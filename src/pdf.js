"use strict";
const { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } = require("pdf-lib");
const { fmtMoney, convert } = require("./util");

// LANGUAGE round: PDF labels follow the language of the request that asked
// for the document. Every label reaches the page through drawText and is
// measured through widthOfTextAtSize, so both translate the text first —
// alignment, centring and fitting then use the Somali width. Data (names,
// references, amounts) never matches the dictionary and is drawn as-is.
// A translation the standard PDF fonts cannot encode falls back to English.
const { tr: trReq, isSomali } = require("./i18n/request");
const WINANSI_EXTRA = "—–…‘’“”•€™ŠšŽžŒœŸˆ˜‚„†‡‰‹›";
function pdfSafe(original, translated) {
  for (const ch of translated) {
    if (ch.charCodeAt(0) > 255 && !WINANSI_EXTRA.includes(ch) && !String(original).includes(ch)) return original;
  }
  return translated;
}
function trPdf(text) {
  if (typeof text !== "string" || !isSomali()) return text;
  return pdfSafe(text, trReq(text));
}
if (!PDFPage.prototype.__oboI18n) {
  const origDraw = PDFPage.prototype.drawText;
  PDFPage.prototype.drawText = function (text, options) { return origDraw.call(this, trPdf(text), options); };
  const origWidth = PDFFont.prototype.widthOfTextAtSize;
  PDFFont.prototype.widthOfTextAtSize = function (text, size) { return origWidth.call(this, trPdf(text), size); };
  PDFPage.prototype.__oboI18n = true;
}

// PAYMENT & TRANSFER UPGRADE round: Payment Date can be a plain "YYYY-MM-DD"
// (no time component — see util.resolvePaymentDate) or, for older rows
// predating this round, a full ISO timestamp. Either way it's shown as a
// plain date on receipts (never a time), distinct from the Created At row
// next to it, which always does show the time.
function fmtDateOnly(s) {
  if (!s) return "—";
  return String(s).slice(0, 10);
}

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 42;

const NAVY = rgb(0x08 / 255, 0x4b / 255, 0x83 / 255);
const MINT = rgb(0xbb / 255, 0xe6 / 255, 0xe4 / 255);
const INK = rgb(0x0d / 255, 0x24 / 255, 0x36 / 255);
const SLATE = rgb(0x5b / 255, 0x74 / 255, 0x80 / 255);

// Converts a "#rrggbb" hex string (as saved in Settings) into a pdf-lib color.
// Falls back to the default brand navy for anything missing or malformed.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return NAVY;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function truncate(str, maxChars) {
  str = trPdf(String(str ?? ""));
  return str.length > maxChars ? str.slice(0, maxChars - 1) + "…" : str;
}
// PROFESSIONAL ACCOUNT REPORTS round: truncate() above (used by
// renderTablePDF/renderQuotationPDF) truncates by a fixed CHARACTER count
// regardless of the column's actual pixel width, which works there because
// those tables have few enough columns that the fixed counts happen to fit.
// renderAccountStatementPDF has up to 9 columns, several quite narrow (Type,
// Balance After, Staff), where a fixed 30-40 char budget overflows into the
// next column. fitText measures the REAL rendered width at this font/size
// and shortens with an ellipsis only as far as actually needed to fit.
function fitText(fontObj, text, maxWidthPx, size) {
  text = trPdf(String(text ?? ""));
  if (fontObj.widthOfTextAtSize(text, size) <= maxWidthPx) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + "…";
    if (fontObj.widthOfTextAtSize(candidate, size) <= maxWidthPx) lo = mid; else hi = mid - 1;
  }
  return lo === 0 ? "…" : text.slice(0, lo) + "…";
}
function companyLine2(company) {
  return [company?.address, company?.phone, company?.email].filter(Boolean).join("   ·   ");
}
// PDF TEMPLATE CONTROL round: substitutes the company.* placeholders a
// template's headerNote/footerText may contain. Deliberately scoped to
// company-level fields only for Round 1 — everything document-specific
// (quotation number, customer name, totals, ...) already has its own fixed
// place in the layout below and isn't re-offered as a free-text token here.
function applyPlaceholders(str, company) {
  if (!str) return "";
  return String(str)
    .replace(/\{\{\s*company_name\s*\}\}/gi, company?.name || "")
    .replace(/\{\{\s*company_address\s*\}\}/gi, company?.address || "")
    .replace(/\{\{\s*company_phone\s*\}\}/gi, company?.phone || "")
    .replace(/\{\{\s*company_email\s*\}\}/gi, company?.email || "")
    .replace(/\{\{\s*company_website\s*\}\}/gi, company?.website || "");
}
async function embedLogo(doc, company) {
  const dataUrl = company?.logo_data_url;
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], "base64");
    return /png/i.test(match[1]) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (e) {
    return null; // malformed image data — fall back to text-only header rather than failing the export
  }
}
function fitLogoBox(img, maxDim) {
  if (!img) return { w: 0, h: 0 };
  const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
  return { w: img.width * ratio, h: img.height * ratio };
}

/**
 * Renders a branded, paginated table report as a PDF and returns the bytes.
 * columns: [{ label, width, align? }]  rows: array of arrays of cell values (same order as columns)
 * company: the row from company_settings (name, tagline, address, phone, email, logo_data_url)
 */
async function renderTablePDF({ title, meta, columns, rows, generatedBy, company }) {
  const NAVY = hexToRgb(company?.pdf_accent_color); // shadows the module default with the company's chosen accent, if any
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await embedLogo(doc, company);
  const logoBox = fitLogoBox(logoImg, 26);
  const companyName = company?.name || "Company";
  const line2 = companyLine2(company);

  const contentW = PAGE_W - MARGIN * 2;
  const totalWeight = columns.reduce((s, c) => s + c.width, 0);
  let xOffsets = [];
  let cursor = MARGIN;
  for (const c of columns) {
    xOffsets.push(cursor);
    cursor += (c.width / totalWeight) * contentW;
  }

  let page, y;

  function drawBrandHeader() {
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: NAVY });
    const textX = logoImg ? MARGIN + 34 : MARGIN;
    if (logoImg) page.drawImage(logoImg, { x: MARGIN, y: PAGE_H - 44 + (26 - logoBox.h) / 2, width: logoBox.w, height: logoBox.h });
    page.drawText(companyName, { x: textX, y: PAGE_H - 30, size: 14, font: bold, color: NAVY });
    if (line2) page.drawText(line2, { x: textX, y: PAGE_H - 44, size: 8, font, color: SLATE });
    page.drawLine({ start: { x: MARGIN, y: PAGE_H - 52 }, end: { x: PAGE_W - MARGIN, y: PAGE_H - 52 }, thickness: 1.2, color: NAVY });
  }

  // Each column's real pixel width (not a guessed character count) — used
  // below so header labels and cell text are fitted to the actual column,
  // never a fixed character budget that overflows a narrow column into its
  // neighbor (see the bug this fixes: a fixed truncate(cell, 34) let a long
  // "Account" value bleed straight into the "Date" column next to it on a
  // table with 8 narrow columns, like Deposits & Withdrawals).
  function colWidthPx(i) {
    return (columns[i].width / totalWeight) * contentW;
  }

  function drawTableHeaderRow() {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: contentW, height: 16, color: MINT });
    columns.forEach((c, i) => {
      page.drawText(fitText(bold, c.label, colWidthPx(i) - 6, 8.5), { x: xOffsets[i] + 3, y: y, size: 8.5, font: bold, color: INK });
    });
    y -= 18;
  }

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - 68;
    drawBrandHeader();
    if (page === doc.getPages()[0]) {
      page.drawText(title, { x: MARGIN, y, size: 16, font: bold, color: INK });
      y -= 18;
      if (meta) {
        page.drawText(truncate(meta, 110), { x: MARGIN, y, size: 9, font, color: SLATE });
        y -= 16;
      }
      y -= 4;
    }
    drawTableHeaderRow();
  }

  newPage();
  for (const row of rows) {
    if (y < MARGIN + 30) newPage();
    row.forEach((cell, i) => {
      const align = columns[i].align || "left";
      const text = fitText(font, cell, colWidthPx(i) - (align === "right" ? 8 : 6), 8.5);
      let x = xOffsets[i] + 3;
      if (align === "right") {
        const w = font.widthOfTextAtSize(text, 8.5);
        x = xOffsets[i] + colWidthPx(i) - w - 5;
      }
      page.drawText(text, { x, y, size: 8.5, font, color: INK });
    });
    y -= 13;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(
      `Generated ${new Date().toLocaleString("en-GB")}${generatedBy ? " by " + generatedBy : ""} · ${companyName} Financial System · Page ${i + 1} of ${pages.length}`,
      { x: MARGIN, y: 24, size: 7, font, color: SLATE }
    );
  });

  return Buffer.from(await doc.save());
}

/**
 * Renders a single branded quotation document (letterhead, bill-to, items, totals, signature lines).
 */
async function renderQuotationPDF({ quotation, items, totals, statusLabel, company, columns, template }) {
  // PDF TEMPLATE CONTROL round: every toggle defaults to the exact
  // pre-this-round behavior when no template is passed (or a field on it is
  // NULL/undefined) — so callers that don't yet know about templates (and
  // any install upgrading into this round before anyone has edited one)
  // render byte-for-byte the same layout as before.
  const showSignatureLines = template ? !!template.show_signature_lines : true;
  const showNotes = template ? !!template.show_notes : true;
  const showBillToAddress = template ? !!template.show_bill_to_address : true;
  const showBillToContact = template ? !!template.show_bill_to_contact : true;
  const headerNote = applyPlaceholders(template?.header_note, company);
  const footerText = applyPlaceholders(template?.footer_text, company);

  const NAVY = hexToRgb(company?.pdf_accent_color); // shadows the module default with the company's chosen accent, if any
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoImg = await embedLogo(doc, company);
  const logoBox = fitLogoBox(logoImg, 30);
  const companyName = company?.name || "Company";
  const line2 = companyLine2(company);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 30;

  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: NAVY });
  const textX = logoImg ? MARGIN + 38 : MARGIN;
  if (logoImg) page.drawImage(logoImg, { x: MARGIN, y: y - logoBox.h + 12 + (30 - logoBox.h) / 2, width: logoBox.w, height: logoBox.h });
  page.drawText(companyName, { x: textX, y, size: 16, font: bold, color: NAVY });
  y -= 16;
  if (line2) page.drawText(line2, { x: textX, y, size: 8, font, color: SLATE });
  y -= 10;
  if (headerNote) { page.drawText(truncate(headerNote, 100), { x: textX, y, size: 8, font, color: SLATE }); y -= 10; }
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.4, color: NAVY });
  y -= 28;

  page.drawText(`Quotation ${quotation.number}`, { x: MARGIN, y, size: 18, font: bold, color: INK });
  const statusText = `${statusLabel}${quotation.invoiced ? " · Invoiced" : ""}`;
  const statusW = bold.widthOfTextAtSize(statusText, 10);
  page.drawRectangle({ x: PAGE_W - MARGIN - statusW - 14, y: y - 4, width: statusW + 14, height: 18, color: MINT });
  page.drawText(statusText, { x: PAGE_W - MARGIN - statusW - 7, y, size: 10, font: bold, color: NAVY });
  y -= 20;
  page.drawText(`Issued ${quotation.issue_date}   ·   Valid until ${quotation.valid_until || "—"}`, { x: MARGIN, y, size: 9, font, color: SLATE });
  y -= 26;

  page.drawText("Bill to", { x: MARGIN, y, size: 9, font: bold, color: SLATE });
  y -= 13;
  page.drawText(quotation.client_name, { x: MARGIN, y, size: 11, font: bold, color: INK });
  y -= 13;
  if (quotation.client_address && showBillToAddress) { page.drawText(quotation.client_address, { x: MARGIN, y, size: 9, font, color: SLATE }); y -= 12; }
  if (quotation.client_contact && showBillToContact) { page.drawText(quotation.client_contact, { x: MARGIN, y, size: 9, font, color: SLATE }); y -= 12; }
  y -= 14;

  const defaultCols = [
    { key: "description", label: "Description" },
    { key: "qty", label: "Qty" },
    { key: "unitPrice", label: "Unit price" },
    { key: "currency", label: "Cur." },
    { key: "subtotal", label: "Subtotal" },
  ];
  const widthFor = (key) => (key === "description" ? 4.4 : key === "qty" ? 0.8 : ["unitPrice", "subtotal"].includes(key) ? 1.5 : key === "currency" ? 0.7 : 1.6);
  const alignFor = (key) => (["qty", "unitPrice", "subtotal"].includes(key) ? "right" : "left");
  const cellValue = (it, key) => {
    if (key === "description") return it.description;
    if (key === "qty") return String(it.qty);
    if (key === "unitPrice") return fmtMoney(it.unit_price, it.currency);
    if (key === "currency") return it.currency;
    if (key === "subtotal") return fmtMoney((Number(it.qty) || 0) * (Number(it.unit_price) || 0), it.currency);
    let extra = {};
    try { extra = it.extra_fields ? JSON.parse(it.extra_fields) : {}; } catch (e) {}
    return extra[key] != null && extra[key] !== "" ? String(extra[key]) : "—";
  };
  const cols = (columns && columns.length ? columns : defaultCols).map((c) => ({ ...c, width: widthFor(c.key), align: alignFor(c.key) }));
  const contentW = PAGE_W - MARGIN * 2;
  const totalWeight = cols.reduce((s, c) => s + c.width, 0);
  let xs = [];
  let cursor = MARGIN;
  for (const c of cols) { xs.push(cursor); cursor += (c.width / totalWeight) * contentW; }

  page.drawRectangle({ x: MARGIN, y: y - 4, width: contentW, height: 16, color: MINT });
  cols.forEach((c, i) => page.drawText(c.label, { x: xs[i] + 3, y, size: 9, font: bold, color: INK }));
  y -= 18;

  for (const it of items) {
    const cells = cols.map((c) => cellValue(it, c.key));
    cells.forEach((val, i) => {
      const align = cols[i].align || "left";
      const text = truncate(val, 46);
      let x = xs[i] + 3;
      if (align === "right") {
        const w = font.widthOfTextAtSize(text, 9);
        x = xs[i] + (cols[i].width / totalWeight) * contentW - w - 5;
      }
      page.drawText(text, { x, y, size: 9, font, color: INK });
    });
    y -= 14;
  }
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.7, color: SLATE });
  y -= 18;

  const boxX = PAGE_W - MARGIN - 220;
  page.drawText("Discount", { x: boxX, y, size: 9, font, color: SLATE });
  page.drawText(`${quotation.discount_percent || 0}%`, { x: PAGE_W - MARGIN - 30, y, size: 9, font, color: INK });
  y -= 14;
  page.drawText("Tax", { x: boxX, y, size: 9, font, color: SLATE });
  page.drawText(`${quotation.tax_percent || 0}%`, { x: PAGE_W - MARGIN - 30, y, size: 9, font, color: INK });
  y -= 18;
  page.drawRectangle({ x: boxX - 10, y: y - 6, width: 240, height: 44, color: MINT });
  page.drawText("Total", { x: boxX, y: y + 14, size: 11, font: bold, color: NAVY });
  page.drawText(fmtMoney(totals.totalUSD, "USD"), { x: boxX + 60, y: y + 14, size: 11, font: bold, color: NAVY });
  page.drawText(fmtMoney(totals.totalSLSH, "SLSH"), { x: boxX + 60, y: y - 2, size: 9, font, color: NAVY });
  y -= 50;

  if (quotation.notes && showNotes) {
    page.drawText("Notes", { x: MARGIN, y, size: 9, font: bold, color: SLATE });
    y -= 12;
    page.drawText(truncate(quotation.notes, 110), { x: MARGIN, y, size: 9, font, color: INK });
    y -= 20;
  }

  y = 110;
  if (showSignatureLines) {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + 180, y }, thickness: 0.8, color: INK });
    page.drawText("Authorized signature", { x: MARGIN, y: y - 12, size: 8, font, color: SLATE });
    page.drawLine({ start: { x: PAGE_W - MARGIN - 180, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.8, color: INK });
    page.drawText("Client acceptance", { x: PAGE_W - MARGIN - 180, y: y - 12, size: 8, font, color: SLATE });
  }

  const footerLine = footerText || `Generated ${new Date().toLocaleString("en-GB")} · ${companyName} Financial System`;
  page.drawText(truncate(footerLine, 130), { x: MARGIN, y: 24, size: 7, font, color: SLATE });

  return Buffer.from(await doc.save());
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
// GLOBAL CURRENCY FORMATTING STANDARD round: `fmtMoney` (USD always
// "$10,000.00", SLSH always "SLSH 100,000,000") is already centralized —
// imported from ./util at the top of this file, the same one the rest of
// the codebase uses — so every PDF renders amounts through that single
// shared formatter rather than a second local copy. Never used for
// exchange RATES (those stay a plain "SLSH 11,700" / "1 USD = SLSH
// 11,700" figure elsewhere in this file — a rate is not a balance).

// =========================================================================
// PDF TEMPLATE & CUSTOMIZATION ENGINE (SUPER ADMIN round)
// =========================================================================
// Turns an optional pdf_templates row (any kind, resolved by the caller —
// see domain.js's getDefaultPdfTemplate — or an explicit row for a
// Preview/Test PDF) into one fully-populated style object that
// renderProfessionalDocument draws from instead of the module-level
// NAVY/MINT/INK/SLATE/PAGE_W/PAGE_H/MARGIN constants it used to hard-code.
// Every field falls back to those exact original values when the template
// is missing or a column is NULL, so a document with no active template (or
// a fresh install before anyone has touched Settings -> PDF Templates)
// renders byte-for-byte the same as before this round existed.
//
// Scope note: font choice is limited to pdf-lib's built-in Helvetica/Times/
// Courier families — embedding real Google-style fonts (Inter, Manrope,
// Roboto...) would need shipping actual .ttf files and a fontkit dependency,
// a much larger and more fragile addition than a settings-panel customizer
// warrants. These three are the "safe fallback" the spec itself asks for,
// just used as the only choices rather than a fallback for a missing one.
const PAPER_SIZES = { A4: [595.28, 841.89], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008] };
const FONT_SETS = {
  helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  times: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  courier: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold },
};

function resolveStyle(template, company) {
  const t = template || {};
  const brandDefault = hexToRgb(company?.brand_color || company?.pdf_accent_color);
  let [pw, ph] = PAPER_SIZES[t.paper_size] || PAPER_SIZES.A4;
  if (t.paper_size === "Custom" && t.page_width && t.page_height) { pw = t.page_width; ph = t.page_height; }
  if (t.orientation === "landscape" && pw < ph) { const tmp = pw; pw = ph; ph = tmp; }
  const fonts = FONT_SETS[t.font_family] || FONT_SETS.helvetica;
  const primary = t.color_primary ? hexToRgb(t.color_primary) : brandDefault;
  let signatureLabels = null;
  try { signatureLabels = t.signature_labels ? JSON.parse(t.signature_labels) : null; } catch (e) { signatureLabels = null; }
  return {
    pageW: pw, pageH: ph,
    margin: { top: t.margin_top ?? 42, bottom: t.margin_bottom ?? 42, left: t.margin_left ?? 42, right: t.margin_right ?? 42 },
    fonts,
    fontSizes: {
      title: t.font_size_title || 15,
      heading: t.font_size_heading || 12,
      body: t.font_size_body || 9,
      table: t.font_size_table || 8,
      footer: t.font_size_footer || 7,
    },
    colors: {
      primary,
      secondary: t.color_secondary ? hexToRgb(t.color_secondary) : INK,
      accent: t.color_accent ? hexToRgb(t.color_accent) : primary,
      text: t.color_text ? hexToRgb(t.color_text) : INK,
      muted: t.color_muted ? hexToRgb(t.color_muted) : SLATE,
      tableHeader: t.color_table_header ? hexToRgb(t.color_table_header) : MINT,
      tableHeaderText: t.table_header_text_color ? hexToRgb(t.table_header_text_color) : INK,
      tableBorder: t.table_border_color ? hexToRgb(t.table_border_color) : SLATE,
      background: t.color_background ? hexToRgb(t.color_background) : null,
      success: t.color_success ? hexToRgb(t.color_success) : rgb(0.18, 0.56, 0.42),
      warning: t.color_warning ? hexToRgb(t.color_warning) : rgb(0.79, 0.54, 0.18),
      danger: t.color_danger ? hexToRgb(t.color_danger) : rgb(0.74, 0.29, 0.24),
    },
    header: {
      style: t.header_style || "professional",
      logoPosition: t.logo_position || "left",
      logoMaxSize: t.logo_max_size || 30,
      showLogo: t.show_logo !== 0,
      showCompanyName: t.show_company_name !== 0,
      showSubtitle: t.show_company_subtitle !== 0,
      showAddress: t.show_company_address !== 0,
      showPhone: t.show_company_phone !== 0,
      showEmail: t.show_company_email !== 0,
      showWebsite: t.show_company_website !== 0,
      showRegistrationNumber: !!t.show_registration_number,
      showTaxNumber: !!t.show_tax_number,
      showDocNumber: t.show_doc_number !== 0,
      showDocDate: t.show_doc_date !== 0,
    },
    footer: {
      show: t.show_footer !== 0,
      showCompanyName: t.footer_show_company_name !== 0,
      showPhone: !!t.footer_show_phone,
      showEmail: !!t.footer_show_email,
      showWebsite: !!t.footer_show_website,
      showGeneratedBy: t.footer_show_generated_by !== 0,
      showGeneratedDate: t.footer_show_generated_date !== 0,
      showPageNumber: t.footer_show_page_number !== 0,
      // FOOTER SIGNATURE TOGGLE round: a Footer-tab checkbox (matching the
      // other footer_show_* toggles) that shows/hides the Signatures block
      // — the actual Prepared/Reviewed/Approved content and its style
      // (lines vs full, labels) stay owned by the separate Signatures tab;
      // this is purely an on/off gate, read where effectiveSignatures is
      // computed below.
      showSignature: t.footer_show_signature !== 0,
      customText: t.footer_custom_text || null,
      align: t.footer_align || "left",
    },
    table: {
      altRows: !!t.table_alt_rows,
      borderStyle: t.table_border_style || "none",
      rowPadding: t.table_row_padding || 0,
    },
    showSummaryCards: t.show_summary_cards !== 0,
    summaryCardColor: t.summary_card_color ? hexToRgb(t.summary_card_color) : null,
    defaultNotes: t.default_notes || null,
    defaultTerms: t.default_terms || null,
    showTerms: !!t.show_terms,
    signatureStyle: t.signature_style || "auto",
    signatureLabels,
  };
}

// =========================================================================
// PROFESSIONAL DOCUMENT ENGINE (MASTER PROMPT round)
// =========================================================================
// One shared renderer behind every "premium" document in the system —
// Account Statement, Quotation, Money Exchange Receipt, Transaction
// Statement, and any future document type. It generalizes the exact layout
// renderAccountStatementPDF pioneered (branded header, title/status,
// optional KPI summary cards, optional key-value info block, an optional
// paginated table with a totals row, optional notes, optional signatures,
// optional extra fresh-page sections, and a page-numbered footer) so every
// document shares one visual language instead of each module inventing its
// own. renderTablePDF and the original renderQuotationPDF are UNCHANGED and
// still exported/used exactly as before by whatever hasn't been migrated to
// this engine yet — this is purely additive.
//
// Brand color precedence everywhere in this engine: company.brand_color
// (the live UI theme from Brand Color Management) first, falling back to
// company.pdf_accent_color, then the module default NAVY — the same choice
// renderAccountStatementPDF made, now applied system-wide so every
// generated document actually matches whatever theme is active.
//
// cfg shape (all fields optional unless noted):
// {
//   company,                    // required: company_settings row
//   docTypeLabel,               // required: e.g. "ACCOUNT STATEMENT — USD", "QUOTATION", "MONEY EXCHANGE RECEIPT"
//   docNumber,                  // e.g. quotation number / reference — shown top-right under title
//   statusLabel, statusTone,    // optional pill badge ("PAID"/"PENDING"/...); tone: green|amber|red|slate
//   subtitleLines: [string],    // plain lines under the title (period, account/customer summary, ...)
//   summaryCards: [{label,value}], // 0-4 KPI cards
//   infoRows: [[label,value]],  // key-value block (bill-to / customer / rate details) before the table
//   table: { columns:[{key,label,width,align}], rows:[{...}], cellText(row,col,idx)=>string, totalsRow:{key:text} },
//   totalsBox: [{label,value,emph}], // boxed total (quotation-style), drawn after the table/info block
//   notes,                      // free text notes block
//   signatures: "lines" | "full" | null,  // "lines" = 2 simple sig lines (quotation-style); "full" = 3-role P/R/A block
//   extraPages: [{ heading, kvRows:[[label,value]] }], // each gets its own fresh page after the main content
//   generatedBy,
// }
const HEADER_STYLE_CONFIG = {
  minimal: { showBand: false, bandHeight: 0, showSeparator: true, sepThickness: 0.6, showSystemLine: false },
  classic: { showBand: true, bandHeight: 6, showSeparator: true, sepThickness: 1.2, showSystemLine: false },
  modern: { showBand: true, bandHeight: 10, showSeparator: false, sepThickness: 0, showSystemLine: true },
  professional: { showBand: true, bandHeight: 6, showSeparator: true, sepThickness: 1.2, showSystemLine: true },
  corporate: { showBand: true, bandHeight: 6, showSeparator: true, sepThickness: 1.2, showSystemLine: true },
};

// Mixes a color toward white by `amount` (0-1) — used for alternating table
// row shading, so it works with whatever primary/accent color a template
// picks rather than a single fixed gray.
function tint(color, amount) {
  return rgb(color.red + (1 - color.red) * amount, color.green + (1 - color.green) * amount, color.blue + (1 - color.blue) * amount);
}

async function renderProfessionalDocument(cfg) {
  const {
    company, template, docTypeLabel, docNumber, statusLabel, statusTone, subtitleLines = [],
    summaryCards = [], infoRows = [], table, totalsBox, notes, signatures, extraPages = [], generatedBy,
  } = cfg;
  const S = resolveStyle(template, company);
  const HS = HEADER_STYLE_CONFIG[S.header.style] || HEADER_STYLE_CONFIG.professional;
  const STATUS_TONE_COLOR = { green: S.colors.success, amber: S.colors.warning, red: S.colors.danger, slate: S.colors.muted };
  const effectiveSignatures = !S.footer.showSignature ? null :
    S.signatureStyle === "none" ? null :
    S.signatureStyle === "lines" ? "lines" :
    S.signatureStyle === "full" ? "full" :
    signatures; // "auto" — whatever the caller asked for
  const effectiveNotes = notes || S.defaultNotes || null;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(S.fonts.regular);
  const bold = await doc.embedFont(S.fonts.bold);
  const logoImg = S.header.showLogo ? await embedLogo(doc, company) : null;
  const logoBox = fitLogoBox(logoImg, S.header.logoMaxSize);
  const companyName = company?.name || "Company";
  const contentW = S.pageW - S.margin.left - S.margin.right;
  // Fixed vertical budget for the header block regardless of which optional
  // lines a template turns on/off, so page content always starts at the same
  // y — avoids overlap/gap bugs from letting the header's real height vary.
  const SEP_Y = S.pageH - HS.bandHeight - 54;
  const CONTENT_START_Y = SEP_Y - 16;

  let cols = [], xOffsets = [], totalWeight = 1;
  if (table) {
    cols = table.columns;
    totalWeight = cols.reduce((s, c) => s + c.width, 0);
    let cursor = S.margin.left;
    for (const c of cols) { xOffsets.push(cursor); cursor += (c.width / totalWeight) * contentW; }
  }
  const colWidthPx = (i) => (cols[i].width / totalWeight) * contentW;

  let page, y;

  function drawBrandHeader() {
    if (S.colors.background) page.drawRectangle({ x: 0, y: 0, width: S.pageW, height: S.pageH, color: S.colors.background });
    if (HS.showBand) page.drawRectangle({ x: 0, y: S.pageH - HS.bandHeight, width: S.pageW, height: HS.bandHeight, color: S.colors.primary });
    const left = S.margin.left, right = S.pageW - S.margin.right;
    const pos = S.header.logoPosition;
    const showLogo = S.header.showLogo && !!logoImg;
    let align = "left", textX = left;
    if (pos === "left") textX = showLogo ? left + 38 : left;
    if (pos === "center") align = "center";
    if (pos === "right") align = "right";
    if (showLogo) {
      let lx = left;
      if (pos === "center") lx = (S.pageW - logoBox.w) / 2;
      if (pos === "right") lx = right - logoBox.w;
      page.drawImage(logoImg, { x: lx, y: S.pageH - HS.bandHeight - 40 + (S.header.logoMaxSize - logoBox.h) / 2, width: logoBox.w, height: logoBox.h });
    }
    const drawLine = (text, ly, size, fontObj, color) => {
      if (!text) return;
      let x = textX;
      if (align !== "left") {
        const w = fontObj.widthOfTextAtSize(text, size);
        x = align === "center" ? (S.pageW - w) / 2 : right - w;
      }
      page.drawText(text, { x, y: ly, size, font: fontObj, color });
    };
    if (S.header.showCompanyName) drawLine(companyName, S.pageH - HS.bandHeight - 22, S.fontSizes.title, bold, S.colors.primary);
    if (HS.showSystemLine && S.header.showSubtitle) drawLine("Financial System", S.pageH - HS.bandHeight - 35, 8, font, S.colors.muted);
    const infoParts = [];
    if (S.header.showAddress && company?.address) infoParts.push(company.address);
    if (S.header.showPhone && company?.phone) infoParts.push(company.phone);
    if (S.header.showEmail && company?.email) infoParts.push(company.email);
    if (S.header.showWebsite && company?.website) infoParts.push(company.website);
    const infoLine = infoParts.join("   ·   ");
    if (infoLine) drawLine(infoLine, S.pageH - HS.bandHeight - 46, 8, font, S.colors.muted);
    const idLine = [
      S.header.showRegistrationNumber && company?.registration_number ? `Reg. No. ${company.registration_number}` : null,
      S.header.showTaxNumber && company?.tax_number ? `Tax No. ${company.tax_number}` : null,
    ].filter(Boolean).join("   ·   ");
    if (idLine) drawLine(idLine, SEP_Y + 4, 7, font, S.colors.muted);
    if (HS.showSeparator) page.drawLine({ start: { x: left, y: SEP_Y }, end: { x: right, y: SEP_Y }, thickness: HS.sepThickness, color: S.colors.primary });
  }

  function drawTitleBlock() {
    const right = S.pageW - S.margin.right;
    page.drawText(docTypeLabel, { x: S.margin.left, y, size: S.fontSizes.title, font: bold, color: S.colors.secondary });
    if (statusLabel) {
      const tone = STATUS_TONE_COLOR[statusTone] || STATUS_TONE_COLOR.slate;
      const w = bold.widthOfTextAtSize(statusLabel, 9);
      page.drawRectangle({ x: right - w - 16, y: y - 3, width: w + 16, height: 16, color: S.colors.tableHeader });
      page.drawText(statusLabel, { x: right - w - 8, y: y - 0, size: 9, font: bold, color: tone });
    }
    if (docNumber && S.header.showDocNumber) {
      const dnW = font.widthOfTextAtSize(docNumber, 9);
      page.drawText(docNumber, { x: right - dnW, y: y - 22, size: 9, font, color: S.colors.muted });
    }
    // The doc number sits 22pt below this line's baseline — when there are
    // no subtitle lines to push the cursor down further (e.g. the Money
    // Exchange Receipt, which has neither), a plain "y -= 18" leaves the
    // very next element (summary cards / info rows) starting only 18pt
    // down, overlapping the doc number's own 22pt offset. Guarantee at
    // least enough clearance to clear the doc number before anything else
    // is drawn.
    y -= docNumber && S.header.showDocNumber ? 26 : 18;
    if (S.header.showDocDate) {
      for (const line of subtitleLines) {
        page.drawText(truncate(line, 130), { x: S.margin.left, y, size: 8.5, font, color: S.colors.muted });
        y -= 14;
      }
    }
    y -= 2;
  }

  function drawSummaryCards() {
    if (!summaryCards.length || !S.showSummaryCards) return;
    const accent = S.summaryCardColor || S.colors.accent;
    const gap = 10;
    const cardW = (contentW - gap * (summaryCards.length - 1)) / summaryCards.length;
    const cardH = 40;
    summaryCards.forEach((c, i) => {
      const x = S.margin.left + i * (cardW + gap);
      page.drawRectangle({ x, y: y - cardH, width: cardW, height: cardH, borderColor: accent, borderWidth: 1, color: tint(accent, 0.94) });
      page.drawText(fitText(font, c.label, cardW - 16, 7.5), { x: x + 8, y: y - 15, size: 7.5, font, color: S.colors.muted });
      // A fixed character-count truncate (like truncate() elsewhere in this
      // file) doesn't account for the card's real pixel width, which cut off
      // multi-currency KPI values (e.g. a combined "$1,396,257.00 · SLSH
      // 20,000" Total Deposits figure on the Transaction Statement) well
      // before the card's actual edge. fitText measures the real rendered
      // width at this font/size, same fix already applied to the table body.
      page.drawText(fitText(bold, String(c.value ?? ""), cardW - 16, 11), { x: x + 8, y: y - 30, size: 11, font: bold, color: accent });
    });
    y -= cardH + 16;
  }

  function drawInfoRows() {
    if (!infoRows.length) return;
    for (const [label, value] of infoRows) {
      if (value === null || value === undefined || value === "") continue;
      page.drawText(label, { x: S.margin.left, y, size: S.fontSizes.body, font, color: S.colors.muted });
      page.drawText(fitText(bold, String(value), contentW - 170, S.fontSizes.body), { x: S.margin.left + 150, y, size: S.fontSizes.body, font: bold, color: S.colors.text });
      y -= 14;
    }
    y -= 8;
  }

  function drawTableHeaderRow() {
    page.drawRectangle({ x: S.margin.left, y: y - 4, width: contentW, height: 16, color: S.colors.tableHeader });
    cols.forEach((c, i) => page.drawText(fitText(bold, c.label, colWidthPx(i) - 6, S.fontSizes.table), { x: xOffsets[i] + 3, y, size: S.fontSizes.table, font: bold, color: S.colors.tableHeaderText }));
    y -= 18;
  }

  function drawRow(text, i, size, fontObj) {
    let x = xOffsets[i] + 3;
    if (cols[i].align === "right") {
      const w = fontObj.widthOfTextAtSize(text, size);
      x = xOffsets[i] + colWidthPx(i) - w - 5;
    }
    page.drawText(text, { x, y, size, font: fontObj, color: S.colors.text });
  }

  function newPage(withHeaderContent) {
    page = doc.addPage([S.pageW, S.pageH]);
    y = CONTENT_START_Y;
    drawBrandHeader();
    if (withHeaderContent) {
      drawTitleBlock();
      drawSummaryCards();
      drawInfoRows();
    }
    if (table) drawTableHeaderRow();
  }

  newPage(true);

  const rowStep = 13 + S.table.rowPadding;
  if (table) {
    table.rows.forEach((r, idx) => {
      if (y < S.margin.bottom + 40) newPage(false);
      if (S.table.altRows && idx % 2 === 1) {
        page.drawRectangle({ x: S.margin.left, y: y - 3, width: contentW, height: rowStep, color: tint(S.colors.primary, 0.95) });
      }
      cols.forEach((c, i) => {
        const raw = table.cellText(r, c.key, idx);
        const text = fitText(font, raw, colWidthPx(i) - 6, S.fontSizes.table);
        drawRow(text, i, S.fontSizes.table, font);
      });
      if (S.table.borderStyle !== "none") {
        page.drawLine({ start: { x: S.margin.left, y: y - 3 }, end: { x: S.margin.left + contentW, y: y - 3 }, thickness: S.table.borderStyle === "thick" ? 1.2 : 0.5, color: S.colors.tableBorder });
      }
      y -= rowStep;
    });
    if (table.totalsRow) {
      if (y < S.margin.bottom + 30) newPage(false);
      page.drawRectangle({ x: S.margin.left, y: y - 4, width: contentW, height: 16, color: S.colors.tableHeader });
      cols.forEach((c, i) => {
        const text = table.totalsRow[c.key];
        if (!text) return;
        drawRow(text, i, S.fontSizes.table + 0.5, bold);
      });
      y -= 26;
    } else {
      y -= 10;
    }
  }

  if (totalsBox && totalsBox.length) {
    if (y < S.margin.bottom + 30 + totalsBox.length * 14) newPage(false);
    const boxW = 240, boxX = S.pageW - S.margin.right - boxW;
    const boxH = totalsBox.length * 16 + 12;
    page.drawRectangle({ x: boxX, y: y - boxH, width: boxW, height: boxH, color: S.colors.tableHeader });
    let by = y - 14;
    for (const t of totalsBox) {
      page.drawText(t.label, { x: boxX + 10, y: by, size: t.emph ? S.fontSizes.body + 2 : S.fontSizes.body, font: t.emph ? bold : font, color: t.emph ? S.colors.accent : S.colors.muted });
      const vw = (t.emph ? bold : font).widthOfTextAtSize(t.value, t.emph ? S.fontSizes.body + 2 : S.fontSizes.body);
      page.drawText(t.value, { x: boxX + boxW - 10 - vw, y: by, size: t.emph ? S.fontSizes.body + 2 : S.fontSizes.body, font: t.emph ? bold : font, color: t.emph ? S.colors.accent : S.colors.text });
      by -= 16;
    }
    y -= boxH + 14;
  }

  if (effectiveNotes) {
    if (y < S.margin.bottom + 40) newPage(false);
    page.drawText("Notes", { x: S.margin.left, y, size: S.fontSizes.body, font: bold, color: S.colors.muted });
    y -= 12;
    page.drawText(truncate(effectiveNotes, 130), { x: S.margin.left, y, size: S.fontSizes.body, font, color: S.colors.text });
    y -= 20;
  }

  if (S.showTerms && S.defaultTerms) {
    if (y < S.margin.bottom + 40) newPage(false);
    page.drawText("Terms & Conditions", { x: S.margin.left, y, size: S.fontSizes.body, font: bold, color: S.colors.muted });
    y -= 12;
    page.drawText(truncate(S.defaultTerms, 130), { x: S.margin.left, y, size: S.fontSizes.body, font, color: S.colors.text });
    y -= 20;
  }

  if (effectiveSignatures === "lines") {
    const sigY = Math.min(y - 20, 110);
    const right = S.pageW - S.margin.right;
    const labels = S.signatureLabels && S.signatureLabels.length >= 2 ? S.signatureLabels : ["Authorized signature", "Client acceptance"];
    page.drawLine({ start: { x: S.margin.left, y: sigY }, end: { x: S.margin.left + 180, y: sigY }, thickness: 0.8, color: S.colors.text });
    page.drawText(labels[0], { x: S.margin.left, y: sigY - 12, size: 8, font, color: S.colors.muted });
    page.drawLine({ start: { x: right - 180, y: sigY }, end: { x: right, y: sigY }, thickness: 0.8, color: S.colors.text });
    page.drawText(labels[1], { x: right - 180, y: sigY - 12, size: 8, font, color: S.colors.muted });
  }

  // "ONE PAGE WHEN POSSIBLE" round: extra sections (Account Information /
  // Report Summary / etc.) used to always force a fresh page each, which
  // padded a short statement (a handful of rows) out to 3 pages even though
  // everything would easily fit on one. A section now only starts a new
  // page when it genuinely doesn't fit in the room left on the current
  // page — exactly the same "does this fit? if not, paginate" check the
  // main table and the "full" signature block below already use. Nothing
  // about a document's content, numbers, or template options changes —
  // this is purely "don't paginate unless the content requires it."
  for (const section of extraPages) {
    const visibleRows = section.kvRows.filter(([, v]) => v !== null && v !== undefined && v !== "");
    const neededHeight = 18 + visibleRows.length * 14 + 14;
    if (y - neededHeight < S.margin.bottom) {
      page = doc.addPage([S.pageW, S.pageH]);
      y = CONTENT_START_Y;
      drawBrandHeader();
    }
    page.drawText(section.heading, { x: S.margin.left, y, size: S.fontSizes.heading, font: bold, color: S.colors.accent });
    y -= 18;
    for (const [label, value] of visibleRows) {
      page.drawText(label, { x: S.margin.left, y, size: S.fontSizes.body, font, color: S.colors.muted });
      page.drawText(String(value), { x: S.margin.left + 170, y, size: S.fontSizes.body, font: bold, color: S.colors.text });
      y -= 14;
    }
    y -= 14;
  }

  if (effectiveSignatures === "full") {
    // FOOTER-STYLE SIGNATURES round: pinned near the bottom margin — the
    // same "always near the bottom, not wherever the preceding content
    // happened to end" treatment the "lines" signature style already uses
    // (see sigY above) — so a short statement doesn't leave Signatures
    // floating in the middle of an otherwise empty page; it reads like
    // part of the page's footer area instead of mid-page content. Content
    // that genuinely runs this low (the overflow case) is unaffected —
    // it still only pushes to a fresh page when there truly isn't room.
    const pinnedY = 150;
    if (y > pinnedY) y = pinnedY;
    if (y < S.margin.bottom + 80) { page = doc.addPage([S.pageW, S.pageH]); y = pinnedY; drawBrandHeader(); }
    page.drawText("SIGNATURES", { x: S.margin.left, y, size: S.fontSizes.heading, font: bold, color: S.colors.accent });
    y -= 24;
    const sigColW = contentW / 3;
    const roleLabels = S.signatureLabels && S.signatureLabels.length >= 3 ? S.signatureLabels : ["Prepared By", "Reviewed By", "Approved By"];
    const sigs = [
      { role: roleLabels[0], name: generatedBy || "", date: new Date().toLocaleDateString("en-GB") },
      { role: roleLabels[1], name: "", date: "" },
      { role: roleLabels[2], name: "", date: "" },
    ];
    sigs.forEach((s, i) => {
      const x = S.margin.left + i * sigColW;
      page.drawText(s.role, { x, y, size: 8.5, font: bold, color: S.colors.muted });
      page.drawText(s.name ? `Name: ${s.name}` : "Name: ___________________", { x, y: y - 14, size: 8.5, font, color: S.colors.text });
      page.drawText(s.date ? `Date: ${s.date}` : "Date: ___________________", { x, y: y - 27, size: 8.5, font, color: S.colors.text });
      page.drawLine({ start: { x, y: y - 42 }, end: { x: x + sigColW - 20, y: y - 42 }, thickness: 0.8, color: S.colors.text });
      page.drawText("Signature", { x, y: y - 52, size: 7.5, font, color: S.colors.muted });
    });
  }

  if (S.footer.show) {
    const pages = doc.getPages();
    pages.forEach((p, i) => {
      let line;
      if (S.footer.customText) {
        line = applyPlaceholders(S.footer.customText, company)
          .replace(/\{\{\s*page\s*\}\}/gi, String(i + 1))
          .replace(/\{\{\s*pages\s*\}\}/gi, String(pages.length));
      } else {
        const lead = [];
        if (S.footer.showGeneratedDate) lead.push(`Generated ${new Date().toLocaleString("en-GB")}`);
        if (S.footer.showGeneratedBy && generatedBy) lead.push(`by ${generatedBy}`);
        const tail = [];
        if (S.footer.showCompanyName) tail.push(`${companyName} Financial System`);
        if (S.footer.showPhone && company?.phone) tail.push(company.phone);
        if (S.footer.showEmail && company?.email) tail.push(company.email);
        if (S.footer.showWebsite && company?.website) tail.push(company.website);
        if (S.footer.showPageNumber) tail.push(`Page ${i + 1} of ${pages.length}`);
        line = [lead.join(" "), ...tail].filter(Boolean).join(" · ");
      }
      const size = S.fontSizes.footer;
      const text = truncate(line, 160);
      let x = S.margin.left;
      if (S.footer.align !== "left") {
        const w = font.widthOfTextAtSize(text, size);
        x = S.footer.align === "center" ? (S.pageW - w) / 2 : S.pageW - S.margin.right - w;
      }
      p.drawText(text, { x, y: 24, size, font, color: S.colors.muted });
    });
  }

  return Buffer.from(await doc.save());
}

// ---- Account Statement — now a thin wrapper around the shared engine ----
// (identical fields/behavior as before; columnOrder/summary/rows semantics
// are unchanged, only the drawing now goes through renderProfessionalDocument)
async function renderAccountStatementPDF({ company, account, rows, summary, columnOrder, from, to, generatedBy, template }) {
  const currency = account.currency;
  const STATEMENT_COLUMN_LABELS = { notes: "Description / Notes", deposit: "Credit", withdrawal: "Debit", balanceAfter: "Balance After", staff: "Staff" };
  const tailCols = (columnOrder || [])
    .filter((k) => STATEMENT_COLUMN_LABELS[k])
    .map((k) => ({ key: k, label: STATEMENT_COLUMN_LABELS[k], width: k === "notes" ? 2.2 : k === "staff" ? 1 : 1.1, align: ["deposit", "withdrawal", "balanceAfter"].includes(k) ? "right" : "left" }));
  const columns = [
    { key: "idx", label: "#", width: 0.4 },
    { key: "date", label: "Date", width: 1.1 },
    { key: "reference", label: "Reference", width: 1.1 },
    { key: "type", label: "Type", width: 0.9 },
    ...tailCols,
  ];
  const periodText = from || to ? `Period: ${from || "start"} to ${to || "today"}` : "Period: All time";
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: `ACCOUNT STATEMENT — ${currency}`,
    subtitleLines: [
      `${periodText}   ·   Generated ${new Date().toLocaleString("en-GB")} by ${generatedBy || "—"}`,
      `Account #${account.accountNumber}   ·   ${account.name}   ·   ${account.accountType === "company" ? "Company" : "Customer"} account   ·   ${currency}`,
    ],
    // GLOBAL "LAST BALANCE AT THE BOTTOM" round: the balance summary no
    // longer sits in a top KPI card — it's a totalsBox (see
    // renderProfessionalDocument) drawn AFTER the transaction table, with
    // "Last Balance" as the final, visually-emphasized row. Opening
    // Balance / Total Deposits / Total Withdrawals move down alongside it
    // (same figures, same math — layout only). The table's own TOTAL row
    // still carries the real per-column sums (Deposit/Withdrawal); it no
    // longer repeats the closing balance in the Balance After cell, since
    // that figure now has its own clear, dedicated row below.
    table: {
      columns, rows,
      cellText: (r, key, idx) => {
        if (key === "idx") return String(idx + 1);
        if (key === "deposit") return r.deposit != null ? fmtMoney(r.deposit, currency) : "";
        if (key === "withdrawal") return r.withdrawal != null ? fmtMoney(r.withdrawal, currency) : "";
        if (key === "balanceAfter") return fmtMoney(r.balanceAfter, currency);
        if (key === "date") return String(r.date).slice(0, 10);
        return r[key] != null ? String(r[key]) : "—";
      },
      totalsRow: {
        date: "TOTAL",
        deposit: fmtMoney(summary.totalDeposits, currency),
        withdrawal: fmtMoney(summary.totalWithdrawals, currency),
      },
    },
    // "SIGNATURES ON PAGE 1" round: Account Information and Report Summary
    // were their own extraPages sections (forced/likely-forced extra
    // pages) — removed per explicit request, nothing in them wasn't
    // already shown elsewhere (account identity is in the subtitle line
    // above the table; every figure in Report Summary already appears in
    // totalsBox/the table's own TOTAL row). With extraPages gone,
    // Signatures now simply follows totalsBox directly, landing on page 1
    // whenever the content fits there (same page-if-it-fits behavior as
    // before, just with nothing left to force pages 2/3 first).
    totalsBox: [
      { label: "Opening Balance", value: fmtMoney(summary.openingBalance, currency) },
      { label: "Total Credits", value: fmtMoney(summary.totalDeposits, currency) },
      { label: "Total Debits", value: fmtMoney(summary.totalWithdrawals, currency) },
      { label: "Last Balance", value: fmtMoney(summary.closingBalance, currency), emph: true },
    ],
    signatures: "full",
  });
}

// ---- Quotation — premium invoice-style document via the shared engine ----
// Same fields/behavior as the pre-existing renderQuotationPDF (template
// toggles, item table, totals box, notes, signature lines), now sharing the
// exact same header/footer/brand styling as every other document instead of
// its own bespoke drawing code. The original renderQuotationPDF is left
// untouched below for anything not yet migrated.
async function renderQuotationDocumentPDF({ quotation, items, totals, statusLabel, company, columns, template, generatedBy, payment, payments }) {
  const showSignatureLines = template ? !!template.show_signature_lines : true;
  const showNotes = template ? !!template.show_notes : true;
  const showBillToAddress = template ? !!template.show_bill_to_address : true;
  const showBillToContact = template ? !!template.show_bill_to_contact : true;
  const headerNote = applyPlaceholders(template?.header_note, company);
  const footerText = applyPlaceholders(template?.footer_text, company);

  // CURRENCY-AWARE RENDERING (spec section 16): currency_mode drives which
  // columns/totals appear, but never which engine renders them — this still
  // goes through the exact same shared renderProfessionalDocument used by
  // every other document type, per the "use the EXISTING PDF TEMPLATE
  // SYSTEM, do NOT create a separate design" requirement.
  const mode = quotation.currency_mode === "SLSH" || quotation.currency_mode === "BOTH" ? quotation.currency_mode : "USD";
  const rate = Number(quotation.rate_used) || 0;

  const defaultCols =
    mode === "BOTH"
      ? [
          { key: "description", label: "Description" },
          { key: "qty", label: "Qty" },
          { key: "unitPrice", label: "Unit price" },
          { key: "currency", label: "Cur." },
          { key: "totalUSD", label: "Total (USD)" },
          { key: "totalSLSH", label: "Total (SLSH)" },
        ]
      : [
          { key: "description", label: "Description" },
          { key: "qty", label: "Qty" },
          { key: "unitPrice", label: `Unit price (${mode})` },
          { key: "subtotal", label: `Total (${mode})` },
        ];
  const widthFor = (key) => (key === "description" ? 4.4 : key === "qty" ? 0.8 : ["unitPrice", "subtotal", "totalUSD", "totalSLSH"].includes(key) ? 1.4 : key === "currency" ? 0.7 : 1.6);
  const alignFor = (key) => (["qty", "unitPrice", "subtotal", "totalUSD", "totalSLSH"].includes(key) ? "right" : "left");
  const lineSubtotal = (it) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
  const cellValue = (it, key) => {
    if (key === "description") return it.description;
    if (key === "qty") return String(it.qty);
    if (key === "unitPrice") return fmtMoney(it.unit_price, it.currency);
    if (key === "currency") return it.currency;
    if (key === "subtotal") return fmtMoney(lineSubtotal(it), it.currency);
    if (key === "totalUSD") return fmtMoney(rate ? convert(lineSubtotal(it), it.currency, "USD", rate) : (it.currency === "USD" ? lineSubtotal(it) : 0), "USD");
    if (key === "totalSLSH") return fmtMoney(rate ? convert(lineSubtotal(it), it.currency, "SLSH", rate) : (it.currency === "SLSH" ? lineSubtotal(it) : 0), "SLSH");
    let extra = {};
    try { extra = it.extra_fields ? JSON.parse(it.extra_fields) : {}; } catch (e) {}
    return extra[key] != null && extra[key] !== "" ? String(extra[key]) : "—";
  };
  const cols = (columns && columns.length ? columns : defaultCols).map((c) => ({ ...c, width: widthFor(c.key), align: alignFor(c.key) }));

  const infoRows = [["Bill to", quotation.client_name]];
  if (quotation.client_address && showBillToAddress) infoRows.push(["Address", quotation.client_address]);
  if (quotation.client_contact && showBillToContact) infoRows.push(["Contact", quotation.client_contact]);
  infoRows.push(["Currency", mode]);
  // Exchange Rate is only shown when the document mode actually needs a
  // conversion (BOTH) — a USD-only or SLSH-only quotation never displays a
  // rate line, since one was never required to produce its total (spec
  // items 3/11/19; see util.js's convert(), which is a no-op when
  // from === to).
  if (mode === "BOTH" && rate) infoRows.push(["Exchange Rate", `1 USD = SLSH ${fmtNum(rate)}`]);

  // Never combine USD + SLSH into a single figure (spec item 10) — each
  // mode shows only the total(s) that are actually meaningful for it.
  const totalsBox = [
    { label: "Discount", value: `${quotation.discount_percent || 0}%` },
    { label: "Tax", value: `${quotation.tax_percent || 0}%` },
  ];
  if (mode === "USD" || mode === "BOTH") totalsBox.push({ label: "Total (USD)", value: fmtMoney(totals.totalUSD, "USD"), emph: mode === "USD" });
  if (mode === "SLSH" || mode === "BOTH") totalsBox.push({ label: "Total (SLSH)", value: fmtMoney(totals.totalSLSH, "SLSH"), emph: mode === "SLSH" });

  // PARTIAL PAYMENT UPGRADE round (spec section 15): the existing quotation
  // PDF template now also surfaces Original/Paid/Remaining/Status — computed
  // by the SAME quotationPaymentSummary() the API, table, and Excel export
  // all read from, so this can never disagree with what's shown on screen —
  // plus a Payment History page listing every individual payment ever
  // recorded (never just the current totals), extending the EXISTING
  // renderProfessionalDocument engine rather than a new/separate design.
  const currency = quotation.charged_currency || (mode === "SLSH" ? "SLSH" : "USD");
  const paymentSummaryCards = payment
    ? [
        { label: "Original Amount", value: fmtMoney(payment.originalAmount, currency) },
        { label: "Total Paid", value: fmtMoney(payment.totalPaid, currency) },
        { label: "Remaining", value: fmtMoney(payment.remaining, currency) },
        { label: "Status", value: (payment.computedStatus || quotation.status || "").toUpperCase() },
      ]
    : [];
  const extraPages = [];
  if (payments && payments.length) {
    extraPages.push({
      heading: "PAYMENT HISTORY",
      kvRows: payments.map((p, i) => [
        `Payment #${i + 1} — ${String(p.date).slice(0, 10)}`,
        `${fmtMoney(p.amount, p.currency)} · ${p.method || "—"} · Staff: ${p.staffName || "—"} · Ref: ${p.reference || p.externalReference || "—"}`,
      ]),
    });
  }

  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: "QUOTATION",
    docNumber: quotation.number,
    statusLabel: `${(statusLabel || quotation.status || "").toUpperCase()}${quotation.invoiced ? " · INVOICED" : ""}`,
    statusTone: quotation.status === "Paid" ? "green" : quotation.status === "Refunded" ? "slate" : quotation.status === "Partially Paid" ? "amber" : "amber",
    subtitleLines: [
      headerNote,
      `Issued ${quotation.issue_date}   ·   Valid until ${quotation.valid_until || "—"}`,
    ].filter(Boolean),
    infoRows,
    summaryCards: paymentSummaryCards,
    table: { columns: cols, rows: items, cellText: (it, key) => truncate(cellValue(it, key), 46) },
    totalsBox,
    notes: showNotes ? quotation.notes : null,
    signatures: showSignatureLines ? "lines" : null,
    extraPages,
  });
}

// ---- Money Exchange Receipt — single-transaction receipt via the shared engine ----
// New document type (spec item 28): no item table, just a clean summary of
// the one exchange (amount given/received, daily/sale/applied rate, profit)
// plus a small key-value block for reference/date/customer/staff/notes.
async function renderExchangeReceiptPDF({ company, tx, dailyRate, saleRate, canViewProfit, generatedBy, template }) {
  const infoRows = [
    ["Reference", tx.referenceNumber || tx.id],
    ["Date", String(tx.date).slice(0, 19).replace("T", " ")],
    ["Customer", tx.clientName],
    ["From currency", tx.currencyGiven],
    ["To currency", tx.currencyReceived],
    ["Daily rate", dailyRate ? `SLSH ${fmtNum(dailyRate)}` : "—"],
    ["Sale rate", saleRate ? `SLSH ${fmtNum(saleRate)}` : "—"],
    ["Staff", tx.staffName],
  ];
  const summaryCards = [
    { label: "Amount Given", value: fmtMoney(tx.amountGiven, tx.currencyGiven) },
    { label: "Amount Received", value: fmtMoney(tx.amountReceived, tx.currencyReceived) },
    { label: "Applied Rate", value: `SLSH ${fmtNum(tx.rateUsed)}` },
  ];
  if (canViewProfit) summaryCards.push({ label: "Exchange Profit", value: fmtMoney(tx.profitUsd, "USD") });
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: "MONEY EXCHANGE RECEIPT",
    docNumber: tx.referenceNumber || `EX-${tx.id}`,
    statusLabel: tx.status === "voided" ? "VOIDED" : "COMPLETED",
    statusTone: tx.status === "voided" ? "red" : "green",
    summaryCards,
    infoRows,
    notes: tx.status === "voided" ? (tx.voidReason || tx.notes) : tx.notes,
    signatures: "lines",
  });
}

// ---- Transaction Statement — filtered multi-type list via the shared engine ----
// Spec item 29: a "Transaction Statement" over a filtered set of history
// rows (deposits/withdrawals/exchanges/transfers/quotation events), the same
// combined shape queryHistory() in routes/history.js already produces. This
// mirrors Account Statement's table+totals+report-summary shape, but the
// "subject" is the filter criteria rather than one account.
async function renderTransactionStatementPDF({ company, rows, filterSummary, totals, from, to, generatedBy, template }) {
  const columns = [
    { key: "idx", label: "#", width: 0.4 },
    { key: "date", label: "Date", width: 1 },
    { key: "reference", label: "Reference", width: 1 },
    { key: "type", label: "Type", width: 1.1 },
    { key: "account", label: "Account", width: 1.3 },
    { key: "amount", label: "Amount", width: 1, align: "right" },
    { key: "status", label: "Status", width: 0.8 },
  ];
  const periodText = from || to ? `Period: ${from || "start"} to ${to || "today"}` : "Period: All time";
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: "TRANSACTION STATEMENT",
    subtitleLines: [
      `${periodText}   ·   Generated ${new Date().toLocaleString("en-GB")} by ${generatedBy || "—"}`,
      filterSummary || "All transaction types",
    ],
    summaryCards: [
      { label: "Total Transactions", value: String(totals.totalTransactions) },
      { label: "Total Credits", value: totals.totalDepositsLabel },
      { label: "Total Debits", value: totals.totalWithdrawalsLabel },
      { label: "Net Movement", value: totals.netMovementLabel },
    ],
    table: {
      columns, rows,
      cellText: (r, key, idx) => {
        if (key === "idx") return String(idx + 1);
        if (key === "date") return String(r.date).slice(0, 10);
        if (key === "account") return r.accountName || "—";
        if (key === "amount") return r.amountSummary || "—";
        return r[key] != null ? String(r[key]) : "—";
      },
    },
    extraPages: [
      {
        heading: "REPORT SUMMARY",
        kvRows: [
          ["Total Transactions", String(totals.totalTransactions)],
          ["Total Credits", totals.totalDepositsLabel],
          ["Total Debits", totals.totalWithdrawalsLabel],
          ["Net Movement", totals.netMovementLabel],
        ],
      },
    ],
    signatures: "full",
  });
}

// ---- Deposit / Withdrawal Receipt — single ledger-entry receipt via the shared engine ----
// New document type: previously a deposit/withdrawal only ever appeared as
// one row in the bulk "Deposits & Withdrawals" list export (renderTablePDF,
// unchanged) — there was no single-record receipt at all. `entry` is one row
// from account_ledger joined to its account (the shape queryLedger() in
// routes/ledger.js already produces).
async function renderLedgerReceiptPDF({ company, entry, generatedBy, template }) {
  const isDeposit = entry.type === "deposit";
  const infoRows = [
    ["Account #", entry.accountNumber],
    ["Account", entry.accountName],
    // PAYMENT & TRANSFER UPGRADE round: Payment Date (the editable accounting
    // date) and Created At (the real, permanent system timestamp) are shown
    // as two distinct rows — financial auditing needs both visible together.
    ["Payment Date", fmtDateOnly(entry.date)],
    ["Created At", entry.createdAt ? String(entry.createdAt).slice(0, 19).replace("T", " ") : "—"],
    ["Staff", entry.staffName],
  ];
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: isDeposit ? "CREDIT RECEIPT" : "DEBIT RECEIPT",
    docNumber: entry.referenceNumber || `LED-${entry.id}`,
    statusLabel: "COMPLETED",
    statusTone: "green",
    summaryCards: [
      { label: isDeposit ? "Amount Credited" : "Amount Debited", value: fmtMoney(entry.amount, entry.currency) },
      { label: "Balance After", value: fmtMoney(entry.balanceAfter, entry.currency) },
    ],
    infoRows,
    notes: entry.notes,
    signatures: "lines",
  });
}

// ---- Transfer Receipt — single account-to-account transfer via the shared engine ----
// New document type: Transfers previously had zero export/PDF capability at
// all. `t` is the rowToJSON() shape from routes/transfers.js.
async function renderTransferReceiptPDF({ company, t, generatedBy, template }) {
  const infoRows = [
    ["Transfer ID", t.referenceNumber || t.id],
    ["Payment Date", fmtDateOnly(t.date)],
    ["Created At", t.createdAt ? String(t.createdAt).slice(0, 19).replace("T", " ") : "—"],
    ["From account", t.fromAccount ? `${t.fromAccount.accountNumber} — ${t.fromAccount.name}` : "—"],
    ["To account", t.toAccount ? `${t.toAccount.accountNumber} — ${t.toAccount.name}` : "—"],
    ["Reference", t.reference || "—"],
    ["Staff", t.staffName],
  ];
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: "TRANSFER RECEIPT",
    docNumber: t.referenceNumber || `TRF-${t.id}`,
    statusLabel: t.status === "voided" ? "VOIDED" : "COMPLETED",
    statusTone: t.status === "voided" ? "red" : "green",
    summaryCards: [{ label: "Amount Transferred", value: fmtMoney(t.amount, t.currency) }],
    infoRows,
    notes: t.status === "voided" ? (t.voidReason || t.notes) : t.notes,
    signatures: "lines",
  });
}

// ---- Generic Report — any of the Reports module's tabular reports via the shared engine ----
// Keeps the exact same columns/rows every report already computes (Exchange
// Summary, Currency Position, Staff Activity, Audit Log) but draws them
// through the branded, template-customizable engine instead of the plain
// renderTablePDF, so the "reports" kind's active PDF Template actually
// applies to them. renderTablePDF itself is untouched and still used
// elsewhere (bulk list exports that aren't a per-kind "document").
// totalsRow (optional): { <column index>: text } — drawn as a bold, shaded
// TOTAL line under the table (e.g. { 1: "TOTAL BALANCE", 3: "$1,234.00" }).
async function renderReportPDF({ company, title, meta, columns, rows, generatedBy, template, totalsRow }) {
  const cols = columns.map((c, i) => ({ key: `c${i}`, label: c.label, width: c.width, align: c.align }));
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: title.toUpperCase(),
    subtitleLines: [meta || ""].filter(Boolean),
    table: {
      columns: cols, rows,
      totalsRow: totalsRow ? Object.fromEntries(Object.entries(totalsRow).map(([i, v]) => [`c${i}`, v])) : undefined,
      cellText: (r, key) => {
        const i = Number(key.slice(1));
        return r[i] != null ? String(r[i]) : "—";
      },
    },
  });
}

// CASH ACCOUNT VIEW round: the Cash Account Statement PDF — same shared
// renderProfessionalDocument engine as renderAccountStatementPDF just above,
// with a fixed (non-customizable) column set per the spec's exact Cash
// Movements table shape: #, Date & Time, Type, Description, Deposit,
// Withdrawal, Balance After, Reference, Staff. Totally additive — nothing
// about renderAccountStatementPDF or any other document changes.
const CASH_MOVEMENT_TYPE_LABEL = {
  cash_transfer: "Transfer", cash_exchange: "Exchange", exchange: "Exchange",
  loan: "Loan", loan_repayment: "Loan", customer_payment: "Payment", opening_balance: "Opening Balance",
  // COMPANY EXPENSES round.
  expense: "Expense", expense_reversal: "Expense Reversal",
};
function cashMovementTypeLabel(row) {
  if (row.sourceType && CASH_MOVEMENT_TYPE_LABEL[row.sourceType]) return CASH_MOVEMENT_TYPE_LABEL[row.sourceType];
  return row.type === "deposit" ? "Credit" : "Debit";
}
async function renderCashAccountStatementPDF({ company, account, rows, summary, from, to, generatedBy, template }) {
  const currency = account.currency;
  const columns = [
    { key: "idx", label: "#", width: 0.4 },
    { key: "date", label: "Date & Time", width: 1.3 },
    { key: "type", label: "Type", width: 0.9 },
    { key: "description", label: "Description", width: 2.1, align: "left" },
    { key: "deposit", label: "Credit", width: 1, align: "right" },
    { key: "withdrawal", label: "Debit", width: 1, align: "right" },
    { key: "balanceAfter", label: "Balance After", width: 1.1, align: "right" },
    { key: "reference", label: "Reference", width: 1 },
    { key: "staff", label: "Staff", width: 0.9 },
  ];
  const periodText = from || to ? `Period: ${from || "start"} to ${to || "today"}` : "Period: All time";
  return renderProfessionalDocument({
    company, generatedBy, template,
    docTypeLabel: `CASH ACCOUNT STATEMENT — ${currency}`,
    subtitleLines: [
      `${periodText}   ·   Generated ${new Date().toLocaleString("en-GB")} by ${generatedBy || "—"}`,
      `${account.name}   ·   ${account.type}   ·   ${currency}   ·   ${account.status === "active" ? "Active" : "Deactivated"}`,
    ],
    // GLOBAL "LAST BALANCE AT THE BOTTOM" round — see renderAccountStatementPDF's
    // matching comment: the balance summary moved out of the top KPI cards
    // into a totalsBox drawn after the table, "Last Balance" emphasized as
    // the final row. Same figures, same math — layout only.
    table: {
      columns, rows,
      cellText: (r, key, idx) => {
        if (key === "idx") return String(idx + 1);
        if (key === "deposit") return r.deposit != null ? fmtMoney(r.deposit, currency) : "—";
        if (key === "withdrawal") return r.withdrawal != null ? fmtMoney(r.withdrawal, currency) : "—";
        if (key === "balanceAfter") return fmtMoney(r.balanceAfter, currency);
        if (key === "type") return cashMovementTypeLabel(r);
        if (key === "date") return `${fmtDateOnly(r.date)}${String(r.date).length > 10 ? " " + new Date(r.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""}`;
        return r[key] != null ? String(r[key]) : "—";
      },
      totalsRow: {
        date: "TOTAL",
        deposit: fmtMoney(summary.totalDeposits, currency),
        withdrawal: fmtMoney(summary.totalWithdrawals, currency),
      },
    },
    // "SIGNATURES ON PAGE 1" round — see renderAccountStatementPDF's matching
    // comment: Cash Account Information and Report Summary extraPages
    // sections removed per explicit request (the account identity line is
    // already in the subtitle, every figure here already appears in
    // totalsBox/the table's TOTAL row); Signatures now follows totalsBox
    // directly, landing on page 1 whenever the content fits there.
    totalsBox: [
      { label: "Opening Balance", value: fmtMoney(summary.openingBalance, currency) },
      { label: "Total Credits", value: fmtMoney(summary.totalDeposits, currency) },
      { label: "Total Debits", value: fmtMoney(summary.totalWithdrawals, currency) },
      { label: "Total Exchanges", value: fmtMoney(summary.totalExchanges, currency) },
      { label: "Total Transfers", value: fmtMoney(summary.totalTransfers, currency) },
      { label: "Last Balance", value: fmtMoney(summary.closingBalance, currency), emph: true },
    ],
    signatures: "full",
  });
}

module.exports = {
  renderTablePDF, renderQuotationPDF, renderAccountStatementPDF,
  renderProfessionalDocument, renderQuotationDocumentPDF, renderExchangeReceiptPDF, renderTransactionStatementPDF,
  renderLedgerReceiptPDF, renderTransferReceiptPDF, renderReportPDF, renderCashAccountStatementPDF,
};
