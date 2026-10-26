"use strict";
// AUTOMATIC BACKUPS (see ../backup.js): Super Admin-only endpoints to list
// the stored backups of the current company, take one on demand, and
// download one (gzip-compressed JSON). MYSQL round: backups live in the
// database, not in files.
const { sendJSON } = require("../http-helpers");
const { requireAuth, isSuperAdmin } = require("../rbac");
const { addAudit } = require("../domain");
const backup = require("../backup");

function requireSuper(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!isSuperAdmin(user)) {
    sendJSON(res, 403, { error: "Only a Super Admin can manage backups." });
    return null;
  }
  return user;
}

function register(router) {
  router.get("/api/backups", (req, res) => {
    const user = requireSuper(req, res); if (!user) return;
    sendJSON(res, 200, {
      backups: backup.listBackups(user._company),
      companyId: user._company.id,
      intervalHours: backup.INTERVAL_HOURS,
      keep: backup.KEEP,
    });
  });

  router.post("/api/backups", (req, res) => {
    const user = requireSuper(req, res); if (!user) return;
    try {
      const b = backup.backupNow(user._company, "manual", user.name);
      addAudit(user, "Database backup created", b.name);
      sendJSON(res, 201, b);
    } catch (e) {
      sendJSON(res, 500, { error: "Backup failed: " + e.message });
    }
  });

  router.get("/api/backups/:name", (req, res, params) => {
    const user = requireSuper(req, res); if (!user) return;
    let gz;
    try { gz = backup.backupFile(user._company, params.name); } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    if (!gz) return sendJSON(res, 404, { error: "Backup not found." });
    addAudit(user, "Database backup downloaded", params.name);
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": gz.length,
      "Content-Disposition": `attachment; filename="${params.name}"`,
      "Cache-Control": "no-store",
    });
    res.end(gz);
  });
}

module.exports = { register };
