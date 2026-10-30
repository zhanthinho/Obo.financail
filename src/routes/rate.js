"use strict";
const { all } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { getCurrentRate, getCurrentDailySlshRate, getCurrentRates, saveRateHistory, addAudit } = require("../domain");

// RATE MANAGEMENT UNIFICATION round: this endpoint's request/response
// contract is UNCHANGED — { rate } in, { rate } out, { rate, history } on
// GET — so every existing caller (the RBAC/e2e suites, and any external
// integration) keeps working exactly as before. What changed is only where
// the data actually lives: a save now goes through the shared
// saveRateHistory() helper, which writes ONE row into the new unified
// rate_history table (carrying forward whatever the current Sale Rate is),
// instead of its own separate exchange_rates table. GET's `history` list is
// synthesized from rate_history's daily_rate column, so it reads exactly
// like the old exchange_rates-backed history did.
function register(router) {
  router.get("/api/rate", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    // CURRENCY / RATE / PROFIT PERMISSIONS round: this readout was
    // universally viewable before (requireAuth only) — rates.view is seeded
    // onto every pre-existing role at backfill time (see db.js) so this
    // check changes nothing for anyone until a Super Admin deliberately
    // revokes it from a role/user.
    if (!requirePerm(user, res, "rates.view")) return;
    const history = all("SELECT id, daily_rate as rate, set_by_name as setByName, at FROM rate_history WHERE daily_rate IS NOT NULL ORDER BY at DESC LIMIT 50");
    // DAILY SLSH RATE round: an additive field on this existing response —
    // every pre-existing caller of GET /api/rate still gets its unchanged
    // { rate, history } contract, this is simply extra data alongside it,
    // fetched once at app load so ManageRatesModal can prefill it wherever
    // it's opened from, same as `rate` itself already does.
    const r = getCurrentRates();
    sendJSON(res, 200, { rate: getCurrentRate(), dailySlshRate: getCurrentDailySlshRate(), costRate: r.costRate, buyRate: r.buyRate, sellRate: r.sellRate, history });
  });

  router.post("/api/rate", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.updateDaily")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const rate = Number(body.rate);
    if (!rate || rate <= 0) return badRequest(res, "Provide a positive numeric rate (SLSH per 1 USD).");
    saveRateHistory({ dailyRate: rate, user });
    addAudit(user, "Rate updated", `Exchange rate set to 1 USD = SLSH ${rate.toLocaleString("en-US")}`);
    sendJSON(res, 200, { rate });
  });
}

module.exports = { register };
