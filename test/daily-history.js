"use strict";
// DAILY FINANCIAL HISTORY round — automatic end-of-day snapshots (one per
// company-local day), recalculated with versions when a backdated change
// moves them, plus the Daily Financial Snapshots screen.
// On a throw-away database. Run with: npm run test:daily-history
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("dailyhist");
const PORT = Number(process.env.DAILY_HISTORY_TEST_PORT || 4684);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "1", SNAPSHOT_TICK_MS: "1000", FINMAN_TEST_MODE: "1" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, raw } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* none */ }
      return { status: r.status, json, text };
    } catch (e) { if (attempt >= 1) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.json; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { const v = c.value && typeof c.value === "object" && "result" in c.value ? c.value.result : c.value; out.push(v == null ? "" : String(v)); })));
  return out.join("\n");
}
const addDays = (d, n) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.DH_DEBUG ? "inherit" : "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await sleep(200); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

async function run() {
  const sa = ok(await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } }), "sa").token;
  const SA = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } }), "switch").token;
  // Company A's history before anything happens in company B.
  const A = ok(await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: PW } }), "amina").token;
  const aBefore = ok(await api("/api/daily-history?from=2000-01-01", { token: SA }), "A history");

  // A fresh company B: only what this test records.
  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "History Beta", admin: { name: "Hb Admin", username: "hb.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  // The Super Admin working inside company B records everything; the
  // company's own admin is given Daily Reports for the screen checks.
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  const hb = ok(await api("/api/users", { token: B }), "B users").users.find((u) => u.username === "hb.admin");
  ok(await api(`/api/users/${hb.id}/permissions`, { method: "PATCH", token: B, body: { overrides: ["dailyReports.view", "dailyReports.export", "cash.view"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } }), "grant hb");
  const today = ok(await api("/api/daily-history", { token: B }), "B today").today;
  const D = (n) => addDays(today, -n);
  const mk = async (name, currency) => ok(await api("/api/accounts", { method: "POST", token: B, body: { name, currency } }), name).account;
  const tillU = ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name: "Hb Till USD", type: "physical_cash", currency: "USD" } }), "tillU").account;
  const tillS = ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name: "Hb Till SLSH", type: "physical_cash", currency: "SLSH" } }), "tillS").account;
  const a = await mk("Hb Customer Alpha", "USD");
  const n = await mk("Hb Customer November", "USD");
  const s = await mk("Hb Customer Sierra", "SLSH");
  const mv = async (acc, kind, amount, currency, date, till) => ok(await api(`/api/accounts/${acc.id}/${kind}`, { method: "POST", token: B, body: { amount, currency, paymentDate: date, cashAccountId: till.id, notes: `Hb ${kind} ${date}` } }), `${kind} ${date}`);
  await mv(a, "deposit", 100, "USD", D(3), tillU);
  await mv(a, "withdraw", 30, "USD", D(2), tillU);
  await mv(n, "withdraw", 20, "USD", D(2), tillU);
  await mv(s, "deposit", 50000, "SLSH", D(2), tillS);

  console.log("\nAutomatic daily snapshots");
  let first;
  await check("1. the days are saved automatically by the scheduler — nobody opens the page", async () => {
    const t0 = Date.now();
    for (;;) {
      first = ok(await api(`/api/daily-history?from=${D(5)}&nosync=1`, { token: B }), "nosync");
      if (first.pageItems.filter((r) => r.status !== "pending").length >= 3) break;
      if (Date.now() - t0 > 15000) throw new Error(`not saved: ${JSON.stringify(first.pageItems.map((r) => [r.date, r.status]))}`);
      await sleep(700);
    }
    const days = first.pageItems.filter((r) => r.status === "saved").map((r) => r.date);
    for (const d of [D(3), D(2), D(1)]) assert(days.includes(d), `${d} missing: ${days.join(",")}`);
  });
  const day = (list, d) => list.pageItems.find((r) => r.date === d);
  await check("2. USD and SLSH are calculated each on its own (Debt + Cash Account − Credit)", async () => {
    const d3 = day(first, D(3)), d2 = day(first, D(2));
    assert(d3.usd.credit === 100 && d3.usd.cash === 100 && d3.usd.debt === 0 && d3.usd.balanceSheet === 0, JSON.stringify(d3.usd));
    assert(d2.usd.credit === 70 && d2.usd.debt === 20 && d2.usd.cash === 50 && d2.usd.balanceSheet === 0, JSON.stringify(d2.usd));
    assert(d3.slsh.cash === 0 && d2.slsh.cash === 50000 && d2.slsh.credit === 50000, JSON.stringify([d3.slsh, d2.slsh]));
    for (const r of first.pageItems) for (const k of ["usd", "slsh"]) assert(Math.abs(r[k].debt + r[k].cash - r[k].credit - r[k].balanceSheet) < 0.005, `${r.date} ${k} formula`);
  });
  await check("3. Cash Account totals match the actual ledger (each account and the total)", async () => {
    const d1 = day(first, D(1));
    const till = d1.cashAccounts.find((x) => x.id === tillU.id);
    const now = ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.find((x) => x.id === tillU.id);
    assert(till.closingBalance === 50 && now.balance === 50, `${till.closingBalance} vs ${now.balance}`);
    assert(d1.usd.cash === d1.cashAccounts.filter((x) => x.currency === "USD").reduce((t, x) => t + x.closingBalance, 0), "total");
  });
  await check("4. opening and closing balances reconcile day to day", async () => {
    const d3 = day(first, D(3)).cashAccounts.find((x) => x.id === tillU.id), d2 = day(first, D(2)).cashAccounts.find((x) => x.id === tillU.id);
    assert(d3.openingBalance === 0 && d3.cashIn === 100 && d3.closingBalance === 100, JSON.stringify(d3));
    assert(d2.openingBalance === d3.closingBalance && d2.cashOut === 50 && d2.closingBalance === d2.openingBalance + d2.cashIn - d2.cashOut + d2.transferIn - d2.transferOut + d2.exchangeIn - d2.exchangeOut, JSON.stringify(d2));
  });

  console.log("\nBackdated changes");
  await mv(n, "deposit", 5, "USD", D(3), tillU);
  let after;
  await check("5. a backdated transaction updates the day it is dated", async () => {
    const t0 = Date.now();
    for (;;) {
      after = ok(await api(`/api/daily-history?from=${D(5)}&nosync=1`, { token: B }), "after");
      if (day(after, D(3)).status === "updated") break;
      if (Date.now() - t0 > 15000) throw new Error(`not updated: ${JSON.stringify(day(after, D(3)))}`);
      await sleep(700);
    }
    const d3 = day(after, D(3));
    assert(d3.usd.credit === 105 && d3.usd.cash === 105 && d3.version === 2, JSON.stringify(d3));
    assert(/recorded later/.test(d3.reason) && /Super Admin/i.test(d3.reason), d3.reason);
  });
  await check("6. every later day is recalculated too; earlier days stay as they were", async () => {
    for (const d of [D(2), D(1)]) {
      const r = day(after, d);
      assert(r.status === "updated" && r.version === 2 && r.usd.debt === 15 && r.usd.cash === 55, `${d}: ${JSON.stringify(r)}`);
    }
    const d4 = day(after, D(4));
    if (d4) assert(d4.status === "saved" && d4.version === 1, `${D(4)} changed`);
  });
  await check("7. every version is kept with when, by what and why; the audit log records it", async () => {
    const v = ok(await api(`/api/daily-history/${D(3)}`, { token: B }), "versions").versions;
    assert(v.length === 2 && v[0].version === 1 && v[0].cashUsd === 100 && v[1].version === 2 && v[1].cashUsd === 105, JSON.stringify(v));
    assert(v[0].recordedAt && v[1].recordedBy && /Recalculated/.test(v[1].reason), JSON.stringify(v[1]));
    const audit = ok(await api("/api/reports/audit-log", { token: B }), "audit");
    const list = audit.entries || audit.audit || audit.rows || [];
    assert(JSON.stringify(list).includes("Daily history recalculated"), "audit entry missing");
  });
  await check("8. repeated runs never duplicate a day or add versions when nothing changed", async () => {
    for (let i = 0; i < 3; i++) ok(await api(`/api/daily-history?from=${D(5)}`, { token: B }), "again");
    await sleep(2500); // scheduler ticks too
    const x = ok(await api(`/api/daily-history?from=${D(5)}&nosync=1`, { token: B }), "x");
    const dates = x.pageItems.map((r) => r.date);
    assert(new Set(dates).size === dates.length, "duplicate day");
    assert(day(x, D(3)).version === 2, `version ${day(x, D(3)).version}`);
    assert(ok(await api(`/api/daily-history/${D(3)}`, { token: B }), "v").versions.length === 2, "extra version");
  });

  console.log("\nIsolation, filters, permissions and exports");
  await check("9. companies stay apart — company A's history did not move, and neither sees the other", async () => {
    const aNow = ok(await api("/api/daily-history?from=2000-01-01", { token: SA }), "A now");
    const strip = (l) => JSON.stringify(l.pageItems.filter((r) => r.status !== "pending").map((r) => [r.date, r.usd, r.slsh, r.version]));
    assert(strip(aNow) === strip(aBefore), "company A's saved days changed");
    assert(!JSON.stringify(aNow).includes("Hb Till"), "B's cash account in A");
    assert(!JSON.stringify(first).includes("Main Till"), "A's data in B");
  });
  await check("the selected day drives the cards (never today when another day is chosen); no snapshot → empty", async () => {
    const one = ok(await api(`/api/daily-history?from=${D(3)}&to=${D(3)}`, { token: B }), "one");
    assert(one.selected && one.selected.date === D(3) && one.selected.usd.cash === 105, JSON.stringify(one).slice(0, 700));
    assert(one.change === null, "no earlier day to compare with");
    const two = ok(await api(`/api/daily-history?from=${D(2)}&to=${D(2)}`, { token: B }), "two");
    assert(two.change && two.change.previousDate === D(3) && two.change.usd.cash === -50, JSON.stringify(two.change));
    assert(one.live && one.live.usd && one.live.usd.cash === 55, "live kept separate");
    const empty = ok(await api(`/api/daily-history?from=2001-01-01&to=2001-01-31`, { token: B }), "empty");
    assert(empty.selected === null && empty.total === 0, JSON.stringify(empty.selected));
    const def = ok(await api(`/api/daily-history`, { token: B }), "default");
    assert(def.selected.date === D(1) && def.selected.status !== "pending", `default selected ${def.selected.date}`);
    const td = ok(await api(`/api/daily-history?from=${today}&to=${today}`, { token: B }), "today");
    assert(td.selected.status === "pending", "today pending");
  });
  await check("latest first by default; ascending on request; total saved days", async () => {
    const l = ok(await api(`/api/daily-history?from=${D(5)}`, { token: B }), "l").pageItems.map((r) => r.date);
    assert(JSON.stringify(l) === JSON.stringify([...l].sort().reverse()), l.join(","));
    const asc = ok(await api(`/api/daily-history?from=${D(5)}&dir=asc`, { token: B }), "asc").pageItems.map((r) => r.date);
    assert(JSON.stringify(asc) === JSON.stringify([...asc].sort()), asc.join(","));
    assert(ok(await api(`/api/daily-history`, { token: B }), "c").savedDays >= 3, "savedDays");
  });
  await check("only authorized users: no Daily Reports view → 403; a USD-only user sees no SLSH", async () => {
    const users = ok(await api("/api/users", { token: SA }), "users").users;
    const sahra = users.find((u) => u.username === "sahra.ismail");
    await api(`/api/users/${sahra.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "dailyReports.view", granted: false }], confirmCritical: true } });
    const S1 = ok(await api("/api/auth/login", { method: "POST", body: { username: "sahra.ismail", password: PW } }), "sahra").token;
    assert((await api("/api/daily-history", { token: S1 })).status === 403, "viewer without permission");
    const xasan = users.find((u) => u.username === "xasan.cali");
    await api(`/api/users/${xasan.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "dailyReports.view", granted: true }, { permissionKey: "currency.slsh", granted: false }], confirmCritical: true } });
    const X = ok(await api("/api/auth/login", { method: "POST", body: { username: "xasan.cali", password: PW } }), "xasan").token;
    const h = ok(await api("/api/daily-history", { token: X }), "usd only");
    assert(h.pageItems.every((r) => !r.slsh && r.cashAccounts.every((c) => c.currency === "USD")), "SLSH shown");
  });
  await check("10. PDF and Excel exports carry the snapshot values (day and range)", async () => {
    const pdf = await api(`/api/daily-history/${D(3)}/export.pdf`, { token: B, raw: true });
    assert(pdf.status === 200, `pdf ${pdf.status} ${pdf.buf.toString().slice(0, 300)}`);
    const t = await pdfText(pdf.buf);
    assert(/DAILY FINANCIAL SNAPSHOT/.test(t) && t.includes("$105.00") && /UPDATED v2/.test(t), t.slice(0, 500));
    const x = await api(`/api/daily-history/export.xlsx?from=${D(3)}&to=${D(1)}`, { token: B, raw: true });
    assert(x.status === 200, `xlsx ${x.status}`);
    const xt = await xlsxText(x.buf);
    assert(xt.includes(D(3)) && xt.includes(D(1)) && /\b105\b/.test(xt) && /\b55\b/.test(xt) && /Updated \(v2\)/.test(xt), xt.slice(0, 600));
    const pr = await api(`/api/daily-history/export.pdf?from=${D(3)}&to=${D(1)}`, { token: B, raw: true });
    assert(pr.status === 200 && (await pdfText(pr.buf)).includes("$55.00"), "range pdf");
  });

  // ------------------------------------------------------------- browser
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  console.log("\nDaily Financial Snapshots screen");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("hb.admin"); await p.fill('input[type="password"]', "BetaPass-2026x"); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
    const nav = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*Daily Reports\s*$/ }).first();
    const group = p.locator(".gk-nav-group").filter({ has: nav });
    if (await group.count()) { const hd = group.first().locator(".gk-nav-group-header").first(); if ((await hd.getAttribute("aria-expanded")) === "false") { await hd.click(); await p.waitForTimeout(300); } }
    await nav.click(); await p.waitForTimeout(1500);
    const root = p.locator(".gk-dh");
    const cardVal = async (k) => (await root.locator(`.gk-dh-card[data-card="${k}"] .gk-dh-card-value`).innerText()).trim();
    await check("header, company, four cards for the latest saved day, the table and its total", async () => {
      assert(/Daily Financial Snapshots/.test(await root.innerText()) && /History Beta/.test(await root.innerText()), "header");
      assert(await root.locator(".gk-dh-card").count() === 4, "cards");
      assert((await root.locator(".gk-dh-asof").innerText()).includes(D(1)), await root.locator(".gk-dh-asof").innerText());
      assert(await cardVal("cashUsd") === "$55.00" && await cardVal("cashSlsh") === "SLSH 50,000", `${await cardVal("cashUsd")} ${await cardVal("cashSlsh")}`);
      const heads = (await root.locator("table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      for (const w of ["#", "DATE", "BALANCE SHEET (USD)", "BALANCE SHEET (SLSH)", "CASH ACCOUNT (USD)", "CASH ACCOUNT (SLSH)", "STATUS", "ACTION"]) assert(heads.includes(w), heads.join(" | "));
      assert(await root.locator("tbody tr[data-date]").first().getAttribute("data-date") === today, "latest first");
      assert(/saved day/i.test(await root.locator(".gk-dh-total").innerText()), "total");
      const hdr = await root.locator("table thead th").nth(1).evaluate((e) => getComputedStyle(e).backgroundColor);
      assert(hdr === "rgb(15, 61, 56)", `header ${hdr}`);
    });
    await check("status badges: Saved / Updated / Pending", async () => {
      const st = async (d) => (await root.locator(`tbody tr[data-date="${d}"] [data-status]`).getAttribute("data-status"));
      assert(await st(D(3)) === "updated" && await st(today) === "pending", `${await st(D(3))} ${await st(today)}`);
    });
    await check("View Details expands that day in place (Balance Sheet and Cash Account details); Close Details hides it", async () => {
      await root.locator(`tbody tr[data-date="${D(2)}"]`).getByRole("button", { name: /View Details/ }).click(); await p.waitForTimeout(700);
      const det = root.locator(".gk-dh-detail");
      const t = await det.innerText();
      for (const w of ["Total Debt (USD)", "Total Cash Account (USD)", "Total Credit (USD)", "Balance Sheet (SLSH)", "Opening", "Cash In", "Cash Out", "Transfers In", "Exchange Out", "Closing"]) assert(t.includes(w), `${w} missing`);
      assert(/Hb Till Usd/i.test(t) && t.includes("$55.00"), t.slice(0, 300));
      await det.getByRole("button", { name: /Close Details/ }).click(); await p.waitForTimeout(300);
      assert(await root.locator(".gk-dh-detail").count() === 0, "not closed");
    });
    await check("changing the date moves the cards, the table and the details together (with a loading state)", async () => {
      await root.getByLabel("Period").selectOption("custom"); await p.waitForTimeout(200);
      await root.getByLabel("From date").fill(D(2)); await root.getByLabel("To date").fill(D(2)); await p.waitForTimeout(1500);
      assert((await root.locator(".gk-dh-asof").innerText()).includes(D(2)), "as-of");
      assert(await cardVal("cashUsd") === "$55.00" && await cardVal("cashSlsh") === "SLSH 50,000", await cardVal("cashUsd"));
      assert(await root.locator("tbody tr[data-date]").count() === 1, "table not filtered");
      assert(/vs/.test(await root.locator(".gk-dh-cards").innerText()), "difference vs previous day");
    });
    await check("a period with no snapshot shows an empty state, not other balances", async () => {
      await root.getByLabel("From date").fill("2001-01-01"); await root.getByLabel("To date").fill("2001-01-05"); await p.waitForTimeout(1500);
      assert(/No snapshot/i.test(await root.innerText()) && await root.locator(".gk-dh-card-value").count() === 0, "empty state");
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
