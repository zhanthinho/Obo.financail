"use strict";
// SECURITY & INTEGRITY AUDIT round — regression tests for the defects found
// and fixed in this round, plus one complete transaction lifecycle.
//   1. Quotations could be read and exported by any signed-in user (cashier,
//      viewer) — now quotations.view is required, and one-currency roles see
//      only their currency.
//   2. A repeated submission (double click, network retry) posted money
//      twice — now an Idempotency-Key makes it post once.
//   3. "Infinity" / 1e308 amounts were accepted and broke balances — now
//      every money amount must be a finite number within range.
//   4. The change-password endpoint allowed unlimited guesses of the current
//      password with a stolen session — now locked after 5 wrong answers.
//   5. Lifecycle: create → ledger → balance → history → another company
//      can't touch it → duplicate is ignored → reversal restores everything;
//      and a full reconciliation of balances against ledgers at the end.
//
// Run with: npm run test:audit
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".audit-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("audit");
const PORT = Number(process.env.AUDIT_TEST_PORT || 4396);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const B_ADMIN = { name: "Hodan Berbera", username: "hodan.berbera", password: "Berbera-Admin-Pass-31" };

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, key, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch(BASE + p, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text, replay: res.headers.get("idempotent-replay") === "true" };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;
const key = () => "t-" + crypto.randomBytes(10).toString("hex");
function dbq(sql, ...params) {
  const db = require("./helpers/mysql").openScope(TESTDB.env, { companyId: "CMP-0001", readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

const ctx = {};
async function setup() {
  ctx.sa = await login("super.admin", SA_PW);
  const companies = (await api("/api/platform/companies", { token: ctx.sa })).json.companies;
  ctx.A = companies[0].id;
  ctx.saA = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: ctx.A } })).json.token;
  ctx.admin = await login("amina.yusuf");
  ctx.cashier = await login("cabdi.maxamed");
  ctx.viewer = await login("sahra.ismail");
  ctx.sales = await login("ilhan.nuur");
  const till = await api("/api/cash/accounts", { method: "POST", token: ctx.saA, body: { name: "Audit Till", type: "physical_cash", currency: "USD", openingBalance: 1000 } });
  assert(till.status === 201, `till: ${till.status} ${till.text}`);
  ctx.till = till.json.account;
  ctx.acct = (await api("/api/accounts?currency=USD", { token: ctx.saA })).json.accounts.find((a) => a.status === "active");
  const b = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Berbera Second Co", admin: B_ADMIN } });
  assert(b.status === 201, `Company B: ${b.status} ${b.text}`);
  ctx.bAdmin = await login(B_ADMIN.username, B_ADMIN.password);
  // A one-currency quotation reader, and a throw-away user for the password test.
  const role = await api("/api/roles", { method: "POST", token: ctx.saA, body: { name: "USD Quote Reader", permissions: ["quotations.view", "currency.usd"] } });
  assert(role.status === 201, `role: ${role.status} ${role.text}`);
  for (const [username, roleId] of [["usd.reader", role.json.role.id], ["pw.target", role.json.role.id]]) {
    const u = await api("/api/users", { method: "POST", token: ctx.saA, body: { name: username, username, password: "Reader-Pass-2026x", roleId } });
    assert(u.status === 201, `user ${username}: ${u.status} ${u.text}`);
  }
  ctx.usdReader = await login("usd.reader", "Reader-Pass-2026x");
  ctx.pwTarget = await login("pw.target", "Reader-Pass-2026x");
}
const balanceOf = async (id) => (await api(`/api/accounts/${id}`, { token: ctx.saA })).json.account.balance;
const cashOf = async (id) => (await api("/api/cash/accounts?status=all", { token: ctx.saA })).json.accounts.find((a) => a.id === id).balance;

async function quotationChecks() {
  console.log("\n1. Quotation read access");
  const all = (await api("/api/quotations", { token: ctx.saA })).json.quotations;
  ctx.quotes = all;
  await check("a cashier and a viewer (no quotation permission) can't read, open or export quotations", async () => {
    assert(all.length > 0, "seed has quotations");
    const id = all[0].id;
    for (const [who, t] of [["cashier", ctx.cashier], ["viewer", ctx.viewer]]) {
      for (const p of ["/api/quotations", "/api/quotations/counts", "/api/quotations/export.csv", "/api/quotations/export.pdf", `/api/quotations/${id}`, `/api/quotations/${id}/pdf`, `/api/quotations/${id}/xlsx`]) {
        const r = await api(p, { token: t });
        assert(r.status === 403, `${who} ${p}: ${r.status}`);
      }
    }
  });
  await check("roles with quotation access keep it (sales, admin)", async () => {
    for (const t of [ctx.sales, ctx.admin]) {
      assert((await api("/api/quotations", { token: t })).json.quotations.length === all.length, "list");
      assert((await api(`/api/quotations/${all[0].id}/pdf`, { token: t })).status === 200, "pdf");
    }
  });
  await check("a USD-only role sees only USD quotations; an SLSH one can't be opened by id", async () => {
    const mine = (await api("/api/quotations", { token: ctx.usdReader })).json.quotations;
    assert(mine.every((q) => !q.chargedCurrency || q.chargedCurrency === "USD"), "non-USD quotation listed");
    assert(mine.length === all.filter((q) => !q.chargedCurrency || q.chargedCurrency === "USD").length, "USD quotation missing");
    const slsh = all.find((q) => q.chargedCurrency === "SLSH");
    if (slsh) assert((await api(`/api/quotations/${slsh.id}`, { token: ctx.usdReader })).status === 404, "SLSH quotation opened");
    const counts = (await api("/api/quotations/counts", { token: ctx.usdReader })).json;
    assert(Object.values(counts).reduce((s, n) => s + n, 0) === mine.length, "counts include other currency");
  });
}

async function amountChecks() {
  console.log("\n3. Amount validation");
  const bad = ["Infinity", 1e308, -5, 0, "abc", 1e13];
  await check("impossible amounts are refused everywhere money comes in (and nothing moves)", async () => {
    const b0 = await balanceOf(ctx.acct.id), c0 = await cashOf(ctx.till.id);
    for (const amount of bad) {
      const tries = [
        [`/api/accounts/${ctx.acct.id}/deposit`, { amount, currency: "USD", cashAccountId: ctx.till.id }],
        [`/api/accounts/${ctx.acct.id}/withdraw`, { amount, currency: "USD", cashAccountId: ctx.till.id }],
        [`/api/cash/accounts/${ctx.till.id}/deposit`, { amount }],
        ["/api/transactions", { clientName: "Audit Walk-in", amountGiven: amount, currencyGiven: "USD" }],
        ["/api/loans", { clientId: ctx.acct.id, cashAccountId: ctx.till.id, amount }],
      ];
      for (const [p, body] of tries) {
        const r = await api(p, { method: "POST", token: ctx.saA, body });
        assert(r.status === 400, `${p} accepted ${amount}: ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    const huge = await api("/api/transactions", { method: "POST", token: ctx.saA, body: { clientName: "Audit", amountGiven: 10, currencyGiven: "USD", rateUsed: "Infinity" } });
    assert(huge.status === 400, `infinite rate: ${huge.status}`);
    const raw = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, raw: `{"amount":1e400,"currency":"USD","cashAccountId":"${ctx.till.id}"}` });
    assert(raw.status === 400 && /Invalid number/.test(raw.text), `1e400: ${raw.status} ${raw.text}`);
    const ob = await api("/api/balances", { method: "POST", token: ctx.saA, body: { usd: "Infinity", slsh: 0 } });
    assert(ob.status === 400, `opening balances: ${ob.status}`);
    assert(near(await balanceOf(ctx.acct.id), b0) && near(await cashOf(ctx.till.id), c0), "a balance moved");
  });
}

async function idempotencyChecks() {
  console.log("\n2. Duplicate submissions");
  await check("the same deposit sent 3 times at once and once more later posts exactly once", async () => {
    const b0 = await balanceOf(ctx.acct.id), c0 = await cashOf(ctx.till.id);
    const k = key();
    const body = { amount: 40, currency: "USD", cashAccountId: ctx.till.id, notes: "idempotency" };
    const rs = await Promise.all([1, 2, 3].map(() => api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, body, key: k })));
    const later = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, body, key: k });
    assert([...rs, later].every((r) => r.status === 200), rs.map((r) => r.status).join(","));
    assert([...rs, later].filter((r) => r.replay).length === 3, "expected 3 replays");
    assert(near(await balanceOf(ctx.acct.id), b0 + 40) && near(await cashOf(ctx.till.id), c0 + 40), "posted more than once");
    assert(dbq("SELECT COUNT(*) n FROM account_ledger WHERE notes = 'idempotency'")[0].n === 1, "ledger rows");
  });
  await check("every money endpoint honours it (exchange, transfer, cash movements, loan)", async () => {
    const other = (await api("/api/accounts?currency=USD", { token: ctx.saA })).json.accounts.filter((a) => a.status === "active" && a.id !== ctx.acct.id)[0];
    const cases = [
      ["/api/transactions", { clientName: "Audit Walk-in", amountGiven: 5, currencyGiven: "USD" }, "SELECT COUNT(*) n FROM exchange_transactions"],
      ["/api/transfers", { fromAccountId: ctx.acct.id, toAccountId: other.id, amount: 3 }, "SELECT COUNT(*) n FROM transfers"],
      [`/api/cash/accounts/${ctx.till.id}/withdraw`, { amount: 2 }, "SELECT COUNT(*) n FROM cash_ledger"],
      ["/api/loans", { clientId: ctx.acct.id, cashAccountId: ctx.till.id, amount: 7 }, "SELECT COUNT(*) n FROM cash_loans"],
    ];
    for (const [p, body, countSql] of cases) {
      const n0 = dbq(countSql)[0].n;
      const k = key();
      const rs = await Promise.all([1, 2].map(() => api(p, { method: "POST", token: ctx.saA, body, key: k })));
      assert(rs.every((r) => r.status < 300), `${p}: ${rs.map((r) => `${r.status} ${r.text.slice(0, 80)}`).join(" | ")}`);
      assert(dbq(countSql)[0].n === n0 + 1, `${p} created ${dbq(countSql)[0].n - n0} records`);
    }
  });
  await check("a key never crosses users, endpoints or a refused request", async () => {
    const k = key();
    const a = await api(`/api/cash/accounts/${ctx.till.id}/deposit`, { method: "POST", token: ctx.saA, body: { amount: 1 }, key: k });
    const otherPath = await api(`/api/cash/accounts/${ctx.till.id}/withdraw`, { method: "POST", token: ctx.saA, body: { amount: 1 }, key: k });
    assert(a.status === 201 && otherPath.status === 201 && !otherPath.replay, "another endpoint replayed");
    const otherUser = await api(`/api/cash/accounts/${ctx.till.id}/deposit`, { method: "POST", token: ctx.admin, body: { amount: 1 }, key: k });
    assert(!otherUser.replay, "another user got a stored answer");
    const k2 = key();
    const refused = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, body: { amount: -1, currency: "USD", cashAccountId: ctx.till.id }, key: k2 });
    const again = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, body: { amount: -1, currency: "USD", cashAccountId: ctx.till.id }, key: k2 });
    assert(refused.status === 400 && again.status === 400 && again.replay, "a refused request should replay its refusal");
  });
}

async function passwordChecks() {
  console.log("\n4. Password change guessing");
  await check("after 5 wrong current passwords the change is locked, even with the right one", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await api("/api/auth/me/password", { method: "POST", token: ctx.pwTarget, body: { currentPassword: `wrong-${i}`, newPassword: "Brand-New-Pass-2026x" } });
      assert(r.status === 400, `attempt ${i}: ${r.status}`);
    }
    const r = await api("/api/auth/me/password", { method: "POST", token: ctx.pwTarget, body: { currentPassword: "Reader-Pass-2026x", newPassword: "Brand-New-Pass-2026x" } });
    assert(r.status === 429, `expected lock, got ${r.status} ${r.text}`);
    assert((await api("/api/auth/login", { method: "POST", body: { username: "pw.target", password: "Reader-Pass-2026x" } })).status === 200, "password must be unchanged");
  });
}

async function lifecycle() {
  console.log("\n5. A complete transaction lifecycle");
  let entry;
  const b0 = await balanceOf(ctx.acct.id), c0 = await cashOf(ctx.till.id);
  await check("create: a deposit is stored once, with its ledger entry and its Cash in Hand leg", async () => {
    const r = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.saA, body: { amount: 250.5, currency: "USD", cashAccountId: ctx.till.id, notes: "lifecycle" }, key: key() });
    assert(r.status === 200, r.text);
    entry = dbq("SELECT * FROM account_ledger WHERE notes = 'lifecycle'");
    assert(entry.length === 1 && entry[0].amount === 250.5 && entry[0].type === "deposit" && entry[0].client_id === ctx.acct.id, JSON.stringify(entry));
    entry = entry[0];
    const leg = dbq("SELECT * FROM cash_ledger WHERE cash_account_id = ? AND amount = 250.5", ctx.till.id);
    assert(leg.length === 1 && leg[0].type === "deposit", `cash leg: ${JSON.stringify(leg)}`);
  });
  await check("balances: the account and the till each move by exactly the amount", async () => {
    assert(near(await balanceOf(ctx.acct.id), b0 + 250.5), "account balance");
    assert(near(await cashOf(ctx.till.id), c0 + 250.5), "till balance");
  });
  await check("history and reports show it once", async () => {
    const h = await api("/api/history?currency=USD", { token: ctx.saA });
    const rows = (h.json.entries || h.json.history || h.json.rows || []).filter((x) => x.id === entry.id || x.referenceNumber === entry.reference_number || x.reference === entry.reference_number);
    assert(rows.length === 1, `history rows: ${rows.length} (${Object.keys(h.json).join(",")})`);
    const d = (await api("/api/dashboard?range=thisMonth", { token: ctx.saA })).json;
    const ledgerSum = dbq("SELECT SUM(amount) n FROM account_ledger WHERE source_type IS NULL AND type='deposit' AND currency='USD' AND date(date) >= date(?) AND date(date) <= date(?)", d.meta.from, d.meta.to)[0].n;
    assert(near(d.summary.paymentsReceived.usd, ledgerSum), `dashboard ${d.summary.paymentsReceived.usd} vs ledger ${ledgerSum}`);
  });
  await check("another company can't see, change or reverse it", async () => {
    assert((await api(`/api/accounts/${ctx.acct.id}`, { token: ctx.bAdmin })).status === 404, "B reads A's account");
    assert((await api(`/api/account-ledger/${entry.id}`, { method: "DELETE", token: ctx.bAdmin })).status === 404, "B deletes A's entry");
    assert((await api(`/api/account-ledger/${entry.id}`, { method: "PATCH", token: ctx.bAdmin, body: { amount: 1 } })).status === 404, "B edits A's entry");
    assert(near(await balanceOf(ctx.acct.id), b0 + 250.5), "A's balance changed");
  });
  await check("reversal: deleting it removes both legs and restores both balances", async () => {
    const r = await api(`/api/account-ledger/${entry.id}`, { method: "DELETE", token: ctx.saA, body: { reason: "audit test" } });
    assert(r.status === 200, r.text);
    assert(near(await balanceOf(ctx.acct.id), b0) && near(await cashOf(ctx.till.id), c0), "balances not restored");
    assert(dbq("SELECT COUNT(*) n FROM cash_ledger WHERE cash_account_id = ? AND amount = 250.5", ctx.till.id)[0].n === 0, "cash leg left behind");
  });
  await check("reconciliation: every stored balance equals its ledger; no orphaned or double-posted movements", async () => {
    const issues = [];
    for (const c of dbq("SELECT id, account_number, balance_usd, balance_slsh FROM clients")) {
      for (const [cur, col] of [["USD", "balance_usd"], ["SLSH", "balance_slsh"]]) {
        const s = dbq("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) n FROM account_ledger WHERE client_id=? AND currency=?", c.id, cur)[0].n;
        if (!near(s, c[col])) issues.push(`${c.account_number} ${cur}: ${c[col]} vs ${s}`);
      }
    }
    for (const a of dbq("SELECT id, name, balance FROM cash_accounts")) {
      const s = dbq("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) n FROM cash_ledger WHERE cash_account_id=?", a.id)[0].n;
      if (!near(s, a.balance)) issues.push(`cash ${a.name}: ${a.balance} vs ${s}`);
    }
    const orphans = dbq("SELECT COUNT(*) n FROM account_ledger WHERE client_id NOT IN (SELECT id FROM clients)")[0].n
      + dbq("SELECT COUNT(*) n FROM cash_ledger WHERE cash_account_id NOT IN (SELECT id FROM cash_accounts)")[0].n;
    if (orphans) issues.push(`${orphans} orphaned ledger rows`);
    assert(!issues.length, issues.slice(0, 5).join("; "));
  });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    await waitUp(); await setup();
    await quotationChecks(); await idempotencyChecks(); await amountChecks(); await passwordChecks(); await lifecycle();
  } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
