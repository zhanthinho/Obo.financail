"use strict";
// FULL SYSTEM AUDIT round — server-side sign-out.
//
// Session tokens are signed and valid for 12 hours (src/auth.js). Before this
// round "Sign out" only deleted the token from the browser: a copy of it (on
// a shared counter computer, in a proxy log, taken from the browser before
// sign-out) kept working until it expired. Now POST /api/auth/logout records
// the token here and rbac.bearerPayload() refuses it on every later request.
//
// Only a SHA-256 hash of the token is stored (never the token itself), in the
// platform (control) tables so it covers company and Super Admin sessions
// alike. Rows are deleted once the token would have expired anyway.
const crypto = require("crypto");

function control() { return require("./tenancy").controlDb(); }
function tokenHash(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }

let lastPrune = 0;
function prune(nowSec) {
  if (Date.now() - lastPrune < 10 * 60 * 1000) return;
  lastPrune = Date.now();
  control().prepare("DELETE FROM revoked_sessions WHERE expires_at < ?").run(nowSec);
}

// Ends one session. `exp` is the token's own expiry (seconds since epoch).
function revoke(token, exp) {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = tokenHash(token);
  const c = control();
  if (!c.prepare("SELECT 1 AS x FROM revoked_sessions WHERE token_hash = ?").get(h)) {
    c.prepare("INSERT INTO revoked_sessions (token_hash, expires_at, revoked_at) VALUES (?,?,?)").run(h, Number(exp) || nowSec + 12 * 3600, new Date().toISOString());
  }
  try { prune(nowSec); } catch (e) { /* pruning is housekeeping only */ }
}

function isRevoked(token) {
  if (!token) return false;
  return !!control().prepare("SELECT 1 AS x FROM revoked_sessions WHERE token_hash = ?").get(tokenHash(token));
}

module.exports = { revoke, isRevoked, tokenHash };
