"use strict";
// GLOBAL SMART ACCOUNT SEARCH round — the Add Transaction search panel and
// account cards, the strict live filter, and the same searchable account
// selector in Money Exchange, Transfers and the Cash Account forms; only
// accounts this user may see, of this company, in this currency.
// Run with: npm run test:account-search
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("acctsearch");
const PORT = Number(process.env.ACCT_SEARCH_TEST_PORT || 4682);
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
  const mk = async (name, currency, extra = {}) => { const r = await api("/api/accounts", { method: "POST", token: SA, body: { name, currency, ...extra } }); assert(r.status < 300, `${name} ${r.status} ${JSON.stringify(r.json)}`); return r.json.account; };
  const ctx = {};
  ctx.abdi = await mk("Abdi Hassan Warsame", "USD", { contact: "+252 63 4455667", openingBalance: 120 });
  ctx.abdiNeg = await mk("Abdirahman Yusuf", "USD", { openingBalance: -45.5 });
  ctx.zero = await mk("Faadumo Zero Balance", "USD");
  ctx.abdiS = await mk("Abdi Hassan Warsame", "SLSH", { openingBalance: 50000 });
  ctx.hidden = await mk("Abdi Hidden Person", "USD");
  const users = (await api("/api/users", { token: SA })).json.users;
  const amina = users.find((u) => u.username === "amina.yusuf");
  await api(`/api/users/${amina.id}/account-access`, { method: "PATCH", token: SA, body: { changes: [{ accountId: ctx.hidden.id, level: "none" }] } });
  // A second company with its own "Abdi".
  await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Search Beta", admin: { name: "Sb Admin", username: "sb.admin", password: "BetaPass-2026x" } } });
  const B = (await api("/api/auth/login", { method: "POST", body: { username: "sb.admin", password: "BetaPass-2026x" } })).json.token;
  ctx.other = (await api("/api/accounts", { method: "POST", token: B, body: { name: "Abdi Other Company", currency: "USD" } })).json.account;
  const A = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW } })).json.token;

  console.log("\nServer search (authoritative)");
  const ids = async (q, cur = "USD", tok = A) => (await api(`/api/accounts?currency=${cur}&search=${encodeURIComponent(q)}`, { token: tok })).json.accounts.map((a) => a.id);
  await check("only this company's, permitted, same-currency accounts come back", async () => {
    const r = await ids("abdi");
    assert(r.includes(ctx.abdi.id) && r.includes(ctx.abdiNeg.id), "matches missing");
    assert(!r.includes(ctx.hidden.id), "No Access account returned");
    assert(!r.includes(ctx.other.id), "other company's account returned");
    assert(!r.includes(ctx.abdiS.id), "SLSH account in USD search");
    assert(!(await ids("abdi", "USD", B)).includes(ctx.abdi.id), "company B sees company A");
  });

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
      await btn.click(); await p.waitForTimeout(1300);
    };
    const style = (loc, prop) => loc.evaluate((el, pr) => getComputedStyle(el)[pr], prop);

    console.log("\nAdd Transaction (Bulk Entry)");
    await go("USD Payment");
    await p.getByRole("button", { name: /Bulk Entry/ }).first().click(); await p.waitForTimeout(800);
    const panel = p.locator(".gk-asearch").first();
    const box = p.getByLabel("Search for a USD account");
    const cards = p.locator(".gk-bulk-search-results .gk-acard");
    const names = async () => (await cards.locator(".gk-acard-name").allInnerTexts()).map((t) => t.trim());
    await check("'Add Transaction', then the mint search panel: emerald edge, icon, bold label, big input with a search icon, helper text", async () => {
      assert(await p.getByText("Add Transaction", { exact: true }).count() >= 1, "title");
      assert(await style(panel, "backgroundColor") === "rgb(240, 250, 247)", await style(panel, "backgroundColor"));
      assert(await style(panel, "borderLeftColor") === "rgb(16, 185, 129)" && parseFloat(await style(panel, "borderTopLeftRadius")) === 12, "edge/radius");
      assert(/Search for a USD account/.test(await panel.locator(".gk-asearch-label").innerText()) && Number(await style(panel.locator(".gk-asearch-label"), "fontWeight")) >= 700, "label");
      assert(await panel.locator(".gk-asearch-label svg").count() === 1 && await panel.locator(".gk-asearch-box svg.gk-asearch-icon").count() === 1, "icons");
      assert((await box.getAttribute("placeholder")) === "Search by name, account number, or phone...", await box.getAttribute("placeholder"));
      assert(parseFloat(await style(box, "height")) >= 42, "input height");
      assert(/Type to search — leave blank to see all\./.test(await panel.innerText()), "helper");
    });
    await check("typing 'Abdi' shows only accounts with Abdi — never others, never hidden or other-company ones", async () => {
      await box.fill("  ABDI "); await p.waitForTimeout(700);
      const n = await names();
      assert(n.length === 2 && n.every((x) => /abdi/i.test(x)), n.join(" | "));
      assert(!n.some((x) => /hidden|other company/i.test(x)), "unauthorised account shown");
    });
    await check("each card: initials, bold name, account number, currency, type badge, balance on the right", async () => {
      const card = cards.filter({ hasText: /Abdi Hassan/i }).first();
      assert((await card.locator(".gk-acard-avatar").innerText()).trim() === "AW", await card.locator(".gk-acard-avatar").innerText());
      assert(Number(await style(card.locator(".gk-acard-name"), "fontWeight")) >= 700, "name weight");
      const sub = await card.locator(".gk-acard-sub").innerText();
      assert(sub.includes(ctx.abdi.accountNumber) && /USD/.test(sub) && /Customer/.test(sub), sub);
      assert((await card.locator(".gk-acard-bal").innerText()).includes("$120.00"), "balance");
      assert(await style(card.locator(".gk-acard-bal"), "textAlign") === "right", "right aligned");
    });
    await check("balances: positive emerald, negative red, zero grey", async () => {
      const col = async (re) => style(p.locator(".gk-bulk-search-results .gk-acard").filter({ hasText: re }).first().locator(".gk-acard-bal"), "color");
      assert(await col(/Abdi Hassan/i) === "rgb(5, 150, 105)", "positive");
      assert(await col(/Abdirahman/i) === "rgb(220, 38, 38)", "negative");
      await box.fill("Faadumo Zero"); await p.waitForTimeout(700);
      assert(await col(/Faadumo Zero/i) === "rgb(100, 116, 139)", "zero");
    });
    await check("account number and phone (with or without spaces) find the one account", async () => {
      await box.fill(ctx.abdiNeg.accountNumber); await p.waitForTimeout(700);
      assert(JSON.stringify(await names()) === JSON.stringify(["Abdirahman Yusuf"]), (await names()).join(" | "));
      await box.fill("63 4455667"); await p.waitForTimeout(700);
      assert((await names()).length === 1 && /Abdi Hassan/i.test((await names())[0]), (await names()).join(" | "));
      await box.fill("634455667"); await p.waitForTimeout(700);
      assert((await names()).length === 1, `digits only: ${(await names()).join(" | ")}`);
    });
    await check("no match → 'No matching accounts found.'; clearing shows every permitted account again", async () => {
      await box.fill("zz-nobody-zz"); await p.waitForTimeout(700);
      assert((await names()).length === 0 && /No matching accounts found/.test(await p.locator(".gk-bulk-search-results").innerText()), "no-match");
      await p.getByRole("button", { name: "Clear search" }).click(); await p.waitForTimeout(800);
      const n = await names();
      assert(n.length >= 3 && !n.some((x) => /hidden|other company/i.test(x)), n.join(" | "));
    });
    await check("choosing a card continues to the Add Transaction form", async () => {
      await box.fill("Abdirahman"); await p.waitForTimeout(700);
      await cards.first().click(); await p.waitForTimeout(300);
      assert(await p.getByText("Current balance:").count() === 1, "form not shown");
    });

    console.log("\nMoney Exchange");
    await check("From Account and Receiving Account: searchable, each in its own currency, strict filter", async () => {
      await p.getByText("Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1000);
      await p.getByRole("button", { name: /New transaction/ }).first().click();
      await p.waitForSelector("#qx-amount", { timeout: 10000 });
      const track = p.getByRole("radio", { name: /Track in Account/ });
      if (await track.count()) { await track.click(); await p.waitForTimeout(400); }
      await p.click("#qx-from"); await p.waitForTimeout(200);
      const fromPanel = p.locator("#qx-from + .gk-acombo-panel");
      await fromPanel.locator("input").fill("abdi"); await p.waitForTimeout(150);
      const fn = (await fromPanel.locator(".gk-acard .gk-acard-name").allInnerTexts()).map((t) => t.trim());
      assert(fn.length === 2 && fn.every((x) => /abdi/i.test(x)), fn.join(" | "));
      assert((await fromPanel.locator(".gk-acard .gk-acard-cur").allInnerTexts()).every((x) => x === "USD"), "From currency");
      await fromPanel.locator(".gk-acard").filter({ hasText: /Abdi Hassan/i }).click(); await p.waitForTimeout(300);
      assert(/Abdi Hassan/i.test(await p.locator("#qx-from").innerText()), "selection not shown");
      await p.click("#qx-to"); await p.waitForTimeout(200);
      const toPanel = p.locator("#qx-to + .gk-acombo-panel");
      assert((await toPanel.locator(".gk-acard .gk-acard-cur").allInnerTexts()).every((x) => x === "SLSH"), "Receiving currency");
      await toPanel.locator("input").fill("zz-none"); await p.waitForTimeout(150);
      assert(/No matching accounts found/.test(await toPanel.innerText()), "no match text");
      await p.keyboard.press("Escape"); await p.waitForTimeout(200);
      assert(await p.locator("#qx-to + .gk-acombo-panel").count() === 0, "panel did not close");
      assert(await p.locator(".gk-exw-cashpair-arrow svg").count() === 1, "direction arrow");
    });

    console.log("\nTransfers");
    await check("Account Transfer: From / To account searches show only matches, as cards", async () => {
      await go("USD Payment");
      await p.getByRole("button", { name: /USD Transfer/ }).first().click(); await p.waitForTimeout(800);
      const dlg = p.getByRole("dialog");
      const first = dlg.locator(".gk-asearch").first();
      await first.locator("input").fill("abdi"); await p.waitForTimeout(800);
      const n = (await first.locator(".gk-acard-name").allInnerTexts()).map((t) => t.trim());
      assert(n.length >= 1 && n.every((x) => /abdi/i.test(x)) && !n.some((x) => /hidden/i.test(x)), n.join(" | "));
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
