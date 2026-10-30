"use strict";
const crypto = require("crypto");

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function nowISO() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Convert an amount between USD and SLSH given "rate" = SLSH per 1 USD.
function convert(amount, from, to, rate) {
  const n = Number(amount) || 0;
  if (from === to) return n;
  return to === "USD" ? n / rate : n * rate;
}

function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  const neg = n < 0; const abs = Math.abs(n);
  const body = currency === "USD" ? `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `SLSH ${Math.round(abs).toLocaleString("en-US")}`;
  return neg ? `-${body}` : body;
}

// Centralized formatter for PERSONAL/PERSON name fields (Account Name,
// Client Name, User/Employee Name, etc.) — trims, collapses internal
// whitespace, and uppercases. Deliberately NOT applied to company names,
// product names, emails, usernames, addresses, or notes (see callers).
// Used both server-side (source of truth) and mirrored client-side for
// immediate visual feedback.
function formatPersonName(name) {
  if (name == null) return name;
  return String(name).trim().replace(/\s+/g, " ").toUpperCase();
}

// PAYMENT & TRANSFER UPGRADE round: normalizes a user-supplied Payment Date
// (an HTML date input's "YYYY-MM-DD", or an already-full ISO timestamp) into
// the exact string account_ledger/transfers store in their `date` column —
// the ACCOUNTING date every balance/statement calculation sorts and totals
// by, kept separate from `created_at` (the real system creation time, always
// set independently to nowISO() at insert and never touched again). Defaults
// to today when omitted/blank; returns null (never a silent "today" fallback)
// when a real but unparseable value was supplied, so a typo surfaces as a
// clear validation error instead of quietly discarding what the user typed.
function resolvePaymentDate(input) {
  if (input === undefined || input === null || String(input).trim() === "") return todayStr();
  const s = String(input).trim();
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return null;
  return s.length === 10 ? s : d.toISOString();
}

// BALANCE & LAST TRANSACTION FIX round: account_ledger/transfers `date` can
// be a bare "YYYY-MM-DD" (anything that went through resolvePaymentDate
// above with no explicit time picked — true for most Payment forms, which
// only offer a date picker) or a full ISO timestamp (an Opening Balance, an
// Exchange, a Transfer given a specific date/time, or any Payment entered
// via a caller that does supply one). Chronological sorting/replay needs a
// genuine Date+Time+Seconds per entry, so a bare date on its own isn't
// enough to order it correctly against a same-day timestamped entry.
//
// chronoSortKey resolves this by borrowing the row's own real insertion
// time (`createdAt`, always set, down to the millisecond) as that entry's
// time-of-day WHENEVER `date` itself carries no explicit time — while still
// keeping the entry pinned to whatever calendar day `date` says (so
// backdating/post-dating to a different day is fully respected; only
// same-day ties fall back to real insertion order, which is the best true
// signal available for "which of these same-day entries actually came
// first"). When `date` already carries an explicit time (its own chosen
// time, not just a day), that's used as-is and never overridden.
//
// Simply zero-padding a bare date to midnight (this function's first,
// simpler version) is NOT sufficient: it can make an earlier-dated
// day-only row sort entirely after a same-day row that happens to carry an
// afternoon timestamp (e.g. an account's Opening Balance, stamped with the
// real time of day it was created) even when the day-only row was created
// LATER — scrambling the balance_after trail even though the final total
// happens to still add up right. routes/history.js hit a related (simpler)
// version of this same mixed-format bug once before (see its
// normalizeHistoryDate) — this is the fuller fix, shared so every place
// that replays/sorts by `date` chronologically (rebuildAccountBalance, the
// Account View activity feed, the Account Statement) agrees.
function chronoSortKey(dateStr, createdAt) {
  const s = String(dateStr || "");
  if (s.length > 10) return s; // the row's own date already carries a real time
  const day = s.slice(0, 10) || String(createdAt || "").slice(0, 10);
  const created = String(createdAt || "");
  const time = created.length > 10 ? created.slice(10) : "T00:00:00.000Z";
  return day + time;
}

// SECURITY & INTEGRITY AUDIT round: one rule for every money amount sent to
// the API — a real (finite) number above zero and no larger than
// MAX_AMOUNT (the same 1 trillion cap Company Expenses already used). Before,
// most routes only checked "positive", so "Infinity" or 1e308 was accepted
// and turned the account balance into Infinity.
const MAX_AMOUNT = 1e12;
function isValidAmount(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT;
}
// For values that may be zero or negative (opening balances): finite and
// within the same size limit.
function isFiniteMoney(n) {
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_AMOUNT;
}

// FULL SYSTEM AUDIT round: a number field from a request body. Only a real
// JSON number or a plain numeric string ("12", "12.5", "-3", "1e3") counts;
// anything else — true, [5], {}, "12abc", "" — becomes NaN so the normal
// validation refuses it. (Number(true) is 1 and Number([5]) is 5, so a
// malformed request used to be saved as a real amount.)
const NUMERIC_STRING = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && NUMERIC_STRING.test(v)) return Number(v);
  return NaN;
}
// FULL SYSTEM AUDIT round: running balances are sums of binary floating-point
// amounts, so 0.1 + 0.2 - 0.3 came out as 0.0000000000000000555 instead of 0
// (and 0.3 - 0.1 as 0.19999999999999998, so a transfer of the full "0.20"
// shown on screen was refused as more than the balance). Rounding each step
// to 8 decimals removes that noise while keeping every real fraction the
// system records (e.g. a USD amount converted from SLSH).
function cleanMoney(n) {
  const v = Math.round((Number(n) || 0) * 1e8) / 1e8;
  return v === 0 ? 0 : v; // never -0
}
// "a is more than b" for money, ignoring floating-point noise.
function moneyExceeds(a, b) {
  return cleanMoney(a) - cleanMoney(b) > 1e-8;
}

// NEWEST-FIRST round: one ordering rule for every transaction list — the
// latest entry is always first. Uses chronoSortKey (so a same-day bare date
// is placed by its real insertion time), then the id as a final tie-break
// (ids start with a base36 timestamp, see uid() above, so a later id is a
// later insert). Sorts in place and returns the array.
function newestFirst(rows, dateOf = (r) => r.date, createdOf = (r) => r.created_at, idOf = (r) => r.id) {
  return rows.sort((a, b) => {
    const ka = chronoSortKey(dateOf(a), createdOf(a)), kb = chronoSortKey(dateOf(b), createdOf(b));
    if (ka !== kb) return ka < kb ? 1 : -1;
    const ia = String(idOf(a) || ""), ib = String(idOf(b) || "");
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  });
}

module.exports = { uid, nowISO, todayStr, convert, fmtMoney, formatPersonName, resolvePaymentDate, chronoSortKey, newestFirst, MAX_AMOUNT, isValidAmount, isFiniteMoney, toNumber, cleanMoney, moneyExceeds };
