"use strict";
const { all } = require("../db");
const { sendJSON } = require("../http-helpers");
const { requireAuth, can } = require("../rbac");

function register(router) {
  // Recent system activity, surfaced as notifications.
  // SECURITY AUDIT round: the full feed IS the audit log (amounts, account
  // names, user/permission changes, other-currency activity), which
  // everywhere else requires the Reports permission. Users with Reports
  // still see everyone's activity; everyone else sees only their own.
  router.get("/api/notifications", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    const limit = Math.min(Math.max(1, Number(query.limit) || 25), 50);
    const rows = can(user, "reports")
      ? all("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?", [limit])
      : all("SELECT * FROM audit_log WHERE actor_id = ? ORDER BY at DESC LIMIT ?", [user.id, limit]);
    sendJSON(res, 200, {
      notifications: rows.map((r) => ({
        id: r.id, action: r.action, details: r.details,
        actorName: r.actor_name, actorRole: r.actor_role, at: r.at,
      })),
    });
  });
}

module.exports = { register };
