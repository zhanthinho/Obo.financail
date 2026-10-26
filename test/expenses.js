"use strict";
// COMPANY EXPENSES round — regression tests.
// On a throw-away installation with two companies, proves that an expense:
//   * is validated (required fields, amounts, dates, currency, account);
//   * takes its amount out of the chosen Cash in Hand account exactly once,
//     through one linked cash movement, and nothing else moves;
//   * is saved together with that movement or not at all (rollback);
//   * can't be posted twice by a double click or a retried request;
//   * edits and cancellations keep every balance right, and a cancellation
//     can happen only once;
//   * keeps USD and SLSH apart in every total, filter, report and export;
//   * is limited by role permissions and never visible to another company.
// Plus the page itself: permissions in the menu, empty/error states, Somali,
// and phone width.
//
// Run with: npm run test:expenses
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".expenses-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("expenses");
const PORT = Number(process.env.EXPENSES_TEST_PORT || 4380);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const B_ADMIN = { name: "Hodan Berbera", username: "hodan.berbera", password: "Berbera-Admin-Pass-31" };

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
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text, buf, type: res.headers.get("content-type") || "" };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));

// Everything an expense must NOT touch, plus every Cash in Hand balance.
async function snapshot(token) {
  const cash = (await api("/api/cash/accounts?status=all", { token })).json.accounts;
  const customers = [];
  for (const cur of ["USD", "SLSH"]) customers.push(...(await api(`/api/accounts?currency=${cur}`, { token })).json.accounts.map((a) => [a.id, a.balance]));
  const ledger = (await api("/api/cash/ledger", { token })).json.entries.length;
  const tx = (await api("/api/transactions", { token })).json.transactions.length;
  return { cash: Object.fromEntries(cash.map((a) => [a.id, a.balance])), customers: Object.fromEntries(customers), ledger, tx };
}

const ctx = {};
async function setup() {
  ctx.sa = await login("super.admin", SA_PW);
  const companies = (await api("/api/platform/companies", { token: ctx.sa })).json.companies;
  ctx.A = companies[0].id;
  const ws = async (cid) => (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: cid } })).json.token;
  ctx.saA = await ws(ctx.A);
  const mk = async (token, body) => {
    const r = await api("/api/cash/accounts", { method: "POST", token, body });
    assert(r.status === 201, `cash account: ${r.status} ${r.text}`);
    return r.json.account;
  };
  ctx.till = await mk(ctx.saA, { name: "Main Till", type: "physical_cash", currency: "USD", openingBalance: 5000 });
  ctx.bank = await mk(ctx.saA, { name: "Dahabshiil Bank", type: "bank", currency: "USD", openingBalance: 20000 });
  ctx.slsh = await mk(ctx.saA, { name: "Zaad Wallet", type: "mobile_money", currency: "SLSH", openingBalance: 10000000 });
  ctx.closed = await mk(ctx.saA, { name: "Old Safe", type: "physical_cash", currency: "USD", openingBalance: 100 });
  await api(`/api/cash/accounts/${ctx.closed.id}/deactivate`, { method: "POST", token: ctx.saA, body: { reason: "test" } });
  ctx.admin = await login("amina.yusuf");      // Company Admin of Company A
  ctx.viewer = await login("sahra.ismail");    // Viewer of Company A (no expense access)
  ctx.cats = (await api("/api/expense-categories", { token: ctx.admin })).json.categories;
  ctx.cat = (name) => ctx.cats.find((c) => c.name === name).id;
  // Company B with its own admin and cash account.
  const b = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Berbera Second Co", admin: B_ADMIN } });
  assert(b.status === 201, `Company B: ${b.status} ${b.text}`);
  ctx.B = b.json.company.id;
  ctx.saB = await ws(ctx.B);
  ctx.bTill = await mk(ctx.saB, { name: "Berbera Till", type: "physical_cash", currency: "USD", openingBalance: 3000 });
  ctx.bAdmin = await login(B_ADMIN.username, B_ADMIN.password);
  // A role that can only VIEW expenses, and a user who has it.
  const role = await api("/api/roles", { method: "POST", token: ctx.saA, body: { name: "Expense Reader", permissions: ["expenses.view"] } });
  assert(role.status === 201, `role: ${role.status} ${role.text}`);
  const u = await api("/api/users", { method: "POST", token: ctx.saA, body: { name: "Reader Person", username: "expense.reader", password: "Reader-Pass-2026x", roleId: role.json.role.id } });
  assert(u.status === 201, `user: ${u.status} ${u.text}`);
  ctx.reader = await login("expense.reader", "Reader-Pass-2026x");
}

const post = (token, body) => api("/api/expenses", { method: "POST", token, body });
const base = () => ({ date: daysAgo(2), categoryId: ctx.cat("Office Rent"), description: "Office rent October", amount: 400, currency: "USD", cashAccountId: ctx.till.id });

async function apiChecks() {
  console.log("\nCreating expenses");
  let before, first;
  await check("1. a valid expense is saved with its own reference, category and creator", async () => {
    before = await snapshot(ctx.saA);
    const r = await post(ctx.admin, { ...base(), clientRequestId: "req-1", externalReference: "INV-77", notes: "paid in cash" });
    assert(r.status === 201, `${r.status} ${r.text}`);
    first = r.json.expense;
    assert(/^EXP-\d{4}-\d{4}$/.test(first.referenceNumber) && first.categoryName === "Office Rent" && first.createdByName && first.status === "posted", JSON.stringify(first));
    assert(first.ledgerEntry && first.ledgerEntry.type === "withdrawal" && near(first.ledgerEntry.amount, 400), "no linked withdrawal");
  });
  await check("5. the paying account goes down exactly once, by exactly the amount", async () => {
    const after = await snapshot(ctx.saA);
    assert(near(after.cash[ctx.till.id], before.cash[ctx.till.id] - 400), `till ${before.cash[ctx.till.id]} -> ${after.cash[ctx.till.id]}`);
    assert(after.ledger === before.ledger + 1, `cash movements ${before.ledger} -> ${after.ledger}`);
    for (const id of [ctx.bank.id, ctx.slsh.id]) assert(after.cash[id] === before.cash[id], `${id} moved`);
  });
  await check("   …and nothing else moves: customer balances and exchanges untouched", async () => {
    const after = await snapshot(ctx.saA);
    for (const [id, bal] of Object.entries(before.customers)) assert(after.customers[id] === bal, `customer ${id} moved`);
    assert(after.tx === before.tx, "exchange transactions changed");
  });
  await check("   …and the movement shows in Cash in Hand, linked to the expense, and can't be changed from there", async () => {
    const e = (await api(`/api/cash/ledger?cashAccountId=${ctx.till.id}`, { token: ctx.saA })).json.entries.find((x) => x.id === first.ledgerEntry.id);
    assert(e && e.sourceType === "expense" && e.reference === first.referenceNumber && !e.editable, JSON.stringify(e));
    const del = await api(`/api/cash/ledger/${e.id}`, { method: "DELETE", token: ctx.saA });
    const ed = await api(`/api/cash/ledger/${e.id}`, { method: "PATCH", token: ctx.saA, body: { amount: 1 } });
    assert(del.status === 400 && ed.status === 400, `delete ${del.status}, edit ${ed.status}`);
  });

  console.log("\nValidation");
  await check("2. missing fields are refused with a clear message per field", async () => {
    for (const [k, field] of [["date", "date"], ["categoryId", "categoryId"], ["description", "description"], ["amount", "amount"], ["cashAccountId", "cashAccountId"]]) {
      const b = base(); delete b[k];
      const r = await post(ctx.admin, b);
      assert(r.status === 400 && r.json.field === field && r.json.error, `${k}: ${r.status} ${r.text}`);
    }
    const r = await post(ctx.admin, { ...base(), description: "   " });
    assert(r.status === 400 && r.json.field === "description", "blank description accepted");
  });
  await check("3. zero, negative and non-numeric amounts are refused", async () => {
    for (const amount of [0, -5, "abc", "", null, 1e15]) {
      const r = await post(ctx.admin, { ...base(), amount });
      assert(r.status === 400 && r.json.field === "amount", `amount ${amount}: ${r.status}`);
    }
  });
  await check("   invalid dates and currencies are refused", async () => {
    assert((await post(ctx.admin, { ...base(), date: "not-a-date" })).status === 400, "bad date accepted");
    assert((await post(ctx.admin, { ...base(), currency: "EUR" })).status === 400, "EUR accepted");
  });
  await check("4. an account in the wrong currency, a deactivated account or another company's account is refused", async () => {
    const wrongCur = await post(ctx.admin, { ...base(), cashAccountId: ctx.slsh.id });
    const closed = await post(ctx.admin, { ...base(), cashAccountId: ctx.closed.id });
    const foreign = await post(ctx.admin, { ...base(), cashAccountId: ctx.bTill.id });
    const nonsense = await post(ctx.admin, { ...base(), cashAccountId: "cash_does_not_exist" });
    for (const [n, r] of [["currency", wrongCur], ["deactivated", closed], ["other company", foreign], ["unknown", nonsense]]) {
      assert(r.status === 400 && r.json.field === "cashAccountId", `${n}: ${r.status} ${r.text}`);
    }
    const bTill = (await api(`/api/cash/accounts/${ctx.bTill.id}`, { token: ctx.saB })).json.account;
    assert(near(bTill.balance, 3000), "Company B's till moved");
  });
  await check("   a receipt must really be a PNG, JPEG or PDF of at most 3 MB", async () => {
    const fake = await post(ctx.admin, { ...base(), attachment: { fileName: "x.png", dataUrl: "data:image/png;base64," + Buffer.from("not an image").toString("base64") } });
    const exe = await post(ctx.admin, { ...base(), attachment: { fileName: "x.exe", dataUrl: "data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA" } });
    const big = await post(ctx.admin, { ...base(), attachment: { fileName: "big.pdf", dataUrl: "data:application/pdf;base64," + Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3 * 1024 * 1024 + 10)]).toString("base64") } });
    for (const [n, r] of [["fake png", fake], ["exe", exe], ["too big", big]]) assert(r.status === 400 && r.json.field === "attachment", `${n}: ${r.status}`);
  });

  console.log("\nDuplicate submissions");
  await check("7. the same request sent again (retry / double click) posts once", async () => {
    const s0 = await snapshot(ctx.saA);
    const again = await post(ctx.admin, { ...base(), clientRequestId: "req-1" });
    assert(again.status === 200 && again.json.duplicate === true && again.json.expense.id === first.id, `${again.status} ${again.text}`);
    const s1 = await snapshot(ctx.saA);
    assert(s1.ledger === s0.ledger && s1.cash[ctx.till.id] === s0.cash[ctx.till.id], "retry moved money");
  });
  await check("   five identical requests at the same moment post once", async () => {
    const s0 = await snapshot(ctx.saA);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(ctx.admin, { ...base(), amount: 33, clientRequestId: "req-burst" })));
    const ids = new Set(rs.map((r) => r.json && r.json.expense && r.json.expense.id));
    assert(ids.size === 1 && rs.filter((r) => r.status === 201).length === 1, `statuses ${rs.map((r) => r.status)}`);
    const s1 = await snapshot(ctx.saA);
    assert(near(s1.cash[ctx.till.id], s0.cash[ctx.till.id] - 33) && s1.ledger === s0.ledger + 1, "burst posted more than once");
  });

  console.log("\nEditing and cancelling");
  let ed;
  await check("8. editing the amount corrects the same movement; the balance stays exact", async () => {
    const r = await post(ctx.admin, { ...base(), amount: 100, description: "Fuel", categoryId: ctx.cat("Transportation and Fuel"), clientRequestId: "req-edit" });
    ed = r.json.expense;
    const s0 = await snapshot(ctx.saA);
    const u = await api(`/api/expenses/${ed.id}`, { method: "PATCH", token: ctx.admin, body: { amount: 150 } });
    assert(u.status === 200 && near(u.json.expense.amount, 150) && u.json.expense.ledgerEntry.id === ed.ledgerEntry.id, u.text);
    const s1 = await snapshot(ctx.saA);
    assert(near(s1.cash[ctx.till.id], s0.cash[ctx.till.id] - 50) && s1.ledger === s0.ledger, `till ${s0.cash[ctx.till.id]} -> ${s1.cash[ctx.till.id]}`);
  });
  await check("   moving it to another account puts the money back on the first and takes it from the second", async () => {
    const s0 = await snapshot(ctx.saA);
    const u = await api(`/api/expenses/${ed.id}`, { method: "PATCH", token: ctx.admin, body: { cashAccountId: ctx.bank.id } });
    assert(u.status === 200, u.text);
    const s1 = await snapshot(ctx.saA);
    assert(near(s1.cash[ctx.till.id], s0.cash[ctx.till.id] + 150) && near(s1.cash[ctx.bank.id], s0.cash[ctx.bank.id] - 150), "balances not moved correctly");
  });
  await check("   switching to SLSH needs an SLSH account (the account decides the currency)", async () => {
    const bad = await api(`/api/expenses/${ed.id}`, { method: "PATCH", token: ctx.admin, body: { currency: "SLSH" } });
    assert(bad.status === 400 && bad.json.field === "cashAccountId", bad.text);
    const ok = await api(`/api/expenses/${ed.id}`, { method: "PATCH", token: ctx.admin, body: { currency: "SLSH", cashAccountId: ctx.slsh.id, amount: 850000 } });
    assert(ok.status === 200 && ok.json.expense.currency === "SLSH", ok.text);
    const s = await snapshot(ctx.saA);
    assert(near(s.cash[ctx.slsh.id], 10000000 - 850000), `SLSH wallet ${s.cash[ctx.slsh.id]}`);
  });
  await check("   cancelling returns the money with a reversing entry and keeps the original", async () => {
    const s0 = await snapshot(ctx.saA);
    const noReason = await api(`/api/expenses/${ed.id}/cancel`, { method: "POST", token: ctx.admin, body: {} });
    assert(noReason.status === 400, "cancel without a reason accepted");
    const c = await api(`/api/expenses/${ed.id}/cancel`, { method: "POST", token: ctx.admin, body: { reason: "Duplicate receipt" } });
    assert(c.status === 200 && c.json.expense.status === "cancelled" && c.json.expense.reversalEntry && c.json.expense.ledgerEntry, c.text);
    const s1 = await snapshot(ctx.saA);
    assert(near(s1.cash[ctx.slsh.id], s0.cash[ctx.slsh.id] + 850000) && s1.ledger === s0.ledger + 1, "reversal wrong");
  });
  await check("   an expense can be cancelled only once, and a cancelled one can't be edited", async () => {
    const s0 = await snapshot(ctx.saA);
    const rs = await Promise.all([1, 2, 3].map(() => api(`/api/expenses/${ed.id}/cancel`, { method: "POST", token: ctx.admin, body: { reason: "again" } })));
    assert(rs.every((r) => r.status === 400), `statuses ${rs.map((r) => r.status)}`);
    const u = await api(`/api/expenses/${ed.id}`, { method: "PATCH", token: ctx.admin, body: { amount: 1 } });
    assert(u.status === 400, "cancelled expense edited");
    const s1 = await snapshot(ctx.saA);
    assert(JSON.stringify(s1.cash) === JSON.stringify(s0.cash) && s1.ledger === s0.ledger, "money moved");
  });

  console.log("\nTotals, filters and reports");
  await check("9. USD and SLSH totals are kept apart and match the records", async () => {
    await post(ctx.admin, { ...base(), currency: "SLSH", cashAccountId: ctx.slsh.id, amount: 250000, categoryId: ctx.cat("Electricity"), description: "Power", date: daysAgo(1) });
    await post(ctx.admin, { ...base(), currency: "SLSH", cashAccountId: ctx.slsh.id, amount: 150000, categoryId: ctx.cat("Electricity"), description: "Power 2", date: daysAgo(1) });
    const all = (await api("/api/expenses?status=posted&pageSize=200", { token: ctx.admin })).json;
    const usd = all.expenses.filter((e) => e.currency === "USD").reduce((s, e) => s + e.amount, 0);
    const slsh = all.expenses.filter((e) => e.currency === "SLSH").reduce((s, e) => s + e.amount, 0);
    const sum = (await api("/api/expenses/summary", { token: ctx.admin })).json;
    assert(near(sum.totals.USD.total, usd) && near(sum.totals.SLSH.total, slsh), `summary ${JSON.stringify(sum.totals)} vs ${usd}/${slsh}`);
    assert(near(sum.totals.SLSH.total, 400000) && sum.totals.SLSH.count === 2 && near(sum.totals.SLSH.average, 200000), JSON.stringify(sum.totals.SLSH));
    assert(near(all.totals.USD.total, usd) && near(all.totals.SLSH.total, slsh), "list totals differ");
    assert(sum.count === sum.totals.USD.count + sum.totals.SLSH.count, "count != USD+SLSH");
  });
  await check("   cancelled expenses never count as money spent", async () => {
    const sum = (await api("/api/expenses/summary", { token: ctx.admin })).json;
    const all = (await api("/api/expenses?status=all&pageSize=200", { token: ctx.admin })).json;
    const cancelled = all.expenses.filter((e) => e.status === "cancelled");
    assert(cancelled.length === 1 && sum.count === all.total - 1, `count ${sum.count} vs ${all.total}`);
  });
  await check("10. date filters and category summaries are correct", async () => {
    await post(ctx.admin, { ...base(), amount: 70, description: "Old internet bill", categoryId: ctx.cat("Internet and Telephone"), date: daysAgo(40) });
    const recent = (await api(`/api/expenses/summary?from=${daysAgo(7)}&to=${daysAgo(0)}`, { token: ctx.admin })).json;
    const older = (await api(`/api/expenses/summary?from=${daysAgo(45)}&to=${daysAgo(35)}`, { token: ctx.admin })).json;
    assert(near(older.totals.USD.total, 70) && older.count === 1, `older ${JSON.stringify(older.totals)}`);
    assert(!recent.byCategory.some((c) => c.categoryName === "Internet and Telephone"), "old expense leaked into recent range");
    const elec = recent.byCategory.find((c) => c.categoryName === "Electricity");
    assert(elec && near(elec.SLSH, 400000) && near(elec.USD, 0) && elec.count === 2, JSON.stringify(elec));
    const byCat = (await api(`/api/expenses?categoryId=${ctx.cat("Electricity")}`, { token: ctx.admin })).json;
    assert(byCat.total === 2 && byCat.expenses.every((e) => e.categoryName === "Electricity"), "category filter");
    const byAcct = (await api(`/api/expenses?cashAccountId=${ctx.slsh.id}`, { token: ctx.admin })).json;
    assert(byAcct.expenses.every((e) => e.cashAccountId === ctx.slsh.id) && byAcct.total === 2, "account filter");
    const search = (await api("/api/expenses?search=INV-77", { token: ctx.admin })).json;
    assert(search.total === 1 && search.expenses[0].id === first.id, "search by reference");
  });
  await check("   pagination and sorting work on the server", async () => {
    const p1 = (await api("/api/expenses?pageSize=2&page=1&sort=amount&dir=asc", { token: ctx.admin })).json;
    const p2 = (await api("/api/expenses?pageSize=2&page=2&sort=amount&dir=asc", { token: ctx.admin })).json;
    assert(p1.expenses.length === 2 && p1.pages >= 2 && p1.expenses[0].id !== p2.expenses[0].id, "paging");
    assert(p1.expenses[0].amount <= p1.expenses[1].amount, "sorting");
  });
  await check("11. every report and export reconciles with the summary (USD and SLSH separately)", async () => {
    const sum = (await api("/api/expenses/summary", { token: ctx.admin })).json;
    for (const g of ["day", "week", "month", "year", "category", "account", "currency", "detail"]) {
      const rep = (await api(`/api/expenses/report?groupBy=${g}`, { token: ctx.admin })).json;
      assert(near(rep.grand.USD, sum.totals.USD.total) && near(rep.grand.SLSH, sum.totals.SLSH.total), `${g} grand`);
      if (g !== "detail") {
        assert(near(rep.rows.reduce((s, r) => s + r.USD, 0), sum.totals.USD.total) && near(rep.rows.reduce((s, r) => s + r.SLSH, 0), sum.totals.SLSH.total), `${g} rows`);
      }
    }
    const csv = await api("/api/expenses/report/export.csv?groupBy=currency", { token: ctx.admin });
    assert(csv.status === 200 && /text\/csv/.test(csv.type), `csv ${csv.status}`);
    const lines = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(","));
    const total = lines.find((l) => l[0] === "TOTAL");
    assert(total && near(total[1], sum.totals.USD.total) && near(total[3], sum.totals.SLSH.total), `csv total ${total}`);
    const ExcelJS = require("exceljs");
    const x = await api("/api/expenses/report/export.xlsx?groupBy=category", { token: ctx.admin });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
    const nums = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => { if (typeof c.value === "number") nums.push(c.value); }));
    assert(nums.some((n) => near(n, sum.totals.USD.total)) && nums.some((n) => near(n, sum.totals.SLSH.total)), "xlsx totals");
    const pdf = await api("/api/expenses/report/export.pdf?groupBy=detail", { token: ctx.admin });
    assert(pdf.status === 200 && pdf.buf.slice(0, 4).toString() === "%PDF", `pdf ${pdf.status}`);
  });
  await check("   a receipt is stored and served only to signed-in users with access", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const r = await post(ctx.admin, { ...base(), amount: 12, description: "Pens", categoryId: ctx.cat("Office Supplies"), attachment: { fileName: "pens.png", dataUrl: png } });
    assert(r.status === 201 && r.json.expense.attachment && r.json.expense.attachment.mimeType === "image/png", r.text);
    const get = await api(`/api/expenses/${r.json.expense.id}/attachment`, { token: ctx.admin });
    assert(get.status === 200 && get.type === "image/png" && get.buf[0] === 0x89, `attachment ${get.status}`);
    assert((await api(`/api/expenses/${r.json.expense.id}/attachment`)).status === 401, "receipt reachable without signing in");
    assert((await api(`/api/expenses/${r.json.expense.id}/attachment`, { token: ctx.viewer })).status === 403, "viewer got the receipt");
    assert((await api(`/api/expenses/${r.json.expense.id}/attachment`, { token: ctx.bAdmin })).status === 404, "other company got the receipt");
  });

  console.log("\nPermissions");
  await check("12. a role without expense access gets nothing", async () => {
    for (const [m, p, body] of [["GET", "/api/expenses"], ["GET", "/api/expenses/summary"], ["GET", "/api/expenses/meta"], ["GET", "/api/expenses/report"], ["POST", "/api/expenses", base()], ["GET", `/api/expenses/${first.id}`], ["GET", "/api/expenses/report/export.csv"]]) {
      const r = await api(p, { method: m, token: ctx.viewer, body });
      assert(r.status === 403, `viewer ${m} ${p}: ${r.status}`);
    }
  });
  await check("   a view-only role can look but not create, edit, cancel, export or manage categories", async () => {
    assert((await api("/api/expenses", { token: ctx.reader })).status === 200, "reader can't view");
    const meta = (await api("/api/expenses/meta", { token: ctx.reader })).json;
    assert(meta.accounts.every((a) => a.balance === undefined), "view-only role sees cash balances");
    for (const [m, p, body] of [["POST", "/api/expenses", base()], ["PATCH", `/api/expenses/${first.id}`, { amount: 1 }], ["POST", `/api/expenses/${first.id}/cancel`, { reason: "x" }], ["GET", "/api/expenses/report/export.csv"], ["POST", "/api/expense-categories", { name: "Hack" }]]) {
      const r = await api(p, { method: m, token: ctx.reader, body });
      assert(r.status === 403, `reader ${m} ${p}: ${r.status}`);
    }
    assert(!(await api("/api/auth/me", { token: ctx.reader })).json.user.rawKeys.includes("expenses.create"), "rawKeys");
  });
  await check("   the Company Admin manages categories; an archived one can't be used for new expenses", async () => {
    const c = await api("/api/expense-categories", { method: "POST", token: ctx.admin, body: { name: "Security" } });
    assert(c.status === 201, c.text);
    const dup = await api("/api/expense-categories", { method: "POST", token: ctx.admin, body: { name: "security" } });
    assert(dup.status === 409, "duplicate category accepted");
    await api(`/api/expense-categories/${c.json.category.id}`, { method: "PATCH", token: ctx.admin, body: { status: "archived" } });
    const r = await post(ctx.admin, { ...base(), categoryId: c.json.category.id });
    assert(r.status === 400 && r.json.field === "categoryId", "archived category used");
  });

  console.log("\nCompany isolation");
  await check("13. Company B sees none of Company A's expenses, categories' usage or accounts — by list, id or filter", async () => {
    const list = (await api("/api/expenses?status=all", { token: ctx.bAdmin })).json;
    assert(list.total === 0, `B sees ${list.total} expenses`);
    for (const p of [`/api/expenses/${first.id}`, `/api/expenses/${first.id}/attachment`]) assert((await api(p, { token: ctx.bAdmin })).status === 404, `B reached ${p}`);
    for (const [m, p, body] of [["PATCH", `/api/expenses/${first.id}`, { amount: 1 }], ["POST", `/api/expenses/${first.id}/cancel`, { reason: "x" }]]) {
      assert((await api(p, { method: m, token: ctx.bAdmin, body })).status === 404, `B ${m} ${p}`);
    }
    const meta = (await api("/api/expenses/meta", { token: ctx.bAdmin })).json;
    assert(meta.accounts.length === 1 && meta.accounts[0].id === ctx.bTill.id, "B sees A's cash accounts");
    assert(meta.categories.every((c) => c.usedCount === 0), "B sees A's category usage");
    const filtered = (await api(`/api/expenses?cashAccountId=${ctx.till.id}`, { token: ctx.bAdmin })).json;
    assert(filtered.total === 0, "filter by A's account leaked");
    const sum = (await api("/api/expenses/summary", { token: ctx.bAdmin })).json;
    assert(sum.count === 0, "B's dashboard counts A's expenses");
  });
  await check("   Company B's own expense stays in Company B", async () => {
    const r = await post(ctx.bAdmin, { date: daysAgo(0), categoryId: (await api("/api/expense-categories", { token: ctx.bAdmin })).json.categories[0].id, description: "Berbera rent", amount: 500, currency: "USD", cashAccountId: ctx.bTill.id });
    assert(r.status === 201, r.text);
    assert((await api(`/api/expenses/${r.json.expense.id}`, { token: ctx.admin })).status === 404, "A sees B's expense");
    const bTill = (await api(`/api/cash/accounts/${ctx.bTill.id}`, { token: ctx.saB })).json.account;
    assert(near(bTill.balance, 2500), `B till ${bTill.balance}`);
  });
}

// 6. Atomicity, checked in-process against the same database after the
// server has stopped: if the balance replay fails half-way, neither the
// expense nor its cash movement may remain.
function rollbackChecks() {
  console.log("\nAtomicity");
  Object.assign(process.env, TESTDB.env);
  const tenancy = require("../src/tenancy");
  tenancy.useScriptTenant(ctx.A);
  const { all, get } = require("../src/db");
  const domain = require("../src/domain");
  const ex = require("../src/expenses");
  const user = { id: "u-test", name: "Rollback Tester" };
  const counts = () => ({ exp: get("SELECT COUNT(*) n FROM expenses").n, led: get("SELECT COUNT(*) n FROM cash_ledger").n, bal: get("SELECT balance FROM cash_accounts WHERE id = ?", [ctx.till.id]).balance });
  const original = domain.rebuildCashAccountBalance;
  return Promise.resolve()
    .then(() => check("6. a failure while posting leaves no expense and no cash movement behind", async () => {
      const c0 = counts();
      domain.rebuildCashAccountBalance = () => { throw new Error("simulated ledger failure"); };
      let threw = false;
      try { ex.createExpense(user, { ...base(), clientRequestId: "req-rollback" }); } catch (e) { threw = /simulated/.test(e.message); }
      domain.rebuildCashAccountBalance = original;
      const c1 = counts();
      assert(threw, "the failure was not raised");
      assert(c1.exp === c0.exp && c1.led === c0.led && c1.bal === c0.bal, `left behind: ${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`);
      assert(!get("SELECT id FROM expenses WHERE client_request_id = 'req-rollback'"), "expense row survived");
    }))
    .then(() => check("   a failure while editing or cancelling leaves the expense exactly as it was", async () => {
      const e = all("SELECT * FROM expenses WHERE status = 'posted' AND currency = 'USD' LIMIT 1")[0];
      const leg0 = get("SELECT * FROM cash_ledger WHERE id = ?", [e.cash_ledger_id]);
      const c0 = counts();
      domain.rebuildCashAccountBalance = () => { throw new Error("simulated ledger failure"); };
      try { ex.updateExpense(user, e.id, { amount: 999 }); } catch (err) { /* expected */ }
      try { ex.cancelExpense(user, e.id, "test"); } catch (err) { /* expected */ }
      domain.rebuildCashAccountBalance = original;
      const e1 = get("SELECT * FROM expenses WHERE id = ?", [e.id]);
      const leg1 = get("SELECT * FROM cash_ledger WHERE id = ?", [e.cash_ledger_id]);
      const c1 = counts();
      assert(e1.amount === e.amount && e1.status === "posted" && leg1.amount === leg0.amount && c1.led === c0.led && c1.bal === c0.bal, "partial change survived");
    }))
    .then(() => check("   every Cash in Hand balance equals a fresh replay of its ledger", async () => {
      for (const a of all("SELECT id, balance FROM cash_accounts")) {
        const replay = all("SELECT type, amount FROM cash_ledger WHERE cash_account_id = ?", [a.id]).reduce((s, l) => s + (l.type === "deposit" ? l.amount : -l.amount), 0);
        assert(near(replay, a.balance), `${a.id}: stored ${a.balance}, replay ${replay}`);
      }
      const orphans = get("SELECT COUNT(*) n FROM expenses e WHERE NOT EXISTS (SELECT 1 FROM cash_ledger l WHERE l.id = e.cash_ledger_id)").n;
      const legs = get("SELECT COUNT(*) n FROM cash_ledger l WHERE l.source_type = 'expense' AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = l.source_id)").n;
      assert(orphans === 0 && legs === 0, `orphans: ${orphans} expenses, ${legs} movements`);
    }));
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  console.log("\nBrowser");
  const errors = [];
  const open = async (viewport, user, pw, lang) => {
    const c = await browser.newContext({ viewport });
    if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.dismiss());
    await p.goto(BASE); await p.waitForTimeout(500);
    await p.locator("input").first().fill(user); await p.fill('input[type="password"]', pw);
    await p.keyboard.press("Enter"); await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(700);
    return { c, p };
  };
  try {
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "sahra.ismail", PW);
      await check("the menu item is hidden from a role without expense access", async () => {
        assert(await p.locator(".gk-nav-btn", { hasText: "Company Expenses" }).count() === 0, "viewer sees Company Expenses");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "amina.yusuf", PW);
      await p.locator(".gk-nav-btn", { hasText: "Company Expenses" }).first().click(); await p.waitForTimeout(1500);
      await check("the page shows real totals, charts and the expense list", async () => {
        const t = await p.locator("body").innerText();
        assert(/Total Expenses \(USD\)/.test(t) && /Total Expenses \(SLSH\)/.test(t) && /Expenses over time — USD/.test(t), "cards/charts missing");
        await p.locator("select").first().selectOption("all"); await p.waitForTimeout(900);
        assert(await p.locator("table.gk-table tbody tr").count() > 0, "no rows");
      });
      await check("the form checks required fields before sending anything", async () => {
        await p.locator("button", { hasText: "Add New Expense" }).click(); await p.waitForTimeout(300);
        await p.locator('[role="dialog"] button[type="submit"]').click(); await p.waitForTimeout(200);
        const t = await p.locator('[role="dialog"]').last().innerText();
        assert(/Expense Category is required/.test(t) && /Amount is required/.test(t) && /Paid From Account is required/.test(t), t.slice(0, 200));
      });
      await check("saving with a double click records one expense; the list and totals update", async () => {
        const before = (await api("/api/expenses?status=all", { token: ctx.admin })).json.total;
        const m = p.locator('[role="dialog"]').last();
        await m.locator("select").nth(0).selectOption({ label: "Marketing" });
        await m.locator("input").nth(1).fill("Radio advert");
        await m.locator("input").nth(2).fill("75");
        await m.locator("select").nth(2).selectOption({ index: 1 });
        await m.locator('button[type="submit"]').dblclick(); await p.waitForTimeout(1500);
        const after = (await api("/api/expenses?status=all", { token: ctx.admin })).json.total;
        assert(after === before + 1, `${before} -> ${after}`);
        assert(/Radio advert/.test(await p.locator("table.gk-table").first().innerText()), "new row not shown");
      });
      await check("a failed request shows an error and keeps what was typed", async () => {
        await p.route("**/api/expenses", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Server unavailable" }) }) : route.continue()));
        await p.locator("button", { hasText: "Add New Expense" }).click(); await p.waitForTimeout(300);
        const m = p.locator('[role="dialog"]').last();
        await m.locator("select").nth(0).selectOption({ label: "Utilities" });
        await m.locator("input").nth(1).fill("Water bill");
        await m.locator("input").nth(2).fill("20");
        await m.locator("select").nth(2).selectOption({ index: 1 });
        await m.locator('button[type="submit"]').click(); await p.waitForTimeout(800);
        const t = await m.innerText();
        assert(/Server unavailable/.test(t) && (await m.locator("input").nth(1).inputValue()) === "Water bill", "error/inputs");
        await p.unroute("**/api/expenses");
        await m.locator("button", { hasText: /^Cancel$/ }).click(); await p.waitForTimeout(300);
      });
      await check("a failed list load shows an error with Try again, not a blank page", async () => {
        await p.route("**/api/expenses?*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
        await p.locator("select").first().selectOption("year"); await p.waitForTimeout(800);
        assert(/Could not load expenses/.test(await p.locator("body").innerText()), "no error state");
        await p.unroute("**/api/expenses?*");
        await p.locator("button", { hasText: "Try again" }).first().click(); await p.waitForTimeout(900);
        assert(await p.locator("table.gk-table tbody tr").count() > 0, "Try again did not reload");
      });
      await check("an empty period shows a clear empty message", async () => {
        await p.locator("select").first().selectOption("custom"); await p.waitForTimeout(200);
        await p.locator('input[type="date"]').nth(0).fill("2001-01-01");
        await p.locator('input[type="date"]').nth(1).fill("2001-01-31"); await p.waitForTimeout(1000);
        assert(/No expenses recorded for this period yet/.test(await p.locator("body").innerText()), "no empty state");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 390, height: 844 }, "amina.yusuf", PW, "so");
      await p.locator(".gk-mobile-hamburger").click(); await p.waitForTimeout(400);
      await p.locator(".gk-nav-btn", { hasText: "Kharashaadka Shirkadda" }).first().click(); await p.waitForTimeout(1500);
      await check("in Somali on a phone: translated, nothing missing, no sideways scrolling", async () => {
        const t = await p.locator("body").innerText();
        assert(/Kharashaadka Shirkadda/.test(t) && /Wadarta Kharashaadka \(USD\)/.test(t), t.slice(0, 200));
        const scroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert(!scroll, "page scrolls sideways");
        await p.locator("button", { hasText: "Ku dar Kharash Cusub" }).click(); await p.waitForTimeout(300);
        await p.locator('[role="dialog"] button[type="submit"]').click(); await p.waitForTimeout(200);
        assert(/Qaybta Kharashka waa lagama maarmaan/.test(await p.locator('[role="dialog"]').last().innerText()), "validation not in Somali");
        const missing = await p.evaluate(() => [...window.__i18n.missing].filter((s) => /\b(the|and|expense|expenses|amount|category|account)\b/i.test(s) && !/^(EXP|Radio|Office rent|Fuel|Power|Old internet|Pens|Berbera)/i.test(s)));
        assert(!missing.length, `untranslated: ${missing.slice(0, 5).join(" | ")}`);
      });
      await c.close();
    }
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await setup(); await apiChecks(); await browserChecks(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  await rollbackChecks();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
