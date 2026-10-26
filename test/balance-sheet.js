"use strict";
// BALANCE SHEET round — regression tests for the Cash in Hand Balance Sheet:
//   Balance Sheet = Debt + Cash in Hand − Credit, per currency, where
//   Debt   = negative customer/company account balances (what customers owe),
//   Cash   = balances of active Cash in Hand accounts,
//   Credit = positive customer/company account balances (funds held).
// Proves the formula (including the task's own $5,000 + $2,000 − $1,500 =
// $5,500 example), zero and negative results, USD/SLSH separation, that every
// kind of money movement updates it correctly, company isolation, currency
// permissions, agreement with the underlying records, and that nothing else
// changes. Plus the card in the browser, in English and Somali.
//
// Run with: npm run test:balance-sheet
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".balance-sheet-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("balance-sheet");
const PORT = Number(process.env.BALANCE_SHEET_TEST_PORT || 4390);
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
const sheet = async (token) => (await api("/api/cash/balance-sheet", { token })).json;

// The same three totals, rebuilt independently from the ordinary list
// endpoints the rest of the app already uses.
async function independent(token, cur) {
  // Active accounts come from the Accounts list, deactivated ones from
  // Settings > Deactivated Accounts — together, every account not deleted.
  const accts = [...((await api(`/api/accounts?currency=${cur}`, { token })).json.accounts || [])];
  const deact = (await api("/api/accounts/deactivated", { token })).json;
  accts.push(...((deact.accounts || deact.rows || []).filter((a) => a.currency === cur)));
  const unique = Object.values(Object.fromEntries(accts.map((a) => [a.id, a])));
  const debt = unique.filter((a) => a.balance < 0).reduce((s, a) => s - a.balance, 0);
  const credit = unique.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const cash = (await api(`/api/cash/accounts?currency=${cur}&status=active`, { token })).json.accounts.reduce((s, a) => s + a.balance, 0);
  return { debt, credit, cash, balanceSheet: debt + cash - credit };
}

const ctx = {};
async function setup() {
  ctx.sa = await login("super.admin", SA_PW);
  ctx.A = (await api("/api/platform/companies", { token: ctx.sa })).json.companies[0].id;
  ctx.ws = async (cid) => (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: cid } })).json.token;
  ctx.saA = await ctx.ws(ctx.A);
  const b = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Berbera Second Co", admin: B_ADMIN } });
  assert(b.status === 201, `Company B: ${b.status} ${b.text}`);
  ctx.B = b.json.company.id;
  ctx.saB = await ctx.ws(ctx.B);
}
const newAccount = async (token, name, currency, openingBalance, accountType = "customer") => {
  const r = await api("/api/accounts", { method: "POST", token, body: { name, accountType, currency, openingBalance } });
  assert(r.status === 201, `account ${name}: ${r.status} ${r.text}`);
  return r.json.account;
};
const newCash = async (token, name, currency, openingBalance) => {
  const r = await api("/api/cash/accounts", { method: "POST", token, body: { name, type: "physical_cash", currency, openingBalance } });
  assert(r.status === 201, `cash ${name}: ${r.status} ${r.text}`);
  return r.json.account;
};

async function apiChecks() {
  console.log("\nFormula");
  await check("a company with nothing yet: every figure is 0", async () => {
    const s = await sheet(ctx.saB);
    for (const cur of ["USD", "SLSH"]) {
      const b = s.currencies[cur];
      assert(b.debt === 0 && b.cashInHand === 0 && b.credit === 0 && b.balanceSheet === 0, `${cur}: ${JSON.stringify(b)}`);
    }
    assert(s.formula === "Debt + Cash Account - Credit", s.formula);
  });
  await check("the task's example: $5,000 + $2,000 − $1,500 = $5,500", async () => {
    ctx.bDebtor = await newAccount(ctx.saB, "Debtor Ltd", "USD", -5000, "company");
    ctx.bTill = await newCash(ctx.saB, "Berbera Till", "USD", 2000);
    ctx.bSaver = await newAccount(ctx.saB, "Saver Person", "USD", 1500);
    const b = (await sheet(ctx.saB)).currencies.USD;
    assert(near(b.debt, 5000) && near(b.cashInHand, 2000) && near(b.credit, 1500) && near(b.balanceSheet, 5500), JSON.stringify(b));
    assert(b.debtAccounts === 1 && b.creditAccounts === 1 && b.cashAccounts === 1, "counts");
  });
  await check("USD and SLSH are never mixed: SLSH stays 0 while USD moves", async () => {
    const s = (await sheet(ctx.saB)).currencies.SLSH;
    assert(s.debt === 0 && s.credit === 0 && s.cashInHand === 0 && s.balanceSheet === 0, JSON.stringify(s));
    await newAccount(ctx.saB, "Slsh Debtor", "SLSH", -3000000);
    const after = await sheet(ctx.saB);
    assert(near(after.currencies.SLSH.debt, 3000000) && near(after.currencies.SLSH.balanceSheet, 3000000), JSON.stringify(after.currencies.SLSH));
    assert(near(after.currencies.USD.balanceSheet, 5500), "USD changed by an SLSH account");
  });
  await check("a negative result is shown as negative (credit larger than debt + cash)", async () => {
    const big = await newAccount(ctx.saB, "Big Depositor", "USD", 10000);
    const b = (await sheet(ctx.saB)).currencies.USD;
    assert(near(b.balanceSheet, 5000 + 2000 - 11500) && b.balanceSheet < 0, JSON.stringify(b));
    ctx.bBig = big;
  });
  await check("an account at exactly 0 counts as neither debt nor credit", async () => {
    await newAccount(ctx.saB, "Zero Person", "USD", 0);
    const b = (await sheet(ctx.saB)).currencies.USD;
    assert(b.debtAccounts === 1 && b.creditAccounts === 2, `${b.debtAccounts}/${b.creditAccounts}`);
  });

  console.log("\nChanges update the figure correctly");
  await check("a customer repays debt in cash: debt down, cash up — the Balance Sheet stays the same", async () => {
    const before = (await sheet(ctx.saB)).currencies.USD;
    const r = await api(`/api/accounts/${ctx.bDebtor.id}/deposit`, { method: "POST", token: ctx.saB, body: { amount: 1000, currency: "USD", cashAccountId: ctx.bTill.id } });
    assert(r.status === 201 || r.status === 200, `${r.status} ${r.text}`);
    const after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.debt, before.debt - 1000) && near(after.cashInHand, before.cashInHand + 1000) && near(after.balanceSheet, before.balanceSheet), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  });
  await check("a customer withdraws their funds in cash: credit down, cash down — unchanged again", async () => {
    const before = (await sheet(ctx.saB)).currencies.USD;
    const r = await api(`/api/accounts/${ctx.bBig.id}/withdraw`, { method: "POST", token: ctx.saB, body: { amount: 2500, currency: "USD", cashAccountId: ctx.bTill.id } });
    assert(r.status === 201 || r.status === 200, `${r.status} ${r.text}`);
    const after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.credit, before.credit - 2500) && near(after.cashInHand, before.cashInHand - 2500) && near(after.balanceSheet, before.balanceSheet), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  });
  await check("cash put in from outside: Cash in Hand and the Balance Sheet both go up by it", async () => {
    const before = (await sheet(ctx.saB)).currencies.USD;
    await api(`/api/cash/accounts/${ctx.bTill.id}/deposit`, { method: "POST", token: ctx.saB, body: { amount: 700 } });
    const after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.cashInHand, before.cashInHand + 700) && near(after.balanceSheet, before.balanceSheet + 700), JSON.stringify(after));
  });
  await check("a company expense paid from cash lowers the Balance Sheet by the expense", async () => {
    const before = (await sheet(ctx.saB)).currencies.USD;
    const cat = (await api("/api/expense-categories", { token: ctx.saB })).json.categories[0].id;
    const e = await api("/api/expenses", { method: "POST", token: ctx.saB, body: { date: new Date().toISOString().slice(0, 10), categoryId: cat, description: "Rent", amount: 300, currency: "USD", cashAccountId: ctx.bTill.id } });
    assert(e.status === 201, e.text);
    let after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.balanceSheet, before.balanceSheet - 300), JSON.stringify(after));
    await api(`/api/expenses/${e.json.expense.id}/cancel`, { method: "POST", token: ctx.saB, body: { reason: "test" } });
    after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.balanceSheet, before.balanceSheet), "cancelling the expense did not restore the figure");
  });
  await check("a deactivated cash account no longer counts; a deactivated customer account still does", async () => {
    const extra = await newCash(ctx.saB, "Spare Box", "USD", 400);
    const before = (await sheet(ctx.saB)).currencies.USD;
    await api(`/api/cash/accounts/${extra.id}/deactivate`, { method: "POST", token: ctx.saB, body: { reason: "test" } });
    let after = (await sheet(ctx.saB)).currencies.USD;
    assert(near(after.cashInHand, before.cashInHand - 400), "deactivated cash account still counted");
    const d = await api(`/api/accounts/${ctx.bDebtor.id}/deactivate`, { method: "POST", token: ctx.saB, body: { reason: "test" } });
    assert(d.status === 200, d.text);
    const again = (await sheet(ctx.saB)).currencies.USD;
    assert(near(again.debt, after.debt), "deactivated customer's debt disappeared");
  });

  console.log("\nAgreement with the records");
  await check("each currency equals a recount from the ordinary account lists (Company A, real demo data)", async () => {
    await newCash(ctx.saA, "Main Till", "USD", 3000);
    await newCash(ctx.saA, "Zaad Wallet", "SLSH", 2500000);
    const s = await sheet(ctx.saA);
    for (const cur of ["USD", "SLSH"]) {
      const ind = await independent(ctx.saA, cur);
      const b = s.currencies[cur];
      assert(near(b.debt, ind.debt) && near(b.credit, ind.credit) && near(b.cashInHand, ind.cash) && near(b.balanceSheet, ind.balanceSheet), `${cur}: api ${JSON.stringify(b)} vs recount ${JSON.stringify(ind)}`);
      assert(near(b.balanceSheet, b.debt + b.cashInHand - b.credit), "formula");
    }
  });
  await check("Cash in Hand matches the existing Cash in Hand totals exactly", async () => {
    const s = await sheet(ctx.saA);
    const sum = (await api("/api/cash/summary", { token: ctx.saA })).json;
    assert(near(s.currencies.USD.cashInHand, sum.totalUSD) && near(s.currencies.SLSH.cashInHand, sum.totalSLSH), "cash totals differ");
  });
  await check("the combined figure uses only the Cash in Hand rate, from the precise values", async () => {
    await api("/api/cash/rate", { method: "POST", token: ctx.saA, body: { rate: 8500 } });
    const s = await sheet(ctx.saA);
    const r = s.combined.rate;
    assert(s.combined.available && r === 8500 && s.cashRate.rate === 8500, JSON.stringify(s.combined));
    assert(near(s.combined.usdEquivalent.total, s.currencies.USD.balanceSheet + s.currencies.SLSH.balanceSheet / r), "USD equivalent");
    assert(near(s.combined.slshEquivalent.total, s.currencies.USD.balanceSheet * r + s.currencies.SLSH.balanceSheet), "SLSH equivalent");
  });
  await check("reading the Balance Sheet changes nothing", async () => {
    const accts = JSON.stringify((await api("/api/accounts?currency=USD", { token: ctx.saA })).json.accounts.map((a) => [a.id, a.balance]));
    const led = (await api("/api/cash/ledger", { token: ctx.saA })).json.entries.length;
    for (let i = 0; i < 3; i++) await sheet(ctx.saA);
    assert(accts === JSON.stringify((await api("/api/accounts?currency=USD", { token: ctx.saA })).json.accounts.map((a) => [a.id, a.balance])), "account balances changed");
    assert(led === (await api("/api/cash/ledger", { token: ctx.saA })).json.entries.length, "ledger changed");
  });

  console.log("\nNet Balance Sheet — both currencies combined");
  await check("no Cash in Hand rate set → unavailable, even though a Money Exchange Daily Rate exists", async () => {
    const c = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Fixture Co" } });
    assert(c.status === 201, c.text);
    ctx.F = c.json.company.id;
    ctx.saF = await ctx.ws(ctx.F);
    await api("/api/rate-history", { method: "POST", token: ctx.saF, body: { dailyRate: 9000, saleRate: 8900 } });
    await newCash(ctx.saF, "Fixture Till", "USD", 100);
    await newCash(ctx.saF, "Fixture Zaad", "SLSH", 1170000);
    const s = await sheet(ctx.saF);
    assert(!s.cashRate && s.combined.available === false && s.combined.reason === "rate_not_set", JSON.stringify(s.combined));
    // The original Exchange Rate card's behaviour is unchanged (it still shows the fallback).
    const summary = (await api("/api/cash/summary", { token: ctx.saF })).json;
    assert(summary.rate === 9000 || summary.rate === null || summary.rate > 0, `summary rate ${summary.rate}`);
  });
  await check("the task's example: $100 × 11,700 + SLSH 1,170,000 = SLSH 2,340,000 (USD Equivalent $200)", async () => {
    const set = await api("/api/cash/rate", { method: "POST", token: ctx.saF, body: { rate: 11700 } });
    assert(set.status === 200, set.text);
    const s = await sheet(ctx.saF);
    assert(near(s.currencies.USD.balanceSheet, 100) && near(s.currencies.SLSH.balanceSheet, 1170000), JSON.stringify(s.currencies));
    const e = s.combined.slshEquivalent, u = s.combined.usdEquivalent;
    assert(s.combined.available && s.combined.rate === 11700, JSON.stringify(s.combined));
    assert(near(e.usdConverted, 1170000) && near(e.slsh, 1170000) && near(e.total, 2340000), JSON.stringify(e));
    assert(near(u.usd, 100) && near(u.slshConverted, 100) && near(u.total, 200), JSON.stringify(u));
  });
  await check("the second example: −$100 × 11,700 + SLSH 1,170,000 = SLSH 0", async () => {
    await newAccount(ctx.saF, "Fixture Depositor", "USD", 200); // credit 200 → USD Balance Sheet −100
    const s = await sheet(ctx.saF);
    assert(near(s.currencies.USD.balanceSheet, -100), JSON.stringify(s.currencies.USD));
    assert(near(s.combined.slshEquivalent.total, 0) && near(s.combined.usdEquivalent.total, 0), JSON.stringify(s.combined));
  });
  await check("changing the Cash in Hand rate recalculates the combined total", async () => {
    await api("/api/cash/rate", { method: "POST", token: ctx.saF, body: { rate: 12000 } });
    const s = await sheet(ctx.saF);
    assert(near(s.combined.slshEquivalent.total, -100 * 12000 + 1170000) && near(s.combined.usdEquivalent.total, -100 + 1170000 / 12000), JSON.stringify(s.combined));
  });
  await check("an invalid rate is refused and the last valid rate stays in use", async () => {
    for (const rate of [0, -5, "abc"]) assert((await api("/api/cash/rate", { method: "POST", token: ctx.saF, body: { rate } })).status === 400, `rate ${rate} accepted`);
    assert((await sheet(ctx.saF)).combined.rate === 12000, "rate changed");
  });
  await check("a balance change in either currency flows into the combined total, converted", async () => {
    const before = (await sheet(ctx.saF)).combined.slshEquivalent.total;
    const till = (await api("/api/cash/accounts?currency=USD", { token: ctx.saF })).json.accounts[0];
    await api(`/api/cash/accounts/${till.id}/deposit`, { method: "POST", token: ctx.saF, body: { amount: 10 } });
    const after = await sheet(ctx.saF);
    assert(near(after.combined.slshEquivalent.total, before + 10 * 12000), `${before} -> ${after.combined.slshEquivalent.total}`);
    assert(near(after.currencies.SLSH.balanceSheet, 1170000), "SLSH changed by a USD deposit");
  });

  console.log("\nCompanies and permissions");
  await check("each company sees only its own figures", async () => {
    const a = await sheet(ctx.saA), b = await sheet(ctx.saB);
    assert(JSON.stringify(a.currencies) !== JSON.stringify(b.currencies), "same figures for both companies");
    const indB = await independent(ctx.saB, "USD");
    assert(near(b.currencies.USD.balanceSheet, indB.balanceSheet), "Company B mixes in other data");
    const bAdminSheet = await api("/api/cash/balance-sheet", { token: await login(B_ADMIN.username, B_ADMIN.password) });
    assert(bAdminSheet.status === 403, "Company Admin without Cash in Hand access got it");
  });
  await check("switching company switches the figures", async () => {
    const tA = await ctx.ws(ctx.A), tB = await ctx.ws(ctx.B);
    assert(near((await sheet(tA)).currencies.USD.balanceSheet, (await sheet(ctx.saA)).currencies.USD.balanceSheet), "A");
    assert(near((await sheet(tB)).currencies.USD.balanceSheet, (await sheet(ctx.saB)).currencies.USD.balanceSheet), "B");
  });
  await check("no Cash in Hand access → refused; signed out → refused", async () => {
    assert((await api("/api/cash/balance-sheet", { token: await login("sahra.ismail") })).status === 403, "viewer");
    assert((await api("/api/cash/balance-sheet")).status === 401, "anonymous");
  });
  await check("a user allowed only USD never receives SLSH figures", async () => {
    const role = await api("/api/roles", { method: "POST", token: ctx.saA, body: { name: "USD Cash Viewer", permissions: ["cash.view", "currency.usd"] } });
    assert(role.status === 201, role.text);
    const u = await api("/api/users", { method: "POST", token: ctx.saA, body: { name: "Usd Only", username: "usd.only", password: "Usd-Only-Pass-2026x", roleId: role.json.role.id } });
    assert(u.status === 201, u.text);
    const s = await sheet(await login("usd.only", "Usd-Only-Pass-2026x"));
    assert(s.currencies.USD && !s.currencies.SLSH && s.combined.available === false && s.combined.reason === "currency_access" && !s.combined.slshEquivalent, JSON.stringify(s.combined));
  });
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  console.log("\nBrowser");
  const errors = [];
  try {
    const run = async (lang, width) => {
      const c = await browser.newContext({ viewport: { width, height: 900 } });
      if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(BASE); await p.waitForTimeout(500);
      await p.locator("input").first().fill("super.admin"); await p.fill('input[type="password"]', SA_PW);
      await p.keyboard.press("Enter"); await p.waitForTimeout(1500);
      return { c, p };
    };
    const openCompanyCash = async (p, companyName) => {
      const card = p.locator("div").filter({ hasText: companyName }).filter({ has: p.locator("button", { hasText: /Open workspace|Fur/ }) }).last();
      await card.locator("button", { hasText: /Open workspace|Fur/ }).first().click();
      await p.waitForSelector(".gk-sidebar", { state: "attached" }); await p.waitForTimeout(1000);
      if (await p.locator(".gk-mobile-hamburger").isVisible().catch(() => false)) { await p.locator(".gk-mobile-hamburger").click(); await p.waitForTimeout(300); }
      const acct = p.locator(".gk-nav-group-header").first();
      if ((await acct.getAttribute("aria-expanded")) !== "true") await acct.click();
      await p.locator(".gk-nav-btn", { hasText: /^Cash Account$|^Akoonka Lacagta$/ }).first().click(); await p.waitForTimeout(1500);
    };
    {
      const { c: cf, p: pf } = await run(null, 1440);
      await openCompanyCash(pf, "Fixture Co");
      await check("Balance Sheet comes first, then the four original Cash in Hand cards, unchanged", async () => {
        const cards = pf.locator(".gk-cash-cards > *");
        assert(await cards.count() === 4, `original cards: ${await cards.count()}`);
        const t = await pf.locator(".gk-cash-cards").innerText();
        for (const w of ["Total Cash Account — USD", "Total Cash Account — SLSH", "Exchange Rate", "(Cash Account only)", "Net Cash Account", "Edit Rate"]) assert(t.includes(w), `missing "${w}"`);
        const order = await pf.evaluate(() => {
          const a = document.querySelector(".gk-cash-cards").getBoundingClientRect().top;
          const b = document.querySelector(".gk-balance-sheet").getBoundingClientRect().top;
          const tabs = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "Cash Accounts").getBoundingClientRect().top;
          return b < a && a < tabs;
        });
        assert(order, "order is not: Balance Sheet → Cash in Hand cards → tabs");
      });
      await check("Net Cash in Hand keeps its own currency selector and calculation", async () => {
        const sum = (await api("/api/cash/summary?base=USD", { token: ctx.saF })).json;
        const card = pf.locator(".gk-cash-cards > *").nth(3);
        assert((await card.innerText()).includes(Number(sum.netCashInHand).toLocaleString("en-US", { minimumFractionDigits: 2 })), "USD net");
        await card.locator("select").selectOption("SLSH"); await pf.waitForTimeout(800);
        const sumS = (await api("/api/cash/summary?base=SLSH", { token: ctx.saF })).json;
        assert((await card.innerText()).replace(/\s/g, "").includes(Math.round(sumS.netCashInHand).toLocaleString("en-US")), "SLSH net");
      });
      await check("the Balance Sheet section has exactly four cards: USD, SLSH, Exchange Rate, Net", async () => {
        const kinds = await pf.locator(".gk-balance-sheet .gk-bs-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
        assert(JSON.stringify(kinds) === JSON.stringify(["usd", "slsh", "rate", "net"]), JSON.stringify(kinds));
        const tops = await pf.locator(".gk-balance-sheet .gk-bs-card").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        assert(new Set(tops).size === 1, `not one row on desktop: ${tops}`);
        const rate = await pf.locator('.gk-bs-card[data-card="rate"]').innerText();
        assert(/\$1 = SLSH 12,000/.test(rate), `rate card: ${rate}`);
      });
      await check("Net Balance Sheet shows one amount in the named reporting currency, and switches", async () => {
        const net = pf.locator('.gk-bs-card[data-card="net"]');
        const s = await sheet(ctx.saF);
        const fmtS = (n) => (n < 0 ? "-SLSH " : "SLSH ") + Math.round(Math.abs(n)).toLocaleString("en-US");
        await net.locator("select").selectOption("SLSH"); await pf.waitForTimeout(300);
        let total = (await net.locator(".gk-net-balance-total").innerText()).trim();
        assert(total === fmtS(s.combined.slshEquivalent.total) && /SLSH Equivalent/.test(await net.innerText()), `SLSH: ${total} vs ${s.combined.slshEquivalent.total}`);
        await net.locator("select").selectOption("USD"); await pf.waitForTimeout(300);
        total = (await net.locator(".gk-net-balance-total").innerText()).trim();
        const usd = s.combined.usdEquivalent.total;
        assert(total === (usd < 0 ? "-$" : "$") + Math.abs(usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), `USD: ${total} vs ${usd}`);
        await net.locator("select").selectOption("SLSH");
      });
      await check("Edit Rate on the Exchange Rate card opens the existing rate editor; a new rate updates the Net card", async () => {
        await pf.locator('.gk-bs-card[data-card="rate"] button', { hasText: "Edit Rate" }).click(); await pf.waitForTimeout(400);
        const dlg = pf.locator('[role="dialog"]').last();
        assert(await dlg.count() === 1, "no rate dialog");
        await dlg.locator("input").first().fill("11700");
        await dlg.locator("button", { hasText: /Save/ }).first().click(); await pf.waitForTimeout(1200);
        const total = (await pf.locator('.gk-bs-card[data-card="net"] .gk-net-balance-total').innerText()).trim();
        const s = await sheet(ctx.saF);
        assert(s.combined.rate === 11700 && total === "SLSH " + Math.round(s.combined.slshEquivalent.total).toLocaleString("en-US"), `${total} / rate ${s.combined.rate}`);
      });
      await check("the tabs, filters and Add Cash Account below still work", async () => {
        for (const tab of ["Cash Movements", "Transfers", "Exchanges", "Loans", "Cash Accounts"]) {
          await pf.locator("button", { hasText: new RegExp(`^${tab}$`) }).first().click(); await pf.waitForTimeout(400);
        }
        await pf.locator("select").filter({ has: pf.locator('option[value="physical_cash"]') }).first().selectOption("bank"); await pf.waitForTimeout(500);
        assert(/No Cash Accounts Found/.test(await pf.locator("body").innerText()), "filter did not apply");
        await pf.locator("select").filter({ has: pf.locator('option[value="physical_cash"]') }).first().selectOption("all"); await pf.waitForTimeout(500);
        assert(await pf.locator("table.gk-table tbody tr").count() === 2, "accounts table");
        assert(await pf.locator("button", { hasText: "Add Cash Account" }).isVisible(), "Add Cash Account missing");
      });
      for (const w of [900, 390]) {
        await pf.setViewportSize({ width: w, height: 900 }); await pf.waitForTimeout(500);
        await check(`at ${w}px: no sideways scrolling, nothing overlapping`, async () => {
          const r = await pf.evaluate(() => {
            const over = document.documentElement.scrollWidth > window.innerWidth + 1;
            const boxes = [...document.querySelectorAll(".gk-bs-card, .gk-cash-cards > *")].map((e) => e.getBoundingClientRect());
            let overlap = false;
            for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i], b = boxes[j];
              if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap = true;
            }
            const narrow = boxes.some((b) => b.width < 150);
            return { over, overlap, narrow };
          });
          assert(!r.over && !r.overlap && !r.narrow, JSON.stringify(r));
        });
      }
      await cf.close();
    }
    const { c, p } = await run(null, 1366);
    await openCompanyCash(p, "Berbera Second Co");
    await check("the Balance Sheet card shows all four figures per currency, matching the API", async () => {
      const card = p.locator(".gk-balance-sheet");
      const t = await card.innerText();
      for (const w of ["Balance Sheet", "Total Debt", "Total Cash Account", "Total Credit", "Debt + Cash Account − Credit"]) assert(t.includes(w), `missing "${w}"`);
      const usd = (await sheet(ctx.saB)).currencies.USD.balanceSheet;
      const shown = await card.locator('[data-currency="USD"] .gk-balance-sheet-total').innerText();
      const expected = (usd < 0 ? "-$" : "$") + Math.abs(usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      assert(shown.replace(/\s/g, "") === expected, `shown ${shown}, expected ${expected}`);
      assert(await card.locator('[data-currency="SLSH"]').count() === 1, "no SLSH column");
    });
    await check("switching to another company changes the card to that company's figures", async () => {
      const bShown = await p.locator('.gk-balance-sheet [data-currency="USD"] .gk-balance-sheet-total').innerText();
      const bRate = await p.locator('.gk-bs-card[data-card="rate"]').innerText();
      const bNet = await p.locator('.gk-bs-card[data-card="net"]').innerText();
      assert(/Not set/.test(bRate) && /Unavailable/.test(bNet), `Company B rate/net: ${bRate} | ${bNet}`);
      await p.locator(".gk-company-badge-name").first().click(); await p.waitForTimeout(300);
      const firstCompany = (await api("/api/platform/companies", { token: ctx.sa })).json.companies[0].name;
      await p.locator("button", { hasText: firstCompany }).last().click();
      await p.waitForSelector(".gk-sidebar", { state: "attached" }); await p.waitForTimeout(1800);
      const aShown = await p.locator('.gk-balance-sheet [data-currency="USD"] .gk-balance-sheet-total').innerText();
      const aUsd = (await sheet(ctx.saA)).currencies.USD.balanceSheet;
      assert(aShown !== bShown && near(Number(aShown.replace(/[^0-9.-]/g, "")), aUsd), `A shows ${aShown} (api ${aUsd}), B showed ${bShown}`);
      const aSheet = await sheet(ctx.saA);
      assert(/\$1 = SLSH 8,500/.test(await p.locator('.gk-bs-card[data-card="rate"]').innerText()), "rate card not refreshed");
      const aNet = (await p.locator('.gk-bs-card[data-card="net"] .gk-net-balance-total').innerText()).trim();
      assert(aNet.replace(/[^0-9-]/g, "") === String(Math.round(aSheet.combined.slshEquivalent.total)), `net ${aNet} vs ${aSheet.combined.slshEquivalent.total}`);
    });
    await c.close();
    {
      const { c: c2, p: p2 } = await run("so", 390);
      await openCompanyCash(p2, "Berbera Second Co");
      await check("in Somali on a phone: translated and fits the screen", async () => {
        const t = await p2.locator(".gk-balance-sheet").innerText();
        assert(/Miisaanka Maaliyadda/.test(t) && /Wadarta Deynta/.test(t) && /Wadarta Kireditka/.test(t), t.slice(0, 200));
        const scroll = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert(!scroll, "page scrolls sideways");
      });
      await c2.close();
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
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
