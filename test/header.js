"use strict";
// GLOBAL HEADER REDESIGN (Option 3) — browser checks for the shared compact
// page header: every page has one compact title row; primary actions stay
// visible; Export / Import / extra actions live in a working ⋯ menu (opens,
// closes on Escape and outside click, keyboard navigation, stays inside the
// viewport, items still run their original actions); per-tab primary actions;
// permission-aware (a viewer sees no Add buttons); no horizontal page
// overflow on a phone; Somali labels.
//
// Run with: npm run test:header
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("header");
const PORT = Number(process.env.HEADER_TEST_PORT || 4460);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message.split("\n")[0]}`); console.log(`FAILED\n      ${e.message.split("\n")[0]}`); }
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

const PAGES = [
  ["Dashboard", "Dashboard"], ["USD Accounts", "USD Accounts"], ["SLSH Accounts", "SLSH Accounts"],
  ["USD Payment", null], ["Money Exchange", "Money Exchange"],
  ["USD Transactions", null], ["Company Expenses", "Company Expenses"], ["Reports", "Reports"],
  ["Users", null], ["Roles", null], ["General", null], ["Deactivated Accounts", null],
];

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(skipped — Playwright not installed)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
  const open = async (user, width, lang) => {
    const c = await browser.newContext({ viewport: { width, height: 860 }, acceptDownloads: true });
    if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill(user); await p.fill('input[type="password"]', user === "super.admin" ? SA_PW : PW);
    await p.keyboard.press("Enter");
    if (user === "super.admin") {
      await p.waitForTimeout(1200);
      await p.locator("button", { hasText: /Open workspace|Fur/ }).first().click();
    }
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
    return { c, p };
  };
  const go = async (p, label) => {
    if (await p.locator(".gk-mobile-hamburger").isVisible().catch(() => false)) { await p.locator(".gk-mobile-hamburger").click(); await p.waitForTimeout(250); }
    const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label.replace(/[()]/g, "\\$&")}\\s*$`) }).first();
    const group = p.locator(".gk-nav-group").filter({ has: btn });
    if (await group.count()) {
      const h = group.first().locator(".gk-nav-group-header").first();
      if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(350); }
    }
    await btn.click(); await p.waitForTimeout(900);
  };
  const closeDialog = async (p) => {
    await p.keyboard.press("Escape"); await p.waitForTimeout(250);
    const d = p.getByRole("dialog");
    if (await d.count()) { await d.last().getByRole("button", { name: /^(Cancel|Close|×|Ka noqo|Xidh)$/ }).first().click().catch(() => {}); await p.waitForTimeout(250); }
    assert(await p.getByRole("dialog").count() === 0, "dialog did not close");
  };
  const header = (p) => p.locator(".gk-ph").first();
  const moreBtn = (p) => header(p).getByRole("button", { name: "More actions" });
  try {
    const { c, p } = await open("amina.yusuf", 1366);
    console.log("\nEvery page uses the compact header");
    for (const [nav] of PAGES) {
      await check(`${nav}: one compact title row (h1, ≤ 72px tall)`, async () => {
        await go(p, nav);
        const h1 = header(p).locator("h1.gk-ph-title");
        assert(await h1.count() === 1, "no h1 title in the shared header");
        const box = await header(p).locator(".gk-ph-row").boundingBox();
        assert(box && box.height <= 72, `header row ${box && box.height}px tall`);
        const fs = await h1.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
        assert(fs <= 19, `title font ${fs}px`);
      });
    }

    console.log("\nAccounts — primary visible, exports/imports in ⋯");
    await go(p, "USD Accounts");
    await check("primary 'Add Customer (USD)' is visible in the header", async () => {
      await header(p).getByRole("button", { name: /Add Customer \(USD\)/ }).waitFor({ timeout: 3000 });
    });
    await check("Export / Import buttons are no longer loose in the header", async () => {
      for (const n of ["Export CSV", "Export PDF", "Preview PDF", "Import Accounts", "Import History", "Print"]) {
        assert(await header(p).getByRole("button", { name: n, exact: true }).count() === 0, `${n} still a header button`);
      }
    });
    await check("⋯ opens a menu with Export and Import groups holding every moved action", async () => {
      await moreBtn(p).click();
      const menu = p.getByRole("menu");
      await menu.waitFor({ timeout: 2000 });
      assert(await moreBtn(p).getAttribute("aria-expanded") === "true", "aria-expanded");
      for (const g of ["Export", "Import"]) assert(await menu.getByRole("group", { name: g }).count() === 1, `group ${g}`);
      for (const n of ["Preview PDF", "Export PDF", "Export Excel", "Print", "Export CSV", "Export Accounts + Balances", "Import History", "Import Accounts"]) {
        assert(await menu.getByRole("menuitem", { name: n, exact: true }).count() === 1, `missing ${n}`);
      }
    });
    await check("keyboard: first item focused, ArrowDown / End move focus", async () => {
      const first = await p.evaluate(() => document.activeElement.getAttribute("role"));
      assert(first === "menuitem", `focus on ${first}`);
      const a = await p.evaluate(() => document.activeElement.textContent);
      await p.keyboard.press("ArrowDown");
      const b = await p.evaluate(() => document.activeElement.textContent);
      assert(a !== b, "ArrowDown did not move");
      await p.keyboard.press("End");
      const items = await p.getByRole("menuitem").allTextContents();
      assert(await p.evaluate(() => document.activeElement.textContent) === items[items.length - 1], "End");
    });
    await check("Escape closes the menu and returns focus to ⋯", async () => {
      await p.keyboard.press("Escape");
      assert(await p.getByRole("menu").count() === 0, "still open");
      assert(await p.evaluate(() => document.activeElement.getAttribute("aria-label")) === "More actions", "focus not back");
    });
    await check("clicking outside closes the menu", async () => {
      await moreBtn(p).click(); await p.getByRole("menu").waitFor();
      await p.mouse.click(5, 500); await p.waitForTimeout(150);
      assert(await p.getByRole("menu").count() === 0, "still open");
    });
    await check("menu items still run their original action (Export CSV downloads a CSV)", async () => {
      await moreBtn(p).click();
      const dl = p.waitForEvent("download", { timeout: 10000 });
      await p.getByRole("menuitem", { name: "Export CSV", exact: true }).click();
      const d = await dl;
      assert(/\.csv$/.test(d.suggestedFilename()), d.suggestedFilename());
      assert(await p.getByRole("menu").count() === 0, "menu stayed open");
    });
    await check("Import Accounts from the menu opens its dialog", async () => {
      await moreBtn(p).click();
      await p.getByRole("menuitem", { name: "Import Accounts", exact: true }).click();
      await p.getByRole("dialog").first().waitFor({ timeout: 3000 });
      await closeDialog(p);
    });
    await check("tabs still switch, and the primary action follows the active tab", async () => {
      await p.locator(".gk-tabbar button", { hasText: "Company accounts" }).click(); await p.waitForTimeout(600);
      await header(p).getByRole("button", { name: /Add Company \(USD\)/ }).waitFor({ timeout: 3000 });
      await p.locator(".gk-tabbar button", { hasText: "Customer accounts" }).click(); await p.waitForTimeout(400);
    });

    console.log("\nCash Account — the active tab's main action is in the header (Super Admin: Admin has no cash.view)");
    const { c: csa, p: psa } = await open("super.admin", 1366);
    {
    const p = psa;
    await go(p, "Cash Account");
    await check("Cash Account: one compact title row", async () => { assert(await header(p).locator("h1.gk-ph-title").count() === 1, "no h1"); });
    for (const [tab, label] of [["Cash Accounts", "+ Add Cash Account"], ["Transfers", "+ New Cash Transfer"], ["Exchanges", "+ New Cash Exchange"], ["Loans", "+ New Loan"]]) {
      await check(`${tab} tab → '${label}' in the header, and only that one`, async () => {
        await p.locator(".gk-tabbar button", { hasText: new RegExp(`^${tab}$`) }).click(); await p.waitForTimeout(500);
        // Btn shows a leading "+ " as its plus icon, so the text has no "+".
        const want = label.replace(/^\+\s*/, "");
        const names = (await header(p).getByRole("button").allTextContents()).map((s) => s.trim());
        assert(names.includes(want), `header buttons: ${names.join(", ")}`);
        assert(names.filter((n) => /^(Add|New) /.test(n)).length === 1, `several: ${names.join(", ")}`);
        assert(await p.getByRole("button", { name: want, exact: true }).count() === 1, "duplicate button on the page");
      });
    }
    await check("'+ New Cash Transfer' still opens its form", async () => {
      await p.locator(".gk-tabbar button", { hasText: /^Transfers$/ }).click(); await p.waitForTimeout(300);
      await header(p).getByRole("button", { name: "New Cash Transfer" }).click();
      await p.getByRole("dialog").first().waitFor({ timeout: 3000 });
      await closeDialog(p);
    });

    }
    await csa.close();
    console.log("\nCompany Expenses and Dashboard");
    await go(p, "Company Expenses");
    await check("'Add New Expense' is in the header and opens the form", async () => {
      await header(p).getByRole("button", { name: "Add New Expense" }).click();
      await p.getByRole("dialog").first().waitFor({ timeout: 3000 });
      await closeDialog(p);
    });
    await check("expense filters sit in one compact filter bar", async () => {
      const bar = p.locator(".gk-filterbar.gk-exp-filters");
      assert(await bar.count() === 1, "no compact filter bar");
      const h = (await bar.boundingBox()).height;
      assert(h < 140, `filter bar ${h}px tall`);
    });
    await go(p, "Dashboard");
    await check("Dashboard: Refresh / Customize visible; Export CSV, Export PDF and Print in ⋯", async () => {
      await p.waitForTimeout(800);
      const names = (await header(p).getByRole("button").allTextContents()).map((t) => t.trim());
      assert(names.includes("Refresh") && names.includes("Customize Dashboard"), `header buttons: ${names.join(" | ")}`);
      await moreBtn(p).click();
      for (const n of ["Export CSV", "Export PDF", "Print"]) assert(await p.getByRole("menuitem", { name: n, exact: true }).count() === 1, n);
      const dl = p.waitForEvent("download", { timeout: 10000 });
      await p.getByRole("menuitem", { name: "Export PDF", exact: true }).click();
      assert(/\.pdf$/.test((await dl).suggestedFilename()), "pdf");
    });
    await c.close();

    console.log("\nPermissions");
    {
      const { c: cv, p: pv } = await open("sahra.ismail", 1366);
      await check("a viewer sees no Add buttons on the Accounts header", async () => {
        await go(pv, "USD Accounts");
        assert(await header(pv).getByRole("button", { name: /^\+?\s*Add / }).count() === 0, "viewer sees an Add button");
      });
      await cv.close();
    }

    console.log("\nPhone (375px)");
    {
      const { c: cm, p: pm } = await open("amina.yusuf", 375);
      for (const [nav] of PAGES.slice(0, 9)) {
        await check(`${nav}: no horizontal page overflow`, async () => {
          await go(pm, nav);
          const over = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert(over <= 1, `page is ${over}px wider than the screen`);
        });
      }
      await check("⋯ menu opens fully inside the phone screen", async () => {
        await go(pm, "USD Accounts");
        await moreBtn(pm).click();
        const b = await pm.getByRole("menu").boundingBox();
        assert(b.x >= 0 && b.x + b.width <= 376, `menu x ${b.x}..${b.x + b.width}`);
        await pm.keyboard.press("Escape");
      });
      await cm.close();
    }

    console.log("\nSomali");
    {
      const { c: cs, p: ps } = await open("amina.yusuf", 1366, "so");
      await check("the ⋯ button and menu groups are translated", async () => {
        const accts = ps.locator(".gk-nav-btn").filter({ hasText: /USD/ }).first();
        if (await ps.locator(".gk-nav-group-header").first().getAttribute("aria-expanded") === "false") await ps.locator(".gk-nav-group-header").first().click();
        await accts.click(); await ps.waitForTimeout(900);
        const b = header(ps).getByRole("button", { name: "Ficillo kale" });
        await b.click();
        const heads = await ps.locator(".gk-om-heading").allTextContents();
        assert(heads.includes("Soo saar") && heads.includes("Soo geli"), heads.join(","));
      });
      await cs.close();
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
  try { await waitUp(); await browserChecks(); } finally { srv.kill(); }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
