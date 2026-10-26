"use strict";
// MULTI-COMPANY round — company registry, per-company databases, platform
// (Super Admin) accounts, and the global username directory.
//
// ARCHITECTURE (see README "Multi-Company Architecture" and
// docs/MYSQL-MIGRATION-PLAN.md). MYSQL round: one MySQL database holds
//   * the platform tables (ctl_*) — the `companies` registry (unique, permanent Company
//                          IDs like CMP-0001), platform Super Admin accounts,
//                          the username -> company directory used at login,
//                          and the platform audit log. Holds NO financial data.
//   * one full set of tables per company (cmpNNNN_*) — every company's accounts, ledgers, payments,
//                          exchanges, quotations, cash, reports data, users,
//                          roles, permissions, settings and branding. The
//                          PRIMARY company is CMP-0001.
// A request can only ever reach ONE company's tables, chosen from the signed
// token after the caller's access has been verified (src/rbac.js). There is no
// query in the app that can join or read across two companies' tables (each
// company's handle can only name its own tables — src/mysql/dialect.js).
const crypto = require("crypto");
const { openTenantDb, openControlDb } = require("./db");
const schema = require("./mysql/schema");
const tenantContext = require("./tenant-context");

const PRIMARY_FILE_TOKEN = "@primary";
const COMPANY_STATUSES = ["active", "inactive", "suspended"];

let control = null;
const tenantCache = new Map(); // companyId -> { companyId, file, db }

function nowISO() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`; }

// The platform tables (MySQL ctl_*). Their schema — including the COMPANY
// STATUS round's deactivated/suspended columns — comes from
// src/mysql/schema.json; the one-time status backfill of old SQLite data is
// done by the migration tool (scripts/legacy/sqlite-control-db.js).
function controlDb() {
  if (!control) control = openControlDb();
  return control;
}

// COMPANY STATUS round: Deactivate and Suspend are two INDEPENDENT switches
// (see README "Company status rules"). `status` stays as the single derived
// value every access check reads: 'inactive' if deactivated, else 'suspended'
// if suspended, else 'active'.
function derivedStatus(deactivated, suspended) {
  return deactivated ? "inactive" : suspended ? "suspended" : "active";
}
// What a blocked company user is told — distinct per reason.
function companyAccessMessage(company) {
  if (company.deactivated || company.status === "inactive") return `${company.name} has been deactivated. Please contact the system administrator.`;
  return `Access to ${company.name} is temporarily suspended. Please contact the system administrator.`;
}
function cget(sql, params = []) { return controlDb().prepare(sql).get(...params); }
function call(sql, params = []) { return controlDb().prepare(sql).all(...params); }
function crun(sql, params = []) { return controlDb().prepare(sql).run(...params); }
function ctx(fn) {
  const d = controlDb();
  d.exec("BEGIN");
  try { const r = fn(); d.exec("COMMIT"); return r; } catch (e) { d.exec("ROLLBACK"); throw e; }
}

function platformAudit(actor, action, companyId, details) {
  crun("INSERT INTO platform_audit (id, at, actor_id, actor_name, action, company_id, details) VALUES (?,?,?,?,?,?,?)",
    [uid("pa"), nowISO(), actor?.id || null, actor?.name || "system", action, companyId || null, details || ""]);
}

/* ------------------------------ companies ------------------------------ */
function getCompany(id) {
  if (!id || typeof id !== "string") return null;
  return cget("SELECT * FROM companies WHERE id = ?", [id]) || null;
}
function listCompanies() {
  return call("SELECT * FROM companies ORDER BY seq ASC");
}
function primaryCompany() {
  return cget("SELECT * FROM companies WHERE is_primary = 1") || null;
}
// Where a company's data lives: its own MySQL table set (prefix), e.g.
// "mysql:cmp0002_*". Informational only.
function companyFile(company) {
  return `mysql:${schema.companyPrefix(company.id)}*`;
}
function nextCompanySeq() {
  return (cget("SELECT MAX(seq) AS n FROM companies")?.n || 0) + 1;
}
function companyIdFor(seq) { return `CMP-${String(seq).padStart(4, "0")}`; }

// Opens (once per process) and returns the tenant handle for a company row.
function openTenant(company) {
  const cached = tenantCache.get(company.id);
  if (cached) return cached;
  const { db } = openTenantDb(company.id, { isPrimary: !!company.is_primary });
  const tenant = { companyId: company.id, file: companyFile(company), db };
  tenantCache.set(company.id, tenant);
  return tenant;
}

// Runs fn inside an explicit company context (platform summaries, background
// jobs, provisioning). Never used to widen a normal user's access.
function withCompany(company, fn) {
  const tenant = openTenant(company);
  return tenantContext.withTenant(tenant, company, fn);
}

function publicCompany(c, { includeLogo = true } = {}) {
  if (!c) return null;
  return {
    id: c.id, name: c.name, status: c.status, statusReason: c.status_reason || "",
    statusChangedAt: c.status_changed_at || null, isPrimary: !!c.is_primary,
    deactivated: !!c.deactivated, deactivatedReason: c.deactivated_reason || "", deactivatedAt: c.deactivated_at || null,
    suspended: !!c.suspended, suspendedReason: c.suspended_reason || "", suspendedAt: c.suspended_at || null,
    contactName: c.contact_name || "", phone: c.phone || "", email: c.email || "",
    address: c.address || "", website: c.website || "", notes: c.notes || "",
    logoDataUrl: includeLogo ? (c.logo_data_url || null) : undefined,
    createdAt: c.created_at, updatedAt: c.updated_at || null,
  };
}

/* ----------------------- usernames & directory ------------------------ */
function normalizeUsername(u) { return String(u || "").trim().toLowerCase(); }

// True if `username` is not taken anywhere in the installation (any company,
// or a platform Super Admin). Usernames are global so login is unambiguous.
function isUsernameAvailable(username) {
  const u = normalizeUsername(username);
  if (!u) return false;
  if (cget("SELECT 1 AS x FROM platform_users WHERE username = ?", [u])) return false;
  if (cget("SELECT 1 AS x FROM user_directory WHERE username = ?", [u])) return false;
  return true;
}
function registerDirectoryUser(username, companyId, userId) {
  crun(`INSERT INTO user_directory (username, company_id, user_id, updated_at) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE company_id = VALUES(company_id), user_id = VALUES(user_id), updated_at = VALUES(updated_at)`,
    [normalizeUsername(username), companyId, userId, nowISO()]);
}
function lookupDirectory(username) {
  return cget("SELECT * FROM user_directory WHERE username = ?", [normalizeUsername(username)]) || null;
}

// Rebuilds the directory from each company's own users table (the source of
// truth). Super Admin rows inside a company database are platform accounts
// and are never listed. A username that somehow exists in two companies is
// never silently re-pointed — the first mapping wins and a warning is logged.
function syncDirectoryForCompany(company) {
  return withCompany(company, () => {
    const { all } = require("./db");
    const rows = all(`SELECT u.id, u.username FROM users u LEFT JOIN roles r ON r.id = u.role_id
                      WHERE COALESCE(r.is_super_admin, 0) = 0`);
    const seen = new Set();
    for (const r of rows) {
      const uname = normalizeUsername(r.username);
      seen.add(uname);
      const existing = lookupDirectory(uname);
      if (cget("SELECT 1 AS x FROM platform_users WHERE username = ?", [uname])) {
        console.warn(`[tenancy] Username "${uname}" in ${company.id} collides with a platform Super Admin — that company user cannot log in until renamed.`);
        continue;
      }
      if (existing && existing.company_id !== company.id) {
        console.warn(`[tenancy] Username "${uname}" exists in both ${existing.company_id} and ${company.id}; keeping ${existing.company_id}. Rename one of them.`);
        continue;
      }
      if (!existing || existing.user_id !== r.id) registerDirectoryUser(uname, company.id, r.id);
    }
    for (const d of call("SELECT username FROM user_directory WHERE company_id = ?", [company.id])) {
      if (!seen.has(d.username)) crun("DELETE FROM user_directory WHERE username = ?", [d.username]);
    }
  });
}

/* --------------------------- platform users --------------------------- */
function getPlatformUser(id) {
  return cget("SELECT * FROM platform_users WHERE id = ?", [id]) || null;
}
function getPlatformUserByUsername(username) {
  return cget("SELECT * FROM platform_users WHERE username = ?", [normalizeUsername(username)]) || null;
}

// A Super Admin entering a company workspace needs a matching row in that
// company's users table — every financial record stores staff_id/created_by
// as a real foreign key to users(id). That row (same id as the platform
// account, Super Admin role, unusable password, never in the directory) is
// all the company database ever knows about the platform account. Must be
// called inside that company's context.
function ensureShadowUser(platformUser) {
  const { get, run } = require("./db");
  const superRole = get("SELECT id FROM roles WHERE is_super_admin = 1 ORDER BY created_at ASC LIMIT 1");
  if (!superRole) throw new Error("Company database has no Super Admin role.");
  const row = get("SELECT * FROM users WHERE id = ?", [platformUser.id]);
  if (!row) {
    let uname = `__platform__.${platformUser.username}`;
    if (get("SELECT id FROM users WHERE username = ?", [uname])) uname = `${uname}.${platformUser.id}`;
    const salt = crypto.randomBytes(16).toString("hex");
    const unusable = crypto.randomBytes(64).toString("hex"); // never a real PBKDF2 output of any password
    run(`INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, last_login, created_at)
         VALUES (?,?,?,?,?,'admin',?,'active',1,1,NULL,?)`, [platformUser.id, platformUser.name, uname, unusable, salt, superRole.id, nowISO()]);
  } else if (row.role_id !== superRole.id || !row.active || row.status !== "active" || row.deleted_at || row.name !== platformUser.name) {
    run("UPDATE users SET role_id = ?, role = 'admin', active = 1, status = 'active', deleted_at = NULL, deleted_by = NULL, name = ? WHERE id = ?",
      [superRole.id, platformUser.name, platformUser.id]);
  }
  return get("SELECT id, name, username, role, role_id, status, active, permissions_version FROM users WHERE id = ?", [platformUser.id]);
}

/* ------------------------- bootstrap / migration ----------------------- */

// Every account that held the Super Admin role in the primary (pre-existing)
// database becomes a platform Super Admin with the SAME id, username and
// password — they previously had unrestricted access to the only company, so
// this preserves exactly what they could do. Their row stays in the primary
// database as their in-company identity (keeps every historical FK intact).
function promotePrimarySuperAdmins(primary) {
  withCompany(primary, () => {
    const { all } = require("./db");
    const rows = all(`SELECT u.* FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_super_admin = 1 AND u.deleted_at IS NULL`);
    for (const u of rows) {
      if (getPlatformUser(u.id)) continue;
      if (u.username.startsWith("__platform__.")) continue;
      if (getPlatformUserByUsername(u.username)) {
        console.warn(`[tenancy] Not promoting ${u.username} from ${primary.id}: a platform account with that username already exists.`);
        continue;
      }
      crun(`INSERT INTO platform_users (id, name, username, password_hash, password_salt, status, permissions_version, last_login, migrated_from_company, created_at)
            VALUES (?,?,?,?,?,?,1,?,?,?)`,
        [u.id, u.name, normalizeUsername(u.username), u.password_hash, u.password_salt,
         (u.active && u.status === "active") ? "active" : "deactivated", u.last_login, primary.id, nowISO()]);
      crun("DELETE FROM user_directory WHERE username = ?", [normalizeUsername(u.username)]);
      console.log(`[tenancy] ${u.username} is now a platform Super Admin.`);
    }
  });
}

let bootstrapped = false;
function bootstrap() {
  if (bootstrapped) return;
  controlDb();
  let primary = primaryCompany();
  if (!primary) {
    // A brand-new installation (existing SQLite data is brought over by
    // scripts/migrate-sqlite-to-mysql.js, which writes the registry itself).
    if (listCompanies().length) throw new Error("[tenancy] Companies exist but none is marked primary — refusing to guess. Check the migration.");
    const name = "OBO Financial System";
    const id = companyIdFor(1);
    crun(`INSERT INTO companies (id, seq, name, status, is_primary, db_file, created_at, created_by)
          VALUES (?, 1, ?, 'active', 1, ?, ?, 'system')`, [id, name, PRIMARY_FILE_TOKEN, nowISO()]);
    platformAudit(null, "Company registered", id, `${name} (new installation)`);
    primary = primaryCompany();
  }
  for (const company of listCompanies()) {
    try {
      openTenant(company);
    } catch (e) {
      console.error(`[tenancy] Could not open ${company.id} (${company.name}):`, e.message);
    }
  }
  promotePrimarySuperAdmins(primary);
  for (const company of listCompanies()) {
    if (!tenantCache.has(company.id)) continue;
    try { syncDirectoryForCompany(company); } catch (e) { console.error(`[tenancy] Directory sync failed for ${company.id}:`, e.message); }
  }
  // Keep registry display data (name/logo/contact) in step with each
  // company's own Settings — company_settings stays the branding source.
  for (const company of listCompanies()) {
    if (!tenantCache.has(company.id)) continue;
    try { withCompany(company, () => syncRegistryFromSettings()); } catch (e) { /* non-fatal */ }
  }
  bootstrapped = true;
}

// Copies the current company's own Settings branding into its registry row
// (call inside a company context). Keeps the Companies list accurate when a
// Company Admin edits branding from inside their own workspace.
function syncRegistryFromSettings() {
  const company = tenantContext.currentCompany();
  if (!company) return;
  const { get } = require("./db");
  const s = get("SELECT * FROM company_settings WHERE id = 1");
  if (!s) return;
  const params = [s.logo_data_url || null, s.phone || null, s.email || null, s.address || null, s.website || null, company.id];
  try {
    crun(`UPDATE companies SET name = ?, logo_data_url = ?, phone = ?, email = ?, address = ?, website = ? WHERE id = ?`, [s.name, ...params]);
  } catch (e) {
    // Another company already uses that display name — keep the registry
    // name unchanged rather than fail the company's own settings save.
    crun(`UPDATE companies SET logo_data_url = ?, phone = ?, email = ?, address = ?, website = ? WHERE id = ?`, params);
    console.warn(`[tenancy] Registry name for ${company.id} not updated to "${s.name}": ${e.message}`);
  }
}

// For CLI scripts/tests only: bootstrap and make the primary company the
// implicit context for this process.
function useScriptTenant(companyId) {
  bootstrap();
  const company = companyId ? getCompany(companyId) : primaryCompany();
  if (!company) throw new Error(`Unknown company ${companyId}`);
  tenantContext.setScriptTenant({ ...openTenant(company), company });
  return company;
}

/* ----------------------------- provisioning --------------------------- */
// Registers a brand-new company: allocates its permanent Company ID, creates
// its own empty database (full schema, default roles/templates), writes its
// branding, and optionally creates its first Company Admin. Never touches any
// other company's database.
function createCompany(input, actor) {
  bootstrap();
  const name = String(input.name || "").trim();
  if (!name) throw httpError(400, "Company name is required.");
  if (name.length > 160) throw httpError(400, "Company name is too long.");
  if (cget("SELECT id FROM companies WHERE lower(name) = lower(?)", [name])) throw httpError(409, "A company with that name already exists.");
  const admin = input.admin && (input.admin.username || input.admin.password || input.admin.name) ? input.admin : null;
  if (admin) validateNewAdmin(admin);

  const seq = nextCompanySeq();
  const id = companyIdFor(seq);
  const fileName = `mysql:${schema.companyPrefix(id)}`;
  const prefix = schema.companyPrefix(id);
  const leftover = controlDb().raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").filter((r) => r.n.startsWith(prefix));
  if (leftover.length) throw httpError(409, `Tables for ${id} already exist in the database — refusing to overwrite them.`);

  const now = nowISO();
  const row = {
    id, seq, name, status: "active", is_primary: 0, db_file: fileName,
    contact_name: str(input.contactName), phone: str(input.phone), email: str(input.email),
    address: str(input.address), website: str(input.website), logo_data_url: input.logoDataUrl || null,
    notes: str(input.notes), created_at: now, created_by: actor?.name || "system",
  };
  let tenant;
  try {
    tenant = openTenantDb(id, { isPrimary: false }).db;
  } catch (e) {
    dropNewCompanyTables(id);
    throw e;
  }
  tenantCache.set(id, { companyId: id, file: companyFile({ id }), db: tenant });
  try {
    crun(`INSERT INTO companies (id, seq, name, status, is_primary, db_file, contact_name, phone, email, address, website, logo_data_url, notes, created_at, created_by, updated_at, updated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.seq, row.name, row.status, row.is_primary, row.db_file, row.contact_name, row.phone, row.email, row.address, row.website, row.logo_data_url, row.notes, now, row.created_by, now, row.created_by]);
  } catch (e) {
    tenantCache.delete(id);
    dropNewCompanyTables(id);
    throw e;
  }
  const company = getCompany(id);
  withCompany(company, () => {
    const { run } = require("./db");
    run(`UPDATE company_settings SET name = ?, tagline = ?, address = ?, phone = ?, email = ?, website = ?, logo_data_url = ?, updated_by = ?, updated_at = ? WHERE id = 1`,
      [name, str(input.tagline) || "", row.address || "", row.phone || "", row.email || "", row.website || "", row.logo_data_url, actor?.name || "system", now]);
    require("./domain").addAudit(actor ? { id: actor.id, name: actor.name, role: "super_admin" } : null, "Company registered", name);
  });
  platformAudit(actor, "Company registered", id, name);
  let adminUser = null;
  if (admin) adminUser = createCompanyAdmin(company, admin, actor);
  return { company: getCompany(id), adminUser };
}

// Removes the tables of a company whose creation failed part-way — ONLY a
// company that is not in the registry, and only tables holding nothing but
// the default seed (no user, no account, no ledger row). Anything else is
// left untouched and reported.
function dropNewCompanyTables(id) {
  if (getCompany(id)) return;
  const c = controlDb();
  const prefix = schema.companyPrefix(id);
  const present = new Set(c.raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((r) => r.n).filter((n) => n.startsWith(prefix)));
  for (const t of ["users", "clients", "account_ledger", "cash_ledger", "exchange_transactions", "transfers", "quotations", "expenses"]) {
    if (present.has(prefix + t) && c.raw(`SELECT COUNT(*) AS n FROM "${prefix + t}"`)[0].n > 0) {
      console.error(`[tenancy] Not removing tables of ${id}: ${t} has rows.`);
      return;
    }
  }
  for (const t of schema.companyTables(id).reverse()) {
    if (!present.has(t)) continue;
    try { c.raw(`DROP TABLE "${t}"`); } catch (e) { console.error(`[tenancy] Could not remove ${t}: ${e.message}`); }
  }
}

function validateNewAdmin(admin) {
  const uname = normalizeUsername(admin.username);
  if (!admin.name || !String(admin.name).trim() || !uname || !admin.password) throw httpError(400, "Company Admin needs a name, username and password.");
  if (!/^[a-z0-9._-]{3,40}$/.test(uname)) throw httpError(400, "Username may only use letters, numbers, dot, dash and underscore (3–40 characters).");
  { const pwErr = require("./auth").passwordPolicyError(String(admin.password), { username: uname }); if (pwErr) throw httpError(400, pwErr); }
  if (!isUsernameAvailable(uname)) throw httpError(409, "That username is already taken (usernames are unique across all companies).");
}

// Creates a new Company Admin user (the company's built-in "Admin" role)
// inside `company`'s own database and registers its username.
function createCompanyAdmin(company, admin, actor) {
  validateNewAdmin(admin);
  const uname = normalizeUsername(admin.username);
  const { hashPassword } = require("./auth");
  const { formatPersonName } = require("./util");
  return withCompany(company, () => {
    const { get, run } = require("./db");
    const role = get("SELECT * FROM roles WHERE key = 'admin'");
    if (!role) throw httpError(500, "This company has no Admin role.");
    const { hash, salt } = hashPassword(String(admin.password));
    const userId = uid("u");
    const name = formatPersonName(admin.name);
    run(`INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, last_login, created_at)
         VALUES (?,?,?,?,?,'admin',?,'active',1,1,NULL,?)`, [userId, name, uname, hash, salt, role.id, nowISO()]);
    registerDirectoryUser(uname, company.id, userId);
    require("./domain").addAudit(actor ? { id: actor.id, name: actor.name, role: "super_admin" } : null, "Company Admin assigned", `${name} (${uname})`);
    platformAudit(actor, "Company Admin created", company.id, `${name} (${uname})`);
    return get("SELECT id, name, username, role_id, status FROM users WHERE id = ?", [userId]);
  });
}

// Promotes an EXISTING user of `company` to the company's Admin role.
function promoteToCompanyAdmin(company, userId, actor) {
  return withCompany(company, () => {
    const { get, run } = require("./db");
    const role = get("SELECT * FROM roles WHERE key = 'admin'");
    const target = get("SELECT u.*, r.is_super_admin FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.deleted_at IS NULL", [userId]);
    if (!target) throw httpError(404, "User not found in this company.");
    if (target.is_super_admin) throw httpError(400, "That account is a platform Super Admin.");
    run("UPDATE users SET role_id = ?, role = 'admin', permissions_version = permissions_version + 1 WHERE id = ?", [role.id, userId]);
    require("./domain").addAudit(actor ? { id: actor.id, name: actor.name, role: "super_admin" } : null, "Company Admin assigned", `${target.name} (${target.username})`);
    platformAudit(actor, "Company Admin assigned", company.id, `${target.name} (${target.username})`);
    return get("SELECT id, name, username, role_id, status FROM users WHERE id = ?", [userId]);
  });
}

function updateCompany(company, input, actor) {
  const fields = {};
  if (input.name !== undefined) {
    const name = String(input.name || "").trim();
    if (!name) throw httpError(400, "Company name is required.");
    if (name.length > 160) throw httpError(400, "Company name is too long.");
    if (cget("SELECT id FROM companies WHERE lower(name) = lower(?) AND id != ?", [name, company.id])) throw httpError(409, "A company with that name already exists.");
    fields.name = name;
  }
  for (const [k, col] of [["contactName", "contact_name"], ["phone", "phone"], ["email", "email"], ["address", "address"], ["website", "website"], ["notes", "notes"]]) {
    if (input[k] !== undefined) fields[col] = str(input[k]);
  }
  if (input.logoDataUrl !== undefined) fields.logo_data_url = input.logoDataUrl || null;
  const cols = Object.keys(fields);
  if (!cols.length) return company;
  crun(`UPDATE companies SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`,
    [...cols.map((c) => fields[c]), nowISO(), actor?.name || "system", company.id]);
  // Mirror branding into the company's own Settings, which every PDF/Excel/
  // CSV export of that company reads its letterhead from.
  withCompany(getCompany(company.id), () => {
    const { get, run } = require("./db");
    const s = get("SELECT * FROM company_settings WHERE id = 1");
    run(`UPDATE company_settings SET name = ?, address = ?, phone = ?, email = ?, website = ?, logo_data_url = ?, updated_by = ?, updated_at = ? WHERE id = 1`,
      [fields.name ?? s.name, fields.address ?? s.address, fields.phone ?? s.phone, fields.email ?? s.email, fields.website ?? s.website,
       fields.logo_data_url !== undefined ? fields.logo_data_url : s.logo_data_url, actor?.name || "system", nowISO()]);
    require("./domain").addAudit(actor ? { id: actor.id, name: actor.name, role: "super_admin" } : null, "Company profile updated (Super Admin)", cols.join(", "));
  });
  platformAudit(actor, "Company updated", company.id, cols.join(", "));
  return getCompany(company.id);
}

const COMPANY_ACTIONS = {
  deactivate: { flag: "deactivated", value: 1, audit: "Company deactivated" },
  activate: { flag: "deactivated", value: 0, audit: "Company activated" },
  suspend: { flag: "suspended", value: 1, audit: "Company suspended" },
  unsuspend: { flag: "suspended", value: 0, audit: "Company unsuspended" },
};
// Applies ONE action to ONE company — only that company's row changes.
function applyCompanyAction(company, action, reason, actor) {
  const a = COMPANY_ACTIONS[action];
  if (!a) throw httpError(400, `Action must be one of: ${Object.keys(COMPANY_ACTIONS).join(", ")}.`);
  const current = getCompany(company.id);
  if (!!current[a.flag] === !!a.value) {
    throw httpError(409, `${current.name} is already ${a.flag === "deactivated" ? (a.value ? "deactivated" : "active") : (a.value ? "suspended" : "not suspended")}.`);
  }
  if (a.value && a.flag === "suspended" && !str(reason)) throw httpError(400, "Please give a reason for the suspension.");
  const now = nowISO(), who = actor?.name || "system";
  const deactivated = a.flag === "deactivated" ? a.value : current.deactivated;
  const suspended = a.flag === "suspended" ? a.value : current.suspended;
  const status = derivedStatus(deactivated, suspended);
  ctx(() => {
    crun(`UPDATE companies SET ${a.flag} = ?, ${a.flag}_reason = ?, ${a.flag}_at = ?, ${a.flag}_by = ?,
          status = ?, status_reason = ?, status_changed_at = ?, status_changed_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [a.value, a.value ? str(reason) : null, now, who, status,
       status === "active" ? null : (status === "inactive" ? (a.flag === "deactivated" ? str(reason) : current.deactivated_reason) : (a.flag === "suspended" ? str(reason) : current.suspended_reason)),
       now, who, now, who, company.id]);
    platformAudit(actor, a.audit, company.id, reason || "");
  });
  return getCompany(company.id);
}
// Backwards-compatible: a plain target status maps onto the two switches.
function setCompanyStatus(company, status, reason, actor) {
  if (!COMPANY_STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${COMPANY_STATUSES.join(", ")}.`);
  const c = getCompany(company.id);
  if (status === "active") {
    if (c.suspended) applyCompanyAction(c, "unsuspend", reason, actor);
    if (getCompany(c.id).deactivated) applyCompanyAction(c, "activate", reason, actor);
  } else if (status === "inactive" && !c.deactivated) applyCompanyAction(c, "deactivate", reason, actor);
  else if (status === "suspended" && !c.suspended) applyCompanyAction(c, "suspend", reason || "Suspended", actor);
  return getCompany(company.id);
}

function str(v) { return v === undefined || v === null ? null : String(v).trim() || null; }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = {
  COMPANY_STATUSES,
  controlDb, cget, call, crun, ctx,
  bootstrap, useScriptTenant,
  getCompany, listCompanies, primaryCompany, companyFile, openTenant, withCompany, publicCompany,
  isUsernameAvailable, registerDirectoryUser, lookupDirectory, normalizeUsername, syncDirectoryForCompany,
  getPlatformUser, getPlatformUserByUsername, ensureShadowUser,
  createCompany, createCompanyAdmin, promoteToCompanyAdmin, updateCompany, setCompanyStatus, applyCompanyAction, companyAccessMessage,
  syncRegistryFromSettings, platformAudit, httpError,
};
