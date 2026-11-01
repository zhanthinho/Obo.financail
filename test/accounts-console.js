"use strict";
// ACCOUNTS CONSOLE round — Accounts — USD / SLSH redesign: server summary,
// ledger Credits / Debits per account, filters, sorting, export, isolation
// and the page itself, on a throw-away database.
// Run with: npm run test:accounts-console
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("acccons");
const PORT = Number(process.env.ACCOUNTS_CONSOLE_TEST_PORT || 4580);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
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
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* binary */ }
  return { status: r.status, json, buf };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json?.token;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const list = async (tok, q) => (await api(`/api/accounts?withTotals=1&${q}`, { token: tok })).json;

let srv, serverErr = "";
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  ctx.adm = await login("amina.yusuf", PW);
  const T = ctx.adm;
  console.log("\nCredits, Debits and the summary");
  await check("Credits and Debits come from the ledger and Credits − Debits equals each balance", async () => {
    const a = await api("/api/accounts", { method: "POST", token: T, body: { name: "Console Test Customer", accountType: "customer", currency: "USD", openingBalance: 100 } });
    assert(a.status === 201 || a.status === 200, `create ${a.status} ${JSON.stringify(a.json)}`);
    ctx.acc = a.json.account;
    for (const [k, amt] of [["deposit", 50], ["withdraw", 30.25]]) {
      const r = await api(`/api/accounts/${ctx.acc.id}/${k}`, { method: "POST", token: T, body: { amount: amt, currency: "USD" } });
      assert(r.status < 300, `${k} ${r.status} ${JSON.stringify(r.json)}`);
    }
    const d = await list(T, "currency=USD&type=customer&sort=name");
    const row = d.accounts.find((x) => x.id === ctx.acc.id);
    assert(row.credits === 150 && row.debits === 30.25 && row.balance === 119.75 && row.ledgerMismatch === false, JSON.stringify(row));
    for (const x of d.accounts) assert(Math.abs(r2(x.credits - x.debits) - x.balance) < 0.005 && !x.ledgerMismatch, `${x.name}: ${x.credits} - ${x.debits} != ${x.balance}`);
  });
  await check("the summary covers ALL matching accounts and matches the rows (counts, held, credits, debits)", async () => {
    const d = await list(T, "currency=USD&type=customer&sort=name");
    const s = d.summary.USD;
    assert(!d.summary.SLSH, "SLSH mixed into the USD page");
    assert(s.accounts === d.accounts.length, "count");
    assert(s.totalHeld === r2(d.accounts.reduce((t, x) => t + x.balance, 0)), "total held");
    assert(s.credits === r2(d.accounts.reduce((t, x) => t + x.credits, 0)) && s.debits === r2(d.accounts.reduce((t, x) => t + x.debits, 0)), "credits/debits");
    assert(s.positive === d.accounts.filter((x) => x.balance > 0).length && s.inDebt === d.accounts.filter((x) => x.balance < 0).length && s.zero === d.accounts.filter((x) => x.balance === 0).length, "classification");
    assert(s.positive + s.zero + s.inDebt === s.accounts, "classes do not add up");
    assert(d.accounts.every((x) => x.currency === "USD" && x.accountType === "customer"), "wrong scope");
  });
  await check("zero balances are their own class: Positive excludes them, the Zero filter finds them", async () => {
    const z = await api("/api/accounts", { method: "POST", token: T, body: { name: "Console Zero Customer", accountType: "customer", currency: "USD" } });
    ctx.zero = z.json.account;
    const pos = await list(T, "currency=USD&type=customer&balanceSign=positive&sort=name");
    const zero = await list(T, "currency=USD&type=customer&balanceSign=zero&sort=name");
    const neg = await list(T, "currency=USD&type=customer&balanceSign=negative&sort=name");
    assert(!pos.accounts.some((x) => x.id === ctx.zero.id) && pos.accounts.every((x) => x.balance > 0), "positive includes zero");
    assert(zero.accounts.some((x) => x.id === ctx.zero.id) && zero.accounts.every((x) => x.balance === 0), "zero filter");
    assert(neg.accounts.every((x) => x.balance < 0), "negative filter");
    const all = await list(T, "currency=USD&type=customer&sort=name");
    assert(pos.accounts.length + zero.accounts.length + neg.accounts.length === all.accounts.length, "filters do not partition the list");
  });
  await check("sorting: Name Z–A and Lowest balance", async () => {
    const zA = (await list(T, "currency=USD&type=customer&sort=name_desc")).accounts.map((x) => x.name);
    assert(JSON.stringify(zA) === JSON.stringify([...zA].sort((a, b) => b.localeCompare(a, "en", { sensitivity: "base" }))) || zA[0] >= zA[zA.length - 1], "name desc");
    const low = (await list(T, "currency=USD&type=customer&sort=balance_asc")).accounts.map((x) => x.balance);
    for (let i = 1; i < low.length; i += 1) assert(low[i] >= low[i - 1], "balance asc");
  });
  await check("search and the customer / company tabs return only matching accounts", async () => {
    const s = await list(T, "currency=USD&type=customer&sort=name&search=Console%20Test");
    assert(s.accounts.length === 1 && s.accounts[0].id === ctx.acc.id && s.summary.USD.accounts === 1, `search ${s.accounts.length}`);
    const comp = await list(T, "currency=USD&type=company&sort=name");
    assert(comp.accounts.every((x) => x.accountType === "company") && !comp.accounts.some((x) => x.id === ctx.acc.id), "company tab mixed");
  });
  await check("the SLSH page only has SLSH accounts and SLSH totals", async () => {
    const d = await list(T, "currency=SLSH&type=customer&sort=name");
    assert(d.accounts.every((x) => x.currency === "SLSH") && d.summary.SLSH && !d.summary.USD, "currency mixed");
  });
  await check("the Excel export follows the filters", async () => {
    const r = await api("/api/accounts/export.xlsx?currency=USD&type=customer&balanceSign=zero&sort=name", { token: T });
    assert(r.status === 200, `export ${r.status}`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
    const text = []; wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value && c.value.result !== undefined ? c.value.result : c.value)))));
    const t = text.join("|");
    assert(/Console Zero Customer/i.test(t) && !/Console Test Customer/i.test(t), "export ignores the balance filter");
  });
  await check("the list of accounts did not touch any balance (read-only)", async () => {
    const a = (await api(`/api/accounts/${ctx.acc.id}`, { token: T })).json;
    assert((a.account || a).balance === 119.75, "balance moved");
  });

  console.log("\nSecurity");
  await check("anonymous and role-less requests are refused; another company sees none of these accounts", async () => {
    assert((await api("/api/accounts?withTotals=1&currency=USD")).status === 401, "anonymous");
    const sa = await login("super.admin", SA_PW);
    const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Console Beta Ltd", admin: { name: "Cb Admin", username: "cb.admin", password: "BetaPass123!" } } });
    assert(c.status === 201 || c.status === 200, `company ${c.status}`);
    const b = await login("cb.admin", "BetaPass123!");
    const d = await list(b, "currency=USD&type=customer&sort=name");
    assert(d.accounts.length === 0 && d.summary.USD.accounts === 0 && d.summary.USD.totalHeld === 0, `B sees ${d.accounts.length} accounts`);
    assert((await api(`/api/accounts/${ctx.acc.id}`, { token: b })).status === 404, "B opens A's account");
    const A = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
    const role = await api("/api/roles", { method: "POST", token: A, body: { name: "No Accounts", permissions: ["currency.usd"] } });
    await api("/api/users", { method: "POST", token: A, body: { name: "Nora None", username: "nora.none", password: "Nora-Pass-2026!", roleId: role.json.role.id } });
    const n = await login("nora.none", "Nora-Pass-2026!");
    assert((await api("/api/accounts?withTotals=1&currency=USD", { token: n })).status === 403, "user without accounts.view lists accounts");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nAccounts — USD page");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    const go = async (label) => {
      const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
      const group = p.locator(".gk-nav-group").filter({ has: btn });
      if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(300); } }
      await btn.click(); await p.waitForTimeout(1000);
    };
    const kpi = async (k) => (await p.locator(`.gk-acc-kpi[data-kpi="${k}"] .gk-acc-kpi-value`).innerText()).trim();
    await go("USD Accounts");
    const api0 = await list(ctx.adm, "currency=USD&type=customer&sort=name");
    await check("title, tabs, toolbar and four KPI cards with the server's figures", async () => {
      assert(await p.locator("h1", { hasText: "Accounts — USD" }).count() === 1, "title");
      assert(await p.getByRole("tab", { name: "Customer Accounts" }).getAttribute("aria-selected") === "true", "tab");
      for (const l of ["Search customers", "Balance", "Registered from", "Registered to", "Sort by"]) assert(await p.getByLabel(l, { exact: true }).count() === 1, `${l} missing`);
      assert(await kpi("accounts") === String(api0.summary.USD.accounts), "accounts kpi");
      assert(await kpi("positive") === String(api0.summary.USD.positive) && await kpi("debt") === String(api0.summary.USD.inDebt), "positive/debt kpis");
      const held = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(api0.summary.USD.totalHeld));
      assert((await kpi("held")).includes(held), `held ${await kpi("held")} vs ${held}`);
      if (process.env.ACC_SHOT) await p.screenshot({ path: process.env.ACC_SHOT });
    });
    await check("table shows Credits, Debits and Balance; the totals row is for all matching accounts", async () => {
      const heads = (await p.locator(".gk-acc-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      for (const h of ["CREDITS", "DEBITS", "BALANCE"]) assert(heads.some((x) => x.startsWith(h)), `${h} column missing: ${heads.join(",")}`);
      const fmt = (n) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
      assert((await p.locator('td[data-total="credits"]').innerText()).includes(fmt(api0.summary.USD.credits)), "credits total");
      assert((await p.locator('td[data-total="debits"]').innerText()).includes(fmt(api0.summary.USD.debits)), "debits total");
      assert(new RegExp(`all ${api0.summary.USD.accounts} matching`).test(await p.locator('td[data-total="name"]').innerText()), "scope label");
      const row = p.locator(`tr[data-account-id="${ctx.acc.id}"]`);
      if (await row.count()) assert(/150\.00/.test(await row.locator('td[data-col="credits"]').innerText()) && /30\.25/.test(await row.locator('td[data-col="debits"]').innerText()), "row credits/debits");
    });
    await check("search (debounced) narrows the table and the KPIs", async () => {
      await p.getByLabel("Search customers").fill("Console Test"); await p.waitForTimeout(1000);
      assert(await kpi("accounts") === "1" && await p.locator(".gk-acc-table tbody tr").count() === 1, "search");
      await p.getByRole("button", { name: "Reset" }).click(); await p.waitForTimeout(900);
      assert(await kpi("accounts") === String(api0.summary.USD.accounts), "reset");
    });
    await check("Balance → Zero balance and the In debt card filter the accounts", async () => {
      await p.getByLabel("Balance", { exact: true }).selectOption("zero"); await p.waitForTimeout(900);
      const signs = await p.locator('.gk-acc-table tbody td[data-col="balance"] [data-sign]').evaluateAll((els) => els.map((e) => e.dataset.sign));
      assert(signs.length >= 1 && signs.every((x) => x === "zero"), signs.join(","));
      await p.locator('.gk-acc-kpi[data-kpi="debt"]').click(); await p.waitForTimeout(900);
      const s2 = await p.locator('.gk-acc-table tbody td[data-col="balance"] [data-sign]').evaluateAll((els) => els.map((e) => e.dataset.sign));
      assert(s2.every((x) => x === "neg"), s2.join(","));
      await p.getByRole("button", { name: "Reset" }).click(); await p.waitForTimeout(800);
    });
    await check("Sort by → Lowest balance orders the table", async () => {
      await p.getByLabel("Sort by").selectOption("balance_asc"); await p.waitForTimeout(900);
      const first = await p.locator('.gk-acc-table tbody tr').first().locator('[data-sign]').getAttribute("data-sign");
      assert(api0.summary.USD.inDebt === 0 || first === "neg", `first row sign ${first}`);
      await p.getByRole("button", { name: "Reset" }).click(); await p.waitForTimeout(600);
    });
    await check("Refresh reloads the data; Export downloads the matching accounts", async () => {
      await api(`/api/accounts/${ctx.acc.id}/deposit`, { method: "POST", token: ctx.adm, body: { amount: 1, currency: "USD" } });
      await p.getByRole("button", { name: "Refresh" }).click(); await p.waitForTimeout(1200);
      const fresh = await list(ctx.adm, "currency=USD&type=customer&sort=name");
      const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(fresh.summary.USD.totalHeld));
      assert((await kpi("held")).includes(fmt), "refresh did not reload");
      const [d] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.getByRole("button", { name: "Export" }).click()]);
      assert(/obo-accounts-usd\.xlsx$/.test(d.suggestedFilename()), d.suggestedFilename());
    });
    await check("View and Edit actions still open; the Company tab shows company accounts", async () => {
      await p.getByRole("button", { name: /^Edit /i }).first().click();
      await p.getByRole("dialog").waitFor({ timeout: 4000 });
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: /Cancel|Close|×/ }).first().click();
      await p.getByRole("tab", { name: "Company Accounts" }).click(); await p.waitForTimeout(900);
      const comp = await list(ctx.adm, "currency=USD&type=company&sort=name");
      assert(await kpi("accounts") === String(comp.summary.USD ? comp.summary.USD.accounts : 0), "company kpi");
    });
    await check("Accounts — SLSH uses SLSH figures only", async () => {
      await go("SLSH Accounts");
      assert(await p.locator("h1", { hasText: "Accounts — SLSH" }).count() === 1, "title");
      const s = await list(ctx.adm, "currency=SLSH&type=customer&sort=name");
      assert(await kpi("accounts") === String(s.summary.SLSH.accounts) && /SLSH/.test(await kpi("held")), "SLSH kpis");
    });
    await check("tablet and phone widths: KPIs wrap, no sideways page scrolling", async () => {
      for (const w of [900, 390]) {
        await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(400);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `${w}px overflow ${over}`);
        const cols = await p.locator(".gk-acc-kpis").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        assert(cols === 2, `${w}px kpi columns ${cols}`);
      }
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
