"use strict";
// FULL SYSTEM AUDIT round — a sweep over EVERY API route the server
// registers (read from the route modules themselves, so a route added later
// is covered automatically). On a throw-away installation with two
// companies it proves that:
//   * no route answers without a valid sign-in (apart from the few public
//     ones listed below), and a forged token is refused everywhere;
//   * a read-only user can't change anything through any route;
//   * Company A, using Company B's real record ids in every URL parameter
//     and every id field of a request body, never sees a byte of Company B's
//     data and never changes it — and never stores a reference to one of
//     Company B's ids in its own records.
//
// Run with: npm run test:route-sweep
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("routesweep");
const PORT = Number(process.env.SWEEP_TEST_PORT || 4398);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const MARK = "ZQBETA"; // every Company B record name carries this
const hasMark = (t) => String(t).toLowerCase().includes(MARK.toLowerCase()); // names may be re-cased

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("latin1");
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { json = null; }
  return { status: res.status, text, json, type: res.headers.get("content-type") || "" };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json;

// Every route, read from the route modules exactly as server.js registers them.
function allRoutes() {
  const prev = process.env.JWT_SECRET; process.env.JWT_SECRET = JWT_SECRET;
  const { Router } = require("../src/router");
  const list = [];
  const r = new Router();
  const orig = r._add.bind(r);
  r._add = (method, pattern, handler) => { list.push({ method, pattern }); return orig(method, pattern, handler); };
  const src = require("fs").readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  for (const m of src.match(/require\("\.\/routes\/[A-Za-z]+"\)/g)) require(path.join(ROOT, "src", m.slice(9, -2))).register(r);
  list.push({ method: "GET", pattern: "/api/health" });
  process.env.JWT_SECRET = prev;
  return list;
}
const fill = (pattern, v) => pattern.replace(/:[A-Za-z_]+/g, () => encodeURIComponent(v));

// Collects every id-like value ("id" or "...Id" keys) in a JSON value.
function harvest(v, out, depth = 0) {
  if (!v || typeof v !== "object" || depth > 8) return out;
  if (Array.isArray(v)) { for (const x of v.slice(0, 50)) harvest(x, out, depth + 1); return out; }
  for (const [k, x] of Object.entries(v)) {
    if ((k === "id" || /Id$/.test(k)) && (typeof x === "string" || typeof x === "number") && String(x).length >= 2) out.add(String(x));
    else if (x && typeof x === "object") harvest(x, out, depth + 1);
  }
  return out;
}

// Public routes: answered without a sign-in by design.
// GET /api/settings/company answers a visitor with the neutral platform
// identity only (checked below).
const PUBLIC = new Set(["POST /api/auth/login", "GET /api/health", "GET /api/settings/company"]);
// Self-service routes a read-only user may legitimately use.
const VIEWER_SELF = [/^POST \/api\/auth\//, /^PATCH \/api\/auth\//, /\/api\/table-layouts/, /\/api\/notifications/, /^(PATCH|DELETE) \/api\/dashboard-layout$/, /^PATCH \/api\/me\b/, /^POST \/api\/me\b/];

async function main() {
  const routes = allRoutes();
  console.log(`${routes.length} API routes found.`);
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await run(routes); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.slice(0, 15).join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

async function setupCompanyB() {
  const sa = (await login("super.admin", SA_PW)).token;
  const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: `${MARK} Traders`, admin: { name: `${MARK} Admin`, username: "zq.admin", password: "ZqBetaPass-2026" } } });
  assert(c.status === 201, `company B: ${c.status} ${c.text.slice(0, 200)}`);
  const b = (await login("zq.admin", "ZqBetaPass-2026")).token;
  // Cash Account / Loans are Super Admin-only by default (permissions.js), so
  // those records are created by the Super Admin inside Company B.
  const cid = ((await api("/api/platform/companies", { token: sa })).json.companies || []).find((x) => x.name === `${MARK} Traders`).id;
  const sb = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: cid } })).json.token;
  const post = async (p, body, tok = b) => {
    const r = await api(p, { method: "POST", token: tok, body });
    if (r.status >= 300) console.log(`    setup ${p} -> ${r.status} ${r.text.slice(0, 160)}`);
    return r.json || {};
  };
  await post("/api/rate-history", { dailyRate: 8000, saleRate: 8100, costRate: 8100, buyRate: 7900, sellRate: 8200, note: MARK });
  const a1 = (await post("/api/accounts", { name: `${MARK} One`, currency: "USD", openingBalance: 500, notes: MARK })).account;
  const a2 = (await post("/api/accounts", { name: `${MARK} Two`, currency: "USD", openingBalance: 100 })).account;
  const as = (await post("/api/accounts", { name: `${MARK} Shilling`, currency: "SLSH", openingBalance: 1000000 })).account;
  await post("/api/transactions", { clientName: `${MARK} Walkin`, amountGiven: 10, currencyGiven: "USD", notes: MARK });
  await post("/api/transactions", { clientName: a1.name, clientAccountId: a1.id, receivingAccountId: as.id, amountGiven: 5, currencyGiven: "USD", notes: MARK });
  await post("/api/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amount: 3, currency: "USD", notes: MARK });
  await post(`/api/accounts/${a1.id}/deposit`, { amount: 7, notes: MARK });
  const cashU = (await post("/api/cash/accounts", { name: `${MARK} Till`, type: "physical_cash", currency: "USD", openingBalance: 300 }, sb)).account;
  const cashS = (await post("/api/cash/accounts", { name: `${MARK} Till S`, type: "bank", currency: "SLSH", openingBalance: 900000 }, sb)).account;
  if (cashU) await post(`/api/cash/accounts/${cashU.id}/deposit`, { amount: 4, description: MARK }, sb);
  await post("/api/quotations", { clientName: `${MARK} Quote Client`, currency: "USD", items: [{ description: `${MARK} item`, qty: 1, unitPrice: 50, currency: "USD" }], notes: MARK });
  const meta = (await api("/api/expenses/meta", { token: b })).json || {};
  const cat = (meta.categories || [])[0];
  if (cat && cashU) await post("/api/expenses", { date: new Date().toISOString().slice(0, 10), categoryId: cat.id, description: `${MARK} rent`, amount: 2, currency: "USD", cashAccountId: cashU.id, notes: MARK }, sb);
  if (cashU) await post("/api/loans", { cashAccountId: cashU.id, clientId: a1.id, amount: 1, date: new Date().toISOString(), notes: MARK }, sb);
  const roles = (await api("/api/roles", { token: b })).json.roles;
  const cashier = roles.find((x) => x.key === "cashier") || roles[roles.length - 1];
  await post("/api/users", { name: `${MARK} Cashier`, username: "zq.cashier", password: "ZqCashier-2026", roleId: cashier.id });
  return { sa, sb, b, a1, cashU, cashS };
}

// Everything Company B can see, as one comparable snapshot (volatile
// fields such as login times and audit entries are left out).
async function snapshotB(b, getRoutes) {
  const parts = [];
  for (const r of getRoutes) {
    if (/audit|notifications|system-overview|health|backups|me$|session|platform/.test(r.pattern)) continue;
    const res = await api(r.pattern, { token: b });
    if (res.status !== 200 || !res.json) continue;
    // (the audit-log count grows with the snapshot's own export downloads;
    // who wrote Company B's audit entries is checked separately)
    const body = r.pattern === "/api/data-reset" ? { ...res.json, categories: (res.json.categories || []).filter((c) => c.key !== "audit") } : res.json;
    const s = JSON.stringify(body, (k, v) => (/^(lastLogin|last_login|time|generatedAt|now|asOf|updatedAt|serverTime|today)$/.test(k) ? undefined : v));
    parts.push(`${r.pattern}=${r.pattern === "/api/data-reset" ? s : crypto.createHash("sha1").update(s).digest("hex")}`);
  }
  return parts;
}

async function run(routes) {
  const ctx = await setupCompanyB();
  const aAdmin = (await login("amina.yusuf", PW)).token;
  const viewer = (await login("sahra.ismail", PW)).token;
  assert(aAdmin && viewer, "demo users could not sign in");
  const getStatic = routes.filter((r) => r.method === "GET" && !r.pattern.includes(":") && r.pattern.startsWith("/api/"));

  // ---- Company B's ids (and Company A's, so shared seed ids are skipped) ----
  const bIds = new Set(), aIds = new Set();
  for (const r of getStatic) {
    const rb = await api(r.pattern, { token: ctx.sb }); if (rb.json) harvest(rb.json, bIds);
    const ra = await api(r.pattern, { token: aAdmin }); if (ra.json) harvest(ra.json, aIds);
  }
  for (const id of [...bIds]) {
    const d = await api(`/api/accounts/${encodeURIComponent(id)}`, { token: ctx.sb });
    if (d.status === 200 && d.json) harvest(d.json, bIds);
  }
  await check("setup: Company B really holds marked records in every module", async () => {
    const missing = [];
    for (const p of ["/api/accounts", "/api/transactions", "/api/transfers", "/api/cash/accounts", "/api/quotations", "/api/expenses", "/api/loans", "/api/users"]) {
      const r = await api(p, { token: ctx.sb });
      if (!hasMark(r.text)) missing.push(`${p} (${r.status})`);
    }
    assert(!missing.length, `no Company B data at ${missing.join(", ")}`);
  });
  const onlyB = [...bIds].filter((id) => !aIds.has(id) && !/^(USD|SLSH|BOTH)$/.test(id));
  console.log(`Company B: ${onlyB.length} record ids to try from Company A.`);

  console.log("\nSign-in required on every route");
  await check("no route answers a request without a token (except the public ones)", async () => {
    const open = [];
    for (const r of routes) {
      const res = await api(fill(r.pattern, "x1"), { method: r.method, body: r.method === "GET" ? undefined : {} });
      if (res.status !== 401 && !PUBLIC.has(`${r.method} ${r.pattern}`)) open.push(`${r.method} ${r.pattern} -> ${res.status}`);
    }
    assert(!open.length, open.slice(0, 10).join(" | "));
  });
  await check("a forged token (wrong signature) is refused on every protected route", async () => {
    const [h, p] = aAdmin.split(".");
    const forged = `${h}.${p}.${crypto.randomBytes(32).toString("base64url")}`;
    const open = [];
    for (const r of routes) {
      if (PUBLIC.has(`${r.method} ${r.pattern}`)) continue;
      const res = await api(fill(r.pattern, "x1"), { method: r.method, token: forged, body: r.method === "GET" ? undefined : {} });
      if (res.status !== 401) open.push(`${r.method} ${r.pattern} -> ${res.status}`);
    }
    assert(!open.length, open.slice(0, 10).join(" | "));
  });

  await check("the public company endpoint gives a visitor no company's details", async () => {
    const r = await api("/api/settings/company");
    const aCo = (await api("/api/settings/company", { token: aAdmin })).json.company || {};
    assert(r.status === 200 && r.json.company.isDefault === true, JSON.stringify(r.json).slice(0, 160));
    const own = [aCo.tagline, aCo.phone, aCo.email, aCo.address].filter((x) => x && String(x).length > 3);
    assert(own.length, "Company A has no details to compare");
    assert(!hasMark(r.text) && !own.some((x) => r.text.includes(x)), "a company's details were sent to a visitor");
  });

  console.log("\nRead-only user");
  await check("a read-only user can't change anything through any route", async () => {
    const changed = [];
    const ids = [...aIds].slice(0, 40);
    for (const r of routes.filter((x) => x.method !== "GET")) {
      const key = `${r.method} ${r.pattern}`;
      if (PUBLIC.has(key) || VIEWER_SELF.some((re) => re.test(key))) continue;
      for (const id of r.pattern.includes(":") ? ids : ["-"]) {
        const res = await api(fill(r.pattern, id), { method: r.method, token: viewer, body: { name: "viewer-probe", amount: 1, currency: "USD", reason: "x" } });
        if (res.status >= 200 && res.status < 300) { changed.push(`${key} (${id}) -> ${res.status}`); break; }
      }
    }
    assert(!changed.length, changed.slice(0, 10).join(" | "));
  });
  await check("a read-only user can't change the company-wide dashboard layout", async () => {
    const d = await api("/api/dashboard-layout?scope=system", { method: "DELETE", token: viewer });
    const p = await api("/api/dashboard-layout", { method: "PATCH", token: viewer, body: { scope: "system", widgets: [] } });
    assert(d.status === 403 && (p.status === 403 || p.status === 400), `delete ${d.status}, patch ${p.status}`);
  });

  await check("nobody can raise their own role or permissions", async () => {
    const roles = (await api("/api/roles", { token: aAdmin })).json.roles;
    const users = (await api("/api/users", { token: aAdmin })).json.users;
    const adminRole = roles.find((r) => r.key === "admin"), sup = roles.find((r) => r.isSuperAdmin || r.key === "super_admin");
    const bad = [];
    for (const u of ["xasan.cali", "faadumo.warsame", "cabdi.maxamed", "ilhan.nuur", "sahra.ismail"]) {
      const t = (await login(u, PW)).token; const me = users.find((x) => x.username === u);
      for (const [label, p, m, body] of [
        ["own role -> Admin", `/api/users/${me.id}`, "PATCH", { roleId: adminRole.id }],
        ["own permissions", `/api/users/${me.id}/permissions`, "PATCH", { grant: ["users.managePermissions", "settings.update"] }],
        ["edit the Admin role", `/api/roles/${adminRole.id}`, "PATCH", { permissions: ["users.view"] }],
        ...(sup ? [["own role -> Super Admin", `/api/users/${me.id}`, "PATCH", { roleId: sup.id }]] : []),
      ]) {
        const r = await api(p, { method: m, token: t, body });
        if (r.status < 300) bad.push(`${u}: ${label} -> ${r.status}`);
      }
    }
    const meA = users.find((x) => x.username === "amina.yusuf");
    if (sup) { const r = await api(`/api/users/${meA.id}`, { method: "PATCH", token: aAdmin, body: { roleId: sup.id } }); if (r.status < 300) bad.push(`admin -> Super Admin ${r.status}`); }
    assert(!bad.length, bad.join(" | "));
  });

  console.log("\nCross-company sweep (Company A using Company B's record ids)");
  const before = await snapshotB(ctx.sb, getStatic);
  const idBody = (id) => {
    const o = { name: "probe", amount: 1, amountGiven: 1, currency: "USD", currencyGiven: "USD", reason: "probe", notes: "probe", description: "probe", date: new Date().toISOString().slice(0, 10) };
    for (const k of ["id", "accountId", "clientId", "clientAccountId", "receivingAccountId", "fromAccountId", "toAccountId", "cashAccountId", "fromCashAccountId", "toCashAccountId", "quotationId", "loanId", "categoryId", "roleId", "userId", "transactionId", "templateId", "expenseId", "entryId", "paymentId"]) o[k] = id;
    o.companyId = "CMP-0002"; o.items = [{ accountId: id, type: "deposit", amount: 1 }];
    // AUDIT round 2: the newer exchange options carry ids too.
    o.fundSelections = [{ ledgerId: id, amount: 1 }]; o.markPaid = true; o.payment = { cashAccountId: id };
    o.clientName = "probe"; o.receivingAccountId = id; o.cashOutAccountId = id; o.cashInAccountId = id;
    return o;
  };
  const leaks = [];
  await check("reading with Company B's ids never returns Company B's data", async () => {
    for (const r of routes.filter((x) => x.method === "GET" && x.pattern.includes(":"))) {
      for (const id of onlyB) {
        const res = await api(fill(r.pattern, id), { token: aAdmin });
        if (hasMark(res.text)) { leaks.push(`GET ${r.pattern} (${id})`); break; }
      }
    }
    for (const r of getStatic) {
      const res = await api(`${r.pattern}?companyId=CMP-0002&company_id=CMP-0002&cid=CMP-0002`, { token: aAdmin, headers: { "X-Company-Id": "CMP-0002" } });
      if (hasMark(res.text)) leaks.push(`GET ${r.pattern} (company id in query/header)`);
    }
    // AUDIT round 2: ids passed as QUERY parameters too (e.g.
    // /api/transactions/fund-sources?accountId=…, statements, filters).
    const qKeys = ["accountId", "clientId", "cashAccountId", "quotationId", "loanId", "staffId", "id"];
    for (const r of getStatic) {
      for (const id of onlyB.slice(0, 25)) {
        const q = qKeys.map((k) => `${k}=${encodeURIComponent(id)}`).join("&");
        const res = await api(`${r.pattern}?${q}`, { token: aAdmin });
        if (hasMark(res.text)) { leaks.push(`GET ${r.pattern}?…=${id}`); break; }
      }
    }
    assert(!leaks.length, leaks.slice(0, 10).join(" | "));
  });
  await check("writing with Company B's ids (URL and body) never shows or changes Company B's data", async () => {
    const seen = [];
    const writes = routes.filter((x) => x.method !== "GET" && !PUBLIC.has(`${x.method} ${x.pattern}`) && !/\/api\/platform\//.test(x.pattern) && !/logout|change-password|password/.test(x.pattern));
    for (const r of writes) {
      const ids = r.pattern.includes(":") ? onlyB : [onlyB[0]];
      for (const id of ids) {
        for (const bodyId of r.pattern.includes(":") ? [id] : onlyB.slice(0, 12)) {
          const res = await api(fill(r.pattern, id), { method: r.method, token: aAdmin, body: idBody(bodyId) });
          if (hasMark(res.text)) seen.push(`${r.method} ${r.pattern}`);
        }
      }
    }
    assert(!seen.length, `Company B data in responses: ${[...new Set(seen)].slice(0, 10).join(" | ")}`);
    const after = await snapshotB(ctx.sb, getStatic);
    const diff = before.filter((x) => !after.includes(x));
    const at = (x, y) => { let i = 0; while (i < x.length && x[i] === y[i]) i += 1; return i; };
    const now = after.filter((x) => !before.includes(x));
    assert(!diff.length, `Company B changed: ${diff.map((x, k) => { const y = now[k] || ""; const i = at(x, y); return `${x.slice(0, 40)}… before[${x.slice(Math.max(0, i - 120), i + 80)}] after[${y.slice(Math.max(0, i - 120), i + 80)}]`; }).join(" || ")}`);
  });
  await check("Company B's audit log has no entry made by a Company A user", async () => {
    const r = await api("/api/reports/audit-log?pageSize=500", { token: ctx.sb });
    assert(r.status === 200, `audit ${r.status}`);
    const t = r.text.toLowerCase();
    assert(!t.includes("amina") && !t.includes("probe"), "Company A activity appears in Company B's audit log");
  });
  await check("Company A never stored a reference to one of Company B's ids", async () => {
    const aNow = new Set();
    for (const r of getStatic) { const ra = await api(r.pattern, { token: aAdmin }); if (ra.json) harvest(ra.json, aNow); }
    const stored = onlyB.filter((id) => aNow.has(id));
    assert(!stored.length, `Company B ids now inside Company A's data: ${stored.slice(0, 10).join(", ")}`);
  });
  await check("Company B still signs in and sees its own data", async () => {
    const r = await api("/api/accounts", { token: ctx.b });
    assert(r.status === 200 && hasMark(r.text), `status ${r.status}`);
  });
}

main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
