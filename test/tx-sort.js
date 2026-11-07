"use strict";
// UNIFIED TRANSACTION SORTING round — the "Sort:" control on Cash Movements,
// Cash Transfers, Cash Exchanges, a Cash Account's own view and the USD /
// SLSH Account View: five options, page groups newest first (Page 1 = the
// newest transactions) with the chosen order inside the page, remembered
// per table; footers, balances and records unchanged.
// On a throw-away database. Run with: npm run test:tx-sort
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("txsort");
const PORT = Number(process.env.TX_SORT_TEST_PORT || 4688);
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
async function api(p, { method = "GET", body, token, raw, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.TS_DEBUG ? "inherit" : "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await sleep(200); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

async function run() {
  const sa = ok(await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } }), "sa").token;
  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Sort Beta", admin: { name: "Ts Admin", username: "ts.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  const ts = ok(await api("/api/users", { token: B }), "users").users.find((u) => u.username === "ts.admin");
  ok(await api(`/api/users/${ts.id}/permissions`, { method: "PATCH", token: B, body: { overrides: ["cash.view"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } }), "grant");
  const today = new Date().toISOString().slice(0, 10);
  const day = (n, h = 10) => `${addDays(today, -n)}T${String(h).padStart(2, "0")}:00:00.000Z`;
  const cash = async (name, currency) => ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name, type: "physical_cash", currency } }), name).account;
  const tillU = await cash("Ts Till USD", "USD"), safeU = await cash("Ts Safe USD", "USD"), tillS = await cash("Ts Till SLSH", "SLSH");
  const acc = async (name, currency) => ok(await api("/api/accounts", { method: "POST", token: B, body: { name, currency } }), name).account;
  const au = await acc("Ts Usd Customer", "USD"), as = await acc("Ts Slsh Customer", "SLSH");
  // Posted out of date order, so reference order ≠ date order ≠ amount order.
  const order = [7, 2, 12, 5, 0, 9, 3, 11, 6, 1, 10, 4, 8];
  const amounts = [130, 15, 990, 47, 260, 5, 610, 88, 333, 72, 1200, 19, 545];
  for (const [i, n] of order.entries()) {
    ok(await api(`/api/accounts/${au.id}/deposit`, { method: "POST", token: B, body: { amount: amounts[i], currency: "USD", paymentDate: day(n + 1, 9 + (i % 5)), cashAccountId: tillU.id, notes: `Ts usd ${i}` } }), "usd dep");
    ok(await api(`/api/accounts/${as.id}/deposit`, { method: "POST", token: B, body: { amount: amounts[i] * 1000, currency: "SLSH", paymentDate: day(n + 1, 9 + (i % 5)), cashAccountId: tillS.id, notes: `Ts slsh ${i}` } }), "slsh dep");
  }
  for (const [i, n] of order.slice(0, 12).entries()) {
    ok(await api("/api/cash/transfers", { method: "POST", token: B, body: { fromCashAccountId: tillU.id, toCashAccountId: safeU.id, amount: (i + 1) * 3, date: day(n + 1, 15), notes: `Ts tr ${i}` } }), "transfer");
    ok(await api("/api/cash/exchanges", { method: "POST", token: B, body: { fromCashAccountId: tillU.id, toCashAccountId: tillS.id, amountGiven: (13 - i) * 2, rateUsed: 8500, date: day(n + 1, 16), notes: `Ts ex ${i}` } }), "exchange");
  }
  for (const [i, n] of order.slice(0, 12).entries()) {
    ok(await api("/api/transactions", { method: "POST", token: B, body: { clientName: `Ts Walkin ${i}`, amountGiven: (i % 2 ? 1 : 1000) * (20 + ((i * 37) % 90)), currencyGiven: i % 2 ? "USD" : "SLSH", rateUsed: 8500, date: day(n + 1, 11), notes: `Ts mx ${i}` } }), "money exchange");
    ok(await api("/api/quotations", { method: "POST", token: B, body: { clientName: "Ts Usd Customer", accountId: au.id, currency: "USD", issueDate: addDays(today, -(n + 1)), items: [{ description: `Ts item ${i}`, qty: 1, unitPrice: 10 + ((i * 53) % 400), currency: "USD" }] } }), "quotation");
  }
  const before = {
    usd: ok(await api(`/api/accounts/${au.id}`, { token: B }), "au").account.balance,
    cash: JSON.stringify(ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.map((a) => [a.id, a.balance]).sort()),
  };
  const apiData = {
    transfers: ok(await api("/api/cash/transfers", { token: B }), "tr").transfers,
    exchanges: ok(await api("/api/cash/exchanges", { token: B }), "ex").exchanges,
  };

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "warning" && /Unknown icon/.test(m.text())) errors.push(m.text()); });
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("ts.admin"); await p.fill('input[type="password"]', "BetaPass-2026x"); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
    const go = async (label) => {
      const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}(\\s*\\d+)?\\s*$`) }).first();
      const group = p.locator(".gk-nav-group").filter({ has: btn });
      if (await group.count()) { const hd = group.first().locator(".gk-nav-group-header").first(); if ((await hd.getAttribute("aria-expanded")) === "false") { await hd.click(); await p.waitForTimeout(300); } }
      await btn.click(); await p.waitForTimeout(1300);
    };
    // The visible rows of a table: reference, date text, amounts (number) and currency per row.
    const read = async (table) => table.evaluate((t) => {
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.innerText.trim().toLowerCase());
      const ix = (re) => heads.findIndex((h) => re.test(h));
      const iRef = ix(/^(reference|quotation$)/), iDate = ix(/^date/), iCr = ix(/^(credit|given|total)/), iDr = ix(/^debit/);
      const num = (s) => { const m = String(s || "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
      return [...t.querySelectorAll("tbody tr")].filter((tr) => tr.querySelectorAll("td").length > 3).map((tr) => {
        const td = [...tr.querySelectorAll("td")];
        const cell = (i) => (i >= 0 && td[i] ? td[i].innerText.trim() : "");
        return { ref: cell(iRef).split("\n")[0], key: cell(iRef).split("\n")[0] || `${cell(iDate)}|${cell(iCr)}|${cell(1)}|${cell(2)}`, date: cell(iDate), cr: num(cell(iCr)), dr: num(cell(iDr)), crText: cell(iCr), drText: cell(iDr) };
      });
    });
    const sortBtn = (id) => p.locator(`#${id}`);
    const choose = async (id, opt) => { await sortBtn(id).click(); await p.waitForTimeout(150); await p.locator(`.gk-txsort-menu [data-sort-option="${opt}"]`).click(); await p.waitForTimeout(300); };
    const amountOf = (r) => (r.cr != null ? r.cr : r.dr);
    const isSorted = (arr, cmp) => arr.every((x, i) => i === 0 || cmp(arr[i - 1], x) <= 0);
    // Checks shared by every module: default + label, all five options, page groups, persistence.
    const fiveOptions = async (label, { id, table, expectedPage1Refs, olderPage2 = true, amountKey = amountOf, nextBtn }) => {
      await check(`${label}: "Sort: Oldest First" by default — Page 1 holds the newest group, oldest → newest inside`, async () => {
        assert(/Sort:\s*Oldest First/.test(await sortBtn(id).innerText()), await sortBtn(id).innerText());
        const r = await read(table());
        assert(r.length === 10, `rows ${r.length}`);
        if (expectedPage1Refs) assert(JSON.stringify(r.map((x) => x.ref).sort()) === JSON.stringify([...expectedPage1Refs].sort()), `page 1 ${r.map((x) => x.ref).join(",")} vs ${expectedPage1Refs.join(",")}`);
        assert(isSorted(r, (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) || isSorted(r.map((x) => new Date(x.date.replace(/\n/g, " ")).getTime() || 0), (a, b) => a - b), `not oldest-first: ${r.map((x) => x.date.replace(/\n/g, " ")).join(" | ")}`);
      });
      let p1;
      await check(`${label}: Newest First reverses the page; Highest / Lowest Amount; Reference A–Z — same rows on Page 1`, async () => {
        p1 = await read(table());
        const set = JSON.stringify(p1.map((x) => x.key).sort());
        await choose(id, "newest");
        const n = await read(table());
        assert(JSON.stringify(n.map((x) => x.key)) === JSON.stringify([...p1].reverse().map((x) => x.key)), `newest ${n.map((x) => x.key).join(",")}`);
        await choose(id, "highest");
        const h = await read(table());
        const grp = (rows) => { const g = {}; for (const x of rows) (g[/SLSH/.test(x.crText + x.drText) ? "S" : "U"] = g[/SLSH/.test(x.crText + x.drText) ? "S" : "U"] || []).push(amountKey(x)); return Object.values(g); };
        for (const g of grp(h)) assert(isSorted(g, (a, b) => b - a), `highest ${h.map(amountKey).join(",")}`);
        await choose(id, "lowest");
        const l = await read(table());
        for (const g of grp(l)) assert(isSorted(g, (a, b) => a - b), `lowest ${l.map(amountKey).join(",")}`);
        await choose(id, "reference");
        const rf = await read(table());
        assert(isSorted(rf.map((x) => x.ref), (a, b) => collator.compare(a, b)), `reference ${rf.map((x) => x.ref).join(",")}`);
        for (const v of [n, h, l, rf]) assert(JSON.stringify(v.map((x) => x.key).sort()) === set, "a sort changed which rows are on Page 1");
        assert(/Sort:\s*Reference/.test(await sortBtn(id).innerText()), "label");
      });
      await check(`${label}: Page 2 holds older transactions — no duplicates, none missing`, async () => {
        await choose(id, "oldest");
        const nb = nextBtn();
        await nb.click(); await p.waitForTimeout(400);
        const p2 = await read(table());
        assert(p2.length >= 1, "page 2 empty");
        const dup = p2.filter((x) => p1.some((y) => y.key === x.key));
        assert(!dup.length, `duplicated ${dup.map((x) => x.key).join(",")}`);
        await p.getByRole("button", { name: "Previous" }).first().click(); await p.waitForTimeout(300);
      });
    };
    const nextOf = (wrap) => () => wrap().getByRole("button", { name: "Next" }).first();

    // ---------- Cash Movements
    console.log("\nCash Movements");
    await go("Cash Account");
    await p.getByRole("tab", { name: /Cash Movements/ }).first().click().catch(async () => { await p.getByText("Cash Movements", { exact: true }).first().click(); });
    await p.waitForTimeout(1200);
    const mvTable = () => p.locator("table.gk-table").filter({ has: p.locator("thead th", { hasText: /Movement Type/i }) }).first();
    await check("the sort control: emerald border, icon left, chevron right, five options with icons", async () => {
      const b = sortBtn("cash-movements-sort");
      assert(await b.locator("svg").count() === 2, "icons");
      assert(await b.evaluate((e) => getComputedStyle(e).borderTopColor) === "rgb(16, 185, 129)", "border");
      await b.click(); await p.waitForTimeout(150);
      const opts = await p.locator(".gk-txsort-menu [data-sort-option]").allInnerTexts();
      assert(opts.map((x) => x.trim()).join("|") === "Oldest First|Newest First|Highest Amount First|Lowest Amount First|Reference (A–Z)", opts.join("|"));
      assert(await p.locator(".gk-txsort-menu [data-sort-option] svg").count() >= 6, "option icons + check");
      await p.keyboard.press("Escape"); await p.waitForTimeout(150);
      assert(await p.locator(".gk-txsort-menu").count() === 0, "Escape did not close");
    });
    await fiveOptions("Cash Movements", { id: "cash-movements-sort", table: mvTable, nextBtn: nextOf(() => p.locator(".gk-table-wrap").filter({ has: mvTable() })),
      amountKey: (r) => amountOf(r) });
    await check("Cash Movements: amounts never compared across USD and SLSH (USD rows first, then SLSH)", async () => {
      await choose("cash-movements-sort", "highest");
      const r = await read(mvTable());
      const curs = r.map((x) => (/SLSH/.test(x.crText + x.drText) ? "SLSH" : "USD"));
      const firstS = curs.indexOf("SLSH");
      assert(firstS === -1 || curs.slice(firstS).every((x) => x === "SLSH"), curs.join(","));
      await choose("cash-movements-sort", "oldest");
    });

    // ---------- Transfers / Exchanges
    const recTable = (re) => () => p.locator("table.gk-table").filter({ has: p.locator("thead th", { hasText: re }) }).first();
    const newest10 = (list) => [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 10).map((x) => x.referenceNumber);
    console.log("\nCash Transfers");
    await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(1200);
    await fiveOptions("Cash Transfers", { id: "cash-transfers-sort", table: recTable(/^From Cash Account/i), expectedPage1Refs: newest10(apiData.transfers), nextBtn: nextOf(() => p.locator(".gk-table-wrap").first()) });
    console.log("\nCash Exchanges");
    await p.getByText("Exchanges", { exact: true }).first().click(); await p.waitForTimeout(1200);
    await fiveOptions("Cash Exchanges", { id: "cash-exchanges-sort", table: recTable(/^Rate/i), expectedPage1Refs: newest10(apiData.exchanges), nextBtn: nextOf(() => p.locator(".gk-table-wrap").first()),
      amountKey: (r) => r.dr });
    await check("Cash Exchanges: the choice is remembered after a reload", async () => {
      await choose("cash-exchanges-sort", "lowest");
      await p.reload(); await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
      await go("Cash Account");
      await p.getByText("Exchanges", { exact: true }).first().click(); await p.waitForTimeout(1200);
      assert(/Sort:\s*Lowest Amount First/.test(await sortBtn("cash-exchanges-sort").innerText()), await sortBtn("cash-exchanges-sort").innerText());
      assert(/Sort:\s*Oldest First/.test(await (async () => { await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(800); return sortBtn("cash-transfers-sort").innerText(); })()), "transfers kept its own choice");
      await p.getByText("Exchanges", { exact: true }).first().click(); await p.waitForTimeout(800);
      await choose("cash-exchanges-sort", "oldest");
    });
    await check("a new transfer saved: back to Page 1 and on it, footer count updated", async () => {
      await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(800);
      await nextOf(() => p.locator(".gk-table-wrap").first())().click(); await p.waitForTimeout(300);
      ok(await api("/api/cash/transfers", { method: "POST", token: B, body: { fromCashAccountId: tillU.id, toCashAccountId: safeU.id, amount: 77, notes: "Ts new transfer" } }), "new transfer");
      await p.getByText("Exchanges", { exact: true }).first().click(); await p.waitForTimeout(500);
      await p.getByText("Transfers", { exact: true }).first().click(); await p.waitForTimeout(1200);
      const t = recTable(/^From Cash Account/i)();
      assert(/Showing 1 to 10 of 13/.test(await p.locator(".gk-table-wrap").first().innerText()), "not page 1 / count");
      assert(/Ts new transfer/.test(await t.innerText()), "new transfer not on Page 1");
    });

    // ---------- Cash Account view
    console.log("\nCash Account view");
    await p.getByText("Cash Accounts", { exact: true }).first().click(); await p.waitForTimeout(1000);
    await p.locator("table.gk-table tbody").getByText(/Ts Till Usd/i).first().click(); await p.waitForTimeout(1800);
    const cvTable = () => p.locator("table.gk-table").filter({ has: p.locator("thead th", { hasText: /^Date/i }) }).first();
    await fiveOptions("Cash Account view", { id: "cash-account-view-sort", table: cvTable, nextBtn: nextOf(() => p.locator(".gk-table-wrap").filter({ has: cvTable() })) });

    // ---------- Account View USD / SLSH
    for (const [cur, a] of [["USD", au], ["SLSH", as]]) {
      console.log(`\n${cur} Account View`);
      await go(`${cur} Accounts`);
      await p.locator("table.gk-table tbody").getByText(new RegExp(`^Ts ${cur === "USD" ? "Usd" : "Slsh"} Customer`, "i")).first().click(); await p.waitForTimeout(1800);
      const avTable = () => p.locator("table.gk-table").filter({ has: p.locator("thead th", { hasText: /^Balance/i }) }).filter({ has: p.locator("thead th", { hasText: /^Status/i }) }).first();
      await fiveOptions(`${cur} Account View`, { id: "account-view-sort", table: avTable, nextBtn: nextOf(() => p.locator(".gk-table-wrap, .gk-av-table, section").filter({ has: avTable() }).last()) });
      await check(`${cur} Account View: running balances are the stored ones, footer covers every page`, async () => {
        const d = ok(await api(`/api/accounts/${a.id}`, { token: B }), "acct");
        const t = avTable();
        const foot = await t.locator("tfoot").innerText();
        const total = amounts.reduce((n, x) => n + x, 0) * (cur === "USD" ? 1 : 1000);
        assert(foot.replace(/,/g, "").includes(String(total)), `footer ${foot}`);
        const bal = await t.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.innerText));
        const stored = d.ledger.map((l) => Number(l.balanceAfter));
        assert(bal.length === 10 && stored.length >= 13, `${bal.length} ${stored.length}`);
      });
    }

    // ---------- Payments, Money Exchange, Quotations, Transaction History
    console.log("\nUSD Payment");
    await go("USD Payment");
    const tableWith = (re) => () => p.locator("table.gk-table").filter({ has: p.locator("thead th", { hasText: re }) }).first();
    const wrapOf = (tf) => () => p.locator(".gk-table-wrap").filter({ has: tf() }).first();
    const payT = tableWith(/^Origin|^Cash Account/i);
    await fiveOptions("USD Payment", { id: "payments-sort", table: payT, nextBtn: nextOf(wrapOf(payT)) });
    console.log("\nMoney Exchange");
    await go("Money Exchange");
    const exT = tableWith(/^Given/i);
    await fiveOptions("Money Exchange", { id: "exchange-sort", table: exT, nextBtn: nextOf(wrapOf(exT)) });
    console.log("\nQuotations");
    await go("Pending");
    const qT = tableWith(/^Valid until/i);
    await fiveOptions("Quotations", { id: "quotations-sort", table: qT, nextBtn: nextOf(wrapOf(qT)) });
    console.log("\nUSD Transaction History");
    await go("USD Transactions");
    const hT = () => p.locator("table.gk-th-table").first();
    await fiveOptions("USD Transaction History", { id: "history-sort", table: hT, nextBtn: nextOf(() => p.locator(".gk-th-table-wrap").first()) });

    await check("nothing changed: balances and records exactly as before", async () => {
      const usd = ok(await api(`/api/accounts/${au.id}`, { token: B }), "au").account.balance;
      assert(usd === before.usd, `${usd} vs ${before.usd}`);
      const cashNow = ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.map((x) => [x.id, x.balance]).sort();
      const was = JSON.parse(before.cash);
      // only the one new transfer moved $77 between the two USD tills
      const diff = cashNow.map(([id, b]) => b - was.find((w) => w[0] === id)[1]);
      assert(JSON.stringify(diff.map((x) => Math.round(x * 100) / 100).sort((x, y) => x - y)) === JSON.stringify([-77, 0, 77]), JSON.stringify(diff));
    });
    await check("phone width: the sort control is full width, no page overflow", async () => {
      await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(500);
      const [w, pw] = await sortBtn("account-view-sort").evaluate((e) => { const bar = e.closest(".gk-filterbar"); const cs = getComputedStyle(bar); return [e.getBoundingClientRect().width, bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)]; });
      assert(w >= pw - 2, `width ${w} of ${pw}`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(over <= 1, `overflow ${over}`);
    });
    await check("no page errors, no unknown icons", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
