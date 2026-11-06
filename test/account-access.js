"use strict";
// ACCOUNT-LEVEL ACCESS round — per account access (Full / View Only /
// View + Credit Only / View + Debit Only / No Access) set on a ROLE and on
// one USER, enforced by the server on every route. Most restrictive wins.
// On a throw-away database. Run with: npm run test:account-access
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("acctaccess");
const PORT = Number(process.env.ACCOUNT_ACCESS_TEST_PORT || 4650);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json, text };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json?.token;
function q(sql, p = []) {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  try { const r = c.query(sql, p); return r.rows || r; } finally { c.close(); }
}
const money = () => crypto.createHash("sha1").update(JSON.stringify([q("SELECT id, balance_usd, balance_slsh FROM cmp0001_clients ORDER BY id"), q("SELECT COUNT(*) AS n, SUM(amount) AS s FROM cmp0001_account_ledger"), q("SELECT COUNT(*) AS n FROM cmp0001_exchange_transactions"), q("SELECT COUNT(*) AS n FROM cmp0001_transfers")])).digest("hex");

let srv, serverErr = "";
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart();
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
const setUser = (token, userId, changes, extra = {}) => api(`/api/users/${userId}/account-access`, { method: "PATCH", token, body: { changes, ...extra } });
const setRole = (token, roleId, changes, extra = {}) => api(`/api/roles/${roleId}/account-access`, { method: "PATCH", token, body: { changes, ...extra } });

async function run() {
  const sa = await login("super.admin", SA_PW);
  const SA = ctx.SA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const mk = async (name, currency, opening) => (await api("/api/accounts", { method: "POST", token: SA, body: { name, currency, openingBalance: opening, accountType: "company" } })).json.account;
  ctx.view = await mk("Access View Usd", "USD", 1000);
  ctx.credit = await mk("Access Credit Usd", "USD", 1000);
  ctx.debit = await mk("Access Debit Usd", "USD", 1000);
  ctx.none = await mk("Access Hidden Slsh", "SLSH", 9000000);
  ctx.full = await mk("Access Full Usd", "USD", 1000);
  ctx.roleView = await mk("Access Role View Usd", "USD", 1000);
  ctx.ceiling = await mk("Access Ceiling Usd", "USD", 1000);
  ctx.adminHidden = await mk("Access Admin Hidden Usd", "USD", 1000);
  ctx.slshFull = await mk("Access Slsh Full", "SLSH", 9000000);
  await api("/api/rate-history", { method: "POST", token: SA, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } });
  // A posting on the hidden account BEFORE it is hidden.
  await api(`/api/accounts/${ctx.none.id}/deposit`, { method: "POST", token: SA, body: { amount: 50000, currency: "SLSH" } });
  const users = (await api("/api/users", { token: SA })).json.users;
  ctx.mgr = users.find((u) => u.username === "xasan.cali");
  ctx.admin = users.find((u) => u.username === "amina.yusuf");
  ctx.cashier = users.find((u) => u.username === "cabdi.maxamed");
  // The manager may also record exchanges (for the exchange checks below).
  const ov = await api(`/api/users/${ctx.mgr.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "exchange.create", granted: true }, { permissionKey: "exchange.view", granted: true }, { permissionKey: "exchange.delete", granted: true }], confirmCritical: true } });
  if (ov.status !== 200) console.log("    (exchange override:", ov.status, ov.text.slice(0, 120), ")");
  ctx.M = await login("xasan.cali", PW);
  // xasan made a posting on `view` earlier (so removing it needs confirmation).
  const pre = await api(`/api/accounts/${ctx.view.id}/deposit`, { method: "POST", token: ctx.M, body: { amount: 5, currency: "USD" } });
  assert(pre.status < 300, `manager deposit before restrictions ${pre.status} ${pre.text}`);

  console.log("\nSetting access (Super Admin)");
  await check("Super Admin sets a user's access per account; removing access the user used needs confirmation; audited", async () => {
    const changes = [{ accountId: ctx.view.id, level: "view" }, { accountId: ctx.credit.id, level: "credit" }, { accountId: ctx.debit.id, level: "debit" }, { accountId: ctx.none.id, level: "none" }];
    const first = await setUser(SA, ctx.mgr.id, changes);
    assert(first.status === 409 && first.json.code === "CONFIRM_REMOVAL" && first.json.needsConfirmation.some((x) => x.accountId === ctx.view.id), `${first.status} ${first.text}`);
    const before = money();
    const ok = await setUser(SA, ctx.mgr.id, changes, { confirmRemoval: true, note: "test" });
    assert(ok.status === 200 && ok.json.changed === 4, `${ok.status} ${ok.text}`);
    assert(money() === before, "money changed by a permission change");
    const audits = q("SELECT details FROM cmp0001_audit_log WHERE action = 'Account access changed'").map((r) => r.details);
    assert(audits.length === 4 && audits.some((d) => d.includes(ctx.view.accountNumber) && d.includes("Full Access -> View Only") && d.includes("xasan.cali") && d.includes("test")), audits.join(" | "));
    const g = (await api(`/api/users/${ctx.mgr.id}/account-access`, { token: SA })).json;
    const lv = (id) => g.accounts.find((a) => a.id === id);
    assert(lv(ctx.view.id).level === "view" && lv(ctx.none.id).level === "none" && lv(ctx.full.id).level === "full" && lv(ctx.view.id).usedByUser, "levels not shown");
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_user_account_access WHERE user_id = ?", [ctx.mgr.id])[0].n === 4, "rows");
  });
  await check("bad input is refused: unknown level, duplicates, unknown account, own access, Super Admin target", async () => {
    assert((await setUser(SA, ctx.mgr.id, [{ accountId: ctx.view.id, level: "owner" }])).status === 400, "level");
    assert((await setUser(SA, ctx.mgr.id, [{ accountId: ctx.view.id, level: "view" }, { accountId: ctx.view.id, level: "none" }])).status === 400, "dup");
    assert((await setUser(SA, ctx.mgr.id, [{ accountId: "cl_nope", level: "view" }])).status === 404, "unknown");
    assert((await setUser(SA, ctx.mgr.id, [])).status === 400, "empty");
  });

  console.log("\nWhat the user can do");
  const M = ctx.M;
  await check("View Only: sees the account, balance and history; Credit, Debit and edits are refused", async () => {
    const a = await api(`/api/accounts/${ctx.view.id}`, { token: M });
    assert(a.status === 200 && a.json.access.level === "view" && a.json.access.canCredit === false, `${a.status} ${JSON.stringify(a.json && a.json.access)}`);
    const d = await api(`/api/accounts/${ctx.view.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } });
    assert(d.status === 403 && /do not have permission to create transactions for this account/.test(d.json.error), `${d.status} ${d.text}`);
    assert((await api(`/api/accounts/${ctx.view.id}/withdraw`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } })).status === 403, "debit");
    assert((await api(`/api/accounts/${ctx.view.id}`, { method: "PATCH", token: M, body: { notes: "x" } })).status === 403, "edit");
    const entry = q("SELECT id FROM cmp0001_account_ledger WHERE client_id = ? ORDER BY created_at DESC LIMIT 1", [ctx.view.id])[0];
    assert((await api(`/api/account-ledger/${entry.id}`, { method: "DELETE", token: M, body: { reason: "x" } })).status === 403, "delete entry");
    const h = (await api(`/api/history?accountId=${ctx.view.id}`, { token: M })).json.entries;
    assert(h.length >= 2, "history hidden");
  });
  await check("View + Credit Only: credits allowed, debits refused", async () => {
    assert((await api(`/api/accounts/${ctx.credit.id}/deposit`, { method: "POST", token: M, body: { amount: 2, currency: "USD" } })).status < 300, "credit");
    const w = await api(`/api/accounts/${ctx.credit.id}/withdraw`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } });
    assert(w.status === 403 && /debits/.test(w.json.error), `${w.status} ${w.text}`);
  });
  await check("View + Debit Only: debits allowed, credits refused", async () => {
    assert((await api(`/api/accounts/${ctx.debit.id}/withdraw`, { method: "POST", token: M, body: { amount: 2, currency: "USD" } })).status < 300, "debit");
    const d = await api(`/api/accounts/${ctx.debit.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } });
    assert(d.status === 403 && /credits/.test(d.json.error), `${d.status} ${d.text}`);
  });
  await check("No Access: not listed, not searchable, 404 on every direct request, absent from history", async () => {
    const list = (await api("/api/accounts", { token: M })).json.accounts;
    assert(!list.some((a) => a.id === ctx.none.id), "hidden account listed");
    assert(list.some((a) => a.id === ctx.view.id), `view-only account not listed (${list.length} listed)`);
    assert(!(await api(`/api/accounts?search=${encodeURIComponent("Access Hidden")}`, { token: M })).json.accounts.length, "search");
    for (const p of [`/api/accounts/${ctx.none.id}`, `/api/accounts/${ctx.none.id}/statement.pdf`, `/api/accounts/${ctx.none.id}/statement.xlsx`]) {
      const r = await api(p, { token: M });
      assert(r.status === 404, `${p} -> ${r.status}`);
    }
    assert((await api(`/api/accounts/${ctx.none.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "SLSH" } })).status === 404, "deposit");
    const entry = q("SELECT id FROM cmp0001_account_ledger WHERE client_id = ? LIMIT 1", [ctx.none.id])[0];
    assert((await api(`/api/account-ledger/${entry.id}/receipt.pdf`, { token: M })).status === 404, "ledger entry");
    const h = (await api("/api/history?currency=SLSH", { token: M })).json.entries;
    assert(!h.some((e) => e.accountId === ctx.none.id || e.counterpartAccountId === ctx.none.id), "history");
  });
  await check("reports, dashboards and exports leave out the No Access account", async () => {
    const csv = await api("/api/accounts/export.csv", { token: M });
    assert(csv.status === 200 && !csv.text.includes(ctx.none.accountNumber) && csv.text.includes(ctx.view.accountNumber), `export.csv ${csv.status}`);
    for (const p of ["/api/dashboard", "/api/reports/accounts-summary", "/api/account-ledger?currency=SLSH", "/api/history/export.csv?currency=SLSH", "/api/customers"]) {
      const r = await api(p, { token: M });
      assert(r.status === 200 || r.status === 403, `${p} -> ${r.status}`);
      assert(!r.text.includes(ctx.none.accountNumber) && !r.text.includes(ctx.none.id) && !/ACCESS HIDDEN/i.test(r.text), `${p} shows the hidden account`);
    }
  });
  await check("transfers and exchanges check every account involved", async () => {
    const t1 = await api("/api/transfers", { method: "POST", token: M, body: { fromAccountId: ctx.credit.id, toAccountId: ctx.full.id, amount: 1, currency: "USD" } });
    assert(t1.status === 403, `debit from a credit-only account ${t1.status}`);
    const t2 = await api("/api/transfers", { method: "POST", token: M, body: { fromAccountId: ctx.full.id, toAccountId: ctx.debit.id, amount: 1, currency: "USD" } });
    assert(t2.status === 403, `credit to a debit-only account ${t2.status}`);
    const t3 = await api("/api/transfers", { method: "POST", token: M, body: { fromAccountId: ctx.debit.id, toAccountId: ctx.credit.id, amount: 1, currency: "USD" } });
    assert(t3.status < 300, `debit-only -> credit-only ${t3.status} ${t3.text}`);
    const x1 = await api("/api/transactions", { method: "POST", token: M, body: { clientName: "x", clientAccountId: ctx.view.id, receivingAccountId: ctx.slshFull.id, amountGiven: 1, currencyGiven: "USD" } });
    assert(x1.status === 403, `exchange from a view-only account ${x1.status}`);
    const x2 = await api("/api/transactions", { method: "POST", token: M, body: { clientName: "x", clientAccountId: ctx.full.id, receivingAccountId: ctx.none.id, amountGiven: 1, currencyGiven: "USD" } });
    assert(x2.status === 404, `exchange into a hidden account ${x2.status} ${x2.text}`);
    const x3 = await api("/api/transactions", { method: "POST", token: M, body: { clientName: "x", clientAccountId: ctx.full.id, receivingAccountId: ctx.slshFull.id, amountGiven: 1, currencyGiven: "USD" } });
    assert(x3.status === 201, `allowed exchange ${x3.status} ${x3.text}`);
    const tr = q("SELECT id FROM cmp0001_transfers ORDER BY created_at DESC LIMIT 1")[0];
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.full.id, level: "view" }], { confirmRemoval: true });
    assert((await api(`/api/transactions/${x3.json.transaction.id}`, { method: "DELETE", token: M, body: { reason: "x" } })).status === 403, "deleting an exchange on a now view-only account");
    assert([403, 404].includes((await api(`/api/transfers/${tr.id}`, { method: "DELETE", token: M, body: { reason: "x" } })).status), "deleting a transfer");
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.full.id, level: "full" }]);
  });
  await check("role permissions still apply: account access never adds anything", async () => {
    const C = await login("cabdi.maxamed", PW);
    const before = await api(`/api/accounts/${ctx.full.id}/withdraw`, { method: "POST", token: C, body: { amount: 1, currency: "USD" } });
    await setUser(SA, ctx.cashier.id, [{ accountId: ctx.full.id, level: "debit" }]);
    const after = await api(`/api/accounts/${ctx.full.id}/withdraw`, { method: "POST", token: C, body: { amount: 1, currency: "USD" } });
    assert(before.status === after.status || after.status === 403, `role refused ${before.status} but account level let it through (${after.status})`);
    const V = await login("sahra.ismail", PW);
    assert((await api(`/api/accounts/${ctx.full.id}/deposit`, { method: "POST", token: V, body: { amount: 1, currency: "USD" } })).status === 403, "viewer role deposited");
  });
  await check("changes take effect at once for the signed-in user", async () => {
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.view.id, level: "full" }]);
    assert((await api(`/api/accounts/${ctx.view.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } })).status < 300, "still refused after Full Access");
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.view.id, level: "none" }], { confirmRemoval: true });
    assert((await api(`/api/accounts/${ctx.view.id}`, { token: M })).status === 404, "still visible after No Access");
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.view.id, level: "view" }]);
  });

  console.log("\nRoles");
  await check("a role's account access applies to everyone with the role; the most restrictive level wins", async () => {
    const r = await setRole(SA, "role_manager", [{ accountId: ctx.roleView.id, level: "view" }, { accountId: ctx.credit.id, level: "debit" }], { confirmRemoval: true });
    assert(r.status === 200 && r.json.changed === 2, `${r.status} ${r.text}`);
    const d = await api(`/api/accounts/${ctx.roleView.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } });
    assert(d.status === 403, `role View Only ignored ${d.status}`);
    // user "credit" + role "debit" = View Only.
    const a = (await api(`/api/accounts/${ctx.credit.id}`, { token: M })).json.access;
    assert(a.level === "view", `credit+debit should be view, got ${a.level}`);
    assert((await api(`/api/accounts/${ctx.credit.id}/deposit`, { method: "POST", token: M, body: { amount: 1, currency: "USD" } })).status === 403, "credit allowed");
    const g = (await api(`/api/users/${ctx.mgr.id}/account-access`, { token: SA })).json.accounts.find((x) => x.id === ctx.credit.id);
    assert(g.roleLevel === "debit" && g.level === "credit" && g.effectiveLevel === "view", JSON.stringify(g));
    const rv = (await api("/api/roles/role_manager/account-access", { token: SA })).json;
    assert(rv.accounts.find((x) => x.id === ctx.roleView.id).level === "view" && rv.role.users >= 1, "role GET");
    assert(q("SELECT details FROM cmp0001_audit_log WHERE action = 'Role account access changed'").some((x) => x.details.includes("Manager") && x.details.includes(ctx.roleView.accountNumber)), "role change not audited");
    await setRole(SA, "role_manager", [{ accountId: ctx.credit.id, level: "full" }]);
  });
  await check("the Super Admin role and Super Admin users are never restricted", async () => {
    assert((await setRole(SA, "role_super_admin", [{ accountId: ctx.view.id, level: "none" }])).status === 403, "SA role");
    const saUser = (await api("/api/users", { token: SA })).json.users.find((u) => u.isSuperAdmin);
    if (saUser) assert((await setUser(SA, saUser.id, [{ accountId: ctx.view.id, level: "none" }])).status === 403, "SA user");
  });

  console.log("\nAdministrator scope");
  await check("an ordinary user can't change anyone's account access (users or roles)", async () => {
    assert((await setUser(M, ctx.cashier.id, [{ accountId: ctx.full.id, level: "none" }])).status === 403, "user");
    assert((await setRole(M, "role_cashier", [{ accountId: ctx.full.id, level: "none" }])).status === 403, "role");
    assert((await api(`/api/users/${ctx.mgr.id}/account-access`, { token: M })).status === 403, "read");
  });
  await check("an Admin manages only within their own scope: never their own access or role, never beyond their own level", async () => {
    const o = await api(`/api/users/${ctx.admin.id}/permissions`, { method: "PATCH", token: SA, body: { overrides: [{ permissionKey: "users.managePermissions", granted: true }, { permissionKey: "roles.managePermissions", granted: true }], confirmCritical: true } });
    assert(o.status === 200, `grant ${o.status} ${o.text}`);
    await setUser(SA, ctx.admin.id, [{ accountId: ctx.ceiling.id, level: "view" }, { accountId: ctx.adminHidden.id, level: "none" }]);
    const A = await login("amina.yusuf", PW);
    assert((await setUser(A, ctx.admin.id, [{ accountId: ctx.full.id, level: "view" }])).status === 403, "own access");
    assert((await setRole(A, "role_admin", [{ accountId: ctx.full.id, level: "view" }])).status === 403, "own (protected) role");
    const beyond = await setUser(A, ctx.cashier.id, [{ accountId: ctx.ceiling.id, level: "full" }]);
    assert(beyond.status === 403 && /your own access/.test(beyond.json.error), `beyond ${beyond.status} ${beyond.text}`);
    assert((await setUser(A, ctx.cashier.id, [{ accountId: ctx.ceiling.id, level: "view" }])).status === 200, "within");
    assert((await setUser(A, ctx.cashier.id, [{ accountId: ctx.adminHidden.id, level: "view" }])).status === 404, "account the admin can't see");
    const list = (await api(`/api/users/${ctx.cashier.id}/account-access`, { token: A })).json.accounts;
    assert(!list.some((a) => a.id === ctx.adminHidden.id), "admin sees an account hidden from them");
    assert((await setRole(A, "role_cashier", [{ accountId: ctx.full.id, level: "view" }])).status === 403, "admin changed a protected built-in role");
    const custom = await api("/api/roles", { method: "POST", token: SA, body: { name: "Access Custom Role", description: "test", permissions: ["accounts.view", "currency.usd"] } });
    assert(custom.status === 201, `custom role ${custom.status} ${custom.text}`);
    const rid = custom.json.role.id;
    assert((await setRole(A, rid, [{ accountId: ctx.full.id, level: "view" }])).status === 200, "admin sets a custom role");
    assert((await setRole(A, rid, [{ accountId: ctx.ceiling.id, level: "credit" }])).status === 403, "admin granted a role more than their own level");
  });

  console.log("\nCompany isolation and records");
  await check("another company can't read or change this company's account access", async () => {
    const sa2 = await login("super.admin", SA_PW);
    await api("/api/platform/companies", { method: "POST", token: sa2, body: { name: "Access Beta", admin: { name: "Ab Admin", username: "ab.admin", password: "BetaPass-2026x" } } });
    const B = await login("ab.admin", "BetaPass-2026x");
    for (const [m, p] of [["GET", `/api/users/${ctx.mgr.id}/account-access`], ["PATCH", `/api/users/${ctx.mgr.id}/account-access`], ["GET", "/api/roles/role_manager/account-access"]]) {
      const r = await api(p, { method: m, token: B, body: m === "PATCH" ? { changes: [{ accountId: ctx.full.id, level: "none" }] } : undefined });
      assert(r.status === 404 || r.status === 403 || (r.status === 200 && !r.text.includes(ctx.full.id) && !r.text.includes("ACCESS")), `${m} ${p} -> ${r.status}`);
    }
    assert(q("SELECT level FROM cmp0001_user_account_access WHERE user_id = ? AND account_id = ?", [ctx.mgr.id, ctx.full.id]).length === 0, "B changed A's access");
  });
  await check("permission changes never touched balances, ledgers or transactions", async () => {
    const before = money();
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.full.id, level: "none" }, { accountId: ctx.debit.id, level: "full" }], { confirmRemoval: true });
    await setRole(SA, "role_manager", [{ accountId: ctx.full.id, level: "view" }], { confirmRemoval: true });
    await setRole(SA, "role_manager", [{ accountId: ctx.full.id, level: "full" }]);
    await setUser(SA, ctx.mgr.id, [{ accountId: ctx.full.id, level: "full" }]);
    assert(money() === before, "money changed");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped)"); return; }
  console.log("\nScreens");
  const browser = await chromium.launch();
  const errors = [];
  const open = async (user, pw) => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill(user); await p.fill('input[type="password"]', pw); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    return p;
  };
  const nav = async (p, label) => {
    const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
    const group = p.locator(".gk-nav-group").filter({ has: btn });
    if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(300); } }
    await btn.click(); await p.waitForTimeout(1000);
  };
  try {
    await check("a View Only account page shows the restriction and offers no Credit or Transfer", async () => {
      const p = await open("xasan.cali", PW);
      await nav(p, "USD Accounts");
      const tab = p.getByRole("tab", { name: /Company Accounts/ });
      if (await tab.count()) { await tab.first().click(); await p.waitForTimeout(900); }
      const search = p.getByRole("searchbox").first();
      if (await search.count()) { await search.fill("Access View"); await p.waitForTimeout(1200); }
      if (process.env.AA_SHOT3) await p.screenshot({ path: process.env.AA_SHOT3 });
      const row = p.locator("tr", { hasText: /Access View Usd/i }).first();
      assert(await row.getByRole("button", { name: /^Edit/ }).count() === 0, "Edit offered on a View Only account");
      assert(/View Only/.test(await row.innerText()), "no View Only badge in the list");
      await row.getByRole("button", { name: /^View/ }).first().click({ timeout: 8000 }); await p.waitForTimeout(1500);
      const badge = p.getByTestId("account-access-level");
      assert(await badge.count() === 1, "no access badge");
      assert(/View Only/.test(await badge.innerText()), await badge.innerText());
      assert(await p.locator(".gk-av-actions").getByRole("button", { name: "Credit", exact: true }).count() === 0, "Credit button shown");
      assert(await p.locator(".gk-av-actions").getByRole("button", { name: "Transfer", exact: true }).count() === 0, "Transfer button shown");
      await p.context().close();
    });
    await check("Users › Account Access: an administrator sets a level and saves", async () => {
      const a = await open("amina.yusuf", PW);
      await nav(a, "Users");
      const row = a.locator("tr", { hasText: "cabdi.maxamed" }).first();
      await row.getByRole("button", { name: "Account Access" }).click(); await a.waitForTimeout(1200);
      const dialog = a.getByRole("dialog");
      assert(/Account Access/.test(await dialog.innerText()), "modal");
      await dialog.getByLabel("Search accounts").fill("Access Full"); await a.waitForTimeout(300);
      await dialog.getByLabel(`Access for ${ctx.full.accountNumber}`).selectOption("view");
      if (process.env.AA_SHOT0) await a.screenshot({ path: process.env.AA_SHOT0 });
      await dialog.getByRole("button", { name: /^Save/ }).click({ timeout: 5000 }); await a.waitForTimeout(1200);
      const lvl = q("SELECT level FROM cmp0001_user_account_access WHERE user_id = ? AND account_id = ?", [ctx.cashier.id, ctx.full.id])[0];
      assert(lvl && lvl.level === "view", JSON.stringify(lvl));
      if (process.env.AA_SHOT) await a.screenshot({ path: process.env.AA_SHOT });
      await dialog.getByRole("button", { name: /Close|Cancel/ }).first().click();
      await nav(a, "Roles");
      await a.locator("tr", { hasText: "Cashier" }).first().getByRole("button", { name: "Account Access" }).click(); await a.waitForTimeout(1200);
      assert(/everyone with this role/.test(await a.getByRole("dialog").innerText()), "role modal");
      if (process.env.AA_SHOT2) await a.screenshot({ path: process.env.AA_SHOT2 });
      await a.context().close();
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
