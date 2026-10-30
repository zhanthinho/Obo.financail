"use strict";
const { all, get } = require("../db");
const { sendJSON, sendCSV, sendPDF } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { currencyPosition, effectiveStatus, getCompanySettings, getDefaultPdfTemplate, addAudit, costRateLookup } = require("../domain");
const { convert } = require("../util");
const { toCSV } = require("../csv");
const { renderTablePDF, renderReportPDF } = require("../pdf");

// GLOBAL RATE & PROFIT round: every exchange row adds to exactly ONE of two
// buckets, never both — Sell-side Profit (customer gave SLSH) or Buy-side
// Cost Rate Difference (customer gave USD) — in USD as stored, and in SLSH
// at that exchange's own Cost Rate (stored, or the one on its date).
// profitUSD stays as the old combined figure for existing API callers.
const { blankMargins, addStoredMargin, roundMargins } = require("../exchange-calc");
const addMargin = (b, t, lookup) => addStoredMargin(b, { currencyGiven: t.currency_given, profitUsd: t.profit_usd, costRate: t.cost_rate != null ? t.cost_rate : lookup(t.date) });
function exchangeFilter(query) {
  const clauses = ["status = 'active'"], params = [];
  if (query.from) { clauses.push("date(date) >= date(?)"); params.push(query.from); }
  if (query.to) { clauses.push("date(date) <= date(?)"); params.push(query.to); }
  // Currency filter: the currency the customer GAVE (USD = Buy side, SLSH = Sell side).
  if (query.currency === "USD" || query.currency === "SLSH") { clauses.push("currency_given = ?"); params.push(query.currency); }
  return { where: clauses.join(" AND "), params };
}

function exchangeSummaryRows(query) {
  const f = exchangeFilter(query);
  const txs = all(`SELECT * FROM exchange_transactions WHERE ${f.where}`, f.params);
  const lookup = costRateLookup();
  const map = {};
  for (const t of txs) {
    const day = t.date.slice(0, 10);
    map[day] = map[day] || { day, count: 0, volumeUSD: 0, ...blankMargins() };
    map[day].count += 1;
    map[day].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
    addMargin(map[day], t, lookup);
  }
  return Object.values(map).map(roundMargins).sort((a, b) => a.day.localeCompare(b.day));
}
function staffActivityRows(query) {
  const f = exchangeFilter(query);
  const txs = all(`SELECT * FROM exchange_transactions WHERE ${f.where}`, f.params);
  const lookup = costRateLookup();
  const map = {};
  for (const t of txs) {
    map[t.staff_id] = map[t.staff_id] || { staff: t.staff_name, count: 0, volumeUSD: 0, ...blankMargins() };
    map[t.staff_id].count += 1;
    map[t.staff_id].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
    addMargin(map[t.staff_id], t, lookup);
  }
  return Object.values(map).map(roundMargins).sort((a, b) => b.volumeUSD - a.volumeUSD);
}
const money0 = (n) => Math.round(n).toLocaleString("en-US");

function register(router) {
  router.get("/api/reports/exchange-summary", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const byDay = exchangeSummaryRows(query);
    const totalVolumeUSD = byDay.reduce((s, d) => s + d.volumeUSD, 0);
    const totalProfitUSD = byDay.reduce((s, d) => s + d.profitUSD, 0);
    const totalCount = byDay.reduce((s, d) => s + d.count, 0);
    const sum = (k) => byDay.reduce((s, d) => s + d[k], 0);
    sendJSON(res, 200, { byDay, totalVolumeUSD, totalProfitUSD, totalCount,
      totals: roundMargins({ profitUSD: totalProfitUSD, sellProfitUSD: sum("sellProfitUSD"), buyDiffUSD: sum("buyDiffUSD"), sellProfitSLSH: sum("sellProfitSLSH"), buyDiffSLSH: sum("buyDiffSLSH"), sellCount: sum("sellCount"), buyCount: sum("buyCount"), unvalued: sum("unvalued") }) });
  });
  router.get("/api/reports/exchange-summary/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const byDay = exchangeSummaryRows(query);
    addAudit(user, "Exchange summary exported (CSV)", `${byDay.length} day(s)`);
    sendCSV(res, "obo-exchange-summary.csv", toCSV(
      ["Date", "Transactions", "Volume (USD)", "Profit — Sell (USD)", "Profit — Sell (SLSH)", "Cost Rate Difference — Buy (USD)", "Cost Rate Difference — Buy (SLSH)"],
      byDay.map((d) => [d.day, d.count, d.volumeUSD.toFixed(2), d.sellProfitUSD.toFixed(2), d.sellProfitSLSH, d.buyDiffUSD.toFixed(2), d.buyDiffSLSH])
    ));
  });
  router.get("/api/reports/exchange-summary/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const byDay = exchangeSummaryRows(query);
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Exchange Summary Report",
      meta: `${query.from || "All time"} – ${query.to || "present"}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Date", width: 0.9 }, { label: "Txns", width: 0.5, align: "right" }, { label: "Volume (USD)", width: 1, align: "right" }, { label: "Profit — Sell", width: 1.4, align: "right" }, { label: "Cost Rate Difference — Buy", width: 1.6, align: "right" }],
      rows: byDay.map((d) => [d.day, String(d.count), `$${d.volumeUSD.toFixed(0)}`, `SLSH ${money0(d.sellProfitSLSH)} ($${d.sellProfitUSD.toFixed(2)})`, `SLSH ${money0(d.buyDiffSLSH)} ($${d.buyDiffUSD.toFixed(2)})`]),
    });
    addAudit(user, "Exchange summary exported (PDF)", `${byDay.length} day(s)`);
    sendPDF(res, "obo-exchange-summary.pdf", pdf);
  });

  router.get("/api/reports/quotations", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const rows = all("SELECT * FROM quotations");
    // TWO-STEP ACCOUNT LEDGER LOGIC: a quotation's lifecycle is now just
    // Pending (charged at creation, awaiting settlement) -> Paid or
    // Refunded — the old Draft/Sent/Accepted/Rejected/Expired pipeline is
    // gone. "Paid rate" (of all quotations ever created) replaces the old
    // "conversion rate" as the headline stat.
    const order = ["Pending", "Paid", "Refunded"];
    const counts = Object.fromEntries(order.map((s) => [s, 0]));
    const byStaff = {};
    rows.forEach((q) => {
      counts[effectiveStatus(q)] = (counts[effectiveStatus(q)] || 0) + 1;
      byStaff[q.created_by_name] = (byStaff[q.created_by_name] || 0) + 1;
    });
    const total = rows.length;
    const paid = counts.Paid || 0;
    sendJSON(res, 200, {
      total, paid, paidRatePercent: total ? +((paid / total) * 100).toFixed(1) : 0,
      byStatus: order.map((s) => ({ name: s, value: counts[s] })),
      byStaff: Object.entries(byStaff).map(([staff, count]) => ({ staff, count })),
    });
  });

  router.get("/api/reports/currency-position", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    sendJSON(res, 200, currencyPosition());
  });

  router.get("/api/reports/accounts-summary", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const totals = get("SELECT COUNT(*) as n, SUM(CASE WHEN account_type='customer' THEN 1 ELSE 0 END) as customers, SUM(CASE WHEN account_type='company' THEN 1 ELSE 0 END) as companies, SUM(balance_usd) as usd, SUM(balance_slsh) as slsh FROM clients WHERE deleted_at IS NULL");
    // SECURITY AUDIT round: permanently deleted accounts keep their row (with
    // its last balance) for history, but their ledger is gone — they must
    // not count towards today's totals, same as every other summary.
    const recentLedger = all("SELECT l.*, c.name as client_name, c.account_number FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE c.deleted_at IS NULL ORDER BY l.date DESC, l.created_at DESC, l.id DESC LIMIT 8");
    sendJSON(res, 200, {
      totalAccounts: totals.n || 0, totalCustomers: totals.customers || 0, totalCompanies: totals.companies || 0,
      totalBalanceUSD: totals.usd || 0, totalBalanceSLSH: totals.slsh || 0,
      recentLedger: recentLedger.map((l) => ({ id: l.id, type: l.type, currency: l.currency, amount: l.amount, accountName: l.client_name, accountNumber: l.account_number, date: l.date })),
    });
  });
  router.get("/api/reports/currency-position/export.csv", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const pos = currencyPosition();
    addAudit(user, "Currency position exported (CSV)", "");
    sendCSV(res, "obo-currency-position.csv", toCSV(
      ["Currency", "Opening balance", "Current balance"],
      [["USD", pos.opening.usd, pos.usd.toFixed(2)], ["SLSH", pos.opening.slsh, Math.round(pos.slsh)]]
    ));
  });
  router.get("/api/reports/currency-position/export.pdf", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const pos = currencyPosition();
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Currency Position Report",
      meta: `As of ${new Date().toLocaleDateString("en-GB")}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Currency", width: 1 }, { label: "Opening balance", width: 1.4, align: "right" }, { label: "Current balance", width: 1.4, align: "right" }],
      rows: [["USD", `$${pos.opening.usd.toLocaleString("en-US")}`, `$${pos.usd.toFixed(2)}`], ["SLSH", `SLSH ${pos.opening.slsh.toLocaleString("en-US")}`, `SLSH ${Math.round(pos.slsh)}`]],
    });
    addAudit(user, "Currency position exported (PDF)", "");
    sendPDF(res, "obo-currency-position.pdf", pdf);
  });

  router.get("/api/reports/staff-activity", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const rows = staffActivityRows(query);
    sendJSON(res, 200, { rows });
  });
  router.get("/api/reports/staff-activity/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const rows = staffActivityRows(query);
    addAudit(user, "Staff activity exported (CSV)", `${rows.length} staff`);
    sendCSV(res, "obo-staff-activity.csv", toCSV(
      ["Staff", "Transactions", "Volume (USD)", "Profit — Sell (USD)", "Cost Rate Difference — Buy (USD)"],
      rows.map((r) => [r.staff, r.count, r.volumeUSD.toFixed(2), r.sellProfitUSD.toFixed(2), r.buyDiffUSD.toFixed(2)])
    ));
  });
  router.get("/api/reports/staff-activity/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const rows = staffActivityRows(query);
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Staff Activity Report",
      meta: `${query.from || "All time"} – ${query.to || "present"}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Staff", width: 1.3 }, { label: "Txns", width: 0.6, align: "right" }, { label: "Volume (USD)", width: 1, align: "right" }, { label: "Profit — Sell (USD)", width: 1.2, align: "right" }, { label: "Cost Rate Difference — Buy (USD)", width: 1.5, align: "right" }],
      rows: rows.map((r) => [r.staff, String(r.count), `$${r.volumeUSD.toFixed(0)}`, `$${r.sellProfitUSD.toFixed(2)}`, `$${r.buyDiffUSD.toFixed(2)}`]),
    });
    addAudit(user, "Staff activity exported (PDF)", `${rows.length} staff`);
    sendPDF(res, "obo-staff-activity.pdf", pdf);
  });

  router.get("/api/reports/audit-log", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const clauses = [], sqlParams = [];
    if (query.actor) { clauses.push("actor_name = ?"); sqlParams.push(query.actor); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    // COMPANY ID VISIBILITY round: details written by Super Admin actions may
    // name a Company ID — stripped for anyone who is not a Super Admin.
    const rows = all(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT 500`, sqlParams)
      .map((r) => ({ ...r, details: require("../tenant-context").redactText(r.details) }));
    sendJSON(res, 200, { entries: rows });
  });
  router.get("/api/reports/audit-log/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const clauses = [], sqlParams = [];
    if (query.actor) { clauses.push("actor_name = ?"); sqlParams.push(query.actor); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    // COMPANY ID VISIBILITY round: details written by Super Admin actions may
    // name a Company ID — stripped for anyone who is not a Super Admin.
    const rows = all(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT 500`, sqlParams)
      .map((r) => ({ ...r, details: require("../tenant-context").redactText(r.details) }));
    addAudit(user, "Audit log exported (CSV)", `${rows.length} entries`);
    sendCSV(res, "obo-audit-log.csv", toCSV(
      ["Date/time", "Actor", "Role", "Action", "Details"],
      rows.map((l) => [l.at, l.actor_name, l.actor_role, l.action, l.details || ""])
    ));
  });
  router.get("/api/reports/audit-log/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const clauses = [], sqlParams = [];
    if (query.actor) { clauses.push("actor_name = ?"); sqlParams.push(query.actor); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    // COMPANY ID VISIBILITY round: details written by Super Admin actions may
    // name a Company ID — stripped for anyone who is not a Super Admin.
    const rows = all(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT 500`, sqlParams)
      .map((r) => ({ ...r, details: require("../tenant-context").redactText(r.details) }));
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Audit Log Report",
      meta: `${rows.length} entries`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Date/time", width: 1.3 }, { label: "Actor", width: 1.1 }, { label: "Action", width: 1.2 }, { label: "Details", width: 2 }],
      rows: rows.map((l) => [l.at.slice(0, 16).replace("T", " "), l.actor_name, l.action, l.details || ""]),
    });
    addAudit(user, "Audit log exported (PDF)", `${rows.length} entries`);
    sendPDF(res, "obo-audit-log.pdf", pdf);
  });
}

module.exports = { register };
