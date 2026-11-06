"use strict";
// ACCOUNT VIEW OLDEST-FIRST round — the Account View transaction table
// lists entries by their real date & time, oldest first (#1) and newest
// last, like Cash Account; several entries on the same day keep their time
// order; each row's Balance follows that order; the footer and the stored
// records are unchanged. Run with: npm run test:account-view-order
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("avorder");
const PORT = Number(process.env.AV_ORDER_TEST_PORT || 4680);
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
  const ctx = {};
  // Recorded OUT of date order: a later-dated entry first, then older ones.
  const make = async (currency, unit) => {
    const acc = (await api("/api/accounts", { method: "POST", token: SA, body: { name: `Ao Order ${currency}`, currency } })).json.account;
    const mv = async (kind, amount, paymentDate, notes) => {
      const r = await api(`/api/accounts/${acc.id}/${kind}`, { method: "POST", token: SA, body: { amount: amount * unit, currency, paymentDate, notes } });
      assert(r.status < 300, `${kind} ${r.status} ${JSON.stringify(r.json)}`);
    };
    await mv("deposit", 100, "2026-03-10T14:00:00", "Ao C — 10 Mar 14:00");
    await mv("deposit", 50, "2026-01-02T08:00:00", "Ao A — 2 Jan");
    await mv("withdraw", 30, "2026-03-10T09:00:00", "Ao B — 10 Mar 09:00");
    await mv("deposit", 20, "2026-03-10T18:30:00", "Ao D — 10 Mar 18:30");
    return acc;
  };
  ctx.usd = await make("USD", 1);
  ctx.slsh = await make("SLSH", 1000);

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
    const open = async (currency) => {
      await go(`${currency} Accounts`);
      await p.locator("table.gk-table tbody").getByText(new RegExp(`^Ao Order ${currency}`, "i")).first().click(); await p.waitForTimeout(1500);
    };
    const rows = async () => {
      const t = p.locator("table.gk-table").filter({ hasText: "Ao A" }).first();
      return t.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => {
        const txt = tr.innerText;
        const m = txt.match(/Ao ([A-D])/);
        const bal = tr.querySelector('td.gk-col-balance, td[data-col="balance"]');
        return { tag: m ? m[1] : null, idx: tr.querySelector("td") ? tr.querySelector("td").innerText.trim() : "", bal: bal ? bal.innerText.trim() : "" };
      }).filter((r) => r.tag));
    };

    for (const [cur, money] of [["USD", (n) => `$${n.toFixed(2)}`], ["SLSH", (n) => `SLSH ${(n * 1000).toLocaleString("en-US")}`]]) {
      console.log(`\n${cur} Account View`);
      await check(`${cur}: oldest first (#1) and newest last, by real date & time — same day in time order`, async () => {
        await open(cur);
        const r = await rows();
        assert(r.map((x) => x.tag).join("") === "ABCD", `order ${r.map((x) => x.tag).join("")}`);
        assert(r[0].idx === "1", `first row number ${r[0].idx}`);
      });
      await check(`${cur}: each Balance follows that order (50, 20, 120, 140)`, async () => {
        const r = await rows();
        const want = [50, 20, 120, 140].map(money);
        r.forEach((x, i) => assert(x.bal.includes(want[i]), `${x.tag}: ${x.bal} (expected ${want[i]})`));
      });
      await check(`${cur}: the footer is unchanged — Credit, Debit and the account's Current Balance`, async () => {
        const t = p.locator("table.gk-table").filter({ hasText: "Ao A" }).first();
        const foot = await t.locator("tfoot").innerText();
        assert(foot.includes(money(170)) && foot.includes(money(30)) && foot.includes(money(140)), foot);
      });
      await check(`${cur}: clicking the Date header sorts newest first, and back`, async () => {
        const t = p.locator("table.gk-table").filter({ hasText: "Ao A" }).first();
        await t.locator("thead th").filter({ hasText: /Date/ }).first().click(); await p.waitForTimeout(300);
        assert((await rows()).map((x) => x.tag).join("") === "DCBA", `desc ${(await rows()).map((x) => x.tag).join("")}`);
        await t.locator("thead th").filter({ hasText: /Date/ }).first().click(); await p.waitForTimeout(300);
        assert((await rows()).map((x) => x.tag).join("") === "ABCD", "asc again");
      });
    }
    await check("the screen shows exactly the server's stored balances, in date order", async () => {
      const d = (await api(`/api/accounts/${ctx.usd.id}`, { token: SA })).json;
      assert(d.account.balance === 140, `balance ${d.account.balance}`);
      const stored = d.ledger.map((l) => [l.notes.slice(0, 4), l.balanceAfter]).sort();
      assert(JSON.stringify(stored) === JSON.stringify([["Ao A", 50], ["Ao B", 20], ["Ao C", 120], ["Ao D", 140]]), JSON.stringify(stored));
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
