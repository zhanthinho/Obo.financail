"use strict";
// SECURITY & INTEGRITY AUDIT round: limits wrong "current password" guesses
// on the change-password endpoints. Without it, someone holding a stolen,
// still-valid session could try passwords there without limit (the sign-in
// form already has its own lockout). Same policy as sign-in: 5 wrong
// answers within 15 minutes lock that account's password change for 15
// minutes; a correct answer clears the counter. Kept in memory per account
// (the key names the company and user, never the password).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const state = new Map(); // key -> { count, first, lockedUntil }

function blocked(key) {
  const e = state.get(key);
  if (!e) return 0;
  const now = Date.now();
  if (e.lockedUntil && now < e.lockedUntil) return Math.ceil((e.lockedUntil - now) / 1000);
  if (e.lockedUntil || now - e.first > WINDOW_MS) state.delete(key);
  return 0;
}
function fail(key) {
  const now = Date.now();
  const e = state.get(key) || { count: 0, first: now, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_ATTEMPTS) e.lockedUntil = now + LOCK_MS;
  state.set(key, e);
}
function succeed(key) { state.delete(key); }

module.exports = { blocked, fail, succeed };
