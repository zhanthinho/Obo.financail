"use strict";
// MYSQL round — the synchronous half of the MySQL bridge.
//
// SyncMysql.query(sql, params) blocks the calling thread until the worker
// (src/mysql/worker.js) has run the statement on its single connection, then
// returns the rows (SELECT) or { affectedRows, insertId } (writes) — the same
// "call it, get the answer" shape node:sqlite gave the app, so none of the
// ~900 existing query call sites had to become async.
//
// Safety rules enforced here:
//  * every call has a timeout; a stuck query kills the worker (MySQL then
//    rolls back anything uncommitted on that connection) and the caller gets
//    an error — the server never hangs forever on a dead database;
//  * if the connection is lost while a transaction is open, every further
//    statement fails until the caller rolls back — a half-done transaction
//    is never silently continued on a new connection.
const path = require("path");
const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");

class DbError extends Error {
  constructor(info, sql) {
    super(info.message || "Database error");
    this.name = "DbError";
    this.code = info.code;
    this.errno = info.errno;
    this.sqlState = info.sqlState;
    this.fatal = !!info.fatal;
    if (sql) this.sql = sql;
  }
}

class SyncMysql {
  constructor(config) {
    this.config = { ...config };
    this.timeoutMs = Number(config.callTimeoutMs) || 30000;
    this.worker = null;
    this.inTx = false;
    this.txBroken = false;
    this.closed = false;
  }

  _start() {
    this.sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.sab);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const { callTimeoutMs, ...workerConfig } = this.config;
    this.worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { config: workerConfig, sab: this.sab, port: port2 },
      transferList: [port2],
    });
    this.worker.unref();
    this.port.unref();
    this.worker.on("error", () => { this.worker = null; });
    this.worker.on("exit", () => { this.worker = null; });
  }

  _kill() {
    const w = this.worker;
    this.worker = null;
    if (w) { try { w.terminate(); } catch (_) { /* ignore */ } }
    if (this.inTx) this.txBroken = true;
  }

  _call(msg, timeoutMs) {
    if (this.closed) throw new DbError({ message: "Database connection is closed.", code: "DB_CLOSED" });
    if (!this.worker) this._start();
    Atomics.store(this.flag, 0, 0);
    this.worker.postMessage(msg);
    const waited = Atomics.wait(this.flag, 0, 0, timeoutMs || this.timeoutMs);
    if (waited === "timed-out") {
      this._kill();
      throw new DbError({ message: `Database did not answer within ${Math.round((timeoutMs || this.timeoutMs) / 1000)}s.`, code: "DB_TIMEOUT", fatal: true }, msg.sql);
    }
    const m = receiveMessageOnPort(this.port);
    if (!m) { this._kill(); throw new DbError({ message: "Database worker returned no answer.", code: "DB_BRIDGE", fatal: true }); }
    const out = m.message;
    if (!out.ok) {
      if (out.error.fatal && this.inTx) this.txBroken = true;
      throw new DbError(out.error, msg.sql);
    }
    return out.result;
  }

  // Runs one statement. Rows come back as plain objects; BLOB values as Buffers.
  query(sql, params = []) {
    const kw = /^\s*(\w+)/.exec(sql);
    const verb = kw ? kw[1].toUpperCase() : "";
    const isBegin = verb === "BEGIN" || verb === "START";
    const isEnd = verb === "COMMIT" || verb === "ROLLBACK";
    if (isBegin && this.inTx) throw new DbError({ message: "cannot start a transaction within a transaction", code: "DB_NESTED_TX" }, sql);
    if (this.txBroken) {
      if (verb === "ROLLBACK") { this.inTx = false; this.txBroken = false; return { affectedRows: 0, insertId: 0 }; }
      throw new DbError({ message: "The database connection was lost during this transaction; it has been rolled back. Please try again.", code: "DB_CONNECTION_LOST", fatal: true }, sql);
    }
    if (this.inTx && !isEnd && /^(CREATE|ALTER|DROP|TRUNCATE|RENAME)$/.test(verb)) {
      // MySQL would silently COMMIT the open transaction before running DDL.
      throw new DbError({ message: `Schema change (${verb}) refused inside a transaction.`, code: "DB_DDL_IN_TX" }, sql);
    }
    const result = this._call({ op: "query", sql: isBegin ? "START TRANSACTION" : sql, params, inTx: this.inTx });
    if (isBegin) this.inTx = true;
    if (isEnd) this.inTx = false;
    if (result.rows) {
      for (const row of result.rows) {
        for (const k in row) {
          const v = row[k];
          if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        }
      }
    }
    return result;
  }

  ping(timeoutMs) { return this._call({ op: "ping" }, timeoutMs); }

  close() {
    if (this.closed) return;
    try { if (this.worker) this._call({ op: "close" }, 5000); } catch (_) { /* ignore */ }
    this._kill();
    this.closed = true;
  }
}

module.exports = { SyncMysql, DbError };
