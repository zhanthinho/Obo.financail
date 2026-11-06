"use strict";
// PROFESSIONAL TRANSACTION MANAGEMENT round — the modules stay separate
// (Payments, Exchanges, Transfers, Quotations, Credits & Debits, Cash
// Account) and the unified Transaction History lists every record once in
// its own module, with the postings and cash entries it made linked to it.
// On a throw-away database. Run with: npm run test:transaction-history
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("unihist");
const PORT = Number(process.env.UNIFIED_HISTORY_TEST_PORT || 4672);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, raw } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* none */ }
      return { status: r.status, json, text };
    } catch (e) { if (attempt >= 1) throw e; await new Promise((r) => setTimeout(r, 150)); }
  }
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.json; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

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
  const sa = await login("super.admin", SA_PW);
  const SA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const amina = ok(await api("/api/users", { token: SA }), "users").users.find((u) => u.username === "amina.yusuf");
  ok(await api(`/api/users/${amina.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "cash.view", granted: true }], confirmCritical: true } }), "cash.view");
  const A = await login("amina.yusuf", PW);
  const ctx = {};
  const hist = async (q, token = A) => ok(await api(`/api/history?withSummary=1&${q}`, { token }), `history ${q}`);
  const before = await hist("currency=USD");
  const beforeSl = await hist("currency=SLSH");

  const mk = async (name, currency) => ok(await api("/api/accounts", { method: "POST", token: A, body: { name, currency } }), "account").account;
  ctx.u = await mk("Uh Customer Hodan", "USD");
  ctx.s = await mk("Uh Customer Hodan", "SLSH");
  ctx.o = await mk("Uh Other Party", "USD");
  ctx.till = ok(await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "UH Till USD", type: "physical_cash", currency: "USD" } }), "till").account;

  ctx.dep = ok(await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: A, body: { amount: 100, currency: "USD", cashAccountId: ctx.till.id, notes: "UH cash credit" } }), "deposit");
  ctx.wd = ok(await api(`/api/accounts/${ctx.u.id}/withdraw`, { method: "POST", token: A, body: { amount: 30, currency: "USD", cashAccountId: ctx.till.id, notes: "UH plain debit" } }), "withdraw");
  ctx.ex = ok(await api("/api/transactions", { method: "POST", token: A, body: { clientName: ctx.u.name, clientAccountId: ctx.u.id, receivingAccountId: ctx.s.id, amountGiven: 50, currencyGiven: "USD", notes: "UH exchange" } }), "exchange").transaction;
  ctx.tr = ok(await api("/api/transfers", { method: "POST", token: A, body: { fromAccountId: ctx.u.id, toAccountId: ctx.o.id, amount: 10, currency: "USD", notes: "UH transfer" } }), "transfer").transfer;
  ctx.q = ok(await api("/api/quotations", { method: "POST", token: A, body: { clientName: ctx.u.name, accountId: ctx.u.id, currency: "USD", items: [{ description: "UH clearance", qty: 1, unitPrice: 40, currency: "USD" }] } }), "quotation").quotation;
  ok(await api(`/api/quotations/${ctx.q.id}/payments`, { method: "POST", token: A, body: { amount: 15, date: today(), method: "cash" } }), "quotation payment");
  const cats = ok(await api("/api/expense-categories", { token: SA }), "categories").categories;
  ctx.exp = ok(await api("/api/expenses", { method: "POST", token: SA, body: { date: today(), categoryId: cats[0].id, description: "UH office rent", amount: 5, currency: "USD", cashAccountId: ctx.till.id } }), "expense").expense;
  const after = await hist("currency=USD");
  const afterSl = await hist("currency=SLSH");
  const d = (k) => after.summary.tabCounts[k] - before.summary.tabCounts[k];
  const usdUni = (await hist("currency=USD&type=all")).entries;

  console.log("\nModules stay separate — every record counted once");
  await check("All lists each business record once: +7 (credit, debit, exchange, transfer, quotation charge, quotation payment, expense)", async () => {
    assert(d("all") === 7, `all +${d("all")}`);
    assert(after.entries.length === after.summary.tabCounts.all && after.summary.counts.entries === after.entries.length, "count mismatch");
    const ids = after.entries.map((e) => `${e.recordType}:${e.id}`);
    assert(new Set(ids).size === ids.length, "a record listed twice");
  });
  await check("an Exchange counts once (Exchanges +1) — its account postings are not extra records", async () => {
    assert(d("exchange") === 1, `exchange +${d("exchange")}`);
    assert(after.entries.filter((e) => e.recordType === "exchange" && e.id === ctx.ex.id).length === 1, "exchange not listed once");
    assert(!after.entries.some((e) => e.recordType === "ledger" && e.origin === "exchange"), "an exchange posting in All");
  });
  await check("a Transfer counts once (Transfers +1); its two postings appear only under Credits / Debits", async () => {
    assert(d("transfer") === 1, `transfer +${d("transfer")}`);
    const cr = (await hist("currency=USD&type=deposit")).entries.filter((e) => e.relatedReference === ctx.tr.referenceNumber);
    const db = (await hist("currency=USD&type=withdrawal")).entries.filter((e) => e.relatedReference === ctx.tr.referenceNumber);
    assert(cr.length === 1 && db.length === 1 && cr[0].origin === "transfer" && db[0].origin === "transfer", `legs ${cr.length}/${db.length}`);
  });
  await check("Payments +2 (the direct credit and debit only)", async () => {
    assert(d("payment") === 2, `payment +${d("payment")}`);
    const p = (await hist("currency=USD&type=payment")).entries;
    assert(p.every((e) => e.recordType === "ledger" && e.origin === "payment"), "non-payment in Payments");
  });
  await check("Credits / Debits list every account posting with its origin (+3 credits, +4 debits in USD)", async () => {
    assert(d("deposit") === 3 && d("withdrawal") === 4, `credits +${d("deposit")} debits +${d("withdrawal")}`);
    const deb = (await hist("currency=USD&type=withdrawal")).entries;
    const leg = deb.find((e) => e.origin === "exchange" && e.relatedReference === ctx.ex.referenceNumber);
    assert(leg && leg.accountId === ctx.u.id && leg.debit === 50, "exchange debit leg");
    ctx.exLeg = leg;
    // The SLSH side is in SLSH history, as a credit, not in USD.
    assert(afterSl.summary.tabCounts.deposit - beforeSl.summary.tabCounts.deposit === 1, "SLSH credit leg");
    assert(afterSl.summary.tabCounts.exchange === beforeSl.summary.tabCounts.exchange, "a USD exchange counted in SLSH too");
  });
  await check("Quotations: charge and payment each once (+1 charge, +1 payment, +2 quotations)", async () => {
    assert(d("quotation_charge") === 1 && d("quotation_payment") === 1 && d("quotation") === 2, `${d("quotation_charge")}/${d("quotation_payment")}/${d("quotation")}`);
  });
  await check("Cash Account: the payments' cash entries are linked, the expense is an original", async () => {
    assert(d("cash") === 3, `cash +${d("cash")}`);
    const cash = (await hist("currency=USD&type=cash")).entries;
    const payLeg = cash.find((e) => e.sourceType === "customer_payment" && e.cashAccountId === ctx.till.id);
    const expRow = cash.find((e) => e.sourceType === "expense" && e.cashAccountId === ctx.till.id);
    assert(payLeg && payLeg.cashOriginal === false && expRow && expRow.cashOriginal === true, "cash rows");
    assert(!after.entries.some((e) => e.id === payLeg.id) && after.entries.some((e) => e.id === expRow.id), "All: cash leg listed / expense missing");
    ctx.payLeg = payLeg;
  });
  await check("summary cards match the tabs; money stays per currency and Exchange profit is unchanged", async () => {
    const s = after.summary;
    assert(s.counts.exchanges === s.tabCounts.exchange && s.counts.transfers === s.tabCounts.transfer && s.counts.payments === s.tabCounts.payment, "cards");
    assert(s.counts.quotationCharges === s.tabCounts.quotation_charge && s.counts.quotationPayments === s.tabCounts.quotation_payment, "quotation cards");
    assert(!s.money.SLSH, "SLSH money mixed into USD");
    const r2 = (n) => Math.round(n * 100) / 100;
    assert(r2(s.money.USD.credits - before.summary.money.USD.credits) === 115 && r2(s.money.USD.debits - before.summary.money.USD.debits) === 70, `credits/debits ${JSON.stringify(s.money.USD)}`);
    const exProfit = Number(ctx.ex.profitUsd || 0);
    assert(r2(s.profit.usd - before.summary.profit.usd) === r2(exProfit), `profit ${before.summary.profit.usd} -> ${s.profit.usd} (exchange ${exProfit})`);
  });
  await check("labels name the origin: 'Exchange Debit', 'Transfer Credit', 'Expense'", async () => {
    const csvR = await api(`/api/history/export.csv?currency=USD&type=withdrawal&search=${encodeURIComponent(ctx.ex.referenceNumber)}`, { token: A });
    const csv = csvR.text;
    assert(/Exchange Debit/.test(csv) && csv.includes(ctx.ex.referenceNumber), csv.slice(0, 400));
    const csv2 = (await api(`/api/history/export.csv?currency=USD&type=deposit&search=${encodeURIComponent(ctx.tr.referenceNumber)}`, { token: A })).text;
    assert(/Transfer Credit/.test(csv2), csv2.slice(0, 400));
    const csv3 = (await api(`/api/history/export.csv?currency=USD&type=cash&search=${encodeURIComponent("UH office rent")}`, { token: A })).text;
    assert(/^Expense,/m.test(csv3), csv3.slice(0, 400));
  });

  console.log("\nPayment module (Credits & Debits)");
  await check("lists Payments only by default — never an exchange / transfer / quotation posting", async () => {
    const l = ok(await api("/api/account-ledger?currency=USD", { token: A }), "ledger").entries;
    assert(l.length > 0 && l.every((e) => e.origin === "payment"), "linked posting listed");
    assert(l.some((e) => e.notes === "UH cash credit") && l.some((e) => e.notes === "UH plain debit"), "payments missing");
  });
  await check("'All account postings' adds the linked postings, each with its origin and reference", async () => {
    const l = ok(await api("/api/account-ledger?currency=USD&origin=all", { token: A }), "ledger").entries;
    const leg = l.find((e) => e.origin === "exchange" && e.relatedReference === ctx.ex.referenceNumber);
    assert(leg && l.some((e) => e.origin === "transfer") && l.some((e) => e.origin === "quotation"), "postings missing");
    const ex = ok(await api("/api/account-ledger?currency=USD&origin=exchange", { token: A }), "ledger").entries;
    assert(ex.length > 0 && ex.every((e) => e.origin === "exchange"), "origin=exchange");
  });
  await check("a linked posting can't be edited or deleted on its own", async () => {
    const p = await api(`/api/account-ledger/${ctx.exLeg.id}`, { method: "PATCH", token: A, body: { amount: 1 } });
    const del = await api(`/api/account-ledger/${ctx.exLeg.id}`, { method: "DELETE", token: A, body: { reason: "x" } });
    assert(p.status === 400 && del.status === 400, `${p.status} ${del.status}`);
  });

  console.log("\nFilters, search, paging and sorting (server side)");
  await check("search by reference, account number, description, staff and phone", async () => {
    const by = async (q, type = "all") => (await hist(`currency=USD&type=${type}&search=${encodeURIComponent(q)}`)).entries;
    assert((await by(ctx.ex.referenceNumber)).some((e) => e.id === ctx.ex.id), "reference");
    assert((await by(ctx.o.accountNumber)).some((e) => e.recordType === "transfer" && e.id === ctx.tr.id), "account number (transfer receiver)");
    assert((await by("UH plain debit")).length === 1, "description");
    assert((await by("Amina")).length > 0, "staff");
    assert((await by(ctx.ex.referenceNumber, "withdrawal")).some((e) => e.id === ctx.exLeg.id), "a posting found by its exchange's reference");
  });
  await check("filters: account, status, staff and dates narrow every tab", async () => {
    const acc = (await hist(`currency=USD&accountId=${ctx.o.id}`)).entries;
    assert(acc.length === 1 && acc[0].id === ctx.tr.id, `account ${acc.length}`);
    const st = (await hist("currency=USD&type=exchange&status=voided")).entries;
    assert(st.every((e) => e.status === "voided"), "status");
    const me = (await api("/api/auth/me", { token: A })).json;
    const meId = (me.user || me).id;
    const staff = (await hist(`currency=USD&staffId=${meId}`)).entries;
    assert(staff.length >= 6 && staff.every((e) => e.staffId === meId), `staff ${staff.length}`);
    const future = (await hist("currency=USD&from=2099-01-01")).summary.tabCounts;
    assert(Object.values(future).every((n) => n === 0 || n === null), JSON.stringify(future));
    assert(after.summary.staff.some(([id]) => id === meId), "staff list");
  });
  await check("page / pageSize return one page with the full total", async () => {
    const p1 = ok(await api("/api/history?currency=USD&page=1&pageSize=3", { token: A }), "p1");
    const p2 = ok(await api("/api/history?currency=USD&page=2&pageSize=3", { token: A }), "p2");
    assert(p1.entries.length === 3 && p1.total === after.summary.tabCounts.all && p1.totalPages === Math.ceil(p1.total / 3), JSON.stringify({ n: p1.entries.length, t: p1.total }));
    assert(!p2.entries.some((e) => p1.entries.some((x) => x.id === e.id)), "pages overlap");
    const big = ok(await api("/api/history?currency=USD&page=1&pageSize=100000", { token: A }), "big");
    assert(big.pageSize === 500, `pageSize cap ${big.pageSize}`);
  });
  await check("sorting by amount, reference and date on the server", async () => {
    const asc = ok(await api("/api/history?currency=USD&type=deposit&page=1&pageSize=500&sort=credit&dir=asc", { token: A }), "asc").entries.map((e) => e.credit);
    assert(asc.every((v, i) => i === 0 || v >= asc[i - 1]), `credit asc ${asc}`);
    const ref = ok(await api("/api/history?currency=USD&page=1&pageSize=500&sort=reference&dir=desc", { token: A }), "ref").entries.map((e) => e.reference.toLowerCase());
    assert(ref.every((v, i) => i === 0 || v <= ref[i - 1]), "reference desc");
    const dt = ok(await api("/api/history?currency=USD&page=1&pageSize=500", { token: A }), "date").entries.map((e) => e.sortKey);
    assert(dt.every((v, i) => i === 0 || v <= dt[i - 1]), "newest first");
  });
  await check("exports (CSV, PDF statement, Excel) follow the selected tab", async () => {
    const csv = (await api("/api/history/export.csv?currency=USD&type=transfer", { token: A })).text;
    const lines = csv.trim().split(/\r?\n/).length - 1;
    assert(lines === after.summary.tabCounts.transfer, `csv ${lines} vs ${after.summary.tabCounts.transfer}`);
    assert(/Origin,Related Reference,Account Number/.test(csv.split(/\r?\n/)[0]), "csv header");
    const pdf = await api("/api/history/statement.pdf?currency=USD&type=cash", { token: A, raw: true });
    assert(pdf.status === 200 && pdf.buf.slice(0, 4).toString() === "%PDF", `pdf ${pdf.status}`);
    const xl = await api("/api/history/statement.xlsx?currency=USD&type=payment", { token: A, raw: true });
    assert(xl.status === 200 && xl.buf.slice(0, 2).toString() === "PK", `xlsx ${xl.status}`);
  });

  console.log("\nRelated records");
  await check("an Exchange shows its account postings (both currencies)", async () => {
    const r = ok(await api(`/api/history/related?recordType=exchange&id=${ctx.ex.id}`, { token: A }), "related").items;
    assert(r.find((i) => i.recordType === "exchange" && i.isSelf), "self");
    const legs = r.filter((i) => i.recordType === "ledger");
    assert(legs.length === 2 && legs.some((l) => l.currency === "USD" && l.direction === "debit") && legs.some((l) => l.currency === "SLSH" && l.direction === "credit"), JSON.stringify(legs));
  });
  await check("a posting leads back to its Exchange; a Transfer shows its two postings", async () => {
    const r = ok(await api(`/api/history/related?recordType=ledger&id=${ctx.exLeg.id}`, { token: A }), "leg").items;
    assert(r.some((i) => i.recordType === "exchange" && i.id === ctx.ex.id) && r.find((i) => i.id === ctx.exLeg.id).isSelf, "back link");
    const t = ok(await api(`/api/history/related?recordType=transfer&id=${ctx.tr.id}`, { token: A }), "transfer").items;
    assert(t.filter((i) => i.recordType === "ledger").length === 2, "transfer legs");
  });
  await check("a Payment shows its Cash Account entry and back; a Quotation shows charge and payment", async () => {
    const pay = (await hist(`currency=USD&type=payment&search=${encodeURIComponent("UH cash credit")}`)).entries[0];
    const r = ok(await api(`/api/history/related?recordType=ledger&id=${pay.id}`, { token: A }), "pay").items;
    const leg = r.find((i) => i.recordType === "cash");
    assert(leg && leg.direction === "in" && leg.amount === 100, "cash leg");
    const back = ok(await api(`/api/history/related?recordType=cash&id=${leg.id}`, { token: A }), "back").items;
    assert(back.some((i) => i.recordType === "ledger" && i.id === pay.id), "cash -> payment");
    const qe = (await hist(`currency=USD&type=quotation_charge&search=${encodeURIComponent(ctx.q.number)}`)).entries[0];
    const q = ok(await api(`/api/history/related?recordType=quotation&id=${qe.id}`, { token: A }), "q").items;
    assert(q.some((i) => i.recordType === "quotation_doc") && q.filter((i) => i.recordType === "ledger").length === 2, JSON.stringify(q.map((i) => i.label)));
  });
  await check("unknown records are not found", async () => {
    assert((await api("/api/history/related?recordType=exchange&id=nope", { token: A })).status === 404, "404");
  });

  console.log("\nSecurity");
  const users = ok(await api("/api/users", { token: SA }), "users").users;
  const mgr = users.find((u) => u.username === "xasan.cali");
  const M = await login("xasan.cali", PW);
  await check("a hidden account: its postings are left out and its related records are not found", async () => {
    ok(await api(`/api/users/${mgr.id}/account-access`, { method: "PATCH", token: SA, body: { changes: [{ accountId: ctx.s.id, level: "none" }] } }), "hide");
    const sl = (await hist("currency=SLSH&type=deposit", M)).entries;
    assert(!sl.some((e) => e.accountId === ctx.s.id), "hidden account posting listed");
    assert((await api(`/api/history/related?recordType=exchange&id=${ctx.ex.id}`, { token: M })).status === 404, "related reachable");
    ok(await api(`/api/users/${mgr.id}/account-access`, { method: "PATCH", token: SA, body: { changes: [{ accountId: ctx.s.id, level: "full" }] } }), "unhide");
  });
  await check("without SLSH access the SLSH posting is left out of related records", async () => {
    ok(await api(`/api/users/${mgr.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "currency.slsh", granted: false }], confirmCritical: true } }), "no slsh");
    const M2 = await login("xasan.cali", PW);
    const r = await api(`/api/history/related?recordType=exchange&id=${ctx.ex.id}`, { token: M2 });
    assert(r.status === 200 && !r.json.items.some((i) => i.currency === "SLSH") && r.json.hiddenCount === 1, JSON.stringify(r.json));
    assert((await api("/api/history?currency=SLSH", { token: M2 })).status === 403, "SLSH history");
  });
  await check("without Cash Account access there is no Cash tab and no cash entry anywhere", async () => {
    ok(await api(`/api/users/${mgr.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "cash.view", granted: false }], confirmCritical: true } }), "no cash");
    const M3 = await login("xasan.cali", PW);
    const h = await hist("currency=USD", M3);
    assert(h.summary.tabCounts.cash === null && !h.entries.some((e) => e.recordType === "cash"), "cash visible");
    assert((await hist("currency=USD&type=cash", M3)).entries.length === 0, "cash tab rows");
    const r = await api(`/api/history/related?recordType=cash&id=${ctx.payLeg.id}`, { token: M3 });
    assert(r.status === 404, `cash related ${r.status}`);
  });
  await check("another company never sees these records", async () => {
    ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Unified Beta", admin: { name: "Ub Admin", username: "ub.admin", password: "BetaPass-2026x" } } }), "company B");
    const B = await login("ub.admin", "BetaPass-2026x");
    const h = ok(await api("/api/history?withSummary=1&currency=USD", { token: B }), "B history");
    assert(!JSON.stringify(h).includes(ctx.ex.referenceNumber) && !h.entries.some((e) => e.id === ctx.ex.id || e.id === ctx.tr.id), "A's records in B");
    for (const [t, id] of [["exchange", ctx.ex.id], ["transfer", ctx.tr.id], ["ledger", ctx.exLeg.id], ["cash", ctx.payLeg.id]]) {
      assert((await api(`/api/history/related?recordType=${t}&id=${id}`, { token: B })).status === 404, `${t} related from B`);
    }
    const l = ok(await api("/api/account-ledger?currency=USD&origin=all", { token: B }), "B ledger");
    assert(!l.entries.some((e) => e.id === ctx.exLeg.id), "A's posting in B");
  });

  // ------------------------------------------------------------- browser
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  console.log("\nTransaction History screen");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    const go = async (label) => {
      const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
      const group = p.locator(".gk-nav-group").filter({ has: btn });
      if (await group.count()) { const hd = group.first().locator(".gk-nav-group-header").first(); if ((await hd.getAttribute("aria-expanded")) === "false") { await hd.click(); await p.waitForTimeout(300); } }
      await btn.click(); await p.waitForTimeout(1200);
    };
    await go("USD Transactions");
    const now = await hist("currency=USD");
    const kpi = async (k) => (await p.locator(`.gk-acc-kpi[data-kpi="${k}"] .gk-acc-kpi-value`).innerText()).trim();
    const tabCount = async (k) => (await p.locator(`.gk-th-tabs button[data-tab="${k}"] .gk-th-tab-count`).innerText()).trim();

    await check("every module has its own tab with the server's count", async () => {
      for (const [k, l] of [["all", "All"], ["payment", "Payments"], ["exchange", "Exchanges"], ["transfer", "Transfers"], ["deposit", "Credits"], ["withdrawal", "Debits"], ["quotation", "Quotations"], ["quotation_charge", "Quotation Charges"], ["quotation_payment", "Quotation Payments"], ["cash", "Cash Account"]]) {
        assert(await p.getByRole("tab", { name: l, exact: true }).count() === 1, `${l} tab`);
        assert(await tabCount(k) === String(now.summary.tabCounts[k]), `${l} count ${await tabCount(k)} vs ${now.summary.tabCounts[k]}`);
      }
    });
    await check("summary cards: Total, Payments, Credits, Debits, Exchanges, Transfers, Quotation Charges / Payments, Exchange Profit", async () => {
      assert(await kpi("entries") === String(now.summary.counts.entries), "total");
      for (const [k, t] of [["payments", "payment"], ["credits", "deposit"], ["debits", "withdrawal"], ["exchanges", "exchange"], ["transfers", "transfer"], ["qcharges", "quotation_charge"], ["qpayments", "quotation_payment"]]) {
        assert(await kpi(k) === String(now.summary.tabCounts[t]), `${k} ${await kpi(k)}`);
      }
      assert(await p.locator('.gk-acc-kpi[data-kpi="profit"]').count() === 1, "profit card");
    });
    await check("the table holds one server page; the footer shows the full total", async () => {
      const rows = await p.locator(".gk-th-table tbody tr").count();
      assert(rows === Math.min(10, now.summary.tabCounts.all), `rows ${rows}`);
      const foot = await p.locator(".gk-th-table-wrap .gk-table-footer").first().innerText().catch(() => "");
      assert(foot.includes(String(now.summary.tabCounts.all)), `footer: ${foot}`);
    });
    await check("type badges carry each module's color", async () => {
      await p.getByRole("tab", { name: "Debits", exact: true }).click(); await p.waitForTimeout(1200);
      await p.getByLabel("Search transactions").fill(ctx.ex.referenceNumber); await p.waitForTimeout(1300);
      const tone = await p.locator(".gk-th-table tbody tr").first().locator("[data-type-tone]").getAttribute("data-type-tone");
      assert(tone === "cyan", `exchange posting tone ${tone}`);
      assert(/Exchange Debit/.test(await p.locator(".gk-th-table tbody tr").first().innerText()), "label");
      assert((await p.locator(".gk-th-table tbody tr").first().locator("[data-related]").getAttribute("data-related")) === ctx.ex.referenceNumber, "related column");
    });
    await check("details show the related records; Open jumps to the Exchange", async () => {
      await p.locator(".gk-th-table tbody tr").first().click();
      const dlg = p.getByRole("dialog");
      await dlg.waitFor({ timeout: 5000 });
      await dlg.locator('[data-related-item="exchange"]').waitFor({ timeout: 5000 });
      assert(await dlg.locator("[data-related-item]").count() >= 3, "related rows");
      assert(await dlg.getByRole("button", { name: "Update", exact: true }).count() === 0 && await dlg.getByRole("button", { name: "Delete", exact: true }).count() === 0, "edit offered on a linked posting");
      await dlg.locator('[data-related-item="exchange"]').getByRole("button", { name: "Open" }).click();
      await p.waitForTimeout(1800);
      assert(await p.locator('.gk-th-tabs button[data-tab="exchange"][aria-selected="true"]').count() === 1, "exchange tab not selected");
      const d2 = p.getByRole("dialog");
      await d2.waitFor({ timeout: 5000 });
      assert((await d2.innerText()).includes(ctx.ex.referenceNumber), "exchange details not opened");
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    });
    await check("Cash Account tab lists cash entries (emerald)", async () => {
      await p.getByLabel("Search transactions").fill(""); await p.waitForTimeout(300);
      await p.getByRole("tab", { name: "Cash Account", exact: true }).click(); await p.waitForTimeout(1300);
      const rec = await p.locator(".gk-th-table tbody tr").evaluateAll((els) => els.map((e) => e.dataset.record));
      assert(rec.length > 0 && rec.every((r) => r === "cash"), rec.join(","));
      assert(await p.locator('.gk-th-table tbody [data-type-tone="emerald"]').count() === rec.length, "cash tone");
    });
    await check("Payment module: Payments only by default; 'All account postings' shows linked ones without Edit/Delete", async () => {
      await go("USD Payment"); await p.waitForTimeout(600);
      const origins = async () => p.locator("table tbody [data-origin]").evaluateAll((els) => els.map((e) => e.dataset.origin));
      const o1 = await origins();
      assert(o1.length > 0 && o1.every((o) => o === "payment"), o1.join(","));
      await p.getByLabel("Show records").selectOption("any"); await p.waitForTimeout(1200);
      const o2 = await origins();
      assert(o2.some((o) => o === "exchange"), o2.join(","));
      const row = p.locator("table tbody tr").filter({ has: p.locator('[data-origin="exchange"]') }).first();
      assert(await row.getByRole("button", { name: "Edit" }).count() === 0 && await row.getByRole("button", { name: "Delete" }).count() === 0, "edit on linked row");
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
