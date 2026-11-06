"use strict";
// NEGATIVE OPENING BALANCE IMPORT round — Import Accounts accepts a
// negative opening balance (a customer who already owes, e.g. -100), created
// exactly like an account made by hand. Run with: npm run test:import-negative
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("importneg");
const PORT = Number(process.env.IMPORT_NEG_TEST_PORT || 4676);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, json };
}

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

async function run() {
  const sa = (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } })).json.token;
  const SA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const csv = "Account #,Account Name,Account Type,Currency,Phone,Email,Status,Opening Balance\r\n" +
    ",Neg Hodan,customer,USD,,,active,-100\r\n" +
    ",Neg Brackets Co,company,SLSH,,,active,\"(250,000)\"\r\n" +
    ",Neg Unicode,customer,USD,,,active,− 12.50\r\n" +
    ",Pos Faarax,customer,USD,,,active,40\r\n" +
    ",Bad Value,customer,USD,,,active,(-5)\r\n";
  const file = { fileName: "neg.csv", fileBase64: Buffer.from(csv).toString("base64") };
  const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

  console.log("\nPreview");
  let pv;
  await check("negative opening balances are valid rows with a clear warning", async () => {
    const r = await api("/api/accounts/import/preview", { method: "POST", token: SA, body: file });
    assert(r.status === 200, `preview ${r.status} ${JSON.stringify(r.json)}`);
    pv = byName(r.json.rows);
    for (const [n, v] of [["Neg Hodan", -100], ["Neg Brackets Co", -250000], ["Neg Unicode", -12.5], ["Pos Faarax", 40]]) {
      assert(pv[n] && pv[n].result === "valid" && pv[n].openingBalance === v, `${n}: ${JSON.stringify(pv[n])}`);
    }
    assert(pv["Neg Hodan"].warnings.some((w) => /Negative opening balance/.test(w)), "warning");
    assert(pv["Bad Value"].result === "invalid", "a malformed value is still refused");
  });

  console.log("\nImport");
  let report;
  await check("import creates the accounts with the negative balances", async () => {
    const r = await api("/api/accounts/import/commit", { method: "POST", token: SA, body: file });
    assert(r.status === 200, `commit ${r.status} ${JSON.stringify(r.json)}`);
    report = r.json;
    const usd = (await api("/api/accounts?currency=USD&search=Neg", { token: SA })).json.accounts;
    const sl = (await api("/api/accounts?currency=SLSH&search=Neg", { token: SA })).json.accounts;
    const h = usd.find((a) => a.name === "Neg Hodan"), u = usd.find((a) => a.name === "Neg Unicode"), b = sl.find((a) => a.name === "Neg Brackets Co");
    assert(h && h.balance === -100 && u && u.balance === -12.5 && b && b.balance === -250000, JSON.stringify([h, u, b].map((a) => a && a.balance)));
  });
  await check("one Opening balance debit posting, the same as an account created by hand", async () => {
    const usd = (await api("/api/accounts?currency=USD&search=Neg%20Hodan", { token: SA })).json.accounts[0];
    const l = (await api(`/api/account-ledger?currency=USD&search=${encodeURIComponent(usd.accountNumber)}`, { token: SA })).json.entries.filter((e) => e.accountId === usd.id);
    assert(l.length === 1 && l[0].type === "withdrawal" && l[0].amount === 100 && l[0].notes === "Opening balance" && l[0].balanceAfter === -100, JSON.stringify(l));
    const acc = (await api(`/api/accounts/${usd.id}`, { token: SA })).json;
    assert(((acc.account || acc).openingBalance) === -100, `openingBalance ${JSON.stringify((acc.account || acc).openingBalance)}`);
  });
  await check("the report says what was created; the bad row is reported, not imported", async () => {
    const txt = JSON.stringify(report);
    assert(/Neg Hodan/.test(txt) && /-\$100\.00|−\$100\.00|\$-100\.00/.test(txt), txt.slice(0, 600));
    assert(/Bad Value/.test(txt) && !(await api("/api/accounts?currency=USD&search=Bad%20Value", { token: SA })).json.accounts.length, "bad row imported");
  });
  await check("without 'Import Opening Balances' a negative balance is refused too", async () => {
    const users = (await api("/api/users", { token: SA })).json.users;
    const m = users.find((u) => u.username === "xasan.cali");
    const o = await api(`/api/users/${m.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "accounts.import", granted: true }, { permissionKey: "accounts.importOpeningBalance", granted: false }], confirmCritical: true } });
    assert(o.status === 200, `override ${o.status}`);
    const M = (await api("/api/auth/login", { method: "POST", body: { username: "xasan.cali", password: PW } })).json.token;
    const f2 = { fileName: "n2.csv", fileBase64: Buffer.from("Account #,Account Name,Account Type,Currency,Phone,Email,Status,Opening Balance\r\n,Neg Refused,customer,USD,,,active,-30\r\n").toString("base64") };
    const r = await api("/api/accounts/import/commit", { method: "POST", token: M, body: f2 });
    assert(r.status === 200 && /requires the 'Import Opening Balances' permission/.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 300));
    assert(!(await api("/api/accounts?currency=USD&search=Neg%20Refused", { token: SA })).json.accounts.length, "created without permission");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
