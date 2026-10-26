"use strict";
// DASHBOARD UPGRADE round — regression tests.
// On a throw-away installation with two companies, proves that the dashboard:
//   * shows Balance Sheet and Cash in Hand figures that reconcile with the
//     accounts and cash accounts themselves, in each currency on its own,
//     and combines them only through the Cash in Hand rate (never the Daily
//     Rate, never without a rate);
//   * counts payments, expenses and quotations from their own records, each
//     exactly once (a cash transfer or an expense is not a "payment");
//   * gives Super Admin, Company Admin and staff only what their role allows
//     — in the API, not only on screen — and never another company's data;
//   * keeps working when one section fails, fits desktop/tablet/phone, and
//     is fully translated in Somali.
//
// Run with: npm run test:dashboard
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".dashboard-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("dashboard");
const PORT = Number(process.env.DASHBOARD_TEST_PORT || 4394);
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
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text };
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
const dash = async (token, q = "?range=thisMonth") => (await api("/api/dashboard" + q, { token })).json;
const today = () => new Date().toISOString().slice(0, 10);
// Read-only look at Company A's own database, to reconcile against.
function dbq(sql, ...params) {
  const db = require("./helpers/mysql").openScope(TESTDB.env, { companyId: "CMP-0001", readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

const ctx = {};
async function setup() {
  ctx.sa = await login("super.admin", SA_PW);
  const companies = (await api("/api/platform/companies", { token: ctx.sa })).json.companies;
  ctx.A = companies[0].id;
  ctx.ws = async (cid) => (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: cid } })).json;
  const wsA = await ctx.ws(ctx.A);
  ctx.saA = wsA.token; ctx.saUser = wsA.user;
  ctx.admin = await login("amina.yusuf");     // Company Admin — no Cash in Hand access by default
  ctx.cashier = await login("cabdi.maxamed"); // staff, no reports
  const mk = async (body) => {
    const r = await api("/api/cash/accounts", { method: "POST", token: ctx.saA, body });
    assert(r.status === 201, `cash account: ${r.status} ${r.text}`);
    return r.json.account;
  };
  ctx.till = await mk({ name: "Main Till", type: "physical_cash", currency: "USD", openingBalance: 5000 });
  ctx.bank = await mk({ name: "Dahabshiil Bank", type: "bank", currency: "USD", openingBalance: 20000 });
  ctx.zaad = await mk({ name: "Zaad Wallet", type: "mobile_money", currency: "SLSH", openingBalance: 10000000 });
  ctx.closed = await mk({ name: "Old Safe", type: "physical_cash", currency: "USD", openingBalance: 700 });
  await api(`/api/cash/accounts/${ctx.closed.id}/deactivate`, { method: "POST", token: ctx.saA, body: { reason: "test" } });
  ctx.usdAccount = (await api("/api/accounts?currency=USD", { token: ctx.saA })).json.accounts.find((a) => a.status === "active");
  const b = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Berbera Second Co", admin: B_ADMIN } });
  assert(b.status === 201, `Company B: ${b.status} ${b.text}`);
  ctx.B = b.json.company.id;
  ctx.bAdmin = await login(B_ADMIN.username, B_ADMIN.password);
  // A staff role that may see Cash in Hand and expenses, but has no reports.
  const role = await api("/api/roles", { method: "POST", token: ctx.saA, body: { name: "Cash Clerk", permissions: ["cash.view", "expenses.view", "currency.usd", "currency.slsh"] } });
  assert(role.status === 201, `role: ${role.status} ${role.text}`);
  const u = await api("/api/users", { method: "POST", token: ctx.saA, body: { name: "Clerk Person", username: "cash.clerk", password: "Clerk-Pass-2026x", roleId: role.json.role.id } });
  assert(u.status === 201, `user: ${u.status} ${u.text}`);
  ctx.clerk = await login("cash.clerk", "Clerk-Pass-2026x");
}

async function apiChecks() {
  console.log("\nBalance Sheet & Cash in Hand");
  await check("4. Cash in Hand totals = the active cash accounts, each currency on its own (deactivated left out)", async () => {
    const s = (await api("/api/cash/summary", { token: ctx.saA })).json;
    const rows = dbq("SELECT currency, SUM(balance) AS n FROM cash_accounts WHERE status = 'active' GROUP BY currency");
    const by = Object.fromEntries(rows.map((r) => [r.currency, r.n]));
    assert(near(s.totalUSD, by.USD) && near(s.totalUSD, 25000), `USD ${s.totalUSD} vs ${by.USD}`);
    assert(near(s.totalSLSH, by.SLSH) && near(s.totalSLSH, 10000000), `SLSH ${s.totalSLSH}`);
  });
  await check("1+2. Balance Sheet (USD/SLSH) = Debt + Cash in Hand − Credit, reconciled with the account balances", async () => {
    const bs = (await api("/api/cash/balance-sheet", { token: ctx.saA })).json;
    for (const [cur, col] of [["USD", "balance_usd"], ["SLSH", "balance_slsh"]]) {
      const [r] = dbq(`SELECT COALESCE(SUM(CASE WHEN ${col} < 0 THEN -${col} ELSE 0 END),0) AS debt, COALESCE(SUM(CASE WHEN ${col} > 0 THEN ${col} ELSE 0 END),0) AS credit FROM clients WHERE deleted_at IS NULL AND currency = ?`, cur);
      const b = bs.currencies[cur];
      assert(near(b.debt, r.debt) && near(b.credit, r.credit), `${cur} debt/credit ${b.debt}/${b.credit} vs ${r.debt}/${r.credit}`);
      assert(near(b.balanceSheet, b.debt + b.cashInHand - b.credit), `${cur} formula`);
    }
    const d = await dash(ctx.saA);
    assert(near(d.summary.usdBalance, dbq("SELECT SUM(balance_usd) AS n FROM clients WHERE deleted_at IS NULL AND currency='USD'")[0].n), "Total USD Balance card");
  });
  await check("14. with no Cash in Hand rate the combined Net Balance Sheet is unavailable — never the Daily Rate", async () => {
    const bs = (await api("/api/cash/balance-sheet", { token: ctx.saA })).json;
    assert(bs.combined.available === false && bs.cashRate == null, JSON.stringify(bs.combined));
  });
  await check("3+5. setting the Cash in Hand rate updates the rate card and the combined total (USD × rate + SLSH)", async () => {
    const r = await api("/api/cash/rate", { method: "POST", token: ctx.saA, body: { rate: 11700 } });
    assert(r.status === 200, r.text);
    const bs = (await api("/api/cash/balance-sheet", { token: ctx.saA })).json;
    const s = (await api("/api/cash/summary?base=SLSH", { token: ctx.saA })).json;
    assert(bs.cashRate.rate === 11700 && s.rate === 11700, "rate");
    const u = bs.currencies.USD.balanceSheet, sl = bs.currencies.SLSH.balanceSheet;
    assert(bs.combined.available && near(bs.combined.slshEquivalent.total, u * 11700 + sl), `${JSON.stringify(bs.combined.slshEquivalent)} vs ${u * 11700 + sl}`);
    assert(near(bs.combined.usdEquivalent.total, u + sl / 11700), "USD equivalent");
    assert(near(s.netCashInHand, s.totalSLSH + s.totalUSD * 11700), "Net Cash in Hand (SLSH)");
  });

  console.log("\nKPIs");
  let before;
  await check("6. payments received/made reconcile with the ledger's own deposits and withdrawals for the period", async () => {
    before = await dash(ctx.saA);
    const from = before.meta.from, to = before.meta.to;
    const rows = dbq("SELECT type, currency, SUM(amount) AS n, COUNT(*) AS c FROM account_ledger WHERE source_type IS NULL AND date(date) >= date(?) AND date(date) <= date(?) GROUP BY type, currency", from, to);
    const get = (t, c) => rows.find((r) => r.type === t && r.currency === c) || { n: 0, c: 0 };
    const pr = before.summary.paymentsReceived, pm = before.summary.paymentsMade;
    assert(near(pr.usd, get("deposit", "USD").n) && near(pr.slsh, get("deposit", "SLSH").n), `received ${JSON.stringify(pr)} vs ${JSON.stringify(rows)}`);
    assert(near(pm.usd, get("withdrawal", "USD").n) && near(pm.slsh, get("withdrawal", "SLSH").n), `made ${JSON.stringify(pm)}`);
    assert(pr.count === get("deposit", "USD").c + get("deposit", "SLSH").c, "received count");
    const pend = dbq("SELECT COUNT(*) AS n FROM quotations WHERE status IN ('Pending','Partially Paid')")[0].n;
    assert(before.summary.pendingQuotations === pend, `pending ${before.summary.pendingQuotations} vs ${pend}`);
  });
  await check("7. a deposit is counted once; a cash transfer and an expense are not payments", async () => {
    const dep = await api(`/api/accounts/${ctx.usdAccount.id}/deposit`, { method: "POST", token: ctx.saA, body: { amount: 123.45, currency: "USD", cashAccountId: ctx.till.id } });
    assert(dep.status === 200 || dep.status === 201, `deposit: ${dep.status} ${dep.text}`);
    const tr = await api("/api/cash/transfers", { method: "POST", token: ctx.saA, body: { fromCashAccountId: ctx.bank.id, toCashAccountId: ctx.till.id, amount: 500, date: today() } });
    assert(tr.status === 200 || tr.status === 201, `transfer: ${tr.status} ${tr.text}`);
    const cats = (await api("/api/expense-categories", { token: ctx.saA })).json.categories;
    const ex = await api("/api/expenses", { method: "POST", token: ctx.saA, body: { date: today(), categoryId: cats[0].id, description: "Dashboard test rent", amount: 400, currency: "USD", cashAccountId: ctx.till.id } });
    assert(ex.status === 201, `expense: ${ex.status} ${ex.text}`);
    const after = await dash(ctx.saA);
    assert(near(after.summary.paymentsReceived.usd - before.summary.paymentsReceived.usd, 123.45) && after.summary.paymentsReceived.count === before.summary.paymentsReceived.count + 1, "deposit not counted exactly once");
    assert(near(after.summary.paymentsMade.usd, before.summary.paymentsMade.usd), "transfer/expense counted as a payment made");
    const s = (await api("/api/cash/summary", { token: ctx.saA })).json;
    assert(near(s.totalUSD, 25000 + 123.45 - 400), `cash after deposit (+123.45), transfer (no change) and expense (−400): ${s.totalUSD}`);
  });
  await check("6. Company Expenses on the dashboard = the posted expenses of the period, per currency", async () => {
    const d = await dash(ctx.saA);
    const e = (await api(`/api/expenses/summary?from=${d.meta.from}&to=${d.meta.to}`, { token: ctx.saA })).json;
    const rows = dbq("SELECT currency, SUM(amount) AS n, COUNT(*) AS c FROM expenses WHERE status = 'posted' AND date(date) >= date(?) AND date(date) <= date(?) GROUP BY currency", d.meta.from, d.meta.to);
    const usd = rows.find((r) => r.currency === "USD") || { n: 0, c: 0 };
    assert(near(e.totals.USD.total, usd.n) && e.totals.USD.count === usd.c && usd.c >= 1, `${JSON.stringify(e.totals.USD)} vs ${JSON.stringify(usd)}`);
    assert(e.totals.SLSH.total === 0, "SLSH mixed in");
  });

  console.log("\nRoles & isolation");
  await check("9. Super Admin gets every section, including the per-company overview (never summed)", async () => {
    const d = await dash(ctx.saA);
    assert(d.summary && d.accountOverview && d.meta.gates.reports, "full dashboard");
    assert((await api("/api/cash/balance-sheet", { token: ctx.saA })).status === 200, "balance sheet");
    const o = await api("/api/platform/overview", { token: ctx.saA });
    assert(o.status === 200 && o.json.companies.length === 2 && o.json.counts.total === 2, `overview: ${o.status}`);
    assert(o.json.companies.every((c) => c.summary && c.summary.accountBalances), "per-company summaries");
    assert(!("totals" in o.json) && !("combined" in o.json), "cross-company totals must not exist");
  });
  await check("10. Company Admin: full company dashboard, but no Cash in Hand data without cash.view, no global view", async () => {
    const d = await dash(ctx.admin);
    assert(d.summary && d.summary.paymentsReceived, "admin dashboard");
    assert((await api("/api/cash/summary", { token: ctx.admin })).status === 403, "cash summary not refused");
    assert((await api("/api/cash/balance-sheet", { token: ctx.admin })).status === 403, "balance sheet not refused");
    assert((await api("/api/platform/overview", { token: ctx.admin })).status === 403, "global overview not refused");
    assert((await api("/api/expenses/summary", { token: ctx.admin })).status === 200, "admin should see expenses");
  });
  await check("11. staff see only what their role allows — no financial data leaks through the dashboard API", async () => {
    const d = await dash(ctx.cashier);
    assert(!d.summary && !d.accountOverview && !d.recentTransactions && !d.balanceTrend, `cashier got: ${Object.keys(d).join(",")}`);
    assert((await api("/api/expenses/summary", { token: ctx.cashier })).status === 403, "cashier expenses");
    assert((await api("/api/cash/summary", { token: ctx.cashier })).status === 403, "cashier cash");
    const c = await dash(ctx.clerk);
    assert(!c.summary, "clerk has no reports grant");
    assert((await api("/api/cash/balance-sheet", { token: ctx.clerk })).status === 200 && (await api("/api/expenses/summary", { token: ctx.clerk })).status === 200, "clerk's own permissions");
  });
  await check("12. without a sign-in nothing is returned", async () => {
    for (const p of ["/api/dashboard", "/api/cash/summary", "/api/cash/balance-sheet", "/api/expenses/summary", "/api/platform/overview"]) {
      const r = await api(p);
      assert(r.status === 401, `${p}: ${r.status}`);
    }
  });
  await check("8+13. each company's dashboard shows only its own figures — switching company switches every number", async () => {
    const a = await dash(ctx.saA);
    const wsB = await ctx.ws(ctx.B);
    const b = await dash(wsB.token);
    assert(b.summary.usdBalance === 0 && b.summary.slshBalance === 0 && b.summary.totalTransactions === 0, `Company B: ${JSON.stringify(b.summary)}`);
    assert(a.summary.usdBalance !== 0, "Company A should have balances");
    const bs = (await api("/api/cash/summary", { token: wsB.token })).json;
    assert(bs.totalUSD === 0 && bs.totalSLSH === 0, "Company A's cash visible in Company B");
    const bb = (await api("/api/cash/balance-sheet", { token: wsB.token })).json;
    assert(bb.combined.available === false, "Company A's Cash in Hand rate used in Company B");
    const bAdmin = await dash(ctx.bAdmin);
    assert(bAdmin.summary.totalTransactions === 0, "B's admin sees A's activity");
    assert((await api(`/api/dashboard?companyId=${ctx.A}`, { token: ctx.bAdmin })).json.summary.usdBalance === 0, "a companyId parameter must not switch company");
  });
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  console.log("\nBrowser");
  const errors = [];
  const wsA = await ctx.ws(ctx.A);
  const open = async (viewport, who, lang, routeHook) => {
    const c = await browser.newContext({ viewport });
    if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
    if (who === "sa") await c.addInitScript(([t, u]) => { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", JSON.stringify(u)); }, [wsA.token, wsA.user]);
    const p = await c.newPage();
    if (routeHook) await routeHook(p);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(500);
    if (who !== "sa") { await p.locator("input").first().fill(who); await p.fill('input[type="password"]', who === "cash.clerk" ? "Clerk-Pass-2026x" : PW); await p.keyboard.press("Enter"); }
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(2500);
    return { c, p };
  };
  const sections = (p) => p.evaluate(() => [...document.querySelectorAll("[data-dash-section]")].map((e) => e.dataset.dashSection));
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  try {
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "sa");
      await check("Super Admin: Balance Sheet, Cash in Hand, Company Expenses and All Companies are shown", async () => {
        const s = await sections(p);
        for (const k of ["balanceSheet", "cashInHand", "companyExpenses", "platformOverview", "quickActions"]) assert(s.includes(k), `missing ${k}: ${s}`);
        const t = await p.locator("[data-dash-section=balanceSheet]").innerText();
        assert(/Balance Sheet \(USD\)/.test(t) && /\$1 = SLSH 11,700/.test(t) && /SLSH Equivalent/.test(t), t.slice(0, 300));
        const net = await p.locator("[data-dash-section=cashInHand]").innerText();
        const cashUsd = (await api("/api/cash/summary", { token: wsA.token })).json.totalUSD;
        const shown = cashUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        assert(/Total Cash Account — USD/.test(net) && net.includes(`$${shown}`), `${shown} not in: ${net.slice(0, 300)}`);
        const all = await p.locator("[data-dash-section=platformOverview]").innerText();
        assert(/Berbera Second Co/.test(all) && /never added together/.test(all), all.slice(0, 200));
      });
      await check("quick actions go to the right page (View Cash Accounts → Cash in Hand)", async () => {
        await p.locator(".gk-dash-quick button", { hasText: "View Cash Accounts" }).click(); await p.waitForTimeout(1200);
        assert(/Cash Accounts/.test(await p.locator("body").innerText()) && await p.locator(".gk-cash-cards").count() === 1, "not on Cash in Hand");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "amina.yusuf");
      await check("Company Admin without Cash in Hand access: no Balance Sheet / Cash sections, expenses shown", async () => {
        const s = await sections(p);
        assert(!s.includes("balanceSheet") && !s.includes("cashInHand") && !s.includes("platformOverview"), `sections: ${s}`);
        assert(s.includes("companyExpenses"), `sections: ${s}`);
        assert(!/View Cash Accounts/.test(await p.locator(".gk-dash-quick").innerText()), "cash quick action shown");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "cash.clerk");
      await check("staff with only Cash in Hand + expenses: those sections, without the full reports dashboard", async () => {
        const s = await sections(p);
        assert(s.includes("balanceSheet") && s.includes("cashInHand") && s.includes("companyExpenses"), `sections: ${s}`);
        assert(await p.locator(".gk-dash-filterbar").count() === 0, "full dashboard filters shown to staff");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "cabdi.maxamed");
      await check("cashier: no financial sections at all", async () => {
        const s = await sections(p);
        assert(!s.some((k) => ["balanceSheet", "cashInHand", "companyExpenses", "platformOverview"].includes(k)), `sections: ${s}`);
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 900 }, "sa", null, (pg) => pg.route("**/api/cash/summary*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated failure" }) })));
      await check("15. if one section's data fails, it says so and the rest still loads (no stale or made-up totals)", async () => {
        const t = await p.locator("[data-dash-section=cashInHand]").innerText();
        assert(/Could not load Cash Account/.test(t) && !/Total Cash Account/.test(t), t.slice(0, 200));
        assert(/Balance Sheet \(USD\)/.test(await p.locator("[data-dash-section=balanceSheet]").innerText()), "balance sheet should still load");
      });
      await c.close();
    }
    for (const [w, h] of [[1366, 900], [900, 1000], [390, 844]]) {
      const { c, p } = await open({ width: w, height: h }, "sa");
      await check(`16. ${w}px wide: no sideways scrolling`, async () => { assert(!(await overflow(p)), "page scrolls sideways"); });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 390, height: 844 }, "sa", "so");
      await check("17. Somali: the new sections are translated, nothing missing", async () => {
        const t = await p.locator("body").innerText();
        assert(/Miisaanka Maaliyadda/.test(t) && /Akoonka Lacagta/.test(t) && /Kharashaadka Shirkadda/.test(t) && /Dhammaan Shirkadaha/.test(t), t.slice(0, 300));
        const missing = await p.evaluate(() => [...window.__i18n.missing].filter((s) => !/:\s*[\d$]/.test(s) && /\b(balance|cash|expense|expenses|payment|payments|companies|company|quotation|view|open|received|made)\b/i.test(s) && !/Berbera|Second Co|OBO|Financial System|Till|Bank|Wallet|Safe/.test(s)));
        assert(!missing.length, `untranslated: ${missing.slice(0, 6).join(" | ")}`);
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
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
