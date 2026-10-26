"use strict";
// Roles + Permissions REST API — SUPER ADMIN + ADVANCED ROLE & PERMISSION
// MANAGEMENT round, Phase 1 (backend foundation only; no UI consumes this
// yet — that's Phase 2's Role & User Management screens). Everything here
// operates on the real, granular data model (roles / role_permissions /
// user_permission_overrides) directly — there is no legacy-key shim on
// this side, unlike the 50+ existing call sites elsewhere in the app.
const { get, all, run, tx, db } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, assertRoleMutable, assertCanManageUser, isSuperAdmin, loadRoleForUser, resolveUserPermissions, requireWithinActorScope, ALL_ACCESS } = require("../rbac");
const { PERMISSION_CATALOG, isValidPermissionKey } = require("../permissions");
const { addAudit } = require("../domain");
const { uid, nowISO } = require("../util");

const VALID_ROLE_STATUSES = ["active", "inactive"];

function roleJSON(role) {
  const permissions = role.is_super_admin
    ? null // not stored — ALL_ACCESS bypass; null signals "every permission" to callers, not "none"
    : all("SELECT permission_key FROM role_permissions WHERE role_id = ? ORDER BY permission_key", [role.id]).map((r) => r.permission_key);
  const userCount = get("SELECT COUNT(*) as n FROM users WHERE role_id = ?", [role.id]).n;
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    status: role.status,
    isSuperAdmin: !!role.is_super_admin,
    isProtected: !!role.is_protected,
    permissionsVersion: role.permissions_version,
    permissions,
    // ROLE MANAGEMENT round, Phase 2: the Role Management table's
    // "Permissions" column — null (Super Admin) reads as "All" client-side.
    permissionCount: permissions === null ? null : permissions.length,
    userCount,
    createdAt: role.created_at,
    createdBy: role.created_by,
    updatedAt: role.updated_at,
    updatedBy: role.updated_by,
  };
}

function permsSetToArrayOrAll(granted) {
  return granted === ALL_ACCESS ? null : Array.from(granted).sort();
}

function register(router) {
  // ---------------- Permission catalog (read-only reference data) ----------------
  router.get("/api/permissions", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.view")) return;
    sendJSON(res, 200, { permissions: PERMISSION_CATALOG });
  });

  // ---------------- Roles ----------------
  router.get("/api/roles", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.view")) return;
    const roles = all("SELECT * FROM roles ORDER BY is_super_admin DESC, is_protected DESC, name ASC");
    sendJSON(res, 200, { roles: roles.map(roleJSON) });
  });

  router.get("/api/roles/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.view")) return;
    const role = get("SELECT * FROM roles WHERE id = ?", [params.id]);
    if (!role) return notFound(res, "Role not found.");
    sendJSON(res, 200, { role: roleJSON(role) });
  });

  router.post("/api/roles", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.create")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const name = String(body.name || "").trim();
    if (!name) return badRequest(res, "Role name is required.");
    const description = body.description ? String(body.description).trim() : null;
    const status = body.status !== undefined ? String(body.status) : "active";
    if (!VALID_ROLE_STATUSES.includes(status)) return badRequest(res, `Status must be one of: ${VALID_ROLE_STATUSES.join(", ")}`);
    // ROLE TEMPLATES (Phase 2, light version): `startFromRoleId` pre-fills
    // this new role's permission set from an existing role's current grants
    // — the same copy `POST /api/roles/:id/duplicate` does, just as an
    // option at creation time rather than a separate action. Explicit
    // `permissions` in the body, if given, wins outright (a template is a
    // starting point, not a constraint).
    let requested;
    if (Array.isArray(body.permissions)) {
      requested = Array.from(new Set(body.permissions));
    } else if (body.startFromRoleId) {
      const template = get("SELECT * FROM roles WHERE id = ?", [body.startFromRoleId]);
      if (!template) return badRequest(res, "Unknown startFromRoleId.");
      requested = template.is_super_admin
        ? [] // Super Admin has no stored grants to copy from — start empty, same as picking no template.
        : all("SELECT permission_key FROM role_permissions WHERE role_id = ?", [template.id]).map((r) => r.permission_key);
    } else {
      requested = [];
    }
    const invalid = requested.filter((k) => !isValidPermissionKey(k));
    if (invalid.length) return badRequest(res, `Unknown permission key(s): ${invalid.join(", ")}`);
    // NO PRIVILEGE ESCALATION: a role can only be created carrying
    // permissions the actor themselves already holds (whether typed in
    // directly or copied in via startFromRoleId) — otherwise an Admin
    // holding roles.create could mint a role with more access than they
    // have and hand it to a user they control.
    if (!requireWithinActorScope(user, res, requested, "grant")) return;

    const id = uid("role");
    // key is a stable, URL/identifier-safe slug — only the seeded system
    // roles' keys are ever consulted by name (roles.key, in rbac.js's
    // legacy-role fallback and the super_admin/is_protected bootstrap); a
    // custom role's key is otherwise just an opaque identifier.
    const key = `custom_${id}`;
    const now = nowISO();
    tx(() => {
      run(
        "INSERT INTO roles (id, key, name, description, status, is_super_admin, is_protected, permissions_version, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,0,0,1,?,?,?,?)",
        [id, key, name, description, status, now, user.name, now, user.name]
      );
      for (const permKey of requested) run("INSERT INTO role_permissions (role_id, permission_key) VALUES (?,?)", [id, permKey]);
    });
    addAudit(user, "Role created", `${name} — ${requested.length} permission(s) granted`);
    sendJSON(res, 201, { role: roleJSON(get("SELECT * FROM roles WHERE id = ?", [id])) });
  });

  router.post("/api/roles/:id/duplicate", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.create")) return;
    const source = get("SELECT * FROM roles WHERE id = ?", [params.id]);
    if (!source) return notFound(res, "Role not found.");
    if (source.is_super_admin) return badRequest(res, "The Super Admin role cannot be duplicated — it carries no stored permission set to copy.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* name override is optional */ }
    const name = body.name ? String(body.name).trim() : `${source.name} (Copy)`;
    if (!name) return badRequest(res, "Role name is required.");

    const sourcePerms = all("SELECT permission_key FROM role_permissions WHERE role_id = ?", [source.id]).map((r) => r.permission_key);
    // NO PRIVILEGE ESCALATION: duplicating a role is still "granting"
    // whatever permissions it carries — an actor can't use it to hand
    // themselves (or whoever they assign the copy to) more than they have.
    if (!requireWithinActorScope(user, res, sourcePerms, "grant")) return;
    const id = uid("role");
    const key = `custom_${id}`;
    const now = nowISO();
    tx(() => {
      // A duplicate is always an ordinary, fully editable custom role —
      // never protected and never Super Admin — regardless of what it was
      // copied from (duplicating Admin, for instance, must not produce a
      // second protected role).
      run(
        "INSERT INTO roles (id, key, name, description, is_super_admin, is_protected, permissions_version, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,0,0,1,?,?,?,?)",
        [id, key, name, source.description, now, user.name, now, user.name]
      );
      for (const permKey of sourcePerms) run("INSERT INTO role_permissions (role_id, permission_key) VALUES (?,?)", [id, permKey]);
    });
    addAudit(user, "Role duplicated", `${source.name} -> ${name} (${sourcePerms.length} permission(s) copied)`);
    sendJSON(res, 201, { role: roleJSON(get("SELECT * FROM roles WHERE id = ?", [id])) });
  });

  router.patch("/api/roles/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.update")) return;
    const role = get("SELECT * FROM roles WHERE id = ?", [params.id]);
    if (!role) return notFound(res, "Role not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }

    const renaming = body.name !== undefined && String(body.name).trim() !== role.name;
    const changingDescription = body.description !== undefined && (body.description || null) !== role.description;
    const changingPerms = Array.isArray(body.permissions);
    const changingStatus = body.status !== undefined && body.status !== role.status;

    if ((renaming || changingDescription) && !assertRoleMutable(role, res, "rename")) return;
    // ROLE STATUS (Phase 2): deliberately NOT gated the same way as
    // rename/description — a Super Admin may deactivate/reactivate even a
    // *protected* role (Admin included; "protected" only ever meant
    // "can't be renamed or deleted", per Phase 1) but, like every other
    // change, can never touch the Super Admin role itself. assertRoleMutable
    // with an action outside {"delete","rename"} enforces exactly that: it
    // still unconditionally refuses is_super_admin, but doesn't trip the
    // protected-role block.
    if (changingStatus) {
      if (!VALID_ROLE_STATUSES.includes(body.status)) return badRequest(res, `Status must be one of: ${VALID_ROLE_STATUSES.join(", ")}`);
      if (!assertRoleMutable(role, res, "update")) return;
    }
    let requested = null;
    if (changingPerms) {
      if (!requirePerm(user, res, "roles.managePermissions")) return;
      if (!assertRoleMutable(role, res, "editPermissions")) return;
      requested = Array.from(new Set(body.permissions));
      const invalid = requested.filter((k) => !isValidPermissionKey(k));
      if (invalid.length) return badRequest(res, `Unknown permission key(s): ${invalid.join(", ")}`);
      // NO PRIVILEGE ESCALATION: only the keys being NEWLY ADDED need to be
      // within the actor's own scope — a key the role already carried
      // (perhaps granted by a Super Admin before this actor's own scope was
      // narrowed) is left alone unless this edit is the one adding it.
      const before = new Set(all("SELECT permission_key FROM role_permissions WHERE role_id=?", [role.id]).map((p) => p.permission_key));
      const added = requested.filter((k) => !before.has(k));
      if (!requireWithinActorScope(user, res, added, "grant")) return;
    }

    const name = renaming ? String(body.name).trim() : role.name;
    if (!name) return badRequest(res, "Role name cannot be empty.");
    const description = changingDescription ? (body.description || null) : role.description;
    const status = changingStatus ? body.status : role.status;

    const auditParts = [];
    if (renaming) auditParts.push(`renamed "${role.name}" -> "${name}"`);
    if (changingStatus) auditParts.push(`status "${role.status}" -> "${status}"`);
    tx(() => {
      run("UPDATE roles SET name=?, description=?, status=?, updated_at=?, updated_by=? WHERE id=?", [name, description, status, nowISO(), user.name, role.id]);
      if (changingPerms) {
        const before = new Set(all("SELECT permission_key FROM role_permissions WHERE role_id=?", [role.id]).map((p) => p.permission_key));
        const after = new Set(requested);
        const added = [...after].filter((k) => !before.has(k));
        const removed = [...before].filter((k) => !after.has(k));
        if (added.length || removed.length) {
          run("DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
          for (const k of after) run("INSERT INTO role_permissions (role_id, permission_key) VALUES (?,?)", [role.id, k]);
          // Bumps every current holder's session out from under them (via
          // requireAuth's rolePermVer check) — Session Security: a role
          // permission edit takes effect immediately, not on next login.
          run("UPDATE roles SET permissions_version = permissions_version + 1 WHERE id = ?", [role.id]);
          auditParts.push(`permissions — added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}`);
        }
      }
    });
    if (auditParts.length) addAudit(user, "Role updated", `${name}: ${auditParts.join("; ")}`);
    sendJSON(res, 200, { role: roleJSON(get("SELECT * FROM roles WHERE id = ?", [role.id])) });
  });

  // ROLE DELETE PROTECTION (Phase 2): a role currently assigned to anyone
  // can't just vanish out from under them. Without a `reassignToRoleId`,
  // this returns the blocking count so the UI can offer
  // "[ Cancel ] [ Reassign Users & Delete ]" — the person picks a
  // replacement role and resubmits with that id, which reassigns every
  // affected user (bumping their session — SESSION SECURITY, same as any
  // other role change) and deletes the now-empty role, all in one
  // transaction. A role with nobody on it deletes immediately either way.
  router.delete("/api/roles/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "roles.delete")) return;
    const role = get("SELECT * FROM roles WHERE id = ?", [params.id]);
    if (!role) return notFound(res, "Role not found.");
    if (!assertRoleMutable(role, res, "delete")) return;
    const affected = all("SELECT id FROM users WHERE role_id = ?", [role.id]);
    if (affected.length > 0) {
      let body = {}; try { body = await readJSONBody(req); } catch (e) { /* no body sent yet — that's the "just tell me the count" case */ }
      const reassignToRoleId = body && body.reassignToRoleId;
      if (!reassignToRoleId) {
        return sendJSON(res, 409, {
          error: `Cannot delete — ${affected.length} user(s) still have this role. Reassign them to a different role first.`,
          inUse: affected.length,
        });
      }
      const target = get("SELECT * FROM roles WHERE id = ?", [reassignToRoleId]);
      if (!target) return badRequest(res, "Unknown reassignToRoleId.");
      if (target.id === role.id) return badRequest(res, "Cannot reassign to the role being deleted.");
      if (target.status === "inactive") return badRequest(res, `Cannot reassign to "${target.name}" — that role is inactive.`);
      // Reassigning INTO the Super Admin role is exactly as sensitive as
      // granting it any other way (routes/users.js) — never let a
      // non-Super-Admin actor use "delete this role" as a side door to make
      // several users Super Admin at once.
      if (target.is_super_admin && !isSuperAdmin(user)) {
        return badRequest(res, "Only a Super Admin can reassign users into the Super Admin role.");
      }
      tx(() => {
        run("UPDATE users SET role_id = ?, permissions_version = permissions_version + 1 WHERE role_id = ?", [target.id, role.id]);
        run("DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
        run("DELETE FROM roles WHERE id = ?", [role.id]);
      });
      addAudit(user, "Role deleted (users reassigned)", `${role.name} -> ${affected.length} user(s) moved to ${target.name}`);
      return sendJSON(res, 200, { deleted: true, id: role.id, reassigned: affected.length, reassignedTo: target.id });
    }
    tx(() => {
      run("DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
      run("DELETE FROM roles WHERE id = ?", [role.id]);
    });
    addAudit(user, "Role deleted", role.name);
    sendJSON(res, 200, { deleted: true, id: role.id });
  });

  // ---------------- Per-user permission overrides ----------------
  // "Role vs User Permissions": every user's EFFECTIVE access is their
  // role's grants with these overrides layered on top (granted=1 adds a
  // key beyond the role; granted=0 explicitly denies one the role would
  // otherwise allow) — never a second, competing set of permissions.
  router.get("/api/users/:id/permissions", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users.managePermissions")) return;
    const target = get("SELECT * FROM users WHERE id = ?", [params.id]);
    if (!target) return notFound(res, "User not found.");
    const role = loadRoleForUser(target);
    const roleGrants = role && role.is_super_admin
      ? null
      : role
      ? all("SELECT permission_key FROM role_permissions WHERE role_id = ?", [role.id]).map((r) => r.permission_key)
      : [];
    const overrides = all(
      "SELECT permission_key, granted, granted_by, granted_at FROM user_permission_overrides WHERE user_id = ? ORDER BY permission_key",
      [target.id]
    ).map((o) => ({ permissionKey: o.permission_key, granted: !!o.granted, grantedBy: o.granted_by, grantedAt: o.granted_at }));
    const effective = permsSetToArrayOrAll(resolveUserPermissions(target, role));
    sendJSON(res, 200, {
      role: role ? { id: role.id, name: role.name, isSuperAdmin: !!role.is_super_admin } : null,
      roleGrants,
      overrides,
      effective,
    });
  });

  router.patch("/api/users/:id/permissions", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users.managePermissions")) return;
    const target = get("SELECT * FROM users WHERE id = ?", [params.id]);
    if (!target) return notFound(res, "User not found.");
    if (!assertCanManageUser(user, target, res)) return;
    const role = loadRoleForUser(target);
    if (role && role.is_super_admin) {
      return badRequest(res, "Super Admin already has full, unrestricted access — custom permissions don't apply.");
    }
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const list = Array.isArray(body.overrides) ? body.overrides : [];
    for (const o of list) {
      if (!o || !isValidPermissionKey(o.permissionKey) || typeof o.granted !== "boolean") {
        return badRequest(res, "Each override needs a valid permissionKey and a boolean granted.");
      }
    }
    const before = all("SELECT permission_key, granted FROM user_permission_overrides WHERE user_id = ?", [target.id]);
    const beforeMap = new Map(before.map((o) => [o.permission_key, !!o.granted]));
    const afterMap = new Map(list.map((o) => [o.permissionKey, o.granted]));
    const added = [], removed = [], changed = [];
    for (const [key, granted] of afterMap) {
      if (!beforeMap.has(key)) added.push(`${key}=${granted ? "grant" : "deny"}`);
      else if (beforeMap.get(key) !== granted) changed.push(`${key}=${granted ? "grant" : "deny"}`);
    }
    for (const key of beforeMap.keys()) if (!afterMap.has(key)) removed.push(key);

    // NO PRIVILEGE ESCALATION: only a NEWLY-granted override (granted=true,
    // and not already true before this save) needs to be within the actor's
    // own scope — denying a permission (granted=false) is always safe
    // regardless of the actor's own scope, and a grant that was already in
    // place before this edit is left alone unless this save is the one
    // turning it on.
    const newGrants = list.filter((o) => o.granted === true && beforeMap.get(o.permissionKey) !== true).map((o) => o.permissionKey);
    if (!requireWithinActorScope(user, res, newGrants, "grant")) return;

    const now = nowISO();
    tx(() => {
      run("DELETE FROM user_permission_overrides WHERE user_id = ?", [target.id]);
      for (const o of list) {
        run(
          "INSERT INTO user_permission_overrides (user_id, permission_key, granted, granted_by, granted_at) VALUES (?,?,?,?,?)",
          [target.id, o.permissionKey, o.granted ? 1 : 0, user.name, now]
        );
      }
      if (added.length || removed.length || changed.length) {
        // Same immediate-effect guarantee as a role permission edit — this
        // user's live sessions revalidate on their next request.
        run("UPDATE users SET permissions_version = permissions_version + 1 WHERE id = ?", [target.id]);
      }
    });
    if (added.length || removed.length || changed.length) {
      addAudit(
        user,
        "User custom permissions changed",
        `${target.name}: added ${added.join(", ") || "none"}; changed ${changed.join(", ") || "none"}; removed ${removed.join(", ") || "none"}`
      );
    }
    const fresh = get("SELECT * FROM users WHERE id = ?", [target.id]);
    sendJSON(res, 200, { effective: permsSetToArrayOrAll(resolveUserPermissions(fresh, role)) });
  });
}

module.exports = { register };
