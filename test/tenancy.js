"use strict";
// SECURITY AUDIT round: the published defaults (Demo123! / SuperAdmin123!)
// now force a password change at sign-in, so test installs are seeded with
// their own non-default passwords instead.
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
// MULTI-COMPANY round — tenant isolation & security test suite.
//
// Builds a real installation on a scratch directory: the primary company
// (CMP-0001, seeded with the demo data) plus two more companies registered
// through the real Super Admin API. Then drives the HTTP API as different
// users from different companies and proves:
//   * Company A can never read/write Company B's accounts, transactions,
//     quotations, cash, users, reports or exports — not via URLs, record IDs,
//     query strings, request bodies or headers;
//   * tokens can't be forged/re-pointed to another company;
//   * dashboard totals/balances are company-specific;
//   * Company Admin / Staff permissions are enforced by the backend;
//   * inactive/suspended companies lock their users out (but not Super Admin);
//   * Super Admin company management is protected;
//   * the database itself rejects a row stamped with another Company ID;
//   * existing financial workflows (deposit, exchange, transfer) still work.
// Optional last part (needs Playwright + Chromium): switching company in the
// browser leaves no data from the previous company on screen or in storage.
//
// Run with: npm run test:tenancy
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".tenancy-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("tenancy");
const PORT = Number(process.env.TENANCY_TEST_PORT || 4320);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0" };

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString("latin1"), headers: res.headers };
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json };
}
async function login(username, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { username, password } });
  return r;
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding the primary company (CMP-0001) with demo data...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    await waitUp();
    await run();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally {
    srv.kill();
  }
  const leaked = serverErr.split("\n").filter((l) => /Blocked data access without company context|Unhandled error/.test(l));
  if (leaked.length) failures.push("server logged unexpected errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
}

const ctx = {};

async function run() {
  console.log("\nSuper Admin & company registration");
  await check("Super Admin signs in as a platform account with no company selected", async () => {
    const r = await login("super.admin", SA_PW);
    assert(r.status === 200, `login ${r.status}`);
    assert(r.json.user.isPlatformAdmin === true && r.json.user.company === null, "expected platform admin with no company");
    ctx.sa = r.json.token;
  });
  await check("Super Admin with no workspace selected cannot read any company data", async () => {
    const r = await api("/api/accounts", { token: ctx.sa });
    assert(r.status === 403 && r.json.code === "COMPANY_REQUIRED", `expected 403 COMPANY_REQUIRED, got ${r.status}`);
  });
  await check("the pre-existing installation is registered as primary company CMP-0001", async () => {
    const r = await api("/api/platform/companies", { token: ctx.sa });
    assert(r.status === 200, `status ${r.status}`);
    const a = r.json.companies.find((c) => c.id === "CMP-0001");
    assert(a && a.isPrimary && a.status === "active", "CMP-0001 missing or not primary/active");
  });
  await check("Company A users sign in bound to CMP-0001", async () => {
    const r = await login("amina.yusuf", DEMO_PW);
    assert(r.status === 200, `login ${r.status}`);
    assert(r.json.user.company && r.json.user.company.name && r.json.user.company.id === undefined, "company users get the company name but never its ID");
    ctx.aName = r.json.user.company.name;
    assert(r.json.user.isPlatformAdmin === false, "company admin must not be a platform admin");
    ctx.aAdmin = r.json.token;
    ctx.aCashier = (await login("cabdi.maxamed", DEMO_PW)).json.token;
  });
  await check("Company Admin cannot register, list, edit or switch companies", async () => {
    for (const [m, p, b] of [["GET", "/api/platform/companies"], ["POST", "/api/platform/companies", { name: "Evil Co" }], ["GET", "/api/platform/overview"],
      ["PATCH", "/api/platform/companies/CMP-0001", { name: "x" }], ["POST", "/api/platform/companies/CMP-0001/status", { status: "suspended" }],
      ["POST", "/api/platform/switch-company", { companyId: "CMP-0001" }], ["POST", "/api/platform/companies/CMP-0001/admins", { name: "x", username: "xx.yy", password: "Password1!" }]]) {
      const r = await api(p, { method: m, body: b, token: ctx.aAdmin });
      assert(r.status === 403, `${m} ${p} should be 403 for a Company Admin, got ${r.status}`);
    }
    const anon = await api("/api/platform/companies");
    assert(anon.status === 401, `anonymous should be 401, got ${anon.status}`);
  });
  // Snapshot Company A's numbers BEFORE any other company exists/acts.
  ctx.aDashBefore = (await api("/api/dashboard", { token: ctx.aAdmin })).json.summary;
  ctx.aAccounts = (await api("/api/accounts", { token: ctx.aAdmin })).json.accounts;
  await check("Super Admin registers Company B with its first Company Admin (permanent ID CMP-0002)", async () => {
    const r = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Beta Traders Ltd", phone: "+252 63 111", email: "info@beta.example", address: "Berbera", admin: { name: "Bashir Admin", username: "b.admin", password: "BetaPass123!" } } });
    assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.json)}`);
    assert(r.json.company.id === "CMP-0002", `expected CMP-0002, got ${r.json.company.id}`);
    // MYSQL round: Company B gets its own, separate set of tables.
    const c = require("./helpers/mysql").openScope(TESTDB.env, { control: true });
    try {
      const names = c.raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((x) => x.n);
      assert(names.includes("cmp0002_clients") && names.includes("cmp0002_account_ledger") && names.includes("cmp0002_tenant_meta"), "Company B must get its own tables");
    } finally { c.close(); }
  });
  await check("company names and usernames are unique across companies", async () => {
    let r = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "beta traders ltd" } });
    assert(r.status === 409, `duplicate name should be 409, got ${r.status}`);
    r = await api("/api/platform/companies", { method: "POST", token: ctx.sa, body: { name: "Gamma Co", admin: { name: "Dup", username: "amina.yusuf", password: "Password1!" } } });
    assert(r.status === 409, `duplicate username across companies should be 409, got ${r.status}`);
  });
  await check("a Company ID is permanent", async () => {
    const r = await api("/api/platform/companies/CMP-0002", { method: "PATCH", token: ctx.sa, body: { id: "CMP-0099", name: "Beta Traders Ltd" } });
    assert(r.status === 400, `changing the id should be refused, got ${r.status}`);
  });

  console.log("\nCompany B setup through its own Company Admin");
  await check("Company B admin signs in bound to CMP-0002 and starts with no records", async () => {
    const r = await login("b.admin", "BetaPass123!");
    assert(r.status === 200 && r.json.user.company.name === "Beta Traders Ltd" && r.json.user.company.id === undefined, `login ${r.status}`);
    ctx.bAdmin = r.json.token;
    const acc = await api("/api/accounts", { token: ctx.bAdmin });
    assert(acc.status === 200 && acc.json.accounts.length === 0, `B should start empty, got ${acc.json && acc.json.accounts && acc.json.accounts.length}`);
  });
  await check("Company B sets its own rates and creates its own accounts", async () => {
    let r = await api("/api/rate", { method: "POST", token: ctx.bAdmin, body: { rate: 8000 } });
    assert(r.status === 200 || r.status === 201, `rate ${r.status} ${JSON.stringify(r.json)}`);
    r = await api("/api/accounts", { method: "POST", token: ctx.bAdmin, body: { name: "Beta Customer One", currency: "USD", openingBalance: 500 } });
    assert(r.status === 201, `account ${r.status} ${JSON.stringify(r.json)}`);
    ctx.bAcc1 = r.json.account;
    r = await api("/api/accounts", { method: "POST", token: ctx.bAdmin, body: { name: "Beta Customer Two", currency: "USD", openingBalance: 0 } });
    ctx.bAcc2 = r.json.account;
    r = await api("/api/accounts", { method: "POST", token: ctx.bAdmin, body: { name: "Beta Shilling", currency: "SLSH", openingBalance: 1000000 } });
    ctx.bAccS = r.json.account;
    const rateA = (await api("/api/rate", { token: ctx.aAdmin })).json.rate;
    assert(rateA !== 8000, "Company B's rate must not change Company A's rate");
  });
  await check("Company B admin creates a staff user; usernames from Company A are rejected", async () => {
    const roles = (await api("/api/roles", { token: ctx.bAdmin })).json.roles;
    const cashier = roles.find((x) => x.key === "cashier");
    let r = await api("/api/users", { method: "POST", token: ctx.bAdmin, body: { name: "Beta Cashier", username: "b.cashier", password: "Cashier123!", roleId: cashier.id } });
    assert(r.status === 201, `create ${r.status} ${JSON.stringify(r.json)}`);
    r = await api("/api/users", { method: "POST", token: ctx.bAdmin, body: { name: "Imposter", username: "amina.yusuf", password: "Password123!", roleId: cashier.id } });
    assert(r.status === 400, `taking Company A's username must be refused, got ${r.status}`);
    ctx.bCashier = (await login("b.cashier", "Cashier123!")).json.token;
    assert(ctx.bCashier, "b.cashier could not log in");
  });
  await check("a Company Admin can never create or promote a Super Admin", async () => {
    const roles = (await api("/api/roles", { token: ctx.bAdmin })).json.roles;
    const sup = roles.find((x) => x.isSuperAdmin || x.key === "super_admin");
    if (sup) {
      const r = await api("/api/users", { method: "POST", token: ctx.bAdmin, body: { name: "X", username: "b.sup", password: "Password123!", roleId: sup.id } });
      assert(r.status === 400 || r.status === 403, `expected refusal, got ${r.status}`);
    }
  });

  // Gather Company A record ids to attack from Company B.
  ctx.aAcc = ctx.aAccounts[0];
  const aTx = (await api("/api/transactions", { token: ctx.aAdmin })).json;
  ctx.aTxId = (aTx.transactions || aTx.items || aTx)[0]?.id;
  const aQ = (await api("/api/quotations", { token: ctx.aAdmin })).json;
  ctx.aQuoteId = (aQ.quotations || aQ)[0]?.id;
  const aUsers = (await api("/api/users", { token: ctx.aAdmin })).json.users;
  ctx.aUser = aUsers.find((u) => u.username === "xasan.cali");

  console.log("\nCross-company isolation (record IDs, URLs, bodies, headers)");
  await check("Company B cannot read Company A's account by id (or its statement/exports)", async () => {
    for (const p of [`/api/accounts/${ctx.aAcc.id}`, `/api/accounts/${ctx.aAcc.id}/statement.pdf`, `/api/accounts/${ctx.aAcc.id}/statement.xlsx`]) {
      const r = await api(p, { token: ctx.bAdmin, raw: true });
      assert(r.status === 404, `${p} should be 404 from Company B, got ${r.status}`);
    }
  });
  await check("Company B cannot update, deactivate or delete Company A's account", async () => {
    let r = await api(`/api/accounts/${ctx.aAcc.id}`, { method: "PATCH", token: ctx.bAdmin, body: { name: "HACKED" } });
    assert(r.status === 404, `PATCH should be 404, got ${r.status}`);
    r = await api(`/api/accounts/${ctx.aAcc.id}/deactivate`, { method: "POST", token: ctx.bAdmin, body: { reason: "x" } });
    assert(r.status === 404, `deactivate should be 404, got ${r.status}`);
    r = await api(`/api/accounts/${ctx.aAcc.id}`, { method: "DELETE", token: ctx.bAdmin, body: { confirmName: ctx.aAcc.name } });
    assert(r.status === 404 || r.status === 400, `DELETE should not succeed, got ${r.status}`);
    const still = await api(`/api/accounts/${ctx.aAcc.id}`, { token: ctx.aAdmin });
    assert(still.status === 200 && still.json.account.name === ctx.aAcc.name && still.json.account.status !== "deactivated", "Company A's account was modified from Company B");
  });
  await check("Company B cannot read Company A's exchange transaction, quotation, or user", async () => {
    if (ctx.aTxId) {
      const r = await api(`/api/transactions/${ctx.aTxId}/receipt.pdf`, { token: ctx.bAdmin, raw: true });
      assert(r.status === 404, `receipt should be 404, got ${r.status}`);
      const p = await api(`/api/transactions/${ctx.aTxId}`, { method: "PATCH", token: ctx.bAdmin, body: { clientName: "HACKED", amountGiven: 1, currencyGiven: "USD", notes: "hacked" } });
      assert(p.status === 404, `PATCH transaction should be 404, got ${p.status}`);
    }
    if (ctx.aQuoteId) {
      for (const p of [`/api/quotations/${ctx.aQuoteId}`, `/api/quotations/${ctx.aQuoteId}/pdf`]) {
        const r = await api(p, { token: ctx.bAdmin, raw: true });
        assert(r.status === 404, `${p} should be 404, got ${r.status}`);
      }
    }
    const u = await api(`/api/users/${ctx.aUser.id}`, { method: "PATCH", token: ctx.bAdmin, body: { name: "HACKED", password: "NewPassword1!" } });
    assert(u.status === 404, `PATCH another company's user should be 404, got ${u.status}`);
    const again = await login("xasan.cali", DEMO_PW);
    assert(again.status === 200, "Company A user's password was changed from Company B");
  });
  await check("money can't be moved into/out of another company's account", async () => {
    let r = await api("/api/transfers", { method: "POST", token: ctx.bAdmin, body: { fromAccountId: ctx.bAcc1.id, toAccountId: ctx.aAcc.id, amount: 10, currency: "USD" } });
    assert(r.status >= 400 && r.status < 500, `transfer to A's account must fail, got ${r.status}`);
    r = await api("/api/accounts/bulk-deposit-withdraw", { method: "POST", token: ctx.bAdmin, body: { currency: "USD", items: [{ accountId: ctx.aAcc.id, type: "deposit", amount: 99 }] } });
    assert(r.status >= 400, `bulk deposit into A's account must fail, got ${r.status}`);
    const a = await api(`/api/accounts/${ctx.aAcc.id}`, { token: ctx.aAdmin });
    assert(a.json.account.balance === ctx.aAcc.balance || a.json.account.balanceUsd === ctx.aAcc.balanceUsd, "Company A balance changed");
  });
  await check("client-supplied company ids in query, body or headers are ignored", async () => {
    const r = await api("/api/accounts?companyId=CMP-0001&company_id=CMP-0001", { token: ctx.bAdmin, headers: { "X-Company-Id": "CMP-0001" } });
    assert(r.status === 200, `status ${r.status}`);
    const names = r.json.accounts.map((a) => a.name);
    assert(!names.some((n) => ctx.aAccounts.some((x) => x.name === n)), "Company A accounts leaked through a query/header company id");
    const c = await api("/api/accounts", { method: "POST", token: ctx.bAdmin, headers: { "X-Company-Id": "CMP-0001" }, body: { name: "Body Company Test", currency: "USD", companyId: "CMP-0001", company_id: "CMP-0001" } });
    assert(c.status === 201, `create ${c.status}`);
    const inA = (await api("/api/accounts", { token: ctx.aAdmin })).json.accounts.some((a) => a.name.includes("BODY COMPANY TEST") || a.name.includes("Body Company Test"));
    assert(!inA, "an account created by Company B landed in Company A");
  });
  await check("a token can't be re-pointed to another company (signature check)", async () => {
    const [h, p, s] = ctx.bAdmin.split(".");
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    payload.cid = "CMP-0001";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${s}`;
    const r = await api("/api/accounts", { token: forged });
    assert(r.status === 401, `forged token must be 401, got ${r.status}`);
  });
  await check("a token from before multi-company support (no company) is rejected", async () => {
    const r = await api("/api/accounts", { token: signLegacy({ sub: "u-admin", role: "admin" }) });
    assert(r.status === 401, `legacy token must be 401, got ${r.status}`);
  });
  await check("a company user with a validly-signed token for ANOTHER company is rejected", async () => {
    // Even if someone obtained a signed token claiming Company A for B's user id, the user doesn't exist there.
    const bMe = (await api("/api/auth/me", { token: ctx.bAdmin })).json.user;
    const r = await api("/api/accounts", { token: signLegacy({ sub: bMe.id, kind: "tenant", cid: "CMP-0001", rolePermVer: 1, userPermVer: 1 }) });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  console.log("\nLists, search, totals, reports and exports are company-specific");
  await check("account lists and search only return the caller's company", async () => {
    const b = (await api("/api/accounts?search=a", { token: ctx.bAdmin })).json.accounts;
    assert(b.every((x) => /beta|body company/i.test(x.name)), `Company B saw foreign accounts: ${b.map((x) => x.name).join(", ")}`);
    const a = (await api("/api/accounts", { token: ctx.aAdmin })).json.accounts;
    assert(!a.some((x) => /beta|body company/i.test(x.name)), "Company A saw Company B accounts");
  });
  await check("dashboard totals are company-specific and Company A's are unchanged by Company B's activity", async () => {
    const bDash = (await api("/api/dashboard", { token: ctx.bAdmin })).json.summary;
    assert(Math.abs(bDash.usdBalance - 500) < 1e-9, `Company B USD balance should be 500, got ${bDash.usdBalance}`);
    assert(Math.abs(bDash.slshBalance - 1000000) < 1e-9, `Company B SLSH balance should be 1,000,000, got ${bDash.slshBalance}`);
    const aDash = (await api("/api/dashboard", { token: ctx.aAdmin })).json.summary;
    assert(aDash.usdBalance === ctx.aDashBefore.usdBalance && aDash.slshBalance === ctx.aDashBefore.slshBalance, "Company A totals changed");
  });
  await check("CSV exports contain only the caller's company data", async () => {
    const b = await api("/api/accounts/export.csv", { token: ctx.bAdmin, raw: true });
    assert(b.status === 200, `B export ${b.status}`);
    for (const acc of ctx.aAccounts) assert(!b.text.includes(acc.name), `Company A account "${acc.name}" appears in Company B's export`);
    const a = await api("/api/accounts/export.csv", { token: ctx.aAdmin, raw: true });
    assert(!/Beta Customer|BETA CUSTOMER/.test(a.text), "Company B data appears in Company A's export");
    const h = await api("/api/history/export.csv?currency=USD", { token: ctx.bAdmin, raw: true });
    for (const acc of ctx.aAccounts) assert(!h.text.includes(acc.name), "Company A appears in Company B's history export");
  });
  await check("reports and audit logs are company-specific", async () => {
    const b = await api("/api/reports/audit-log", { token: ctx.bAdmin });
    const rows = b.json.entries || b.json.rows || b.json.log || b.json;
    const text = JSON.stringify(rows);
    assert(!/AMINA YUSUF|XASAN CALI/.test(text), "Company A users appear in Company B's audit log");
    const ex = await api("/api/reports/exchange-summary", { token: ctx.bAdmin });
    assert(ex.status === 200, `exchange summary ${ex.status}`);
    assert(!JSON.stringify(ex.json).match(/AMINA|XASAN|CABDI/), "Company A staff appear in Company B's exchange report");
  });
  await check("PDF/Excel exports carry the caller's own company branding", async () => {
    const sb = (await api("/api/settings/company", { token: ctx.bAdmin })).json.company;
    const sa = (await api("/api/settings/company", { token: ctx.aAdmin })).json.company;
    assert(sb.name === "Beta Traders Ltd" && sb.companyId === undefined, `B branding: ${sb.name}`);
    assert(sa.name !== sb.name && sa.companyId === undefined, "A branding wrong");
    const pdf = await api("/api/accounts/export.pdf", { token: ctx.bAdmin, raw: true });
    assert(pdf.status === 200 && pdf.text.startsWith("%PDF"), `B pdf ${pdf.status}`);
    const xlsx = await api("/api/accounts/export.xlsx", { token: ctx.bAdmin, raw: true });
    assert(xlsx.status === 200, `B xlsx ${xlsx.status}`);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xlsx.text, "latin1"));
    let cells = "";
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { cells += ` ${c.text}`; })));
    assert(cells.includes("Beta Traders Ltd"), "Company B's Excel export must carry Company B's letterhead");
    assert(!cells.includes(sa.name), "Company A's name appears in Company B's Excel export");
    for (const acc of ctx.aAccounts) assert(!cells.toLowerCase().includes(acc.name.toLowerCase()), `Company A account "${acc.name}" in Company B's Excel export`);
    const anon = (await api("/api/settings/company")).json.company;
    // GLOBAL LOGIN round: the shared login page shows the neutral platform identity, never a company's.
    assert(anon.isDefault === true && anon.companyId === undefined && !anon.logoDataUrl && !anon.address, "login screen must not show any company's branding");
  });
  await check("user lists are company-specific (and hide platform Super Admin accounts)", async () => {
    const b = (await api("/api/users", { token: ctx.bAdmin })).json.users.map((u) => u.username);
    assert(b.includes("b.admin") && b.includes("b.cashier"), "B users missing");
    assert(!b.some((u) => ["amina.yusuf", "xasan.cali", "super.admin"].includes(u) || u.startsWith("__platform__")), `B sees foreign users: ${b.join(",")}`);
    const a = (await api("/api/users", { token: ctx.aAdmin })).json.users.map((u) => u.username);
    assert(!a.includes("b.admin") && !a.includes("b.cashier"), "Company A sees Company B users");
  });

  console.log("\nRoles & permissions enforced on the backend");
  await check("Staff (cashier) can't manage users, accounts, settings or roles", async () => {
    for (const [m, p, b] of [["GET", "/api/users"], ["POST", "/api/users", { name: "x", username: "x.y.z", password: "Password1!", role: "viewer" }],
      ["POST", "/api/accounts", { name: "x", currency: "USD" }], ["PATCH", "/api/settings/company", { name: "Hacked" }], ["POST", "/api/roles", { name: "R" }]]) {
      const r = await api(p, { method: m, body: b, token: ctx.bCashier });
      assert(r.status === 403, `${m} ${p} should be 403 for staff, got ${r.status}`);
    }
  });
  await check("Company Admin can't use Super-Admin-only company functions (backups)", async () => {
    const r = await api("/api/backups", { token: ctx.bAdmin });
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  console.log("\nCompany status: inactive / suspended");
  await check("suspending Company B locks out its live sessions and logins, but not Company A", async () => {
    const r = await api("/api/platform/companies/CMP-0002/status", { method: "POST", token: ctx.sa, body: { status: "suspended", reason: "test" } });
    assert(r.status === 200 && r.json.company.status === "suspended", `suspend ${r.status}`);
    const live = await api("/api/accounts", { token: ctx.bAdmin });
    assert(live.status === 403 && live.json.code === "COMPANY_SUSPENDED", `live session should be blocked, got ${live.status}`);
    const li = await login("b.cashier", "Cashier123!");
    assert(li.status === 403, `login should be refused, got ${li.status}`);
    const wrong = await login("b.cashier", "wrong-password");
    assert(wrong.status === 401, "wrong password must not reveal company status");
    const a = await api("/api/accounts", { token: ctx.aAdmin });
    assert(a.status === 200, "Company A must be unaffected");
  });
  await check("Super Admin can still open a suspended company's workspace", async () => {
    const r = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0002" } });
    assert(r.status === 200, `switch ${r.status}`);
    const acc = await api("/api/accounts", { token: r.json.token });
    assert(acc.status === 200 && acc.json.accounts.some((x) => /beta customer one/i.test(x.name)), "Super Admin should see B's accounts");
  });
  await check("deactivated (inactive) companies are locked out too; re-activation restores access", async () => {
    await api("/api/platform/companies/CMP-0002/status", { method: "POST", token: ctx.sa, body: { status: "inactive" } });
    assert((await login("b.admin", "BetaPass123!")).status === 403, "inactive company login should be 403");
    await api("/api/platform/companies/CMP-0002/status", { method: "POST", token: ctx.sa, body: { status: "active" } });
    const r = await login("b.admin", "BetaPass123!");
    assert(r.status === 200, `re-activated login ${r.status}`);
    ctx.bAdmin = r.json.token;
  });
  // COMPANY STATUS round: Deactivate and Suspend are independent switches,
  // available on every company (the primary one included).
  const act = (id, action, reason) => api(`/api/platform/companies/${id}/status`, { method: "POST", token: ctx.sa, body: { action, reason } });
  const canUse = async (u, pw) => (await login(u, pw)).status === 200;
  await check("the primary company can now be deactivated and re-activated, independently of Company B", async () => {
    let r = await act("CMP-0001", "deactivate", "test closure");
    assert(r.status === 200 && r.json.company.deactivated === true && r.json.company.status === "inactive", `deactivate ${r.status} ${JSON.stringify(r.json)}`);
    const msg = await login("cabdi.maxamed", DEMO_PW);
    assert(msg.status === 403 && /deactivated/i.test(msg.json.error), `A staff should get the deactivated message: ${JSON.stringify(msg.json)}`);
    assert(await canUse("b.admin", "BetaPass123!"), "Company B must be unaffected");
    r = await act("CMP-0001", "activate");
    assert(r.status === 200 && r.json.company.status === "active", "activate");
    assert(await canUse("cabdi.maxamed", DEMO_PW), "A users should work again");
  });
  await check("suspend needs a reason and shows a distinct message", async () => {
    let r = await act("CMP-0002", "suspend", "");
    assert(r.status === 400, `suspend without reason should be 400, got ${r.status}`);
    r = await act("CMP-0002", "suspend", "unpaid invoice");
    assert(r.status === 200 && r.json.company.suspended === true && r.json.company.suspendedReason === "unpaid invoice", "suspend");
    const msg = await login("b.cashier", "Cashier123!");
    assert(msg.status === 403 && /suspended/i.test(msg.json.error), `B staff should get the suspended message: ${msg.json && msg.json.error}`);
    assert(await canUse("amina.yusuf", DEMO_PW), "Company A must be unaffected");
  });
  await check("the two switches are independent: unsuspending a deactivated company keeps it blocked", async () => {
    let r = await act("CMP-0002", "deactivate", "closing");
    assert(r.json.company.deactivated && r.json.company.suspended, "both switches should be on");
    r = await act("CMP-0002", "unsuspend");
    assert(r.status === 200 && r.json.company.suspended === false && r.json.company.deactivated === true && r.json.company.status === "inactive", "unsuspend must leave it deactivated");
    assert(!(await canUse("b.admin", "BetaPass123!")), "still blocked while deactivated");
    r = await act("CMP-0002", "activate");
    assert(r.json.company.status === "active", "activate");
    assert(await canUse("b.admin", "BetaPass123!"), "B usable again");
    ctx.bAdmin = (await login("b.admin", "BetaPass123!")).json.token;
  });
  await check("both companies can be suspended and unsuspended independently", async () => {
    await act("CMP-0001", "suspend", "audit A"); await act("CMP-0002", "suspend", "audit B");
    assert(!(await canUse("amina.yusuf", DEMO_PW)) && !(await canUse("b.admin", "BetaPass123!")), "both blocked");
    await act("CMP-0001", "unsuspend");
    assert(await canUse("amina.yusuf", DEMO_PW) && !(await canUse("b.admin", "BetaPass123!")), "only A restored");
    await act("CMP-0002", "unsuspend");
    assert(await canUse("b.admin", "BetaPass123!"), "B restored");
    ctx.aAdmin = (await login("amina.yusuf", DEMO_PW)).json.token;
    ctx.bAdmin = (await login("b.admin", "BetaPass123!")).json.token;
  });
  await check("repeating an action, unknown actions, and non-Super-Admins are refused", async () => {
    assert((await act("CMP-0001", "activate")).status === 409, "already active should be 409");
    assert((await act("CMP-0001", "explode")).status === 400, "unknown action should be 400");
    const r = await api("/api/platform/companies/CMP-0002/status", { method: "POST", token: ctx.aAdmin, body: { action: "suspend", reason: "x" } });
    assert(r.status === 403, `Company Admin must get 403, got ${r.status}`);
  });
  await check("a Super Admin keeps working in a deactivated current workspace (with status shown)", async () => {
    await act("CMP-0002", "deactivate", "x");
    const sw = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0002" } });
    assert(sw.status === 200 && sw.json.user.company.deactivated === true, "switch into deactivated company");
    assert((await api("/api/accounts", { token: sw.json.token })).status === 200, "Super Admin can still read it");
    await act("CMP-0002", "activate");
  });

  console.log("\nSuper Admin workspace switching");
  await check("switching company issues a token bound to that company only", async () => {
    const ta = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0001" } })).json;
    const tb = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0002" } })).json;
    assert(ta.user.company.id === "CMP-0001" && tb.user.company.id === "CMP-0002", "wrong company on switch");
    const la = (await api("/api/accounts", { token: ta.token })).json.accounts.map((x) => x.name);
    const lb = (await api("/api/accounts", { token: tb.token })).json.accounts.map((x) => x.name);
    assert(!la.some((n) => lb.includes(n)), "account lists overlap between companies");
    ctx.saA = ta.token; ctx.saB = tb.token;
  });
  await check("a Super Admin's writes inside a workspace land only in that company", async () => {
    const r = await api("/api/accounts", { method: "POST", token: ctx.saB, body: { name: "SA Made In Beta", currency: "USD" } });
    assert(r.status === 201, `create ${r.status}`);
    const inA = (await api("/api/accounts", { token: ctx.saA })).json.accounts.some((x) => /SA MADE IN BETA|SA Made In Beta/.test(x.name));
    assert(!inA, "Super Admin's Company B record appeared in Company A");
  });
  await check("switching to an unknown company is refused", async () => {
    const r = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-9999" } });
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });
  await check("a Super Admin's in-company identity can't be edited from a company Users page", async () => {
    const users = (await api("/api/users", { token: ctx.saB })).json.users;
    const shadow = users.find((u) => u.isSuperAdmin);
    assert(shadow, "expected the Super Admin row to be visible to a Super Admin");
    const r = await api(`/api/users/${shadow.id}`, { method: "PATCH", token: ctx.bAdmin, body: { password: "Hijack12345" } });
    assert(r.status === 400 || r.status === 403, `expected refusal, got ${r.status}`);
    assert((await login("super.admin", SA_PW)).status === 200, "platform password must be unchanged");
  });

  console.log("\nExisting financial workflows still work (per company)");
  await check("deposit, transfer and exchange keep correct balances inside Company B", async () => {
    let r = await api("/api/accounts/bulk-deposit-withdraw", { method: "POST", token: ctx.bAdmin, body: { currency: "USD", items: [{ accountId: ctx.bAcc1.id, type: "deposit", amount: 250 }, { accountId: ctx.bAcc2.id, type: "deposit", amount: 40 }] } });
    assert(r.status === 200 || r.status === 201, `bulk ${r.status} ${JSON.stringify(r.json)}`);
    r = await api("/api/transfers", { method: "POST", token: ctx.bAdmin, body: { fromAccountId: ctx.bAcc1.id, toAccountId: ctx.bAcc2.id, amount: 100, currency: "USD" } });
    assert(r.status === 201 || r.status === 200, `transfer ${r.status} ${JSON.stringify(r.json)}`);
    const a1 = (await api(`/api/accounts/${ctx.bAcc1.id}`, { token: ctx.bAdmin })).json.account;
    const a2 = (await api(`/api/accounts/${ctx.bAcc2.id}`, { token: ctx.bAdmin })).json.account;
    const bal = (a) => (a.balance !== undefined ? a.balance : a.currency === "USD" ? a.balanceUsd : a.balanceSlsh);
    assert(Math.abs(bal(a1) - 650) < 1e-9, `account 1 should be 650, got ${bal(a1)}`);
    assert(Math.abs(bal(a2) - 140) < 1e-9, `account 2 should be 140, got ${bal(a2)}`);
    r = await api("/api/transactions", { method: "POST", token: ctx.bAdmin, body: { clientName: "Walk-in", amountGiven: 10, currencyGiven: "USD" } });
    assert(r.status === 201 || r.status === 200, `exchange ${r.status} ${JSON.stringify(r.json)}`);
    const tx = r.json.transaction || r.json;
    assert(Number(tx.amountReceived ?? tx.amount_received) === 80000, `exchange should use Company B's own rate (8000): ${JSON.stringify(tx).slice(0, 200)}`);
  });
  await check("reference numbers are sequenced per company", async () => {
    const b = (await api("/api/transfers", { token: ctx.bAdmin })).json;
    const list = b.transfers || b;
    assert(list.length === 1 && /TR-\d{4}-0001/.test(list[0].referenceNumber || list[0].reference_number), `Company B's first transfer should be TR-YYYY-0001: ${JSON.stringify(list[0]).slice(0, 160)}`);
  });

  console.log("\nCompany ID visibility (Super Admin only)");
  const decode = (t) => JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  const HAS_ID = /CMP-\d{4,}/;
  // A legacy audit entry that names a Company ID (as older Super Admin actions did).
  {
    const bdb = require("./helpers/mysql").openScope(TESTDB.env, { companyId: "CMP-0002" });
    bdb.prepare("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES ('log_legacy_cmp', ?, 'x', 'SUPER ADMIN', 'super_admin', 'Super Admin opened company workspace', 'CMP-0002')").run(new Date().toISOString());
    bdb.prepare("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES ('log_legacy_cmp2', ?, 'x', 'SUPER ADMIN', 'super_admin', 'Company registered', 'CMP-0002 — Beta Traders Ltd')").run(new Date().toISOString());
    bdb.close();
  }
  const roles = [["Company Admin (A)", "amina.yusuf", DEMO_PW], ["Staff (A, cashier)", "cabdi.maxamed", DEMO_PW], ["Company Admin (B)", "b.admin", "BetaPass123!"], ["Staff (B, cashier)", "b.cashier", "Cashier123!"]];
  const ENDPOINTS = ["/api/auth/me", "/api/settings/company", "/api/accounts", "/api/accounts/deactivated", "/api/dashboard", "/api/transactions", "/api/transfers",
    "/api/quotations", "/api/quotations/counts", "/api/history?currency=USD", "/api/account-ledger?currency=USD", "/api/users", "/api/roles", "/api/permissions",
    "/api/reports/audit-log", "/api/reports/exchange-summary", "/api/reports/currency-position", "/api/reports/staff-activity", "/api/reports/quotations",
    "/api/notifications", "/api/system-overview", "/api/rate", "/api/rate-history", "/api/sale-rate", "/api/cash/accounts", "/api/cash/summary", "/api/cash/ledger",
    "/api/loans", "/api/pdf-templates?kind=global", "/api/excel-templates?kind=global", "/api/table-layout/accounts.usd", "/api/dashboard-layout", "/api/accounts/import-history"];
  const CSVS = ["/api/accounts/export.csv?currency=USD", "/api/history/export.csv?currency=USD", "/api/reports/audit-log/export.csv", "/api/transactions/export.csv", "/api/dashboard/export.csv"];
  for (const [label, u, pw] of roles) {
    await check(`${label}: login response and token contain no Company ID`, async () => {
      const r = await api("/api/auth/login", { method: "POST", body: { username: u, password: pw } });
      assert(r.status === 200, `login ${r.status}`);
      assert(!HAS_ID.test(JSON.stringify(r.json)), "login response contains a Company ID");
      assert(!HAS_ID.test(JSON.stringify(decode(r.json.token))), "token payload contains a readable Company ID");
      ctx[`vis_${u}`] = r.json.token;
    });
    await check(`${label}: no Company ID or company_id in ${ENDPOINTS.length} API responses`, async () => {
      const leaks = [];
      for (const ep of ENDPOINTS) {
        const r = await api(ep, { token: ctx[`vis_${u}`], raw: true });
        if (r.status !== 200) continue; // 403 for endpoints this role can't use is fine
        if (HAS_ID.test(r.text) || /"company_?id"/i.test(r.text)) leaks.push(ep);
      }
      assert(leaks.length === 0, `leaks: ${leaks.join(", ")}`);
    });
    await check(`${label}: CSV exports contain no Company ID`, async () => {
      const leaks = [];
      for (const ep of CSVS) {
        const r = await api(ep, { token: ctx[`vis_${u}`], raw: true });
        if (r.status === 200 && HAS_ID.test(r.text)) leaks.push(ep);
      }
      assert(leaks.length === 0, `leaks: ${leaks.join(", ")}`);
    });
    await check(`${label}: platform endpoints that list Company IDs stay closed`, async () => {
      for (const ep of ["/api/platform/companies", "/api/platform/overview", "/api/platform/companies/CMP-0001"]) {
        const r = await api(ep, { token: ctx[`vis_${u}`] });
        assert(r.status === 403, `${ep} should be 403, got ${r.status}`);
      }
    });
  }
  await check("legacy audit entries are shown without the Company ID (text kept)", async () => {
    const r = await api("/api/reports/audit-log", { token: ctx.vis_b_admin || ctx["vis_b.admin"], raw: true });
    assert(r.status === 200 && !HAS_ID.test(r.text) && r.text.includes("Beta Traders Ltd"), "redaction failed or removed the surrounding text");
  });
  await check("Super Admin: Company IDs are visible (console, switch, branding, audit)", async () => {
    const list = await api("/api/platform/companies", { token: ctx.sa, raw: true });
    assert(list.text.includes("CMP-0001") && list.text.includes("CMP-0002"), "company list without IDs");
    const sw = (await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0002" } })).json;
    assert(sw.user.company.id === "CMP-0002", "switch response missing the ID");
    const br = (await api("/api/settings/company", { token: sw.token })).json.company;
    assert(br.companyId === "CMP-0002", "Super Admin branding should include the ID");
    const au = await api("/api/reports/audit-log", { token: sw.token, raw: true });
    assert(au.text.includes("CMP-0002"), "Super Admin should still see IDs in the audit log");
  });
  await check("sealed company reference can't be forged or swapped", async () => {
    const t = ctx["vis_b.admin"]; const [h, p, sg] = t.split(".");
    const pl = decode(t); pl.cref = decode(ctx["vis_amina.yusuf"]).cref;
    const forged = `${h}.${Buffer.from(JSON.stringify(pl)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${sg}`;
    assert((await api("/api/accounts", { token: forged })).status === 401, "swapped cref must be rejected");
  });

  console.log("\nDatabase-level protection");
  await check("each company's tables are stamped with its own Company ID on every row", async () => {
    const { openScope } = require("./helpers/mysql");
    const bdb = openScope(TESTDB.env, { companyId: "CMP-0002" });
    try {
      assert(bdb.prepare("SELECT company_id FROM tenant_meta").get().company_id === "CMP-0002", "tenant_meta");
      const wrong = bdb.prepare("SELECT COUNT(*) AS n FROM clients WHERE company_id != 'CMP-0002'").get().n;
      assert(wrong === 0, "rows with a foreign company_id");
      let threw = false;
      try { bdb.prepare("INSERT INTO clients (id, name, created_at, company_id) VALUES ('x1','Smuggled', '2026-01-01', 'CMP-0001')").run(); } catch (e) { threw = /Check constraint .* is violated/.test(e.message); }
      assert(threw, "inserting a row stamped for another company must abort");
      threw = false;
      try { bdb.prepare("UPDATE clients SET company_id = 'CMP-0001'").run(); } catch (e) { threw = /Check constraint .* is violated/.test(e.message); }
      assert(threw, "re-stamping rows to another company must abort");
    } finally { bdb.close(); }
    const adb = openScope(TESTDB.env, { companyId: "CMP-0001" });
    try {
      assert(adb.prepare("SELECT company_id FROM tenant_meta").get().company_id === "CMP-0001", "primary tenant_meta");
      assert(adb.prepare("SELECT COUNT(*) AS n FROM account_ledger WHERE company_id != 'CMP-0001'").get().n === 0, "primary rows stamped");
    } finally { adb.close(); }
  });
  await check("a company's tables can never be opened as, or stamped for, a different company", async () => {
    const { openScope } = require("./helpers/mysql");
    const bdb = openScope(TESTDB.env, { companyId: "CMP-0002" });
    try {
      let threw = false;
      try { bdb.prepare("UPDATE tenant_meta SET company_id = 'CMP-0001'").run(); } catch (e) { threw = /Check constraint .* is violated/.test(e.message); }
      assert(threw, "re-stamping tenant_meta to another company must be refused by the database");
    } finally { bdb.close(); }
    const out = execFileSync(process.execPath, ["-e", `
      const { openTenantDb } = require(${JSON.stringify(path.join(ROOT, "src", "db.js"))});
      const r = openTenantDb("CMP-0002");
      const a = r.db.prepare("SELECT company_id FROM tenant_meta").get().company_id;
      let direct = "OPEN";
      try { openTenantDb("CMP-0001").db.prepare("SELECT COUNT(*) AS n FROM cmp0002_clients").get(); } catch (e) { direct = "REFUSED " + e.message; }
      console.log(a + " " + direct);
      require(${JSON.stringify(path.join(ROOT, "src", "mysql", "connection.js"))}).close();`], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert(/^CMP-0002 REFUSED/.test(out.trim()), `expected CMP-0002's own tables and a refusal for direct access, got: ${out}`);
  });
}

function signLegacy(payload) {
  const b64 = (x) => Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ ...payload, iat: now, exp: now + 3600 }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${sig}`;
}

// Browser: switching companies must not leave the previous company's data
// on screen or in storage (full reload + per-company storage keys).
async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nBrowser: company switching leaves no stale data");
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.fill('input[placeholder="Username"]', "super.admin");
    await page.fill('input[placeholder="Password"]', SA_PW);
    await page.click(".gk-login-submit");
    await page.waitForSelector("text=Super Admin Console", { timeout: 15000 });
    await check("console lists both companies, each with its own Company ID", async () => {
      await page.waitForSelector("text=CMP-0002", { timeout: 10000 });
      const t = await page.textContent("body");
      assert(t.includes("CMP-0001") && t.includes("Beta Traders Ltd"), "companies missing");
    });
    await page.locator(".gk-icon-btn", { hasText: "Open workspace" }).first().click();
    await page.waitForSelector('button[title="Switch company"]', { timeout: 15000 });
    await page.evaluate(() => localStorage.setItem("probe_a_marker", "1"));
    await check("Company A workspace shows the active company and A's accounts", async () => {
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("button", { name: "USD Accounts", exact: true }).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(TMP, "a-accounts.png") });
      const t = await page.textContent("body");
      assert(t.includes("CMP-0001"), "active company id not visible");
      assert(ctx.aAccounts.filter((a) => a.currency === "USD").some((a) => t.toLowerCase().includes(a.name.toLowerCase())), "A's accounts not shown");
    });
    await page.click('button[title="Switch company"]');
    await page.click('[role="option"]:has-text("Beta Traders Ltd")');
    await page.waitForLoadState("load");
    await page.waitForSelector("text=CMP-0002", { timeout: 15000 });
    await check("after switching to Company B, nothing from Company A remains on screen", async () => {
      await page.getByRole("button", { name: "Account", exact: true }).click().catch(() => {});
      await page.getByRole("button", { name: "USD Accounts", exact: true }).click().catch(() => {});
      await page.waitForTimeout(1500);
      const t = await page.textContent("body");
      assert(t.includes("Beta Traders Ltd") || t.includes("BETA CUSTOMER ONE") || t.includes("Beta Customer One"), "B not shown");
      const leaked = ctx.aAccounts.filter((a) => t.toLowerCase().includes(a.name.toLowerCase()));
      assert(leaked.length === 0, `Company A data still on screen: ${leaked.map((a) => a.name).join(", ")}`);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("geeska_user")).company.id);
      assert(stored === "CMP-0002", "stored session not switched");
    });
    await check("no browser errors during switching", async () => { assert(errors.length === 0, errors.join(" | ")); });
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
