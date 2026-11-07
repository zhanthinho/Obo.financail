"use strict";
// SYSTEM AUDIT round — one rule for "which calendar day is this?".
//
// Timestamps are stored in UTC (toISOString). A user, a report or a date
// filter speaks in the COMPANY's calendar day (its time zone is the Daily
// Snapshot setting, default Africa/Mogadishu). Before this round, date
// filters compared DATE(stored UTC timestamp) with the chosen day and
// todayStr() returned the UTC date — so anything recorded between 00:00 and
// 03:00 Mogadishu time landed on the previous day in Transaction History,
// statements, reports and "today" defaults, while the Daily Reports already
// used the company day. Everything now uses the same company day.
//
// A stored value may be a bare "YYYY-MM-DD" (a day chosen without a time —
// it already IS a company day) or a full ISO timestamp (an instant). The SQL
// built here handles both, row by row.
const S = require("./daily-snapshots");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function companyTimezone() {
  try { return S.getSettings().timezone || S.DEFAULT_TIMEZONE; } catch (e) { return S.DEFAULT_TIMEZONE; }
}
// Today's date in the company's time zone.
function companyToday(tz) { return S.businessDateOf(new Date(), tz || companyTimezone()); }
// The UTC instant (ISO string) at which `day` starts in the company's zone.
function dayStartUtc(day, tz) { return S.zonedToUtc(day, "00:00", tz || companyTimezone()).toISOString(); }

// A WHERE clause comparing column `col` with a company calendar day.
//   op ">=" — on or after `day`;  "<=" — on or before `day`;  "<" — before `day`.
// Returns [sql, params]. An input that isn't YYYY-MM-DD keeps the old
// DATE() comparison (unchanged behaviour for odd inputs).
function dayClause(col, op, day, tz) {
  if (!DAY_RE.test(String(day || ""))) return [`date(${col}) ${op} date(?)`, [day]];
  const z = tz || companyTimezone();
  if (op === ">=") return [`(CASE WHEN LENGTH(${col}) <= 10 THEN ${col} >= ? ELSE ${col} >= ? END)`, [day, dayStartUtc(day, z)]];
  if (op === "<=") return [`(CASE WHEN LENGTH(${col}) <= 10 THEN ${col} <= ? ELSE ${col} < ? END)`, [day, dayStartUtc(S.addDays(day, 1), z)]];
  if (op === "<") return [`(CASE WHEN LENGTH(${col}) <= 10 THEN ${col} < ? ELSE ${col} < ? END)`, [day, dayStartUtc(day, z)]];
  throw new Error(`dayClause: unsupported operator ${op}`);
}

module.exports = { companyTimezone, companyToday, dayStartUtc, dayClause, DAY_RE };
