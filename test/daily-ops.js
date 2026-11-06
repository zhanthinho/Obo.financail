"use strict";
// DAILY OPERATIONS CENTER round — the day workspace: USD / SLSH day figures,
// Quick Entry through the existing endpoints, the day's transactions,
// reconciliation, snapshots and closing.
// On a throw-away database. Run with: npm run test:daily-ops
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("dailyops");
const PORT = Number(process.env.DAILY_OPS_TEST_PORT || 4686);
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
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.DO_DEBUG ? "inherit" : "ignore"] });
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
  const aBefore = ok(await api("/api/daily-ops", { token: SA }), "A day before");

  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Ops Beta", admin: { name: "Ob Admin", username: "ob.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  const users = ok(await api("/api/users", { token: B }), "B users").users;
  const ob = users.find((u) => u.username === "ob.admin");
  let OB = ok(await api("/api/auth/login", { method: "POST", body: { username: "ob.admin", password: "BetaPass-2026x" } }), "ob").token;
  const today = ok(await api("/api/daily-ops", { token: B }), "B today").today;
  const D = (n) => addDays(today, -n);
  const nowIso = new Date().toISOString();
  const mk = async (name, currency) => ok(await api("/api/accounts", { method: "POST", token: B, body: { name, currency } }), name).account;
  const cashAcc = async (name, currency) => ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name, type: "physical_cash", currency } }), name).account;
  const tillU = await cashAcc("Ob Till USD", "USD"), safeU = await cashAcc("Ob Safe USD", "USD"), tillS = await cashAcc("Ob Till SLSH", "SLSH");
  const cu = await mk("Ob Customer Uniform", "USD"), cs = await mk("Ob Customer Sierra", "SLSH");
  const mv = async (acc, kind, amount, currency, date, till, extra = {}) => ok(await api(`/api/accounts/${acc.id}/${kind}`, { method: "POST", token: B, body: { amount, currency, paymentDate: date, cashAccountId: till.id, notes: `Ob ${kind}`, ...extra } }), `${kind} ${date}`);
  const day = async (d, tok = B) => ok(await api(`/api/daily-ops${d ? `?date=${d}` : ""}`, { token: tok }), `day ${d}`);

  // Yesterday: an opening position. Today: the Quick Entry postings.
  await mv(cu, "deposit", 500, "USD", `${D(1)}T10:00:00.000Z`, tillU);
  await mv(cs, "deposit", 1000000, "SLSH", `${D(1)}T10:00:00.000Z`, tillS);

  console.log("\nQuick Entry postings (existing endpoints)");
  await check("1. USD Credit — Money In and Closing Cash rise in USD only", async () => {
    await mv(cu, "deposit", 200, "USD", nowIso, tillU);
    const d = await day();
    assert(d.summaries.USD.openingCash === 500 && d.summaries.USD.cashIn === 200 && d.summaries.USD.moneyIn === 200 && d.summaries.USD.closingCash === 700, JSON.stringify(d.summaries.USD));
    assert(d.summaries.SLSH.cashIn === 0 && d.summaries.SLSH.closingCash === 1000000, JSON.stringify(d.summaries.SLSH));
  });
  await check("2. USD Debit — Money Out", async () => {
    await mv(cu, "withdraw", 50, "USD", nowIso, tillU);
    const d = await day();
    assert(d.summaries.USD.cashOut === 50 && d.summaries.USD.moneyOut === 50 && d.summaries.USD.closingCash === 650, JSON.stringify(d.summaries.USD));
  });
  await check("3. SLSH Credit", async () => {
    await mv(cs, "deposit", 300000, "SLSH", nowIso, tillS);
    const d = await day();
    assert(d.summaries.SLSH.cashIn === 300000 && d.summaries.SLSH.closingCash === 1300000, JSON.stringify(d.summaries.SLSH));
  });
  await check("4. SLSH Debit", async () => {
    await mv(cs, "withdraw", 100000, "SLSH", nowIso, tillS);
    const d = await day();
    assert(d.summaries.SLSH.cashOut === 100000 && d.summaries.SLSH.closingCash === 1200000 && d.summaries.USD.closingCash === 650, JSON.stringify(d.summaries));
  });
  await check("5. USD-to-SLSH Exchange — counted once on each side (Exchanges card), Cash in Hand legs", async () => {
    ok(await api("/api/transactions", { method: "POST", token: B, body: { clientName: "Walk-in Ob", amountGiven: 10, currencyGiven: "USD", rateUsed: 8500, cashInAccountId: tillS.id, cashOutAccountId: tillU.id } }), "exchange");
    const d = await day();
    assert(d.summaries.USD.exchanges.amount === 10 && d.summaries.USD.exchanges.count === 1, JSON.stringify(d.summaries.USD.exchanges));
    assert(d.summaries.SLSH.exchanges.amount === 85000 && d.summaries.SLSH.exchanges.count === 1, JSON.stringify(d.summaries.SLSH.exchanges));
    const ex = d.transactions.filter((e) => /exchange/i.test(e.typeLabel));
    assert(ex.length >= 1, "exchange missing from the day's transactions");
  });
  await check("6. SLSH-to-USD Exchange (Cash Exchange) — USD and SLSH Exchange In/Out", async () => {
    const before = await day();
    ok(await api("/api/cash/exchanges", { method: "POST", token: B, body: { fromCashAccountId: tillS.id, toCashAccountId: tillU.id, amountGiven: 170000, rateUsed: 8500 } }), "cash exchange");
    const d = await day();
    assert(d.summaries.SLSH.exchangeOut - before.summaries.SLSH.exchangeOut === 170000, JSON.stringify(d.summaries.SLSH));
    assert(d.summaries.USD.exchangeIn - before.summaries.USD.exchangeIn === 20, JSON.stringify(d.summaries.USD));
    assert(d.summaries.SLSH.exchanges.count === 2 && d.summaries.USD.exchanges.amount === 30, JSON.stringify([d.summaries.SLSH.exchanges, d.summaries.USD.exchanges]));
    for (const c of ["USD", "SLSH"]) { const x = d.summaries[c]; assert(Math.abs(x.openingCash + x.cashIn - x.cashOut + x.transferIn - x.transferOut + x.exchangeIn - x.exchangeOut - x.closingCash) < 0.005, `${c} opening→closing`); }
  });
  await check("7. Cash In and Cash Out on a Cash Account", async () => {
    const b = await day();
    ok(await api(`/api/cash/accounts/${safeU.id}/deposit`, { method: "POST", token: B, body: { amount: 40, description: "Ob float" } }), "cash in");
    ok(await api(`/api/cash/accounts/${safeU.id}/withdraw`, { method: "POST", token: B, body: { amount: 15, description: "Ob petty" } }), "cash out");
    const d = await day();
    assert(d.summaries.USD.cashIn - b.summaries.USD.cashIn === 40 && d.summaries.USD.cashOut - b.summaries.USD.cashOut === 15, JSON.stringify(d.summaries.USD));
    assert(d.summaries.USD.closingCash - b.summaries.USD.closingCash === 25, "closing");
  });
  await check("8. Cash Transfer — In and Out, Money In/Out and closing unchanged", async () => {
    const b = await day();
    ok(await api("/api/cash/transfers", { method: "POST", token: B, body: { fromCashAccountId: tillU.id, toCashAccountId: safeU.id, amount: 60 } }), "transfer");
    const d = await day();
    assert(d.summaries.USD.transferIn - b.summaries.USD.transferIn === 60 && d.summaries.USD.transferOut - b.summaries.USD.transferOut === 60, JSON.stringify(d.summaries.USD));
    assert(d.summaries.USD.moneyIn === b.summaries.USD.moneyIn && d.summaries.USD.moneyOut === b.summaries.USD.moneyOut && d.summaries.USD.closingCash === b.summaries.USD.closingCash, "transfer changed money in/out");
    const rej = await api("/api/cash/transfers", { method: "POST", token: B, body: { fromCashAccountId: tillU.id, toCashAccountId: tillS.id, amount: 1 } });
    assert(rej.status === 400, `cross-currency transfer ${rej.status}`);
  });

  console.log("\nDates, snapshots and history");
  await check("9. Historical date filtering — a past day shows its own figures and transactions, never today's", async () => {
    const d = await day(D(1));
    assert(d.mode === "historical" && d.isToday === false, d.mode);
    assert(d.summaries.USD.closingCash === 500 && d.summaries.SLSH.closingCash === 1000000 && d.summaries.USD.cashIn === 500, JSON.stringify(d.summaries.USD));
    assert(d.transactions.length === 2 && d.transactions.every((e) => String(e.date).slice(0, 10) === D(1)), JSON.stringify(d.transactions.map((e) => e.date)));
    const t = await day();
    assert(t.mode === "live" && t.transactions.every((e) => String(e.date).slice(0, 10) !== D(1)), "today has yesterday");
    assert((await api(`/api/daily-ops?date=${addDays(today, 2)}`, { token: B })).status === 400, "future date");
    assert((await api("/api/daily-ops?date=2026/1/1", { token: B })).status === 400, "bad date");
    const sorted = t.transactions.map((e) => e.sortKey);
    assert(sorted.every((k, i) => i === 0 || String(sorted[i - 1]) >= String(k)), "latest first");
  });
  await check("10. Daily snapshot creation — today's manual snapshot (once)", async () => {
    assert((await day()).snapshot.state === "pending", "already saved");
    const r = await api("/api/daily-ops/snapshot", { method: "POST", token: B, body: { date: today } });
    assert(r.status === 201 && r.json.snapshot.created, `${r.status} ${r.text}`);
    const again = await api("/api/daily-ops/snapshot", { method: "POST", token: B, body: { date: today } });
    assert(again.status === 200 && !again.json.snapshot.created, `second ${again.status}`);
    assert((await day()).snapshot.state === "saved", "state");
  });
  await check("11. Historical snapshot updates — a backdated entry gives the past day a new version", async () => {
    ok(await api("/api/daily-ops/snapshot", { method: "POST", token: B, body: { date: D(1) } }), "sync D1");
    const before = (await day(D(1))).snapshot;
    assert(before.state === "saved" && before.version === 1, JSON.stringify(before));
    await mv(cu, "deposit", 25, "USD", `${D(1)}T12:00:00.000Z`, tillU);
    const r = ok(await api("/api/daily-ops/snapshot", { method: "POST", token: B, body: { date: D(1) } }), "sync again");
    assert(r.result.updated.includes(D(1)), JSON.stringify(r.result));
    const after = await day(D(1));
    assert(after.snapshot.state === "updated" && after.snapshot.version === 2 && after.summaries.USD.closingCash === 525, JSON.stringify([after.snapshot, after.summaries.USD.closingCash]));
  });

  console.log("\nReconciliation and closing");
  const live = await day();
  await check("12. Reconciliation differences — expected from the server, difference, approval needs a note, versions, balances untouched", async () => {
    const exp = live.summaries.USD.closingCash;
    const cashBefore = ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.map((a) => `${a.id}:${a.balance}`).join(",");
    const r1 = ok(await api("/api/daily-ops/reconcile", { method: "POST", token: B, body: { date: today, currency: "USD", actual: exp - 5, expected: 999999 } }), "recon 1").reconciliation;
    assert(r1.expected === exp && r1.difference === -5 && r1.status === "difference" && r1.version === 1, JSON.stringify(r1));
    const noNote = await api("/api/daily-ops/reconcile", { method: "POST", token: B, body: { date: today, currency: "USD", actual: exp - 5, approveDifference: true } });
    assert(noNote.status === 400, `approve without note ${noNote.status}`);
    const r2 = ok(await api("/api/daily-ops/reconcile", { method: "POST", token: B, body: { date: today, currency: "USD", actual: exp - 5, approveDifference: true, notes: "Counted short by $5 — till error" } }), "approve").reconciliation;
    assert(r2.status === "approved" && r2.version === 2 && r2.performedBy, JSON.stringify(r2));
    const r3 = ok(await api("/api/daily-ops/reconcile", { method: "POST", token: B, body: { date: today, currency: "SLSH", actual: live.summaries.SLSH.closingCash } }), "slsh").reconciliation;
    assert(r3.status === "balanced" && r3.difference === 0, JSON.stringify(r3));
    const cashAfter = ok(await api("/api/cash/accounts", { token: B }), "cash").accounts.map((a) => `${a.id}:${a.balance}`).join(",");
    assert(cashBefore === cashAfter, "reconciliation changed a balance");
    const audit = ok(await api("/api/reports/audit-log", { token: B }), "audit").entries;
    assert(audit.some((e) => e.action === "Daily reconciliation" && /USD/.test(e.details) && /approved/.test(e.details)), "audit");
  });
  await check("13. Daily closing permissions — view/reconcile/close/reopen each checked; checks enforced; closed day locked; reopen with a reason", async () => {
    assert((await api("/api/daily-ops", { token: OB })).status === 403, "ob views without dailyOps.view");
    ok(await api(`/api/users/${ob.id}/permissions`, { method: "PATCH", token: B, body: { overrides: ["dailyOps.view", "cash.view"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } }), "grant view");
    OB = ok(await api("/api/auth/login", { method: "POST", body: { username: "ob.admin", password: "BetaPass-2026x" } }), "ob").token;
    const v = ok(await api("/api/daily-ops", { token: OB }), "ob view");
    assert(v.reconciliation === null && v.can.close === false, "reconciliation shown without viewReconciliation");
    for (const [p, b] of [["reconcile", { currency: "USD", actual: 1 }], ["close", { confirmReviewed: true, confirmCashIncluded: true }], ["reopen", { reason: "x" }], ["snapshot", {}]]) {
      const r = await api(`/api/daily-ops/${p}`, { method: "POST", token: OB, body: { date: today, ...b } });
      assert(r.status === 403, `${p} without permission: ${r.status}`);
    }
    assert((await api(`/api/daily-ops/report.pdf?date=${today}`, { token: OB, raw: true })).status === 403, "export without permission");
    // Checks: yesterday has no reconciliation — can't be closed.
    const early = await api("/api/daily-ops/close", { method: "POST", token: B, body: { date: D(1), confirmReviewed: true, confirmCashIncluded: true } });
    assert(early.status === 409 && /reconciliation/.test(early.json.error), `${early.status} ${early.text}`);
    const noConfirm = await api("/api/daily-ops/close", { method: "POST", token: B, body: { date: today } });
    assert(noConfirm.status === 400, `no confirm ${noConfirm.status}`);
    ok(await api(`/api/users/${ob.id}/permissions`, { method: "PATCH", token: B, body: { overrides: ["dailyOps.viewReconciliation", "dailyOps.close"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } }), "grant close");
    OB = ok(await api("/api/auth/login", { method: "POST", body: { username: "ob.admin", password: "BetaPass-2026x" } }), "ob").token;
    const c = ok(await api("/api/daily-ops/close", { method: "POST", token: OB, body: { date: today, confirmReviewed: true, confirmCashIncluded: true } }), "close");
    assert(c.closing.status === "closed" && /ob admin/i.test(c.closing.closedBy), JSON.stringify(c));
    const d = await day();
    assert(d.closing.status === "closed" && d.closing.usdClosing === live.summaries.USD.closingCash && d.closing.slshClosing === live.summaries.SLSH.closingCash, JSON.stringify(d.closing));
    assert((await api("/api/daily-ops/close", { method: "POST", token: B, body: { date: today, confirmReviewed: true, confirmCashIncluded: true } })).status === 409, "closed twice");
    assert((await api("/api/daily-ops/reconcile", { method: "POST", token: B, body: { date: today, currency: "USD", actual: 1 } })).status === 409, "reconcile a closed day");
    assert((await api("/api/daily-ops/reopen", { method: "POST", token: OB, body: { date: today, reason: "Late entry" } })).status === 403, "ob reopens");
    assert((await api("/api/daily-ops/reopen", { method: "POST", token: B, body: { date: today } })).status === 400, "reopen without reason");
    ok(await api("/api/daily-ops/reopen", { method: "POST", token: B, body: { date: today, reason: "Late entry from the branch" } }), "reopen");
    const r = await day();
    assert(r.closing.status === "reopened" && r.closing.reopenReason === "Late entry from the branch", JSON.stringify(r.closing));
    const audit = ok(await api("/api/reports/audit-log", { token: B }), "audit").entries.map((e) => e.action);
    assert(audit.includes("Day closed") && audit.includes("Day reopened"), "audit");
    // Close again after the reopen.
    ok(await api("/api/daily-ops/close", { method: "POST", token: B, body: { date: today, confirmReviewed: true, confirmCashIncluded: true } }), "close again");
    ok(await api("/api/daily-ops/reopen", { method: "POST", token: B, body: { date: today, reason: "Keep the day open for the UI check" } }), "reopen again");
  });
  await check("14. Multi-company isolation — company A's day is untouched by company B", async () => {
    const aAfter = await day(null, SA);
    assert(JSON.stringify(aAfter.summaries) === JSON.stringify(aBefore.summaries) && aAfter.transactions.length === aBefore.transactions.length, "company A changed");
    assert(!aAfter.transactions.some((e) => /^Ob /.test(e.accountName || "")), "B's accounts in A");
    assert(aAfter.reconciliation.USD === null || aAfter.reconciliation.USD.notes !== "Counted short by $5 — till error", "B's reconciliation in A");
  });
  await check("15. Duplicate submission prevention — the same Idempotency-Key posts once", async () => {
    const b = await day();
    const key = `do-${crypto.randomBytes(6).toString("hex")}`;
    const body = { amount: 7, currency: "USD", paymentDate: new Date().toISOString(), cashAccountId: tillU.id, notes: "Ob double click" };
    const [r1, r2] = await Promise.all([1, 2].map(() => api(`/api/accounts/${cu.id}/deposit`, { method: "POST", token: B, body, headers: { "Idempotency-Key": key } })));
    assert(r1.status < 300 && r2.status < 300, `${r1.status} ${r2.status}`);
    const d = await day();
    assert(d.summaries.USD.cashIn - b.summaries.USD.cashIn === 7 && d.transactions.filter((e) => /double click/.test(e.description || e.notes || JSON.stringify(e.raw || {}))).length === 1, `posted ${d.summaries.USD.cashIn - b.summaries.USD.cashIn}`);
  });
  await check("16. USD and SLSH totals remain separate — every figure in its own currency", async () => {
    const d = await day();
    const usd = d.transactions.filter((e) => e.currency === "USD"), slsh = d.transactions.filter((e) => e.currency === "SLSH");
    assert(usd.length + slsh.length === d.transactions.length && usd.length && slsh.length, "currency on rows");
    assert(usd.every((e) => e.accountCurrency === "USD") && slsh.every((e) => e.accountCurrency === "SLSH"), "a row in the wrong currency");
    const sum = (rows, k) => Math.round(rows.reduce((n, e) => n + (Number(e[k]) || 0), 0) * 100) / 100;
    assert(d.summaries.USD.credits === sum(usd, "credit") && d.summaries.SLSH.credits === sum(slsh, "credit"), "credits");
    assert(d.summaries.USD.debits === sum(usd, "debit") && d.summaries.SLSH.debits === sum(slsh, "debit"), "debits");
    assert(d.summaries.USD.closingCash < 10000 && d.summaries.SLSH.closingCash > 100000, "mixed closing");
    for (const fmt of ["pdf", "xlsx"]) { const r = await api(`/api/daily-ops/report.${fmt}?date=${today}`, { token: B, raw: true }); assert(r.status === 200 && r.buf.length > 500, `${fmt} ${r.status}`); }
    const x = await xlsxText((await api(`/api/daily-ops/report.xlsx?date=${today}`, { token: B, raw: true })).buf);
    assert(/Closing Cash/.test(x) && /SLSH/.test(x) && /\$/.test(x), "xlsx content");
    const t = await pdfText((await api(`/api/daily-ops/report.pdf?date=${today}`, { token: B, raw: true })).buf);
    assert(/Daily Operations Report/i.test(t), "pdf title");
  });

  // ------------------------------------------------------------- browser
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  console.log("\nDaily Operations screen");
  ok(await api(`/api/users/${ob.id}/permissions`, { method: "PATCH", token: B, body: { overrides: [...["view", "viewReconciliation", "close", "create", "reconcile", "snapshot", "updateHistory", "reopen", "print", "export"].map((k) => `dailyOps.${k}`), "cash.view", "cash.deposit"].map((k) => ({ permissionKey: k, granted: true })), confirmCritical: true } }), "grant all");
  OB = ok(await api("/api/auth/login", { method: "POST", body: { username: "ob.admin", password: "BetaPass-2026x" } }), "ob").token;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "warning" && /Unknown icon/.test(m.text())) errors.push(m.text()); });
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("ob.admin"); await p.fill('input[type="password"]', "BetaPass-2026x"); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
    if (process.env.DO_SHOTS) await p.screenshot({ path: path.join(process.env.DO_SHOTS, "daily-ops-login.png") });
    const nav = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*Daily Operations\s*$/ }).first();
    const group = p.locator(".gk-nav-group").filter({ has: nav });
    if (await group.count()) { const hd = group.first().locator(".gk-nav-group-header").first(); if ((await hd.getAttribute("aria-expanded")) === "false") { await hd.click(); await p.waitForTimeout(300); } }
    await nav.click(); await p.waitForTimeout(1500);
    const root = p.locator(".gk-do");
    const api0 = await day(null, OB);
    const card = async (cur, k) => (await root.locator(`.gk-do-cur[data-currency="${cur}"] .gk-do-card[data-card="${k}"] .gk-do-card-value`).innerText()).trim();
    const fmt = (v, cur) => (cur === "USD" ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `SLSH ${Math.round(v).toLocaleString("en-US")}`);
    await check("header (company, date, status) and four cards per currency, matching the server", async () => {
      const t = await root.locator(".gk-do-head").innerText();
      assert(/Daily Operations/.test(t) && /Ops Beta/.test(t), t);
      assert(await root.getByLabel("Business date").inputValue() === today, "date");
      for (const cur of ["USD", "SLSH"]) {
        assert(await root.locator(`.gk-do-cur[data-currency="${cur}"] .gk-do-card`).count() === 4, `${cur} cards`);
        assert(await card(cur, "closing") === fmt(api0.summaries[cur].closingCash, cur), `${cur} closing ${await card(cur, "closing")}`);
        assert(await card(cur, "moneyIn") === fmt(api0.summaries[cur].moneyIn, cur), `${cur} money in`);
      }
      assert(await root.locator(".gk-do-cur[data-currency=USD] .gk-do-card[data-card=moneyIn] .gk-do-card-value").evaluate((e) => getComputedStyle(e).fontVariantNumeric) === "tabular-nums", "tabular figures");
    });
    const qe = root.locator('section[aria-label="Quick Entry"]');
    await check("Quick Entry: currency first — types locked until a currency is chosen; only that currency's accounts", async () => {
      assert(await qe.locator('.gk-do-typebtn[data-type="credit"]').isDisabled(), "type enabled before currency");
      await qe.locator('.gk-do-curbtn[data-currency="SLSH"]').click(); await p.waitForTimeout(200);
      await qe.locator('.gk-do-typebtn[data-type="credit"]').click(); await p.waitForTimeout(800);
      await p.click("#do-account"); await p.waitForTimeout(250);
      const ids = await p.locator("#do-account + .gk-acombo-panel [data-account-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-account-id")));
      assert(ids.includes(cs.id) && !ids.includes(cu.id), `accounts ${ids.join(",")}`);
      await p.keyboard.press("Escape");
      assert(/SLSH/.test(await qe.locator(".gk-do-amount span").first().innerText()), "amount currency");
    });
    await check("Quick Entry posts a SLSH Credit through the existing endpoint — cards and table refresh", async () => {
      await p.locator(`#do-account + .gk-acombo-panel [data-account-id="${cs.id}"]`).click().catch(async () => { await p.click("#do-account"); await p.waitForTimeout(200); await p.locator(`#do-account + .gk-acombo-panel [data-account-id="${cs.id}"]`).click(); });
      await p.waitForTimeout(200);
      await p.click("#do-cash"); await p.waitForTimeout(200); await p.locator(`#do-cash + .gk-acombo-panel [data-account-id="${tillS.id}"]`).click(); await p.waitForTimeout(200);
      await qe.getByLabel("Amount (SLSH)").fill("25000");
      await qe.getByLabel("Description").fill("Ob UI credit");
      const save = qe.getByRole("button", { name: /Save Credit/ });
      await save.dblclick(); await p.waitForTimeout(1800);
      const after = await day(null, OB);
      assert(after.summaries.SLSH.cashIn - api0.summaries.SLSH.cashIn === 25000, `posted ${after.summaries.SLSH.cashIn - api0.summaries.SLSH.cashIn}`);
      assert(await card("SLSH", "moneyIn") === fmt(after.summaries.SLSH.moneyIn, "SLSH"), "card not refreshed");
      assert(await root.locator(".gk-do-table tbody tr").filter({ hasText: "Ob UI credit" }).count() === 1, "row missing / duplicated");
    });
    await check("every Quick Entry tab, type, field and button carries an icon; exchange shows rate, received amount and profit", async () => {
      await qe.locator('.gk-do-curbtn[data-currency="USD"]').click(); await p.waitForTimeout(150);
      await qe.locator('.gk-do-typebtn[data-type="exchange"]').click(); await p.waitForTimeout(700);
      await qe.getByLabel("Amount Given (USD)").fill("100"); await qe.getByLabel("Exchange Rate").fill("8600"); await p.waitForTimeout(200);
      assert((await qe.locator("[data-received]").innerText()).trim() === "SLSH 860,000", await qe.locator("[data-received]").innerText());
      const missing = await qe.evaluate((el) => [...el.querySelectorAll(".gk-do-tab, .gk-do-curbtn, .gk-do-typebtn, .gk-do-label, .gk-do-actions button, .gk-do-exsum > span")].filter((b) => !b.querySelector("svg")).map((b) => b.textContent.trim()));
      assert(!missing.length, `no icon: ${missing.join(" | ")}`);
      const tones = await qe.evaluate((el) => ["credit", "debit", "exchange"].map((k) => getComputedStyle(el.querySelector(`.gk-do-typebtn[data-type="${k}"] .gk-do-typeic`)).color));
      assert(tones[0] === "rgb(21, 128, 61)" && tones[1] === "rgb(185, 28, 28)" && tones[2] === "rgb(15, 118, 110)", tones.join(" "));
      await qe.getByRole("button", { name: /^Cancel$/ }).click();
    });
    await check("Cash Account tab: Cash In / Out / Transfer / Exchange, USD Cash Accounts only", async () => {
      await qe.getByRole("tab", { name: /Cash Account/ }).click(); await p.waitForTimeout(200);
      const types = await qe.locator(".gk-do-typebtn").allInnerTexts();
      for (const w of ["Cash In", "Cash Out", "Cash Transfer", "Cash Exchange"]) assert(types.some((t) => t.includes(w)), w);
      await qe.locator('.gk-do-typebtn[data-type="cashIn"]').click(); await p.waitForTimeout(700);
      await p.click("#do-cash"); await p.waitForTimeout(250);
      const ids = await p.locator("#do-cash + .gk-acombo-panel [data-account-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-account-id")));
      assert(ids.includes(tillU.id) && ids.includes(safeU.id) && !ids.includes(tillS.id), ids.join(","));
      await p.keyboard.press("Escape");
      assert(await qe.getByRole("tab", { name: /Bulk Entry/ }).count() === 1, "bulk tab");
    });
    await check("transactions table: columns, currency filter keeps USD and SLSH apart, per-currency footer totals", async () => {
      const heads = (await root.locator(".gk-do-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      for (const w of ["#", "TIME", "TYPE", "CURRENCY", "ACCOUNT", "DESCRIPTION", "AMOUNT", "BALANCE", "ACTION"]) assert(heads.includes(w), heads.join("|"));
      await root.locator('.gk-do-seg button').filter({ hasText: "SLSH" }).click(); await p.waitForTimeout(250);
      const curs = await root.locator(".gk-do-table tbody tr[data-currency]").evaluateAll((r) => [...new Set(r.map((x) => x.getAttribute("data-currency")))]);
      assert(curs.length === 1 && curs[0] === "SLSH", curs.join(","));
      assert(await root.locator(".gk-do-table tfoot tr[data-total]").count() === 1, "footer per currency");
      await root.locator('.gk-do-seg button').filter({ hasText: "All" }).click(); await p.waitForTimeout(200);
      await root.locator(".gk-do-table tbody tr").first().getByRole("button", { name: /View/ }).click(); await p.waitForTimeout(300);
      assert(await p.locator('[role="dialog"] .gk-do-detail').count() === 1, "detail");
      await p.keyboard.press("Escape"); await p.locator('[role="dialog"]').count() && await p.mouse.click(5, 5); await p.waitForTimeout(200);
    });
    await check("reconciliation: the difference is shown live and saved as Difference Found (balances unchanged)", async () => {
      const rc = root.locator('section[aria-label="Daily Reconciliation"]');
      await rc.getByRole("tab", { name: /SLSH/ }).click(); await p.waitForTimeout(200);
      const d = await day(null, OB);
      await rc.getByLabel("Actual closing balance SLSH").fill(String(d.summaries.SLSH.closingCash - 1000)); await p.waitForTimeout(150);
      assert(await rc.locator(".gk-do-diff").getAttribute("data-diff") === "nonzero", "diff");
      await rc.getByRole("button", { name: /Save Reconciliation/ }).click(); await p.waitForTimeout(1200);
      assert(await rc.locator(".gk-do-recon").getAttribute("data-status") === "difference", await rc.locator(".gk-do-recon").getAttribute("data-status"));
      const after = await day(null, OB);
      assert(after.summaries.SLSH.closingCash === d.summaries.SLSH.closingCash, "balance changed");
      assert(await root.getByRole("button", { name: /^Close Day$/ }).isDisabled(), "Close Day enabled with a difference");
    });
    await check("a past date shows that day's figures, no Quick Entry", async () => {
      await root.getByLabel("Business date").fill(D(1)); await p.waitForTimeout(1500);
      assert(await root.getAttribute("data-mode") === "historical", "mode");
      assert(await root.locator('section[aria-label="Quick Entry"]').count() === 0, "quick entry on a past day");
      const d1 = await day(D(1), OB);
      assert(await card("USD", "closing") === fmt(d1.summaries.USD.closingCash, "USD"), await card("USD", "closing"));
      if (process.env.DO_SHOTS) await p.screenshot({ path: path.join(process.env.DO_SHOTS, "daily-ops-past.png"), fullPage: true });
      await root.getByRole("button", { name: /^Today$/ }).click(); await p.waitForTimeout(1500);
      if (process.env.DO_SHOTS) await p.screenshot({ path: path.join(process.env.DO_SHOTS, "daily-ops-today.png"), fullPage: true });
    });
    await check("phone width: no horizontal page scroll", async () => {
      await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(500);
      const over = await p.evaluate(() => { const r = document.querySelector(".gk-do").getBoundingClientRect(); return r.right - window.innerWidth; });
      assert(over <= 1, `overflow ${over}px`);
      if (process.env.DO_SHOTS) await p.screenshot({ path: path.join(process.env.DO_SHOTS, "daily-ops-phone.png"), fullPage: true });
    });
    await check("no page errors, no unknown icons", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
