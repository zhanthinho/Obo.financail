"use strict";
// PDF TEMPLATE & CUSTOMIZATION ENGINE round: generalizes the Round 1
// quotation-only template manager (form-based Create/Edit/Delete/Duplicate/
// Preview/Set Default/Archive/Restore) into the full spec — every document
// kind in the system, plus colors, fonts, page settings, header/footer,
// table styling, summary cards, notes/terms, signatures, and 5 built-in
// presets — still a settings-panel customizer (see resolveStyle in
// src/pdf.js), not the spec's full drag-and-drop visual canvas editor; that
// remains a much larger, separate project, same explicit scope decision as
// Round 1 documented for the future.
//
// GATING CHANGE: every mutation route below now checks "pdfTemplates.manage"
// instead of the old "settingsManage" — a brand-new, Super-Admin-only
// granular permission (see permissions.js) with no legacy mapping, so only
// a real Super Admin (via rbac.js's ALL_ACCESS bypass) can ever pass it,
// exactly the spec's "SUPER ADMIN ONLY" requirement. Every other PDF action
// (preview/generate/download/print an actual document) is untouched and
// still gated by whatever permission already governed that document.
const { get, all, run } = require("../db");
const { sendJSON, badRequest, notFound, sendPDF, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { addAudit, getCompanySettings, getDefaultPdfTemplate, quotationTotals } = require("../domain");
const { uid, nowISO } = require("../util");
const {
  renderQuotationDocumentPDF, renderAccountStatementPDF, renderExchangeReceiptPDF,
  renderTransactionStatementPDF, renderLedgerReceiptPDF, renderTransferReceiptPDF, renderReportPDF,
} = require("../pdf");

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

// Declarative field catalog: every customizable column beyond the Round 1
// toggle set. `col` is the DB column, `type` picks validation/coercion.
// Colors/free text/optional numbers are nullable (null = inherit the
// brand/module default, see resolveStyle) — everything else has a NOT NULL
// DEFAULT in the schema itself (see db.js's pdf_templates recreate).
const FIELD_DEFS = [
  { key: "headerNote", col: "header_note", type: "text", max: 400 },
  { key: "footerText", col: "footer_text", type: "text", max: 400 },
  { key: "showSignatureLines", col: "show_signature_lines", type: "bool" },
  { key: "showNotes", col: "show_notes", type: "bool" },
  { key: "showBillToAddress", col: "show_bill_to_address", type: "bool" },
  { key: "showBillToContact", col: "show_bill_to_contact", type: "bool" },
  { key: "paperSize", col: "paper_size", type: "enum", values: ["A4", "A5", "Letter", "Legal", "Custom"] },
  { key: "orientation", col: "orientation", type: "enum", values: ["portrait", "landscape"] },
  { key: "pageWidth", col: "page_width", type: "float" },
  { key: "pageHeight", col: "page_height", type: "float" },
  { key: "marginTop", col: "margin_top", type: "float" },
  { key: "marginBottom", col: "margin_bottom", type: "float" },
  { key: "marginLeft", col: "margin_left", type: "float" },
  { key: "marginRight", col: "margin_right", type: "float" },
  { key: "colorPrimary", col: "color_primary", type: "color" },
  { key: "colorSecondary", col: "color_secondary", type: "color" },
  { key: "colorAccent", col: "color_accent", type: "color" },
  { key: "colorText", col: "color_text", type: "color" },
  { key: "colorMuted", col: "color_muted", type: "color" },
  { key: "colorTableHeader", col: "color_table_header", type: "color" },
  { key: "colorTableBorder", col: "color_table_border", type: "color" },
  { key: "colorBackground", col: "color_background", type: "color" },
  { key: "colorSuccess", col: "color_success", type: "color" },
  { key: "colorWarning", col: "color_warning", type: "color" },
  { key: "colorDanger", col: "color_danger", type: "color" },
  { key: "fontFamily", col: "font_family", type: "enum", values: ["helvetica", "times", "courier"] },
  { key: "fontSizeTitle", col: "font_size_title", type: "float" },
  { key: "fontSizeHeading", col: "font_size_heading", type: "float" },
  { key: "fontSizeBody", col: "font_size_body", type: "float" },
  { key: "fontSizeTable", col: "font_size_table", type: "float" },
  { key: "fontSizeFooter", col: "font_size_footer", type: "float" },
  { key: "headerStyle", col: "header_style", type: "enum", values: ["minimal", "classic", "modern", "professional", "corporate"] },
  { key: "logoPosition", col: "logo_position", type: "enum", values: ["left", "center", "right"] },
  { key: "logoMaxSize", col: "logo_max_size", type: "float" },
  { key: "showLogo", col: "show_logo", type: "bool" },
  { key: "showCompanyName", col: "show_company_name", type: "bool" },
  { key: "showCompanySubtitle", col: "show_company_subtitle", type: "bool" },
  { key: "showCompanyAddress", col: "show_company_address", type: "bool" },
  { key: "showCompanyPhone", col: "show_company_phone", type: "bool" },
  { key: "showCompanyEmail", col: "show_company_email", type: "bool" },
  { key: "showCompanyWebsite", col: "show_company_website", type: "bool" },
  { key: "showRegistrationNumber", col: "show_registration_number", type: "bool" },
  { key: "showTaxNumber", col: "show_tax_number", type: "bool" },
  { key: "showDocNumber", col: "show_doc_number", type: "bool" },
  { key: "showDocDate", col: "show_doc_date", type: "bool" },
  { key: "showFooter", col: "show_footer", type: "bool" },
  { key: "footerShowCompanyName", col: "footer_show_company_name", type: "bool" },
  { key: "footerShowPhone", col: "footer_show_phone", type: "bool" },
  { key: "footerShowEmail", col: "footer_show_email", type: "bool" },
  { key: "footerShowWebsite", col: "footer_show_website", type: "bool" },
  { key: "footerShowGeneratedBy", col: "footer_show_generated_by", type: "bool" },
  { key: "footerShowGeneratedDate", col: "footer_show_generated_date", type: "bool" },
  { key: "footerShowPageNumber", col: "footer_show_page_number", type: "bool" },
  { key: "footerShowSignature", col: "footer_show_signature", type: "bool" },
  { key: "footerCustomText", col: "footer_custom_text", type: "text", max: 400 },
  { key: "footerAlign", col: "footer_align", type: "enum", values: ["left", "center", "right"] },
  { key: "tableHeaderTextColor", col: "table_header_text_color", type: "color" },
  { key: "tableAltRows", col: "table_alt_rows", type: "bool" },
  { key: "tableBorderStyle", col: "table_border_style", type: "enum", values: ["none", "thin", "thick"] },
  { key: "tableRowPadding", col: "table_row_padding", type: "float" },
  { key: "showSummaryCards", col: "show_summary_cards", type: "bool" },
  { key: "summaryCardColor", col: "summary_card_color", type: "color" },
  { key: "defaultNotes", col: "default_notes", type: "text", max: 1000 },
  { key: "defaultTerms", col: "default_terms", type: "text", max: 1000 },
  { key: "showTerms", col: "show_terms", type: "bool" },
  { key: "signatureStyle", col: "signature_style", type: "enum", values: ["auto", "lines", "full", "none"] },
  { key: "signatureLabels", col: "signature_labels", type: "json" },
];

// The exact literal each NOT NULL column falls back to on "Reset to
// Defaults" — copied straight from the CREATE TABLE in db.js. Anything not
// listed here is a nullable column and resets to NULL (inherit brand/module
// default) instead.
const COLUMN_DEFAULTS = {
  paper_size: "'A4'", orientation: "'portrait'", margin_top: 42, margin_bottom: 42, margin_left: 42, margin_right: 42,
  font_family: "'helvetica'", header_style: "'professional'", logo_position: "'left'", logo_max_size: 30,
  show_logo: 1, show_company_name: 1, show_company_subtitle: 1, show_company_address: 1, show_company_phone: 1,
  show_company_email: 1, show_company_website: 1, show_registration_number: 0, show_tax_number: 0,
  show_doc_number: 1, show_doc_date: 1, show_footer: 1, footer_show_company_name: 1, footer_show_phone: 0,
  footer_show_email: 0, footer_show_website: 0, footer_show_generated_by: 1, footer_show_generated_date: 1,
  footer_show_page_number: 1, footer_show_signature: 1, footer_align: "'left'", table_alt_rows: 0, table_border_style: "'none'",
  table_row_padding: 0, show_summary_cards: 1, show_terms: 0, signature_style: "'auto'",
  show_signature_lines: 1, show_notes: 1, show_bill_to_address: 1, show_bill_to_contact: 1,
};
const RESET_SQL = FIELD_DEFS.map((def) => `${def.col} = ${Object.prototype.hasOwnProperty.call(COLUMN_DEFAULTS, def.col) ? COLUMN_DEFAULTS[def.col] : "NULL"}`).join(", ");

// SUPER ADMIN PROFESSIONAL PRESETS: 5 built-in starting points (spec item
// 33), each a full look — colors, font, header style, logo position, table
// styling, footer alignment — a Super Admin can select on Create and further
// customize from there. `columns` uses the same DB column names as
// FIELD_DEFS so applying one is a plain object merge.
const PRESETS = {
  modern_emerald: {
    name: "Modern Emerald", description: "Fresh emerald green, a bold modern header band, and light alternating rows.",
    columns: { color_primary: "#0f9d6e", color_secondary: "#0b3d2e", color_accent: "#0f9d6e", color_table_header: "#e3f7ef", table_header_text_color: "#0b3d2e", font_family: "helvetica", header_style: "modern", logo_position: "left", table_alt_rows: 1, table_border_style: "thin", table_border_color: "#cfe9df", footer_align: "left" },
  },
  corporate: {
    name: "Corporate", description: "Deep corporate blue with a gold accent and a Times serif face.",
    columns: { color_primary: "#0b3d91", color_secondary: "#0b3d91", color_accent: "#c9a227", color_table_header: "#e8edf7", table_header_text_color: "#0b3d91", font_family: "times", header_style: "corporate", logo_position: "left", table_alt_rows: 0, table_border_style: "thin", table_border_color: "#c7d0e6", footer_align: "center" },
  },
  minimal: {
    name: "Minimal", description: "Plain black on white, no header band, thin rules only.",
    columns: { color_primary: "#111111", color_secondary: "#111111", color_accent: "#111111", color_table_header: "#f2f2f2", table_header_text_color: "#111111", font_family: "helvetica", header_style: "minimal", logo_position: "left", table_alt_rows: 0, table_border_style: "none", footer_align: "left" },
  },
  classic_financial: {
    name: "Classic Financial", description: "Traditional maroon and gold on a serif face, centered letterhead.",
    columns: { color_primary: "#7a1f1f", color_secondary: "#3a0d0d", color_accent: "#b6862c", color_table_header: "#f4e9df", table_header_text_color: "#3a0d0d", font_family: "times", header_style: "classic", logo_position: "center", table_alt_rows: 1, table_border_style: "thin", table_border_color: "#e3d3c2", footer_align: "center" },
  },
  premium_business: {
    name: "Premium Business", description: "Near-black ink with a gold accent, right-aligned letterhead, bold table borders.",
    columns: { color_primary: "#1a1a2e", color_secondary: "#1a1a2e", color_accent: "#c9a227", color_table_header: "#efeef5", table_header_text_color: "#1a1a2e", font_family: "helvetica", header_style: "professional", logo_position: "right", table_alt_rows: 1, table_border_style: "thick", table_border_color: "#c9a227", footer_align: "right" },
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
    else if (def.type === "json") { try { out[def.key] = raw ? JSON.parse(raw) : null; } catch (e) { out[def.key] = null; } }
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
    case "json": {
      try {
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.every((s) => typeof s === "string")) throw new Error("not a list of strings");
        return { value: JSON.stringify(arr) };
      } catch (e) { return { error: `${def.key} must be a list of text labels.` }; }
    }
    default: return { value: raw };
  }
}

// ---- Preview / Test PDF sample data, one branch per document kind -------
// `real=1` pulls the single most recent genuine record of that kind instead
// of synthetic dummy data (spec item 24, "Generate Test PDF... using
// realistic system data") — falls back to the dummy branch if none exists
// yet. Preview (no `real`) always uses the dummy branch (spec item 23), so a
// brand-new install can still preview every kind before any real data exists.
async function buildPreviewPDF(kind, template, company, user, useReal) {
  const generatedBy = user.name;
  if (kind === "quotation") {
    if (useReal) {
      const q = get("SELECT * FROM quotations ORDER BY created_at DESC LIMIT 1");
      if (q) {
        const items = all("SELECT * FROM quotation_items WHERE quotation_id = ?", [q.id]);
        const totals = quotationTotals(items, q.discount_percent, q.tax_percent, null);
        return renderQuotationDocumentPDF({ quotation: q, items, totals, statusLabel: q.status, company, columns: null, template, generatedBy });
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
    return renderQuotationDocumentPDF({ quotation: dummyQuotation, items: dummyItems, totals, statusLabel: "Pending", company, columns: null, template, generatedBy });
  }
  if (kind === "account") {
    const account = { accountNumber: "ACC-0000", name: "Sample Customer Ltd.", accountType: "customer", currency: "USD", currentBalance: 1250.5, registrationDate: "2024-01-01" };
    const rows = [
      { idx: 0, date: "2026-01-01", reference: "R1", type: "Credit", notes: "Sample credit", deposit: 1000, withdrawal: null, balanceAfter: 1000, staff: generatedBy },
      { idx: 1, date: "2026-01-05", reference: "R2", type: "Debit", notes: "Sample debit", deposit: null, withdrawal: 250, balanceAfter: 1250, staff: generatedBy },
    ];
    account.currency = "USD";
    return renderAccountStatementPDF({
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
        return renderExchangeReceiptPDF({ company, tx, dailyRate: row.rate_used, saleRate: row.rate_used, canViewProfit: true, generatedBy, template });
      }
    }
    const tx = {
      referenceNumber: "EX-PREVIEW-0000", date: new Date().toISOString(), clientName: "Sample Customer Ltd.",
      currencyGiven: "USD", currencyReceived: "SLSH", amountGiven: 500, amountReceived: 5750000,
      rateUsed: 11500, profitUsd: 12.5, staffName: generatedBy, status: "completed", notes: "Sample preview transaction — no real transaction data is used.",
    };
    return renderExchangeReceiptPDF({ company, tx, dailyRate: 11500, saleRate: 11550, canViewProfit: true, generatedBy, template });
  }
  if (kind === "transaction") {
    const rows = [
      { date: "2026-01-01", reference: "EX-0001", type: "Exchange", accountName: "Sample Customer Ltd.", amountSummary: "$500.00 → SLSH 5,750,000", status: "Completed" },
      { date: "2026-01-03", reference: "DEP-0002", type: "Credit", accountName: "Sample Customer Ltd.", amountSummary: "$250.00", status: "Completed" },
    ];
    return renderTransactionStatementPDF({
      company, rows, filterSummary: "Sample preview — all transaction types, no real records used",
      totals: { totalTransactions: 2, totalDepositsLabel: "$250.00", totalWithdrawalsLabel: "$0.00", netMovementLabel: "$250.00" },
      from: null, to: null, generatedBy, template,
    });
  }
  if (kind === "deposit" || kind === "withdrawal") {
    if (useReal) {
      const row = get("SELECT l.*, c.name AS account_name, c.account_number FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE l.type = ? ORDER BY l.date DESC LIMIT 1", [kind]);
      if (row) {
        const entry = { id: row.id, type: row.type, currency: row.currency, amount: row.amount, balanceAfter: row.balance_after, notes: row.notes, staffName: row.staff_name, date: row.date, referenceNumber: row.reference_number, accountName: row.account_name, accountNumber: row.account_number };
        return renderLedgerReceiptPDF({ company, entry, generatedBy, template });
      }
    }
    const entry = {
      id: "PREVIEW", type: kind, currency: "USD", amount: 250, balanceAfter: 1250,
      notes: "Sample preview entry — no real ledger data is used.", staffName: generatedBy, date: new Date().toISOString(),
      referenceNumber: `${kind.toUpperCase()}-PREVIEW-0000`, accountName: "Sample Customer Ltd.", accountNumber: "ACC-0000",
    };
    return renderLedgerReceiptPDF({ company, entry, generatedBy, template });
  }
  if (kind === "transfer") {
    if (useReal) {
      const row = get("SELECT * FROM transfers ORDER BY date DESC LIMIT 1");
      if (row) {
        const fromAcc = get("SELECT id, name, account_number, currency FROM clients WHERE id = ?", [row.from_account_id]);
        const toAcc = get("SELECT id, name, account_number, currency FROM clients WHERE id = ?", [row.to_account_id]);
        const t = {
          id: row.id, referenceNumber: row.reference_number, date: row.date,
          fromAccount: fromAcc ? { accountNumber: fromAcc.account_number, name: fromAcc.name } : null,
          toAccount: toAcc ? { accountNumber: toAcc.account_number, name: toAcc.name } : null,
          currency: row.currency, amount: row.amount, staffName: row.staff_name, status: row.status, voidReason: row.void_reason, notes: row.notes,
        };
        return renderTransferReceiptPDF({ company, t, generatedBy, template });
      }
    }
    const t = {
      id: "PREVIEW", referenceNumber: "TRF-PREVIEW-0000", date: new Date().toISOString(),
      fromAccount: { accountNumber: "ACC-0001", name: "Sample Sender Ltd." },
      toAccount: { accountNumber: "ACC-0002", name: "Sample Receiver Ltd." },
      currency: "USD", amount: 300, staffName: generatedBy, status: "completed", notes: "Sample preview transfer — no real transfer data is used.",
    };
    return renderTransferReceiptPDF({ company, t, generatedBy, template });
  }
  // reports / global — no single "real record" makes sense for a bulk
  // report or the all-documents fallback, so this branch always uses
  // realistic sample rows regardless of `real`.
  return renderReportPDF({
    company, title: "Sample Report", meta: "Preview — sample data, no real records used", generatedBy, template,
    columns: [{ label: "Date", width: 1 }, { label: "Description", width: 2 }, { label: "Amount", width: 1, align: "right" }],
    rows: [["2026-01-01", "Sample line item", "$500.00"], ["2026-01-02", "Another sample line", "$120.00"]],
  });
}

function register(router) {
  router.get("/api/pdf-templates/kinds", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const kinds = Object.entries(KIND_LABELS).map(([key, label]) => {
      const def = get("SELECT id, name FROM pdf_templates WHERE kind = ? AND is_default = 1 AND is_archived = 0", [key]);
      const count = get("SELECT COUNT(*) as n FROM pdf_templates WHERE kind = ? AND is_archived = 0", [key]).n;
      return { key, label, defaultTemplateId: def ? def.id : null, defaultTemplateName: def ? def.name : null, templateCount: count };
    });
    sendJSON(res, 200, { kinds });
  });

  router.get("/api/pdf-templates/presets", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    sendJSON(res, 200, { presets: Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, description: p.description, swatch: p.columns.color_primary || null, accent: p.columns.color_accent || null })) });
  });

  router.get("/api/pdf-templates", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const kind = query && query.kind;
    if (!kind || !VALID_KINDS.has(kind)) return badRequest(res, "Unknown or missing template kind.");
    const includeArchived = query && (query.includeArchived === "1" || query.includeArchived === "true");
    const rows = includeArchived
      ? all("SELECT * FROM pdf_templates WHERE kind = ? ORDER BY is_default DESC, name COLLATE NOCASE", [kind])
      : all("SELECT * FROM pdf_templates WHERE kind = ? AND is_archived = 0 ORDER BY is_default DESC, name COLLATE NOCASE", [kind]);
    sendJSON(res, 200, { templates: rows.map(serialize) });
  });

  router.get("/api/pdf-templates/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    sendJSON(res, 200, { template: serialize(row) });
  });

  router.post("/api/pdf-templates", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const kind = body.kind;
    if (!kind || !VALID_KINDS.has(kind)) return badRequest(res, "Unknown or missing template kind.");
    if (!body.name || !String(body.name).trim()) return badRequest(res, "A template name is required.");
    if (String(body.name).length > 80) return badRequest(res, "Template name is too long (max 80 characters).");
    if (body.presetKey !== undefined && body.presetKey !== null && !PRESETS[body.presetKey]) return badRequest(res, "Unknown preset.");

    const seed = body.presetKey && PRESETS[body.presetKey] ? PRESETS[body.presetKey].columns : {};
    const cols = ["id", "kind", "name", "is_default", "is_archived", "is_builtin", "preset_key", "version", "created_at", "created_by", "updated_at", "updated_by"];
    const now = nowISO();
    const id = uid("tpl");
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
    run(`INSERT INTO pdf_templates (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    addAudit(user, "PDF template created", String(body.name).trim());
    sendJSON(res, 201, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [id])) });
  });

  router.patch("/api/pdf-templates/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const current = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
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
    run(`UPDATE pdf_templates SET ${setCols.join(", ")} WHERE id = ?`, vals);
    addAudit(user, "PDF template updated", body.name !== undefined ? String(body.name).trim() : current.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/pdf-templates/:id/duplicate", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const src = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!src) return notFound(res, "Template not found.");
    let body = {}; try { body = (await readJSONBody(req)) || {}; } catch (e) { /* body is optional here */ }
    const name = (body.name && String(body.name).trim()) || `${src.name} (Copy)`;
    const now = nowISO();
    const id = uid("tpl");
    const cols = ["id", "kind", "name", "is_default", "is_archived", "is_builtin", "preset_key", "version", "created_at", "created_by", "updated_at", "updated_by", ...FIELD_DEFS.map((d) => d.col)];
    const vals = [id, src.kind, name, 0, 0, 0, src.preset_key, 1, now, user.name, now, user.name, ...FIELD_DEFS.map((d) => src[d.col])];
    run(`INSERT INTO pdf_templates (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    addAudit(user, "PDF template duplicated", `${name} (from ${src.name})`);
    sendJSON(res, 201, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [id])) });
  });

  router.post("/api/pdf-templates/:id/set-default", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_archived) return badRequest(res, "An archived template can't be set as the default — restore it first.");
    if (row.is_default) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE pdf_templates SET is_default = 0 WHERE kind = ? AND is_default = 1", [row.kind]);
    run("UPDATE pdf_templates SET is_default = 1, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "PDF template set as default", `${row.name} (${KIND_LABELS[row.kind] || row.kind})`);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/pdf-templates/:id/archive", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_default) return badRequest(res, "Can't archive the default template — set a different one as default first.");
    if (row.is_archived) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE pdf_templates SET is_archived = 1, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "PDF template archived", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [params.id])) });
  });

  router.post("/api/pdf-templates/:id/restore", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (!row.is_archived) return sendJSON(res, 200, { template: serialize(row) });
    run("UPDATE pdf_templates SET is_archived = 0, updated_at = ?, updated_by = ? WHERE id = ?", [nowISO(), user.name, params.id]);
    addAudit(user, "PDF template restored", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [params.id])) });
  });

  // "Reset Template" / "Restore Default" (spec item 34): puts every
  // customizable field on this template back to the original hardcoded
  // look, in place — the template keeps its id/name/kind/default status, so
  // nothing that pointed at it needs to change, only what it looks like.
  router.post("/api/pdf-templates/:id/reset", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    run(`UPDATE pdf_templates SET ${RESET_SQL}, preset_key = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`, [nowISO(), user.name, params.id]);
    addAudit(user, "PDF template reset to defaults", row.name);
    sendJSON(res, 200, { template: serialize(get("SELECT * FROM pdf_templates WHERE id = ?", [params.id])) });
  });

  router.delete("/api/pdf-templates/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const row = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Template not found.");
    if (row.is_builtin) return badRequest(res, "The built-in default template can't be deleted.");
    if (row.is_default) return badRequest(res, "Can't delete the default template — set a different one as default first.");
    run("DELETE FROM pdf_templates WHERE id = ?", [params.id]);
    addAudit(user, "PDF template deleted", row.name);
    sendJSON(res, 200, { ok: true });
  });

  // Renders a sample document with this template's settings applied —
  // doubles as both the spec's "Preview PDF" (item 23, synthetic dummy data
  // by default) and "Generate Test PDF" (item 24, pass ?real=1 to render
  // from the single most recent genuine record of this kind instead) —
  // maintaining two near-identical dummy-data code paths for what is
  // ultimately the same rendering call would be pure duplication, so both
  // spec items share buildPreviewPDF above and are told apart by the query
  // flag alone. Not a fake HTML mockup — this is the exact PDF a real
  // document of this kind would produce.
  router.get("/api/pdf-templates/:id/preview.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "pdfTemplates.manage")) return;
    const template = get("SELECT * FROM pdf_templates WHERE id = ?", [params.id]);
    if (!template) return notFound(res, "Template not found.");
    const useReal = !!(query && (query.real === "1" || query.real === "true"));
    const pdf = await buildPreviewPDF(template.kind, template, getCompanySettings(), user, useReal);
    sendPDF(res, `pdf-template-preview-${template.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`, pdf);
  });
}

module.exports = { register, KIND_LABELS };
