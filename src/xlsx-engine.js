"use strict";
// MASTER PROMPT — shared "Professional Document Engine" Excel counterpart of
// pdf.js's renderProfessionalDocument. One config-driven builder used by every
// module's .xlsx export so all documents share the same premium branded
// layout, and — per the explicit spec rule — ONE SHEET ONLY per document
// (this supersedes the earlier 4-sheet Account Statement workbook design).
//
// EXCEL TEMPLATE & CUSTOMIZATION ENGINE round: this file now also resolves
// an optional `excel_templates` row (see src/routes/excelTemplates.js) into
// a concrete style — colors, fonts, table theme, header/footer toggles,
// date format, and print setup — exactly the same "template row -> resolved
// style -> apply while rendering" shape pdf.js's resolveStyle() already
// uses for PDFs. A missing/null template resolves to the identical
// hardcoded look this engine always had, so nothing changes until a Super
// Admin actually customizes or assigns a template.
//
// The workbook produced here is a genuinely editable Excel file: a real
// Excel Table (ListObject) with AutoFilter + frozen header, real SUM/formula
// cells for totals/KPIs (never a hardcoded duplicate number), proper number
// formats, sensible column widths, a native Excel print footer, and print
// setup — never a flattened image/screenshot.
const ExcelJS = require("exceljs");

function colLetter(i) {
  // Documents built through this engine never have anywhere near 26 columns,
  // so a single-letter mapping is sufficient.
  return String.fromCharCode(65 + i);
}

// EXPORT CORRUPTION FIX (root cause): an Excel Table's column names must each
// be non-empty AND unique within the table — exceljs's own Table.validate()
// only checks that a name is truthy, it does NOT check uniqueness, so a
// caller-supplied column list with a blank or duplicate `label` (e.g. from a
// user-customized column picker passed through as a query-string param —
// see routes/quotations.js's `?columns=`) silently produces an invalid
// /xl/tables/table1.xml. Microsoft Excel "fixes" that on open by stripping
// the Table — and since this engine's AutoFilter lives on the Table itself,
// AutoFilter goes with it — producing exactly the "Removed Feature: Table /
// AutoFilter" repair warning. Sanitizing every column list here, once, in
// the shared engine (rather than patching each caller) closes this for good
// regardless of what calls buildProfessionalWorkbook.
function sanitizeTableColumns(cols) {
  const seenKeys = new Set();
  const seenLabels = new Set();
  return (cols || []).map((c, i) => {
    let key = c && c.key != null && String(c.key).trim() ? String(c.key).trim() : `col${i + 1}`;
    while (seenKeys.has(key)) key = `${key}_${i + 1}`;
    seenKeys.add(key);
    let label = c && c.label != null && String(c.label).trim() ? String(c.label).trim() : `Column ${i + 1}`;
    while (seenLabels.has(label)) label = `${label} (${i + 1})`;
    seenLabels.add(label);
    return { ...c, key, label };
  });
}

function brandArgbOf(company) {
  const preferredHex = company?.brand_color || company?.pdf_accent_color;
  const brandHex = /^#[0-9a-fA-F]{6}$/.test(preferredHex || "") ? preferredHex : "#084b83";
  return `FF${brandHex.slice(1).toUpperCase()}`;
}

function hexToArgb(hex, fallbackArgb) {
  return /^#[0-9a-fA-F]{6}$/.test(hex || "") ? `FF${hex.slice(1).toUpperCase()}` : fallbackArgb;
}

// Same {{company_*}} placeholder substitution pdf.js's applyPlaceholders
// offers for its own header/footer text fields — kept in sync so a Super
// Admin sees identical placeholder support (and the identical hint in the
// settings UI) on both the PDF and Excel Template editors.
function applyPlaceholders(str, company) {
  if (!str) return "";
  return String(str)
    .replace(/\{\{\s*company_name\s*\}\}/gi, company?.name || "")
    .replace(/\{\{\s*company_address\s*\}\}/gi, company?.address || "")
    .replace(/\{\{\s*company_phone\s*\}\}/gi, company?.phone || "")
    .replace(/\{\{\s*company_email\s*\}\}/gi, company?.email || "")
    .replace(/\{\{\s*company_website\s*\}\}/gi, company?.website || "");
}

// Excel Table built-in style names behind each friendly `table_theme` value
// a Super Admin picks in Settings -> Excel Templates. 'none' still uses a
// real ListObject (so filtering/totals keep working) just without a themed
// banding style layered on top.
const TABLE_THEMES = {
  medium_blue: "TableStyleMedium9",
  medium_green: "TableStyleMedium7",
  medium_gray: "TableStyleMedium15",
  medium_gold: "TableStyleMedium24",
  dark_navy: "TableStyleDark11",
  light: "TableStyleLight9",
  none: "TableStyleLight1",
};

// resolveExcelStyle(template, company) — the Excel counterpart of pdf.js's
// resolveStyle(). `template` is a raw excel_templates row (or null/undefined,
// which resolves to exactly this engine's original hardcoded defaults).
function resolveExcelStyle(template, company) {
  const t = template || {};
  const brandArgb = brandArgbOf(company);
  const primaryArgb = t.color_primary ? hexToArgb(t.color_primary, brandArgb) : brandArgb;
  return {
    colors: {
      primary: primaryArgb,
      secondary: hexToArgb(t.color_secondary, "FF5B7480"),
      accent: hexToArgb(t.color_accent, primaryArgb),
      text: hexToArgb(t.color_text, "FF1A1A1A"),
      muted: hexToArgb(t.color_muted, "FF5B7480"),
      tableHeader: t.color_table_header || null,
      tableHeaderText: t.table_header_text_color || null,
    },
    font: {
      family: t.font_family || "Calibri",
      sizeTitle: t.font_size_title || 16,
      sizeHeading: t.font_size_heading || 13,
      sizeBody: t.font_size_body || 10,
    },
    header: {
      showLogo: template ? !!t.show_logo : true,
      showCompanyName: template ? t.show_company_name !== 0 : true,
      showCompanySubtitle: template ? t.show_company_subtitle !== 0 : true,
      showCompanyAddress: template ? t.show_company_address !== 0 : false,
      showCompanyPhone: template ? t.show_company_phone !== 0 : false,
      showCompanyEmail: template ? t.show_company_email !== 0 : false,
      showCompanyWebsite: template ? t.show_company_website !== 0 : false,
      showDocTitle: template ? t.show_doc_title !== 0 : true,
      showDocNumber: template ? t.show_doc_number !== 0 : true,
      showGeneratedDate: template ? t.show_generated_date !== 0 : true,
      showGeneratedBy: template ? t.show_generated_by !== 0 : true,
      showDateRange: template ? t.show_date_range !== 0 : true,
    },
    table: {
      themeStyle: TABLE_THEMES[t.table_theme] || TABLE_THEMES.medium_blue,
      altRows: template ? t.table_alt_rows !== 0 : true,
      freezeHeader: template ? t.freeze_header !== 0 : true,
      enableFilters: template ? t.enable_filters !== 0 : true,
    },
    dateFormat: t.date_format || "dd mmm yyyy",
    footer: {
      show: template ? t.show_footer !== 0 : true,
      showCompanyName: template ? t.footer_show_company_name !== 0 : true,
      showGeneratedBy: template ? t.footer_show_generated_by !== 0 : true,
      showGeneratedDate: template ? t.footer_show_generated_date !== 0 : true,
      showPageNumber: template ? t.footer_show_page_number !== 0 : true,
      customText: t.footer_custom_text || null,
      align: t.footer_align || "left",
    },
    print: {
      orientation: t.page_orientation || "auto",
      fitToPage: template ? t.fit_to_page !== 0 : true,
      repeatHeaderRows: template ? t.repeat_header_rows !== 0 : true,
    },
    // Document-body toggles the quotation workbook (xlsx-documents.js) reads
    // — kept on this same resolved-style object so every "does this excel
    // template want notes/bill-to shown" check goes through one place.
    showNotes: template ? !!t.show_notes : true,
    showBillToAddress: template ? !!t.show_bill_to_address : true,
    showBillToContact: template ? !!t.show_bill_to_contact : true,
  };
}

/**
 * buildProfessionalWorkbook(cfg) — the shared single-sheet Excel engine.
 *
 * cfg = {
 *   company, template,                    // excel_templates row, or null/undefined
 *   docTypeLabel, docNumber, statusLabel, generatedBy,
 *   subtitleLines: [string],              // e.g. "Period: ... · Generated by ..."
 *   infoRows: [{ label, value }],         // key/value pairs above the table
 *   summaryCards: [{ label, value, numFmt }],  // KPI band above the table
 *   table: {
 *     columns: [{ key, label, width, align, numFmt, isDate }],
 *     rows: [ ...plain data objects... ],
 *     cellValue: (row, key, idx) => value,      // raw value (number/string/Date) for the cell
 *     totalsRow: { [key]: "sum" | "count" | value } | undefined,
 *   },
 *   totalsBox: [{ label, value, numFmt, emph }],  // label/value rows placed AFTER the table —
 *                                                  // the last entry typically sets emph:true for
 *                                                  // a single highlighted closing figure (e.g.
 *                                                  // "Last Balance"); never a card, never above the table
 *   notes: string,
 * }
 */
async function buildProfessionalWorkbook(cfg) {
  const {
    company, template, docTypeLabel, docNumber, statusLabel, generatedBy,
    subtitleLines = [], infoRows = [], summaryCards = [], table, totalsBox, notes, sheetName,
  } = cfg;

  const style = resolveExcelStyle(template, company);
  const brandARGB = style.colors.primary;
  const wb = new ExcelJS.Workbook();
  wb.creator = generatedBy || "OBO Financial System";
  wb.created = new Date();

  const tableCols = sanitizeTableColumns(table?.columns || []);
  const colCount = Math.max(4, tableCols.length, summaryCards.length);
  const wantsLandscape = style.print.orientation === "landscape" || (style.print.orientation === "auto" && tableCols.length > 6);
  const ws = wb.addWorksheet((sheetName || docTypeLabel || "Document").slice(0, 31), {
    pageSetup: { orientation: wantsLandscape ? "landscape" : "portrait", fitToPage: style.print.fitToPage, fitToWidth: 1 },
  });
  ws.columns = new Array(colCount).fill(0).map((_, i) => ({ width: tableCols[i] ? tableCols[i].width || 16 : 18 }));
  ws.properties.defaultRowHeight = 15;

  let r = 1;
  // ---------------- Branded header block ----------------
  // Company logo, embedded top-left, when the template wants it and one is
  // actually configured (company.logo_data_url is a data: URL, same field
  // the PDF header already draws from).
  if (style.header.showLogo && company?.logo_data_url && /^data:image\/(png|jpe?g);base64,/.test(company.logo_data_url)) {
    try {
      const match = company.logo_data_url.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
      const ext = match[1] === "jpg" ? "jpeg" : match[1];
      const imgId = wb.addImage({ base64: company.logo_data_url, extension: ext });
      ws.addImage(imgId, { tl: { col: 0, row: r - 1 }, ext: { width: 60, height: 60 } });
      r += 1; // reserve a little vertical room the logo occupies alongside the name line
    } catch (e) { /* a malformed logo data URL should never break the export */ }
  }
  if (style.header.showCompanyName) {
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    ws.getCell(`A${r}`).value = company?.name || "Company";
    ws.getCell(`A${r}`).font = { name: style.font.family, bold: true, size: style.font.sizeTitle, color: { argb: brandARGB } };
    r++;
  }
  if (style.header.showCompanySubtitle) {
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    ws.getCell(`A${r}`).value = company?.tagline || "Financial System";
    ws.getCell(`A${r}`).font = { name: style.font.family, size: 10, color: { argb: style.colors.muted } };
    r++;
  }
  const contactBits = [];
  if (style.header.showCompanyAddress && company?.address) contactBits.push(company.address);
  if (style.header.showCompanyPhone && company?.phone) contactBits.push(company.phone);
  if (style.header.showCompanyEmail && company?.email) contactBits.push(company.email);
  if (style.header.showCompanyWebsite && company?.website) contactBits.push(company.website);
  if (contactBits.length) {
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    ws.getCell(`A${r}`).value = contactBits.join("   ·   ");
    ws.getCell(`A${r}`).font = { name: style.font.family, size: 9, color: { argb: style.colors.muted } };
    r++;
  }
  r++;

  if (style.header.showDocTitle) {
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    const titleParts = [
      docTypeLabel,
      style.header.showDocNumber && docNumber ? `#${docNumber}` : null,
      statusLabel ? `— ${statusLabel}` : null,
    ].filter(Boolean);
    ws.getCell(`A${r}`).value = titleParts.join(" ");
    ws.getCell(`A${r}`).font = { name: style.font.family, bold: true, size: style.font.sizeHeading };
    r++;
  }
  for (const line of subtitleLines) {
    if (!line) continue;
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    ws.getCell(`A${r}`).value = line;
    ws.getCell(`A${r}`).font = { name: style.font.family, size: 9.5, color: { argb: style.colors.muted } };
    r++;
  }
  r++;

  // ---------------- Info rows (key/value pairs) ----------------
  if (infoRows.length) {
    for (const { label, value } of infoRows) {
      if (value === null || value === undefined || value === "") continue;
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { name: style.font.family, bold: true, color: { argb: style.colors.muted } };
      ws.mergeCells(`B${r}:${colLetter(colCount - 1)}${r}`);
      ws.getCell(`B${r}`).value = value;
      ws.getCell(`B${r}`).font = { name: style.font.family };
      r++;
    }
    r++;
  }

  // ---------------- Summary / KPI band ----------------
  let tableStartRow = null; // filled in once the table is placed, so KPI formulas can reference it
  const kpiFormulaSlots = []; // { row, col, key } to fill in with formulas after the table exists

  if (summaryCards.length) {
    const kpiRow = r;
    summaryCards.forEach((card, i) => {
      const cell = ws.getCell(`${colLetter(i)}${kpiRow}`);
      cell.value = card.label;
      cell.font = { name: style.font.family, size: 9, color: { argb: style.colors.muted } };
      cell.border = { top: { style: "medium", color: { argb: brandARGB } } };
    });
    summaryCards.forEach((card, i) => {
      const cell = ws.getCell(`${colLetter(i)}${kpiRow + 1}`);
      if (card.formulaKey) {
        // Resolved below, once the table's column letters/row range are known.
        kpiFormulaSlots.push({ row: kpiRow + 1, col: i, key: card.formulaKey, fn: card.formulaFn || "sum" });
      } else {
        cell.value = card.value;
      }
      if (card.numFmt) cell.numFmt = card.numFmt;
      cell.font = { name: style.font.family, bold: true, size: style.font.sizeHeading, color: { argb: brandARGB } };
    });
    r = kpiRow + 3;
  }

  // ---------------- The real Excel Table ----------------
  let colLetterByKey = {};
  let dataRowCount = 0;
  let headerRow = null;
  let lastDataRow = null;
  let firstDataRow = null; // hoisted (not just block-local) so a post-table totalsBox formula can reference the table's real range too
  if (table && tableCols.length) {
    const { rows = [], cellValue, totalsRow } = table;
    dataRowCount = rows.length;
    tableStartRow = r;
    tableCols.forEach((c, i) => { colLetterByKey[c.key] = colLetter(i); });

    if (dataRowCount > 0) {
      const bodyRows = rows.map((row, idx) => tableCols.map((c) => {
        const v = cellValue ? cellValue(row, c.key, idx) : row[c.key];
        return v === undefined ? null : v;
      }));

      ws.addTable({
        name: `Tbl_${Math.random().toString(36).slice(2, 8)}`,
        ref: `A${tableStartRow}`,
        headerRow: true,
        totalsRow: !!totalsRow && dataRowCount > 0,
        style: { theme: style.table.themeStyle, showRowStripes: style.table.altRows },
        columns: tableCols.map((c) => ({
          name: c.label,
          filterButton: style.table.enableFilters,
          totalsRowFunction: totalsRow && totalsRow[c.key] === "sum" ? "sum" : totalsRow && totalsRow[c.key] === "count" ? "count" : "none",
          totalsRowLabel: totalsRow && typeof totalsRow[c.key] === "string" && totalsRow[c.key] !== "sum" && totalsRow[c.key] !== "count" ? totalsRow[c.key] : undefined,
        })),
        rows: bodyRows,
      });

      headerRow = tableStartRow;
      firstDataRow = tableStartRow + 1;
      lastDataRow = tableStartRow + dataRowCount;

      // EXPORT CORRUPTION FIX (root cause #2): exceljs's own addTable()/store()
      // only ever writes a real value into the FIRST totals-row cell (the
      // label) and into any cell with a totalsRowFunction (a SUM/COUNT
      // formula) — every other column in that row is left as a bare `null`
      // value (see node_modules/exceljs/lib/doc/table.js's store(): `else {
      // cell.value = null; }`). exceljs never serializes a null-valued cell
      // into the sheet XML at all, so the totals row ends up with HOLES — no
      // <c> element for those columns — even though the Table's own `ref`
      // range declares the full rectangle including every column in that row.
      // Microsoft Excel's stricter Table loader checks that every cell in a
      // declared Table range actually exists; a sparse totals row like this is
      // exactly the "Removed Feature: Table" (+ AutoFilter, since it lives on
      // the Table) repair this fixes. Explicitly writing an empty string into
      // every still-empty totals-row cell forces exceljs to serialize a real
      // (empty) <c> element for it, closing the hole — purely cosmetic
      // (an empty cell looks identical either way), structurally required.
      if (totalsRow && dataRowCount > 0) {
        const totalsRowNum = lastDataRow + 1;
        tableCols.forEach((c, i) => {
          const cell = ws.getCell(`${colLetter(i)}${totalsRowNum}`);
          if (cell.value === null || cell.value === undefined) cell.value = "";
        });
      }
      tableCols.forEach((c, i) => {
        const letter = colLetter(i);
        // A column's own explicit numFmt always wins; `isDate` lets a caller
        // defer to the template's single date format instead of hard-coding
        // one (spec item 15 — one consistent date format per document).
        // numFmt may also be a function (row) => formatString — needed for
        // a column that mixes USD and SLSH rows (e.g. an "All currencies"
        // accounts export), where each row needs its OWN currency's Excel
        // format ("$"#,##0.00 vs #,##0 "SLSH") rather than one fixed
        // format for the whole column (GLOBAL CURRENCY FORMATTING round).
        const numFmt = c.numFmt || (c.isDate ? style.dateFormat : null);
        if (numFmt) {
          if (typeof numFmt === "function") {
            for (let rr = firstDataRow; rr <= lastDataRow; rr++) { const f = numFmt(rows[rr - firstDataRow]); if (f) ws.getCell(`${letter}${rr}`).numFmt = f; }
          } else {
            for (let rr = firstDataRow; rr <= lastDataRow; rr++) ws.getCell(`${letter}${rr}`).numFmt = numFmt;
            if (totalsRow && dataRowCount > 0) ws.getCell(`${letter}${lastDataRow + 1}`).numFmt = numFmt;
          }
        }
        if (c.align) {
          for (let rr = firstDataRow; rr <= lastDataRow; rr++) ws.getCell(`${letter}${rr}`).alignment = { horizontal: c.align };
        }
        if (c.wrap) {
          for (let rr = firstDataRow; rr <= lastDataRow; rr++) ws.getCell(`${letter}${rr}`).alignment = { wrapText: true, vertical: "top" };
        }
        for (let rr = firstDataRow; rr <= lastDataRow; rr++) ws.getCell(`${letter}${rr}`).font = { name: style.font.family, size: style.font.sizeBody };
      });
      ws.getRow(headerRow).font = { name: style.font.family, bold: true, color: style.colors.tableHeaderText ? { argb: hexToArgb(style.colors.tableHeaderText) } : undefined };
      if (style.colors.tableHeader) {
        const headerFillArgb = hexToArgb(style.colors.tableHeader);
        for (let i = 0; i < tableCols.length; i++) {
          ws.getCell(`${colLetter(i)}${headerRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFillArgb } };
        }
      }
      r = (totalsRow && dataRowCount > 0 ? lastDataRow + 1 : lastDataRow) + 2;
    } else {
      // EXPORT CORRUPTION FIX (root cause #3): a zero-record export used to
      // still call ws.addTable() with an empty `rows: []` array, producing a
      // real Excel Table whose declared `ref` range is ONLY the single
      // header row (e.g. "A8:G8") with zero data/totals rows beneath it.
      // Every individual cell in that range is well-formed, but the Table
      // itself is a degenerate, header-only ListObject — and Microsoft
      // Excel's own (stricter-than-exceljs/openpyxl/LibreOffice) Table
      // loader rejects that shape on open, "fixing" it by deleting the
      // Table — and the AutoFilter that lives on it — producing the same
      // "Removed Feature: Table / AutoFilter" repair dialog as the other two
      // root causes this file now guards against. Per the original spec's
      // own empty-state rule ("If there are zero records: Do not generate
      // broken tables. Use a valid empty-state structure such as 'No data
      // available'... Do not create invalid AutoFilter/table ranges. The
      // Excel file must still open normally."), a zero-row export no longer
      // creates an Excel Table/ListObject/AutoFilter at all. It writes the
      // same column labels as plain styled cells — visually identical to a
      // real table header — followed by a merged "No data available"
      // message row. Plain cells in a plain (non-Table) worksheet region
      // have no ref-rectangle completeness requirement, so this is always
      // structurally valid no matter how few or many columns there are.
      headerRow = tableStartRow;
      lastDataRow = tableStartRow;
      tableCols.forEach((c, i) => {
        ws.getCell(`${colLetter(i)}${headerRow}`).value = c.label;
      });
      const noDataRow = headerRow + 1;
      const lastColLetter = colLetter(Math.max(tableCols.length - 1, 0));
      ws.mergeCells(`A${noDataRow}:${lastColLetter}${noDataRow}`);
      const noDataCell = ws.getCell(`A${noDataRow}`);
      noDataCell.value = "No data available";
      noDataCell.font = { name: style.font.family, italic: true, color: { argb: style.colors.muted } };
      noDataCell.alignment = { horizontal: "center" };
      ws.getRow(headerRow).font = { name: style.font.family, bold: true, color: style.colors.tableHeaderText ? { argb: hexToArgb(style.colors.tableHeaderText) } : undefined };
      if (style.colors.tableHeader) {
        const headerFillArgb = hexToArgb(style.colors.tableHeader);
        for (let i = 0; i < tableCols.length; i++) {
          ws.getCell(`${colLetter(i)}${headerRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerFillArgb } };
        }
      }
      r = noDataRow + 2;
    }

    // Resolve KPI formula slots now that the table's real range is known —
    // these are always same-sheet references (the master spec's "one sheet
    // only" rule), never cross-sheet lookups.
    for (const slot of kpiFormulaSlots) {
      const letter = colLetterByKey[slot.key];
      const cell = ws.getCell(`${colLetter(slot.col)}${slot.row}`);
      if (!letter || dataRowCount === 0) { cell.value = 0; continue; }
      const range = `${letter}${firstDataRow}:${letter}${lastDataRow}`;
      cell.value = { formula: `${slot.fn.toUpperCase()}(${range})` };
    }

    // Freeze panes so the header row (and everything above it) stays
    // visible while scrolling through a large export (spec item 12).
    if (style.table.freezeHeader) {
      ws.views = [{ state: "frozen", ySplit: headerRow }];
    }
    // Repeat the header row on every printed page (spec item 17).
    if (style.print.repeatHeaderRows) {
      ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
    }
  } else {
    // No slots to resolve without a table — fall back to literal values.
    for (const slot of kpiFormulaSlots) ws.getCell(`${colLetter(slot.col)}${slot.row}`).value = 0;
  }

  // ---------------- Totals summary block (post-table) ----------------
  // GLOBAL "LAST BALANCE AT THE BOTTOM" round: the Excel counterpart of
  // pdf.js's renderProfessionalDocument totalsBox — a clean label/value row
  // block placed AFTER the transaction table (never a KPI card, never
  // before the table). The final entry may set `emph: true` to render as
  // the document's single highlighted closing figure (e.g. "Last
  // Balance") using the existing Emerald/Teal brand color, exactly the
  // same "bold + accent + subtle fill" treatment the PDF engine already
  // gives an emph totalsBox row — never a second KPI card, just a clearly
  // emphasized report row.
  if (totalsBox && totalsBox.length) {
    const lastColLetter = colLetter(colCount - 1);
    for (const t of totalsBox) {
      const labelCell = ws.getCell(`A${r}`);
      ws.mergeCells(`B${r}:${lastColLetter}${r}`);
      const valueCell = ws.getCell(`B${r}`);
      labelCell.value = t.label;
      // A totalsBox row may reuse the same "real SUM() formula over the
      // table range" treatment summaryCards rows get, rather than a
      // hardcoded duplicate number — the table's column range is already
      // known by this point (we're strictly after the table-placement
      // block above), so it can be resolved immediately instead of via
      // the deferred kpiFormulaSlots mechanism summaryCards needs.
      if (t.formulaKey && colLetterByKey[t.formulaKey] && dataRowCount > 0) {
        const letter = colLetterByKey[t.formulaKey];
        valueCell.value = { formula: `${(t.formulaFn || "sum").toUpperCase()}(${letter}${firstDataRow}:${letter}${lastDataRow})` };
      } else {
        valueCell.value = t.value;
      }
      if (t.numFmt) valueCell.numFmt = t.numFmt;
      if (t.emph) {
        const fillArgb = "FFE3F2EF"; // subtle emerald/teal tint, independent of template customization
        labelCell.font = { name: style.font.family, bold: true, size: style.font.sizeHeading, color: { argb: brandARGB } };
        valueCell.font = { name: style.font.family, bold: true, size: style.font.sizeHeading, color: { argb: brandARGB } };
        labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillArgb } };
        valueCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillArgb } };
        const borderEdge = { style: "medium", color: { argb: brandARGB } };
        labelCell.border = { top: borderEdge, bottom: borderEdge };
        valueCell.border = { top: borderEdge, bottom: borderEdge };
      } else {
        labelCell.font = { name: style.font.family, color: { argb: style.colors.muted } };
        valueCell.font = { name: style.font.family };
      }
      r++;
    }
    r++;
  }

  // ---------------- Notes ----------------
  if (notes) {
    ws.getCell(`A${r}`).value = "Notes";
    ws.getCell(`A${r}`).font = { name: style.font.family, bold: true, color: { argb: style.colors.muted } };
    r++;
    ws.mergeCells(`A${r}:${colLetter(colCount - 1)}${r}`);
    ws.getCell(`A${r}`).value = notes;
    ws.getCell(`A${r}`).font = { name: style.font.family };
    ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: "top" };
    r++;
  }

  // ---------------- Native Excel print footer (spec item 18) ----------------
  // A real Excel print/page footer (visible in Print Preview and when
  // printed), not a worksheet data row — keeps the "one clean sheet" rule
  // intact while still giving every export the professional footer the
  // spec asks for. &P/&N are Excel's own "current page"/"total pages"
  // codes, so the page count is always correct without any calculation.
  if (style.footer.show) {
    const left = [];
    if (style.footer.showCompanyName && company?.name) left.push(company.name);
    const center = [];
    if (style.footer.showGeneratedBy && generatedBy) center.push(`Generated by ${generatedBy}`);
    if (style.footer.showGeneratedDate) center.push(`Generated ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`);
    if (style.footer.customText) center.push(applyPlaceholders(style.footer.customText, company));
    const right = style.footer.showPageNumber ? "Page &P of &N" : "";
    const slots = { left: "", center: "", right: "" };
    // footer_align decides which of the three native footer slots the
    // company-name/generated-by text lands in; the page number (when shown)
    // always stays on the opposite/right slot so it never collides with it.
    const bodyText = [...left, ...center].filter(Boolean).join("   ·   ");
    if (style.footer.align === "center") slots.center = bodyText;
    else if (style.footer.align === "right") slots.right = bodyText;
    else slots.left = bodyText;
    if (right && slots.right) slots.right = `${slots.right}   ${right}`;
    else if (right) slots.right = right;
    ws.headerFooter = {
      oddFooter: `&L${slots.left}&C${slots.center}&R${slots.right}`,
    };
  }

  localizeWorkbook(wb);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await assertValidWorkbook(buffer);
  return buffer;
}

// LANGUAGE round: in Somali, every text cell that is interface wording
// (titles, labels, column headings, "Active", "Deposit"...) is translated
// and the sheet tab renamed. Numbers, dates and data text (names,
// references) are left exactly as they are — they never match the
// dictionary. Sheet names keep Excel's 31-character / character rules.
function localizeWorkbook(wb) {
  const { tr, isSomali } = require("./i18n/request");
  if (!isSomali()) return;
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.master !== cell) return;
        if (typeof cell.value === "string") {
          const t = tr(cell.value);
          if (t !== cell.value) cell.value = t;
        }
      });
    });
    const name = tr(ws.name).replace(/[\\/?*\[\]:]/g, " ").trim().slice(0, 31);
    if (name && name !== ws.name && !wb.worksheets.some((o) => o !== ws && o.name === name)) ws.name = name;
  }
}

// VALIDATE BEFORE DOWNLOAD: re-open the just-written buffer with a fresh
// ExcelJS instance before it ever reaches sendXLSX/the client. This is the
// same safety net Excel itself effectively runs on open — if exceljs can't
// parse what it just wrote (a genuinely corrupt workbook, as opposed to the
// column-naming bug fixed above, which this also catches as a second line of
// defense), we fail loudly here with a clear server error instead of
// silently handing the user a file Excel will "repair" or refuse to open.
async function assertValidWorkbook(buffer) {
  try {
    const check = new ExcelJS.Workbook();
    await check.xlsx.load(buffer);
    if (!check.worksheets.length) throw new Error("Generated workbook has no worksheets.");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[xlsx-engine] Generated workbook failed validation — not sending a corrupt file:", e);
    throw new Error("Failed to generate a valid Excel file. Please try again or contact support.");
  }
}

module.exports = { buildProfessionalWorkbook, brandArgbOf, colLetter, resolveExcelStyle, TABLE_THEMES, sanitizeTableColumns, assertValidWorkbook };
