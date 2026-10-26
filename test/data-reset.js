"use strict";
// DATA RESET round — tests of Settings → Reset Data (Super Admin only):
//   * only a Super Admin may preview or reset; a Company Admin is refused;
//   * the company name must be typed to confirm;
//   * only the chosen categories are cleared, with their linked ledger rows,
//     and balances are rebuilt from what remains;
//   * a category others depend on pulls them in automatically;
//   * a full "prereset" backup is stored first;
//   * the other company is never touched;
//   * the page works in the browser (English and Somali).
// Needs TEST_MYSQL_* (see test/helpers/mysql.js). Run: npm run test:data-reset
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { createTestDatabase, openScope } = require("./helpers/mysql");

const ROOT = path.join(__dirname, "..");
const TESTDB = createTestDatabase("datareset");
const PORT = Number(process.env.DATA_RESET_TEST_PORT || 4441);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
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
  const res = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;
const count = (h, sql) => h.prepare(sql).get().n;

async function run() {
  const sa = await login("super.admin", SA_PW);
  const admin = await login("amina.yusuf", PW);
  const B = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Other Co", admin: { name: "Omar Admin", username: "omar.admin", password: "Omar-Admin-Pass-55" } } });
  const omar = await login("omar.admin", "Omar-Admin-Pass-55");
  const acc = await api("/api/accounts", { method: "POST", token: omar, body: { name: "Other Customer", accountType: "customer", currency: "USD" } });
  await api(`/api/accounts/${acc.json.account.id}/deposit`, { method: "POST", token: omar, body: { amount: 300, currency: "USD", notes: "kept" } });
  const swA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const A = openScope(TESTDB.env, { companyId: "CMP-0001" });
  const Bdb = openScope(TESTDB.env, { companyId: B.json.company.id });

  console.log("\nAccess and confirmation");
  await check("a Company Admin cannot preview or reset", async () => {
    assert((await api("/api/data-reset", { token: admin })).status === 403, "preview allowed");
    assert((await api("/api/data-reset", { method: "POST", token: admin, body: { categories: ["audit"], confirmName: "OBO Financial System" } })).status === 403, "reset allowed");
  });
  let preview;
  await check("Super Admin sees each category with its record count", async () => {
    preview = await api("/api/data-reset", { token: swA });
    assert(preview.status === 200, `${preview.status}`);
    const c = Object.fromEntries(preview.json.categories.map((x) => [x.key, x.count]));
    assert(c.exchanges === 10 && c.quotations === 5 && c.accounts === 11, JSON.stringify(c));
  });
  await check("the company name must be typed to confirm", async () => {
    const r = await api("/api/data-reset", { method: "POST", token: swA, body: { categories: ["exchanges"], confirmName: "wrong" } });
    assert(r.status === 400, `${r.status}`);
    assert(count(A, "SELECT COUNT(*) AS n FROM exchange_transactions") === 10, "data changed");
  });

  console.log("\nClearing");
  await check("only the chosen categories are cleared, with their ledger rows; balances rebuilt", async () => {
    const ledgerBefore = count(A, "SELECT COUNT(*) AS n FROM account_ledger");
    const quoteLegs = count(A, "SELECT COUNT(*) AS n FROM account_ledger WHERE source_type LIKE 'quotation%'");
    const r = await api("/api/data-reset", { method: "POST", token: swA, body: { categories: ["quotations"], confirmName: "obo financial system" } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    assert(count(A, "SELECT COUNT(*) AS n FROM quotations") === 0 && count(A, "SELECT COUNT(*) AS n FROM quotation_items") === 0, "quotations left");
    assert(count(A, "SELECT COUNT(*) AS n FROM exchange_transactions") === 10, "exchanges were touched");
    assert(count(A, "SELECT COUNT(*) AS n FROM account_ledger") === ledgerBefore - quoteLegs, "wrong ledger rows removed");
    const bad = A.prepare("SELECT c.id FROM clients c WHERE ABS(c.balance_usd - COALESCE((SELECT SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END) FROM account_ledger l WHERE l.client_id=c.id AND l.currency='USD'),0)) > 0.005").all();
    assert(!bad.length, `balances not rebuilt for ${bad.length} account(s)`);
    assert(/prereset/.test(r.json.backup), `backup: ${r.json.backup}`);
  });
  await check("a pre-reset backup is stored and listed", async () => {
    const list = await api("/api/backups", { token: swA });
    assert(list.json.backups.some((b) => b.kind === "prereset"), JSON.stringify(list.json.backups));
  });
  await check("choosing accounts pulls in everything that depends on them", async () => {
    const r = await api("/api/data-reset", { method: "POST", token: swA, body: { categories: ["accounts"], confirmName: "OBO Financial System" } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    for (const k of ["payments", "exchanges", "transfers", "quotations", "loans", "accounts"]) assert(r.json.cleared.includes(k), `missing ${k}`);
    assert(count(A, "SELECT COUNT(*) AS n FROM clients") === 0 && count(A, "SELECT COUNT(*) AS n FROM account_ledger") === 0, "accounts left");
    assert(count(A, "SELECT COUNT(*) AS n FROM users") >= 7 && count(A, "SELECT COUNT(*) AS n FROM roles") === 7, "users/roles touched");
  });
  await check("the other company is never touched", async () => {
    assert(count(Bdb, "SELECT COUNT(*) AS n FROM clients") === 1 && count(Bdb, "SELECT COUNT(*) AS n FROM account_ledger") === 1, "company B changed");
  });
  await check("the app keeps working after a reset (dashboard, accounts)", async () => {
    assert((await api("/api/dashboard", { token: admin })).status === 200, "dashboard");
    assert((await api("/api/accounts", { token: admin })).json.accounts.length === 0, "accounts");
  });
  A.close(); Bdb.close();
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  const browser = await chromium.launch();
  console.log("\nBrowser");
  const errors = [];
  try {
    for (const [lang, width] of [[null, 1440], ["so", 390]]) {
      const c = await browser.newContext({ viewport: { width, height: 900 } });
      if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(BASE); await p.waitForTimeout(500);
      await p.locator("input").first().fill("super.admin"); await p.fill('input[type="password"]', SA_PW);
      await p.keyboard.press("Enter"); await p.waitForTimeout(1500);
      const card = p.locator("div").filter({ hasText: "OBO Financial System" }).filter({ has: p.locator("button", { hasText: /Open workspace|Fur/ }) }).last();
      await card.locator("button", { hasText: /Open workspace|Fur/ }).first().click();
      await p.waitForSelector(".gk-sidebar", { state: "attached" }); await p.waitForTimeout(800);
      if (await p.locator(".gk-mobile-hamburger").isVisible().catch(() => false)) { await p.locator(".gk-mobile-hamburger").click(); await p.waitForTimeout(300); }
      const settings = p.locator(".gk-nav-group-header", { hasText: /Settings|Dejinta/ }).last();
      if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
      await p.locator(".gk-nav-btn", { hasText: lang ? "Dib-u-dejinta Xogta" : /^Reset Data$/ }).first().click(); await p.waitForTimeout(1200);
      await check(`${lang ? "Somali, phone" : "English, desktop"}: the Reset Data page lists the categories and fits the screen`, async () => {
        const text = await p.locator("body").innerText();
        assert(text.includes(lang ? "Maxaa la tirtirayaa" : "What to reset"), "heading missing");
        assert(text.includes(lang ? "Sarrifka lacagta" : "Money exchanges"), "category missing");
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflow <= 1, `sideways scroll ${overflow}px`);
      });
      if (!lang) {
        await check("ticking accounts auto-includes dependents; reset needs the typed name", async () => {
          await p.locator("label", { hasText: "Customer & company accounts" }).locator("input").check();
          const autos = await p.locator("text=Included automatically").count();
          assert(autos >= 5, `auto-included: ${autos}`);
          await p.locator("button", { hasText: "Reset selected data" }).click();
          const now = p.locator("button", { hasText: "Reset now" });
          assert(await now.isDisabled(), "Reset now enabled before typing the name");
          await p.fill('input[placeholder="Company name"]', "OBO Financial System");
          assert(!(await now.isDisabled()), "Reset now still disabled");
          await now.click(); await p.waitForTimeout(2500);
          assert((await p.locator("body").innerText()).includes("Reset completed"), "no completion message");
        });
      }
      await c.close();
    }
    await check("no browser errors", async () => assert(!errors.length, errors.join(" | ")));
  } finally { await browser.close(); }
}

async function main() {
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const start = Date.now();
    for (;;) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (e) { /* not yet */ } if (Date.now() - start > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart();
  } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
