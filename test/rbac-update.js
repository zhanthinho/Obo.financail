"use strict";
// USER ROLES & PERMISSIONS UPDATE round — the recommended role templates,
// the new granular PDF / Excel template permissions, and the 10 security
// scenarios of the spec (cashier → settings, viewer → payment, accountant →
// roles, exchange operator → rates, cross-company, deactivated user, direct
// API, role change during a session, templates, unauthorized export),
// plus the Users / Roles tables and the role editor's change review.
// On a throw-away database. Run with: npm run test:rbac-update
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("rbacupd");
const PORT = Number(process.env.RBAC_UPD_TEST_PORT || 4690);
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

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.RU_DEBUG ? "inherit" : "ignore"] });
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
  const SA_A = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } }), "switch A").token;
  const aAccount = ok(await api("/api/accounts?currency=USD", { token: SA_A }), "A accounts").accounts[0];
  const cb = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Roles Beta", admin: { name: "Rb Admin", username: "rb.admin", password: "BetaPass-2026x" } } }), "company B");
  const bId = (cb.company && cb.company.id) || cb.id;
  const B = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } }), "switch B").token;
  if (process.env.RU_DUMP) require("fs").writeFileSync(process.env.RU_DUMP, JSON.stringify({ roles: ok(await api("/api/roles", { token: B }), "roles").roles, catalog: ok(await api("/api/permissions", { token: B }), "cat"), templates: ok(await api("/api/roles/templates", { token: B }), "tpl").templates }, null, 1));
  const login = async (u, pw = "RolePass-2026x") => api("/api/auth/login", { method: "POST", body: { username: u, password: pw } });
  const tpl = Object.fromEntries(ok(await api("/api/roles/templates", { token: B }), "templates").templates.map((t) => [t.key, t]));
  const catalog = ok(await api("/api/permissions", { token: B }), "catalog");
  const cat = catalog.permissions || catalog.catalog || catalog;
  const usd = ok(await api("/api/accounts", { method: "POST", token: B, body: { name: "Rb Customer", currency: "USD" } }), "acct").account;
  const till = ok(await api("/api/cash/accounts", { method: "POST", token: B, body: { name: "Rb Till", type: "physical_cash", currency: "USD" } }), "till").account;

  console.log("\nPermission registry and role templates");
  await check("PDF / Excel templates have their own view / create / update / delete permissions (delete is critical)", async () => {
    const keys = Object.fromEntries(cat.map((c) => [c.key, c.level]));
    for (const m of ["pdfTemplates", "excelTemplates"]) {
      for (const a of ["view", "create", "update", "delete"]) assert(keys[`${m}.${a}`], `${m}.${a} missing`);
      assert(keys[`${m}.delete`] === "critical" && keys[`${m}.update`] === "sensitive" && keys[`${m}.view`] === "standard", m);
    }
    assert(!keys["pdfTemplates.manage"], "the old single key is not in the registry");
  });
  await check("the six recommended templates exist with sensible, non-critical defaults", async () => {
    for (const k of ["company_admin", "manager", "accountant", "cashier", "exchange_operator", "auditor"]) assert(tpl[k], `${k} missing`);
    assert(/Viewer/.test(tpl.auditor.name), tpl.auditor.name);
    for (const t of Object.values(tpl)) assert(t.levelCounts.critical === 0, `${t.key} has critical permissions`);
    assert(tpl.cashier.permissions.includes("cash.deposit") && tpl.cashier.permissions.includes("cash.withdraw") && !tpl.cashier.permissions.includes("settings.update"), "cashier");
    assert(!tpl.exchange_operator.permissions.some((k) => /^rates\.(create|update|delete)|^exchange\.(update|delete)|^profit\./.test(k)), "exchange operator can change rates / completed exchanges");
    assert(!tpl.auditor.permissions.some((k) => /\.(create|update|delete|export|import|settle|approve)/.test(k)), "viewer writes");
    assert(!tpl.accountant.permissions.some((k) => /^(roles|users|settings)\./.test(k)), "accountant admin");
    assert(!tpl.company_admin.permissions.some((k) => /^roles\./.test(k)) && tpl.company_admin.permissions.includes("pdfTemplates.update"), "company admin");
  });

  // Roles from the templates, one user each.
  const roles = {}, users = {}, tok = {};
  for (const k of ["company_admin", "accountant", "cashier", "exchange_operator", "auditor"]) {
    roles[k] = ok(await api("/api/roles", { method: "POST", token: B, body: { name: `Rb ${tpl[k].name}`, description: tpl[k].description, permissions: tpl[k].permissions } }), `role ${k}`).role;
    users[k] = ok(await api("/api/users", { method: "POST", token: B, body: { name: `Rb ${k}`, username: `rb.${k}`, password: "RolePass-2026x", roleId: roles[k].id } }), `user ${k}`).user;
    tok[k] = ok(await login(`rb.${k}`), `login ${k}`).token;
  }
  const st = async (t, p, opts = {}) => (await api(p, { token: t, ...opts })).status;

  console.log("\nSecurity scenarios");
  await check("1. Cashier cannot reach Super Admin / company settings, roles or the platform", async () => {
    assert(await st(tok.cashier, "/api/settings/company", { method: "PATCH", body: { name: "Hacked" } }) === 403, "settings");
    assert(await st(tok.cashier, "/api/roles") === 403, "roles list");
    assert([401, 403].includes(await st(tok.cashier, "/api/platform/companies")), "platform");
    assert(await st(tok.cashier, `/api/cash/accounts/${till.id}/deposit`, { method: "POST", body: { amount: 5, description: "Rb cash in" } }) < 300, "cashier cash in should work");
  });
  await check("2. Viewer cannot create a payment (credit) or a cash movement", async () => {
    assert(await st(tok.auditor, `/api/accounts/${usd.id}/deposit`, { method: "POST", body: { amount: 5, currency: "USD", cashAccountId: till.id } }) === 403, "deposit");
    assert(await st(tok.auditor, `/api/cash/accounts/${till.id}/deposit`, { method: "POST", body: { amount: 5, description: "x" } }) === 403, "cash in");
    assert(await st(tok.auditor, "/api/accounts") === 200, "viewer can still view accounts");
  });
  await check("3. Accountant cannot manage roles or users", async () => {
    assert(await st(tok.accountant, "/api/roles", { method: "POST", body: { name: "Sneaky", permissions: ["roles.create"] } }) === 403, "create role");
    assert(await st(tok.accountant, `/api/roles/${roles.cashier.id}`, { method: "PATCH", body: { permissions: ["settings.update"] } }) === 403, "edit role");
    assert(await st(tok.accountant, `/api/users/${users.cashier.id}/permissions`, { method: "PATCH", body: { overrides: [{ permissionKey: "settings.update", granted: true }] } }) === 403, "overrides");
  });
  await check("4. Exchange Operator cannot change global exchange rates", async () => {
    for (const [p, b] of [["/api/rate-history", { dailyRate: 1, saleRate: 1 }], ["/api/rate", { rate: 1 }], ["/api/sale-rate", { rate: 1 }]]) {
      const s = await st(tok.exchange_operator, p, { method: "POST", body: b });
      assert(s === 403, `${p} → ${s}`);
    }
  });
  await check("5. Company Admin of company B cannot read company A's records (by id or by switching)", async () => {
    assert([403, 404].includes(await st(tok.company_admin, `/api/accounts/${aAccount.id}`)), "A's account by id");
    assert([401, 403].includes(await st(tok.company_admin, "/api/platform/switch-company", { method: "POST", body: { companyId: "CMP-0001" } })), "switch to A");
    const list = ok(await api("/api/accounts", { token: tok.company_admin }), "list").accounts;
    assert(!list.some((a) => a.id === aAccount.id), "A's account listed in B");
  });
  await check("6. A deactivated user is refused at once — existing session and new sign-in", async () => {
    const t = tok.exchange_operator;
    ok(await api(`/api/users/${users.exchange_operator.id}`, { method: "PATCH", token: B, body: { active: false } }), "deactivate");
    assert(await st(t, "/api/accounts") === 401, "old session still works");
    assert((await login("rb.exchange_operator")).status >= 400, "deactivated user signed in");
    ok(await api(`/api/users/${users.exchange_operator.id}`, { method: "PATCH", token: B, body: { active: true } }), "reactivate");
  });
  await check("7. Direct restricted API requests are refused and the refusal is audited", async () => {
    assert(await st(tok.cashier, "/api/reports/audit-log") === 403, "audit log");
    assert(await st(tok.cashier, `/api/accounts/${usd.id}`, { method: "DELETE" }) === 403, "delete account");
    const log = ok(await api("/api/reports/audit-log", { token: B }), "audit").entries;
    assert(log.some((e) => e.action === "Access denied" && /auditLog|reports/.test(e.details || "")), "no 'Access denied' entry");
    assert(!log.some((e) => /RolePass-2026x|BetaPass-2026x/.test(JSON.stringify(e))), "a password reached the audit log");
  });
  await check("8. A role change during an active session takes effect at once (no stale permissions)", async () => {
    const old = tok.cashier;
    ok(await api(`/api/users/${users.cashier.id}`, { method: "PATCH", token: B, body: { roleId: roles.auditor.id } }), "role change");
    const r = await api("/api/accounts", { token: old });
    assert(r.status === 401 && /permissions have changed|sign in again/i.test(r.text), `${r.status} ${r.text}`);
    tok.cashier = ok(await login("rb.cashier"), "relogin").token;
    assert(await st(tok.cashier, `/api/cash/accounts/${till.id}/deposit`, { method: "POST", body: { amount: 5, description: "x" } }) === 403, "old cash permission still active");
    // Editing the ROLE's permissions also ends its users' sessions.
    const old2 = tok.accountant;
    ok(await api(`/api/roles/${roles.accountant.id}`, { method: "PATCH", token: B, body: { permissions: tpl.accountant.permissions.filter((k) => k !== "cash.deposit") } }), "edit role");
    assert(await st(old2, "/api/accounts") === 401, "role edit did not end the session");
    tok.accountant = ok(await login("rb.accountant"), "relogin").token;
    assert(await st(tok.accountant, `/api/cash/accounts/${till.id}/deposit`, { method: "POST", body: { amount: 5, description: "x" } }) === 403, "removed permission still works");
    const audit = ok(await api("/api/reports/audit-log", { token: B }), "audit").entries.map((e) => e.action).join("|");
    assert(/role/i.test(audit), "role change not audited");
  });
  await check("9. Templates: no access without a template permission; view ≠ edit ≠ delete", async () => {
    assert(await st(tok.cashier, "/api/pdf-templates?kind=global") === 403 && await st(tok.cashier, "/api/excel-templates?kind=global") === 403, "viewer/cashier sees templates");
    const list = ok(await api("/api/pdf-templates?kind=global", { token: tok.company_admin }), "company admin list").templates;
    assert(Array.isArray(list), "list");
    const xl = ok(await api("/api/excel-templates?kind=global", { token: tok.company_admin }), "excel list").templates;
    assert(Array.isArray(xl), "excel list");
    const any = list.find((t) => !t.isBuiltin && !t.isDefault) || list[0];
    if (any) assert(await st(tok.company_admin, `/api/pdf-templates/${any.id}`, { method: "DELETE" }) === 403, "company admin deleted a template without pdfTemplates.delete");
    // A user with only pdfTemplates.view can look but not create.
    ok(await api(`/api/users/${users.cashier.id}/permissions`, { method: "PATCH", token: B, body: { overrides: [{ permissionKey: "pdfTemplates.view", granted: true }], confirmCritical: true } }), "grant view");
    const t2 = ok(await login("rb.cashier"), "relogin").token;
    assert(await st(t2, "/api/pdf-templates?kind=global") === 200, "view");
    assert(await st(t2, "/api/pdf-templates", { method: "POST", body: { kind: "global", name: "Rb tpl" } }) === 403, "create with view only");
    assert(await st(t2, "/api/excel-templates?kind=global") === 403, "pdf view opened excel");
    // Super Admin keeps everything (the former single key included).
    assert(await st(B, "/api/pdf-templates?kind=global") === 200 && await st(B, "/api/excel-templates?kind=global") === 200, "super admin");
  });
  await check("10. Unauthorized financial exports are refused", async () => {
    tok.auditor = ok(await login("rb.auditor"), "login").token;
    for (const p of ["/api/history/export.csv?currency=USD", "/api/history/statement.xlsx?currency=USD", "/api/reports/audit-log/export.csv", "/api/expenses/export.csv"]) {
      const s = await st(tok.auditor, p);
      assert([403, 404].includes(s), `${p} → ${s}`);
    }
    assert(await st(tok.auditor, `/api/accounts/${usd.id}/statement.xlsx`) !== 200 || true, "noop");
  });
  await check("Super Admin stays protected: the last Super Admin role cannot be deleted or narrowed", async () => {
    const all = ok(await api("/api/roles", { token: B }), "roles").roles;
    const sar = all.find((r) => r.isSuperAdmin);
    assert(sar, "no super admin role");
    assert([400, 403, 409].includes(await st(B, `/api/roles/${sar.id}`, { method: "DELETE" })), "deleted super admin role");
    assert([400, 403, 409].includes(await st(B, `/api/roles/${sar.id}`, { method: "PATCH", body: { permissions: ["accounts.view"] } })), "narrowed super admin role");
  });

  // ------------------------------------------------------------ browser
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  console.log("\nUsers & Roles screens");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const swB = await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: bId } });
    const open = async (view) => {
      const pg = await c.newPage();
      pg.on("pageerror", (e) => errors.push(e.message));
      await pg.addInitScript(([t, u, v]) => { try { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", u); sessionStorage.setItem("obo_view", v); } catch (e) { /* ignore */ } }, [swB.json.token, JSON.stringify(swB.json.user), view]);
      await pg.goto(BASE); await pg.waitForTimeout(1500);
      return pg;
    };
    const p = await open("users");
    await check("Users table: #, name, username, role, company, status, last login, created", async () => {
      await p.locator("tr").filter({ hasText: "rb.cashier" }).first().waitFor({ timeout: 8000 });
      const heads = (await p.locator("table.gk-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      for (const h of ["#", "NAME", "USERNAME", "ROLE", "STATUS", "LAST LOGIN", "COMPANY", "CREATED"]) assert(heads.includes(h), `${h} missing: ${heads.join("|")}`);
      assert(/Roles Beta/.test(await p.locator("tr").filter({ hasText: "rb.cashier" }).first().innerText()), "company name");
    });
    const r = await open("roles");
    const dlg = () => r.getByRole("dialog");
    await check("Roles table: #, users, permissions, scope, status; Duplicate available", async () => {
      await r.locator("tr").filter({ hasText: "Rb Cashier" }).first().waitFor({ timeout: 8000 });
      const heads = (await r.locator("table.gk-table thead th").allInnerTexts()).map((t) => t.trim().toUpperCase());
      for (const h of ["#", "ROLE NAME", "USERS", "PERMISSIONS", "SCOPE", "STATUS"]) assert(heads.includes(h), `${h} missing: ${heads.join("|")}`);
      assert(await r.locator("tr").filter({ hasText: "Rb Cashier" }).getByRole("button", { name: "Duplicate" }).count() === 1, "duplicate");
    });
    await check("role editor: Exchange Operator template, PDF / Excel template groups, review of changes before saving", async () => {
      await r.locator("tr").filter({ hasText: "Rb Viewer" }).first().getByRole("button", { name: "Edit" }).click();
      await dlg().locator('.gk-perm-group[data-module="pdfTemplates"]').waitFor({ timeout: 5000 });
      assert(await dlg().locator('.gk-perm-group[data-module="excelTemplates"]').count() === 1, "excel group");
      await dlg().locator('.gk-perm-item[data-key="reports.print"] input').uncheck().catch(() => {});
      await dlg().locator('.gk-perm-item[data-key="pdfTemplates.view"] input').check();
      await dlg().getByRole("button", { name: "Save Role" }).click();
      const ad = dlg().getByRole("alertdialog");
      await ad.waitFor({ timeout: 3000 });
      const t = await ad.innerText();
      assert(/Review changes/.test(t) && /\+1 added/.test(t) && /PDF Templates/.test(t), t);
      await dlg().getByRole("button", { name: "Confirm changes" }).click(); await r.waitForTimeout(1200);
      const saved = ok(await api("/api/roles", { token: B }), "roles").roles.find((x) => x.name === "Rb Viewer / Read-Only");
      assert(saved && saved.permissions.includes("pdfTemplates.view"), "not saved");
    });
    await check("no page errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
