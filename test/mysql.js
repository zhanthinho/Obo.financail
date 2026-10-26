"use strict";
// MYSQL round — tests of the MySQL layer itself:
//   1. company separation in SQL (each company's handle reaches only its own
//      tables; SQLite-only SQL is refused, never run differently);
//   2. atomic transactions (all-or-nothing, nested refused, no hidden
//      COMMIT by schema changes);
//   3. database downtime (no hang, clear 503, no partial writes, recovery
//      without a restart; a start while MySQL is down recovers by itself);
//   4. sign-in while the database is down / back;
//   5. backups stored in MySQL: download, restore (only into the same
//      company, all-or-nothing, with a pre-restore backup).
// Needs TEST_MYSQL_* (see test/helpers/mysql.js). Run: npm run test:mysql
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createTestDatabase, openScope } = require("./helpers/mysql");

const ROOT = path.join(__dirname, "..");
const TESTDB = createTestDatabase("mysql");
const PORT = Number(process.env.MYSQL_TEST_PORT || 4412);
const BASE = `http://localhost:${PORT}`;
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + p, { method, signal: ctl.signal, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Runs a node script WITHOUT blocking this process (the relay below lives in
// this process's event loop). Resolves { code, out } with stdout+stderr.
function runNode(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code, out }));
  });
}

// A TCP relay between the app and MySQL that the test can cut and restore —
// the stand-in for "the database went down".
function makeRelay(targetHost, targetPort) {
  const sockets = new Set();
  let server = null;
  const relay = {
    port: null,
    start(port) {
      return new Promise((resolve) => {
        server = net.createServer((client) => {
          const up = net.connect(targetPort, targetHost);
          sockets.add(client); sockets.add(up);
          client.pipe(up); up.pipe(client);
          const end = () => { client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up); };
          client.on("error", end); up.on("error", end); client.on("close", end); up.on("close", end);
        });
        server.listen(port || 0, "127.0.0.1", () => { relay.port = server.address().port; resolve(); });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
      });
    },
  };
  return relay;
}

function inProcess() {
  // The app's own modules, against the test database, in this process.
  Object.assign(process.env, TESTDB.env, { JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex") });
  const tenancy = require("../src/tenancy");
  tenancy.bootstrap();
  return tenancy;
}

async function part1and2() {
  console.log("\nCompany separation in SQL");
  const tenancy = inProcess();
  const db = require("../src/db");
  const a = tenancy.primaryCompany();
  await check("a company's handle reaches only its own tables", async () => {
    tenancy.withCompany(a, () => {
      const n = db.get("SELECT COUNT(*) AS n FROM roles").n;
      assert(n === 7, `CMP-0001 roles ${n}`);
      let refused = false;
      try { db.get("SELECT COUNT(*) AS n FROM cmp0002_clients"); } catch (e) { refused = /not allowed/.test(e.message); }
      assert(refused, "naming another company's table directly must be refused");
      refused = false;
      try { db.get("SELECT COUNT(*) AS n FROM ctl_platform_users"); } catch (e) { refused = /not allowed/.test(e.message); }
      assert(refused, "naming platform tables from a company handle must be refused");
      refused = false;
      try { db.get("SELECT COUNT(*) AS n FROM platform_users"); } catch (e) { refused = /doesn't exist/.test(e.message); }
      assert(refused, "platform tables are not visible as company tables");
    });
  });
  await check("SQLite-only SQL is refused, not run with different meaning", async () => {
    tenancy.withCompany(a, () => {
      for (const sql of ["SELECT julianday('now') AS d", "SELECT * FROM clients WHERE name GLOB 'A*'", "SELECT name FROM sqlite_master", "SELECT * FROM clients WHERE id IS ?", "PRAGMA table_info(clients)"]) {
        let refused = false;
        try { db.all(sql, sql.includes("?") ? ["x"] : []); } catch (e) { refused = e.code === "SQL_DIALECT"; }
        assert(refused, `not refused: ${sql}`);
      }
    });
  });
  await check("no query can run without an authorized company (fails closed)", async () => {
    let refused = false;
    try { db.get("SELECT COUNT(*) AS n FROM clients"); } catch (e) { refused = e.code === "NO_COMPANY_CONTEXT"; }
    assert(refused, "query outside a company context must throw");
  });

  console.log("\nAtomic transactions");
  await check("a failure inside a transaction leaves nothing behind", async () => {
    tenancy.withCompany(a, () => {
      const before = db.get("SELECT COUNT(*) AS n FROM audit_log").n;
      let threw = false;
      try {
        db.tx(() => {
          db.run("INSERT INTO audit_log (id, at, actor_name, actor_role, action) VALUES (?,?,?,?,?)", ["tx1", new Date().toISOString(), "t", "t", "x"]);
          db.run("INSERT INTO audit_log (id, at, actor_name, actor_role, action) VALUES (?,?,?,?,?)", ["tx2", new Date().toISOString(), "t", "t", "x"]);
          throw new Error("boom");
        });
      } catch (e) { threw = e.message === "boom"; }
      assert(threw, "error must propagate");
      assert(db.get("SELECT COUNT(*) AS n FROM audit_log").n === before, "rows of a failed transaction remain");
    });
  });
  await check("a database error half-way rolls back the earlier writes too", async () => {
    tenancy.withCompany(a, () => {
      const before = db.get("SELECT COUNT(*) AS n FROM audit_log").n;
      let threw = false;
      try {
        db.tx(() => {
          db.run("INSERT INTO audit_log (id, at, actor_name, actor_role, action) VALUES (?,?,?,?,?)", ["tx3", new Date().toISOString(), "t", "t", "x"]);
          db.run("INSERT INTO audit_log (id, at, actor_name, actor_role, action) VALUES (?,?,?,?,?)", ["tx3", new Date().toISOString(), "t", "t", "dup"]);
        });
      } catch (e) { threw = /Duplicate/.test(e.message); }
      assert(threw, "duplicate key must fail");
      assert(db.get("SELECT COUNT(*) AS n FROM audit_log").n === before, "first insert survived a failed transaction");
    });
  });
  await check("nested transactions are refused (never silently committed)", async () => {
    tenancy.withCompany(a, () => {
      let threw = false;
      try { db.tx(() => db.tx(() => 1)); } catch (e) { threw = /within a transaction/.test(e.message); }
      assert(threw, "nested tx must be refused");
      assert(db.get("SELECT 1 AS x").x === 1, "connection usable afterwards");
    });
  });
  await check("a schema change inside a transaction is refused (MySQL would commit early)", async () => {
    tenancy.withCompany(a, () => {
      let threw = false;
      try { db.tx(() => { db.db.exec("CREATE TABLE clients (x INT)"); }); } catch (e) { threw = e.code === "DB_DDL_IN_TX"; }
      assert(threw, "DDL in tx must be refused");
    });
  });
  await check("money values keep full precision (USD and SLSH never mixed)", async () => {
    tenancy.withCompany(a, () => {
      const r = db.get("SELECT ? + ? AS s", [0.1, 0.2]).s;
      assert(r === 0.1 + 0.2, `double arithmetic ${r}`);
      let threw = false;
      try { db.run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, staff_name, date) VALUES ('x','x','deposit','EUR',1,1,'t','2026-01-01')"); } catch (e) { threw = /Check constraint/.test(e.message) || /foreign key/i.test(e.message); }
      assert(threw, "a currency other than USD/SLSH must be refused by the database");
    });
  });
  await check("connection lost mid-transaction: nothing continues until rollback; idle loss reconnects by itself", async () => {
    const { SyncMysql } = require("../src/mysql/sync-client");
    const cfg = { host: TESTDB.env.DB_HOST, port: Number(TESTDB.env.DB_PORT), user: TESTDB.env.DB_USER, password: TESTDB.env.DB_PASSWORD, database: TESTDB.env.DB_NAME };
    const c = new SyncMysql(cfg);
    const killer = new SyncMysql(cfg);
    const pause = () => { const t = Date.now(); while (Date.now() - t < 300) { /* let the kill land */ } };
    try {
      c.query("CREATE TABLE killtest (id INT PRIMARY KEY)");
      let id = c.query("SELECT CONNECTION_ID() AS id").rows[0].id;
      killer.query(`KILL ${id}`); pause();
      const r = c.query("SELECT COUNT(*) AS n FROM killtest");
      assert(r.rows[0].n === 0 && r.reconnected, "idle connection loss was not recovered transparently");
      c.query("BEGIN");
      c.query("INSERT INTO killtest VALUES (1)");
      id = c.query("SELECT CONNECTION_ID() AS id").rows[0].id;
      killer.query(`KILL ${id}`); pause();
      let code = null;
      try { c.query("INSERT INTO killtest VALUES (2)"); } catch (e) { code = e.code; }
      assert(code === "DB_CONNECTION_LOST", `statement after loss inside a transaction must fail, got ${code}`);
      code = null;
      try { c.query("SELECT 1"); } catch (e) { code = e.code; }
      assert(code === "DB_CONNECTION_LOST", "still refused until ROLLBACK");
      c.query("ROLLBACK");
      assert(c.query("SELECT COUNT(*) AS n FROM killtest").rows[0].n === 0, "a row of the lost transaction was kept");
      c.query("DROP TABLE killtest");
    } finally { c.close(); killer.close(); }
  });
  require("../src/mysql/connection").close();
}

async function waitHealth(want, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.status === want) return true; } catch (e) { /* not up */ }
    await sleep(250);
  }
  return false;
}

async function part3to5() {
  const relay = makeRelay(TESTDB.env.DB_HOST, Number(TESTDB.env.DB_PORT));
  await relay.start();
  const ENV = { ...process.env, ...TESTDB.env, DB_HOST: "127.0.0.1", DB_PORT: String(relay.port), PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", DB_QUERY_TIMEOUT_MS: "4000", DB_CONNECT_TIMEOUT_MS: "2000" };
  const seeded = await runNode([path.join(ROOT, "scripts", "seed.js")], ENV);
  if (seeded.code !== 0) throw new Error(`seed failed: ${seeded.out}`);
  let srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    assert(await waitHealth(200), "server did not become healthy");
    console.log("\nDatabase downtime");
    const login = async (u, p) => api("/api/auth/login", { method: "POST", body: { username: u, password: p } });
    const admin = (await login("amina.yusuf", PW)).json.token;
    const accounts = (await api("/api/accounts", { token: admin })).json.accounts;
    const acct = accounts.find((x) => x.currency === "USD");
    const bal0 = acct.balanceUsd ?? acct.balance;

    await check("health check reports the database (200 while it is up)", async () => {
      const r = await api("/api/health");
      assert(r.status === 200 && r.json.database === "ok", JSON.stringify(r.json));
    });
    await relay.stop();
    await check("database down: health answers 503 quickly", async () => {
      const t0 = Date.now();
      const r = await api("/api/health");
      assert(r.status === 503 && r.json.database === "unavailable", `${r.status} ${r.text}`);
      assert(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    });
    await check("database down: a payment answers 503 (no hang, nothing saved)", async () => {
      const t0 = Date.now();
      const r = await api(`/api/accounts/${acct.id}/deposit`, { method: "POST", token: admin, body: { amount: 77, currency: "USD", notes: "during outage" } });
      assert(r.status === 503, `expected 503, got ${r.status} ${r.text.slice(0, 120)}`);
      assert(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
    });
    await check("database down: sign-in answers 503, never lets anyone in", async () => {
      const r = await login("amina.yusuf", PW);
      assert(r.status === 503 && !r.json?.token, `${r.status} ${r.text.slice(0, 120)}`);
    });
    await relay.start(relay.port);
    await check("database back: the app recovers without a restart", async () => {
      assert(await waitHealth(200, 15000), "health did not recover");
      const r = await login("amina.yusuf", PW);
      assert(r.status === 200 && r.json.token, `login ${r.status}`);
    });
    await check("the payment attempted during the outage was not saved", async () => {
      const a = (await api(`/api/accounts`, { token: admin })).json.accounts.find((x) => x.id === acct.id);
      assert(Number(a.balanceUsd ?? a.balance) === Number(bal0), `balance changed: ${bal0} -> ${a.balanceUsd ?? a.balance}`);
      const led = (await api(`/api/account-ledger?currency=USD`, { token: admin })).text;
      assert(!led.includes("during outage"), "ledger row from the outage exists");
    });
    await check("wrong password is refused; right password works (auth unchanged)", async () => {
      assert((await login("amina.yusuf", "not-the-password")).status === 401, "wrong password accepted");
      assert((await login("amina.yusuf", PW)).status === 200, "right password refused");
    });

    console.log("\nStart while MySQL is down");
    srv.kill(); await sleep(500);
    await relay.stop();
    srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
    srv.stderr.on("data", (d) => { serverErr += d.toString(); });
    await check("the server starts and answers 503 instead of crashing", async () => {
      assert(await waitHealth(503, 15000), "no 503 from a server whose database is down");
      const r = await api("/api/accounts", { token: admin });
      assert(r.status === 503, `API should be 503, got ${r.status}`);
    });
    await relay.start(relay.port);
    await check("...and becomes ready by itself once MySQL is reachable", async () => {
      assert(await waitHealth(200, 30000), "did not recover");
      assert((await api("/api/accounts", { token: admin })).status === 200, "API not serving");
    });

    console.log("\nBackups in MySQL");
    const sa = (await login("super.admin", SA_PW)).json.token;
    const created = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Restore Test Co", admin: { name: "Rita Admin", username: "rita.admin", password: "Rita-Admin-Pass-77" } } });
    assert(created.status === 201, `company create ${created.status}`);
    const B = created.json.company.id;
    const rita = (await login("rita.admin", "Rita-Admin-Pass-77")).json.token;
    const acc = await api("/api/accounts", { method: "POST", token: rita, body: { name: "Restore Customer", accountType: "customer", currency: "USD" } });
    const accId = acc.json.account.id;
    await api(`/api/accounts/${accId}/deposit`, { method: "POST", token: rita, body: { amount: 500, currency: "USD", notes: "kept" } });
    const swB = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: B } })).json.token;
    const swA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
    let backupName;
    await check("a Super Admin backup is stored in the database and downloads intact", async () => {
      const b = await api("/api/backups", { method: "POST", token: swB });
      assert(b.status === 201 && /^finman-CMP-\d{4}-.*-manual\.json\.gz$/.test(b.json.name), `${b.status} ${b.text}`);
      backupName = b.json.name;
      const res = await fetch(`${BASE}/api/backups/${backupName}`, { headers: { Authorization: `Bearer ${swB}` } });
      const gz = Buffer.from(await res.arrayBuffer());
      const data = JSON.parse(require("zlib").gunzipSync(gz).toString());
      assert(data.scope === B && data.tables.find((t) => t.name === "clients").rows.length === 1, "backup content");
      assert(!JSON.stringify(data).includes("CMP-0001\""), "another company's data inside the backup");
    });
    await check("a company's backup is not visible from another company", async () => {
      const r = await api(`/api/backups/${backupName}`, { token: swA });
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });
    // Change data after the backup, then restore.
    await api(`/api/accounts/${accId}/deposit`, { method: "POST", token: rita, body: { amount: 123, currency: "USD", notes: "after backup" } });
    srv.kill(); await sleep(500);
    await check("restore puts the company back exactly as backed up (with a pre-restore backup)", async () => {
      const { out } = await runNode([path.join(ROOT, "scripts", "backup.js"), "restore", "--company", B, "--name", backupName, "--confirm"], ENV);
      assert(/Restored/.test(out) && /prerestore/.test(out), out);
      const h = openScope(TESTDB.env, { companyId: B });
      try {
        const bal = h.prepare("SELECT balance_usd FROM clients WHERE id = ?").get(accId).balance_usd;
        assert(bal === 500, `balance after restore ${bal}`);
        assert(!h.prepare("SELECT id FROM account_ledger WHERE notes = 'after backup'").get(), "post-backup row still present");
      } finally { h.close(); }
      const list = (await runNode([path.join(ROOT, "scripts", "backup.js"), "list", "--company", B], ENV)).out;
      assert(/prerestore/.test(list), "no pre-restore backup listed");
    });
    await check("a backup of one company can never be restored into another", async () => {
      let msg = (await runNode([path.join(ROOT, "scripts", "backup.js"), "restore", "--company", "CMP-0001", "--name", backupName, "--confirm"], ENV)).out;
      assert(/not found|belongs to/.test(msg), `expected refusal, got: ${msg.slice(0, 200)}`);
      const gzFile = path.join(require("os").tmpdir(), `finman-test-${crypto.randomBytes(4).toString("hex")}.json.gz`);
      const dl = await runNode([path.join(ROOT, "scripts", "backup.js"), "download", "--company", B, "--name", backupName, "--out", gzFile], ENV);
      assert(dl.code === 0, `download failed: ${dl.out}`);
      msg = (await runNode([path.join(ROOT, "scripts", "backup.js"), "restore", "--company", "CMP-0001", "--file", gzFile, "--confirm"], ENV)).out;
      require("fs").rmSync(gzFile, { force: true });
      assert(/belongs to/.test(msg), `expected 'belongs to' refusal, got: ${msg.slice(0, 200)}`);
      const h = openScope(TESTDB.env, { companyId: "CMP-0001" });
      try { assert(h.prepare("SELECT COUNT(*) AS n FROM users").get().n > 1, "CMP-0001 data was touched"); } finally { h.close(); }
    });
  } finally {
    srv.kill();
    await relay.stop();
  }
  await sleep(300);
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.slice(0, 5).join("\n      "));
}

async function main() {
  console.log(`MySQL layer tests (database ${TESTDB.name})`);
  await part1and2();
  // Fresh database for the HTTP part (part 1 created CMP-0001 in-process).
  const h = openScope(TESTDB.env, { control: true });
  const tables = h.raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((r) => r.n);
  h.raw("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of tables) h.raw(`DROP TABLE "${t}"`);
  h.raw("SET FOREIGN_KEY_CHECKS = 1");
  h.close();
  await part3to5();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
