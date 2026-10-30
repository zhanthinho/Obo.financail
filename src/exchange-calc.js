"use strict";
// GLOBAL RATE & PROFIT round — the ONE place the exchange margin is
// calculated. The server (transactions, history, dashboard, reports) and the
// frontend (Manage Rates, Quick Exchange, tables) all import this module, so
// no screen can drift to a different formula.
//
// Rates are SLSH per 1 USD:
//   Cost Rate — what a dollar is worth to the company (its valuation rate)
//   Buy Rate  — the company BUYS dollars from a customer (customer gives USD)
//   Sell Rate — the company SELLS dollars to a customer (customer gives SLSH)
//
//   Sell (customer gives SLSH):  Profit               = (Sell − Cost) × USD   [SLSH]
//   Buy  (customer gives USD):   Cost Rate Difference = (Cost − Buy)  × USD   [SLSH]
//
// The Buy-side figure is a valuation difference, not realized profit — it is
// always labelled and totalled separately from Sell-side Profit.
// The USD equivalent divides by THIS transaction's own Cost Rate (never
// today's rate, never an unstated rate).

const SIDE_BUY = "buy";
const SIDE_SELL = "sell";

const pos = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? v : null; };
const round = (n, dp) => { const f = 10 ** dp; return Math.round((Number(n) + Number.EPSILON) * f) / f; };

// Customer gives USD -> the company buys dollars; gives SLSH -> sells dollars.
function sideOf(currencyGiven) { return currencyGiven === "USD" ? SIDE_BUY : SIDE_SELL; }

// The customer rate a NEW exchange uses by default for its direction:
// Buy Rate for USD -> SLSH, Sell Rate for SLSH -> USD, falling back to the
// Daily Rate only while the direction's own rate has never been set.
function defaultRateFor(currencyGiven, rates) {
  const r = rates || {};
  const own = sideOf(currencyGiven) === SIDE_BUY ? pos(r.buyRate) : pos(r.sellRate);
  return own || pos(r.dailyRate) || null;
}

// The USD leg of an exchange: what the customer gave (Buy) or received (Sell).
function usdAmountOf(currencyGiven, amountGiven, amountReceived) {
  return currencyGiven === "USD" ? Number(amountGiven) || 0 : Number(amountReceived) || 0;
}

// Returns null when the margin can't honestly be calculated (no/invalid
// Cost Rate or transaction rate, or no USD amount) — callers show "—",
// never a made-up 0 or a guess.
function computeMargin({ currencyGiven, amountGiven, amountReceived, rate, costRate }) {
  const cost = pos(costRate), txRate = pos(rate);
  const usd = usdAmountOf(currencyGiven, amountGiven, amountReceived);
  if (!cost || !txRate || !(usd > 0)) return null;
  const side = sideOf(currencyGiven);
  const perUsd = side === SIDE_SELL ? txRate - cost : cost - txRate;
  const slsh = round(perUsd * usd, 2);
  return {
    side,                       // "buy" | "sell"
    kind: side === SIDE_SELL ? "profit" : "costRateDifference",
    label: side === SIDE_SELL ? "Profit" : "Cost Rate Difference",
    usdAmount: usd,
    rate: txRate,
    costRate: cost,
    perUsd,                     // SLSH per $1
    slsh,                       // SLSH
    usd: round(slsh / cost, 6), // USD equivalent at this transaction's Cost Rate
    costValue: round(usd * cost, 2),   // SLSH
    txValue: round(usd * txRate, 2),   // SLSH (Buy Value or Sell Value)
  };
}

// Per-$1 spreads shown in Manage Rates (null when either side is missing).
function rateSpreads({ costRate, buyRate, sellRate }) {
  const c = pos(costRate), b = pos(buyRate), s = pos(sellRate);
  return {
    buyDifferencePerUsd: c && b ? c - b : null,
    sellProfitPerUsd: c && s ? s - c : null,
  };
}

// Validation for a set of rates (Manage Rates). Returns an error message or null.
function validateRates({ costRate, buyRate, sellRate }) {
  for (const [name, v] of [["Cost Rate", costRate], ["Buy Rate", buyRate], ["Sell Rate", sellRate]]) {
    if (v === undefined || v === null || v === "") continue;
    if (!pos(v)) return `${name} must be a positive number.`;
  }
  return null;
}

// Totals a list of margins, keeping Buy-side and Sell-side apart (never
// added together) and counting each transaction once.
function totalMargins(margins) {
  const t = { sell: { slsh: 0, usd: 0, count: 0 }, buy: { slsh: 0, usd: 0, count: 0 } };
  for (const m of margins) {
    if (!m) continue;
    const b = t[m.side];
    b.slsh += m.slsh; b.usd += m.usd; b.count += 1;
  }
  for (const k of ["sell", "buy"]) { t[k].slsh = round(t[k].slsh, 2); t[k].usd = round(t[k].usd, 2); }
  return t;
}

// Totals for STORED exchanges (reports, dashboard): each row adds to exactly
// one bucket — Sell-side Profit or Buy-side Cost Rate Difference — in USD as
// stored and in SLSH at that row's own Cost Rate (skipped, and counted as
// `unvalued`, when no Cost Rate is known). profitUSD keeps the old combined
// figure for existing API callers.
function blankMargins() { return { profitUSD: 0, sellProfitUSD: 0, buyDiffUSD: 0, sellProfitSLSH: 0, buyDiffSLSH: 0, sellCount: 0, buyCount: 0, unvalued: 0 }; }
function addStoredMargin(b, { currencyGiven, profitUsd, costRate }) {
  const usd = Number(profitUsd) || 0;
  const cost = pos(costRate);
  const slsh = cost ? round(usd * cost, 2) : null;
  b.profitUSD += usd;
  if (sideOf(currencyGiven) === SIDE_BUY) { b.buyDiffUSD += usd; b.buyCount += 1; if (slsh !== null) b.buyDiffSLSH += slsh; }
  else { b.sellProfitUSD += usd; b.sellCount += 1; if (slsh !== null) b.sellProfitSLSH += slsh; }
  if (slsh === null) b.unvalued += 1;
  return b;
}
function roundMargins(b) {
  for (const k of ["profitUSD", "sellProfitUSD", "buyDiffUSD"]) b[k] = round(b[k], 2);
  for (const k of ["sellProfitSLSH", "buyDiffSLSH"]) b[k] = round(b[k], 0);
  return b;
}

module.exports = { blankMargins, addStoredMargin, roundMargins, SIDE_BUY, SIDE_SELL, sideOf, defaultRateFor, usdAmountOf, computeMargin, rateSpreads, validateRates, totalMargins };
