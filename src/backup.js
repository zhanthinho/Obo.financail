"use strict";
// AUTOMATIC BACKUPS — MYSQL round.
//
// A backup is a complete, self-contained logical copy of ONE company's tables
// (or of the platform tables), stored compressed INSIDE the MySQL database
// (ctl_backups + ctl_backup_chunks) — the hosting's file system is not
// persistent between deploys, so backups never depend on it. A Super Admin
// can download any backup (gzip-compressed JSON) to keep a copy off the
// server; scripts/restore-backup.js restores one.
//
// Schedule (unchanged): every BACKUP_INTERVAL_HOURS (default 24) per company;
// the newest BACKUP_KEEP (default 30) automatic/manual backups are kept, the
// one-time pre-migration / pre-reset / pre-restore rollback points never are
// pruned. On boot and then hourly the age of the newest automatic backup is
// checked, so redeploys never cause missed or duplicate backups.
//
// Every company is backed up SEPARATELY — a backup never contains two
// companies' data, and a restore refuses a backup of another company.
const zlib = require("zlib");
const crypto = require("crypto");
const dump = require("./mysql/dump");

const KEEP = Math.max(3, parseInt(process.env.BACKUP_KEEP || "30", 10) || 30);
const INTERVAL_HOURS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24) || 24);
const KINDS = ["auto", "manual", "premigration", "prereset", "prerestore"];
const NAME_RE = /^finman-(CMP-\d{4,}|control)-\d{4}-\d{2}-\d{2}_\d{6}-(auto|manual|premigration|prereset|prerestore)\.json\.gz$/;
const CHUNK_BYTES = 4 * 1024 * 1024;
// Kept for compatibility with callers that printed the location.
const BACKUP_DIR = "MySQL (ctl_backups)";

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function control() { return require("./tenancy").controlDb(); }

function listScope(scope) {
  return control().prepare("SELECT name, size_bytes, created_at, kind FROM backups WHERE scope = ? AND status = 'complete' ORDER BY created_at DESC, name DESC").all(scope)
    .map((r) => ({ name: r.name, size: r.size_bytes, createdAt: r.created_at, kind: r.kind }));
}
function listBackups(company) {
  if (!company) throw new Error("backup: company required");
  return listScope(company.id);
}

// Stores one dump. Rows are written in one transaction; the backup row is
// marked complete only when every chunk is in.
function store(scope, kind, data, actorName) {
  const json = Buffer.from(JSON.stringify(data));
  const gz = zlib.gzipSync(json, { level: 9 });
  const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
  const createdAt = new Date();
  let name = `finman-${scope}-${stamp(createdAt)}-${kind}.json.gz`;
  const c = control();
  if (c.prepare("SELECT 1 AS x FROM backups WHERE scope = ? AND name = ?").get(scope, name)) {
    // Two backups within the same second: wait for the next second's name.
    const until = Date.now() + 1100;
    while (Date.now() < until) { /* spin briefly — backups are rare */ }
    name = `finman-${scope}-${stamp(new Date())}-${kind}.json.gz`;
  }
  const id = `bk_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
  const chunks = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));
  c.exec("BEGIN");
  try {
    c.prepare(`INSERT INTO backups (id, scope, name, kind, status, created_at, created_by, size_bytes, sha256, row_counts, chunk_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, name, kind, "writing", createdAt.toISOString(), actorName || "system", gz.length, sha256, JSON.stringify(dump.rowCounts(data)), chunks);
    for (let i = 0; i < chunks; i++) {
      c.prepare("INSERT INTO backup_chunks (backup_id, seq, data) VALUES (?,?,?)").run(id, i, gz.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    }
    c.prepare("UPDATE backups SET status = 'complete' WHERE id = ?").run(id);
    c.exec("COMMIT");
  } catch (e) {
    try { c.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
  return { name, size: gz.length, createdAt: createdAt.toISOString(), kind, sha256 };
}

function prune(scope) {
  const c = control();
  const all = c.prepare("SELECT id, kind FROM backups WHERE scope = ? ORDER BY created_at DESC, name DESC").all(scope)
    .filter((b) => b.kind === "auto" || b.kind === "manual");
  for (const b of all.slice(KEEP)) {
    try {
      c.exec("BEGIN");
      c.prepare("DELETE FROM backup_chunks WHERE backup_id = ?").run(b.id);
      c.prepare("DELETE FROM backups WHERE id = ?").run(b.id);
      c.exec("COMMIT");
    } catch (e) {
      try { c.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    }
  }
}

function dumpCompany(company) {
  const tenancy = require("./tenancy");
  return dump.dumpScope(tenancy.openTenant(company).db, { kind: "tenant", scopeId: company.id });
}
function dumpControl() {
  return dump.dumpScope(control(), { kind: "control", scopeId: "control" });
}

function backupNow(company, kind = "auto", actorName) {
  if (!KINDS.includes(kind)) kind = "manual";
  const b = store(company.id, kind, dumpCompany(company), actorName);
  prune(company.id);
  // eslint-disable-next-line no-console
  console.log(`[backup] ${company.id} ${kind} backup stored: ${b.name} (${b.size} bytes)`);
  return { name: b.name, size: b.size, createdAt: b.createdAt, kind: b.kind };
}

function backupControl(kind = "auto") {
  const b = store("control", KINDS.includes(kind) ? kind : "manual", dumpControl());
  prune("control");
  return b;
}

// The stored (gzip) bytes of one backup, after checking its SHA-256.
function readBackup(scope, name) {
  if (!NAME_RE.test(String(name || ""))) return null;
  const c = control();
  const b = c.prepare("SELECT id, sha256, chunk_count, size_bytes FROM backups WHERE scope = ? AND name = ? AND status = 'complete'").get(scope, name);
  if (!b) return null;
  const parts = c.prepare("SELECT seq, data FROM backup_chunks WHERE backup_id = ? ORDER BY seq").all(b.id);
  if (parts.length !== b.chunk_count) throw new Error(`Backup ${name} is incomplete.`);
  const gz = Buffer.concat(parts.map((p) => p.data));
  if (gz.length !== b.size_bytes || crypto.createHash("sha256").update(gz).digest("hex") !== b.sha256) throw new Error(`Backup ${name} is damaged (checksum mismatch).`);
  return gz;
}
function backupFile(company, name) { return readBackup(company.id, name); }

function parseBackup(gz) {
  return JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
}

// MANUAL RESTORE (scripts/restore-backup.js): replaces one company's data
// with a backup of THAT company. A pre-restore backup of the current data is
// stored first, and the restore itself is one transaction.
function restoreCompany(company, gz, actorName) {
  const data = parseBackup(gz);
  dump.validateDump(data, { kind: "tenant", scopeId: company.id });
  const before = backupNow(company, "prerestore", actorName);
  const tenancy = require("./tenancy");
  dump.loadScope(tenancy.openTenant(company).db, data, { kind: "tenant" });
  return { restoredFrom: data.createdAt, preRestoreBackup: before.name, rowCounts: dump.rowCounts(data) };
}

let started = false;
function startScheduler() {
  if (started || process.env.BACKUP_ENABLED === "0") return;
  started = true;
  const dueMs = INTERVAL_HOURS * 3600 * 1000 - 5 * 60 * 1000;
  const check = () => {
    const tenancy = require("./tenancy");
    let anyRan = false;
    for (const company of tenancy.listCompanies()) {
      try {
        const latest = listBackups(company).find((b) => b.kind === "auto");
        const age = latest ? Date.now() - new Date(latest.createdAt).getTime() : Infinity;
        if (age >= dueMs) { backupNow(company, "auto"); anyRan = true; }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[backup] Automatic backup failed for ${company.id}:`, e && e.message);
      }
    }
    if (anyRan) {
      try { backupControl(); } catch (e) { console.error("[backup] Platform tables backup failed:", e && e.message); }
    }
  };
  setTimeout(check, 60 * 1000).unref();
  setInterval(check, 60 * 60 * 1000).unref();
  // eslint-disable-next-line no-console
  console.log(`[backup] Automatic backups every ${INTERVAL_HOURS}h, stored in the database (keeping ${KEEP} per company).`);
}

module.exports = {
  backupNow, backupControl, listBackups, listScope, readBackup, backupFile, parseBackup, restoreCompany,
  dumpCompany, dumpControl, startScheduler, BACKUP_DIR, KEEP, INTERVAL_HOURS, NAME_RE,
};
