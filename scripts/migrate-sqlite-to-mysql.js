"use strict";
// MYSQL round — ONE-TIME MIGRATION: SQLite -> MySQL.
//
// Moves an existing installation (primary company database, control
// database, and every other company's database) into the MySQL tables the app
// now uses — every row, every ID, every date, amount, flag and NULL exactly
// as it is, each company into its own tables.
//
// SAFETY RULES (all enforced below):
//   * The SQLite files are opened READ-ONLY and are never changed.
//   * Before anything else, an immutable backup of every SQLite file is made
//     (with SHA-256 checksums in manifest.json). All further work happens on
//     COPIES of that backup.
//   * Nothing is ever deleted or overwritten in MySQL: a table that already
//     holds rows not written by this tool stops the migration.
//   * Every table is copied in its own transaction and verified (row count +
//     SHA-256 of the content) before it is committed and recorded in
//     ctl_migration_runs — so a re-run (--resume) skips finished tables and
//     never creates duplicates.
//   * --dry-run reads and checks everything and writes NOTHING to MySQL.
//   * Problems in the data (e.g. amounts that are not real numbers, values
//     too long for a key column) stop the migration with a report — the tool
//     never "fixes" financial data on its own.
//
// USAGE (run where both the SQLite files and the MySQL database are reachable;
// the MySQL connection comes from DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD):
//   node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --source data/geeska.sqlite --dry-run
//   node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --source data/geeska.sqlite --execute
//   node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --resume migration-runs/<run> --execute
// Offline, without MySQL access (a bundle to import later where MySQL is reachable):
//   node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --source data/geeska.sqlite --bundle out.json.gz
//   node scripts/migrate-sqlite-to-mysql.js --from-bundle out.json.gz --dry-run | --execute
// Options: --control <file> --companies-dir <dir> (defaults follow the old
// DB_PATH layout: <name>-control.sqlite and <name>-companies/ next to it),
// --out <dir> (where run folders go; default ./migration-runs).
require("../src/env");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const schema = require("../src/mysql/schema");
const dump = require("../src/mysql/dump");

const BUNDLE_FORMAT = "finman-migration-bundle";

function args() {
  const a = process.argv.slice(2);
  const o = { dryRun: a.includes("--dry-run"), execute: a.includes("--execute") };
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  o.source = val("--source"); o.control = val("--control"); o.companiesDir = val("--companies-dir");
  o.out = val("--out") || path.join(process.cwd(), "migration-runs");
  o.resume = val("--resume"); o.bundle = val("--bundle"); o.fromBundle = val("--from-bundle");
  o.acceptUpgradeChanges = a.includes("--accept-upgrade-changes");
  return o;
}
function log(...m) { console.log(...m); }
function fail(msg) { const e = new Error(msg); e.migrationStop = true; return e; }
function sha256File(f) { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

/* ------------------------------ SQLite side ------------------------------ */
function sqlite() { return require("node:sqlite"); }

function discoverSources(o) {
  if (!o.source) throw fail("--source <path to the primary geeska.sqlite> is required.");
  const primary = path.resolve(o.source);
  if (!fs.existsSync(primary)) throw fail(`Source not found: ${primary}`);
  const base = path.basename(primary).replace(/\.sqlite$/i, "");
  const control = path.resolve(o.control || path.join(path.dirname(primary), `${base}-control.sqlite`));
  const companiesDir = path.resolve(o.companiesDir || path.join(path.dirname(primary), `${base}-companies`));
  return { primary, control: fs.existsSync(control) ? control : null, companiesDir };
}

// Step 1: immutable, checksummed backup of every source file.
// The originals are only ever READ as plain files (byte copies of the
// database and its -wal/-shm/-journal companions) — not even opened by
// SQLite, which would touch the -shm index file. Each byte copy is then
// turned into one self-contained snapshot (WAL merged) for the work.
// Stop the app (or work on downloaded copies) so the files are not being
// written while they are copied.
function makeBackup(src, runDir) {
  const { DatabaseSync } = sqlite();
  const dir = path.join(runDir, "backup");
  const rawDir = path.join(dir, "raw");
  const tmpDir = path.join(runDir, "tmp-open");
  fs.mkdirSync(rawDir, { recursive: true });
  const files = [];
  const raw = [];
  const snap = (from, name) => {
    const parts = ["", "-wal", "-shm", "-journal"].filter((x) => fs.existsSync(from + x));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const x of parts) {
      const rawName = `${name}${x}`;
      fs.copyFileSync(from + x, path.join(rawDir, rawName));
      fs.chmodSync(path.join(rawDir, rawName), 0o444);
      raw.push({ source: from + x, file: `raw/${rawName}`, sha256: sha256File(path.join(rawDir, rawName)) });
      fs.copyFileSync(from + x, path.join(tmpDir, `db${x}`));
    }
    const to = path.join(dir, name);
    const h = new DatabaseSync(path.join(tmpDir, "db"));
    try { h.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { h.close(); }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.chmodSync(to, 0o444);
    files.push({ source: from, backup: name, sha256: sha256File(to), bytes: fs.statSync(to).size });
  };
  snap(src.primary, "primary.sqlite");
  if (src.control) snap(src.control, "control.sqlite");
  if (fs.existsSync(src.companiesDir)) {
    for (const f of fs.readdirSync(src.companiesDir).filter((n) => /^CMP-\d{4,}\.sqlite$/.test(n)).sort()) {
      snap(path.join(src.companiesDir, f), `companies__${f}`);
    }
  }
  const manifest = { createdAt: new Date().toISOString(), files, raw };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.chmodSync(path.join(dir, "manifest.json"), 0o444);
  return manifest;
}

function verifyBackup(runDir) {
  const dir = path.join(runDir, "backup");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (sha256File(path.join(dir, f.backup)) !== f.sha256) throw fail(`Backup file ${f.backup} changed since it was made — refusing to continue.`);
  }
  for (const f of manifest.raw || []) {
    if (sha256File(path.join(dir, f.file)) !== f.sha256) throw fail(`Backup file ${f.file} changed since it was made — refusing to continue.`);
  }
  return manifest;
}

// Step 2: bring COPIES up to the final SQLite schema with the app's own
// (legacy) migration code, then read them as one dump per company.
function prepareWorkCopies(runDir, manifest) {
  const { DatabaseSync } = sqlite();
  const { openTenantDb } = require("./legacy/sqlite-tenant-db");
  const { openControlDb } = require("./legacy/sqlite-control-db");
  const work = path.join(runDir, "work");
  fs.mkdirSync(work, { recursive: true });
  const copy = (name) => { const to = path.join(work, name); if (!fs.existsSync(to)) { fs.copyFileSync(path.join(runDir, "backup", name), to); fs.chmodSync(to, 0o644); } return to; };
  const hasControl = manifest.files.some((f) => f.backup === "control.sqlite");
  const controlFile = hasControl ? copy("control.sqlite") : path.join(work, "control.sqlite");
  const control = openControlDb(controlFile);
  try {
    let companies = control.prepare("SELECT * FROM companies ORDER BY seq").all();
    if (!companies.length) {
      // An installation from before multi-company support: its only
      // database becomes the primary company CMP-0001 (as the app did).
      const p = new DatabaseSync(path.join(runDir, "backup", "primary.sqlite"), { readOnly: true });
      let name = null;
      try { name = p.prepare("SELECT name FROM company_settings WHERE id = 1").get()?.name || null; } catch (e) { /* older file */ } finally { p.close(); }
      control.prepare("INSERT INTO companies (id, seq, name, status, is_primary, db_file, created_at, created_by) VALUES ('CMP-0001', 1, ?, 'active', 1, '@primary', ?, 'migration')")
        .run(name || "OBO Financial System", new Date().toISOString());
      companies = control.prepare("SELECT * FROM companies ORDER BY seq").all();
    }
    const out = [];
    for (const c of companies) {
      const backupName = c.db_file === "@primary" ? "primary.sqlite" : `companies__${c.db_file}`;
      if (!manifest.files.some((f) => f.backup === backupName)) throw fail(`Company ${c.id} (${c.name}) is registered but its database file ${c.db_file} was not found.`);
      const file = copy(backupName);
      const h = openTenantDb(file, c.id, { isPrimary: !!c.is_primary });
      h.close();
      out.push({ id: c.id, name: c.name, isPrimary: !!c.is_primary, file, backupName });
    }
    return { controlFile, companies: out };
  } finally { control.close(); }
}

// Reads one upgraded SQLite file as a dump (same format as MySQL backups).
function readScope(file, kind, scopeId) {
  const { DatabaseSync } = sqlite();
  const h = new DatabaseSync(file, { readOnly: true });
  try {
    const out = { format: dump.FORMAT, version: dump.VERSION, scope: scopeId, kind, createdAt: new Date().toISOString(), tables: [] };
    const present = new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of schema.ordered(schema.tablesFor(kind))) {
      if (dump.NOT_BACKED_UP.has(t.name)) continue;
      const columns = t.columns.map((c) => c.name);
      if (!present.has(t.name)) {
        // Only optional tables may be absent (created by the app on demand).
        if (t.name === "reset_log") { out.tables.push({ name: t.name, columns, rows: [], checksum: dump.rowsChecksum(columns, []) }); continue; }
        throw fail(`${scopeId}: table ${t.name} is missing from the SQLite database after the upgrade.`);
      }
      const live = h.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
      const extra = live.filter((c) => !columns.includes(c));
      if (extra.length) throw fail(`${scopeId}: ${t.name} has columns the MySQL schema does not know (${extra.join(", ")}) — their data would be lost.`);
      const order = (t.primaryKey.length ? t.primaryKey : columns).map((c) => `"${c}"`).join(", ");
      const sel = columns.map((c) => (live.includes(c) ? `"${c}"` : `NULL AS "${c}"`)).join(", ");
      const rows = h.prepare(`SELECT ${sel} FROM "${t.name}" ORDER BY ${order}`).all().map((r) => columns.map((c) => dump.encodeValue(r[c])));
      out.tables.push({ name: t.name, columns, rows, checksum: dump.rowsChecksum(columns, rows) });
    }
    // Integrity facts to compare after loading.
    out.facts = { fkOrphans: sqliteOrphans(h, kind) };
    return out;
  } finally { h.close(); }
}
function sqliteOrphans(h, kind) {
  const o = {};
  for (const t of schema.tablesFor(kind)) for (const f of t.foreignKeys) {
    if (f.columns.length !== 1) continue;
    const n = h.prepare(`SELECT COUNT(*) AS n FROM "${t.name}" x WHERE x."${f.columns[0]}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${f.refTable}" p WHERE p."${f.refColumns[0]}" = x."${f.columns[0]}")`).get().n;
    if (n) o[`${t.name}.${f.columns[0]}`] = n;
  }
  return o;
}

// What the app's own (legacy) upgrade changed in the copy, table by table,
// compared with the untouched backup: an installation that already ran the
// latest version shows no changes; an older one may get the backfills its
// next start would have made. Reported, and --execute requires
// --accept-upgrade-changes when there are any.
function upgradeChanges(backupFile, workFile) {
  const { DatabaseSync } = sqlite();
  const b = new DatabaseSync(backupFile, { readOnly: true });
  const w = new DatabaseSync(workFile, { readOnly: true });
  try {
    const tables = (h) => new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
    const bt = tables(b), out = [];
    for (const t of tables(w)) {
      const wcols = w.prepare(`PRAGMA table_info("${t}")`).all();
      if (!bt.has(t)) { const n = w.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n; if (n) out.push(`${t}: new table with ${n} row(s)`); continue; }
      const bcols = new Set(b.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
      const common = wcols.map((c) => c.name).filter((c) => bcols.has(c));
      const pk = wcols.filter((c) => c.pk).map((c) => c.name);
      const order = (pk.length ? pk : common).map((c) => `"${c}"`).join(", ");
      const read = (h) => h.prepare(`SELECT ${common.map((c) => `"${c}"`).join(", ")} FROM "${t}" ORDER BY ${order}`).all().map((r) => common.map((c) => dump.encodeValue(r[c])));
      const before = read(b), after = read(w);
      const added = wcols.filter((c) => !bcols.has(c.name)).map((c) => c.name);
      if (before.length !== after.length) out.push(`${t}: ${before.length} -> ${after.length} rows`);
      else if (dump.rowsChecksum(common, before) !== dump.rowsChecksum(common, after)) {
        let changed = 0;
        for (let i = 0; i < before.length; i++) if (dump.rowsChecksum(common, [before[i]]) !== dump.rowsChecksum(common, [after[i]])) changed++;
        out.push(`${t}: ${changed} row(s) updated`);
      }
      if (added.length) out.push(`${t}: column(s) added: ${added.join(", ")}`);
    }
    return out;
  } finally { b.close(); w.close(); }
}

/* --------------------------------- checks -------------------------------- */
// Every value must fit its MySQL column exactly as it is; nothing is coerced.
function preflight(d) {
  const problems = [];
  const defs = new Map(schema.tablesFor(d.kind).map((t) => [t.name, t]));
  for (const t of d.tables) {
    const def = defs.get(t.name);
    const colDefs = t.columns.map((c) => def.columns.find((x) => x.name === c));
    // MySQL primary-key columns can never be NULL (SQLite allowed it for TEXT keys).
    const pk = new Set(def.primaryKey);
    t.rows.forEach((r, ri) => {
      r.forEach((v, ci) => {
        const c = colDefs[ci];
        const where = () => `${d.scope} ${t.name}.${c.name} (row ${ri + 1}${t.columns.includes("id") ? `, id ${r[t.columns.indexOf("id")]}` : ""})`;
        if (v === null) { if (c.notNull || pk.has(c.name)) problems.push(`${where()}: NULL in a NOT NULL column`); return; }
        if (c.mysqlType === "BIGINT") { if (typeof v !== "number" || !Number.isInteger(v) || !Number.isSafeInteger(v)) problems.push(`${where()}: ${JSON.stringify(v)} is not a whole number`); }
        else if (c.mysqlType === "DOUBLE") { if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${where()}: ${JSON.stringify(v)} is not a real number (Infinity/NaN/text)`); }
        else if (c.mysqlType.startsWith("VARCHAR")) { if (typeof v !== "string") problems.push(`${where()}: expected text, found ${typeof v}`); else if ([...v].length > 255) problems.push(`${where()}: ${[...v].length} characters (key columns hold at most 255)`); }
        else if (c.mysqlType === "LONGTEXT") { if (typeof v !== "string") problems.push(`${where()}: expected text, found ${typeof v} ${JSON.stringify(v)}`); }
      });
    });
    if (d.kind === "tenant") {
      const ci = t.columns.indexOf("company_id");
      const bad = ci < 0 ? 0 : t.rows.filter((r) => r[ci] !== d.scope).length;
      if (bad) problems.push(`${d.scope} ${t.name}: ${bad} row(s) carry another company's ID`);
    }
    // Unique keys as MySQL will enforce them (incl. lower(name) and the
    // one-default/one-primary rules).
    for (const ix of def.indexes.filter((i) => i.unique)) {
      const seen = new Map();
      for (const r of t.rows) {
        let k;
        if (ix.expression) {
          const m = /^lower\((\w+)\)$/.exec(ix.expression);
          if (!m) continue;
          const v = r[t.columns.indexOf(m[1])]; if (v === null) continue; k = String(v).toLowerCase();
        } else {
          const vals = ix.columns.map((c) => r[t.columns.indexOf(c)]);
          if (vals.some((v) => v === null)) continue;
          const w = ix.where && /^(\w+) = (\d+)$/.exec(ix.where);
          if (w && String(r[t.columns.indexOf(w[1])]) !== w[2]) continue;
          k = JSON.stringify(vals);
        }
        if (seen.has(k)) problems.push(`${d.scope} ${t.name}: duplicate value for unique key ${ix.name || ix.columns.join(",")}: ${k}`);
        seen.set(k, true);
      }
    }
  }
  return problems;
}

// Financial totals per company: the sums every report is built from.
const TOTALS = [
  ["account_ledger", "SELECT currency, type, COUNT(*) AS n, SUM(amount) AS s FROM account_ledger GROUP BY currency, type ORDER BY currency, type"],
  ["cash_ledger", "SELECT currency, type, COUNT(*) AS n, SUM(amount) AS s FROM cash_ledger GROUP BY currency, type ORDER BY currency, type"],
  ["clients", "SELECT COUNT(*) AS n, SUM(balance_usd) AS usd, SUM(balance_slsh) AS slsh FROM clients"],
  ["cash_accounts", "SELECT currency, COUNT(*) AS n, SUM(balance) AS s FROM cash_accounts GROUP BY currency ORDER BY currency"],
  ["exchange_transactions", "SELECT currency_given, currency_received, status, COUNT(*) AS n, SUM(amount_given) AS g, SUM(amount_received) AS r FROM exchange_transactions GROUP BY currency_given, currency_received, status ORDER BY currency_given, currency_received, status"],
  ["transfers", "SELECT currency, status, COUNT(*) AS n, SUM(amount) AS s FROM transfers GROUP BY currency, status ORDER BY currency, status"],
  ["expenses", "SELECT currency, status, COUNT(*) AS n, SUM(amount) AS s FROM expenses GROUP BY currency, status ORDER BY currency, status"],
  ["quotation_payments", "SELECT currency, COUNT(*) AS n, SUM(amount) AS s FROM quotation_payments GROUP BY currency ORDER BY currency"],
  ["opening_balances", "SELECT usd, slsh FROM opening_balances"],
];
function sameTotals(a, b) {
  if (a.length !== b.length) return false;
  return a.every((r, i) => Object.keys(r).every((k) => {
    const x = r[k], y = b[i][k];
    if (typeof x === "number" || typeof y === "number") return Math.abs(Number(x) - Number(y)) < 0.000001 * Math.max(1, Math.abs(Number(x)));
    return x === y;
  }));
}

/* ------------------------------- MySQL side ------------------------------ */
function mysqlHandles() {
  const { connection } = require("../src/mysql/connection");
  const { CompatDb } = require("../src/mysql/compat-db");
  const client = connection();
  const make = (kind, companyId) => new CompatDb(client, kind === "control"
    ? { kind, prefix: schema.CONTROL_PREFIX, tables: new Set(schema.tableNames("control")) }
    : { kind, companyId, prefix: schema.companyPrefix(companyId), tables: new Set(schema.tableNames("tenant")) });
  return { client, make };
}

function targetState(h, d) {
  const present = new Set(h.raw("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").map((r) => r.n));
  const ledgerTable = `${schema.CONTROL_PREFIX}migration_runs`;
  const ledger = present.has(ledgerTable) ? h.raw(`SELECT table_name, checksum, rows_copied FROM "${ledgerTable}" WHERE scope = ?`, [d.scope]) : [];
  const done = new Map(ledger.map((r) => [r.table_name, r]));
  const state = [];
  for (const t of d.tables) {
    const full = h.table(t.name);
    const rows = present.has(full) ? h.raw(`SELECT COUNT(*) AS n FROM "${full}"`)[0].n : 0;
    const prior = done.get(t.name);
    let action;
    if (prior) {
      if (prior.checksum !== t.checksum || prior.rows_copied !== t.rows.length) action = `STOP: already migrated from DIFFERENT source data (${prior.rows_copied} rows) — not overwriting`;
      else if (rows !== t.rows.length) action = `STOP: migrated earlier but now holds ${rows} rows — not touching it`;
      else action = "skip (already migrated and verified)";
    } else if (rows > 0) action = `STOP: holds ${rows} rows not written by this migration — not overwriting`;
    else action = `copy ${t.rows.length} rows`;
    state.push({ table: t.name, sourceRows: t.rows.length, targetRows: rows, action });
  }
  return state;
}

function loadScopeResumable(h, d, sourceSha) {
  const ledgerTable = `${schema.CONTROL_PREFIX}migration_runs`;
  for (const s of targetState(h, d)) {
    if (s.action.startsWith("STOP")) throw fail(`${d.scope} ${s.table}: ${s.action}`);
    if (s.action.startsWith("skip")) { log(`    ${s.table}: already done`); continue; }
    const t = d.tables.find((x) => x.name === s.table);
    const full = h.table(t.name);
    h.exec("BEGIN");
    try {
      h.raw("SET FOREIGN_KEY_CHECKS = 0");
      if (t.rows.length) dump.insertRows(h, full, t.columns, t.rows);
      h.raw("SET FOREIGN_KEY_CHECKS = 1");
      const def = schema.tablesFor(d.kind).find((x) => x.name === t.name);
      const order = (def.primaryKey.length ? def.primaryKey : t.columns).map((c) => `"${c}"`).join(", ");
      const back = h.raw(`SELECT ${t.columns.map((c) => `"${c}"`).join(", ")} FROM "${full}" ORDER BY ${order}`).map((r) => t.columns.map((c) => dump.encodeValue(r[c])));
      const sum = dump.rowsChecksum(t.columns, back);
      if (back.length !== t.rows.length || sum !== t.checksum) throw fail(`${d.scope} ${t.name}: verification failed after copy (rows ${back.length}/${t.rows.length}).`);
      h.raw(`INSERT INTO "${ledgerTable}" (scope, table_name, source_sha256, rows_copied, checksum, finished_at) VALUES (?,?,?,?,?,?)`,
        [d.scope, t.name, sourceSha, t.rows.length, sum, new Date().toISOString()]);
      h.exec("COMMIT");
      log(`    ${t.name}: ${t.rows.length} rows copied and verified`);
    } catch (e) {
      try { h.exec("ROLLBACK"); } catch (_) { /* ignore */ }
      try { h.raw("SET FOREIGN_KEY_CHECKS = 1"); } catch (_) { /* ignore */ }
      throw e;
    }
  }
}

function verifyScope(h, d) {
  const issues = [];
  const after = dump.dumpScope(h, { kind: d.kind, scopeId: d.scope });
  for (const t of d.tables) {
    const a = after.tables.find((x) => x.name === t.name);
    if (!a) { issues.push(`${t.name}: missing in MySQL`); continue; }
    if (a.rows.length !== t.rows.length) issues.push(`${t.name}: ${a.rows.length} rows in MySQL vs ${t.rows.length} in SQLite`);
    else if (a.columns.join() === t.columns.join() && a.checksum !== t.checksum) issues.push(`${t.name}: content differs`);
  }
  const { foreignKeyViolations } = require("../src/mysql/integrity");
  const orphansNow = {};
  for (const v of foreignKeyViolations(h, d.kind)) orphansNow[`${v.table}.${v.column}`] = v.count;
  if (JSON.stringify(orphansNow) !== JSON.stringify(d.facts?.fkOrphans || {})) issues.push(`relationship check differs: SQLite ${JSON.stringify(d.facts?.fkOrphans || {})} vs MySQL ${JSON.stringify(orphansNow)}`);
  if (d.kind === "tenant" && d.facts?.totals) {
    for (const [name, sql] of TOTALS) {
      const mine = h.prepare(sql).all();
      if (!sameTotals(d.facts.totals[name] || [], mine)) issues.push(`financial totals differ for ${name}: SQLite ${JSON.stringify(d.facts.totals[name])} vs MySQL ${JSON.stringify(mine)}`);
    }
  }
  return issues;
}

function sqliteTotals(file) {
  const { DatabaseSync } = sqlite();
  const h = new DatabaseSync(file, { readOnly: true });
  try { const o = {}; for (const [name, sql] of TOTALS) o[name] = h.prepare(sql).all().map((r) => ({ ...r })); return o; } finally { h.close(); }
}

/* ---------------------------------- main --------------------------------- */
function buildBundle(o) {
  let runDir;
  if (o.resume) { runDir = path.resolve(o.resume); verifyBackup(runDir); }
  else {
    const src = discoverSources(o);
    runDir = path.join(path.resolve(o.out), `run-${stamp()}`);
    fs.mkdirSync(runDir, { recursive: true });
    log(`Run folder: ${runDir}`);
    log("1) Making an immutable backup of the SQLite files (read-only)...");
    const m = makeBackup(src, runDir);
    for (const f of m.files) log(`   ${f.backup}  ${f.bytes} bytes  sha256 ${f.sha256.slice(0, 16)}…`);
  }
  const manifest = verifyBackup(runDir);
  log("2) Upgrading COPIES to the final SQLite schema and reading them...");
  const prepared = prepareWorkCopies(runDir, manifest);
  const sha = (name) => manifest.files.find((f) => f.backup === name)?.sha256 || "generated";
  const scopes = [];
  const changes = {};
  const bk = (n) => path.join(runDir, "backup", n);
  if (manifest.files.some((f) => f.backup === "control.sqlite")) changes.control = upgradeChanges(bk("control.sqlite"), prepared.controlFile);
  else changes.control = ["control database created (installation from before multi-company support)"];
  for (const c of prepared.companies) changes[c.id] = upgradeChanges(bk(c.backupName), c.file);
  const control = readScope(prepared.controlFile, "control", "control");
  control.sourceSha256 = sha("control.sqlite");
  scopes.push(control);
  for (const c of prepared.companies) {
    const d = readScope(c.file, "tenant", c.id);
    d.sourceSha256 = sha(c.backupName);
    d.facts.totals = sqliteTotals(c.file);
    d.companyName = c.name;
    scopes.push(d);
  }
  return { format: BUNDLE_FORMAT, version: 1, createdAt: new Date().toISOString(), runDir, scopes, upgradeChanges: changes };
}

function main() {
  const o = args();
  if (!o.dryRun && !o.execute && !o.bundle) throw fail("Choose --dry-run, --execute or --bundle <file>.");
  if (o.dryRun && o.execute) throw fail("--dry-run and --execute cannot be combined.");
  let bundle;
  if (o.fromBundle) {
    bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(o.fromBundle)).toString("utf8"));
    if (bundle.format !== BUNDLE_FORMAT) throw fail("Not a FINMAN migration bundle.");
    for (const d of bundle.scopes) for (const t of d.tables) if (dump.rowsChecksum(t.columns, t.rows) !== t.checksum) throw fail(`Bundle damaged: ${d.scope} ${t.name}.`);
  } else {
    bundle = buildBundle(o);
  }

  const changed = Object.entries(bundle.upgradeChanges || {}).filter(([, v]) => v.length);
  const dataChanged = changed.some(([, list]) => list.some((x) => !/column\(s\) added|control database created/.test(x)));
  if (changed.length) {
    log("\nThe app's own upgrade (the same one its next start would run) changed these on the COPY:");
    for (const [scope, list] of changed) for (const x of list) log(`  ${scope}: ${x}`);
  }
  if (!dataChanged) log("   upgrade changed no data (existing rows are exactly as in the backup).");
  log("3) Checking every value against the MySQL schema...");
  const problems = bundle.scopes.flatMap((d) => preflight(d));
  const report = { createdAt: new Date().toISOString(), mode: o.dryRun ? "dry-run" : o.execute ? "execute" : "bundle", scopes: [] };
  for (const d of bundle.scopes) {
    report.scopes.push({ scope: d.scope, name: d.companyName || "platform", rows: dump.rowCounts(d), fkOrphansInSource: d.facts?.fkOrphans || {} });
  }
  log("\nRow counts per company (source):");
  for (const s of report.scopes) {
    const total = Object.values(s.rows).reduce((a, b) => a + b, 0);
    log(`  ${s.scope.padEnd(9)} ${String(s.name).slice(0, 40).padEnd(40)} ${total} rows`);
    for (const [t, n] of Object.entries(s.rows)) if (n) log(`      ${t.padEnd(28)} ${n}`);
    if (Object.keys(s.fkOrphansInSource).length) log(`      NOTE: rows referencing missing parents in SQLite (carried over as they are): ${JSON.stringify(s.fkOrphansInSource)}`);
  }
  if (problems.length) {
    report.problems = problems;
    if (bundle.runDir) fs.writeFileSync(path.join(bundle.runDir, "report.json"), JSON.stringify(report, null, 2));
    log(`\nSTOPPED — ${problems.length} value(s) cannot be stored in MySQL exactly as they are. Nothing was written to MySQL.`);
    for (const p of problems.slice(0, 50)) log(`  - ${p}`);
    if (problems.length > 50) log(`  ... and ${problems.length - 50} more (see report.json)`);
    process.exitCode = 3;
    return;
  }
  log("   all values fit.");

  if (o.bundle) {
    fs.writeFileSync(o.bundle, zlib.gzipSync(Buffer.from(JSON.stringify(bundle))));
    log(`\nBundle written: ${o.bundle} (import it with --from-bundle where MySQL is reachable).`);
    if (bundle.runDir) fs.writeFileSync(path.join(bundle.runDir, "report.json"), JSON.stringify(report, null, 2));
    return;
  }

  if (o.execute && dataChanged && !o.acceptUpgradeChanges) {
    log("\nSTOPPED — the upgrade above changed existing data. Review it (report.json); to migrate the upgraded data, run again with --accept-upgrade-changes. Nothing was written to MySQL.");
    report.upgradeChanges = bundle.upgradeChanges;
    if (bundle.runDir) fs.writeFileSync(path.join(bundle.runDir, "report.json"), JSON.stringify(report, null, 2));
    process.exitCode = 6;
    return;
  }
  report.upgradeChanges = bundle.upgradeChanges;
  log("\n4) Checking the MySQL target...");
  const { make, client } = mysqlHandles();
  const plan = bundle.scopes.map((d) => ({ d, h: make(d.kind, d.kind === "tenant" ? d.scope : undefined) }));
  let stop = false;
  for (const { d, h } of plan) {
    const st = targetState(h, d);
    report.scopes.find((s) => s.scope === d.scope).target = st;
    const todo = st.filter((s) => s.action.startsWith("copy")).length;
    const stops = st.filter((s) => s.action.startsWith("STOP"));
    log(`  ${d.scope}: ${todo} table(s) to copy, ${st.length - todo - stops.length} already done${stops.length ? `, ${stops.length} BLOCKED` : ""}`);
    for (const s of stops) { log(`      ${s.table}: ${s.action}`); stop = true; }
  }
  if (bundle.runDir) fs.writeFileSync(path.join(bundle.runDir, "report.json"), JSON.stringify(report, null, 2));
  if (stop) { log("\nSTOPPED — the target already holds data this migration did not write. Nothing was changed."); process.exitCode = 4; client.close(); return; }
  if (o.dryRun) { log("\nDRY RUN finished — nothing was written to MySQL."); client.close(); return; }

  log("\n5) Copying (one transaction per table, verified before commit)...");
  for (const { d, h } of plan) {
    log(`  ${d.scope}${d.companyName ? ` (${d.companyName})` : ""}`);
    schema.ensureScope((sql, p = []) => h.raw(sql, p), d.kind === "control" ? { kind: "control" } : { kind: "tenant", companyId: d.scope });
    loadScopeResumable(h, d, d.sourceSha256 || "bundle");
  }

  log("\n6) Verifying everything (row counts, content checksums, relationships, financial totals)...");
  let issues = 0;
  for (const { d, h } of plan) {
    const v = verifyScope(h, d);
    report.scopes.find((s) => s.scope === d.scope).verification = v.length ? v : "OK";
    log(`  ${d.scope}: ${v.length ? "PROBLEMS" : "OK"}`);
    for (const x of v) log(`      - ${x}`);
    issues += v.length;
  }
  if (bundle.runDir) fs.writeFileSync(path.join(bundle.runDir, "report.json"), JSON.stringify(report, null, 2));
  client.close();
  if (issues) { log(`\nVERIFICATION FOUND ${issues} PROBLEM(S). Do not use the MySQL data; the SQLite files are unchanged.`); process.exitCode = 5; return; }
  log("\nMigration complete and verified. The SQLite files were not changed.");
}

try { main(); } catch (e) {
  if (e.migrationStop) { console.error(`\nSTOPPED: ${e.message}`); process.exitCode = 2; }
  else { console.error(e); process.exitCode = 1; }
  try { require("../src/mysql/connection").close(); } catch (_) { /* ignore */ }
}
