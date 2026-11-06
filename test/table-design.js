"use strict";
// GLOBAL FINANCIAL TABLE DESIGN round — one table look across FINMAN
// (emerald header, light-mint Balance column, green Credit / red Debit,
// icon actions, Inter numbers) with footers whose totals cover every
// matching record on every page, per currency. On a throw-away database.
// Run with: npm run test:table-design
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("tabledesign");
const PORT = Number(process.env.TABLE_DESIGN_TEST_PORT || 4674);
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
const money = (n) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
const r2 = (n) => Math.round(n * 100) / 100;

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
  const amina = (await api("/api/users", { token: SA })).json.users.find((u) => u.username === "amina.yusuf");
  const g = await api(`/api/users/${amina.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: ["cash.view", "cash.update", "cash.deposit", "loans.view"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } });
  assert(g.status === 200, `grant ${g.status}`);
  const till = (await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Td Till USD", type: "physical_cash", currency: "USD" } })).json.account;
  // More customer accounts than one page (10), so footers must cover every page.
  for (let i = 0; i < 12; i++) {
    const a = (await api("/api/accounts", { method: "POST", token: SA, body: { name: `Td Customer ${String(i).padStart(2, "0")}`, currency: "USD", contact: `+252 63 55${String(i).padStart(5, "0")}` } })).json.account;
    if (i % 3 === 0) await api(`/api/accounts/${a.id}/deposit`, { method: "POST", token: SA, body: { amount: 10 + i, currency: "USD", cashAccountId: till.id } });
    if (i === 4) await api(`/api/accounts/${a.id}/withdraw`, { method: "POST", token: SA, body: { amount: 7.25, currency: "USD", cashAccountId: till.id } });
  }
  // A second USD Cash Account, a Cash Transfer, a Cash Exchange and a Loan.
  const till2 = (await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Td Bank USD", type: "bank", currency: "USD", openingBalance: 40 } })).json.account;
  const tillS = (await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Td Till SLSH", type: "physical_cash", currency: "SLSH", openingBalance: 500000 } })).json.account;
  const trf = await api("/api/cash/transfers", { method: "POST", token: SA, body: { fromCashAccountId: till.id, toCashAccountId: till2.id, amount: 6.25, notes: "Td move to bank" } });
  assert(trf.status < 300, `transfer ${trf.status} ${JSON.stringify(trf.json)}`);
  const xch = await api("/api/cash/exchanges", { method: "POST", token: SA, body: { fromCashAccountId: tillS.id, toCashAccountId: till2.id, amountGiven: 87500, rateUsed: 8750 } });
  assert(xch.status < 300, `exchange ${xch.status} ${JSON.stringify(xch.json)}`);
  const loanCust = (await api("/api/accounts?currency=USD&search=Td%20Customer%2001", { token: SA })).json.accounts[0];
  const ln = await api("/api/loans", { method: "POST", token: SA, body: { clientId: loanCust.id, cashAccountId: till2.id, amount: 20, notes: "Td short loan" } });
  assert(ln.status < 300, `loan ${ln.status} ${JSON.stringify(ln.json)}`);
  const rp = await api(`/api/loans/${ln.json.loan.id}/payments`, { method: "POST", token: SA, body: { amount: 5, cashAccountId: till2.id } });
  assert(rp.status < 300, `repay ${rp.status} ${JSON.stringify(rp.json)}`);
  // A plain (editable) cash movement, made last — the newest entry.
  await new Promise((r) => setTimeout(r, 1100));
  const top = await api(`/api/cash/accounts/${till.id}/deposit`, { method: "POST", token: SA, body: { amount: 3.5, description: "Td float top-up" } });
  assert(top.status < 300, `cash deposit ${top.status} ${JSON.stringify(top.json)}`);
  const A = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW } })).json.token;
  const usdCustomers = (await api("/api/accounts?currency=USD&type=customer", { token: A })).json.accounts;
  const ledger = (await api("/api/account-ledger?currency=USD", { token: A })).json.entries;
  const hist = (await api("/api/history?currency=USD&withSummary=1&page=1&pageSize=10", { token: A })).json;

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
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
      await btn.click(); await p.waitForTimeout(1400);
    };
    const style = (loc, prop) => loc.evaluate((el, pr) => getComputedStyle(el)[pr], prop);
    const EMERALD = "rgb(16, 63, 59)";

    console.log("\nAccounts — USD");
    await go("USD Accounts");
    const tbl = p.locator("table.gk-table").first();
    await check("emerald header with white text; columns # | Account # | Customer Name | Phone | Status | Created At | ... | Balance | Actions", async () => {
      const th = tbl.locator("thead th").nth(1);
      assert(await style(th, "backgroundColor") === EMERALD, await style(th, "backgroundColor"));
      assert(await style(th, "color") === "rgb(255, 255, 255)", await style(th, "color"));
      const heads = (await tbl.locator("thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      const want = ["#", "ACCOUNT #", "CUSTOMER NAME", "PHONE", "STATUS", "CREATED AT", "BALANCE", "ACTIONS"];
      let at = -1;
      for (const w of want) { const i = heads.findIndex((h, k) => k > at && h.startsWith(w)); assert(i > at, `${w} missing/out of order: ${heads.join(" | ")}`); at = i; }
    });
    await check("the Balance column is light mint on every row; positive green, negative red, zero grey", async () => {
      const cells = tbl.locator("tbody td.gk-col-balance");
      assert(await cells.count() === Math.min(10, usdCustomers.length), `mint cells ${await cells.count()}`);
      assert(await style(cells.first(), "backgroundColor") === "rgb(240, 250, 247)", await style(cells.first(), "backgroundColor"));
      const signs = await tbl.locator("tbody .gk-bal").evaluateAll((els) => els.map((e) => [e.dataset.sign, getComputedStyle(e).color]));
      for (const [sg, col] of signs) {
        const want = { pos: "rgb(21, 128, 61)", neg: "rgb(220, 38, 38)", zero: "rgb(100, 116, 139)" }[sg];
        assert(col === want, `${sg} ${col}`);
      }
    });
    await check("customer initials in a round avatar; phone shown or —", async () => {
      assert(await tbl.locator("tbody tr").first().locator("text=/^[A-Z]{1,2}$/").count() >= 1, "no initials avatar");
      const phones = await tbl.locator('tbody td[data-col="contact"]').allInnerTexts();
      assert(phones.every((t) => t.trim().length > 0), "empty phone cell");
    });
    await check("emerald footer: all matching accounts (every page) and their total balance", async () => {
      const foot = tbl.locator("tfoot td").filter({ hasText: /Total/ }).first();
      assert(new RegExp(`all ${usdCustomers.length} matching`).test(await foot.innerText()), await foot.innerText());
      assert(await style(foot, "backgroundColor") === EMERALD, `footer bg ${await style(foot, "backgroundColor")}`);
      const total = r2(usdCustomers.reduce((n, a) => n + Number(a.balance || 0), 0));
      assert((await tbl.locator("tfoot").innerText()).includes(money(total)), `total ${money(total)} not in ${await tbl.locator("tfoot").innerText()}`);
    });
    await check("compact outlined icon actions (View, Edit, Deactivate) with accessible names", async () => {
      const row = tbl.locator("tbody tr").first();
      for (const l of ["View", "Edit", "Deactivate"]) assert(await row.getByRole("button", { name: new RegExp(`^${l}\\b`) }).count() === 1, `${l} action`);
      assert(await row.locator("button.gk-row-icon-btn").count() >= 2, "icon buttons");
    });
    await check("table text in Inter with tabular numerals", async () => {
      const cell = tbl.locator("tbody td.gk-col-balance").first();
      assert(/Inter/.test(await style(cell, "fontFamily")), await style(cell, "fontFamily"));
      assert(/tabular-nums/.test(await style(cell, "fontVariantNumeric")), `tabular nums: ${await style(cell, "fontVariantNumeric")}`);
    });

    console.log("\nPayments — USD");
    await go("USD Payment");
    const pt = p.locator("table.gk-table").first();
    await check("# | Date | Customer / Account | Description | Reference | Cash Account | Credit | Debit | Balance | Actions", async () => {
      const heads = (await pt.locator("thead th").allInnerTexts()).map((t) => t.trim().toUpperCase()).filter(Boolean);
      const want = ["#", "DATE", "ACCOUNT", "DESCRIPTION", "REFERENCE", "CASH ACCOUNT", "CREDIT", "DEBIT", "BALANCE"];
      let at = -1;
      for (const w of want) { const i = heads.findIndex((h, k) => k > at && h.startsWith(w)); assert(i > at, `${w}: ${heads.join(" | ")}`); at = i; }
    });
    await check("credit green with +, debit red with -, empty as —", async () => {
      const cr = pt.locator("tbody .gk-amt-credit").first();
      assert(await style(cr, "color") === "rgb(22, 163, 74)" && /^\+/.test(await cr.innerText()), "credit");
      const db = pt.locator("tbody .gk-amt-debit");
      if (await db.count()) assert(await style(db.first(), "color") === "rgb(220, 38, 38)" && /^-/.test(await db.first().innerText()), "debit");
      assert(await pt.locator("tbody td").filter({ hasText: /^—$/ }).count() > 0, "em dash");
    });
    await check("light-mint footer: totals of every matching payment, not one page", async () => {
      const cr = r2(ledger.filter((e) => e.type === "deposit").reduce((n, e) => n + e.amount, 0));
      const db = r2(ledger.filter((e) => e.type === "withdrawal").reduce((n, e) => n + e.amount, 0));
      const foot = await pt.locator("tfoot").innerText();
      assert(new RegExp(`Total — ${ledger.length} transactions`).test(foot), foot);
      assert(foot.includes(`+$${money(cr)}`) && foot.includes(`-$${money(db)}`), foot);
      assert(await style(pt.locator("tfoot td").first(), "backgroundColor") !== EMERALD, "transaction footer should be mint");
    });

    console.log("\nTransaction History — USD");
    await go("USD Transactions");
    const ht = p.locator("table.gk-th-table");
    await check("Date | Type | Description | Reference | Account | Credit | Debit | Balance | Actions", async () => {
      const heads = (await ht.locator("thead th").allInnerTexts()).map((t) => t.trim().toUpperCase()).filter(Boolean);
      const want = ["DATE", "TYPE", "DESCRIPTION", "REFERENCE", "ACCOUNT", "CREDIT", "DEBIT", "BALANCE", "ACTIONS"];
      let at = -1;
      for (const w of want) { const i = heads.findIndex((h, k) => k > at && h.startsWith(w)); assert(i > at, `${w}: ${heads.join(" | ")}`); at = i; }
    });
    await check("footer totals come from the server summary of all pages", async () => {
      const foot = await ht.locator("tfoot").innerText();
      assert(foot.includes(`+$${money(hist.summary.money.USD.credits)}`) && foot.includes(`-$${money(hist.summary.money.USD.debits)}`), foot);
      assert(new RegExp(`${hist.summary.counts.entries} matching`).test(foot), foot);
      assert(await ht.locator("tbody tr").count() === Math.min(10, hist.total), "one page");
    });

    console.log("\nCash Account");
    await go("Cash Account");
    if (process.env.TD_SHOT) await p.screenshot({ path: process.env.TD_SHOT });
    await check("Cash Accounts: #, mint Balance, emerald footer with per-currency totals", async () => {
      const t = p.locator("table.gk-table").first();
      const accts = (await api("/api/cash/accounts", { token: A })).json.accounts.filter((a) => a.status === "active");
      assert((await t.locator("thead th").first().innerText()).trim() === "#", "#");
      assert(await t.locator("tbody td.gk-col-balance").count() > 0, "mint balance");
      const foot = await t.locator("tfoot").innerText();
      assert(new RegExp(`all ${accts.length} matching`).test(foot), foot);
      const usd = r2(accts.filter((a) => a.currency === "USD").reduce((n, a) => n + Number(a.balance), 0));
      assert(foot.includes(money(usd)), `${money(usd)} in ${foot}`);
    });
    await check("Cash Movements: Credit / Debit / Balance columns and totals of all movements", async () => {
      await p.getByText("Cash Movements", { exact: true }).first().click(); await p.waitForTimeout(1200);
      const t = p.locator("table.gk-table").first();
      const heads = (await t.locator("thead th").allInnerTexts()).map((x) => x.trim().toUpperCase());
      for (const w of ["#", "DATE", "FROM CASH ACCOUNT", "TO CASH ACCOUNT", "DESCRIPTION", "REFERENCE", "CREDIT", "DEBIT", "BALANCE"]) assert(heads.some((h) => h.startsWith(w)), `${w}: ${heads.join(" | ")}`);
      const mv = (await api("/api/cash/ledger", { token: A })).json.entries.filter((e) => e.currency === "USD" && e.sourceType !== "cash_transfer"); // internal transfers are not credit/debit
      const cr = r2(mv.filter((e) => e.type === "deposit").reduce((n, e) => n + e.amount, 0));
      const foot = await t.locator('tfoot tr[data-currency="USD"]').innerText();
      assert(foot.includes(`+$${money(cr)}`), foot);
    });

    console.log("\nOne Cash Account (Account View design)");
    await check("# | Date & Time | Description | Reference | Credit | Debit | Balance — no Actions column", async () => {
      await go("Cash Account");
      await p.getByText("Cash Accounts", { exact: true }).first().click(); await p.waitForTimeout(800);
      await p.locator("table.gk-table tbody").getByText(/^Td Till Usd/i).first().click(); await p.waitForTimeout(1500);
      const t = p.locator("table.gk-cash-view-table");
      const heads = (await t.locator("thead th").allInnerTexts()).map((x) => x.trim().toUpperCase()).filter(Boolean);
      assert(JSON.stringify(heads) === JSON.stringify(["#", "DATE & TIME", "DESCRIPTION", "REFERENCE", "CREDIT", "DEBIT", "BALANCE"]), heads.join(" | "));
      assert(await style(t.locator("thead th").nth(1), "backgroundColor") === EMERALD, "header color");
      assert(await t.locator("tbody td.gk-col-balance").count() === await t.locator("tbody tr").count(), "mint balance column");
    });
    await check("oldest first, newest at the bottom; credits green +, debits red -, amounts right-aligned", async () => {
      const t = p.locator("table.gk-cash-view-table");
      assert(/Td float top-up/.test(await t.locator("tbody tr").last().innerText()), "newest not at the bottom");
      assert(!/Td float top-up/.test(await t.locator("tbody tr").first().innerText()), "newest at the top");
      const dates = await t.locator("tbody tr").evaluateAll((rs) => rs.length);
      assert(dates > 1, "rows");
      const cr = t.locator('tbody td[data-col="credit"]').first();
      assert(await style(cr, "textAlign") === "right", "right aligned");
      assert(await style(cr.locator(".gk-amt-credit"), "color") === "rgb(22, 163, 74)", "credit color");
    });
    await check("footer: count, total credit, total debit of every movement and the account's current balance", async () => {
      const t = p.locator("table.gk-cash-view-table");
      const acc = (await api(`/api/cash/accounts/${till.id}`, { token: A })).json.account;
      const mv = (await api(`/api/cash/ledger?cashAccountId=${till.id}`, { token: A })).json.entries;
      const cr = r2(mv.filter((e) => e.type === "deposit").reduce((n, e) => n + e.amount, 0));
      const db = r2(mv.filter((e) => e.type !== "deposit").reduce((n, e) => n + e.amount, 0));
      const txt = (k) => t.locator(`tfoot td[data-total="${k}"]`).innerText();
      assert((await txt("count")).includes(`Total — ${mv.length} transactions`), await txt("count"));
      assert((await txt("credit")).includes(`+$${money(cr)}`) && (await txt("debit")).includes(`-$${money(db)}`), `${await txt("credit")} ${await txt("debit")}`);
      assert((await txt("balance")).includes(money(acc.balance)), `${await txt("balance")} vs ${acc.balance}`);
      await p.getByPlaceholder("Reference #…").fill(mv[mv.length - 1].referenceNumber); await p.waitForTimeout(500);
      assert((await txt("count")).includes("Total — 1 transactions"), `filtered: ${await txt("count")}`);
      assert((await txt("balance")).includes(money(acc.balance)), "current balance changed with a filter");
      await p.getByPlaceholder("Reference #…").fill(""); await p.waitForTimeout(400);
    });
    await check("the Reference opens the movement with its details, and Edit for a plain movement", async () => {
      const t = p.locator("table.gk-cash-view-table");
      await t.locator("tbody tr").filter({ hasText: "Td float top-up" }).first().locator("button.gk-cash-ref-link").click();
      const dlg = p.getByRole("dialog"); await dlg.waitFor({ timeout: 5000 });
      assert(/Td float top-up/.test(await dlg.innerText()), "details");
      assert(await dlg.getByRole("button", { name: "Edit", exact: true }).count() === 1, "edit missing");
      await dlg.getByRole("button", { name: "Close", exact: true }).first().click(); await p.waitForTimeout(300);
      await t.locator("tbody tr").filter({ hasText: "Payment" }).first().locator("button.gk-cash-ref-link").click();
      const d2 = p.getByRole("dialog"); await d2.waitFor({ timeout: 5000 });
      await d2.locator('[data-related-item="ledger"]').waitFor({ timeout: 5000 });
      assert(await d2.getByRole("button", { name: "Edit", exact: true }).count() === 0, "edit on a linked entry");
      await d2.getByRole("button", { name: "Close", exact: true }).first().click(); await p.waitForTimeout(300);
    });

    console.log("\nCash Transfers, Exchanges, Loans and Movements");
    const openTab = async (name) => { await go("Cash Account"); await p.getByText(name, { exact: true }).first().click(); await p.waitForTimeout(1300); };
    await check("Transfers: one row per transfer with From / To, Credit and Debit, both balances, and the footer", async () => {
      await openTab("Transfers");
      const t = p.locator("table.gk-cash-transfers-table");
      const row = t.locator("tbody tr").filter({ hasText: "Td move to bank" });
      assert(await row.count() === 1, "transfer listed once");
      const txt = await row.innerText();
      assert(/Td Till Usd/i.test(txt) && /Td Bank Usd/i.test(txt) && txt.includes("+$6.25") && txt.includes("-$6.25"), txt);
      assert(await row.locator('td[data-col="balance"] .gk-bal').count() === 2, "both balances");
      const foot = await t.locator("tfoot").innerText();
      assert(/Total — 1 transfers/.test(foot) && foot.includes("+$6.25") && foot.includes("-$6.25"), foot);
      await row.locator("button.gk-cash-ref-link").click();
      const dlg = p.getByRole("dialog"); await dlg.waitFor({ timeout: 5000 });
      assert(await dlg.locator("table.gk-cash-legs tbody tr").count() === 2, "two Cash Account entries");
      await dlg.getByRole("button", { name: "Close", exact: true }).first().click(); await p.waitForTimeout(300);
    });
    await check("Exchanges: the given side is a Debit, the received side a Credit, per currency, at the recorded rate", async () => {
      await openTab("Exchanges");
      const t = p.locator("table.gk-cash-exchanges-table");
      const txt = await t.locator("tbody tr").first().innerText();
      assert(txt.includes("8,750") && /\+\$10\.00/.test(txt) && /-SLSH 87,500/.test(txt), txt);
      const foot = await t.locator("tfoot").innerText();
      assert(/Total — 1 exchanges/.test(foot) && foot.includes("+$10.00") && foot.includes("-SLSH 87,500"), foot);
    });
    await check("Loans: paid out as a Debit, repayments as a Credit (not a new loan), Outstanding from the loan", async () => {
      await openTab("Loans");
      const t = p.locator("table.gk-cash-loans-table");
      const row = t.locator("tbody tr").filter({ hasText: "Td short loan" });
      assert(await row.count() === 1, "loan listed once");
      const txt = await row.innerText();
      assert(txt.includes("-$20.00") && txt.includes("+$5.00") && /1 repayment/.test(txt) && txt.includes("$15.00"), txt);
      assert(/Total — 1 loans/.test(await t.locator("tfoot").innerText()), await t.locator("tfoot").innerText());
    });
    await check("Cash Movements: oldest first; From / To shown; a transfer is counted once and not as credit or debit", async () => {
      await openTab("Cash Movements");
      const t = p.locator("table.gk-cash-moves-table");
      const heads = (await t.locator("thead th").allInnerTexts()).map((x) => x.trim().toUpperCase());
      for (const w of ["MOVEMENT TYPE", "FROM CASH ACCOUNT", "TO CASH ACCOUNT"]) assert(heads.some((h) => h.startsWith(w)), heads.join(" | "));
      const mv = (await api("/api/cash/ledger?currency=USD", { token: A })).json.entries;
      const real = mv.filter((e) => e.sourceType !== "cash_transfer");
      const cr = r2(real.filter((e) => e.type === "deposit").reduce((n, e) => n + e.amount, 0));
      const db = r2(real.filter((e) => e.type !== "deposit").reduce((n, e) => n + e.amount, 0));
      await p.locator(".gk-filterbar select").filter({ has: p.locator('option[value="SLSH"]') }).first().selectOption("USD"); await p.waitForTimeout(1200);
      const foot = await t.locator('tfoot tr[data-currency="USD"]').innerText();
      assert(foot.includes(`+$${money(cr)}`) && foot.includes(`-$${money(db)}`), `${foot} vs +${cr} -${db}`);
      assert(new RegExp(`Total — ${real.length + 1} transactions`).test(foot), `${foot} (expected ${real.length + 1})`);
      const first = await t.locator("tbody tr").first().innerText();
      assert(/Opening balance/i.test(first) || /CSHDEP-.*-0001/.test(first), `oldest first: ${first}`);
      const tr = t.locator('tbody tr[data-source="cash_transfer"]');
      if (await tr.count()) { const x = await tr.first().innerText(); assert(/Td Till Usd/i.test(x) && /Td Bank Usd/i.test(x), x); }
    });

    console.log("\nResponsive");
    await check("tablet and phone: no sideways page scrolling; table scrolls inside its frame", async () => {
      await go("USD Accounts");
      for (const w of [900, 390]) {
        await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(400);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `${w}px overflow ${over}`);
        assert(await p.locator("table.gk-table tfoot").first().isVisible(), `${w}px footer hidden`);
      }
      await p.setViewportSize({ width: 1440, height: 900 });
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
