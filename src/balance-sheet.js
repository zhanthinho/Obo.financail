"use strict";
// BALANCE SHEET — the one authoritative calculation, shared by
// GET /api/cash/balance-sheet (live) and the daily snapshots
// (src/daily-snapshots.js), so a stored snapshot always holds exactly the
// figures the live Balance Sheet showed at that moment.
//
//   Balance Sheet = Debt + Cash Account − Credit, worked out separately for
//   each currency (USD and SLSH are never added together).
//   Debt         = the negative balances of customer/company accounts
//                  (what customers owe the company — "In debt" on
//                  Accounts), as a positive figure.
//   Cash Account = the balances of ACTIVE Cash Accounts.
//   Credit       = the positive balances of customer/company accounts
//                  (money the company holds for customers and owes back).
// Account balances are the ledger-derived clients.balance_usd /
// balance_slsh (each account counts once, in its own currency).
// Permanently deleted accounts are left out; deactivated accounts still
// count, because what they owe or are owed has not gone away. Loans are
// not part of Debt (by decision of the business). Each company has its own
// tables, so these sums only ever cover the current company.
//
// Read-only: it only sums balances the system already keeps.
const { all, get } = require("./db");
const { getExplicitCashRate } = require("./domain");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function cashTotalsByCurrency() {
  const rows = all("SELECT currency, COALESCE(SUM(balance),0) as total FROM cash_accounts WHERE status = 'active' GROUP BY currency");
  const out = { USD: 0, SLSH: 0 };
  for (const r of rows) out[r.currency] = r.total;
  return out;
}

// currencies: which of "USD"/"SLSH" to include (the caller's currency access).
function computeBalanceSheet(currenciesAllowed = ["USD", "SLSH"]) {
  const cash = cashTotalsByCurrency();
  const currencies = {};
  const precise = {}; // unrounded Balance Sheet per currency, for combining
  for (const cur of currenciesAllowed) {
    const col = cur === "USD" ? "balance_usd" : "balance_slsh";
    const r = get(`SELECT
        COALESCE(SUM(CASE WHEN ${col} < 0 THEN -${col} ELSE 0 END), 0) AS debt,
        COALESCE(SUM(CASE WHEN ${col} > 0 THEN ${col} ELSE 0 END), 0) AS credit,
        SUM(CASE WHEN ${col} < 0 THEN 1 ELSE 0 END) AS debtAccounts,
        SUM(CASE WHEN ${col} > 0 THEN 1 ELSE 0 END) AS creditAccounts
      FROM clients WHERE currency = ? AND deleted_at IS NULL`, [cur]);
    const cashAccounts = get("SELECT COUNT(*) AS n FROM cash_accounts WHERE currency = ? AND status = 'active'", [cur]).n;
    const cashTotal = cash[cur] || 0;
    precise[cur] = r.debt + cashTotal - r.credit;
    currencies[cur] = {
      debt: round2(r.debt), cashInHand: round2(cashTotal), credit: round2(r.credit),
      balanceSheet: round2(precise[cur]),
      debtAccounts: r.debtAccounts || 0, creditAccounts: r.creditAccounts || 0, cashAccounts,
    };
  }
  // Net Balance Sheet — both currencies combined into ONE amount in one
  // named reporting currency. It is converted ONLY with a Cash Account rate
  // someone has explicitly set (getExplicitCashRate): never the company
  // Daily Rate, and never a guessed rate. Without one, the combined total
  // is reported as unavailable instead of a misleading number. Computed
  // from the precise per-currency values, rounded only at the end.
  //   SLSH Equivalent = Balance Sheet (USD) × rate + Balance Sheet (SLSH)
  //   USD Equivalent  = Balance Sheet (USD) + Balance Sheet (SLSH) ÷ rate
  const explicit = getExplicitCashRate();
  const cashRate = explicit && explicit.rate ? { rate: explicit.rate, setAt: explicit.at, setByName: explicit.setByName } : null;
  let combined;
  if (!currencies.USD || !currencies.SLSH) combined = { available: false, reason: "currency_access" };
  else if (explicit && explicit.invalid) combined = { available: false, reason: "rate_invalid" };
  else if (!cashRate) combined = { available: false, reason: "rate_not_set" };
  else {
    const rate = cashRate.rate;
    const usdAsSlsh = precise.USD * rate, slshAsUsd = precise.SLSH / rate;
    combined = {
      available: true, rate,
      slshEquivalent: { usdConverted: round2(usdAsSlsh), slsh: round2(precise.SLSH), total: round2(usdAsSlsh + precise.SLSH) },
      usdEquivalent: { usd: round2(precise.USD), slshConverted: round2(slshAsUsd), total: round2(precise.USD + slshAsUsd) },
      // Kept for anything that read the earlier shape of this field.
      USD: round2(precise.USD + slshAsUsd), SLSH: round2(usdAsSlsh + precise.SLSH),
    };
  }
  return { formula: "Debt + Cash Account - Credit", currencies, cashRate, combined };
}

module.exports = { computeBalanceSheet, cashTotalsByCurrency, round2 };
