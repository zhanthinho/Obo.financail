"use strict";
// FULL SYSTEM AUDIT round — regression tests for the problems that audit
// confirmed and fixed. On a throw-away installation it proves that:
//   * running balances carry no floating-point noise (0.1 + 0.2 − 0.3 is 0,
//     not 0.0000000000000000555), for customer and Cash accounts;
//   * a transfer of the full balance shown on screen is accepted, and two
//     transfers racing for the same money can't both succeed;
//   * an exchange refuses an unknown currency, an unreadable date (was a
//     500) and an amount received of zero;
//   * true / [5] / "12abc" are never accepted as amounts or rates, while
//     plain numbers and numeric text still are;
//   * a rate above the system's own ceiling can't be saved;
//   * "Sign out" ends that session on the server (a copied token stops
//     working) without signing the user out anywhere else.
//
// Run with: npm run test:audit-fixes
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("auditfixes");
const PORT = Number(process.env.AUDIT_FIXES_TEST_PORT || 4393);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
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
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;

let admin;
let seq = 0;
async function newAccount(currency = "USD") {
  seq += 1;
  const r = await api("/api/accounts", { method: "POST", token: admin, body: { name: `Audit Probe ${seq} ${Date.now()}`, currency } });
  assert(r.status === 201, `account ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.account;
}
const move = (id, kind, amount) => api(`/api/accounts/${id}/${kind}`, { method: "POST", token: admin, body: { amount } });
const balanceOf = async (id) => (await api(`/api/accounts/${id}`, { token: admin })).json.account.balance;

async function run() {
  admin = await login("amina.yusuf");
  assert(admin, "admin could not sign in");

  console.log("\nBalances without floating-point noise");
  await check("0.1 + 0.2 − 0.3 leaves a customer balance of exactly 0", async () => {
    const a = await newAccount();
    await move(a.id, "deposit", 0.1); await move(a.id, "deposit", 0.2); await move(a.id, "withdraw", 0.3);
    const b = await balanceOf(a.id);
    assert(b === 0, `balance is ${b}`);
    const led = (await api(`/api/accounts/${a.id}`, { token: admin })).json.ledger || [];
    assert(led.every((e) => Math.abs(e.balanceAfter * 1e8 - Math.round(e.balanceAfter * 1e8)) < 1e-6), JSON.stringify(led.map((e) => e.balanceAfter)));
  });
  await check("the full balance shown (0.30 − 0.10 = 0.20) can be transferred", async () => {
    const a = await newAccount(), b = await newAccount();
    await move(a.id, "deposit", 0.3); await move(a.id, "withdraw", 0.1);
    const r = await api("/api/transfers", { method: "POST", token: admin, body: { fromAccountId: a.id, toAccountId: b.id, amount: 0.2 } });
    assert(r.status === 201, `transfer ${r.status} ${JSON.stringify(r.json)}`);
    assert(await balanceOf(a.id) === 0 && await balanceOf(b.id) === 0.2, "balances after transfer");
  });
  await check("more than the balance is still refused", async () => {
    const a = await newAccount(), b = await newAccount();
    await move(a.id, "deposit", 5);
    const r = await api("/api/transfers", { method: "POST", token: admin, body: { fromAccountId: a.id, toAccountId: b.id, amount: 5.01 } });
    assert(r.status === 400 && /Insufficient/.test(r.json.error), `${r.status} ${JSON.stringify(r.json)}`);
  });
  await check("two transfers racing for the same money: only one goes through", async () => {
    const a = await newAccount(), b = await newAccount(), c = await newAccount();
    await move(a.id, "deposit", 10);
    const [r1, r2] = await Promise.all([
      api("/api/transfers", { method: "POST", token: admin, body: { fromAccountId: a.id, toAccountId: b.id, amount: 8 } }),
      api("/api/transfers", { method: "POST", token: admin, body: { fromAccountId: a.id, toAccountId: c.id, amount: 8 } }),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 201).length;
    assert(ok === 1, `${ok} transfers succeeded (${r1.status}, ${r2.status})`);
    const bal = await balanceOf(a.id);
    assert(bal === 2, `source balance ${bal}`);
  });
  console.log("\nExchange input validation");
  await check("an unknown currency is refused (was saved as USD -> SLSH)", async () => {
    for (const cur of ["EUR", "usd", "", 123]) {
      const r = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 5, currencyGiven: cur } });
      assert(r.status === 400, `${JSON.stringify(cur)} -> ${r.status}`);
    }
    const ok = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 5 } });
    assert(ok.status === 201 && ok.json.transaction.currencyGiven === "USD", "leaving it out still means USD");
  });
  await check("an unreadable date is a 400, not a server error (create and edit)", async () => {
    const r = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD", date: "garbage" } });
    assert(r.status === 400, `create ${r.status}`);
    const t = (await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 6, currencyGiven: "USD" } })).json.transaction;
    const p = await api(`/api/transactions/${t.id}`, { method: "PATCH", token: admin, body: { clientName: "Walk-in", amountGiven: 6, currencyGiven: "USD", date: "31/31/2026" } });
    assert(p.status === 400, `edit ${p.status}`);
  });
  await check("an amount received of zero is refused", async () => {
    const r = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD", amountReceived: 0 } });
    assert(r.status === 400, `typed 0 -> ${r.status}`);
    const r2 = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 1, currencyGiven: "SLSH" } });
    assert(r2.status === 400, `SLSH 1 (rounds to $0.00) -> ${r2.status}`);
  });

  console.log("\nStrict numbers");
  await check("true, [5], {} and '12abc' are never amounts", async () => {
    const a = await newAccount(), b = await newAccount();
    const bad = [true, [5], { v: 5 }, "12abc"];
    const routes = (v) => [
      [`/api/accounts/${a.id}/deposit`, { amount: v }],
      [`/api/accounts/${a.id}/withdraw`, { amount: v }],
      ["/api/transfers", { fromAccountId: a.id, toAccountId: b.id, amount: v }],
      ["/api/transactions", { clientName: "Walk-in", amountGiven: v, currencyGiven: "USD" }],
      ["/api/transactions", { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD", rateUsed: v }],
      ["/api/transactions", { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD", amountReceived: v }],
      ["/api/transactions", { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD", profitUsd: v }],
      ["/api/accounts", { name: `Strict ${Date.now()}`, currency: "USD", openingBalance: v }],
      ["/api/quotations", { clientName: "Strict", currency: "USD", items: [{ description: "x", qty: v, unitPrice: 5, currency: "USD" }] }],
      ["/api/rate-history", { dailyRate: v, saleRate: 8000 }],
    ];
    const accepted = [];
    for (const v of bad) for (const [p, body] of routes(v)) {
      const r = await api(p, { method: "POST", token: admin, body });
      if (r.status < 300) accepted.push(`${p} ${JSON.stringify(v)}`);
    }
    const r = await api("/api/accounts/bulk-deposit-withdraw", { method: "POST", token: admin, body: { currency: "USD", items: [{ accountId: a.id, type: "deposit", amount: true }] } });
    if (r.status < 300 && !(r.json && r.json.itemErrors && r.json.itemErrors.length)) accepted.push("bulk true");
    assert(!accepted.length, accepted.join(" | "));
    assert(await balanceOf(a.id) === 0, "the account balance moved");
  });
  await check("plain numbers and numeric text still work", async () => {
    const a = await newAccount();
    assert((await move(a.id, "deposit", "12.50")).status === 200, "text amount refused");
    assert((await move(a.id, "deposit", 7)).status === 200, "number refused");
    assert(await balanceOf(a.id) === 19.5, `balance ${await balanceOf(a.id)}`);
  });
  await check("a rate above the system ceiling (1e9) can't be saved", async () => {
    const r = await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 1e16, saleRate: 8000 } });
    assert(r.status === 400, `daily ${r.status}`);
    const r2 = await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 8000, saleRate: 8000, costRate: 5e9 } });
    assert(r2.status === 400, `cost ${r2.status}`);
    const ok = await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 8750, saleRate: 8650, costRate: 8800, buyRate: 8700, sellRate: 8900 } });
    assert(ok.status < 300, `normal rates refused ${ok.status}`);
  });

  // (last of the money checks: once a Cash Account exists, a payment must
  // name one, which the checks above don't.)
  await check("Cash Account balances: 0.1 + 0.2 − 0.3 is exactly 0", async () => {
    const sa = await login("super.admin", SA_PW);
    const companies = (await api("/api/platform/companies", { token: sa })).json.companies;
    const sw = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: companies[0].id } })).json.token;
    const acc = (await api("/api/cash/accounts", { method: "POST", token: sw, body: { name: "Audit Till", type: "physical_cash", currency: "USD" } })).json.account;
    assert(acc, "cash account not created");
    for (const [k, amt] of [["deposit", 0.1], ["deposit", 0.2], ["withdraw", 0.3]]) {
      const r = await api(`/api/cash/accounts/${acc.id}/${k}`, { method: "POST", token: sw, body: { amount: amt } });
      assert(r.status < 300, `${k} ${r.status} ${JSON.stringify(r.json)}`);
    }
    const bal = (await api(`/api/cash/accounts/${acc.id}`, { token: sw })).json.account.balance;
    assert(bal === 0, `cash balance ${bal}`);
  });

  console.log("\nServer-side sign-out");
  await check("signing out ends that session; a copy of its token is refused", async () => {
    const s1 = await login("xasan.cali"), s2 = await login("xasan.cali");
    assert((await api("/api/auth/me", { token: s1 })).status === 200, "session 1 not working");
    const out = await api("/api/auth/logout", { method: "POST", token: s1 });
    assert(out.status === 200, `logout ${out.status}`);
    for (const p of ["/api/auth/me", "/api/accounts", "/api/transactions"]) {
      const r = await api(p, { token: s1 });
      assert(r.status === 401, `${p} still answers the signed-out token (${r.status})`);
    }
    assert((await api("/api/auth/me", { token: s2 })).status === 200, "the user's other session was signed out too");
  });
  await check("a Super Admin sign-out works the same way", async () => {
    const sa = await login("super.admin", SA_PW);
    assert((await api("/api/platform/companies", { token: sa })).status === 200, "SA session not working");
    assert((await api("/api/auth/logout", { method: "POST", token: sa })).status === 200, "logout");
    assert((await api("/api/platform/companies", { token: sa })).status === 401, "SA token still works");
  });
  await check("sign-out without a valid token is refused", async () => {
    assert((await api("/api/auth/logout", { method: "POST" })).status === 401, "no token");
    assert((await api("/api/auth/logout", { method: "POST", token: "a.b.c" })).status === 401, "garbage token");
  });
}

async function main() {
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await run(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  await check("the server logged no unhandled errors", async () => { assert(!bad.length, bad.slice(0, 5).join(" | ")); });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
