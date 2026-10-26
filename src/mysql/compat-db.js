"use strict";
// MYSQL round — a database handle with the same shape the app always used
// (node:sqlite's DatabaseSync: prepare().get/all/run, exec), bound to ONE
// scope: one company's tables, or the platform tables. Every statement is
// translated by dialect.js for that scope before it reaches MySQL.
const { makeTranslator, splitStatements } = require("./dialect");

function checkParams(params, sql) {
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    const ok = v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint" || Buffer.isBuffer(v) || v instanceof Uint8Array;
    if (!ok) {
      // Same rule node:sqlite applied: undefined/booleans are a bug in
      // the caller, never silently stored as something else.
      const e = new TypeError(`Provided value cannot be bound to SQL parameter ${i + 1}.`);
      e.code = "ERR_INVALID_ARG_TYPE";
      e.sql = sql;
      throw e;
    }
    if (typeof v === "number" && !Number.isFinite(v) && !Number.isNaN(v)) {
      const e = new TypeError(`Parameter ${i + 1} is not a finite number.`);
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
  }
}

class CompatDb {
  // client: SyncMysql; scope: { kind, companyId?, prefix, tables:Set }
  constructor(client, scope) {
    this.client = client;
    this.scope = scope;
    this.translate = makeTranslator(scope);
  }
  _query(sql, params) {
    checkParams(params, sql);
    return this.client.query(this.translate(sql), params.map((v) => (typeof v === "bigint" ? v.toString() : Number.isNaN(v) ? null : v)));
  }
  prepare(sql) {
    const self = this;
    return {
      get(...params) { const r = self._query(sql, params); return r.rows ? r.rows[0] : undefined; },
      all(...params) { const r = self._query(sql, params); return r.rows || []; },
      run(...params) {
        const r = self._query(sql, params);
        return { changes: r.rows ? 0 : r.affectedRows, lastInsertRowid: r.rows ? 0 : r.insertId };
      },
    };
  }
  exec(sql) {
    for (const s of splitStatements(sql)) this._query(s, []);
  }
  // The full MySQL name of one of this scope's tables.
  table(name) {
    if (!this.scope.tables.has(name)) throw new Error(`Unknown table ${name}`);
    return this.scope.prefix + name;
  }
  // Untranslated statement (schema tools, backups) — callers must use table().
  raw(sql, params = []) {
    checkParams(params, sql);
    const r = this.client.query(sql, params);
    return r.rows || r;
  }
  close() { /* the connection is shared; closed by mysql/connection.js */ }
}

module.exports = { CompatDb };
