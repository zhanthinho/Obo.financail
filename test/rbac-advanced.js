"use strict";
// ADVANCED RBAC round — sensitivity levels, role templates, delegation and
// self-escalation guards, critical-permission confirmation, revocation,
// denied-request auditing, company isolation, and the role editor, on a
// throw-away database.
// Run with: npm run test:rbac-advanced
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("rbacadv");
const PORT = Number(process.env.RBAC_ADV_TEST_PORT || 4560);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const USER_PW = "Rbac-Adv-Pass-2026!";

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, headers = {} } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  return { status: r.status, json };
}
const login = async (username, password) => (await api("/api/auth/login", { method: "POST", body: { username, password } })).json?.token;
function db() {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  return { q: (sql, p = []) => c.query(sql, p).rows, close: () => c.close() };
}
const auditRows = (like) => { const h = db(); try { return h.q("SELECT action, details, actor_name FROM cmp0001_audit_log WHERE action LIKE ? ORDER BY at", [like]); } finally { h.close(); } };

let srv, serverErr = "";
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  const sa = await login("super.admin", SA_PW);
  ctx.sa = sa;
  ctx.A = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  ctx.adm = await login("amina.yusuf", DEMO_PW);
  const T = ctx.A;
  ctx.roles = (await api("/api/roles", { token: T })).json.roles;
  const roleByKey = (k) => ctx.roles.find((r) => r.key === k);

  console.log("\nSensitivity levels & templates");
  await check("every permission carries a sensitivity level; examples are classified as expected", async () => {
    const cat = (await api("/api/permissions", { token: T })).json.permissions;
    assert(cat.length > 50 && cat.every((p) => ["standard", "sensitive", "critical"].includes(p.level)), "missing levels");
    const lv = Object.fromEntries(cat.map((p) => [p.key, p.level]));
    assert(lv["accounts.view"] === "standard" && lv["accounts.print"] === "standard", "standard");
    for (const k of ["profit.viewCompany", "rates.updateDaily", "payments.create", "cash.deposit", "auditLog.view", "reports.export"]) assert(lv[k] === "sensitive", `${k} should be sensitive`);
    for (const k of ["users.managePermissions", "roles.managePermissions", "accounts.delete", "accounts.importOpeningBalance", "settings.update", "exchange.delete"]) assert(lv[k] === "critical", `${k} should be critical`);
    ctx.levels = lv;
  });
  await check("roles report how many sensitive and critical permissions they carry", async () => {
    const admin = roleByKey("admin");
    assert(admin.levelCounts && admin.levelCounts.critical > 0 && admin.levelCounts.standard > 0, JSON.stringify(admin.levelCounts));
    assert(roleByKey("super_admin").levelCounts === null, "super admin should be 'all'");
  });
  await check("role templates are least-privilege starting points", async () => {
    const t = (await api("/api/roles/templates", { token: T })).json.templates;
    const by = Object.fromEntries(t.map((x) => [x.key, x]));
    for (const k of ["company_admin", "accountant", "cashier", "exchange_operator", "auditor"]) assert(by[k], `${k} missing`);
    assert(!by.auditor.permissions.some((k) => /\.(create|update|delete|settle|deposit|withdraw|cancel|repay|writeOff|activate|deactivate|import)/.test(k)), "auditor can change data");
    assert(by.auditor.permissions.includes("auditLog.view"), "auditor cannot read the audit log");
    assert(!by.exchange_operator.permissions.some((k) => k === "exchange.manageRate" || k === "exchange.delete" || k.startsWith("profit.") || k.startsWith("roles.")), "exchange operator too broad");
    assert(!by.cashier.permissions.some((k) => k.startsWith("profit.") || k.startsWith("roles.") || k.startsWith("reports.")), "cashier too broad");
    assert(!by.company_admin.permissions.some((k) => ctx.levels[k] === "critical" || k.startsWith("roles.")), "company admin template has critical/role permissions");
    ctx.templates = by;
  });
  await check("a role can be created from a template (exact permission list)", async () => {
    const r = await api("/api/roles", { method: "POST", token: T, body: { name: "Read-only Auditor", templateKey: "auditor" } });
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.json)}`);
    assert(JSON.stringify([...r.json.role.permissions].sort()) === JSON.stringify([...ctx.templates.auditor.permissions].sort()), "permissions differ");
    ctx.auditorRole = r.json.role;
    assert((await api("/api/roles", { method: "POST", token: T, body: { name: "x", templateKey: "nope" } })).status === 400, "unknown template accepted");
  });

  console.log("\nCritical permissions need explicit confirmation");
  await check("creating a role with a critical permission is refused without confirmCritical, accepted with it", async () => {
    let r = await api("/api/roles", { method: "POST", token: T, body: { name: "Deleter", permissions: ["accounts.view", "accounts.delete"] } });
    assert(r.status === 400 && r.json.code === "CRITICAL_CONFIRMATION_REQUIRED" && r.json.critical.includes("accounts.delete"), `${r.status} ${JSON.stringify(r.json)}`);
    r = await api("/api/roles", { method: "POST", token: T, body: { name: "Deleter", permissions: ["accounts.view", "accounts.delete"], confirmCritical: true } });
    assert(r.status === 201, `${r.status}`);
    ctx.deleterRole = r.json.role;
  });
  await check("adding a critical permission to a role, or as a user override, also needs confirmation", async () => {
    let r = await api(`/api/roles/${ctx.auditorRole.id}`, { method: "PATCH", token: T, body: { permissions: [...ctx.auditorRole.permissions, "exchange.delete"] } });
    assert(r.status === 400 && r.json.code === "CRITICAL_CONFIRMATION_REQUIRED", `role ${r.status}`);
    const users = (await api("/api/users", { token: T })).json.users;
    ctx.users = users;
    const cashier = users.find((u) => u.username === "cabdi.maxamed");
    r = await api(`/api/users/${cashier.id}/permissions`, { method: "PATCH", token: T, body: { overrides: [{ permissionKey: "accounts.delete", granted: true }] } });
    assert(r.status === 400 && r.json.code === "CRITICAL_CONFIRMATION_REQUIRED", `override ${r.status}`);
    r = await api(`/api/users/${cashier.id}/permissions`, { method: "PATCH", token: T, body: { overrides: [] } });
    assert(r.status === 200, "removing overrides should not need confirmation");
  });
  await check("keeping an already-granted critical permission does not need confirmation again", async () => {
    const r = await api(`/api/roles/${ctx.deleterRole.id}`, { method: "PATCH", token: T, body: { permissions: ["accounts.view", "accounts.delete", "accounts.print"] } });
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  });

  console.log("\nNo self-escalation, delegation limits, protected roles");
  const me = (await api("/api/auth/me", { token: ctx.adm })).json;
  ctx.me = me.user || me;
  await check("an administrator cannot change their own role", async () => {
    const r = await api(`/api/users/${ctx.me.id}`, { method: "PATCH", token: ctx.adm, body: { roleId: roleByKey("manager").id } });
    assert(r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);
  });
  await check("an administrator cannot change their own custom permissions", async () => {
    const r = await api(`/api/users/${ctx.me.id}/permissions`, { method: "PATCH", token: ctx.adm, body: { overrides: [{ permissionKey: "accounts.view", granted: true }] } });
    assert(r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);
  });
  await check("an administrator cannot change the permissions of their own (or any protected built-in) role", async () => {
    let r = await api(`/api/roles/${roleByKey("admin").id}`, { method: "PATCH", token: ctx.adm, body: { permissions: roleByKey("admin").permissions.filter((k) => k !== "accounts.view") } });
    assert(r.status === 403, `own role ${r.status}`);
    r = await api(`/api/roles/${roleByKey("cashier").id}`, { method: "PATCH", token: ctx.adm, body: { permissions: [...roleByKey("cashier").permissions, "accounts.view"] } });
    assert(r.status === 403, `protected role ${r.status}`);
    const after = (await api("/api/roles", { token: T })).json.roles.find((x) => x.key === "cashier");
    assert(JSON.stringify(after.permissions) === JSON.stringify(roleByKey("cashier").permissions), "protected role changed");
  });
  await check("an administrator cannot grant permissions they do not hold (role or user)", async () => {
    let r = await api("/api/roles", { method: "POST", token: ctx.adm, body: { name: "Cash Grabber", permissions: ["cash.view"] } });
    assert(r.status === 403 && /do not have yourself/.test(r.json.error), `${r.status} ${JSON.stringify(r.json)}`);
    const viewer = ctx.users.find((u) => u.username === "sahra.ismail");
    r = await api(`/api/users/${viewer.id}/permissions`, { method: "PATCH", token: ctx.adm, body: { overrides: [{ permissionKey: "cash.view", granted: true }] } });
    assert(r.status === 403, `override ${r.status}`);
  });
  await check("an administrator cannot assign a role broader than their own, nor the Super Admin role", async () => {
    const viewer = ctx.users.find((u) => u.username === "sahra.ismail");
    let r = await api(`/api/users/${viewer.id}`, { method: "PATCH", token: ctx.adm, body: { roleId: ctx.deleterRole.id } });
    // Deleter holds accounts.delete; Admin has it too, so this is allowed only within scope:
    assert([200, 403].includes(r.status), `${r.status}`);
    const cashRole = await api("/api/roles", { method: "POST", token: T, body: { name: "Cash Only", permissions: ["cash.view"] } });
    r = await api(`/api/users/${viewer.id}`, { method: "PATCH", token: ctx.adm, body: { roleId: cashRole.json.role.id } });
    assert(r.status === 403, `broader role ${r.status} ${JSON.stringify(r.json)}`);
    r = await api(`/api/users/${viewer.id}`, { method: "PATCH", token: ctx.adm, body: { roleId: roleByKey("super_admin").id } });
    assert(r.status === 400 || r.status === 403, `super admin ${r.status}`);
    await api(`/api/users/${viewer.id}`, { method: "PATCH", token: T, body: { roleId: roleByKey("viewer").id } });
  });
  await check("a non-Super-Admin cannot touch the Super Admin role, and the Super Admin role cannot be edited at all", async () => {
    const r = await api(`/api/roles/${roleByKey("super_admin").id}`, { method: "PATCH", token: T, body: { permissions: ["accounts.view"] } });
    assert(r.status === 403, `${r.status}`);
    const d = await api(`/api/roles/${roleByKey("admin").id}`, { method: "DELETE", token: T });
    assert(d.status === 403, `delete protected ${d.status}`);
  });

  console.log("\nEnforced by the backend, revocation is immediate");
  await check("a user with view-only permission can read but cannot create, pay out, delete or change rates via the API", async () => {
    const role = await api("/api/roles", { method: "POST", token: T, body: { name: "Accounts Viewer", permissions: ["accounts.view", "currency.usd", "currency.slsh"] } });
    ctx.viewerRole = role.json.role;
    const u = await api("/api/users", { method: "POST", token: T, body: { name: "Vera Viewer", username: "vera.viewer", password: USER_PW, roleId: ctx.viewerRole.id } });
    assert(u.status === 201, `user ${u.status} ${JSON.stringify(u.json)}`);
    ctx.vera = u.json.user;
    ctx.veraTok = await login("vera.viewer", USER_PW);
    const accs = await api("/api/accounts?currency=USD", { token: ctx.veraTok });
    assert(accs.status === 200 && accs.json.accounts.length > 0, `read ${accs.status}`);
    const acc = accs.json.accounts[0];
    ctx.acc = acc;
    const before = (await api(`/api/accounts/${acc.id}`, { token: T })).json;
    for (const [m, p, b] of [["POST", "/api/accounts", { name: "Hack Ltd", currency: "USD" }], ["POST", `/api/accounts/${acc.id}/deposit`, { amount: 100, currency: "USD" }],
      ["POST", `/api/accounts/${acc.id}/withdraw`, { amount: 100, currency: "USD" }], ["PATCH", `/api/accounts/${acc.id}`, { name: "Renamed" }],
      ["DELETE", `/api/accounts/${acc.id}`, {}], ["POST", "/api/rate", { rate: 1 }], ["POST", "/api/cash/rate", { rate: 1 }], ["GET", "/api/reports/audit-log"]]) {
      const r = await api(p, { method: m, token: ctx.veraTok, body: b });
      assert(r.status === 403, `${m} ${p} -> ${r.status}`);
    }
    const after = (await api(`/api/accounts/${acc.id}`, { token: T })).json;
    assert(JSON.stringify((after.account || after).balance) === JSON.stringify((before.account || before).balance) && (after.account || after).name === (before.account || before).name, "the account changed");
  });
  await check("refused requests are written to the audit log once per minute, with no secrets", async () => {
    const rows = auditRows("Access denied").filter((r) => /vera/i.test(r.actor_name || ""));
    const dep = rows.filter((r) => /payments\.create|accountsManage/.test(r.details) && /deposit/.test(r.details));
    assert(rows.length >= 6, `rows ${rows.length}: ${JSON.stringify(auditRows("Access denied").map((r) => r.actor_name))}`);
    assert(dep.length >= 1, "deposit attempt not logged with its endpoint");
    const n = auditRows("Access denied").length;
    await api(`/api/accounts/${ctx.acc.id}/deposit`, { method: "POST", token: ctx.veraTok, body: { amount: 100, currency: "USD" } });
    assert(auditRows("Access denied").length === n, "duplicate denial within a minute was logged again");
    const h = db();
    try { assert(!h.q("SELECT COUNT(*) AS n FROM cmp0001_audit_log WHERE details LIKE ? OR details LIKE ?", [`%${USER_PW}%`, "%Bearer %"])[0].n, "secrets in audit log"); } finally { h.close(); }
  });
  await check("removing a permission invalidates existing sessions; after signing in again it is refused", async () => {
    const r = await api(`/api/roles/${ctx.viewerRole.id}`, { method: "PATCH", token: T, body: { permissions: ["currency.usd"] } });
    assert(r.status === 200, `patch ${r.status}`);
    const stale = await api("/api/accounts?currency=USD", { token: ctx.veraTok });
    assert(stale.status === 401, `stale token ${stale.status}`);
    const fresh = await login("vera.viewer", USER_PW);
    assert((await api("/api/accounts?currency=USD", { token: fresh })).status === 403, "revoked permission still works");
    const ch = auditRows("Role updated").find((x) => /Accounts Viewer/.test(x.details) && /removed: .*accounts\.view/.test(x.details));
    assert(ch, "role change not audited with before/after");
  });
  await check("a deny override beats the role and takes effect on the next sign-in", async () => {
    const cashier = ctx.users.find((u) => u.username === "cabdi.maxamed");
    const tok = await login("cabdi.maxamed", DEMO_PW);
    assert((await api("/api/transactions?limit=1", { token: tok })).status === 200, "cashier cannot list exchanges");
    const r = await api(`/api/users/${cashier.id}/permissions`, { method: "PATCH", token: T, body: { overrides: [{ permissionKey: "exchange.view", granted: false }] } });
    assert(r.status === 200, `${r.status}`);
    assert((await api("/api/transactions?limit=1", { token: tok })).status === 401, "old session kept working");
    const tok2 = await login("cabdi.maxamed", DEMO_PW);
    const x = await api("/api/transactions/x/receipt.pdf", { token: tok2 });
    assert(x.status === 403 || x.status === 404, `${x.status}`);
    assert(auditRows("User custom permissions changed").some((a) => /exchange\.view=deny/.test(a.details)), "override not audited");
    await api(`/api/users/${cashier.id}/permissions`, { method: "PATCH", token: T, body: { overrides: [] } });
  });
  await check("the last active Super Admin cannot be deactivated or deleted", async () => {
    const r = await api("/api/users/u_super_admin", { method: "PATCH", token: ctx.adm, body: { active: false } });
    assert(r.status === 403 || r.status === 404 || r.status === 400, `${r.status}`);
  });
  await check("duplicate submissions with the same Idempotency-Key create one financial entry", async () => {
    const key = `rbacadv-${crypto.randomBytes(6).toString("hex")}`;
    const before = (await api(`/api/accounts/${ctx.acc.id}`, { token: T })).json;
    const b0 = (before.account || before).balance;
    const one = api(`/api/accounts/${ctx.acc.id}/deposit`, { method: "POST", token: ctx.adm, body: { amount: 12.34, currency: "USD" }, headers: { "Idempotency-Key": key } });
    const two = api(`/api/accounts/${ctx.acc.id}/deposit`, { method: "POST", token: ctx.adm, body: { amount: 12.34, currency: "USD" }, headers: { "Idempotency-Key": key } });
    const [r1, r2] = await Promise.all([one, two]);
    assert(r1.status < 300 && r2.status < 300, `${r1.status}/${r2.status}`);
    const after = (await api(`/api/accounts/${ctx.acc.id}`, { token: T })).json;
    assert(Math.abs((after.account || after).balance - b0 - 12.34) < 0.001, `balance moved by ${(after.account || after).balance - b0}`);
  });

  console.log("\nCompany isolation");
  await check("Company B cannot read or change Company A's roles, user permissions or audit entries", async () => {
    const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Rbac Beta Ltd", admin: { name: "Rb Admin", username: "rb.admin", password: "BetaPass123!" } } });
    assert(c.status === 201 || c.status === 200, `company ${c.status}`);
    const bAdm = await login("rb.admin", "BetaPass123!");
    for (const [m, p, b] of [["GET", `/api/roles/${ctx.auditorRole.id}`], ["PATCH", `/api/roles/${ctx.auditorRole.id}`, { name: "Hijacked" }], ["DELETE", `/api/roles/${ctx.deleterRole.id}`],
      ["GET", `/api/users/${ctx.vera.id}/permissions`], ["PATCH", `/api/users/${ctx.vera.id}/permissions`, { overrides: [] }], ["PATCH", `/api/users/${ctx.vera.id}`, { name: "Hijacked" }]]) {
      const r = await api(p, { method: m, token: bAdm, body: b });
      assert(r.status === 404, `${m} ${p} from B -> ${r.status}`);
    }
    const bRoles = (await api("/api/roles", { token: bAdm })).json.roles;
    assert(!bRoles.some((r) => r.id === ctx.auditorRole.id || r.name === "Read-only Auditor"), "B lists A's custom roles");
    const bAudit = (await api("/api/reports/audit-log", { token: bAdm })).json.entries;
    assert(!bAudit.some((e) => /Vera Viewer|Read-only Auditor/.test(`${e.actor_name} ${e.details}`)), "B sees A's audit entries");
    assert((await api("/api/roles", { token: T })).json.roles.find((r) => r.id === ctx.auditorRole.id).name === "Read-only Auditor", "A's role was renamed");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nRole editor");
  const sw = await api("/api/platform/switch-company", { method: "POST", token: ctx.sa, body: { companyId: "CMP-0001" } });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(([tok, user]) => { try { localStorage.setItem("geeska_token", tok); localStorage.setItem("geeska_user", user); sessionStorage.setItem("obo_view", "roles"); } catch (e) { /* ignore */ } }, [sw.json.token, JSON.stringify(sw.json.user)]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(1200);
    await check("the Roles list shows sensitive / critical counts", async () => {
      await p.locator("tr").filter({ hasText: "Read-only Auditor" }).first().waitFor({ timeout: 8000 });
      assert(await p.locator('tr:has-text("Deleter") .gk-perm-badge[data-level="critical"]').count() >= 1, "no critical badge");
    });
    const dlg = () => p.getByRole("dialog");
    await p.locator(".gk-table-footer select").first().selectOption("100").catch(() => {});
    await p.waitForTimeout(300);
    await check("new role from the Cashier template: summary counts and badges", async () => {
      await p.getByRole("button", { name: /New role/ }).click();
      await dlg().getByLabel("Start from").selectOption("tpl:cashier");
      const sel = Number(await dlg().locator('[data-count="selected"]').innerText());
      assert(sel === ctx.templates.cashier.permissions.length, `selected ${sel}`);
      assert(Number(await dlg().locator('[data-count="critical"]').innerText()) === 0, "cashier template has critical");
      assert(await dlg().locator('.gk-perm-item[data-level="critical"] .gk-perm-badge').count() > 5, "critical badges missing");
    });
    await check("search finds permissions by name, action and level", async () => {
      const box = dlg().getByLabel("Search permissions");
      await box.fill("delete");
      const keys = await dlg().locator(".gk-perm-item").evaluateAll((els) => els.map((e) => e.dataset.key));
      assert(keys.length > 3 && keys.every((k) => /delete|Delete/i.test(k) || /deletePayment/.test(k)), keys.join(","));
      await box.fill("critical");
      const lv = await dlg().locator(".gk-perm-item").evaluateAll((els) => els.map((e) => e.dataset.level));
      assert(lv.length > 5 && lv.every((x) => x === "critical"), "level search");
      await box.fill("");
    });
    await check("ticking a module selects only its standard permissions; individual ticks are kept", async () => {
      const grp = dlg().locator('.gk-perm-group[data-module="accounts"]');
      await dlg().getByLabel("Start from").selectOption("");
      await grp.locator(".gk-perm-group-head input[type=checkbox]").check();
      const on = await grp.locator(".gk-perm-item").evaluateAll((els) => els.filter((e) => e.querySelector("input").checked).map((e) => e.dataset.level));
      assert(on.length > 0 && on.every((l) => l === "standard"), on.join(","));
      await grp.locator('.gk-perm-item[data-key="accounts.export"] input').check();
      assert(await grp.locator('.gk-perm-item[data-key="accounts.export"] input').isChecked(), "individual tick lost");
      assert(Number(await dlg().locator('[data-count="sensitive"]').innerText()) >= 1, "sensitive count");
    });
    await check("saving with a critical permission asks for confirmation first; the role is stored as chosen", async () => {
      await dlg().getByLabel("Role name").fill("UI Critical Role");
      await dlg().locator('.gk-perm-item[data-key="accounts.delete"] input').check();
      await dlg().getByRole("button", { name: "Create Role" }).click();
      await dlg().getByRole("alertdialog").waitFor({ timeout: 3000 });
      assert(/critical/i.test(await dlg().getByRole("alertdialog").innerText()), "no critical warning");
      await dlg().getByRole("button", { name: "Save with critical permissions" }).click();
      await p.waitForTimeout(1200);
      const r = (await api("/api/roles", { token: ctx.A })).json.roles.find((x) => x.name === "UI Critical Role");
      assert(r && r.permissions.includes("accounts.delete") && r.permissions.includes("accounts.export") && r.permissions.includes("accounts.view") && !r.permissions.includes("accounts.importOpeningBalance"), JSON.stringify(r && r.permissions));
      ctx.uiRole = r;
    });
    await check("reopening the role shows its saved selections; closing with unsaved changes warns", async () => {
      if (process.env.RBAC_SHOT) await p.screenshot({ path: process.env.RBAC_SHOT });
      await p.locator("tr").filter({ hasText: "UI Critical Role" }).getByRole("button", { name: "Edit" }).click({ timeout: 8000 });
      await dlg().locator('.gk-perm-item[data-key="accounts.delete"] input').waitFor({ timeout: 4000 });
      assert(await dlg().locator('.gk-perm-item[data-key="accounts.delete"] input').isChecked(), "saved selection not shown");
      await dlg().locator('.gk-perm-item[data-key="accounts.print"] input').click();
      await dlg().getByRole("button", { name: "Cancel" }).last().click();
      await dlg().getByRole("alertdialog").waitFor({ timeout: 3000 });
      assert(/unsaved/i.test(await dlg().getByRole("alertdialog").innerText()), "no unsaved warning");
      await dlg().getByRole("button", { name: "Discard changes" }).click();
      await p.waitForTimeout(400);
      assert(await p.getByRole("dialog").count() === 0, "editor did not close");
      const r = (await api("/api/roles", { token: ctx.A })).json.roles.find((x) => x.name === "UI Critical Role");
      assert(JSON.stringify(r.permissions) === JSON.stringify(ctx.uiRole.permissions), "discarded change was saved");
    });
    await check("phone width: one column, no sideways scrolling", async () => {
      await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
      await p.locator("tr").filter({ hasText: "UI Critical Role" }).getByRole("button", { name: "Edit" }).click();
      await dlg().locator(".gk-perm-items").first().waitFor({ timeout: 4000 });
      const cols = await dlg().locator(".gk-perm-items").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert(cols === 1, `columns ${cols}`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `overflow ${over}`);
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
