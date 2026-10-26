"use strict";
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, ROLE_LABELS, PERMS, assertCanManageUser, loadRoleForUser, roleDisplayName, requireRoleWithinActorScope, isSuperAdmin } = require("../rbac");
const tenancy = require("../tenancy");
const { currentCompany } = require("../tenant-context");

function isSuperAdminRole(role) { return !!(role && role.is_super_admin); }
const { addAudit } = require("../domain");
const { uid, nowISO, formatPersonName } = require("../util");
const authLib = require("../auth");
const { publicUser } = require("./auth");

// The legacy `role` column's CHECK constraint (schema.sql) only ever
// allowed these 6 values — still true, untouched this round. Kept for the
// legacy body.role create/update path so the current frontend (not yet
// updated to send role_id — that's the Phase 3 sweep) keeps working
// unchanged.
const VALID_ROLES = Object.keys(PERMS);
const LEGACY_ROLE_KEYS = new Set(VALID_ROLES);

// Resolves the role a create/update request is asking for, from either the
// new `roleId` field or the legacy `role` string field (roleId wins if
// both are present — it's unambiguous, `role` only names one of the 6
// original roles). Returns { role, error } — error is a user-facing string
// when neither field resolves to a real row.
function resolveRequestedRole(body) {
  if (body.roleId !== undefined) {
    const role = get("SELECT * FROM roles WHERE id = ?", [body.roleId]);
    if (!role) return { error: "Unknown roleId." };
    return { role };
  }
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role)) return { error: `Role must be one of: ${VALID_ROLES.join(", ")}` };
    const role = get("SELECT * FROM roles WHERE key = ?", [body.role]);
    if (!role) return { error: "Unknown role." };
    return { role };
  }
  return { role: null }; // not being changed
}

// The best-effort legacy `role` label to keep on the row alongside the
// real `role_id` — matches the role's own key when it's one of the 6
// legacy values, falls back to 'admin' for Super Admin (same precedent as
// the super.admin bootstrap user in src/db.js), and otherwise (a Phase 2
// custom role with no legacy equivalent at all) leaves whatever value is
// already there — schema.sql documents this column as never authoritative
// for a security decision post-RBAC-round, so an unchanged stale label is
// harmless, while inventing one would be actively misleading.
function legacyRoleLabelFor(role, fallbackCurrentValue) {
  if (LEGACY_ROLE_KEYS.has(role.key)) return role.key;
  if (role.is_super_admin) return "admin";
  return fallbackCurrentValue || "viewer";
}

function register(router) {
  router.get("/api/users", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users")) return;
    // MULTI-COMPANY round: Super Admin rows in a company database are platform
    // accounts' in-company identities (managed from the Companies console,
    // not here) — a Company Admin/staff never sees them in their user list.
    const rows = all(isSuperAdmin(user)
      ? "SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC"
      : `SELECT u.* FROM users u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.deleted_at IS NULL AND COALESCE(r.is_super_admin, 0) = 0 ORDER BY u.created_at ASC`);
    sendJSON(res, 200, { users: rows.map(publicUser) });
  });

  router.post("/api/users", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const { username, password } = body;
    // Users are always people — the name is unconditionally uppercased.
    const name = formatPersonName(body.name);
    if (!name || !username || !password) return badRequest(res, "Name, username, and password are required.");
    const { role: requestedRole, error: roleError } = resolveRequestedRole(body);
    if (roleError) return badRequest(res, roleError);
    if (!requestedRole) return badRequest(res, `Role must be one of: ${VALID_ROLES.join(", ")}`);
    // USER ROLE EDIT FIX round: Super Admin is no longer assignable from
    // Users management at all — by explicit decision, it stays locked to
    // the accounts that already hold it (the bootstrapped super.admin
    // account, plus whichever others already had it before this round).
    // This is unconditional (not even a Super Admin actor is exempt),
    // replacing the old "only a Super Admin can grant Super Admin" rule —
    // enforced here (not just hidden in the Role dropdown — see app.jsx's
    // matching `assignable` filter) so it can't be bypassed by a raw API
    // call either.
    if (requestedRole.is_super_admin) {
      return badRequest(res, "Super Admin can't be assigned from here — it's reserved for the accounts that already hold it.");
    }
    // ROLE STATUS (Phase 2): an inactive role can never be handed to a
    // brand-new user — only reactivating the role, or picking a different
    // one, unblocks this.
    if (requestedRole.status === "inactive") {
      return badRequest(res, `The "${requestedRole.name}" role is inactive and can't be assigned. Reactivate it first, or choose a different role.`);
    }
    // NO PRIVILEGE ESCALATION: assigning a role hands the new user
    // everything that role grants — an Admin can never hand out a role
    // carrying more than their own effective permissions (Super Admin is
    // already blocked above regardless of scope).
    if (!requireRoleWithinActorScope(user, res, requestedRole)) return;
    { const pwErr = authLib.passwordPolicyError(password, { username }); if (pwErr) return badRequest(res, pwErr); }
    const uname = String(username).toLowerCase();
    if (get("SELECT id FROM users WHERE username = ?", [uname])) return badRequest(res, "Username already exists.");
    // MULTI-COMPANY round: usernames are unique across ALL companies (login
    // finds a user's company from their username alone).
    if (!tenancy.isUsernameAvailable(uname)) return badRequest(res, "Username already exists.");

    const { hash, salt } = authLib.hashPassword(password);
    const id = uid("u");
    const legacyRole = legacyRoleLabelFor(requestedRole, "viewer");
    run(
      "INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, last_login, created_at) VALUES (?,?,?,?,?,?,?, 'active', 1, 1, NULL, ?)",
      [id, name, uname, hash, salt, legacyRole, requestedRole.id, nowISO()]
    );
    tenancy.registerDirectoryUser(uname, currentCompany().id, id);
    addAudit(user, "User created", `${name} (${requestedRole.name})`);
    sendJSON(res, 201, { user: publicUser(get("SELECT * FROM users WHERE id = ?", [id])) });
  });

  router.patch("/api/users/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users")) return;
    const target = get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [params.id]);
    if (!target) return notFound(res, "User not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }

    // MULTI-COMPANY round: a Super Admin row here is a platform account —
    // its credentials and status live in the control database, so editing
    // this in-company copy would silently do nothing useful.
    if (isSuperAdminRole(loadRoleForUser(target))) {
      if (!isSuperAdmin(user)) return sendJSON(res, 403, { error: "Only a Super Admin can manage another Super Admin's account." });
      return badRequest(res, "Super Admin accounts are platform accounts — manage them from the Super Admin console.");
    }
    // --- resolve what's actually changing before touching anything ---
    const { role: requestedRole, error: roleError } = resolveRequestedRole(body);
    if (roleError) return badRequest(res, roleError);
    const currentRole = loadRoleForUser(target);
    const roleChanging = !!requestedRole && requestedRole.id !== target.role_id;

    // status: prefer the new 3-state `status` field; fall back to the
    // legacy boolean `active` the current frontend still sends (mapped
    // onto 'active'/'deactivated' — 'suspended' has no legacy equivalent
    // and can only be reached via the new `status` field). When NEITHER is
    // present, status/active are left completely untouched below — they
    // must never be silently recomputed from each other on an unrelated
    // update (e.g. a plain name edit), which would risk quietly
    // reactivating someone who was deactivated before this column existed.
    const statusTouched = body.status !== undefined || body.active !== undefined;
    let requestedStatus = target.status;
    if (body.status !== undefined) {
      if (!["active", "deactivated", "suspended"].includes(body.status)) {
        return badRequest(res, "Status must be one of: active, deactivated, suspended.");
      }
      requestedStatus = body.status;
    } else if (body.active !== undefined) {
      requestedStatus = body.active ? "active" : "deactivated";
    }
    const statusChanging = statusTouched && requestedStatus !== target.status;
    const losingActiveAccess = statusChanging && target.status === "active" && requestedStatus !== "active";

    if (target.id === user.id && losingActiveAccess) {
      return badRequest(res, "You cannot deactivate your own account.");
    }

    // --- SUPER ADMIN PROTECTION ---
    // Anything that touches an existing Super Admin at all requires the
    // actor to be one too; anything that would take Super Admin status or
    // access away is additionally refused if it would leave zero left.
    const removingSuperAdminStatus =
      (currentRole && currentRole.is_super_admin && roleChanging && requestedRole && !requestedRole.is_super_admin) ||
      (currentRole && currentRole.is_super_admin && losingActiveAccess);
    if ((currentRole && currentRole.is_super_admin) || removingSuperAdminStatus) {
      if (!assertCanManageUser(user, target, res, { removingSuperAdminStatus })) return;
    }
    // USER ROLE EDIT FIX round: promoting anyone TO Super Admin via this
    // endpoint is blocked unconditionally now — see the matching comment on
    // the POST handler above for why (no actor exemption, including a
    // Super Admin actor).
    if (roleChanging && requestedRole.is_super_admin) {
      return badRequest(res, "Super Admin can't be assigned from here — it's reserved for the accounts that already hold it.");
    }
    // ROLE STATUS (Phase 2): only blocks NEWLY assigning an inactive role —
    // a user already holding one (roleChanging === false here) is left
    // completely alone by this check, per "existing users assigned to an
    // inactive role must be handled safely," never silently stripped.
    if (roleChanging && requestedRole.status === "inactive") {
      return badRequest(res, `The "${requestedRole.name}" role is inactive and can't be assigned. Reactivate it first, or choose a different role.`);
    }
    // NO PRIVILEGE ESCALATION: same rule as user creation — reassigning
    // someone to a role can never hand them more than the actor themselves
    // effectively has.
    if (roleChanging && !requireRoleWithinActorScope(user, res, requestedRole)) return;

    // Users are always people — the name is unconditionally uppercased.
    const name = body.name !== undefined ? formatPersonName(body.name) : target.name;
    // Only recomputed when actually requested (see statusTouched above) —
    // otherwise kept byte-identical to what's already on the row.
    const active = statusTouched ? (requestedStatus === "active" ? 1 : 0) : target.active;

    let hash = target.password_hash, salt = target.password_salt;
    if (body.password) {
      const pwErr = authLib.passwordPolicyError(body.password, { username: target.username });
      if (pwErr) return badRequest(res, pwErr);
      const h = authLib.hashPassword(body.password);
      hash = h.hash; salt = h.salt;
    }

    const legacyRole = roleChanging ? legacyRoleLabelFor(requestedRole, target.role) : target.role;
    const roleId = roleChanging ? requestedRole.id : target.role_id;

    tx(() => {
      run(
        "UPDATE users SET name=?, role=?, role_id=?, status=?, active=?, password_hash=?, password_salt=? WHERE id=?",
        [name, legacyRole, roleId, requestedStatus, active, hash, salt, target.id]
      );
      // SECURITY AUDIT round: a password reset (typically after a suspected
      // compromise) or a role change must end every existing session of
      // that user immediately — bumping this makes requireAuth reject their
      // current tokens on the very next request.
      if (roleChanging || body.password) {
        // SESSION SECURITY: a role reassignment must take effect
        // immediately, not on next natural token expiry — bumping this
        // forces requireAuth to reject the user's current session token
        // on their very next request (see src/rbac.js).
        run("UPDATE users SET permissions_version = permissions_version + 1 WHERE id = ?", [target.id]);
      }
    });

    // One audit entry, summarizing every field that actually changed —
    // matches the pattern used by routes/roles.js's role PATCH.
    const changeParts = [];
    if (body.name !== undefined && name !== target.name) changeParts.push(`name "${target.name}" -> "${name}"`);
    if (roleChanging) changeParts.push(`role "${roleDisplayName(target)}" -> "${requestedRole.name}"`);
    if (statusChanging) changeParts.push(`status "${target.status}" -> "${requestedStatus}"`);
    if (body.password) changeParts.push("password reset");
    addAudit(user, "User updated", changeParts.length ? `${name}: ${changeParts.join("; ")}` : name);

    sendJSON(res, 200, { user: publicUser(get("SELECT * FROM users WHERE id = ?", [target.id])) });
  });

  // Permanent delete — mirrors accounts.js's own account-delete pattern
  // exactly: only reachable from an already-deactivated/suspended state,
  // requires typing the exact username to confirm, and is a SOFT delete
  // (deleted_at/deleted_by) — never a real SQL DELETE, since
  // exchange_transactions.staff_id, quotations.created_by,
  // exchange_rates.set_by, and transfers.staff_id all hold real FK
  // references to users(id); a hard delete would either fail those or
  // orphan real financial history. A brand-new capability with no legacy
  // equivalent, so it's gated by the granular key directly rather than
  // through the legacy "users" shim (see src/permissions.js).
  router.delete("/api/users/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users.delete")) return;
    const target = get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [params.id]);
    if (!target) return notFound(res, "User not found.");
    if (target.id === user.id) return badRequest(res, "You cannot delete your own account.");
    if (target.active || target.status === "active") {
      return badRequest(res, "Only a deactivated or suspended user can be permanently deleted. Deactivate them first.");
    }
    if (!assertCanManageUser(user, target, res, { removingSuperAdminStatus: true })) return;
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* confirmation text optional */ }
    if (!body || body.confirmUsername !== target.username) {
      return badRequest(res, "Type the user's exact username to confirm permanent deletion.");
    }
    run("UPDATE users SET deleted_at = ?, deleted_by = ? WHERE id = ?", [nowISO(), user.name, target.id]);
    addAudit(user, "User permanently deleted", `${target.name} (${target.username})`);
    sendJSON(res, 200, { ok: true });
  });
}

module.exports = { register };
