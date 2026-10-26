"use strict";
const pwThrottle = require("../password-throttle");
// MULTI-COMPANY round — Super Admin "Companies Management" API.
//
// Every endpoint here requires a PLATFORM Super Admin token
// (rbac.requirePlatformAdmin). Company Admins and staff — whose tokens are
// bound to one company — are refused with 403 on all of them, so they can
// never register companies, see other companies, or switch workspaces.
//
// Global summaries are computed company by company, each inside that
// company's OWN database context (tenancy.withCompany), and returned as
// separate per-company objects — never merged into combined totals.
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requirePlatformAdmin } = require("../rbac");
const tenancy = require("../tenancy");
const authLib = require("../auth");

const MAX_LOGO_CHARS = 1_800_000;

function fail(res, e) {
  if (e && e.status) return sendJSON(res, e.status, { error: e.message });
  // eslint-disable-next-line no-console
  console.error("[platform]", e);
  return sendJSON(res, 500, { error: "Internal server error." });
}

function validateLogo(res, logo) {
  if (logo === undefined || logo === null || logo === "") return true;
  if (typeof logo !== "string" || logo.length > MAX_LOGO_CHARS) { badRequest(res, "That logo image is too large. Please use a smaller file (under ~1MB)."); return false; }
  if (!/^data:image\/(png|jpeg|jpg);base64,/.test(logo)) { badRequest(res, "Logo must be a PNG or JPEG image."); return false; }
  return true;
}
function validateEmail(res, email) {
  if (!email) return true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) { badRequest(res, "Email address looks invalid."); return false; }
  return true;
}

// Read-only snapshot of ONE company, computed inside its own database.
function companySummary() {
  const { get, all } = require("../db");
  const one = (sql, p) => { try { return get(sql, p) || {}; } catch (e) { return {}; } };
  const accounts = one("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM clients WHERE deleted_at IS NULL");
  const usd = one("SELECT COALESCE(SUM(balance_usd), 0) AS n FROM clients WHERE deleted_at IS NULL AND currency = 'USD'").n || 0;
  const slsh = one("SELECT COALESCE(SUM(balance_slsh), 0) AS n FROM clients WHERE deleted_at IS NULL AND currency = 'SLSH'").n || 0;
  const cash = {};
  try {
    for (const r of all("SELECT currency, COALESCE(SUM(balance), 0) AS n FROM cash_accounts WHERE status = 'active' GROUP BY currency")) cash[r.currency] = r.n;
  } catch (e) { /* table may be empty */ }
  const users = one(`SELECT COUNT(*) AS total, SUM(CASE WHEN u.status = 'active' AND u.active = 1 THEN 1 ELSE 0 END) AS active
                     FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL AND COALESCE(r.is_super_admin, 0) = 0`);
  const pendingQuotations = one("SELECT COUNT(*) AS n FROM quotations WHERE status IN ('Pending','Partially Paid')").n || 0;
  const exchanges = one("SELECT COUNT(*) AS n FROM exchange_transactions WHERE status = 'active'").n || 0;
  const lastActivity = one("SELECT MAX(at) AS at FROM audit_log").at || null;
  const rate = one("SELECT daily_rate FROM rate_history ORDER BY at DESC, id DESC LIMIT 1").daily_rate ?? null;
  return {
    accounts: { total: accounts.total || 0, active: accounts.active || 0 },
    accountBalances: { USD: usd, SLSH: slsh },
    cashInHand: { USD: cash.USD || 0, SLSH: cash.SLSH || 0 },
    users: { total: users.total || 0, active: users.active || 0 },
    pendingQuotations,
    exchanges,
    dailyRate: rate,
    lastActivity,
  };
}

function companyAdmins() {
  const { all } = require("../db");
  return all(`SELECT u.id, u.name, u.username, u.status, u.active, u.last_login FROM users u JOIN roles r ON r.id = u.role_id
              WHERE r.key = 'admin' AND u.deleted_at IS NULL ORDER BY u.created_at ASC`)
    .map((u) => ({ id: u.id, name: u.name, username: u.username, status: u.status, active: !!u.active, lastLogin: u.last_login }));
}
function companyUsers() {
  const { all } = require("../db");
  return all(`SELECT u.id, u.name, u.username, u.status, u.active, u.last_login, r.name AS role_name, r.key AS role_key FROM users u
              LEFT JOIN roles r ON r.id = u.role_id
              WHERE u.deleted_at IS NULL AND COALESCE(r.is_super_admin, 0) = 0 ORDER BY u.created_at ASC`)
    .map((u) => ({ id: u.id, name: u.name, username: u.username, status: u.status, active: !!u.active, lastLogin: u.last_login, roleName: u.role_name, roleKey: u.role_key }));
}

function safeSummary(company) {
  try { return tenancy.withCompany(company, companySummary); } catch (e) { return { error: "Company database unavailable." }; }
}

function register(router) {
  router.get("/api/platform/companies", (req, res) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    try {
      const companies = tenancy.listCompanies().map((c) => ({ ...tenancy.publicCompany(c), summary: safeSummary(c) }));
      sendJSON(res, 200, { companies, activeCompanyId: pu.activeCompanyId });
    } catch (e) { fail(res, e); }
  });

  // Global overview: one clearly separated summary per company. Totals are
  // never added together across companies (different businesses, different
  // books — a combined figure would be meaningless and would mix records).
  router.get("/api/platform/overview", (req, res) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    try {
      const companies = tenancy.listCompanies();
      const counts = { total: companies.length, active: 0, inactive: 0, suspended: 0 };
      for (const c of companies) {
        if (c.status === "active") counts.active += 1;
        if (c.deactivated) counts.inactive += 1;
        if (c.suspended) counts.suspended += 1;
      }
      sendJSON(res, 200, {
        counts,
        companies: companies.map((c) => ({ ...tenancy.publicCompany(c, { includeLogo: false }), summary: safeSummary(c) })),
        recentActivity: tenancy.call("SELECT id, at, actor_name, action, company_id, details FROM platform_audit ORDER BY at DESC LIMIT 25")
          .map((r) => ({ id: r.id, at: r.at, actorName: r.actor_name, action: r.action, companyId: r.company_id, details: r.details || "" })),
      });
    } catch (e) { fail(res, e); }
  });

  router.get("/api/platform/companies/:id", (req, res, params) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    const company = tenancy.getCompany(params.id);
    if (!company) return notFound(res, "Company not found.");
    try {
      const detail = tenancy.withCompany(company, () => ({ summary: companySummary(), admins: companyAdmins(), users: companyUsers() }));
      sendJSON(res, 200, { company: tenancy.publicCompany(company), ...detail });
    } catch (e) { fail(res, e); }
  });

  router.post("/api/platform/companies", async (req, res) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!validateLogo(res, body.logoDataUrl) || !validateEmail(res, body.email)) return;
    try {
      const { company, adminUser } = tenancy.createCompany(body, { id: pu.id, name: pu.name });
      sendJSON(res, 201, { company: tenancy.publicCompany(company), adminUser });
    } catch (e) { fail(res, e); }
  });

  router.patch("/api/platform/companies/:id", async (req, res, params) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    const company = tenancy.getCompany(params.id);
    if (!company) return notFound(res, "Company not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (body.id !== undefined && body.id !== company.id) return badRequest(res, "A Company ID is permanent and cannot be changed.");
    if (!validateLogo(res, body.logoDataUrl) || !validateEmail(res, body.email)) return;
    try {
      const updated = tenancy.updateCompany(company, body, { id: pu.id, name: pu.name });
      sendJSON(res, 200, { company: tenancy.publicCompany(updated) });
    } catch (e) { fail(res, e); }
  });

  router.post("/api/platform/companies/:id/status", async (req, res, params) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    const company = tenancy.getCompany(params.id);
    if (!company) return notFound(res, "Company not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    // COMPANY STATUS round: `action` (deactivate|activate|suspend|unsuspend)
    // toggles one of the two independent switches; the older `status` body is
    // still accepted. Applies to every company, the primary one included.
    try {
      const actor = { id: pu.id, name: pu.name };
      const updated = body.action
        ? tenancy.applyCompanyAction(company, String(body.action), body.reason, actor)
        : tenancy.setCompanyStatus(company, body.status, body.reason, actor);
      sendJSON(res, 200, { company: tenancy.publicCompany(updated) });
    } catch (e) { fail(res, e); }
  });

  // Assign a Company Admin: either create a brand-new admin user in the
  // company, or promote one of that company's own existing users.
  router.post("/api/platform/companies/:id/admins", async (req, res, params) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    const company = tenancy.getCompany(params.id);
    if (!company) return notFound(res, "Company not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    try {
      const actor = { id: pu.id, name: pu.name };
      const adminUser = body.userId
        ? tenancy.promoteToCompanyAdmin(company, String(body.userId), actor)
        : tenancy.createCompanyAdmin(company, { name: body.name, username: body.username, password: body.password }, actor);
      sendJSON(res, 201, { adminUser });
    } catch (e) { fail(res, e); }
  });

  router.get("/api/platform/username-available", (req, res, _params, query) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    sendJSON(res, 200, { available: tenancy.isUsernameAvailable(query.username) });
  });

  // Open a company's workspace (or leave it with companyId: null). Issues a
  // NEW server-signed token carrying the selected company — the only way a
  // Super Admin's requests become bound to a company. Nothing is copied,
  // moved or merged between companies; the frontend reloads from scratch.
  router.post("/api/platform/switch-company", async (req, res) => {
    const pu = requirePlatformAdmin(req, res); if (!pu) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const { sessionUser } = require("./auth");
    if (body.companyId === null || body.companyId === undefined || body.companyId === "") {
      const token = authLib.sign({ sub: pu.id, kind: "platform", pv: pu.permissions_version, name: pu.name, cid: null });
      return sendJSON(res, 200, { token, user: sessionUser(null, null, tenancy.getPlatformUser(pu.id)) });
    }
    const company = tenancy.getCompany(String(body.companyId));
    if (!company) return notFound(res, "Company not found.");
    try {
      const user = tenancy.withCompany(company, () => {
        const shadow = tenancy.ensureShadowUser(tenancy.getPlatformUser(pu.id));
        require("../domain").addAudit({ id: pu.id, name: pu.name, role: "super_admin" }, "Super Admin opened company workspace", company.name);
        const { get } = require("../db");
        return sessionUser(get("SELECT * FROM users WHERE id = ?", [shadow.id]), company, pu);
      });
      tenancy.platformAudit({ id: pu.id, name: pu.name }, "Opened company workspace", company.id, company.name);
      const token = authLib.sign({ sub: pu.id, kind: "platform", pv: pu.permissions_version, name: pu.name, cid: company.id });
      sendJSON(res, 200, { token, user });
    } catch (e) { fail(res, e); }
  });

  router.post("/api/platform/me/password", async (req, res) => {
    const pu = requirePlatformAdmin(req, res, { allowPasswordChange: true }); if (!pu) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const throttleKey = `platform:${pu.id}`;
    if (pwThrottle.blocked(throttleKey)) return sendJSON(res, 429, { error: "Too many incorrect attempts. Please try again in a few minutes." });
    if (!body.currentPassword || !authLib.verifyPassword(String(body.currentPassword), pu.password_hash, pu.password_salt)) {
      pwThrottle.fail(throttleKey);
      return badRequest(res, "Current password is incorrect.");
    }
    pwThrottle.succeed(throttleKey);
    { const pwErr = authLib.passwordPolicyError(String(body.newPassword || ""), { username: pu.username }); if (pwErr) return badRequest(res, pwErr); }
    if (String(body.newPassword) === String(body.currentPassword)) return badRequest(res, "The new password must be different from the current one.");
    const { hash, salt } = authLib.hashPassword(String(body.newPassword));
    // Bumping permissions_version signs out every other session of this account.
    tenancy.crun("UPDATE platform_users SET password_hash = ?, password_salt = ?, permissions_version = permissions_version + 1 WHERE id = ?", [hash, salt, pu.id]);
    tenancy.platformAudit({ id: pu.id, name: pu.name }, "Super Admin password changed", null, "");
    const fresh = tenancy.getPlatformUser(pu.id);
    const token = authLib.sign({ sub: pu.id, kind: "platform", pv: fresh.permissions_version, name: pu.name, cid: pu.activeCompanyId || null });
    sendJSON(res, 200, { ok: true, token });
  });
}

module.exports = { register, companySummary };
