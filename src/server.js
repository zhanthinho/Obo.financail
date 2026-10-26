"use strict";
require("./env"); // SECURITY HARDENING: load .env (if present) before anything else,
// so JWT_SECRET (checked by ./auth, required transitively below) is available.
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { Router } = require("./router");
const { sendJSON } = require("./http-helpers");
const { serveStatic } = require("./static");
const tenantContext = require("./tenant-context");
const tenancy = require("./tenancy");
const idempotency = require("./idempotency");

const mysqlConnection = require("./mysql/connection");

// MULTI-COMPANY round: open the platform tables, register the primary company
// on first run, and open every company's tables — all BEFORE a single API
// request is served. Then forbid any process-wide default company: from here
// on, a company is only ever bound to a request by rbac.requireAuth after
// verifying the signed token.
// MYSQL round: if MySQL is not reachable at start, the server still starts
// (so the platform's health check gets a clear 503 instead of a crash loop)
// and retries every 15 seconds; until then every API call answers 503.
let ready = false;
let lastBootError = null;
function tryBootstrap() {
  if (ready) return true;
  try {
    tenancy.bootstrap();
    // ONE-TIME OPERATIONAL DATA RESET — inert unless RESET_OPERATIONAL_DATA is
    // set (see src/reset-operational.js). Tolerates the module being absent.
    try { require("./reset-operational").runFromEnv(); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }
    tenantContext.lockScriptTenant();
    ready = true;
    lastBootError = null;
    require("./backup").startScheduler();
    return true;
  } catch (e) {
    lastBootError = e;
    // eslint-disable-next-line no-console
    console.error(`[startup] Database not ready: ${e.message}`);
    if (e.code === "DB_NOT_CONFIGURED") return false;
    if (!/connect|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|PROTOCOL|DB_TIMEOUT|DB_BRIDGE|DB_CLOSED|too many connections/i.test(`${e.code} ${e.message}`)) {
      // Not a connectivity problem (e.g. a schema or ownership check failed):
      // stop rather than serve on a database in an unexpected state.
      // eslint-disable-next-line no-console
      console.error("[startup] Refusing to start:", e);
      process.exit(1);
    }
    return false;
  }
}
tryBootstrap();
if (!ready) {
  const retry = setInterval(() => { if (tryBootstrap()) clearInterval(retry); }, 15000);
  retry.unref();
}

// Errors that mean "the database is unreachable right now" (answered 503).
function isDbUnavailable(err) {
  return !!err && (err.fatal || ["DB_TIMEOUT", "DB_BRIDGE", "DB_CLOSED", "DB_CONNECTION_LOST", "DB_NOT_CONFIGURED", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST", "ER_CON_COUNT_ERROR"].includes(err.code));
}

const router = new Router();
require("./routes/auth").register(router);
require("./routes/users").register(router);
require("./routes/rate").register(router);
require("./routes/balances").register(router);
require("./routes/transactions").register(router);
require("./routes/transfers").register(router);
require("./routes/quotations").register(router);
require("./routes/reports").register(router);
require("./routes/accounts").register(router);
require("./routes/settings").register(router);
require("./routes/history").register(router);
require("./routes/ledger").register(router);
require("./routes/notifications").register(router);
require("./routes/roles").register(router);
require("./routes/tableLayouts").register(router);
require("./routes/systemOverview").register(router);
require("./routes/pdfTemplates").register(router);
require("./routes/excelTemplates").register(router);
require("./routes/dashboard").register(router);
require("./routes/saleRate").register(router);
require("./routes/rateHistory").register(router);
require("./routes/accountStatements").register(router);
require("./routes/cash").register(router);
require("./routes/cashAccountStatements").register(router);
require("./routes/backups").register(router);
require("./routes/loans").register(router);
require("./routes/expenses").register(router);
require("./routes/platform").register(router);

// MYSQL round: the health check makes a real round-trip to MySQL (bounded by
// a short timeout) — 200 only when the app can actually serve data.
router.get("/api/health", (req, res) => {
  const db = mysqlConnection.healthCheck(3000);
  const ok = ready && db.ok;
  sendJSON(res, ok ? 200 : 503, { ok, service: "obo-financial-system", database: db.ok ? "ok" : "unavailable", time: new Date().toISOString() });
});

const staticHandler = serveStatic(path.join(__dirname, "..", "public"));

const server = http.createServer((req, res) => {
  // SECURITY HARDENING: the frontend is always served from this same server
  // (same origin, confirmed) — so CORS is locked down to that origin instead
  // of the previous wildcard "*". A request whose Origin header doesn't match
  // this server's own host simply gets no Access-Control-Allow-Origin header,
  // which makes the browser block the cross-origin response from being read.
  // Same-origin requests (the normal app usage) never send a mismatched
  // Origin, so this does not change any legitimate request/response.
  const requestOrigin = req.headers.origin;
  const host = req.headers.host;
  if (requestOrigin && host) {
    let originHost = null;
    try { originHost = new URL(requestOrigin).host; } catch (e) { originHost = null; }
    if (originHost && originHost === host) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
    }
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  // SECURITY HARDENING: baseline security headers on every response.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'"
  );
  // SECURITY AUDIT round: deny powerful browser features the app never uses,
  // and keep this window isolated from any window that opened it.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Only meaningful over HTTPS, harmless over plain HTTP (ignored by browsers).
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (e) {
    return sendJSON(res, 400, { error: "Invalid URL." });
  }
  const query = Object.fromEntries(url.searchParams.entries());

  if (url.pathname.startsWith("/api/")) {
    const match = router.match(req.method, url.pathname);
    if (!match) return sendJSON(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
    if (match.malformed) return sendJSON(res, 400, { error: "Malformed request path." });
    if (!ready && url.pathname !== "/api/health") return sendJSON(res, 503, { error: "The database is not available yet. Please try again shortly." });
    // SECURITY & INTEGRITY AUDIT round: a repeated save carrying the same
    // Idempotency-Key gets the first answer instead of running twice
    // (src/idempotency.js). Requests without the header are untouched.
    const idemScope = idempotency.scopeFor(req, url.pathname);
    if (idemScope && idempotency.begin(idemScope, res)) return;
    // Every API request gets its own, initially EMPTY company context.
    // LANGUAGE round: the interface language only affects the wording of
    // messages and export labels (never data, permissions or company scope).
    const reqLang = String(req.headers["x-lang"] || query.lang || "").toLowerCase() === "so" ? "so" : "en";
    res.oboLang = reqLang;
    tenantContext.runRequest(async () => match.handler(req, res, match.params, query), reqLang).catch((err) => {
      if (err && err.code === "NO_COMPANY_CONTEXT") {
        // A code path tried to touch company data without an authorized
        // company — refused (fail closed), never answered from any database.
        // eslint-disable-next-line no-console
        console.error(`[server] Blocked data access without company context: ${req.method} ${url.pathname}`);
        if (!res.headersSent) sendJSON(res, 403, { error: "Not authorized for any company." });
        return;
      }
      if (isDbUnavailable(err)) {
        // eslint-disable-next-line no-console
        console.error(`[server] Database unavailable: ${req.method} ${url.pathname}: ${err.code} ${err.message}`);
        if (!res.headersSent) sendJSON(res, 503, { error: "The database is temporarily unavailable. Nothing was saved — please try again." });
        return;
      }
      // eslint-disable-next-line no-console
      console.error("[server] Unhandled error:", err);
      if (!res.headersSent) sendJSON(res, 500, { error: "Internal server error." });
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return staticHandler(req, res, url.pathname);
  }
  sendJSON(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
});

// MYSQL round: the old one-time SQLite upload route (POST /api/_restore-db,
// RESTORE_TOKEN) is gone — data is brought over by
// scripts/migrate-sqlite-to-mysql.js and restored by scripts/restore-backup.js.

// The hosting platform provides PORT.
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`OBO Financial System API listening on port ${PORT}`);
});

// Graceful stop on redeploy/shutdown: finish in-flight requests, close MySQL.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[server] ${signal} received — shutting down.`);
  server.close(() => { mysqlConnection.close(); process.exit(0); });
  setTimeout(() => { mysqlConnection.close(); process.exit(0); }, 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { server };
