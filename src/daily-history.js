"use strict";
// DAILY FINANCIAL HISTORY round — one row per company-local calendar day:
// the day's closing Balance Sheet (Debt + Cash Account − Credit, USD and
// SLSH each on its own) and the closing balance of every active Cash
// Account, with the day's Cash Account movements.
//
// How a day's closing position is worked out (read-only, nothing written
// to any financial table):
//   * Each account's balance at the end of day D = its balance now, minus
//     every ledger movement dated AFTER D (account_ledger for customer /
//     company accounts, cash_ledger for Cash Accounts). The ledger is the
//     same one every balance is kept from, so a day with no later
//     movements equals today's balance exactly, and nothing is counted
//     twice. The transaction's own date is used — never when it was typed.
//   * Debt / Credit / Balance Sheet then follow src/balance-sheet.js:
//     Debt = negative account balances (as a positive figure), Credit =
//     positive ones, per currency; deleted accounts are left out; Cash
//     Account = active Cash Accounts.
//
// Saving and history:
//   * Every ended day (up to yesterday in the company's time zone) is saved
//     once — automatically by the scheduler (src/daily-snapshots.js calls
//     sync() every minute for every company), independent of who is
//     signed in. A UNIQUE index on the date means two runs can never store
//     two rows for one day.
//   * When a transaction dated on or before an already saved day is added,
//     edited, deleted or reversed, the next sync finds that day's figures
//     changed and saves them as a NEW VERSION (status "updated"), and every
//     later day that changed too. Each version is kept in
//     daily_financial_history_versions with when, by what and why; the
//     company audit log records the recalculation. Nothing is overwritten
//     without its earlier version staying readable.
//   * The stored point-in-time snapshots of src/daily-snapshots.js are not
//     touched by any of this.
const { get, all, run, tx } = require("./db");
const { uid, nowISO } = require("./util");
const { addAudit } = require("./domain");
const { round2 } = require("./balance-sheet");
const S = require("./daily-snapshots");

const CALC_VERSION = "dfh-1";
const SYSTEM = { id: null, name: "Daily history (system)", role: "system" };
const MAX_BACKFILL_DAYS = 3 * 366;
const CURS = ["USD", "SLSH"];

function ledgerDay(dateStr, tz) {
  const s = String(dateStr || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s.slice(0, 10) : S.businessDateOf(new Date(t), tz);
}
function moveKind(sourceType, type) {
  if (sourceType === "cash_transfer") return type === "deposit" ? "transferIn" : "transferOut";
  if (sourceType === "cash_exchange" || sourceType === "exchange") return type === "deposit" ? "exchangeIn" : "exchangeOut";
  return type === "deposit" ? "cashIn" : "cashOut";
}
const MOVES = ["cashIn", "cashOut", "transferIn", "transferOut", "exchangeIn", "exchangeOut"];

// A cheap fingerprint of everything a day's figures depend on — when it has
// not changed since the last sync, there is nothing to recalculate.
function signature(tz, today) {
  const a = get("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, client_id, type, amount, date))), 0) AS s FROM account_ledger");
  const c = get("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, cash_account_id, type, amount, date))), 0) AS s FROM cash_ledger");
  const k = get("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, currency, COALESCE(deleted_at, ''), balance_usd, balance_slsh))), 0) AS s FROM clients");
  const h = get("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, status, currency, balance, name))), 0) AS s FROM cash_accounts");
  return [tz, today, a.n, a.s, c.n, c.s, k.n, k.s, h.n, h.s].join(":");
}

// The closing position of every day in [from, to] (inclusive), computed
// from the ledgers as described above. Returns Map(date -> figures).
function computeDays(from, to, tz) {
  const days = [];
  for (let d = from; d <= to; d = S.addDays(d, 1)) days.push(d);
  const out = new Map();
  if (!days.length) return out;
  // --- customer / company accounts ---
  const clients = all("SELECT id, currency, balance_usd, balance_slsh FROM clients WHERE deleted_at IS NULL");
  const bal = new Map(clients.map((c) => [c.id, { cur: c.currency === "SLSH" ? "SLSH" : "USD", v: Number(c.currency === "SLSH" ? c.balance_slsh : c.balance_usd) || 0 }]));
  const accMoves = new Map(); // day -> Map(clientId -> net)
  const laterAcc = new Map(); // clientId -> net of movements after `to`
  for (const e of all("SELECT client_id, type, amount, date FROM account_ledger")) {
    if (!bal.has(e.client_id)) continue;
    const day = ledgerDay(e.date, tz);
    const signed = (e.type === "deposit" ? 1 : -1) * (Number(e.amount) || 0);
    if (day > to) { laterAcc.set(e.client_id, (laterAcc.get(e.client_id) || 0) + signed); continue; }
    if (day < from) continue;
    if (!accMoves.has(day)) accMoves.set(day, new Map());
    const m = accMoves.get(day); m.set(e.client_id, (m.get(e.client_id) || 0) + signed);
  }
  for (const [id, n] of laterAcc) bal.get(id).v -= n; // now: balances at the end of `to`
  // --- Cash Accounts (active ones, as on the Balance Sheet) ---
  const cash = all("SELECT id, name, type, currency, balance FROM cash_accounts WHERE status = 'active' ORDER BY currency, name");
  const cbal = new Map(cash.map((a) => [a.id, Number(a.balance) || 0]));
  const cashMoves = new Map(); // day -> Map(cashId -> {net, kinds})
  const laterCash = new Map();
  for (const e of all("SELECT cash_account_id, type, amount, date, source_type FROM cash_ledger")) {
    if (!cbal.has(e.cash_account_id)) continue;
    const day = ledgerDay(e.date, tz);
    const amt = Number(e.amount) || 0, signed = e.type === "deposit" ? amt : -amt;
    if (day > to) { laterCash.set(e.cash_account_id, (laterCash.get(e.cash_account_id) || 0) + signed); continue; }
    if (day < from) continue;
    if (!cashMoves.has(day)) cashMoves.set(day, new Map());
    const m = cashMoves.get(day);
    if (!m.has(e.cash_account_id)) m.set(e.cash_account_id, { net: 0, ...Object.fromEntries(MOVES.map((k) => [k, 0])) });
    const x = m.get(e.cash_account_id);
    x.net += signed; x[moveKind(e.source_type, e.type)] += amt;
  }
  for (const [id, n] of laterCash) cbal.set(id, cbal.get(id) - n);
  // --- walk the days backwards from `to` ---
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    const fig = {};
    for (const cur of CURS) fig[cur] = { debt: 0, credit: 0, cash: 0, debtAccounts: 0, creditAccounts: 0, cashAccounts: 0 };
    for (const { cur, v } of bal.values()) {
      const r = round2(v);
      if (r < 0) { fig[cur].debt -= v; fig[cur].debtAccounts += 1; } else if (r > 0) { fig[cur].credit += v; fig[cur].creditAccounts += 1; }
    }
    const dayCash = cashMoves.get(d) || new Map();
    const cashRows = [];
    for (const a of cash) {
      const closing = cbal.get(a.id);
      const mv = dayCash.get(a.id);
      const opening = closing - (mv ? mv.net : 0);
      fig[a.currency === "SLSH" ? "SLSH" : "USD"].cash += closing;
      fig[a.currency === "SLSH" ? "SLSH" : "USD"].cashAccounts += 1;
      cashRows.push({ id: a.id, name: a.name, type: a.type, currency: a.currency, openingBalance: round2(opening),
        ...Object.fromEntries(MOVES.map((k) => [k, round2(mv ? mv[k] : 0)])), closingBalance: round2(closing) });
    }
    const out1 = { calcVersion: CALC_VERSION, cashAccounts: cashRows };
    for (const cur of CURS) {
      const f = fig[cur];
      out1[cur.toLowerCase()] = { debt: round2(f.debt), cash: round2(f.cash), credit: round2(f.credit), balanceSheet: round2(f.debt + f.cash - f.credit),
        debtAccounts: f.debtAccounts, creditAccounts: f.creditAccounts, cashAccounts: f.cashAccounts };
    }
    out.set(d, out1);
    // step back to the end of the previous day
    const am = accMoves.get(d);
    if (am) for (const [id, n] of am) bal.get(id).v -= n;
    if (mv0(dayCash)) for (const [id, x] of dayCash) cbal.set(id, cbal.get(id) - x.net);
  }
  return out;
}
const mv0 = (m) => m && m.size > 0;

function firstActivityDay(tz) {
  const a = get("SELECT MIN(date) AS d FROM account_ledger");
  const c = get("SELECT MIN(date) AS d FROM cash_ledger");
  const ds = [a && a.d, c && c.d].filter(Boolean).map((x) => ledgerDay(x, tz));
  return ds.length ? ds.sort()[0] : null;
}

// What was saved, as compared figures (only the parts a version tracks).
const comparable = (data) => JSON.stringify({ usd: data.usd, slsh: data.slsh, cash: (data.cashAccounts || []).map((a) => [a.id, a.openingBalance, a.closingBalance, ...MOVES.map((k) => a[k])]) });

// Why a saved day changed: the ledger entries dated on or before it that
// were recorded after it was last saved (a backdated entry); otherwise an
// edit, deletion or reversal of an earlier entry.
function reasonFor(day, since, tz) {
  const rows = [
    ...all("SELECT reference_number AS ref, staff_name AS staff, date, created_at FROM account_ledger WHERE created_at > ?", [since]),
    ...all("SELECT reference_number AS ref, staff_name AS staff, date, created_at FROM cash_ledger WHERE created_at > ?", [since]),
  ].filter((r) => ledgerDay(r.date, tz) <= day);
  if (rows.length) {
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const r = rows[0];
    return `Recalculated: ${rows.length} transaction(s) dated on or before ${day} were recorded later (latest ${r.ref || "entry"} dated ${ledgerDay(r.date, tz)}${r.staff ? ` by ${r.staff}` : ""}).`;
  }
  return `Recalculated: a transaction dated on or before ${day} was edited, deleted or reversed.`;
}

const lastSig = new Map(); // company id -> signature already synced
function companyKey() { const c = require("./tenant-context").currentCompany(); return c ? c.id : "_"; }

// Saves every ended day that is not saved yet, and a new version of every
// saved day whose figures have changed. Idempotent; safe to run often.
function sync({ now = new Date(), actor = SYSTEM, force = false } = {}) {
  const tz = S.getSettings().timezone;
  const today = S.businessDateOf(now, tz);
  const yesterday = S.addDays(today, -1);
  const key = companyKey();
  const sig = signature(tz, today);
  if (!force && lastSig.get(key) === sig) return { action: "unchanged" };
  const first = firstActivityDay(tz);
  if (!first || first > yesterday) { lastSig.set(key, sig); return { action: "nothing" }; }
  const from = first < S.addDays(yesterday, -MAX_BACKFILL_DAYS) ? S.addDays(yesterday, -MAX_BACKFILL_DAYS) : first;
  const figures = computeDays(from, yesterday, tz);
  const saved = new Map(all("SELECT * FROM daily_financial_history WHERE business_date >= ? AND business_date <= ?", [from, yesterday]).map((r) => [r.business_date, r]));
  let created = 0;
  const updated = [];
  const at = nowISO();
  for (const [day, data] of [...figures.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const row = saved.get(day);
    const json = JSON.stringify(data);
    if (!row) {
      try {
        tx(() => {
          const id = uid("dfh");
          run(`INSERT INTO daily_financial_history (id, business_date, version, status, calc_version, timezone, bs_usd, bs_slsh, cash_usd, cash_slsh, data, created_at, created_by, updated_at, updated_by, update_reason)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, day, 1, "saved", CALC_VERSION, tz, data.usd.balanceSheet, data.slsh.balanceSheet, data.usd.cash, data.slsh.cash, json, at, actor.name, at, actor.name, "End-of-day snapshot"]);
          run(`INSERT INTO daily_financial_history_versions (id, business_date, version, calc_version, bs_usd, bs_slsh, cash_usd, cash_slsh, data, recorded_at, recorded_by, reason)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uid("dfv"), day, 1, CALC_VERSION, data.usd.balanceSheet, data.slsh.balanceSheet, data.usd.cash, data.slsh.cash, json, at, actor.name, "End-of-day snapshot"]);
        });
        created += 1;
      } catch (e) { if (!/duplicate/i.test(e.message)) throw e; /* another run saved it first */ }
      continue;
    }
    let old = null; try { old = JSON.parse(row.data); } catch (e) { old = {}; }
    if (comparable(old) === comparable(data)) continue;
    const reason = reasonFor(day, row.updated_at, tz);
    const version = Number(row.version) + 1;
    try {
      tx(() => {
        run(`INSERT INTO daily_financial_history_versions (id, business_date, version, calc_version, bs_usd, bs_slsh, cash_usd, cash_slsh, data, recorded_at, recorded_by, reason)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid("dfv"), day, version, CALC_VERSION, data.usd.balanceSheet, data.slsh.balanceSheet, data.usd.cash, data.slsh.cash, json, at, actor.name, reason]);
        // Only the row still at the version this run read is moved on.
        const r = run(`UPDATE daily_financial_history SET version = ?, status = 'updated', calc_version = ?, bs_usd = ?, bs_slsh = ?, cash_usd = ?, cash_slsh = ?, data = ?, updated_at = ?, updated_by = ?, update_reason = ?, error = NULL
                       WHERE business_date = ? AND version = ?`,
        [version, CALC_VERSION, data.usd.balanceSheet, data.slsh.balanceSheet, data.usd.cash, data.slsh.cash, json, at, actor.name, reason, day, row.version]);
        if (!r.changes) throw new Error("duplicate: updated by another run");
      });
      updated.push(day);
    } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
  }
  if (created) addAudit(actor, "Daily history saved", `${created} day(s) up to ${yesterday} (${tz})`);
  if (updated.length) addAudit(actor, "Daily history recalculated", `${updated.length} day(s) from ${updated[0]} to ${updated[updated.length - 1]} — earlier versions kept`);
  lastSig.set(key, signature(tz, today));
  return { action: "synced", created, updated };
}

// Today's (not yet ended) figures, worked out now — shown as Pending.
function todayFigures(now = new Date()) {
  const tz = S.getSettings().timezone;
  const today = S.businessDateOf(now, tz);
  return { date: today, data: computeDays(today, today, tz).get(today) };
}

module.exports = { CALC_VERSION, sync, computeDays, todayFigures, ledgerDay, MOVES };
