"use strict";
// ENTERPRISE FINANCIAL MANAGEMENT DASHBOARD round.
//
// A single, real-data, currency-safe aggregation endpoint (GET /api/dashboard)
// backing the rebuilt Dashboard, plus its layout-persistence and export
// endpoints. Every number here is computed from the same tables every other
// module already writes to (account_ledger, exchange_transactions, transfers,
// quotations, clients) — nothing is hard-coded or randomly generated, and an
// empty period returns real empty arrays/zeros, never fabricated data (see
// the frontend's "No data available for this period" empty states).
//
// CURRENCY SAFETY (spec section 38): every amount-bearing field in this
// response is either a plain count, or an object shaped {usd, slsh} — USD
// and SLSH are NEVER added together into one combined total anywhere below.
//
// PERMISSIONS (spec sections 45-49): this route only requires requireAuth —
// like the pre-existing Dashboard, every authenticated user gets SOME
// dashboard. Which sections actually appear in the JSON is decided here,
// server-side, from the user's real grants (can(user, ...)) — never left to
// the frontend to hide on its own. A Super Admin (ALL_ACCESS) always sees
// every section, including ones added in the future, automatically (nothing
// here special-cases "super_admin" — can() already returns true
// unconditionally for ALL_ACCESS).
const { all, get } = require("../db");
const { sendJSON, sendCSV, sendPDF, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, can } = require("../rbac");
const { getCompanySettings, getCurrentRate, getCurrentRates, costRateLookup, addAudit, getDefaultPdfTemplate } = require("../domain");
const { blankMargins, addStoredMargin, roundMargins } = require("../exchange-calc");
const { uid, nowISO, todayStr, convert, newestFirst } = require("../util");
const { toCSV } = require("../csv");
const { renderReportPDF } = require("../pdf");

// ---------------------------------------------------------------------
// Date range resolution (spec section 2 — Today/Yesterday/This Week/This
// Month/Last Month/This Year/Last 3 Months/Last 6 Months/Custom Range).
// Dates are plain "YYYY-MM-DD" strings throughout, matching the
// `date(date) >= date(?)` pattern already used across reports.js/history.js.
// ---------------------------------------------------------------------
function isoDate(d) { return d.toISOString().slice(0, 10); }
function startOfWeek(d) {
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday-start week
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}
const RANGE_PRESETS = new Set(["today", "yesterday", "thisWeek", "thisMonth", "lastMonth", "thisYear", "last3Months", "last6Months", "custom"]);
function resolveDateRange(range, fromQ, toQ) {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const r = RANGE_PRESETS.has(range) ? range : "today";
  switch (r) {
    case "yesterday": { const y = new Date(today); y.setUTCDate(y.getUTCDate() - 1); return { range: r, from: isoDate(y), to: isoDate(y) }; }
    case "thisWeek": return { range: r, from: isoDate(startOfWeek(today)), to: isoDate(today) };
    case "thisMonth": return { range: r, from: isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: isoDate(today) };
    case "lastMonth": {
      const s = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const e = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { range: r, from: isoDate(s), to: isoDate(e) };
    }
    case "thisYear": return { range: r, from: isoDate(new Date(Date.UTC(today.getUTCFullYear(), 0, 1))), to: isoDate(today) };
    case "last3Months": { const s = new Date(today); s.setUTCMonth(s.getUTCMonth() - 3); return { range: r, from: isoDate(s), to: isoDate(today) }; }
    case "last6Months": { const s = new Date(today); s.setUTCMonth(s.getUTCMonth() - 6); return { range: r, from: isoDate(s), to: isoDate(today) }; }
    case "custom": {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(fromQ || "") ? fromQ : isoDate(today);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(toQ || "") ? toQ : isoDate(today);
      return { range: r, from: from <= to ? from : to, to: from <= to ? to : from };
    }
    default: return { range: "today", from: isoDate(today), to: isoDate(today) };
  }
}

// Chooses a sensible bucket granularity for a date span so trend charts stay
// legible (spec item 27: "avoid giant charts") — a caller can still force one
// via the `bucket` query param (used by the Deposits vs Withdrawals /
// "Payment Performance" widget's own Daily/Weekly/Monthly toggle, spec item 13).
function daySpan(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000) + 1;
}
function pickBucketUnit(from, to, forced) {
  if (forced === "day" || forced === "week" || forced === "month") return forced;
  const span = daySpan(from, to);
  if (span <= 31) return "day";
  if (span <= 180) return "week";
  return "month";
}
function bucketKeyFor(dateStr, unit) {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  if (unit === "month") return d.toISOString().slice(0, 7);
  if (unit === "week") { const s = startOfWeek(d); return isoDate(s); }
  return isoDate(d);
}
function enumerateBuckets(from, to, unit) {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const keys = [];
  if (unit === "month") {
    let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (d <= last) { keys.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  } else if (unit === "week") {
    let d = startOfWeek(start);
    while (d <= end) { keys.push(isoDate(d)); d.setUTCDate(d.getUTCDate() + 7); }
  } else {
    let d = new Date(start);
    while (d <= end) { keys.push(isoDate(d)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  return keys;
}

// ---------------------------------------------------------------------
// Scoped row fetchers — every one respects the account-scope filter
// (drill-down: spec item 18) and, where relevant, the currency filter
// (spec item 2 — "If Currency = USD, only USD financial data").
// ---------------------------------------------------------------------
function ledgerRows(from, to, currency, accountId) {
  const clauses = ["date(l.date) >= date(?)", "date(l.date) <= date(?)", "c.deleted_at IS NULL"];
  const params = [from, to];
  if (currency) { clauses.push("l.currency = ?"); params.push(currency); }
  if (accountId) { clauses.push("l.client_id = ?"); params.push(accountId); }
  return all(`SELECT l.* FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE ${clauses.join(" AND ")} ORDER BY l.date ASC`, params);
}
function allTimeLedgerRows(currency, accountId) {
  const clauses = ["c.deleted_at IS NULL"];
  const params = [];
  if (currency) { clauses.push("l.currency = ?"); params.push(currency); }
  if (accountId) { clauses.push("l.client_id = ?"); params.push(accountId); }
  return all(`SELECT l.date, l.type, l.amount FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE ${clauses.join(" AND ")} ORDER BY l.date ASC`, params);
}
function exchangeRows(from, to, accountId) {
  const clauses = ["status = 'active'", "date(date) >= date(?)", "date(date) <= date(?)"];
  const params = [from, to];
  if (accountId) { clauses.push("(client_id = ? OR from_account_id = ? OR to_account_id = ?)"); params.push(accountId, accountId, accountId); }
  return all(`SELECT * FROM exchange_transactions WHERE ${clauses.join(" AND ")} ORDER BY date DESC, id DESC`, params);
}
function transferRows(from, to, accountId) {
  const clauses = ["status = 'active'", "date(date) >= date(?)", "date(date) <= date(?)"];
  const params = [from, to];
  if (accountId) { clauses.push("(from_account_id = ? OR to_account_id = ?)"); params.push(accountId, accountId); }
  return all(`SELECT * FROM transfers WHERE ${clauses.join(" AND ")} ORDER BY date DESC, created_at DESC, id DESC`, params);
}
function quotationRows(from, to, status, accountId) {
  const clauses = ["date(created_at) >= date(?)", "date(created_at) <= date(?)"];
  const params = [from, to];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (accountId) { clauses.push("charged_account_id = ?"); params.push(accountId); }
  return all(`SELECT * FROM quotations WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params);
}

function sumByCurrency(rows, currencyField, amountField, predicate) {
  const out = { usd: 0, slsh: 0 };
  for (const r of rows) {
    if (predicate && !predicate(r)) continue;
    const cur = r[currencyField] === "USD" ? "usd" : r[currencyField] === "SLSH" ? "slsh" : null;
    if (!cur) continue;
    out[cur] += Number(r[amountField]) || 0;
  }
  return out;
}

// Reconstructs a real, self-consistent Opening/In/Out/Closing balance trend
// (spec items 7-8) for one currency from that currency's FULL ledger history
// (not just the selected range) — the range's first bucket's Opening Balance
// is the true historical balance at that moment, worked out from every
// ledger row that ever happened before it, not an approximation.
function balanceTrend(currency, accountId, buckets, unit, to) {
  const rows = allTimeLedgerRows(currency, accountId);
  const bucketEndExclusive = (i) => {
    if (i + 1 < buckets.length) return buckets[i + 1];
    const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
    return isoDate(d);
  };
  let idx = 0, running = 0;
  const result = [];
  for (let i = 0; i < buckets.length; i++) {
    const bStart = buckets[i];
    while (idx < rows.length && rows[idx].date.slice(0, 10) < bStart) {
      running += rows[idx].type === "deposit" ? rows[idx].amount : -rows[idx].amount;
      idx++;
    }
    const opening = running;
    const bEnd = bucketEndExclusive(i);
    let inAmt = 0, outAmt = 0, j = idx;
    while (j < rows.length && rows[j].date.slice(0, 10) < bEnd) {
      if (rows[j].type === "deposit") inAmt += rows[j].amount; else outAmt += rows[j].amount;
      j++;
    }
    result.push({ date: bStart, opening, in: inAmt, out: outAmt, closing: opening + inAmt - outAmt });
  }
  return result;
}

function bucketedSeries(rows, dateField, unit, buckets, reducer) {
  const map = new Map(buckets.map((b) => [b, reducer.init()]));
  for (const r of rows) {
    const key = bucketKeyFor(r[dateField], unit);
    if (!map.has(key)) continue; // outside the enumerated range (shouldn't happen — defensive)
    reducer.add(map.get(key), r);
  }
  return buckets.map((b) => ({ date: b, ...map.get(b) }));
}

// ---------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------
function buildDashboard(user, query) {
  const { range, from, to } = resolveDateRange(query.range, query.from, query.to);
  const currencyFilter = query.currency === "USD" || query.currency === "SLSH" ? query.currency : null;
  const accountId = query.accountId || null;
  const statusFilter = query.status && ["Pending", "Paid", "Refunded"].includes(query.status) ? query.status : null;
  const unit = pickBucketUnit(from, to, query.bucket);
  const buckets = enumerateBuckets(from, to, unit);

  const reportsGate = can(user, "reports");
  const exchangeGate = reportsGate && (can(user, "exchangeCreate") || can(user, "exchangeAll"));
  const quotationsGate = reportsGate && (can(user, "quotationsManage") || can(user, "quotationsApprove"));
  const payload = {
    meta: {
      generatedAt: nowISO(), range, from, to, currency: currencyFilter || "all", accountId, status: statusFilter || "all",
      bucketUnit: unit,
      gates: { reports: reportsGate, exchange: exchangeGate, quotations: quotationsGate, accounts: can(user, "accountsManage") },
    },
  };
  if (!reportsGate) return payload; // matches the pre-existing Dashboard: no "reports" grant sees only the currency converter + role blurb (frontend-owned, no data needed here)

  const currencies = currencyFilter ? [currencyFilter] : ["USD", "SLSH"];
  const asKey = (c) => (c === "USD" ? "usd" : "slsh");

  // --- point-in-time (NOT date-filtered): current balances, account counts ---
  const clientClauses = ["deleted_at IS NULL"]; const clientParams = [];
  if (accountId) { clientClauses.push("id = ?"); clientParams.push(accountId); }
  const clients = all(`SELECT id, name, account_number, currency, status, balance_usd, balance_slsh FROM clients WHERE ${clientClauses.join(" AND ")}`, clientParams);
  const usdAccounts = clients.filter((c) => c.currency === "USD");
  const slshAccounts = clients.filter((c) => c.currency === "SLSH");
  payload.accountOverview = accountId ? null : {
    usd: { totalAccounts: usdAccounts.length, totalBalance: usdAccounts.reduce((s, c) => s + c.balance_usd, 0) },
    slsh: { totalAccounts: slshAccounts.length, totalBalance: slshAccounts.reduce((s, c) => s + c.balance_slsh, 0) },
    activeAccounts: clients.filter((c) => c.status === "active").length,
    deactivatedAccounts: clients.filter((c) => c.status === "deactivated").length,
  };

  // --- period-scoped raw rows, fetched once and reused across widgets ---
  const ledger = currencyFilter ? ledgerRows(from, to, currencyFilter, accountId) : [...ledgerRows(from, to, "USD", accountId), ...ledgerRows(from, to, "SLSH", accountId)];
  const exchanges = exchangeGate ? exchangeRows(from, to, accountId) : [];
  const transfers = transferRows(from, to, accountId);
  const quotations = quotationsGate ? quotationRows(from, to, statusFilter, accountId) : [];
  const plainLedger = ledger.filter((l) => !l.source_type);

  // --- summary cards (spec section 3) ---
  const moneyIn = { usd: 0, slsh: 0 }, moneyOut = { usd: 0, slsh: 0 };
  for (const l of ledger) {
    const k = asKey(l.currency);
    if (l.type === "deposit") moneyIn[k] += l.amount; else moneyOut[k] += l.amount;
  }
  const paymentsIn = { usd: 0, slsh: 0, count: 0 }, paymentsOut = { usd: 0, slsh: 0 };
  for (const l of plainLedger) {
    const k = asKey(l.currency);
    paymentsIn.count += 1;
    if (l.type === "deposit") paymentsIn[k] += l.amount; else paymentsOut[k] += l.amount;
  }
  payload.summary = {
    usdBalance: usdAccounts.reduce((s, c) => s + c.balance_usd, 0),
    slshBalance: slshAccounts.reduce((s, c) => s + c.balance_slsh, 0),
    moneyIn, moneyOut,
    totalPayments: { count: plainLedger.length, usd: paymentsIn.usd + paymentsOut.usd, slsh: paymentsIn.slsh + paymentsOut.slsh },
    totalTransactions: plainLedger.length + exchanges.length + transfers.length + quotations.length,
    // DASHBOARD UPGRADE round: payments split by direction, from the same
    // plainLedger rows as totalPayments above (manual deposits/withdrawals
    // only — quotation, exchange and transfer legs are left out, so nothing
    // is counted twice). Each currency on its own; dated by the payment date.
    paymentsReceived: { usd: paymentsIn.usd, slsh: paymentsIn.slsh, count: plainLedger.filter((l) => l.type === "deposit").length },
    paymentsMade: { usd: paymentsOut.usd, slsh: paymentsOut.slsh, count: plainLedger.filter((l) => l.type === "withdrawal").length },
  };
  // Open quotations right now (Pending + Partially Paid) — a point-in-time
  // count like the Quotations menu badges, not limited to the period.
  if (quotationsGate) {
    payload.summary.pendingQuotations = get("SELECT COUNT(*) AS n FROM quotations WHERE status IN ('Pending','Partially Paid')" + (accountId ? " AND charged_account_id = ?" : ""), accountId ? [accountId] : []).n;
  }
  payload.moneyFlow = {
    usd: { in: moneyIn.usd, out: moneyOut.usd, net: moneyIn.usd - moneyOut.usd },
    slsh: { in: moneyIn.slsh, out: moneyOut.slsh, net: moneyIn.slsh - moneyOut.slsh },
  };

  // --- money flow trend + balance trend (spec sections 6-8) ---
  const flowReducer = { init: () => ({ inUsd: 0, outUsd: 0, inSlsh: 0, outSlsh: 0 }), add: (acc, l) => {
    const k = l.currency === "USD" ? "Usd" : "Slsh";
    if (l.type === "deposit") acc[`in${k}`] += l.amount; else acc[`out${k}`] += l.amount;
  } };
  const flowSeries = bucketedSeries(ledger, "date", unit, buckets, flowReducer);
  payload.moneyFlowTrend = {
    labels: buckets,
    usd: { in: flowSeries.map((b) => b.inUsd), out: flowSeries.map((b) => b.outUsd), net: flowSeries.map((b) => b.inUsd - b.outUsd) },
    slsh: { in: flowSeries.map((b) => b.inSlsh), out: flowSeries.map((b) => b.outSlsh), net: flowSeries.map((b) => b.inSlsh - b.outSlsh) },
  };
  payload.balanceTrend = {};
  for (const c of currencies) payload.balanceTrend[asKey(c)] = balanceTrend(c, accountId, buckets, unit, to);

  // --- transaction activity + distribution (spec sections 9-10) ---
  const categories = [
    { type: "Credit", count: plainLedger.filter((l) => l.type === "deposit").length, amount: sumByCurrency(plainLedger, "currency", "amount", (l) => l.type === "deposit") },
    { type: "Debit", count: plainLedger.filter((l) => l.type === "withdrawal").length, amount: sumByCurrency(plainLedger, "currency", "amount", (l) => l.type === "withdrawal") },
    { type: "Transfer", count: transfers.length, amount: sumByCurrency(transfers, "currency", "amount") },
    { type: "Exchange", count: exchanges.length, amount: sumByCurrency(exchanges, "currency_given", "amount_given") },
    { type: "Quotation", count: quotations.length, amount: sumByCurrency(quotations, "charged_currency", "charged_amount") },
  ];
  payload.transactionActivity = categories;
  const totalCount = categories.reduce((s, c) => s + c.count, 0);
  payload.transactionDistribution = categories
    .filter((c) => c.count > 0)
    .map((c) => ({ ...c, pct: totalCount ? +((c.count / totalCount) * 100).toFixed(1) : 0 }));

  // --- deposits vs withdrawals / "payment performance" (spec sections 11, 13 — consolidated, see README) ---
  const dwReducer = { init: () => ({ depUsd: 0, wdUsd: 0, depSlsh: 0, wdSlsh: 0, depCount: 0, wdCount: 0 }), add: (acc, l) => {
    const k = l.currency === "USD" ? "Usd" : "Slsh";
    if (l.type === "deposit") { acc[`dep${k}`] += l.amount; acc.depCount += 1; } else { acc[`wd${k}`] += l.amount; acc.wdCount += 1; }
  } };
  const dwSeries = bucketedSeries(plainLedger, "date", unit, buckets, dwReducer);
  payload.depositsVsWithdrawals = {
    labels: buckets,
    depositsUsd: dwSeries.map((b) => b.depUsd), withdrawalsUsd: dwSeries.map((b) => b.wdUsd),
    depositsSlsh: dwSeries.map((b) => b.depSlsh), withdrawalsSlsh: dwSeries.map((b) => b.wdSlsh),
    depositsCount: dwSeries.map((b) => b.depCount), withdrawalsCount: dwSeries.map((b) => b.wdCount),
  };

  // --- quotation performance (spec section 12) ---
  if (quotationsGate) {
    payload.quotationPerformance = ["Pending", "Paid", "Refunded"].map((status) => {
      const rows = quotations.filter((q) => q.status === status);
      return { status, count: rows.length, value: sumByCurrency(rows, "charged_currency", "charged_amount") };
    });
  }

  // --- exchange activity + chart (spec sections 14-15) ---
  if (exchangeGate) {
    const usdToSlsh = exchanges.filter((e) => e.currency_given === "USD");
    const slshToUsd = exchanges.filter((e) => e.currency_given === "SLSH");
    payload.exchangeActivity = {
      currentRate: getCurrentRate(),
      usdToSlsh: { count: usdToSlsh.length, amountUsd: usdToSlsh.reduce((s, e) => s + e.amount_given, 0) },
      slshToUsd: { count: slshToUsd.length, amountSlsh: slshToUsd.reduce((s, e) => s + e.amount_given, 0) },
    };
    // GLOBAL RATE & PROFIT round: current Cost/Buy/Sell rates, and — for
    // users allowed to see exchange profit — the period's Sell-side Profit
    // and Buy-side Cost Rate Difference, each exchange counted once.
    const rates = getCurrentRates();
    payload.exchangeActivity.rates = { costRate: rates.costRate, buyRate: rates.buyRate, sellRate: rates.sellRate };
    if (can(user, "profit.viewExchange")) {
      const lookup = costRateLookup();
      const b = blankMargins();
      for (const e of exchanges) addStoredMargin(b, { currencyGiven: e.currency_given, profitUsd: e.profit_usd, costRate: e.cost_rate != null ? e.cost_rate : lookup(e.date) });
      payload.exchangeActivity.margins = roundMargins(b);
    }
    const exReducer = { init: () => ({ usdToSlsh: 0, slshToUsd: 0 }), add: (acc, e) => {
      if (e.currency_given === "USD") acc.usdToSlsh += e.amount_given; else acc.slshToUsd += e.amount_given;
    } };
    const exSeries = bucketedSeries(exchanges, "date", unit, buckets, exReducer);
    payload.exchangeChart = { labels: buckets, usdToSlsh: exSeries.map((b) => b.usdToSlsh), slshToUsd: exSeries.map((b) => b.slshToUsd) };
  }

  // --- top accounts by balance (spec sections 16-17) — point-in-time, not date-filtered ---
  if (!accountId) {
    const topOf = (rows, field) => rows.filter((c) => c.status === "active").slice().sort((a, b) => b[field] - a[field]).slice(0, 10)
      .map((c) => ({ id: c.id, name: c.name, accountNumber: c.account_number, balance: c[field] }));
    payload.topAccounts = { usd: topOf(usdAccounts, "balance_usd"), slsh: topOf(slshAccounts, "balance_slsh") };
  }

  // --- recent tables (spec sections 21-24) ---
  const RECENT_LIMIT = 10;
  payload.recentTransactions = [
    ...plainLedger.map((l) => ({ id: l.id, _createdAt: l.created_at, date: l.date, reference: l.reference_number, type: l.type === "deposit" ? "Credit" : "Debit", accountId: l.client_id, currency: l.currency, amount: l.amount, note: l.notes || "", status: null })),
    ...exchanges.map((e) => ({ id: e.id, date: e.date, reference: e.reference_number, type: "Exchange", accountId: e.client_id, currency: e.currency_given, amount: e.amount_given, note: e.notes || "", status: e.status })),
    ...transfers.map((t) => ({ id: t.id, _createdAt: t.created_at, date: t.date, reference: t.reference_number, type: "Transfer", accountId: t.from_account_id, currency: t.currency, amount: t.amount, note: t.notes || "", status: t.status })),
  ];
  newestFirst(payload.recentTransactions, (r) => r.date, (r) => r._createdAt);
  payload.recentTransactions = payload.recentTransactions.slice(0, RECENT_LIMIT).map(({ _createdAt, ...r }) => r);
  payload.recentPayments = newestFirst(plainLedger.slice()).slice(0, RECENT_LIMIT)
    .map((l) => ({ id: l.id, date: l.date, reference: l.reference_number, accountId: l.client_id, currency: l.currency, amount: l.amount, type: l.type }));
  if (quotationsGate) {
    payload.recentQuotations = quotations.slice(0, RECENT_LIMIT)
      .map((q) => ({ id: q.id, date: q.created_at, reference: q.number, clientName: q.client_name, currency: q.charged_currency, amount: q.charged_amount, status: q.status }));
  }
  if (exchangeGate) {
    payload.recentExchanges = exchanges.slice(0, RECENT_LIMIT)
      .map((e) => ({ id: e.id, date: e.date, reference: e.reference_number, from: e.currency_given, to: e.currency_received, rate: e.rate_used, amount: e.amount_given, status: e.status }));
  }

  // --- attention required (spec section 25) — only real, data-driven alerts ---
  const alerts = [];
  const pendingCount = get("SELECT COUNT(*) as n FROM quotations WHERE status = 'Pending'" + (accountId ? " AND charged_account_id = ?" : ""), accountId ? [accountId] : []).n;
  if (quotationsGate && pendingCount > 0) {
    alerts.push({ type: "pendingQuotations", label: "Pending quotations awaiting settlement", count: pendingCount, severity: "amber", view: "quotations-pending" });
  }
  // "Large" is derived from this period's own data (>= 3x the median of the
  // same type+currency, with at least 5 entries to make a median meaningful)
  // — never a hard-coded absolute number, so it scales with the business's
  // own real activity (spec section 39: no fabricated thresholds).
  function medianOf(nums) {
    if (!nums.length) return 0;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  for (const type of ["deposit", "withdrawal"]) {
    for (const cur of currencies) {
      const rows = plainLedger.filter((l) => l.type === type && l.currency === cur);
      if (rows.length < 5) continue;
      const median = medianOf(rows.map((r) => r.amount));
      if (median <= 0) continue;
      const largest = rows.slice().sort((a, b) => b.amount - a.amount)[0];
      if (largest.amount >= median * 3) {
        alerts.push({
          type: `large${type === "deposit" ? "Deposit" : "Withdrawal"}`,
          label: `Notably large ${type === "deposit" ? "credit" : "debit"} this period (${cur})`,
          count: 1, severity: "red", accountId: largest.client_id,
          detail: { amount: largest.amount, currency: cur, date: largest.date },
        });
      }
    }
  }
  payload.attentionRequired = alerts.slice(0, 6);

  return payload;
}

function register(router) {
  router.get("/api/dashboard", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    sendJSON(res, 200, buildDashboard(user, query || {}));
  });

  // ---------------------------------------------------------------------
  // Layout persistence (spec section 33 — show/hide/reorder/resize widgets).
  // Reuses the EXISTING table_layouts table (see tableLayouts.js) rather
  // than a new one — table_key is hard-coded to 'dashboard' here (never a
  // client-supplied param, unlike tableLayouts.js's own :tableKey route),
  // and columns_json stores an array of {key, visible, size} widget-state
  // objects instead of tableLayouts.js's flat column-key strings; both are
  // just opaque TEXT to the table itself. Gated on the NEW
  // dashboard.customize grant (spec explicitly calls "Customize Dashboard"
  // out as its own permission, distinct from settings.manageTableDefaults),
  // not reused from Table Customization.
  // ---------------------------------------------------------------------
  const { get: getRow, run } = require("../db");
  const DASHBOARD_TABLE_KEY = "dashboard";
  const SYSTEM_SCOPE_ID = "__system__";
  const MAX_WIDGETS = 40;
  function serializeLayout(row) {
    if (!row) return null;
    let widgets = [];
    try { widgets = JSON.parse(row.columns_json) || []; } catch (e) { widgets = []; }
    return { widgets, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  function validateWidgets(widgets) {
    if (!Array.isArray(widgets)) return "widgets must be an array.";
    if (widgets.length > MAX_WIDGETS) return `widgets can't have more than ${MAX_WIDGETS} entries.`;
    const seen = new Set();
    for (const w of widgets) {
      if (!w || typeof w !== "object" || typeof w.key !== "string" || !w.key || w.key.length > 60) return "Each widget needs a short, non-empty key.";
      if (seen.has(w.key)) return "widgets must not contain duplicate keys.";
      seen.add(w.key);
      if (w.visible !== undefined && typeof w.visible !== "boolean") return "widget.visible must be a boolean.";
      if (w.size !== undefined && !["full", "half"].includes(w.size)) return "widget.size must be 'full' or 'half'.";
    }
    return null;
  }
  router.get("/api/dashboard-layout", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    const system = getRow("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [DASHBOARD_TABLE_KEY, SYSTEM_SCOPE_ID]);
    const mine = getRow("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [DASHBOARD_TABLE_KEY, user.id]);
    sendJSON(res, 200, { system: serializeLayout(system), mine: serializeLayout(mine) });
  });
  router.patch("/api/dashboard-layout", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const scope = body.scope === "system" ? "system" : "me";
    if (scope === "system" && !requirePerm(user, res, "dashboard.customize")) return;
    const err = validateWidgets(body.widgets);
    if (err) return badRequest(res, err);
    const userId = scope === "system" ? SYSTEM_SCOPE_ID : user.id;
    const now = nowISO();
    const existing = getRow("SELECT id FROM table_layouts WHERE table_key = ? AND user_id = ?", [DASHBOARD_TABLE_KEY, userId]);
    if (existing) {
      run("UPDATE table_layouts SET columns_json=?, updated_at=?, updated_by=? WHERE id=?", [JSON.stringify(body.widgets), now, user.name, existing.id]);
    } else {
      run("INSERT INTO table_layouts (id, table_key, user_id, columns_json, density, updated_at, updated_by) VALUES (?,?,?,?,NULL,?,?)", [uid("layout"), DASHBOARD_TABLE_KEY, userId, JSON.stringify(body.widgets), now, user.name]);
    }
    if (scope === "system") addAudit(user, "Dashboard default layout changed", `${body.widgets.length} widget(s) configured`);
    const fresh = getRow("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [DASHBOARD_TABLE_KEY, userId]);
    sendJSON(res, 200, { layout: serializeLayout(fresh) });
  });
  router.delete("/api/dashboard-layout", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    const scope = query && query.scope === "system" ? "system" : "me";
    if (scope === "system" && !requirePerm(user, res, "dashboard.customize")) return;
    const userId = scope === "system" ? SYSTEM_SCOPE_ID : user.id;
    run("DELETE FROM table_layouts WHERE table_key = ? AND user_id = ?", [DASHBOARD_TABLE_KEY, userId]);
    if (scope === "system") addAudit(user, "Dashboard default layout reset", "");
    sendJSON(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------
  // Export (spec section 41) — PDF and CSV, respecting the same filters and
  // permissions as the live view (never more than the viewer could already
  // see on screen). Print is the browser's own PDF-preview print dialog on
  // the frontend, so it needs no separate endpoint here.
  // ---------------------------------------------------------------------
  router.get("/api/dashboard/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "dashboard.export")) return;
    const d = buildDashboard(user, query || {});
    const rows = [];
    if (d.summary) {
      rows.push(["Total USD balance", d.summary.usdBalance.toFixed(2), ""]);
      rows.push(["Total SLSH balance", Math.round(d.summary.slshBalance), ""]);
      rows.push(["Money in", d.summary.moneyIn.usd.toFixed(2), Math.round(d.summary.moneyIn.slsh)]);
      rows.push(["Money out", d.summary.moneyOut.usd.toFixed(2), Math.round(d.summary.moneyOut.slsh)]);
      rows.push(["Total payments (count)", String(d.summary.totalPayments.count), ""]);
      rows.push(["Total transactions (count)", String(d.summary.totalTransactions), ""]);
    }
    addAudit(user, "Dashboard summary exported (CSV)", "");
    sendCSV(res, "obo-dashboard-summary.csv", toCSV(["Metric", "USD", "SLSH"], rows));
  });
  router.get("/api/dashboard/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "dashboard.export")) return;
    const d = buildDashboard(user, query || {});
    const rows = [];
    if (d.summary) {
      rows.push(["Total USD balance", `$${d.summary.usdBalance.toFixed(2)}`]);
      rows.push(["Total SLSH balance", `SLSH ${Math.round(d.summary.slshBalance)}`]);
      rows.push(["Money in (USD)", `$${d.summary.moneyIn.usd.toFixed(2)}`]);
      rows.push(["Money in (SLSH)", `SLSH ${Math.round(d.summary.moneyIn.slsh)}`]);
      rows.push(["Money out (USD)", `$${d.summary.moneyOut.usd.toFixed(2)}`]);
      rows.push(["Money out (SLSH)", `SLSH ${Math.round(d.summary.moneyOut.slsh)}`]);
      rows.push(["Total payments", String(d.summary.totalPayments.count)]);
      rows.push(["Total transactions", String(d.summary.totalTransactions)]);
    }
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Financial Dashboard Summary",
      meta: `${d.meta.from} – ${d.meta.to} · Currency: ${d.meta.currency}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Metric", width: 2 }, { label: "Value", width: 1.4, align: "right" }],
      rows,
    });
    addAudit(user, "Dashboard summary exported (PDF)", "");
    sendPDF(res, "obo-dashboard-summary.pdf", pdf);
  });
}

module.exports = { register, buildDashboard, resolveDateRange };
