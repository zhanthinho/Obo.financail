"use strict";
const { all, get } = require("../db");
const { sendJSON, sendCSV, sendPDF, sendXLSX } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
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
function queryHistory(query) {
  const type = query.type || "all";
  const accountType = query.accountType && query.accountType !== "all" ? query.accountType : null;
  const currency = query.currency && ["USD", "SLSH"].includes(query.currency) ? query.currency : null;
  const from = query.from, to = query.to;
  const search = (query.search || "").trim().toLowerCase();
  const status = query.status && query.status !== "all" ? query.status.toLowerCase() : null;
  const staffId = query.staffId || null;
  const accountId = query.accountId || null;
  let entries = [];

  if (type === "all" || type === "exchange") {
    const clauses = [], params = [];
    if (from) { clauses.push("date(t.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(t.date) <= date(?)"); params.push(to); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(`SELECT t.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency FROM exchange_transactions t LEFT JOIN clients c ON c.id = t.client_id ${where}`, params);
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
      amountSummary: `${fmtMoney(t.amount_given, t.currency_given)} -> ${fmtMoney(t.amount_received, t.currency_received)}`,
      status: t.status, staffOrCreator: t.staff_name, staffId: t.staff_id, accountId: t.client_id, notes: t.notes,
      raw: transactionRowToJSON(t),
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
  if (type === "all" || type === "quotation" || type === "quotation_payment") {
    const clauses = ["l.source_type IN ('quotation_charge','quotation_paid','quotation_refund')"], params = [];
    // QUOTATION PAYMENT INTEGRATION round (spec: "each payment must be an
    // independent transaction, filterable on its own"): a dedicated
    // "Quotation Payments" view narrows this same query down to just the
    // settlement deposits (source_type='quotation_paid') — never the
    // original charge or a refund — so it answers "show me only money that
    // actually came IN against quotations."
    if (type === "quotation_payment") clauses.push("l.source_type = 'quotation_paid'");
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
      `SELECT l.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency, c.name AS client_name,
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
      accountName: l.client_name || "—", accountType: l.client_account_type || "customer", accountCurrency: l.client_currency || l.currency, phone: l.client_phone || "",
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
  if (type === "all" || type === "transfer") {
    const clauses = [], params = [];
    if (from) { clauses.push("date(t.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(t.date) <= date(?)"); params.push(to); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(
      `SELECT t.*, fc.name AS from_name, fc.account_type AS from_account_type, fc.currency AS from_currency, fc.contact AS from_phone, tc.name AS to_name
       FROM transfers t LEFT JOIN clients fc ON fc.id = t.from_account_id LEFT JOIN clients tc ON tc.id = t.to_account_id ${where}`,
      params
    );
    entries.push(...rows.map((t) => ({
      id: t.id, sortKey: chronoSortKey(t.date, t.created_at), recordType: "transfer", reference: t.reference_number || t.id.slice(0, 10), date: normalizeHistoryDate(t.date),
      accountName: t.from_name || "—", accountType: t.from_account_type || "customer", accountCurrency: t.from_currency || t.currency, phone: t.from_phone || "",
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
  if (type === "all" || type === "deposit" || type === "withdrawal") {
    const wantedTypes = type === "all" ? ["deposit", "withdrawal"] : [type];
    const clauses = ["l.source_type IS NULL", `l.type IN (${wantedTypes.map(() => "?").join(",")})`];
    const params = [...wantedTypes];
    if (from) { clauses.push("date(l.date) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(l.date) <= date(?)"); params.push(to); }
    const where = "WHERE " + clauses.join(" AND ");
    const rows = all(
      `SELECT l.*, c.account_type AS client_account_type, c.contact AS client_phone, c.currency AS client_currency, c.name AS client_name
       FROM account_ledger l LEFT JOIN clients c ON c.id = l.client_id ${where}`,
      params
    );
    entries.push(...rows.map((l) => ({
      id: l.id, sortKey: chronoSortKey(l.date, l.created_at), recordType: "ledger", ledgerType: l.type, reference: l.reference_number || l.id.slice(0, 10), date: normalizeHistoryDate(l.date),
      accountName: l.client_name || "—", accountType: l.client_account_type || "customer", accountCurrency: l.client_currency || l.currency, phone: l.client_phone || "",
      amountSummary: fmtMoney(l.amount, l.currency),
      status: null, staffOrCreator: l.staff_name, staffId: l.staff_id, accountId: l.client_id, notes: l.notes,
      raw: { id: l.id, type: l.type, accountName: l.client_name || "—", amount: l.amount, currency: l.currency, notes: l.notes, date: l.date },
    })));
  }
  if (accountType) entries = entries.filter((e) => e.accountType === accountType);
  if (currency) entries = entries.filter((e) => e.accountCurrency === currency);
  if (status) entries = entries.filter((e) => (e.status || "").toLowerCase() === status);
  if (staffId) entries = entries.filter((e) => e.staffId === staffId);
  if (accountId) entries = entries.filter((e) => e.accountId === accountId || e.counterpartAccountId === accountId);
  if (search) {
    entries = entries.filter((e) =>
      e.reference.toLowerCase().includes(search) ||
      e.accountName.toLowerCase().includes(search) ||
      (e.phone || "").toLowerCase().includes(search) ||
      (e.staffOrCreator || "").toLowerCase().includes(search) ||
      (e.notes || "").toLowerCase().includes(search)
    );
  }
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
  if (e.recordType === "ledger") return e.ledgerType === "withdrawal" ? "Debit" : "Credit";
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
  const TYPE_LABEL = { deposit: "Credit", withdrawal: "Debit", exchange: "Exchange", transfer: "Transfer", quotation: "Quotation", quotation_payment: "Quotation Payment" };
  if (query.type && query.type !== "all") parts.push(`Type: ${TYPE_LABEL[query.type] || query.type}`);
  if (query.accountType && query.accountType !== "all") parts.push(`Account type: ${query.accountType}`);
  if (query.currency) parts.push(`Currency: ${query.currency}`);
  if (query.status && query.status !== "all") parts.push(`Status: ${query.status}`);
  if (query.accountId) parts.push("Account: filtered");
  if (query.search) parts.push(`Search: "${query.search}"`);
  return parts.length ? parts.join(" · ") : null;
}

function register(router) {
  router.get("/api/history", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    sendJSON(res, 200, { entries: queryHistory(query) });
  });

  router.get("/api/history/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = queryHistory(query);
    // QUOTATION PAYMENT INTEGRATION round (spec section 21): added Quotation
    // and Payment Method columns — populated only for quotation-tagged rows
    // (e.quotationNumber/e.paymentMethod are undefined for every other
    // record type), blank otherwise. Every pre-existing column keeps its
    // exact name/position so nothing already parsing this CSV breaks.
    const csv = toCSV(
      ["Type", "Reference", "Date", "Account", "Account type", "Currency", "Phone", "Amount", "Status", "Staff/Creator", "Quotation", "Payment Method"],
      entries.map((e) => [historyTypeLabel(e), e.reference, e.date, e.accountName, e.accountType, e.accountCurrency, e.phone, e.amountSummary, e.status || "", e.staffOrCreator, e.quotationNumber || "", e.paymentMethod || ""])
    );
    addAudit(user, "Transaction history exported (CSV)", `${entries.length} record(s)`);
    sendCSV(res, "obo-transaction-history.csv", csv);
  });

  router.get("/api/history/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const entries = queryHistory(query);
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
    const entries = queryHistory(query);
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
    const entries = queryHistory(query);
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

module.exports = { register, queryHistory };
