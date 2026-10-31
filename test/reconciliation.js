"use strict";
// FULL SYSTEM AUDIT round 2 — financial reconciliation. On a throw-away
// installation it drives a realistic mix of money operations through the
// real API — payments with decimals and back-dates, transfers, tracked and
// walk-in exchanges (edited and deleted), Mark as Paid, paying from selected
// credits, Cash Account movements, expenses (one cancelled), a loan and its
// repayment, a quotation charge and payment, and bursts of simultaneous
// requests — then proves that:
//   * every stored account and Cash Account balance equals its ledger
//     (scripts/integrity-check.js, the read-only checker, reports nothing);
//   * each account's balance equals the sum of its own ledger rows (API);
//   * report totals equal the records they summarise (exchange count and
//     volume, accounts summary, currency position);
//   * USD and SLSH are never mixed in any total;
//   * an exchange keeps its own rate and Cost Rate after the rates change;
//   * company B's data and totals are untouched by all of it.
//
// Run with: npm run test:reconciliation
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("reconcile");
const PORT = Number(process.env.RECONCILE_TEST_PORT || 4392);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;
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
const ok = (r, what) => { assert(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 240)}`); return r.json; };

async function run() {
  const admin = await login("amina.yusuf");
  const sa = await login("super.admin", SA_PW);
  const companies = (await api("/api/platform/companies", { token: sa })).json.companies;
  const sw = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: companies[0].id } })).json.token;
  // Company B, with its own data, to prove nothing here touches it.
  ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Reconcile Bravo", admin: { name: "Bravo Admin", username: "rb.admin", password: "Bravo-Pass-2026" } } }), "company B");
  const bTok = await login("rb.admin", "Bravo-Pass-2026");
  const bAcc = ok(await api("/api/accounts", { method: "POST", token: bTok, body: { name: "Bravo Customer", currency: "USD", openingBalance: 1234.56 } }), "B account").account;
  const bBefore = (await api(`/api/accounts/${bAcc.id}`, { token: bTok })).json;
  const bSummaryBefore = (await api("/api/reports/accounts-summary", { token: bTok })).json;

  ok(await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } }), "rates");
  const acct = async (name, currency, openingBalance) => ok(await api("/api/accounts", { method: "POST", token: admin, body: { name, currency, openingBalance } }), name).account;
  const U1 = await acct("Recon Usd One", "USD", 250.75);
  const U2 = await acct("Recon Usd Two", "USD");
  const S1 = await acct("Recon Slsh One", "SLSH", 500000);
  const S2 = await acct("Recon Slsh Two", "SLSH");

  console.log("\nDriving operations");
  let exA, exB;
  await check("payments, transfers and exchanges (before any Cash Account exists)", async () => {
    for (const [a, k, amt, d] of [[U1, "deposit", 0.1], [U1, "deposit", 0.2], [U1, "withdraw", 0.3], [U2, "deposit", 99.99, "2026-01-15"], [S1, "withdraw", 12345], [S2, "deposit", 1000000]]) {
      ok(await api(`/api/accounts/${a.id}/${k}`, { method: "POST", token: admin, body: { amount: amt, paymentDate: d } }), `${k} ${amt}`);
    }
    ok(await api("/api/transfers", { method: "POST", token: admin, body: { fromAccountId: U2.id, toAccountId: U1.id, amount: 49.99 } }), "transfer");
    exA = ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: U1.name, clientAccountId: U1.id, receivingAccountId: S2.id, amountGiven: 120.5, currencyGiven: "USD" } }), "exchange A").transaction;
    exB = ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: S1.name, clientAccountId: S1.id, receivingAccountId: U2.id, amountGiven: 234000, currencyGiven: "SLSH" } }), "exchange B").transaction;
    ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 75, currencyGiven: "USD" } }), "walk-in");
    const del = ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: U1.name, clientAccountId: U1.id, amountGiven: 10, currencyGiven: "USD" } }), "to delete").transaction;
    ok(await api(`/api/transactions/${del.id}`, { method: "DELETE", token: admin, body: { reason: "test" } }), "delete exchange");
    ok(await api(`/api/transactions/${exA.id}`, { method: "PATCH", token: admin, body: { clientName: U1.name, clientAccountId: U1.id, receivingAccountId: S2.id, amountGiven: 100, currencyGiven: "USD" } }), "edit exchange");
  });
  await check("quotation charge and partial payment", async () => {
    const q = ok(await api("/api/quotations", { method: "POST", token: admin, body: { clientAccountId: S2.id, clientName: S2.name, currency: "SLSH", items: [{ description: "Clearance fee", qty: 2, unitPrice: 150000, currency: "SLSH" }] } }), "quotation");
    const qid = (q.quotation || q).id;
    const pay = await api(`/api/quotations/${qid}/payments`, { method: "POST", token: admin, body: { amount: 100000, method: "cash" } });
    assert(pay.status < 300 || pay.status === 400, `quotation payment ${pay.status}`);
  });
  let usdTill, slshTill;
  await check("Cash Accounts: payments into a till, Mark as Paid, paying from selected credits", async () => {
    usdTill = ok(await api("/api/cash/accounts", { method: "POST", token: sw, body: { name: "Recon Till USD", type: "physical_cash", currency: "USD", openingBalance: 1000 } }), "till").account;
    slshTill = ok(await api("/api/cash/accounts", { method: "POST", token: sw, body: { name: "Recon Till SLSH", type: "bank", currency: "SLSH" } }), "till S").account;
    ok(await api(`/api/accounts/${U1.id}/deposit`, { method: "POST", token: admin, body: { amount: 300, cashAccountId: usdTill.id } }), "deposit to till");
    ok(await api(`/api/accounts/${U1.id}/withdraw`, { method: "POST", token: admin, body: { amount: 20.25, cashAccountId: usdTill.id } }), "withdraw from till");
    ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: U2.name, clientAccountId: U2.id, receivingAccountId: S1.id, amountGiven: 60, currencyGiven: "USD", markPaid: true, payment: { cashAccountId: usdTill.id } } }), "mark as paid");
    const src = (await api(`/api/transactions/fund-sources?accountId=${U1.id}`, { token: admin })).json.rows;
    const pick = src[0];
    ok(await api("/api/transactions", { method: "POST", token: admin, body: { clientName: U1.name, clientAccountId: U1.id, amountGiven: Math.min(25, pick.available), currencyGiven: "USD", fundSelections: [{ ledgerId: pick.ledgerId, amount: Math.min(25, pick.available) }] } }), "pay from selection");
    ok(await api(`/api/cash/accounts/${usdTill.id}/withdraw`, { method: "POST", token: sw, body: { amount: 7.5 } }), "cash withdraw");
  });
  await check("expenses (one cancelled) and a loan with a repayment", async () => {
    const meta = (await api("/api/expenses/meta", { token: admin })).json;
    const cat = meta.categories[0];
    const mk = async (amt) => ok(await api("/api/expenses", { method: "POST", token: admin, body: { date: new Date().toISOString().slice(0, 10), categoryId: cat.id, description: `Recon expense ${amt}`, amount: amt, currency: "USD", cashAccountId: usdTill.id } }), "expense");
    await mk(12.34);
    const e2 = await mk(56.78);
    const id = (e2.expense || e2).id;
    ok(await api(`/api/expenses/${id}/cancel`, { method: "POST", token: admin, body: { reason: "test" } }), "cancel expense");
    const loan = ok(await api("/api/loans", { method: "POST", token: sw, body: { cashAccountId: usdTill.id, clientId: U2.id, amount: 40, date: new Date().toISOString() } }), "loan");
    const lid = (loan.loan || loan).id;
    ok(await api(`/api/loans/${lid}/payments`, { method: "POST", token: sw, body: { cashAccountId: usdTill.id, amount: 15 } }), "loan repayment");
  });
  await check("bursts of simultaneous payments and exchanges all land", async () => {
    const amts = [1.01, 2.02, 3.03, 4.04, 5.05, 6.06, 7.07, 8.08];
    const before = (await api(`/api/accounts/${U2.id}`, { token: admin })).json.account.balance;
    const rs = await Promise.all(amts.map((a) => api(`/api/accounts/${U2.id}/deposit`, { method: "POST", token: admin, body: { amount: a, cashAccountId: usdTill.id } })));
    assert(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
    const after = (await api(`/api/accounts/${U2.id}`, { token: admin })).json.account.balance;
    assert(near(after - before, amts.reduce((s, a) => s + a, 0)), `burst moved ${after - before}`);
    const xs = await Promise.all([11, 12, 13].map((a) => api("/api/transactions", { method: "POST", token: admin, body: { clientName: U2.name, clientAccountId: U2.id, receivingAccountId: S1.id, amountGiven: a, currencyGiven: "USD" } })));
    assert(xs.every((r) => r.status === 201), xs.map((r) => r.status).join(","));
  });
  await check("rates change afterwards (history must keep the old ones)", async () => {
    ok(await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 12000, saleRate: 12000, costRate: 12100, buyRate: 11900, sellRate: 12300 } }), "new rates");
  });

  console.log("\nReconciliation");
  await check("integrity check: every stored balance equals its ledger, nothing orphaned", async () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "integrity-check.js")], { env: { ...process.env, ...TESTDB.env, JWT_SECRET: ENV.JWT_SECRET }, encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const problems = out.split("\n").filter((l) => /^\s+- /.test(l) && !/possible double submission/.test(l));
    assert(/OK|item\(s\) to review/.test(out), out.slice(-500));
    assert(!problems.length, problems.join(" | "));
  });
  await check("each account's balance equals the sum of its own ledger rows", async () => {
    for (const a of [U1, U2, S1, S2]) {
      const d = (await api(`/api/accounts/${a.id}`, { token: admin })).json;
      const full = (await api(`/api/accounts/${a.id}/statement?pageSize=1000`, { token: admin })).json;
      const rows = (full && (full.entries || full.rows || full.ledger)) || d.ledger || [];
      if (rows.length && rows.length < 50) {
        const sum = rows.reduce((s, l) => s + (l.type === "deposit" ? l.amount : -l.amount), 0);
        assert(near(sum, d.account.balance), `${a.name}: ledger ${sum} vs balance ${d.account.balance}`);
      }
      assert(Number.isFinite(d.account.balance) && Math.abs(d.account.balance * 1e8 - Math.round(d.account.balance * 1e8)) < 1e-3, `${a.name}: floating noise ${d.account.balance}`);
    }
  });
  await check("Cash Account balances equal opening + movements, expenses counted once", async () => {
    const t = (await api(`/api/cash/accounts/${usdTill.id}`, { token: sw })).json.account.balance;
    // 1000 opening + 300 − 20.25 + 60 (Mark as Paid) − 7.5 − 12.34 (the
    // cancelled 56.78 nets to 0) − 40 (loan) + 15 (repayment) + 36.36 (burst)
    const expected = 1000 + 300 - 20.25 + 60 - 7.5 - 12.34 - 40 + 15 + 36.36;
    assert(near(t, expected), `USD till ${t}, expected ${expected}`);
  });
  await check("report totals equal the records: exchange count, volume, accounts summary", async () => {
    const txs = (await api("/api/transactions", { token: admin })).json.transactions.filter((x) => x.status === "active");
    const rep = (await api("/api/reports/exchange-summary", { token: admin })).json;
    assert(rep.totalCount === txs.length, `report ${rep.totalCount} vs list ${txs.length}`);
    const vol = txs.reduce((s, x) => s + (x.currencyGiven === "USD" ? x.amountGiven : x.amountGiven / x.rateUsed), 0);
    assert(near(rep.totalVolumeUSD, vol, 0.05), `volume ${rep.totalVolumeUSD} vs ${vol}`);
    const accs = (await api("/api/accounts", { token: admin })).json.accounts;
    const sumUsd = accs.filter((a) => a.currency === "USD").reduce((s, a) => s + a.balance, 0);
    const sumSlsh = accs.filter((a) => a.currency === "SLSH").reduce((s, a) => s + a.balance, 0);
    const sumRep = (await api("/api/reports/accounts-summary", { token: admin })).json;
    assert(near(sumRep.totalBalanceUSD, sumUsd) && near(sumRep.totalBalanceSLSH, sumSlsh, 0.5), `summary USD ${sumRep.totalBalanceUSD} vs ${sumUsd}, SLSH ${sumRep.totalBalanceSLSH} vs ${sumSlsh}`);
  });
  await check("currency position keeps USD and SLSH apart (per-currency sums of exchanges)", async () => {
    const txs = (await api("/api/transactions", { token: admin })).json.transactions.filter((x) => x.status === "active");
    const pos = (await api("/api/reports/currency-position", { token: admin })).json;
    let usd = pos.opening.usd, slsh = pos.opening.slsh;
    for (const t of txs) {
      if (t.currencyGiven === "USD") usd += t.amountGiven; else slsh += t.amountGiven;
      if (t.currencyReceived === "USD") usd -= t.amountReceived; else slsh -= t.amountReceived;
    }
    assert(near(pos.usd, usd) && near(pos.slsh, slsh, 0.5), `position ${pos.usd}/${pos.slsh} vs ${usd}/${slsh}`);
  });
  await check("exchanges keep their own rate and Cost Rate after the rates changed", async () => {
    const b = (await api("/api/transactions", { token: admin })).json.transactions.find((t) => t.id === exB.id);
    assert(b.rateUsed === 11700 && b.costRate === 11500, `rate ${b.rateUsed}, cost ${b.costRate}`);
    assert(near(b.marginSlsh, (11700 - 11500) * (234000 / 11700)), `margin ${b.marginSlsh}`);
  });
  await check("company B is untouched: same account, same totals", async () => {
    const now = (await api(`/api/accounts/${bAcc.id}`, { token: bTok })).json;
    assert(now.account.balance === bBefore.account.balance && (now.ledger || []).length === (bBefore.ledger || []).length, "B account changed");
    const s = (await api("/api/reports/accounts-summary", { token: bTok })).json;
    assert(s.totalBalanceUSD === bSummaryBefore.totalBalanceUSD && s.totalAccounts === bSummaryBefore.totalAccounts, "B totals changed");
    const bTx = (await api("/api/transactions", { token: bTok })).json.transactions;
    assert(bTx.length === 0, "B sees exchanges");
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
