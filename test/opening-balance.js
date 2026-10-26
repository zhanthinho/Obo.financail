"use strict";
// OPENING BALANCE (Customer / Company Information) round — regression tests.
// Proves, over real HTTP on a throw-away installation, that the Opening
// Balance on the Create/Edit Customer and Company forms is saved, shown,
// edited and cleared correctly; that it lives in exactly ONE ledger entry
// (never double-counted in balances or totals); and that no other account,
// transaction or total changes.
//
// Run with: npm run test:opening-balance
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".opening-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("opening-balance");
const PORT = Number(process.env.OPENING_TEST_PORT || 4340);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PW } })).json.token;
const getAcc = async (t, id) => (await api(`/api/accounts/${id}`, { token: t })).json;
// Every account except `skip`, with its balance — to prove nothing else moved.
async function snapshot(t, skip) {
  const out = {};
  for (const cur of ["USD", "SLSH"]) {
    const r = await api(`/api/accounts?currency=${cur}`, { token: t });
    for (const a of r.json.accounts) if (!skip.includes(a.id)) out[a.id] = a.balance;
  }
  return out;
}
function ledgerOf(detail) {
  const a = detail.account || detail;
  return (detail.ledger || detail.entries || a.ledger || []);
}

async function run() {
  const admin = await login("amina.yusuf");
  const viewer = await login("sahra.ismail");
  const before = await snapshot(admin, []);
  const txBefore = (await api("/api/transactions", { token: admin })).json.transactions.length;
  let cust, comp;

  console.log("\nCustomer Information");
  await check("create a USD customer with Opening Balance 500 → balance 500, shown as openingBalance", async () => {
    const r = await api("/api/accounts", { method: "POST", token: admin, body: { name: "Opening Probe Customer", accountType: "customer", currency: "USD", openingBalance: 500 } });
    assert(r.status === 201, `create failed: ${r.status} ${JSON.stringify(r.json)}`);
    cust = r.json.account;
    assert(near(cust.openingBalance, 500) && near(cust.balance, 500), `got opening ${cust.openingBalance}, balance ${cust.balance}`);
  });
  await check("a later deposit adds on top of it (no double-count)", async () => {
    const r = await api(`/api/accounts/${cust.id}/deposit`, { method: "POST", token: admin, body: { amount: 100 } });
    assert(r.status === 200 || r.status === 201, `deposit failed: ${r.status} ${JSON.stringify(r.json)}`);
    const a = (await getAcc(admin, cust.id)).account;
    assert(near(a.balance, 600) && near(a.openingBalance, 500), `balance ${a.balance}, opening ${a.openingBalance}`);
  });
  await check("editing it to 750 moves the balance by exactly +250 and keeps ONE opening entry", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { openingBalance: 750 } });
    assert(r.status === 200, `edit failed: ${r.status} ${JSON.stringify(r.json)}`);
    const d = await getAcc(admin, cust.id);
    assert(near(d.account.openingBalance, 750) && near(d.account.balance, 850), `opening ${d.account.openingBalance}, balance ${d.account.balance}`);
    const opens = ledgerOf(d).filter((e) => /opening balance/i.test(e.notes || e.description || ""));
    assert(opens.length === 1, `expected exactly one opening entry, found ${opens.length}`);
  });
  await check("a negative Opening Balance (money owed) is accepted: -200 → balance -100", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { openingBalance: -200 } });
    assert(r.status === 200, `edit failed: ${r.status}`);
    const a = (await getAcc(admin, cust.id)).account;
    assert(near(a.openingBalance, -200) && near(a.balance, -100), `opening ${a.openingBalance}, balance ${a.balance}`);
  });
  await check("setting it to 0 removes the opening entry: balance back to the deposit (100)", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { openingBalance: 0 } });
    assert(r.status === 200, `edit failed: ${r.status}`);
    const d = await getAcc(admin, cust.id);
    assert(near(d.account.openingBalance, 0) && near(d.account.balance, 100), `opening ${d.account.openingBalance}, balance ${d.account.balance}`);
  });
  await check("adding one back to an account that had none (300) → balance 400, dated first", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { openingBalance: 300 } });
    assert(r.status === 200, `edit failed: ${r.status}`);
    const d = await getAcc(admin, cust.id);
    assert(near(d.account.balance, 400), `balance ${d.account.balance}`);
    // Applied first: its running balance is the opening amount itself.
    const open = ledgerOf(d).find((e) => /opening balance/i.test(e.notes || e.description || ""));
    assert(open && near(open.balanceAfter, 300), `opening entry running balance ${open && open.balanceAfter} (expected 300)`);
  });
  await check("editing other fields without openingBalance leaves the balance alone", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { contact: "+252 63 111 2222" } });
    assert(r.status === 200, `edit failed: ${r.status}`);
    const a = (await getAcc(admin, cust.id)).account;
    assert(near(a.balance, 400) && near(a.openingBalance, 300), `balance ${a.balance}`);
  });
  await check("invalid amounts are refused (400) and change nothing", async () => {
    for (const bad of ["abc", "1e20", "NaN"]) {
      const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: admin, body: { openingBalance: bad } });
      assert(r.status === 400, `"${bad}" accepted (${r.status})`);
    }
    const c = await api("/api/accounts", { method: "POST", token: admin, body: { name: "Bad Opening Probe", accountType: "customer", currency: "USD", openingBalance: "12x" } });
    assert(c.status === 400, `create with "12x" accepted (${c.status})`);
    assert(near((await getAcc(admin, cust.id)).account.balance, 400), "balance changed");
  });

  console.log("\nCompany Information");
  await check("create an SLSH company with Opening Balance 1,000,000", async () => {
    const r = await api("/api/accounts", { method: "POST", token: admin, body: { name: "Opening Probe Company Ltd", accountType: "company", currency: "SLSH", openingBalance: "1,000,000" } });
    assert(r.status === 201, `create failed: ${r.status} ${JSON.stringify(r.json)}`);
    comp = r.json.account;
    assert(near(comp.openingBalance, 1000000) && near(comp.balance, 1000000) && comp.accountType === "company", `opening ${comp.openingBalance}, balance ${comp.balance}`);
  });
  await check("edit the company's Opening Balance to 1,250,000 → saved and shown", async () => {
    const r = await api(`/api/accounts/${comp.id}`, { method: "PATCH", token: admin, body: { openingBalance: 1250000 } });
    assert(r.status === 200, `edit failed: ${r.status}`);
    const a = (await getAcc(admin, comp.id)).account;
    assert(near(a.openingBalance, 1250000) && near(a.balance, 1250000), `opening ${a.openingBalance}`);
  });
  await check("the customer's and the company's opening balances are independent", async () => {
    assert(near((await getAcc(admin, cust.id)).account.openingBalance, 300), "customer opening changed");
  });

  console.log("\nSafety");
  await check("a user without account-management permission cannot change it (403)", async () => {
    const r = await api(`/api/accounts/${cust.id}`, { method: "PATCH", token: viewer, body: { openingBalance: 999 } });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await check("a deactivated account's Opening Balance can't be changed", async () => {
    await api(`/api/accounts/${comp.id}/deactivate`, { method: "POST", token: admin, body: { reason: "test" } });
    const r = await api(`/api/accounts/${comp.id}`, { method: "PATCH", token: admin, body: { openingBalance: 5 } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await api(`/api/accounts/${comp.id}/reactivate`, { method: "POST", token: admin });
  });
  await check("no other account's balance changed", async () => {
    const after = await snapshot(admin, [cust.id, comp.id]);
    const moved = Object.keys(before).filter((id) => !near(before[id], after[id]));
    assert(moved.length === 0, `${moved.length} other account(s) changed`);
  });
  await check("no exchange transactions were added or changed", async () => {
    const n = (await api("/api/transactions", { token: admin })).json.transactions.length;
    assert(n === txBefore, `${txBefore} -> ${n}`);
  });
  await check("totals count each opening balance once (Accounts Summary = sum of account balances)", async () => {
    const sum = await api("/api/reports/accounts-summary", { token: admin });
    let usd = 0, slsh = 0;
    for (const cur of ["USD", "SLSH"]) for (const a of (await api(`/api/accounts?currency=${cur}`, { token: admin })).json.accounts) { if (a.currency === "USD") usd += a.balance; else slsh += a.balance; }
    const deact = (await api("/api/accounts/deactivated", { token: admin })).json;
    for (const a of (deact.accounts || [])) { if (a.currency === "USD") usd += a.balance; else slsh += a.balance; }
    assert(near(sum.json.totalBalanceUSD, usd) && near(sum.json.totalBalanceSLSH, slsh), `report USD ${sum.json.totalBalanceUSD} vs ${usd}; SLSH ${sum.json.totalBalanceSLSH} vs ${slsh}`);
  });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await run(); } finally { srv.kill(); }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
