"use strict";
// SUPER ADMIN SYSTEM OVERVIEW round: a single, read-only aggregate view for
// Admin/Super Admin — "is the system healthy, who's in it, and what's
// changed lately" — one screen instead of stitching together the Users
// list, Roles list, and Audit Log separately. Everything here is a plain
// SELECT/COUNT against tables that already exist; no new schema, and no new
// permission — gated by the same "users" legacy key that already restricts
// the Users & Roles module to Admin/Super Admin (a Manager, who can't see
// Users & Roles today, shouldn't be able to see a page that summarizes it
// either).
const { get, all, db } = require("../db");
const { sendJSON } = require("../http-helpers");
const { requireAuth, requirePerm, roleDisplayName } = require("../rbac");
const { PERMISSION_CATALOG } = require("../permissions");
const { nowISO } = require("../util");

const RECENT_LIMIT = 8;

function register(router) {
  router.get("/api/system-overview", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "users")) return;

    const userCounts = get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
              SUM(CASE WHEN status = 'deactivated' THEN 1 ELSE 0 END) as deactivated,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended
       FROM users WHERE deleted_at IS NULL`
    );
    const roleCounts = get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
              SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) as inactive,
              SUM(CASE WHEN is_super_admin = 1 THEN 1 ELSE 0 END) as superAdmin,
              SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END) as protectedCount
       FROM roles`
    );
    const roleGrants = get("SELECT COUNT(*) as n FROM role_permissions").n;
    const userOverrides = get("SELECT COUNT(*) as n FROM user_permission_overrides").n;

    // Table row counts double as a quick sanity signal that the database is
    // actually reachable and populated, not just "the file exists".
    const tableCounts = {};
    for (const t of ["users", "roles", "clients", "exchange_transactions", "quotations", "account_ledger", "audit_log"]) {
      tableCounts[t] = get(`SELECT COUNT(*) as n FROM ${t}`).n;
    }
    // MYSQL round: "file size" is now the storage this company's own tables
    // use in MySQL (data + indexes), as reported by the server.
    let dbFileSizeBytes = null;
    try {
      const prefix = db.scope.prefix;
      dbFileSizeBytes = db.raw("SELECT TABLE_NAME AS t, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")
        .filter((r) => r.t.startsWith(prefix)).reduce((s, r) => s + Number(r.n || 0), 0);
    } catch (e) { /* fine — surfaced as null below */ }

    const recentChanges = all("SELECT id, at, actor_name, actor_role, action, details FROM audit_log ORDER BY at DESC LIMIT ?", [RECENT_LIMIT])
      .map((r) => ({ id: r.id, at: r.at, actorName: r.actor_name, actorRole: r.actor_role, action: r.action, details: r.details || "" }));

    const recentLoginRows = all(
      "SELECT id, name, role, role_id, status, last_login FROM users WHERE last_login IS NOT NULL AND deleted_at IS NULL ORDER BY last_login DESC LIMIT ?",
      [RECENT_LIMIT]
    );
    const recentLogins = recentLoginRows.map((r) => ({ id: r.id, name: r.name, roleLabel: roleDisplayName(r), status: r.status, lastLogin: r.last_login }));

    const since = (hours) => { const d = new Date(Date.now() - hours * 3600 * 1000); return d.toISOString(); };
    const auditActivity = {
      last24h: get("SELECT COUNT(*) as n FROM audit_log WHERE at >= ?", [since(24)]).n,
      last7d: get("SELECT COUNT(*) as n FROM audit_log WHERE at >= ?", [since(24 * 7)]).n,
      total: tableCounts.audit_log,
    };

    sendJSON(res, 200, {
      systemStatus: {
        serverTime: nowISO(),
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        // Field name kept for API compatibility; the engine is now MySQL.
        sqliteEngine: (() => { const i = require("../mysql/connection").info(); return i ? `MySQL ${i.version}` : "MySQL"; })(),
      },
      users: { total: userCounts.total || 0, active: userCounts.active || 0, deactivated: userCounts.deactivated || 0, suspended: userCounts.suspended || 0 },
      roles: { total: roleCounts.total || 0, active: roleCounts.active || 0, inactive: roleCounts.inactive || 0, superAdmin: roleCounts.superAdmin || 0, protectedCount: roleCounts.protectedCount || 0 },
      permissions: { catalogSize: PERMISSION_CATALOG.length, roleGrants, userOverrides },
      database: { fileSizeBytes: dbFileSizeBytes, walMode: true, tableCounts },
      recentChanges,
      recentLogins,
      auditActivity,
    });
  });
}

module.exports = { register };
