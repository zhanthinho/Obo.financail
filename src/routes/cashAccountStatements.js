"use strict";
// CASH ACCOUNT VIEW round: a dedicated, per-cash-account (cash_account_id
// scoped, unbounded) Cash Account Statement — both a professional
// print-ready PDF and a genuinely editable Excel workbook — mirroring
// routes/accountStatements.js EXACTLY, just pointed at cash_accounts/
// cash_ledger instead of clients/account_ledger. Deliberately a brand-new,
// fully additive pair of routes: nothing about the existing customer
// Account Statement, or any other Cash in Hand endpoint, is touched.
const { all, get } = require("../db");
const { sendPDF, sendXLSX, notFound } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, addAudit } = require("../domain");
const { renderCashAccountStatementPDF } = require("../pdf");
const { buildCashAccountStatementWorkbook } = require("../xlsx-cash-account-report");

// Same CASE-expression chronological sort key as accountStatements.js's own
// CHRONO_SORT_EXPR (see that file's comment for the full rationale) —
// cash_ledger.date has the exact same "bare YYYY-MM-DD or full ISO
// timestamp" shape as account_ledger.date, so the same fix applies here.
const CHRONO_SORT_EXPR = "(CASE WHEN length(date) > 10 THEN date ELSE substr(date,1,10) || substr(COALESCE(created_at, date || 'T00:00:00.000Z'), 11) END)";

// Loads everything both exports need from ONE place, so the PDF and Excel
// route handlers can never quietly diverge in how they compute a total —
// same discipline as accountStatements.js's own loadStatementData.
function loadCashAccountStatementData(cashAccountId, query) {
  const account = get("SELECT * FROM cash_accounts WHERE id = ?", [cashAccountId]);
  if (!account) return { error: "Cash account not found." };
  const currency = account.currency;

  const clauses = ["cash_account_id = ?"], sqlParams = [account.id];
  if (query.from) { clauses.push("date(date) >= date(?)"); sqlParams.push(query.from); }
  if (query.to) { clauses.push("date(date) <= date(?)"); sqlParams.push(query.to); }
  const where = "WHERE " + clauses.join(" AND ");
  const rows = all(
    `SELECT * FROM cash_ledger ${where} ORDER BY ${CHRONO_SORT_EXPR} ASC, id ASC`,
    sqlParams
  );

  // Opening balance = the balance immediately before the period's first
  // entry (the most recent cash_ledger row strictly before `from`) — same
  // "every account's true starting point is 0, one entry at a time" logic
  // as the customer Account Statement.
  let openingBalance = 0;
  if (query.from) {
    const prior = get(
      `SELECT balance_after FROM cash_ledger WHERE cash_account_id = ? AND date(date) < date(?)
       ORDER BY ${CHRONO_SORT_EXPR} DESC, id DESC LIMIT 1`,
      [account.id, query.from]
    );
    if (prior) openingBalance = prior.balance_after;
  }

  let totalDeposits = 0, totalWithdrawals = 0, totalExchanges = 0, totalTransfers = 0;
  for (const r of rows) {
    if (r.type === "deposit") totalDeposits += r.amount; else totalWithdrawals += r.amount;
    if (r.source_type === "cash_exchange" || r.source_type === "exchange") totalExchanges += r.amount;
    if (r.source_type === "cash_transfer") totalTransfers += r.amount;
  }
  const closingBalance = rows.length ? rows[rows.length - 1].balance_after : openingBalance;

  return {
    account: {
      id: account.id, name: account.name, type: account.type, currency,
      status: account.status, reference: account.reference,
      currentBalance: account.balance,
    },
    rows: rows.map((r) => ({
      date: r.date,
      type: r.type,
      sourceType: r.source_type,
      description: r.description || "—",
      reference: r.reference_number || r.reference || "—",
      staff: r.staff_name || "—",
      deposit: r.type === "deposit" ? r.amount : null,
      withdrawal: r.type === "withdrawal" ? r.amount : null,
      balanceAfter: r.balance_after,
    })),
    summary: {
      openingBalance, totalDeposits, totalWithdrawals, totalExchanges, totalTransfers,
      closingBalance, totalTransactions: rows.length,
    },
  };
}

// Spec section 15 ("EXPORT FILE NAMING"): cash-movements-{account}-{currency}-{date}.ext,
// lowercase, spaces/invalid chars collapsed to hyphens — same convention the
// frontend's own exportFilename() already builds for the actual saved file;
// mirrored here too so the Content-Disposition header this route sets is
// never out of step with it (e.g. for direct API callers that aren't going
// through the app's download helper).
function cashStatementFilename(account, query, ext) {
  const base = `cash-movements-${account.name}-${account.currency}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const dateTag = query.to || new Date().toISOString().slice(0, 10);
  return `${base}-${dateTag}.${ext}`;
}

function register(router) {
  router.get("/api/cash/accounts/:id/statement.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "cash.view")) return;
    const data = loadCashAccountStatementData(params.id, query);
    if (data.error) return notFound(res, data.error);
    const pdf = await renderCashAccountStatementPDF({
      company: getCompanySettings(), account: data.account, rows: data.rows, summary: data.summary,
      from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultPdfTemplate("cash_account"),
    });
    addAudit(user, "Cash account statement exported (PDF)", `${data.account.name} (${data.account.currency})`);
    sendPDF(res, cashStatementFilename(data.account, query, "pdf"), pdf);
  });

  router.get("/api/cash/accounts/:id/statement.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "cash.view")) return;
    const data = loadCashAccountStatementData(params.id, query);
    if (data.error) return notFound(res, data.error);
    const buf = await buildCashAccountStatementWorkbook({
      company: getCompanySettings(), account: data.account, rows: data.rows, summary: data.summary,
      from: query.from, to: query.to, generatedBy: user.name,
      template: getDefaultExcelTemplate("cash_account"),
    });
    addAudit(user, "Cash account statement exported (Excel)", `${data.account.name} (${data.account.currency})`);
    sendXLSX(res, cashStatementFilename(data.account, query, "xlsx"), buf);
  });
}

module.exports = { register, loadCashAccountStatementData };
