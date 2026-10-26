"use strict";
const crypto = require("crypto");

// SECURITY HARDENING: no insecure fallback secret. A hardcoded default would
// let anyone who reads this source forge valid login tokens for any account.
// The server must refuse to start rather than silently sign real tokens with
// a known/guessable secret. ./env.js (required by server.js before this
// module loads) fills in JWT_SECRET from a local .env file if one exists; a
// real environment variable set by the host/process manager always wins.
if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
  // eslint-disable-next-line no-console
  console.error(
    "[auth] FATAL: JWT_SECRET is not set. Refusing to start.\n" +
    "        Set a strong, random JWT_SECRET (e.g. generate one with:\n" +
    "        node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\")\n" +
    "        as an environment variable, or in a .env file in the project root."
  );
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

/* ---------------- Password hashing (PBKDF2-SHA512, no external deps) ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const check = crypto.pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- Minimal JWT (HS256), no external deps ---------------- */
function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64");
}
function sign(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${sig}`;
}
function verify(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

/* ---------------- Sealed company reference (COMPANY ID VISIBILITY round) ----------------
   A JWT payload is only base64 — readable by whoever holds it. Company users'
   tokens therefore carry their company as an AES-256-GCM sealed value (`cref`)
   instead of the readable Company ID, so the ID can't be read out of the
   token. Only the server (which holds JWT_SECRET) can open it. */
const CREF_KEY = crypto.createHash("sha256").update(`${JWT_SECRET}::company-ref`).digest();
function sealCompanyId(companyId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", CREF_KEY, iv);
  const enc = Buffer.concat([c.update(String(companyId), "utf8"), c.final()]);
  return b64url(Buffer.concat([iv, c.getAuthTag(), enc]));
}
function openCompanyRef(ref) {
  try {
    const raw = b64urlDecode(String(ref));
    const d = crypto.createDecipheriv("aes-256-gcm", CREF_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}
// The company a verified token is bound to: sealed `cref` (company users) or
// plain `cid` (Super Admin tokens, and company tokens issued before this round).
function tokenCompanyId(payload) {
  if (!payload) return null;
  if (payload.cref) return openCompanyRef(payload.cref);
  return payload.cid || null;
}

/* ---------------- Password policy (SECURITY AUDIT round) ----------------
   The demo/seed passwords below are published in this repository (scripts/
   seed.js, README), so an account still using one is effectively open to
   anyone. They — and a handful of the most-guessed passwords — can never be
   set again, and signing in with one forces a password change before the
   session can do anything else (see routes/auth.js + rbac.requireAuth). */
const KNOWN_DEFAULT_PASSWORDS = new Set([
  "demo123!", "superadmin123!", "admin123!", "admin123", "password", "password1", "password123", "password123!",
  "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "11111111", "00000000", "abcd1234", "geeska123", "welcome1", "letmein1",
].map((p) => p.toLowerCase()));
function isKnownDefaultPassword(password) {
  return KNOWN_DEFAULT_PASSWORDS.has(String(password || "").trim().toLowerCase());
}
// Returns an error message, or null when the password is acceptable.
function passwordPolicyError(password, { username } = {}) {
  if (typeof password !== "string") return "Password must be text.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 200) return "Password is too long.";
  if (isKnownDefaultPassword(password)) return "This password is a published default or too common — choose a different one.";
  if (username && password.trim().toLowerCase() === String(username).trim().toLowerCase()) return "Password can't be the same as the username.";
  return null;
}
// Spends the same time as a real check, so a login for an unknown username
// can't be told apart from a wrong password by how long it takes.
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");
const DUMMY_HASH = crypto.pbkdf2Sync("not-a-real-password", DUMMY_SALT, 100_000, 64, "sha512").toString("hex");
function burnPasswordCheck(password) {
  try { verifyPassword(String(password || ""), DUMMY_HASH, DUMMY_SALT); } catch (e) { /* ignore */ }
}

module.exports = { hashPassword, verifyPassword, sign, verify, sealCompanyId, tokenCompanyId, isKnownDefaultPassword, passwordPolicyError, burnPasswordCheck };
