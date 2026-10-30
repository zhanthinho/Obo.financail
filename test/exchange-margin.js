"use strict";
// GLOBAL RATE & PROFIT round — Cost / Buy / Sell rates and the exchange
// margin, end to end. Proves, with the business's own worked examples:
//   1. Buy  $100, Cost 11,500, Buy 11,300  -> Cost Rate Difference 20,000 SLSH
//   2. Sell $100, Cost 11,500, Sell 11,700 -> Profit 20,000 SLSH
//   3. Sell $250 at the same rates         -> Profit 50,000 SLSH
//   4. Rate equal to the Cost Rate         -> 0
//   5. Missing / invalid rates             -> no made-up figure; rejected
//   6. Changing today's rates never re-values an earlier exchange
//   7. Another company's Cost Rate is never used
//   8. Dashboard and reports count each exchange exactly once, Buy and Sell apart
//
// Run with: npm run test:exchange-margin
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const calc = require("../src/exchange-calc");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("exmargin");
const PORT = Number(process.env.EXMARGIN_TEST_PORT || 4397);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const B_ADMIN = { name: "Second Admin", username: "second.admin", password: "Second-Admin-Pass-31" };

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
  return { status: res.status, json, text };
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
const RATES = { dailyRate: 11500, saleRate: 11500, costRate: 11500, buyRate: 11300, sellRate: 11700 };

function unitChecks() {
  console.log("Shared calculation (src/exchange-calc.js)");
  const m = (currencyGiven, usd, rate, costRate) => calc.computeMargin({
    currencyGiven, amountGiven: currencyGiven === "USD" ? usd : usd * rate, amountReceived: currencyGiven === "USD" ? usd * rate : usd, rate, costRate,
  });
  check("Test 1: Buy $100 at 11,300, Cost 11,500 -> Cost Rate Difference 20,000 SLSH", () => {
    const r = m("USD", 100, 11300, 11500);
    assert(r.side === "buy" && r.kind === "costRateDifference" && r.slsh === 20000, JSON.stringify(r));
    assert(r.costValue === 1150000 && r.txValue === 1130000, "cost/buy values");
  });
  check("Test 2: Sell $100 at 11,700, Cost 11,500 -> Profit 20,000 SLSH", () => {
    const r = m("SLSH", 100, 11700, 11500);
    assert(r.side === "sell" && r.kind === "profit" && r.slsh === 20000 && r.txValue === 1170000, JSON.stringify(r));
  });
  check("Test 3: Sell $250 -> Profit 50,000 SLSH", () => { assert(m("SLSH", 250, 11700, 11500).slsh === 50000, "not 50,000"); });
  check("Test 4: rate equal to the Cost Rate -> 0 (both directions)", () => {
    assert(m("USD", 100, 11500, 11500).slsh === 0 && m("SLSH", 100, 11500, 11500).slsh === 0, "not 0");
  });
  check("Test 5: missing or invalid rate -> null, never a made-up figure", () => {
    for (const [rate, cost] of [[11700, null], [11700, 0], [11700, -5], [11700, "abc"], [null, 11500], [0, 11500]]) {
      assert(m("SLSH", 100, rate, cost) === null, `rate ${rate} cost ${cost}`);
    }
    assert(calc.validateRates({ costRate: -1 }) && calc.validateRates({ sellRate: "x" }) && !calc.validateRates({ costRate: 11500 }), "validateRates");
  });
  check("large amounts keep exact SLSH", () => {
    assert(m("SLSH", 1234567.89, 11700, 11500).slsh === 246913578, "large amount");
  });
  check("default customer rate: Buy for USD -> SLSH, Sell for SLSH -> USD, Daily only as fallback", () => {
    assert(calc.defaultRateFor("USD", RATES) === 11300 && calc.defaultRateFor("SLSH", RATES) === 11700, "direction rates");
    assert(calc.defaultRateFor("SLSH", { dailyRate: 8750 }) === 8750, "fallback");
  });
}

const ctx = {};
async function apiChecks() {
  console.log("\nAPI");
  ctx.admin = await login("amina.yusuf");
  await check("Test 5 (API): a negative or non-numeric Cost/Buy/Sell rate is refused", async () => {
    for (const bad of [{ costRate: -1 }, { buyRate: "abc" }, { sellRate: 0 }]) {
      const r = await api("/api/rate-history", { method: "POST", token: ctx.admin, body: { dailyRate: 11500, saleRate: 11500, ...bad } });
      assert(r.status === 400, `${JSON.stringify(bad)} -> ${r.status}`);
    }
  });
  await check("no Cost Rate yet: an exchange records 0, not a made-up profit", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD", rateUsed: 11300 } })).json.transaction;
    assert(t.profitUsd === 0 && t.marginSlsh === null, JSON.stringify(t));
    ctx.preCost = t;
  });
  const r = await api("/api/rate-history", { method: "POST", token: ctx.admin, body: RATES });
  assert(r.status === 200, "set rates");
  await check("rates are returned by /api/rate and kept in the rate history", async () => {
    const d = (await api("/api/rate", { token: ctx.admin })).json;
    assert(d.costRate === 11500 && d.buyRate === 11300 && d.sellRate === 11700, JSON.stringify(d));
  });
  await check("Test 1 (API): Buy $100 uses the Buy Rate and stores Cost Rate + difference", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD" } })).json.transaction;
    assert(t.rateUsed === 11300 && t.amountReceived === 1130000 && t.costRate === 11500 && t.marginSide === "buy" && t.marginSlsh === 20000, JSON.stringify(t));
    assert(near(t.profitUsd, 20000 / 11500, 1e-6), `usd ${t.profitUsd}`);
    ctx.buyTx = t;
  });
  await check("Test 2-3 (API): Sell $100 and $250 use the Sell Rate -> 20,000 and 50,000 SLSH", async () => {
    const a = (await api("/api/transactions", { method: "POST", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 1170000, currencyGiven: "SLSH" } })).json.transaction;
    const b = (await api("/api/transactions", { method: "POST", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 2925000, currencyGiven: "SLSH" } })).json.transaction;
    assert(a.rateUsed === 11700 && a.amountReceived === 100 && a.marginSide === "sell" && a.marginSlsh === 20000, JSON.stringify(a));
    assert(b.amountReceived === 250 && b.marginSlsh === 50000, JSON.stringify(b));
    ctx.sellTx = a;
  });
  await check("Test 4 (API): a customer rate equal to the Cost Rate -> 0", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD", rateUsed: 11500 } })).json.transaction;
    assert(t.marginSlsh === 0 && t.profitUsd === 0, JSON.stringify(t));
  });
  await check("Test 6: changing today's rates never re-values an earlier exchange (list, history, edit)", async () => {
    await api("/api/rate-history", { method: "POST", token: ctx.admin, body: { ...RATES, costRate: 12000, buyRate: 11900, sellRate: 12100 } });
    const list = (await api("/api/transactions", { token: ctx.admin })).json.transactions;
    const s = list.find((x) => x.id === ctx.sellTx.id);
    assert(s.rateUsed === 11700 && s.costRate === 11500 && s.marginSlsh === 20000 && near(s.profitUsd, ctx.sellTx.profitUsd, 1e-9), JSON.stringify(s));
    const h = (await api("/api/history?type=exchange", { token: ctx.admin })).json.entries.find((e) => e.id === ctx.sellTx.id);
    assert(h.rate === 11700 && h.costRate === 11500 && h.marginSlsh === 20000, JSON.stringify(h));
    // An edit of the old exchange is still valued at ITS Cost Rate (11,500).
    const e = await api(`/api/transactions/${ctx.sellTx.id}`, { method: "PATCH", token: ctx.admin, body: { clientName: "Walk-in", amountGiven: 1170000, currencyGiven: "SLSH", rateUsed: 11700, notes: "edited" } });
    assert(e.status === 200 && e.json.transaction.costRate === 11500 && e.json.transaction.marginSlsh === 20000, JSON.stringify(e.json));
  });
  await check("an exchange recorded before any Cost Rate shows its date's rate (none) and keeps its stored 0", async () => {
    const t = (await api("/api/transactions", { token: ctx.admin })).json.transactions.find((x) => x.id === ctx.preCost.id);
    assert(t.costRate === null && t.profitUsd === 0, JSON.stringify(t));
  });
  await check("Test 7: another company's Cost Rate is never used", async () => {
    const sa = await login("super.admin", SA_PW);
    const b = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Second Co", admin: B_ADMIN } });
    assert(b.status === 201, `company: ${b.status} ${b.text}`);
    const bAdmin = await login(B_ADMIN.username, B_ADMIN.password);
    const rb = (await api("/api/rate", { token: bAdmin })).json;
    assert(rb.costRate === null && rb.buyRate === null && rb.sellRate === null, `company B sees ${JSON.stringify(rb)}`);
    await api("/api/rate-history", { method: "POST", token: bAdmin, body: { dailyRate: 9000, saleRate: 9000, costRate: 9000, buyRate: 8900, sellRate: 9100 } });
    const ra = (await api("/api/rate", { token: ctx.admin })).json;
    assert(ra.costRate === 12000, `company A cost changed to ${ra.costRate}`);
    const tb = (await api("/api/transactions", { method: "POST", token: bAdmin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD" } }));
    if (tb.status === 201 || tb.status === 200) {
      assert(tb.json.transaction.costRate === 9000 && tb.json.transaction.marginSlsh === 10000, JSON.stringify(tb.json.transaction));
    }
  });
  await check("Test 8: dashboard and report totals count each exchange once, Buy and Sell apart", async () => {
    const list = (await api("/api/transactions", { token: ctx.admin })).json.transactions.filter((t) => t.status === "active");
    const sell = list.filter((t) => t.currencyGiven === "SLSH"), buy = list.filter((t) => t.currencyGiven === "USD");
    const sum = (rows) => rows.reduce((s, t) => s + (Number(t.profitUsd) || 0), 0);
    const rep = (await api("/api/reports/exchange-summary", { token: ctx.admin })).json.totals;
    assert(rep.sellCount === sell.length && rep.buyCount === buy.length, `counts ${rep.sellCount}/${sell.length} ${rep.buyCount}/${buy.length}`);
    assert(near(rep.sellProfitUSD, sum(sell), 0.011) && near(rep.buyDiffUSD, sum(buy), 0.011), JSON.stringify(rep));
    assert(near(rep.profitUSD, rep.sellProfitUSD + rep.buyDiffUSD, 0.011), "combined total double-counts");
    const newOnes = (await api("/api/transactions", { token: ctx.admin })).json.transactions.filter((t) => t.costRate === 11500 && t.status === "active");
    const sellSlsh = newOnes.filter((t) => t.marginSide === "sell").reduce((s, t) => s + t.marginSlsh, 0);
    assert(sellSlsh === 70000, `sell SLSH ${sellSlsh}`);
    const today = new Date().toISOString().slice(0, 10);
    const d = (await api(`/api/dashboard?range=custom&from=${today}&to=${today}`, { token: ctx.admin })).json;
    const dm = d.exchangeActivity && d.exchangeActivity.margins;
    assert(dm, "dashboard has no margins");
    const todays = list.filter((t) => t.date.slice(0, 10) === today);
    assert(dm.sellCount + dm.buyCount === todays.length, `dashboard counted ${dm.sellCount + dm.buyCount}, expected ${todays.length}`);
    const repCur = (await api("/api/reports/exchange-summary?currency=SLSH", { token: ctx.admin })).json.totals;
    assert(repCur.buyCount === 0 && repCur.sellCount === sell.length, "currency filter");
  });
  await check("margins follow the existing profit permission: shown only where profit is", async () => {
    const sa = await login("super.admin", SA_PW);
    const ws = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: (await api("/api/platform/companies", { token: sa })).json.companies[0].id } })).json.token;
    const role = await api("/api/roles", { method: "POST", token: ws, body: { name: "No Profit Teller", permissions: ["exchange.create", "exchange.view", "exchange.viewAll", "currency.usd", "currency.slsh", "reports.view", "payments.view"] } });
    assert(role.status === 201, `role ${role.status} ${role.text}`);
    const u = await api("/api/users", { method: "POST", token: ws, body: { name: "No Profit", username: "no.profit", password: "No-Profit-Pass-2026", roleId: role.json.role.id } });
    assert(u.status === 201, `user ${u.status} ${u.text}`);
    const tok = await login("no.profit", "No-Profit-Pass-2026");
    const r = await api("/api/transactions", { token: tok });
    assert(r.status === 200 && r.json.transactions.length > 0, `list ${r.status}`);
    for (const t of r.json.transactions) assert(t.profitUsd === undefined && t.marginSlsh === undefined && t.costRate === undefined, "margin leaked in list");
    const h = await api("/api/history?type=exchange", { token: tok });
    if (h.status === 200) for (const e of h.json.entries) assert(e.marginSlsh === undefined && e.costRate === undefined, "margin leaked in history");
    const today = new Date().toISOString().slice(0, 10);
    const d = (await api(`/api/dashboard?range=custom&from=${today}&to=${today}`, { token: tok })).json;
    assert(!(d.exchangeActivity && d.exchangeActivity.margins), "margin leaked on dashboard");
  });
}

async function browserChecks() {
  console.log("\nScreens");
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
    // Put today's rates back to the worked example for the screen checks.
    await api("/api/rate-history", { method: "POST", token: ctx.admin, body: RATES });
    await p.reload(); await p.waitForTimeout(2500);
    await p.getByText("Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1200);
    await p.getByRole("button", { name: /New transaction/ }).click(); await p.waitForSelector("#qx-amount");
    await check("Quick Exchange, Buy $100: Cost Rate Difference +SLSH 20,000 before saving", async () => {
      await p.fill("#qx-amount", "100"); await p.waitForTimeout(200);
      const t = await p.locator(".gk-qx-margin").innerText();
      assert(/\+\$1\.74/.test(t) && /\+SLSH 20,000/.test(await p.locator(".gk-qx-margin-slsh").innerText()), t);
      assert(!(await p.locator("#qx-ratedetails").count()), "rate details should start closed (optional)");
      assert(/Cost Rate Difference/.test(await p.locator("[data-margin-side=buy]").innerText()), "label");
    });
    await check("Quick Exchange, Sell $100: Profit +SLSH 20,000; switching direction updates it", async () => {
      await p.click('button[aria-label="Reverse exchange direction"]');
      await p.fill("#qx-amount", "1170000"); await p.waitForTimeout(200);
      assert(/\+\$1\.74/.test(await p.locator(".gk-qx-margin").innerText()), "sell margin");
      assert(/Profit/.test(await p.locator("[data-margin-side=sell]").innerText()), "label");
      assert(/\$100\.00/.test(await p.locator("text=You Will Receive").first().locator("..").innerText()), "receive");
    });
    await check("the saved exchange shows its Cost Rate and margin in the list", async () => {
      await p.click('button:has-text("Record Exchange")'); await p.waitForTimeout(2500);
      const first = await p.locator("table tbody tr").first().innerText();
      assert(/PROFIT/i.test(first) && /\+\$1\.74/.test(first) && /\+SLSH 20,000/.test(first), first.replace(/\s+/g, " "));
      assert(!/COST RATE/i.test(await p.locator("table thead").first().innerText()), "Cost Rate column should be optional (hidden by default)");
    });
    await check("Manage Rates shows the per-$1 spreads and the example amount", async () => {
      await p.getByRole("button", { name: /New transaction/ }).click(); await p.waitForSelector("#qx-amount");
      await p.locator(".gk-qx button:has-text('Manage Rates')").click(); await p.waitForTimeout(600);
      const t = await p.locator(".gk-rates-cbs").innerText();
      assert(/\+SLSH 200/.test(t) && /\$100: \+\$1\.74 \(\+SLSH 20,000\)/.test(t), t.replace(/\s+/g, " "));
      const modal = await p.locator(".gk-rates-cbs").locator("xpath=ancestor::*[contains(., 'Manage Exchange Rates')][1]").innerText();
      assert(!/Daily Rate|Sale Rate|Daily SLSH/.test(modal), "old rate manager fields still shown");
    });
    await c.close();
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  unitChecks();
  console.log("\nSeeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await apiChecks(); await browserChecks(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
