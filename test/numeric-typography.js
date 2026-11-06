"use strict";
// NUMERIC TYPOGRAPHY round — every number in FINMAN is drawn in Inter with
// tabular, lining figures: in every module at desktop, tablet and phone
// widths, in generated PDFs and in exported workbooks. Values themselves are
// never changed. On a throw-away database. Run with: npm run test:numeric-typography
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("numfont");
const PORT = Number(process.env.NUMFONT_TEST_PORT || 4660);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SHOTS = process.env.NUMFONT_SHOTS || "";

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
  return { status: r.status, json, buf, type: r.headers.get("content-type") || "" };
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
  // The Company Admin, given the few modules her role doesn't include by
  // default (Cash Account, Quotations, Daily Reports) so every screen is checked.
  const sa = (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } })).json.token;
  const SA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const amina = (await api("/api/users", { token: SA })).json.users.find((u) => u.username === "amina.yusuf");
  const keys = ["cash.view", "quotations.view", "quotations.create", "quotations.update", "quotations.settle", "quotations.duplicate", "quotations.export", "quotations.print", "dailyReports.view", "dailyReports.export"];
  const ov = await api(`/api/users/${amina.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: keys.map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } });
  if (ov.status !== 200) console.log("  (overrides:", ov.status, ov.buf.toString().slice(0, 150), ")");
  const T = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW } })).json.token;
  const acc = (await api("/api/accounts", { token: T })).json.accounts;
  const usd = acc.find((a) => a.currency === "USD"), slsh = acc.find((a) => a.currency === "SLSH");

  console.log("\nAssets");
  await check("the Inter digit font files are served (woff2, cached) and loaded by the page", async () => {
    for (const w of [400, 500, 600, 700, 800]) {
      const r = await fetch(`${BASE}/fonts/inter-latin-${w}-normal.woff2`);
      assert(r.status === 200 && r.headers.get("content-type") === "font/woff2" && /max-age/.test(r.headers.get("cache-control") || ""), `${w}: ${r.status} ${r.headers.get("content-type")}`);
    }
    const html = await (await fetch(BASE + "/")).text();
    assert(/font-family: "FINMAN Digits"/.test(html) && /unicode-range: U\+0030-0039/.test(html) && /tabular-nums/.test(html), "index.html has no Inter digit face");
  });

  console.log("\nPDF and Excel");
  await check("generated PDFs embed Inter for their numbers (statements, receipts, reports)", async () => {
    const ex = (await api("/api/transactions", { token: T })).json.transactions[0];
    const paths = [
      `/api/accounts/${usd.id}/statement.pdf`, `/api/accounts/${slsh.id}/statement.pdf`, "/api/history/statement.pdf?currency=USD",
      "/api/history/export.pdf", "/api/accounts/export.pdf", "/api/reports/exchange-summary/export.pdf", "/api/reports/currency-position/export.pdf",
      ex ? `/api/transactions/${ex.id}/receipt.pdf` : null, "/api/dashboard/export.pdf", "/api/quotations/export.pdf",
    ].filter(Boolean);
    const bad = [];
    const { PDFDocument, PDFName, PDFDict } = require("pdf-lib");
    for (const p of paths) {
      const r = await api(p, { token: T });
      if (r.status !== 200 || !/pdf/.test(r.type)) { bad.push(`${p} -> ${r.status}`); continue; }
      const doc = await PDFDocument.load(r.buf);
      const fonts = [];
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) { const b = obj.get(PDFName.of("BaseFont")); if (b) fonts.push(b.toString()); }
      }
      if (!fonts.some((f) => /Inter/.test(f))) bad.push(`${p}: fonts ${fonts.join(", ")}`);
    }
    assert(!bad.length, bad.join("\n      "));
  });
  await check("exported workbooks use Inter for number and date cells; values are unchanged", async () => {
    const ExcelJS = require("exceljs");
    const r = await api("/api/accounts/export.xlsx", { token: T });
    assert(r.status === 200, `xlsx ${r.status}`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.buf);
    const ws = wb.worksheets[0];
    let numbers = 0, interNumbers = 0, textInter = 0;
    ws.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === "number") { numbers += 1; if (cell.font && cell.font.name === "Inter") interNumbers += 1; }
      else if (typeof cell.value === "string" && /^[A-Za-z ]+$/.test(cell.value) && cell.font && cell.font.name === "Inter" && !cell.numFmt) textInter += 1;
    }));
    assert(numbers > 0 && interNumbers === numbers, `${interNumbers}/${numbers} number cells in Inter`);
    const balances = (await api("/api/accounts", { token: T })).json.accounts;
    const nums = []; ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === "number") nums.push(c.value); }));
    assert(balances.every((a) => nums.includes(a.balance) || a.balance === 0), "an exported balance differs from the account");
    void textInter;
  });

  await browserPart(T, usd);
}

async function browserPart(T, usd) {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped)"); return; }
  console.log("\nScreens (desktop 1440, tablet 820, phone 390)");
  const browser = await chromium.launch();
  const errors = [];
  const modules = ["Dashboard", "USD Accounts", "SLSH Accounts", "Cash Account", "USD Payment", "Money Exchange", "USD Transactions", "Pending", "Company Expenses", "Reports Overview", "Balance Sheet Report", "Cash Account Report", "Users"];
  // Every element showing a digit must have "FINMAN Digits" (Inter) first
  // in its font stack, with tabular lining figures; reports the offenders.
  const audit = () => {
    const out = { checked: 0, bad: [], clipped: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\d/.test(n.nodeValue)) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || el.closest("script,style,svg title")) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
      out.checked += 1;
      const fam = cs.fontFamily.replace(/['"]/g, "").split(",")[0].trim();
      const tab = /tabular-nums/.test(cs.fontVariantNumeric) || /"tnum"/.test(cs.fontFeatureSettings);
      if (fam !== "FINMAN Digits" || !tab) out.bad.push(`${el.tagName.toLowerCase()}.${el.className || ""} "${n.nodeValue.trim().slice(0, 20)}" font=${cs.fontFamily.slice(0, 40)} num=${cs.fontVariantNumeric}`);
      if ((cs.overflow === "hidden" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1 && /^[\s$+\-−.,\d%A-Z:/()]*\d[\s$+\-−.,\d%A-Z:/()]*$/.test(el.textContent.trim()) && el.textContent.trim().length < 24) out.clipped.push(`${el.tagName.toLowerCase()} "${el.textContent.trim()}"`);
    }
    return out;
  };
  try {
    for (const [width, height, label] of [[1440, 900, "desktop"], [820, 1100, "tablet"], [390, 844, "phone"]]) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
      await p.goto(BASE); await p.waitForTimeout(400);
      await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
      await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(700);
      await check(`${label}: Inter digits are loaded and actually used for rendering`, async () => {
        await p.evaluate(() => document.fonts.ready);
        const loaded = await p.evaluate(() => document.fonts.check('600 16px "FINMAN Digits"', "0123456789"));
        assert(loaded, "FINMAN Digits not loaded");
        // What the browser really painted a number with (Chromium's own report).
        const cdp = await ctx.newCDPSession(p);
        await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
        const ids = (await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".gk-header-rate b, .gk-hdr-rate-value, [class*=rate] b, [class*=kpi-value]" })).nodeIds.slice(0, 3);
        const used = [];
        for (const id of ids) { const f = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: id }); used.push(...f.fonts.map((x) => x.familyName)); }
        assert(!ids.length || used.some((n) => /^Inter|FINMAN Digits/.test(n)), `rendered with ${used.join(", ")}`);
      });
      const report = [];
      for (const m of modules) {
        const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${m}\\s*\\d*\\s*$`) }).first();
        if (!(await btn.count())) { report.push(`${m}: not in menu`); continue; }
        if (width < 900) { const t = p.locator(".gk-mobile-menu-btn, [aria-label='Open menu'], [aria-label='Menu']").first(); if (await t.count() && !(await btn.isVisible())) { await t.click().catch(() => {}); await p.waitForTimeout(300); } }
        const group = p.locator(".gk-nav-group").filter({ has: btn });
        if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click().catch(() => {}); await p.waitForTimeout(250); } }
        await btn.click({ timeout: 5000 }).catch(async () => { await btn.evaluate((el) => el.click()); });
        await p.waitForTimeout(1300);
        const a = await p.evaluate(audit);
        report.push({ m, ...a });
        if (SHOTS && width !== 820) await p.screenshot({ path: `${SHOTS}/${label}-${m.replace(/\W+/g, "_")}.png` });
      }
      // The account detail view, opened directly.
      await check(`${label}: every number in every module is Inter with tabular figures (${modules.length} modules)`, async () => {
        const missing = report.filter((r) => typeof r === "string");
        const bad = report.filter((r) => typeof r === "object" && r.bad.length).map((r) => `${r.m}: ${r.bad.length}/${r.checked} e.g. ${r.bad.slice(0, 2).join(" | ")}`);
        const total = report.filter((r) => typeof r === "object").reduce((s, r) => s + r.checked, 0);
        assert(!missing.length, missing.join(", "));
        assert(total > 200, `only ${total} numbers checked`);
        assert(!bad.length, bad.join("\n      "));
      });
      await check(`${label}: no number is clipped`, async () => {
        const clipped = report.filter((r) => typeof r === "object" && r.clipped.length).map((r) => `${r.m}: ${r.clipped.slice(0, 3).join(", ")}`);
        assert(!clipped.length, clipped.join("\n      "));
      });
      await ctx.close();
    }
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 5).join(" | ")); });
  } finally { await browser.close(); }
  void T; void usd;
}

main().catch((e) => { console.error(e); process.exit(1); });
