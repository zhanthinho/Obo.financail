"use strict";
const auth = require("./auth");
const { get, all } = require("./db");
const { sendJSON } = require("./http-helpers");
const { LEGACY_KEY_MAP, isValidPermissionKey } = require("./permissions");
const tenantContext = require("./tenant-context");

// Legacy fixed-role label table — kept only as a fallback for the legacy
// `role` column (e.g. if a user row somehow has no role_id yet) and for
// VALID_ROLES in routes/users.js until that file is rewritten to use the
// dynamic `roles` table directly (Task #57). Real role display/validation
// should go through the `roles` table (see roleDisplayName below), not this.
const ROLE_LABELS = {
  admin: "Admin",
  manager: "Manager",
  accountant: "Accountant",
  cashier: "Cashier / Teller",
  sales: "Sales Staff",
  viewer: "Viewer / Auditor",
};

// Legacy fixed PERMS table — no longer consulted by can()/requirePerm()
// below (see resolveUserPermissions), kept only so routes/users.js's
// `VALID_ROLES = Object.keys(PERMS)` keeps working until Task #57 replaces
// it with the live `roles` table. Do not add new keys here; the real,
// editable source of truth is now role_permissions (see src/permissions.js
// and src/db.js's one-time seed).
const PERMS = {
  admin: { users: true, rateManage: true, exchangeCreate: true, exchangeAll: true, exchangeUpdate: true, exchangeDelete: true, transferUpdate: true, transferDelete: true, quotationsManage: true, quotationsApprove: true, quotationsDelete: true, reports: true, accountsManage: true, accountsDelete: true, settingsManage: true },
  manager: { users: false, rateManage: true, exchangeCreate: false, exchangeAll: true, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: true, quotationsDelete: true, reports: true, accountsManage: true, accountsDelete: true, settingsManage: false },
  accountant: { users: false, rateManage: false, exchangeCreate: true, exchangeAll: true, exchangeUpdate: true, exchangeDelete: true, transferUpdate: true, transferDelete: true, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: true, accountsManage: true, accountsDelete: false, settingsManage: false },
  cashier: { users: false, rateManage: false, exchangeCreate: true, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: false, accountsManage: false, accountsDelete: false, settingsManage: false },
  sales: { users: false, rateManage: false, exchangeCreate: false, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: true, quotationsApprove: false, quotationsDelete: false, reports: false, accountsManage: true, accountsDelete: false, settingsManage: false },
  viewer: { users: false, rateManage: false, exchangeCreate: false, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: true, accountsManage: false, accountsDelete: false, settingsManage: false },
};

// ---------------------------------------------------------------------
// DYNAMIC PERMISSION ENGINE
// SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 1.
//
// Real source of truth from here on: roles / role_permissions /
// user_permission_overrides (see schema.sql). The 50+ call sites across
// routes/*.js keep checking the SAME OLD coarse keys ("accountsManage",
// "reports", etc.) unchanged — LEGACY_KEY_MAP (src/permissions.js)
// translates each into the granular key(s) that must ALL be granted for it
// to resolve true, so this round is a resolution-engine swap with zero
// visible behavior change. Call sites switch to checking granular keys
// directly in a later round (Phase 3), once a real Role Management UI
// (Phase 2) exists to grant them.
// ---------------------------------------------------------------------

// Sentinel returned by resolveUserPermissions for a Super Admin — never a
// Set of keys, so it can never be accidentally narrowed by an override and
// a missing/corrupt role_permissions table can never restrict it either.
const ALL_ACCESS = Symbol("rbac.all-access");

function loadRoleById(roleId) {
  if (!roleId) return null;
  return get("SELECT * FROM roles WHERE id = ?", [roleId]);
}

// Resolves the role for a user row, preferring role_id (the real source of
// truth) but falling back to looking the role up by its `key` matching the
// user's legacy `role` column when role_id is unset. This matters because
// not every place a user row gets INSERTed sets role_id yet — scripts/
// seed.js's demo-data inserts and routes/users.js's POST /api/users both
// still only set the legacy `role` column (they're rewritten to set
// role_id directly in Task #57) — without this fallback, any such user
// would silently resolve to zero permissions everywhere, since a NULL
// role_id would otherwise mean "no role, no grants." The legacy `role`
// column's CHECK constraint only allows the 6 keys every one of ROLE_DEFS
// (src/db.js) already seeds a matching roles row for, so this always finds
// a real role for any row that passed that constraint.
function loadRoleForUser(userRow) {
  if (!userRow) return null;
  if (userRow.role_id) {
    const byId = loadRoleById(userRow.role_id);
    if (byId) return byId;
  }
  if (userRow.role) return get("SELECT * FROM roles WHERE key = ?", [userRow.role]);
  return null;
}

// Computes what a user effectively holds: ALL_ACCESS for a Super Admin
// (short-circuits before any table lookup below it — must never be
// restricted even if role_permissions/user_permission_overrides data is
// missing or corrupted), otherwise the role's granted keys with per-user
// overrides layered on top (granted=1 adds a key beyond the role even if
// the role doesn't have it; granted=0 is an explicit deny even if the role
// would otherwise allow it — see "Custom Permission Override" in the spec).
// `role`, if already looked up by the caller (requireAuth does, to also
// read its permissions_version for session revalidation), is reused
// instead of querying it again; pass nothing to have it resolved here.
function resolveUserPermissions(userRow, role) {
  if (!userRow) return new Set();
  if (role === undefined) role = loadRoleForUser(userRow);
  if (role && role.is_super_admin) return ALL_ACCESS;
  const keys = new Set();
  if (role) {
    for (const row of all("SELECT permission_key FROM role_permissions WHERE role_id = ?", [role.id])) {
      keys.add(row.permission_key);
    }
  }
  for (const row of all("SELECT permission_key, granted FROM user_permission_overrides WHERE user_id = ?", [userRow.id])) {
    if (row.granted) keys.add(row.permission_key);
    else keys.delete(row.permission_key);
  }
  return keys;
}

// True if `granted` (a Set from resolveUserPermissions, or ALL_ACCESS)
// satisfies `key`. `key` may be a granular "module.action" key, or one of
// the old coarse legacy keys — translated via LEGACY_KEY_MAP, requiring
// ALL of its mapped granular keys to be present (see the map's own
// comments for why each legacy key resolves the way it does). An
// unrecognized key fails closed (never silently allowed) rather than
// throwing, since a typo'd permission key should deny, not crash a route.
function keysSatisfy(granted, key) {
  if (granted === ALL_ACCESS) return true;
  if (isValidPermissionKey(key)) return granted.has(key);
  const mapped = LEGACY_KEY_MAP[key];
  if (!mapped || mapped.length === 0) return false;
  return mapped.every((k) => granted.has(k));
}

// can(user, key) — NEW signature: takes the resolved user row (as returned
// by requireAuth, which caches its permission grants on the object so
// repeated can()/requirePerm() calls in the same request don't re-query),
// not just a role string. The two call sites that used to call
// can(user.role, key) directly (routes/transactions.js, routes/ledger.js)
// are updated to can(user, key) accordingly.
function can(user, key) {
  if (!user) return false;
  const granted = user._permGrants || resolveUserPermissions(user);
  return keysSatisfy(granted, key);
}

function isSuperAdmin(user) {
  if (!user) return false;
  const granted = user._permGrants || resolveUserPermissions(user);
  return granted === ALL_ACCESS;
}

function roleDisplayName(user) {
  const role = loadRoleForUser(user);
  return (role && role.name) || ROLE_LABELS[user.role] || user.role;
}

// SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 3.
// Single entry point for handing the FRONTEND a resolved snapshot of what a
// user can actually do — computed through the exact same engine
// (resolveUserPermissions + keysSatisfy/LEGACY_KEY_MAP) every backend route
// already enforces with, so the UI can never drift from what the API will
// actually allow. `perms` is still keyed by the old coarse legacy names (the
// ~59 `perm("accountsManage")`-style call sites across app.jsx, unchanged
// since Phase 3) — that surface stays exactly as it was.
//
// Phase 2 adds `rawKeys`: the user's own real granular grants (an array of
// "module.action" keys, or `null` meaning "every key" for a Super Admin's
// ALL_ACCESS bypass). This is what the new Role & User Management UI uses to
// decide things the 15 legacy keys were never meant to cover — chiefly,
// whether to show the "Roles" menu at all (gated on the real `roles.view`
// key, not a fake legacy stand-in for it). Any BRAND-NEW granular permission
// added to the catalog in the future works through `rawKeys` automatically —
// nothing here needs updating when permissions.js grows.
function resolvedPermsPayload(userRow) {
  const grants = resolveUserPermissions(userRow);
  const perms = {};
  for (const key of Object.keys(LEGACY_KEY_MAP)) perms[key] = keysSatisfy(grants, key);
  return {
    isSuperAdmin: grants === ALL_ACCESS,
    perms,
    rawKeys: grants === ALL_ACCESS ? null : Array.from(grants).sort(),
    roleLabel: roleDisplayName(userRow),
  };
}

// Verifies the Authorization: Bearer <token> header, loads the live user
// record (so a deactivated user is rejected even with a still-valid
// token), resolves and caches its permission grants for the rest of this
// request, and returns it — or sends 401 and returns null.
//
// MULTI-COMPANY round: this is also THE point where a request is bound to a
// company. The company always comes from the server-signed token (`cid`),
// never from a URL, query string, header or request body — and is only
// accepted after verifying:
//   * tenant users ("kind":"tenant"): the token's company still exists and is
//     ACTIVE (inactive/suspended companies lock their users out immediately),
//     and the user still exists, active, inside THAT company's own database;
//   * platform Super Admins ("kind":"platform"): the platform account is
//     still active and has explicitly switched into this company (see
//     POST /api/platform/switch-company).
// Only then is the request's database context set (src/tenant-context.js);
// before that, every database query fails closed.
function bearerPayload(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return auth.verify(token);
}

// SECURITY AUDIT round: a session that signed in with a published default
// password carries `mpc` ("must change password"). Such a session may only
// load its own profile and set a new password — every other endpoint is
// refused until it does (the server enforces this, not just the UI).
function refuseIfPasswordChangeRequired(payload, res, opts) {
  if (payload && payload.mpc && !(opts && opts.allowPasswordChange)) {
    sendJSON(res, 403, { error: "You must set a new password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" });
    return true;
  }
  return false;
}

function requireAuth(req, res, opts) {
  const payload = bearerPayload(req);
  if (!payload) {
    sendJSON(res, 401, { error: "Missing or invalid authentication token." });
    return null;
  }
  if (refuseIfPasswordChangeRequired(payload, res, opts)) return null;
  const tenancy = require("./tenancy");
  if (payload.kind === "platform") return requirePlatformWorkspace(payload, res, tenancy);
  const tokenCid = auth.tokenCompanyId(payload);
  if (payload.kind !== "tenant" || !tokenCid) {
    // A token issued before multi-company support existed carries no
    // company at all — never guess one; force a fresh sign-in.
    sendJSON(res, 401, { error: "Please sign in again." });
    return null;
  }
  const company = tenancy.getCompany(tokenCid);
  if (!company) {
    sendJSON(res, 401, { error: "Company not found." });
    return null;
  }
  if (company.status !== "active") {
    sendJSON(res, 403, { error: tenancy.companyAccessMessage(company), code: "COMPANY_SUSPENDED", companyStatus: company.status });
    return null;
  }
  if (!bindCompany(company, res, tenancy)) return null;
  const user = get(
    "SELECT id, name, username, role, role_id, status, active, permissions_version FROM users WHERE id = ?",
    [payload.sub]
  );
  if (!user || !user.active || user.status === "deactivated" || user.status === "suspended") {
    sendJSON(res, 401, { error: "Account not found or deactivated." });
    return null;
  }
  const role = loadRoleForUser(user);
  // A Super Admin row inside a company database is a platform account's
  // in-company identity — it can never be used through a company token.
  if (role && role.is_super_admin) {
    sendJSON(res, 401, { error: "Please sign in again." });
    return null;
  }
  // SESSION SECURITY: the token was signed with a snapshot of the role's
  // and the user's permissions_version at login time (see routes/auth.js).
  // If either has moved since — the role's permission set was edited, or
  // this user's own role/overrides were changed — the token is stale and
  // the session must revalidate by logging in again, even though it
  // hasn't expired. A token signed before this round existed (missing
  // either field) is stale by definition, since there's nothing to compare
  // it against; it fails the same way, forcing a one-time re-login.
  // Deactivation/suspension is already immediate via the check above —
  // this covers the "permissions changed while still active" case.
  const roleVerNow = role ? role.permissions_version : null;
  if (payload.rolePermVer === undefined || payload.userPermVer === undefined ||
      payload.rolePermVer !== roleVerNow || payload.userPermVer !== user.permissions_version) {
    sendJSON(res, 401, { error: "Your permissions have changed — please sign in again." });
    return null;
  }
  user._permGrants = resolveUserPermissions(user, role);
  user._company = company;
  user._mustChangePassword = !!payload.mpc;
  return user;
}

function bindCompany(company, res, tenancy) {
  let tenant;
  try {
    tenant = tenancy.openTenant(company);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tenancy] ${company.id} unavailable:`, e.message);
    sendJSON(res, 503, { error: "This company's data is temporarily unavailable." });
    return false;
  }
  tenantContext.setRequestTenant(tenant, company);
  return true;
}

// Platform Super Admin inside a company workspace.
function requirePlatformWorkspace(payload, res, tenancy) {
  const pu = verifyPlatformPayload(payload, res, tenancy);
  if (!pu) return null;
  if (!payload.cid) {
    sendJSON(res, 403, { error: "Select a company workspace first.", code: "COMPANY_REQUIRED" });
    return null;
  }
  const company = tenancy.getCompany(payload.cid);
  if (!company) {
    sendJSON(res, 403, { error: "That company no longer exists.", code: "COMPANY_REQUIRED" });
    return null;
  }
  if (!bindCompany(company, res, tenancy)) return null;
  const user = tenancy.ensureShadowUser(pu);
  const role = loadRoleForUser(user);
  if (!role || !role.is_super_admin) {
    sendJSON(res, 500, { error: "Super Admin identity could not be established for this company." });
    return null;
  }
  user._permGrants = resolveUserPermissions(user, role);
  user._platformUser = pu;
  user._company = company;
  return user;
}

function verifyPlatformPayload(payload, res, tenancy) {
  const pu = tenancy.getPlatformUser(payload.sub);
  if (!pu || pu.status !== "active") {
    sendJSON(res, 401, { error: "Account not found or deactivated." });
    return null;
  }
  if (payload.pv !== pu.permissions_version) {
    sendJSON(res, 401, { error: "Your session has changed — please sign in again." });
    return null;
  }
  // COMPANY ID VISIBILITY round: only a verified platform Super Admin session
  // may receive Company IDs in responses.
  tenantContext.allowCompanyIds();
  return pu;
}

// Platform-level endpoints (/api/platform/*): only a platform Super Admin,
// with or without a company currently selected. Never binds a company.
function requirePlatformAdmin(req, res, opts) {
  const payload = bearerPayload(req);
  if (!payload) {
    sendJSON(res, 401, { error: "Missing or invalid authentication token." });
    return null;
  }
  if (refuseIfPasswordChangeRequired(payload, res, opts)) return null;
  if (payload.kind !== "platform") {
    sendJSON(res, 403, { error: "Only a Super Admin can manage companies." });
    return null;
  }
  const pu = verifyPlatformPayload(payload, res, require("./tenancy"));
  if (!pu) return null;
  return { ...pu, activeCompanyId: payload.cid || null, mustChangePassword: !!payload.mpc };
}

// Builds the { rolePermVer, userPermVer } snapshot to embed in a freshly
// signed JWT (routes/auth.js's login) — the pair requireAuth compares
// against the live DB on every request to decide whether the session is
// still current. Takes a fresh user row (role_id + permissions_version
// columns selected).
function sessionVersionClaims(userRow) {
  const role = loadRoleForUser(userRow);
  return { rolePermVer: role ? role.permissions_version : null, userPermVer: userRow.permissions_version };
}

function requirePerm(user, res, key) {
  if (!can(user, key)) {
    sendJSON(res, 403, { error: `Your role (${roleDisplayName(user)}) does not have permission to do this.` });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// CURRENCY / RATE / PROFIT PERMISSIONS round — currency-access helpers.
// A Super Admin (and, via seed backfill, every pre-existing role — see
// db.js) implicitly has both; a role/user with neither currency.usd nor
// currency.slsh granted can see no accounts at all, which is the intended
// behavior for a role a Super Admin has deliberately narrowed.
// ---------------------------------------------------------------------

// Every currency this user is allowed to see/touch accounts in, as an array
// (e.g. ["USD"], ["USD","SLSH"], or [] for neither). Used both to build SQL
// filters (routes/accounts.js, routes/ledger.js) and for direct membership
// checks (hasCurrencyAccess below).
function allowedCurrencies(user) {
  if (isSuperAdmin(user)) return ["USD", "SLSH"];
  const out = [];
  if (can(user, "currency.usd")) out.push("USD");
  if (can(user, "currency.slsh")) out.push("SLSH");
  return out;
}

// True if `currency` (or no currency at all — e.g. a record that isn't
// scoped to one) is visible to this user.
function hasCurrencyAccess(user, currency) {
  if (!currency) return true;
  return allowedCurrencies(user).includes(currency);
}

// Sends 403 and returns false if the user can't see `currency`'s accounts;
// true (does nothing) otherwise. Mirrors requirePerm's shape so call sites
// read the same way: `if (!requireCurrencyAccess(user, res, c.currency)) return;`
function requireCurrencyAccess(user, res, currency) {
  if (!hasCurrencyAccess(user, currency)) {
    sendJSON(res, 403, { error: `Your role (${roleDisplayName(user)}) does not have access to ${currency} accounts.` });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// SUPER ADMIN PROTECTION — guards for role/user-management mutations.
// Not yet called from any route (routes/users.js is Task #57, the Roles
// API is Task #56); exported here so both can just import and use them
// rather than re-implementing the same rules twice.
// ---------------------------------------------------------------------

function isSuperAdminRole(role) {
  return !!(role && role.is_super_admin);
}

// Counts currently-usable (active, not deactivated/suspended) users whose
// role is Super Admin, optionally excluding one user id (the one about to
// be demoted/deactivated/deleted, so the check answers "would this leave
// zero left").
function countActiveSuperAdmins(excludeUserId) {
  const rows = excludeUserId
    ? all(
        `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.is_super_admin = 1 AND u.active = 1 AND u.status = 'active' AND u.id != ?`,
        [excludeUserId]
      )
    : all(
        `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.is_super_admin = 1 AND u.active = 1 AND u.status = 'active'`
      );
  return rows.length;
}

// Guards a mutation targeting `targetUser` (deactivate, suspend, delete,
// reassign role away from Super Admin, or change permissions) initiated by
// `actor`. Sends the appropriate 403 and returns false when disallowed;
// returns true when the mutation may proceed.
//   - SUPER ADMIN PROTECTION: only another Super Admin may manage a Super
//     Admin's account at all — a normal Admin, however extensively
//     permissioned, can never touch one.
//   - Even a Super Admin can never remove Super Admin status from, or
//     deactivate/delete, the LAST remaining active Super Admin — at least
//     one must always exist. Pass removingSuperAdminStatus: true when the
//     mutation would do that (demote/deactivate/suspend/delete), false for
//     an edit that leaves the target's Super Admin status intact.
function assertCanManageUser(actor, targetUser, res, { removingSuperAdminStatus = false } = {}) {
  const targetRole = loadRoleForUser(targetUser);
  if (!isSuperAdminRole(targetRole)) return true;
  if (!isSuperAdmin(actor)) {
    sendJSON(res, 403, { error: "Only a Super Admin can manage another Super Admin's account." });
    return false;
  }
  if (removingSuperAdminStatus && countActiveSuperAdmins(targetUser.id) < 1) {
    sendJSON(res, 403, { error: "At least one Super Admin must always exist — this is the last one." });
    return false;
  }
  return true;
}

// Guards a mutation on a role itself (rename, delete, or edit its
// permission set). action is one of "rename" | "delete" | "editPermissions".
//   - The Super Admin role can never be renamed, deleted, or have its
//     permissions edited (it has none stored — see the ALL_ACCESS bypass —
//     editing would be meaningless and is refused outright).
//   - A protected role (Super Admin and Admin) can never be renamed or
//     deleted. Admin's PERMISSION SET, unlike its existence, stays fully
//     editable by a Super Admin — only rename/delete are blocked for it.
function assertRoleMutable(role, res, action) {
  if (!role) {
    sendJSON(res, 404, { error: "Role not found." });
    return false;
  }
  if (role.is_super_admin) {
    sendJSON(res, 403, { error: "The Super Admin role cannot be modified." });
    return false;
  }
  if (role.is_protected && (action === "delete" || action === "rename")) {
    sendJSON(res, 403, {
      error: `The ${role.name} role is protected and cannot be ${action === "delete" ? "deleted" : "renamed"}.`,
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// SUPER ADMIN & ROLE-BASED PERMISSION CONTROL round — NO PRIVILEGE
// ESCALATION. Every place in the app that lets a person hand OUT access
// (grant a role or role-edit some permissions, assign a role to a user, or
// grant a per-user override) must refuse to hand out more than the actor
// themselves holds. A Super Admin is exempt (ALL_ACCESS already satisfies
// any key). This was previously unenforced anywhere: routes/roles.js and
// routes/users.js gated these mutations on a coarse "can you manage
// roles/users at all" flag, but never checked the CONTENT of what was being
// granted against the actor's own scope — an Admin holding roles.create +
// roles.managePermissions (or users.managePermissions) could mint a role or
// override carrying permissions they don't themselves have, and then hand
// it to a user they control. These two helpers are the single enforcement
// point for that rule; every route that grants a permission or assigns a
// role calls one of them before committing.
// ---------------------------------------------------------------------

// Which of `keys` (granular "module.action" permission keys) the actor is
// NOT allowed to hand out. Always empty for a Super Admin. `keys` must
// already be validated permission keys (callers check isValidPermissionKey
// first) — this only ever narrows, never validates shape.
function permissionsOutsideActorScope(actor, keys) {
  if (isSuperAdmin(actor)) return [];
  const granted = actor._permGrants || resolveUserPermissions(actor);
  return keys.filter((k) => !granted.has(k));
}

// Sends 403 and returns false if any of `keys` falls outside what `actor`
// themselves holds; true (does nothing) otherwise. `verb` fills in the
// error message ("grant", "assign") so the same helper reads naturally at
// every call site.
function requireWithinActorScope(actor, res, keys, verb = "grant") {
  const disallowed = permissionsOutsideActorScope(actor, keys);
  if (disallowed.length) {
    sendJSON(res, 403, {
      error: `You cannot ${verb} permission(s) you do not have yourself: ${disallowed.join(", ")}.`,
    });
    return false;
  }
  return true;
}

// Same rule, phrased for handing someone a whole ROLE (routes/users.js's
// role assignment on create/update): the role's own full granted-permission
// set must be entirely within the actor's own scope. A Super Admin role is
// never reachable here in practice (routes/users.js blocks assigning it
// outright, for every actor including a Super Admin), but is treated as
// "everything" defensively if it ever is.
function requireRoleWithinActorScope(actor, res, role) {
  if (isSuperAdmin(actor)) return true;
  const roleKeys = role.is_super_admin
    ? null // means "every key" — can never be within a non-Super-Admin's scope
    : all("SELECT permission_key FROM role_permissions WHERE role_id = ?", [role.id]).map((r) => r.permission_key);
  if (roleKeys === null) {
    sendJSON(res, 403, { error: "You cannot assign a role with greater authority than your own." });
    return false;
  }
  return requireWithinActorScope(actor, res, roleKeys, "assign a role carrying");
}

module.exports = {
  PERMS,
  ROLE_LABELS,
  can,
  requireAuth,
  requirePlatformAdmin,
  requirePerm,
  isSuperAdmin,
  resolveUserPermissions,
  loadRoleById,
  loadRoleForUser,
  roleDisplayName,
  resolvedPermsPayload,
  sessionVersionClaims,
  countActiveSuperAdmins,
  assertCanManageUser,
  assertRoleMutable,
  allowedCurrencies,
  hasCurrencyAccess,
  requireCurrencyAccess,
  permissionsOutsideActorScope,
  requireWithinActorScope,
  requireRoleWithinActorScope,
  ALL_ACCESS,
};
