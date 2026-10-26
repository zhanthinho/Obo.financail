"use strict";
// PROFESSIONAL ACCOUNT REPORTS: the genuinely-editable Excel counterpart of
// pdf.js's renderAccountStatementPDF — same underlying data (see
// routes/accountStatements.js, which computes both from the SAME
// account_ledger query so the two exports can never disagree).
//
// MASTER PROMPT update: rewritten as a thin wrapper around the shared
// buildProfessionalWorkbook() engine (src/xlsx-engine.js), and reduced from
// the earlier 4-sheet design (Account Statement / Transactions / Summary /
// Account Information) down to the master spec's "ONE SHEET ONLY" rule.
// Every KPI here is a real SUM formula over the same-sheet table — never a
// hardcoded duplicate number.
const { buildProfessionalWorkbook } = require("./xlsx-engine");

// The same customizable tail columns renderAccountStatementPDF respects —
// kept in sync deliberately (see that function's own comment for why "#",
// Date, Reference, and Type are always fixed and not part of this set).
const STATEMENT_COLUMN_DEFS = {
  notes: { header: "Description / Notes", width: 36 },
  deposit: { header: "Credit", width: 16 },
  withdrawal: { header: "Debit", width: 16 },
  balanceAfter: { header: "Balance After", width: 16 },
  staff: { header: "Staff", width: 18 },
};

async function buildAccountStatementWorkbook({ company, account, rows, summary, columnOrder, from, to, generatedBy, template }) {
  const currency = account.currency;
  const numFmt = currency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"';

  const tailCols = (columnOrder || []).filter((k) => STATEMENT_COLUMN_DEFS[k]);
  const columns = [
    { key: "idx", label: "#", width: 6, align: "right" },
    { key: "date", label: "Date", width: 14, isDate: true },
    { key: "reference", label: "Reference", width: 16 },
    { key: "type", label: "Type", width: 12 },
    ...tailCols.map((k) => ({
      key: k,
      label: STATEMENT_COLUMN_DEFS[k].header,
      width: STATEMENT_COLUMN_DEFS[k].width,
      numFmt: k === "deposit" || k === "withdrawal" || k === "balanceAfter" ? numFmt : undefined,
      align: k === "deposit" || k === "withdrawal" || k === "balanceAfter" ? "right" : undefined,
      wrap: k === "notes",
    })),
  ];

  const totalsRow = { date: "TOTAL" };
  if (tailCols.includes("deposit")) totalsRow.deposit = "sum";
  if (tailCols.includes("withdrawal")) totalsRow.withdrawal = "sum";

  // GLOBAL "LAST BALANCE AT THE BOTTOM" round: the balance figure no longer
  // sits in the top KPI band — it moves into totalsBox (see
  // buildProfessionalWorkbook), a label/value block placed AFTER the
  // transaction table, with "Last Balance" as the final, emphasized row.
  // Opening Balance / Total Deposits / Total Withdrawals move down with it
  // (same real SUM() formulas as before, just relocated) — same figures,
  // same math, layout only.
  const closingBalance = summary.closingBalance != null ? summary.closingBalance : summary.openingBalance + summary.totalDeposits - summary.totalWithdrawals;
  const totalsBox = [
    { label: "Opening Balance", value: summary.openingBalance, numFmt },
    { label: "Total Credits", formulaKey: tailCols.includes("deposit") ? "deposit" : null, formulaFn: "sum", value: summary.totalDeposits, numFmt },
    { label: "Total Debits", formulaKey: tailCols.includes("withdrawal") ? "withdrawal" : null, formulaFn: "sum", value: summary.totalWithdrawals, numFmt },
    { label: "Last Balance", value: closingBalance, numFmt, emph: true },
  ].map((c) => (c.formulaKey ? c : { label: c.label, value: c.value, numFmt: c.numFmt, emph: c.emph }));

  const infoRows = [
    { label: "Account #", value: account.accountNumber },
    { label: "Account Name", value: account.name },
    { label: "Account Type", value: account.accountType === "company" ? "Company" : "Customer" },
    { label: "Currency", value: currency },
    { label: "Registration Date", value: account.registrationDate ? String(account.registrationDate).slice(0, 10) : null },
  ];

  return buildProfessionalWorkbook({
    company, template,
    sheetName: "Account Statement",
    docTypeLabel: `ACCOUNT STATEMENT — ${currency}`,
    subtitleLines: [
      `Period: ${from || to ? `${from || "start"} to ${to || "today"}` : "All time"} · Generated ${new Date().toLocaleString("en-GB")}${generatedBy ? ` by ${generatedBy}` : ""}`,
    ],
    infoRows,
    table: {
      columns,
      rows: rows.map((row, i) => ({ ...row, idx: i + 1, date: row.date ? new Date(row.date) : null })),
      cellValue: (row, key) => row[key],
      totalsRow,
    },
    totalsBox,
    generatedBy,
  });
}

module.exports = { buildAccountStatementWorkbook };
