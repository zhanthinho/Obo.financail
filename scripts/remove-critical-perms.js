"use strict";
// Owner-approved cleanup: CRITICAL permissions belong to the Super Admin only.
//
//   node scripts/remove-critical-perms.js            (dry run — shows what would change)
//   node scripts/remove-critical-perms.js --confirm  (makes the change)
//   ROLES-SUPERADMIN-ONLY.bat                        (backup first, then --confirm)
//
// In every company it removes each CRITICAL permission (src/permissions.js —
// deleting / reversing financial records, user & role administration,
// company settings) from every role that is not the protected Super Admin
// role, and from any per-user override that grants one. Every other
// permission is left exactly as it is. No financial record is touched.
//
// For each changed role the role's permissions_version is bumped (holders are
// signed out and get the new rights at once, as with an edit in the app) and
// an audit entry "Role updated" is written in that company's Audit Log.
// Each company is changed inside one transaction: all or nothing.
require("../src/env");
const crypto = require("crypto");
const { SyncMysql } = require("../src/mysql/sync-client");
const { readConfig } = require("../src/mysql/connection");
const { CompatDb } = require("../src/mysql/compat-db");
const schema = require("../src/mysql/schema");
const P = require("../src/permissions");

const CONFIRM = process.argv.includes("--confirm");
const client = new SyncMysql(readConfig());
const present = new Set(client.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").rows.map((r) => r.n));
const open = (cid) => new CompatDb(client, { kind: "tenant", companyId: cid, prefix: schema.companyPrefix(cid), tables: new Set(schema.tableNames("tenant")) });
const companies = present.has(`${schema.CONTROL_PREFIX}companies`) ? client.query(`SELECT id, name FROM "${schema.CONTROL_PREFIX}companies" ORDER BY seq`).rows : [];
const label = (k) => (P.PERMISSION_CATALOG.find((c) => c.key === k) || {}).label || k;
const isCritical = (k) => P.permissionLevel(k) === "critical";
const now = () => new Date().toISOString();
const ACTOR = "Super Admin only — owner-approved cleanup";

let changedRoles = 0, changedOverrides = 0;
console.log(CONFIRM ? "CHANGING: critical permissions -> Super Admin only" : "DRY RUN (nothing is changed — add --confirm to apply)");
for (const co of companies) {
  const db = open(co.id);
  if (!present.has(db.table("roles"))) continue;
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const x = (sql, ...p) => db.prepare(sql).run(...p);
  console.log(`\n=== ${co.name} (${co.id}) ===`);
  const plan = [];
  for (const r of q("SELECT id, name, is_super_admin FROM roles ORDER BY name")) {
    if (r.is_super_admin) continue;
    const crit = q("SELECT permission_key FROM role_permissions WHERE role_id = ?", r.id).map((p) => p.permission_key).filter(isCritical);
    if (crit.length) plan.push({ kind: "role", r, crit });
  }
  const hasOverrides = present.has(db.table("user_permission_overrides"));
  const overrides = hasOverrides ? q(
    "SELECT o.user_id, o.permission_key, u.name, u.username, u.role_id FROM user_permission_overrides o JOIN users u ON u.id = o.user_id WHERE o.granted = 1"
  ).filter((o) => isCritical(o.permission_key)) : [];
  const superRoleIds = new Set(q("SELECT id FROM roles WHERE is_super_admin = 1").map((r) => r.id));
  const ov = overrides.filter((o) => !superRoleIds.has(o.role_id));

  if (!plan.length && !ov.length) { console.log("  nothing to change — only the Super Admin holds critical permissions."); continue; }
  for (const p of plan) console.log(`  - ${p.r.name}: remove ${p.crit.length} — ${p.crit.map(label).join("; ")}`);
  for (const o of ov) console.log(`  - user ${o.name} (${o.username}): remove personal grant — ${label(o.permission_key)}`);
  if (!CONFIRM) continue;

  client.query("START TRANSACTION");
  try {
    for (const p of plan) {
      for (const k of p.crit) x("DELETE FROM role_permissions WHERE role_id = ? AND permission_key = ?", p.r.id, k);
      x("UPDATE roles SET permissions_version = permissions_version + 1, updated_at = ?, updated_by = ? WHERE id = ?", now(), ACTOR, p.r.id);
      x("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES (?,?,?,?,?,?,?)",
        `log_${crypto.randomBytes(8).toString("hex")}`, now(), null, ACTOR, "system", "Role updated",
        `${p.r.name}: permissions — added: none; removed: ${p.crit.join(", ")}`);
      changedRoles++;
    }
    for (const o of ov) {
      x("DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_key = ? AND granted = 1", o.user_id, o.permission_key);
      x("UPDATE users SET permissions_version = permissions_version + 1 WHERE id = ?", o.user_id);
      x("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES (?,?,?,?,?,?,?)",
        `log_${crypto.randomBytes(8).toString("hex")}`, now(), null, ACTOR, "system", "User permissions updated",
        `${o.name} (${o.username}): removed personal grant ${o.permission_key}`);
      changedOverrides++;
    }
    client.query("COMMIT");
    console.log("  done.");
  } catch (e) {
    try { client.query("ROLLBACK"); } catch (e2) { /* already rolled back */ }
    console.log(`  [X] failed, nothing changed in this company: ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(CONFIRM
  ? `\n${changedRoles} role(s) and ${changedOverrides} personal grant(s) changed. Financial records were not touched.`
  : "\nDry run only. Nothing was changed.");
client.close();
