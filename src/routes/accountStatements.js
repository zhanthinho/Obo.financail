"use strict";
// PROFESSIONAL ACCOUNT REPORTS round: a dedicated, per-account (client_id
// scoped, unbounded) Account Statement — both a professional print-ready
// PDF and a genuinely editable Excel workbook — deliberately kept SEPARATE
// from the pre-existing /api/account-ledger/export.{csv,pdf} routes in
// ledger.js (a global, text-search-scoped export used elsewhere) so nothing
// about that existing feature changes. Both new endpoints below query the
// SAME account_ledger rows and compute the SAME summary numbers, so the PDF
// and Excel for one account/date-range can never disagree with each other.
const { all, get } = require("../db");
const { sendPDF, sendXLSX, notFound } = require("../http-helpers");
const { requireAuth, requirePerm, requireCurrencyAccess, can } = require("../rbac");
const { getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, addAudit } = require("../domain");
const { renderAccountStatementPDF } = require("../pdf");
const { buildAccountStatementWorkbook } = require("../xlsx-account-report");

function canView(user) {
  return can(user, "accountsManage") || can(user, "reports");
}

const SYSTEM_SCOPE_ID = "__system__";
// The account statement's tail columns are exactly the customizable subset
// of the live "payments.<currency>" table (see TABLE CUSTOMIZATION round in
// frontend/app.jsx) — "#", Date, Reference, and Type stay fixed (see
// renderAccountStatementPDF's own comment for why). Reusing that table's
// saved layout means a user who already hid/reordered Notes/Deposit/
// Withdrawal/Balance After/Staff on the live Payments table sees the exact
// same choices reflected in their printed/exported statement, per the
// spec's "respect the existing table customization" requirement.
const CUSTOMIZABLE_KEYS = new Set(["notes", "deposit", "withdrawal", "balanceAfter", "staff"]);
const DEFAULT_COLUMN_ORDER = ["notes", "deposit", "withdrawal", "balanceAfter", "staff"];

function resolveStatementColumnOrder(user, currency) {
  const tableKey = `payments.${String(currency || "").toLowerCase()}`;
  const mine = get("SELECT columns_json FROM table_layouts WHERE table_key = ? AND user_id = ?", [tableKey, user.id]);
  const system = get("SELECT columns_json FROM table_layouts WHERE table_key = ? AND user_id = ?", [tableKey, SYSTEM_SCOPE_ID]);
  const raw = (mine && mine.columns_json) || (system && system.columns_json);
  if (!raw) return DEFAULT_COLUMN_ORDER;
  try {
    const saved = JSON.parse(raw).filter((k) => CUSTOMIZABLE_KEYS.has(k));
    return saved.length ? saved : DEFAULT_COLUMN_ORDER;
  } catch (e) {
    return DEFAULT_COLUMN_ORDER;
  }
}

// Loads everything both exports need from ONE place, so the PDF and Excel
// route handlers can never quietly diverge in how they compute a total.
function loadStatementData(accountId, query) {
  const account = get("SELECT * FROM clients WHERE id = ?", [accountId]);
  if (!account) return { error: "Account not found." };
  const currency = account.currency;
  const balanceField = currency === "USD" ? "balance_usd" : "balance_slsh";

  const clauses = ["al.client_id = ?"], sqlParams = [account.id];
  if (query.from) { clauses.push("date(al.date) >= date(?)"); sqlParams.push(query.from); }
  if (query.to) { clauses.push("date(al.date) <= date(?)"); sqlParams.push(query.to); }
  const where = "WHERE " + clauses.join(" AND ");
  // PAYMENT & TRANSFER UPGRADE round: a transfer's two ledger legs are plain
  // account_ledger rows (type deposit/withdrawal, tagged source_type=
  // 'transfer'/source_id=<transfer id>) so every existing balance/statement
  // calculation keeps working untouched. The LEFT JOIN below only adds the
  // Transfer's own reference_number so this statement can label those rows
  // "Transfer In"/"Transfer Out" and show the same Transfer ID both legs
  // share, per the spec's "both referencing the same Transfer ID" requirement
  // — it changes no totals and no other row's data.
  // BALANCE & LAST TRANSACTION FIX round: `al.date` can be a bare
  // "YYYY-MM-DD" or a full ISO timestamp (see util.chronoSortKey for the
  // full rationale) — a plain `ORDER BY al.date` compares those as raw
  // strings, which can even rank a same-day bare-date row entirely after a
  // same-day timestamped row with an afternoon time. The CASE expression
  // below is the SQL equivalent of util.chronoSortKey: when `date` has no
  // explicit time, it borrows the TIME portion of `created_at` (the real,
  // always-set insertion timestamp) while keeping date's own calendar day —
  // so chronological order, and therefore the running/closing balance
  // below, always agrees with the live Account View. `id` is the final
  // tiebreaker.
  const CHRONO_SORT_EXPR = "(CASE WHEN length(al.date) > 10 THEN al.date ELSE substr(al.date,1,10) || substr(COALESCE(al.created_at, al.date || 'T00:00:00.000Z'), 11) END)";
  const rows = all(
    `SELECT al.*, tr.reference_number AS transfer_reference
     FROM account_ledger al
     LEFT JOIN transfers tr ON al.source_type = 'transfer' AND al.source_id = tr.id
     ${where} ORDER BY ${CHRONO_SORT_EXPR} ASC, al.id ASC`,
    sqlParams
  );

  // Opening balance = the balance immediately before the period's first
  // entry (the most recent ledger row strictly before `from`), so a
  // date-filtered statement's own math is internally consistent even
  // though the account itself has no separately stored "opening balance"
  // field — every account's true starting point is 0, one ledger entry at
  // a time from there.
  let openingBalance = 0;
  if (query.from) {
    const priorChronoExpr = "(CASE WHEN length(date) > 10 THEN date ELSE substr(date,1,10) || substr(COALESCE(created_at, date || 'T00:00:00.000Z'), 11) END)";
    const prior = get(
      `SELECT balance_after FROM account_ledger WHERE client_id = ? AND date(date) < date(?)
       ORDER BY ${priorChronoExpr} DESC, id DESC LIMIT 1`,
      [account.id, query.from]
    );
    if (prior) openingBalance = prior.balance_after;
  }
  let totalDeposits = 0, totalWithdrawals = 0;
  for (const r of rows) {
    if (r.type === "deposit") totalDeposits += r.amount; else totalWithdrawals += r.amount;
  }
  const netMovement = totalDeposits - totalWithdrawals;
  const closingBalance = rows.length ? rows[rows.length - 1].balance_after : openingBalance;

  return {
    account: {
      id: account.id, accountNumber: account.account_number, name: account.name,
      accountType: account.account_type, currency, registrationDate: account.created_at,
      currentBalance: account[balanceField],
    },
    rows: rows.map((r) => ({
      date: r.date,
      reference: r.source_type === "transfer" ? (r.transfer_reference || "—") : (r.reference_number || "—"),
      type: r.source_type === "transfer"
        ? (r.type === "deposit" ? "Transfer In" : "Transfer Out")
        : (r.type === "deposit" ? "Credit" : "Debit"),
      notes: r.notes || "—",
      deposit: r.type === "deposit" ? r.amount : null,
      withdrawal: r.type === "withdrawal" ? r.amount : null,
      balanceAfter: r.balance_after,
      staff: r.staff_name || "—",
    })),
    summary: { openingBalance, totalDeposits, totalWithdrawals, netMovement, closingBalance, totalTransactions: rows.length },
  };
}

function register(router) {
  router.get("/api/accounts/:id/statement.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const data = loadStatementData(params.id, query);
    if (data.error) return notFound(res, data.error);
    // SECURITY HARDENING: this route was missing the currency-scope check
    // every other account-scoped route enforces (see accounts.js/ledger.js) —
    // without it, a user restricted to one currency (currency.usd or
    // currency.slsh only) could pull another currency's account statement by
    // guessing/incrementing the :id in the URL.
    if (!requireCurrencyAccess(user, res, data.account.currency)) return;
    const columnOrder = resolveStatementColumnOrder(user, data.account.currency);
    const pdf = await renderAccountStatementPDF({
      company: getCompanySettings(), account: data.account, rows: data.rows, summary: data.summary,
      columnOrder, from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultPdfTemplate("account"),
    });
    addAudit(user, "Account statement exported (PDF)", `${data.account.accountNumber} (${data.account.currency})`);
    sendPDF(res, `${data.account.accountNumber}-statement.pdf`, pdf);
  });

  router.get("/api/accounts/:id/statement.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const data = loadStatementData(params.id, query);
    if (data.error) return notFound(res, data.error);
    // SECURITY HARDENING: same missing currency-scope check as the PDF route
    // above — see that comment.
    if (!requireCurrencyAccess(user, res, data.account.currency)) return;
    const columnOrder = resolveStatementColumnOrder(user, data.account.currency);
    const buf = await buildAccountStatementWorkbook({
      company: getCompanySettings(), account: data.account, rows: data.rows, summary: data.summary,
      columnOrder, from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultExcelTemplate("account"),
    });
    addAudit(user, "Account statement exported (Excel)", `${data.account.accountNumber} (${data.account.currency})`);
    sendXLSX(res, `${data.account.accountNumber}-statement.xlsx`, buf);
  });
}

module.exports = { register };
