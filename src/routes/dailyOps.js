"use strict";
// DAILY OPERATIONS CENTER round — the everyday workspace for one company
// and one business day (company time zone):
//   GET  /api/daily-ops?date=           USD / SLSH day summaries, the day's
//                                       transactions, reconciliation, closing
//   POST /api/daily-ops/reconcile       record the counted (actual) closing cash
//   POST /api/daily-ops/snapshot        save today's snapshot / recalculate a past day
//   POST /api/daily-ops/close           close the day (after the checks)
//   POST /api/daily-ops/reopen          reopen a closed day (with a reason)
//   GET  /api/daily-ops/report.{pdf,xlsx}
//
// Nothing here posts money. Transactions are entered through the existing
// endpoints (deposit / withdraw / exchange / transfer / quotation /
// expense / Cash Account), which keep their own rules, permissions,
// references, audit and idempotency. The figures come from the ledgers by
// transaction date through src/daily-history.js (the same calculation as
// the Daily Financial Snapshots), so USD and SLSH are always worked out
// apart and nothing is counted twice. Reconciliation and closing never
// change a balance: they only record what was counted, by whom and when.
const { get, all, run, tx } = require("../db");
const { sendJSON, badRequest, readJSONBody, sendPDF, sendXLSX } = require("../http-helpers");
const { requireAuth, requirePerm, can, allowedCurrencies } = require("../rbac");
const { addAudit, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate } = require("../domain");
const { uid, nowISO, fmtMoney } = require("../util");
const { round2 } = require("../balance-sheet");
const S = require("../daily-snapshots");
const DH = require("../daily-history");
const H = require("./history");
const { renderReportPDF } = require("../pdf");
const { buildProfessionalWorkbook } = require("../xlsx-engine");

const CURS = ["USD", "SLSH"];
const tz = () => S.getSettings().timezone;
const todayStr = () => S.businessDateOf(new Date(), tz());

function companyName() { const c = getCompanySettings(); return (c && c.name) || "Company"; }

// The day's Cash Account figures per currency (sum of every active Cash
// Account of that currency; internal transfers show as in AND out).
function cashDay(date) {
  const data = DH.computeDays(date, date, tz()).get(date);
  const out = {};
  for (const c of CURS) {
    const rows = (data ? data.cashAccounts : []).filter((a) => a.currency === c);
    const sum = (k) => round2(rows.reduce((n, a) => n + (Number(a[k]) || 0), 0));
    out[c] = {
      openingCash: sum("openingBalance"), cashIn: sum("cashIn"), cashOut: sum("cashOut"),
      transferIn: sum("transferIn"), transferOut: sum("transferOut"), exchangeIn: sum("exchangeIn"), exchangeOut: sum("exchangeOut"),
      closingCash: sum("closingBalance"), cashAccounts: rows.length,
      accounts: rows.map((a) => ({ id: a.id, name: a.name, type: a.type, openingBalance: a.openingBalance, closingBalance: a.closingBalance, cashIn: a.cashIn, cashOut: a.cashOut, transferIn: a.transferIn, transferOut: a.transferOut, exchangeIn: a.exchangeIn, exchangeOut: a.exchangeOut })),
      balanceSheet: data ? data[c.toLowerCase()].balanceSheet : null,
    };
    // Money In / Out = what came into / left the company's cash (an internal
    // transfer between two Cash Accounts is neither).
    out[c].moneyIn = round2(out[c].cashIn + out[c].exchangeIn);
    out[c].moneyOut = round2(out[c].cashOut + out[c].exchangeOut);
  }
  return out;
}
// Exchanges of the day, each counted once, by the side in each currency.
function exchangeDay(date) {
  const z = tz();
  const res = { USD: { amount: 0, count: 0 }, SLSH: { amount: 0, count: 0 } };
  const add = (cur, amt) => { if (res[cur]) res[cur].amount += Number(amt) || 0; };
  const rows = [
    ...all("SELECT date, amount_given, currency_given, amount_received, currency_received FROM exchange_transactions WHERE status <> 'voided'"),
    ...all("SELECT date, amount_given, currency_given, amount_received, currency_received FROM cash_exchanges WHERE status = 'active'"),
  ];
  for (const r of rows) {
    if (DH.ledgerDay(r.date, z) !== date) continue;
    add(r.currency_given, r.amount_given); add(r.currency_received, r.amount_received);
    for (const c of new Set([r.currency_given, r.currency_received])) if (res[c]) res[c].count += 1;
  }
  for (const c of CURS) res[c].amount = round2(res[c].amount);
  return res;
}
function reconRow(date, cur) { return get("SELECT * FROM daily_reconciliations WHERE business_date = ? AND currency = ?", [date, cur]) || null; }
function reconJSON(r) {
  if (!r) return null;
  return { currency: r.currency, expected: r.expected, actual: r.actual, difference: r.difference, status: r.status, notes: r.notes, version: Number(r.version), performedBy: r.performed_by_name, performedAt: r.performed_at };
}
function closingRow(date) { return get("SELECT * FROM daily_closings WHERE business_date = ?", [date]) || null; }
// Is the day's snapshot saved? A past day: the Daily Financial History row.
// Today: a stored snapshot (automatic or manual) of today.
function snapshotStatus(date) {
  const today = todayStr();
  if (date < today) {
    const r = get("SELECT business_date, status, version, updated_at FROM daily_financial_history WHERE business_date = ?", [date]);
    return r ? { state: r.status === "updated" ? "updated" : "saved", version: Number(r.version), at: r.updated_at, kind: "history" } : { state: "pending", kind: "history" };
  }
  const s = get("SELECT id, source, captured_at FROM daily_snapshots WHERE business_date = ? ORDER BY captured_at DESC LIMIT 1", [date]);
  return s ? { state: "saved", at: s.captured_at, source: s.source, kind: "snapshot" } : { state: "pending", kind: "snapshot" };
}
function dayTransactions(user, date, res) {
  const out = [];
  for (const c of allowedCurrencies(user)) {
    const rows = H.scopedHistory(user, res, { currency: c, type: "all", from: date, to: date }, {});
    if (!rows) return null;
    for (const e of rows) out.push({ ...e, typeLabel: H.historyTypeLabel(e), currency: c });
  }
  out.sort((a, b) => String(b.sortKey || "").localeCompare(String(a.sortKey || "")));
  return out;
}
function closingChecks(date, user, cur) {
  const recon = {}; for (const c of cur) recon[c] = reconJSON(reconRow(date, c));
  const reconOk = (c) => recon[c] && (recon[c].status === "balanced" || recon[c].status === "approved");
  const snap = snapshotStatus(date);
  return {
    reconciliation: Object.fromEntries(cur.map((c) => [c, !!reconOk(c)])),
    differencesResolved: cur.every((c) => !recon[c] || recon[c].status !== "difference"),
    snapshotSaved: snap.state !== "pending",
    allPassed: cur.every((c) => reconOk(c)) && snap.state !== "pending",
  };
}

function register(router) {
  const viewer = (req, res, perm = "dailyOps.view") => {
    const user = requireAuth(req, res); if (!user) return null;
    if (!requirePerm(user, res, perm)) return null;
    const cur = allowedCurrencies(user);
    if (!cur.length) { sendJSON(res, 403, { error: "You don't have access to USD or SLSH." }); return null; }
    return { user, cur };
  };
  const dateOf = (q) => {
    const d = q && q.date;
    if (!d) return todayStr();
    if (!S.DATE_RE.test(String(d))) return null;
    return String(d);
  };

  router.get("/api/daily-ops", (req, res, params, query) => {
    const v = viewer(req, res); if (!v) return;
    const date = dateOf(query); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    const today = todayStr();
    if (date > today) return badRequest(res, "That day has not started yet.");
    try { DH.sync(); } catch (e) { /* the history job reports its own errors */ }
    const cash = cashDay(date), ex = exchangeDay(date);
    const tr = dayTransactions(v.user, date, res); if (!tr) return;
    const summaries = {};
    for (const c of v.cur) {
      const rows = tr.filter((e) => e.currency === c);
      summaries[c] = { ...cash[c], exchanges: ex[c], credits: round2(rows.reduce((n, e) => n + (Number(e.credit) || 0), 0)), debits: round2(rows.reduce((n, e) => n + (Number(e.debit) || 0), 0)), transactions: rows.length };
    }
    const closing = closingRow(date);
    const out = {
      date, today, isToday: date === today, timezone: tz(), company: companyName(), currencies: v.cur,
      // Live balances are only reported for today — a past day shows its own end-of-day figures.
      mode: date === today ? "live" : "historical",
      summaries, transactions: tr,
      reconciliation: can(v.user, "dailyOps.viewReconciliation") ? Object.fromEntries(v.cur.map((c) => [c, reconJSON(reconRow(date, c))])) : null,
      snapshot: snapshotStatus(date),
      closing: closing ? { status: closing.status, closedBy: closing.closed_by_name, closedAt: closing.closed_at, reopenedBy: closing.reopened_by_name, reopenedAt: closing.reopened_at, reopenReason: closing.reopen_reason, usdClosing: closing.usd_closing, slshClosing: closing.slsh_closing, notes: closing.notes } : null,
      checks: closingChecks(date, v.user, v.cur),
      can: Object.fromEntries(["create", "viewReconciliation", "reconcile", "snapshot", "updateHistory", "close", "reopen", "print", "export"].map((k) => [k, can(v.user, `dailyOps.${k}`)])),
    };
    sendJSON(res, 200, out);
  });

  router.post("/api/daily-ops/reconcile", async (req, res) => {
    const v = viewer(req, res, "dailyOps.reconcile"); if (!v) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const date = dateOf(body); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    if (date > todayStr()) return badRequest(res, "That day has not started yet.");
    const cur = body.currency;
    if (!CURS.includes(cur)) return badRequest(res, "Choose USD or SLSH.");
    if (!v.cur.includes(cur)) return sendJSON(res, 403, { error: `You don't have access to ${cur}.` });
    const actual = Number(body.actual);
    if (body.actual === "" || body.actual == null || !Number.isFinite(actual)) return badRequest(res, "Enter the actual (counted) closing balance.");
    const notes = body.notes == null ? "" : String(body.notes).trim().slice(0, 1000);
    const closed = closingRow(date);
    if (closed && closed.status === "closed") return sendJSON(res, 409, { error: `${date} is closed. Reopen it before changing its reconciliation.` });
    const c = cashDay(date)[cur];
    const expected = c.closingCash;
    const difference = round2(actual - expected);
    let status = Math.abs(difference) < 0.005 ? "balanced" : "difference";
    if (status === "difference" && body.approveDifference === true) {
      if (!notes) return badRequest(res, "Explain the difference in the notes before approving it.");
      status = "approved";
    }
    const prev = reconRow(date, cur);
    const version = prev ? Number(prev.version) + 1 : 1;
    const at = nowISO();
    tx(() => {
      if (prev) {
        run("UPDATE daily_reconciliations SET opening = ?, total_in = ?, total_out = ?, expected = ?, actual = ?, difference = ?, status = ?, notes = ?, version = ?, performed_by = ?, performed_by_name = ?, performed_at = ? WHERE id = ?",
          [c.openingCash, round2(c.cashIn + c.transferIn + c.exchangeIn), round2(c.cashOut + c.transferOut + c.exchangeOut), expected, actual, difference, status, notes || null, version, v.user.id, v.user.name, at, prev.id]);
      } else {
        run("INSERT INTO daily_reconciliations (id, business_date, currency, opening, total_in, total_out, expected, actual, difference, status, notes, version, performed_by, performed_by_name, performed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("drc"), date, cur, c.openingCash, round2(c.cashIn + c.transferIn + c.exchangeIn), round2(c.cashOut + c.transferOut + c.exchangeOut), expected, actual, difference, status, notes || null, version, v.user.id, v.user.name, at]);
      }
      run("INSERT INTO daily_reconciliation_history (id, business_date, currency, version, expected, actual, difference, status, notes, performed_by, performed_by_name, performed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("drh"), date, cur, version, expected, actual, difference, status, notes || null, v.user.id, v.user.name, at]);
    });
    addAudit(v.user, "Daily reconciliation", `${date} ${cur}: expected ${fmtMoney(expected, cur)}, actual ${fmtMoney(actual, cur)}, difference ${fmtMoney(difference, cur)} — ${status}${prev ? ` (version ${version})` : ""}`);
    sendJSON(res, 200, { reconciliation: reconJSON(reconRow(date, cur)) });
  });

  router.post("/api/daily-ops/snapshot", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    let body = {}; try { body = (await readJSONBody(req)) || {}; } catch (e) { return badRequest(res, e.message); }
    const date = dateOf(body); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    const today = todayStr();
    if (date > today) return badRequest(res, "That day has not started yet.");
    if (date === today) {
      if (!requirePerm(user, res, "dailyOps.snapshot")) return;
      try {
        const r = S.capture({ source: "manual", trigger: "manual", actor: user });
        return sendJSON(res, r.created ? 201 : 200, { snapshot: { date: r.snapshot.business_date, capturedAt: r.snapshot.captured_at, created: r.created } });
      } catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
    }
    // A past day: bring its saved history (and every later day) up to date
    // — a new version is kept for any day whose figures changed.
    if (!requirePerm(user, res, "dailyOps.updateHistory")) return;
    const r = DH.sync({ actor: user, force: true });
    addAudit(user, "Daily history recalculation requested", `${date}: ${r.action}${r.updated && r.updated.length ? ` · ${r.updated.length} day(s) updated` : ""}`);
    sendJSON(res, 200, { result: { action: r.action, created: r.created || 0, updated: r.updated || [] }, snapshot: snapshotStatus(date) });
  });

  router.post("/api/daily-ops/close", async (req, res) => {
    const v = viewer(req, res, "dailyOps.close"); if (!v) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const date = dateOf(body); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    if (date > todayStr()) return badRequest(res, "That day has not started yet.");
    if (v.cur.length < 2) return sendJSON(res, 403, { error: "Closing a day needs access to both USD and SLSH." });
    if (body.confirmReviewed !== true || body.confirmCashIncluded !== true) return badRequest(res, "Confirm that the transactions were reviewed and the Cash Account movements are included.");
    const existing = closingRow(date);
    if (existing && existing.status === "closed") return sendJSON(res, 409, { error: `${date} is already closed (by ${existing.closed_by_name} at ${existing.closed_at}).` });
    const checks = closingChecks(date, v.user, v.cur);
    const missing = [];
    for (const c of v.cur) if (!checks.reconciliation[c]) missing.push(`${c} reconciliation is not completed (balanced or an approved difference)`);
    if (!checks.snapshotSaved) missing.push("the daily snapshot is not saved");
    if (missing.length) return sendJSON(res, 409, { error: `The day can't be closed yet: ${missing.join("; ")}.`, checks });
    const cash = cashDay(date);
    const at = nowISO();
    const data = JSON.stringify({ cash: Object.fromEntries(CURS.map((c) => [c, { opening: cash[c].openingCash, closing: cash[c].closingCash }])), reconciliation: Object.fromEntries(CURS.map((c) => [c, reconJSON(reconRow(date, c))])), snapshot: snapshotStatus(date) });
    try {
      tx(() => {
        if (existing) run("UPDATE daily_closings SET status = 'closed', usd_closing = ?, slsh_closing = ?, data = ?, notes = ?, closed_by = ?, closed_by_name = ?, closed_at = ? WHERE id = ? AND status = 'reopened'",
          [cash.USD.closingCash, cash.SLSH.closingCash, data, body.notes ? String(body.notes).slice(0, 1000) : null, v.user.id, v.user.name, at, existing.id]);
        else run("INSERT INTO daily_closings (id, business_date, status, usd_closing, slsh_closing, data, notes, closed_by, closed_by_name, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [uid("dcl"), date, "closed", cash.USD.closingCash, cash.SLSH.closingCash, data, body.notes ? String(body.notes).slice(0, 1000) : null, v.user.id, v.user.name, at]);
      });
    } catch (e) {
      if (/duplicate/i.test(e.message)) return sendJSON(res, 409, { error: `${date} is already closed.` });
      throw e;
    }
    addAudit(v.user, "Day closed", `${date}: USD ${fmtMoney(cash.USD.closingCash, "USD")} · SLSH ${fmtMoney(cash.SLSH.closingCash, "SLSH")}`);
    sendJSON(res, 200, { closing: { status: "closed", closedBy: v.user.name, closedAt: at } });
  });

  router.post("/api/daily-ops/reopen", async (req, res) => {
    const v = viewer(req, res, "dailyOps.reopen"); if (!v) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const date = dateOf(body); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    const reason = String(body.reason || "").trim();
    if (!reason) return badRequest(res, "Give the reason for reopening the day.");
    const row = closingRow(date);
    if (!row || row.status !== "closed") return sendJSON(res, 409, { error: `${date} is not closed.` });
    const at = nowISO();
    run("UPDATE daily_closings SET status = 'reopened', reopened_by_name = ?, reopened_at = ?, reopen_reason = ? WHERE id = ? AND status = 'closed'", [v.user.name, at, reason.slice(0, 1000), row.id]);
    addAudit(v.user, "Day reopened", `${date}: ${reason.slice(0, 300)}`);
    sendJSON(res, 200, { closing: { status: "reopened", reopenedBy: v.user.name, reopenedAt: at } });
  });

  for (const fmt of ["pdf", "xlsx"]) router.get(`/api/daily-ops/report.${fmt}`, async (req, res, params, query) => {
    const v = viewer(req, res, fmt === "pdf" && query && query.print === "1" ? "dailyOps.print" : "dailyOps.export"); if (!v) return;
    const date = dateOf(query); if (!date) return badRequest(res, "Dates must be YYYY-MM-DD.");
    const cash = cashDay(date), ex = exchangeDay(date);
    const tr = dayTransactions(v.user, date, res); if (!tr) return;
    const rows = [];
    for (const c of v.cur) {
      const x = cash[c];
      const recon = reconJSON(reconRow(date, c));
      for (const [label, val] of [["Opening Cash", x.openingCash], ["Cash In", x.cashIn], ["Cash Out", x.cashOut], ["Transfers In", x.transferIn], ["Transfers Out", x.transferOut], ["Exchange In", x.exchangeIn], ["Exchange Out", x.exchangeOut], ["Closing Cash", x.closingCash], ["Exchanges (" + c + " side)", ex[c].amount]]) rows.push({ cur: c, item: label, value: fmtMoney(val, c), num: val });
      rows.push({ cur: c, item: "Reconciliation", value: recon ? `${recon.status} · actual ${fmtMoney(recon.actual, c)} · difference ${fmtMoney(recon.difference, c)}` : "Pending review", num: null });
    }
    const closing = closingRow(date);
    const title = "Daily Operations Report";
    const meta = `${companyName()} · ${date} (${tz()}) · ${tr.length} transaction(s) · ${closing && closing.status === "closed" ? `closed by ${closing.closed_by_name}` : "not closed"}`;
    addAudit(v.user, "Daily operations report", `${fmt.toUpperCase()} · ${date}`);
    if (fmt === "pdf") {
      const trRows = tr.slice(0, 400).map((e) => [String(e.date || "").replace("T", " ").slice(0, 16), e.typeLabel, e.currency, e.accountName || "", e.credit != null ? fmtMoney(e.credit, e.currency) : e.debit != null ? `-${fmtMoney(e.debit, e.currency)}` : e.amountSummary || ""]);
      const pdf = await renderReportPDF({ company: getCompanySettings(), title, meta, generatedBy: v.user.name, template: getDefaultPdfTemplate("reports"),
        columns: [{ label: "Currency", width: 0.6 }, { label: "Item", width: 1.6 }, { label: "Amount / Status", width: 2.4, align: "right" }],
        rows: [...rows.map((r) => [r.cur, r.item, r.value]), ["", "", ""], ...trRows.map((t) => [t[2], `${t[0]} · ${t[1]} · ${t[3]}`, t[4]])] });
      return sendPDF(res, `daily-operations-${date}.pdf`, pdf);
    }
    const wb = await buildProfessionalWorkbook({ company: getCompanySettings(), template: getDefaultExcelTemplate("reports"), generatedBy: v.user.name, sheetName: date, docTypeLabel: title.toUpperCase(),
      subtitleLines: [meta], infoRows: [],
      table: { columns: [{ key: "cur", label: "Currency", width: 10 }, { key: "item", label: "Item", width: 28 }, { key: "value", label: "Amount / Status", width: 46, align: "right" }], rows, cellValue: (r, key) => r[key] } });
    sendXLSX(res, `daily-operations-${date}.xlsx`, wb);
  });
}

module.exports = { register, cashDay, exchangeDay };
