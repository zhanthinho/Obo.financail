"use strict";
// DAILY REPORTS round — automatic daily snapshots, Balance Sheet history,
// Cash Account history, exports, permissions and company isolation, on a
// throw-away database. The scheduler runs for real (tick shortened to 1 s).
// Run with: npm run test:daily-reports
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("dailyrep");
const PORT = Number(process.env.DAILY_REPORTS_TEST_PORT || 4540);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOT_TICK_MS: "1000", FINMAN_TEST_MODE: "1" };
process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const TZ = "Africa/Mogadishu";

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* binary */ }
  return { status: r.status, json, buf, headers: r.headers };
}
async function waitFor(fn, ms = 15000, what = "condition") {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(300); }
}
// Shared reader: also decodes the Inter (number) font's text.
const { pdfText } = require("./helpers/pdf-text");
async function xlsxText(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { const v = c.value && typeof c.value === "object" && "result" in c.value ? c.value.result : c.value; out.push(v == null ? "" : String(v)); })));
  return out.join("\n");
}
function db() {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  return { q: (sql, p = []) => c.query(sql, p).rows, close: () => c.close() };
}
function tzNow(tz = TZ, offsetMin = 0) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = {}; for (const p of f.formatToParts(new Date(Date.now() + offsetMin * 60000))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` };
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let srv = null, serverErr = "";
async function startServer(extra = {}) {
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...ENV, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  await waitFor(async () => { try { return (await fetch(BASE + "/api/health")).ok; } catch (e) { return false; } }, 20000, "server");
}
async function stopServer() { if (!srv) return; const p = new Promise((r) => srv.once("exit", r)); srv.kill(); await p; srv = null; }

async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  try {
    await startServer();
    await phaseA();
    await stopServer();
    await startServer({ FINMAN_TEST_SNAPSHOT_FAULT: "1" });
    await phaseB();
    await stopServer();
    await startServer();
    await phaseC();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally { await stopServer(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function logins() {
  ctx.sa = (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: SA_PW } })).json.token;
  ctx.A = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0001" } })).json.token;
  ctx.adm = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: DEMO_PW } })).json.token;
  assert(ctx.A && ctx.adm, "logins failed");
}
const snaps = async (token, q = "") => (await api(`/api/daily-reports/snapshots?from=2000-01-01&pageSize=200${q}`, { token })).json;

async function phaseA() {
  await logins();
  const T = ctx.A;
  console.log("\nSchedule & automatic snapshot");
  await check("status comes from the server: enabled by default, 23:59 Africa/Mogadishu, a real next run time", async () => {
    const r = await api("/api/daily-reports/status", { token: T });
    assert(r.status === 200, `status ${r.status}`);
    const s = r.json;
    assert(s.enabled === true && s.runTime === "23:59" && s.timezone === TZ, JSON.stringify(s));
    assert(s.today === tzNow().date, `today ${s.today} vs ${tzNow().date}`);
    assert(s.lastSuccess === null && ["pending", "delayed"].includes(s.state), s.state);
    assert(Date.parse(s.nextRunAt) > Date.now(), "next run should be in the future");
  });
  await check("settings are validated (time, time zone, unknown fields)", async () => {
    for (const body of [{ runTime: "25:00" }, { runTime: "9pm" }, { timezone: "Mars/Olympus" }, { enabled: "yes" }, { hack: 1 }]) {
      const r = await api("/api/daily-reports/settings", { method: "PATCH", token: T, body });
      assert(r.status === 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
  });
  // A Cash Account rate before the snapshot, so the combined figure is made.
  await api("/api/cash/rate", { method: "POST", token: T, body: { rate: 11000 } });
  ctx.liveBefore = (await api("/api/cash/balance-sheet", { token: T })).json;
  const late = tzNow(TZ, -30);
  const early = tzNow(TZ, -1);
  ctx.expectLate = late.date === tzNow().date;
  await check("the scheduler takes today's automatic snapshot once its time has passed (company time zone)", async () => {
    const r = await api("/api/daily-reports/settings", { method: "PATCH", token: T, body: { runTime: ctx.expectLate ? late.time : early.time } });
    assert(r.status === 200, `patch ${r.status} ${JSON.stringify(r.json)}`);
    const d = await waitFor(async () => { const x = await snaps(T); return x.snapshots.find((s) => s.source === "automatic"); }, 15000, "automatic snapshot");
    ctx.auto = d;
    assert(d.businessDate === tzNow().date && d.timezone === TZ, `${d.businessDate} ${d.timezone}`);
    assert(d.scheduledFor && Date.parse(d.capturedAt) >= Date.parse(d.scheduledFor), "capture time must be the real (later) time");
  });
  await check("a snapshot taken well after its scheduled time is flagged late and keeps its real capture time", async () => {
    if (!ctx.expectLate) return; // too close to midnight to schedule 30 min earlier today
    assert(ctx.auto.late === true, "not flagged late");
    assert(Date.parse(ctx.auto.capturedAt) - Date.parse(ctx.auto.scheduledFor) > 25 * 60000, "times look wrong");
    const s = (await api("/api/daily-reports/status", { token: T })).json;
    assert(s.state === "saved_late", s.state);
  });
  await check("stored figures equal the live Balance Sheet at capture: Debt + Cash − Credit, per currency", async () => {
    const L = ctx.liveBefore.currencies;
    for (const [c, k] of [["USD", "usd"], ["SLSH", "slsh"]]) {
      const s = ctx.auto[k];
      assert(s.debt === L[c].debt && s.cash === L[c].cashInHand && s.credit === L[c].credit, `${c} components differ`);
      assert(s.balanceSheet === L[c].balanceSheet, `${c} balance sheet ${s.balanceSheet} vs ${L[c].balanceSheet}`);
      assert(Math.abs(s.balanceSheet - round2(s.debt + s.cash - s.credit)) <= 0.01, `${c} formula`);
      assert(s.debt >= 0 && s.credit >= 0, "debt and credit are stored as positive amounts");
    }
  });
  await check("the historical exchange rate and the combined Net Balance Sheet are stored with the snapshot", async () => {
    const s = ctx.auto;
    assert(s.exchangeRate === 11000, `rate ${s.exchangeRate}`);
    assert(s.combined.available === true, JSON.stringify(s.combined));
    assert(Math.abs(s.combined.usdEquivalent - round2(s.usd.balanceSheet + s.slsh.balanceSheet / 11000)) <= 0.01, "USD equivalent");
    assert(Math.abs(s.combined.slshEquivalent - round2(s.usd.balanceSheet * 11000 + s.slsh.balanceSheet)) <= 0.01, "SLSH equivalent");
  });

  console.log("\nManual snapshot, duplicates, immutability");
  await check("a manual snapshot needs explicit confirmation, is stored separately, and only once per day", async () => {
    let r = await api("/api/daily-reports/snapshots/run", { method: "POST", token: T, body: {} });
    assert(r.status === 400, `no confirm -> ${r.status}`);
    r = await api("/api/daily-reports/snapshots/run", { method: "POST", token: T, body: { confirm: true } });
    assert(r.status === 201 && r.json.snapshot.source === "manual", `manual ${r.status} ${JSON.stringify(r.json)}`);
    ctx.manual = r.json.snapshot;
    assert(ctx.manual.createdByName && ctx.manual.createdByName !== "Automatic snapshot (system)", "initiating user not recorded");
    r = await api("/api/daily-reports/snapshots/run", { method: "POST", token: T, body: { confirm: true } });
    assert(r.status === 409, `second manual -> ${r.status}`);
  });
  await check("the scheduler never stores a second automatic snapshot for the same day, and the database refuses one", async () => {
    await sleep(3500); // several scheduler ticks
    const all = (await snaps(T)).snapshots.filter((s) => s.businessDate === ctx.auto.businessDate);
    assert(all.filter((s) => s.source === "automatic").length === 1 && all.filter((s) => s.source === "manual").length === 1, JSON.stringify(all.map((s) => s.source)));
    const h = db();
    try {
      let refused = false;
      try { h.q(`INSERT INTO cmp0001_daily_snapshots (id, business_date, source, timezone, captured_at, created_at) VALUES ('dup', ?, 'automatic', ?, '2026-01-01', '2026-01-01')`, [ctx.auto.businessDate, TZ]); } catch (e) { refused = /duplicate/i.test(e.message); }
      assert(refused, "unique constraint missing");
    } finally { h.close(); }
  });
  await check("later transactions and a new exchange rate change the live Balance Sheet but never a stored snapshot", async () => {
    const acc = (await api("/api/accounts?currency=USD", { token: T })).json.accounts[0];
    const dep = await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token: T, body: { amount: 777.77, currency: "USD" } });
    assert(dep.status === 200 || dep.status === 201, `deposit ${dep.status} ${JSON.stringify(dep.json)}`);
    await api("/api/cash/rate", { method: "POST", token: T, body: { rate: 12500 } });
    const live = (await api("/api/cash/balance-sheet", { token: T })).json;
    assert(live.currencies.USD.balanceSheet !== ctx.auto.usd.balanceSheet, "live position did not move");
    const again = (await api(`/api/daily-reports/snapshots/${ctx.auto.id}`, { token: T })).json.snapshot;
    for (const k of ["usd", "slsh"]) assert(JSON.stringify(again[k]) === JSON.stringify(ctx.auto[k]), `${k} figures changed`);
    assert(again.exchangeRate === 11000 && again.combined.usdEquivalent === ctx.auto.combined.usdEquivalent, "historical rate rewritten");
    assert(again.capturedAt === ctx.auto.capturedAt && again.businessDate === ctx.auto.businessDate, "timestamps changed");
  });
  await check("the live position is served separately and labelled live", async () => {
    const r = await api("/api/daily-reports/live", { token: T });
    assert(r.status === 200 && r.json.live === true && r.json.currencies.USD, JSON.stringify(r.json).slice(0, 200));
  });
  await check("snapshot detail shows the selected snapshot's stored values and the comparison with the previous one", async () => {
    const r = (await api(`/api/daily-reports/snapshots/${ctx.manual.id}`, { token: T })).json;
    assert(r.snapshot.id === ctx.manual.id && r.snapshot.usd.balanceSheet === ctx.manual.usd.balanceSheet, "wrong snapshot");
    assert(Array.isArray(r.runs) && r.runs.some((x) => x.status === "succeeded"), "audit history missing for an administrator");
    assert(Array.isArray(r.audit) && r.audit.some((a) => /snapshot/i.test(a.action)), "audit log entries missing");
  });

  console.log("\nMissed days and retry rules");
  await check("a day whose time passed while the server was off is recorded as missed — never back-filled", async () => {
    const h = db();
    const yesterday = new Date(Date.parse(tzNow().date) - 86400000).toISOString().slice(0, 10);
    ctx.yesterday = yesterday;
    try { h.q("UPDATE cmp0001_daily_snapshot_settings SET created_at = ? WHERE id = 1", [new Date(Date.now() - 5 * 86400000).toISOString()]); } finally { h.close(); }
    const run = await waitFor(async () => (await api("/api/daily-reports/runs?limit=50", { token: T })).json.runs.find((x) => x.business_date === yesterday && x.status === "missed"), 8000, "missed run");
    ctx.missedRun = run;
    const hist = (await api(`/api/daily-reports/balance-history?from=${yesterday}&to=${tzNow().date}`, { token: T })).json;
    const y = hist.days.find((d) => d.businessDate === yesterday);
    assert(y && y.available === false && y.reason === "missed", JSON.stringify(y));
    assert(!(await snaps(T)).snapshots.some((s) => s.businessDate === yesterday), "a snapshot was invented for yesterday");
  });
  await check("retrying a past day is refused (a snapshot is the position when it is taken)", async () => {
    const r = await api(`/api/daily-reports/runs/${ctx.missedRun.id}/retry`, { method: "POST", token: T });
    assert(r.status === 409 && /ended/.test(r.json.error), `${r.status} ${JSON.stringify(r.json)}`);
  });
  await check("the missed day is logged once, not on every scheduler tick", async () => {
    await sleep(2500);
    const n = (await api("/api/daily-reports/runs?limit=200", { token: T })).json.runs.filter((x) => x.business_date === ctx.yesterday && x.status === "missed").length;
    assert(n === 1, `logged ${n} times`);
  });

  console.log("\nCash Account history");
  await check("opening, cash in/out and transfers reconcile, transfers are not double counted", async () => {
    const mk = async (name, opening) => (await api("/api/cash/accounts", { method: "POST", token: T, body: { name, type: "physical_cash", currency: "USD", openingBalance: opening } })).json;
    const a = await mk("DR Till A", 1000), b = await mk("DR Till B", 0);
    ctx.tillA = a.account || a; ctx.tillB = b.account || b;
    let r = await api(`/api/cash/accounts/${ctx.tillA.id}/deposit`, { method: "POST", token: T, body: { amount: 200 } });
    assert(r.status < 300, `deposit ${r.status} ${JSON.stringify(r.json)}`);
    r = await api(`/api/cash/accounts/${ctx.tillA.id}/withdraw`, { method: "POST", token: T, body: { amount: 50.5 } });
    assert(r.status < 300, `withdraw ${r.status} ${JSON.stringify(r.json)}`);
    r = await api("/api/cash/transfers", { method: "POST", token: T, body: { fromCashAccountId: ctx.tillA.id, toCashAccountId: ctx.tillB.id, amount: 300, currency: "USD" } });
    assert(r.status < 300, `transfer ${r.status} ${JSON.stringify(r.json)}`);
    const today = tzNow().date;
    const h = (await api(`/api/daily-reports/cash-history?from=${today}&to=${today}&currency=USD`, { token: T })).json;
    const A = h.summaries.find((s) => s.accountId === ctx.tillA.id), B = h.summaries.find((s) => s.accountId === ctx.tillB.id);
    assert(A && B, "accounts missing");
    assert(A.transferOut === 300 && B.transferIn === 300 && A.transferIn === 0 && B.transferOut === 0, `transfers ${A.transferOut}/${B.transferIn}`);
    assert(A.cashOut === 50.5 && A.cashIn === 1200, `A cash in/out ${A.cashIn}/${A.cashOut}`);
    assert(A.closingBalance === 849.5 && B.closingBalance === 300, `closing ${A.closingBalance}/${B.closingBalance}`);
    assert(A.closingBalance === round2(A.openingBalance + A.totalIn - A.totalOut), "A does not reconcile");
    assert(A.reconciliation.ok && B.reconciliation.ok, "reconciliation should pass");
    assert(h.totals.USD.transferIn === h.totals.USD.transferOut, "transfers must net out across accounts");
    const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
    const next = (await api(`/api/daily-reports/cash-history?from=${tomorrow}&to=${tomorrow}&accountId=${ctx.tillA.id}`, { token: T })).json;
    assert(next.summaries[0].openingBalance === 849.5, `next day's opening ${next.summaries[0].openingBalance} (no gap, no double count)`);
    const day = h.rows.find((x) => x.accountId === ctx.tillA.id);
    assert(day && day.openingBalance === 0 && day.closingBalance === 849.5, JSON.stringify(day));
  });
  await check("a reconciliation difference is reported, and nothing is changed to hide it", async () => {
    const h = db();
    try { h.q("UPDATE cmp0001_cash_accounts SET balance = balance + 10 WHERE id = ?", [ctx.tillB.id]); } finally { h.close(); }
    const today = tzNow().date;
    const r = (await api(`/api/daily-reports/cash-history?from=${today}&to=${today}&currency=USD`, { token: T })).json;
    const B = r.summaries.find((s) => s.accountId === ctx.tillB.id);
    assert(r.discrepancies >= 1 && B.reconciliation.ok === false && B.reconciliation.difference === 10, JSON.stringify(B.reconciliation));
    const h2 = db();
    try { assert(h2.q("SELECT balance FROM cmp0001_cash_accounts WHERE id = ?", [ctx.tillB.id])[0].balance === 310, "report changed the balance"); h2.q("UPDATE cmp0001_cash_accounts SET balance = balance - 10 WHERE id = ?", [ctx.tillB.id]); } finally { h2.close(); }
  });
  await check("invalid ranges are refused safely", async () => {
    for (const q of ["from=2026-05-02&to=2026-05-01", "from=xx", "from=2020-01-01&to=2026-01-01"]) {
      const r = await api(`/api/daily-reports/balance-history?${q}`, { token: T });
      assert(r.status === 400, `${q} -> ${r.status}`);
    }
  });

  console.log("\nExports");
  await check("PDF and Excel exports of the snapshot list follow the filters and name the company", async () => {
    const today = tzNow().date;
    const pdf = await api(`/api/daily-reports/snapshots/export.pdf?from=${today}&to=${today}&source=manual`, { token: T });
    assert(pdf.status === 200 && pdf.buf.slice(0, 4).toString() === "%PDF", `pdf ${pdf.status}`);
    const t = await pdfText(pdf.buf);
    assert(/CMP-0001/.test(t) && /Manual/.test(t) && !/Automatic/.test(t), "PDF ignores the source filter or lacks the company");
    const x = await api(`/api/daily-reports/snapshots/export.xlsx?from=${today}&to=${today}`, { token: T });
    const xt = await xlsxText(x.buf);
    assert(x.status === 200 && /Balance Sheet \(USD\)/.test(xt) && /Balance Sheet \(SLSH\)/.test(xt), "Excel lacks separate currency columns");
    assert(xt.includes(String(ctx.auto.usd.balanceSheet)), "Excel lacks the stored USD figure");
  });
  await check("the single-snapshot report, Balance Sheet history and Cash Account history export to PDF and Excel", async () => {
    const today = tzNow().date;
    for (const p of [`/api/daily-reports/snapshots/${ctx.auto.id}/report`, `/api/daily-reports/balance-history/export`, `/api/daily-reports/cash-history/export`]) {
      for (const f of ["pdf", "xlsx"]) {
        const r = await api(`${p}.${f}?from=${ctx.yesterday}&to=${today}`, { token: T });
        assert(r.status === 200 && r.buf.length > 500, `${p}.${f} -> ${r.status}`);
      }
    }
    const det = await pdfText((await api(`/api/daily-reports/snapshots/${ctx.auto.id}/report.pdf`, { token: T })).buf);
    assert(/DAILY FINANCIAL SNAPSHOT/.test(det) && det.includes(ctx.auto.businessDate) && /11,000/.test(det), "detail PDF lacks the date or the stored rate");
    const bh = await pdfText((await api(`/api/daily-reports/balance-history/export.pdf?from=${ctx.yesterday}&to=${today}`, { token: T })).buf);
    assert(/No snapshot \(missed\)/.test(bh) && bh.includes(ctx.yesterday), `history PDF hides the missed day: ${bh.slice(0, 600)}`);
  });

  console.log("\nPermissions");
  await check("anonymous requests are refused (401)", async () => {
    for (const p of ["/api/daily-reports/status", "/api/daily-reports/snapshots", `/api/daily-reports/snapshots/${ctx.auto.id}/report.pdf`]) assert((await api(p)).status === 401, p);
  });
  await check("a Company Admin without Daily Reports permissions is refused everything (403)", async () => {
    const calls = [["GET", "/api/daily-reports/status"], ["GET", "/api/daily-reports/snapshots"], ["GET", `/api/daily-reports/snapshots/${ctx.auto.id}`],
      ["GET", "/api/daily-reports/cash-history"], ["GET", "/api/daily-reports/snapshots/export.pdf"], ["GET", "/api/daily-reports/settings"],
      ["PATCH", "/api/daily-reports/settings", { enabled: false }], ["POST", "/api/daily-reports/snapshots/run", { confirm: true }], ["POST", `/api/daily-reports/runs/${ctx.missedRun.id}/retry`]];
    for (const [method, p, body] of calls) { const r = await api(p, { method, token: ctx.adm, body }); assert(r.status === 403, `${method} ${p} -> ${r.status}`); }
    assert((await api("/api/daily-reports/status", { token: T })).json.enabled === true, "settings changed");
  });
  await check("view-only permission: can read reports, cannot export, change settings or run snapshots", async () => {
    const users = (await api("/api/users", { token: T })).json.users;
    const u = users.find((x) => x.username === "amina.yusuf");
    const r = await api(`/api/users/${u.id}/permissions`, { method: "PATCH", token: T, body: { overrides: [{ permissionKey: "dailyReports.view", granted: true }] } });
    assert(r.status === 200, `grant ${r.status} ${JSON.stringify(r.json)}`);
    ctx.adm = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: DEMO_PW } })).json.token;
    const s = await api("/api/daily-reports/status", { token: ctx.adm });
    assert(s.status === 200 && s.json.canManage === false && s.json.canExport === false, `status ${s.status} ${JSON.stringify(s.json)}`);
    // Audit details follow the existing Audit Log permission (Admin has it).
    const det = (await api(`/api/daily-reports/snapshots/${ctx.auto.id}`, { token: ctx.adm })).json;
    assert(det.snapshot.id === ctx.auto.id && Array.isArray(det.runs), "detail / audit (auditLog.view) missing");
    for (const [method, p, body] of [["GET", "/api/daily-reports/snapshots/export.xlsx"], ["GET", `/api/daily-reports/snapshots/${ctx.auto.id}/report.pdf`], ["PATCH", "/api/daily-reports/settings", { enabled: false }], ["POST", "/api/daily-reports/snapshots/run", { confirm: true }], ["GET", "/api/daily-reports/runs"]]) {
      const x = await api(p, { method, token: ctx.adm, body });
      assert(x.status === 403, `${method} ${p} -> ${x.status}`);
    }
  });

  console.log("\nCompany isolation");
  await check("Company B never sees Company A's snapshots, details or exports", async () => {
    const c = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Snapshot Beta Ltd", admin: { name: "Beta Admin", username: "sb.admin", password: "BetaPass123!" } } });
    assert(c.status === 201 || c.status === 200, `company ${c.status}`);
    ctx.bId = c.json.company.id;
    ctx.B = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: ctx.bId } })).json.token;
    const list = await snaps(ctx.B);
    assert(list.snapshots.every((s) => s.company !== (ctx.auto.company)), "B lists A's snapshots");
    assert(!list.snapshots.some((s) => s.id === ctx.auto.id || s.id === ctx.manual.id), "B lists A's snapshot ids");
    for (const p of [`/api/daily-reports/snapshots/${ctx.auto.id}`, `/api/daily-reports/snapshots/${ctx.auto.id}/report.pdf`, `/api/daily-reports/snapshots/${ctx.auto.id}/report.xlsx`]) {
      const r = await api(p, { token: ctx.B });
      assert(r.status === 404, `${p} from B -> ${r.status}`);
    }
    const r = await api(`/api/daily-reports/runs/${ctx.missedRun.id}/retry`, { method: "POST", token: ctx.B });
    assert(r.status === 404, `retry A's run from B -> ${r.status}`);
    const exp = await pdfText((await api(`/api/daily-reports/snapshots/export.pdf?from=2000-01-01`, { token: ctx.B })).buf);
    assert(!/CMP-0001/.test(exp) && new RegExp(ctx.bId).test(exp), "B's export names the wrong company");
  });
  await check("a manual snapshot in Company B stores only B's figures", async () => {
    const r = await api("/api/daily-reports/snapshots/run", { method: "POST", token: ctx.B, body: { confirm: true } });
    assert(r.status === 201, `B manual ${r.status}`);
    assert(r.json.snapshot.usd.balanceSheet === 0 && r.json.snapshot.slsh.balanceSheet === 0 && r.json.snapshot.company === "Snapshot Beta Ltd", JSON.stringify(r.json.snapshot).slice(0, 300));
    const aList = (await snaps(T)).snapshots;
    assert(!aList.some((s) => s.id === r.json.snapshot.id), "A lists B's snapshot");
    // B's automatic snapshot is due 2 minutes ago (for the failure phase).
    await api("/api/daily-reports/settings", { method: "PATCH", token: ctx.B, body: { enabled: false } });
  });
}

// Phase B: the database "fails" for every snapshot attempt.
async function phaseB() {
  console.log("\nFailures, restart recovery");
  await logins();
  ctx.B = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: ctx.bId } })).json.token;
  await check("a failing automatic snapshot is retried a few times, then reported as failed — nothing half-saved", async () => {
    const due = tzNow(TZ, -2);
    if (due.date !== tzNow().date) return;
    await api("/api/daily-reports/settings", { method: "PATCH", token: ctx.B, body: { enabled: true, runTime: due.time } });
    await waitFor(async () => (await api("/api/daily-reports/runs?limit=50", { token: ctx.B })).json.runs.filter((r) => r.status === "failed" && r.source === "automatic").length >= 3, 12000, "3 failed attempts");
    await sleep(2500);
    const runs = (await api("/api/daily-reports/runs?limit=50", { token: ctx.B })).json.runs.filter((r) => r.source === "automatic" && r.business_date === tzNow().date);
    assert(runs.filter((r) => r.status === "failed").length === 3, `attempts ${runs.length}`);
    assert(runs.every((r) => !/password|DB_|host=/i.test(r.error || "")), "error text leaks connection details");
    ctx.failedRun = runs.find((r) => r.status === "failed");
    const s = (await api("/api/daily-reports/status", { token: ctx.B })).json;
    assert(s.state === "failed" && s.todayError, JSON.stringify(s));
    assert(!(await snaps(ctx.B)).snapshots.some((x) => x.source === "automatic"), "a snapshot was saved despite the failure");
  });
  await check("after a restart Company A still has exactly one automatic snapshot for today", async () => {
    await sleep(2000);
    const a = (await snaps(ctx.A)).snapshots.filter((s) => s.businessDate === ctx.auto.businessDate && s.source === "automatic");
    assert(a.length === 1 && a[0].id === ctx.auto.id, `count ${a.length}`);
  });
}

async function phaseC() {
  console.log("\nRetry after the failure is fixed");
  await logins();
  ctx.B = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: ctx.bId } })).json.token;
  await check("an administrator's retry of today's failed run saves the snapshot; retrying again changes nothing", async () => {
    if (!ctx.failedRun) return;
    let r = await api(`/api/daily-reports/runs/${ctx.failedRun.id}/retry`, { method: "POST", token: ctx.B });
    assert(r.status === 201 && r.json.created === true && r.json.snapshot.source === "automatic", `retry ${r.status} ${JSON.stringify(r.json)}`);
    const id = r.json.snapshot.id;
    r = await api(`/api/daily-reports/runs/${ctx.failedRun.id}/retry`, { method: "POST", token: ctx.B });
    assert(r.status === 200 && r.json.created === false && r.json.snapshot.id === id, `second retry ${r.status} ${JSON.stringify(r.json)}`);
    const s = (await api("/api/daily-reports/status", { token: ctx.B })).json;
    assert(/^saved/.test(s.state), s.state);
  });
  await check("the existing Balance Sheet endpoint is unchanged (same figures as the shared calculation)", async () => {
    const a = (await api("/api/cash/balance-sheet", { token: ctx.A })).json, b = (await api("/api/daily-reports/live", { token: ctx.A })).json;
    assert(JSON.stringify(a.currencies) === JSON.stringify(b.currencies) && a.formula === "Debt + Cash Account - Credit", "differs");
  });
  await check("time-zone helpers: business date and DST-safe schedule", async () => {
    const S = require("../src/daily-snapshots");
    assert(S.businessDateOf(new Date("2026-11-01T21:30:00Z"), "Africa/Mogadishu") === "2026-11-02", "Mogadishu is UTC+3");
    assert(S.zonedToUtc("2026-11-01", "23:59", "Africa/Mogadishu").toISOString() === "2026-11-01T20:59:00.000Z", "23:59 EAT");
    assert(S.zonedToUtc("2026-07-01", "23:59", "America/New_York").toISOString() === "2026-07-02T03:59:00.000Z", "EDT");
    assert(S.zonedToUtc("2026-12-01", "23:59", "America/New_York").toISOString() === "2026-12-02T04:59:00.000Z", "EST");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nDaily Reports page");
  const sw = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0001" } });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await c.addInitScript(([tok, user]) => { try { localStorage.setItem("geeska_token", tok); localStorage.setItem("geeska_user", user); sessionStorage.setItem("obo_view", "dashboard"); } catch (e) { /* ignore */ } }, [sw.json.token, JSON.stringify(sw.json.user)]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    const go = async (label) => {
      const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
      const group = p.locator(".gk-nav-group").filter({ has: btn });
      if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(300); } }
      await btn.click(); await p.waitForTimeout(900);
    };
    await p.goto(BASE); await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    await check("Reports menu holds Reports Overview, Daily Reports, Balance Sheet Report, Cash Account Report, Financial History", async () => {
      for (const l of ["Reports Overview", "Daily Reports", "Balance Sheet Report", "Cash Account Report", "Financial History"]) {
        assert(await p.locator(".gk-nav-btn").filter({ hasText: new RegExp(`^\\s*${l}\\s*$`) }).count() === 1, `${l} missing`);
      }
    });
    await check("the existing Reports page still opens from Reports Overview", async () => {
      await go("Reports Overview");
      assert(await p.locator("h1", { hasText: /^Reports$/ }).count() === 1, "Reports page did not open");
    });
    await check("Daily Reports page: title, real status, 4 currency cards from the latest stored snapshot", async () => {
      await go("Daily Reports");
      await p.locator("h1", { hasText: "Daily Reports — Balance Sheet & Cash Account" }).waitFor({ timeout: 8000 });
      await p.waitForSelector('.gk-dr-status[data-state^="saved"]', { timeout: 8000 });
      const labels = await p.locator(".gk-dr-cards .gk-av-card-label").allInnerTexts();
      assert(labels.length === 4 && labels.some((l) => /Balance Sheet \(USD\)/.test(l)) && labels.some((l) => /Cash Account \(SLSH\)/.test(l)), labels.join(" | "));
      assert(/Historical/.test(await p.locator(".gk-dr-cardtag").innerText()) && /\d{4}-\d{2}-\d{2}/.test(await p.locator(".gk-dr-cardtag").innerText()), "cards are not labelled as a historical snapshot");
      if (process.env.DAILY_REPORTS_SHOT) await p.screenshot({ path: process.env.DAILY_REPORTS_SHOT, fullPage: true });
    });
    await check("Show live position switches the cards to clearly labelled LIVE figures", async () => {
      await p.getByRole("button", { name: "Show live position" }).click();
      await p.waitForSelector('.gk-dr-cards[data-live="1"]', { timeout: 5000 });
      assert((await p.locator(".gk-dr-cardtag").innerText()).includes("LIVE"), "not labelled live");
      await p.getByRole("button", { name: "Show latest snapshot" }).click();
    });
    await check("the history table lists the snapshots; the Source filter narrows it", async () => {
      await p.waitForSelector(".gk-dr-table tbody tr", { timeout: 8000 });
      const all = await p.locator(".gk-dr-table tbody tr").count();
      await p.getByLabel("Source").selectOption("manual"); await p.waitForTimeout(900);
      const manual = await p.locator(".gk-dr-table tbody tr").count();
      assert(all >= 2 && manual === 1, `${all} → ${manual}`);
      await p.getByRole("button", { name: "Reset Filters" }).click(); await p.waitForTimeout(800);
      assert(await p.locator(".gk-dr-table tbody tr").count() === all, "reset did not restore");
    });
    await check("clicking a row opens that snapshot's stored figures (not live ones)", async () => {
      await p.locator(".gk-dr-table tbody tr").filter({ hasText: "Automatic" }).first().click();
      const dlg = p.getByRole("dialog");
      await dlg.locator(`[data-snapshot-id="${ctx.auto.id}"]`).waitFor({ timeout: 6000 });
      const txt = await dlg.innerText();
      const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(ctx.auto.usd.balanceSheet));
      assert(txt.includes(usd), `stored USD balance sheet ${usd} not shown`);
      for (const t of ["Cash Account", "Balance Sheet Breakdown", "Daily Changes", "Audit History"]) assert(await dlg.getByRole("tab", { name: t }).count() === 1, `${t} tab missing`);
      await dlg.getByRole("tab", { name: "Audit History" }).click();
      assert(/succeeded/.test(await dlg.innerText()), "audit history empty");
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
      if (await p.getByRole("dialog").count()) await p.getByRole("dialog").getByRole("button", { name: /Close|×/ }).first().click();
    });
    await check("Excel export downloads the filtered period", async () => {
      const [d] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.locator(".gk-dr-filters").getByRole("button", { name: "Export Excel" }).click()]);
      assert(/^daily-snapshots-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/.test(d.suggestedFilename()), d.suggestedFilename());
    });
    await check("an invalid custom range shows an error state instead of data", async () => {
      await p.getByLabel("From").first().fill("2030-01-01"); await p.waitForTimeout(900);
      await p.locator(".gk-dr-error").first().waitFor({ timeout: 5000 });
      await p.getByRole("button", { name: "Reset Filters" }).click(); await p.waitForTimeout(600);
    });
    await check("Balance Sheet Report: days without a snapshot say so (missed), never a live figure", async () => {
      await go("Balance Sheet Report");
      await p.getByLabel("Period", { exact: true }).selectOption("last7"); await p.waitForTimeout(900);
      const missed = p.locator(`tr.gk-dr-missing[data-missing="missed"]`);
      assert(await missed.count() >= 1 && /No snapshot available — missed/.test(await missed.first().innerText()), "missed day not shown");
    });
    await check("Cash Account Report: period summary with reconciliation and daily rows", async () => {
      await go("Cash Account Report");
      await p.waitForSelector("text=Period summary", { timeout: 8000 });
      const t = await p.locator(".gk-dr-table").first().innerText();
      assert(/DR Till A/.test(t) && /Reconciled/.test(t), "summary missing");
      assert(await p.locator(".gk-dr-table").nth(1).locator("tbody tr").count() >= 1, "no daily rows");
    });
    await check("Snapshot Settings shows the real schedule and the execution history", async () => {
      await go("Daily Reports");
      await p.getByRole("button", { name: "Snapshot Settings" }).click();
      const dlg = p.getByRole("dialog");
      await dlg.getByLabel("Snapshot time").waitFor({ timeout: 5000 });
      assert(await dlg.getByLabel("Company time zone").inputValue() === TZ, "time zone");
      await dlg.locator('tr[data-run-status="succeeded"]').first().waitFor({ timeout: 6000 });
      assert(await dlg.locator('tr[data-run-status="missed"]').count() >= 1 && await dlg.locator('tr[data-run-status="succeeded"]').count() >= 1, "run history incomplete");
      await p.keyboard.press("Escape"); await p.waitForTimeout(300);
    });
    await check("phone width: no horizontal page scroll, cards stack", async () => {
      await p.setViewportSize({ width: 390, height: 860 }); await p.waitForTimeout(500);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `overflow ${over}px`);
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
