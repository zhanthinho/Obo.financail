"use strict";
// COPY TO ONLINE — scripts/copy-to-online.js copies a local FINMAN database
// into an EMPTY database, exactly, and the app then runs on the copy:
//   * every table + row arrives and checksums match (the script verifies);
//   * the source database is not changed at all;
//   * a non-empty target is refused and left untouched;
//   * the app starts on the copy and a demo user can log in and read
//     the same accounts/balances as on the source.
// Run with: npm run test:copy-to-online
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { SyncMysql } = require("../src/mysql/sync-client");

const ROOT = path.join(__dirname, "..");
const H = require("./helpers/mysql");
const SRC = H.createTestDatabase("copysrc");
const DST = H.createTestDatabase("copydst");
const PORT = 4480;
const JWT = crypto.randomBytes(32).toString("hex");

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
const q = (env, sql) => { const c = new SyncMysql({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME }); try { return c.query(sql).rows; } finally { c.close(); } };
function fingerprint(env) {
  const out = {};
  for (const { t } of q(env, "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME")) {
    out[t] = q(env, `CHECKSUM TABLE "${t}"`)[0].Checksum + ":" + q(env, `SELECT COUNT(*) AS n FROM "${t}"`)[0].n;
  }
  return out;
}
function runCopy(target) {
  const envFile = path.join(os.tmpdir(), `copy-env-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(envFile, Object.entries(SRC.env).map(([k, v]) => `${k}=${v}`).join("\n"));
  try {
    return spawnSync(process.execPath, [path.join(ROOT, "scripts", "copy-to-online.js")], {
      env: { ...process.env, COPY_TEST_ENV_FILE: envFile, COPY_TEST_TARGET: JSON.stringify({ host: target.DB_HOST, port: Number(target.DB_PORT), user: target.DB_USER, password: target.DB_PASSWORD, database: target.DB_NAME }) },
      encoding: "utf8", timeout: 300000,
    });
  } finally { fs.rmSync(envFile, { force: true }); }
}
async function api(base, p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function withServer(env, port, fn) {
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...process.env, ...env, PORT: String(port), JWT_SECRET: JWT, BACKUP_ENABLED: "0" }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(base + "/api/health")).ok) break; } catch (_) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    return await fn(base);
  } finally { srv.kill(); }
}
async function snapshot(base) {
  const tok = (await api(base, "/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: process.env.SEED_DEMO_PASSWORD } })).json.token;
  assert(tok, "login failed");
  const usd = (await api(base, "/api/accounts?currency=USD", { token: tok })).json.accounts.map((a) => [a.id, a.name, a.balance]);
  const hist = (await api(base, "/api/history?currency=USD", { token: tok })).json;
  return JSON.stringify({ usd, hist: hist && (hist.total ?? (hist.rows || hist.entries || []).length) });
}

async function main() {
  console.log("Seeding the source database...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: { ...process.env, ...SRC.env, JWT_SECRET: JWT }, stdio: "ignore" });
  // Make some real activity (and a backup with binary chunks) on the source.
  let before;
  await withServer(SRC.env, PORT, async (base) => {
    const tok = (await api(base, "/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: process.env.SEED_DEMO_PASSWORD } })).json.token;
    const acct = (await api(base, "/api/accounts", { method: "POST", token: tok, body: { name: "Copy Test Ltd — Hargeysa", accountType: "company", currency: "USD", openingBalance: -1234.56 } })).json.account;
    await api(base, `/api/accounts/${acct.id}/deposit`, { method: "POST", token: tok, body: { amount: 200.25, currency: "USD" } });
    before = await snapshot(base);
  });
  const srcPrint = fingerprint(SRC.env);

  console.log("\nCopy");
  let out;
  await check("the copy reports every table copied and verified", async () => {
    out = runCopy(DST.env);
    assert(out.status === 0, `exit ${out.status}: ${(out.stdout + out.stderr).slice(-600)}`);
    assert(/\[OK\] Dhammaan \d+ table/.test(out.stdout), out.stdout.slice(-400));
  });
  await check("target now has the same tables, rows and table checksums as the source", async () => {
    const d = fingerprint(DST.env);
    assert(JSON.stringify(Object.keys(d)) === JSON.stringify(Object.keys(srcPrint)), "table lists differ");
    for (const t of Object.keys(srcPrint)) assert(d[t] === srcPrint[t], `${t}: ${srcPrint[t]} vs ${d[t]}`);
  });
  await check("the source database was not changed", async () => {
    assert(JSON.stringify(fingerprint(SRC.env)) === JSON.stringify(srcPrint), "source changed");
  });
  await check("the output never prints the online password", async () => {
    assert(!out.stdout.includes(DST.env.DB_PASSWORD) || !DST.env.DB_PASSWORD, "password printed");
  });
  await check("a second run is refused because the target is not empty, and changes nothing", async () => {
    const d1 = fingerprint(DST.env);
    const r = runCopy(DST.env);
    assert(r.status !== 0 && /horay ayuu u leeyahay/.test(r.stdout), r.stdout.slice(-300));
    assert(JSON.stringify(fingerprint(DST.env)) === JSON.stringify(d1), "target changed");
  });

  console.log("\nThe app on the copy");
  await check("the app starts on the copied database and shows the same accounts and balances", async () => {
    const after = await withServer(DST.env, PORT + 1, snapshot);
    assert(after === before, `${before}\n   vs ${after}`);
  });

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
