"use strict";
// Every company table the app defines (grows when a round adds a table).
const TENANT_TABLE_COUNT = require("../src/mysql/schema").tableNames("tenant").length;
// MYSQL round — tests of the one-time SQLite -> MySQL migration
// (scripts/migrate-sqlite-to-mysql.js). Builds a realistic OLD installation
// with the legacy SQLite code (control database + primary company + a second
// company, real users/passwords, ledgers in both currencies, an expense with
// an attachment, Unicode text, NULLs, an older table shape), then checks:
//   * --dry-run writes nothing to MySQL; the SQLite files stay byte-identical;
//   * --execute copies every row exactly and verifies it (counts, checksums,
//     relationships, financial totals); the SQLite files stay byte-identical;
//   * a re-run never duplicates anything (resume);
//   * the app starts on the migrated data: old passwords work, balances are
//     the same, each company still sees only its own data;
//   * bad values (an Infinity amount) stop the migration before any write;
//   * a target that already holds data is never overwritten;
//   * a pre-multi-company installation (no control database) migrates;
//   * the offline bundle route gives the same result.
// The legacy SQLite startup migrations themselves run (on copies) inside the
// tool; the "older table shape" case below proves that path.
// Needs TEST_MYSQL_* (see test/helpers/mysql.js). Run: npm run test:migration
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
process.env.JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { createTestDatabase, openScope } = require("./helpers/mysql");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "scripts", "migrate-sqlite-to-mysql.js");
const PORT = Number(process.env.MIGRATION_TEST_PORT || 4431);
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "finman-migration-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
function sha(f) { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }
function snapshotDir(dir) {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p); } };
  walk(dir);
  return out;
}
function tool(args, env) {
  const r = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/* ---------------------- build an OLD SQLite installation --------------------- */
const { hashPassword } = require("../src/auth");
function buildOldInstall(dir, { withControl = true, badAmount = false, clientName = "CABDI XASAN — Ñ 中文 ✓" } = {}) {
  const { openTenantDb } = require("../scripts/legacy/sqlite-tenant-db");
  const { openControlDb } = require("../scripts/legacy/sqlite-control-db");
  fs.mkdirSync(path.join(dir, "geeska-companies"), { recursive: true });
  const now = new Date().toISOString();
  const A = openTenantDb(path.join(dir, "geeska.sqlite"), "CMP-0001", { isPrimary: true });
  const roleId = (h, key) => h.prepare("SELECT id FROM roles WHERE key = ?").get(key).id;
  const addUser = (h, id, name, username, pw, role) => {
    const { hash, salt } = hashPassword(pw);
    h.prepare("INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, created_at) VALUES (?,?,?,?,?,?,?,'active',1,1,?)").run(id, name, username, hash, salt, role, roleId(h, role), now);
  };
  addUser(A, "u-a1", "AMINA YUSUF", "amina.yusuf", "Amina-Pass-2026!", "admin");
  A.prepare("INSERT INTO clients (id, name, account_number, account_type, currency, balance_usd, balance_slsh, contact, created_at) VALUES ('c1',?,'ACC-0001','customer','USD',0.30000000000000004,0,NULL,?)").run(clientName, now);
  A.prepare("INSERT INTO clients (id, name, account_number, account_type, currency, balance_usd, balance_slsh, contact, created_at) VALUES ('c2','HODAN (SLSH)','ACC-0002','company','SLSH',0,2500000.5,'+252 63 400 1122',?)").run(now);
  const led = A.prepare("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, reference_number, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  led.run("l1", "c1", "deposit", "USD", 0.1, 0.1, "first", "u-a1", "AMINA YUSUF", "2026-01-05T10:00:00.000Z", "DEP-2026-0001", now);
  led.run("l2", "c1", "deposit", "USD", 0.2, 0.30000000000000004, null, "u-a1", "AMINA YUSUF", "2026-01-06T10:00:00.000Z", "DEP-2026-0002", now);
  led.run("l3", "c2", "deposit", "SLSH", badAmount ? Infinity : 2500000.5, 2500000.5, "slsh", "u-a1", "AMINA YUSUF", "2026-01-07T10:00:00.000Z", "DEP-2026-0003", now);
  A.prepare("INSERT INTO cash_accounts (id, name, type, currency, balance, status, created_at) VALUES ('k1','Main Till','physical_cash','USD',150.75,'active',?)").run(now);
  A.prepare("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, date, created_at) VALUES ('kl1','k1','deposit','USD',200.75,200.75,'opening',?,?)").run("2026-01-05T09:00:00.000Z", now);
  const cat = A.prepare("SELECT id, name FROM expense_categories ORDER BY sort_order LIMIT 1").get();
  A.prepare("INSERT INTO expenses (id, reference_number, date, category_id, category_name, description, amount, currency, cash_account_id, status, created_at) VALUES ('e1','EXP-2026-0001','2026-01-08',?,?,'Fuel',50,'USD','k1','posted',?)").run(cat.id, cat.name, now);
  A.prepare("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, date, created_at, source_type, source_id) VALUES ('kl2','k1','withdrawal','USD',50,150.75,'Fuel',?,?,'expense','e1')").run("2026-01-08T09:00:00.000Z", now);
  A.prepare("INSERT INTO expense_attachments (id, expense_id, file_name, mime_type, size_bytes, data_base64, uploaded_at) VALUES ('ea1','e1','r.png','image/png',4,'iVBORw==',?)").run(now);
  A.close();
  const B = openTenantDb(path.join(dir, "geeska-companies", "CMP-0002.sqlite"), "CMP-0002", { isPrimary: false });
  addUser(B, "u-b1", "BASHIR ADMIN", "b.admin", "Bashir-Pass-2026!", "admin");
  B.prepare("INSERT INTO clients (id, name, account_number, account_type, currency, balance_usd, created_at) VALUES ('bc1','BETA CUSTOMER','ACC-0001','customer','USD',1234.56,?)").run(now);
  B.prepare("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, staff_id, staff_name, date, reference_number, created_at) VALUES ('bl1','bc1','deposit','USD',1234.56,1234.56,'u-b1','BASHIR ADMIN','2026-02-01T08:00:00.000Z','DEP-2026-0001',?)").run(now);
  // An OLDER table shape: this column did not exist in early versions; the
  // tool's upgrade of its COPY must add it back (the source stays as it is).
  B.exec("ALTER TABLE clients DROP COLUMN notes");
  B.close();
  if (withControl) {
    const C = openControlDb(path.join(dir, "geeska-control.sqlite"));
    C.prepare("INSERT INTO companies (id, seq, name, status, is_primary, db_file, created_at, created_by) VALUES ('CMP-0001',1,'Alpha Exchange','active',1,'@primary',?, 'system')").run(now);
    C.prepare("INSERT INTO companies (id, seq, name, status, is_primary, db_file, created_at, created_by) VALUES ('CMP-0002',2,'Beta Traders Ltd','active',0,'CMP-0002.sqlite',?, 'system')").run(now);
    C.prepare("INSERT INTO user_directory (username, company_id, user_id, updated_at) VALUES ('amina.yusuf','CMP-0001','u-a1',?), ('b.admin','CMP-0002','u-b1',?)").run(now, now);
    C.close();
  } else {
    fs.rmSync(path.join(dir, "geeska-companies"), { recursive: true, force: true });
  }
}

async function api(p, { method = "GET", body, token } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text };
}
async function withServer(env, fn) {
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...process.env, ...env, PORT: String(PORT), BACKUP_ENABLED: "0" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  srv.stderr.on("data", (d) => { err += d; });
  try {
    const start = Date.now();
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (e) { /* not yet */ }
      if (Date.now() - start > 20000) throw new Error(`server did not start: ${err.slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await fn();
  } finally { srv.kill(); await new Promise((r) => setTimeout(r, 400)); }
  const bad = err.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) throw new Error(`server errors: ${bad.slice(0, 3).join(" | ")}`);
}

async function main() {
  console.log("SQLite -> MySQL migration tests\n");
  const src = path.join(TMP, "old");
  buildOldInstall(src);
  const before = snapshotDir(src);
  const db1 = createTestDatabase("mig");
  const out = path.join(TMP, "runs");

  await check("--dry-run reads and checks everything but writes nothing", async () => {
    const r = tool(["--source", path.join(src, "geeska.sqlite"), "--out", out, "--dry-run"], db1.env);
    assert(r.code === 0, r.out);
    assert(/upgrade changed no data/.test(r.out), "an up-to-date installation must show no upgrade changes");
    assert(/DRY RUN finished/.test(r.out) && /CMP-0002/.test(r.out) && new RegExp(`${TENANT_TABLE_COUNT} table\\(s\\) to copy`).test(r.out), r.out.slice(-600));
    const h = openScope(db1.env, { control: true });
    try { assert(h.raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")[0].n === 0, "dry-run created tables"); } finally { h.close(); }
  });
  await check("the SQLite files are byte-identical after the dry-run", async () => {
    assert(JSON.stringify(snapshotDir(src)) === JSON.stringify(before), "source files changed");
  });
  await check("an immutable backup with checksums was made first", async () => {
    const run = fs.readdirSync(out).sort()[0];
    const m = JSON.parse(fs.readFileSync(path.join(out, run, "backup", "manifest.json"), "utf8"));
    assert(m.files.length === 3 && m.raw.length >= 3, JSON.stringify(m).slice(0, 200));
    for (const f of m.files) assert(sha(path.join(out, run, "backup", f.backup)) === f.sha256, `checksum ${f.backup}`);
    assert((fs.statSync(path.join(out, run, "backup", "primary.sqlite")).mode & 0o222) === 0, "backup is writable");
  });

  await check("--execute copies every company and verifies counts, checksums, relationships and totals", async () => {
    const r = tool(["--source", path.join(src, "geeska.sqlite"), "--out", out, "--execute"], db1.env);
    assert(r.code === 0, r.out.slice(-1500));
    assert(/control: OK/.test(r.out) && /CMP-0001: OK/.test(r.out) && /CMP-0002: OK/.test(r.out) && /Migration complete and verified/.test(r.out), r.out.slice(-800));
  });
  await check("values arrive exactly: IDs, dates, decimals, NULLs, Unicode, flags, company IDs", async () => {
    const a = openScope(db1.env, { companyId: "CMP-0001" });
    try {
      const c1 = a.prepare("SELECT * FROM clients WHERE id = 'c1'").get();
      assert(c1.name === "CABDI XASAN — Ñ 中文 ✓" && c1.balance_usd === 0.30000000000000004 && c1.contact === null && c1.company_id === "CMP-0001", JSON.stringify(c1));
      const l2 = a.prepare("SELECT * FROM account_ledger WHERE id = 'l2'").get();
      assert(l2.amount === 0.2 && l2.notes === null && l2.date === "2026-01-06T10:00:00.000Z" && l2.reference_number === "DEP-2026-0002", JSON.stringify(l2));
      const l3 = a.prepare("SELECT amount, currency FROM account_ledger WHERE id = 'l3'").get();
      assert(l3.amount === 2500000.5 && l3.currency === "SLSH", JSON.stringify(l3));
      assert(a.prepare("SELECT data_base64 FROM expense_attachments WHERE id = 'ea1'").get().data_base64 === "iVBORw==", "attachment");
      assert(a.prepare("SELECT active FROM users WHERE id = 'u-a1'").get().active === 1, "flag");
      assert(a.prepare("SELECT COUNT(*) AS n FROM role_permissions").get().n === 200, "permissions");
    } finally { a.close(); }
    const b = openScope(db1.env, { companyId: "CMP-0002" });
    try {
      const bc = b.prepare("SELECT * FROM clients WHERE id = 'bc1'").get();
      assert(bc.balance_usd === 1234.56 && bc.company_id === "CMP-0002" && "notes" in bc, JSON.stringify(bc));
      assert(b.prepare("SELECT COUNT(*) AS n FROM clients").get().n === 1, "company B row count");
    } finally { b.close(); }
  });
  await check("the SQLite files are byte-identical after the migration (older table shape untouched)", async () => {
    assert(JSON.stringify(snapshotDir(src)) === JSON.stringify(before), "source files changed");
    const { DatabaseSync } = require("node:sqlite");
    const h = new DatabaseSync(path.join(src, "geeska-companies", "CMP-0002.sqlite"), { readOnly: true });
    try { assert(!h.prepare("PRAGMA table_info(clients)").all().some((c) => c.name === "notes"), "source was upgraded in place"); } finally { h.close(); }
  });
  await check("running it again copies nothing and duplicates nothing (resume)", async () => {
    const h = openScope(db1.env, { companyId: "CMP-0001" });
    const n0 = h.prepare("SELECT COUNT(*) AS n FROM account_ledger").get().n;
    h.close();
    const r = tool(["--source", path.join(src, "geeska.sqlite"), "--out", out, "--execute"], db1.env);
    assert(r.code === 0 && new RegExp(`0 table\\(s\\) to copy, ${TENANT_TABLE_COUNT} already done`).test(r.out), r.out.slice(-600));
    const h2 = openScope(db1.env, { companyId: "CMP-0001" });
    try { assert(h2.prepare("SELECT COUNT(*) AS n FROM account_ledger").get().n === n0, "duplicated rows"); } finally { h2.close(); }
  });
  await check("the app runs on the migrated data: old passwords, same balances, companies kept apart", async () => {
    await withServer(db1.env, async () => {
      const a = await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: "Amina-Pass-2026!" } });
      assert(a.status === 200, `amina login ${a.status} ${a.text.slice(0, 120)}`);
      const accts = (await api("/api/accounts", { token: a.json.token })).json.accounts;
      assert(accts.length === 2, `A sees ${accts.length} accounts`);
      const b = await api("/api/auth/login", { method: "POST", body: { username: "b.admin", password: "Bashir-Pass-2026!" } });
      assert(b.status === 200, `b.admin login ${b.status}`);
      const bAccts = (await api("/api/accounts", { token: b.json.token })).json.accounts;
      assert(bAccts.length === 1 && bAccts[0].name.toUpperCase().includes("BETA"), JSON.stringify(bAccts).slice(0, 200));
      const sa = await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } });
      assert(sa.status === 200, `super admin login ${sa.status}`);
      const cos = (await api("/api/platform/companies", { token: sa.json.token })).json.companies;
      assert(cos.map((c) => c.id).join() === "CMP-0001,CMP-0002", JSON.stringify(cos.map((c) => c.id)));
    });
  });

  await check("data the app's upgrade would still change is reported and needs explicit approval", async () => {
    const old = path.join(TMP, "notupgraded");
    buildOldInstall(old, { clientName: "Cabdi Xasan" }); // not yet in the upper-case form the app stores
    const dbx = createTestDatabase("migupg");
    let r = tool(["--source", path.join(old, "geeska.sqlite"), "--out", out, "--execute"], dbx.env);
    assert(r.code === 6 && /CMP-0001: clients: 1 row\(s\) updated/.test(r.out) && /Nothing was written/.test(r.out), r.out.slice(-700));
    const h = openScope(dbx.env, { control: true });
    try { assert(h.raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")[0].n === 0, "tables were written"); } finally { h.close(); }
    r = tool(["--source", path.join(old, "geeska.sqlite"), "--out", out, "--execute", "--accept-upgrade-changes"], dbx.env);
    assert(r.code === 0 && /Migration complete and verified/.test(r.out), r.out.slice(-600));
    dbx.drop();
  });
  await check("a value MySQL cannot store exactly (an Infinity amount) stops it before any write", async () => {
    const bad = path.join(TMP, "bad");
    buildOldInstall(bad, { badAmount: true });
    const db2 = createTestDatabase("migbad");
    const r = tool(["--source", path.join(bad, "geeska.sqlite"), "--out", out, "--execute"], db2.env);
    assert(r.code === 3 && /STOPPED/.test(r.out) && /account_ledger\.amount/.test(r.out) && /l3/.test(r.out), r.out.slice(-600));
    const h = openScope(db2.env, { control: true });
    try { assert(h.raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")[0].n === 0, "tables were written"); } finally { h.close(); }
    db2.drop();
  });
  await check("a target that already holds other data is never overwritten", async () => {
    const db3 = createTestDatabase("migfull");
    const { SyncMysql } = require("../src/mysql/sync-client");
    const c = new SyncMysql({ host: db3.env.DB_HOST, port: Number(db3.env.DB_PORT), user: db3.env.DB_USER, password: db3.env.DB_PASSWORD, database: db3.env.DB_NAME });
    const schema = require("../src/mysql/schema");
    schema.ensureScope((sql, p = []) => { const r = c.query(sql, p); return r.rows || r; }, { kind: "tenant", companyId: "CMP-0002" });
    c.query(`INSERT INTO "cmp0002_audit_log" (id, at, actor_name, actor_role, action) VALUES ('keep-me','2026-01-01','x','x','x')`);
    c.close();
    const r = tool(["--source", path.join(src, "geeska.sqlite"), "--out", out, "--execute"], db3.env);
    assert(r.code === 4 && /BLOCKED/.test(r.out) && /audit_log/.test(r.out), r.out.slice(-600));
    const h = openScope(db3.env, { companyId: "CMP-0002" });
    try {
      assert(h.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n === 1, "existing row touched");
      assert(h.prepare("SELECT COUNT(*) AS n FROM clients").get().n === 0, "data was written despite the block");
    } finally { h.close(); }
    db3.drop();
  });
  await check("an installation from before multi-company support migrates as CMP-0001", async () => {
    const single = path.join(TMP, "single");
    buildOldInstall(single, { withControl: false });
    const db4 = createTestDatabase("migsingle");
    const r = tool(["--source", path.join(single, "geeska.sqlite"), "--out", out, "--execute"], db4.env);
    assert(r.code === 0 && /CMP-0001: OK/.test(r.out), r.out.slice(-600));
    const h = openScope(db4.env, { control: true });
    try { assert(h.prepare("SELECT id FROM companies WHERE is_primary = 1").get().id === "CMP-0001", "primary"); } finally { h.close(); }
    db4.drop();
  });
  await check("the offline bundle route (no MySQL access needed to build it) gives the same result", async () => {
    const bundle = path.join(TMP, "bundle.json.gz");
    let r = tool(["--source", path.join(src, "geeska.sqlite"), "--out", out, "--bundle", bundle], { DB_HOST: "", DB_NAME: "", DB_USER: "", DB_PASSWORD: "" });
    assert(r.code === 0 && fs.existsSync(bundle), r.out.slice(-400));
    const db5 = createTestDatabase("migbundle");
    r = tool(["--from-bundle", bundle, "--execute"], db5.env);
    assert(r.code === 0 && /Migration complete and verified/.test(r.out), r.out.slice(-600));
    const h = openScope(db5.env, { companyId: "CMP-0001" });
    try { assert(h.prepare("SELECT balance_usd FROM clients WHERE id = 'c1'").get().balance_usd === 0.30000000000000004, "bundle values"); } finally { h.close(); }
    db5.drop();
  });

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
