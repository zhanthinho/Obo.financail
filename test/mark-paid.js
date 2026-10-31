"use strict";
// MARK AS PAID round — Quick Exchange -> "Mark as Paid (Create Credit)".
// On a throw-away installation it proves (tests 1–12 of the brief):
//   1  without it: one exchange, no Credit, behaviour unchanged;
//   2  with it: the exchange plus ONE ordinary Credit, linked both ways;
//   3  the exchange itself is identical to the same exchange unpaid;
//   4  the Receiving Account gets the received amount exactly once;
//   5  the chosen Cash In To account gets the money, with a normal cash leg;
//   6  both directions use the amount and currency GIVEN, on the From Account;
//   7  a repeated submission creates one exchange and one Credit;
//   8  a failure after the Credit was written rolls everything back;
//   9  another company's accounts are refused and nothing changes;
//  10  the Credit is the same kind of record as one made in Payments;
//  11  the exchange list and Payments history show both, linked;
//  12  reports count the exchange once; balances add up; profit unchanged.
//
// Run with: npm run test:mark-paid
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("markpaid");
const PORT = Number(process.env.MARKPAID_TEST_PORT || 4391);
const FAULT_PORT = PORT + 100;
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers: extra, base = BASE } = {}) {
  const headers = { ...(extra || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json };
}
async function waitUp(base) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;

let admin, sw;
const account = async (name, currency) => {
  const r = await api("/api/accounts", { method: "POST", token: admin, body: { name, currency } });
  assert(r.status === 201, `account ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.account;
};
const bal = async (a) => (await api(`/api/accounts/${a.id}`, { token: admin })).json.account.balance;
const cashBal = async (c) => (await api(`/api/cash/accounts/${c.id}`, { token: sw })).json.account.balance;
const exchanges = async () => (await api("/api/transactions", { token: admin })).json.transactions;
const plainCredits = async (a) => ((await api(`/api/accounts/${a.id}`, { token: admin })).json.ledger || []).filter((l) => l.type === "deposit");
const ex = (body, opts = {}) => api("/api/transactions", { method: "POST", token: admin, body, ...opts });

async function run() {
  admin = await login("amina.yusuf");
  await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } });
  // Cash Accounts are created by the Super Admin (Cash is Super-Admin-only
  // by default); amina (Admin) records payments into them.
  const sa = await login("super.admin", SA_PW);
  const companies = (await api("/api/platform/companies", { token: sa })).json.companies;
  sw = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: companies[0].id } })).json.token;
  const tillUsd = (await api("/api/cash/accounts", { method: "POST", token: sw, body: { name: "Main Till USD", type: "physical_cash", currency: "USD" } })).json.account;
  const tillSlsh = (await api("/api/cash/accounts", { method: "POST", token: sw, body: { name: "Main Till SLSH", type: "physical_cash", currency: "SLSH" } })).json.account;
  assert(tillUsd && tillSlsh, "cash accounts not created");

  const A = await account("Paid Alpha USD", "USD");        // From (USD)
  const R = await account("Paid Romeo SLSH", "SLSH");      // Receiving (SLSH)
  const A2 = await account("Paid Bravo SLSH", "SLSH");     // From (SLSH), reverse direction
  const R2 = await account("Paid Sierra USD", "USD");      // Receiving (USD)
  const base = (extra = {}) => ({ clientName: A.name, clientAccountId: A.id, receivingAccountId: R.id, amountGiven: 100, currencyGiven: "USD", ...extra });
  const paid = (extra = {}) => base({ markPaid: true, payment: { cashAccountId: tillUsd.id }, ...extra });

  console.log("\nRecording");
  let unpaidTx, paidTx;
  await check("1. without Mark as Paid: one exchange, no Credit", async () => {
    const before = (await exchanges()).length, credits = (await plainCredits(A)).length;
    const r = await ex(base());
    assert(r.status === 201 && r.json.transaction.payment === null && r.json.transaction.paidLedgerId === null, `${r.status} ${JSON.stringify(r.json)}`);
    unpaidTx = r.json.transaction;
    assert((await exchanges()).length === before + 1, "exchange count");
    assert((await plainCredits(A)).length === credits, "a Credit was created");
    assert(near(await bal(A), -100) && near(await bal(R), 1130000), `balances ${await bal(A)} / ${await bal(R)}`);
  });
  let balA, balR, balTill;
  await check("2. with Mark as Paid: the exchange and ONE linked ordinary Credit", async () => {
    balA = await bal(A); balR = await bal(R); balTill = await cashBal(tillUsd);
    const r = await ex(paid());
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.json)}`);
    paidTx = r.json.transaction;
    const p = paidTx.payment;
    assert(p && paidTx.paidLedgerId === p.ledgerId && p.type === "deposit", JSON.stringify(p));
    assert(p.account.id === A.id && p.currency === "USD" && near(p.amount, 100) && p.cashAccount.id === tillUsd.id, JSON.stringify(p));
    assert(/^DEP-/.test(p.referenceNumber) && p.reference === paidTx.referenceNumber, `references ${p.referenceNumber} / ${p.reference}`);
  });
  await check("3. the exchange is identical to the same exchange without Mark as Paid", async () => {
    for (const k of ["amountGiven", "currencyGiven", "amountReceived", "currencyReceived", "rateUsed", "profitUsd", "costRate", "fromAccountId", "toAccountId", "clientName", "status"]) {
      assert(JSON.stringify(paidTx[k]) === JSON.stringify(unpaidTx[k]), `${k}: ${paidTx[k]} vs ${unpaidTx[k]}`);
    }
    const listed = (await exchanges()).find((t) => t.id === paidTx.id);
    assert(listed.amountGiven === 100 && listed.amountReceived === 1130000 && listed.referenceNumber === paidTx.referenceNumber, "stored exchange differs");
  });
  await check("4. Receiving Account gets the received SLSH once; From Account nets to zero", async () => {
    assert(near(await bal(R), balR + 1130000), `receiving ${await bal(R)} (was ${balR})`);
    assert(near(await bal(A), balA), `from account moved: ${await bal(A)} (was ${balA})`);
  });
  await check("5. Cash In To receives the $100 through a normal payment cash leg", async () => {
    assert(near(await cashBal(tillUsd), balTill + 100), `till ${await cashBal(tillUsd)} (was ${balTill})`);
    const legs = (await api(`/api/cash/ledger?cashAccountId=${tillUsd.id}`, { token: sw })).json;
    const rows = legs.entries || legs.ledger || legs.rows || legs;
    const leg = (Array.isArray(rows) ? rows : []).find((l) => (l.sourceId || l.source_id) === paidTx.paidLedgerId);
    assert(leg && near(leg.amount, 100) && leg.type === "deposit", `cash leg ${JSON.stringify(leg)}`);
  });
  await check("6. reverse direction (customer gives SLSH): Credit in SLSH on the From Account", async () => {
    const bA2 = await bal(A2), bR2 = await bal(R2), bT = await cashBal(tillSlsh);
    const r = await ex({ clientName: A2.name, clientAccountId: A2.id, receivingAccountId: R2.id, amountGiven: 1170000, currencyGiven: "SLSH", markPaid: true, payment: { cashAccountId: tillSlsh.id, reference: "RCPT-77", paymentDate: "2026-10-30" } });
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.json)}`);
    const p = r.json.transaction.payment;
    assert(p.currency === "SLSH" && near(p.amount, 1170000) && p.account.id === A2.id && p.reference === "RCPT-77" && p.date === "2026-10-30", JSON.stringify(p));
    assert(near(await bal(A2), bA2) && near(await bal(R2), bR2 + 100) && near(await cashBal(tillSlsh), bT + 1170000), "balances");
    const usdTill = await cashBal(tillUsd);
    assert(near(usdTill, balTill + 100), "the USD till moved on a SLSH payment");
  });

  console.log("\nSafety");
  await check("refused: no From Account, combined with selected transactions, missing Cash Account, wrong currency Cash Account", async () => {
    const before = (await exchanges()).length;
    const cases = [
      ["walk-in", { clientName: "Walk-in", amountGiven: 10, currencyGiven: "USD", markPaid: true, payment: { cashAccountId: tillUsd.id } }],
      ["with fund selections", paid({ fundSelections: [{ ledgerId: "x", amount: 100 }] })],
      ["no cash account", base({ markPaid: true, payment: {} })],
      ["SLSH till for a USD credit", base({ markPaid: true, payment: { cashAccountId: tillSlsh.id } })],
      ["bad date", base({ markPaid: true, payment: { cashAccountId: tillUsd.id, paymentDate: "31/31/2026" } })],
      ["markPaid not a boolean", base({ markPaid: "yes" })],
    ];
    for (const [label, body] of cases) {
      const r = await ex(body);
      assert(r.status === 400, `${label}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert((await exchanges()).length === before, "an exchange was saved");
  });
  await check("a role that can't record Payments can't mark an exchange as paid", async () => {
    const cash = await login("cabdi.maxamed");
    const me = (await api("/api/auth/me", { token: cash })).json.user;
    assert(me && me.perms && me.perms.exchangeCreate && !me.perms.accountsManage, `seeded cashier perms: ${JSON.stringify(me && me.perms)}`);
    const r = await api("/api/transactions", { method: "POST", token: cash, body: paid() });
    assert(r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);
    const plain = await api("/api/transactions", { method: "POST", token: cash, body: base({ amountGiven: 1 }) });
    assert(plain.status === 201, `the same cashier can still record the exchange unpaid: ${plain.status}`);
  });
  await check("7. the same submission sent three times: one exchange, one Credit, balances once", async () => {
    const before = (await exchanges()).length, bT = await cashBal(tillUsd), bR = await bal(R);
    const key = crypto.randomBytes(8).toString("hex");
    const rs = await Promise.all([1, 2, 3].map(() => ex(paid({ amountGiven: 20 }), { headers: { "Idempotency-Key": key } })));
    assert(rs.every((r) => r.status === 201), rs.map((r) => r.status).join(","));
    assert(new Set(rs.map((r) => r.json.transaction.id)).size === 1, "different exchanges answered");
    assert((await exchanges()).length === before + 1, "exchange count");
    assert(near(await cashBal(tillUsd), bT + 20) && near(await bal(R), bR + 226000), "balances applied more than once");
  });
  await check("8. a failure after the Credit is written rolls everything back", async () => {
    const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...ENV, PORT: String(FAULT_PORT), FINMAN_TEST_FAULT: "exchange-after-payment" }, stdio: "ignore" });
    try {
      await waitUp(`http://localhost:${FAULT_PORT}`);
      const before = (await exchanges()).length, credits = (await plainCredits(A)).length, bA = await bal(A), bR = await bal(R), bT = await cashBal(tillUsd);
      const tok = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW }, base: `http://localhost:${FAULT_PORT}` })).json.token;
      const r = await api("/api/transactions", { method: "POST", token: tok, body: paid(), base: `http://localhost:${FAULT_PORT}` });
      assert(r.status === 500, `status ${r.status}`);
      assert((await exchanges()).length === before, "an exchange remained");
      assert((await plainCredits(A)).length === credits, "a Credit remained");
      assert(near(await bal(A), bA) && near(await bal(R), bR) && near(await cashBal(tillUsd), bT), "balances changed");
    } finally { srv.kill(); await new Promise((r) => setTimeout(r, 300)); }
  });
  await check("9. another company's Cash Account or account is refused; nothing changes", async () => {
    const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Other Paid Co", admin: { name: "Other Paid", username: "other.paid", password: "OtherPaid-2026" } } });
    assert(c.status === 201, `company ${c.status}`);
    const oid = (await api("/api/platform/companies", { token: sa })).json.companies.find((x) => x.name === "Other Paid Co").id;
    const osw = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: oid } })).json.token;
    const oTill = (await api("/api/cash/accounts", { method: "POST", token: osw, body: { name: "Other Till", type: "bank", currency: "USD" } })).json.account;
    const oAcc = (await api("/api/accounts", { method: "POST", token: osw, body: { name: "Other Customer", currency: "USD" } })).json.account;
    const before = (await exchanges()).length, bA = await bal(A), bT = await cashBal(tillUsd);
    const r1 = await ex(base({ markPaid: true, payment: { cashAccountId: oTill.id } }));
    assert(r1.status === 400, `other company's till: ${r1.status}`);
    const r2 = await ex({ clientName: "x", clientAccountId: oAcc.id, amountGiven: 5, currencyGiven: "USD", markPaid: true, payment: { cashAccountId: tillUsd.id } });
    assert(r2.status === 404, `other company's account: ${r2.status}`);
    assert((await exchanges()).length === before && near(await bal(A), bA) && near(await cashBal(tillUsd), bT), "something changed");
    const oBal = (await api(`/api/cash/accounts/${oTill.id}`, { token: osw })).json.account.balance;
    assert(near(oBal, 0), "other company's till moved");
  });

  console.log("\nSame record as a Payment, visible everywhere, counted once");
  await check("10. the Credit matches an ordinary Payment made in the Payments module", async () => {
    const r = await api(`/api/accounts/${A.id}/deposit`, { method: "POST", token: admin, body: { amount: 5, cashAccountId: tillUsd.id, reference: "MANUAL-1" } });
    assert(r.status === 200, `deposit ${r.status} ${JSON.stringify(r.json)}`);
    const credits = await plainCredits(A);
    const manual = credits.find((l) => l.reference === "MANUAL-1"), fromQx = credits.find((l) => l.id === paidTx.paidLedgerId);
    assert(manual && fromQx, "credits not found in the account ledger");
    for (const k of ["type", "currency", "cashAccountId"]) assert(JSON.stringify(manual[k]) === JSON.stringify(fromQx[k]), `${k}: ${manual[k]} vs ${fromQx[k]}`);
    assert(/^DEP-/.test(manual.referenceNumber) && /^DEP-/.test(fromQx.referenceNumber), "reference series differ");
    const pay = (await api("/api/history?currency=USD&type=deposit", { token: admin })).json.entries;
    const both = pay.filter((e) => e.id === manual.id || e.id === fromQx.id || e.ledgerId === manual.id || e.ledgerId === fromQx.id || (e.raw && (e.raw.id === manual.id || e.raw.id === fromQx.id)));
    assert(both.length === 2, `Payments history shows ${both.length} of the 2 credits`);
  });
  await check("11. the exchange list links the Credit; Payments history names the exchange", async () => {
    const listed = (await exchanges()).find((t) => t.id === paidTx.id);
    assert(listed.payment && listed.payment.ledgerId === paidTx.paidLedgerId && listed.payment.referenceNumber === paidTx.payment.referenceNumber, "link missing from the exchange list");
    const unpaid = (await exchanges()).find((t) => t.id === unpaidTx.id);
    assert(unpaid.payment === null, "unpaid exchange shows a payment");
    const hist = (await api(`/api/history?currency=USD&search=${encodeURIComponent(paidTx.referenceNumber)}`, { token: admin })).json.entries;
    assert(hist.some((e) => e.recordType !== "exchange" && /Payment for exchange/.test(e.notes || "")), "Payments history doesn't name the exchange");
    assert(hist.some((e) => e.recordType === "exchange" && e.id === paidTx.id), "exchange missing from history");
    assert(hist.filter((e) => e.recordType === "exchange").length === 1, "the exchange appears more than once");
  });
  await check("12. reports count each exchange once, profit unchanged, balances add up", async () => {
    const all = await exchanges();
    const rep = (await api("/api/reports/exchange-summary", { token: admin })).json;
    const active = all.filter((t) => t.status === "active");
    assert(rep.totalCount === active.length, `report counts ${rep.totalCount}, list has ${active.length} active`);
    const paidOnes = all.filter((t) => t.payment);
    assert(paidOnes.length === 3, `paid exchanges ${paidOnes.length}`);
    // A paid exchange's margin equals its unpaid twin's (same $100 at the same rates).
    assert(near(paidTx.profitUsd, unpaidTx.profitUsd), "profit differs");
    // From Account: only the unpaid exchanges ($100, and the cashier's $1)
    // and the manual $5 credit move it — the paid ones net to zero.
    assert(near(await bal(A), -100 - 1 + 5), `From Account balance ${await bal(A)}`);
    // Cash till: $100 + $20 (paid exchanges) + $5 (manual) = $125.
    assert(near(await cashBal(tillUsd), 125), `USD till ${await cashBal(tillUsd)}`);
  });
}

async function browserChecks() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  const A = await account("Paid Browser Alpha", "USD");
  const R = await account("Paid Browser Romeo", "SLSH");
  try {
    const c = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
    await p.getByText("Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /New transaction/ }).first().click();
    await p.waitForSelector("#qx-amount", { timeout: 10000 });
    await check("UI: Mark as Paid is unchecked and unavailable for a walk-in", async () => {
      assert(!(await p.isChecked("#qx-markpaid")) && await p.isDisabled("#qx-markpaid"), "checkbox state");
    });
    await check("UI: with a From Account it opens the payment fields (Cash In To, Reference, Date)", async () => {
      await p.getByRole("radio", { name: /Track in Account/ }).click(); await p.waitForTimeout(300);
      await p.selectOption("#qx-from", A.id); await p.selectOption("#qx-to", R.id); await p.waitForTimeout(500);
      await p.fill("#qx-amount", "50");
      await p.check("#qx-markpaid"); await p.waitForTimeout(800);
      const t = await p.locator(".gk-qx-paid").innerText();
      assert(/Credit to/.test(t) && /Paid Browser Alpha/i.test(t) && /\$50\.00/.test(t) && /Receiving Account/.test(t), t);
      assert(await p.locator("#qx-pay-cash").count() && await p.locator("#qx-pay-ref").count() && await p.locator("#qx-pay-date").count(), "fields missing");
    });
    await check("UI: recording creates the exchange with its linked Credit", async () => {
      const opts = await p.locator("#qx-pay-cash option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
      const usd = opts.find((o) => /Main Till USD/i.test(o.t));
      await p.selectOption("#qx-pay-cash", usd.v);
      await p.fill("#qx-pay-ref", "UI-PAY-1");
      await p.locator('button:has-text("Record Exchange")').click(); await p.waitForTimeout(2500);
      const t = (await exchanges()).find((x) => x.fromAccountId === A.id);
      assert(t && t.payment && t.payment.reference === "UI-PAY-1" && near(t.payment.amount, 50), JSON.stringify(t && t.payment));
      assert(near(await bal(A), 0) && near(await bal(R), 565000), "balances");
    });
    await c.close();
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(BASE); await run(); await browserChecks(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  await check("the server logged no unhandled errors", async () => { assert(!bad.length, bad.slice(0, 5).join(" | ")); });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
