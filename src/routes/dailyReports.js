"use strict";
// DAILY REPORTS round — Daily Reports (Balance Sheet & Cash Account):
// stored daily snapshots, Balance Sheet history, Cash Account history,
// their PDF / Excel exports, and the snapshot schedule settings.
//
// Permissions (src/permissions.js, module "dailyReports"):
//   dailyReports.view   — every read endpoint below
//   dailyReports.export — every PDF / Excel download (printing uses the PDF)
//   dailyReports.manage — settings, manual snapshot, retry, run history
// Company isolation: every table read here is the signed-in company's own
// (per-company tables, chosen by the server from the session — never from
// a company id sent by the browser). Currency access (currency.usd /
// currency.slsh) hides the other currency's figures, as on the Balance Sheet.
const { get, all } = require("../db");
const { sendJSON, badRequest, notFound, sendPDF, sendXLSX, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, can, allowedCurrencies } = require("../rbac");
const { addAudit, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate } = require("../domain");
const { fmtMoney } = require("../util");
const { computeBalanceSheet, round2 } = require("../balance-sheet");
const S = require("../daily-snapshots");
const { renderProfessionalDocument, renderReportPDF } = require("../pdf");
const { buildProfessionalWorkbook } = require("../xlsx-engine");

const USD_FMT = '"$"#,##0.00;[Red]-"$"#,##0.00', SLSH_FMT = '#,##0" SLSH";[Red]-#,##0" SLSH"', RATE_FMT = "#,##0.####";
const MAX_RANGE_DAYS = 400;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseRange(query, tz, { defaultDays = 30, maxDays = MAX_RANGE_DAYS } = {}) {
  const today = S.businessDateOf(new Date(), tz);
  const to = query.to && S.DATE_RE.test(query.to) ? query.to : today;
  const from = query.from && S.DATE_RE.test(query.from) ? query.from : S.addDays(to, -(defaultDays - 1));
  if ((query.from && !S.DATE_RE.test(query.from)) || (query.to && !S.DATE_RE.test(query.to))) return { error: "Dates must be YYYY-MM-DD." };
  if (from > to) return { error: "The start date is after the end date." };
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > maxDays) return { error: `Choose a period of at most ${maxDays} days.` };
  return { from, to, days, today };
}
function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = S.addDays(d, 1)) out.push(d);
  return out;
}
const diff = (a, b) => (a == null || b == null ? null : round2(a - b));

// A stored snapshot as JSON, limited to the currencies the user may see.
function snapshotJSON(row, cur, companyName) {
  if (!row) return null;
  const out = {
    id: row.id, businessDate: row.business_date, source: row.source, status: row.status,
    late: !!row.is_late, timezone: row.timezone, scheduledFor: row.scheduled_for, capturedAt: row.captured_at,
    createdByName: row.created_by_name, company: companyName,
    exchangeRate: row.cash_rate, exchangeRateSetAt: row.cash_rate_set_at, dailyRate: row.daily_rate,
    combined: null,
  };
  if (cur.includes("USD")) out.usd = { debt: row.debt_usd, cash: row.cash_usd, credit: row.credit_usd, balanceSheet: row.bs_usd, debtAccounts: row.debt_accounts_usd, creditAccounts: row.credit_accounts_usd, cashAccounts: row.cash_accounts_usd };
  if (cur.includes("SLSH")) out.slsh = { debt: row.debt_slsh, cash: row.cash_slsh, credit: row.credit_slsh, balanceSheet: row.bs_slsh, debtAccounts: row.debt_accounts_slsh, creditAccounts: row.credit_accounts_slsh, cashAccounts: row.cash_accounts_slsh };
  if (cur.length === 2) {
    out.combined = row.combined_usd != null
      ? { available: true, rate: row.cash_rate, usdEquivalent: row.combined_usd, slshEquivalent: row.combined_slsh, direction: "SLSH per 1 USD" }
      : { available: false, reason: row.combined_reason || "rate_not_set" };
  }
  try {
    out.cashAccounts = JSON.parse(row.cash_breakdown || "[]").filter((a) => cur.includes(a.currency));
  } catch (e) { out.cashAccounts = []; }
  return out;
}
function changeJSON(row, prev, cur) {
  if (!prev) return null;
  const c = { previousId: prev.id, previousDate: prev.business_date };
  if (cur.includes("USD")) c.usd = { balanceSheet: diff(row.bs_usd, prev.bs_usd), debt: diff(row.debt_usd, prev.debt_usd), cash: diff(row.cash_usd, prev.cash_usd), credit: diff(row.credit_usd, prev.credit_usd) };
  if (cur.includes("SLSH")) c.slsh = { balanceSheet: diff(row.bs_slsh, prev.bs_slsh), debt: diff(row.debt_slsh, prev.debt_slsh), cash: diff(row.cash_slsh, prev.cash_slsh), credit: diff(row.credit_slsh, prev.credit_slsh) };
  return c;
}
function previousOf(row) {
  return get("SELECT * FROM daily_snapshots WHERE source = ? AND business_date < ? ORDER BY business_date DESC LIMIT 1", [row.source, row.business_date])
    || get("SELECT * FROM daily_snapshots WHERE business_date < ? ORDER BY business_date DESC, source ASC LIMIT 1", [row.business_date]) || null;
}
function needCurrencies(user, res) {
  const cur = allowedCurrencies(user);
  if (!cur.length) { sendJSON(res, 403, { error: "You don't have access to USD or SLSH figures." }); return null; }
  return cur;
}
function companyName() { const c = getCompanySettings(); return (c && c.name) || "Company"; }
function companyLabel() {
  const ctx = require("../tenant-context").currentCompany();
  return ctx ? `${companyName()} (${ctx.id})` : companyName();
}

// ---- snapshot list (Daily Snapshot tab / Financial History) ---------------
const SORTS = { date: "business_date", bsUsd: "bs_usd", bsSlsh: "bs_slsh", cashUsd: "cash_usd", cashSlsh: "cash_slsh", captured: "captured_at" };
function listSnapshots(query, cur, tz) {
  // Snapshots are one or two rows a day, so any period may be listed.
  const range = parseRange(query, tz, { defaultDays: 365, maxDays: 20000 });
  if (range.error) return range;
  const where = ["business_date >= ?", "business_date <= ?"], p = [range.from, range.to];
  if (query.source === "automatic" || query.source === "manual") { where.push("source = ?"); p.push(query.source); }
  if (query.status === "late") where.push("is_late = 1");
  else if (query.status === "on_time") where.push("is_late = 0");
  const rows = all(`SELECT * FROM daily_snapshots WHERE ${where.join(" AND ")} ORDER BY business_date ASC, source ASC`, p);
  // Daily change = against the previous stored snapshot of the same source.
  const firstPrev = {};
  const name = companyName();
  const items = rows.map((r) => {
    if (!(r.source in firstPrev)) firstPrev[r.source] = previousOf(r);
    const prev = firstPrev[r.source];
    firstPrev[r.source] = r;
    const prevSame = prev && prev.source === r.source ? prev : prev;
    return { ...snapshotJSON(r, cur, name), change: changeJSON(r, prevSame, cur) };
  });
  let filtered = items;
  const q = String(query.search || "").trim().toLowerCase();
  if (q) filtered = items.filter((s) => [s.businessDate, s.source, s.createdByName, s.id, s.late ? "late" : "saved"].some((v) => String(v || "").toLowerCase().includes(q)));
  const sortKey = SORTS[query.sort] ? query.sort : "date";
  const dir = query.dir === "asc" ? 1 : -1;
  const val = (s) => ({ date: s.businessDate + s.source, bsUsd: s.usd?.balanceSheet, bsSlsh: s.slsh?.balanceSheet, cashUsd: s.usd?.cash, cashSlsh: s.slsh?.cash, captured: s.capturedAt })[sortKey];
  filtered.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  const total = filtered.length;
  const page = Math.min(Math.max(1, Number(query.page) || 1), Math.max(1, Math.ceil(total / pageSize)));
  return { ...range, total, page, pageSize, items: filtered, pageItems: filtered.slice((page - 1) * pageSize, page * pageSize) };
}

// ---- Balance Sheet history: one line per day, gaps shown as gaps ----------
function balanceHistory(query, cur, tz) {
  const range = parseRange(query, tz, { defaultDays: 30 });
  if (range.error) return range;
  const snaps = all("SELECT * FROM daily_snapshots WHERE business_date >= ? AND business_date <= ? ORDER BY business_date ASC, source ASC", [range.from, range.to]);
  const byDate = new Map();
  for (const s of snaps) {
    // The automatic (end-of-day) snapshot represents the day; a manual one
    // only when no automatic snapshot exists for it.
    const cur0 = byDate.get(s.business_date);
    if (!cur0 || (cur0.source === "manual" && s.source === "automatic")) byDate.set(s.business_date, s);
  }
  const runs = all("SELECT business_date, status FROM daily_snapshot_runs WHERE business_date >= ? AND business_date <= ? AND source = 'automatic' AND status IN ('failed','missed')", [range.from, range.to]);
  const runStatus = new Map(runs.map((r) => [r.business_date, r.status]));
  const name = companyName();
  let prev = null;
  const firstInRange = snaps.length ? snaps[0] : null;
  if (firstInRange) {
    const before = get("SELECT * FROM daily_snapshots WHERE business_date < ? ORDER BY business_date DESC, source ASC LIMIT 1", [range.from]);
    prev = before || null;
  }
  const days = datesBetween(range.from, range.to).map((d) => {
    const s = byDate.get(d);
    if (!s) return { businessDate: d, available: false, reason: runStatus.get(d) || (d > range.today ? "future" : d === range.today ? "pending" : "no_snapshot") };
    const out = { businessDate: d, available: true, snapshot: snapshotJSON(s, cur, name), change: changeJSON(s, prev, cur) };
    prev = s;
    return out;
  });
  const avail = days.filter((d) => d.available);
  // Month by month: the last snapshot of each month, against the month before.
  const months = [];
  let prevMonth = null;
  for (const d of avail) {
    const m = d.businessDate.slice(0, 7);
    if (months.length && months[months.length - 1].month === m) months[months.length - 1].last = d.snapshot;
    else months.push({ month: m, last: d.snapshot });
  }
  for (const m of months) {
    m.change = prevMonth ? {
      usd: m.last.usd && prevMonth.usd ? diff(m.last.usd.balanceSheet, prevMonth.usd.balanceSheet) : null,
      slsh: m.last.slsh && prevMonth.slsh ? diff(m.last.slsh.balanceSheet, prevMonth.slsh.balanceSheet) : null,
    } : null;
    prevMonth = m.last;
  }
  const first = avail[0] ? avail[0].snapshot : null, last = avail.length ? avail[avail.length - 1].snapshot : null;
  const period = first && last ? {
    from: first.businessDate, to: last.businessDate,
    usd: first.usd ? { start: first.usd.balanceSheet, end: last.usd.balanceSheet, change: diff(last.usd.balanceSheet, first.usd.balanceSheet) } : undefined,
    slsh: first.slsh ? { start: first.slsh.balanceSheet, end: last.slsh.balanceSheet, change: diff(last.slsh.balanceSheet, first.slsh.balanceSheet) } : undefined,
  } : null;
  return { ...range, days, months, period, available: avail.length, missing: days.filter((d) => !d.available && d.reason !== "future").length };
}

// ---- Cash Account history (from cash_ledger, the source of every balance) --
function ledgerDay(dateStr, tz) {
  const s = String(dateStr || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s.slice(0, 10) : S.businessDateOf(new Date(t), tz);
}
function moveKind(e) {
  if (e.source_type === "cash_transfer") return e.type === "deposit" ? "transferIn" : "transferOut";
  if (e.source_type === "cash_exchange" || e.source_type === "exchange") return e.type === "deposit" ? "exchangeIn" : "exchangeOut";
  return e.type === "deposit" ? "cashIn" : "cashOut";
}
const MOVE_TYPES = ["cashIn", "cashOut", "transferIn", "transferOut", "exchangeIn", "exchangeOut"];
function cashHistory(query, cur, tz) {
  const range = parseRange(query, tz, { defaultDays: 30 });
  if (range.error) return range;
  const where = [], p = [];
  const currencies = query.currency === "USD" || query.currency === "SLSH" ? [query.currency].filter((c) => cur.includes(c)) : cur;
  if (!currencies.length) return { error: "You don't have access to that currency." };
  where.push(`currency IN (${currencies.map(() => "?").join(",")})`); p.push(...currencies);
  if (query.accountId) { where.push("id = ?"); p.push(String(query.accountId)); }
  const accounts = all(`SELECT id, name, type, currency, status, balance FROM cash_accounts WHERE ${where.join(" AND ")} ORDER BY currency, name`, p);
  const typeFilter = MOVE_TYPES.includes(query.type) ? query.type : null;
  const summaries = [], daily = [];
  for (const a of accounts) {
    const entries = all("SELECT id, type, amount, date, created_at, source_type, balance_after FROM cash_ledger WHERE cash_account_id = ?", [a.id]);
    let opening = 0, ledgerTotal = 0;
    const t = Object.fromEntries(MOVE_TYPES.map((k) => [k, 0]));
    const byDay = new Map();
    for (const e of entries) {
      const signed = e.type === "deposit" ? e.amount : -e.amount;
      ledgerTotal += signed;
      const day = ledgerDay(e.date, tz);
      if (day < range.from) { opening += signed; continue; }
      if (day > range.to) continue;
      const k = moveKind(e);
      t[k] += e.amount;
      if (!byDay.has(day)) byDay.set(day, Object.fromEntries(MOVE_TYPES.map((x) => [x, 0])));
      byDay.get(day)[k] += e.amount;
    }
    const totalIn = t.cashIn + t.transferIn + t.exchangeIn, totalOut = t.cashOut + t.transferOut + t.exchangeOut;
    const closing = opening + totalIn - totalOut;
    // Reconciliation: the ledger replay must equal the balance the system
    // keeps on the account (only comparable when the period runs to today).
    const reconcilable = range.to >= range.today;
    const difference = reconcilable ? round2(a.balance - ledgerTotal) : null;
    summaries.push({
      accountId: a.id, account: a.name, type: a.type, currency: a.currency, status: a.status,
      openingBalance: round2(opening), ...Object.fromEntries(MOVE_TYPES.map((k) => [k, round2(t[k])])),
      totalIn: round2(totalIn), totalOut: round2(totalOut), closingBalance: round2(closing),
      currentBalance: round2(a.balance),
      reconciliation: reconcilable ? { checked: true, difference, ok: Math.abs(difference) < 0.005, ledgerBalance: round2(ledgerTotal), storedBalance: round2(a.balance) } : { checked: false },
    });
    let run = opening;
    for (const d of [...byDay.keys()].sort()) {
      const m = byDay.get(d);
      const inn = m.cashIn + m.transferIn + m.exchangeIn, out = m.cashOut + m.transferOut + m.exchangeOut;
      const row = { date: d, accountId: a.id, account: a.name, currency: a.currency, openingBalance: round2(run), ...Object.fromEntries(MOVE_TYPES.map((k) => [k, round2(m[k])])), cashInTotal: round2(inn), cashOutTotal: round2(out) };
      run += inn - out;
      row.closingBalance = round2(run);
      if (!typeFilter || m[typeFilter] > 0) daily.push(row);
    }
  }
  const totals = {};
  for (const c of currencies) {
    const ss = summaries.filter((s) => s.currency === c);
    totals[c] = { accounts: ss.length, openingBalance: round2(ss.reduce((x, s) => x + s.openingBalance, 0)), closingBalance: round2(ss.reduce((x, s) => x + s.closingBalance, 0)),
      ...Object.fromEntries(MOVE_TYPES.map((k) => [k, round2(ss.reduce((x, s) => x + s[k], 0))])) };
  }
  const dir = query.dir === "asc" ? 1 : -1;
  daily.sort((x, y) => (x.date === y.date ? x.account.localeCompare(y.account) : (x.date > y.date ? 1 : -1) * dir));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.min(Math.max(1, Number(query.page) || 1), Math.max(1, Math.ceil(daily.length / pageSize)));
  return {
    ...range, currencies, summaries, totals, daily, total: daily.length, page, pageSize,
    pageItems: daily.slice((page - 1) * pageSize, page * pageSize),
    discrepancies: summaries.filter((s) => s.reconciliation.checked && !s.reconciliation.ok).length,
  };
}

function statusJSON(user) {
  const settings = S.getSettings();
  const now = new Date();
  const { today, dueToday, next } = S.scheduleInfo(settings, now);
  const todaySnap = S.findSnapshot(today, "automatic");
  const lastSuccess = get("SELECT * FROM daily_snapshots ORDER BY captured_at DESC LIMIT 1");
  const lastFailed = get("SELECT * FROM daily_snapshot_runs WHERE status IN ('failed','missed') ORDER BY started_at DESC LIMIT 1");
  const todayFailed = get("SELECT error FROM daily_snapshot_runs WHERE business_date = ? AND source = 'automatic' AND status = 'failed' ORDER BY started_at DESC LIMIT 1", [today]);
  let state;
  if (todaySnap) state = todaySnap.is_late ? "saved_late" : "saved";
  else if (!settings.enabled) state = "disabled";
  else if (now < dueToday) state = "pending";
  else if (todayFailed) state = "failed";
  else state = "delayed";
  const out = {
    state, enabled: settings.enabled, timezone: settings.timezone, runTime: settings.runTime, today,
    nextRunAt: settings.enabled ? next.toISOString() : null,
    lastSuccess: lastSuccess ? { id: lastSuccess.id, businessDate: lastSuccess.business_date, capturedAt: lastSuccess.captured_at, source: lastSuccess.source } : null,
    lastFailure: lastFailed ? { id: lastFailed.id, businessDate: lastFailed.business_date, status: lastFailed.status, at: lastFailed.finished_at || lastFailed.started_at } : null,
    company: companyName(),
    canManage: can(user, "dailyReports.manage"), canExport: can(user, "dailyReports.export"),
  };
  if (out.canManage && todayFailed) out.todayError = todayFailed.error;
  return out;
}

// ---- PDF / Excel builders -------------------------------------------------
const money = (v, c) => (v == null ? "—" : fmtMoney(v, c));
const signed = (v, c) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmtMoney(v, c)}`);
const statusText = (s) => `${s.source === "automatic" ? "Automatic" : "Manual"}${s.late ? " · Late" : ""}`;
const capturedText = (s) => `${s.capturedAt.replace("T", " ").slice(0, 19)} UTC`;

function snapshotTableSpec(items, cur) {
  const cols = [{ key: "date", label: "Snapshot Date", pl: "Date", w: 0.95, xw: 13 }];
  if (cur.includes("USD")) cols.push({ key: "bsUsd", label: "Balance Sheet (USD)", pl: "Bal. Sheet USD", w: 1.15, xw: 18, align: "right", fmt: USD_FMT, c: "USD" });
  if (cur.includes("SLSH")) cols.push({ key: "bsSlsh", label: "Balance Sheet (SLSH)", pl: "Bal. Sheet SLSH", w: 1.3, xw: 20, align: "right", fmt: SLSH_FMT, c: "SLSH" });
  if (cur.includes("USD")) cols.push({ key: "cashUsd", label: "Cash Account (USD)", pl: "Cash USD", w: 1.1, xw: 18, align: "right", fmt: USD_FMT, c: "USD" });
  if (cur.includes("SLSH")) cols.push({ key: "cashSlsh", label: "Cash Account (SLSH)", pl: "Cash SLSH", w: 1.25, xw: 20, align: "right", fmt: SLSH_FMT, c: "SLSH" });
  cols.push({ key: "rate", label: "Exchange Rate", pl: "Rate", w: 0.7, xw: 13, align: "right", fmt: RATE_FMT });
  if (cur.includes("USD")) cols.push({ key: "chgUsd", label: "Daily Change (USD)", pl: "Change USD", w: 1.05, xw: 17, align: "right", fmt: USD_FMT, c: "USD", signed: true });
  if (cur.includes("SLSH")) cols.push({ key: "chgSlsh", label: "Daily Change (SLSH)", pl: "Change SLSH", w: 1.2, xw: 19, align: "right", fmt: SLSH_FMT, c: "SLSH", signed: true });
  cols.push({ key: "status", label: "Status", pl: "Status", w: 1.3, xw: 22 });
  const val = (s, key) => ({
    date: s.businessDate, bsUsd: s.usd?.balanceSheet, bsSlsh: s.slsh?.balanceSheet, cashUsd: s.usd?.cash, cashSlsh: s.slsh?.cash,
    rate: s.exchangeRate, chgUsd: s.change?.usd?.balanceSheet ?? null, chgSlsh: s.change?.slsh?.balanceSheet ?? null, status: statusText(s),
  })[key];
  return { cols, val, items };
}
// A wide financial table (more than 6 columns) is printed landscape; every
// other setting of the company's Reports template is kept.
function wideTemplate(t, columns) {
  if (columns <= 6) return t;
  return { ...(t || {}), orientation: "landscape" };
}
async function specPDF({ title, meta, spec, generatedBy }) {
  const rows = spec.items.map((s) => spec.cols.map((c) => {
    const v = spec.val(s, c.key);
    if (c.c) return c.signed ? signed(v, c.c) : money(v, c.c);
    if (c.key === "rate") return v == null ? "Not set" : Number(v).toLocaleString("en-US");
    return v == null ? "—" : String(v);
  }));
  return renderReportPDF({ company: getCompanySettings(), title, meta, generatedBy, template: wideTemplate(getDefaultPdfTemplate("reports"), spec.cols.length),
    columns: spec.cols.map((c) => ({ label: c.pl || c.label, width: c.w, align: c.align })), rows: rows.length ? rows : [spec.cols.map((c, i) => (i === 0 ? "No snapshots in this period" : ""))] });
}
async function specXLSX({ title, sheetName, subtitle, spec, generatedBy, infoRows = [], totalsBox }) {
  return buildProfessionalWorkbook({
    company: getCompanySettings(), template: getDefaultExcelTemplate("reports"), generatedBy, sheetName, docTypeLabel: title.toUpperCase(),
    subtitleLines: [subtitle], infoRows, totalsBox,
    table: { columns: spec.cols.map((c) => ({ key: c.key, label: c.label, width: c.xw, align: c.align, numFmt: c.fmt })), rows: spec.items, cellValue: (s, key) => { const v = spec.val(s, key); return v === undefined ? null : v; } },
  });
}

async function snapshotDetailPDF(snap, change, cur, user) {
  const info = [
    ["Company", companyLabel()], ["Business date", snap.businessDate], ["Captured at", capturedText(snap)],
    ["Time zone", snap.timezone], ["Source", statusText(snap)], ["Exchange rate (Cash Account)", snap.exchangeRate ? `${Number(snap.exchangeRate).toLocaleString("en-US")} SLSH per 1 USD` : "Not set — combined total unavailable"],
  ];
  if (snap.scheduledFor) info.push(["Scheduled for", `${snap.scheduledFor.replace("T", " ").slice(0, 16)} UTC`]);
  if (snap.combined && snap.combined.available) {
    info.push(["Net Balance Sheet (USD equivalent)", money(snap.combined.usdEquivalent, "USD")]);
    info.push(["Net Balance Sheet (SLSH equivalent)", money(snap.combined.slshEquivalent, "SLSH")]);
  }
  const rows = [];
  for (const [c, k] of [["USD", "usd"], ["SLSH", "slsh"]]) {
    if (!snap[k]) continue;
    const ch = change && change[k];
    rows.push({ item: `Debt (${c})`, value: money(snap[k].debt, c), change: ch ? signed(ch.debt, c) : "—", note: `${snap[k].debtAccounts} account(s) in debt` });
    rows.push({ item: `Cash Account (${c})`, value: money(snap[k].cash, c), change: ch ? signed(ch.cash, c) : "—", note: `${snap[k].cashAccounts} active cash account(s)` });
    rows.push({ item: `Credit (${c})`, value: money(snap[k].credit, c), change: ch ? signed(ch.credit, c) : "—", note: `${snap[k].creditAccounts} account(s) in credit` });
    rows.push({ item: `Balance Sheet (${c})`, value: money(snap[k].balanceSheet, c), change: ch ? signed(ch.balanceSheet, c) : "—", note: "Debt + Cash Account - Credit" });
  }
  for (const a of snap.cashAccounts || []) rows.push({ item: `Cash account: ${a.name}`, value: money(a.balance, a.currency), change: "", note: `${a.type} · ${a.currency}` });
  return renderProfessionalDocument({
    company: getCompanySettings(), template: getDefaultPdfTemplate("reports"), generatedBy: user.name,
    docTypeLabel: "DAILY FINANCIAL SNAPSHOT", docNumber: snap.businessDate, statusLabel: snap.late ? "LATE" : "SAVED", statusTone: snap.late ? "amber" : "green",
    subtitleLines: [`Position stored at ${capturedText(snap)} — historical figures, not today's live balances.`, change ? `Compared with the snapshot of ${change.previousDate}.` : "No earlier snapshot to compare with."],
    infoRows: info,
    table: {
      columns: [{ key: "item", label: "Item", width: 1.8 }, { key: "value", label: "Amount", width: 1.2, align: "right" }, { key: "change", label: "Change", width: 1.1, align: "right" }, { key: "note", label: "Details", width: 1.7 }],
      rows, cellText: (r, key) => String(r[key] ?? ""),
    },
  });
}

// ---------------------------------------------------------------------------
function register(router) {
  const viewer = (req, res) => {
    const user = requireAuth(req, res); if (!user) return null;
    if (!requirePerm(user, res, "dailyReports.view")) return null;
    const cur = needCurrencies(user, res); if (!cur) return null;
    return { user, cur, tz: S.getSettings().timezone };
  };
  const exporter = (req, res) => {
    const v = viewer(req, res); if (!v) return null;
    if (!requirePerm(v.user, res, "dailyReports.export")) return null;
    return v;
  };
  const manager = (req, res) => {
    const user = requireAuth(req, res); if (!user) return null;
    if (!requirePerm(user, res, "dailyReports.manage")) return null;
    return user;
  };
  const fail = (res, e) => sendJSON(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });

  router.get("/api/daily-reports/status", (req, res) => {
    const v = viewer(req, res); if (!v) return;
    sendJSON(res, 200, statusJSON(v.user));
  });

  // The live position, clearly marked live — never presented as history.
  router.get("/api/daily-reports/live", (req, res) => {
    const v = viewer(req, res); if (!v) return;
    sendJSON(res, 200, { live: true, at: new Date().toISOString(), ...computeBalanceSheet(v.cur) });
  });

  router.get("/api/daily-reports/snapshots", (req, res, params, query) => {
    const v = viewer(req, res); if (!v) return;
    const r = listSnapshots(query || {}, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    sendJSON(res, 200, { from: r.from, to: r.to, total: r.total, page: r.page, pageSize: r.pageSize, snapshots: r.pageItems, currencies: v.cur });
  });

  router.get("/api/daily-reports/balance-history", (req, res, params, query) => {
    const v = viewer(req, res); if (!v) return;
    const r = balanceHistory(query || {}, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    sendJSON(res, 200, { ...r, currencies: v.cur });
  });

  router.get("/api/daily-reports/cash-accounts", (req, res) => {
    const v = viewer(req, res); if (!v) return;
    const rows = all(`SELECT id, name, type, currency, status FROM cash_accounts WHERE currency IN (${v.cur.map(() => "?").join(",")}) ORDER BY currency, name`, v.cur);
    sendJSON(res, 200, { accounts: rows });
  });

  router.get("/api/daily-reports/cash-history", (req, res, params, query) => {
    const v = viewer(req, res); if (!v) return;
    const r = cashHistory(query || {}, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    const { daily, ...rest } = r;
    sendJSON(res, 200, { ...rest, rows: r.pageItems, pageItems: undefined });
  });

  // ---- exports ----
  for (const fmt of ["pdf", "xlsx"]) router.get(`/api/daily-reports/snapshots/export.${fmt}`, async (req, res, p0, query) => {
    const params = { ...p0, fmt };
    const v = exporter(req, res); if (!v) return;
    if (!["pdf", "xlsx"].includes(params.fmt)) return notFound(res, "Unknown format.");
    const r = listSnapshots({ ...(query || {}), page: 1, pageSize: 200 }, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    const spec = snapshotTableSpec(r.items, v.cur);
    const meta = `${companyLabel()} · Period: ${r.from} to ${r.to} · ${r.total} snapshot(s)${query && query.source ? ` · ${query.source}` : ""}`;
    if (params.fmt === "pdf") {
      const pdf = await specPDF({ title: "Daily Financial Snapshots", meta, spec, generatedBy: v.user.name });
      addAudit(v.user, "Daily report exported (PDF)", `Snapshots ${r.from} – ${r.to}`);
      return sendPDF(res, `daily-snapshots-${r.from}-to-${r.to}.pdf`, pdf);
    }
    const xlsx = await specXLSX({ title: "Daily Financial Snapshots", sheetName: "Snapshots", subtitle: meta, spec, generatedBy: v.user.name });
    addAudit(v.user, "Daily report exported (Excel)", `Snapshots ${r.from} – ${r.to}`);
    sendXLSX(res, `daily-snapshots-${r.from}-to-${r.to}.xlsx`, xlsx);
  });

  for (const fmt of ["pdf", "xlsx"]) router.get(`/api/daily-reports/snapshots/:id/report.${fmt}`, async (req, res, p0) => {
    const params = { ...p0, fmt };
    const v = exporter(req, res); if (!v) return;
    if (!["pdf", "xlsx"].includes(params.fmt)) return notFound(res, "Unknown format.");
    const row = get("SELECT * FROM daily_snapshots WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Snapshot not found.");
    const snap = snapshotJSON(row, v.cur, companyName());
    const change = changeJSON(row, previousOf(row), v.cur);
    if (params.fmt === "pdf") {
      const pdf = await snapshotDetailPDF(snap, change, v.cur, v.user);
      addAudit(v.user, "Daily report exported (PDF)", `Snapshot ${row.business_date} · ${row.id}`);
      return sendPDF(res, `daily-snapshot-${row.business_date}-${row.source}.pdf`, pdf);
    }
    const items = [];
    for (const [c, k] of [["USD", "usd"], ["SLSH", "slsh"]]) {
      if (!snap[k]) continue;
      const ch = change && change[k];
      for (const [label, f] of [["Debt", "debt"], ["Cash Account", "cash"], ["Credit", "credit"], ["Balance Sheet", "balanceSheet"]]) {
        items.push({ item: `${label} (${c})`, currency: c, usd: c === "USD" ? snap[k][f] : null, slsh: c === "SLSH" ? snap[k][f] : null, chgUsd: c === "USD" && ch ? ch[f] : null, chgSlsh: c === "SLSH" && ch ? ch[f] : null });
      }
    }
    for (const a of snap.cashAccounts) items.push({ item: `Cash account: ${a.name}`, currency: a.currency, usd: a.currency === "USD" ? a.balance : null, slsh: a.currency === "SLSH" ? a.balance : null, chgUsd: null, chgSlsh: null });
    const xlsx = await buildProfessionalWorkbook({
      company: getCompanySettings(), template: getDefaultExcelTemplate("reports"), generatedBy: v.user.name, sheetName: "Snapshot",
      docTypeLabel: "DAILY FINANCIAL SNAPSHOT", docNumber: snap.businessDate, statusLabel: snap.late ? "LATE" : "SAVED",
      subtitleLines: [`${companyLabel()} · Position stored at ${capturedText(snap)} (historical, not live)`],
      infoRows: [
        { label: "Business date", value: snap.businessDate }, { label: "Captured at (UTC)", value: snap.capturedAt }, { label: "Time zone", value: snap.timezone },
        { label: "Source", value: statusText(snap) }, { label: "Exchange rate (SLSH per 1 USD)", value: snap.exchangeRate ?? "Not set" },
        ...(snap.combined && snap.combined.available ? [{ label: "Net Balance Sheet — USD equivalent", value: snap.combined.usdEquivalent }, { label: "Net Balance Sheet — SLSH equivalent", value: snap.combined.slshEquivalent }] : []),
        { label: "Compared with", value: change ? change.previousDate : "—" },
      ],
      table: {
        columns: [{ key: "item", label: "Item", width: 30 }, { key: "currency", label: "Currency", width: 10 },
          { key: "usd", label: "Amount (USD)", width: 18, align: "right", numFmt: USD_FMT }, { key: "slsh", label: "Amount (SLSH)", width: 20, align: "right", numFmt: SLSH_FMT },
          { key: "chgUsd", label: "Change (USD)", width: 16, align: "right", numFmt: USD_FMT }, { key: "chgSlsh", label: "Change (SLSH)", width: 18, align: "right", numFmt: SLSH_FMT }],
        rows: items, cellValue: (r2, key) => r2[key],
      },
    });
    addAudit(v.user, "Daily report exported (Excel)", `Snapshot ${row.business_date} · ${row.id}`);
    sendXLSX(res, `daily-snapshot-${row.business_date}-${row.source}.xlsx`, xlsx);
  });

  for (const fmt of ["pdf", "xlsx"]) router.get(`/api/daily-reports/balance-history/export.${fmt}`, async (req, res, p0, query) => {
    const params = { ...p0, fmt };
    const v = exporter(req, res); if (!v) return;
    if (!["pdf", "xlsx"].includes(params.fmt)) return notFound(res, "Unknown format.");
    const r = balanceHistory(query || {}, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    const items = r.days.filter((d) => d.reason !== "future").map((d) => (d.available ? { ...d.snapshot, change: d.change } : { businessDate: d.businessDate, missing: d.reason }));
    const spec = snapshotTableSpec(items, v.cur);
    const baseVal = spec.val;
    spec.val = (s, key) => (s.missing ? (key === "date" ? s.businessDate : key === "status" ? `No snapshot${s.missing === "missed" ? " (missed)" : s.missing === "failed" ? " (failed)" : s.missing === "pending" ? " yet (pending)" : ""}` : null) : baseVal(s, key));
    const meta = `${companyLabel()} · Period: ${r.from} to ${r.to} · ${r.available} day(s) with a snapshot, ${r.missing} without`;
    const box = [];
    if (r.period && r.period.usd) box.push({ label: `Balance Sheet change (USD) ${r.period.from} → ${r.period.to}`, value: r.period.usd.change, numFmt: USD_FMT });
    if (r.period && r.period.slsh) box.push({ label: `Balance Sheet change (SLSH) ${r.period.from} → ${r.period.to}`, value: r.period.slsh.change, numFmt: SLSH_FMT });
    if (params.fmt === "pdf") {
      const pdf = await specPDF({ title: "Balance Sheet History", meta: `${meta}${r.period && r.period.usd ? ` · USD change ${signed(r.period.usd.change, "USD")}` : ""}${r.period && r.period.slsh ? ` · SLSH change ${signed(r.period.slsh.change, "SLSH")}` : ""}`, spec, generatedBy: v.user.name });
      addAudit(v.user, "Daily report exported (PDF)", `Balance Sheet history ${r.from} – ${r.to}`);
      return sendPDF(res, `balance-sheet-history-${r.from}-to-${r.to}.pdf`, pdf);
    }
    const xlsx = await specXLSX({ title: "Balance Sheet History", sheetName: "Balance Sheet History", subtitle: meta, spec, generatedBy: v.user.name, totalsBox: box.length ? box : undefined });
    addAudit(v.user, "Daily report exported (Excel)", `Balance Sheet history ${r.from} – ${r.to}`);
    sendXLSX(res, `balance-sheet-history-${r.from}-to-${r.to}.xlsx`, xlsx);
  });

  for (const fmt of ["pdf", "xlsx"]) router.get(`/api/daily-reports/cash-history/export.${fmt}`, async (req, res, p0, query) => {
    const params = { ...p0, fmt };
    const v = exporter(req, res); if (!v) return;
    if (!["pdf", "xlsx"].includes(params.fmt)) return notFound(res, "Unknown format.");
    const r = cashHistory({ ...(query || {}), page: 1, pageSize: 200 }, v.cur, v.tz);
    if (r.error) return badRequest(res, r.error);
    const meta = `${companyLabel()} · Period: ${r.from} to ${r.to} · ${r.summaries.length} cash account(s)${r.discrepancies ? ` · ${r.discrepancies} reconciliation difference(s)` : ""}`;
    const cols = [
      { key: "date", label: "Date", w: 0.9, xw: 12 }, { key: "account", label: "Account", w: 1.5, xw: 24 }, { key: "currency", label: "Currency", w: 0.6, xw: 9 },
      { key: "openingBalance", label: "Opening Balance", w: 1.1, xw: 17, align: "right", money: true }, { key: "cashInTotal", label: "Cash In", w: 1, xw: 16, align: "right", money: true },
      { key: "cashOutTotal", label: "Cash Out", w: 1, xw: 16, align: "right", money: true }, { key: "closingBalance", label: "Closing Balance", w: 1.1, xw: 17, align: "right", money: true },
    ];
    if (params.fmt === "pdf") {
      const rows = [...r.summaries.map((s) => [`${r.from} to ${r.to}`, `${s.account} (period total)`, s.currency, money(s.openingBalance, s.currency), money(s.totalIn, s.currency), money(s.totalOut, s.currency), money(s.closingBalance, s.currency)]),
        ...r.daily.map((d) => cols.map((c) => (c.money ? money(d[c.key], d.currency) : String(d[c.key]))))];
      const pdf = await renderReportPDF({ company: getCompanySettings(), title: "Cash Account History", meta, generatedBy: v.user.name, template: wideTemplate(getDefaultPdfTemplate("reports"), cols.length),
        columns: cols.map((c) => ({ label: c.label, width: c.w, align: c.align })), rows: rows.length ? rows : [["No cash movements in this period", "", "", "", "", "", ""]] });
      addAudit(v.user, "Daily report exported (PDF)", `Cash Account history ${r.from} – ${r.to}`);
      return sendPDF(res, `cash-account-history-${r.from}-to-${r.to}.pdf`, pdf);
    }
    // Excel: separate USD and SLSH amount columns, never one mixed column.
    const xcols = [{ key: "date", label: "Date", width: 12 }, { key: "account", label: "Account", width: 26 }, { key: "currency", label: "Currency", width: 9 }];
    for (const [c, fmt] of [["USD", USD_FMT], ["SLSH", SLSH_FMT]]) {
      if (!r.currencies.includes(c)) continue;
      for (const [k, l] of [["openingBalance", "Opening"], ["cashInTotal", "Cash In"], ["cashOutTotal", "Cash Out"], ["closingBalance", "Closing"]]) xcols.push({ key: `${k}_${c}`, label: `${l} (${c})`, width: 17, align: "right", numFmt: fmt });
    }
    const xlsx = await buildProfessionalWorkbook({
      company: getCompanySettings(), template: getDefaultExcelTemplate("reports"), generatedBy: v.user.name, sheetName: "Cash Account History",
      docTypeLabel: "CASH ACCOUNT HISTORY", subtitleLines: [meta],
      infoRows: r.summaries.map((s) => ({ label: `${s.account} (${s.currency})`, value: `Opening ${money(s.openingBalance, s.currency)} · In ${money(s.totalIn, s.currency)} · Out ${money(s.totalOut, s.currency)} · Closing ${money(s.closingBalance, s.currency)}${s.reconciliation.checked && !s.reconciliation.ok ? ` · RECONCILIATION DIFFERENCE ${money(s.reconciliation.difference, s.currency)}` : ""}` })),
      table: { columns: xcols, rows: r.daily, cellValue: (d, key) => { const m = /^(\w+)_(USD|SLSH)$/.exec(key); if (m) return d.currency === m[2] ? d[m[1]] : null; return d[key]; } },
    });
    addAudit(v.user, "Daily report exported (Excel)", `Cash Account history ${r.from} – ${r.to}`);
    sendXLSX(res, `cash-account-history-${r.from}-to-${r.to}.xlsx`, xlsx);
  });

  router.get("/api/daily-reports/snapshots/:id", (req, res, params) => {
    const v = viewer(req, res); if (!v) return;
    const row = get("SELECT * FROM daily_snapshots WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Snapshot not found.");
    const prev = previousOf(row);
    const out = { snapshot: snapshotJSON(row, v.cur, companyName()), change: changeJSON(row, prev, v.cur), currencies: v.cur };
    if (can(v.user, "dailyReports.manage") || can(v.user, "auditLog.view")) {
      out.runs = all("SELECT id, source, trigger_type, status, started_at, finished_at, snapshot_id, error, actor_name, attempt FROM daily_snapshot_runs WHERE business_date = ? ORDER BY started_at ASC", [row.business_date]);
      out.audit = all("SELECT at, actor_name, action, details FROM audit_log WHERE action LIKE '%snapshot%' AND (details LIKE ? OR details LIKE ?) ORDER BY at ASC LIMIT 100", [`%${row.id}%`, `${row.business_date}%`]);
    }
    sendJSON(res, 200, out);
  });

  // ---- administration ----
  router.get("/api/daily-reports/settings", (req, res) => {
    const user = manager(req, res); if (!user) return;
    const s = S.getSettings();
    sendJSON(res, 200, { settings: { enabled: s.enabled, runTime: s.runTime, timezone: s.timezone, updatedAt: s.updatedAt, updatedBy: s.updatedBy }, status: statusJSON(user) });
  });
  router.patch("/api/daily-reports/settings", async (req, res) => {
    const user = manager(req, res); if (!user) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest(res, "Settings must be a JSON object.");
    const v = S.validateSettings(body);
    if (v.error) return badRequest(res, v.error);
    const s = S.updateSettings(v.value, user);
    sendJSON(res, 200, { settings: { enabled: s.enabled, runTime: s.runTime, timezone: s.timezone, updatedAt: s.updatedAt, updatedBy: s.updatedBy }, status: statusJSON(user) });
  });
  router.get("/api/daily-reports/runs", (req, res, params, query) => {
    const user = manager(req, res); if (!user) return;
    const limit = Math.min(200, Math.max(1, Number(query && query.limit) || 50));
    sendJSON(res, 200, { runs: all("SELECT id, business_date, source, trigger_type, status, started_at, finished_at, snapshot_id, error, actor_name, attempt FROM daily_snapshot_runs ORDER BY started_at DESC LIMIT ?", [limit]) });
  });
  // Manual snapshot: today's position, stored as a MANUAL snapshot (one per
  // business day) — it never replaces or blocks the automatic one.
  router.post("/api/daily-reports/snapshots/run", async (req, res) => {
    const user = manager(req, res); if (!user) return;
    let body = {}; try { body = (await readJSONBody(req)) || {}; } catch (e) { return badRequest(res, e.message); }
    if (body.confirm !== true) return badRequest(res, "Confirm the manual snapshot (confirm: true).");
    try {
      const r = S.capture({ source: "manual", trigger: "manual", actor: user });
      if (!r.created) return sendJSON(res, 409, { error: `A manual snapshot for ${r.snapshot.business_date} already exists — it was taken at ${r.snapshot.captured_at}.`, snapshot: snapshotJSON(r.snapshot, allowedCurrencies(user), companyName()) });
      sendJSON(res, 201, { snapshot: snapshotJSON(r.snapshot, allowedCurrencies(user), companyName()) });
    } catch (e) { fail(res, e); }
  });
  router.post("/api/daily-reports/runs/:id/retry", (req, res, params) => {
    const user = manager(req, res); if (!user) return;
    const row = get("SELECT * FROM daily_snapshot_runs WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Run not found.");
    try {
      const r = S.retry(row, user);
      sendJSON(res, r.created ? 201 : 200, { snapshot: snapshotJSON(r.snapshot, allowedCurrencies(user), companyName()), created: r.created });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, listSnapshots, balanceHistory, cashHistory };
