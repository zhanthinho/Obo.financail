"use strict";
// MYSQL round — logical dump / load of one scope's tables (one company, or
// the platform tables). Used by backups (src/backup.js), manual restore
// (scripts/restore-backup.js) and the SQLite -> MySQL migration verifier.
//
// A dump is plain JSON: for every table its column names and its rows (as
// arrays, ordered by primary key). Binary values are written as
// { "$base64": "..." }. Checksums are SHA-256 over a canonical encoding of
// the rows, so the same data always gives the same checksum whether it was
// read from SQLite or from MySQL.
const crypto = require("crypto");
const schema = require("./schema");

const FORMAT = "finman-mysql-backup";
const VERSION = 1;
// Platform bookkeeping tables that are never part of a backup.
const NOT_BACKED_UP = new Set(["backups", "backup_chunks", "migration_runs"]);

function encodeValue(v) {
  if (v === undefined) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $base64: Buffer.from(v).toString("base64") };
  if (typeof v === "bigint") return Number(v);
  return v;
}
function decodeValue(v) {
  if (v && typeof v === "object" && typeof v.$base64 === "string") return Buffer.from(v.$base64, "base64");
  return v;
}

// Canonical text for one value — numbers by their shortest round-trip form,
// so 5 and 5.0 (SQLite REAL vs MySQL DOUBLE) are the same value.
function canon(v) {
  if (v === null || v === undefined) return "N";
  if (typeof v === "number") return Number.isFinite(v) ? `n${Object.is(v, -0) ? 0 : v}` : `n${String(v)}`;
  if (typeof v === "bigint") return `n${v}`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `b${Buffer.from(v).toString("base64")}`;
  if (v && typeof v === "object" && typeof v.$base64 === "string") return `b${v.$base64}`;
  return `s${String(v)}`;
}
function rowsChecksum(columns, rows) {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(columns));
  for (const r of rows) {
    h.update("\u0001");
    for (const v of r) { h.update(canon(v)); h.update("\u0000"); }
  }
  return h.digest("hex");
}

function tableDefs(kind) {
  return schema.ordered(schema.tablesFor(kind));
}
function orderBy(t) {
  return (t.primaryKey.length ? t.primaryKey : t.columns.map((c) => c.name)).map((c) => `"${c}"`).join(", ");
}

// Reads every table of the scope through handle h (a CompatDb). Columns are
// the table's live columns (so a column added later is never silently lost).
function dumpScope(h, { kind, scopeId }) {
  const out = { format: FORMAT, version: VERSION, scope: scopeId, kind, createdAt: new Date().toISOString(), tables: [] };
  for (const t of tableDefs(kind)) {
    if (NOT_BACKED_UP.has(t.name)) continue;
    const full = h.table(t.name);
    const columns = h.raw("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [full]).map((r) => r.n);
    const rows = h.raw(`SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${full}" ORDER BY ${orderBy(t)}`)
      .map((r) => columns.map((c) => encodeValue(r[c])));
    out.tables.push({ name: t.name, columns, rows, checksum: rowsChecksum(columns, rows) });
  }
  return out;
}

function rowCounts(dump) {
  const o = {};
  for (const t of dump.tables) o[t.name] = t.rows.length;
  return o;
}

// Validates a parsed dump before anything is written.
function validateDump(dump, { kind, scopeId }) {
  if (!dump || dump.format !== FORMAT) throw new Error("This file is not a FINMAN MySQL backup.");
  if (dump.version !== VERSION) throw new Error(`Unsupported backup version ${dump.version}.`);
  if (dump.kind !== kind) throw new Error(`This backup is of the ${dump.kind} tables, not ${kind}.`);
  if (dump.scope !== scopeId) throw new Error(`This backup belongs to ${dump.scope}, not ${scopeId} — refusing to restore it here.`);
  const known = new Set(tableDefs(kind).map((t) => t.name));
  for (const t of dump.tables) {
    if (!known.has(t.name)) throw new Error(`Backup contains unknown table ${t.name}.`);
    if (rowsChecksum(t.columns, t.rows) !== t.checksum) throw new Error(`Backup table ${t.name} is damaged (checksum mismatch).`);
    if (kind === "tenant") {
      const ci = t.columns.indexOf("company_id");
      if (ci >= 0 && t.rows.some((r) => r[ci] !== scopeId)) throw new Error(`Backup table ${t.name} contains rows of another company — refusing.`);
    }
  }
}

// Replaces ALL rows of the scope with the dump's rows, in ONE transaction:
// either every table is restored, or nothing changes. Verifies row counts
// and checksums before committing.
function loadScope(h, dump, { kind }) {
  const defs = tableDefs(kind).filter((t) => !NOT_BACKED_UP.has(t.name));
  const byName = new Map(dump.tables.map((t) => [t.name, t]));
  h.exec("BEGIN");
  try {
    h.raw("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [...defs].reverse()) h.raw(`DELETE FROM "${h.table(t.name)}"`);
    for (const t of defs) {
      const d = byName.get(t.name);
      if (!d || !d.rows.length) continue;
      insertRows(h, h.table(t.name), d.columns, d.rows);
    }
    h.raw("SET FOREIGN_KEY_CHECKS = 1");
    const check = dumpScope(h, { kind, scopeId: dump.scope });
    for (const t of check.tables) {
      const d = byName.get(t.name);
      const expectRows = d ? d.rows.length : 0;
      if (t.rows.length !== expectRows) throw new Error(`Restore check failed: ${t.name} has ${t.rows.length} rows, backup has ${expectRows}.`);
      if (d && d.rows.length && d.columns.join() === t.columns.join() && t.checksum !== d.checksum) throw new Error(`Restore check failed: ${t.name} content differs from the backup.`);
    }
    h.exec("COMMIT");
  } catch (e) {
    try { h.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    try { h.raw("SET FOREIGN_KEY_CHECKS = 1"); } catch (_) { /* ignore */ }
    throw e;
  }
}

// Multi-row INSERTs, a few hundred rows (and at most ~4 MB) per statement.
function insertRows(h, fullTable, columns, rows) {
  const colSql = columns.map((c) => `"${c}"`).join(", ");
  const one = `(${columns.map(() => "?").join(", ")})`;
  let batch = [], params = [], bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    h.raw(`INSERT INTO "${fullTable}" (${colSql}) VALUES ${batch.join(", ")}`, params);
    batch = []; params = []; bytes = 0;
  };
  for (const r of rows) {
    batch.push(one);
    for (const v of r) {
      const dv = decodeValue(v);
      params.push(dv);
      bytes += typeof dv === "string" ? dv.length : Buffer.isBuffer(dv) ? dv.length : 8;
    }
    if (batch.length >= 200 || bytes > 4 * 1024 * 1024 || params.length > 30000) flush();
  }
  flush();
}

module.exports = { FORMAT, VERSION, NOT_BACKED_UP, dumpScope, validateDump, loadScope, insertRows, rowsChecksum, rowCounts, canon, encodeValue, decodeValue };
