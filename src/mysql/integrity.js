"use strict";
// MYSQL round — foreign-key orphan check for one scope (the MySQL stand-in
// for SQLite's PRAGMA foreign_key_check), from the relationships recorded in
// schema.json. Read-only.
const schema = require("./schema");

// Returns [{ table, column, refTable, count }] for every relationship that has
// rows pointing at a parent row that does not exist.
function foreignKeyViolations(h, kind) {
  const out = [];
  for (const t of schema.tablesFor(kind)) {
    for (const f of t.foreignKeys) {
      if (f.columns.length !== 1) continue;
      const c = f.columns[0], rc = f.refColumns[0];
      const n = h.raw(`SELECT COUNT(*) AS n FROM "${h.table(t.name)}" x WHERE x."${c}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${h.table(f.refTable)}" p WHERE p."${rc}" = x."${c}")`)[0].n;
      if (n) out.push({ table: t.name, column: c, refTable: f.refTable, count: n });
    }
  }
  return out;
}

module.exports = { foreignKeyViolations };
