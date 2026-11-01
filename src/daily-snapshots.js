"use strict";
// DAILY REPORTS round — automatic daily financial snapshots.
//
// Once a day, at the time set in Daily Reports > Settings (default 23:59) in
// the company's own time zone, each company's Balance Sheet position is
// stored in daily_snapshots: Debt, Cash Account and Credit per currency, the
// Balance Sheet per currency, the Cash Account rate in force and the
// combined (Net) figure made with THAT rate, plus each active cash
// account's balance. The figures come from src/balance-sheet.js — the same
// calculation as the live Balance Sheet — read inside one transaction so
// they belong to one consistent moment.
//
// Rules this module keeps:
//   * A snapshot is never changed after it is written (there is no update
//     or delete path). New transactions, edits and rate changes never touch
//     a stored snapshot.
//   * One automatic and at most one manual snapshot per company per
//     business date — enforced by a UNIQUE index, so two processes (or a
//     retry racing the scheduler) can never store two.
//   * The capture time stored is the real one. A snapshot taken more than
//     LATE_AFTER_MIN minutes after its scheduled time is flagged late.
//   * A business day whose scheduled time passed while the server was off
//     is recorded as MISSED — it is never filled in later with a position
//     taken on another day.
//   * Taking a snapshot only reads; it never writes a financial record.
//   * Every run (started / succeeded / failed / missed) is logged in
//     daily_snapshot_runs and the main events in the company audit log.
const { get, all, run, tx } = require("./db");
const { uid, nowISO } = require("./util");
const { addAudit } = require("./domain");
const { computeBalanceSheet, round2 } = require("./balance-sheet");

const DEFAULT_TIMEZONE = "Africa/Mogadishu";
const DEFAULT_RUN_TIME = "23:59";
const LATE_AFTER_MIN = 10;
const AUTO_ATTEMPTS = 3; // automatic re-tries of a failed scheduled run (same day only)
const SYSTEM_ACTOR = { id: null, name: "Automatic snapshot (system)", role: "system" };

// ---- time zone helpers (Intl only; no fixed offsets, so DST is handled) ----
function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string" || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
}
function zonedParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}`, seconds: Number(o.second) };
}
// The business date (YYYY-MM-DD) an instant falls on in the time zone.
function businessDateOf(date, tz) { return zonedParts(date, tz).date; }
// Offset (ms) of tz at an instant: local wall clock minus UTC.
function tzOffsetMs(instantMs, tz) {
  const p = zonedParts(new Date(instantMs), tz);
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = p.time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, p.seconds) - Math.floor(instantMs / 1000) * 1000;
}
// The UTC instant of a wall-clock date+time in tz.
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass settles DST edges
  return new Date(t);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---- settings ------------------------------------------------------------
function getSettings() {
  let row = get("SELECT * FROM daily_snapshot_settings WHERE id = 1");
  if (!row) {
    // First use: the defaults are written once, so "since when has the
    // schedule existed" is known (days before that are never called missed).
    try {
      run("INSERT INTO daily_snapshot_settings (id, enabled, run_time, timezone, created_at, updated_at, updated_by) VALUES (1, 1, ?, ?, ?, ?, ?)",
        [DEFAULT_RUN_TIME, DEFAULT_TIMEZONE, nowISO(), nowISO(), "system"]);
    } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    row = get("SELECT * FROM daily_snapshot_settings WHERE id = 1");
  }
  return {
    enabled: !!row.enabled, runTime: row.run_time, timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
    createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by,
  };
}
function validateSettings(body) {
  const out = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be true or false." };
    out.enabled = body.enabled;
  }
  if (body.runTime !== undefined) {
    if (!TIME_RE.test(String(body.runTime))) return { error: "Snapshot time must be HH:MM (24-hour), e.g. 23:59." };
    out.runTime = String(body.runTime);
  }
  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) return { error: "Unknown time zone. Use a name like Africa/Mogadishu." };
    out.timezone = body.timezone;
  }
  const unknown = Object.keys(body).filter((k) => !["enabled", "runTime", "timezone"].includes(k));
  if (unknown.length) return { error: `Unknown setting(s): ${unknown.join(", ")}.` };
  return { value: out };
}
function updateSettings(patch, actor) {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  run("UPDATE daily_snapshot_settings SET enabled = ?, run_time = ?, timezone = ?, updated_at = ?, updated_by = ? WHERE id = 1",
    [next.enabled ? 1 : 0, next.runTime, next.timezone, nowISO(), actor.name]);
  const changes = ["enabled", "runTime", "timezone"].filter((k) => cur[k] !== next[k]).map((k) => `${k}: ${cur[k]} → ${next[k]}`);
  addAudit(actor, "Daily snapshot settings changed", changes.join("; ") || "no change");
  return getSettings();
}

// The schedule as of `now`: today's business date, when today's automatic
// snapshot is due, and the next run time.
function scheduleInfo(settings, now = new Date()) {
  const today = businessDateOf(now, settings.timezone);
  const dueToday = zonedToUtc(today, settings.runTime, settings.timezone);
  const next = now < dueToday ? dueToday : zonedToUtc(addDays(today, 1), settings.runTime, settings.timezone);
  return { today, dueToday, next };
}

// ---- capture ---------------------------------------------------------------
function dailyRateNow() {
  const r = get("SELECT daily_rate AS rate FROM rate_history WHERE daily_rate IS NOT NULL ORDER BY at DESC LIMIT 1");
  return r && Number(r.rate) > 0 ? Number(r.rate) : null;
}

function readPosition() {
  const bs = computeBalanceSheet(["USD", "SLSH"]);
  const breakdown = all("SELECT id, name, type, currency, balance FROM cash_accounts WHERE status = 'active' ORDER BY currency, name")
    .map((a) => ({ id: a.id, name: a.name, type: a.type, currency: a.currency, balance: round2(a.balance) }));
  return { bs, breakdown, dailyRate: dailyRateNow() };
}

function logRun(fields) {
  const id = uid("snr");
  run(`INSERT INTO daily_snapshot_runs (id, business_date, source, trigger_type, status, started_at, finished_at, snapshot_id, error, actor_id, actor_name, attempt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, fields.businessDate, fields.source, fields.trigger, fields.status, fields.startedAt || nowISO(), fields.finishedAt || null,
    fields.snapshotId || null, fields.error || null, fields.actor?.id || null, fields.actor?.name || SYSTEM_ACTOR.name, fields.attempt || 1]);
  return id;
}
function finishRun(id, status, { snapshotId = null, error = null } = {}) {
  run("UPDATE daily_snapshot_runs SET status = ?, finished_at = ?, snapshot_id = ?, error = ? WHERE id = ?",
    [status, nowISO(), snapshotId, error ? String(error).slice(0, 500) : null, id]);
}

function findSnapshot(businessDate, source) {
  return get("SELECT * FROM daily_snapshots WHERE business_date = ? AND source = ?", [businessDate, source]) || null;
}

class SnapshotError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Takes and stores one snapshot. Returns { snapshot, created }.
//   source: "automatic" | "manual"; trigger: "scheduler" | "manual" | "retry"
// An existing snapshot for the same business date and source is returned
// unchanged (created: false) — retries are idempotent.
function capture({ source, trigger, actor, now = new Date(), attempt = 1 }) {
  const settings = getSettings();
  const tz = settings.timezone;
  const businessDate = businessDateOf(now, tz);
  const existing = findSnapshot(businessDate, source);
  if (existing) return { snapshot: existing, created: false };

  const scheduledFor = source === "automatic" ? zonedToUtc(businessDate, settings.runTime, tz) : null;
  const runId = logRun({ businessDate, source, trigger, status: "started", actor, attempt });
  if (source === "automatic") addAudit(actor || SYSTEM_ACTOR, "Automatic snapshot started", `${businessDate} (${tz})`);
  else addAudit(actor, "Manual snapshot requested", `${businessDate} (${tz})`);
  try {
    if (process.env.FINMAN_TEST_SNAPSHOT_FAULT === "1" && process.env.FINMAN_TEST_MODE === "1") {
      throw new Error("Simulated database failure (test)");
    }
    const id = uid("snap");
    let row;
    try {
      row = tx(() => {
        const { bs, breakdown, dailyRate } = readPosition();
        const capturedAt = nowISO();
        const isLate = scheduledFor && Date.parse(capturedAt) - scheduledFor.getTime() > LATE_AFTER_MIN * 60000 ? 1 : 0;
        const U = bs.currencies.USD, S = bs.currencies.SLSH, c = bs.combined;
        run(`INSERT INTO daily_snapshots (id, business_date, source, status, timezone, scheduled_for, captured_at, is_late,
              debt_usd, debt_slsh, cash_usd, cash_slsh, credit_usd, credit_slsh, bs_usd, bs_slsh,
              debt_accounts_usd, debt_accounts_slsh, credit_accounts_usd, credit_accounts_slsh, cash_accounts_usd, cash_accounts_slsh,
              cash_rate, cash_rate_set_at, daily_rate, combined_usd, combined_slsh, combined_reason, cash_breakdown,
              created_by, created_by_name, created_at)
             VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?)`,
        [id, businessDate, source, "final", tz, scheduledFor ? scheduledFor.toISOString() : null, capturedAt, isLate,
          U.debt, S.debt, U.cashInHand, S.cashInHand, U.credit, S.credit, U.balanceSheet, S.balanceSheet,
          U.debtAccounts, S.debtAccounts, U.creditAccounts, S.creditAccounts, U.cashAccounts, S.cashAccounts,
          bs.cashRate ? bs.cashRate.rate : null, bs.cashRate ? bs.cashRate.setAt : null, dailyRate,
          c.available ? c.usdEquivalent.total : null, c.available ? c.slshEquivalent.total : null, c.available ? null : c.reason,
          JSON.stringify(breakdown), actor?.id || null, actor?.name || SYSTEM_ACTOR.name, capturedAt]);
        return get("SELECT * FROM daily_snapshots WHERE id = ?", [id]);
      });
    } catch (e) {
      // Another process stored the same snapshot first: that one stands.
      if (/duplicate/i.test(e.message)) {
        const other = findSnapshot(businessDate, source);
        if (other) { finishRun(runId, "skipped", { snapshotId: other.id, error: "Already captured by another run." }); return { snapshot: other, created: false }; }
      }
      throw e;
    }
    finishRun(runId, "succeeded", { snapshotId: row.id });
    addAudit(actor || SYSTEM_ACTOR, source === "automatic" ? "Automatic snapshot succeeded" : "Manual snapshot succeeded",
      `${businessDate} · snapshot ${row.id}${row.is_late ? " · late" : ""}`);
    return { snapshot: row, created: true };
  } catch (e) {
    // Diagnostic text only — never amounts or connection details.
    const msg = String(e && e.message || "error").replace(/(password|user|host)=\S+/gi, "$1=…").slice(0, 300);
    finishRun(runId, "failed", { error: msg });
    try { addAudit(actor || SYSTEM_ACTOR, source === "automatic" ? "Automatic snapshot failed" : "Manual snapshot failed", `${businessDate} · ${msg}`); } catch (_) { /* audit must not hide the failure */ }
    throw new SnapshotError(e.status || 500, `The snapshot could not be saved: ${msg}`);
  }
}

// Called by the scheduler for the CURRENT company. Takes today's automatic
// snapshot once it is due, re-tries a failed one a few times (same day
// only), and records yesterday as missed if its time passed unseen.
function runDue(now = new Date()) {
  const settings = getSettings();
  if (!settings.enabled) return { action: "disabled" };
  const { today, dueToday } = scheduleInfo(settings, now);

  // Yesterday: due while the server was off (or the job kept failing)?
  const yesterday = addDays(today, -1);
  const dueYesterday = zonedToUtc(yesterday, settings.runTime, settings.timezone);
  if (settings.createdAt && Date.parse(settings.createdAt) < dueYesterday.getTime() && !findSnapshot(yesterday, "automatic")) {
    const logged = get("SELECT id FROM daily_snapshot_runs WHERE business_date = ? AND source = 'automatic' AND status = 'missed'", [yesterday]);
    if (!logged) {
      logRun({ businessDate: yesterday, source: "automatic", trigger: "scheduler", status: "missed", finishedAt: nowISO(),
        error: "No snapshot was taken for this business day (the server was not running at the scheduled time, or every attempt failed)." });
      addAudit(SYSTEM_ACTOR, "Automatic snapshot missed", `${yesterday} (${settings.timezone})`);
    }
  }

  if (now < dueToday) return { action: "pending" };
  if (findSnapshot(today, "automatic")) return { action: "done" };
  const failures = get("SELECT COUNT(*) AS n FROM daily_snapshot_runs WHERE business_date = ? AND source = 'automatic' AND trigger_type = 'scheduler' AND status = 'failed'", [today]).n;
  if (failures >= AUTO_ATTEMPTS) return { action: "gave_up" };
  try {
    const r = capture({ source: "automatic", trigger: "scheduler", now, attempt: failures + 1 });
    return { action: r.created ? "captured" : "done", snapshot: r.snapshot };
  } catch (e) {
    return { action: "failed", error: e.message };
  }
}

// Retry of a failed or missed run, by an administrator. Only today's
// business day can be captured: a snapshot is the position at the moment
// it is taken, so a past day can no longer be captured truthfully.
function retry(runRow, actor, now = new Date()) {
  const settings = getSettings();
  const today = businessDateOf(now, settings.timezone);
  if (!["failed", "missed"].includes(runRow.status)) throw new SnapshotError(400, "Only a failed or missed snapshot can be retried.");
  if (runRow.business_date !== today) {
    throw new SnapshotError(409, `The business day ${runRow.business_date} has ended. A snapshot always records the position at the moment it is taken, so that day can no longer be captured — it stays marked as ${runRow.status}.`);
  }
  addAudit(actor, "Snapshot retry", `${runRow.business_date} (${runRow.source})`);
  return capture({ source: runRow.source, trigger: "retry", actor, now });
}

// ---- scheduler -------------------------------------------------------------
let started = false;
function startScheduler() {
  if (started || process.env.SNAPSHOTS_ENABLED === "0") return;
  started = true;
  const tickMs = Math.max(1000, Number(process.env.SNAPSHOT_TICK_MS) || 60 * 1000);
  let busy = false;
  const tick = () => {
    if (busy) return; // never two passes at once in this process
    busy = true;
    try {
      const tenancy = require("./tenancy");
      for (const company of tenancy.listCompanies()) {
        try { tenancy.withCompany(company, () => runDue(new Date())); } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[snapshots] ${company.id}: ${e && e.message}`);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[snapshots] Scheduled check failed:", e && e.message);
    } finally { busy = false; }
  };
  setTimeout(tick, Math.min(5000, tickMs)).unref();
  setInterval(tick, tickMs).unref();
  // eslint-disable-next-line no-console
  console.log("[snapshots] Daily financial snapshots scheduler started.");
}

module.exports = {
  DEFAULT_TIMEZONE, DEFAULT_RUN_TIME, LATE_AFTER_MIN, SnapshotError,
  isValidTimezone, businessDateOf, zonedToUtc, addDays, scheduleInfo, DATE_RE,
  getSettings, validateSettings, updateSettings, capture, runDue, retry, findSnapshot, startScheduler,
};
