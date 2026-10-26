"use strict";
const { all, get } = require("../db");
const { sendJSON, sendCSV, sendPDF } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { currencyPosition, effectiveStatus, getCompanySettings, getDefaultPdfTemplate, addAudit } = require("../domain");
const { convert } = require("../util");
const { toCSV } = require("../csv");
const { renderTablePDF, renderReportPDF } = require("../pdf");

function exchangeSummaryRows(query) {
  const clauses = ["status = 'active'"], params = [];
  if (query.from) { clauses.push("date(date) >= date(?)"); params.push(query.from); }
  if (query.to) { clauses.push("date(date) <= date(?)"); params.push(query.to); }
  const txs = all(`SELECT * FROM exchange_transactions WHERE ${clauses.join(" AND ")}`, params);
  const map = {};
  for (const t of txs) {
    const day = t.date.slice(0, 10);
    map[day] = map[day] || { day, count: 0, volumeUSD: 0, profitUSD: 0 };
    map[day].count += 1;
    map[day].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
    map[day].profitUSD += Number(t.profit_usd) || 0;
  }
  return Object.values(map).sort((a, b) => a.day.localeCompare(b.day));
}

function register(router) {
  router.get("/api/reports/exchange-summary", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const byDay = exchangeSummaryRows(query);
    const totalVolumeUSD = byDay.reduce((s, d) => s + d.volumeUSD, 0);
    const totalProfitUSD = byDay.reduce((s, d) => s + d.profitUSD, 0);
    const totalCount = byDay.reduce((s, d) => s + d.count, 0);
    sendJSON(res, 200, { byDay, totalVolumeUSD, totalProfitUSD, totalCount });
  });
  router.get("/api/reports/exchange-summary/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const byDay = exchangeSummaryRows(query);
    addAudit(user, "Exchange summary exported (CSV)", `${byDay.length} day(s)`);
    sendCSV(res, "obo-exchange-summary.csv", toCSV(
      ["Date", "Transactions", "Volume (USD)", "Profit (USD)"],
      byDay.map((d) => [d.day, d.count, d.volumeUSD.toFixed(2), d.profitUSD.toFixed(2)])
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
      columns: [{ label: "Date", width: 1 }, { label: "Transactions", width: 1, align: "right" }, { label: "Volume (USD)", width: 1.2, align: "right" }, { label: "Profit (USD)", width: 1.2, align: "right" }],
      rows: byDay.map((d) => [d.day, String(d.count), `$${d.volumeUSD.toFixed(0)}`, `$${d.profitUSD.toFixed(2)}`]),
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
    const recentLedger = all("SELECT l.*, c.name as client_name, c.account_number FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE c.deleted_at IS NULL ORDER BY l.date DESC LIMIT 8");
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
    const clauses = ["status = 'active'"], sqlParams = [];
    if (query.from) { clauses.push("date(date) >= date(?)"); sqlParams.push(query.from); }
    if (query.to) { clauses.push("date(date) <= date(?)"); sqlParams.push(query.to); }
    const txs = all(`SELECT * FROM exchange_transactions WHERE ${clauses.join(" AND ")}`, sqlParams);
    const map = {};
    for (const t of txs) {
      map[t.staff_id] = map[t.staff_id] || { staff: t.staff_name, count: 0, volumeUSD: 0, profitUSD: 0 };
      map[t.staff_id].count += 1;
      map[t.staff_id].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
      map[t.staff_id].profitUSD += Number(t.profit_usd) || 0;
    }
    const rows = Object.values(map).sort((a, b) => b.volumeUSD - a.volumeUSD);
    sendJSON(res, 200, { rows });
  });
  router.get("/api/reports/staff-activity/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const clauses = ["status = 'active'"], sqlParams = [];
    if (query.from) { clauses.push("date(date) >= date(?)"); sqlParams.push(query.from); }
    if (query.to) { clauses.push("date(date) <= date(?)"); sqlParams.push(query.to); }
    const txs = all(`SELECT * FROM exchange_transactions WHERE ${clauses.join(" AND ")}`, sqlParams);
    const map = {};
    for (const t of txs) {
      map[t.staff_id] = map[t.staff_id] || { staff: t.staff_name, count: 0, volumeUSD: 0, profitUSD: 0 };
      map[t.staff_id].count += 1;
      map[t.staff_id].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
      map[t.staff_id].profitUSD += Number(t.profit_usd) || 0;
    }
    const rows = Object.values(map).sort((a, b) => b.volumeUSD - a.volumeUSD);
    addAudit(user, "Staff activity exported (CSV)", `${rows.length} staff`);
    sendCSV(res, "obo-staff-activity.csv", toCSV(
      ["Staff", "Transactions", "Volume (USD)", "Profit (USD)"],
      rows.map((r) => [r.staff, r.count, r.volumeUSD.toFixed(2), r.profitUSD.toFixed(2)])
    ));
  });
  router.get("/api/reports/staff-activity/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "reports")) return;
    const clauses = ["status = 'active'"], sqlParams = [];
    if (query.from) { clauses.push("date(date) >= date(?)"); sqlParams.push(query.from); }
    if (query.to) { clauses.push("date(date) <= date(?)"); sqlParams.push(query.to); }
    const txs = all(`SELECT * FROM exchange_transactions WHERE ${clauses.join(" AND ")}`, sqlParams);
    const map = {};
    for (const t of txs) {
      map[t.staff_id] = map[t.staff_id] || { staff: t.staff_name, count: 0, volumeUSD: 0, profitUSD: 0 };
      map[t.staff_id].count += 1;
      map[t.staff_id].volumeUSD += convert(t.amount_given, t.currency_given, "USD", t.rate_used);
      map[t.staff_id].profitUSD += Number(t.profit_usd) || 0;
    }
    const rows = Object.values(map).sort((a, b) => b.volumeUSD - a.volumeUSD);
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Staff Activity Report",
      meta: `${query.from || "All time"} – ${query.to || "present"}`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("reports"),
      columns: [{ label: "Staff", width: 1.4 }, { label: "Transactions", width: 1, align: "right" }, { label: "Volume (USD)", width: 1.2, align: "right" }, { label: "Profit (USD)", width: 1.2, align: "right" }],
      rows: rows.map((r) => [r.staff, String(r.count), `$${r.volumeUSD.toFixed(0)}`, `$${r.profitUSD.toFixed(2)}`]),
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
