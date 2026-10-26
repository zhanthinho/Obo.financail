"use strict";
// MYSQL round — the app's one MySQL connection (see sync-client.js).
//
// Connection settings come ONLY from environment variables — never from code
// or committed files. The names are the ones GoDaddy Node.js Hosting injects
// for its managed MySQL database (godaddy/nodejs-hosting-agent-skill,
// references/contract.md): DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.
// For local development put them in a .env file (never committed; see
// .env.example).
const { SyncMysql, DbError } = require("./sync-client");

const MIN_VERSION = [8, 0, 16]; // functional indexes + enforced CHECK constraints

function readConfig() {
  // Read explicitly by name — exactly the variables the platform sets.
  const settings = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
  };
  const missing = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].filter((k) => !settings[k] || !String(settings[k]).trim());
  if (missing.length) {
    const e = new Error(`Database is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. On GoDaddy these are provided by the managed MySQL database; locally, put them in .env (see .env.example).`);
    e.code = "DB_NOT_CONFIGURED";
    throw e;
  }
  const port = settings.DB_PORT ? Number(settings.DB_PORT) : 3306;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("DB_PORT must be a port number.");
  const queryTimeoutMs = Number(process.env.DB_QUERY_TIMEOUT_MS) || 25000;
  // Encrypted connection for a cloud MySQL (e.g. Aiven), which requires TLS:
  //   DB_SSL_CA = the server's CA certificate (PEM text; "\n" escapes are
  //               accepted) -> TLS with the certificate verified (preferred);
  //   DB_SSL    = "require"  -> TLS without verifying the certificate.
  // Neither set -> plain connection (local MySQL, GoDaddy), as before.
  let ssl;
  const ca = process.env.DB_SSL_CA && String(process.env.DB_SSL_CA).trim();
  if (ca) ssl = { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  else if (/^(require|required|true|1)$/i.test(String(process.env.DB_SSL || "").trim())) ssl = { rejectUnauthorized: false };
  return {
    ssl,
    host: String(settings.DB_HOST).trim(),
    port,
    database: String(settings.DB_NAME).trim(),
    user: String(settings.DB_USER).trim(),
    password: String(settings.DB_PASSWORD),
    connectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
    queryTimeoutMs,
    callTimeoutMs: queryTimeoutMs + 5000,
  };
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function atLeast(v, min) {
  for (let i = 0; i < 3; i++) { if (v[i] > min[i]) return true; if (v[i] < min[i]) return false; }
  return true;
}

let client = null;
let serverInfo = null;

// Opens (once) and checks the connection. Refuses MariaDB and MySQL older
// than 8.0.16 with a clear message instead of misbehaving later.
function connection() {
  if (client) return client;
  const c = new SyncMysql(readConfig());
  try {
    const r = c.query("SELECT VERSION() AS v, @@version_comment AS vc, DATABASE() AS db").rows[0];
    const ver = parseVersion(r.v);
    if (/mariadb/i.test(`${r.v} ${r.vc}`)) throw new Error(`This app needs MySQL ${MIN_VERSION.join(".")}+; the server is MariaDB ${r.v}.`);
    if (!ver || !atLeast(ver, MIN_VERSION)) throw new Error(`This app needs MySQL ${MIN_VERSION.join(".")} or newer; the server reports ${r.v}.`);
    if (!r.db) throw new Error("DB_NAME does not select a database.");
    serverInfo = { version: r.v, comment: r.vc };
  } catch (e) {
    c.close();
    throw e;
  }
  client = c;
  return client;
}

// For /api/health: a real round-trip to MySQL, bounded by a short timeout.
function healthCheck(timeoutMs = 3000) {
  try {
    connection().ping(timeoutMs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === "DB_NOT_CONFIGURED" ? "database not configured" : "database unreachable" };
  }
}

function close() { if (client) { client.close(); client = null; } }
function info() { return serverInfo; }

module.exports = { connection, readConfig, healthCheck, close, info, DbError, MIN_VERSION, parseVersion, atLeast };
