"use strict";
// MYSQL round — DEVELOPER TOOL (not used at runtime, not used in production).
//
//   node --experimental-sqlite scripts/dev/generate-mysql-schema.js
//
// Derives the MySQL schema from the app's last SQLite schema, so the two are
// guaranteed to match column for column:
//   1. builds a brand-new SQLite company database and control database in a
//      temporary folder using the legacy SQLite code (scripts/legacy/);
//   2. introspects every table (columns, types, NOT NULL, defaults, primary
//      keys, UNIQUE, FOREIGN KEY, CHECK, indexes);
//   3. writes src/mysql/schema.json (structure only — the MySQL DDL is
//      rendered from it per company by src/mysql/schema.js), and
//      src/mysql/tenant-seed.json (the default rows a new company starts
//      with: roles, permissions, expense categories, PDF/Excel templates,
//      settings — no users, no passwords, no financial data).
// Run it again whenever the legacy schema changes; commit both JSON files.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const { openTenantDb, stampCompanyId } = require("../legacy/sqlite-tenant-db");
const { openControlDb } = require("../legacy/sqlite-control-db");

function splitTop(s) {
  const out = []; let depth = 0, cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function balanced(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  throw new Error("unbalanced: " + s);
}
function stripComments(sql) { return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " "); }

function introspect(db, { skip = [] } = {}) {
  const tables = [];
  const names = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name, sql } of names) {
    if (skip.includes(name)) continue;
    const body = stripComments(sql);
    const inner = body.slice(body.indexOf("(") + 1, body.lastIndexOf(")"));
    const items = splitTop(inner);
    const checks = [];
    for (const it of items) {
      let re = /\bCHECK\s*\(/gi, m;
      while ((m = re.exec(it))) { checks.push(balanced(it, m.index + m[0].length - 1).replace(/\s+/g, " ").trim()); }
    }
    const info = db.prepare(`PRAGMA table_info('${name}')`).all();
    const columns = info.map((c) => ({ name: c.name, sqliteType: String(c.type || "").toUpperCase(), notNull: !!c.notnull, default: c.dflt_value, pk: c.pk }));
    const primaryKey = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const fkRows = db.prepare(`PRAGMA foreign_key_list('${name}')`).all();
    const fks = new Map();
    for (const f of fkRows) {
      if (!fks.has(f.id)) fks.set(f.id, { columns: [], refTable: f.table, refColumns: [], onDelete: f.on_delete, onUpdate: f.on_update });
      fks.get(f.id).columns.push(f.from); fks.get(f.id).refColumns.push(f.to);
    }
    const indexes = [];
    for (const ix of db.prepare(`PRAGMA index_list('${name}')`).all()) {
      if (ix.origin === "pk") continue;
      const cols = db.prepare(`PRAGMA index_xinfo('${ix.name}')`).all().filter((c) => c.key);
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(ix.name);
      const def = { name: ix.origin === "u" ? null : ix.name, unique: !!ix.unique, columns: cols.map((c) => c.name), where: null, expression: null };
      if (ddl && ddl.sql) {
        const t = stripComments(ddl.sql);
        const w = /\bWHERE\b([\s\S]*)$/i.exec(t);
        if (w) def.where = w[1].replace(/\s+/g, " ").trim();
        if (cols.some((c) => c.name === null)) {
          const on = t.slice(t.indexOf("(", t.search(/\bON\b/i)));
          def.expression = balanced(on, 0).replace(/\s+/g, " ").trim();
          def.columns = [];
        }
      }
      if (def.columns.some((c) => c === null)) throw new Error(`unexpected expression column in ${ix.name}`);
      indexes.push(def);
    }
    for (const f of fks.values()) {
      if ((f.onDelete && f.onDelete !== "NO ACTION") || (f.onUpdate && f.onUpdate !== "NO ACTION")) throw new Error(`${name}: FK actions are not handled by this generator`);
    }
    tables.push({ name, columns, primaryKey, foreignKeys: [...fks.values()].map(({ columns, refTable, refColumns }) => ({ columns, refTable, refColumns })), checks, indexes });
  }
  return tables;
}

// Decides each column's MySQL type. Text that is part of a key or index must
// be VARCHAR (MySQL cannot index unbounded TEXT); everything else keeps
// unbounded LONGTEXT exactly like SQLite TEXT.
function assignTypes(tables) {
  const keyed = new Set();
  const mark = (t, c) => keyed.add(`${t}.${c}`);
  for (const t of tables) {
    t.primaryKey.forEach((c) => mark(t.name, c));
    for (const f of t.foreignKeys) { f.columns.forEach((c) => mark(t.name, c)); f.refColumns.forEach((c) => mark(f.refTable, c)); }
    for (const ix of t.indexes) {
      ix.columns.forEach((c) => mark(t.name, c));
      if (ix.expression) for (const c of t.columns) if (new RegExp(`\\b${c.name}\\b`).test(ix.expression)) mark(t.name, c.name);
      if (ix.where) for (const c of t.columns) if (new RegExp(`\\b${c.name}\\b`).test(ix.where)) mark(t.name, c.name);
    }
    mark(t.name, "company_id");
  }
  for (const t of tables) {
    for (const c of t.columns) {
      const st = c.sqliteType;
      const isKey = keyed.has(`${t.name}.${c.name}`);
      if (/INT/.test(st)) c.mysqlType = "BIGINT";
      else if (/REAL|FLOA|DOUB/.test(st)) c.mysqlType = "DOUBLE";
      else if (/BLOB/.test(st) || st === "") c.mysqlType = "LONGBLOB";
      else if (/CHAR|CLOB|TEXT/.test(st)) c.mysqlType = isKey ? "VARCHAR(255)" : "LONGTEXT";
      else throw new Error(`${t.name}.${c.name}: unknown SQLite type ${st}`);
      if (c.mysqlType === "LONGBLOB" && st === "") throw new Error(`${t.name}.${c.name}: column without a declared type`);
      c.isCompanyId = c.name === "company_id";
      c.default = normalizeDefault(t.name, c);
    }
  }
}
function normalizeDefault(table, c) {
  const d = c.default;
  if (d === null || d === undefined || /^NULL$/i.test(d)) return null;
  if (/^-?\d+(\.\d+)?$/.test(d)) return { kind: "number", value: Number(d) };
  const m = /^'((?:[^']|'')*)'$/.exec(d);
  if (m) return { kind: "string", value: m[1].replace(/''/g, "'") };
  throw new Error(`${table}.${c.name}: default ${d} needs a manual MySQL translation`);
}

function main() {
  const t0 = new Date(Date.now() - 1000).toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finman-schema-"));
  try {
    const control = openControlDb(path.join(dir, "control.sqlite"));
    const tenant = openTenantDb(path.join(dir, "CMP-0002.sqlite"), "CMP-0002", { isPrimary: false });
    // reset_log is created by src/reset-operational.js the one time an owner-
    // approved data reset runs; carried over so a reset never runs twice.
    tenant.exec("CREATE TABLE IF NOT EXISTS reset_log (code TEXT PRIMARY KEY, at TEXT NOT NULL, summary TEXT NOT NULL)");
    stampCompanyId(tenant, "CMP-0002");
    const t1 = new Date(Date.now() + 1000).toISOString();
    const tenantTables = introspect(tenant);
    const controlTables = introspect(control);
    assignTypes(tenantTables);
    assignTypes(controlTables);
    for (const t of tenantTables) {
      const cid = t.columns.find((c) => c.name === "company_id");
      if (!cid) throw new Error(`${t.name} has no company_id column`);
      cid.default = { kind: "companyId" };
    }
    const schema = {
      generatedBy: "scripts/dev/generate-mysql-schema.js",
      sourceSchema: "scripts/legacy/schema.sql + scripts/legacy/sqlite-tenant-db.js + scripts/legacy/sqlite-control-db.js",
      tenantTables, controlTables,
    };
    // Seed rows of a brand-new company (no users exist in a new company).
    const seed = {};
    const isNow = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && v >= t0 && v <= t1;
    for (const t of tenantTables) {
      if (t.name === "tenant_meta") continue;
      const rows = tenant.prepare(`SELECT * FROM "${t.name}"`).all();
      if (!rows.length) continue;
      if (t.name === "users") throw new Error("A new company must not get seeded users");
      seed[t.name] = rows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === "company_id") continue;
          o[k] = isNow(v) ? "@@NOW@@" : (Buffer.isBuffer(v) || v instanceof Uint8Array ? { base64: Buffer.from(v).toString("base64") } : v);
        }
        return o;
      });
    }
    control.close(); tenant.close();
    fs.writeFileSync(path.join(ROOT, "src", "mysql", "schema.json"), JSON.stringify(schema, null, 1) + "\n");
    fs.writeFileSync(path.join(ROOT, "src", "mysql", "tenant-seed.json"), JSON.stringify({ generatedBy: schema.generatedBy, tables: seed }, null, 1) + "\n");
    console.log(`schema.json: ${tenantTables.length} company tables, ${controlTables.length} platform tables`);
    console.log(`tenant-seed.json: ${Object.entries(seed).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
