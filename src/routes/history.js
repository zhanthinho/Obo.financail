"use strict";
const { all, get } = require("../db");
const { sendJSON, sendCSV, sendPDF, sendXLSX } = require("../http-helpers");
const { requireAuth, requirePerm, can, allowedCurrencies } = require("../rbac");
const { computeMargin } = require("../exchange-calc");
const { costRateLookup } = require("../domain");
const { getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, quotationPaymentSummary, addAudit } = require("../domain");
const { fmtMoney, chronoSortKey } = require("../util");
const { toCSV } = require("../csv");
const { renderReportPDF, renderTransactionStatementPDF } = require("../pdf");
const { buildTransactionStatementWorkbook } = require("../xlsx-documents");
const { rowToJSON: transactionRowToJSON } = require("./transactions");
const { rowToJSON: transferRowToJSON } = require("./transfers");

// BUGFIX — mixed date formats silently pushed real rows out of view:
// account_ledger.date holds a bare "YYYY-MM-DD" for anything that went
// through resolvePaymentDate (quotation payments, and any deposit/
// withdrawal/transfer with a manually-picked Payment Date — see
// src/util.js), but a full ISO timestamp ("...T07:42:59.911Z") for
// everything created via nowISO() (a quotation's original charge, an
// exchange, etc.). Both this module's own final sort and the frontend
// table's default "newest first" sort compare `date` as a plain string —
// and "2026-09-28" is LESS than "2026-09-28T07:42:59.911Z" in a plain
// string compare (a prefix always sorts before the longer string it's a
// prefix of), regardless of what time of day the timestamped row actually
// happened. The practical effect: a quotation-payment row always sorted
// as if it were "older" than every other same-day timestamped entry, no
// matter how recent — with 60+ other entries on a busy day, that could
// bury a real payment dozens of rows down, looking indistinguishable from
// "missing" (see the QT-2026-0017 report: the payment rows had already
// been confirmed correctly recorded and correctly tagged, but were never
// scrolled to). Padding every date-only value to explicit UTC midnight
// makes every `date` field the same fixed-width ISO shape, so plain string
// comparison sorts them correctly everywhere this field is used.
function normalizeHistoryDate(d) {
  if (!d) return d;
  return d.length === 10 ? `${d}T00:00:00.000Z` : d;
}

// Builds one merged, normalized list across exchange_transactions,
// transfers, quotations (their account_ledger legs), and plain (unlinked)
// deposits/withdrawals, so the whole history can be searched and filtered
// the same way regardless of record kind. This is the UNIFIED TRANSACTION
// HISTORY module — every row also carries a `raw` object shaped exactly
// like the record's own type-specific API response (transactions.js'/
// transfers.js' own rowToJSON, or the plain ledger entry shape used by
// EditLedgerEntryModal/DeleteLedgerEntryModal), so the frontend's row-click
// Detail view can drive each type's *own* existing Update/Delete flow
// (AddTxModal, TransferModal, EditLedgerEntryModal…) without a second
// round-trip and without reimplementing any type's mutation logic here —
// see the landmine note in ledger.js: a quotation/exchange/transfer-tagged
// ledger leg must NEVER be mutated through the generic /api/account-ledger
// endpoints, only through its own type's endpoint.
// The tabs of the unified Transaction History, each a filter over the same
// rows. "All" = original business records only (Payments, Exchanges,
// Transfers, Quotation charges / payments / refunds, Cash Account
// transactions) — the account postings and Cash Account entries an
// Exchange / Transfer / Payment creates are its effects, shown under
// Credits, Debits and Cash Account, never as extra originals.
const TAB_FILTERS = {
  all: (e) => e.recordType === "exchange" || e.recordType === "transfer" || e.recordType === "quotation" || (e.recordType === "ledger" && e.origin === "payment") || (e.recordType === "cash" && e.cashOriginal),
  payment: (e) => e.recordType === "ledger" && e.origin === "payment",
  exchange: (e) => e.recordType === "exchange",
  transfer: (e) => e.recordType === "transfer",
  quotation: (e) => e.recordType === "quotation",
  quotation_charge: (e) => e.recordType === "quotation" && e.sourceType === "quotation_charge" && e.ledgerType === "withdrawal",
  quotation_payment: (e) => e.recordType === "quotation" && e.sourceType === "quotation_paid",
  deposit: (e) => e.recordType === "ledger" && e.ledgerType === "deposit",
  withdrawal: (e) => e.recordType === "ledger" && e.ledgerType === "withdrawal",
  cash: (e) => e.recordType === "cash",
};

function queryHistory(query, opts = {}) {
  // GLOBAL RATE & PROFIT round: exchange rows carry their own rate, Cost
  // Rate and margin — only for users allowed to see exchange profit.
  const includeProfit = !!opts.includeProfit;
  const lookup = includeProfit ? costRateLookup() : null;
  // PROFESSIONAL TRANSACTION MANAGEMENT round: every source is read once
  // (the "universe": original records + every account-ledger effect + every
  // Cash Account entry), the other filters are applied, and the tab is a
  // predicate over that set (TAB_FILTERS) — so tab counts and summary cards
  // come from the same rows and nothing is ever counted twice.
  const type = TAB_FILTERS[query.type] ? query.type : "all";
  const includeCash = !!opts.includeCash;
  const accountType = query.accountType && query.accountType !== "all" ? query.accountType : null;
  const currency = query.currency && ["USD", "SLSH"].includes(query.currency) ? query.currency : null;
  const from = query.from, to = query.to;
  const search = (query.search || "").trim().toLowerCase();
  const status = query.status && query.status !== "all" ? query.status.toLowerCase() : null;
  const staffId = query.staffId || null;
  const accountId = query.accountId || null;
  let entries = [];

  {
    const clauses = [], params = [];
    if (from) { clauses.push("date(t.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(t.date) <= date(?)"); params.push(to); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(`SELECT t.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency, fa.account_number AS from_account_number, ta.account_number AS to_account_number FROM exchange_transactions t LEFT JOIN clients fa ON fa.id = t.from_account_id LEFT JOIN clients ta ON ta.id = t.to_account_id LEFT JOIN clients c ON c.id = t.client_id ${where}`, params);
    entries.push(...rows.map((t) => ({
      id: t.id, sortKey: chronoSortKey(t.date, t.created_at), recordType: "exchange", reference: t.reference_number || t.id.slice(0, 10), date: normalizeHistoryDate(t.date),
      // IMPORTANT: accountCurrency for an exchange must come from the
      // transaction's own currency_given column, NEVER from the client's
      // static clients.currency field. A walk-in client (typed name, no
      // linked account) is created via findOrCreateClient with no currency
      // context, so clients.currency for them is just the schema default —
      // it does not reflect what currency THIS exchange actually moved.
      // Using currency_given is always correct even for a real linked
      // account: account creation enforces fromAccount.currency ===
      // currencyGiven, so the two never disagree there either. Getting this
      // wrong previously let a SLSH-given walk-in exchange masquerade as a
      // USD row and corrupt the USD Transaction History balance footer with
      // a SLSH-magnitude number (see GLOBAL TABLE UX round changelog).
      accountName: t.client_name, accountType: t.client_account_type || "customer", accountCurrency: t.currency_given, phone: t.client_phone || "",
      accountNumber: [t.from_account_number, t.to_account_number].filter(Boolean).join(" "),
      amountSummary: `${fmtMoney(t.amount_given, t.currency_given)} -> ${fmtMoney(t.amount_received, t.currency_received)}`,
      status: t.status, staffOrCreator: t.staff_name, staffId: t.staff_id, accountId: t.client_id, notes: t.notes,
      rate: t.rate_used,
      ...(includeProfit ? (() => {
        const costRate = t.cost_rate != null ? t.cost_rate : lookup(t.date);
        const m = computeMargin({ currencyGiven: t.currency_given, amountGiven: t.amount_given, amountReceived: t.amount_received, rate: t.rate_used, costRate });
        return { costRate, costRateSource: t.cost_rate != null ? "stored" : costRate != null ? "history" : null, marginSide: t.currency_given === "USD" ? "buy" : "sell", marginSlsh: m ? m.slsh : null, profitUsd: t.profit_usd };
      })() : {}),
      raw: transactionRowToJSON(t, includeProfit, lookup),
    })));
  }
  // TWO-STEP ACCOUNT LEDGER LOGIC: a quotation now posts TWO real, linked
  // account-ledger legs — an immediate Withdrawal the instant it's created
  // (tagged "quotation_charge"), and a settlement Deposit once it's marked
  // Paid ("quotation_paid") or Refunded ("quotation_refund"). Both legs are
  // real money movements, both carry the quotation's own number as their
  // reference (stored directly on the ledger row as reference_number, NOT
  // looked up via a join — a quotation DOCUMENT can be deleted once it's
  // settled, and both ledger legs must keep showing their reference number
  // even then), and both stay visible here permanently — the original
  // Withdrawal is never replaced, hidden, or deleted once the settlement
  // Deposit exists. (There is no separate "quotation document" row here
  // anymore — these two ledger rows ARE its financial history; the
  // Quotations module itself remains where you view/manage the document —
  // exactly the "source-module link" a Transaction History row for one of
  // these routes Update/Delete to instead of editing the ledger leg directly.)
  {
    const clauses = ["l.source_type IN ('quotation_charge','quotation_paid','quotation_refund')"], params = [];
    // QUOTATION PAYMENT INTEGRATION round (spec: "each payment must be an
    // independent transaction, filterable on its own"): a dedicated
    // "Quotation Payments" view narrows this same query down to just the
    // settlement deposits (source_type='quotation_paid') — never the
    // original charge or a refund — so it answers "show me only money that
    // actually came IN against quotations."
    if (from) { clauses.push("date(l.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(l.date) <= date(?)"); params.push(to); }
    const where = "WHERE " + clauses.join(" AND ");
    // BUGFIX: this used to hardcode the row's status purely from source_type
    // — every "quotation_paid" leg (a settlement Deposit) was always labeled
    // "Paid", even when it was only a PARTIAL payment that left the
    // quotation at "Partially Paid" (spec: quotations can now receive any
    // number of partial payments — see recordQuotationPayment). That made a
    // partial payment's Transaction History row silently show "Paid" —
    // never "Partially Paid" — so filtering History by status
    // "Partially Paid" always came back empty and the row looked like a
    // full settlement even though money was still owed. Joining the
    // quotations table and using its own live `status` column (which
    // recordQuotationPayment already keeps correctly in sync — Pending /
    // Partially Paid / Paid / Refunded) fixes every one of that quotation's
    // ledger rows (charge, each partial payment, and any eventual refund)
    // to reflect its REAL current settlement state instead of a
    // one-size-fits-all guess from source_type alone.
    //
    // QUOTATION PAYMENT INTEGRATION round also joins quotation_payments (via
    // the ledger row's own id, which recordQuotationPayment always stores as
    // that payment's ledger_id) purely to surface its Payment Method on this
    // row — every other field a payment needs (amount, currency, date,
    // staff, reference) already lives directly on the ledger row itself.
    const rows = all(
      `SELECT l.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency, c.name AS client_name, c.account_number AS client_account_number,
              q.status AS quotation_status, q.number AS quotation_number, q.charged_amount AS quotation_total,
              p.method AS payment_method
       FROM account_ledger l
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN quotations q ON q.id = l.source_id
       LEFT JOIN quotation_payments p ON p.ledger_id = l.id
       ${where}`,
      params
    );
    // Remaining balance is only meaningful as a CURRENT figure (the spec's
    // own examples show it changing after each subsequent payment), so it's
    // computed once per distinct quotation touched here rather than stored
    // redundantly on every ledger row — quotationPaymentSummary is the same
    // single source of truth every other surface (the quotation itself, its
    // PDF/Excel) already reads from.
    const remainingCache = new Map();
    function remainingFor(quotationId) {
      if (!quotationId) return null;
      if (remainingCache.has(quotationId)) return remainingCache.get(quotationId);
      const q = get("SELECT * FROM quotations WHERE id = ?", [quotationId]);
      const remaining = q ? quotationPaymentSummary(q, all("SELECT amount FROM quotation_payments WHERE quotation_id = ?", [quotationId])).remaining : null;
      remainingCache.set(quotationId, remaining);
      return remaining;
    }
    entries.push(...rows.map((l) => ({
      id: l.id, sortKey: chronoSortKey(l.date, l.created_at), recordType: "quotation", ledgerType: l.type,
      // Every quotation-tagged ledger row is distinguished ONLY by its own
      // source_type from here on — see historyTypeLabel below — never
      // guessed from the quotation's current (and constantly-changing)
      // status. This is what fixes a refund credit and a real partial
      // payment both being mislabeled "Quotation Settlement" (they're
      // indistinguishable from source_type alone under the OLD status-based
      // guess, since both are Deposit legs).
      sourceType: l.source_type,
      reference: l.reference_number || l.id.slice(0, 10), date: normalizeHistoryDate(l.date),
      accountName: l.client_name || "—", accountType: l.client_account_type || "customer", accountCurrency: l.client_currency || l.currency, phone: l.client_phone || "", accountNumber: l.client_account_number || "", balanceAfter: l.balance_after == null ? null : Number(l.balance_after),
      amountSummary: fmtMoney(l.amount, l.currency),
      // Fall back to the old source_type-based guess only if the quotation
      // document itself has since been deleted (q.status comes back NULL
      // from the LEFT JOIN) — the ledger rows themselves are permanent even
      // then (see the comment above this block), so history still needs
      // something sensible to show.
      status: l.quotation_status || (l.source_type === "quotation_charge" ? "Pending" : l.source_type === "quotation_paid" ? "Paid" : "Refunded"),
      staffOrCreator: l.staff_name, staffId: l.staff_id, accountId: l.client_id, notes: l.notes,
      quotationNumber: l.quotation_number || l.reference_number,
      quotationTotal: l.quotation_total,
      paymentMethod: l.payment_method,
      remaining: remainingFor(l.source_id),
      raw: {
        id: l.id, quotationId: l.source_id, ledgerType: l.type, amount: l.amount, currency: l.currency, notes: l.notes, date: l.date, accountName: l.client_name,
        sourceType: l.source_type, quotationNumber: l.quotation_number || l.reference_number, paymentMethod: l.payment_method, remaining: remainingFor(l.source_id),
      },
    })));
  }
  // A Transfer moves money between two accounts (same currency) — shown as
  // one row keyed to the SOURCE account, with the destination named in the
  // amount summary, mirroring how an Exchange is one row per client. An
  // Account filter still matches a Transfer that only names an account as
  // the destination (see accountId filtering below).
  {
    const clauses = [], params = [];
    if (from) { clauses.push("date(t.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(t.date) <= date(?)"); params.push(to); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(
      `SELECT t.*, fc.name AS from_name, fc.account_type AS from_account_type, fc.currency AS from_currency, fc.contact AS from_phone, fc.account_number AS from_number, tc.account_number AS to_number, tc.name AS to_name
       FROM transfers t LEFT JOIN clients fc ON fc.id = t.from_account_id LEFT JOIN clients tc ON tc.id = t.to_account_id ${where}`,
      params
    );
    entries.push(...rows.map((t) => ({
      id: t.id, sortKey: chronoSortKey(t.date, t.created_at), recordType: "transfer", reference: t.reference_number || t.id.slice(0, 10), date: normalizeHistoryDate(t.date),
      accountName: t.from_name || "—", accountType: t.from_account_type || "customer", accountCurrency: t.from_currency || t.currency, phone: t.from_phone || "", accountNumber: [t.from_number, t.to_number].filter(Boolean).join(" "), counterpartyName: t.to_name || null,
      amountSummary: `${fmtMoney(t.amount, t.currency)} -> ${t.to_name || "—"}`,
      status: t.status, staffOrCreator: t.staff_name, staffId: t.staff_id, accountId: t.from_account_id, counterpartAccountId: t.to_account_id, notes: t.notes,
      raw: transferRowToJSON(t),
    })));
  }
  // Plain (unlinked) deposits/withdrawals — a real manual movement with no
  // source_type/source_id tag at all, the one bucket the pre-Round-1 history
  // never surfaced. Its Update/Delete route to the generic
  // /api/account-ledger/:id endpoints (guarded in ledger.js to only ever
  // accept a row exactly like this one — untagged).
  // Every account-ledger posting (the Credits / Debits view). A posting with
  // no source_type is itself a Payment (Payment module credit/debit, opening
  // balance); one with a source is an effect of an Exchange, Transfer or
  // Quotation — listed under Credits/Debits with its origin and the
  // original's reference, never as a second original record.
  {
    const clauses = ["(l.source_type IS NULL OR l.source_type IN ('exchange','transfer','quotation_charge','quotation_paid','quotation_refund'))"];
    const params = [];
    if (from) { clauses.push("date(l.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(l.date) <= date(?)"); params.push(to); }
    const rows = all(
      `SELECT l.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency, c.name AS client_name, c.account_number AS client_account_number,
              x.reference_number AS exchange_ref, tr.reference_number AS transfer_ref, ca.name AS cash_name
       FROM account_ledger l LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN exchange_transactions x ON l.source_type = 'exchange' AND x.id = l.source_id
       LEFT JOIN transfers tr ON l.source_type = 'transfer' AND tr.id = l.source_id
       LEFT JOIN cash_accounts ca ON ca.id = l.cash_account_id
       WHERE ${clauses.join(" AND ")}`,
      params
    );
    entries.push(...rows.map((l) => {
      const origin = !l.source_type ? "payment" : l.source_type.startsWith("quotation") ? "quotation" : l.source_type;
      return {
        id: l.id, sortKey: chronoSortKey(l.date, l.created_at), recordType: "ledger", ledgerType: l.type, origin, sourceType: l.source_type || null, sourceId: l.source_id || null,
        relatedReference: origin === "exchange" ? l.exchange_ref : origin === "transfer" ? l.transfer_ref : origin === "quotation" ? l.reference_number : null,
        reference: l.reference_number || (origin === "exchange" && l.exchange_ref) || (origin === "transfer" && l.transfer_ref) || l.id.slice(0, 10), date: normalizeHistoryDate(l.date),
        accountName: l.client_name || "—", accountType: l.client_account_type || "customer", accountCurrency: l.client_currency || l.currency, phone: l.client_phone || "", accountNumber: l.client_account_number || "", balanceAfter: l.balance_after == null ? null : Number(l.balance_after),
        amountSummary: fmtMoney(l.amount, l.currency),
        status: null, staffOrCreator: l.staff_name, staffId: l.staff_id, accountId: l.client_id, notes: l.notes,
        cashAccountId: l.cash_account_id || null, cashAccountName: l.cash_name || null,
        raw: { id: l.id, type: l.type, accountName: l.client_name || "—", amount: l.amount, currency: l.currency, notes: l.notes, date: l.date, origin, cashAccountName: l.cash_name || null },
      };
    }));
  }
  // Cash Account entries (only for users who may see Cash Accounts). An
  // entry that is the cash side of a Payment or an Exchange is that record's
  // effect (cashOriginal = false); manual cash movements, expenses, loans,
  // opening balances and the sending side of a Cash Account exchange or Cash
  // Account transfer are original records of their own.
  if (includeCash) {
    const clauses = [], params = [];
    if (from) { clauses.push("date(cl.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(cl.date) <= date(?)"); params.push(to); }
    const rows = all(
      `SELECT cl.*, ca.name AS cash_name, c.name AS cp_name, c.account_type AS cp_type, c.account_number AS cp_number, c.contact AS cp_phone,
              x.reference_number AS exchange_ref, al.reference_number AS payment_ref
       FROM cash_ledger cl JOIN cash_accounts ca ON ca.id = cl.cash_account_id
       LEFT JOIN clients c ON c.id = cl.counterparty_client_id
       LEFT JOIN exchange_transactions x ON cl.source_type = 'exchange' AND x.id = cl.source_id
       LEFT JOIN account_ledger al ON cl.source_type = 'customer_payment' AND al.id = cl.source_id
       ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}`,
      params
    );
    const CASH_LABEL = { expense: "Expense", expense_reversal: "Expense Reversal", loan: "Loan", loan_repayment: "Loan Repayment", opening_balance: "Opening Balance", cash_transfer: "Cash Transfer", cash_exchange: "Cash Exchange", customer_payment: "Payment", exchange: "Exchange" };
    entries.push(...rows.map((cl) => {
      const src = cl.source_type || null;
      const cashOriginal = !src || ["expense", "expense_reversal", "loan", "loan_repayment", "opening_balance"].includes(src) || ((src === "cash_transfer" || src === "cash_exchange") && cl.type === "withdrawal");
      return {
        id: cl.id, sortKey: chronoSortKey(cl.date, cl.created_at), recordType: "cash", ledgerType: cl.type, origin: src || "cash", sourceType: src, sourceId: cl.source_id || null, cashOriginal,
        cashLabel: CASH_LABEL[src] || (cl.type === "deposit" ? "Cash In" : "Cash Out"),
        relatedReference: src === "exchange" ? cl.exchange_ref : src === "customer_payment" ? cl.payment_ref : null,
        reference: cl.reference_number || cl.id.slice(0, 10), date: normalizeHistoryDate(cl.date),
        accountName: cl.cash_name, accountType: "cash", accountCurrency: cl.currency, phone: cl.cp_phone || "", accountNumber: cl.cp_number || "", balanceAfter: cl.balance_after == null ? null : Number(cl.balance_after),
        amountSummary: `${cl.type === "deposit" ? "+" : "-"}${fmtMoney(cl.amount, cl.currency)}`,
        status: null, staffOrCreator: cl.staff_name, staffId: cl.staff_id, accountId: cl.counterparty_client_id || null, cashAccountId: cl.cash_account_id, cashAccountName: cl.cash_name,
        counterpartyName: cl.cp_name || cl.counterparty_label || null, notes: cl.description,
        raw: { id: cl.id, type: cl.type, amount: cl.amount, currency: cl.currency, notes: cl.description, date: cl.date, cashAccountName: cl.cash_name, counterparty: cl.cp_name || cl.counterparty_label || null, sourceType: src },
      };
    }));
  }
  if (accountType) entries = entries.filter((e) => e.accountType === accountType);
  if (currency) entries = entries.filter((e) => e.accountCurrency === currency);
  if (status) entries = entries.filter((e) => (e.status || "").toLowerCase() === status);
  if (staffId) entries = entries.filter((e) => e.staffId === staffId);
  if (accountId) entries = entries.filter((e) => e.accountId === accountId || e.counterpartAccountId === accountId);
  // CROSS-CURRENCY CUSTOMER LINKING round: every account of one customer
  // profile (combined history; filter by currency as usual).
  if (query.customerId) {
    const ids = new Set(all("SELECT id FROM clients WHERE customer_id = ?", [query.customerId]).map((r) => r.id));
    entries = entries.filter((e) => ids.has(e.accountId) || ids.has(e.counterpartAccountId));
  }
  if (search) {
    entries = entries.filter((e) =>
      e.reference.toLowerCase().includes(search) ||
      e.accountName.toLowerCase().includes(search) ||
      (e.phone || "").toLowerCase().includes(search) ||
      (e.staffOrCreator || "").toLowerCase().includes(search) ||
      (e.notes || "").toLowerCase().includes(search) ||
      (e.accountNumber || "").toLowerCase().includes(search) ||
      (e.relatedReference || "").toLowerCase().includes(search) ||
      (e.cashAccountName || "").toLowerCase().includes(search) ||
      (e.counterpartyName || "").toLowerCase().includes(search) ||
      (e.quotationNumber || "").toLowerCase().includes(search)
    );
  }
  if (opts.universe) return sortHistory(entries);
  entries = entries.filter(TAB_FILTERS[type]);
  return sortHistory(entries);
}
function sortHistory(entries) {
  // NEWEST-FIRST round: latest entry first; same-day entries by real insert time, then id.
  entries.sort((a, b) => (a.sortKey === b.sortKey ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.sortKey < b.sortKey ? 1 : -1)));
  return entries;
}

// Mirrors the frontend's typeLabelFor() so CSV/PDF exports read the same
// human labels shown on screen, rather than the raw recordType/ledgerType.
// QUOTATION PAYMENT INTEGRATION round: mirrors the frontend's own
// historyTypeLabelFor() exactly — both now switch on the ledger row's own
// sourceType, never on the quotation's current (constantly-changing)
// status, so a real payment ("Quotation Payment") and a refund credit
// ("Quotation Refund") are never both mislabeled the same generic
// "Quotation Settlement" the way the old status-based guess did (both are
// Deposit legs, so status/ledgerType alone can't tell them apart).
function historyTypeLabel(e) {
  if (e.recordType === "quotation") {
    if (e.sourceType === "quotation_paid") return "Quotation Payment";
    if (e.sourceType === "quotation_refund") return "Quotation Refund";
    // quotation_charge: a Withdrawal is the original charge; a Deposit under
    // this same source_type is a downward revision made via Update while
    // still Pending (see recordQuotationPayment vs. the PATCH handler in
    // routes/quotations.js) — never an actual payment.
    return e.ledgerType === "withdrawal" ? "Quotation Charge" : "Quotation Adjustment";
  }
  if (e.recordType === "ledger") {
    const dir = e.ledgerType === "withdrawal" ? "Debit" : "Credit";
    if (!e.origin || e.origin === "payment") return dir;
    if (e.origin === "quotation") return historyTypeLabel({ ...e, recordType: "quotation" });
    return `${e.origin === "exchange" ? "Exchange" : "Transfer"} ${dir}`;
  }
  if (e.recordType === "cash") return e.cashLabel || "Cash Account";
  return { exchange: "Exchange", transfer: "Transfer" }[e.recordType] || e.recordType;
}

// MASTER PROMPT — a currency-aware Deposits/Withdrawals/Net-Movement summary
// over a filtered set of history entries, for the new Transaction Statement
// document (PDF + Excel). Only entries with a genuine, currency-tagged
// deposit/withdrawal amount (plain ledger rows and quotation charge/
// settlement legs) participate in these three totals — an Exchange or
// Transfer doesn't have simple deposit/withdrawal semantics (it moves money
// between two sides at once), so those still count toward
// totalTransactions but aren't force-fit into a deposit/withdrawal bucket.
function computeHistoryTotals(entries) {
  const deposits = { USD: 0, SLSH: 0 };
  const withdrawals = { USD: 0, SLSH: 0 };
  for (const e of entries) {
    const raw = e.raw || {};
    const amount = Number(raw.amount);
    const currency = raw.currency;
    if (!amount || !currency || !(currency in deposits)) continue;
    const isDeposit = e.recordType === "ledger" ? e.ledgerType === "deposit" : e.recordType === "quotation" ? e.ledgerType !== "withdrawal" : null;
    if (isDeposit === true) deposits[currency] += amount;
    else if (isDeposit === false) withdrawals[currency] += amount;
  }
  const fmtMap = (map) => {
    const parts = [];
    if (map.USD) parts.push(fmtMoney(map.USD, "USD"));
    if (map.SLSH) parts.push(fmtMoney(Math.round(map.SLSH), "SLSH"));
    return parts.length ? parts.join(" · ") : fmtMoney(0, "USD");
  };
  const net = { USD: deposits.USD - withdrawals.USD, SLSH: deposits.SLSH - withdrawals.SLSH };
  return {
    totalTransactions: entries.length,
    totalDepositsLabel: fmtMap(deposits),
    totalWithdrawalsLabel: fmtMap(withdrawals),
    netMovementLabel: fmtMap(net),
  };
}

// Mirrors the filter-bar summary shown on screen — same fields queryHistory
// itself accepts — so the statement's subtitle line always describes
// exactly the filters that produced its rows.
function describeFilters(query) {
  const parts = [];
  // DEPOSIT/WITHDRAW → CREDIT/DEBIT round: the stored type values stay
  // deposit/withdrawal; the printed filter uses the on-screen label.
  const TYPE_LABEL = { deposit: "Credit", withdrawal: "Debit", exchange: "Exchange", transfer: "Transfer", quotation: "Quotation", quotation_payment: "Quotation Payment", quotation_charge: "Quotation Charge", payment: "Payment", cash: "Cash Account" };
  if (query.type && query.type !== "all") parts.push(`Type: ${TYPE_LABEL[query.type] || query.type}`);
  if (query.accountType && query.accountType !== "all") parts.push(`Account type: ${query.accountType}`);
  if (query.currency) parts.push(`Currency: ${query.currency}`);
  if (query.status && query.status !== "all") parts.push(`Status: ${query.status}`);
  if (query.from || query.to) parts.push(`Dates: ${query.from || "…"} to ${query.to || "…"}`);
  if (query.accountId) parts.push("Account: filtered");
  if (query.customerId) parts.push("Customer: filtered");
  if (query.search) parts.push(`Search: "${query.search}"`);
  return parts.length ? parts.join(" · ") : null;
}

// TRANSACTION HISTORY CONSOLE round ---------------------------------------
// Credit / Debit per entry, using the SAME classification as the Transaction
// Statement totals above (computeHistoryTotals): plain credits/debits and
// the quotation ledger legs move an account balance in the ledger's own
// currency; an exchange or a transfer is shown by its amount only — the
// account postings an exchange or transfer creates are separate ledger rows
// (with a source_type) that this page never lists a second time, so nothing
// is counted twice.
function ledgerDirection(e) {
  if (e.recordType === "ledger") return e.ledgerType === "deposit" ? "credit" : "debit";
  if (e.recordType === "quotation") return e.ledgerType === "withdrawal" ? "debit" : "credit";
  return null;
}
function decorate(e) {
  const dir = ledgerDirection(e);
  const amount = Number((e.raw || {}).amount);
  const cur = (e.raw || {}).currency;
  return { ...e, credit: dir === "credit" ? amount : null, debit: dir === "debit" ? amount : null, entryCurrency: cur || e.accountCurrency };
}
// Summary of ALL matching entries (not one page), per currency — USD and
// SLSH are never added together. Exchange profit is the figure stored on
// each exchange when it was made (profit_usd, USD), voided exchanges
// excluded, and only for users allowed to see exchange profit.
function historySummary(entries, includeProfit) {
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const counts = { entries: entries.length, exchanges: 0, transfers: 0, quotationCharges: 0, quotationPayments: 0, quotations: 0, creditsDebits: 0, credits: 0, debits: 0, payments: 0, cash: 0 };
  const cash = {};
  const money = {};
  let profitUsd = 0, profitCount = 0;
  for (const e of entries) {
    if (e.recordType === "exchange") counts.exchanges += 1;
    else if (e.recordType === "transfer") counts.transfers += 1;
    else if (e.recordType === "ledger") { counts.creditsDebits += 1; if (e.ledgerType === "deposit") counts.credits += 1; else counts.debits += 1; if (e.origin === "payment") counts.payments += 1; }
    else if (e.recordType === "cash") {
      counts.cash += 1;
      const m = cash[e.entryCurrency] || (cash[e.entryCurrency] = { in: 0, out: 0 });
      if (e.ledgerType === "deposit") m.in += Number(e.raw.amount) || 0; else m.out += Number(e.raw.amount) || 0;
    }
    else if (e.recordType === "quotation") {
      counts.quotations += 1;
      if (e.sourceType === "quotation_paid") counts.quotationPayments += 1;
      if (e.sourceType === "quotation_charge" && e.ledgerType === "withdrawal") counts.quotationCharges += 1;
    }
    if (e.credit != null || e.debit != null) {
      const m = money[e.entryCurrency] || (money[e.entryCurrency] = { credits: 0, debits: 0 });
      if (e.credit != null) m.credits += e.credit; else m.debits += e.debit;
    }
    if (includeProfit && e.recordType === "exchange" && e.status !== "voided" && e.profitUsd != null) { profitUsd += Number(e.profitUsd) || 0; profitCount += 1; }
  }
  for (const k of Object.keys(money)) { money[k] = { credits: r2(money[k].credits), debits: r2(money[k].debits), net: r2(money[k].credits - money[k].debits) }; }
  for (const k of Object.keys(cash)) { cash[k] = { in: r2(cash[k].in), out: r2(cash[k].out), net: r2(cash[k].in - cash[k].out) }; }
  return { counts, money, cash, profit: includeProfit ? { usd: r2(profitUsd), exchanges: profitCount, basis: "recorded at exchange time, voided excluded" } : null };
}

// Currency access (currency.usd / currency.slsh) applies here too: a user
// limited to one currency can't read the other currency's history, and a
// request without a currency only returns the currencies they may see.
function scopedHistory(user, res, query, opts = {}) {
  opts = { ...opts, includeCash: can(user, "cash.view") };
  const allowed = allowedCurrencies(user);
  if (query.currency && !allowed.includes(query.currency)) {
    sendJSON(res, 403, { error: `You don't have access to ${query.currency} accounts.` });
    return null;
  }
  // ACCOUNT-LEVEL ACCESS round: entries of an account this user has "No
  // Access" to (either side of a transfer) are left out of history,
  // summaries and every export.
  const hidden = require("../account-access").hiddenIds(user);
  return queryHistory(query, opts).filter((e) => allowed.includes(e.accountCurrency) && !(hidden.has(e.accountId) || hidden.has(e.counterpartAccountId))).map(decorate);
}

// Server-side sort for the paged console. Unknown fields fall back to the
// default newest-first order; ties keep that order (stable).
const SORT_FIELDS = {
  date: (e) => e.sortKey, reference: (e) => String(e.reference || "").toLowerCase(), recordType: (e) => historyTypeLabel(e).toLowerCase(),
  accountName: (e) => String(e.accountName || "").toLowerCase(), status: (e) => String(e.status || "").toLowerCase(),
  staffOrCreator: (e) => String(e.staffOrCreator || "").toLowerCase(), credit: (e) => (e.credit == null ? -Infinity : e.credit), debit: (e) => (e.debit == null ? -Infinity : e.debit),
  amount: (e) => Number((e.raw || {}).amount ?? (e.raw || {}).amountGiven ?? 0),
};
function sortEntries(entries, field, dir) {
  const get = SORT_FIELDS[field];
  if (!get) return entries;
  const d = dir === "asc" ? 1 : -1;
  return entries.map((e, i) => [e, i]).sort(([a, i], [b, j]) => { const x = get(a), y = get(b); return x < y ? -d : x > y ? d : i - j; }).map(([e]) => e);
}

// UNIFIED TRANSACTION SORTING round: `sortMode` — the matching entries are
// put in fixed page groups newest first (Page 1 = the newest), and the
// chosen order applies inside the page: oldest | newest | highest | lowest
// (amounts compared within one currency) | reference (A–Z, numbers in order).
const SORT_MODES = new Set(["oldest", "newest", "highest", "lowest", "reference"]);
const refCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const entryAmount = (e) => Math.abs(Number(e.credit != null ? e.credit : e.debit != null ? e.debit : ((e.raw || {}).amount ?? (e.raw || {}).amountGiven ?? 0)) || 0);
function sortWithinPage(rows, mode) {
  const chrono = (a, b) => (String(a.sortKey) < String(b.sortKey) ? -1 : String(a.sortKey) > String(b.sortKey) ? 1 : 0);
  const cur = (e) => e.entryCurrency || e.accountCurrency || "";
  const byCur = (a, b) => (cur(a) === cur(b) ? 0 : cur(a) === "USD" ? -1 : cur(b) === "USD" ? 1 : cur(a) < cur(b) ? -1 : 1);
  const list = [...rows];
  if (mode === "oldest") return list.sort(chrono);
  if (mode === "newest") return list.sort((a, b) => -chrono(a, b));
  if (mode === "highest" || mode === "lowest") { const d = mode === "highest" ? -1 : 1; return list.sort((a, b) => byCur(a, b) || (entryAmount(a) - entryAmount(b)) * d || chrono(a, b)); }
  return list.sort((a, b) => { const x = String(a.reference || ""), y = String(b.reference || ""); if (!x !== !y) return x ? -1 : 1; return refCollator.compare(x, y) || chrono(a, b); });
}

function register(router) {
  router.get("/api/history", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const includeProfit = can(user, "profit.viewExchange");
    const universe = scopedHistory(user, res, query, { includeProfit, universe: true }); if (!universe) return;
    const tab = TAB_FILTERS[query.type] ? query.type : "all";
    const entries = universe.filter(TAB_FILTERS[tab]);
    const out = {};
    if (query.withSummary === "1") {
      out.summary = historySummary(entries, includeProfit);
      // Count of every tab under the same filters (Credits / Debits are
      // every ledger posting; the others are original records).
      out.summary.tabCounts = Object.fromEntries(Object.entries(TAB_FILTERS).map(([k, f]) => [k, universe.filter(f).length]));
      out.summary.tabCounts.cash = can(user, "cash.view") ? out.summary.tabCounts.cash : null;
      // Staff who recorded any matching entry (the console's Staff filter —
      // the page itself only holds one page of rows).
      const staff = new Map(); for (const e of universe) if (e.staffId && e.staffOrCreator) staff.set(e.staffId, e.staffOrCreator);
      out.summary.staff = [...staff.entries()];
    }
    // PROFESSIONAL TRANSACTION MANAGEMENT round: optional server-side
    // sorting and paging (page / pageSize / sort / dir) so the browser never
    // has to load every record; without `page` the full list is returned as
    // before (exports, other screens).
    const mode = SORT_MODES.has(query.sortMode) ? query.sortMode : null;
    const sorted = mode ? sortEntries(entries, "date", "desc") : sortEntries(entries, query.sort, query.dir);
    if (query.page !== undefined) {
      const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 500);
      const total = sorted.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), totalPages);
      out.entries = sorted.slice((page - 1) * pageSize, page * pageSize);
      if (mode) out.entries = sortWithinPage(out.entries, mode);
      out.page = page; out.pageSize = pageSize; out.total = total; out.totalPages = totalPages;
    } else out.entries = sorted;
    sendJSON(res, 200, out);
  });

  // PROFESSIONAL TRANSACTION MANAGEMENT round — the records connected to
  // one transaction: an Exchange with its account postings and Cash Account
  // entries, a Transfer with its two postings, a Payment with its Cash
  // Account entry, a Quotation with its charge / payments / refunds, and any
  // posting or Cash Account entry with the original it belongs to. Read
  // from the original tables (nothing copied); accounts the user may not
  // see and currencies they can't access are left out.
  router.get("/api/history/related", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const allowed = allowedCurrencies(user);
    const hidden = require("../account-access").hiddenIds(user);
    const canCash = can(user, "cash.view");
    const id = String(query.id || "");
    const kind = String(query.recordType || "");
    const items = [];
    const seen = new Set();
    const push = (it) => { if (!it || seen.has(`${it.recordType}:${it.id}`)) return; seen.add(`${it.recordType}:${it.id}`); items.push(it); };
    const ledgerItem = (l) => l && ({ recordType: "ledger", id: l.id, reference: l.reference_number || null, label: historyTypeLabel({ recordType: "ledger", ledgerType: l.type, origin: !l.source_type ? "payment" : l.source_type.startsWith("quotation") ? "quotation" : l.source_type, sourceType: l.source_type }), direction: l.type === "deposit" ? "credit" : "debit", amount: l.amount, currency: l.currency, date: l.date, accountId: l.client_id, accountName: (get("SELECT name FROM clients WHERE id = ?", [l.client_id]) || {}).name || "—", tab: l.type });
    const cashItem = (c) => c && canCash && ({ recordType: "cash", id: c.id, reference: c.reference_number || null, label: c.type === "deposit" ? "Cash Account In" : "Cash Account Out", direction: c.type === "deposit" ? "in" : "out", amount: c.amount, currency: c.currency, date: c.date, accountId: c.counterparty_client_id || null, accountName: (get("SELECT name FROM cash_accounts WHERE id = ?", [c.cash_account_id]) || {}).name || "—", tab: "cash" });
    const exchangeItem = (x) => x && ({ recordType: "exchange", id: x.id, reference: x.reference_number, label: "Exchange", amount: x.amount_given, currency: x.currency_given, amountReceived: x.amount_received, currencyReceived: x.currency_received, rate: x.rate_used, date: x.date, status: x.status, accountId: x.client_id, accountName: x.client_name, tab: "exchange" });
    const transferItem = (t) => t && ({ recordType: "transfer", id: t.id, reference: t.reference_number, label: "Transfer", amount: t.amount, currency: t.currency, date: t.date, status: t.status, accountId: t.from_account_id, counterpartAccountId: t.to_account_id, accountName: (get("SELECT name FROM clients WHERE id = ?", [t.from_account_id]) || {}).name || "—", tab: "transfer" });
    const quotationItem = (q) => q && ({ recordType: "quotation_doc", id: q.id, reference: q.number, label: "Quotation", amount: q.charged_amount, currency: q.charged_currency, date: q.issue_date || q.created_at, status: q.status, accountId: q.charged_account_id || q.client_id, accountName: q.client_name, tab: "quotation" });
    const expandExchange = (xid) => { push(exchangeItem(get("SELECT * FROM exchange_transactions WHERE id = ?", [xid]))); for (const l of all("SELECT * FROM account_ledger WHERE source_type = 'exchange' AND source_id = ?", [xid])) push(ledgerItem(l)); for (const c of all("SELECT * FROM cash_ledger WHERE source_type = 'exchange' AND source_id = ?", [xid])) push(cashItem(c)); };
    const expandTransfer = (tid) => { push(transferItem(get("SELECT * FROM transfers WHERE id = ?", [tid]))); for (const l of all("SELECT * FROM account_ledger WHERE source_type = 'transfer' AND source_id = ?", [tid])) push(ledgerItem(l)); };
    const expandQuotation = (qid) => { push(quotationItem(get("SELECT * FROM quotations WHERE id = ?", [qid]))); for (const l of all("SELECT * FROM account_ledger WHERE source_type IN ('quotation_charge','quotation_paid','quotation_refund') AND source_id = ? ORDER BY date, created_at", [qid])) push(ledgerItem(l)); };
    const expandPayment = (lid) => { push(ledgerItem(get("SELECT * FROM account_ledger WHERE id = ?", [lid]))); for (const c of all("SELECT * FROM cash_ledger WHERE source_type = 'customer_payment' AND source_id = ?", [lid])) push(cashItem(c)); };
    if (kind === "exchange") expandExchange(id);
    else if (kind === "transfer") expandTransfer(id);
    else if (kind === "quotation") { const l = get("SELECT * FROM account_ledger WHERE id = ?", [id]); if (l && l.source_id) expandQuotation(l.source_id); }
    else if (kind === "ledger") {
      const l = get("SELECT * FROM account_ledger WHERE id = ?", [id]);
      if (l && l.source_type === "exchange") expandExchange(l.source_id);
      else if (l && l.source_type === "transfer") expandTransfer(l.source_id);
      else if (l && l.source_type && l.source_type.startsWith("quotation")) expandQuotation(l.source_id);
      else if (l) expandPayment(l.id);
    } else if (kind === "cash" && canCash) {
      const c = get("SELECT * FROM cash_ledger WHERE id = ?", [id]);
      if (c && c.source_type === "exchange") expandExchange(c.source_id);
      else if (c && c.source_type === "customer_payment") expandPayment(c.source_id);
      else if (c && (c.source_type === "cash_transfer" || c.source_type === "cash_exchange")) for (const o of all("SELECT * FROM cash_ledger WHERE source_type = ? AND source_id = ?", [c.source_type, c.source_id])) push(cashItem(o));
      else if (c) push(cashItem(c));
    }
    if (!items.length) return sendJSON(res, 404, { error: "Transaction not found." });
    // Access: an original touching an account the user may not see is not
    // found at all; other rows outside their currencies are left out.
    const blocked = items.some((it) => (it.accountId && hidden.has(it.accountId)) || (it.counterpartAccountId && hidden.has(it.counterpartAccountId)));
    if (blocked) return sendJSON(res, 404, { error: "Transaction not found." });
    const visible = items.filter((it) => !it.currency || allowed.includes(it.currency));
    if (!visible.length) return sendJSON(res, 403, { error: "You don't have access to this currency." });
    sendJSON(res, 200, { items: visible.map((it) => ({ ...it, isSelf: it.id === id })), hiddenCount: items.length - visible.length });
  });

  router.get("/api/history/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = scopedHistory(user, res, query, {}); if (!entries) return;
    // QUOTATION PAYMENT INTEGRATION round (spec section 21): added Quotation
    // and Payment Method columns — populated only for quotation-tagged rows
    // (e.quotationNumber/e.paymentMethod are undefined for every other
    // record type), blank otherwise. Every pre-existing column keeps its
    // exact name/position so nothing already parsing this CSV breaks.
    const csv = toCSV(
      ["Type", "Reference", "Date", "Account", "Account type", "Currency", "Phone", "Amount", "Status", "Staff/Creator", "Quotation", "Payment Method", "Origin", "Related Reference", "Account Number"],
      entries.map((e) => [historyTypeLabel(e), e.reference, e.date, e.accountName, e.accountType, e.accountCurrency, e.phone, e.amountSummary, e.status || "", e.staffOrCreator, e.quotationNumber || "", e.paymentMethod || "", e.recordType === "ledger" ? e.origin : e.recordType, e.relatedReference || "", e.accountNumber || ""])
    );
    addAudit(user, "Transaction history exported (CSV)", `${entries.length} record(s)`);
    sendCSV(res, "obo-transaction-history.csv", csv);
  });

  router.get("/api/history/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = scopedHistory(user, res, query, {}); if (!entries) return;
    const pdf = await renderReportPDF({
      title: "Transaction History",
      meta: `${entries.length} record(s)`,
      generatedBy: user.name,
      company: getCompanySettings(),
      template: getDefaultPdfTemplate("transaction"),
      columns: [
        { label: "Type", width: 0.9 }, { label: "Reference", width: 1.1 }, { label: "Date", width: 1 },
        { label: "Account", width: 1.5 }, { label: "Amount", width: 1.8 }, { label: "Status", width: 0.9 },
      ],
      rows: entries.map((e) => [historyTypeLabel(e), e.reference, e.date.slice(0, 10), e.accountName, e.amountSummary, e.status || ""]),
    });
    addAudit(user, "Transaction history exported (PDF)", `${entries.length} record(s)`);
    sendPDF(res, "obo-transaction-history.pdf", pdf);
  });

  // MASTER PROMPT — the new premium "Transaction Statement" document over
  // the same filtered rows queryHistory() already produces for the screen,
  // CSV, and old export.pdf above (never separately recomputed).
  router.get("/api/history/statement.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = scopedHistory(user, res, query, {}); if (!entries) return;
    const rows = entries.map((e) => ({ date: e.date, reference: e.reference, type: historyTypeLabel(e), accountName: e.accountName, amountSummary: e.amountSummary, status: e.status || "—" }));
    const pdf = await renderTransactionStatementPDF({
      company: getCompanySettings(), rows, filterSummary: describeFilters(query),
      totals: computeHistoryTotals(entries), from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultPdfTemplate("transaction"),
    });
    addAudit(user, "Transaction statement exported (PDF)", `${entries.length} record(s)`);
    sendPDF(res, "obo-transaction-statement.pdf", pdf);
  });

  router.get("/api/history/statement.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = scopedHistory(user, res, query, {}); if (!entries) return;
    const rows = entries.map((e) => ({ date: e.date, reference: e.reference, type: historyTypeLabel(e), accountName: e.accountName, amountSummary: e.amountSummary, status: e.status || "—" }));
    const xlsx = await buildTransactionStatementWorkbook({
      company: getCompanySettings(), rows, filterSummary: describeFilters(query),
      totals: computeHistoryTotals(entries), from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultExcelTemplate("transaction"),
    });
    addAudit(user, "Transaction statement exported (Excel)", `${entries.length} record(s)`);
    sendXLSX(res, "obo-transaction-statement.xlsx", xlsx);
  });
}

module.exports = { register, queryHistory, historySummary, scopedHistory, historyTypeLabel };
