"use strict";
// ACCOUNT IMPORT & EXPORT round: all the row-level parsing/validation logic
// for bulk account import, shared between POST /api/accounts/import/preview
// and POST /api/accounts/import/commit (routes/accounts.js) so the two can
// never disagree about what counts as valid — commit re-runs this exact
// same classification from scratch against a fresh read of the database,
// rather than trusting whatever the client says the preview showed.
//
// This module does NOT touch the database for writes — it only READS
// existing accounts (to detect duplicates) and returns plain data. All
// actual INSERT/UPDATE happens in routes/accounts.js's commit handler,
// inside one transaction, reusing the exact same opening-balance mechanism
// POST /api/accounts already uses.
const { all } = require("./db");
const ExcelJS = require("exceljs");

// Column order for both the downloadable import templates and the parsed
// header lookup — matches spec section 3 exactly ("Do NOT require technical
// database IDs").
const TEMPLATE_COLUMNS = ["Account #", "Account Name", "Account Type", "Currency", "Phone", "Email", "Status", "Opening Balance", "Notes"];

// Accepts a handful of reasonable header spellings per column so a
// user-edited template (renamed casing, "Acct #" style tweaks) doesn't
// silently fail to parse — matched case-insensitively, trimmed.
const HEADER_ALIASES = {
  accountNumber: ["account #", "account number", "account no", "acct #", "acct no"],
  name: ["account name", "name", "client name"],
  accountType: ["account type", "type"],
  currency: ["currency"],
  phone: ["phone", "contact", "phone number"],
  email: ["email", "email address"],
  status: ["status"],
  openingBalance: ["opening balance", "opening", "balance"],
  notes: ["notes", "note", "remarks"],
};

function normalizeHeaderKey(h) {
  return String(h || "").trim().toLowerCase();
}

// Maps a row's raw header->value object (however it was parsed) to our
// canonical field names.
function mapRowByHeaders(headers, values) {
  const byNorm = {};
  // LANGUAGE round: a file exported in Somali has Somali headings — map
  // each one back to its English heading too (the English key wins).
  const { untranslate } = require("./i18n");
  headers.forEach((h, i) => { byNorm[normalizeHeaderKey(h)] = values[i]; });
  headers.forEach((h, i) => { const en = normalizeHeaderKey(untranslate(String(h || "").trim())); if (!Object.prototype.hasOwnProperty.call(byNorm, en)) byNorm[en] = values[i]; });
  const out = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    let found;
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(byNorm, alias)) { found = byNorm[alias]; break; }
    }
    out[field] = found === undefined || found === null ? "" : String(found).trim();
  }
  return out;
}

const ACCOUNT_TYPE_MAP = { customer: "customer", client: "customer", company: "company", business: "company" };
const CURRENCY_SET = new Set(["USD", "SLSH"]);
const STATUS_MAP = { "": "active", active: "active", deactivated: "deactivated", inactive: "deactivated", suspended: "deactivated" };

// Parses + validates ONE row's own fields (no DB/duplicate awareness yet —
// that's layered on by classifyRows below, which needs the full batch).
function buildRow(mapped, rowNumber) {
  const row = {
    rowNumber,
    accountNumberRaw: mapped.accountNumber || "",
    accountNumber: mapped.accountNumber || "",
    name: (mapped.name || "").trim(),
    accountTypeRaw: mapped.accountType || "",
    accountType: null,
    currencyRaw: mapped.currency || "",
    currency: null,
    phone: mapped.phone || "",
    email: mapped.email || "",
    statusRaw: mapped.status || "",
    accountStatus: null, // the account's own active/deactivated state (distinct from `status` below, which is this row's import classification)
    openingBalanceRaw: mapped.openingBalance || "",
    openingBalance: 0,
    notes: mapped.notes || "",
    errors: [],
    warnings: [],
  };

  if (!row.name) row.errors.push("Missing Account Name.");

  const { untranslate } = require("./i18n");
  const typeKey = untranslate(row.accountTypeRaw.trim()).toLowerCase();
  if (!typeKey) { row.accountType = "customer"; row.warnings.push("Account type not specified — defaulting to Customer."); }
  else if (ACCOUNT_TYPE_MAP[typeKey]) row.accountType = ACCOUNT_TYPE_MAP[typeKey];
  else { row.errors.push(`Invalid account type: "${row.accountTypeRaw}". Use Customer or Company.`); }

  const curKey = row.currencyRaw.trim().toUpperCase();
  if (!curKey) { row.currency = "USD"; row.warnings.push("Currency not specified — defaulting to USD."); }
  else if (CURRENCY_SET.has(curKey)) row.currency = curKey;
  else { row.errors.push(`Invalid currency: "${row.currencyRaw}". Use USD or SLSH.`); }

  const statusKey = untranslate(row.statusRaw.trim()).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, statusKey)) row.accountStatus = STATUS_MAP[statusKey];
  else { row.errors.push(`Invalid status: "${row.statusRaw}". Use Active or Deactivated.`); }

  const obRaw = row.openingBalanceRaw.trim();
  if (!obRaw) { row.openingBalance = 0; }
  else {
    const n = Number(obRaw.replace(/,/g, ""));
    if (!Number.isFinite(n)) row.errors.push(`Invalid opening balance: "${row.openingBalanceRaw}".`);
    else if (n < 0) row.errors.push("Negative opening balance is not allowed.");
    else row.openingBalance = n;
  }

  if (!row.phone) row.warnings.push("Phone is empty.");
  if (!row.email) row.warnings.push("Email is empty.");

  return row;
}

// Full classification pass: takes the already-per-row-validated rows and
// layers on duplicate detection against BOTH the existing database and the
// rest of the same file, then assigns each row a final `status`:
//   "invalid"   — has at least one hard error, can never be imported as-is
//   "duplicate" — matches an existing account (by account # or exact name)
//   "valid"     — brand-new account, ready to import
function classifyRows(rows) {
  const existingByNumber = new Map();
  const existingByName = new Map();
  for (const c of all("SELECT id, account_number, name, account_type, currency, balance_usd, balance_slsh, status FROM clients WHERE deleted_at IS NULL", [])) {
    if (c.account_number) existingByNumber.set(c.account_number.trim().toLowerCase(), c);
    existingByName.set(c.name.trim().toLowerCase(), c);
  }
  const seenNumbersInFile = new Map(); // norm number -> first rowNumber
  const seenNamesInFile = new Map(); // norm name -> first rowNumber

  for (const row of rows) {
    if (row.errors.length) { row.status = "invalid"; continue; }

    const numNorm = row.accountNumber.trim().toLowerCase();
    const nameNorm = row.name.trim().toLowerCase();

    // In-file duplicates (two rows describing the same account in one file)
    // are always an error — silently picking one would be a surprise.
    if (numNorm && seenNumbersInFile.has(numNorm)) {
      row.errors.push(`Duplicate Account # within this file (also on row ${seenNumbersInFile.get(numNorm)}).`);
    } else if (numNorm) seenNumbersInFile.set(numNorm, row.rowNumber);
    if (seenNamesInFile.has(nameNorm)) {
      row.errors.push(`Duplicate Account Name within this file (also on row ${seenNamesInFile.get(nameNorm)}).`);
    } else seenNamesInFile.set(nameNorm, row.rowNumber);
    if (row.errors.length) { row.status = "invalid"; continue; }

    const existing = (numNorm && existingByNumber.get(numNorm)) || existingByName.get(nameNorm) || null;
    if (existing) {
      row.status = "duplicate";
      row.existingAccount = {
        id: existing.id, accountNumber: existing.account_number, name: existing.name,
        accountType: existing.account_type, currency: existing.currency,
        balance: existing.currency === "USD" ? existing.balance_usd : existing.balance_slsh,
        status: existing.status,
      };
      // Balance Safety (spec section 11): an imported Opening Balance must
      // NEVER silently replace an existing account's Current Balance — flag
      // it clearly so the UI can show it, even though the commit step never
      // applies it either way unless the caller explicitly chooses "Update
      // Account Details" (and even then, only non-financial fields move).
      if (row.openingBalance > 0) row.warnings.push("This account already exists — its opening balance/current balance will NOT be changed by this import.");
    } else {
      row.status = "valid";
    }
  }
  return rows;
}

function summarize(rows) {
  const s = { total: rows.length, valid: 0, duplicate: 0, invalid: 0, warnings: 0 };
  for (const r of rows) {
    if (r.status === "valid") s.valid += 1;
    else if (r.status === "duplicate") s.duplicate += 1;
    else if (r.status === "invalid") s.invalid += 1;
    if (r.warnings.length) s.warnings += 1;
  }
  return s;
}

function serializeRowForClient(r) {
  return {
    rowNumber: r.rowNumber,
    accountNumber: r.accountNumber || null,
    name: r.name,
    accountType: r.accountType,
    currency: r.currency,
    phone: r.phone || null,
    email: r.email || null,
    accountStatus: r.accountStatus || null, // the imported account's own active/deactivated state
    openingBalance: r.openingBalance,
    notes: r.notes || null,
    result: r.status, // classification: "valid" | "duplicate" | "invalid"
    errors: r.errors,
    warnings: r.warnings,
    existingAccount: r.existingAccount || null,
  };
}

const TEMPLATE_EXAMPLE_ROWS = [
  ["", "A-Raheen Moh'ed Ali", "Customer", "USD", "252634000000", "araheen@example.com", "Active", "500", ""],
  ["", "Abdirahin Mohamed", "Customer", "USD", "252634000001", "", "Active", "1000", ""],
  ["", "Company Account", "Company", "SLSH", "252634000002", "", "Active", "250000", "Corporate account"],
];

// Plain, professional data-entry template — bold/frozen header, autofilter,
// sensible widths, a few example rows — with EXACTLY the columns the import
// engine accepts (spec item 19: "Do NOT provide a template containing
// unsupported fields."). Deliberately built directly with ExcelJS rather
// than routed through xlsx-engine's buildProfessionalWorkbook: that engine
// is for finished REPORTS (KPI cards, totals rows, a document title block);
// this is a blank form the user types into, so it stays a single clean
// table with nothing to work around when pasting in real data.
async function buildImportTemplateWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OBO Financial System";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Accounts", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Account #", key: "accountNumber", width: 16 },
    { header: "Account Name", key: "name", width: 28 },
    { header: "Account Type", key: "accountType", width: 16 },
    { header: "Currency", key: "currency", width: 12 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 24 },
    { header: "Status", key: "status", width: 14 },
    { header: "Opening Balance", key: "openingBalance", width: 18 },
    { header: "Notes", key: "notes", width: 24 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E6B5C" } }; // deep emerald
  header.alignment = { vertical: "middle" };
  header.height = 20;
  for (const example of TEMPLATE_EXAMPLE_ROWS) sheet.addRow(example);
  sheet.getColumn(8).numFmt = "#,##0.00";
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEMPLATE_COLUMNS.length } };
  for (let r = 2; r <= sheet.rowCount; r++) {
    sheet.getRow(r).eachCell((cell) => { cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8E6" } } }; });
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  // VALIDATE BEFORE DOWNLOAD (see xlsx-engine.js's assertValidWorkbook for
  // why): cheap re-parse so a corrupt template is never silently handed out.
  const check = new ExcelJS.Workbook();
  await check.xlsx.load(buffer);
  return buffer;
}

module.exports = { TEMPLATE_COLUMNS, mapRowByHeaders, buildRow, classifyRows, summarize, serializeRowForClient, buildImportTemplateWorkbook };
