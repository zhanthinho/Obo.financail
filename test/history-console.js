"use strict";
// TRANSACTION HISTORY CONSOLE round — Transaction History — USD / SLSH:
// server summary, Credit / Debit per entry, no double counting of linked
// exchange payments, profit visibility, currency and company isolation,
// filters, export and the page itself, on a throw-away database.
// Run with: npm run test:history-console
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("histcons");
const PORT = Number(process.env.HISTORY_CONSOLE_TEST_PORT || 4600);
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
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* binary */ }
  return { status: r.status, json, buf };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json?.token;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hist = async (tok, q) => (await api(`/api/history?withSummary=1&${q}`, { token: tok })).json;

let srv, serverErr = "";
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  const T = ctx.adm = await login("amina.yusuf", PW);
  const sa = ctx.sa = await login("super.admin", SA_PW);
  ctx.A = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  await api("/api/rate-history", { method: "POST", token: T, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } });
  const acc = async (name, currency) => (await api("/api/accounts", { method: "POST", token: T, body: { name, currency } })).json.account;
  ctx.u = await acc("History Usd Customer", "USD");
  ctx.s = await acc("History Slsh Customer", "SLSH");
  await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: T, body: { amount: 500, currency: "USD", notes: "HC credit note" } });
  await api(`/api/accounts/${ctx.u.id}/withdraw`, { method: "POST", token: T, body: { amount: 120.5, currency: "USD", notes: "HC debit note" } });
  const till = ctx.till = (await api("/api/cash/accounts", { method: "POST", token: ctx.A, body: { name: "HC Till USD", type: "physical_cash", currency: "USD" } })).json.account;
  const ex = await api("/api/transactions", { method: "POST", token: T, body: { clientName: ctx.u.name, clientAccountId: ctx.u.id, receivingAccountId: ctx.s.id, amountGiven: 100, currencyGiven: "USD", markPaid: true, payment: { cashAccountId: till.id } } });
  assert(ex.status === 201, `exchange ${ex.status} ${JSON.stringify(ex.json)}`);
  ctx.ex = ex.json.transaction;

  console.log("\nSummary, Credit / Debit");
  await check("Credit / Debit per entry follow the ledger type; exchanges and transfers have neither", async () => {
    const d = await hist(T, "currency=USD");
    for (const e of d.entries) {
      if (e.recordType === "ledger") assert((e.ledgerType === "deposit") === (e.credit != null) && (e.ledgerType === "withdrawal") === (e.debit != null), `${e.reference}`);
      if (e.recordType === "quotation") assert((e.credit != null) !== (e.debit != null), `quotation ${e.reference}`);
      if (e.recordType === "exchange" || e.recordType === "transfer") assert(e.credit == null && e.debit == null, `${e.recordType} ${e.reference} has credit/debit`);
    }
    const c = d.entries.find((e) => e.notes === "HC credit note"), w = d.entries.find((e) => e.notes === "HC debit note");
    assert(c.credit === 500 && c.debit == null && w.debit === 120.5 && w.credit == null, "amounts");
  });
  await check("the summary covers ALL matching entries: counts by type and USD-only money", async () => {
    const d = await hist(T, "currency=USD");
    const s = d.summary, cnt = (f) => d.entries.filter(f).length;
    assert(s.counts.entries === d.entries.length, "entries");
    assert(s.counts.exchanges === cnt((e) => e.recordType === "exchange") && s.counts.transfers === cnt((e) => e.recordType === "transfer"), "type counts");
    assert(s.counts.creditsDebits === cnt((e) => e.recordType === "ledger") && s.counts.credits + s.counts.debits === s.counts.creditsDebits, "ledger counts");
    assert(s.counts.quotationPayments === cnt((e) => e.sourceType === "quotation_paid"), "quotation payments");
    const credits = r2(d.entries.reduce((t, e) => t + (e.credit || 0), 0)), debits = r2(d.entries.reduce((t, e) => t + (e.debit || 0), 0));
    assert(s.money.USD.credits === credits && s.money.USD.debits === debits && s.money.USD.net === r2(credits - debits), JSON.stringify(s.money));
    assert(!s.money.SLSH, "SLSH money mixed into USD page");
    assert(d.entries.every((e) => e.accountCurrency === "USD"), "non-USD entries");
  });
  await check("a paid exchange is not counted twice: its linked postings are not separate history rows", async () => {
    const d = await hist(T, `currency=USD&accountId=${ctx.u.id}`);
    const exRows = d.entries.filter((e) => e.recordType === "exchange" && e.id === ctx.ex.id);
    assert(exRows.length === 1, `exchange rows ${exRows.length}`);
    const sameRefLedger = d.entries.filter((e) => e.recordType === "ledger" && e.reference === exRows[0].reference);
    assert(sameRefLedger.length <= 1, "exchange posting listed more than once");
    const before = await hist(T, "currency=USD");
    assert(before.summary.money.USD.credits === r2(before.entries.reduce((t, e) => t + (e.credit || 0), 0)), "credits total mismatch");
  });
  await check("exchange profit is shown only with permission, as recorded, voided exchanges excluded", async () => {
    const d = await hist(ctx.A, "currency=USD");
    assert(d.summary.profit && typeof d.summary.profit.usd === "number", "super admin sees no profit");
    const expect = r2(d.entries.filter((e) => e.recordType === "exchange" && e.status !== "voided" && e.profitUsd != null).reduce((t, e) => t + e.profitUsd, 0));
    assert(d.summary.profit.usd === expect, `${d.summary.profit.usd} vs ${expect}`);
    const role = await api("/api/roles", { method: "POST", token: ctx.A, body: { name: "History No Profit", permissions: ["reports.view", "reports.export", "reports.print", "auditLog.view", "payments.view", "payments.export", "payments.print", "currency.usd"] } });
    await api("/api/users", { method: "POST", token: ctx.A, body: { name: "Hana History", username: "hana.history", password: "Hana-Pass-2026!", roleId: role.json.role.id } });
    ctx.hana = await login("hana.history", "Hana-Pass-2026!");
    const h = await hist(ctx.hana, "currency=USD");
    assert(h.summary && h.summary.profit === null && h.entries.every((e) => e.profitUsd === undefined), "profit leaked");
  });

  console.log("\nFilters");
  await check("category, account, status, search and dates combine correctly", async () => {
    const credits = await hist(T, "currency=USD&type=deposit");
    assert(credits.entries.length > 0 && credits.entries.every((e) => e.recordType === "ledger" && e.ledgerType === "deposit"), "credits tab");
    const acc = await hist(T, `currency=USD&accountId=${ctx.u.id}&type=withdrawal`);
    assert(acc.entries.length >= 1 && acc.entries.every((e) => e.accountId === ctx.u.id && e.debit != null), "account + debits");
    const srch = await hist(T, "currency=USD&search=HC%20credit");
    assert(srch.entries.length === 1 && srch.summary.counts.entries === 1, `search ${srch.entries.length}`);
    const voided = await hist(T, "currency=USD&status=voided");
    assert(voided.entries.every((e) => (e.status || "").toLowerCase() === "voided"), "status");
    const future = await hist(T, "currency=USD&from=2099-01-01");
    assert(future.entries.length === 0 && future.summary.counts.entries === 0 && future.summary.money.USD === undefined, "date");
  });
  await check("the SLSH page shows SLSH entries and SLSH money only", async () => {
    const d = await hist(T, "currency=SLSH");
    assert(d.entries.every((e) => e.accountCurrency === "SLSH") && !d.summary.money.USD, "currency mixed");
  });
  await check("the Excel statement follows the filters", async () => {
    const r = await api("/api/history/statement.xlsx?currency=USD&search=HC%20debit", { token: T });
    assert(r.status === 200, `export ${r.status}`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
    const t = []; wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => t.push(String(c.value)))));
    const text = t.join("|");
    assert(/120\.5|120\.50/.test(text) && !/500\.00/.test(text.replace(/120\.50/g, "")), "export ignores the search");
  });

  console.log("\nSecurity");
  await check("a USD-only user cannot read SLSH history or its exports, and gets only USD without a currency", async () => {
    for (const p of ["/api/history?currency=SLSH", "/api/history/statement.xlsx?currency=SLSH", "/api/history/export.csv?currency=SLSH", "/api/history/statement.pdf?currency=SLSH"]) {
      assert((await api(p, { token: ctx.hana })).status === 403, `${p} not refused`);
    }
    const all = (await api("/api/history", { token: ctx.hana })).json.entries;
    assert(all.length > 0 && all.every((e) => e.accountCurrency === "USD"), "SLSH leaked without a currency filter");
  });
  await check("anonymous and users without report access are refused; another company sees nothing", async () => {
    assert((await api("/api/history?currency=USD")).status === 401, "anonymous");
    const cash = await login("cabdi.maxamed", PW);
    assert((await api("/api/history?currency=USD", { token: cash })).status === 403, "cashier reads history");
    const c = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "History Beta Ltd", admin: { name: "Hb Admin", username: "hb.admin", password: "BetaPass123!" } } });
    assert(c.status === 201 || c.status === 200, `company ${c.status}`);
    const b = await login("hb.admin", "BetaPass123!");
    const d = await hist(b, "currency=USD");
    assert(d.entries.length === 0 && d.summary.counts.entries === 0, `B sees ${d.entries.length}`);
    assert(!(await hist(b, `currency=USD&search=${encodeURIComponent(ctx.ex.referenceNumber || "EX")}`)).entries.length, "search leaks");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nTransaction History — USD page");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    const go = async (label) => {
      const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
      const group = p.locator(".gk-nav-group").filter({ has: btn });
      if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(300); } }
      await btn.click(); await p.waitForTimeout(1200);
    };
    const kpi = async (k) => (await p.locator(`.gk-acc-kpi[data-kpi="${k}"] .gk-acc-kpi-value`).innerText()).trim();
    await go("USD Transactions");
    const s0 = await hist(ctx.adm, "currency=USD");
    const fmt = (n) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
    await check("title, the category tabs, filter toolbar and KPI cards with the server's counts", async () => {
      assert(await p.locator("h1", { hasText: "Transaction History — USD" }).count() === 1, "title");
      for (const t of ["All", "Exchanges", "Transfers", "Quotations", "Quotation Payments", "Credits", "Debits"]) assert(await p.getByRole("tab", { name: t, exact: true }).count() === 1, `${t} tab`);
      for (const l of ["Account type", "Status", "Staff", "Account", "Date from", "Date to", "Search transactions"]) assert(await p.getByLabel(l, { exact: true }).count() >= 1, `${l} missing`);
      assert(await kpi("entries") === String(s0.summary.counts.entries) && await kpi("exchanges") === String(s0.summary.counts.exchanges) && await kpi("transfers") === String(s0.summary.counts.transfers), "kpis");
      // PROFESSIONAL TRANSACTION MANAGEMENT round: Credits / Debits cards
      // count every account posting (their tabs), Payments the direct ones.
      assert(await kpi("qpayments") === String(s0.summary.counts.quotationPayments) && await kpi("credits") === String(s0.summary.tabCounts.deposit) && await kpi("debits") === String(s0.summary.tabCounts.withdrawal) && await kpi("payments") === String(s0.summary.tabCounts.payment), "kpis 2");
      if (process.env.HIST_SHOT) await p.screenshot({ path: process.env.HIST_SHOT });
    });
    await check("Credit and Debit columns, and totals for all matching entries", async () => {
      const heads = (await p.locator(".gk-th-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      assert(heads.some((h) => h.startsWith("CREDIT")) && heads.some((h) => h.startsWith("DEBIT")), heads.join(","));
      assert((await p.locator('td[data-total="credit"]').innerText()).includes(fmt(s0.summary.money.USD.credits)), "credit total");
      assert((await p.locator('td[data-total="debit"]').innerText()).includes(fmt(s0.summary.money.USD.debits)), "debit total");
      assert(new RegExp(`${s0.summary.counts.entries} matching`).test(await p.locator('td[data-total="account"]').innerText()), "scope");
    });
    await check("the Debits tab shows only debits and updates the KPIs", async () => {
      await p.getByRole("tab", { name: "Debits", exact: true }).click(); await p.waitForTimeout(1000);
      const rec = await p.locator(".gk-th-table tbody tr").evaluateAll((els) => els.map((e) => e.dataset.record));
      assert(rec.length > 0 && rec.every((r) => r === "ledger"), rec.join(","));
      assert(await p.locator('.gk-th-table tbody td[data-col="credit"]').filter({ hasText: "$" }).count() === 0, "a credit amount on the Debits tab");
      await p.getByRole("tab", { name: "All", exact: true }).click(); await p.waitForTimeout(800);
    });
    await check("search narrows the rows; no results shows the empty state with Clear filters", async () => {
      await p.getByLabel("Search transactions").fill("HC credit"); await p.waitForTimeout(1200);
      assert(await kpi("entries") === "1", `entries ${await kpi("entries")}`);
      await p.getByLabel("Search transactions").fill("zzzz-no-such-thing"); await p.waitForTimeout(1200);
      await p.getByText("No transactions found").waitFor({ timeout: 4000 });
      await p.locator(".gk-th-empty").getByRole("button", { name: "Clear filters" }).click(); await p.waitForTimeout(1000);
      assert(await kpi("entries") === String(s0.summary.counts.entries), "clear filters");
    });
    await check("clicking a row opens the existing transaction details", async () => {
      await p.locator(`.gk-th-table tbody tr[data-record="exchange"]`).first().click();
      await p.getByRole("dialog").waitFor({ timeout: 5000 });
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: /Close|×/ }).first().click();
    });
    await check("Refresh reloads; Export downloads the filtered statement", async () => {
      const before = Number(await kpi("entries"));
      const dep = await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: ctx.adm, body: { amount: 1, currency: "USD", cashAccountId: ctx.till.id } });
      assert(dep.status < 300, `deposit ${dep.status} ${JSON.stringify(dep.json)}`);
      await p.locator(".gk-th-toolbar").getByRole("button", { name: "Refresh" }).click(); await p.waitForTimeout(1500);
      assert(Number(await kpi("entries")) === before + 1, `refresh ${before} -> ${await kpi("entries")}`);
      const [d] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.locator(".gk-th-toolbar").getByRole("button", { name: "Export" }).click()]);
      assert(/obo-transaction-statement-USD\.xlsx$/.test(d.suggestedFilename()), d.suggestedFilename());
    });
    await check("Transaction History — SLSH uses SLSH only", async () => {
      await go("SLSH Transactions");
      assert(await p.locator("h1", { hasText: "Transaction History — SLSH" }).count() === 1, "title");
      const s = await hist(ctx.adm, "currency=SLSH");
      assert(await kpi("entries") === String(s.summary.counts.entries), "slsh kpi");
    });
    await check("tablet and phone: KPIs wrap, no sideways page scrolling", async () => {
      for (const [w, n] of [[900, 3], [390, 2]]) {
        await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(400);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `${w}px overflow ${over}`);
        const cols = await p.locator(".gk-th-kpis").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        assert(cols === n, `${w}px kpi columns ${cols}`);
      }
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
