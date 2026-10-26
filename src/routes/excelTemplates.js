"use strict";
// EXCEL TEMPLATE & CUSTOMIZATION ENGINE round: the Excel counterpart of
// routes/pdfTemplates.js — same exact shape (Create/Edit/Duplicate/Delete/
// Set Default/Archive/Restore/Reset/Preview, one row per document kind,
// SUPER ADMIN ONLY via the same no-legacy-mapping "excelTemplates.manage"
// permission trick pdfTemplates.manage already uses — see rbac.js's
// keysSatisfy: a key absent from permissions.js's PERMISSION_CATALOG can
// only ever be satisfied by a Super Admin's ALL_ACCESS bypass, never
// granted to any other role). Every mutation here only changes ROWS in the
// brand-new excel_templates table — it never touches pdf_templates, so the
// existing PDF Template system is completely unaffected.
const { get, all, run } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { addAudit, getCompanySettings, getDefaultExcelTemplate, quotationTotals } = require("../domain");
const { uid, nowISO } = require("../util");
const { buildProfessionalWorkbook, TABLE_THEMES } = require("../xlsx-engine");
const { buildQuotationWorkbook, buildExchangeReceiptWorkbook, buildTransactionStatementWorkbook } = require("../xlsx-documents");
const { buildAccountStatementWorkbook } = require("../xlsx-account-report");

// Reuses the exact same kind taxonomy as the PDF Template system (spec:
// "work alongside the existing PDF Template system") — an Accounts Excel
// template and an Accounts PDF template are two independent rows, but they
// classify documents the same way so the two settings pages read alike.
const KIND_LABELS = {
  global: "All Documents (Global Default)",
  account: "Account Statement",
  quotation: "Quotation",
  exchange: "Money Exchange Receipt",
  transaction: "Transaction Statement",
  reports: "Reports",
  deposit: "Credit Receipt",
  withdrawal: "Debit Receipt",
  transfer: "Transfer Receipt",
};
const VALID_KINDS = new Set(Object.keys(KIND_LABELS));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const FIELD_DEFS = [
  { key: "showLogo", col: "show_logo", type: "bool" },
  { key: "showCompanyName", col: "show_company_name", type: "bool" },
  { key: "showCompanySubtitle", col: "show_company_subtitle", type: "bool" },
  { key: "showCompanyAddress", col: "show_company_address", type: "bool" },
  { key: "showCompanyPhone", col: "show_company_phone", type: "bool" },
  { key: "showCompanyEmail", col: "show_company_email", type: "bool" },
  { key: "showCompanyWebsite", col: "show_company_website", type: "bool" },
  { key: "showDocTitle", col: "show_doc_title", type: "bool" },
  { key: "showDocNumber", col: "show_doc_number", type: "bool" },
  { key: "showGeneratedDate", col: "show_generated_date", type: "bool" },
  { key: "showGeneratedBy", col: "show_generated_by", type: "bool" },
  { key: "showDateRange", col: "show_date_range", type: "bool" },
  { key: "showNotes", col: "show_notes", type: "bool" },
  { key: "showBillToAddress", col: "show_bill_to_address", type: "bool" },
  { key: "showBillToContact", col: "show_bill_to_contact", type: "bool" },
  { key: "colorPrimary", col: "color_primary", type: "color" },
  { key: "colorSecondary", col: "color_secondary", type: "color" },
  { key: "colorAccent", col: "color_accent", type: "color" },
  { key: "colorText", col: "color_text", type: "color" },
  { key: "colorMuted", col: "color_muted", type: "color" },
  { key: "colorTableHeader", col: "color_table_header", type: "color" },
  { key: "tableHeaderTextColor", col: "table_header_text_color", type: "color" },
  { key: "fontFamily", col: "font_family", type: "enum", values: ["Calibri", "Arial", "Times New Roman", "Georgia"] },
  { key: "fontSizeTitle", col: "font_size_title", type: "float" },
  { key: "fontSizeHeading", col: "font_size_heading", type: "float" },
  { key: "fontSizeBody", col: "font_size_body", type: "float" },
  { key: "tableTheme", col: "table_theme", type: "enum", values: Object.keys(TABLE_THEMES) },
  { key: "tableAltRows", col: "table_alt_rows", type: "bool" },
  { key: "freezeHeader", col: "freeze_header", type: "bool" },
  { key: "enableFilters", col: "enable_filters", type: "bool" },
  { key: "dateFormat", col: "date_format", type: "enum", values: ["dd mmm yyyy", "yyyy-mm-dd", "mm/dd/yyyy", "dd/mm/yyyy"] },
  { key: "showFooter", col: "show_footer", type: "bool" },
  { key: "footerShowCompanyName", col: "footer_show_company_name", type: "bool" },
  { key: "footerShowGeneratedBy", col: "footer_show_generated_by", type: "bool" },
  { key: "footerShowGeneratedDate", col: "footer_show_generated_date", type: "bool" },
  { key: "footerShowPageNumber", col: "footer_show_page_number", type: "bool" },
  { key: "footerCustomText", col: "footer_custom_text", type: "text", max: 200 },
  { key: "footerAlign", col: "footer_align", type: "enum", values: ["left", "center", "right"] },
  { key: "pageOrientation", col: "page_orientation", type: "enum", values: ["auto", "portrait", "landscape"] },
  { key: "fitToPage", col: "fit_to_page", type: "bool" },
  { key: "repeatHeaderRows", col: "repeat_header_rows", type: "bool" },
];

// The exact literal each NOT NULL column falls back to on "Reset to
// Defaults" — copied straight from the CREATE TABLE in schema.sql.
const COLUMN_DEFAULTS = {
  show_logo: 1, show_company_name: 1, show_company_subtitle: 1, show_company_address: 1, show_company_phone: 1,
  show_company_email: 1, show_company_website: 1, show_doc_title: 1, show_doc_number: 1, show_generated_date: 1,
  show_generated_by: 1, show_date_range: 1, show_notes: 1, show_bill_to_address: 1, show_bill_to_contact: 1,
  font_family: "'Calibri'", font_size_title: 16, font_size_heading: 13, font_size_body: 10,
  table_theme: "'medium_blue'", table_alt_rows: 1, freeze_header: 1, enable_filters: 1, date_format: "'dd mmm yyyy'",
  show_footer: 1, footer_show_company_name: 1, footer_show_generated_by: 1, footer_show_generated_date: 1,
  footer_show_page_number: 1, footer_align: "'left'", page_orientation: "'auto'", fit_to_page: 1, repeat_header_rows: 1,
};
const RESET_SQL = FIELD_DEFS.map((def) => `${def.col} = ${Object.prototype.hasOwnProperty.call(COLUMN_DEFAULTS, def.col) ? COLUMN_DEFAULTS[def.col] : "NULL"}`).join(", ");

// SUPER ADMIN PROFESSIONAL PRESETS — the same 5 named looks the PDF
// Template system offers, so a Super Admin picks one recognizable identity
// ("Corporate", "Classic Financial"...) and gets it consistently across
// both PDF and Excel output for that document kind.
const PRESETS = {
  modern_emerald: {
    name: "Modern Emerald", description: "Fresh emerald green header with a light banded table.",
    columns: { color_primary: "#0f9d6e", color_secondary: "#0b3d2e", color_accent: "#0f9d6e", color_table_header: "#e3f7ef", table_header_text_color: "#0b3d2e", font_family: "Calibri", table_theme: "medium_green", table_alt_rows: 1, footer_align: "left" },
  },
  corporate: {
    name: "Corporate", description: "Deep corporate blue with a gold accent on a Times New Roman face.",
    columns: { color_primary: "#0b3d91", color_secondary: "#0b3d91", color_accent: "#c9a227", color_table_header: "#e8edf7", table_header_text_color: "#0b3d91", font_family: "Times New Roman", table_theme: "medium_blue", table_alt_rows: 0, footer_align: "center" },
  },
  minimal: {
    name: "Minimal", description: "Plain black on white, no shaded header row, light table style.",
    columns: { color_primary: "#111111", color_secondary: "#111111", color_accent: "#111111", color_table_header: null, table_header_text_color: "#111111", font_family: "Calibri", table_theme: "light", table_alt_rows: 0, footer_align: "left" },
  },
  classic_financial: {
    name: "Classic Financial", description: "Traditional maroon and gold on a serif face.",
    columns: { color_primary: "#7a1f1f", color_secondary: "#3a0d0d", color_accent: "#b6862c", color_table_header: "#f4e9df", table_header_text_color: "#3a0d0d", font_family: "Georgia", table_theme: "medium_gold", table_alt_rows: 1, footer_align: "center" },
  },
  premium_business: {
    name: "Premium Business", description: "Near-black ink with a gold accent and a dark navy table theme.",
    columns: { color_primary: "#1a1a2e", color_secondary: "#1a1a2e", color_accent: "#c9a227", color_table_header: "#efeef5", table_header_text_color: "#1a1a2e", font_family: "Calibri", table_theme: "dark_navy", table_alt_rows: 1, footer_align: "right" },
  },
};

function serialize(row) {
  if (!row) return null;
  const out = {
    id: row.id, kind: row.kind, name: row.name,
    isDefault: !!row.is_default, isArchived: !!row.is_archived, isBuiltin: !!row.is_builtin,
    presetKey: row.preset_key || null,
    version: row.version, createdAt: row.created_at, createdBy: row.created_by,
    updatedAt: row.updated_at, updatedBy: row.updated_by,
  };
  for (const def of FIELD_DEFS) {
    const raw = row[def.col];
    if (def.type === "bool") out[def.key] = !!raw;
    else if (def.type === "text") out[def.key] = raw || "";
    else out[def.key] = raw ?? null;
  }
  return out;
}

function validateAndConvert(def, raw) {
  if (raw === null) {
    if (Object.prototype.hasOwnProperty.call(COLUMN_DEFAULTS, def.col)) {
      return { error: `${def.key} can't be cleared — set it to a valid value or use Reset to Defaults.` };
    }
    return { value: null };
  }
  switch (def.type) {
    case "bool": return { value: raw ? 1 : 0 };
    case "float": { const n = Number(raw); return Number.isFinite(n) ? { value: n } : { error: `${def.key} must be a number.` }; }
    case "text": { const s = String(raw); return def.max && s.length > def.max ? { error: `${def.key} is too long (max ${def.max} characters).` } : { value: s || null }; }
    case "color": return HEX_RE.test(raw) ? { value: raw } : { error: `${def.key} must be a hex color like #084b83.` };
    case "enum": return def.values.includes(raw) ? { value: raw } : { error: `${def.key} must be one of: ${def.values.join(", ")}.` };
    default: return { value: raw };
  }
}

// ---- Preview sample data, one branch per document kind — mirrors
// buildPreviewPDF in routes/pdfTemplates.js exactly (same dummy data, same
// "real=1 pulls the most recent genuine record" behavior), just rendered
// through the Excel builders instead of the PDF ones, so a Super Admin
// previewing an Excel Template sees the same sample document a PDF preview
// would show — just as a real .xlsx file. ----
async function buildPreviewXLSX(kind, template, company, user, useReal) {
  const generatedBy = user.name;
  if (kind === "quotation") {
    if (useReal) {
      const q = get("SELECT * FROM quotations ORDER BY created_at DESC LIMIT 1");
      if (q) {
        const items = all("SELECT * FROM quotation_items WHERE quotation_id = ?", [q.id]);
        const totals = quotationTotals(items, q.discount_percent, q.tax_percent, null);
        return buildQuotationWorkbook({ quotation: q, items, totals, statusLabel: q.status, company, columns: null, template, generatedBy });
      }
    }
    const dummyItems = [
      { description: "Currency exchange service fee", qty: 1, unit_price: 250, currency: "USD", extra_fields: null },
      { description: "Wire transfer handling", qty: 2, unit_price: 45, currency: "USD", extra_fields: null },
    ];
    const totals = quotationTotals(dummyItems, 5, 0, null);
    const dummyQuotation = {
      number: "QT-PREVIEW-0000", issue_date: new Date().toISOString().slice(0, 10),
      valid_until: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      client_name: "Sample Customer Ltd.", client_address: "123 Sample Street, Hargeysa",
      client_contact: "+252 63 000 0000", discount_percent: 5, tax_percent: 0,
      notes: "This is a sample preview — no real quotation data is used.", invoiced: false,
    };
    return buildQuotationWorkbook({ quotation: dummyQuotation, items: dummyItems, totals, statusLabel: "Pending", company, columns: null, template, generatedBy });
  }
  if (kind === "account") {
    const account = { accountNumber: "ACC-0000", name: "Sample Customer Ltd.", accountType: "customer", currency: "USD", currentBalance: 1250.5, registrationDate: "2024-01-01" };
    const rows = [
      { idx: 0, date: "2026-01-01", reference: "R1", type: "Credit", notes: "Sample credit", deposit: 1000, withdrawal: null, balanceAfter: 1000, staff: generatedBy },
      { idx: 1, date: "2026-01-05", reference: "R2", type: "Debit", notes: "Sample debit", deposit: null, withdrawal: 250, balanceAfter: 1250, staff: generatedBy },
    ];
    return buildAccountStatementWorkbook({
      company, account, rows,
      summary: { openingBalance: 0, totalDeposits: 1000, totalWithdrawals: 250, closingBalance: 1250, totalTransactions: 2, netMovement: 750 },
      columnOrder: ["notes", "deposit", "withdrawal", "balanceAfter", "staff"], from: null, to: null, generatedBy, template,
    });
  }
  if (kind === "exchange") {
    if (useReal) {
      const row = get("SELECT * FROM exchange_transactions ORDER BY date DESC LIMIT 1");
      if (row) {
        const tx = {
          id: row.id, referenceNumber: row.reference_number, date: row.date, clientName: row.client_name,
          currencyGiven: row.currency_given, currencyReceived: row.currency_received, amountGiven: row.amount_given,
          amountReceived: row.amount_received, rateUsed: row.rate_used, profitUsd: row.profit_usd,
          staffName: row.staff_name, status: row.status, voidReason: row.void_reason, notes: row.notes,
        };
        return buildExchangeReceiptWorkbook({ company, tx, dailyRate: row.rate_used, saleRate: row.rate_used, canViewProfit: true, generatedBy, template });
      }
    }
    const tx = {
      referenceNumber: "EX-PREVIEW-0000", date: new Date().toISOString(), clientName: "Sample Customer Ltd.",
      currencyGiven: "USD", currencyReceived: "SLSH", amountGiven: 500, amountReceived: 5750000,
      rateUsed: 11500, profitUsd: 12.5, staffName: generatedBy, status: "completed", notes: "Sample preview transaction — no real transaction data is used.",
    };
    return buildExchangeReceiptWorkbook({ company, tx, dailyRate: 11500, saleRate: 11550, canViewProfit: true, generatedBy, template });
  }
  if (kind === "transaction") {
    const rows = [
      { date: "2026-01-01", reference: "EX-0001", type: "Exchange", accountName: "Sample Customer Ltd.", amountSummary: "$500.00 → SLSH 5,750,000", status: "Completed" },
      { date: "2026-01-03", reference: "DEP-0002", type: "Credit", accountName: "Sample Customer Ltd.", amountSummary: "$250.00", status: "Completed" },
    ];
    return buildTransactionStatementWorkbook({
      company, rows, filterSummary: "Sample preview — all transaction types, no real records used",
      totals: { totalTransactions: 2, totalDepositsLabel: "$250.00", totalWithdrawalsLabel: "$0.00", netMovementLabel: "$250.00" },
      from: null, to: null, generatedBy, template,
    });
  }
  // deposit / withdrawal / transfer have no dedicated Excel document today
  // (only a PDF receipt exists — see routes/ledger.js and routes/
  // transfers.js), and reports/global don't map to any one real record, so
  // every remaining kind previews through the same generic report table the
  // Excel Accounts/Reports list exports already use.
  return buildProfessionalWorkbook({
    company, template, generatedBy,
    sheetName: "Sample Report",
    docTypeLabel: "SAMPLE REPORT",
    subtitleLines: ["Preview — sample data, no real records used"],
    table: {
      columns: [
        { key: "date", label: "Date", width: 14, isDate: true },
        { key: "description", label: "Description", width: 30 },
        { key: "amount", label: "Amount", width: 16, align: "right", numFmt: '"$"#,##0.00' },
      ],
      rows: [
        { date: new Date("2026-01-01"), description: "Sample line item", amount: 500 },
        { date: new Date("2026-01-02"), description: "Another sample line", amount: 120 },
      ],
      cellValue: (row, key) => row[key],
      totalsRow: { date: "TOTAL", amount: "sum" },
    },
  });
}

function register(router) {
  router.get("/api/excel-templates/kinds", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const kinds = Object.entries(KIND_LABELS).map(([key, label]) => {
      const def = get("SELECT id, name FROM excel_templates WHERE kind = ? AND is_default = 1 AND is_archived = 0", [key]);
      const count = get("SELECT COUNT(*) as n FROM excel_templates WHERE kind = ? AND is_archived = 0", [key]).n;
      return { key, label, defaultTemplateId: def ? def.id : null, defaultTemplateName: def ? def.name : null, templateCount: count };
    });
    sendJSON(res, 200, { kinds });
  });

  router.get("/api/excel-templates/presets", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    sendJSON(res, 200, { presets: Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, description: p.description, swatch: p.columns.color_primary || null, accent: p.columns.color_accent || null })) });
  });

  router.get("/api/excel-templates", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const kind = query && query.kind;
    if (!kind || !VALID_KINDS.has(kind)) return badRequest(res, "Unknown or missing template kind.");
    const includeArchived = query && (query.includeArchived === "1" || query.includeArchived === "true");
    const rows = includeArchived
      ? all("SELECT * FROM excel_templates WHERE kind = ? ORDER BY is_default DESC, name COLLATE NOCASE", [kind])
      : all("SELECT * FROM excel_templates WHERE kind = ? AND is_archived = 0 ORDER BY is_default DESC, name COLLATE NOCASE", [kind]);
    sendJSON(res, 200, { templates: rows.map(serialize) });
  });

  router.get("/api/excel-templates/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    sendJSON(res, 200, { template: serialize(row) });
  });

  router.post("/api/excel-templates", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const kind = body.kind;
    if (!kind || !VALID_KINDS.has(kind)) return badRequest(res, "Unknown or missing template kind.");
    if (!body.name || !String(body.name).trim()) return badRequest(res, "A template name is required.");
    if (String(body.name).length > 80) return badRequest(res, "Template name is too long (max 80 characters).");
    if (body.presetKey !== undefined && body.presetKey !== null && !PRESETS[body.presetKey]) return badRequest(res, "Unknown preset.");

    const seed = body.presetKey && PRESETS[body.presetKey] ? PRESETS[body.presetKey].columns : {};
    const cols = ["id", "kind", "name", "is_default", "is_archived", "is_builtin", "preset_key", "version", "created_at", "created_by", "updated_at", "updated_by"];
    const now = nowISO();
    const id = uid("xtpl");
    const vals = [id, kind, String(body.name).trim(), 0, 0, 0, body.presetKey || null, 1, now, user.name, now, user.name];

    for (const def of FIELD_DEFS) {
      const has = Object.prototype.hasOwnProperty.call(body, def.key);
      let raw;
      if (has) raw = body[def.key];
      else if (Object.prototype.hasOwnProperty.call(seed, def.col)) raw = seed[def.col];
      else continue;
      const { value, error } = validateAndConvert(def, raw);
      if (error) return badRequest(res, error);
      cols.push(def.col);
      vals.push(value);
    }
    run(`INSERT INTO excel_templates (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    addAudit(user, "Excel template created", String(body.name).trim());
    sendJSON(res, 201, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [id])) });
  });

  router.patch("/api/excel-templates/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const current = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!current) return notFound(res, "Template not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (body.name !== undefined) {
      if (!String(body.name).trim()) return badRequest(res, "A template name is required.");
      if (String(body.name).length > 80) return badRequest(res, "Template name is too long (max 80 characters).");
    }
    const setCols = ["name = ?", "version = version + 1", "updated_at = ?", "updated_by = ?"];
    const vals = [body.name !== undefined ? String(body.name).trim() : current.name, nowISO(), user.name];
    for (const def of FIELD_DEFS) {
      if (!Object.prototype.hasOwnProperty.call(body, def.key)) continue;
      const { value, error } = validateAndConvert(def, body[def.key]);
      if (error) return badRequest(res, error);
      setCols.push(`${def.col} = ?`);
      vals.push(value);
    }
    vals.push(params.id);
    run(`UPDATE excel_templates SET ${setCols.join(", ")} WHERE id = ?`, vals);
    addAudit(user, "Excel template updated", body.name !== undefined ? String(body.name).trim() : current.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/excel-templates/:id/duplicate", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const src = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!src) return notFound(res, "Template not found.");
    let body = {}; try { body = (await readJSONBody(req)) || {}; } catch (e) { /* body is optional here */ }
    const name = (body.name && String(body.name).trim()) || `${src.name} (Copy)`;
    const now = nowISO();
    const id = uid("xtpl");
    const cols = ["id", "kind", "name", "is_default", "is_archived", "is_builtin", "preset_key", "version", "created_at", "created_by", "updated_at", "updated_by", ...FIELD_DEFS.map((d) => d.col)];
    const vals = [id, src.kind, name, 0, 0, 0, src.preset_key, 1, now, user.name, now, user.name, ...FIELD_DEFS.map((d) => src[d.col])];
    run(`INSERT INTO excel_templates (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    addAudit(user, "Excel template duplicated", `${name} (from ${src.name})`);
    sendJSON(res, 201, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [id])) });
  });

  router.post("/api/excel-templates/:id/set-default", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_archived) return badRequest(res, "An archived template can't be set as the default — restore it first.");
    if (row.is_default) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE excel_templates SET is_default = 0 WHERE kind = ? AND is_default = 1", [row.kind]);
    run("UPDATE excel_templates SET is_default = 1, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "Excel template set as default", `${row.name} (${KIND_LABELS[row.kind] || row.kind})`);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/excel-templates/:id/archive", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_default) return badRequest(res, "Can't archive the default template — set a different one as default first.");
    if (row.is_archived) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE excel_templates SET is_archived = 1, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "Excel template archived", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/excel-templates/:id/restore", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (!row.is_archived) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE excel_templates SET is_archived = 0, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "Excel template restored", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/excel-templates/:id/reset", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    run(`UPDATE excel_templates SET ${RESET_SQL}, preset_key = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`, [nowISO(), user.name, params.id]);
    addAudit(user, "Excel template reset to defaults", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM excel_templates WHERE id = ?", [params.id])) });
  });

  router.delete("/api/excel-templates/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const row = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_builtin) return badRequest(res, "The built-in default template can't be deleted.");
    if (row.is_default) return badRequest(res, "Can't delete the default template — set a different one as default first.");
    run("DELETE FROM excel_templates WHERE id = ?", [params.id]);
    addAudit(user, "Excel template deleted", row.name);
    sendJSON(res, 200, { ok: true });
  });

  // Renders a real sample .xlsx with this template's settings applied —
  // doubles as "Preview Template" (dummy data) and "Generate Test Excel"
  // (?real=1, most recent genuine record), same split as the PDF system's
  // preview.pdf endpoint.
  router.get("/api/excel-templates/:id/preview.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "excelTemplates.manage")) return;
    const template = get("SELECT * FROM excel_templates WHERE id = ?", [params.id]);
    if (!template) return notFound(res, "Template not found.");
    const useReal = !!(query && (query.real === "1" || query.real === "true"));
    const xlsx = await buildPreviewXLSX(template.kind, template, getCompanySettings(), user, useReal);
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="excel-template-preview-${template.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.xlsx"`,
    });
    res.end(xlsx);
  });
}

module.exports = { register, KIND_LABELS };
