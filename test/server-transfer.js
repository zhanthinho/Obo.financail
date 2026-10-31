"use strict";
// SERVER-TO-SERVER TRANSFER (src/server-transfer.js) — a new installation
// pulls a whole database from a running one over HTTP(S), on start.
// Run with: node test/server-transfer.js
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { SyncMysql } = require("../src/mysql/sync-client");

const ROOT = path.join(__dirname, "..");
const H = require("./helpers/mysql");
const SRC = H.createTestDatabase("xfersrc");
const DST = H.createTestDatabase("xferdst");
const BUSY = H.createTestDatabase("xferbusy");
const JWT = crypto.randomBytes(32).toString("hex");
const TOKEN = crypto.randomBytes(24).toString("hex");
const SRC_PORT = 4520;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { const m = e.message + (e.cause ? ` (${e.cause.code || e.cause.message})` : ""); failures.push(`${label}: ${m}`); console.log(`FAILED\n      ${m}`); }
}
const q = (env, sql) => { const c = new SyncMysql({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME }); try { return c.query(sql).rows; } finally { c.close(); } };
function fingerprint(env, { skip = /^(ctl_backups|ctl_backup_chunks|finman_transfer_import)$/ } = {}) {
  const out = {};
  for (const { t } of q(env, "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME")) {
    if (skip.test(t)) continue;
    out[t] = q(env, `CHECKSUM TABLE "${t}"`)[0].Checksum + ":" + q(env, `SELECT COUNT(*) AS n FROM "${t}"`)[0].n;
  }
  return out;
}
async function api(base, p, { method = "GET", body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
function start(env, port, extra = {}) {
  const logs = [];
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...process.env, ...env, PORT: String(port), JWT_SECRET: JWT, BACKUP_ENABLED: "0", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => logs.push(String(d)));
  srv.stderr.on("data", (d) => logs.push(String(d)));
  const base = `http://localhost:${port}`;
  const ready = (async () => {
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(base + "/api/health"); if (r.ok) return; } catch (_) { /* not yet */ }
      if (Date.now() - t0 > 60000) throw new Error("server did not start: " + logs.join("").slice(-600));
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return { srv, base, ready, log: () => logs.join(""), stop: () => new Promise((r) => { srv.once("exit", r); srv.kill(); }) };
}
async function snapshot(base) {
  const tok = (await api(base, "/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: process.env.SEED_DEMO_PASSWORD } })).json.token;
  assert(tok, "login failed");
  const usd = (await api(base, "/api/accounts?currency=USD", { token: tok })).json.accounts.map((a) => [a.id, a.name, a.balance]);
  return JSON.stringify(usd);
}

async function main() {
  console.log("Preparing source (seeded + activity) and two targets...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: { ...process.env, ...SRC.env, JWT_SECRET: JWT }, stdio: "ignore" });
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: { ...process.env, ...BUSY.env, JWT_SECRET: JWT }, stdio: "ignore" });
  // DST: a fresh install (the app's own first start, like GoDaddy's).
  { const s = start(DST.env, 4530); await s.ready; await s.stop(); }
  // BUSY: a seeded install the app has already run on once.
  { const s = start(BUSY.env, 4529); await s.ready; await s.stop(); }

  const src = start(SRC.env, SRC_PORT, { MIGRATION_TOKEN: TOKEN });
  await src.ready;
  let before;
  try {
    const tok = (await api(src.base, "/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: process.env.SEED_DEMO_PASSWORD } })).json.token;
    const acct = (await api(src.base, "/api/accounts", { method: "POST", token: tok, body: { name: "Transfer Test — Hargeysa", accountType: "company", currency: "USD", openingBalance: 500.5 } })).json.account;
    await api(src.base, `/api/accounts/${acct.id}/deposit`, { method: "POST", token: tok, body: { amount: 75.25, currency: "USD" } });
    // A stored backup on the source (its rows are not carried).
    await api(src.base, "/api/backups", { method: "POST", token: tok, body: {} });
    before = await snapshot(src.base);
    const srcPrint = fingerprint(SRC.env);

    console.log("\nSource export endpoint");
    await check("no token / wrong token -> 404, nothing revealed", async () => {
      // (one retry: the test client may reuse a keep-alive socket the server just closed)
      const get = (h) => fetch(src.base + "/api/migration/export", { headers: h }).catch(() => fetch(src.base + "/api/migration/export", { headers: h }));
      const a = await get({});
      const b = await get({ "X-Migration-Token": "x".repeat(48) });
      assert(a.status === 404 && b.status === 404, `${a.status} ${b.status}`);
    });

    console.log("\nTarget pulls on start");
    let dst;
    await check("a fresh target imports everything and logs DONE", async () => {
      dst = start(DST.env, 4531, { MIGRATE_FROM_URL: src.base, MIGRATION_TOKEN: TOKEN, FINMAN_TRANSFER_ALLOW_HTTP: "1" });
      await dst.ready;
      assert(/\[transfer\] DONE — \d+ tables, \d+ rows copied and verified/.test(dst.log()), dst.log().slice(-800));
    });
    await check("target tables, rows and checksums equal the source (backup rows excepted)", async () => {
      const d = fingerprint(DST.env);
      assert(JSON.stringify(Object.keys(d)) === JSON.stringify(Object.keys(srcPrint)), "table lists differ");
      for (const t of Object.keys(srcPrint)) assert(d[t] === srcPrint[t], `${t}: ${srcPrint[t]} vs ${d[t]}`);
      assert(Number(q(DST.env, 'SELECT COUNT(*) AS n FROM "ctl_backups"')[0].n) === 0, "backup rows were carried");
    });
    await check("the source database was not changed by the export", async () => {
      assert(JSON.stringify(fingerprint(SRC.env)) === JSON.stringify(srcPrint), "source changed");
    });
    await check("the app on the target shows the same accounts and balances; users log in with their old passwords", async () => {
      const after = await snapshot(dst.base);
      assert(after === before, `${before}\n   vs ${after}`);
    });
    await check("the logs never contain the token", async () => {
      assert(!dst.log().includes(TOKEN) && !src.log().includes(TOKEN), "token printed");
    });
    if (dst) await dst.stop();

    await check("a restart does not import again (marker) and keeps new data", async () => {
      q(DST.env, "UPDATE \"cmp0001_clients\" SET name = CONCAT(name, ' *') WHERE name LIKE 'Transfer Test%'");
      const p = fingerprint(DST.env);
      const s = start(DST.env, 4532, { MIGRATE_FROM_URL: src.base, MIGRATION_TOKEN: TOKEN, FINMAN_TRANSFER_ALLOW_HTTP: "1" });
      await s.ready; await s.stop();
      assert(/already imported earlier/.test(s.log()), s.log().slice(-400));
      assert(JSON.stringify(fingerprint(DST.env)) === JSON.stringify(p), "target changed on restart");
    });

    await check("a target that already has real data is REFUSED and left unchanged", async () => {
      const p = fingerprint(BUSY.env);
      const s = start(BUSY.env, 4533, { MIGRATE_FROM_URL: src.base, MIGRATION_TOKEN: TOKEN, FINMAN_TRANSFER_ALLOW_HTTP: "1" });
      await s.ready; await s.stop();
      assert(/REFUSED — this database is not a fresh install/.test(s.log()), s.log().slice(-400));
      assert(JSON.stringify(fingerprint(BUSY.env)) === JSON.stringify(p), "busy target changed");
    });

    await check("http:// is refused unless explicitly allowed (tests only)", async () => {
      const fresh = H.createTestDatabase("xferhttp");
      const s = start(fresh.env, 4534, { MIGRATE_FROM_URL: src.base, MIGRATION_TOKEN: TOKEN });
      await s.ready; await s.stop();
      assert(/must start with https:\/\//.test(s.log()), s.log().slice(-300));
      assert(Number(q(fresh.env, 'SELECT COUNT(*) AS n FROM "ctl_companies"')[0].n) === 1, "fresh install did not start normally");
    });

    await check("wrong token at the target: FAILED, target starts as a normal fresh install", async () => {
      const fresh = H.createTestDatabase("xferbad");
      const s = start(fresh.env, 4535, { MIGRATE_FROM_URL: src.base, MIGRATION_TOKEN: "y".repeat(48), FINMAN_TRANSFER_ALLOW_HTTP: "1" });
      await s.ready; await s.stop();
      assert(/\[transfer\] FAILED — the source answered 404/.test(s.log()), s.log().slice(-300));
      assert(Number(q(fresh.env, 'SELECT COUNT(*) AS n FROM "ctl_companies"')[0].n) === 1, "fresh install did not start");
    });

    await check("after 5 wrong tokens the export locks itself (even the right token gets 404)", async () => {
      for (let i = 0; i < 6; i++) await fetch(src.base + "/api/migration/export", { headers: { "X-Migration-Token": "z".repeat(40) + i } });
      const r = await fetch(src.base + "/api/migration/export", { headers: { "X-Migration-Token": TOKEN } });
      assert(r.status === 404, String(r.status));
    });
  } finally {
    await src.stop();
  }

  await check("without MIGRATION_TOKEN the export route does not exist (404)", async () => {
    const s = start(SRC.env, 4536);
    await s.ready;
    try {
      const r = await fetch(s.base + "/api/migration/export", { headers: { "X-Migration-Token": TOKEN } });
      assert(r.status === 404, String(r.status));
    } finally { await s.stop(); }
  });

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
