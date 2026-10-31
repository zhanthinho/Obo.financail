"use strict";
// SERVER-TO-SERVER TRANSFER — moves a whole FINMAN database from one running
// installation (the SOURCE, e.g. Render + Aiven) to a new one (the TARGET,
// e.g. GoDaddy + its managed MySQL) over HTTPS, for hosts whose database can
// only be reached by the app itself.
//
// Both sides are inert unless configured through environment variables set
// by the owner in each host's dashboard (never in code or committed files):
//   SOURCE:  MIGRATION_TOKEN   — a long random value (32+ characters).
//            Enables GET /api/migration/export, which answers only to that
//            exact token (constant-time check, X-Migration-Token header) and
//            locks itself after a few wrong tokens. Remove it afterwards.
//   TARGET:  MIGRATION_TOKEN   — the same value, and
//            MIGRATE_FROM_URL  — the source's https:// address.
//            On start, BEFORE the app opens its database, the target fetches
//            the export and replaces its own tables with it — but ONLY when
//            its database is still a fresh install (no customers, ledger,
//            exchanges, transfers, quotations, cash or expenses; at most the
//            one default user). A database with real data is never touched.
//
// Safety:
//   * the source is only READ (one consistent snapshot) — never changed;
//   * every table keeps its exact structure (SHOW CREATE TABLE); after the
//     copy every table's row count AND a SHA-256 of all its rows are compared
//     with the source's; any difference undoes the copy (the target is left
//     empty and starts as a fresh install again);
//   * stored backups (ctl_backups/ctl_backup_chunks rows) are not carried —
//     they stay on the source; the target makes its own from the first day;
//   * a marker table (finman_transfer_import) records a finished import, so
//     a restart never imports a second time.
const crypto = require("crypto");
const zlib = require("zlib");

const FORMAT = "finman-transfer-v1";
const MARKER = "finman_transfer_import";
const SKIP_ROWS = /^ctl_(backups|backup_chunks)$/;
// Tables that hold real business data: any row here = not a fresh install.
const BUSINESS = /_(clients|account_ledger|exchange_transactions|transfers|quotations|cash_accounts|cash_ledger|cash_exchanges|cash_transfers|cash_loans|expenses|opening_balances)$/;
const NAME_OK = /^[A-Za-z0-9_]{1,64}$/;

function mysql() { return require("mysql2/promise"); }

const typeCast = (field, next) => (field.type === "JSON" ? field.string("utf8") : next());
const COMMON = { dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, charset: "UTF8MB4_GENERAL_CI", typeCast, multipleStatements: false };

async function connect() {
  const cfg = require("./mysql/connection").readConfig();
  const c = await mysql().createConnection({ ...COMMON, host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, ssl: cfg.ssl || undefined, connectTimeout: 20000 });
  await c.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin");
  await c.query("SET SESSION time_zone = '+00:00'");
  return c;
}

const q = (n) => `\`${n}\``;

function rowHash(h, row, cols) {
  h.update("\u0001");
  for (const c of cols) {
    const v = row[c];
    if (v === null || v === undefined) h.update("N");
    else if (Buffer.isBuffer(v)) { h.update("b"); h.update(v); }
    else h.update("s" + String(v));
    h.update("\u0000");
  }
}

async function tableMeta(c, t) {
  const [cols] = await c.query("SELECT COLUMN_NAME AS c, EXTRA AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [t]);
  const [pk] = await c.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [t]);
  return {
    cols: cols.filter((x) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(x.x)).map((x) => x.c),
    all: cols.map((x) => x.c),
    pk: pk.map((x) => x.c),
  };
}

async function checksum(c, t, meta) {
  const h = crypto.createHash("sha256");
  const order = (meta.pk.length ? meta.pk : meta.all).map(q).join(", ");
  const [rows] = await c.query(`SELECT * FROM ${q(t)} ORDER BY ${order}`);
  for (const r of rows) rowHash(h, r, meta.all);
  return { count: rows.length, sum: h.digest("hex") };
}

const enc = (v) => (Buffer.isBuffer(v) ? { b64: v.toString("base64") } : v);
const dec = (v) => (v && typeof v === "object" && typeof v.b64 === "string" ? Buffer.from(v.b64, "base64") : v);

// ---------------------------------------------------------------- SOURCE --
async function exportAll() {
  const c = await connect();
  try {
    await c.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await c.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const [list] = await c.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
    const tables = [];
    for (const { t } of list) {
      if (t === MARKER) continue;
      const [[ct]] = await c.query(`SHOW CREATE TABLE ${q(t)}`);
      const meta = await tableMeta(c, t);
      let rows = [];
      let sum = { count: 0, sum: crypto.createHash("sha256").digest("hex") };
      if (!SKIP_ROWS.test(t)) {
        const order = (meta.pk.length ? meta.pk : meta.all).map(q).join(", ");
        const [r] = await c.query(`SELECT ${meta.cols.map(q).join(", ")} FROM ${q(t)} ORDER BY ${order}`);
        rows = r.map((row) => meta.cols.map((k) => enc(row[k])));
        sum = await checksum(c, t, meta);
      }
      tables.push({ name: t, create: ct["Create Table"], cols: meta.cols, all: meta.all, pk: meta.pk, rows, count: sum.count, sum: sum.sum });
    }
    await c.query("COMMIT");
    return { format: FORMAT, createdAt: new Date().toISOString(), tables };
  } finally {
    await c.end().catch(() => {});
  }
}

function tokenOk(given) {
  const want = String(process.env.MIGRATION_TOKEN || "");
  if (want.length < 32) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

let wrongTokens = 0;
const MAX_WRONG = 5;

function register(router) {
  router.get("/api/migration/export", async (req, res) => {
    const { sendJSON } = require("./http-helpers");
    // Disabled unless the owner configured a token — and then indistinguishable
    // from an unknown route for anyone without it.
    if (String(process.env.MIGRATION_TOKEN || "").length < 32 || wrongTokens >= MAX_WRONG) return sendJSON(res, 404, { error: "Not found." });
    if (!tokenOk(req.headers["x-migration-token"])) {
      wrongTokens += 1;
      // eslint-disable-next-line no-console
      console.error(`[transfer] export refused: wrong token (${wrongTokens}/${MAX_WRONG})${wrongTokens >= MAX_WRONG ? " — export disabled until restart" : ""}`);
      return sendJSON(res, 404, { error: "Not found." });
    }
    const data = await exportAll();
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8"));
    // eslint-disable-next-line no-console
    console.log(`[transfer] export sent: ${data.tables.length} tables, ${gz.length} bytes`);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": gz.length, "Cache-Control": "no-store" });
    res.end(gz);
  });
}

// ---------------------------------------------------------------- TARGET --
async function listTables(c) {
  const [r] = await c.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  return r.map((x) => x.t);
}

// Returns null when the target is a fresh install, else why it is not.
async function notFreshReason(c, tables) {
  const count = async (t) => Number((await c.query(`SELECT COUNT(*) AS n FROM ${q(t)}`))[0][0].n);
  for (const t of tables) {
    if (BUSINESS.test(t) && (await count(t)) > 0) return `table ${t} has data`;
    if ((/^cmp\d+_users$/.test(t) || t === "ctl_platform_users") && (await count(t)) > 1) return `table ${t} has more than the default user`;
    if (t === "ctl_companies" && (await count(t)) > 1) return "more than one company exists";
  }
  return null;
}

function validateExport(data) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.tables)) throw new Error("The source did not send a FINMAN transfer.");
  const names = new Set();
  for (const t of data.tables) {
    if (!NAME_OK.test(t.name || "") || names.has(t.name)) throw new Error(`Bad table name in transfer: ${t.name}`);
    names.add(t.name);
    if (typeof t.create !== "string" || !t.create.startsWith(`CREATE TABLE ${q(t.name)} (`)) throw new Error(`Bad structure for ${t.name}`);
    if (!Array.isArray(t.cols) || !t.cols.every((x) => NAME_OK.test(x)) || !Array.isArray(t.rows)) throw new Error(`Bad columns for ${t.name}`);
    if (t.rows.some((r) => !Array.isArray(r) || r.length !== t.cols.length)) throw new Error(`Bad rows for ${t.name}`);
  }
  if (!names.has("ctl_companies") || !names.has("ctl_platform_users")) throw new Error("The transfer has no platform tables.");
}

async function importInto(c, data, log) {
  await c.query("SET FOREIGN_KEY_CHECKS = 0");
  const existing = await listTables(c);
  for (const t of existing) await c.query(`DROP TABLE IF EXISTS ${q(t)}`);
  log(`[transfer] removed ${existing.length} tables of the fresh install`);
  try {
    for (const t of data.tables) await c.query(t.create);
    await c.query("START TRANSACTION");
    try {
      for (const t of data.tables) {
        const list = t.cols.map(q).join(", ");
        let chunk = [];
        let bytes = 0;
        const flush = async () => {
          if (!chunk.length) return;
          const ph = chunk.map(() => `(${t.cols.map(() => "?").join(", ")})`).join(", ");
          await c.query(`INSERT INTO ${q(t.name)} (${list}) VALUES ${ph}`, chunk.flat().map(dec));
          chunk = []; bytes = 0;
        };
        for (const r of t.rows) {
          const n = JSON.stringify(r).length;
          if (chunk.length && (chunk.length >= 200 || bytes + n > 1048576)) await flush();
          chunk.push(r); bytes += n;
        }
        await flush();
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
    const bad = [];
    for (const t of data.tables) {
      const got = await checksum(c, t.name, await tableMeta(c, t.name));
      if (got.count !== t.count || got.sum !== t.sum) bad.push(`${t.name} (source ${t.count} rows, here ${got.count})`);
    }
    if (bad.length) throw new Error(`verification failed for ${bad.length} table(s): ${bad.slice(0, 5).join("; ")}`);
    await c.query(`CREATE TABLE ${q(MARKER)} (id INT PRIMARY KEY, source VARCHAR(255) NOT NULL, source_created_at VARCHAR(40) NOT NULL, imported_at VARCHAR(40) NOT NULL, table_count INT NOT NULL, row_count BIGINT NOT NULL)`);
    const rowsTotal = data.tables.reduce((s, t) => s + t.count, 0);
    await c.query(`INSERT INTO ${q(MARKER)} VALUES (1, ?, ?, ?, ?, ?)`, [String(process.env.MIGRATE_FROM_URL).slice(0, 255), data.createdAt, new Date().toISOString(), data.tables.length, rowsTotal]);
    await c.query("SET FOREIGN_KEY_CHECKS = 1");
    return { tables: data.tables.length, rows: rowsTotal };
  } catch (e) {
    // Undo: leave the database empty, so the app starts as a fresh install
    // and the transfer can simply be tried again.
    await c.query("ROLLBACK").catch(() => {});
    for (const t of await listTables(c).catch(() => [])) await c.query(`DROP TABLE IF EXISTS ${q(t)}`).catch(() => {});
    await c.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
    throw e;
  }
}

// Called once on start, before the app opens its database. Never throws:
// any problem is logged and the app starts on whatever the database holds.
async function pullFromEnv({ log = console.log, fetchImpl = fetch } = {}) {
  const from = String(process.env.MIGRATE_FROM_URL || "").trim().replace(/\/+$/, "");
  if (!from) return { skipped: "not configured" };
  const token = String(process.env.MIGRATION_TOKEN || "");
  try {
    let u;
    try { u = new URL(from); } catch (_) { throw new Error("MIGRATE_FROM_URL is not a valid address."); }
    if (u.protocol !== "https:" && !(process.env.FINMAN_TRANSFER_ALLOW_HTTP === "1" && u.protocol === "http:")) throw new Error("MIGRATE_FROM_URL must start with https://");
    if (token.length < 32) throw new Error("MIGRATION_TOKEN must be at least 32 characters.");
    const c = await connect();
    try {
      const tables = await listTables(c);
      if (tables.includes(MARKER)) { log("[transfer] already imported earlier — nothing to do (you can remove MIGRATE_FROM_URL and MIGRATION_TOKEN)."); return { skipped: "already imported" }; }
      const why = await notFreshReason(c, tables);
      if (why) { log(`[transfer] REFUSED — this database is not a fresh install (${why}). Nothing was changed.`); return { skipped: "not fresh", reason: why }; }
      log(`[transfer] fetching data from ${u.origin} ...`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240000);
      let gz;
      try {
        const r = await fetchImpl(`${from}/api/migration/export`, { headers: { "X-Migration-Token": token }, signal: ctrl.signal });
        if (r.status !== 200) throw new Error(`the source answered ${r.status} — check that MIGRATION_TOKEN is the same on both and the source runs the latest version.`);
        gz = Buffer.from(await r.arrayBuffer());
      } finally { clearTimeout(timer); }
      const data = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
      validateExport(data);
      log(`[transfer] received ${data.tables.length} tables (${gz.length} bytes); importing ...`);
      const out = await importInto(c, data, log);
      log(`[transfer] DONE — ${out.tables} tables, ${out.rows} rows copied and verified (row counts + SHA-256). Source data snapshot: ${data.createdAt}.`);
      return { imported: true, ...out };
    } finally {
      await c.end().catch(() => {});
    }
  } catch (e) {
    log(`[transfer] FAILED — ${e.message}. The app starts normally; nothing from the source was kept.`);
    return { failed: true, error: e.message };
  }
}

module.exports = { register, exportAll, pullFromEnv, validateExport, MARKER, FORMAT };
