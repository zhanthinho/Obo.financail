"use strict";
// SYSTEM AUDIT follow-up — backups really restore: a company backup is
// taken, more money is posted, the backup is restored with the command-line
// tool (scripts/backup.js restore), and the company is exactly as it was
// when backed up; a "prerestore" backup of the replaced data exists; another
// company is untouched; a backup can't be restored into the wrong company;
// the read-only integrity check passes afterwards.
// On a throw-away database. Run with: npm run test:backup-restore
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("backuprestore");
const PORT = Number(process.env.BACKUP_RESTORE_TEST_PORT || 4694);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "1", SNAPSHOT_TICK_MS: "1000", FINMAN_TEST_MODE: "1" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, raw, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* none */ }
      return { status: r.status, json, text };
    } catch (e) { if (attempt >= 1) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.json; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { const v = c.value && typeof c.value === "object" && "result" in c.value ? c.value.result : c.value; out.push(v == null ? "" : String(v)); })));
  return out.join("\n");
}

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.BR_DEBUG ? "inherit" : "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await sleep(200); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
const fs = require("fs"), os = require("os");
const cli = (...args) => require("child_process").spawnSync(process.execPath, [path.join(ROOT, "scripts", "backup.js"), ...args], { env: ENV, encoding: "utf8" });

async function run() {
  const sa = ok(await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } }), "sa").token;
  const A = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } }), "switch A").token;
  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Restore Beta", admin: { name: "Rs Admin", username: "rs.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  const acc = ok(await api("/api/accounts", { method: "POST", token: B, body: { name: "Rs Customer", currency: "USD" } }), "acct").account;
  const till = ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name: "Rs Till", type: "physical_cash", currency: "USD" } }), "till").account;
  ok(await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token: B, body: { amount: 100, currency: "USD", cashAccountId: till.id, notes: "Rs before backup" } }), "dep1");
  const state = async () => {
    const a = ok(await api(`/api/accounts/${acc.id}`, { token: B }), "acct").account;
    const cash = ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.find((x) => x.id === till.id);
    const h = ok(await api("/api/history?currency=USD", { token: B }), "hist").entries.length;
    return { bal: a.balance, cash: cash.balance, h };
  };
  const aBefore = JSON.stringify(ok(await api("/api/accounts", { token: A }), "A").accounts.map((x) => [x.id, x.balance]));
  const s0 = await state();
  let name;
  await check("a manual backup of company B is stored and can be downloaded", async () => {
    const r = ok(await api("/api/backups", { method: "POST", token: B }), "backup");
    name = (r.backup && r.backup.name) || r.name;
    assert(name, JSON.stringify(r));
    const f = await api(`/api/backups/${encodeURIComponent(name)}`, { token: B, raw: true });
    assert(f.status === 200 && f.buf.length > 100, `download ${f.status}`);
    fs.writeFileSync(path.join(os.tmpdir(), `br-${bId}.json.gz`), f.buf);
  });
  ok(await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token: B, body: { amount: 55, currency: "USD", cashAccountId: till.id, notes: "Rs after backup" } }), "dep2");
  ok(await api(`/api/cash/accounts/${till.id}/withdraw`, { method: "POST", token: B, body: { amount: 7, description: "Rs after backup" } }), "cash out");
  const s1 = await state();
  await check("restoring without --confirm is refused and changes nothing", async () => {
    const r = cli("restore", "--company", bId, "--name", name);
    assert(r.status !== 0, `exit ${r.status} ${r.stdout}`);
    assert(JSON.stringify(await state()) === JSON.stringify(s1), "data changed");
  });
  await check("a company's backup cannot be restored into another company", async () => {
    const r = cli("restore", "--company", "CMP-0001", "--file", path.join(os.tmpdir(), `br-${bId}.json.gz`), "--confirm");
    assert(r.status !== 0, `exit ${r.status}: ${r.stdout}`);
    assert(JSON.stringify(ok(await api("/api/accounts", { token: A }), "A").accounts.map((x) => [x.id, x.balance])) === aBefore, "company A changed");
  });
  await check("restore brings company B back exactly to the backup (balances, cash, history)", async () => {
    const r = cli("restore", "--company", bId, "--name", name, "--confirm");
    assert(r.status === 0, `exit ${r.status}: ${r.stdout} ${r.stderr}`);
    const s2 = await state();
    assert(JSON.stringify(s2) === JSON.stringify(s0), `${JSON.stringify(s2)} vs backup ${JSON.stringify(s0)} (before restore ${JSON.stringify(s1)})`);
  });
  await check("the replaced data was kept as a 'prerestore' backup", async () => {
    const list = ok(await api("/api/backups", { token: B }), "list").backups;
    assert(list.some((b) => /prerestore/.test(b.kind || b.name || "")), JSON.stringify(list.map((b) => b.name)));
  });
  await check("company A is untouched and the integrity check passes", async () => {
    assert(JSON.stringify(ok(await api("/api/accounts", { token: A }), "A").accounts.map((x) => [x.id, x.balance])) === aBefore, "company A changed");
    const r = require("child_process").spawnSync(process.execPath, [path.join(ROOT, "scripts", "integrity-check.js")], { env: ENV, encoding: "utf8" });
    assert(r.status === 0, r.stdout.slice(-800));
  });
  try { fs.unlinkSync(path.join(os.tmpdir(), `br-${bId}.json.gz`)); } catch (e) { /* gone */ }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
