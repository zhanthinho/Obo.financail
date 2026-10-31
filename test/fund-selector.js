"use strict";
// CUSTOMER TRANSACTION SELECTOR round — Quick Exchange -> Track in Account ->
// View Transactions. On a throw-away installation it proves (tests A–M of
// the brief):
//   A  only the chosen account's credits with money left are listed;
//   B  switching account in the form clears the old selection;
//   C/D multi-select totals and deselection (in the browser);
//   E  a credit partly used (FIFO) offers only what is left;
//   F  a fully used credit can't be used again;
//   G  two exchanges racing for the same credit: only one is saved;
//   H  tampered ids / amounts are refused by the server;
//   I  another company's account and credits are out of reach;
//   J  a successful exchange records the right amount, balances, references;
//   K  a refused selection leaves nothing behind;
//   L  a repeated submission is saved once;
//   M  walk-in, tracked-without-selection, edit and delete still work.
//
// Run with: npm run test:fund-selector
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("fundselector");
const PORT = Number(process.env.FUND_TEST_PORT || 4394);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;

let admin;
async function account(name, currency = "USD", token = admin) {
  const r = await api("/api/accounts", { method: "POST", token, body: { name, currency } });
  assert(r.status === 201, `account ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.account;
}
async function credit(acc, amount, token = admin) {
  const r = await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token, body: { amount, notes: `credit ${amount}` } });
  assert(r.status === 200, `deposit ${r.status} ${JSON.stringify(r.json)}`);
}
const sources = async (acc, q = "", token = admin) => api(`/api/transactions/fund-sources?accountId=${encodeURIComponent(acc.id)}${q}`, { token });
const exchange = (acc, given, fundSelections, extra = {}) => api("/api/transactions", { method: "POST", token: admin, body: { clientName: acc.name, clientAccountId: acc.id, amountGiven: given, currencyGiven: acc.currency, fundSelections, ...extra } });
const balanceOf = async (acc) => (await api(`/api/accounts/${acc.id}`, { token: admin })).json.account.balance;
const byAmount = (rows, amt) => rows.find((r) => near(r.amount, amt));

async function run() {
  admin = await login("amina.yusuf");
  await api("/api/rate-history", { method: "POST", token: admin, body: { dailyRate: 8750, saleRate: 8650, costRate: 8800, buyRate: 8750, sellRate: 8900 } });

  // Account A: credits 500, 150, 100 then a 200 withdrawal (FIFO: the 500
  // credit has 300 left). Account B: one credit of 70.
  const A = await account("Fund Selector Alpha");
  const B = await account("Fund Selector Bravo");
  await credit(A, 500); await credit(A, 150); await credit(A, 100);
  assert((await api(`/api/accounts/${A.id}/withdraw`, { method: "POST", token: admin, body: { amount: 200 } })).status === 200, "withdraw");
  await credit(B, 70);
  let rowsA;

  console.log("\nListing");
  await check("A. only Account A's credits with money left are listed", async () => {
    const r = await sources(A);
    assert(r.status === 200, `status ${r.status}`);
    rowsA = r.json.rows;
    assert(rowsA.length === 3 && r.json.eligibleCount === 3, `rows ${rowsA.length}`);
    assert(near(r.json.totalAvailable, 550) && near(r.json.account.balance, 550), `available ${r.json.totalAvailable}, balance ${r.json.account.balance}`);
    const bRows = (await sources(B)).json.rows;
    assert(!rowsA.some((x) => bRows.some((y) => y.ledgerId === x.ledgerId)), "Account B credit listed under A");
    assert(rowsA.every((x) => x.type === "Credit" && x.reference), JSON.stringify(rowsA[0]));
  });
  await check("E. a credit already partly used shows only what's left (500 -> 300)", async () => {
    const big = byAmount(rowsA, 500);
    assert(big && near(big.available, 300) && near(big.consumed, 200), JSON.stringify(big));
  });
  await check("search, date and type filters work on the server", async () => {
    const ref = byAmount(rowsA, 150).reference;
    const s = (await sources(A, `&search=${encodeURIComponent(ref)}`)).json;
    assert(s.rows.length === 1 && s.rows[0].reference === ref, `search ${s.rows.length}`);
    const today = new Date().toISOString().slice(0, 10);
    assert((await sources(A, "&from=2000-01-01&to=2000-12-31")).json.rows.length === 0, "date filter");
    assert((await sources(A, `&from=${today.slice(0, 8)}01`)).json.rows.length === 3, "date filter (this month)");
    assert((await sources(A, "&type=Transfer%20in")).json.rows.length === 0, "type filter");
  });

  console.log("\nServer-side checks");
  await check("H. tampered selections are refused", async () => {
    const d2 = byAmount(rowsA, 150), bCredit = (await sources(B)).json.rows[0];
    const led = (await api(`/api/accounts/${A.id}`, { token: admin })).json.ledger || [];
    const debit = led.find((l) => l.type === "withdrawal");
    const cases = [
      ["another account's credit", 70, [{ ledgerId: bCredit.ledgerId, amount: 70 }]],
      ["a debit, not a credit", 200, [{ ledgerId: debit ? debit.id : "x", amount: 200 }]],
      ["made-up id", 10, [{ ledgerId: "ldg_fake_123", amount: 10 }]],
      ["more than is left", 151, [{ ledgerId: d2.ledgerId, amount: 151 }]],
      ["negative amount", 10, [{ ledgerId: d2.ledgerId, amount: -10 }]],
      ["same credit twice", 100, [{ ledgerId: d2.ledgerId, amount: 50 }, { ledgerId: d2.ledgerId, amount: 50 }]],
      ["total differs from amount given", 140, [{ ledgerId: d2.ledgerId, amount: 150 }]],
      ["amount as true", 1, [{ ledgerId: d2.ledgerId, amount: true }]],
    ];
    for (const [label, given, sel] of cases) {
      const r = await exchange(A, given, sel);
      assert(r.status === 400, `${label}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    const walk = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 150, currencyGiven: "USD", fundSelections: [{ ledgerId: d2.ledgerId, amount: 150 }] } });
    assert(walk.status === 400, `selection without a From Account: ${walk.status}`);
    const notList = await exchange(A, 150, { ledgerId: d2.ledgerId, amount: 150 });
    assert(notList.status === 400, `fundSelections not a list: ${notList.status}`);
  });
  await check("K. a refused selection leaves no exchange, ledger row or balance change", async () => {
    const before = (await api("/api/transactions", { token: admin })).json.transactions.length;
    const bal = await balanceOf(A);
    const r = await exchange(A, 301, [{ ledgerId: byAmount(rowsA, 500).ledgerId, amount: 301 }]);
    assert(r.status === 400, `status ${r.status}`);
    assert((await api("/api/transactions", { token: admin })).json.transactions.length === before, "an exchange was saved");
    assert(near(await balanceOf(A), bal), "balance changed");
  });
  let ex1;
  await check("J. exchange paid from 300 (partial of 500) + 150 = $450: amounts, balance, references", async () => {
    const d1 = byAmount(rowsA, 500), d2 = byAmount(rowsA, 150);
    const r = await exchange(A, 450, [{ ledgerId: d1.ledgerId, amount: 300 }, { ledgerId: d2.ledgerId, amount: 150 }]);
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.json)}`);
    ex1 = r.json.transaction;
    assert(ex1.amountGiven === 450 && ex1.amountReceived === 450 * 8750, JSON.stringify(ex1));
    assert(ex1.fundSources.length === 2 && ex1.fundSources.some((f) => f.reference === d1.reference && f.amount === 300), JSON.stringify(ex1.fundSources));
    assert(near(await balanceOf(A), 100), `balance ${await balanceOf(A)}`);
    const listed = (await api("/api/transactions", { token: admin })).json.transactions.find((t) => t.id === ex1.id);
    assert(listed && listed.fundSources.length === 2, "fund sources missing from the exchange list");
    const left = (await sources(A)).json;
    assert(left.rows.length === 1 && near(left.rows[0].amount, 100) && near(left.totalAvailable, 100), JSON.stringify(left.rows));
  });
  await check("F. a fully used credit can't be used again", async () => {
    const r = await exchange(A, 150, [{ ledgerId: byAmount(rowsA, 150).ledgerId, amount: 150 }]);
    assert(r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
    assert(near(await balanceOf(A), 100), "balance changed");
  });
  await check("G. two exchanges racing for the same $100 credit: exactly one is saved", async () => {
    const d3 = byAmount(rowsA, 100);
    const [r1, r2] = await Promise.all([exchange(A, 100, [{ ledgerId: d3.ledgerId, amount: 100 }]), exchange(A, 100, [{ ledgerId: d3.ledgerId, amount: 100 }])]);
    const ok = [r1, r2].filter((r) => r.status === 201).length;
    assert(ok === 1, `${ok} saved (${r1.status}, ${r2.status})`);
    assert(near(await balanceOf(A), 0), `balance ${await balanceOf(A)}`);
    assert((await sources(A)).json.rows.length === 0, "credit still listed");
  });
  await check("L. the same submission sent three times is saved once", async () => {
    const C = await account("Fund Selector Charlie");
    await credit(C, 40);
    const c1 = (await sources(C)).json.rows[0];
    const key = crypto.randomBytes(8).toString("hex");
    const body = { clientName: C.name, clientAccountId: C.id, amountGiven: 40, currencyGiven: "USD", fundSelections: [{ ledgerId: c1.ledgerId, amount: 40 }] };
    const rs = await Promise.all([1, 2, 3].map(() => api("/api/transactions", { method: "POST", token: admin, body, headers: { "Idempotency-Key": key } })));
    assert(rs.every((r) => r.status === 201), rs.map((r) => r.status).join(","));
    const mine = (await api("/api/transactions", { token: admin })).json.transactions.filter((t) => t.fromAccountId === C.id);
    assert(mine.length === 1 && mine[0].fundSources.length === 1, `${mine.length} exchanges`);
    assert(near(await balanceOf(C), 0), "balance");
  });

  console.log("\nCompanies and permissions");
  await check("I. another company's account and credits are out of reach", async () => {
    const sa = await login("super.admin", SA_PW);
    const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Other Co Fund", admin: { name: "Other Admin", username: "other.fund", password: "OtherFund-2026" } } });
    assert(c.status === 201, `company ${c.status}`);
    const other = await login("other.fund", "OtherFund-2026");
    const O = await account("Other Company Customer", "USD", other);
    await credit(O, 90, other);
    const oRow = (await sources(O, "", other)).json.rows[0];
    assert(oRow, "other company sees its own credit");
    const r = await sources(O);
    assert(r.status === 404, `company A reading company B's account: ${r.status}`);
    const D = await account("Fund Selector Delta");
    await credit(D, 90);
    const x = await exchange(D, 90, [{ ledgerId: oRow.ledgerId, amount: 90 }]);
    assert(x.status === 400, `company B's credit on company A's account: ${x.status}`);
    const back = await sources(A, "", other);
    assert(back.status === 404, `company B reading company A's account: ${back.status}`);
  });
  await check("a user without exchange permission or signed out can't list credits", async () => {
    const viewer = await login("sahra.ismail");
    assert([403].includes((await sources(B, "", viewer)).status), "viewer allowed");
    assert((await sources(B, "", null)).status === 401, "no token allowed");
  });

  console.log("\nExisting workflows");
  await check("M. walk-in and tracked exchanges without a selection still work", async () => {
    const w = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 10, currencyGiven: "USD" } });
    assert(w.status === 201 && w.json.transaction.fundSources.length === 0, `walk-in ${w.status}`);
    const t = await exchange(B, 20);
    assert(t.status === 201 && near(await balanceOf(B), 50), `tracked ${t.status}`);
    const left = (await sources(B)).json.rows[0];
    assert(near(left.available, 50), `FIFO after an unselected exchange: ${left.available}`);
  });
  await check("M. deleting a paid-from-selection exchange frees its credits again", async () => {
    const E = await account("Fund Selector Echo");
    await credit(E, 60);
    const e1 = (await sources(E)).json.rows[0];
    const ex = (await exchange(E, 60, [{ ledgerId: e1.ledgerId, amount: 60 }])).json.transaction;
    assert((await sources(E)).json.rows.length === 0, "still listed after use");
    const del = await api(`/api/transactions/${ex.id}`, { method: "DELETE", token: admin, body: { reason: "test" } });
    assert(del.status === 200, `delete ${del.status}`);
    const back = (await sources(E)).json.rows;
    assert(back.length === 1 && near(back[0].available, 60), JSON.stringify(back));
  });
  await check("M. editing the amount of such an exchange drops the named credits (FIFO applies)", async () => {
    const F = await account("Fund Selector Foxtrot");
    await credit(F, 30); await credit(F, 50);
    const rows = (await sources(F)).json.rows;
    const newer = byAmount(rows, 50);
    const ex = (await exchange(F, 50, [{ ledgerId: newer.ledgerId, amount: 50 }])).json.transaction;
    let now = (await sources(F)).json.rows;
    assert(now.length === 1 && near(now[0].amount, 30), "the newer credit should be used");
    const p = await api(`/api/transactions/${ex.id}`, { method: "PATCH", token: admin, body: { clientName: F.name, clientAccountId: F.id, amountGiven: 40, currencyGiven: "USD" } });
    assert(p.status === 200, `edit ${p.status} ${JSON.stringify(p.json)}`);
    now = (await sources(F)).json.rows;
    assert(now.length === 1 && near(now[0].amount, 50) && near(now[0].available, 40), `after edit: ${JSON.stringify(now)}`);
  });

  return { A, B };
}

async function browserChecks() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  // Fresh accounts for the browser part.
  const U = await account("Fund Browser Uniform");
  await credit(U, 150); await credit(U, 100); await credit(U, 75);
  const V = await account("Fund Browser Victor");
  await credit(V, 20);
  const open = async (viewport) => {
    const c = await browser.newContext({ viewport });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
    if (viewport.width < 800) { const ham = p.locator(".gk-mobile-hamburger"); if (await ham.count()) { await ham.click(); await p.waitForTimeout(400); } }
    await p.getByText("Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /New transaction/ }).first().click();
    await p.waitForSelector("#qx-amount", { timeout: 10000 });
    await p.getByRole("radio", { name: /Track in Account/ }).click(); await p.waitForTimeout(300);
    return { c, p };
  };
  const pick = async (p, acc) => { await p.selectOption("#qx-from", acc.id); await p.waitForTimeout(600); };
  const dialog = (p) => p.locator('[role="dialog"]').last();
  const useBtn = (p) => dialog(p).getByRole("button", { name: /Use Selected Amount/ });
  try {
    {
      const { c, p } = await open({ width: 1366, height: 1000 });
      await check("the button sits beside Available and counts the eligible credits", async () => {
        await pick(p, U);
        const line = await p.locator(".gk-qx-available").innerText();
        assert(/Available: \$325\.00/.test(line) && /View Transactions/.test(line) && /3/.test(line), line);
      });
      await check("the modal lists the account's credits newest first", async () => {
        await p.locator(".gk-qx-viewtx").click(); await p.waitForTimeout(800);
        assert(/Customer Transactions \(USD\)/.test(await dialog(p).innerText()), "title");
        const amounts = await dialog(p).locator("tbody tr td:nth-child(6)").allInnerTexts();
        assert(amounts.join("|") === "$75.00|$100.00|$150.00", amounts.join("|"));
      });
      const box = (amt) => dialog(p).locator("tbody tr", { hasText: `$${amt}.00` }).first().locator('input[type="checkbox"]');
      await check("C. selecting $150 and $100 totals $250", async () => {
        await box(150).check(); await box(100).check(); await p.waitForTimeout(200);
        assert(/Use Selected Amount \(\$250\.00\)/.test(await useBtn(p).innerText()), await useBtn(p).innerText());
        assert(/2 selected/.test(await dialog(p).innerText()), "count");
      });
      await check("D. deselecting one updates the count and total", async () => {
        await box(100).uncheck(); await p.waitForTimeout(200);
        assert(/Use Selected Amount \(\$150\.00\)/.test(await useBtn(p).innerText()) && /1 selected/.test(await dialog(p).innerText()), await useBtn(p).innerText());
        await box(100).check(); await p.waitForTimeout(200);
      });
      await check("E (UI). taking part of a credit; more than is left is refused", async () => {
        const amt = dialog(p).locator("tbody tr", { hasText: "$150.00" }).first().locator('input[aria-label^="Amount to use"]');
        await amt.fill("160"); await p.waitForTimeout(150);
        assert(await useBtn(p).isDisabled(), "more than available was accepted");
        await amt.fill("150"); await p.waitForTimeout(150);
        assert(!(await useBtn(p).isDisabled()), "valid selection blocked");
      });
      await check("Use Selected Amount fills the amount and keeps the references", async () => {
        await useBtn(p).click(); await p.waitForTimeout(400);
        assert((await p.inputValue("#qx-amount")).replace(/,/g, "") === "250", await p.inputValue("#qx-amount"));
        assert(/From 2 selected transaction/.test(await p.locator(".gk-qx-fundsel").innerText()), "summary chip");
        assert(/SLSH 2,187,500/.test(await p.locator(".gk-qx").innerText()), "receive amount not recalculated");
      });
      await check("B. switching to another account clears the selection with a note", async () => {
        await pick(p, V);
        assert(!(await p.locator(".gk-qx-fundsel").count()), "selection kept");
        assert(/cleared because the account/.test(await p.locator(".gk-qx").innerText()), "no note");
        assert(/Available: \$20\.00/.test(await p.locator(".gk-qx-available").innerText()), "count/balance not refreshed");
      });
      await check("changing the amount by hand clears the selection", async () => {
        await pick(p, U);
        await p.locator(".gk-qx-viewtx").click(); await p.waitForTimeout(800);
        await box(75).check(); await useBtn(p).click(); await p.waitForTimeout(300);
        await p.fill("#qx-amount", "80"); await p.waitForTimeout(200);
        assert(!(await p.locator(".gk-qx-fundsel").count()) && /amount was changed by hand/.test(await p.locator(".gk-qx").innerText()), "not cleared");
      });
      await check("J (UI). recording the exchange saves the selected credits", async () => {
        await p.locator(".gk-qx-viewtx").click(); await p.waitForTimeout(800);
        await box(150).check(); await box(100).check(); await useBtn(p).click(); await p.waitForTimeout(300);
        await p.locator('button:has-text("Record Exchange")').click(); await p.waitForTimeout(2500);
        const t = (await api("/api/transactions", { token: admin })).json.transactions.find((x) => x.fromAccountId === U.id);
        assert(t && t.amountGiven === 250 && t.fundSources.length === 2, JSON.stringify(t && t.fundSources));
        assert(near(await balanceOf(U), 75), "balance");
      });
      await c.close();
    }
    {
      const { c, p } = await open({ width: 390, height: 844 });
      await check("390px wide: the modal fits without sideways scrolling", async () => {
        await pick(p, V);
        await p.locator(".gk-qx-viewtx").click(); await p.waitForTimeout(800);
        assert(await dialog(p).locator("tbody tr").count() === 1, "row missing");
        assert(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "page scrolls sideways");
      });
      await c.close();
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
  try { await waitUp(); await run(); await browserChecks(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  await check("the server logged no unhandled errors", async () => { assert(!bad.length, bad.slice(0, 5).join(" | ")); });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
