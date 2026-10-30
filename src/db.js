"use strict";
// MYSQL round — the app's database layer, now on MySQL (GoDaddy managed MySQL
// in production). The SQLite version of this file (with every historical
// SQLite migration) lives on, for the offline migration tool only, in
// scripts/legacy/sqlite-tenant-db.js.
//
// The API every route and service uses is unchanged: run/get/all/tx (and the
// `db` handle) always act on the database of the company the CURRENT request
// was authorized for (src/tenant-context.js). There is deliberately no
// fallback: with no authorized company, every query throws. Each company's
// handle can only name that company's own tables (src/mysql/dialect.js).
const tenantContext = require("./tenant-context");
const { connection } = require("./mysql/connection");
const { CompatDb } = require("./mysql/compat-db");
const schema = require("./mysql/schema");
const SEED = require("./mysql/tenant-seed.json");

const TENANT_TABLES = new Set(schema.tableNames("tenant"));
const CONTROL_TABLES = new Set(schema.tableNames("control"));

function tenantScope(companyId) {
  return { kind: "tenant", companyId, prefix: schema.companyPrefix(companyId), tables: TENANT_TABLES };
}
function controlScope() {
  return { kind: "control", prefix: schema.CONTROL_PREFIX, tables: CONTROL_TABLES };
}

// The platform (control) tables: companies, platform users, directory, audit,
// backups. Created/upgraded on first use.
let controlHandle = null;
function openControlDb() {
  if (controlHandle) return controlHandle;
  const client = connection();
  const h = new CompatDb(client, controlScope());
  schema.ensureScope((sql, p = []) => h.raw(sql, p), { kind: "control" });
  controlHandle = h;
  return h;
}

// Every company's tables carry a one-row tenant_meta naming the company they
// belong to. It is checked BEFORE anything else touches the tables, so tables
// holding company A's data can never be opened (let alone served) as
// company B — e.g. after a restore into the wrong place.
function assertTenantOwnership(h, companyId) {
  const row = h.prepare("SELECT company_id FROM tenant_meta WHERE id = 1").get();
  if (row && row.company_id !== companyId) {
    throw new Error(`[tenancy] Refusing to open the tables of ${companyId}: they belong to company ${row.company_id}.`);
  }
  return !!row;
}

function nowISO() { return new Date().toISOString(); }

// Inserts the default rows every new company starts with (roles and their
// permissions, expense categories, PDF/Excel templates, settings) — the same
// rows the SQLite version created; see scripts/dev/generate-mysql-schema.js.
function seedNewCompany(h, companyId, { isPrimary }) {
  const now = nowISO();
  h.exec("BEGIN");
  try {
    for (const t of schema.ordered(schema.SCHEMA.tenantTables)) {
      const rows = SEED.tables[t.name];
      if (!rows) continue;
      for (const r of rows) {
        const cols = Object.keys(r);
        const vals = cols.map((c) => {
          const v = r[c];
          if (v === "@@NOW@@") return now;
          if (v && typeof v === "object" && v.base64) return Buffer.from(v.base64, "base64");
          return v;
        });
        h.prepare(`INSERT INTO ${t.name} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
      }
    }
    h.prepare("INSERT INTO tenant_meta (id, company_id, stamped_at) VALUES (1, ?, ?)").run(companyId, now);
    h.exec("COMMIT");
  } catch (e) {
    try { h.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  if (isPrimary) ensureInitialSuperAdmin(h);
}

// The primary company's first Super Admin (then promoted to a platform Super
// Admin by src/tenancy.js) — identical rule to the SQLite version: set
// SUPER_ADMIN_INITIAL_PASSWORD on a brand-new deployment; without it the old
// default is used and the first sign-in is forced to choose a new password.
function ensureInitialSuperAdmin(h) {
  if (h.prepare("SELECT id FROM users WHERE username = ?").get("super.admin")) return;
  const role = h.prepare("SELECT id FROM roles WHERE \"key\" = 'super_admin'").get();
  if (!role) throw new Error("Primary company has no super_admin role.");
  const { hashPassword } = require("./auth");
  const { hash, salt } = hashPassword(process.env.SUPER_ADMIN_INITIAL_PASSWORD || "SuperAdmin123!");
  h.prepare(
    "INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, last_login, created_at) VALUES (?,?,?,?,?,?,?, 'active', 1, 1, NULL, ?)"
  ).run("u_super_admin", "SUPER ADMIN", "super.admin", hash, salt, "admin", role.id, nowISO());
}

// Opens one company's tables: creates any that are missing (a new company),
// adds missing columns/indexes (an upgrade), checks ownership, and seeds the
// defaults of a brand-new company. Returns { db, created } — `created` lists
// the tables made by THIS call (so a failed company creation can remove
// exactly those and nothing else).
function openTenantDb(companyId, { isPrimary = false } = {}) {
  const client = connection();
  const h = new CompatDb(client, tenantScope(companyId));
  const raw = (sql, p = []) => h.raw(sql, p);
  // Ownership is checked before any change when the tables already exist.
  const metaTable = h.table("tenant_meta");
  const exists = raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [metaTable])[0].n > 0;
  if (exists) assertTenantOwnership(h, companyId);
  const { created } = schema.ensureScope(raw, { kind: "tenant", companyId });
  if (!assertTenantOwnership(h, companyId)) {
    // No tenant_meta row: only a company whose tables are all still empty
    // may be seeded — never write defaults into tables that hold data.
    for (const t of TENANT_TABLES) {
      const n = raw(`SELECT COUNT(*) AS n FROM "${h.table(t)}"`)[0].n;
      if (n > 0) throw new Error(`[tenancy] ${companyId}: table ${t} has data but no tenant_meta row — refusing to seed. Check the migration.`);
    }
    seedNewCompany(h, companyId, { isPrimary });
  } else if (isPrimary) {
    ensureInitialSuperAdmin(h);
  }
  return { db: h, created };
}

// --- query helpers (positional `?` params) — always the current company ---
function currentDb() {
  const t = tenantContext.currentTenant();
  if (!t || !t.db) throw new tenantContext.TenantContextError();
  return t.db;
}
// Kept for compatibility: there are no database files any more.
function currentDbFile() { return null; }
function run(sql, params = []) {
  return currentDb().prepare(sql).run(...params);
}
function get(sql, params = []) {
  return currentDb().prepare(sql).get(...params);
}
function all(sql, params = []) {
  return currentDb().prepare(sql).all(...params);
}
// One atomic unit of work: everything inside fn commits together or not at
// all. Nested calls are refused (as with SQLite), never silently committed.
// Within this process transactions already run one at a time (the bridge is
// synchronous); the per-company MySQL named lock additionally serializes them
// against any OTHER app process using the same database (e.g. a second
// instance during a redeploy), the same one-writer-at-a-time rule SQLite's
// file lock gave each company before.
function tx(fn) {
  const d = currentDb();
  // FULL SYSTEM AUDIT round: MySQL named locks are server-wide, not
  // per-database — the name now includes the database, so two installations
  // sharing one MySQL server (e.g. a staging copy) never block each other.
  const lockName = `finman_tx_${require("crypto").createHash("sha1").update(`${String(process.env.DB_NAME || "").trim()}|${d.scope.prefix}`).digest("hex").slice(0, 40)}`;
  const got = d.prepare("SELECT GET_LOCK(?, 30) AS ok").get(lockName);
  if (!got || got.ok !== 1) {
    const e = new Error("Another save for this company is still running — please try again.");
    e.status = 409;
    throw e;
  }
  try {
    d.exec("BEGIN");
    try {
      const result = fn();
      d.exec("COMMIT");
      return result;
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch (_) { /* connection lost: MySQL already rolled back */ }
      throw e;
    }
  } finally {
    try { d.prepare("SELECT RELEASE_LOCK(?) AS ok").get(lockName); } catch (_) { /* lock ends with the connection */ }
  }
}

// `db` kept for the few callers that use the raw handle (prepare/exec) — it
// forwards to the current company's database, with the same fail-closed rule.
const db = new Proxy({}, {
  get(_t, prop) {
    const d = currentDb();
    const v = d[prop];
    return typeof v === "function" ? v.bind(d) : v;
  },
});

module.exports = { db, run, get, all, tx, openTenantDb, openControlDb, currentDbFile, tenantScope, controlScope, TENANT_TABLES, CONTROL_TABLES };
