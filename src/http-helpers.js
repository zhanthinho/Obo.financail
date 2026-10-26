"use strict";

// COMPANY ID VISIBILITY round: lazily required to avoid a load-order cycle.
function redact(v) { return require("./tenant-context").redactValue(v); }
// LANGUAGE round: API error/info messages follow the caller's language.
function localizeMessages(res, obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const lang = res.oboLang || require("./tenant-context").requestLang();
  if (lang !== "so") return obj;
  const { translate } = require("./i18n");
  let out = obj;
  for (const k of ["error", "message", "warning"]) {
    if (typeof obj[k] === "string") {
      const t = translate(obj[k], "so");
      if (t !== obj[k]) { if (out === obj) out = { ...obj }; out[k] = t; }
    }
  }
  return out;
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(redact(localizeMessages(res, obj)));
  // SECURITY AUDIT round: API answers carry financial data — never let a
  // browser or proxy cache them.
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function sendCSV(res, filename, csvString) {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(require("./tenant-context").redactText(csvString));
}

function sendPDF(res, filename, buffer) {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

// PROFESSIONAL ACCOUNT REPORTS round: the Excel counterpart of sendPDF, for
// the new genuinely-editable Account Statement workbook (see
// xlsx-account-report.js) — same shape, just the .xlsx MIME type.
function sendXLSX(res, filename, buffer) {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

function notFound(res, msg = "Not found") {
  sendJSON(res, 404, { error: msg });
}
function badRequest(res, msg = "Bad request") {
  sendJSON(res, 400, { error: msg });
}

function hasNonFiniteNumber(v, depth = 0) {
  if (typeof v === "number") return !Number.isFinite(v);
  if (!v || typeof v !== "object" || depth > 20) return false;
  for (const k of Object.keys(v)) if (hasNonFiniteNumber(v[k], depth + 1)) return true;
  return false;
}
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        return reject(new Error("Invalid JSON body"));
      }
      // SECURITY & INTEGRITY AUDIT round: JSON numbers too large for a double
      // (e.g. 1e400) parse as Infinity — never a legitimate value anywhere in
      // this API, so the whole request is refused.
      if (hasNonFiniteNumber(parsed)) return reject(new Error("Invalid number in request."));
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

module.exports = { sendJSON, sendCSV, sendPDF, sendXLSX, notFound, badRequest, readJSONBody };
