"use strict";
// ACCOUNT VIEW PRO round — the redesigned View Account page.
//   API:   the account's activity feed is its COMPLETE history (no more
//          "latest 50" cut-off), and its credit/debit totals equal the
//          ledger's own all-time totals.
//   Page:  header (name, number, type, currency, status, actions), the five
//          summary cards, Credit / Debit / Balance columns in that order,
//          the totals row over ALL pages, search + type + date filters
//          moving the cards and totals together, Compare: Credits & Debits,
//          export, Balances Over Time, permissions (a viewer gets no
//          actions), phone layout without sideways scrolling, USD and SLSH
//          never mixed.
// Run with: npm run test:account-view
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("acctview");
const PORT = Number(process.env.ACCOUNT_VIEW_TEST_PORT || 4490);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message.split("\n")[0]}`); console.log(`FAILED\n      ${e.message.split("\n")[0]}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}
const login = async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PW } })).json.token;
const money = (v) => Number(String(v).replace(/[^0-9.-]/g, ""));

const ctx = {};
async function setup() {
  ctx.admin = await login("amina.yusuf");
  const mk = async (name, currency) => {
    const r = await api("/api/accounts", { method: "POST", token: ctx.admin, body: { name, accountType: "customer", currency } });
    assert(r.status === 201, `${name}: ${r.status} ${r.text}`);
    return r.json.account;
  };
  ctx.acct = await mk("Hodan Warsame Ledger", "USD");
  ctx.other = await mk("Ayan Transfer Partner", "USD");
  ctx.slsh = await mk("Hodan Warsame Shilling", "SLSH");
  // 60 credits of 10 + one credit 1000, two debits (250, 75.5) and one
  // transfer out of 100 — more than the old 50-row cut-off.
  for (let i = 0; i < 60; i++) {
    const r = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.admin, body: { amount: 10, currency: "USD", notes: `Small credit ${i + 1}` } });
    assert(r.status === 201 || r.status === 200, `deposit ${i}: ${r.status} ${r.text}`);
  }
  await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.admin, body: { amount: 1000, currency: "USD", notes: "Big customer payment" } });
  await api(`/api/accounts/${ctx.acct.id}/withdraw`, { method: "POST", token: ctx.admin, body: { amount: 250, currency: "USD", notes: "Rent payout" } });
  await api(`/api/accounts/${ctx.acct.id}/withdraw`, { method: "POST", token: ctx.admin, body: { amount: 75.5, currency: "USD", notes: "Fee payout" } });
  const t = await api("/api/transfers", { method: "POST", token: ctx.admin, body: { fromAccountId: ctx.acct.id, toAccountId: ctx.other.id, amount: 100, currency: "USD", notes: "Move to partner" } });
  assert(t.status === 201 || t.status === 200, `transfer: ${t.status} ${t.text}`);
  await api(`/api/accounts/${ctx.slsh.id}/deposit`, { method: "POST", token: ctx.admin, body: { amount: 500000, currency: "SLSH", notes: "Shilling credit" } });
  // expected: credits 600 + 1000 = 1600; debits 250 + 75.5 + 100 = 425.5
  ctx.expect = { credit: 1600, debit: 425.5, balance: 1174.5, count: 64 };
}

async function apiChecks() {
  console.log("\nData");
  await check("the activity feed holds the whole history (64 entries, not the old 50) and says it is complete", async () => {
    const d = (await api(`/api/accounts/${ctx.acct.id}`, { token: ctx.admin })).json;
    assert(d.activity.length === ctx.expect.count, `activity rows: ${d.activity.length}`);
    assert(d.activityComplete === true, "activityComplete");
    assert(near(d.account.balance, ctx.expect.balance), `balance ${d.account.balance}`);
  });
  await check("credits/debits derived from the feed equal the ledger's own all-time totals", async () => {
    const d = (await api(`/api/accounts/${ctx.acct.id}`, { token: ctx.admin })).json;
    let credit = 0, debit = 0;
    for (const r of d.activity) {
      credit += r.kind === "deposit" ? r.amount : r.ledgerType === "deposit" ? r.ledgerAmount : 0;
      debit += r.kind === "withdrawal" ? r.amount : r.ledgerType === "withdrawal" ? r.ledgerAmount : 0;
    }
    assert(near(credit, d.summary.totalDeposited) && near(debit, d.summary.totalWithdrawn), `${credit}/${debit} vs ${d.summary.totalDeposited}/${d.summary.totalWithdrawn}`);
    assert(near(credit, ctx.expect.credit) && near(debit, ctx.expect.debit), `${credit}/${debit}`);
  });
  await check("the newest row's balance-after is the current balance", async () => {
    const d = (await api(`/api/accounts/${ctx.acct.id}`, { token: ctx.admin })).json;
    assert(near(d.activity[0].balanceAfter, d.account.balance), `${d.activity[0].balanceAfter} vs ${d.account.balance}`);
  });
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped — Playwright not installed)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  const open = async (user, width) => {
    const c = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill(user); await p.fill('input[type="password"]', PW);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(700);
    return { c, p };
  };
  const openAccount = async (p, name) => {
    if (await p.locator(".gk-mobile-hamburger").isVisible().catch(() => false)) { await p.locator(".gk-mobile-hamburger").click(); await p.waitForTimeout(250); }
    const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*USD Accounts\s*$/ }).first();
    const group = p.locator(".gk-nav-group").filter({ has: btn }).first().locator(".gk-nav-group-header").first();
    if ((await group.getAttribute("aria-expanded")) === "false") { await group.click(); await p.waitForTimeout(300); }
    await btn.click(); await p.waitForTimeout(1000);
    await p.getByText(name, { exact: true }).first().click();
    await p.waitForSelector(".gk-av-name", { timeout: 8000 }); await p.waitForTimeout(600);
  };
  const cardValue = async (p, label) => p.locator(`.gk-av-card[aria-label="${label}"] .gk-av-card-value`).innerText();
  try {
    const { c, p } = await open("amina.yusuf", 1440);
    await openAccount(p, "Hodan Warsame Ledger");
    console.log("\nHeader and summary cards");
    await check("breadcrumb, name, account number, type, currency and status are shown", async () => {
      const crumbs = await p.locator(".gk-av-crumbs").innerText();
      assert(/Accounts/.test(crumbs) && /View Account/.test(crumbs), crumbs);
      assert((await p.locator("h1.gk-av-name").innerText()) === "Hodan Warsame Ledger", "name");
      const meta = await p.locator(".gk-av-meta").innerText();
      assert(meta.includes(ctx.acct.accountNumber) && /Customer Account/.test(meta) && /USD/.test(meta) && /Active/.test(meta), meta);
    });
    await check("Credit, Transfer and Edit are visible; the rest is in the ⋯ menu", async () => {
      for (const n of ["Credit", "Transfer", "Edit"]) assert(await p.locator(".gk-av-actions").getByRole("button", { name: n, exact: true }).count() === 1, n);
      await p.locator(".gk-av-actions").getByRole("button", { name: "More account actions" }).click();
      const items = await p.getByRole("menuitem").allInnerTexts();
      for (const n of ["Debit", "Compare: Credits & Debits", "Refresh", "Deactivate account"]) assert(items.some((t) => t.includes(n)), `menu lacks ${n}: ${items.join("|")}`);
      await p.keyboard.press("Escape");
    });
    await check("the five cards show the real all-time figures", async () => {
      assert(near(money(await cardValue(p, "Current Balance")), ctx.expect.balance), "balance");
      assert(near(money(await cardValue(p, "Total Credits")), ctx.expect.credit), "credits");
      assert(near(money(await cardValue(p, "Total Debits")), ctx.expect.debit), "debits");
      assert(near(money(await cardValue(p, "Net Change")), ctx.expect.credit - ctx.expect.debit), "net");
      assert((await cardValue(p, "Total Transactions")) === String(ctx.expect.count), "count");
    });
    await check("desktop: the five cards sit in one compact row (about 70–84px tall)", async () => {
      const boxes = await p.locator(".gk-av-card").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
      assert(boxes.length === 5, `cards: ${boxes.length}`);
      assert(new Set(boxes.map((b) => b[0])).size === 1, `not one row: ${JSON.stringify(boxes)}`);
      assert(boxes.every((b) => b[1] >= 68 && b[1] <= 84), `heights: ${boxes.map((b) => b[1]).join(",")}`);
    });

    console.log("\nCredits & Debits table");
    await check("columns run # · Date · Reference · Description · Credit · Debit · Balance", async () => {
      const heads = (await p.locator(".gk-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase().replace(/\s+/g, " "));
      const want = ["#", "DATE", "REFERENCE", "DESCRIPTION", "CREDIT", "DEBIT", "BALANCE"];
      want.forEach((w, i) => assert(heads[i] && heads[i].startsWith(w), `col ${i}: ${heads[i]} (all: ${heads.join(",")})`));
    });
    await check("a debit sits in the Debit column, a credit in the Credit column, with a dash in the other", async () => {
      await p.fill('input[aria-label="Search transactions"]', "Rent payout"); await p.waitForTimeout(300);
      const cells = await p.locator(".gk-table tbody tr").first().locator("td").allInnerTexts();
      assert(/250\.00/.test(cells[5]) && cells[4].trim() === "—", `credit=${cells[4]} debit=${cells[5]}`);
      assert(/^DBT|^WDR|^[A-Z]{2,4}-/.test(cells[2].trim()), `reference: ${cells[2]}`);
      await p.fill('input[aria-label="Search transactions"]', "Big customer payment"); await p.waitForTimeout(300);
      const c2 = await p.locator(".gk-table tbody tr").first().locator("td").allInnerTexts();
      assert(/1,000\.00/.test(c2[4]) && c2[5].trim() === "—", `credit=${c2[4]} debit=${c2[5]}`);
      await p.fill('input[aria-label="Search transactions"]', ""); await p.waitForTimeout(300);
    });
    await check("the totals row covers all pages (page size 10) and ends with the current balance", async () => {
      const foot = await p.locator(".gk-table tfoot").innerText();
      assert(/1,600\.00/.test(foot) && /425\.50/.test(foot) && /1,174\.50/.test(foot), foot.replace(/\s+/g, " "));
      assert(/64 transactions · all pages/i.test(foot) && /Current balance/i.test(foot), foot.replace(/\s+/g, " "));
      assert(await p.locator(".gk-table tbody tr").count() === 10, "page size");
    });
    await check("filtering to Debits moves the cards and the totals together", async () => {
      await p.locator(".gk-filterbar select").first().selectOption("withdrawal"); await p.waitForTimeout(300);
      try {
      assert(near(money(await cardValue(p, "Total Debits")), 325.5), `debits ${await cardValue(p, "Total Debits")}`);
      assert(near(money(await cardValue(p, "Total Credits")), 0), "credits should be 0");
      assert((await cardValue(p, "Total Transactions")) === "2", "count");
      assert(near(money(await cardValue(p, "Current Balance")), ctx.expect.balance), "current balance must not change with filters");
      const foot = await p.locator(".gk-table tfoot").innerText();
      assert(/325\.50/.test(foot) && /filtered/i.test(foot), foot.replace(/\s+/g, " "));
      } finally { await p.locator(".gk-filterbar select").first().selectOption("all"); await p.waitForTimeout(300); }
    });
    await check("date range 'Today' keeps everything (all made today) and shows the closing balance", async () => {
      await p.locator('select[aria-label="Date range"]').selectOption("today"); await p.waitForTimeout(300);
      try {
      assert((await cardValue(p, "Total Transactions")) === String(ctx.expect.count), "count");
      const foot = await p.locator(".gk-table tfoot").innerText();
      assert(/Closing balance/i.test(foot) && /1,174\.50/.test(foot), foot.replace(/\s+/g, " "));
      } finally { await p.locator('select[aria-label="Date range"]').selectOption("all"); await p.waitForTimeout(300); }
    });

    console.log("\nCompare: Credits & Debits");
    await check("the comparison shows the same totals, net change and counts by type", async () => {
      await p.getByRole("button", { name: "Compare: Credits & Debits" }).first().click();
      const dlg = p.getByRole("dialog", { name: "Compare: Credits & Debits" });
      await dlg.waitFor({ timeout: 3000 });
      const text = await dlg.innerText();
      assert(/1,600\.00/.test(text) && /425\.50/.test(text) && /1,174\.50/.test(text), text.replace(/\s+/g, " ").slice(0, 300));
      const rows = await dlg.locator(".gk-av-kind-table tbody tr").allInnerTexts();
      const n = (label) => Number((rows.find((r) => r.startsWith(label)) || "").replace(/\D+/g, ""));
      assert(n("Credits") === 61 && n("Debits") === 2 && n("Transfers") === 1, rows.join(" | "));
      assert(/USD only/.test(text), "currency note");
      await dlg.getByRole("button", { name: "Close" }).last().click();
    });

    console.log("\nOther tabs, export, actions");
    await check("Balances Over Time draws the balance line", async () => {
      await p.getByRole("tab", { name: "Balances Over Time" }).click(); await p.waitForTimeout(400);
      assert(await p.locator(".gk-av-panel svg path").count() > 0, "no chart path");
      await p.getByRole("tab", { name: "Transactions" }).click(); await p.waitForTimeout(300);
    });
    await check("Export → Excel downloads the account's statement", async () => {
      await p.getByRole("button", { name: "Export", exact: true }).click();
      const dl = p.waitForEvent("download", { timeout: 15000 });
      await p.getByRole("button", { name: "Export Excel" }).click();
      assert(/\.xlsx$/.test((await dl).suggestedFilename()), "xlsx");
    });
    await check("Credit still opens the existing credit form", async () => {
      await p.locator(".gk-av-actions").getByRole("button", { name: "Credit", exact: true }).click();
      await p.getByRole("dialog").first().waitFor({ timeout: 3000 });
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").last().getByRole("button", { name: /Cancel|Close|×/ }).first().click().catch(() => {});
    });
    await c.close();

    console.log("\nPermissions, currencies, phone");
    {
      const { c: cv, p: pv } = await open("sahra.ismail", 1280);
      await check("a viewer sees the account but none of the account actions", async () => {
        await openAccount(pv, "Hodan Warsame Ledger");
        for (const n of ["Credit", "Transfer", "Edit"]) assert(await pv.locator(".gk-av-actions").getByRole("button", { name: n, exact: true }).count() === 0, `viewer sees ${n}`);
        await pv.locator(".gk-av-actions").getByRole("button", { name: "More account actions" }).click();
        const items = await pv.getByRole("menuitem").allInnerTexts();
        assert(!items.some((t) => /^\s*Debit\s*$|Deactivate|Delete/.test(t)), items.join("|"));
        await pv.keyboard.press("Escape");
      });
      await cv.close();
    }
    {
      const { c: cs, p: ps } = await open("amina.yusuf", 1280);
      await check("an SLSH account shows only its own SLSH figures", async () => {
        if (await ps.locator(".gk-mobile-hamburger").isVisible().catch(() => false)) await ps.locator(".gk-mobile-hamburger").click();
        const btn = ps.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*SLSH Accounts\s*$/ }).first();
        const group = ps.locator(".gk-nav-group").filter({ has: btn }).first().locator(".gk-nav-group-header").first();
        if ((await group.getAttribute("aria-expanded")) === "false") { await group.click(); await ps.waitForTimeout(300); }
        await btn.click(); await ps.waitForTimeout(900);
        await ps.getByText("Hodan Warsame Shilling", { exact: true }).first().click();
        await ps.waitForSelector(".gk-av-name"); await ps.waitForTimeout(500);
        const credits = await cardValue(ps, "Total Credits");
        assert(/500,000/.test(credits) && !/\$/.test(credits), credits);
        assert((await cardValue(ps, "Total Transactions")) === "1", "count");
      });
      await cs.close();
    }
    {
      const { c: cm, p: pm } = await open("amina.yusuf", 375);
      await check("phone: the account page has no sideways scrolling and the cards stack", async () => {
        await openAccount(pm, "Hodan Warsame Ledger");
        const over = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `page ${over}px too wide`);
        const boxes = await pm.locator(".gk-av-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
        assert(boxes.every((w) => w <= 375), boxes.join(","));
      });
      await cm.close();
    }
    await check("no browser errors", async () => assert(!errors.length, errors.slice(0, 3).join(" | ")));
  } finally { await browser.close(); }
}

async function main() {
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await setup(); await apiChecks(); await browserChecks();
  } finally { srv.kill(); }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
