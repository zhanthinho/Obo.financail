"use strict";
// OPTION 1 LIGHT SECTION BACKGROUND round — every From / To / Source /
// Destination / Receiving account field sits in its own light-mint section
// (#F0FAF7) with a bold navy label, a dark-emerald icon (#0F5B50) and a
// white dropdown with a light-grey border; From and To side by side have
// equal widths. Visual only. Run with: npm run test:account-fields
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("acctfields");
const PORT = Number(process.env.ACCT_FIELDS_TEST_PORT || 4678);
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
  await api(`/api/users/${amina.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: ["cash.view", "cash.transfer", "cash.exchange", "loans.view", "loans.create"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } });
  await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Af Till USD", type: "physical_cash", currency: "USD", openingBalance: 100 } });
  await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Af Bank USD", type: "bank", currency: "USD" } });
  await api("/api/cash/accounts", { method: "POST", token: SA, body: { name: "Af Till SLSH", type: "physical_cash", currency: "SLSH" } });

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
    // Every account section on screen: mint background, emerald icon, bold label, white select with grey border.
    const looksRight = async (scope, minCount) => {
      const groups = await scope.locator(".gk-acct-group").evaluateAll((els) => els.filter((e) => e.offsetParent).map((g) => {
        const cs = getComputedStyle(g), lab = g.querySelector(".gk-acct-label"), ic = g.querySelector(".gk-acct-label svg"), sel = g.querySelector("select, input, .gk-acombo-trigger");
        return { bg: cs.backgroundColor, radius: parseFloat(cs.borderTopLeftRadius), pad: parseFloat(cs.paddingTop), w: g.getBoundingClientRect().width, label: lab ? lab.textContent.trim() : "",
          weight: lab ? Number(getComputedStyle(lab).fontWeight) : 0, icon: ic ? getComputedStyle(ic).color : null,
          selBg: sel ? getComputedStyle(sel).backgroundColor : null, selBorder: sel ? getComputedStyle(sel).borderTopColor : null };
      }));
      assert(groups.length >= minCount, `account sections: ${groups.length} (${groups.map((g) => g.label).join(" | ")})`);
      for (const g of groups) {
        assert(g.bg === "rgb(240, 250, 247)", `${g.label}: background ${g.bg}`);
        assert(g.radius >= 10 && g.radius <= 12 && g.pad >= 12 && g.pad <= 16, `${g.label}: radius ${g.radius} padding ${g.pad}`);
        assert(g.weight >= 700, `${g.label}: label weight ${g.weight}`);
        assert(g.icon === "rgb(15, 91, 80)", `${g.label}: icon ${g.icon}`);
        if (g.selBg) assert(g.selBg === "rgb(255, 255, 255)" && g.selBorder === "rgb(203, 213, 216)", `${g.label}: dropdown ${g.selBg} / ${g.selBorder}`);
      }
      return groups;
    };

    console.log("\nCash Account forms");
    await go("Cash Account");
    await check("Cash Transfer: From and To in their own mint sections, side by side, equal widths", async () => {
      await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(800);
      await p.getByRole("button", { name: /New Cash Transfer/ }).click(); await p.waitForTimeout(500);
      const dlg = p.getByRole("dialog");
      const g = await looksRight(dlg, 2);
      assert(Math.abs(g[0].w - g[1].w) < 2, `widths ${g[0].w} / ${g[1].w}`);
      assert(/^From/.test(g[0].label) && /^To/.test(g[1].label), g.map((x) => x.label).join(" | "));
      // the dropdowns still work
      await dlg.locator(".gk-acct-group .gk-acombo-trigger").first().click(); await p.waitForTimeout(200);
      await dlg.locator(".gk-acombo-panel .gk-acard").first().click(); await p.waitForTimeout(200);
      assert(!(await dlg.locator(".gk-acct-group .gk-acombo-trigger").nth(1).isDisabled()), "To not enabled after choosing From");
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: "Cancel" }).first().click();
    });
    await check("Cash Exchange: source and receiving currency told apart", async () => {
      await p.getByText("Exchanges", { exact: true }).first().click(); await p.waitForTimeout(800);
      await p.getByRole("button", { name: /New Cash Exchange/ }).click(); await p.waitForTimeout(500);
      const dlg = p.getByRole("dialog");
      await looksRight(dlg, 2);
      await dlg.locator(".gk-acct-group .gk-acombo-trigger").first().click(); await p.waitForTimeout(200);
      await dlg.locator(".gk-acombo-panel .gk-acard").filter({ hasText: /Af Till Usd/i }).first().click();
      await p.waitForTimeout(200);
      const t = await dlg.locator(".gk-acct-pair").innerText();
      assert(/Gives (USD|SLSH)/.test(t) && /Receives (USD|SLSH)/.test(t), t);
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: "Cancel" }).first().click();
    });
    await check("New Loan: the source Cash Account is a mint section", async () => {
      await p.getByText("Loans", { exact: true }).first().click(); await p.waitForTimeout(800);
      await p.getByRole("button", { name: /New Loan/ }).click(); await p.waitForTimeout(500);
      await looksRight(p.getByRole("dialog"), 1);
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: "Cancel" }).first().click();
    });

    console.log("\nPayments and transfers");
    await check("Payments (Bulk Entry): the USD account selector is a mint section", async () => {
      await go("USD Payment");
      await p.getByRole("button", { name: /Bulk Entry/ }).first().click(); await p.waitForTimeout(700);
      // GLOBAL SMART ACCOUNT SEARCH round: here it is the Add Transaction search panel (same mint).
      const panel = p.locator(".gk-asearch").first();
      assert(await panel.evaluate((e) => getComputedStyle(e).backgroundColor) === "rgb(240, 250, 247)", "search panel not mint");
    });
    await check("Account Transfer: From Account and To Account sections, equal widths", async () => {
      await go("USD Payment");
      await p.getByRole("button", { name: /USD Transfer/ }).first().click(); await p.waitForTimeout(600);
      const dlg = p.getByRole("dialog");
      const g = await looksRight(dlg, 2);
      assert(Math.abs(g[0].w - g[1].w) < 2, `widths ${g[0].w} / ${g[1].w}`);
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: "Cancel" }).first().click();
    });

    console.log("\nResponsive");
    await check("on a phone the From and To sections stack, full width, no sideways scrolling", async () => {
      await go("Cash Account");
      await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(700);
      await p.getByRole("button", { name: /New Cash Transfer/ }).click(); await p.waitForTimeout(500);
      await p.setViewportSize({ width: 390, height: 860 }); await p.waitForTimeout(400);
      const boxes = await p.getByRole("dialog").locator(".gk-acct-group").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.top, r.width]));
      assert(boxes.length === 2 && boxes[1][1] > boxes[0][1] && Math.abs(boxes[0][2] - boxes[1][2]) < 2, JSON.stringify(boxes));
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `overflow ${over}`);
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
