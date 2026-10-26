"use strict";
// COMPANY EXPENSES round — HTTP API for the Company Expenses module. All the
// accounting lives in ../expenses.js; this file only authenticates, checks
// permissions and shapes requests/responses.
//
// Company isolation: requireAuth binds every request to the company named in
// the server-signed session token, and each company has its own database, so
// every query below can only ever see the signed-in company's expenses,
// categories and Cash in Hand accounts. Nothing here reads a company id from
// the request.
const { sendJSON, sendCSV, sendPDF, sendXLSX, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, can } = require("../rbac");
const { getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, addAudit } = require("../domain");
const { fmtMoney } = require("../util");
const { toCSV } = require("../csv");
const { renderReportPDF } = require("../pdf");
const { buildProfessionalWorkbook } = require("../xlsx-engine");
const ex = require("../expenses");

// Expense bodies may carry a receipt (≤3 MB file ≈ 4 MB base64), which fits
// inside readJSONBody's existing 5 MB request limit.

function fail(res, e) {
  if (e instanceof ex.ExpenseError) {
    if (e.status === 404) return notFound(res, e.message);
    return sendJSON(res, e.status, { error: e.message, ...(e.code ? { field: e.code } : {}) });
  }
  throw e;
}
async function body(req, res) {
  try { return await readJSONBody(req); } catch (e) { badRequest(res, e.message); return null; }
}

const GROUP_LABEL = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly", category: "By Category", account: "By Payment Account", currency: "By Currency", detail: "Detailed Transactions" };
const KEY_LABEL = { day: "Date", week: "Week starting", month: "Month", year: "Year", category: "Category", account: "Paid From", currency: "Currency" };
const periodLabel = (q) => `${q.from || "All time"} – ${q.to || "present"}`;
const money = (n, c) => fmtMoney(n, c);

// Table columns + plain rows for a report, shared by CSV, PDF and Excel so
// all three always carry exactly the same figures as the screen.
function reportTable(rep) {
  if (rep.groupBy === "detail") {
    const columns = ["Date", "Reference", "Category", "Description", "Paid From", "Currency", "Amount", "Created By"];
    const rows = rep.rows.map((r) => [r.date, r.reference, r.category, r.description, r.paidFrom, r.currency, r.amount, r.createdBy]);
    return { columns, rows };
  }
  const columns = [KEY_LABEL[rep.groupBy], "Expenses (USD)", "Count (USD)", "Expenses (SLSH)", "Count (SLSH)"];
  const rows = rep.rows.map((r) => [r.key, r.USD, r.countUSD, r.SLSH, r.countSLSH]);
  return { columns, rows };
}

function register(router) {
  // ---- reference data for the page and the form --------------------------
  router.get("/api/expenses/meta", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    const accounts = ex.paymentAccounts().map((a) => ({
      id: a.id, name: a.name, type: a.type, currency: a.currency,
      // The paying account's balance is shown only to someone who can record
      // or edit expenses (they need it to choose) or who can see Cash in Hand.
      ...(can(user, "expenses.create") || can(user, "expenses.update") || can(user, "cash.view") ? { balance: a.balance } : {}),
    }));
    sendJSON(res, 200, { categories: ex.listCategories(), accounts });
  });

  router.get("/api/expenses/summary", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    sendJSON(res, 200, ex.summary(query));
  });

  // ---- reports & exports ------------------------------------------------
  router.get("/api/expenses/report", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    sendJSON(res, 200, ex.report(query));
  });
  router.get("/api/expenses/report/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.export")) return;
    const rep = ex.report(query);
    const t = reportTable(rep);
    // Money to 2 decimals, counts as whole numbers, text untouched.
    const moneyCols = rep.groupBy === "detail" ? new Set([6]) : new Set([1, 3]);
    const rows = t.rows.map((r) => r.map((c, i) => (moneyCols.has(i) ? ex.round2(c).toFixed(2) : c)));
    const totals = rep.groupBy === "detail"
      ? [["TOTAL (USD)", "", "", "", "", "USD", ex.round2(rep.grand.USD).toFixed(2), ""], ["TOTAL (SLSH)", "", "", "", "", "SLSH", ex.round2(rep.grand.SLSH).toFixed(2), ""]]
      : [["TOTAL", ex.round2(rep.grand.USD).toFixed(2), rep.grand.countUSD, ex.round2(rep.grand.SLSH).toFixed(2), rep.grand.countSLSH]];
    addAudit(user, "Expense report exported (CSV)", `${GROUP_LABEL[rep.groupBy]} · ${periodLabel(query)}`);
    sendCSV(res, `obo-expenses-${rep.groupBy}.csv`, toCSV(t.columns, [...rows, ...totals]));
  });
  router.get("/api/expenses/report/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.export")) return;
    const rep = ex.report(query);
    const t = reportTable(rep);
    const isDetail = rep.groupBy === "detail";
    const rows = isDetail
      ? t.rows.map((r) => [r[0], r[1], r[2], r[3], r[4], money(r[6], r[5]), r[7]])
      : t.rows.map((r) => [r[0], money(r[1], "USD"), String(r[2]), money(r[3], "SLSH"), String(r[4])]);
    const columns = isDetail
      ? [{ label: "Date", width: 0.9 }, { label: "Reference", width: 1 }, { label: "Category", width: 1.1 }, { label: "Description", width: 1.8 }, { label: "Paid From", width: 1.1 }, { label: "Amount", width: 1, align: "right" }, { label: "Created By", width: 1 }]
      : [{ label: t.columns[0], width: 1.4 }, { label: "Expenses (USD)", width: 1.2, align: "right" }, { label: "Count (USD)", width: 0.8, align: "right" }, { label: "Expenses (SLSH)", width: 1.4, align: "right" }, { label: "Count (SLSH)", width: 0.8, align: "right" }];
    const totalRows = isDetail
      ? [["", "", "", "TOTAL (USD)", "", money(rep.grand.USD, "USD"), ""], ["", "", "", "TOTAL (SLSH)", "", money(rep.grand.SLSH, "SLSH"), ""]]
      : [["TOTAL", money(rep.grand.USD, "USD"), String(rep.grand.countUSD), money(rep.grand.SLSH, "SLSH"), String(rep.grand.countSLSH)]];
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: `Expense Report — ${GROUP_LABEL[rep.groupBy]}`,
      meta: `Period: ${periodLabel(query)}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns, rows: [...rows, ...totalRows],
    });
    addAudit(user, "Expense report exported (PDF)", `${GROUP_LABEL[rep.groupBy]} · ${periodLabel(query)}`);
    sendPDF(res, `obo-expenses-${rep.groupBy}.pdf`, pdf);
  });
  router.get("/api/expenses/report/export.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.export")) return;
    const rep = ex.report(query);
    const isDetail = rep.groupBy === "detail";
    const usdFmt = '"$"#,##0.00', slshFmt = '#,##0 "SLSH"';
    const columns = isDetail
      ? [
        { key: "date", label: "Date", width: 12 }, { key: "reference", label: "Reference", width: 16 },
        { key: "category", label: "Category", width: 20 }, { key: "description", label: "Description", width: 34 },
        { key: "paidFrom", label: "Paid From", width: 20 }, { key: "currency", label: "Currency", width: 10 },
        { key: "amount", label: "Amount", width: 16, align: "right", numFmt: (r) => (r.currency === "USD" ? usdFmt : slshFmt) },
        { key: "createdBy", label: "Created By", width: 18 },
      ]
      : [
        { key: "key", label: KEY_LABEL[rep.groupBy], width: 22 },
        { key: "USD", label: "Expenses (USD)", width: 18, align: "right", numFmt: usdFmt },
        { key: "countUSD", label: "Count (USD)", width: 12, align: "right" },
        { key: "SLSH", label: "Expenses (SLSH)", width: 20, align: "right", numFmt: slshFmt },
        { key: "countSLSH", label: "Count (SLSH)", width: 12, align: "right" },
      ];
    const xlsx = await buildProfessionalWorkbook({
      company: getCompanySettings(),
      generatedBy: user.name,
      template: getDefaultExcelTemplate("reports"),
      sheetName: "Expenses",
      docTypeLabel: `EXPENSE REPORT — ${GROUP_LABEL[rep.groupBy].toUpperCase()}`,
      subtitleLines: [`Period: ${periodLabel(query)} · Generated ${new Date().toLocaleString("en-GB")} by ${user.name}`],
      table: {
        columns,
        rows: rep.rows,
        cellValue: (r, key) => r[key],
        totalsRow: isDetail ? undefined : { key: "TOTAL", USD: "sum", countUSD: "sum", SLSH: "sum", countSLSH: "sum" },
      },
      // USD and SLSH totals are always kept apart.
      totalsBox: [
        { label: "Total Expenses (USD)", value: rep.grand.USD, numFmt: usdFmt },
        { label: "Total Expenses (SLSH)", value: rep.grand.SLSH, numFmt: slshFmt },
        { label: "Expense Transactions", value: rep.grand.count, emph: true },
      ],
    });
    addAudit(user, "Expense report exported (Excel)", `${GROUP_LABEL[rep.groupBy]} · ${periodLabel(query)}`);
    sendXLSX(res, `obo-expenses-${rep.groupBy}.xlsx`, xlsx);
  });

  // ---- categories --------------------------------------------------------
  router.get("/api/expense-categories", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    sendJSON(res, 200, { categories: ex.listCategories() });
  });
  router.post("/api/expense-categories", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.manageCategories")) return;
    const b = await body(req, res); if (!b) return;
    try { sendJSON(res, 201, { category: ex.createCategory(user, b) }); } catch (e) { fail(res, e); }
  });
  router.patch("/api/expense-categories/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.manageCategories")) return;
    const b = await body(req, res); if (!b) return;
    try { sendJSON(res, 200, { category: ex.updateCategory(user, params.id, b) }); } catch (e) { fail(res, e); }
  });

  // ---- expenses ----------------------------------------------------------
  router.get("/api/expenses", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    sendJSON(res, 200, ex.listExpenses(query));
  });
  router.post("/api/expenses", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.create")) return;
    const b = await body(req, res); if (!b) return;
    try {
      const r = ex.createExpense(user, b);
      sendJSON(res, r.duplicate ? 200 : 201, r);
    } catch (e) { fail(res, e); }
  });
  router.get("/api/expenses/:id/attachment", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    const f = ex.attachmentFile(params.id);
    if (!f) return notFound(res, "No receipt is attached to this expense.");
    const buf = Buffer.from(f.data_base64, "base64");
    const safeName = String(f.file_name).replace(/[^\w.\- ]+/g, "_");
    res.writeHead(200, {
      "Content-Type": f.mime_type,
      "Content-Length": buf.length,
      "Content-Disposition": `${req.url.includes("download=1") ? "attachment" : "inline"}; filename="${safeName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    res.end(buf);
  });
  router.get("/api/expenses/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.view")) return;
    const d = ex.detail(params.id);
    if (!d) return notFound(res, "Expense not found.");
    sendJSON(res, 200, { expense: d });
  });
  router.patch("/api/expenses/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.update")) return;
    const b = await body(req, res); if (!b) return;
    try { sendJSON(res, 200, { expense: ex.updateExpense(user, params.id, b) }); } catch (e) { fail(res, e); }
  });
  router.post("/api/expenses/:id/cancel", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "expenses.cancel")) return;
    const b = await body(req, res); if (!b) return;
    try { sendJSON(res, 200, { expense: ex.cancelExpense(user, params.id, b.reason) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
