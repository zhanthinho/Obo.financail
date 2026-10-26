"use strict";
// DATA RESET round: Super Admin-only "Reset Data" for the CURRENT company
// (see ../data-reset.js). GET shows what each category would clear; POST
// clears the chosen categories after the company's name has been typed to
// confirm. A full backup is stored first and its name is returned.
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, isSuperAdmin } = require("../rbac");
const reset = require("../data-reset");

function requireSuper(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!isSuperAdmin(user)) { sendJSON(res, 403, { error: "Only a Super Admin can reset data." }); return null; }
  return user;
}

function register(router) {
  router.get("/api/data-reset", (req, res) => {
    const user = requireSuper(req, res); if (!user) return;
    sendJSON(res, 200, { company: { name: user._company.name }, ...reset.preview() });
  });

  router.post("/api/data-reset", async (req, res) => {
    const user = requireSuper(req, res); if (!user) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const selected = Array.isArray(body && body.categories) ? body.categories.filter((k) => typeof k === "string") : [];
    const unknown = selected.filter((k) => !reset.CATEGORIES[k]);
    if (unknown.length) return badRequest(res, `Unknown category: ${unknown.join(", ")}`);
    if (!selected.length) return badRequest(res, "Choose at least one thing to reset.");
    const typed = String((body && body.confirmName) || "").trim().toLowerCase();
    if (!typed || typed !== String(user._company.name || "").trim().toLowerCase()) {
      return badRequest(res, "Type the company name exactly to confirm the reset.");
    }
    try {
      const result = reset.execute(user._company, selected, { id: user.id, name: user.name, role: "super_admin" });
      sendJSON(res, 200, result);
    } catch (e) {
      if (e.status) return sendJSON(res, e.status, { error: e.message });
      throw e;
    }
  });
}

module.exports = { register };
