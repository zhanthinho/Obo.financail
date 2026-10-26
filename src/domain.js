"use strict";
const { get, all, run } = require("./db");
const { uid, nowISO, todayStr, convert, formatPersonName, chronoSortKey } = require("./util");

// RATE MANAGEMENT UNIFICATION round: Daily Rate and Sale Rate now both live
// in the one unified `rate_history` table (schema.sql) — each save writes
// ONE row carrying both current values together — but every existing
// caller of these two functions (computeExchangeProfit below, every
// transaction route, the whole frontend) is completely unaffected: the
// function names, signatures, and defaulting behavior are all unchanged,
// only what table they query.
function getCurrentRate() {
  const row = get("SELECT daily_rate as rate FROM rate_history WHERE daily_rate IS NOT NULL ORDER BY at DESC LIMIT 1");
  return row ? row.rate : 1;
}

// SALE RATE / EXCHANGE PROFIT round. Unlike getCurrentRate() above, this
// deliberately returns null (never a fabricated 1) until someone with
// rateManage has actually set a Sale Rate at least once — a fake default
// here would silently manufacture huge, wrong "profit" numbers the moment
// this ships against an existing database, instead of just leaving Profit
// at its pre-existing 0 baseline until the business supplies a real figure.
function getCurrentSaleRate() {
  const row = get("SELECT sale_rate as rate FROM rate_history WHERE sale_rate IS NOT NULL ORDER BY at DESC LIMIT 1");
  return row ? row.rate : null;
}

// DAILY SLSH RATE round: a RECORD-ONLY companion to the Daily (USD) Rate
// above — the "opposite direction" rate a Super Admin can optionally note
// down alongside it. Same null-until-set shape as getCurrentSaleRate().
// Deliberately NEVER consulted by convert() or any money-calculation path
// (Money Exchange, Quotations, Dashboard, Reports all still convert
// SLSH<->USD via the single Daily Rate exactly as before this round) — it
// exists purely to be displayed and kept in rate_history for reference.
function getCurrentDailySlshRate() {
  const row = get("SELECT daily_slsh_rate as rate FROM rate_history WHERE daily_slsh_rate IS NOT NULL ORDER BY at DESC LIMIT 1");
  return row ? row.rate : null;
}

// CASH IN HAND — INDEPENDENT RATE round: Cash in Hand's own exchange rate
// (cash_rate_history, schema.sql), completely separate from the
// company-wide Daily Rate above — reading/saving one never touches the
// other. Falls back to the current company Daily Rate ONLY until someone
// with rateManage has actually set a Cash in Hand rate at least once, so an
// existing installation's Cash in Hand screen keeps showing the same number
// it always has the moment this ships, rather than suddenly going blank —
// after that first explicit save, it's on its own and the company Daily
// Rate can change without ever moving this figure.
function getCurrentCashRate() {
  const row = get("SELECT rate FROM cash_rate_history ORDER BY at DESC LIMIT 1");
  return row ? row.rate : getCurrentRate();
}
// BALANCE SHEET round: ONLY a Cash in Hand rate someone has explicitly set
// (never the Daily Rate fallback above) — used where combining USD and SLSH
// must not silently borrow the Money Exchange rate. null when none is set
// or the stored value isn't a usable positive number.
function getExplicitCashRate() {
  const row = get("SELECT rate, at, set_by_name FROM cash_rate_history ORDER BY at DESC LIMIT 1");
  if (!row) return null;
  const rate = Number(row.rate);
  if (!Number.isFinite(rate) || rate <= 0) return { rate: null, invalid: true, at: row.at, setByName: row.set_by_name };
  return { rate, at: row.at, setByName: row.set_by_name };
}
function saveCashRateHistory({ rate, note, user, currencyPair = "USD_SLSH" }) {
  const id = uid("crh");
  const at = nowISO();
  run(
    "INSERT INTO cash_rate_history (id, currency_pair, rate, note, set_by, set_by_name, at) VALUES (?,?,?,?,?,?,?)",
    [id, currencyPair, rate, note || null, user.id, user.name, at]
  );
  return { id, currencyPair, rate, note: note || null, at };
}

// RATE MANAGEMENT UNIFICATION round: the single save path behind the
// unified Rate Management UI (header quick-edit, the Money Exchange "Rate
// history" tab's Save Rates form, AND the still-separate /api/rate and
// /api/sale-rate endpoints kept for backward compatibility) — every save,
// whatever triggered it, produces exactly ONE new rate_history row
// carrying BOTH current values (point 11 of the spec: changing only one
// side still snapshots the other side's current value into the same new
// row, rather than leaving it to an implicit "still whatever it was on an
// older row" join). Pass only the side that actually changed; the other is
// carried forward automatically via getCurrentRate()/getCurrentSaleRate().
// currencyPair defaults to the only real pair this business trades today,
// but the column (and this function) are already pair-aware for whenever a
// second one is genuinely configured.
function saveRateHistory({ dailyRate, saleRate, dailySlshRate, note, user, currencyPair = "USD_SLSH" }) {
  const effectiveDaily = dailyRate != null ? dailyRate : getCurrentRate();
  const effectiveSale = saleRate != null ? saleRate : getCurrentSaleRate();
  // DAILY SLSH RATE round: carried forward the same "untouched side keeps
  // its current value" way effectiveSale already works above — record-only,
  // never read by any conversion math (see getCurrentDailySlshRate()).
  const effectiveDailySlsh = dailySlshRate != null ? dailySlshRate : getCurrentDailySlshRate();
  const difference = effectiveDaily != null && effectiveSale != null ? effectiveDaily - effectiveSale : null;
  const id = uid("rh");
  const at = nowISO();
  run(
    "INSERT INTO rate_history (id, currency_pair, daily_rate, sale_rate, daily_slsh_rate, rate_difference, note, set_by, set_by_name, at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, currencyPair, effectiveDaily, effectiveSale, effectiveDailySlsh, difference, note || null, user.id, user.name, at]
  );
  return { id, currencyPair, dailyRate: effectiveDaily, saleRate: effectiveSale, dailySlshRate: effectiveDailySlsh, difference, note: note || null, at };
}

// The Profit (USD) one exchange makes against the current Sale Rate, given
// the Daily/quoted rate actually used on that one transaction (both rates
// are "1 USD = SLSH X"). Confirmed with the business, worked example:
// Daily Rate 8,700, Sale Rate 8,650, $100 USD -> SLSH: Profit = 100 * (8700
// - 8650) / 8650 ~= $0.58.
//
// Both directions share that same spread-times-USD-amount shape; only the
// sign flips between them, because the business is effectively "selling"
// the opposite currency each time (USD->SLSH hands out SLSH for USD in;
// SLSH->USD hands out USD for SLSH in) — a Daily Rate above the wholesale
// Sale Rate is a gain when SLSH is what's going out, but the mirror-image
// loss when USD is what's going out instead. amountGiven/amountReceived
// are already in their own respective currencies (never mixed), so
// whichever side of the pair is USD is what the spread is applied to.
//
// Returns 0 whenever no Sale Rate has ever been set, or rateUsed is falsy
// — profit then silently stays at its pre-existing 0 baseline rather than
// fabricating a number from an unset rate.
function computeExchangeProfit(currencyGiven, amountGiven, amountReceived, rateUsed) {
  const saleRate = getCurrentSaleRate();
  if (!saleRate || !rateUsed) return 0;
  if (currencyGiven === "USD") return amountGiven * (rateUsed - saleRate) / saleRate;
  return amountReceived * (saleRate - rateUsed) / saleRate;
}

function getCompanySettings() {
  const row = get("SELECT * FROM company_settings WHERE id = 1");
  // LANGUAGE round: the company's own profile text is data — never
  // translated in Somali exports.
  if (row) require("./i18n/request").protect(row.name, row.tagline, row.address, row.phone, row.email, row.website);
  return row;
}

// PDF TEMPLATE CONTROL round: the one active, non-archived default template
// for a given kind (currently only "quotation") — what every real PDF
// export of that kind renders with unless a caller explicitly asks for a
// different template. Never returns an archived row, even if it's
// (invalidly) still flagged is_default=1 — archiving a template is
// supposed to take it out of active use.
function getDefaultPdfTemplate(kind) {
  const specific = get("SELECT * FROM pdf_templates WHERE kind = ? AND is_default = 1 AND is_archived = 0", [kind]);
  if (specific) return specific;
  // EXPORT TEMPLATE FIX: the spec this engine was built from ("If no
  // specific template is assigned: Use the global default" — see db.js's
  // seed comment for the 'global' row) was never actually implemented here
  // — this always did an exact-kind-only lookup, so the seeded "global"
  // template (labeled "All Documents (Global Default)" in Settings > PDF
  // Templates, and the one most users reach for first) silently had NO
  // effect on any export whose kind doesn't have its own template row
  // (every kind except "quotation" — account statements, transaction
  // history, exchange receipts, reports, deposit/withdrawal/transfer
  // receipts all fell through to this with nothing to show for a
  // customized global template). Falling back to the 'global' row here
  // makes that label true.
  if (kind === "global") return null; // already checked above; avoid a redundant second query
  return get("SELECT * FROM pdf_templates WHERE kind = 'global' AND is_default = 1 AND is_archived = 0", []);
}

// EXCEL TEMPLATE & CUSTOMIZATION ENGINE round: the Excel counterpart of
// getDefaultPdfTemplate above — same exact-kind lookup, same "no row found"
// meaning "render with the hardcoded defaults" (resolveExcelStyle in
// xlsx-engine.js treats a null template exactly like resolveStyle in pdf.js
// does), so every Excel export call site follows the identical
// `template: getDefaultExcelTemplate("<kind>")` pattern already used for PDFs.
function getDefaultExcelTemplate(kind) {
  const specific = get("SELECT * FROM excel_templates WHERE kind = ? AND is_default = 1 AND is_archived = 0", [kind]);
  if (specific) return specific;
  // Same "global" fallback fix as getDefaultPdfTemplate above — see its
  // comment for the full explanation.
  if (kind === "global") return null;
  return get("SELECT * FROM excel_templates WHERE kind = 'global' AND is_default = 1 AND is_archived = 0", []);
}

function findOrCreateClient(name, contact, address, currencyHint) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw) return null;
  // Try the name exactly as typed first — this is what lets a typed
  // Client Name resolve to an existing COMPANY account, whose name is
  // intentionally left in its original casing (never uppercased). Only if
  // that misses do we try the uppercased/person-formatted form, which is
  // how an existing customer account (already stored uppercase) is found.
  const formatted = formatPersonName(raw);
  let existing = get("SELECT id FROM clients WHERE name = ?", [raw]);
  if (!existing && formatted !== raw) {
    existing = get("SELECT id FROM clients WHERE name = ?", [formatted]);
  }
  if (existing) {
    if (contact || address) {
      run("UPDATE clients SET contact = COALESCE(?, contact), address = COALESCE(?, address) WHERE id = ?", [contact || null, address || null, existing.id]);
    }
    return existing.id;
  }
  // No existing account matched — create a brand-new one. A name reaching
  // this path (typed inline on an exchange/quotation, not picked from an
  // existing account) is always a walk-in PERSON, so the new client is
  // stored under the default 'customer' account_type in canonical uppercase.
  //
  // CURRENCY: a walk-in client has no account currency of its own — it's
  // just a typed name, not a chosen account — so the currency it gets
  // tagged with must come from the transaction that's creating it right
  // now (currencyHint, e.g. an exchange's currencyGiven or a quotation's
  // intended charge currency). Leaving this to the schema's bare 'USD'
  // default (the old behavior) silently mistagged every SLSH walk-in
  // transaction as a USD one — polluting the USD Accounts list and, for a
  // quotation with no explicit account, even charging totalUSD instead of
  // totalSLSH. Only used at creation time; an existing client's currency is
  // never touched here.
  const id = uid("cl");
  const currency = currencyHint === "SLSH" ? "SLSH" : "USD";
  run("INSERT INTO clients (id, name, contact, address, currency, created_at) VALUES (?,?,?,?,?,?)", [id, formatted, contact || null, address || null, currency, nowISO()]);
  return id;
}

function addAudit(actor, action, details) {
  run(
    "INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES (?,?,?,?,?,?,?)",
    [uid("log"), nowISO(), actor?.id || null, actor?.name || "system", actor?.role || "system", action, details || ""]
  );
}

function currencyPosition() {
  const ob = get("SELECT usd, slsh FROM opening_balances WHERE id = 1") || { usd: 0, slsh: 0 };
  let usd = ob.usd, slsh = ob.slsh;
  const txs = all("SELECT amount_given, currency_given, amount_received, currency_received FROM exchange_transactions WHERE status = 'active'");
  for (const t of txs) {
    if (t.currency_given === "USD") usd += t.amount_given; else slsh += t.amount_given;
    if (t.currency_received === "USD") usd -= t.amount_received; else slsh -= t.amount_received;
  }
  return { usd, slsh, opening: ob };
}

// Kept as a thin passthrough (rather than inlining q.status everywhere) so
// call sites don't need to change now that the old Draft/Sent/Accepted/
// Rejected/Expired/Cancelled workflow is gone — a quotation's status is
// simply Pending / Paid / Refunded, reflecting whether its settlement
// Deposit has posted yet, not a date-driven "Expired" computation.
function effectiveStatus(q) {
  return q.status;
}

function quotationTotals(items, discountPercent, taxPercent, rateUsed) {
  let subUSD = 0, subSLSH = 0;
  for (const it of items) {
    const line = (Number(it.qty) || 0) * (Number(it.unit_price ?? it.unitPrice) || 0);
    const cur = it.currency;
    subUSD += convert(line, cur, "USD", rateUsed);
    subSLSH += convert(line, cur, "SLSH", rateUsed);
  }
  const discPct = Number(discountPercent) || 0;
  const taxPct = Number(taxPercent) || 0;
  const afterDiscUSD = subUSD * (1 - discPct / 100);
  const afterDiscSLSH = subSLSH * (1 - discPct / 100);
  return {
    subUSD, subSLSH,
    totalUSD: afterDiscUSD * (1 + taxPct / 100),
    totalSLSH: afterDiscSLSH * (1 + taxPct / 100),
  };
}

function nextQuotationNumber() {
  const year = new Date().getFullYear();
  const prefix = `QT-${year}-`;
  // Based on the HIGHEST existing sequence number for this year, not a
  // COUNT(*) of rows — a quotation can be permanently deleted (once
  // Cancelled or refunded), which would make a count-based "next" number
  // collide with a number that's still in use (quotations.number is
  // UNIQUE). Mirrors nextAccountNumber's same MAX-based approach below.
  const row = get("SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) as n FROM quotations WHERE number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

function nextAccountNumber() {
  const row = get("SELECT MAX(CAST(SUBSTR(account_number, 5) AS INTEGER)) as n FROM clients WHERE account_number LIKE 'ACC-%'");
  const seq = (row?.n || 0) + 1;
  return `ACC-${String(seq).padStart(4, "0")}`;
}

// UNIFIED TRANSACTION HISTORY reference numbers — same MAX-based-on-highest-
// existing-sequence approach as nextQuotationNumber/nextAccountNumber above
// (never a COUNT(*), since a permanently deleted row must not free up its
// number for reuse — collisions would confuse anyone matching a reference
// against printed/exported history from before the delete).
function nextExchangeReference() {
  const year = new Date().getFullYear();
  const prefix = `EX-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM exchange_transactions WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
function nextTransferReference() {
  const year = new Date().getFullYear();
  const prefix = `TR-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM transfers WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
// Plain (unlinked) deposits/withdrawals reuse account_ledger.reference_number
// (already used for quotation legs' QT- numbers) — DEP-/WD- prefixes keep
// these disjoint from QT- so MAX(...) LIKE-scoped per prefix never collides.
function nextLedgerReference(type) {
  const prefix = type === "withdrawal" ? "WD" : "DEP";
  const year = new Date().getFullYear();
  const p = `${prefix}-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM account_ledger WHERE reference_number LIKE ?", [p.length + 1, p + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${p}${String(seq).padStart(4, "0")}`;
}

// PARTIAL PAYMENT UPGRADE round: same MAX-based-on-highest-existing-sequence
// approach as the other reference generators above.
function nextQuotationPaymentReference() {
  const year = new Date().getFullYear();
  const prefix = `PAY-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM quotation_payments WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// The single source of truth for a quotation's payment math — used by the
// API response (serialize), the quotation table, the settlement modal, the
// PDF, and the Excel export, so none of them can ever compute Paid/Remaining
// differently from another. `payments` is the quotation's own
// quotation_payments rows (each a REAL, permanently recorded payment — never
// a rewrite of the original charged_amount, which stays untouched here).
// Status is derived, never stored redundantly out of sync: Pending (nothing
// paid yet), Partially Paid (something paid but less than the full amount),
// Paid (paid in full) — Refunded stays a separate terminal status set by the
// existing refund-charge action, which this function leaves alone (a
// refunded quotation's own `status` column already reads 'Refunded' and is
// returned as-is rather than recomputed from payments).
function quotationPaymentSummary(quotation, payments) {
  const total = round2(Number(quotation.charged_amount) || 0);
  let paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  // Legacy fallback: a quotation marked Paid before this round (via the old
  // one-click "mark fully paid" flow) has no quotation_payments rows at all,
  // since that table didn't exist yet. Its real settlement Deposit ledger
  // entry already posted at the time (paid_ledger_id) — this only affects
  // how Paid/Remaining render for it now, never rewrites any ledger/audit
  // history and never fabricates a payment record.
  if (quotation.status === "Paid" && payments.length === 0) paid = total;
  paid = round2(paid);
  const remaining = quotation.status === "Refunded" ? 0 : Math.max(0, round2(total - paid));
  let status;
  if (quotation.status === "Refunded") status = "Refunded";
  else if (paid <= 0) status = "Pending";
  else if (paid + 0.005 >= total) status = "Paid";
  else status = "Partially Paid";
  return { originalAmount: total, totalPaid: paid, remaining, percentPaid: total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0, computedStatus: status };
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Recomputes balance_after for every ledger entry of one account+currency, in
// date order, and updates the account's stored balance to match — the only
// safe way to edit or delete a ledger entry without corrupting the running
// balance history. Call this after any insert/update/delete to account_ledger.
//
// BALANCE & LAST TRANSACTION FIX round: `date` is the user-editable
// Payment/Accounting Date, which can be a bare "YYYY-MM-DD" (most Payment
// forms only offer a date picker — see util.resolvePaymentDate) OR a full
// ISO timestamp (an Opening Balance, an Exchange, a Transfer, or anything
// given a specific date/time). A plain SQL `ORDER BY date` compares those
// two shapes as plain strings, which is NOT chronologically correct and can
// even put a same-day bare-date row entirely AFTER a same-day timestamped
// row that happens to carry an afternoon time, regardless of which one was
// actually entered first. Left uncorrected, this doesn't just mis-order a
// display list — it silently REPLAYS entries in the wrong order, scrambling
// every affected row's balance_after even when the final total happens to
// still add up right. So the replay below fetches un-ordered and sorts in
// JS using util.chronoSortKey (same calendar day → real insertion order via
// created_at; different days → the day itself, so backdating still works),
// with `id` (embeds a real timestamp — see uid() in util.js) as the final,
// last-resort tiebreaker. This changes ONLY the replay order used to
// compute balance_after/balance; it never changes a single amount, type, or
// any entry's own Payment Date.
function rebuildAccountBalance(clientId, currency) {
  const entries = all(
    "SELECT id, type, amount, date, created_at FROM account_ledger WHERE client_id = ? AND currency = ?",
    [clientId, currency]
  );
  entries.sort((a, b) => {
    const byDate = chronoSortKey(a.date, a.created_at).localeCompare(chronoSortKey(b.date, b.created_at));
    if (byDate !== 0) return byDate;
    return String(a.id).localeCompare(String(b.id));
  });
  let balance = 0;
  for (const e of entries) {
    balance += e.type === "deposit" ? e.amount : -e.amount;
    run("UPDATE account_ledger SET balance_after = ? WHERE id = ?", [balance, e.id]);
  }
  const field = currency === "USD" ? "balance_usd" : "balance_slsh";
  run(`UPDATE clients SET ${field} = ? WHERE id = ?`, [balance, clientId]);
  return balance;
}

// CASH IN HAND round: the cash_ledger analogue of rebuildAccountBalance
// above — same exact "replay every row in date order, rewrite balance_after,
// then write the final figure onto the parent row" mechanism, just pointed
// at cash_accounts/cash_ledger instead of clients/account_ledger. Also
// stamps last_activity_at (a Cash Account concept with no clients
// equivalent) to the most recent entry's date, or null if the account now
// has no ledger rows at all (e.g. its only entry was just deleted).
// SECURITY AUDIT round: replayed in the same true chronological order as
// rebuildAccountBalance (chronoSortKey) instead of a raw `ORDER BY date`
// string sort, which mis-orders a bare "YYYY-MM-DD" date against a full
// timestamp on the same day and so scrambles balance_after. The final
// balance is unchanged either way (a sum doesn't depend on order).
function rebuildCashAccountBalance(cashAccountId) {
  const entries = all(
    "SELECT id, type, amount, date, created_at FROM cash_ledger WHERE cash_account_id = ?",
    [cashAccountId]
  );
  entries.sort((a, b) => {
    const byDate = chronoSortKey(a.date, a.created_at).localeCompare(chronoSortKey(b.date, b.created_at));
    if (byDate !== 0) return byDate;
    return String(a.id).localeCompare(String(b.id));
  });
  let balance = 0;
  for (const e of entries) {
    balance += e.type === "deposit" ? e.amount : -e.amount;
    run("UPDATE cash_ledger SET balance_after = ? WHERE id = ?", [balance, e.id]);
  }
  const lastActivity = entries.length ? entries[entries.length - 1].date : null;
  run("UPDATE cash_accounts SET balance = ?, last_activity_at = ? WHERE id = ?", [balance, lastActivity, cashAccountId]);
  return balance;
}

// Same MAX-based-on-highest-existing-sequence pattern as every other
// reference generator above — CSH- prefixes kept disjoint from the existing
// DEP-/WD-/EX-/TR-/QT- series so none of these LIKE-scoped MAX queries can
// ever collide with each other.
function nextCashLedgerReference(type) {
  const prefix = type === "withdrawal" ? "CSHWD" : "CSHDEP";
  const year = new Date().getFullYear();
  const p = `${prefix}-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM cash_ledger WHERE reference_number LIKE ?", [p.length + 1, p + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${p}${String(seq).padStart(4, "0")}`;
}
function nextCashTransferReference() {
  const year = new Date().getFullYear();
  const prefix = `CSHTR-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM cash_transfers WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
function nextCashExchangeReference() {
  const year = new Date().getFullYear();
  const prefix = `CSHEX-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM cash_exchanges WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
function nextLoanReference() {
  const year = new Date().getFullYear();
  const prefix = `LN-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM cash_loans WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
function nextLoanPaymentReference() {
  const year = new Date().getFullYear();
  const prefix = `LNPAY-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM cash_loan_payments WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  const seq = (row?.n || 0) + 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

module.exports = {
  getCurrentRate, getCurrentSaleRate, getCurrentDailySlshRate, saveRateHistory, getCurrentCashRate, getExplicitCashRate, saveCashRateHistory, computeExchangeProfit, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, findOrCreateClient, addAudit, currencyPosition,
  effectiveStatus, quotationTotals, nextQuotationNumber, nextAccountNumber, rebuildAccountBalance,
  nextExchangeReference, nextTransferReference, nextLedgerReference,
  nextQuotationPaymentReference, quotationPaymentSummary,
  rebuildCashAccountBalance, nextCashLedgerReference, nextCashTransferReference, nextCashExchangeReference,
  nextLoanReference, nextLoanPaymentReference,
};
