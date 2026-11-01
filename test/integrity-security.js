"use strict";
// FINMAN SECURITY & INTEGRITY round — company isolation, financial integrity
// and backend security, on a throw-away installation with two companies.
//
//   1. Isolation: Company B, signed in with EVERY permission (the Super
//      Admin inside Company B's workspace) and as its own Company Admin,
//      tries Company A's real record ids in every URL of every API route,
//      in request bodies, in searches, reports and exports — and never sees
//      or changes a byte of Company A's data. Dashboards, reports and the
//      daily-snapshot background job stay company-specific; switching
//      company gives a token for that company only.
//   2. Financial integrity: a save that fails just before COMMIT leaves no
//      partial record (deposits, withdrawals, exchanges, transfers, cash
//      movements, expenses, loans, quotation payments); simultaneous
//      postings never lose an update; repeated submissions post once;
//      exchange profit follows the documented formula and keeps the rate
//      of its own day; USD and SLSH are never added together; every stored
//      balance equals its own ledger.
//   3. Backend security: forged, expired and signed-out tokens, malformed
//      and hostile input, oversized bodies, file downloads and error
//      responses.
//
// Run with: npm run test:integrity-security
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("intsec");
const PORT = Number(process.env.INTSEC_TEST_PORT || 4640);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0", FINMAN_TEST_MODE: "1" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const MARK = "ALPHAMARK"; // only ever in Company A's records

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, opts = {}) {
  // One retry on a dropped keep-alive connection (a client/server idle-timeout
  // race, not an answer); a server that really stopped fails the retry too.
  try { return await api0(p, opts); } catch (e0) { /* retry once */ }
  try { return await api0(p, opts); } catch (e) { return { status: 0, json: null, text: `FETCH FAILED ${opts.method || "GET"} ${p}: ${e.cause ? e.cause.code || e.cause.message : e.message}`, headers: new Map(), replay: false, fetchFailed: true }; }
}
async function api0(p, { method = "GET", body, token, headers = {}, rawBody } = {}) {
  const h = { ...(body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  const r = await fetch(BASE + p, { method, headers: h, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers, replay: r.headers.get("idempotent-replay") === "true" };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json?.token;
function q(sql, p = []) {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  try { const r = c.query(sql, p); return r.rows || r; } finally { c.close(); }
}
const key = () => `k${crypto.randomBytes(10).toString("hex")}`;
const today = () => new Date().toISOString().slice(0, 10);

const tablesOf = (prefix) => q("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((r) => r.n).filter((n) => n.startsWith(`${prefix}_`)).sort();
// Every table of one company, hashed (audit / session tables excluded: they
// legitimately record refused attempts).
const VOLATILE = /^(audit_log|reset_log|table_layouts|tenant_meta|daily_snapshot_runs)$/;
function companyChecksum(prefix) {
  const tables = tablesOf(prefix);
  const h = crypto.createHash("sha256");
  const out = {};
  for (const t of tables) {
    const short = t.slice(prefix.length + 1);
    if (VOLATILE.test(short)) continue;
    const rows = q(`SELECT * FROM "${t}" ORDER BY 1`);
    const s = JSON.stringify(rows, (k, v) => (/^(last_login|last_login_at|updated_at|last_seen_at)$/.test(k) ? undefined : v));
    out[short] = crypto.createHash("sha1").update(s).digest("hex");
    h.update(`${short}=${out[short]}`);
  }
  return { all: h.digest("hex"), tables: out };
}
function diffTables(a, b) { return Object.keys(a.tables).filter((k) => a.tables[k] !== b.tables[k]); }
// Money tables of one company (for the atomicity checks).
const MONEY = ["account_ledger", "cash_ledger", "exchange_transactions", "transfers", "cash_transfers", "cash_exchanges", "expenses", "expense_attachments", "cash_loans", "cash_loan_payments", "quotation_payments", "quotations", "clients", "cash_accounts", "exchange_fund_allocations"];
function moneyState(prefix = "cmp0001") {
  return MONEY.map((t) => {
    const rows = q(`SELECT * FROM "${prefix}_${t}" ORDER BY 1`);
    return `${t}:${rows.length}:${crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex")}`;
  }).join("|");
}

// Every API route, read from the route modules exactly as server.js registers them.
function allRoutes() {
  const prev = process.env.JWT_SECRET; process.env.JWT_SECRET = JWT_SECRET;
  const { Router } = require("../src/router");
  const list = [];
  const r = new Router();
  const orig = r._add.bind(r);
  r._add = (method, pattern, handler) => { list.push({ method, pattern }); return orig(method, pattern, handler); };
  const src = require("fs").readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  for (const m of src.match(/require\("\.\/routes\/[A-Za-z]+"\)/g)) require(path.join(ROOT, "src", m.slice(9, -2))).register(r);
  process.env.JWT_SECRET = prev;
  return list;
}

let srv, serverErr = "";
async function startServer() {
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
}

async function main() {
  console.log("Seeding a throw-away installation (Company A = CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  await startServer();
  try { await run(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 300));
  // Injected faults are logged by design; anything else unexpected fails.
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l) && !/Injected test failure|TEST_TX_FAULT/.test(l));
  const unhandled = leaked.filter((l, i, arr) => !(arr[i + 1] || "").includes("Injected test failure"));
  if (unhandled.length) failures.push("server logged unexpected errors:\n      " + unhandled.slice(0, 12).join("\n      "));
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function setup() {
  const sa = ctx.sa = await login("super.admin", SA_PW);
  ctx.saA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  ctx.adminA = await login("amina.yusuf", PW);
  const A = ctx.saA;
  const post = async (p, body, tok = A) => {
    const r = await api(p, { method: "POST", token: tok, body });
    if (r.status >= 300) console.log(`    setup ${p} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r.json || {};
  };
  // ---- Company A: marked records in every module ----
  await post("/api/rate-history", { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700, note: MARK });
  ctx.aUsd = (await post("/api/accounts", { name: `${MARK} Usd Customer`, currency: "USD", openingBalance: 1000, contact: "+252 63 9000001", notes: MARK })).account;
  ctx.aUsd2 = (await post("/api/accounts", { name: `${MARK} Second`, currency: "USD", openingBalance: 50 })).account;
  ctx.aSlsh = (await post("/api/accounts", { name: `${MARK} Usd Customer`, currency: "SLSH", openingBalance: 2000000, contact: "+252 63 9000001" })).account;
  ctx.aCashU = (await post("/api/cash/accounts", { name: `${MARK} Till`, type: "physical_cash", currency: "USD", openingBalance: 5000 })).account;
  ctx.aCashU2 = (await post("/api/cash/accounts", { name: `${MARK} Safe`, type: "bank", currency: "USD", openingBalance: 100 })).account;
  ctx.aCashS = (await post("/api/cash/accounts", { name: `${MARK} Till S`, type: "bank", currency: "SLSH", openingBalance: 50000000 })).account;
  ctx.aEx = (await post("/api/transactions", { clientName: ctx.aUsd.name, clientAccountId: ctx.aUsd.id, receivingAccountId: ctx.aSlsh.id, amountGiven: 10, currencyGiven: "USD", notes: MARK })).transaction;
  ctx.aTr = (await post("/api/transfers", { fromAccountId: ctx.aUsd.id, toAccountId: ctx.aUsd2.id, amount: 5, currency: "USD", notes: MARK })).transfer;
  await post(`/api/accounts/${ctx.aUsd.id}/deposit`, { amount: 7, currency: "USD", cashAccountId: ctx.aCashU.id, notes: MARK });
  await post(`/api/cash/accounts/${ctx.aCashU.id}/deposit`, { amount: 4, description: MARK });
  ctx.aQuote = (await post("/api/quotations", { clientName: ctx.aUsd.name, accountId: ctx.aUsd.id, currency: "USD", items: [{ description: `${MARK} item`, qty: 1, unitPrice: 50, currency: "USD" }], notes: MARK })).quotation;
  const meta = (await api("/api/expenses/meta", { token: A })).json || {};
  ctx.cat = (meta.categories || [])[0];
  const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARK)]).toString("base64");
  ctx.aExp = (await post("/api/expenses", { date: today(), categoryId: ctx.cat.id, description: `${MARK} rent`, amount: 2, currency: "USD", cashAccountId: ctx.aCashU.id, notes: MARK, attachment: { fileName: `${MARK}.png`, dataUrl: png } })).expense;
  ctx.aLoan = (await post("/api/loans", { cashAccountId: ctx.aCashU.id, clientId: ctx.aUsd.id, amount: 1, date: new Date().toISOString(), notes: MARK })).loan;
  await post("/api/daily-reports/snapshots/run", { confirm: true });

  // ---- Company B with its own admin, and the Super Admin inside B ----
  const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Bravo Exchange", admin: { name: "Bravo Admin", username: "bravo.admin", password: "BravoPass-2026x" } } });
  assert(c.status === 201, `company B ${c.status} ${c.text}`);
  ctx.bId = ((await api("/api/platform/companies", { token: sa })).json.companies || []).find((x) => x.name === "Bravo Exchange").id;
  ctx.adminB = await login("bravo.admin", "BravoPass-2026x");
  ctx.saB = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: ctx.bId } })).json.token;
  ctx.bPrefix = ctx.bId.toLowerCase().replace("-", "");
  const B = ctx.saB;
  await post("/api/rate-history", { dailyRate: 8000, saleRate: 8000, costRate: 8100, buyRate: 7900, sellRate: 8200 }, B);
  ctx.bUsd = (await post("/api/accounts", { name: "Bravo Customer", currency: "USD", openingBalance: 300 }, B)).account;
  ctx.bSlsh = (await post("/api/accounts", { name: "Bravo Customer", currency: "SLSH", openingBalance: 900000 }, B)).account;
  ctx.bCashU = (await post("/api/cash/accounts", { name: "Bravo Till", type: "physical_cash", currency: "USD", openingBalance: 700 }, B)).account;
}

async function run() {
  const routes = allRoutes();
  await setup();
  const only = process.env.INTSEC_ONLY || "";
  if (!only || only === "isolation") await isolation(routes);
  if (!only || only === "financial") await financial();
  if (!only || only === "security") await security();
}

// ---------------------------------------------------------------------------
async function isolation(routes) {
  console.log("\n1. Company isolation");
  const A = ctx.saA, B = ctx.saB;
  await check("setup: Company A holds marked records in every module; Company B its own", async () => {
    for (const [k, v] of Object.entries({ aUsd: ctx.aUsd, aSlsh: ctx.aSlsh, aCashU: ctx.aCashU, aEx: ctx.aEx, aTr: ctx.aTr, aQuote: ctx.aQuote, aExp: ctx.aExp, aLoan: ctx.aLoan, bUsd: ctx.bUsd, bCashU: ctx.bCashU })) assert(v && v.id, `${k} missing`);
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_daily_snapshots")[0].n >= 1, "A snapshot");
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_expense_attachments")[0].n === 1, "A attachment");
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_customers")[0].n >= 1, "A customer profiles");
  });

  // Company A's ids, one or more per entity type, read from its own tables.
  const ids = new Set();
  for (const t of ["clients", "exchange_transactions", "transfers", "quotations", "quotation_items", "account_ledger", "cash_accounts", "cash_ledger", "cash_loans", "expenses", "expense_categories", "users", "roles", "daily_snapshots", "daily_snapshot_runs", "customers", "pdf_templates", "excel_templates", "rate_history"]) {
    for (const r of q(`SELECT id FROM "cmp0001_${t}" ORDER BY 1 LIMIT 3`)) ids.add(String(r.id));
  }
  // (CUST-/ACC- numbers are per-company sequences — every company has its
  // own CUST-0001 — so they are not used as Company A identifiers.)
  // Ids that also exist in Company B's own tables (built-in roles, templates
  // and categories every company is seeded with) are B's own records.
  const bTables = tablesOf(ctx.bPrefix);
  const bOwn = new Set();
  const withId = new Set(q("SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id'").map((r) => r.t));
  for (const t of bTables) if (withId.has(t)) for (const r of q(`SELECT id FROM "${t}"`)) bOwn.add(String(r.id));
  assert(bTables.length > 20 && bOwn.has("role_admin"), `Company B tables not found (${ctx.bPrefix}: ${bTables.length})`);
  const aIds = [...ids].filter((id) => !bOwn.has(id));
  const before = companyChecksum("cmp0001");
  assert(Object.keys(before.tables).length > 25, "Company A's tables not found");
  const paramRoutes = routes.filter((r) => r.pattern.includes(":") && !r.pattern.startsWith("/api/platform") && !/backups/.test(r.pattern));
  const fill = (pattern, v) => pattern.replace(/:[A-Za-z_]+/g, () => encodeURIComponent(v));
  const leakOf = (res) => (res.text.includes(MARK) ? MARK : aIds.find((id) => id.length > 6 && res.text.includes(id) && !/not found|no such|unknown/i.test(res.text)));
  const isLeak = (res) => !!leakOf(res);

  await check(`reading with Company A's ids on every route (${paramRoutes.filter((r) => r.method === "GET").length} GET routes) never returns Company A's data — for B's Super Admin and B's Company Admin`, async () => {
    const bad = [];
    for (const r of paramRoutes.filter((x) => x.method === "GET")) {
      const ghost = await api(fill(r.pattern, "zz-no-such-id-0001"), { token: B });
      for (const id of aIds) {
        for (const tok of [B, ctx.adminB]) {
          const res = await api(fill(r.pattern, id), { token: tok });
          if (res.fetchFailed || isLeak(res) || (res.status === 200 && ghost.status !== 200)) bad.push(`${r.pattern} ${id} -> ${res.status} ${res.text.slice(0, 80)}`);
        }
      }
    }
    assert(!bad.length, bad.slice(0, 8).join("\n      "));
  });
  await check("writing with Company A's ids (URL and body) never shows or changes Company A's data", async () => {
    const bad = [];
    const bodies = (id) => [{}, { accountId: id, clientAccountId: id, receivingAccountId: id, fromAccountId: id, toAccountId: id, cashAccountId: id, clientId: id, customerId: id, categoryId: id, roleId: id, amount: 1, currency: "USD", action: "link", confirm: true }];
    for (const r of paramRoutes.filter((x) => x.method !== "GET")) {
      for (const id of aIds.slice(0, 40)) {
        for (const body of bodies(id)) {
          const res = await api(fill(r.pattern, id), { method: r.method, token: B, body });
          if (isLeak(res) || (res.status >= 200 && res.status < 300 && /^(PATCH|DELETE)$/.test(r.method))) bad.push(`${r.method} ${r.pattern} ${id} -> ${res.status} ${res.text.slice(0, 80)}`);
        }
      }
    }
    // Static write routes with Company A's ids in the body.
    for (const r of routes.filter((x) => x.method === "POST" && !x.pattern.includes(":") && /^\/api\/(transactions|transfers|quotations|loans|expenses|cash\/transfers|cash\/exchanges|accounts\/bulk|customers)/.test(x.pattern))) {
      for (const id of [ctx.aUsd.id, ctx.aSlsh.id, ctx.aCashU.id]) {
        const res = await api(r.pattern, { method: "POST", token: B, body: { clientName: "Bravo Customer", clientAccountId: id, receivingAccountId: id, fromAccountId: id, toAccountId: id, fromCashAccountId: id, toCashAccountId: id, cashAccountId: id, clientId: id, accountId: id, amountGiven: 1, currencyGiven: "USD", amount: 1, currency: "USD", date: today(), categoryId: ctx.cat.id, description: "x", items: [{ accountId: id, type: "deposit", amount: 1, currency: "USD" }] } });
        if (isLeak(res)) bad.push(`POST ${r.pattern} body ${id} -> ${res.status} ${res.text.slice(0, 80)}`);
      }
    }
    const after = companyChecksum("cmp0001");
    assert(!bad.length, bad.slice(0, 8).join("\n      "));
    assert(after.all === before.all, `Company A changed: ${diffTables(before, after).join(", ")}`);
  });
  await check("Company B never stored a reference to one of Company A's ids", async () => {
    const tables = tablesOf(ctx.bPrefix);
    const strong = aIds.filter((id) => id.length > 10);
    const hits = [];
    for (const t of tables) {
      if (/audit_log/.test(t)) continue;
      const s = JSON.stringify(q(`SELECT * FROM "${t}"`));
      for (const id of strong) if (s.includes(id)) hits.push(`${t}: ${id}`);
    }
    assert(!hits.length, hits.slice(0, 5).join(", "));
  });
  await check("searches, filters, reports and exports for Company B never contain Company A's data", async () => {
    const statics = routes.filter((r) => r.method === "GET" && !r.pattern.includes(":") && !r.pattern.startsWith("/api/platform") && !/backups|health/.test(r.pattern));
    const bad = [];
    for (const r of statics) {
      for (const qs of ["", `?search=${MARK}&q=${MARK}&name=${MARK}&currency=USD&from=2000-01-01&to=2100-01-01`, `?customerId=${q("SELECT id FROM cmp0001_customers LIMIT 1")[0].id}&accountId=${ctx.aUsd.id}&cashAccountId=${ctx.aCashU.id}`]) {
        const res = await api(r.pattern + qs, { token: B });
        // Company B's own audit log records the ids B itself tried (refused
        // attempts are logged on purpose) — there only A's names/data count.
        const leak = /audit-log/.test(r.pattern) ? (res.text.includes(MARK) ? MARK : null) : leakOf(res);
        if (res.fetchFailed || leak) bad.push(`${r.pattern}${qs.slice(0, 30)} -> ${res.status} ${res.fetchFailed ? res.text : `contains ${leak}`}`);
      }
    }
    assert(!bad.length, bad.slice(0, 8).join("\n      "));
  });
  await check("a Company A expense receipt can't be downloaded from Company B", async () => {
    const own = await api(`/api/expenses/${ctx.aExp.id}/attachment`, { token: A });
    assert(own.status === 200 && own.text.includes(MARK), `A's own download ${own.status}`);
    for (const tok of [B, ctx.adminB]) assert((await api(`/api/expenses/${ctx.aExp.id}/attachment?download=1`, { token: tok })).status === 404, "B downloaded A's receipt");
  });
  await check("dashboard, reports and live totals stay company-specific while the other company is busy", async () => {
    const statics = ["/api/dashboard", "/api/reports/exchange-summary", "/api/reports/accounts-summary", "/api/reports/currency-position", "/api/daily-reports/live", "/api/accounts?withTotals=1&currency=USD", "/api/cash/accounts", "/api/history?currency=USD&withSummary=1"];
    const snap = async () => { const out = []; for (const p of statics) { const r = await api(p, { token: B }); out.push(`${p}:${r.status}:${crypto.createHash("sha1").update(JSON.stringify(r.json, (k, v) => (/^(generatedAt|now|asOf|time|serverTime|today|updatedAt)$/.test(k) ? undefined : v))).digest("hex")}`); } return out; };
    const b1 = await snap();
    await api(`/api/accounts/${ctx.aUsd.id}/deposit`, { method: "POST", token: A, body: { amount: 33, currency: "USD", cashAccountId: ctx.aCashU.id } });
    await api("/api/transactions", { method: "POST", token: A, body: { clientName: "A walk in", amountGiven: 20, currencyGiven: "USD" } });
    const b2 = await snap();
    const changed = b1.filter((x, i) => x !== b2[i]);
    assert(!changed.length, `B's figures moved with A's activity: ${changed.join(", ")}`);
  });
  await check("the daily-snapshot background job keeps each company's figures separate", async () => {
    const bBefore = q(`SELECT COUNT(*) AS n FROM "${ctx.bPrefix}_daily_snapshots"`)[0].n;
    const r = await api("/api/daily-reports/snapshots/run", { method: "POST", token: B, body: { confirm: true } });
    assert(r.status < 300, `B snapshot ${r.status} ${r.text.slice(0, 150)}`);
    const snap = q(`SELECT * FROM "${ctx.bPrefix}_daily_snapshots" ORDER BY captured_at DESC LIMIT 1`)[0];
    assert(q(`SELECT COUNT(*) AS n FROM "${ctx.bPrefix}_daily_snapshots"`)[0].n === bBefore + 1, "B snapshot not stored in B");
    const s = JSON.stringify(snap);
    assert(!s.includes(MARK) && !s.includes(ctx.aUsd.id), "A's data in B's snapshot");
    const cashB = q(`SELECT SUM(balance) AS s FROM "${ctx.bPrefix}_cash_accounts" WHERE currency = 'USD'`)[0].s;
    assert(s.includes(String(Number(cashB))) || s.includes(Number(cashB).toFixed(2)), `B snapshot cash should be ${cashB}: ${s.slice(0, 300)}`);
  });
  await check("switching company issues a token for that company only; the old one stays bound to its own", async () => {
    const accA = (await api("/api/accounts?search=" + MARK, { token: A })).json.accounts;
    const accB = (await api("/api/accounts?search=" + MARK, { token: B })).json.accounts;
    assert(accA.length >= 2 && accB.length === 0, `A ${accA.length} / B ${accB.length}`);
    const bad = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-9999" } });
    assert(bad.status === 404, `unknown company ${bad.status}`);
    for (const tok of [ctx.adminA, ctx.adminB]) assert((await api("/api/platform/switch-company", { method: "POST", token: tok, body: { companyId: "CMP-0001" } })).status === 403, "a company user switched company");
  });
  await check("client-supplied company ids (query, body, headers) are ignored", async () => {
    const r = await api(`/api/accounts?companyId=CMP-0001&company_id=CMP-0001&search=${MARK}`, { token: ctx.adminB, headers: { "X-Company-Id": "CMP-0001", "X-Tenant": "CMP-0001" } });
    assert(r.status === 200 && r.json.accounts.length === 0, `B saw A's accounts: ${r.status}`);
    const c = await api("/api/accounts", { method: "POST", token: ctx.adminB, headers: { "X-Company-Id": "CMP-0001" }, body: { name: "Bravo Body Company", currency: "USD", companyId: "CMP-0001", company_id: "CMP-0001" } });
    assert(c.status === 201 && q(`SELECT COUNT(*) AS n FROM "${ctx.bPrefix}_clients" WHERE name LIKE 'BRAVO BODY%'`)[0].n === 1 && q("SELECT COUNT(*) AS n FROM cmp0001_clients WHERE name LIKE 'BRAVO BODY%'")[0].n === 0, "landed in the wrong company");
  });
  await check("a multi-company Super Admin keeps legitimate access to both companies", async () => {
    assert((await api(`/api/accounts/${ctx.aUsd.id}`, { token: A })).status === 200, "A from A");
    assert((await api(`/api/accounts/${ctx.bUsd.id}`, { token: B })).status === 200, "B from B");
    assert((await api(`/api/accounts/${ctx.aUsd.id}`, { token: B })).status === 404, "A from B");
  });
  await check("administrative exceptions only where explicitly allowed (company admins: no platform, no backups)", async () => {
    for (const tok of [ctx.adminA, ctx.adminB]) {
      for (const [m, p] of [["GET", "/api/platform/companies"], ["GET", "/api/platform/overview"], ["POST", "/api/platform/companies"], ["GET", "/api/backups"], ["POST", "/api/backups"], ["POST", "/api/data-reset"]]) {
        const r = await api(p, { method: m, token: tok, body: m === "POST" ? {} : undefined });
        assert(r.status === 403 || r.status === 401, `${m} ${p} -> ${r.status}`);
      }
    }
    const noWs = await api("/api/accounts", { token: ctx.sa });
    assert(noWs.status === 403, `Super Admin without a workspace read company data: ${noWs.status}`);
  });
}

// ---------------------------------------------------------------------------
async function financial() {
  console.log("\n2. Financial integrity");
  const A = ctx.saA;
  const bal = async (id) => (await api(`/api/accounts/${id}`, { token: A })).json.account.balance;
  const cashBal = (id) => Number(q("SELECT balance FROM cmp0001_cash_accounts WHERE id = ?", [id])[0].balance);
  const FAULT = { "X-Finman-Test-Fault": "1" };

  await check("a save that fails just before COMMIT leaves no partial record (every money operation)", async () => {
    const ops = [
      ["deposit with Cash Account leg", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: 11, currency: "USD", cashAccountId: ctx.aCashU.id }],
      ["withdrawal with Cash Account leg", `/api/accounts/${ctx.aUsd.id}/withdraw`, { amount: 3, currency: "USD", cashAccountId: ctx.aCashU.id }],
      ["exchange between two accounts", "/api/transactions", { clientName: ctx.aUsd.name, clientAccountId: ctx.aUsd.id, receivingAccountId: ctx.aSlsh.id, amountGiven: 5, currencyGiven: "USD" }],
      ["walk-in exchange (creates an account)", "/api/transactions", { clientName: "Fault Walkin Person", amountGiven: 5, currencyGiven: "USD" }],
      ["account transfer", "/api/transfers", { fromAccountId: ctx.aUsd.id, toAccountId: ctx.aUsd2.id, amount: 2, currency: "USD" }],
      ["cash deposit", `/api/cash/accounts/${ctx.aCashU.id}/deposit`, { amount: 9 }],
      ["cash withdrawal", `/api/cash/accounts/${ctx.aCashU.id}/withdraw`, { amount: 9 }],
      ["cash transfer", "/api/cash/transfers", { fromCashAccountId: ctx.aCashU.id, toCashAccountId: ctx.aCashU2.id, amount: 6 }],
      ["company expense", "/api/expenses", { date: today(), categoryId: ctx.cat.id, description: "Fault rent", amount: 3, currency: "USD", cashAccountId: ctx.aCashU.id }],
      ["loan", "/api/loans", { cashAccountId: ctx.aCashU.id, clientId: ctx.aUsd.id, amount: 2, date: new Date().toISOString() }],
      ["loan repayment", `/api/loans/${ctx.aLoan.id}/payments`, { amount: 0.5, cashAccountId: ctx.aCashU.id }],
      ["quotation payment", `/api/quotations/${ctx.aQuote.id}/payments`, { amount: 10, date: today(), method: "cash" }],
      ["new account with opening balance", "/api/accounts", { name: "Fault Opening Person", currency: "USD", openingBalance: 40 }],
    ];
    const bad = [];
    for (const [label, p, body] of ops) {
      const before = moneyState();
      const r = await api(p, { method: "POST", token: A, body, headers: FAULT });
      const after = moneyState();
      if (r.status < 500) bad.push(`${label}: expected a failure, got ${r.status} ${r.text.slice(0, 100)}`);
      else if (before !== after) bad.push(`${label}: partial write (${after.split("|").filter((x, i) => x !== before.split("|")[i]).map((x) => x.split(":")[0]).join(", ")})`);
      // ...and without the fault the same request really saves (the check above is meaningful).
      const ok = await api(p, { method: "POST", token: A, body });
      if (ok.status >= 300) bad.push(`${label}: normal save failed ${ok.status} ${ok.text.slice(0, 120)}`);
      else if (moneyState() === after) bad.push(`${label}: normal save changed nothing`);
    }
    assert(!bad.length, bad.join("\n      "));
  });
  await check("25 simultaneous credits on one account all land; no update is lost", async () => {
    const b0 = await bal(ctx.aUsd2.id), c0 = cashBal(ctx.aCashU.id);
    const rs = await Promise.all(Array.from({ length: 25 }, () => api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: A, body: { amount: 1.1, currency: "USD", cashAccountId: ctx.aCashU.id } })));
    assert(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.status).join(","));
    assert(Math.abs((await bal(ctx.aUsd2.id)) - (b0 + 27.5)) < 1e-9, `balance ${await bal(ctx.aUsd2.id)} vs ${b0 + 27.5}`);
    assert(Math.abs(cashBal(ctx.aCashU.id) - (c0 + 27.5)) < 1e-9, "cash balance");
    const rows = q("SELECT amount, type, balance_after FROM cmp0001_account_ledger WHERE client_id = ? ORDER BY created_at, id", [ctx.aUsd2.id]);
    const afters = rows.map((r) => Number(r.balance_after)).slice(-25).sort((x, y) => x - y);
    assert(new Set(afters.map((x) => x.toFixed(2))).size === 25, "two postings saw the same running balance");
  });
  await check("simultaneous Cash Account withdrawals are all recorded exactly (negative cash is allowed by the business rules)", async () => {
    const till = (await api("/api/cash/accounts", { method: "POST", token: A, body: { name: "Race Till", type: "physical_cash", currency: "USD", openingBalance: 10 } })).json.account;
    const rs = await Promise.all(Array.from({ length: 8 }, () => api(`/api/cash/accounts/${till.id}/withdraw`, { method: "POST", token: A, body: { amount: 3 } })));
    assert(rs.every((r) => r.status < 300), rs.map((r) => r.status).join(","));
    assert(cashBal(till.id) === -14, `balance ${cashBal(till.id)} (expected 10 − 8 × 3 = −14)`);
    const refs = q("SELECT reference_number AS r FROM cmp0001_cash_ledger WHERE cash_account_id = ?", [till.id]).map((x) => x.r);
    assert(new Set(refs).size === refs.length, "duplicate reference numbers");
  });
  await check("a repeated submission posts once (same key, sent 4 times at once and once later)", async () => {
    const k = key();
    const before = q("SELECT COUNT(*) AS n FROM cmp0001_account_ledger")[0].n;
    const body = { amount: 2.5, currency: "USD", cashAccountId: ctx.aCashU.id };
    const rs = await Promise.all(Array.from({ length: 4 }, () => api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: A, body, headers: { "Idempotency-Key": k } })));
    const later = await api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: A, body, headers: { "Idempotency-Key": k } });
    assert(rs.every((r) => r.status < 300) && later.replay, "not replayed");
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_account_ledger")[0].n === before + 1, "posted more than once");
  });
  await check("same key, different amount after a success: refused (422), nothing posted twice", async () => {
    const k = key();
    const first = await api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: A, body: { amount: 1, currency: "USD", cashAccountId: ctx.aCashU.id }, headers: { "Idempotency-Key": k } });
    const n = q("SELECT COUNT(*) AS n FROM cmp0001_account_ledger")[0].n;
    const second = await api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: A, body: { amount: 2, currency: "USD", cashAccountId: ctx.aCashU.id }, headers: { "Idempotency-Key": k } });
    assert(first.status < 300 && second.status === 422 && q("SELECT COUNT(*) AS n FROM cmp0001_account_ledger")[0].n === n, `${first.status} ${second.status}`);
  });
  await check("a corrected resubmission after a refusal is saved (the form keeps its key)", async () => {
    const k = key();
    const body = (amount) => ({ fromAccountId: ctx.aUsd2.id, toAccountId: ctx.aUsd.id, amount, currency: "USD" });
    const refused = await api("/api/transfers", { method: "POST", token: A, body: body(99999999), headers: { "Idempotency-Key": k } });
    const again = await api("/api/transfers", { method: "POST", token: A, body: body(99999999), headers: { "Idempotency-Key": k } });
    const corrected = await api("/api/transfers", { method: "POST", token: A, body: body(1), headers: { "Idempotency-Key": k } });
    assert(refused.status === 400 && again.status === 400 && again.replay, `refusal ${refused.status} ${refused.text.slice(0, 100)}, replay ${again.replay}`);
    assert(corrected.status < 300 && !corrected.replay, `corrected ${corrected.status} ${corrected.text.slice(0, 120)}`);
  });
  await check("a signed-out session can't read back a stored answer with its key", async () => {
    const tok = await login("amina.yusuf", PW);
    const k = key();
    const r = await api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: tok, body: { amount: 1, currency: "USD", cashAccountId: ctx.aCashU.id }, headers: { "Idempotency-Key": k } });
    assert(r.status < 300, `deposit ${r.status} ${r.text.slice(0, 120)}`);
    await api("/api/auth/logout", { method: "POST", token: tok });
    const again = await api(`/api/accounts/${ctx.aUsd2.id}/deposit`, { method: "POST", token: tok, body: { amount: 1, currency: "USD", cashAccountId: ctx.aCashU.id }, headers: { "Idempotency-Key": k } });
    assert(again.status === 401 && !again.replay, `${again.status} replay=${again.replay}`);
  });
  await check("exchange profit follows the documented formula and keeps its own day's rates", async () => {
    const buy = (await api("/api/transactions", { method: "POST", token: A, body: { clientName: ctx.aUsd.name, clientAccountId: ctx.aUsd.id, receivingAccountId: ctx.aSlsh.id, amountGiven: 100, currencyGiven: "USD" } })).json.transaction;
    const sell = (await api("/api/transactions", { method: "POST", token: A, body: { clientName: ctx.aUsd.name, clientAccountId: ctx.aSlsh.id, receivingAccountId: ctx.aUsd.id, amountGiven: 1170000, currencyGiven: "SLSH" } })).json.transaction;
    const row = (id) => q("SELECT rate_used, cost_rate, profit_usd, amount_given, amount_received FROM cmp0001_exchange_transactions WHERE id = ?", [id])[0];
    const b = row(buy.id), s = row(sell.id);
    // Customer gives USD (company buys): Cost Rate Difference = (cost − rate) × USD, in USD at the Cost Rate.
    const expBuy = ((Number(b.cost_rate) - Number(b.rate_used)) * 100) / Number(b.cost_rate);
    // Customer gives SLSH (company sells USD): Profit = (rate − cost) × USD received.
    const expSell = ((Number(s.rate_used) - Number(s.cost_rate)) * Number(s.amount_received)) / Number(s.cost_rate);
    assert(Math.abs(Number(b.profit_usd) - expBuy) < 0.01, `buy profit ${b.profit_usd} vs ${expBuy} (${JSON.stringify(b)})`);
    assert(Math.abs(Number(s.profit_usd) - expSell) < 0.01, `sell profit ${s.profit_usd} vs ${expSell} (${JSON.stringify(s)})`);
    assert(Number(b.amount_received) === 100 * Number(b.rate_used), "SLSH paid out = USD × rate");
    await api("/api/rate-history", { method: "POST", token: A, body: { dailyRate: 12000, saleRate: 12000, costRate: 12100, buyRate: 11900, sellRate: 12300 } });
    const b2 = row(buy.id), s2 = row(sell.id);
    assert(JSON.stringify(b2) === JSON.stringify(b) && JSON.stringify(s2) === JSON.stringify(s), "a stored exchange changed when the rates changed");
    const h = (await api(`/api/history?currency=USD&search=${encodeURIComponent(buy.referenceNumber)}`, { token: A })).json.entries.find((e) => e.id === buy.id);
    assert(h && Number(h.rate) === Number(b.rate_used), "history shows a different rate");
  });
  await check("USD and SLSH are never added together in summaries", async () => {
    const r = (await api("/api/history?withSummary=1", { token: A })).json;
    const sum = (cur) => r.entries.filter((e) => e.credit != null && e.entryCurrency === cur).reduce((t, e) => t + e.credit, 0);
    const m = r.summary.money;
    assert(m.USD && m.SLSH, JSON.stringify(m));
    assert(Math.abs(m.USD.credits - sum("USD")) < 0.01 && Math.abs(m.SLSH.credits - sum("SLSH")) < 0.01, `USD ${m.USD.credits} vs ${sum("USD")}, SLSH ${m.SLSH.credits} vs ${sum("SLSH")}`);
  });
  await check("every stored balance equals its own ledger (accounts and Cash Accounts), in both companies", async () => {
    for (const pre of ["cmp0001", ctx.bPrefix]) {
      const bad = q(`SELECT c.account_number, c.currency, c.balance_usd, c.balance_slsh,
          COALESCE(SUM(CASE WHEN l.currency = c.currency AND l.type = 'deposit' THEN l.amount WHEN l.currency = c.currency AND l.type = 'withdrawal' THEN -l.amount ELSE 0 END), 0) AS led
        FROM "${pre}_clients" c LEFT JOIN "${pre}_account_ledger" l ON l.client_id = c.id WHERE c.deleted_at IS NULL GROUP BY c.id, c.account_number, c.currency, c.balance_usd, c.balance_slsh`)
        .filter((x) => Math.abs((x.currency === "USD" ? Number(x.balance_usd) : Number(x.balance_slsh)) - Number(x.led)) > 0.005);
      assert(!bad.length, `${pre}: ${JSON.stringify(bad.slice(0, 3))}`);
      const accs = (await api("/api/accounts?withTotals=1", { token: pre === "cmp0001" ? A : ctx.saB })).json.accounts;
      assert(accs.every((a) => !a.ledgerMismatch), `${pre}: ledgerMismatch flagged`);
    }
    const cash = q("SELECT id, balance FROM cmp0001_cash_accounts");
    for (const c of cash) {
      const led = q("SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) AS s FROM cmp0001_cash_ledger WHERE cash_account_id = ?", [c.id])[0].s;
      assert(Math.abs(Number(c.balance) - Number(led)) < 0.005, `cash ${c.id}: ${c.balance} vs ledger ${led}`);
    }
  });
}

// ---------------------------------------------------------------------------
async function security() {
  console.log("\n3. Backend security");
  const A = ctx.saA;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signWith = (header, payload, secret = JWT_SECRET) => {
    const h = b64(header), p = b64(payload);
    const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${h}.${p}.${sig}`;
  };
  await check("forged, expired, never-expiring and 'alg: none' tokens are refused", async () => {
    const real = JSON.parse(Buffer.from(ctx.adminA.split(".")[1], "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    const tokens = {
      wrongSecret: signWith({ alg: "HS256", typ: "JWT" }, real, "not-the-secret"),
      expired: signWith({ alg: "HS256", typ: "JWT" }, { ...real, iat: now - 90000, exp: now - 3600 }),
      noExpiry: signWith({ alg: "HS256", typ: "JWT" }, (({ exp, ...x }) => x)(real)),
      algNone: `${b64({ alg: "none", typ: "JWT" })}.${b64(real)}.`,
    };
    for (const [k, t] of Object.entries(tokens)) {
      const r = await api("/api/accounts", { token: t });
      assert(r.status === 401 || r.status === 403, `${k}: ${r.status}`);
    }
    assert((await api("/api/accounts", { token: ctx.adminA })).status === 200, "the real token stopped working");
  });
  await check("hostile and malformed input is refused cleanly (400), never a server error", async () => {
    const bad = [];
    const cases = [
      ["POST", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: -5, currency: "USD" }],
      ["POST", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: "1e309", currency: "USD" }],
      ["POST", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: { $gt: 0 }, currency: "USD" }],
      ["POST", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: 5, currency: "EUR" }],
      ["POST", `/api/accounts/${ctx.aUsd.id}/deposit`, { amount: 5, currency: "USD", paymentDate: "2026-13-45" }],
      ["POST", "/api/transactions", { clientName: "x", amountGiven: 0, currencyGiven: "USD" }],
      ["POST", "/api/transactions", { clientName: "x", amountGiven: 10, currencyGiven: "BTC" }],
      ["POST", "/api/transfers", { fromAccountId: ctx.aUsd.id, toAccountId: ctx.aUsd.id, amount: 1 }],
      ["POST", "/api/transfers", { fromAccountId: ctx.aUsd.id, toAccountId: ctx.aSlsh.id, amount: 1 }],
      ["POST", "/api/expenses", { date: "not-a-date", categoryId: ctx.cat.id, description: "x", amount: 1, currency: "USD", cashAccountId: ctx.aCashU.id }],
      ["POST", "/api/cash/transfers", { fromCashAccountId: ctx.aCashU.id, toCashAccountId: ctx.aCashS.id, amount: 1 }],
      ["POST", "/api/accounts", { name: ["array"], currency: "USD" }],
      ["POST", "/api/rate-history", { dailyRate: -1, saleRate: "abc" }],
    ];
    for (const [m, p, body] of cases) {
      const r = await api(p, { method: m, token: A, body });
      if (r.status !== 400 && r.status !== 404) bad.push(`${m} ${p} ${JSON.stringify(body).slice(0, 60)} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    for (const raw of ["{not json", '{"amount": 1e400}', "[" .repeat(5000)]) {
      const r = await api(`/api/accounts/${ctx.aUsd.id}/deposit`, { method: "POST", token: A, rawBody: raw });
      if (r.status !== 400) bad.push(`raw ${raw.slice(0, 15)} -> ${r.status}`);
    }
    assert(!bad.length, bad.join("\n      "));
  });
  await check("SQL-looking search, sort and paging values do nothing harmful", async () => {
    const before = companyChecksum("cmp0001");
    const evil = encodeURIComponent("' OR 1=1; DROP TABLE clients; --");
    for (const p of [`/api/accounts?search=${evil}&sort=${evil}`, `/api/history?search=${evil}&type=${evil}&status=${evil}&accountId=${evil}`, `/api/expenses?search=${evil}&sort=${evil}&dir=${evil}&page=-1&pageSize=99999999`, `/api/customers?search=${evil}`, `/api/quotations?search=${evil}`, `/api/accounts?from=${evil}&to=${evil}`]) {
      const r = await api(p, { token: A });
      assert(r.status === 200 || r.status === 400, `${p} -> ${r.status} ${r.text.slice(0, 100)}`);
      assert(!/sql|syntax|mysql|ER_/i.test(r.text) || r.status === 200, `${p} exposes a database error`);
      if (/accounts\?search/.test(p)) assert(r.json.accounts.length === 0, "the search matched everything");
    }
    assert(companyChecksum("cmp0001").all === before.all, "data changed");
  });
  await check("a request body over the limit is refused, and the server keeps running", async () => {
    const big = JSON.stringify({ name: "x".repeat(6 * 1024 * 1024), currency: "USD" });
    const r = await api("/api/accounts", { method: "POST", token: A, rawBody: big }).catch((e) => ({ status: 0, text: e.message }));
    assert(r.status === 400 || r.status === 413 || r.status === 0, `${r.status}`);
    const k = await api("/api/accounts", { method: "POST", token: A, rawBody: big, headers: { "Idempotency-Key": key() } }).catch((e) => ({ status: 0 }));
    assert(k.status === 400 || k.status === 413 || k.status === 0, `keyed ${k.status}`);
    assert((await api("/api/health")).status === 200, "server down");
  });
  await check("over-long or non-text account fields are refused (400), not stored or crashed on", async () => {
    for (const body of [{ name: "x".repeat(30000), currency: "USD" }, { name: { a: 1 }, currency: "USD" }, { name: "Ok Name", currency: "USD", contact: ["x"] }]) {
      const r = await api("/api/accounts", { method: "POST", token: A, body });
      assert(r.status === 400, `${JSON.stringify(body).slice(0, 40)} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
  });
  await check("text split across network chunks (e.g. ’ cut in half) is read exactly", async () => {
    const { EventEmitter } = require("events");
    process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
    const { readJSONBody } = require("../src/http-helpers");
    const raw = Buffer.from(JSON.stringify({ name: "Xaawo’s ’ shop" }), "utf8");
    const cut = raw.indexOf(Buffer.from("’")) + 1; // inside the 3-byte character
    const req = new EventEmitter();
    const p = readJSONBody(req);
    req.emit("data", raw.subarray(0, cut)); req.emit("data", raw.subarray(cut)); req.emit("end");
    const out = await p;
    assert(out.name === "Xaawo’s ’ shop", JSON.stringify(out));
  });
  await check("file downloads are access-controlled and served safely", async () => {
    assert((await api(`/api/expenses/${ctx.aExp.id}/attachment`)).status === 401, "anonymous download");
    const cashier = await login("cabdi.maxamed", PW);
    assert([403].includes((await api(`/api/expenses/${ctx.aExp.id}/attachment`, { token: cashier })).status), "cashier without expenses.view downloaded a receipt");
    const own = await api(`/api/expenses/${ctx.aExp.id}/attachment?download=1`, { token: A });
    assert(own.status === 200 && /attachment;/.test(own.headers.get("content-disposition")) && /sandbox/.test(own.headers.get("content-security-policy")) && own.headers.get("x-content-type-options") === "nosniff", "unsafe download headers");
    for (const name of ["..%2F..%2Fetc%2Fpasswd", "%2e%2e%2fsecret.gz", "x%0d%0aSet-Cookie:%20a=b"]) {
      const r = await api(`/api/backups/${name}`, { token: A });
      assert(r.status === 404 || r.status === 400, `backup ${name} -> ${r.status}`);
    }
  });
  await check("error responses never expose internals; security headers are present", async () => {
    const r = await api("/api/accounts/%E0%A4%A", { token: A });
    assert(r.status === 400 && !/stack|at \w+ \(/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
    const h = (await api("/api/accounts", { token: A })).headers;
    for (const k of ["x-content-type-options", "x-frame-options", "content-security-policy", "referrer-policy", "strict-transport-security"]) assert(h.get(k), `${k} missing`);
    const cors = await api("/api/accounts", { token: A, headers: { Origin: "https://evil.example" } });
    assert(!cors.headers.get("access-control-allow-origin"), "a foreign origin is allowed");
  });
  await check("refused access attempts are recorded in each company's own audit log", async () => {
    const before = q("SELECT COUNT(*) AS n FROM cmp0001_audit_log WHERE action = 'Access denied'")[0].n;
    const viewer = await login("sahra.ismail", PW);
    await api(`/api/accounts/${ctx.aUsd.id}/deposit`, { method: "POST", token: viewer, body: { amount: 1, currency: "USD" } });
    const after = q("SELECT COUNT(*) AS n FROM cmp0001_audit_log WHERE action = 'Access denied'")[0].n;
    assert(after === before + 1, `${before} -> ${after}`);
    const leak = q("SELECT details FROM cmp0001_audit_log WHERE action = 'Access denied' ORDER BY at DESC LIMIT 1")[0].details;
    assert(!/Bearer|eyJ|password/i.test(leak), "a token or password in the audit log");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
