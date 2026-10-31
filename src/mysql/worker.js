"use strict";
// MYSQL round — the background half of the synchronous MySQL bridge.
//
// The whole app was written against a synchronous database API (node:sqlite).
// MySQL drivers are asynchronous, so this worker thread owns ONE mysql2
// connection and runs each query the main thread hands it; the main thread
// waits (src/mysql/sync-client.js) until the answer is posted back. One
// connection, one query at a time — exactly the serial behaviour the app had
// with SQLite, so a transaction can never interleave with another request.
const { parentPort, workerData } = require("worker_threads");
const mysql = require("mysql2");

const flag = new Int32Array(workerData.sab);
const reply = workerData.port;
const cfg = workerData.config;

// Session settings every connection gets before its first query:
//  * ANSI_QUOTES: "name" is an identifier (as in SQLite), never a string.
//  * PIPES_AS_CONCAT: || concatenates, as in SQLite.
//  * NO_BACKSLASH_ESCAPES: a backslash is an ordinary character in literals
//    and LIKE patterns, as in SQLite (values are always sent as bound
//    parameters, never spliced into SQL, so this cannot open an injection).
//  * STRICT_TRANS_TABLES: refuse bad data instead of silently truncating it.
//  * time_zone UTC: the app stores ISO-8601 UTC strings itself.
const SESSION_SQL = [
  "SET SESSION sql_mode = 'ANSI_QUOTES,PIPES_AS_CONCAT,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION time_zone = '+00:00'",
  "SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin",
];
// GODADDY round: managed MySQL hosts close idle connections quickly (short
// wait_timeout). Asked for a longer idle time where the server allows it;
// refused silently where it doesn't — the reconnect below covers both.
const OPTIONAL_SESSION_SQL = ["SET SESSION wait_timeout = 28800"];
// Errors meaning "the server already dropped this idle connection": the
// statement in hand was never run, so outside a transaction it is safe to
// reconnect and send it once. (MySQL 8.0.24+ sends ER_CLIENT_INTERACTION_TIMEOUT
// / 4031 when it closes an idle session; the driver reports it on the next
// query.)
const IDLE_DROP_RE = /closed state|EPIPE|ECONNRESET|PROTOCOL_CONNECTION_LOST|ER_CLIENT_INTERACTION_TIMEOUT|\b4031\b|server closed the connection/i;

let conn = null;

function connect() {
  return new Promise((resolve, reject) => {
    const c = mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      socketPath: cfg.socketPath || undefined,
      ssl: cfg.ssl || undefined,
      charset: "UTF8MB4_GENERAL_CI", // handshake only; SET NAMES below picks the real collation
      connectTimeout: cfg.connectTimeoutMs || 10000,
      decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false,
      dateStrings: true, multipleStatements: false,
      flags: ["+FOUND_ROWS"],
      enableKeepAlive: true,
    });
    c.on("error", () => { if (conn === c) conn = null; });
    c.connect((err) => {
      if (err) { try { c.destroy(); } catch (_) { /* ignore */ } return reject(err); }
      let i = 0;
      const optional = () => {
        let j = 0;
        const step = () => {
          if (j >= OPTIONAL_SESSION_SQL.length) { conn = c; return resolve(c); }
          c.query(OPTIONAL_SESSION_SQL[j++], () => step()); // best effort
        };
        step();
      };
      const next = () => {
        if (i >= SESSION_SQL.length) return optional();
        c.query(SESSION_SQL[i++], (e) => (e ? (c.destroy(), reject(e)) : next()));
      };
      next();
    });
  });
}

function q(c, sql, params, useExecute) {
  return new Promise((resolve, reject) => {
    const cb = (err, result) => (err ? reject(err) : resolve(result));
    if (useExecute) c.execute({ sql, timeout: cfg.queryTimeoutMs || undefined }, params, cb);
    else c.query({ sql, timeout: cfg.queryTimeoutMs || undefined }, cb);
  });
}

async function handle(msg) {
  if (msg.op === "close") {
    if (conn) { const c = conn; conn = null; await new Promise((r) => c.end(() => r())); }
    return { closed: true };
  }
  if (msg.op === "ping") {
    if (!conn) await connect();
    try {
      await q(conn, "SELECT 1 AS ok", [], false);
    } catch (e) {
      if (!IDLE_DROP_RE.test(`${e.code} ${e.errno} ${e.message}`)) throw e;
      try { conn && conn.destroy(); } catch (_) { /* ignore */ }
      conn = null;
      await connect();
      await q(conn, "SELECT 1 AS ok", [], false);
    }
    return { ok: 1 };
  }
  if (msg.op === "query") {
    let reconnected = false;
    if (!conn) {
      // A dropped connection may only be silently replaced when no
      // transaction was open on it — otherwise the main thread is told, so
      // the half-finished transaction is reported as failed, never resumed
      // on a fresh connection (sync-client.js enforces this too).
      if (msg.inTx) { const e = new Error("The database connection was lost during a transaction; it was rolled back by the server."); e.code = "DB_CONNECTION_LOST"; e.fatal = true; throw e; }
      await connect();
      reconnected = true;
    }
    const useExecute = Array.isArray(msg.params) && msg.params.length > 0;
    let result;
    try {
      result = await q(conn, msg.sql, msg.params || [], useExecute);
    } catch (e) {
      // The server closed an idle connection and the driver only noticed now:
      // the statement was NEVER sent, so (outside a transaction) it is safe to
      // reconnect and send it once. Any other failure is reported as-is.
      if (msg.inTx || !IDLE_DROP_RE.test(`${e.code} ${e.errno} ${e.message}`)) throw e;
      try { conn && conn.destroy(); } catch (_) { /* ignore */ }
      conn = null;
      await connect();
      reconnected = true;
      result = await q(conn, msg.sql, msg.params || [], useExecute);
    }
    if (Array.isArray(result)) return { rows: result, reconnected };
    return { affectedRows: result.affectedRows, insertId: result.insertId, reconnected };
  }
  throw new Error(`unknown op ${msg.op}`);
}

// GODADDY round: keep the one connection from being dropped as idle — a
// lightweight ping every 45 s while nothing else is running on it. A failed
// ping just forgets the connection; the next query reconnects.
let busy = false;
setInterval(() => {
  if (busy || !conn) return;
  const c = conn;
  c.ping((err) => { if (err && conn === c) { try { c.destroy(); } catch (_) { /* ignore */ } conn = null; } });
}, Number(cfg.keepAliveMs) || 45000).unref();

parentPort.on("message", async (msg) => {
  busy = true;
  let out;
  try {
    out = { ok: true, result: await handle(msg) };
  } catch (e) {
    if (e && e.fatal) { try { conn && conn.destroy(); } catch (_) { /* ignore */ } conn = null; }
    out = { ok: false, error: { message: e && e.message, code: e && e.code, errno: e && e.errno, sqlState: e && e.sqlState, fatal: !!(e && e.fatal) } };
  }
  busy = false;
  try { reply.postMessage(out); } catch (e) { reply.postMessage({ ok: false, error: { message: `result could not be returned: ${e.message}` } }); }
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
