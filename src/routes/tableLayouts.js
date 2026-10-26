"use strict";
// TABLE CUSTOMIZATION round — persistence for the reusable column
// show/hide/reorder + row-density system (frontend/app.jsx's
// useTableLayout/TableCustomizerModal). This route is deliberately
// agnostic about what any given table's columns actually ARE: it just
// stores/returns an ordered array of column keys plus a density string,
// scoped by an app-defined `tableKey`. The frontend owns the canonical
// column definitions (label, sort field, render) for each table and is
// solely responsible for reconciling a saved layout against them (a saved
// key that no longer exists just quietly stops rendering — see
// resolveColumns in app.jsx).
const { get, all, run } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { addAudit } = require("../domain");
const { uid, nowISO } = require("../util");

// Defense in depth: table_key isn't attacker-controlled in any meaningful
// way (it only ever drives a SELECT/UPSERT keyed on this string, never
// interpolated into SQL or a file path), but constraining it to the
// table's this app actually ships keeps table_layouts from silently
// accumulating rows for typos or a since-renamed table.
// TABLE CUSTOMIZATION round 2 added exchange/payments.*/quotations, and
// round 3 added history.usd/history.slsh (Transaction History) — all of
// them originally deferred out of Round 1 as "more complex existing
// footer/grouping logic". No new permission or schema change was needed for
// any of these extensions: it's the same table_layouts store and the same
// settings.manageTableDefaults gate, just more valid table keys.
// TABLE CUSTOMIZATION round 4 added accounts.deactivated (Settings ->
// Deactivated Accounts) — the one remaining table still hand-rendering a
// fixed column list. Same store, same settings.manageTableDefaults gate.
// ACCOUNT TRANSACTIONS COLUMN CUSTOMIZATION round added account.transactions
// (Account View -> Transactions). Display-only: unlike payments.<currency>,
// NO export route reads this key — statements keep their standard columns.
const VALID_TABLE_KEYS = new Set(["account.transactions", "accounts.usd", "accounts.slsh", "accounts.deactivated", "users", "roles", "auditLog", "exchange", "payments.usd", "payments.slsh", "quotations", "history.usd", "history.slsh"]);

// user_id sentinel for "the system-wide default" row — see schema.sql's
// own comment on table_layouts for why a real users.id can never collide
// with this.
const SYSTEM_SCOPE_ID = "__system__";

const VALID_DENSITIES = new Set(["compact", "comfortable"]);
const MAX_COLUMNS = 40;
const MAX_KEY_LEN = 60;

function serialize(row) {
  if (!row) return null;
  let columns = [];
  try { columns = JSON.parse(row.columns_json) || []; } catch (e) { columns = []; }
  return { columns, density: row.density || null, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function validateColumns(columns) {
  if (!Array.isArray(columns)) return "columns must be an array.";
  if (columns.length > MAX_COLUMNS) return `columns can't have more than ${MAX_COLUMNS} entries.`;
  for (const k of columns) {
    if (typeof k !== "string" || !k || k.length > MAX_KEY_LEN) return "Each column key must be a short, non-empty string.";
  }
  if (new Set(columns).size !== columns.length) return "columns must not contain duplicate keys.";
  return null;
}

function register(router) {
  router.get("/api/table-layout/:tableKey", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!VALID_TABLE_KEYS.has(params.tableKey)) return badRequest(res, "Unknown table.");
    const system = get("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [params.tableKey, SYSTEM_SCOPE_ID]);
    const mine = get("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [params.tableKey, user.id]);
    sendJSON(res, 200, { system: serialize(system), mine: serialize(mine) });
  });

  router.patch("/api/table-layout/:tableKey", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!VALID_TABLE_KEYS.has(params.tableKey)) return badRequest(res, "Unknown table.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const scope = body.scope === "system" ? "system" : "me";
    // Saving your OWN layout is self-service, same as the pre-existing
    // quotation_column_prefs pattern — no special permission needed, it
    // only ever affects what this one user sees. Setting the SYSTEM
    // default for everyone else is the new, genuinely privileged action.
    if (scope === "system" && !requirePerm(user, res, "settings.manageTableDefaults")) return;
    const columnsError = validateColumns(body.columns);
    if (columnsError) return badRequest(res, columnsError);
    if (body.density !== undefined && body.density !== null && !VALID_DENSITIES.has(body.density)) {
      return badRequest(res, `density must be one of: ${Array.from(VALID_DENSITIES).join(", ")}`);
    }
    const density = body.density || null;
    const userId = scope === "system" ? SYSTEM_SCOPE_ID : user.id;
    const now = nowISO();
    const existing = get("SELECT id FROM table_layouts WHERE table_key = ? AND user_id = ?", [params.tableKey, userId]);
    if (existing) {
      run("UPDATE table_layouts SET columns_json=?, density=?, updated_at=?, updated_by=? WHERE id=?", [JSON.stringify(body.columns), density, now, user.name, existing.id]);
    } else {
      run(
        "INSERT INTO table_layouts (id, table_key, user_id, columns_json, density, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)",
        [uid("layout"), params.tableKey, userId, JSON.stringify(body.columns), density, now, user.name]
      );
    }
    if (scope === "system") addAudit(user, "Table default layout changed", `${params.tableKey}: ${body.columns.length} column(s) visible`);
    const fresh = get("SELECT * FROM table_layouts WHERE table_key = ? AND user_id = ?", [params.tableKey, userId]);
    sendJSON(res, 200, { layout: serialize(fresh) });
  });

  router.delete("/api/table-layout/:tableKey", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!VALID_TABLE_KEYS.has(params.tableKey)) return badRequest(res, "Unknown table.");
    const scope = query && query.scope === "system" ? "system" : "me";
    if (scope === "system" && !requirePerm(user, res, "settings.manageTableDefaults")) return;
    const userId = scope === "system" ? SYSTEM_SCOPE_ID : user.id;
    run("DELETE FROM table_layouts WHERE table_key = ? AND user_id = ?", [params.tableKey, userId]);
    if (scope === "system") addAudit(user, "Table default layout reset", params.tableKey);
    sendJSON(res, 200, { ok: true });
  });
}

module.exports = { register };
