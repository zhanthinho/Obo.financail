"use strict";
// CASH ACCOUNT VIEW round: the genuinely-editable Excel counterpart of
// pdf.js's renderCashAccountStatementPDF — same underlying data (see
// routes/cashAccountStatements.js, which computes both from the SAME
// cash_ledger query so the two exports can never disagree), built the exact
// same way xlsx-account-report.js's buildAccountStatementWorkbook wraps the
// shared buildProfessionalWorkbook() engine. Purely additive — nothing about
// the customer Account Statement workbook changes.
const { buildProfessionalWorkbook } = require("./xlsx-engine");

const CASH_MOVEMENT_TYPE_LABEL = {
  cash_transfer: "Transfer", cash_exchange: "Exchange", exchange: "Exchange",
  loan: "Loan", loan_repayment: "Loan", customer_payment: "Payment", opening_balance: "Opening Balance",
  // COMPANY EXPENSES round.
  expense: "Expense", expense_reversal: "Expense Reversal",
};
function cashMovementTypeLabel(row) {
  if (row.sourceType && CASH_MOVEMENT_TYPE_LABEL[row.sourceType]) return CASH_MOVEMENT_TYPE_LABEL[row.sourceType];
  return row.type === "deposit" ? "Credit" : "Debit";
}

async function buildCashAccountStatementWorkbook({ company, account, rows, summary, from, to, generatedBy, template }) {
  const currency = account.currency;
  const numFmt = currency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"';

  const columns = [
    { key: "idx", label: "#", width: 6, align: "right" },
    { key: "date", label: "Date", width: 14, isDate: true },
    { key: "time", label: "Time", width: 12 },
    { key: "type", label: "Type", width: 14 },
    { key: "description", label: "Description", width: 34, wrap: true },
    { key: "deposit", label: "Credit", width: 16, numFmt, align: "right" },
    { key: "withdrawal", label: "Debit", width: 16, numFmt, align: "right" },
    { key: "balanceAfter", label: "Balance After", width: 16, numFmt, align: "right" },
    { key: "reference", label: "Reference", width: 16 },
    { key: "staff", label: "Staff", width: 18 },
  ];

  // GLOBAL "LAST BALANCE AT THE BOTTOM" round: the balance figure moves
  // from the top KPI band into totalsBox (see buildProfessionalWorkbook),
  // a label/value block placed AFTER the movements table, with "Last
  // Balance" as the final, emphasized row — same real SUM() formulas for
  // Deposits/Withdrawals, same figures, layout only.
  const totalsBox = [
    { label: "Opening Balance", value: summary.openingBalance, numFmt },
    { label: "Total Credits", formulaKey: "deposit", formulaFn: "sum", value: summary.totalDeposits, numFmt },
    { label: "Total Debits", formulaKey: "withdrawal", formulaFn: "sum", value: summary.totalWithdrawals, numFmt },
    { label: "Total Exchanges", value: summary.totalExchanges, numFmt },
    { label: "Total Transfers", value: summary.totalTransfers, numFmt },
    { label: "Last Balance", value: summary.closingBalance, numFmt, emph: true },
  ];

  const infoRows = [
    { label: "Account Name", value: account.name },
    { label: "Account Type", value: account.type },
    { label: "Currency", value: currency },
    { label: "Status", value: account.status === "active" ? "Active" : "Deactivated" },
    { label: "Opening Balance (period)", value: summary.openingBalance },
    { label: "Current Balance", value: account.currentBalance },
    { label: "Date Range", value: from || to ? `${from || "start"} to ${to || "today"}` : "All time" },
  ];

  return buildProfessionalWorkbook({
    company, template,
    sheetName: "Cash Movements",
    docTypeLabel: `CASH ACCOUNT STATEMENT — ${currency}`,
    subtitleLines: [
      `Period: ${from || to ? `${from || "start"} to ${to || "today"}` : "All time"} · Generated ${new Date().toLocaleString("en-GB")}${generatedBy ? ` by ${generatedBy}` : ""}`,
    ],
    infoRows,
    table: {
      columns,
      rows: rows.map((row, i) => ({
        ...row,
        idx: i + 1,
        date: row.date ? new Date(row.date) : null,
        time: row.date && String(row.date).length > 10 ? new Date(row.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "",
        type: cashMovementTypeLabel(row),
      })),
      cellValue: (row, key) => row[key],
      totalsRow: { date: "TOTAL", deposit: "sum", withdrawal: "sum" },
    },
    totalsBox,
    generatedBy,
  });
}

module.exports = { buildCashAccountStatementWorkbook };
