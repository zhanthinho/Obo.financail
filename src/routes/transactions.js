"use strict";
const { isValidAmount, MAX_AMOUNT } = require("../util");
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, sendCSV, sendPDF, sendXLSX, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, can, allowedCurrencies } = require("../rbac");
const { computeMargin, defaultRateFor } = require("../exchange-calc");
const { getCurrentRate, getCurrentSaleRate, getCurrentRates, getCurrentCostRate, costRateAt, costRateLookup, computeExchangeProfit, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, findOrCreateClient, addAudit, rebuildAccountBalance, nextExchangeReference, rebuildCashAccountBalance, nextCashLedgerReference } = require("../domain");
const { uid, nowISO, todayStr, convert, fmtMoney } = require("../util");
const { toCSV } = require("../csv");
const { renderReportPDF, renderExchangeReceiptPDF } = require("../pdf");
const { buildExchangeReceiptWorkbook } = require("../xlsx-documents");

// Thrown from inside a delete or update transaction for an expected,
// user-facing problem (not found / already gone / can't be mutated here) so
// the route handler can turn it into the right HTTP response instead of a
// 500. Shared by DELETE and PATCH below since both need the same
// find-the-row / reject-if-voided guard.
class TransactionMutationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// CURRENCY / RATE / PROFIT PERMISSIONS round: `includeProfit` (the caller's
// profit.viewExchange grant) decides whether profitUsd is even PRESENT on
// the object sent to the browser — not hidden with CSS, per spec item 8's
// explicit "do not simply expose the value and hide it" requirement. Every
// call site below passes `can(user, "profit.viewExchange")`.
// EXCHANGE WORKSPACE round: resolves a cash_accounts row down to the small
// basic-info shape the frontend's "Cash Out From"/"Cash In To" cards need
// (name/type/currency/balance) — mirrors routes/cash.js's own accountBasic
// used the same way for Payments, kept as a tiny local copy here rather
// than a cross-file import since it's one trivial SELECT.
function cashAccountBasic(id) {
  if (!id) return null;
  const a = get("SELECT id, name, type, currency, balance, status FROM cash_accounts WHERE id = ?", [id]);
  return a ? { id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance, status: a.status } : null;
}

// ACCOUNT PICKER DIRECTNESS round: resolves a client (customer) account down
// to the same small basic-info shape, so the Exchange form's From
// Account/Receiving Account pickers can preload an edit's existing accounts
// immediately (same reason cashAccountBasic exists for Cash Out/Cash In)
// without waiting on their own currency-filtered list to load first.
function clientAccountBasic(id) {
  if (!id) return null;
  const a = get("SELECT id, name, account_number, currency, balance_usd, balance_slsh, status FROM clients WHERE id = ?", [id]);
  if (!a) return null;
  return { id: a.id, name: a.name, accountNumber: a.account_number, currency: a.currency, balance: a.currency === "USD" ? a.balance_usd : a.balance_slsh, status: a.status };
}

// Validates an exchange's chosen Cash Out/Cash In account before anything is
// written — same shape as routes/cash.js's validatePaymentCashAccount (not
// imported from there to avoid a route-to-route dependency): optional
// (null/undefined means "no Cash in Hand linkage for this leg," exactly
// today's behavior), must exist, be active, and match the leg's currency
// (Cash Out must hold currencyGiven, Cash In must hold currencyReceived —
// spec section 10). No insufficient-balance check, matching every other
// Cash in Hand withdrawal-style move in this app (accounts may go negative).
function resolveExchangeCashAccount(cashAccountId, expectedCurrency, label) {
  if (!cashAccountId) return { cashAccount: null };
  const a = get("SELECT * FROM cash_accounts WHERE id = ?", [cashAccountId]);
  if (!a) return { error: `${label} account was not found.` };
  if (a.status !== "active") return { error: `${a.name} is deactivated — choose another ${label} account.` };
  if (a.currency !== expectedCurrency) return { error: `${a.name} is ${a.currency} — ${label} must be ${expectedCurrency}.` };
  return { cashAccount: a };
}

// GLOBAL RATE & PROFIT round: the Cost Rate this exchange was valued at —
// stored on the row since this round; for an older row, the Cost (or Sale)
// Rate that applied on its own date (display only, the stored profit is
// never rewritten). `margin` comes from the shared calculation.
// null = not supplied; false = supplied but not a positive number.
function parseCostRate(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : false;
}
function txCostRate(t, lookup) {
  if (t.cost_rate != null) return { costRate: t.cost_rate, costRateSource: "stored" };
  const r = lookup ? lookup(t.date) : costRateAt(t.date);
  return { costRate: r, costRateSource: r != null ? "history" : null };
}
function marginFields(t, lookup) {
  const { costRate, costRateSource } = txCostRate(t, lookup);
  const margin = computeMargin({ currencyGiven: t.currency_given, amountGiven: t.amount_given, amountReceived: t.amount_received, rate: t.rate_used, costRate });
  return { profitUsd: t.profit_usd, costRate, costRateSource, marginSide: t.currency_given === "USD" ? "buy" : "sell", marginSlsh: margin ? margin.slsh : null };
}

function rowToJSON(t, includeProfit, lookup) {
  return {
    id: t.id, date: t.date, clientName: t.client_name, referenceNumber: t.reference_number,
    fromAccountId: t.from_account_id, fromAccount: clientAccountBasic(t.from_account_id),
    toAccountId: t.to_account_id, toAccount: clientAccountBasic(t.to_account_id),
    amountGiven: t.amount_given, currencyGiven: t.currency_given,
    amountReceived: t.amount_received, currencyReceived: t.currency_received,
    rateUsed: t.rate_used, ...(includeProfit ? marginFields(t, lookup) : {}), staffId: t.staff_id, staffName: t.staff_name,
    status: t.status, notes: t.notes, voidReason: t.void_reason, voidedBy: t.voided_by, voidedAt: t.voided_at,
    // EXCHANGE WORKSPACE round: optional Cash in Hand linkage — both null on
    // every exchange recorded before this round, and on any new one where
    // the (optional) picker was left unset.
    cashOutAccountId: t.cash_out_account_id, cashOutAccount: cashAccountBasic(t.cash_out_account_id),
    cashInAccountId: t.cash_in_account_id, cashInAccount: cashAccountBasic(t.cash_in_account_id),
  };
}

// Applies role scoping (cashiers/etc. without exchangeAll only ever see their own
// transactions — this is enforced here, server-side, not just hidden in the UI)
// plus optional date/staff/client/status filters from the query string.
function queryTransactions(user, query) {
  const clauses = [];
  const params = [];
  if (!can(user, "exchangeAll")) {
    clauses.push("staff_id = ?");
    params.push(user.id);
  } else if (query.staffId) {
    clauses.push("staff_id = ?");
    params.push(query.staffId);
  }
  if (query.from) { clauses.push("date(date) >= date(?)"); params.push(query.from); }
  if (query.to) { clauses.push("date(date) <= date(?)"); params.push(query.to); }
  if (query.client) { clauses.push("client_name LIKE ?"); params.push(`%${query.client}%`); }
  if (query.status && query.status !== "all") { clauses.push("status = ?"); params.push(query.status); }
  // Currency filter: every exchange converts USD <-> SLSH for one client, so
  // "currency" here means which side the client GAVE (currency_given) —
  // "USD" shows exchanges where the client gave USD (received SLSH), and
  // vice versa. currency_received is always the other one, so filtering on
  // either leg would be equivalent; currency_given reads most naturally as
  // "show me USD exchanges" (the side the client paid in).
  if (query.currency && query.currency !== "all" && (query.currency === "USD" || query.currency === "SLSH")) {
    clauses.push("currency_given = ?");
    params.push(query.currency);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  return all(`SELECT * FROM exchange_transactions ${where} ORDER BY date DESC, id DESC`, params);
}

function register(router) {
  router.get("/api/transactions", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    // An Exchange always converts USD <-> SLSH for one client, so a role
    // restricted to only one currency (currency.usd or currency.slsh alone)
    // has no legitimate view onto Exchange at all — same "must not appear
    // anywhere" rule as Accounts, applied to the one module that inherently
    // touches both currencies at once.
    const allowed = allowedCurrencies(user);
    if (allowed.length < 2) return sendJSON(res, 200, { transactions: [] });
    const includeProfit = can(user, "profit.viewExchange");
    const rows = queryTransactions(user, query);
    const lookup = includeProfit ? costRateLookup() : null;
    sendJSON(res, 200, { transactions: rows.map((t) => rowToJSON(t, includeProfit, lookup)) });
  });

  router.post("/api/transactions", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (allowedCurrencies(user).length < 2) {
      return sendJSON(res, 403, { error: "You need access to both USD and SLSH accounts to record a currency exchange." });
    }
    if (!requirePerm(user, res, "exchangeCreate")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const given = Number(body.amountGiven);
    const currencyGiven = body.currencyGiven === "SLSH" ? "SLSH" : "USD";
    if (!body.clientName || !isValidAmount(given)) return badRequest(res, "clientName and a positive amountGiven are required.");
    const currencyReceived = currencyGiven === "USD" ? "SLSH" : "USD";
    // GLOBAL RATE & PROFIT round: with no rate typed, the direction's own
    // rate applies (Buy Rate for USD -> SLSH, Sell Rate for SLSH -> USD),
    // falling back to the Daily Rate until those are set.
    const rate = body.rateUsed !== undefined && body.rateUsed !== "" && body.rateUsed !== null ? Number(body.rateUsed) : defaultRateFor(currencyGiven, getCurrentRates());
    if (!rate || rate <= 0 || !Number.isFinite(rate) || rate > 1e9) return badRequest(res, "Rate must be a positive number.");
    // COST RATE OVERRIDE round: a Cost Rate typed for THIS exchange only
    // (Quick Exchange -> Rate details); otherwise the company's current one.
    const costOverride = parseCostRate(body.costRate);
    if (costOverride === false) return badRequest(res, "Cost Rate must be a positive number.");
    const costRate = costOverride !== null ? costOverride : getCurrentCostRate();
    const txDate = body.date ? new Date(body.date).toISOString() : nowISO();
    let received = body.amountReceived !== undefined && body.amountReceived !== "" && body.amountReceived !== null
      ? Number(body.amountReceived)
      : convert(given, currencyGiven, currencyReceived, rate);
    received = currencyReceived === "USD" ? Math.round(received * 100) / 100 : Math.round(received);
    if (!Number.isFinite(received) || received < 0 || received > MAX_AMOUNT) return badRequest(res, "The received amount must be a valid number within range.");
    // SALE RATE / EXCHANGE PROFIT round: `profitUsd` stays an editable
    // override (the Money Exchange form still shows and accepts it), but
    // when the caller doesn't explicitly supply one it's no longer
    // hardcoded to 0 — it falls back to the auto-computed spread against
    // the current Sale Rate, the same override-with-server-fallback shape
    // already used just above for `rate` (body.rateUsed vs
    // getCurrentRate()) and `received` (body.amountReceived vs convert()).
    // GLOBAL RATE & PROFIT round: the fallback is the shared Cost Rate
    // margin (src/exchange-calc.js) in USD at this exchange's Cost Rate —
    // Sell-side Profit or Buy-side Cost Rate Difference — 0 with no Cost Rate.
    const margin = computeMargin({ currencyGiven, amountGiven: given, amountReceived: received, rate, costRate });
    const profitUsd = body.profitUsd !== undefined && body.profitUsd !== null && body.profitUsd !== ""
      ? Number(body.profitUsd) || 0
      : (margin ? margin.usd : 0);

    // ACCOUNT PICKER DIRECTNESS round: From Account and Receiving Account
    // are now two independent picks made directly in the Exchange form
    // (clientAccountId / receivingAccountId), not derived from a client's
    // pre-configured linked_account_id pairing — that implicit "type a name,
    // get auto-linked to whatever account it's paired with" behavior is
    // gone. Either, both, or neither may be set; each is validated against
    // its own side's currency independently of the other.
    let fromAccount = null, toAccount = null;
    if (body.clientAccountId) {
      fromAccount = get("SELECT * FROM clients WHERE id = ?", [body.clientAccountId]);
      if (!fromAccount) return notFound(res, "Selected account not found.");
      if (fromAccount.status !== "active") return badRequest(res, `${fromAccount.name}'s account is deactivated — reactivate it before exchanging on it.`);
      if (fromAccount.currency !== currencyGiven) {
        return badRequest(res, `${fromAccount.name}'s account is ${fromAccount.currency} — "Currency given" must match it.`);
      }
      // Accounts are allowed to go negative (into debt) — an exchange debit
      // is never blocked for insufficient funds, per business policy.
    }
    if (body.receivingAccountId) {
      toAccount = get("SELECT * FROM clients WHERE id = ?", [body.receivingAccountId]);
      if (!toAccount) return notFound(res, "Selected receiving account not found.");
      if (toAccount.status !== "active") return badRequest(res, `${toAccount.name}'s account is deactivated — reactivate it before exchanging on it.`);
      if (toAccount.currency !== currencyReceived) {
        return badRequest(res, `${toAccount.name}'s account is ${toAccount.currency} — "Currency received" must match it.`);
      }
    }

    // EXCHANGE WORKSPACE round: optional Cash in Hand linkage (spec section
    // 7/10) — Cash Out From must hold currencyGiven, Cash In To must hold
    // currencyReceived. Resolved and validated before anything is written,
    // same as the client-account checks just above; either or both may be
    // left unset with no error (an exchange with no Cash in Hand linkage at
    // all behaves exactly as it always has).
    const cashOutResult = resolveExchangeCashAccount(body.cashOutAccountId, currencyGiven, "Cash Out From");
    if (cashOutResult.error) return badRequest(res, cashOutResult.error);
    const cashInResult = resolveExchangeCashAccount(body.cashInAccountId, currencyReceived, "Cash In To");
    if (cashInResult.error) return badRequest(res, cashInResult.error);
    const cashOutAccount = cashOutResult.cashAccount, cashInAccount = cashInResult.cashAccount;

    const clientId = fromAccount ? fromAccount.id : findOrCreateClient(body.clientName, body.clientContact, body.clientAddress, currencyGiven);
    // Use the resolved client's actual stored name (correct casing for its
    // account type) for the denormalized client_name column, rather than the
    // raw typed value — this keeps it in sync with clients.name.
    const resolvedClientName = fromAccount ? fromAccount.name : (get("SELECT name FROM clients WHERE id = ?", [clientId]) || {}).name || body.clientName;
    const id = uid("t");
    const referenceNumber = nextExchangeReference();
    tx(() => {
      run(
        `INSERT INTO exchange_transactions
         (id, date, client_id, client_name, from_account_id, to_account_id, amount_given, currency_given, amount_received, currency_received, rate_used, cost_rate, profit_usd, staff_id, staff_name, status, notes, void_reason, voided_by, voided_at, reference_number, cash_out_account_id, cash_in_account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,NULL,NULL,NULL,?,?,?)`,
        [id, txDate, clientId, resolvedClientName, fromAccount ? fromAccount.id : null, toAccount ? toAccount.id : null, given, currencyGiven, received, currencyReceived, rate, costRate, profitUsd, user.id, user.name, body.notes || null, referenceNumber, cashOutAccount ? cashOutAccount.id : null, cashInAccount ? cashInAccount.id : null]
      );
      if (fromAccount) {
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), fromAccount.id, "withdrawal", fromAccount.currency, given, 0, `Exchange: gave ${fmtMoney(given, currencyGiven)} for ${fmtMoney(received, currencyReceived)}`, user.id, user.name, txDate, "exchange", id]);
        rebuildAccountBalance(fromAccount.id, fromAccount.currency);
      }
      if (toAccount) {
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), toAccount.id, "deposit", toAccount.currency, received, 0, `Exchange: received ${fmtMoney(received, currencyReceived)} for ${fmtMoney(given, currencyGiven)}`, user.id, user.name, txDate, "exchange", id]);
        rebuildAccountBalance(toAccount.id, toAccount.currency);
      }
      // Cash in Hand legs — mirror the client-ledger legs exactly (withdraw
      // the given amount from Cash Out From, deposit the received amount
      // into Cash In To), tagged back to this same exchange id so Delete/
      // Update can find and reverse precisely these rows later, and so the
      // Cash Movements tab's rejectIfLinked guard routes any edit attempt
      // back to this Exchange instead of letting it be edited standalone.
      if (cashOutAccount) {
        run("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("csl"), cashOutAccount.id, "withdrawal", currencyGiven, given, 0, `Exchange ${referenceNumber}: ${resolvedClientName} gave ${fmtMoney(given, currencyGiven)}`, nextCashLedgerReference("withdrawal"), user.id, user.name, txDate, "exchange", id]);
        rebuildCashAccountBalance(cashOutAccount.id);
      }
      if (cashInAccount) {
        run("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("csl"), cashInAccount.id, "deposit", currencyReceived, received, 0, `Exchange ${referenceNumber}: ${resolvedClientName} received ${fmtMoney(received, currencyReceived)}`, nextCashLedgerReference("deposit"), user.id, user.name, txDate, "exchange", id]);
        rebuildCashAccountBalance(cashInAccount.id);
      }
    });
    const linkNote = fromAccount ? (toAccount ? ` — moved ${fmtMoney(given, currencyGiven)} from ${fromAccount.name} into linked account ${toAccount.name}` : ` — debited ${fmtMoney(given, currencyGiven)} from ${fromAccount.name}'s account`) : "";
    const cashNote = cashOutAccount || cashInAccount ? ` (Cash Account: ${cashOutAccount ? cashOutAccount.name : "—"} -> ${cashInAccount ? cashInAccount.name : "—"})` : "";
    addAudit(user, "Transaction recorded", `${resolvedClientName}: ${given} ${currencyGiven} -> ${received} ${currencyReceived}${linkNote}${cashNote}`);
    sendJSON(res, 201, { transaction: rowToJSON(get("SELECT * FROM exchange_transactions WHERE id = ?", [id]), can(user, "profit.viewExchange")) });
  });

  // EXCHANGE DELETE — PERMANENT FULL DATA DELETION. Replaces the old
  // "Void" flow entirely: there is no more soft-cancel that leaves a
  // "voided" row (plus a separate reversal entry) sitting in the database
  // forever. Delete means permanently gone — the exchange row itself, and
  // every account_ledger row it created, are removed for real; any real
  // balance effect is reversed first (by deleting the very ledger rows that
  // caused it and rebuilding from what's left, so the account lands back at
  // exactly its pre-exchange balance with no separate "reversal" entry
  // needed or left behind).
  router.delete("/api/transactions/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "exchangeDelete")) return;
    if (allowedCurrencies(user).length < 2) {
      return sendJSON(res, 403, { error: "You need access to both USD and SLSH accounts to delete a currency exchange." });
    }
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* an optional reason may be sent; no body at all is fine too */ }

    let deleted;
    try {
      // The entire operation — permission was already checked above, so from
      // here it's: lock/re-check status, reverse any real balance effect,
      // delete every child ledger row, delete the transaction itself, then
      // rebuild the affected accounts' balances — runs inside ONE database
      // transaction (tx() below is BEGIN/COMMIT/ROLLBACK), so a failure at
      // any step rolls back everything rather than leaving a partial delete.
      deleted = tx(() => {
        // Re-read the row *inside* the transaction rather than trusting a
        // lookup done before this call — this is what makes a double-click
        // (or two near-simultaneous delete requests) safe: node:sqlite runs
        // this whole synchronous callback to completion before any other
        // request's JS can run, so the second request's re-read here will
        // find nothing and fail cleanly instead of double-reversing balances
        // or erroring out on a row that's already gone.
        const t = get("SELECT * FROM exchange_transactions WHERE id = ?", [params.id]);
        if (!t) throw new TransactionMutationError(404, "Transaction not found.");
        // A transaction already voided under the old system was already
        // reversed at void time via a separate, untagged reversal ledger
        // entry (not linked back to this transaction's id) — deleting this
        // row's own tagged ledger entries now, on top of that, would double
        // the reversal and corrupt the account balance. There's nothing
        // further to do for one of these: it has no outstanding financial
        // effect left to reverse, so it's not eligible for this flow.
        if (t.status === "voided") throw new TransactionMutationError(400, "This transaction was already voided and has no remaining financial effect to reverse or delete.");

        const fromAcc = t.from_account_id ? get("SELECT id, currency FROM clients WHERE id = ?", [t.from_account_id]) : null;
        const toAcc = t.to_account_id ? get("SELECT id, currency FROM clients WHERE id = ?", [t.to_account_id]) : null;
        // EXCHANGE WORKSPACE round: same reversal for the optional Cash in
        // Hand legs — captured from the row itself before it's deleted.
        const cashOutId = t.cash_out_account_id, cashInId = t.cash_in_account_id;

        // Delete only the ledger rows this exchange itself created — never
        // anything else belonging to these accounts (DO NOT DELETE
        // UNRELATED DATA) — identified precisely by source_type/source_id,
        // not by account, date, or amount.
        run("DELETE FROM account_ledger WHERE source_type = 'exchange' AND source_id = ?", [t.id]);
        run("DELETE FROM cash_ledger WHERE source_type = 'exchange' AND source_id = ?", [t.id]);
        run("DELETE FROM exchange_transactions WHERE id = ?", [t.id]);
        // Rebuild replays every ledger row that's left for each account, in
        // order — with this exchange's own rows now gone, that naturally
        // restores the balance to exactly what it was before the exchange,
        // for an account that was never touched by this exchange at all
        // (status was 'active' but had no linked account — nothing to do).
        if (fromAcc) rebuildAccountBalance(fromAcc.id, fromAcc.currency);
        if (toAcc) rebuildAccountBalance(toAcc.id, toAcc.currency);
        if (cashOutId) rebuildCashAccountBalance(cashOutId);
        if (cashInId) rebuildCashAccountBalance(cashInId);
        return t;
      });
    } catch (e) {
      if (e instanceof TransactionMutationError) return e.status === 404 ? notFound(res, e.message) : badRequest(res, e.message);
      throw e;
    }
    const reasonNote = body.reason && body.reason.trim() ? ` — ${body.reason.trim()}` : "";
    addAudit(user, "Exchange deleted permanently", `${deleted.client_name}: ${fmtMoney(deleted.amount_given, deleted.currency_given)} -> ${fmtMoney(deleted.amount_received, deleted.currency_received)} (was ${deleted.status})${reasonNote}`);
    sendJSON(res, 200, { deleted: true, id: deleted.id });
  });

  // EXCHANGE UPDATE — every exchange takes financial effect the instant
  // it's created (see the EXCHANGE DELETE work above: there's no separate
  // "Accepted" step in this app's data model), so editing one that already
  // moved money has to be handled with the same care as deleting it. This
  // treats an edit as "undo the OLD effect, then apply the NEW one, in one
  // transaction": it deletes this exchange's own tagged ledger rows and
  // rebuilds whichever account(s) they belonged to (exactly what DELETE
  // does — that's what puts the OLD account(s) back to their pre-exchange
  // balance), THEN writes the edited fields onto the same
  // exchange_transactions row and re-posts fresh ledger rows — still tagged
  // to this same exchange id — against whichever account(s) the edited form
  // now points at. The exchange row itself is never deleted or recreated
  // (same id throughout), only its fields and its ledger effect change.
  router.patch("/api/transactions/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "exchangeUpdate")) return;
    if (allowedCurrencies(user).length < 2) {
      return sendJSON(res, 403, { error: "You need access to both USD and SLSH accounts to edit a currency exchange." });
    }
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }

    const given = Number(body.amountGiven);
    const currencyGiven = body.currencyGiven === "SLSH" ? "SLSH" : "USD";
    if (!body.clientName || !isValidAmount(given)) return badRequest(res, "clientName and a positive amountGiven are required.");
    const currencyReceived = currencyGiven === "USD" ? "SLSH" : "USD";
    const rate = body.rateUsed !== undefined && body.rateUsed !== "" && body.rateUsed !== null ? Number(body.rateUsed) : defaultRateFor(currencyGiven, getCurrentRates());
    if (!rate || rate <= 0 || !Number.isFinite(rate) || rate > 1e9) return badRequest(res, "Rate must be a positive number.");
    let received = body.amountReceived !== undefined && body.amountReceived !== "" && body.amountReceived !== null
      ? Number(body.amountReceived)
      : convert(given, currencyGiven, currencyReceived, rate);
    received = currencyReceived === "USD" ? Math.round(received * 100) / 100 : Math.round(received);
    if (!Number.isFinite(received) || received < 0 || received > MAX_AMOUNT) return badRequest(res, "The received amount must be a valid number within range.");
    // SALE RATE / EXCHANGE PROFIT round: same override-with-fallback as
    // the create route above — an explicit body.profitUsd always wins,
    // otherwise the edited amounts/rate are re-run through the current
    // Sale Rate spread rather than silently keeping whatever profit the
    // row happened to have before the edit.
    const profitOverride = body.profitUsd !== undefined && body.profitUsd !== null && body.profitUsd !== ""
      ? Number(body.profitUsd) || 0 : null;
    const costOverride = parseCostRate(body.costRate);
    if (costOverride === false) return badRequest(res, "Cost Rate must be a positive number.");

    // Same account-resolution and validation as creating a new exchange
    // (currency-separation rule included: the account must match its side's
    // currency exactly) — an edit can re-point either side of the exchange
    // to a different account entirely, not just change the amounts.
    // ACCOUNT PICKER DIRECTNESS round: From and Receiving are independent
    // picks (clientAccountId / receivingAccountId), not derived from the
    // From account's linked_account_id — see the matching comment on POST.
    let newFromAccount = null, newToAccount = null;
    if (body.clientAccountId) {
      newFromAccount = get("SELECT * FROM clients WHERE id = ?", [body.clientAccountId]);
      if (!newFromAccount) return notFound(res, "Selected account not found.");
      if (newFromAccount.status !== "active") return badRequest(res, `${newFromAccount.name}'s account is deactivated — reactivate it before exchanging on it.`);
      if (newFromAccount.currency !== currencyGiven) {
        return badRequest(res, `${newFromAccount.name}'s account is ${newFromAccount.currency} — "Currency given" must match it.`);
      }
    }
    if (body.receivingAccountId) {
      newToAccount = get("SELECT * FROM clients WHERE id = ?", [body.receivingAccountId]);
      if (!newToAccount) return notFound(res, "Selected receiving account not found.");
      if (newToAccount.status !== "active") return badRequest(res, `${newToAccount.name}'s account is deactivated — reactivate it before exchanging on it.`);
      if (newToAccount.currency !== currencyReceived) {
        return badRequest(res, `${newToAccount.name}'s account is ${newToAccount.currency} — "Currency received" must match it.`);
      }
    }

    // EXCHANGE WORKSPACE round: same optional Cash in Hand validation as
    // create — an edit can re-point Cash Out/Cash In to different accounts
    // entirely, or clear either one, same as it can re-point the client
    // account pair above.
    const cashOutResult = resolveExchangeCashAccount(body.cashOutAccountId, currencyGiven, "Cash Out From");
    if (cashOutResult.error) return badRequest(res, cashOutResult.error);
    const cashInResult = resolveExchangeCashAccount(body.cashInAccountId, currencyReceived, "Cash In To");
    if (cashInResult.error) return badRequest(res, cashInResult.error);
    const newCashOutAccount = cashOutResult.cashAccount, newCashInAccount = cashInResult.cashAccount;

    let result;
    try {
      // One database transaction end to end, same as DELETE: re-read and
      // re-check the row from inside it (safe against a double-click / two
      // near-simultaneous edits, for the same single-threaded-synchronous
      // reason DELETE's comment explains), undo the old effect, write the
      // new fields, re-apply the new effect, rebuild every account touched
      // either before or after the edit. Any failure rolls back the whole
      // thing — the row is never left half-old/half-new.
      result = tx(() => {
        const t = get("SELECT * FROM exchange_transactions WHERE id = ?", [params.id]);
        if (!t) throw new TransactionMutationError(404, "Transaction not found.");
        // Same reasoning as DELETE: a row voided under the old system has
        // an untagged, unlinked reversal already sitting in the ledger —
        // there's no clean "old effect" to undo here, so it's not eligible.
        if (t.status === "voided") throw new TransactionMutationError(400, "This transaction was voided under the old system and can no longer be edited.");

        const oldFromAccount = t.from_account_id ? get("SELECT id, currency FROM clients WHERE id = ?", [t.from_account_id]) : null;
        const oldToAccount = t.to_account_id ? get("SELECT id, currency FROM clients WHERE id = ?", [t.to_account_id]) : null;
        const oldCashOutId = t.cash_out_account_id, oldCashInId = t.cash_in_account_id;

        // Undo the OLD effect: delete only this exchange's own tagged
        // ledger rows (never unrelated data — DO NOT DELETE UNRELATED DATA)
        // and rebuild the old account(s) from what's left, exactly like
        // DELETE does. Do this before touching the row, so if the edit
        // turns out invalid there is nothing left half-applied.
        run("DELETE FROM account_ledger WHERE source_type = 'exchange' AND source_id = ?", [t.id]);
        run("DELETE FROM cash_ledger WHERE source_type = 'exchange' AND source_id = ?", [t.id]);
        if (oldFromAccount) rebuildAccountBalance(oldFromAccount.id, oldFromAccount.currency);
        if (oldToAccount) rebuildAccountBalance(oldToAccount.id, oldToAccount.currency);
        if (oldCashOutId) rebuildCashAccountBalance(oldCashOutId);
        if (oldCashInId) rebuildCashAccountBalance(oldCashInId);

        const clientId = newFromAccount ? newFromAccount.id : findOrCreateClient(body.clientName, body.clientContact, body.clientAddress, currencyGiven);
        const resolvedClientName = newFromAccount ? newFromAccount.name : (get("SELECT name FROM clients WHERE id = ?", [clientId]) || {}).name || body.clientName;
        const txDate = body.date ? new Date(body.date).toISOString() : t.date;
        // GLOBAL RATE & PROFIT round: an edit keeps the exchange's OWN Cost
        // Rate (stored, or the one that applied on its date) — never today's.
        const editCostRate = costOverride !== null ? costOverride : t.cost_rate;
        const valuedAt = editCostRate != null ? editCostRate : costRateAt(t.date);
        const editMargin = computeMargin({ currencyGiven, amountGiven: given, amountReceived: received, rate, costRate: valuedAt });
        const profitUsd = profitOverride !== null ? profitOverride
          : editMargin ? editMargin.usd : (Number(t.profit_usd) || 0);

        run(
          `UPDATE exchange_transactions
           SET date=?, client_id=?, client_name=?, from_account_id=?, to_account_id=?,
               amount_given=?, currency_given=?, amount_received=?, currency_received=?,
               rate_used=?, cost_rate=?, profit_usd=?, notes=?, cash_out_account_id=?, cash_in_account_id=?
           WHERE id = ?`,
          [txDate, clientId, resolvedClientName, newFromAccount ? newFromAccount.id : null, newToAccount ? newToAccount.id : null,
           given, currencyGiven, received, currencyReceived, rate, editCostRate, profitUsd, body.notes || null,
           newCashOutAccount ? newCashOutAccount.id : null, newCashInAccount ? newCashInAccount.id : null, t.id]
        );

        // Re-apply the NEW effect, tagged back to this same exchange id so
        // a later Delete (or another Update) still finds and reverses
        // exactly these rows.
        if (newFromAccount) {
          run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("ldg"), newFromAccount.id, "withdrawal", newFromAccount.currency, given, 0, `Exchange: gave ${fmtMoney(given, currencyGiven)} for ${fmtMoney(received, currencyReceived)}`, user.id, user.name, txDate, "exchange", t.id]);
          rebuildAccountBalance(newFromAccount.id, newFromAccount.currency);
        }
        if (newToAccount) {
          run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("ldg"), newToAccount.id, "deposit", newToAccount.currency, received, 0, `Exchange: received ${fmtMoney(received, currencyReceived)} for ${fmtMoney(given, currencyGiven)}`, user.id, user.name, txDate, "exchange", t.id]);
          rebuildAccountBalance(newToAccount.id, newToAccount.currency);
        }
        if (newCashOutAccount) {
          run("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("csl"), newCashOutAccount.id, "withdrawal", currencyGiven, given, 0, `Exchange ${t.reference_number}: ${resolvedClientName} gave ${fmtMoney(given, currencyGiven)}`, nextCashLedgerReference("withdrawal"), user.id, user.name, txDate, "exchange", t.id]);
          rebuildCashAccountBalance(newCashOutAccount.id);
        }
        if (newCashInAccount) {
          run("INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, staff_id, staff_name, date, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("csl"), newCashInAccount.id, "deposit", currencyReceived, received, 0, `Exchange ${t.reference_number}: ${resolvedClientName} received ${fmtMoney(received, currencyReceived)}`, nextCashLedgerReference("deposit"), user.id, user.name, txDate, "exchange", t.id]);
          rebuildCashAccountBalance(newCashInAccount.id);
        }

        return { before: t, after: get("SELECT * FROM exchange_transactions WHERE id = ?", [t.id]) };
      });
    } catch (e) {
      if (e instanceof TransactionMutationError) return e.status === 404 ? notFound(res, e.message) : badRequest(res, e.message);
      throw e;
    }

    const { before, after } = result;
    addAudit(user, "Exchange updated", `${before.client_name}: ${fmtMoney(before.amount_given, before.currency_given)} -> ${fmtMoney(before.amount_received, before.currency_received)} changed to ${after.client_name}: ${fmtMoney(after.amount_given, after.currency_given)} -> ${fmtMoney(after.amount_received, after.currency_received)}`);
    sendJSON(res, 200, { transaction: rowToJSON(after, can(user, "profit.viewExchange")) });
  });

  router.get("/api/transactions/daily-log", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (allowedCurrencies(user).length < 2) {
      return sendJSON(res, 200, { date: query.date || todayStr(), openUSD: 0, openSLSH: 0, closeUSD: 0, closeSLSH: 0, transactions: [] });
    }
    const includeProfit = can(user, "profit.viewExchange");
    const date = query.date || todayStr();
    const rows = queryTransactions(user, {}); // full scoped history (no date filter) to compute balances
    const ob = get("SELECT usd, slsh FROM opening_balances WHERE id = 1") || { usd: 0, slsh: 0 };
    let openUSD = ob.usd, openSLSH = ob.slsh;
    for (const t of rows) {
      if (t.status !== "active" || t.date.slice(0, 10) >= date) continue;
      if (t.currency_given === "USD") openUSD += t.amount_given; else openSLSH += t.amount_given;
      if (t.currency_received === "USD") openUSD -= t.amount_received; else openSLSH -= t.amount_received;
    }
    const today = rows.filter((t) => t.date.slice(0, 10) === date);
    let closeUSD = openUSD, closeSLSH = openSLSH;
    for (const t of today) {
      if (t.status !== "active") continue;
      if (t.currency_given === "USD") closeUSD += t.amount_given; else closeSLSH += t.amount_given;
      if (t.currency_received === "USD") closeUSD -= t.amount_received; else closeSLSH -= t.amount_received;
    }
    sendJSON(res, 200, { date, openUSD, openSLSH, closeUSD, closeSLSH, transactions: today.map((t) => rowToJSON(t, includeProfit)) });
  });

  router.get("/api/transactions/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (allowedCurrencies(user).length < 2) return sendCSV(res, "obo-exchange-transactions.csv", toCSV(["Reference", "Date", "Client", "Amount given", "Currency given", "Amount received", "Currency received", "Rate used", "Staff", "Status", "Notes"], []));
    const includeProfit = can(user, "profit.viewExchange");
    const rows = queryTransactions(user, query);
    // Profit column is entirely OMITTED (not blanked) when the caller lacks
    // profit.viewExchange — same "never expose the value at all" rule as
    // rowToJSON above, applied to the CSV export.
    // REPLACE MANUAL REFERENCES round: Reference is the first column,
    // using the same official reference_number every other Exchange surface
    // (ExchangeDetailView, the receipt PDF, the list table) already shows.
    const headers = includeProfit
      ? ["Reference", "Date", "Client", "Amount given", "Currency given", "Amount received", "Currency received", "Rate used", "Profit (USD)", "Staff", "Status", "Notes"]
      : ["Reference", "Date", "Client", "Amount given", "Currency given", "Amount received", "Currency received", "Rate used", "Staff", "Status", "Notes"];
    const csv = toCSV(
      headers,
      rows.map((t) => {
        const base = [t.reference_number || t.id, t.date, t.client_name, t.amount_given, t.currency_given, t.amount_received, t.currency_received, t.rate_used];
        if (includeProfit) base.push(t.profit_usd);
        base.push(t.staff_name, t.status, t.notes || "");
        return base;
      })
    );
    addAudit(user, "Exchange transactions exported (CSV)", `${rows.length} record(s)`);
    sendCSV(res, "obo-exchange-transactions.csv", csv);
  });

  router.get("/api/transactions/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    const rows = allowedCurrencies(user).length < 2 ? [] : queryTransactions(user, query);
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Money Exchange Ledger",
      meta: `${rows.length} transaction(s)`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("exchange"),
      columns: [
        // REPLACE MANUAL REFERENCES round: same new Reference column as the CSV export above.
        { label: "Reference", width: 1.1 }, { label: "Date", width: 1.1 }, { label: "Client", width: 1.4 }, { label: "Given", width: 1.1, align: "right" },
        { label: "Received", width: 1.1, align: "right" }, { label: "Staff", width: 1 }, { label: "Status", width: 0.8 },
      ],
      rows: rows.map((t) => [t.reference_number || t.id, t.date.slice(0, 10), t.client_name, `${t.amount_given} ${t.currency_given}`, `${t.amount_received} ${t.currency_received}`, t.staff_name, t.status]),
    });
    addAudit(user, "Exchange ledger exported (PDF)", `${rows.length} transaction(s)`);
    sendPDF(res, "obo-exchange-ledger.pdf", pdf);
  });

  // MASTER PROMPT — per-transaction Money Exchange receipt (new document
  // type; there was no per-row export before). Scoped by the same role
  // restriction as every other transactions route (cashiers without
  // exchangeAll only ever see their own transactions), and profit is
  // included ONLY when the caller holds profit.viewExchange — mirroring the
  // CSV export's "omit entirely, don't just hide" rule. PDF/Excel both
  // render from the exact same rowToJSON() shape the rest of the module
  // already uses, so a receipt can never disagree with the list view.
  router.get("/api/transactions/:id/receipt.pdf", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    const row = get("SELECT * FROM exchange_transactions WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Transaction not found.");
    if (!can(user, "exchangeAll") && row.staff_id !== user.id) return notFound(res, "Transaction not found.");
    const canViewProfit = can(user, "profit.viewExchange");
    const tx = rowToJSON(row, canViewProfit);
    const pdf = await renderExchangeReceiptPDF({
      company: getCompanySettings(), tx, dailyRate: getCurrentRate(), saleRate: getCurrentSaleRate(), canViewProfit, generatedBy: user.name,
      template: getDefaultPdfTemplate("exchange"),
    });
    addAudit(user, "Exchange receipt exported (PDF)", tx.referenceNumber || tx.id);
    sendPDF(res, `${tx.referenceNumber || tx.id}.pdf`, pdf);
  });

  router.get("/api/transactions/:id/receipt.xlsx", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    const row = get("SELECT * FROM exchange_transactions WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Transaction not found.");
    if (!can(user, "exchangeAll") && row.staff_id !== user.id) return notFound(res, "Transaction not found.");
    const canViewProfit = can(user, "profit.viewExchange");
    const tx = rowToJSON(row, canViewProfit);
    const xlsx = await buildExchangeReceiptWorkbook({
      company: getCompanySettings(), tx, dailyRate: getCurrentRate(), saleRate: getCurrentSaleRate(), canViewProfit, generatedBy: user.name,
      template: getDefaultExcelTemplate("exchange"),
    });
    addAudit(user, "Exchange receipt exported (Excel)", tx.referenceNumber || tx.id);
    sendXLSX(res, `${tx.referenceNumber || tx.id}.xlsx`, xlsx);
  });
}

module.exports = { register, queryTransactions, rowToJSON };
