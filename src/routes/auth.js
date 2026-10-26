"use strict";
const pwThrottle = require("../password-throttle");
const { get, run } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const authLib = require("../auth");
const { requireAuth, requirePlatformAdmin, ROLE_LABELS, sessionVersionClaims, resolvedPermsPayload, loadRoleForUser } = require("../rbac");
const { setRequestTenant } = require("../tenant-context");
const { addAudit } = require("../domain");
const { nowISO } = require("../util");

// SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 3: every
// user payload now carries the live-resolved `perms`/`isSuperAdmin`/
// `roleLabel` from resolvedPermsPayload (src/rbac.js) — computed through the
// exact same engine every backend route enforces with — so app.jsx's sidebar
// and buttons can gate off real, DB-backed permissions instead of the old
// hard-coded PERMS table. `roleLabel` here supersedes the flat
// ROLE_LABELS[u.role] lookup (still imported/used as ROLE_LABELS' own
// fallback inside roleDisplayName) so a Super Admin correctly shows "Super
// Admin", not "Admin", even though their legacy `role` column still stores
// 'admin' for CHECK-constraint compatibility.
function publicUser(u) {
  let columnPrefs = null;
  try { columnPrefs = u.quotation_column_prefs ? JSON.parse(u.quotation_column_prefs) : null; } catch (e) { columnPrefs = null; }
  const resolved = resolvedPermsPayload(u);
  return {
    id: u.id, name: u.name, username: u.username, role: u.role,
    // USER ROLE EDIT FIX round: `roleId` was missing entirely — app.jsx's
    // Edit User modal (UserFormModal) needs the user's REAL current role id
    // to preselect the Role dropdown correctly. Without it, the modal fell
    // back to "whichever role loads first in the list" (Super Admin, since
    // it's seeded first) for every single user, every time the modal
    // opened — making a saved role change look like it "didn't take" on
    // reopen, and risking an accidental Super Admin reassignment if someone
    // saved without noticing the wrong preselected value.
    roleId: u.role_id,
    roleLabel: resolved.roleLabel, isSuperAdmin: resolved.isSuperAdmin, perms: resolved.perms,
    rawKeys: resolved.rawKeys,
    active: !!u.active, lastLogin: u.last_login, quotationColumnPrefs: columnPrefs,
  };
}

// SECURITY HARDENING: brute-force protection for /api/auth/login. Tracked
// in-memory per username (not per-IP — an attacker can trivially rotate or
// spoof source IPs/forwarded headers, but can't rotate the username they're
// trying to guess a password for). Generous enough not to lock out a real
// user who mistypes their password a couple of times: 5 failed attempts
// opens a 15-minute lockout, and the counter itself resets after 15 minutes
// of inactivity. A successful login always clears the counter immediately.
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const FAILED_LOGIN_MAX_ATTEMPTS = 5;
const FAILED_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // lowercase username -> { count, firstAttemptAt, lockedUntil }

function loginRateLimitStatus(username) {
  const key = String(username).toLowerCase();
  const entry = failedLogins.get(key);
  if (!entry) return { allowed: true };
  const now = Date.now();
  if (entry.lockedUntil) {
    if (now < entry.lockedUntil) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    failedLogins.delete(key); // lockout expired
    return { allowed: true };
  }
  if (now - entry.firstAttemptAt > FAILED_LOGIN_WINDOW_MS) {
    failedLogins.delete(key); // window expired with no lockout triggered
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedLogin(username) {
  const key = String(username).toLowerCase();
  const now = Date.now();
  let entry = failedLogins.get(key);
  if (!entry || (now - entry.firstAttemptAt > FAILED_LOGIN_WINDOW_MS && !entry.lockedUntil)) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= FAILED_LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + FAILED_LOGIN_LOCKOUT_MS;
  }
  failedLogins.set(key, entry);
  trimMap(failedLogins);
}

function clearFailedLogins(username) {
  failedLogins.delete(String(username).toLowerCase());
}

// SECURITY AUDIT round: the per-username lockout above can't stop one
// source from trying a few passwords against MANY usernames (password
// spraying), and its Map grew forever with every random username tried.
// Added: a per-source limit (failed attempts from one IP address), a hard
// cap on both maps, and a periodic sweep of expired entries.
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILURES = 30;
const MAX_TRACKED = 20000;
const failedByIp = new Map(); // ip -> { count, firstAttemptAt }

// The address the request really came from. Behind Railway's proxy that is
// the LAST X-Forwarded-For entry (added by the proxy itself — earlier
// entries are whatever the client claimed); otherwise the socket address.
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return (xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress)) || "unknown";
}
function ipBlockedFor(ip) {
  const e = failedByIp.get(ip);
  if (!e) return 0;
  const age = Date.now() - e.firstAttemptAt;
  if (age > IP_WINDOW_MS) { failedByIp.delete(ip); return 0; }
  return e.count >= IP_MAX_FAILURES ? Math.ceil((IP_WINDOW_MS - age) / 1000) : 0;
}
function recordIpFailure(ip) {
  const now = Date.now();
  let e = failedByIp.get(ip);
  if (!e || now - e.firstAttemptAt > IP_WINDOW_MS) e = { count: 0, firstAttemptAt: now };
  e.count += 1;
  failedByIp.delete(ip); failedByIp.set(ip, e); // keep insertion order = recency
  trimMap(failedByIp);
}
function trimMap(m) {
  while (m.size > MAX_TRACKED) m.delete(m.keys().next().value);
}
function sweepLoginTracking() {
  const now = Date.now();
  for (const [k, e] of failedLogins) {
    if (e.lockedUntil ? now >= e.lockedUntil : now - e.firstAttemptAt > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(k);
  }
  for (const [k, e] of failedByIp) if (now - e.firstAttemptAt > IP_WINDOW_MS) failedByIp.delete(k);
}
setInterval(sweepLoginTracking, 5 * 60 * 1000).unref();

// MULTI-COMPANY round: what the frontend gets about the signed-in session —
// the usual publicUser() shape plus which company the session is bound to
// (null for a Super Admin who hasn't picked a workspace yet) and whether this
// is a platform Super Admin (who sees the Companies console + switcher).
function sessionUser(userRow, company, platformUser) {
  const tenancy = require("../tenancy");
  if (!userRow && platformUser) {
    const perms = {};
    for (const key of Object.keys(require("../permissions").LEGACY_KEY_MAP)) perms[key] = true;
    return {
      id: platformUser.id, name: platformUser.name, username: platformUser.username, role: "admin", roleId: null,
      roleLabel: "Super Admin", isSuperAdmin: true, isPlatformAdmin: true, perms, rawKeys: null,
      active: platformUser.status === "active", lastLogin: platformUser.last_login, quotationColumnPrefs: null,
      company: null,
    };
  }
  // COMPANY ID VISIBILITY round: Company Admins/Staff get their company's
  // name and status only — never its Company ID.
  const companyView = platformUser
    ? tenancy.publicCompany(company, { includeLogo: false })
    : (company ? { name: company.name, status: company.status } : null);
  return { ...publicUser(userRow), isPlatformAdmin: !!platformUser, company: companyView };
}

function register(router) {
  router.post("/api/auth/login", async (req, res) => {
    let body;
    try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const { username, password } = body;
    if (!username || !password) return badRequest(res, "Username and password are required.");
    if (typeof username !== "string" || typeof password !== "string" || username.length > 100 || password.length > 200) {
      return badRequest(res, "Invalid username or password format.");
    }
    const tenancy = require("../tenancy");
    const ip = clientIp(req);
    const ipWait = ipBlockedFor(ip);
    if (ipWait) {
      res.setHeader("Retry-After", String(ipWait));
      return sendJSON(res, 429, { error: "Too many failed login attempts. Please try again in a few minutes." });
    }

    const rateStatus = loginRateLimitStatus(username);
    if (!rateStatus.allowed) {
      tenancy.platformAudit({ name: String(username) }, "Login blocked", null, `Too many failed login attempts; temporarily locked for ${rateStatus.retryAfterSeconds}s`);
      res.setHeader("Retry-After", String(rateStatus.retryAfterSeconds));
      return sendJSON(res, 429, { error: "Too many failed login attempts. Please try again in a few minutes." });
    }
    const uname = tenancy.normalizeUsername(username);
    const invalid = () => sendJSON(res, 401, { error: "Invalid username or password, or the account is inactive." });

    // 1) Platform Super Admin?
    const pu = tenancy.getPlatformUserByUsername(uname);
    if (pu) {
      if (pu.status !== "active" || !authLib.verifyPassword(password, pu.password_hash, pu.password_salt)) {
        recordFailedLogin(username); recordIpFailure(ip);
        tenancy.platformAudit({ id: pu.id, name: pu.name }, "Failed login attempt", null, pu.status !== "active" ? "Account inactive" : "Invalid credentials");
        return invalid();
      }
      clearFailedLogins(username);
      require("../tenant-context").allowCompanyIds();
      tenancy.crun("UPDATE platform_users SET last_login = ? WHERE id = ?", [nowISO(), pu.id]);
      const mustChange = authLib.isKnownDefaultPassword(password);
      const token = authLib.sign({ sub: pu.id, kind: "platform", pv: pu.permissions_version, name: pu.name, cid: null, ...(mustChange ? { mpc: 1 } : {}) });
      tenancy.platformAudit({ id: pu.id, name: pu.name }, "Super Admin logged in", null, mustChange ? "Signed in with a published default password — password change required" : "");
      return sendJSON(res, 200, { token, user: { ...sessionUser(null, null, tenancy.getPlatformUser(pu.id)), mustChangePassword: mustChange } });
    }

    // 2) A company user — the directory says which ONE company they belong to.
    const entry = tenancy.lookupDirectory(uname);
    const company = entry ? tenancy.getCompany(entry.company_id) : null;
    if (!company) {
      authLib.burnPasswordCheck(password); // same response time as a wrong password
      recordFailedLogin(username); recordIpFailure(ip);
      tenancy.platformAudit({ name: String(username) }, "Failed login attempt", null, "Invalid credentials");
      return invalid();
    }
    let tenant;
    try { tenant = tenancy.openTenant(company); } catch (e) { return sendJSON(res, 503, { error: "This company's data is temporarily unavailable." }); }
    setRequestTenant(tenant, company);
    // Same eligibility rule as before multi-company support (active flag), so
    // nobody who could sign in yesterday is locked out by this upgrade.
    const user = get("SELECT * FROM users WHERE id = ? AND username = ?", [entry.user_id, uname]);
    const role = user ? loadRoleForUser(user) : null;
    if (!user) authLib.burnPasswordCheck(password);
    if (!user || !user.active || (role && role.is_super_admin) || !authLib.verifyPassword(password, user.password_hash, user.password_salt)) {
      recordFailedLogin(username); recordIpFailure(ip);
      addAudit(
        user || { name: String(username) },
        "Failed login attempt",
        user && !user.active ? "Account inactive" : "Invalid credentials"
      );
      return invalid();
    }
    // Only revealed AFTER a correct password, so it can't be probed.
    if (company.status !== "active") {
      addAudit(user, "Login refused", `Company is ${company.status}`);
      return sendJSON(res, 403, { error: tenancy.companyAccessMessage(company), code: "COMPANY_SUSPENDED", companyStatus: company.status });
    }
    clearFailedLogins(username);
    run("UPDATE users SET last_login = ? WHERE id = ?", [nowISO(), user.id]);
    // rolePermVer/userPermVer: a snapshot this session's permissions are
    // pinned to — requireAuth (src/rbac.js) rejects this token the moment
    // either has moved on the live row, forcing a fresh login (SESSION
    // SECURITY: permission/role changes take effect immediately, not just
    // on next natural token expiry). `cid` binds the session to the user's
    // own company — it is the ONLY place the server learns which company a
    // request is for.
    // The company is sealed (`cref`) so the Company ID can't be read out of the token.
    const mustChange = authLib.isKnownDefaultPassword(password);
    const token = authLib.sign({ sub: user.id, kind: "tenant", cref: authLib.sealCompanyId(company.id), role: user.role, name: user.name, ...sessionVersionClaims(user), ...(mustChange ? { mpc: 1 } : {}) });
    addAudit(user, "User logged in", mustChange ? "Signed in with a published default password — password change required" : "");
    sendJSON(res, 200, { token, user: { ...sessionUser(user, company, null), mustChangePassword: mustChange } });
  });

  router.get("/api/auth/me", (req, res) => {
    // A Super Admin with no company selected yet only has the platform console.
    const header = req.headers["authorization"] || "";
    const payload = authLib.verify(header.startsWith("Bearer ") ? header.slice(7) : null);
    const mpc = !!(payload && payload.mpc);
    if (payload && payload.kind === "platform" && !payload.cid) {
      const pu = requirePlatformAdmin(req, res, { allowPasswordChange: true }); if (!pu) return;
      return sendJSON(res, 200, { user: { ...sessionUser(null, null, require("../tenancy").getPlatformUser(pu.id)), mustChangePassword: mpc } });
    }
    const authed = requireAuth(req, res, { allowPasswordChange: true });
    if (!authed) return;
    const full = get("SELECT * FROM users WHERE id = ?", [authed.id]);
    sendJSON(res, 200, { user: { ...sessionUser(full, authed._company, authed._platformUser || null), mustChangePassword: mpc } });
  });

  // SECURITY AUDIT round: self-service password change for company users
  // (Super Admins use POST /api/platform/me/password). Requires the current
  // password, applies the password policy, ends every other session of this
  // user, and returns a fresh token for this one. Also the way out of the
  // "must change password" state a default-password login is put in.
  router.post("/api/auth/me/password", async (req, res) => {
    const authed = requireAuth(req, res, { allowPasswordChange: true });
    if (!authed) return;
    if (authed._platformUser) return badRequest(res, "Super Admins change their password from the Super Admin account menu.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const full = get("SELECT * FROM users WHERE id = ?", [authed.id]);
    if (!full) return sendJSON(res, 401, { error: "Account not found or deactivated." });
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const throttleKey = `${authed._company ? authed._company.id : "-"}:${authed.id}`;
    const wait = pwThrottle.blocked(throttleKey);
    if (wait) return sendJSON(res, 429, { error: "Too many incorrect attempts. Please try again in a few minutes." });
    if (!current || !authLib.verifyPassword(current, full.password_hash, full.password_salt)) {
      pwThrottle.fail(throttleKey);
      addAudit(authed, "Password change refused", "Current password incorrect");
      return badRequest(res, "Current password is incorrect.");
    }
    pwThrottle.succeed(throttleKey);
    const pwErr = authLib.passwordPolicyError(body.newPassword, { username: full.username });
    if (pwErr) return badRequest(res, pwErr);
    if (body.newPassword === current) return badRequest(res, "The new password must be different from the current one.");
    const { hash, salt } = authLib.hashPassword(body.newPassword);
    run("UPDATE users SET password_hash = ?, password_salt = ?, permissions_version = permissions_version + 1 WHERE id = ?", [hash, salt, full.id]);
    const fresh = get("SELECT * FROM users WHERE id = ?", [full.id]);
    addAudit(authed, "Password changed", "Self-service; all other sessions signed out");
    const token = authLib.sign({ sub: fresh.id, kind: "tenant", cref: authLib.sealCompanyId(authed._company.id), role: fresh.role, name: fresh.name, ...sessionVersionClaims(fresh) });
    sendJSON(res, 200, { ok: true, token, user: { ...sessionUser(fresh, authed._company, null), mustChangePassword: false } });
  });

  // Self-service: save this user's own quotation column layout (visible
  // columns, order, and any custom columns) — "Save as Default" in the UI.
  router.patch("/api/auth/me/quotation-column-prefs", async (req, res) => {
    const authed = requireAuth(req, res);
    if (!authed) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const json = body.prefs === null ? null : JSON.stringify(body.prefs || {});
    run("UPDATE users SET quotation_column_prefs = ? WHERE id = ?", [json, authed.id]);
    const full = get("SELECT * FROM users WHERE id = ?", [authed.id]);
    sendJSON(res, 200, { user: sessionUser(full, authed._company, authed._platformUser || null) });
  });
}

module.exports = { register, publicUser, sessionUser };
