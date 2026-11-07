"use strict";
// SYSTEM AUDIT follow-up — READ-ONLY review of every company's roles.
//
//   node scripts/roles-review.js            (or ROLES-REVIEW.bat)
//
// For each company it lists every role, how many active users hold it, and
// the CRITICAL permissions it carries (delete / reverse financial records,
// user & role administration, settings) — so a person can decide whether a
// role has more power than its job needs. It also shows, next to each
// existing role, the matching recommended template (src/permissions.js) and
// the permissions that template would add or remove.
//
// It never writes, creates, migrates or changes anything (READ ONLY MySQL
// session). Changes are made in the app: Users & Roles → Edit role.
require("../src/env");
const { SyncMysql } = require("../src/mysql/sync-client");
const { readConfig } = require("../src/mysql/connection");
const { CompatDb } = require("../src/mysql/compat-db");
const schema = require("../src/mysql/schema");
const P = require("../src/permissions");

const client = new SyncMysql(readConfig());
client.query("SET SESSION TRANSACTION READ ONLY");
const present = new Set(client.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").rows.map((r) => r.n));
const open = (cid) => new CompatDb(client, { kind: "tenant", companyId: cid, prefix: schema.companyPrefix(cid), tables: new Set(schema.tableNames("tenant")) });
const companies = present.has(`${schema.CONTROL_PREFIX}companies`) ? client.query(`SELECT id, name FROM "${schema.CONTROL_PREFIX}companies" ORDER BY seq`).rows : [];
const TEMPLATE_FOR = { admin: "company_admin", manager: "manager", accountant: "accountant", cashier: "cashier", viewer: "auditor" };
const tpl = Object.fromEntries(P.ROLE_TEMPLATES.map((t) => [t.key, t]));
const label = (k) => (P.PERMISSION_CATALOG.find((c) => c.key === k) || {}).label || k;

let flagged = 0;
for (const co of companies) {
  const db = open(co.id);
  if (!present.has(db.table("roles"))) continue;
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  console.log(`\n=== ${co.name} (${co.id}) ===`);
  for (const r of q("SELECT id, key, name, is_super_admin, status FROM roles ORDER BY name")) {
    // A user's role is role_id, or (accounts from before roles were editable) the legacy role key.
    const users = q("SELECT name, username FROM users WHERE (role_id = ? OR (role_id IS NULL AND role = ?)) AND deleted_at IS NULL AND active = 1", r.id, r.key);
    if (r.is_super_admin) { console.log(`\n- ${r.name}: ALL permissions (protected Super Admin) · ${users.length} active user(s)`); continue; }
    const perms = q("SELECT permission_key FROM role_permissions WHERE role_id = ?", r.id).map((x) => x.permission_key);
    const crit = perms.filter((k) => P.permissionLevel(k) === "critical");
    console.log(`\n- ${r.name}${r.status === "inactive" ? " (inactive)" : ""}: ${perms.length} permissions, ${crit.length} critical · ${users.length} active user(s)${users.length ? ": " + users.map((u) => `${u.name} (${u.username})`).join(", ") : ""}`);
    if (crit.length) { flagged++; console.log(`    critical: ${crit.map(label).join("; ")}`); }
    const t = tpl[TEMPLATE_FOR[r.key]];
    if (t) {
      const add = t.permissions.filter((k) => !perms.includes(k)), remove = perms.filter((k) => !t.permissions.includes(k));
      console.log(`    vs recommended "${t.name}": would add ${add.length}${add.length ? ` (${add.slice(0, 8).map(label).join("; ")}${add.length > 8 ? " …" : ""})` : ""}; would remove ${remove.length}${remove.length ? ` (${remove.slice(0, 8).map(label).join("; ")}${remove.length > 8 ? " …" : ""})` : ""}`);
    }
  }
}
console.log(`\n${flagged} role(s) hold critical permissions. Nothing was changed.`);
client.close();
