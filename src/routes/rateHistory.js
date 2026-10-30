"use strict";
const { all, get, run } = require("../db");
const { sendJSON, sendCSV, notFound, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { getCurrentRate, getCurrentSaleRate, getCurrentDailySlshRate, saveRateHistory, addAudit } = require("../domain");
const { validateRates } = require("../exchange-calc");
const { toCSV } = require("../csv");

const PAIR_LABELS = { USD_SLSH: "USD → SLSH" };

function shapeRow(r, latestAt) {
  return {
    id: r.id,
    currencyPair: r.currency_pair,
    currencyPairLabel: PAIR_LABELS[r.currency_pair] || r.currency_pair,
    dailyRate: r.daily_rate,
    saleRate: r.sale_rate,
    dailySlshRate: r.daily_slsh_rate,
    difference: r.rate_difference,
    costRate: r.cost_rate,
    buyRate: r.buy_rate,
    sellRate: r.sell_rate,
    note: r.note,
    setByName: r.set_by_name,
    at: r.at,
    status: r.at === latestAt ? "Active" : "Expired",
  };
}

// RATE MANAGEMENT UNIFICATION round: the unified Rate Management surface
// behind the header's "Manage Rates" control and Money Exchange's "Rate
// history" tab. Everything here reads/writes the single rate_history table
// (schema.sql) rather than the two legacy per-rate tables — /api/rate and
// /api/sale-rate (routes/rate.js, routes/saleRate.js) are kept exactly as
// they were for backward compatibility, but both now go through the same
// saveRateHistory() helper underneath, so a change made through either the
// old endpoints or this new one all land in the same one unified history.
//
// Gating: CURRENCY / RATE / PROFIT PERMISSIONS round — this file previously
// kept the single coarse `rateManage` flag for every action here by
// deliberate choice (see this file's git history); that choice is reversed
// now that a granular rates.* permission set has been explicitly requested.
// view/export/delete are split from create/update exactly per the new
// catalog (src/permissions.js): rates.viewHistory, rates.exportHistory,
// rates.create (this file's unified "set both Daily + Sale Rate" POST), and
// the new rates.delete below. Every pre-existing role that had rateManage=1
// was backfilled with all of these except delete (see db.js), so nothing
// changes for an existing installation until a Super Admin edits a role.
function register(router) {
  router.get("/api/rate-history", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.viewHistory")) return;

    const clauses = [];
    const args = [];
    if (query.pair && query.pair !== "all") { clauses.push("currency_pair = ?"); args.push(query.pair); }
    if (query.from) { clauses.push("at >= ?"); args.push(query.from); }
    if (query.to) { clauses.push("at <= ?"); args.push(query.to + "T23:59:59"); }
    if (query.search) { clauses.push("(note LIKE ? OR set_by_name LIKE ?)"); args.push(`%${query.search}%`, `%${query.search}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const latest = get("SELECT at FROM rate_history ORDER BY at DESC LIMIT 1");
    const latestAt = latest ? latest.at : null;

    // Status filter is applied after shaping (it depends on latestAt, not a column).
    let rows = all(`SELECT * FROM rate_history ${where} ORDER BY at DESC`, args).map((r) => shapeRow(r, latestAt));
    if (query.status && query.status !== "all") rows = rows.filter((r) => r.status.toLowerCase() === query.status.toLowerCase());

    const sort = query.sort || "newest";
    const cmp = {
      newest: (a, b) => (a.at < b.at ? 1 : -1),
      oldest: (a, b) => (a.at > b.at ? 1 : -1),
      daily: (a, b) => (b.dailyRate || 0) - (a.dailyRate || 0),
      sale: (a, b) => (b.saleRate || 0) - (a.saleRate || 0),
    }[sort] || null;
    if (cmp) rows.sort(cmp);

    const currentDaily = getCurrentRate();
    const currentSale = getCurrentSaleRate();
    const currentDailySlsh = getCurrentDailySlshRate();
    const latestRow = rows.find((r) => r.status === "Active");
    sendJSON(res, 200, {
      history: rows,
      summary: {
        currentDaily,
        currentSale,
        currentDailySlsh,
        currentDifference: currentSale ? currentDaily - currentSale : null,
        lastUpdated: latestAt,
        updatedBy: latestRow ? latestRow.setByName : null,
      },
    });
  });

  // Registered BEFORE the /:id route below — this router matches routes in
  // registration order (see router.js), and "export.csv" would otherwise be
  // captured as an :id value by the more general pattern.
  router.get("/api/rate-history/export.csv", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.exportHistory")) return;
    const latest = get("SELECT at FROM rate_history ORDER BY at DESC LIMIT 1");
    const latestAt = latest ? latest.at : null;
    const rows = all("SELECT * FROM rate_history ORDER BY at DESC").map((r) => shapeRow(r, latestAt));
    const csvRows = rows.map((r) => [r.at, r.currencyPairLabel, r.dailyRate ?? "", r.saleRate ?? "", r.dailySlshRate ?? "", r.difference ?? "", r.costRate ?? "", r.buyRate ?? "", r.sellRate ?? "", r.status, r.setByName, r.note || ""]);
    addAudit(user, "Rate history exported (CSV)", `${rows.length} entries`);
    sendCSV(res, "obo-rate-history.csv", toCSV(["Date", "Currency Pair", "Daily Rate", "Sale Rate", "Daily SLSH Rate", "Rate Difference", "Cost Rate", "Buy Rate", "Sell Rate", "Status", "Updated By", "Note"], csvRows));
  });

  router.get("/api/rate-history/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.viewHistory")) return;
    const row = get("SELECT * FROM rate_history WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Rate history record not found.");
    const latest = get("SELECT at FROM rate_history ORDER BY at DESC LIMIT 1");
    sendJSON(res, 200, shapeRow(row, latest ? latest.at : null));
  });

  // DELETE — CURRENCY / RATE / PROFIT PERMISSIONS round: brand new (no
  // legacy endpoint of any kind existed to delete a rate-history row before
  // this round). Deleting a rate record has no balance/ledger effect to
  // reverse — unlike an Exchange or Transfer, a rate_history row is just a
  // record of what the rate WAS at a point in time, never itself money
  // moving — so this is a plain, permanent row delete. Gated by the new
  // rates.delete permission, extra-granted to Admin only at seed time (see
  // db.js) since there is no legacy behavior to preserve here.
  router.delete("/api/rate-history/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.delete")) return;
    const row = get("SELECT * FROM rate_history WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Rate history record not found.");
    run("DELETE FROM rate_history WHERE id = ?", [params.id]);
    addAudit(user, "Rate history record deleted", `${row.at} — Daily ${row.daily_rate ?? "—"}, Sale ${row.sale_rate ?? "—"}`);
    sendJSON(res, 200, { deleted: true, id: params.id });
  });

  // The combined "Save Rates" form: both Daily Rate and Sale Rate together,
  // in one unified action, matching how the header's quick-edit and the
  // Rate history tab's form both actually save (spec section 3/11) — every
  // save here always snapshots BOTH values into one new row, even when the
  // caller only means to change one of them (the untouched side is simply
  // resubmitted at its current value, which saveRateHistory would do
  // automatically anyway, but requiring both explicitly here keeps this
  // endpoint's intent — "set the full rate state" — clear at the call site).
  router.post("/api/rate-history", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.create")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const dailyRate = Number(body.dailyRate);
    const saleRate = Number(body.saleRate);
    if (!dailyRate || dailyRate <= 0) return badRequest(res, "Provide a positive numeric Daily Rate (SLSH per 1 USD).");
    if (!saleRate || saleRate <= 0) return badRequest(res, "Provide a positive numeric Sale Rate (SLSH per 1 USD).");
    // DAILY SLSH RATE round: optional, record-only — unlike Daily/Sale Rate
    // above, this is never required (an installation that never fills it in
    // behaves exactly as it always has).
    let dailySlshRate;
    if (body.dailySlshRate !== undefined && body.dailySlshRate !== "" && body.dailySlshRate !== null) {
      dailySlshRate = Number(body.dailySlshRate);
      if (!dailySlshRate || dailySlshRate <= 0) return badRequest(res, "Daily SLSH Rate must be a positive number.");
    }
    // GLOBAL RATE & PROFIT round: optional Cost / Buy / Sell rates.
    const rateErr = validateRates(body);
    if (rateErr) return badRequest(res, rateErr);
    const opt = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const costRate = opt(body.costRate), buyRate = opt(body.buyRate), sellRate = opt(body.sellRate);
    const currencyPair = body.currencyPair && PAIR_LABELS[body.currencyPair] ? body.currencyPair : "USD_SLSH";
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    const saved = saveRateHistory({ dailyRate, saleRate, dailySlshRate, costRate, buyRate, sellRate, note, user, currencyPair });
    addAudit(user, "Exchange rates updated", `Daily Rate set to 1 USD = SLSH ${dailyRate.toLocaleString("en-US")}, Sale Rate set to 1 USD = SLSH ${saleRate.toLocaleString("en-US")}${dailySlshRate ? `, Daily SLSH Rate set to 1 SLSH = USD ${dailySlshRate.toLocaleString("en-US")}` : ""}${costRate ? `, Cost Rate ${costRate.toLocaleString("en-US")}` : ""}${buyRate ? `, Buy Rate ${buyRate.toLocaleString("en-US")}` : ""}${sellRate ? `, Sell Rate ${sellRate.toLocaleString("en-US")}` : ""}${note ? ` — ${note}` : ""}`);
    sendJSON(res, 200, saved);
  });
}

module.exports = { register };
