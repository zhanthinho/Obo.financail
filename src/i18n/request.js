"use strict";
// Server-side helper: translate interface text into the language of the
// CURRENT request (the X-Lang header the browser sends, held in the
// request's AsyncLocalStorage store — see tenant-context.js). Outside a
// request, or for English, text is returned unchanged.
//
// protect(...values) marks user data seen in this request — the company's
// own name, tagline and address from Settings — so it is never translated
// even when it happens to contain interface words ("Currency Exchange").
const { translateDoc } = require("./index");

function store() { return require("../tenant-context").requestStore(); }
function lang() { return require("../tenant-context").requestLang(); }
function isSomali() { return lang() === "so"; }
function protect(...values) {
  const st = store();
  if (!st || st.lang !== "so") return;
  if (!st.raw) st.raw = new Set();
  for (const v of values) if (typeof v === "string" && v.trim()) st.raw.add(v.trim());
}
function tr(s) {
  if (typeof s !== "string" || !isSomali()) return s;
  const st = store();
  const raw = st && st.raw;
  if (raw && raw.has(s.trim())) return s;
  if (raw && s.includes("·")) {
    const parts = s.split(/(\s+·\s+)/);
    if (parts.some((p, i) => i % 2 === 0 && raw.has(p.trim()))) {
      return parts.map((p, i) => (i % 2 || raw.has(p.trim()) ? p : translateDoc(p, "so"))).join("");
    }
  }
  return translateDoc(s, "so");
}

module.exports = { tr, isSomali, lang, protect };
