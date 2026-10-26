"use strict";
// SECURITY AUDIT round: the published defaults (Demo123! / SuperAdmin123!)
// now force a password change at sign-in, so test installs are seeded with
// their own non-default passwords instead.
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
process.env.JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
// RBAC backend test suite — SUPER ADMIN + ADVANCED ROLE & PERMISSION
// MANAGEMENT round, Phase 1. Two parts:
//   A) direct unit-level checks of src/rbac.js's resolution engine and
//      protection guards, against a scratch DB manipulated straight
//      through node:sqlite (the only reliable way to exercise the "last
//      remaining Super Admin" rule for an actor other than the target,
//      since every real HTTP path to a lone Super Admin either goes
//      through the pre-existing self-deactivation guard first or is
//      blocked earlier by "only a Super Admin may manage a Super Admin");
//   B) a real HTTP integration pass — spawns the actual server and drives
//      login, session revalidation, the Roles API, and the Users API
//      exactly as a client would, including the legacy-key compatibility
//      shim and the guards that ARE reachable end-to-end over HTTP.
// Run with: npm run test:rbac
const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
// MYSQL round: a disposable MySQL database per run (test/helpers/mysql.js).
let TESTDB = require("./helpers/mysql").createTestDatabase("rbac");
const PORT = process.env.RBAC_TEST_PORT || 4310;
const BASE = `http://localhost:${PORT}`;

function cleanDb() {
  // A brand-new, empty database (the previous one is dropped).
  TESTDB.drop();
  TESTDB = require("./helpers/mysql").createTestDatabase("rbac");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  await fn();
  console.log("ok");
}

// ---------------------------------------------------------------------
// PART A — direct unit-level checks against a scratch DB
// ---------------------------------------------------------------------
async function partA() {
  console.log("Part A — permission engine & guards (direct)\n");
  cleanDb();
  Object.assign(process.env, TESTDB.env);
  delete require.cache[require.resolve(path.join(ROOT, "src", "db.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "src", "rbac.js"))];
  delete require.cache[require.resolve(path.join(ROOT, "src", "permissions.js"))];
  require(path.join(ROOT, "src", "db.js"));
  // MULTI-COMPANY round: direct (non-HTTP) checks run against the primary company.
  require(path.join(ROOT, "src", "tenancy.js")).useScriptTenant();
  const rbac = require(path.join(ROOT, "src", "rbac.js"));
  const { db, get, all, run } = require(path.join(ROOT, "src", "db.js"));

  function mkRes() {
    return { status: null, body: null, writeHead(c) { this.status = c; }, end(b) { this.body = JSON.parse(b); } };
  }
  function freshUser(username) {
    const u = get("SELECT * FROM users WHERE username = ?", [username]);
    u._permGrants = rbac.resolveUserPermissions(u);
    return u;
  }
  function insertUser(id, username, roleKey) {
    const role = get("SELECT id FROM roles WHERE key = ?", [roleKey]);
    run(
      "INSERT INTO users (id,name,username,password_hash,password_salt,role,role_id,status,active,permissions_version,created_at) VALUES (?,?,?,?,?,?,?, 'active',1,1,?)",
      [id, username.toUpperCase(), username, "x", "y", roleKey === "super_admin" ? "admin" : roleKey, role.id, new Date().toISOString()]
    );
    return freshUser(username);
  }

  await check("Super Admin bypasses every check, including an unknown key", async () => {
    const sa = freshUser("super.admin");
    assert(rbac.isSuperAdmin(sa), "expected isSuperAdmin(super.admin) to be true");
    assert(rbac.can(sa, "accountsDelete"), "expected legacy key to resolve true for a Super Admin");
    assert(rbac.can(sa, "totally.unknown.key"), "expected an unrecognized key to still resolve true for a Super Admin");
  });

  const mgr = insertUser("u_t_mgr", "t.manager", "manager");
  await check("legacy key resolves via ALL of its mapped granular keys (manager: quotationsManage is false)", async () => {
    assert(rbac.can(mgr, "accountsManage") === true, "manager should have accountsManage");
    assert(rbac.can(mgr, "quotationsManage") === false, "manager should NOT have quotationsManage");
    assert(rbac.can(mgr, "quotationsApprove") === true, "manager should have quotationsApprove (view-only, per app.jsx's real gating)");
  });

  await check("an unknown permission key fails closed, not open", async () => {
    assert(rbac.can(mgr, "this.key.does.not.exist") === false, "unknown key must never silently allow");
  });

  await check("a deny override narrows a legacy key's ALL-semantics resolution", async () => {
    const now = new Date().toISOString();
    run("INSERT INTO user_permission_overrides (user_id, permission_key, granted, granted_by, granted_at) VALUES (?,?,0,?,?)", [mgr.id, "accounts.deactivate", "test", now]);
    const mgr2 = freshUser("t.manager");
    assert(rbac.can(mgr2, "accountsManage") === false, "denying one of accountsManage's mapped keys should flip the whole legacy check false");
    assert(rbac.can(mgr2, "accounts.create") === true, "an unrelated granular key the deny didn't touch should still be true");
    run("DELETE FROM user_permission_overrides WHERE user_id = ?", [mgr.id]);
  });

  await check("a user with no role_id falls back to their legacy `role` string", async () => {
    const role = get("SELECT id FROM roles WHERE key = 'cashier'", []);
    run("INSERT INTO users (id,name,username,password_hash,password_salt,role,role_id,status,active,permissions_version,created_at) VALUES ('u_t_nullrole','NR','t.nullrole','x','y','cashier',NULL,'active',1,1,?)", [new Date().toISOString()]);
    const u = freshUser("t.nullrole");
    assert(u.role_id === null, "test setup: expected role_id to actually be NULL");
    assert(rbac.can(u, "exchangeCreate") === true, "should resolve cashier's grants via the legacy `role` string fallback despite role_id being NULL");
    run("DELETE FROM users WHERE id = 'u_t_nullrole'");
  });

  await check("assertRoleMutable blocks delete/rename on Super Admin and on a protected role, but allows editing Admin's permissions", async () => {
    const roles = all("SELECT * FROM roles", []);
    const superRole = roles.find((r) => r.key === "super_admin");
    const adminRole = roles.find((r) => r.key === "admin");
    let r1 = mkRes(); assert(rbac.assertRoleMutable(superRole, r1, "delete") === false && r1.status === 403, "Super Admin role must refuse delete");
    let r2 = mkRes(); assert(rbac.assertRoleMutable(adminRole, r2, "delete") === false && r2.status === 403, "protected Admin role must refuse delete");
    let r3 = mkRes(); assert(rbac.assertRoleMutable(adminRole, r3, "editPermissions") === true, "Admin's permission SET must stay editable despite being protected");
  });

  await check("assertCanManageUser: a non-Super-Admin actor can never manage a Super Admin target", async () => {
    const sa = freshUser("super.admin");
    let r = mkRes();
    assert(rbac.assertCanManageUser(mgr, sa, r) === false && r.status === 403, "expected 403");
  });

  await check("assertCanManageUser: the LAST active Super Admin can never be stripped of status", async () => {
    // countActiveSuperAdmins(targetUser.id) counts every OTHER active
    // Super Admin — it's only ever exactly one Super Admin (the seeded
    // super.admin) at this point in the test, so removing THAT one, by
    // anyone (including itself — actor identity doesn't change the count),
    // must be blocked. In the real HTTP API (Part B) this exact branch is
    // only ever reachable via self-targeting, because the only actor that
    // can pass the earlier "only a Super Admin may manage a Super Admin"
    // gate when a lone Super Admin exists IS that same Super Admin — the
    // route layer's own separate self-deactivation guard happens to catch
    // that case first there, so this function-level check is exercised
    // directly here instead.
    const sa1 = freshUser("super.admin");
    let r = mkRes();
    assert(
      rbac.assertCanManageUser(sa1, sa1, r, { removingSuperAdminStatus: true }) === false && r.status === 403,
      "expected the last-Super-Admin rule to block this, got status " + r.status
    );

    // With a SECOND active Super Admin, removing either one (leaving one)
    // is fine — the rule only fires at exactly zero remaining, not one.
    const sa2 = insertUser("u_t_sa2", "t.sa2", "super_admin");
    let r2 = mkRes();
    assert(rbac.assertCanManageUser(sa2, sa1, r2, { removingSuperAdminStatus: true }) === true, "should allow removing sa1's status while sa2 remains active");
    let r3 = mkRes();
    assert(rbac.assertCanManageUser(sa1, sa2, r3, { removingSuperAdminStatus: true }) === true, "should allow removing sa2's status while sa1 remains active");
    run("DELETE FROM users WHERE id = 'u_t_sa2'");
  });

  await check("resolveUserPermissions never throws on a null/undefined user row", async () => {
    assert(rbac.resolveUserPermissions(null).size === 0, "expected an empty Set for a null user row");
  });

  db.close();
  console.log();
}

// ---------------------------------------------------------------------
// PART B — real HTTP integration pass
// ---------------------------------------------------------------------
function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const res = await fetch(url); if (res.ok) return resolve(); } catch (e) { /* not up yet */ }
      if (Date.now() - start > timeoutMs) return reject(new Error("Server did not start in time"));
      setTimeout(tick, 200);
    };
    tick();
  });
}
async function api(pathname, opts = {}, token) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body };
}
async function login(username, password) {
  const { status, body } = await api("/api/auth/login", { method: "POST", body: { username, password } });
  assert(status === 200, `login as ${username} failed: ${JSON.stringify(body)}`);
  // MULTI-COMPANY round: a platform Super Admin starts with no company
  // selected — these RBAC checks all run inside the primary company, so open
  // its workspace exactly as the UI's company switcher does.
  if (body.user && body.user.isPlatformAdmin && !body.user.company) {
    const sw = await api("/api/platform/switch-company", { method: "POST", body: { companyId: "CMP-0001" } }, body.token);
    assert(sw.status === 200, `switching ${username} into CMP-0001 failed: ${JSON.stringify(sw.body)}`);
    return sw.body.token;
  }
  return body.token;
}
function decodeJwtPayload(token) {
  const [, p] = token.split(".");
  return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

async function partB() {
  console.log("Part B — HTTP integration (real server)\n");
  cleanDb();
  console.log("  seeding a scratch database...");
  execSync("node scripts/seed.js", { cwd: ROOT, env: { ...process.env, ...TESTDB.env }, stdio: "ignore" });

  console.log("  starting the server...");
  const server = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: { ...process.env, ...TESTDB.env, PORT: String(PORT) } });
  let output = "";
  server.stdout.on("data", (d) => (output += d));
  server.stderr.on("data", (d) => (output += d));
  try {
    await waitFor(`${BASE}/api/health`);
    console.log("  server is up.\n");

    const saToken = await login("super.admin", SA_PW);

    await check("JWT carries rolePermVer/userPermVer claims", async () => {
      const payload = decodeJwtPayload(saToken);
      // MULTI-COMPANY round: a Super Admin is a platform account — its
      // session version is the platform account's own `pv` claim.
      if (payload.kind === "platform") {
        assert(typeof payload.pv === "number", "expected numeric pv on a platform token");
        assert(payload.cid === "CMP-0001", "expected the workspace company on the token");
        const mgrPayload = decodeJwtPayload(await login("xasan.cali", DEMO_PW));
        assert(typeof mgrPayload.rolePermVer === "number", "expected numeric rolePermVer");
        assert(typeof mgrPayload.userPermVer === "number", "expected numeric userPermVer");
        return;
      }
      assert(typeof payload.rolePermVer === "number", "expected numeric rolePermVer");
      assert(typeof payload.userPermVer === "number", "expected numeric userPermVer");
    });

    await check("GET /api/permissions returns the full catalog (Super Admin bypass)", async () => {
      const { status, body } = await api("/api/permissions", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert(Array.isArray(body.permissions) && body.permissions.length > 40, "expected a substantial permission catalog");
    });

    await check("GET /api/roles lists all seeded roles with correct shapes", async () => {
      const { status, body } = await api("/api/roles", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      const sa = body.roles.find((r) => r.key === "super_admin");
      assert(sa && sa.permissions === null, "Super Admin's permissions should serialize as null (ALL), not an array");
      const admin = body.roles.find((r) => r.key === "admin");
      assert(admin && admin.isProtected === true && admin.isSuperAdmin === false, "Admin should be protected but not Super Admin");
    });

    let mgrToken;
    await check("a Manager (legacy role, no roles.* grants) is blocked from the Roles API", async () => {
      mgrToken = await login("xasan.cali", DEMO_PW);
      const { status } = await api("/api/roles", {}, mgrToken);
      assert(status === 403, `expected 403, got ${status}`);
    });

    await check("a Cashier (legacy \"users\": false) is blocked from GET /api/users", async () => {
      const cashToken = await login("cabdi.maxamed", DEMO_PW);
      const { status } = await api("/api/users", {}, cashToken);
      assert(status === 403, `expected 403, got ${status}`);
    });

    let customRoleId;
    await check("POST /api/roles rejects an unknown permission key", async () => {
      const { status, body } = await api("/api/roles", { method: "POST", body: { name: "Bad Role", permissions: ["not.a.real.key"] } }, saToken);
      assert(status === 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
    });
    await check("POST /api/roles creates a custom role with valid permissions", async () => {
      const { status, body } = await api("/api/roles", { method: "POST", body: { name: "Junior Accountant", permissions: ["accounts.view", "reports.view"] } }, saToken);
      assert(status === 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
      assert(body.role.permissionsVersion === 1, "a freshly created role should start at permissions_version 1");
      customRoleId = body.role.id;
    });
    await check("PATCH permissions bumps permissions_version only when the set actually changes", async () => {
      const same = await api(`/api/roles/${customRoleId}`, { method: "PATCH", body: { permissions: ["accounts.view", "reports.view"] } }, saToken);
      assert(same.body.role.permissionsVersion === 1, "re-submitting the identical set should not bump the version");
      const changed = await api(`/api/roles/${customRoleId}`, { method: "PATCH", body: { permissions: ["accounts.view"] } }, saToken);
      assert(changed.body.role.permissionsVersion === 2, `expected version 2 after an actual change, got ${changed.body.role.permissionsVersion}`);
    });
    await check("a protected role cannot be deleted, but its permissions stay editable", async () => {
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const adminRole = roles.find((r) => r.key === "admin");
      const del = await api(`/api/roles/${adminRole.id}`, { method: "DELETE" }, saToken);
      assert(del.status === 403, `expected 403 deleting Admin, got ${del.status}`);
    });
    await check("the Super Admin role itself refuses any modification", async () => {
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const superRole = roles.find((r) => r.key === "super_admin");
      const patch = await api(`/api/roles/${superRole.id}`, { method: "PATCH", body: { permissions: ["accounts.view"] } }, saToken);
      assert(patch.status === 403, `expected 403, got ${patch.status}`);
    });

    let mgrUserId;
    await check("a role in use cannot be deleted until its users are reassigned (manual two-step)", async () => {
      const users = (await api("/api/users", {}, saToken)).body.users;
      mgrUserId = users.find((u) => u.username === "xasan.cali").id;
      await api(`/api/users/${mgrUserId}`, { method: "PATCH", body: { roleId: customRoleId } }, saToken);
      const del = await api(`/api/roles/${customRoleId}`, { method: "DELETE" }, saToken);
      assert(del.status === 409, `expected 409 (role in use), got ${del.status}`);
      assert(del.body.inUse === 1, `expected inUse:1 in the blocked-delete response, got ${JSON.stringify(del.body)}`);
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const managerRole = roles.find((r) => r.key === "manager");
      await api(`/api/users/${mgrUserId}`, { method: "PATCH", body: { roleId: managerRole.id } }, saToken);
      const del2 = await api(`/api/roles/${customRoleId}`, { method: "DELETE" }, saToken);
      assert(del2.status === 200, `expected 200 after reassignment, got ${del2.status}`);
    });

    // ROLE MANAGEMENT round, Phase 2: the one-step "Reassign Users & Delete"
    // flow — reassignToRoleId on the DELETE call itself, instead of a
    // separate PATCH first.
    await check("DELETE /api/roles/:id with reassignToRoleId reassigns affected users and deletes in one step", async () => {
      const created = await api("/api/roles", { method: "POST", body: { name: "rbac-test-reassign-source", permissions: ["accounts.view"] } }, saToken);
      const sourceRoleId = created.body.role.id;
      const users = (await api("/api/users", {}, saToken)).body.users;
      const cashierUserId = users.find((u) => u.username === "cabdi.maxamed").id;
      await api(`/api/users/${cashierUserId}`, { method: "PATCH", body: { roleId: sourceRoleId } }, saToken);

      const blocked = await api(`/api/roles/${sourceRoleId}`, { method: "DELETE" }, saToken);
      assert(blocked.status === 409 && blocked.body.inUse === 1, `expected 409/inUse:1, got ${blocked.status}/${JSON.stringify(blocked.body)}`);

      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const cashierRole = roles.find((r) => r.key === "cashier");
      const combined = await api(`/api/roles/${sourceRoleId}`, { method: "DELETE", body: { reassignToRoleId: cashierRole.id } }, saToken);
      assert(combined.status === 200, `expected 200, got ${combined.status}: ${JSON.stringify(combined.body)}`);
      assert(combined.body.reassigned === 1, `expected reassigned:1, got ${JSON.stringify(combined.body)}`);

      const stillThere = await api(`/api/roles/${sourceRoleId}`, {}, saToken);
      assert(stillThere.status === 404, "the deleted role should be gone");
      const freshUsers = (await api("/api/users", {}, saToken)).body.users;
      const movedUser = freshUsers.find((u) => u.id === cashierUserId);
      assert(movedUser.roleLabel === cashierRole.name, `expected the reassigned user to now show role "${cashierRole.name}", got "${movedUser.roleLabel}"`);
    });

    await check("reassigning into the Super Admin role via role-delete is blocked for a non-Super-Admin actor", async () => {
      const plainAdminToken = await login("amina.yusuf", DEMO_PW); // Admin role: has roles.create/roles.delete, but is NOT Super Admin
      const created = await api("/api/roles", { method: "POST", body: { name: "rbac-test-reassign-guard", permissions: [] } }, plainAdminToken);
      const sourceRoleId = created.body.role.id;
      const created2 = await api("/api/users", { method: "POST", body: { name: "Reassign Guard User", username: "rbac.test.reassignguard", password: DEMO_PW, roleId: sourceRoleId } }, saToken);
      const guardUserId = created2.body.user.id;
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const superRole = roles.find((r) => r.key === "super_admin");
      const del = await api(`/api/roles/${sourceRoleId}`, { method: "DELETE", body: { reassignToRoleId: superRole.id } }, plainAdminToken);
      assert(del.status === 400, `expected 400 (non-Super-Admin can't reassign into Super Admin), got ${del.status}`);
      // clean up: a Super Admin can still do the same reassignment
      const asSA = await api(`/api/roles/${sourceRoleId}`, { method: "DELETE", body: { reassignToRoleId: superRole.id } }, saToken);
      assert(asSA.status === 200, `expected 200 for the Super Admin actor, got ${asSA.status}: ${JSON.stringify(asSA.body)}`);
      // ...and immediately demote them back off Super Admin so later checks
      // (last-active-Super-Admin guards) aren't affected by this test user.
      const managerRole = roles.find((r) => r.key === "manager");
      await api(`/api/users/${guardUserId}`, { method: "PATCH", body: { roleId: managerRole.id } }, saToken);
      await api(`/api/users/${guardUserId}`, { method: "PATCH", body: { active: false } }, saToken);
      await api(`/api/users/${guardUserId}`, { method: "DELETE", body: { confirmUsername: "rbac.test.reassignguard" } }, saToken);
    });

    await check("ROLE STATUS: an inactive role can't be newly assigned, but a user already on it is left alone", async () => {
      const created = await api("/api/roles", { method: "POST", body: { name: "rbac-test-inactive-role", permissions: ["accounts.view"], status: "inactive" } }, saToken);
      assert(created.body.role.status === "inactive", `expected the role to be created inactive, got "${created.body.role.status}"`);
      const denied = await api("/api/users", { method: "POST", body: { name: "Should Not Work", username: "rbac.test.inactiverole", password: DEMO_PW, roleId: created.body.role.id } }, saToken);
      assert(denied.status === 400, `expected 400 assigning an inactive role to a new user, got ${denied.status}`);
      // Reactivating it unblocks assignment again.
      await api(`/api/roles/${created.body.role.id}`, { method: "PATCH", body: { status: "active" } }, saToken);
      const allowed = await api("/api/users", { method: "POST", body: { name: "Should Work Now", username: "rbac.test.reactivatedrole", password: DEMO_PW, roleId: created.body.role.id } }, saToken);
      assert(allowed.status === 201, `expected 201 after reactivating the role, got ${allowed.status}`);
      // clean up
      await api(`/api/users/${allowed.body.user.id}`, { method: "PATCH", body: { active: false } }, saToken);
      await api(`/api/users/${allowed.body.user.id}`, { method: "DELETE", body: { confirmUsername: "rbac.test.reactivatedrole" } }, saToken);
      await api(`/api/roles/${created.body.role.id}`, { method: "DELETE" }, saToken);
    });

    await check("SESSION SECURITY: a role reassignment invalidates the affected user's existing token", async () => {
      const oldToken = await login("xasan.cali", DEMO_PW);
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const viewerRole = roles.find((r) => r.key === "viewer");
      await api(`/api/users/${mgrUserId}`, { method: "PATCH", body: { roleId: viewerRole.id } }, saToken);
      const stale = await api("/api/auth/me", {}, oldToken);
      assert(stale.status === 401, `expected the pre-reassignment token to be rejected (401), got ${stale.status}`);
      const fresh = await login("xasan.cali", DEMO_PW);
      const ok = await api("/api/auth/me", {}, fresh);
      assert(ok.status === 200, "a fresh login after the change should succeed");
      // restore for later checks
      const managerRole = roles.find((r) => r.key === "manager");
      await api(`/api/users/${mgrUserId}`, { method: "PATCH", body: { roleId: managerRole.id } }, saToken);
    });

    await check("PATCH permission overrides layer on top of the role and bump the user's own session version", async () => {
      const before = (await api(`/api/users/${mgrUserId}/permissions`, {}, saToken)).body;
      assert(before.effective.includes("accounts.view"), "sanity: manager's effective set should include accounts.view");
      const tok = await login("xasan.cali", DEMO_PW);
      const set = await api(`/api/users/${mgrUserId}/permissions`, { method: "PATCH", body: { overrides: [{ permissionKey: "payments.view", granted: false }] } }, saToken);
      assert(set.status === 200, `expected 200, got ${set.status}`);
      assert(!set.body.effective.includes("payments.view"), "payments.view should be denied by the override");
      const stale = await api("/api/auth/me", {}, tok);
      assert(stale.status === 401, "an override change should also invalidate the target's existing session");
      // clean up the override
      await api(`/api/users/${mgrUserId}/permissions`, { method: "PATCH", body: { overrides: [] } }, saToken);
    });

    await check("overrides don't apply to a Super Admin (not applicable, 400)", async () => {
      const { status, body } = await api("/api/users/u_super_admin/permissions", { method: "PATCH", body: { overrides: [{ permissionKey: "accounts.view", granted: false }] } }, saToken);
      assert(status === 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
    });

    let plainUserId, plainToken;
    await check("POST /api/users creates a user by roleId and they can log in", async () => {
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const cashierRole = roles.find((r) => r.key === "cashier");
      const created = await api("/api/users", { method: "POST", body: { name: "rbac test cashier", username: "rbac.test.cashier", password: "Passw0rd!", roleId: cashierRole.id } }, saToken);
      assert(created.status === 201, `expected 201, got ${created.status}`);
      plainUserId = created.body.user.id;
      plainToken = await login("rbac.test.cashier", "Passw0rd!");
      assert(!!plainToken, "expected a token for the newly created user");
    });

    await check("deactivating a user immediately invalidates their session", async () => {
      await api(`/api/users/${plainUserId}`, { method: "PATCH", body: { active: false } }, saToken);
      const { status } = await api("/api/auth/me", {}, plainToken);
      assert(status === 401, `expected 401 for a deactivated user's still-unexpired token, got ${status}`);
    });

    await check("an unrelated PATCH (name only) never silently reactivates a deactivated user", async () => {
      await api(`/api/users/${plainUserId}`, { method: "PATCH", body: { name: "renamed cashier" } }, saToken);
      const users = (await api("/api/users", {}, saToken)).body.users;
      const u = users.find((x) => x.id === plainUserId);
      assert(u.active === false, "expected the user to still be inactive after an unrelated field update");
    });

    await check("DELETE requires the user to already be deactivated", async () => {
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const cashierRole = roles.find((r) => r.key === "cashier");
      const created = await api("/api/users", { method: "POST", body: { name: "still active", username: "rbac.still.active", password: "Passw0rd!", roleId: cashierRole.id } }, saToken);
      const del = await api(`/api/users/${created.body.user.id}`, { method: "DELETE" }, saToken);
      assert(del.status === 400, `expected 400 for deleting a still-active user, got ${del.status}`);
    });

    await check("DELETE requires the exact username as confirmation, then soft-deletes", async () => {
      const noConfirm = await api(`/api/users/${plainUserId}`, { method: "DELETE" }, saToken);
      assert(noConfirm.status === 400, `expected 400 without confirmation, got ${noConfirm.status}`);
      const wrongConfirm = await api(`/api/users/${plainUserId}`, { method: "DELETE", body: { confirmUsername: "wrong" } }, saToken);
      assert(wrongConfirm.status === 400, `expected 400 for a wrong confirmation, got ${wrongConfirm.status}`);
      const ok = await api(`/api/users/${plainUserId}`, { method: "DELETE", body: { confirmUsername: "rbac.test.cashier" } }, saToken);
      assert(ok.status === 200, `expected 200, got ${ok.status}`);
      const users = (await api("/api/users", {}, saToken)).body.users;
      assert(!users.some((u) => u.id === plainUserId), "deleted user should no longer appear in the list");
    });

    await check("SUPER ADMIN PROTECTION: a normal Admin can't manage a Super Admin over HTTP", async () => {
      const roles = (await api("/api/roles", {}, saToken)).body.roles;
      const adminRole = roles.find((r) => r.key === "admin");
      const created = await api("/api/users", { method: "POST", body: { name: "normal admin", username: "rbac.normal.admin", password: "Passw0rd!", roleId: adminRole.id } }, saToken);
      const adminToken = await login("rbac.normal.admin", "Passw0rd!");
      const attempt = await api("/api/users/u_super_admin", { method: "PATCH", body: { active: false } }, adminToken);
      assert(attempt.status === 403, `expected 403, got ${attempt.status}`);
      const promote = await api(`/api/users/${created.body.user.id}`, { method: "PATCH", body: { roleId: roles.find((r) => r.key === "super_admin").id } }, adminToken);
      assert(promote.status === 400, `expected 400 (only a Super Admin can grant Super Admin), got ${promote.status}`);
    });

    // TABLE CUSTOMIZATION round — GET/PATCH/DELETE /api/table-layout/:tableKey.
    // Saving your OWN ("me") layout is self-service (no special permission,
    // same precedent as the pre-existing quotation_column_prefs), while
    // setting the SYSTEM-wide default is gated on the new
    // settings.manageTableDefaults grant (Admin/Super Admin only).
    //
    // mgrToken was captured way back before the role-reassignment and
    // permission-override checks above, both of which invalidate xasan.cali's
    // existing session (that's the whole point of those checks) — re-login
    // for a fresh token here rather than reusing the now-stale one.
    mgrToken = await login("xasan.cali", DEMO_PW);
    await check("GET /api/table-layout/:tableKey rejects an unknown table key", async () => {
      const { status } = await api("/api/table-layout/not-a-real-table", {}, saToken);
      assert(status === 400, `expected 400, got ${status}`);
    });
    await check("GET /api/table-layout/:tableKey starts empty (no layout saved yet)", async () => {
      const { status, body } = await api("/api/table-layout/users", {}, mgrToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert(body.system === null && body.mine === null, `expected both null before anything is saved, got ${JSON.stringify(body)}`);
    });
    await check("PATCH scope=me is self-service — a plain Manager (no settings.manageTableDefaults) can save their OWN layout", async () => {
      const { status, body } = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "me", columns: ["name", "status"], density: "compact" } }, mgrToken);
      assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert(JSON.stringify(body.layout.columns) === JSON.stringify(["name", "status"]), "columns should persist exactly as sent, in order");
      assert(body.layout.density === "compact", "density should persist");
    });
    await check("PATCH scope=system is blocked for that same Manager — 403, settings.manageTableDefaults required", async () => {
      const { status } = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "system", columns: ["name"] } }, mgrToken);
      assert(status === 403, `expected 403, got ${status}`);
    });
    await check("PATCH rejects a non-array columns value and an out-of-range density", async () => {
      const badColumns = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "me", columns: "not-an-array" } }, mgrToken);
      assert(badColumns.status === 400, `expected 400 for non-array columns, got ${badColumns.status}`);
      const badDensity = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "me", columns: ["name"], density: "roomy" } }, mgrToken);
      assert(badDensity.status === 400, `expected 400 for an invalid density, got ${badDensity.status}`);
      const dupColumns = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "me", columns: ["name", "name"] } }, mgrToken);
      assert(dupColumns.status === 400, `expected 400 for duplicate column keys, got ${dupColumns.status}`);
    });
    await check("PATCH scope=system succeeds for Super Admin and becomes the default everyone else inherits", async () => {
      const { status, body } = await api("/api/table-layout/users", { method: "PATCH", body: { scope: "system", columns: ["username", "roleLabel"], density: "comfortable" } }, saToken);
      assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
      const viewerToken = await login("sahra.ismail", DEMO_PW); // a user who has never saved their own layout
      const asViewer = await api("/api/table-layout/users", {}, viewerToken);
      assert(JSON.stringify(asViewer.body.system.columns) === JSON.stringify(["username", "roleLabel"]), "a user with no personal override should see the new system default");
      assert(asViewer.body.mine === null, "the viewer's own layout should still be untouched");
    });
    await check("a user's OWN saved layout still wins over the system default (mine > system priority)", async () => {
      const { body } = await api("/api/table-layout/users", {}, mgrToken);
      assert(JSON.stringify(body.mine.columns) === JSON.stringify(["name", "status"]), "the Manager's earlier personal layout should be untouched by the system default change");
      assert(JSON.stringify(body.system.columns) === JSON.stringify(["username", "roleLabel"]), "system default should reflect what Super Admin just set");
    });
    await check("DELETE scope=system is blocked for a plain Manager, allowed for Super Admin, and actually clears it", async () => {
      const blocked = await api("/api/table-layout/users?scope=system", { method: "DELETE" }, mgrToken);
      assert(blocked.status === 403, `expected 403, got ${blocked.status}`);
      const allowed = await api("/api/table-layout/users?scope=system", { method: "DELETE" }, saToken);
      assert(allowed.status === 200, `expected 200, got ${allowed.status}`);
      const after = await api("/api/table-layout/users", {}, saToken);
      assert(after.body.system === null, "system default should be gone after DELETE");
    });
    await check("DELETE scope=me (default) resets just that user's own layout, leaving others untouched", async () => {
      const del = await api("/api/table-layout/users", { method: "DELETE" }, mgrToken);
      assert(del.status === 200, `expected 200, got ${del.status}`);
      const after = await api("/api/table-layout/users", {}, mgrToken);
      assert(after.body.mine === null, "the Manager's own layout should be gone after resetting it");
    });
    await check("Admin (not just Super Admin) can also set the system default — settings.manageTableDefaults is one of Admin's real grants", async () => {
      const adminToken2 = await login("amina.yusuf", DEMO_PW); // the seeded legacy 'admin' role account
      const { status } = await api("/api/table-layout/roles", { method: "PATCH", body: { scope: "system", columns: ["name", "status"] } }, adminToken2);
      assert(status === 200, `expected 200 (Admin should hold settings.manageTableDefaults), got ${status}`);
      await api("/api/table-layout/roles?scope=system", { method: "DELETE" }, adminToken2); // cleanup
    });

    // TABLE CUSTOMIZATION round 2 — exchange/payments.usd/payments.slsh/
    // quotations were added to VALID_TABLE_KEYS. No new permission or schema
    // was needed (same table_layouts store, same settings.manageTableDefaults
    // gate) — this just confirms the 4 new keys are actually wired in, not
    // still rejected as "unknown table", and that the same scope=me/system
    // rules apply to them as to the 5 Round-1 tables.
    await check("the 4 new Round-2 table keys (exchange, payments.usd, payments.slsh, quotations) are all accepted, not rejected as unknown", async () => {
      for (const key of ["exchange", "payments.usd", "payments.slsh", "quotations"]) {
        const { status } = await api(`/api/table-layout/${key}`, {}, saToken);
        assert(status === 200, `expected 200 for table key "${key}", got ${status}`);
      }
    });
    await check("the 2 new Round-3 table keys (history.usd, history.slsh — Transaction History) are also accepted", async () => {
      for (const key of ["history.usd", "history.slsh"]) {
        const { status } = await api(`/api/table-layout/${key}`, {}, saToken);
        assert(status === 200, `expected 200 for table key "${key}", got ${status}`);
      }
    });
    await check("scope=me self-service and scope=system permission gating both apply identically to a Round-2 table (exchange)", async () => {
      const fresh = await login("xasan.cali", DEMO_PW); // Manager — no settings.manageTableDefaults
      const mine = await api("/api/table-layout/exchange", { method: "PATCH", body: { scope: "me", columns: ["client", "given", "received"] } }, fresh);
      assert(mine.status === 200, `expected self-service scope=me to succeed, got ${mine.status}`);
      const blocked = await api("/api/table-layout/exchange", { method: "PATCH", body: { scope: "system", columns: ["client"] } }, fresh);
      assert(blocked.status === 403, `expected scope=system to be blocked for a Manager, got ${blocked.status}`);
      const allowed = await api("/api/table-layout/exchange", { method: "PATCH", body: { scope: "system", columns: ["client", "status"] } }, saToken);
      assert(allowed.status === 200, `expected scope=system to succeed for Super Admin, got ${allowed.status}`);
      // cleanup — leave both scopes as they were before this check
      await api("/api/table-layout/exchange", { method: "DELETE" }, fresh);
      await api("/api/table-layout/exchange?scope=system", { method: "DELETE" }, saToken);
    });

    // APPEARANCE & BRANDING round: brand_color/website/favicon_data_url
    // reuse the pre-existing settingsManage gate (same as pdf_accent_color
    // already did) — no new permission, so this just confirms the new
    // fields are actually wired through GET/PATCH and still properly
    // gated/validated, without touching table_layouts at all.
    await check("GET /api/settings/company (signed in) includes the new Appearance & Branding fields", async () => {
      const { status, body } = await api("/api/settings/company", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert("brandColor" in body.company, "expected a brandColor field on the public company payload");
      assert("website" in body.company, "expected a website field on the public company payload");
      assert("faviconDataUrl" in body.company, "expected a faviconDataUrl field on the public company payload");
    });
    await check("PATCH /api/settings/company is blocked for a role without settingsManage (Manager)", async () => {
      const fresh = await login("xasan.cali", DEMO_PW);
      const { status } = await api("/api/settings/company", { method: "PATCH", body: { brandColor: "#112233" } }, fresh);
      assert(status === 403, `expected 403, got ${status}`);
    });
    await check("PATCH rejects a malformed brandColor and a malformed faviconDataUrl", async () => {
      const badColor = await api("/api/settings/company", { method: "PATCH", body: { brandColor: "not-a-color" } }, saToken);
      assert(badColor.status === 400, `expected 400 for a bad brandColor, got ${badColor.status}`);
      const badFavicon = await api("/api/settings/company", { method: "PATCH", body: { faviconDataUrl: "data:text/plain;base64,aGVsbG8=" } }, saToken);
      assert(badFavicon.status === 400, `expected 400 for a non-image faviconDataUrl, got ${badFavicon.status}`);
    });
    await check("PATCH saves brandColor/website/faviconDataUrl and GET reflects them back", async () => {
      const before = (await api("/api/settings/company", {}, saToken)).body.company;
      const favicon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const { status } = await api("/api/settings/company", { method: "PATCH", body: { brandColor: "#1d6b4a", website: "www.geeska-rbac-test.example", faviconDataUrl: favicon } }, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      const after = (await api("/api/settings/company", {}, saToken)).body.company;
      assert(after.brandColor === "#1d6b4a", `expected brandColor to persist, got ${after.brandColor}`);
      assert(after.website === "www.geeska-rbac-test.example", `expected website to persist, got ${after.website}`);
      assert(after.faviconDataUrl === favicon, "expected faviconDataUrl to persist");
      // restore prior values so this check has no lasting side effect
      await api("/api/settings/company", { method: "PATCH", body: { brandColor: before.brandColor, website: before.website, faviconDataUrl: before.faviconDataUrl } }, saToken);
    });

    // APPEARANCE & BRANDING round 2: secondaryColor/accentColor/status*Color
    // reuse the same hex regex as brandColor; fontFamily/fontSize are
    // validated against a fixed whitelist instead (a curated key, not a
    // free-form CSS value) — same settingsManage gate throughout, no new
    // permission introduced.
    await check("GET /api/settings/company includes the new Round-2 Appearance fields, defaulted sensibly", async () => {
      const { status, body } = await api("/api/settings/company", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      for (const key of ["secondaryColor", "accentColor", "statusPendingColor", "statusPaidColor", "statusRefundedColor"]) {
        assert(key in body.company, `expected a ${key} field on the public company payload`);
      }
      assert(body.company.fontFamily === "inter" || typeof body.company.fontFamily === "string", "expected a fontFamily string");
      assert(body.company.fontSize === "medium" || typeof body.company.fontSize === "string", "expected a fontSize string");
    });
    await check("PATCH /api/settings/company (Round-2 fields) is blocked for a role without settingsManage (Manager)", async () => {
      const fresh = await login("xasan.cali", DEMO_PW);
      const { status } = await api("/api/settings/company", { method: "PATCH", body: { accentColor: "#112233" } }, fresh);
      assert(status === 403, `expected 403, got ${status}`);
    });
    await check("PATCH rejects a malformed color and an out-of-whitelist fontFamily/fontSize", async () => {
      const badSecondary = await api("/api/settings/company", { method: "PATCH", body: { secondaryColor: "nope" } }, saToken);
      assert(badSecondary.status === 400, `expected 400 for a bad secondaryColor, got ${badSecondary.status}`);
      const badStatus = await api("/api/settings/company", { method: "PATCH", body: { statusPaidColor: "green" } }, saToken);
      assert(badStatus.status === 400, `expected 400 for a bad statusPaidColor, got ${badStatus.status}`);
      const badFamily = await api("/api/settings/company", { method: "PATCH", body: { fontFamily: "comic-sans" } }, saToken);
      assert(badFamily.status === 400, `expected 400 for an unknown fontFamily, got ${badFamily.status}`);
      const badSize = await api("/api/settings/company", { method: "PATCH", body: { fontSize: "huge" } }, saToken);
      assert(badSize.status === 400, `expected 400 for an unknown fontSize, got ${badSize.status}`);
    });
    await check("PATCH saves all Round-2 Appearance fields together and GET reflects them back", async () => {
      const before = (await api("/api/settings/company", {}, saToken)).body.company;
      const body = {
        secondaryColor: "#a5f3fc", accentColor: "#22d3ee", statusPendingColor: "#92400e",
        statusPaidColor: "#065f46", statusRefundedColor: "#5b21b6", fontFamily: "georgia", fontSize: "large",
      };
      const { status } = await api("/api/settings/company", { method: "PATCH", body }, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      const after = (await api("/api/settings/company", {}, saToken)).body.company;
      for (const key of Object.keys(body)) {
        assert(after[key] === body[key], `expected ${key} to persist as ${body[key]}, got ${after[key]}`);
      }
      // restore prior values so this check has no lasting side effect
      await api("/api/settings/company", { method: "PATCH", body: {
        secondaryColor: before.secondaryColor, accentColor: before.accentColor,
        statusPendingColor: before.statusPendingColor, statusPaidColor: before.statusPaidColor,
        statusRefundedColor: before.statusRefundedColor, fontFamily: before.fontFamily, fontSize: before.fontSize,
      } }, saToken);
    });

    // SUPER ADMIN SYSTEM OVERVIEW round: GET /api/system-overview reuses the
    // same "users" legacy-key gate as the Users list itself — no new
    // permission was introduced, so this just confirms that gate is
    // actually applied here too, and that the aggregate shape comes back
    // sane for someone who IS allowed to see it.
    await check("GET /api/system-overview is blocked for a role without the 'users' permission (Cashier)", async () => {
      const cashier = await login("cabdi.maxamed", DEMO_PW);
      const { status } = await api("/api/system-overview", {}, cashier);
      assert(status === 403, `expected 403, got ${status}`);
    });
    await check("GET /api/system-overview succeeds for Super Admin and returns the expected aggregate shape", async () => {
      const { status, body } = await api("/api/system-overview", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      for (const key of ["systemStatus", "users", "roles", "permissions", "database", "recentChanges", "recentLogins", "auditActivity"]) {
        assert(key in body, `expected a "${key}" field in the system overview payload`);
      }
      assert(body.users.total >= 1, "expected at least 1 user counted");
      assert(body.roles.total >= 1, "expected at least 1 role counted");
      assert(body.permissions.catalogSize > 0, "expected a non-empty permission catalog size");
      assert(Array.isArray(body.recentChanges), "expected recentChanges to be an array");
      assert(Array.isArray(body.recentLogins), "expected recentLogins to be an array");
    });
    await check("GET /api/system-overview also succeeds for Admin (amina.yusuf) — same 'users' grant as the Users list", async () => {
      const adminToken3 = await login("amina.yusuf", DEMO_PW);
      const { status } = await api("/api/system-overview", {}, adminToken3);
      assert(status === 200, `expected 200, got ${status}`);
    });

    // SUPER ADMIN PDF TEMPLATE CONTROL round (Round 1 — form-based template
    // manager, not the full visual editor; see README) — reuses the exact
    // same "settingsManage" legacy-key gate as the rest of Settings
    // (company info, PDF accent color, brand color). No new permission.
    await check("PDF templates: GET is public within the app but blocked for a role without settingsManage (Manager)", async () => {
      const fresh = await login("xasan.cali", DEMO_PW);
      const { status } = await api("/api/pdf-templates?kind=quotation", {}, fresh);
      assert(status === 403, `expected 403, got ${status}`);
    });
    await check("PDF templates: the seeded built-in default exists and can't be deleted or archived while it's the default", async () => {
      const { status, body } = await api("/api/pdf-templates?kind=quotation", {}, saToken);
      assert(status === 200, `expected 200, got ${status}`);
      const builtin = body.templates.find((t) => t.isBuiltin);
      assert(builtin, "expected a seeded built-in template");
      assert(builtin.isDefault === true, "expected the built-in template to start as the default");
      const del = await api(`/api/pdf-templates/${builtin.id}`, { method: "DELETE" }, saToken);
      assert(del.status === 400, `expected 400 deleting the built-in default, got ${del.status}`);
      const arc = await api(`/api/pdf-templates/${builtin.id}/archive`, { method: "POST" }, saToken);
      assert(arc.status === 400, `expected 400 archiving the current default, got ${arc.status}`);
    });
    await check("PDF templates: create, set as default, then the OLD default becomes archivable and deletable", async () => {
      const before = await api("/api/pdf-templates?kind=quotation", {}, saToken);
      const builtinId = before.body.templates.find((t) => t.isBuiltin).id;
      const created = await api("/api/pdf-templates", { method: "POST", body: { kind: "quotation", name: "QA custom template", showSignatureLines: false, headerNote: "{{company_name}}", footerText: "{{company_website}}" } }, saToken);
      assert(created.status === 201, `expected 201, got ${created.status}`);
      const newId = created.body.template.id;
      const setDef = await api(`/api/pdf-templates/${newId}/set-default`, { method: "POST" }, saToken);
      assert(setDef.status === 200 && setDef.body.template.isDefault === true, "expected the new template to become the default");
      const afterList = await api("/api/pdf-templates?kind=quotation", {}, saToken);
      const builtinNow = afterList.body.templates.find((t) => t.id === builtinId);
      assert(builtinNow.isDefault === false, "expected exactly one default — the OLD default should no longer be flagged default");
      const arc = await api(`/api/pdf-templates/${builtinId}/archive`, { method: "POST" }, saToken);
      assert(arc.status === 200, `expected the no-longer-default built-in to now archive cleanly, got ${arc.status}`);
      const restore = await api(`/api/pdf-templates/${builtinId}/restore`, { method: "POST" }, saToken);
      assert(restore.status === 200 && restore.body.template.isArchived === false, "expected restore to un-archive it");
      const delNew = await api(`/api/pdf-templates/${newId}`, { method: "DELETE" }, saToken);
      assert(delNew.status === 400, `expected 400 deleting the current default, got ${delNew.status}`);
      const setBack = await api(`/api/pdf-templates/${builtinId}/set-default`, { method: "POST" }, saToken);
      assert(setBack.status === 200, "expected setting the built-in back as default to succeed");
      const cleanup = await api(`/api/pdf-templates/${newId}`, { method: "DELETE" }, saToken);
      assert(cleanup.status === 200, `expected the now-non-default custom template to delete cleanly, got ${cleanup.status}`);
    });
    await check("PDF templates: header/footer placeholders actually substitute into a rendered preview PDF", async () => {
      const before = await api("/api/pdf-templates?kind=quotation", {}, saToken);
      const builtinId = before.body.templates.find((t) => t.isBuiltin).id;
      const patch = await api(`/api/pdf-templates/${builtinId}`, { method: "PATCH", body: { headerNote: "Licensed by {{company_name}}" } }, saToken);
      assert(patch.status === 200 && patch.body.template.version === 2, `expected PATCH to bump version to 2, got ${JSON.stringify(patch.body)}`);
      const previewRes = await fetch(`${BASE}/api/pdf-templates/${builtinId}/preview.pdf`, { headers: { Authorization: `Bearer ${saToken}` } });
      assert(previewRes.status === 200, `expected 200 from preview.pdf, got ${previewRes.status}`);
      const buf = Buffer.from(await previewRes.arrayBuffer());
      assert(buf.slice(0, 4).toString() === "%PDF", "expected a real PDF file back from preview.pdf");
      // revert the header note so this check leaves no lasting side effect
      await api(`/api/pdf-templates/${builtinId}`, { method: "PATCH", body: { headerNote: "" } }, saToken);
    });
    await check("PDF templates: an unknown template id 404s on every action route, not just GET", async () => {
      const a = await api("/api/pdf-templates/nope", {}, saToken);
      const b = await api("/api/pdf-templates/nope/set-default", { method: "POST" }, saToken);
      const c = await api("/api/pdf-templates/nope/archive", { method: "POST" }, saToken);
      const d = await api("/api/pdf-templates/nope", { method: "DELETE" }, saToken);
      assert(a.status === 404 && b.status === 404 && c.status === 404 && d.status === 404, `expected all 404s, got ${a.status}/${b.status}/${c.status}/${d.status}`);
    });

    // -----------------------------------------------------------------
    // ENTERPRISE FINANCIAL DASHBOARD round: the payload from GET
    // /api/dashboard is shaped by the caller's REAL permissions server
    // side (never left to the frontend to hide) — these checks drive that
    // with real demo accounts of known, different grant combinations
    // (see LEGACY_PERMS_SNAPSHOT in db.js) rather than a synthetic role.
    // -----------------------------------------------------------------
    await check("GET /api/dashboard requires authentication", async () => {
      const { status } = await api("/api/dashboard", {});
      assert(status === 401, `expected 401, got ${status}`);
    });
    await check("a user without 'reports' (Cashier) gets only meta — no summary/financial sections", async () => {
      const cashToken = await login("cabdi.maxamed", DEMO_PW);
      const { status, body } = await api("/api/dashboard", {}, cashToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert(body.meta && body.meta.gates.reports === false, "expected meta.gates.reports to be false for a Cashier");
      assert(body.summary === undefined, "a Cashier's payload should have no summary section at all");
      assert(body.exchangeActivity === undefined && body.quotationPerformance === undefined, "no financial section should leak through without 'reports'");
    });
    await check("Accountant (reports+exchange, no quotations) sees exchange data but not quotation data", async () => {
      const acctToken = await login("faadumo.warsame", DEMO_PW);
      const { status, body } = await api("/api/dashboard" + "?range=last6Months", {}, acctToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert(body.meta.gates.reports === true && body.meta.gates.exchange === true && body.meta.gates.quotations === false, `unexpected gates: ${JSON.stringify(body.meta.gates)}`);
      assert(body.summary && typeof body.summary.usdBalance === "number", "expected a real summary section");
      assert(body.exchangeActivity !== undefined, "expected exchangeActivity (Accountant has exchangeCreate+exchangeAll)");
      assert(body.quotationPerformance === undefined && body.recentQuotations === undefined, "quotation sections should be absent — Accountant lacks quotationsManage/quotationsApprove");
    });
    await check("Viewer (reports only, no exchange/quotations grants) sees summary but neither exchange nor quotation sections", async () => {
      const viewerToken = await login("sahra.ismail", DEMO_PW);
      const { status, body } = await api("/api/dashboard", {}, viewerToken);
      assert(status === 200, `expected 200, got ${status}`);
      assert(body.summary !== undefined, "Viewer has 'reports' so summary should be present");
      assert(body.exchangeActivity === undefined && body.quotationPerformance === undefined, "Viewer lacks exchange/quotation grants — those sections must be absent");
    });
    await check("CURRENCY SAFETY: summary.moneyIn/moneyOut are always {usd, slsh} pairs, never a combined scalar", async () => {
      const saDashboard = await api("/api/dashboard?range=thisYear", {}, saToken);
      const s = saDashboard.body.summary;
      assert(typeof s.moneyIn.usd === "number" && typeof s.moneyIn.slsh === "number", "expected moneyIn to be a real {usd, slsh} pair");
      assert(typeof s.moneyOut.usd === "number" && typeof s.moneyOut.slsh === "number", "expected moneyOut to be a real {usd, slsh} pair");
      assert(!("combined" in s.moneyIn) && !("total" in s.moneyIn), "moneyIn must never carry a pre-summed USD+SLSH total");
    });
    await check("dashboard.customize / dashboard.export are NOT granted to a legacy role without the new extra grant", async () => {
      const mgrToken2 = await login("xasan.cali", DEMO_PW);
      const patch = await api("/api/dashboard-layout", { method: "PATCH", body: { scope: "system", widgets: [] } }, mgrToken2);
      assert(patch.status === 403, `expected 403 (Manager lacks dashboard.customize), got ${patch.status}`);
      const csv = await api("/api/dashboard/export.csv", {}, mgrToken2);
      assert(csv.status === 403, `expected 403 (Manager lacks dashboard.export), got ${csv.status}`);
    });
    await check("dashboard.customize / dashboard.export ARE granted to Admin via ADMIN_EXTRA_GRANTS", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const patch = await api("/api/dashboard-layout", { method: "PATCH", body: { scope: "system", widgets: [{ key: "summary", visible: true, size: "full" }] } }, adminToken);
      assert(patch.status === 200, `expected 200, got ${patch.status}: ${JSON.stringify(patch.body)}`);
      const csvRes = await fetch(`${BASE}/api/dashboard/export.csv`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert(csvRes.status === 200, `expected 200 from export.csv, got ${csvRes.status}`);
      const csvText = await csvRes.text();
      assert(csvText.includes("Metric"), "expected a real CSV export with a header row");
      // clean up the system default this check set, so later checks/e2e see the shipped default
      await api("/api/dashboard-layout?scope=system", { method: "DELETE" }, adminToken);
    });
    await check("dashboard-layout PATCH validates widget shape (array, size enum, no duplicate keys)", async () => {
      const notArray = await api("/api/dashboard-layout", { method: "PATCH", body: { widgets: "nope" } }, saToken);
      assert(notArray.status === 400, `expected 400 for a non-array widgets, got ${notArray.status}`);
      const badSize = await api("/api/dashboard-layout", { method: "PATCH", body: { widgets: [{ key: "summary", size: "huge" }] } }, saToken);
      assert(badSize.status === 400, `expected 400 for an invalid size, got ${badSize.status}`);
      const dupe = await api("/api/dashboard-layout", { method: "PATCH", body: { widgets: [{ key: "summary" }, { key: "summary" }] } }, saToken);
      assert(dupe.status === 400, `expected 400 for duplicate widget keys, got ${dupe.status}`);
      const ok = await api("/api/dashboard-layout", { method: "PATCH", body: { widgets: [{ key: "summary", visible: false, size: "half" }] } }, saToken);
      assert(ok.status === 200, `expected 200 for a valid widgets array, got ${ok.status}: ${JSON.stringify(ok.body)}`);
      // clean up this Super Admin's own personal layout
      await api("/api/dashboard-layout", { method: "DELETE" }, saToken);
    });
    await check("dashboard-layout: a personal ('me') layout always wins over the system default", async () => {
      await api("/api/dashboard-layout", { method: "PATCH", body: { scope: "system", widgets: [{ key: "summary", visible: false, size: "full" }] } }, saToken);
      const beforeMine = await api("/api/dashboard-layout", {}, saToken);
      assert(beforeMine.body.system.widgets[0].visible === false, "expected the system default to be persisted");
      await api("/api/dashboard-layout", { method: "PATCH", body: { scope: "me", widgets: [{ key: "summary", visible: true, size: "full" }] } }, saToken);
      const after = await api("/api/dashboard-layout", {}, saToken);
      assert(after.body.mine.widgets[0].visible === true, "expected the personal layout to be saved independently of the system default");
      // clean up both, restoring the shipped default for later runs
      await api("/api/dashboard-layout", { method: "DELETE" }, saToken);
      await api("/api/dashboard-layout?scope=system", { method: "DELETE" }, saToken);
    });

    // -----------------------------------------------------------------
    // SALE RATE / EXCHANGE PROFIT round — a brand new /api/sale-rate
    // endpoint (logged exactly like /api/rate) and the auto-computed
    // `profitUsd` fallback on POST/PATCH /api/transactions when the
    // caller doesn't explicitly supply one. The two confirmed-with-the-
    // business worked examples this round was built against: Daily Rate
    // 8,700, Sale Rate 8,650, $100 USD -> SLSH = +$0.58 profit; the same
    // spread with SLSH given -> USD received flips to -$0.58.
    // -----------------------------------------------------------------
    await check("GET /api/sale-rate requires authentication", async () => {
      const res = await api("/api/sale-rate");
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });
    await check("POST /api/sale-rate is blocked for a role without rateManage (Cashier)", async () => {
      const cashToken = await login("cabdi.maxamed", DEMO_PW);
      const res = await api("/api/sale-rate", { method: "POST", body: { rate: 8650 } }, cashToken);
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });
    await check("AUTO PROFIT: with no Sale Rate ever set, a new exchange's profit stays at the pre-existing 0 baseline", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const before = await api("/api/sale-rate", {}, adminToken);
      assert(before.body.rate === null, `expected no sale rate to be set yet, got ${JSON.stringify(before.body)}`);
      await api("/api/rate", { method: "POST", body: { rate: 8700 } }, adminToken);
      const created = await api("/api/transactions", { method: "POST", body: { clientName: "RBAC Sale Rate Test A", amountGiven: 100, currencyGiven: "USD" } }, adminToken);
      assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      assert(created.body.transaction.profitUsd === 0, `expected profit 0 with no Sale Rate set, got ${created.body.transaction.profitUsd}`);
    });
    await check("POST /api/sale-rate succeeds for a role with rateManage (Admin) and GET reflects it back with history", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const res = await api("/api/sale-rate", { method: "POST", body: { rate: 8650 } }, adminToken);
      assert(res.status === 200 && res.body.rate === 8650, `expected 200 with rate 8650, got ${res.status}: ${JSON.stringify(res.body)}`);
      const get = await api("/api/sale-rate", {}, adminToken);
      assert(get.body.rate === 8650, `expected current sale rate 8650, got ${get.body.rate}`);
      assert(Array.isArray(get.body.history) && get.body.history.some((h) => h.rate === 8650), "expected the new sale rate to appear in its own history");
    });
    await check("AUTO PROFIT: USD given -> SLSH received computes Profit = amountUSD * (dailyRate - saleRate) / saleRate", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const created = await api("/api/transactions", { method: "POST", body: { clientName: "RBAC Sale Rate Test B", amountGiven: 100, currencyGiven: "USD" } }, adminToken);
      assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      const expected = 100 * (8700 - 8650) / 8650;
      assert(Math.abs(created.body.transaction.profitUsd - expected) < 0.001, `expected profit ~${expected.toFixed(4)}, got ${created.body.transaction.profitUsd}`);
    });
    await check("AUTO PROFIT: SLSH given -> USD received flips the sign of the same spread", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const created = await api("/api/transactions", { method: "POST", body: { clientName: "RBAC Sale Rate Test C", amountGiven: 870000, currencyGiven: "SLSH" } }, adminToken);
      assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      const expected = -(100 * (8700 - 8650) / 8650); // 870,000 SLSH at rate 8700 = 100 USD received
      assert(Math.abs(created.body.transaction.profitUsd - expected) < 0.001, `expected profit ~${expected.toFixed(4)}, got ${created.body.transaction.profitUsd}`);
    });
    await check("AUTO PROFIT: an explicit profitUsd always overrides the auto-computed spread, on both create and update", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const created = await api("/api/transactions", { method: "POST", body: { clientName: "RBAC Sale Rate Test D", amountGiven: 50, currencyGiven: "USD", profitUsd: 42 } }, adminToken);
      assert(created.status === 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      assert(created.body.transaction.profitUsd === 42, `expected the explicit override 42 to be respected, got ${created.body.transaction.profitUsd}`);
      // Updating without an explicit profitUsd re-runs the (possibly
      // changed) amounts/rate through the current Sale Rate spread rather
      // than silently keeping the old override.
      const updated = await api(`/api/transactions/${created.body.transaction.id}`, { method: "PATCH", body: { clientName: "RBAC Sale Rate Test D", amountGiven: 50, currencyGiven: "USD" } }, adminToken);
      assert(updated.status === 200, `expected 200, got ${updated.status}: ${JSON.stringify(updated.body)}`);
      const expectedAuto = 50 * (8700 - 8650) / 8650;
      assert(Math.abs(updated.body.transaction.profitUsd - expectedAuto) < 0.001, `expected the PATCH (no explicit profitUsd) to recompute to ~${expectedAuto.toFixed(4)}, got ${updated.body.transaction.profitUsd}`);
    });
    await check("POST /api/sale-rate also succeeds for Manager (also has rateManage) — same gate as Daily Rate", async () => {
      const mgrToken = await login("xasan.cali", DEMO_PW);
      const res = await api("/api/sale-rate", { method: "POST", body: { rate: 8660 } }, mgrToken);
      assert(res.status === 200 && res.body.rate === 8660, `expected 200 with rate 8660, got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    // -----------------------------------------------------------------
    // RATE MANAGEMENT UNIFICATION round — the new /api/rate-history
    // surface behind the header/Dashboard "Manage Rates" and the Money
    // Exchange "Rate history" tab's "Set Rates" action. Gated on the
    // same single `rateManage` permission as /api/rate and /api/sale-rate
    // (the person's explicit choice — no new granular keys). At this
    // point in the suite: Daily Rate = 8,700 (set earlier), Sale Rate =
    // 8,660 (just set above by Manager) — both via the OLD endpoints,
    // proving the old and new endpoints genuinely share one history.
    // -----------------------------------------------------------------
    await check("GET /api/rate-history requires authentication", async () => {
      const res = await api("/api/rate-history");
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });
    await check("GET and POST /api/rate-history are blocked for a role without rateManage (Cashier)", async () => {
      const cashToken = await login("cabdi.maxamed", DEMO_PW);
      const get = await api("/api/rate-history", {}, cashToken);
      assert(get.status === 403, `expected 403 on GET, got ${get.status}`);
      const post = await api("/api/rate-history", { method: "POST", body: { dailyRate: 8710, saleRate: 8665 } }, cashToken);
      assert(post.status === 403, `expected 403 on POST, got ${post.status}`);
    });
    await check("GET /api/rate-history reflects the rates set via the OLD /api/rate + /api/sale-rate endpoints — one shared history", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const res = await api("/api/rate-history", {}, adminToken);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(Array.isArray(res.body.history) && res.body.history.length > 0, "expected a non-empty unified history");
      assert(res.body.summary.currentDaily === 8700, `expected summary.currentDaily 8700, got ${res.body.summary.currentDaily}`);
      assert(res.body.summary.currentSale === 8660, `expected summary.currentSale 8660, got ${res.body.summary.currentSale}`);
      assert(res.body.summary.currentDifference === 40, `expected summary.currentDifference 40 (8700-8660), got ${res.body.summary.currentDifference}`);
      const newest = res.body.history[0];
      assert(newest.status === "Active", `expected the newest row to be Active, got ${newest.status}`);
      assert(newest.dailyRate === 8700 && newest.saleRate === 8660, `expected the newest row to carry BOTH current values (one shared record), got ${JSON.stringify(newest)}`);
    });
    await check("POST /api/rate-history succeeds for Admin, saves ONE combined record, and computes the Rate Difference", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const res = await api("/api/rate-history", { method: "POST", body: { dailyRate: 8710, saleRate: 8665, note: "RBAC combined save test" } }, adminToken);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.dailyRate === 8710 && res.body.saleRate === 8665, `expected the response to echo both saved values, got ${JSON.stringify(res.body)}`);
      assert(res.body.difference === 45, `expected difference 8710-8665=45, got ${res.body.difference}`);
      assert(res.body.currencyPair === "USD_SLSH", `expected currencyPair USD_SLSH, got ${res.body.currencyPair}`);
      // GET /api/rate and GET /api/sale-rate (the OLD endpoints) must also
      // see this new value, proving there is really only one underlying
      // history table behind all three endpoints.
      const oldRate = await api("/api/rate", {}, adminToken);
      assert(oldRate.body.rate === 8710, `expected /api/rate to reflect the combined save, got ${oldRate.body.rate}`);
      const oldSale = await api("/api/sale-rate", {}, adminToken);
      assert(oldSale.body.rate === 8665, `expected /api/sale-rate to reflect the combined save, got ${oldSale.body.rate}`);
    });
    await check("GET /api/rate-history/:id returns the full detail record", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const list = await api("/api/rate-history", {}, adminToken);
      const id = list.body.history[0].id;
      const res = await api(`/api/rate-history/${id}`, {}, adminToken);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.id === id, "expected the detail record to match the requested id");
      assert(res.body.dailyRate === 8710 && res.body.saleRate === 8665, `expected the detail record's values to match the latest save, got ${JSON.stringify(res.body)}`);
      assert(res.body.note === "RBAC combined save test", `expected the note to round-trip, got ${res.body.note}`);
    });
    await check("GET /api/rate-history/:id returns 404 for an unknown id", async () => {
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const res = await api("/api/rate-history/does-not-exist", {}, adminToken);
      assert(res.status === 404, `expected 404, got ${res.status}`);
    });
    await check("POST /api/rate-history also succeeds for Manager (also has rateManage) — same gate as Daily/Sale Rate", async () => {
      const mgrToken = await login("xasan.cali", DEMO_PW);
      const res = await api("/api/rate-history", { method: "POST", body: { dailyRate: 8720, saleRate: 8670 } }, mgrToken);
      assert(res.status === 200 && res.body.dailyRate === 8720 && res.body.saleRate === 8670, `expected 200 with the new combined rates, got ${res.status}: ${JSON.stringify(res.body)}`);
    });
    await check("GET /api/rate-history/export.csv is blocked for Cashier (403) and returns a real CSV for Admin (200)", async () => {
      const cashToken = await login("cabdi.maxamed", DEMO_PW);
      const blocked = await api("/api/rate-history/export.csv", {}, cashToken);
      assert(blocked.status === 403, `expected 403, got ${blocked.status}`);
      const adminToken = await login("amina.yusuf", DEMO_PW);
      const csvRes = await fetch(`${BASE}/api/rate-history/export.csv`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert(csvRes.status === 200, `expected 200 from export.csv, got ${csvRes.status}`);
      const csvText = await csvRes.text();
      assert(csvText.includes("Daily Rate") && csvText.includes("Sale Rate") && csvText.includes("Rate Difference"), "expected a real unified CSV export with the combined header row");
    });

    console.log("\nAll RBAC checks passed.");
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 200));
    if (server.exitCode !== null && server.exitCode !== 0 && server.exitCode !== null) {
      // non-zero/unexpected exit while checks were still running is
      // already surfaced by the failing check itself; nothing extra to do.
    }
    cleanDb();
  }
}

async function main() {
  await partA();
  await partB();
}

main().catch((e) => {
  console.error("\nRBAC test FAILED:", e.message);
  cleanDb();
  process.exit(1);
});
