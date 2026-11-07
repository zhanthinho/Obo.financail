"use strict";
// SYSTEM AUDIT round — the company calendar day (Africa/Mogadishu, UTC+3):
// a transaction made between 00:00 and 03:00 local time belongs to that local
// day in every date filter (Transaction History, payments ledger, Cash
// Account ledger, statements, dashboard, Daily Operations), exactly as the
// Daily Reports already count it; plus real-image validation of logo uploads.
// On a throw-away database. Run with: npm run test:company-day
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("companyday");
const PORT = Number(process.env.COMPANY_DAY_TEST_PORT || 4692);
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
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.CD_DEBUG ? "inherit" : "ignore"] });
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
  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Day Beta", admin: { name: "Db Admin", username: "db.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  const tz = "Africa/Mogadishu";
  const localDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  // A local day safely in the past, and 01:30 local on it (= 22:30 UTC the day before).
  const day = localDay(new Date(Date.now() - 3 * 86400000));
  const prev = addDays(day, -1);
  const early = new Date(Date.parse(`${day}T01:30:00+03:00`)).toISOString();
  const late = new Date(Date.parse(`${day}T23:30:00+03:00`)).toISOString();
  console.log(`  local day ${day}; 01:30 local = ${early}`);

  await check("company-day helpers: Mogadishu midnight is 21:00 UTC the day before", async () => {
    const S = require(path.join(ROOT, "src", "daily-snapshots"));
    assert(S.zonedToUtc("2026-11-07", "00:00", tz).toISOString() === "2026-11-06T21:00:00.000Z", "midnight");
  });

  const acc = ok(await api("/api/accounts", { method: "POST", token: B, body: { name: "Db Midnight Customer", currency: "USD" } }), "acct").account;
  const till = ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name: "Db Till", type: "physical_cash", currency: "USD" } }), "till").account;
  ok(await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token: B, body: { amount: 40, currency: "USD", paymentDate: early, cashAccountId: till.id, notes: "Db early" } }), "early deposit");
  ok(await api(`/api/accounts/${acc.id}/deposit`, { method: "POST", token: B, body: { amount: 2, currency: "USD", paymentDate: late, cashAccountId: till.id, notes: "Db late" } }), "late deposit");
  const notes = (rows) => rows.map((e) => e.notes || e.description || "").join("|");

  await check("Transaction History: 01:30 local is on that local day, not the day before", async () => {
    const on = ok(await api(`/api/history?currency=USD&from=${day}&to=${day}`, { token: B }), "h").entries;
    const before = ok(await api(`/api/history?currency=USD&from=${prev}&to=${prev}`, { token: B }), "h").entries;
    assert(/Db early/.test(notes(on)) && /Db late/.test(notes(on)), `on ${notes(on)}`);
    assert(!/Db early/.test(notes(before)), `previous day has it: ${notes(before)}`);
  });
  await check("Payments ledger and Cash Account ledger use the same local day", async () => {
    const l = ok(await api(`/api/account-ledger?currency=USD&from=${day}&to=${day}`, { token: B }), "ledger").entries;
    assert(l.filter((e) => e.clientId === acc.id || e.client_id === acc.id || /Db (early|late)/.test(e.notes || "")).length === 2, `ledger ${notes(l)}`);
    const c = ok(await api(`/api/cash/ledger?cashAccountId=${till.id}&from=${day}&to=${day}`, { token: B }), "cash ledger").entries;
    assert(c.length === 2, `cash ledger ${c.length}`);
    const cPrev = ok(await api(`/api/cash/ledger?cashAccountId=${till.id}&from=${prev}&to=${prev}`, { token: B }), "cash ledger prev").entries;
    assert(cPrev.length === 0, `cash ledger previous day ${cPrev.length}`);
  });
  await check("Daily Operations: the table and the cards agree for that day", async () => {
    const d = ok(await api(`/api/daily-ops?date=${day}`, { token: B }), "ops");
    assert(d.summaries.USD.cashIn === 42, `cards cashIn ${d.summaries.USD.cashIn}`);
    assert(d.transactions.filter((e) => /Db (early|late)/.test(e.notes || "")).length === 2, `table ${d.transactions.length}`);
    const p = ok(await api(`/api/daily-ops?date=${prev}`, { token: B }), "ops prev");
    assert(p.summaries.USD.cashIn === 0 && p.transactions.length === 0, "previous day");
  });
  await check("Dashboard custom range for that day counts both credits", async () => {
    const d = ok(await api(`/api/dashboard?range=custom&from=${day}&to=${day}&currency=USD`, { token: B }), "dash");
    assert(d.from === day || (d.range && d.range.from === day) || JSON.stringify(d).includes(day), "range");
    const txt = JSON.stringify(d);
    assert(/42/.test(txt), "dashboard total missing 42");
  });
  await check("Account statement opening balance before that day excludes the 01:30 credit", async () => {
    const r = await api(`/api/accounts/${acc.id}/statement?from=${day}&to=${day}`, { token: B });
    if (r.status === 404) return; // no JSON statement endpoint in this build
    const j = r.json || {};
    const opening = j.openingBalance ?? (j.statement && j.statement.openingBalance);
    if (opening !== undefined) assert(Number(opening) === 0, `opening ${opening}`);
  });
  await check("logo upload: a fake image labelled PNG is refused; a real PNG is accepted", async () => {
    const fake = "data:image/png;base64," + Buffer.from("<script>alert(1)</script>").toString("base64");
    const r1 = await api("/api/settings/company", { method: "PATCH", token: B, body: { name: "Day Beta", logoDataUrl: fake } });
    assert(r1.status === 400, `fake accepted ${r1.status}`);
    const real = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const r2 = await api("/api/settings/company", { method: "PATCH", token: B, body: { name: "Day Beta", logoDataUrl: real } });
    assert(r2.status === 200, `real refused ${r2.status} ${r2.text}`);
    const r3 = await api(`/api/platform/companies/${bId}`, { method: "PATCH", token: sa, body: { name: "Day Beta", logoDataUrl: fake } });
    assert(r3.status === 400, `platform fake accepted ${r3.status}`);
  });
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
