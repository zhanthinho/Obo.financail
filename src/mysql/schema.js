"use strict";
// MYSQL round — the MySQL schema: renders and applies the tables of one scope
// (one company, or the shared platform registry) from schema.json.
//
// Layout in the ONE MySQL database the hosting gives the app:
//   ctl_*        platform tables: companies registry, platform Super Admins,
//                username directory, platform audit, backups, schema info.
//                Hold NO financial data.
//   cmpNNNN_*    one full set of tables PER COMPANY (cmp0001_clients,
//                cmp0002_clients, ...). A company's rows only ever live in
//                its own tables, and every one of those tables also carries
//                CHECK (company_id = '<that company>') — the database itself
//                refuses a row stamped with another company's ID. (This
//                replaces the SQLite triggers; CHECK constraints need no
//                special TRIGGER privilege on managed hosting.)
//
// ensureScope() is idempotent and additive only: it creates missing tables,
// adds missing columns and indexes, and NEVER drops, renames or rewrites
// anything — safe to run on every start.
const SCHEMA = require("./schema.json");

const COMPANY_ID_RE = /^CMP-\d{4,}$/;
const CONTROL_PREFIX = "ctl_";
const TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin";

function companyPrefix(companyId) {
  if (!COMPANY_ID_RE.test(String(companyId))) throw new Error(`Invalid company id ${companyId}`);
  return `cmp${companyId.slice(4).toLowerCase()}_`;
}

// Platform tables that exist only on MySQL (no SQLite counterpart).
const EXTRA_CONTROL_TABLES = [
  {
    // One row per backup. The (gzip-compressed JSON) content is stored in
    // backup_chunks, a few MB per row, so no single row ever exceeds the
    // server's max_allowed_packet.
    name: "backups",
    ddl: (p) => `CREATE TABLE IF NOT EXISTS "${p}backups" (
      "id" VARCHAR(80) NOT NULL PRIMARY KEY,
      "scope" VARCHAR(40) NOT NULL,
      "name" VARCHAR(160) NOT NULL,
      "kind" VARCHAR(20) NOT NULL,
      "status" VARCHAR(20) NOT NULL,
      "created_at" VARCHAR(40) NOT NULL,
      "created_by" VARCHAR(255),
      "size_bytes" BIGINT NOT NULL DEFAULT 0,
      "sha256" VARCHAR(64),
      "row_counts" LONGTEXT,
      "chunk_count" BIGINT NOT NULL DEFAULT 0,
      UNIQUE KEY "uq_backups_scope_name" ("scope", "name"),
      KEY "idx_backups_scope_created" ("scope", "created_at")
    ) ${TABLE_OPTIONS}`,
  },
  {
    name: "backup_chunks",
    ddl: (p) => `CREATE TABLE IF NOT EXISTS "${p}backup_chunks" (
      "backup_id" VARCHAR(80) NOT NULL,
      "seq" BIGINT NOT NULL,
      "data" LONGBLOB NOT NULL,
      PRIMARY KEY ("backup_id", "seq"),
      FOREIGN KEY ("backup_id") REFERENCES "${p}backups" ("id")
    ) ${TABLE_OPTIONS}`,
  },
  {
    // Resume ledger of scripts/migrate-sqlite-to-mysql.js: which table of
    // which company has been copied and verified, so a re-run never copies a
    // table twice.
    name: "migration_runs",
    ddl: (p) => `CREATE TABLE IF NOT EXISTS "${p}migration_runs" (
      "scope" VARCHAR(40) NOT NULL,
      "table_name" VARCHAR(100) NOT NULL,
      "source_sha256" VARCHAR(64) NOT NULL,
      "rows_copied" BIGINT NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" VARCHAR(40) NOT NULL,
      PRIMARY KEY ("scope", "table_name")
    ) ${TABLE_OPTIONS}`,
  },
  {
    // FULL SYSTEM AUDIT round: sessions ended with "Sign out" (see
    // src/session-revocation.js). Only a SHA-256 of the token is kept, never
    // the token; a row is useless once its token has expired and is pruned.
    name: "revoked_sessions",
    ddl: (p) => `CREATE TABLE IF NOT EXISTS "${p}revoked_sessions" (
      "token_hash" VARCHAR(64) NOT NULL PRIMARY KEY,
      "expires_at" BIGINT NOT NULL,
      "revoked_at" VARCHAR(40) NOT NULL,
      KEY "idx_revoked_sessions_expires" ("expires_at")
    ) ${TABLE_OPTIONS}`,
  },
];

function tablesFor(kind) { return kind === "tenant" ? SCHEMA.tenantTables : SCHEMA.controlTables; }
function tableNames(kind) {
  const names = tablesFor(kind).map((t) => t.name);
  if (kind === "control") for (const t of EXTRA_CONTROL_TABLES) names.push(t.name);
  return names;
}

function q(name) { return `"${name}"`; }
function sqlString(v) { return `'${String(v).replace(/'/g, "''")}'`; }

function columnDdl(c, companyId) {
  let s = `${q(c.name)} ${c.mysqlType}`;
  if (c.notNull) s += " NOT NULL";
  const d = c.default;
  if (d) {
    const lit = d.kind === "number" ? String(d.value) : d.kind === "companyId" ? sqlString(companyId) : sqlString(d.value);
    // MySQL only accepts a default on LONGTEXT/LONGBLOB as an expression.
    s += /^LONG/.test(c.mysqlType) ? ` DEFAULT (${lit})` : ` DEFAULT ${lit}`;
  }
  return s;
}

// Rewrites a SQLite CHECK / index expression for MySQL (quotes the reserved
// column name `key`; the expressions in schema.json are otherwise portable).
function portableExpr(expr) {
  return expr.replace(/(^|[^"\w.])key\b/g, '$1"key"');
}

function indexDdl(t, ix) {
  const name = ix.name || `uq_${t.name}_${ix.columns.join("_")}`.slice(0, 64);
  const kw = ix.unique ? "UNIQUE KEY" : "KEY";
  if (ix.expression) {
    if (ix.where) throw new Error(`${t.name}.${name}: partial expression index not supported`);
    return `${kw} ${q(name)} ((${portableExpr(ix.expression)}))`;
  }
  if (!ix.where) return `${kw} ${q(name)} (${ix.columns.map(q).join(", ")})`;
  // Partial UNIQUE indexes from SQLite:
  //   WHERE col IS NOT NULL  -> plain UNIQUE (MySQL already allows many NULLs);
  //   WHERE flag = 1         -> unique on CASE WHEN flag = 1 THEN col END
  //                            (rows with flag <> 1 index as NULL = unrestricted).
  const nn = /^(\w+) IS NOT NULL$/i.exec(ix.where);
  if (ix.unique && nn && ix.columns.length === 1 && nn[1] === ix.columns[0]) return `${kw} ${q(name)} (${q(ix.columns[0])})`;
  const eq = /^(\w+) = (\d+)$/.exec(ix.where);
  if (ix.unique && eq && ix.columns.length === 1) return `${kw} ${q(name)} ((CASE WHEN ${q(eq[1])} = ${eq[2]} THEN ${q(ix.columns[0])} END))`;
  throw new Error(`${t.name}.${name}: partial index WHERE ${ix.where} has no MySQL translation`);
}

function createTableDdl(t, prefix, companyId) {
  const parts = t.columns.map((c) => columnDdl(c, companyId));
  if (t.primaryKey.length) parts.push(`PRIMARY KEY (${t.primaryKey.map(q).join(", ")})`);
  for (const ix of t.indexes) parts.push(indexDdl(t, ix));
  for (const f of t.foreignKeys) parts.push(`FOREIGN KEY (${f.columns.map(q).join(", ")}) REFERENCES ${q(prefix + f.refTable)} (${f.refColumns.map(q).join(", ")})`);
  for (const ch of t.checks) parts.push(`CHECK (${portableExpr(ch)})`);
  if (companyId) parts.push(`CHECK (${q("company_id")} = ${sqlString(companyId)})`);
  return `CREATE TABLE IF NOT EXISTS ${q(prefix + t.name)} (\n  ${parts.join(",\n  ")}\n) ${TABLE_OPTIONS}`;
}

// Tables ordered so that every table comes after the tables it references.
function ordered(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const out = [], seen = new Set(), visiting = new Set();
  const visit = (t) => {
    if (seen.has(t.name)) return;
    if (visiting.has(t.name)) throw new Error(`FK cycle at ${t.name}`);
    visiting.add(t.name);
    for (const f of t.foreignKeys) if (f.refTable !== t.name && byName.has(f.refTable)) visit(byName.get(f.refTable));
    visiting.delete(t.name); seen.add(t.name); out.push(t);
  };
  tables.forEach(visit);
  return out;
}

// raw(sql, params) runs one statement directly (no translation).
function existingTables(raw, prefix) {
  return new Set(raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((r) => r.n).filter((n) => n.startsWith(prefix)));
}

// Creates/updates every table of one scope. Returns { created: [...], altered: [...] }.
function ensureScope(raw, { kind, companyId }) {
  const prefix = kind === "tenant" ? companyPrefix(companyId) : CONTROL_PREFIX;
  const have = existingTables(raw, prefix);
  const created = [], altered = [];
  for (const t of ordered(tablesFor(kind))) {
    const full = prefix + t.name;
    if (!have.has(full)) {
      raw(createTableDdl(t, prefix, kind === "tenant" ? companyId : null));
      created.push(full);
      continue;
    }
    // Additive upgrade of an existing table: missing columns, then indexes.
    const cols = new Set(raw("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [full]).map((r) => r.n));
    for (const c of t.columns) {
      if (cols.has(c.name)) continue;
      raw(`ALTER TABLE ${q(full)} ADD COLUMN ${columnDdl(c, companyId)}`);
      altered.push(`${full}.${c.name}`);
    }
    const idx = new Set(raw("SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [full]).map((r) => r.n));
    for (const ix of t.indexes) {
      const name = ix.name || `uq_${t.name}_${ix.columns.join("_")}`.slice(0, 64);
      if (idx.has(name)) continue;
      raw(`ALTER TABLE ${q(full)} ADD ${indexDdl(t, ix)}`);
      altered.push(`${full}#${name}`);
    }
  }
  if (kind === "control") {
    for (const t of EXTRA_CONTROL_TABLES) {
      if (!have.has(prefix + t.name)) { raw(t.ddl(prefix)); created.push(prefix + t.name); }
    }
  }
  return { created, altered };
}

// Every table of one company (for dropping a half-created company only).
function companyTables(companyId) {
  const p = companyPrefix(companyId);
  return ordered(SCHEMA.tenantTables).map((t) => p + t.name);
}

module.exports = {
  SCHEMA, CONTROL_PREFIX, COMPANY_ID_RE, companyPrefix, tableNames, tablesFor,
  ensureScope, createTableDdl, companyTables, ordered,
};
