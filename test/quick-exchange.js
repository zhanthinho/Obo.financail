"use strict";
// QUICK EXCHANGE round — regression tests for the redesigned Money Exchange
// form. On a throw-away installation it proves that:
//   * USD -> SLSH and SLSH -> USD convert at the Daily Rate (or a per-
//     transaction rate), and profit follows the Sale Rate spread exactly as
//     the screen shows it;
//   * a walk-in exchange changes no account balance; a tracked exchange
//     debits the From Account and credits the Receiving Account;
//   * a repeated submission (same request id) is saved once; bad input and
//     users without permission are refused by the server;
//   * the Quick Exchange page records a real transaction, switches direction
//     correctly, never saves twice on rapid clicks, is fully translated in
//     Somali and fits a phone screen.
//
// Run with: npm run test:quick-exchange
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("quickexchange");
const PORT = Number(process.env.QX_TEST_PORT || 4396);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
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
const login = async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PW } })).json.token;
const DAILY = 8750, SALE = 8650;
// Same formulas the form uses (and domain.js's computeExchangeProfit).
const profitOf = (cur, given, received) => cur === "USD" ? given * (DAILY - SALE) / SALE : received * (SALE - DAILY) / SALE;

let admin, accUsd, accSlsh;
async function balanceOf(id) { return (await api(`/api/accounts/${id}`, { token: admin })).json.account.balance; }

async function apiChecks() {
  admin = await login("amina.yusuf");
  const r = await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: DAILY, saleRate: SALE } });
  assert(r.status < 300, "could not set rates");
  accUsd = (await api("/api/accounts?currency=USD", { token: admin })).json.accounts[0];
  accSlsh = (await api("/api/accounts?currency=SLSH", { token: admin })).json.accounts[0];

  await check("1. USD -> SLSH converts at the Daily Rate", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD", profitUsd: profitOf("USD", 100) } })).json.transaction;
    assert(t.amountReceived === 875000 && t.currencyReceived === "SLSH" && t.rateUsed === DAILY, JSON.stringify(t));
  });
  await check("2. SLSH -> USD converts at the Daily Rate", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 1750000, currencyGiven: "SLSH" } })).json.transaction;
    assert(near(t.amountReceived, 200) && t.currencyReceived === "USD", JSON.stringify(t));
  });
  await check("3-4. a per-transaction customer rate is used instead of the Daily Rate", async () => {
    const t = (await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 10, currencyGiven: "USD", rateUsed: 8800 } })).json.transaction;
    assert(t.amountReceived === 88000 && t.rateUsed === 8800, JSON.stringify(t));
  });
  await check("7. profit: the form's estimate is what gets stored", async () => {
    const est = profitOf("USD", 100);
    const t = (await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 100, currencyGiven: "USD", profitUsd: Number(est.toFixed(2)) } })).json.transaction;
    assert(near(t.profitUsd, 1.16), `profit ${t.profitUsd}`);
    const est2 = profitOf("SLSH", 875000, 100);
    assert(est2 < 0, "SLSH->USD at Daily above Sale should be a negative spread for this direction");
  });
  await check("8. tracked exchange: From Account debited, Receiving Account credited", async () => {
    const bU = await balanceOf(accUsd.id), bS = await balanceOf(accSlsh.id);
    const res = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: accUsd.name, clientAccountId: accUsd.id, receivingAccountId: accSlsh.id, amountGiven: 50, currencyGiven: "USD" } });
    assert(res.status < 300, JSON.stringify(res.json));
    assert(near(await balanceOf(accUsd.id), bU - 50), "USD account not debited by 50");
    assert(near(await balanceOf(accSlsh.id), bS + 437500), "SLSH account not credited by 437,500");
  });
  await check("9. walk-in exchange changes no account balance", async () => {
    const bU = await balanceOf(accUsd.id);
    await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 20, currencyGiven: "USD" } });
    assert(near(await balanceOf(accUsd.id), bU), "balance changed");
  });
  await check("14. the same request id is saved only once", async () => {
    const before = (await api("/api/transactions", { token: admin })).json.transactions.length;
    const key = crypto.randomBytes(8).toString("hex");
    const body = { clientName: "Walk-in", amountGiven: 7, currencyGiven: "USD" };
    await Promise.all([1, 2, 3].map(() => api("/api/transactions", { method: "POST", token: admin, body, headers: { "Idempotency-Key": key } })));
    const after = (await api("/api/transactions", { token: admin })).json.transactions.length;
    assert(after - before === 1, `saved ${after - before} times`);
  });
  await check("12-13. missing or invalid amount is refused by the server", async () => {
    for (const amountGiven of [0, -5, "abc", undefined]) {
      const r = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven, currencyGiven: "USD" } });
      assert(r.status === 400, `amount ${amountGiven} -> ${r.status}`);
    }
  });
  await check("17. a viewer cannot record an exchange or manage rates", async () => {
    const viewer = await login("sahra.ismail");
    const r = await api("/api/transactions", { method: "POST", token: viewer, body: { clientName: "Walk-in", amountGiven: 5, currencyGiven: "USD" } });
    assert(r.status === 403, `create -> ${r.status}`);
    const r2 = await api("/api/rate-history", { method: "POST", token: viewer, body: { dailyRate: 1, saleRate: 1 } });
    assert(r2.status === 403, `rates -> ${r2.status}`);
  });
  await check("21. the new exchange shows first in the list and in Transaction History", async () => {
    const list = (await api("/api/transactions", { token: admin })).json.transactions;
    assert(list[0].amountGiven === 7, `first is ${list[0].amountGiven}`);
  });
}

async function browserChecks() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  const open = async (viewport, lang) => {
    const c = await browser.newContext({ viewport });
    if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
    const ham = p.locator('button[aria-label*="enu"]:visible');
    if (viewport.width < 800 && await ham.count()) { await ham.first().click(); await p.waitForTimeout(400); }
    await p.getByText(lang === "so" ? "Sarrifka Lacagta" : "Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1000);
    await p.getByRole("button", { name: lang === "so" ? /Macaamil cusub/ : /New transaction/ }).first().click();
    await p.waitForSelector("#qx-amount", { timeout: 10000 });
    return { c, p };
  };
  const text = (p, label) => p.locator(`text=${label}`).first().locator("..").innerText();
  try {
    {
      const { c, p } = await open({ width: 1366, height: 1000 });
      await check("record is disabled until an amount is entered", async () => {
        assert(await p.locator('button:has-text("Record Exchange")').isDisabled(), "enabled with no amount");
      });
      await check("5-6. You Will Receive and the Summary agree, in both directions", async () => {
        await p.fill("#qx-amount", "100"); await p.waitForTimeout(200);
        assert(/SLSH 875,000/.test(await text(p, "You Will Receive")), await text(p, "You Will Receive"));
        assert(/SLSH 875,000/.test(await text(p, "Exchange Summary")), "summary differs");
        assert(/\$1\.16/.test(await text(p, "Estimated Profit")), await text(p, "Estimated Profit"));
        await p.click('button[aria-label="Reverse exchange direction"]'); await p.waitForTimeout(200);
        assert((await p.inputValue("#qx-amount")) === "", "amount left over after switching direction");
        await p.fill("#qx-amount", "1750000"); await p.waitForTimeout(200);
        assert(/\$200\.00/.test(await text(p, "You Will Receive")) && /\$200\.00/.test(await text(p, "Exchange Summary")), await text(p, "Exchange Summary"));
      });
      await check("Additional Details expand and collapse", async () => {
        await p.click('button[aria-controls="qx-details"]');
        assert(await p.locator("#qx-date").isVisible(), "not expanded");
        await p.click('button[aria-controls="qx-details"]');
        assert(!(await p.locator("#qx-date").count()), "not collapsed");
      });
      await check("16. Record Exchange saves exactly one real transaction, even on rapid clicks", async () => {
        const before = (await api("/api/transactions", { token: admin })).json.transactions.length;
        await p.locator('button:has-text("Record Exchange")').evaluate((el) => { el.click(); el.click(); el.click(); });
        await p.waitForTimeout(2500);
        const list = (await api("/api/transactions", { token: admin })).json.transactions;
        assert(list.length - before === 1, `saved ${list.length - before}`);
        assert(list[0].currencyGiven === "SLSH" && list[0].amountGiven === 1750000 && near(list[0].amountReceived, 200), JSON.stringify(list[0]));
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 1000 });
      await check("15. a failed save keeps what was typed", async () => {
        await p.route("**/api/transactions", (r) => r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated failure" }) }) : r.continue());
        await p.fill("#qx-amount", "321");
        await p.click('button:has-text("Record Exchange")'); await p.waitForTimeout(1200);
        assert((await p.inputValue("#qx-amount")) === "321", "amount lost");
        assert(!(await p.locator('button:has-text("Record Exchange")').isDisabled()), "button stuck disabled");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 1366, height: 1000 }, "so");
      await check("19. Somali: the Quick Exchange page is fully translated", async () => {
        await p.fill("#qx-amount", "100"); await p.click('button[aria-controls="qx-details"]'); await p.waitForTimeout(300);
        const t = await p.locator(".gk-qx").innerText();
        assert(/Sarrif Degdeg ah/.test(t) && /Waxaad Helaysaa/.test(t) && /Faa'iidada la Qiyaasay/.test(t), t.slice(0, 200));
        const missing = await p.evaluate(() => [...window.__i18n.missing]);
        const ours = missing.filter((s) => !/^Walk-In$/.test(s) && /Quick Exchange|Walk-in|Account|Direction|Amount|Rate|Receive|Profit|Summary|Details|Currency|override|Customer/i.test(s));
        assert(!ours.length, `untranslated: ${ours.slice(0, 6).join(" | ")}`);
      });
      await c.close();
    }
    for (const [w, h] of [[900, 1000], [390, 844]]) {
      const { c, p } = await open({ width: w, height: h });
      await check(`20. ${w}px wide: no sideways scrolling`, async () => {
        await p.fill("#qx-amount", "100");
        assert(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "page scrolls sideways");
      });
      await c.close();
    }
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  console.log("Seeding a scratch installation...");
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
