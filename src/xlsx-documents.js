"use strict";
// MASTER PROMPT — Excel counterparts of pdf.js's renderQuotationDocumentPDF,
// renderExchangeReceiptPDF, and renderTransactionStatementPDF, built on the
// shared buildProfessionalWorkbook() engine (src/xlsx-engine.js). Each of
// these mirrors its PDF sibling's exact field shapes and source data so the
// PDF/Excel/Preview/Print of a given document can never disagree — same
// caller-supplied config, just rendered by a different engine.
const { buildProfessionalWorkbook } = require("./xlsx-engine");
const { convert } = require("./util");

function fmtDateTime(d) {
  return d ? String(d).slice(0, 19).replace("T", " ") : "—";
}

// ---- Quotation workbook — one real Excel Table of line items + totals ----
async function buildQuotationWorkbook({ quotation, items, totals, statusLabel, company, columns, template, generatedBy, payment, payments }) {
  const showNotes = template ? !!template.show_notes : true;
  const showBillToAddress = template ? !!template.show_bill_to_address : true;
  const showBillToContact = template ? !!template.show_bill_to_contact : true;

  // CURRENCY-AWARE RENDERING (spec section 16) — same mode/rate handling as
  // pdf.js's renderQuotationDocumentPDF, kept in lockstep so the PDF and
  // Excel exports of a given quotation never disagree.
  const mode = quotation.currency_mode === "SLSH" || quotation.currency_mode === "BOTH" ? quotation.currency_mode : "USD";
  const rate = Number(quotation.rate_used) || 0;
  const lineSubtotal = (it) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0);

  const defaultCols =
    mode === "BOTH"
      ? [
          { key: "description", label: "Description", width: 34 },
          { key: "qty", label: "Qty", width: 8, align: "right" },
          { key: "unitPrice", label: "Unit price", width: 14, align: "right" },
          { key: "currency", label: "Cur.", width: 8 },
          { key: "totalUSD", label: "Total (USD)", width: 14, align: "right" },
          { key: "totalSLSH", label: "Total (SLSH)", width: 16, align: "right" },
        ]
      : [
          { key: "description", label: "Description", width: 34 },
          { key: "qty", label: "Qty", width: 8, align: "right" },
          { key: "unitPrice", label: `Unit price (${mode})`, width: 16, align: "right" },
          { key: "subtotal", label: `Total (${mode})`, width: 16, align: "right" },
        ];
  const cellValue = (it, key) => {
    if (key === "description") return it.description;
    if (key === "qty") return Number(it.qty) || 0;
    if (key === "unitPrice") return Number(it.unit_price) || 0;
    if (key === "currency") return it.currency;
    if (key === "subtotal") return lineSubtotal(it);
    if (key === "totalUSD") return rate ? convert(lineSubtotal(it), it.currency, "USD", rate) : (it.currency === "USD" ? lineSubtotal(it) : 0);
    if (key === "totalSLSH") return Math.round(rate ? convert(lineSubtotal(it), it.currency, "SLSH", rate) : (it.currency === "SLSH" ? lineSubtotal(it) : 0));
    let extra = {};
    try { extra = it.extra_fields ? JSON.parse(it.extra_fields) : {}; } catch (e) {}
    return extra[key] != null && extra[key] !== "" ? extra[key] : "—";
  };
  const numericCols = ["qty", "unitPrice", "subtotal", "totalUSD", "totalSLSH"];
  // EXPORT FIX: a caller-supplied column's own `width` (e.g. from the
  // on-screen column customizer) used to be discarded here and silently
  // replaced with a hardcoded 16 — honor it when present, falling back to 16
  // only when no valid width was supplied.
  const cols = (columns && columns.length
    ? columns.map((c) => ({ ...c, width: typeof c.width === "number" && c.width > 0 ? c.width : 16, align: numericCols.includes(c.key) ? "right" : "left" }))
    : defaultCols
  // GLOBAL CURRENCY FORMATTING round: totalUSD/totalSLSH are always one
  // fixed currency, so they get a static Excel format; unitPrice/subtotal
  // follow whatever currency the DOCUMENT is in when it's single-currency,
  // but in BOTH mode each line item can be its own currency (`it.currency`),
  // so those two get a per-row numFmt instead of one fixed format.
  ).map((c) => ({
    ...c,
    numFmt:
      c.key === "totalUSD" ? '"$"#,##0.00'
      : c.key === "totalSLSH" ? '#,##0 "SLSH"'
      : ["unitPrice", "subtotal"].includes(c.key)
        ? (mode === "BOTH" ? (row) => (row.currency === "SLSH" ? '#,##0 "SLSH"' : '"$"#,##0.00') : (mode === "SLSH" ? '#,##0 "SLSH"' : '"$"#,##0.00'))
        : undefined,
  }));

  const infoRows = [{ label: "Bill to", value: quotation.client_name }];
  if (quotation.client_address && showBillToAddress) infoRows.push({ label: "Address", value: quotation.client_address });
  if (quotation.client_contact && showBillToContact) infoRows.push({ label: "Contact", value: quotation.client_contact });
  infoRows.push({ label: "Currency", value: mode });
  if (mode === "BOTH" && rate) infoRows.push({ label: "Exchange Rate", value: `1 USD = SLSH ${rate}` });

  // PARTIAL PAYMENT UPGRADE round (spec section 16): every payment ever
  // recorded against this quotation, listed here as its own permanent
  // Payment History block — same data the PDF's "PAYMENT HISTORY" extra page
  // and the settlement modal both read from (never recomputed separately).
  if (payments && payments.length) {
    infoRows.push({ label: "Payment History", value: "" });
    payments.forEach((p, i) => {
      infoRows.push({
        label: `  Payment #${i + 1} — ${String(p.date).slice(0, 10)}`,
        value: `${p.amount.toFixed(2)} ${p.currency} · ${p.method || "—"} · Staff: ${p.staffName || "—"} · Ref: ${p.reference || p.externalReference || "—"}`,
      });
    });
  }

  // Never combine USD + SLSH into one figure (spec item 10) — only the
  // currency figure(s) that are meaningful for the selected mode appear.
  const summaryCards = [
    { label: "Discount", value: `${quotation.discount_percent || 0}%` },
    { label: "Tax", value: `${quotation.tax_percent || 0}%` },
  ];
  if (mode === "USD" || mode === "BOTH") summaryCards.push({ label: "Total (USD)", value: totals.totalUSD, numFmt: '"$"#,##0.00' });
  if (mode === "SLSH" || mode === "BOTH") summaryCards.push({ label: "Total (SLSH)", value: Math.round(totals.totalSLSH), numFmt: '#,##0 "SLSH"' });
  // PARTIAL PAYMENT UPGRADE round (spec section 16): Original/Paid/Remaining/
  // Status appended to the same KPI band, computed by the identical
  // quotationPaymentSummary() the PDF and the on-screen table both use.
  if (payment) {
    const payCurrency = quotation.charged_currency === "SLSH" ? "SLSH" : "USD";
    const payFmt = payCurrency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"';
    summaryCards.push({ label: "Original Amount", value: payment.originalAmount, numFmt: payFmt });
    summaryCards.push({ label: "Total Paid", value: payment.totalPaid, numFmt: payFmt });
    summaryCards.push({ label: "Remaining", value: payment.remaining, numFmt: payFmt });
    summaryCards.push({ label: "Status", value: (payment.computedStatus || quotation.status || "").toUpperCase() });
  }

  const totalsRow = { description: "TOTAL" };
  const rowKeys = cols.map((c) => c.key);
  if (rowKeys.includes("subtotal")) totalsRow.subtotal = "sum";
  if (rowKeys.includes("totalUSD")) totalsRow.totalUSD = "sum";
  if (rowKeys.includes("totalSLSH")) totalsRow.totalSLSH = "sum";

  return buildProfessionalWorkbook({
    company, generatedBy, template,
    sheetName: "Quotation",
    docTypeLabel: "QUOTATION",
    docNumber: quotation.number,
    statusLabel: `${(statusLabel || quotation.status || "").toUpperCase()}${quotation.invoiced ? " · INVOICED" : ""}`,
    subtitleLines: [`Issued ${quotation.issue_date}   ·   Valid until ${quotation.valid_until || "—"}`],
    infoRows,
    summaryCards,
    table: {
      columns: cols,
      rows: items,
      cellValue,
      totalsRow,
    },
    notes: showNotes ? quotation.notes : null,
  });
}

// ---- Money Exchange Receipt workbook — no item table, KPI band + info rows ----
async function buildExchangeReceiptWorkbook({ company, tx, dailyRate, saleRate, canViewProfit, generatedBy, template }) {
  const infoRows = [
    { label: "Reference", value: tx.referenceNumber || tx.id },
    { label: "Date", value: fmtDateTime(tx.date) },
    { label: "Customer", value: tx.clientName },
    { label: "From currency", value: tx.currencyGiven },
    { label: "To currency", value: tx.currencyReceived },
    { label: "Daily rate", value: dailyRate || null },
    { label: "Sale rate", value: saleRate || null },
    { label: "Staff", value: tx.staffName },
  ];
  const summaryCards = [
    { label: "Amount Given", value: Number(tx.amountGiven) || 0, numFmt: tx.currencyGiven === "SLSH" ? '#,##0 "SLSH"' : '"$"#,##0.00' },
    { label: "Amount Received", value: Number(tx.amountReceived) || 0, numFmt: tx.currencyReceived === "SLSH" ? '#,##0 "SLSH"' : '"$"#,##0.00' },
    { label: "Applied Rate", value: Number(tx.rateUsed) || 0, numFmt: '#,##0.00 "SLSH"' },
  ];
  if (canViewProfit) summaryCards.push({ label: "Exchange Profit", value: Number(tx.profitUsd) || 0, numFmt: '"$"#,##0.00' });

  return buildProfessionalWorkbook({
    company, generatedBy, template,
    sheetName: "Exchange Receipt",
    docTypeLabel: "MONEY EXCHANGE RECEIPT",
    docNumber: tx.referenceNumber || `EX-${tx.id}`,
    statusLabel: tx.status === "voided" ? "VOIDED" : "COMPLETED",
    infoRows,
    summaryCards,
    notes: tx.status === "voided" ? (tx.voidReason || tx.notes) : tx.notes,
  });
}

// ---- Transaction Statement workbook — filtered multi-type history list ----
async function buildTransactionStatementWorkbook({ company, rows, filterSummary, totals, from, to, generatedBy, template }) {
  const columns = [
    { key: "idx", label: "#", width: 6, align: "right" },
    { key: "date", label: "Date", width: 14, isDate: true },
    { key: "reference", label: "Reference", width: 16 },
    { key: "type", label: "Type", width: 14 },
    { key: "account", label: "Account", width: 20 },
    { key: "amount", label: "Amount", width: 16, align: "right" },
    { key: "status", label: "Status", width: 12 },
  ];
  const periodText = from || to ? `Period: ${from || "start"} to ${to || "today"}` : "Period: All time";
  const cellValue = (r, key, idx) => {
    if (key === "idx") return idx + 1;
    if (key === "date") return String(r.date).slice(0, 10);
    if (key === "account") return r.accountName || "—";
    if (key === "amount") return r.amountSummary || "—";
    return r[key] != null ? r[key] : "—";
  };
  return buildProfessionalWorkbook({
    company, generatedBy, template,
    sheetName: "Transaction Statement",
    docTypeLabel: "TRANSACTION STATEMENT",
    subtitleLines: [
      `${periodText}   ·   Generated ${new Date().toLocaleString("en-GB")}${generatedBy ? ` by ${generatedBy}` : ""}`,
      filterSummary || "All transaction types",
    ],
    summaryCards: [
      { label: "Total Transactions", value: totals.totalTransactions },
      { label: "Total Credits", value: totals.totalDepositsLabel },
      { label: "Total Debits", value: totals.totalWithdrawalsLabel },
      { label: "Net Movement", value: totals.netMovementLabel },
    ],
    table: {
      columns, rows,
      cellValue,
      totalsRow: { date: "TOTAL" },
    },
  });
}

module.exports = { buildQuotationWorkbook, buildExchangeReceiptWorkbook, buildTransactionStatementWorkbook };
