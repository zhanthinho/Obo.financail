"use strict";
// TEMPLATE VERSION HISTORY round — every PDF / Excel template keeps the
// look it had before each change, so a Super Admin (or anyone holding the
// template update permission) can open an earlier version, preview it, and
// put it back.
//
// A version is a snapshot of the template's customizable columns (its
// FIELD_DEFS) plus its name, taken just BEFORE the template changes: a save
// in the editor, "Reset to Defaults", or a restore of another version. The
// table (template_versions) only ever grows — nothing here deletes a version.
const { get, all, run } = require("./db");
const { uid, nowISO } = require("./util");

const TABLE_OF = { pdf: "pdf_templates", excel: "excel_templates" };

// The editor saves automatically a moment after each change. One editing
// session is one version: a "Before save" snapshot is skipped when the same
// person already saved a "Before save" version of this template in the last
// 10 minutes (that version already holds the look from before the session).
const SESSION_MS = 10 * 60 * 1000;

// Store the template row as it is right now.
function snapshot(type, row, fieldDefs, user, reason) {
  if (reason === "Before save") {
    const last = get("SELECT created_at, created_by, reason FROM template_versions WHERE template_type = ? AND template_id = ? ORDER BY created_at DESC LIMIT 1", [type, row.id]);
    if (last && last.reason === "Before save" && last.created_by === ((user && user.name) || "system")
      && Date.now() - Date.parse(last.created_at) < SESSION_MS) return false;
  }
  const cols = {};
  for (const def of fieldDefs) cols[def.col] = row[def.col] === undefined ? null : row[def.col];
  run(
    "INSERT INTO template_versions (id, template_type, template_id, version, name, data, reason, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
    [uid("tv"), type, row.id, row.version || 1, row.name, JSON.stringify({ name: row.name, cols }), reason || null, nowISO(), (user && user.name) || "system"]
  );
  return true;
}

function list(type, templateId) {
  return all(
    "SELECT id, version, name, reason, created_at, created_by FROM template_versions WHERE template_type = ? AND template_id = ? ORDER BY created_at DESC, version DESC",
    [type, templateId]
  ).map((v) => ({ id: v.id, version: v.version, name: v.name, reason: v.reason, createdAt: v.created_at, createdBy: v.created_by }));
}

function find(type, templateId, versionId) {
  const v = get("SELECT * FROM template_versions WHERE id = ? AND template_type = ? AND template_id = ?", [versionId, type, templateId]);
  if (!v) return null;
  let data = null; try { data = JSON.parse(v.data); } catch (e) { data = null; }
  if (!data || typeof data.cols !== "object") return null;
  return { row: v, data };
}

// The template as it looked in that version: the current row with the
// snapshot's columns laid over it (a column added after the snapshot keeps
// its current value).
function rowAsOf(current, found, fieldDefs) {
  const out = { ...current, name: found.data.name || current.name };
  for (const def of fieldDefs) if (Object.prototype.hasOwnProperty.call(found.data.cols, def.col)) out[def.col] = found.data.cols[def.col];
  return out;
}

// Put a version back: snapshot what is there now, then write the old values.
function restore(type, current, found, fieldDefs, user) {
  const table = TABLE_OF[type];
  snapshot(type, current, fieldDefs, user, `Before restoring version ${found.row.version}`);
  const setCols = ["name = ?", "version = version + 1", "updated_at = ?", "updated_by = ?"];
  const vals = [found.data.name || current.name, nowISO(), user.name];
  for (const def of fieldDefs) {
    if (!Object.prototype.hasOwnProperty.call(found.data.cols, def.col)) continue;
    setCols.push(`${def.col} = ?`);
    vals.push(found.data.cols[def.col]);
  }
  vals.push(current.id);
  run(`UPDATE ${table} SET ${setCols.join(", ")} WHERE id = ?`, vals);
}

module.exports = { snapshot, list, find, rowAsOf, restore };
