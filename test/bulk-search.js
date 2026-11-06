"use strict";
// SMART ACCOUNT LIVE SEARCH round — the account search of New USD
// Transactions — Bulk Entry shows only the accounts matching what is typed.
// On a throw-away database. Run with: npm run test:bulk-search
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("bulksearch");
const PORT = Number(process.env.BULK_SEARCH_TEST_PORT || 4670);
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
  const mk = async (name, currency, extra = {}) => (await api("/api/accounts", { method: "POST", token: SA, body: { name, currency, ...extra } })).json.account;
  const ctx = {};
  ctx.m1 = await mk("Maxamed Cabdi Nuur", "USD", { contact: "+252 63 7771234", openingBalance: 150 });
  ctx.m2 = await mk("Maxamed Xuseen", "USD", { openingBalance: 20 });
  ctx.ali = await mk("Ali Warsame", "USD");
  ctx.mS = await mk("Maxamed Cabdi Nuur", "SLSH");
  ctx.hidden = await mk("Maxamed Hidden Person", "USD");
  const users = (await api("/api/users", { token: SA })).json.users;
  const amina = users.find((u) => u.username === "amina.yusuf");
  const h = await api(`/api/users/${amina.id}/account-access`, { method: "PATCH", token: SA, body: { changes: [{ accountId: ctx.hidden.id, level: "none" }] } });
  assert(h.status === 200, `hide ${h.status}`);

  console.log("\nServer search");
  await check("the search ignores surrounding spaces and case", async () => {
    const T = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW } })).json.token;
    const r = (await api(`/api/accounts?currency=USD&search=${encodeURIComponent("   maxamed  ")}`, { token: T })).json.accounts.map((a) => a.id);
    assert(r.includes(ctx.m1.id) && r.includes(ctx.m2.id) && !r.includes(ctx.ali.id) && !r.includes(ctx.mS.id) && !r.includes(ctx.hidden.id), JSON.stringify(r));
  });

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  console.log("\nBulk Entry screen");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    // The list for an EMPTY search answers slowly — the old way, it could land
    // after a typed search and put every account back on screen.
    await p.route("**/api/accounts?**", async (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.get("search")) await new Promise((r) => setTimeout(r, 1500));
      route.continue();
    });
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*USD Payment\s*$/ }).first();
    const group = p.locator(".gk-nav-group").filter({ has: btn });
    if (await group.count()) { const hd = group.first().locator(".gk-nav-group-header").first(); if ((await hd.getAttribute("aria-expanded")) === "false") { await hd.click(); await p.waitForTimeout(300); } }
    await btn.click(); await p.waitForTimeout(900);
    await p.getByRole("button", { name: /Bulk Entry/ }).first().click(); await p.waitForTimeout(500);
    const box = p.getByLabel("Search for a USD account");
    const list = p.locator(".gk-bulk-search-results");
    const names = async () => (await list.locator("button[role=option] .gk-acard-name").allInnerTexts()).map((t) => t.trim());

    await check("typing a name at once shows only the matching accounts — even before the server answers", async () => {
      await box.fill("Maxamed");
      await p.waitForTimeout(80);
      const early = await names();
      assert(early.every((n) => /maxamed/i.test(n)), `unrelated accounts while typing: ${early.join(", ")}`);
      await p.waitForTimeout(2200); // the slow "all accounts" answer arrives — and must be ignored
      const r = await names();
      assert(r.length === 2 && r.every((n) => /maxamed/i.test(n)), `results: ${r.join(", ")}`);
      assert(!r.some((n) => /hidden/i.test(n)), "an account with No Access was offered");
      assert(await p.locator(".gk-bulk-search-results mark.gk-hl").count() >= 2, "match not highlighted");
    });
    await check("each result shows name, account number, currency, balance and type", async () => {
      const t = await list.locator(`button[data-account="${ctx.m1.accountNumber}"]`).innerText();
      assert(t.includes(ctx.m1.accountNumber) && /USD/.test(t) && /\$150\.00/.test(t) && /Company|Customer/.test(t), t);
    });
    await check("partial and case-insensitive: 'ali' finds Ali (and names containing it), nothing else", async () => {
      await box.fill("ali"); await p.waitForTimeout(700);
      const r = await names();
      assert(r.length >= 1 && r.every((n) => /ali/i.test(n)) && r.some((n) => /^Ali Warsame/i.test(n)), r.join(", "));
    });
    await check("an account number or a phone number finds that account", async () => {
      await box.fill(ctx.m2.accountNumber); await p.waitForTimeout(700);
      assert((await names()).length === 1 && /Xuseen/i.test((await names())[0]), (await names()).join(", "));
      await box.fill("7771234"); await p.waitForTimeout(700);
      const r = await names();
      assert(r.length === 1 && /Cabdi/i.test(r[0]), r.join(", "));
      assert(/7771234/.test(await list.innerText()), "phone match not shown");
    });
    await check("no match shows 'No matching accounts found.' and never the full list", async () => {
      await box.fill("zzqx-nobody"); await p.waitForTimeout(700);
      assert((await names()).length === 0, "results shown");
      assert(/No matching accounts found/.test(await list.innerText()), await list.innerText());
    });
    await check("the clear button resets the search; nothing is selected automatically", async () => {
      await box.fill("Maxamed"); await p.waitForTimeout(700);
      assert(await p.getByText("Current balance:").count() === 0, "an account was selected automatically");
      await p.getByRole("button", { name: "Clear search" }).click(); await p.waitForTimeout(100);
      assert((await box.inputValue()) === "", "search not cleared");
      await p.waitForTimeout(500);
      assert((await names()).length === 0 && /Type a name/.test(await list.innerText()), "clearing listed accounts again");
    });
    await check("clicking an account continues to the existing Add Transaction form; Change goes back", async () => {
      await box.fill("Xuseen"); await p.waitForTimeout(700);
      await list.locator(`button[data-account="${ctx.m2.accountNumber}"]`).click(); await p.waitForTimeout(300);
      assert(await p.getByText("Current balance:").count() === 1, "form not shown");
      assert(await p.getByRole("button", { name: "Credit", exact: true }).count() >= 1 && await p.getByRole("button", { name: "Debit", exact: true }).count() >= 1, "credit/debit missing");
      await p.getByRole("button", { name: "Change", exact: true }).click(); await p.waitForTimeout(300);
      assert((await box.inputValue()) === "", "search not reset after Change");
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
