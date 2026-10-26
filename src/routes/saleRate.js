"use strict";
const { all } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { getCurrentSaleRate, saveRateHistory, addAudit } = require("../domain");

// RATE MANAGEMENT UNIFICATION round: same unchanged { rate } / { rate,
// history } contract as rate.js above, for the same reason — every save
// now goes through the shared saveRateHistory() helper (one unified
// rate_history row, carrying forward the current Daily Rate) instead of
// its own separate sale_rates table.
function register(router) {
  router.get("/api/sale-rate", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    // CURRENCY / RATE / PROFIT PERMISSIONS round: universal before (see
    // rate.js's matching comment) — rates.view is backfilled onto every
    // pre-existing role, so this is a no-op for existing installations.
    if (!requirePerm(user, res, "rates.view")) return;
    const history = all("SELECT id, sale_rate as rate, set_by_name as setByName, at FROM rate_history WHERE sale_rate IS NOT NULL ORDER BY at DESC LIMIT 50");
    sendJSON(res, 200, { rate: getCurrentSaleRate(), history });
  });

  router.post("/api/sale-rate", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rates.updateSale")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const rate = Number(body.rate);
    if (!rate || rate <= 0) return badRequest(res, "Provide a positive numeric rate (SLSH per 1 USD).");
    saveRateHistory({ saleRate: rate, user });
    addAudit(user, "Sale rate updated", `Sale (wholesale) rate set to 1 USD = SLSH ${rate.toLocaleString("en-US")}`);
    sendJSON(res, 200, { rate });
  });
}

module.exports = { register };
