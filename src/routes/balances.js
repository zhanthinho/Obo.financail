"use strict";
const { isFiniteMoney } = require("../util");
const { get, run } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { addAudit, currencyPosition } = require("../domain");
const { nowISO } = require("../util");

function register(router) {
  router.get("/api/balances", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    sendJSON(res, 200, currencyPosition());
  });

  router.post("/api/balances", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "rateManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const usd = Number(body.usd);
    const slsh = Number(body.slsh);
    if (Number.isNaN(usd) || Number.isNaN(slsh)) return badRequest(res, "Provide numeric usd and slsh values.");
    if (!isFiniteMoney(usd) || !isFiniteMoney(slsh)) return badRequest(res, "Opening balances must be finite numbers within range.");
    const exists = get("SELECT id FROM opening_balances WHERE id = 1");
    if (exists) {
      run("UPDATE opening_balances SET usd=?, slsh=?, updated_by=?, updated_at=? WHERE id=1", [usd, slsh, user.name, nowISO()]);
    } else {
      run("INSERT INTO opening_balances (id, usd, slsh, updated_by, updated_at) VALUES (1,?,?,?,?)", [usd, slsh, user.name, nowISO()]);
    }
    addAudit(user, "Opening balances set", `USD ${usd.toLocaleString("en-US")} / SLSH ${slsh.toLocaleString("en-US")}`);
    sendJSON(res, 200, currencyPosition());
  });
}

module.exports = { register };
