"use strict";
// ACCOUNT-LEVEL ACCESS round — managing access to individual accounts for
// one user (Users -> a user -> Account Access) and for a whole ROLE
// (Roles & Permissions -> a role -> Account Access).
//   GET   /api/roles/:id/account-access    same, for everyone holding the role
//   PATCH /api/roles/:id/account-access    same body (needs roles.managePermissions;
//                                           not the Super Admin role, not the
//                                           administrator's own role, not a
//                                           protected role unless Super Admin)
// A user's effective level = the most restrictive of their role's level and
// their own level on that account.
//   GET   /api/users/:id/account-access    the accounts the administrator
//                                           may manage, with this user's level
//   PATCH /api/users/:id/account-access    { changes: [{ accountId, level }],
//                                           confirmRemoval?, note? }
// Rules (enforced here, never only in the screen):
//   * needs users.managePermissions (Super Admin always has it);
//   * nobody changes their own account access;
//   * a Super Admin's access can't be restricted, and only a Super Admin
//     manages another Super Admin (rbac.assertCanManageUser);
//   * an administrator only sees and sets accounts inside their own scope
//     (currencies they hold, accounts they can see) and never grants more
//     than their own level on that account;
//   * taking access away from an account the user has worked on needs an
//     explicit confirmation;
//   * every change is written to the company audit log (who, whom, which
//     account, before -> after, note).
// Levels only ever restrict: the user's role permissions still apply.
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, allowedCurrencies, assertCanManageUser, loadRoleForUser, auditDenied, isSuperAdmin } = require("../rbac");
const { addAudit } = require("../domain");
const { uid, nowISO } = require("../util");
const access = require("../account-access");

// Accounts the user has worked on (any posting they made touching it).
function usedAccountIds(userId) {
  const ids = new Set();
  for (const r of all("SELECT DISTINCT client_id AS id FROM account_ledger WHERE staff_id = ?", [userId])) ids.add(r.id);
  for (const r of all("SELECT client_id, from_account_id, to_account_id FROM exchange_transactions WHERE staff_id = ?", [userId])) [r.client_id, r.from_account_id, r.to_account_id].forEach((x) => x && ids.add(x));
  for (const r of all("SELECT from_account_id, to_account_id FROM transfers WHERE staff_id = ?", [userId])) [r.from_account_id, r.to_account_id].forEach((x) => x && ids.add(x));
  return ids;
}

function loadTarget(req, res, params) {
  const actor = requireAuth(req, res); if (!actor) return null;
  if (!requirePerm(actor, res, "users.managePermissions")) return null;
  const target = get("SELECT id, name, username, role, role_id, status, active FROM users WHERE id = ?", [params.id]);
  if (!target) { notFound(res, "User not found."); return null; }
  return { actor, target, targetRole: loadRoleForUser(target) };
}

// Validates a change list against the administrator's own scope and returns
// { plan, needConfirm } or answers the request itself (returns null).
function planChanges(actor, res, changes, current, used) {
  if (!Array.isArray(changes) || !changes.length) { badRequest(res, "No changes to save."); return null; }
  if (changes.length > 5000) { badRequest(res, "Too many changes at once — save in smaller groups."); return null; }
  const allowed = allowedCurrencies(actor);
  const plan = [], needConfirm = [], seen = new Set();
  for (const c of changes) {
    const accountId = c && typeof c.accountId === "string" ? c.accountId : null;
    const level = c && typeof c.level === "string" ? c.level : null;
    if (!accountId || !access.LEVELS.includes(level)) { badRequest(res, "Each change needs an account and one of: full, view, credit, debit, none."); return null; }
    if (seen.has(accountId)) { badRequest(res, "The same account appears twice in one save."); return null; }
    seen.add(accountId);
    const a = get("SELECT id, name, account_number, currency, deleted_at FROM clients WHERE id = ?", [accountId]);
    if (!a || a.deleted_at || !allowed.includes(a.currency) || !access.canView(actor, a.id)) { notFound(res, "Account not found."); return null; }
    const ceiling = access.levelFor(actor, a.id);
    if (!access.levelWithin(level, ceiling)) {
      auditDenied(actor, `tried to grant ${access.LEVEL_LABELS[level]} on ${a.account_number} beyond own ${access.LEVEL_LABELS[ceiling]}`);
      sendJSON(res, 403, { error: `You can't grant ${access.LEVEL_LABELS[level]} on ${a.account_number} — your own access to it is ${access.LEVEL_LABELS[ceiling]}.` });
      return null;
    }
    const before = current.get(a.id) || "full";
    if (before === level) continue;
    const lost = ["view", "credit", "debit"].filter((k) => access.ALLOWS[before][k] && !access.ALLOWS[level][k]);
    if (lost.length && used.has(a.id)) needConfirm.push({ accountId: a.id, accountNumber: a.account_number, name: a.name, currency: a.currency, from: before, to: level });
    plan.push({ a, before, level });
  }
  return { plan, needConfirm };
}

function loadRoleTarget(req, res, params, write) {
  const actor = requireAuth(req, res); if (!actor) return null;
  if (!requirePerm(actor, res, write ? "roles.managePermissions" : "roles.view")) return null;
  const role = get("SELECT * FROM roles WHERE id = ?", [params.id]);
  if (!role) { notFound(res, "Role not found."); return null; }
  return { actor, role };
}
// Why this administrator can't change the role's account access (null = can).
function roleLock(actor, role) {
  if (role.is_super_admin) return "The Super Admin role always has full access to every account; it can't be restricted.";
  if (!isSuperAdmin(actor)) {
    const own = loadRoleForUser(actor);
    if (own && own.id === role.id) return "You can't change the account access of your own role — ask a Super Admin.";
    if (role.is_protected) return `The ${role.name} role is a protected built-in role — only a Super Admin can change its account access.`;
  }
  return null;
}

function register(router) {
  router.get("/api/roles/:id/account-access", (req, res, params, query) => {
    const ctx = loadRoleTarget(req, res, params, false); if (!ctx) return;
    const { actor, role } = ctx;
    const allowed = allowedCurrencies(actor);
    const clauses = ["deleted_at IS NULL"], p = [];
    clauses.push(allowed.length ? `currency IN (${allowed.map(() => "?").join(",")})` : "1 = 0"); p.push(...allowed);
    if (query.currency === "USD" || query.currency === "SLSH") { clauses.push("currency = ?"); p.push(query.currency); }
    if (query.type === "customer" || query.type === "company") { clauses.push("account_type = ?"); p.push(query.type); }
    if (query.search) { clauses.push("(name LIKE ? OR account_number LIKE ? OR contact LIKE ?)"); const s = `%${String(query.search).slice(0, 100)}%`; p.push(s, s, s); }
    const rows = all(`SELECT id, name, account_number, account_type, currency, status FROM clients WHERE ${clauses.join(" AND ")} ORDER BY name ASC, currency ASC`, p).filter((a) => access.canView(actor, a.id));
    const levels = new Map(all("SELECT account_id, level, updated_at, updated_by FROM role_account_access WHERE role_id = ?", [role.id]).map((r) => [r.account_id, r]));
    let accounts = rows.map((a) => {
      const row = levels.get(a.id);
      const level = role.is_super_admin ? "full" : row ? row.level : "full";
      return { id: a.id, name: a.name, accountNumber: a.account_number, accountType: a.account_type, currency: a.currency, status: a.status || "active", level, label: access.LEVEL_LABELS[level], explicit: !!row, updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null, maxLevel: access.levelFor(actor, a.id) };
    });
    if (access.LEVELS.includes(query.level)) accounts = accounts.filter((a) => a.level === query.level);
    const counts = Object.fromEntries(access.LEVELS.map((l) => [l, 0]));
    for (const a of accounts) counts[a.level] += 1;
    const lock = roleLock(actor, role);
    const holders = get("SELECT COUNT(*) AS n FROM users WHERE role_id = ? OR (role_id IS NULL AND role = ?)", [role.id, role.key]).n;
    sendJSON(res, 200, {
      role: { id: role.id, name: role.name, key: role.key, isSuperAdmin: !!role.is_super_admin, isProtected: !!role.is_protected, users: holders },
      accounts, counts, levels: access.LEVELS.map((l) => ({ key: l, label: access.LEVEL_LABELS[l], ...access.ALLOWS[l] })),
      canEdit: !lock && require("../rbac").can(actor, "roles.managePermissions"), reason: lock,
    });
  });

  router.patch("/api/roles/:id/account-access", async (req, res, params) => {
    const ctx = loadRoleTarget(req, res, params, true); if (!ctx) return;
    const { actor, role } = ctx;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const lock = roleLock(actor, role);
    if (lock) { auditDenied(actor, `tried to change account access of role ${role.name}`); return sendJSON(res, 403, { error: lock }); }
    const note = body.note === undefined || body.note === null ? "" : String(body.note).slice(0, 300);
    const current = new Map(all("SELECT account_id, level FROM role_account_access WHERE role_id = ?", [role.id]).map((r) => [r.account_id, r.level]));
    // Accounts any holder of the role has worked on.
    const used = new Set();
    for (const u of all("SELECT id FROM users WHERE role_id = ? OR (role_id IS NULL AND role = ?)", [role.id, role.key])) for (const id of usedAccountIds(u.id)) used.add(id);
    const out = planChanges(actor, res, body.changes, current, used); if (!out) return;
    const { plan, needConfirm } = out;
    if (needConfirm.length && body.confirmRemoval !== true) {
      return sendJSON(res, 409, { error: `Users with the ${role.name} role have worked on ${needConfirm.length} of these account(s). Confirm to remove the access.`, code: "CONFIRM_REMOVAL", needsConfirmation: needConfirm });
    }
    const at = nowISO();
    tx(() => {
      for (const { a, before, level } of plan) {
        if (level === "full") run("DELETE FROM role_account_access WHERE role_id = ? AND account_id = ?", [role.id, a.id]);
        else if (current.has(a.id)) run("UPDATE role_account_access SET level = ?, updated_at = ?, updated_by = ? WHERE role_id = ? AND account_id = ?", [level, at, actor.name, role.id, a.id]);
        else run("INSERT INTO role_account_access (id, role_id, account_id, level, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)", [uid("raa"), role.id, a.id, level, at, actor.name, at, actor.name]);
        addAudit(actor, "Role account access changed", `Role ${role.name} · ${a.account_number} ${a.name} (${a.currency}): ${access.LEVEL_LABELS[before]} -> ${access.LEVEL_LABELS[level]}${note ? ` — ${note}` : ""}`);
      }
    });
    sendJSON(res, 200, { changed: plan.length, unchanged: body.changes.length - plan.length });
  });

  router.get("/api/users/:id/account-access", (req, res, params, query) => {
    const ctx = loadTarget(req, res, params); if (!ctx) return;
    const { actor, target, targetRole } = ctx;
    const allowed = allowedCurrencies(actor);
    const clauses = ["deleted_at IS NULL"], p = [];
    clauses.push(allowed.length ? `currency IN (${allowed.map(() => "?").join(",")})` : "1 = 0"); p.push(...allowed);
    if (query.currency === "USD" || query.currency === "SLSH") { clauses.push("currency = ?"); p.push(query.currency); }
    if (query.type === "customer" || query.type === "company") { clauses.push("account_type = ?"); p.push(query.type); }
    if (query.search) { clauses.push("(name LIKE ? OR account_number LIKE ? OR contact LIKE ?)"); const s = `%${String(query.search).slice(0, 100)}%`; p.push(s, s, s); }
    const rows = all(`SELECT id, name, account_number, account_type, currency, status, balance_usd, balance_slsh FROM clients WHERE ${clauses.join(" AND ")} ORDER BY name ASC, currency ASC`, p)
      .filter((a) => access.canView(actor, a.id));
    const targetIsSuper = !!(targetRole && targetRole.is_super_admin);
    const levels = new Map(all("SELECT account_id, level, updated_at, updated_by FROM user_account_access WHERE user_id = ?", [target.id]).map((r) => [r.account_id, r]));
    const roleLevels = new Map(targetRole ? all("SELECT account_id, level FROM role_account_access WHERE role_id = ?", [targetRole.id]).map((r) => [r.account_id, r.level]) : []);
    const used = usedAccountIds(target.id);
    let accounts = rows.map((a) => {
      const row = levels.get(a.id);
      const level = targetIsSuper ? "full" : row ? row.level : "full";
      return {
        id: a.id, name: a.name, accountNumber: a.account_number, accountType: a.account_type, currency: a.currency, status: a.status || "active",
        level, label: access.LEVEL_LABELS[level], explicit: !!row, updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null,
        roleLevel: targetIsSuper ? "full" : roleLevels.get(a.id) || "full",
        effectiveLevel: targetIsSuper ? "full" : access.stricter(roleLevels.get(a.id) || "full", level),
        usedByUser: used.has(a.id), maxLevel: access.levelFor(actor, a.id),
      };
    });
    if (access.LEVELS.includes(query.level)) accounts = accounts.filter((a) => a.level === query.level);
    const counts = Object.fromEntries(access.LEVELS.map((l) => [l, 0]));
    for (const a of accounts) counts[a.level] += 1;
    const self = target.id === actor.id;
    sendJSON(res, 200, {
      user: { id: target.id, name: target.name, username: target.username, role: targetRole ? targetRole.name : null, isSuperAdmin: targetIsSuper },
      accounts, counts, levels: access.LEVELS.map((l) => ({ key: l, label: access.LEVEL_LABELS[l], ...access.ALLOWS[l] })),
      canEdit: !self && !targetIsSuper,
      reason: self ? "You can't change your own account access." : targetIsSuper ? "A Super Admin always has full access to every account." : null,
    });
  });

  router.patch("/api/users/:id/account-access", async (req, res, params) => {
    const ctx = loadTarget(req, res, params); if (!ctx) return;
    const { actor, target, targetRole } = ctx;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (target.id === actor.id) { auditDenied(actor, "tried to change own account access"); return sendJSON(res, 403, { error: "You can't change your own account access — ask another administrator." }); }
    if (targetRole && targetRole.is_super_admin) return sendJSON(res, 403, { error: "A Super Admin always has full access to every account; it can't be restricted." });
    if (!assertCanManageUser(actor, target, res)) return;
    const note = body.note === undefined || body.note === null ? "" : String(body.note).slice(0, 300);
    const current = new Map(all("SELECT account_id, level FROM user_account_access WHERE user_id = ?", [target.id]).map((r) => [r.account_id, r.level]));
    const out = planChanges(actor, res, body.changes, current, usedAccountIds(target.id)); if (!out) return;
    const { plan, needConfirm } = out;
    if (needConfirm.length && body.confirmRemoval !== true) {
      return sendJSON(res, 409, { error: `${target.name} has worked on ${needConfirm.length} of these account(s). Confirm to remove the access.`, code: "CONFIRM_REMOVAL", needsConfirmation: needConfirm });
    }
    const at = nowISO();
    tx(() => {
      for (const { a, before, level } of plan) {
        if (level === "full") run("DELETE FROM user_account_access WHERE user_id = ? AND account_id = ?", [target.id, a.id]);
        else if (current.has(a.id)) run("UPDATE user_account_access SET level = ?, updated_at = ?, updated_by = ? WHERE user_id = ? AND account_id = ?", [level, at, actor.name, target.id, a.id]);
        else run("INSERT INTO user_account_access (id, user_id, account_id, level, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)", [uid("uaa"), target.id, a.id, level, at, actor.name, at, actor.name]);
        addAudit(actor, "Account access changed", `${target.name} (${target.username}) · ${a.account_number} ${a.name} (${a.currency}): ${access.LEVEL_LABELS[before]} -> ${access.LEVEL_LABELS[level]}${note ? ` — ${note}` : ""}`);
      }
    });
    sendJSON(res, 200, { changed: plan.length, unchanged: body.changes.length - plan.length });
  });
}

module.exports = { register };
