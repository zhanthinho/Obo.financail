"use strict";

// SECURITY AUDIT round (CSV/formula injection): a text cell that starts with
// = + - @ (or a tab/CR) is run as a FORMULA when the CSV is opened in Excel
// or Sheets — so a customer named "=HYPERLINK(...)" could execute in whoever
// opens the export. Such cells are prefixed with an apostrophe (the OWASP
// recommendation). Plain numbers, including negatives like -1250.50, are
// left untouched so amounts stay numeric.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;
function neutralizeFormula(s) {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}
function escapeCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string") s = neutralizeFormula(s);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// LANGUAGE round: in Somali the column headings and interface words in cells
// (e.g. "Active", "Deposit") are translated; data (names, references,
// amounts) never matches the dictionary so it passes through unchanged.
// opts.raw keeps a file English-only (the import template, whose headings
// are the importer's contract).
function toCSV(headerRow, rows, opts) {
  const { tr } = require("./i18n/request");
  const loc = opts && opts.raw ? (v) => v : (v) => (typeof v === "string" ? tr(v) : v);
  const lines = [headerRow.map((h) => escapeCell(loc(h))).join(",")];
  for (const row of rows) lines.push(row.map((c) => escapeCell(loc(c))).join(","));
  // Leading BOM so Excel opens UTF-8 (e.g. "SLSH", non-ASCII names) correctly.
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ACCOUNT IMPORT & EXPORT round: the counterpart reader to toCSV above —
// nothing in this app has ever needed to READ a CSV before now (only write
// one, for export). Hand-written rather than a dependency since the format
// is simple and this keeps the same "zero new runtime deps" footprint as
// the rest of the codebase. Handles: quoted fields (with embedded commas,
// newlines, and escaped "" quotes), a leading UTF-8 BOM (written by toCSV
// itself, and by Excel's own "CSV UTF-8" export), and both \r\n and \n line
// endings. Returns { headers: string[], rows: string[][] } — every row is
// padded/truncated to headers.length is NOT done here; callers (the import
// route) look up cells by header name and tolerate short rows.
function parseCSV(text) {
  if (typeof text !== "string") text = String(text || "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  function endField() { row.push(field); field = ""; }
  function endRow() { endField(); rows.push(row); row = []; }
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ",") { endField(); i += 1; continue; }
    if (c === "\r") { i += 1; continue; } // swallow, \n (or EOF) ends the row
    if (c === "\n") { endRow(); i += 1; continue; }
    field += c; i += 1;
  }
  // Final field/row (file may or may not end with a newline).
  if (field !== "" || row.length > 0) endRow();
  // Drop fully-blank trailing rows (common with a trailing newline, or
  // Excel padding out a saved CSV with empty lines).
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h || "").trim());
  return { headers, rows: rows.slice(1) };
}

module.exports = { toCSV, parseCSV };
