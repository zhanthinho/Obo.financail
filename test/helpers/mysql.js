"use strict";
// MYSQL round — test helper: every test run gets its OWN, brand-new MySQL
// database (created here, dropped at the end), so tests never touch real
// data and never see each other's rows.
//
// Needs a MySQL 8 account that may CREATE and DROP databases, given by:
//   TEST_MYSQL_HOST, TEST_MYSQL_PORT, TEST_MYSQL_USER, TEST_MYSQL_PASSWORD
// (a local development server — NEVER the production database).
const crypto = require("crypto");
const { SyncMysql } = require("../../src/mysql/sync-client");
const { CompatDb } = require("../../src/mysql/compat-db");
const schema = require("../../src/mysql/schema");

function adminConfig() {
  const e = process.env;
  if (!e.TEST_MYSQL_HOST || !e.TEST_MYSQL_USER) {
    console.error("These tests need a disposable local MySQL 8 server: set TEST_MYSQL_HOST, TEST_MYSQL_PORT, TEST_MYSQL_USER, TEST_MYSQL_PASSWORD.");
    process.exit(2);
  }
  if (e.DB_NAME && !/^finman_test_/.test(e.DB_NAME)) {
    // Guard: never let a test run against whatever database the shell points at.
    delete e.DB_NAME;
  }
  return { host: e.TEST_MYSQL_HOST, port: Number(e.TEST_MYSQL_PORT || 3306), user: e.TEST_MYSQL_USER, password: e.TEST_MYSQL_PASSWORD || "" };
}

// Creates a fresh database. Returns { name, env, drop() }.
function createTestDatabase(label = "t") {
  const cfg = adminConfig();
  const name = `finman_test_${String(label).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new SyncMysql({ ...cfg, database: "" });
  admin.query(`CREATE DATABASE "${name}" CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  admin.close();
  const env = { DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_NAME: name, DB_USER: cfg.user, DB_PASSWORD: cfg.password };
  let dropped = false;
  const drop = () => {
    if (dropped || process.env.KEEP_TEST_DB) return;
    dropped = true;
    const a = new SyncMysql({ ...cfg, database: "" });
    try { a.query(`DROP DATABASE IF EXISTS "${name}"`); } finally { a.close(); }
  };
  // Dropped automatically when the test process ends (even on failure).
  process.on("exit", () => { try { drop(); } catch (_) { /* ignore */ } });
  return { name, env, drop };
}

// A direct handle on one company's tables (or the platform tables) of a test
// database — the same app SQL works on it (`SELECT ... FROM clients`).
function openScope(env, { companyId, control = false, readOnly = false } = {}) {
  const client = new SyncMysql({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
  const kind = control ? "control" : "tenant";
  const scope = control
    ? { kind, prefix: schema.CONTROL_PREFIX, tables: new Set(schema.tableNames("control")) }
    : { kind, companyId: companyId || "CMP-0001", prefix: schema.companyPrefix(companyId || "CMP-0001"), tables: new Set(schema.tableNames("tenant")) };
  const h = new CompatDb(client, scope);
  if (readOnly) client.query("SET SESSION TRANSACTION READ ONLY");
  h.close = () => client.close();
  return h;
}

module.exports = { createTestDatabase, openScope, adminConfig };
