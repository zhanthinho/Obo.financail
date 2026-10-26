"use strict";
/* =========================================================================
   SOMALI / ENGLISH LANGUAGE SUPPORT — the one translation engine, shared by
   the browser (frontend/app.jsx, bundled by esbuild) and the server (API
   error messages, CSV / PDF / Excel labels).

   Keys are the English interface text itself (the gettext convention): the
   English UI is the source and the fallback, so a string with no Somali
   entry simply stays in English — nothing ever renders blank.
     so.json           exact strings      "Save changes" -> "Kaydi isbeddellada"
     so-patterns.json  strings with parts "Edit {0}"     -> "Wax ka beddel {0}"
   A {n} part is matched against the real text (a name, an amount, a number)
   and is itself translated only when it is a known interface word
   (e.g. "customer"), so names, amounts and references are never changed.

   Only interface text is translated. User-entered data (customer and
   company names, notes, references, IDs) is passed through untouched,
   because it never appears in these dictionaries.
   ========================================================================= */
const SO = require("./so.json");
const SO_PATTERNS = require("./so-patterns.json");

const LANGS = ["en", "so"];
let currentLang = "en";
function setLang(lang) { currentLang = lang === "so" ? "so" : "en"; }
function getLang() { return currentLang; }

// Whitespace-normalised lookup table (JSX text may carry line breaks).
const norm = (s) => s.replace(/\s+/g, " ").trim();
const SO_NORM = new Map();
const SO_LOWER = new Map();
for (const [k, v] of Object.entries(SO)) {
  SO_NORM.set(norm(k), v);
  const lk = norm(k).toLowerCase();
  if (!SO_LOWER.has(lk)) SO_LOWER.set(lk, v);
}

// Patterns compiled to anchored regexes, indexed by their first literal
// characters so each lookup only tries a handful.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compiled = Object.entries(SO_PATTERNS).map(([key, value]) => {
  const parts = key.split(/(\{\d+\})/);
  const order = [];
  const re = new RegExp("^" + parts.map((p) => {
    const m = /^\{(\d+)\}$/.exec(p);
    if (m) { order.push(Number(m[1])); return "([\\s\\S]+?)"; }
    return esc(p);
  }).join("") + "$");
  const prefix = parts[0] || "";
  // A pattern whose fixed text is just a word or two ("Opening {0}",
  // "View {0}") could otherwise match a customer or company NAME such as
  // "Opening Test Trading Co". Those only accept parts that are clearly not
  // names (see partIsSafe); patterns with sentence punctuation in their
  // fixed text ("Totals for this list ({0}) — {1} transactions") accept any.
  const literal = parts.filter((x) => !/^\{\d+\}$/.test(x)).join("");
  const words = literal.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
  const strict = !/[:—–()"?.!,·/#]/.test(literal) && words < 2;
  const reI = new RegExp(re.source, "i");
  return { re, reI, order, value, prefix, strict };
});
const byPrefix = new Map();
const noPrefix = [];
for (const p of compiled) {
  if (p.prefix.length >= 2) {
    const k = p.prefix.slice(0, 2);
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    byPrefix.get(k).push(p);
  } else noPrefix.push(p);
}

const MONTHS_SO = { Jan: "Jan", Feb: "Feb", Mar: "Mar", Apr: "Abr", May: "May", Jun: "Jun", Jul: "Luu", Aug: "Ogs", Sep: "Seb", Sept: "Seb", Oct: "Okt", Nov: "Nof", Dec: "Dis",
  January: "Janaayo", February: "Febraayo", March: "Maarso", April: "Abriil", June: "Juun", July: "Luulyo", August: "Agoosto", September: "Sebteembar", October: "Oktoobar", November: "Noofembar", December: "Diseembar" };
const MONTH_RE = /\b(January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b/g;
const DAYS_SO = { Mon: "Isn", Tue: "Tal", Wed: "Arb", Thu: "Kha", Fri: "Jim", Sat: "Sab", Sun: "Axd" };

function exact(s) {
  if (Object.prototype.hasOwnProperty.call(SO, s)) return SO[s];
  const n = norm(s);
  if (SO_NORM.has(n)) return SO_NORM.get(n);
  return null;
}
// A pattern part is "safe" when it is an interface word, or carries a
// digit (amount, count, date, reference), or has no words at all once
// currency codes are removed — i.e. it cannot be someone's name.
function partIsSafe(part) {
  if (exact(part) != null) return true;
  // drop amounts / references / counts (tokens with a digit) and currency
  // codes; anything word-like left over could be a name or free text.
  const rest = part.split(/\s+/).filter((w) => !/\d/.test(w) && !/^(USD|SLSH)$/.test(w)).join(" ");
  return !/[A-Za-z]{2}/.test(rest);
}
function viaPattern(s, depth = 0, anyCase = false) {
  const cands = anyCase ? compiled : (byPrefix.get(s.slice(0, 2)) || []).concat(noPrefix);
  for (const p of cands) {
    const m = (anyCase ? p.reI : p.re).exec(s);
    if (!m) continue;
    if (p.strict && !m.slice(1).every(partIsSafe)) continue;
    let out = p.value;
    p.order.forEach((idx, i) => {
      const part = m[i + 1];
      // A part may itself be interface text ("13 account(s)"); names and
      // data come back unchanged.
      let t = exact(part);
      if (t == null && depth < 2 && /[A-Za-z]{3}/.test(part)) {
        const sub = translateCore(part, depth + 1, false, true);
        if (sub !== part) t = sub;
      }
      out = out.split(`{${idx}}`).join(t != null ? t : part);
    });
    return out;
  }
  return null;
}

// Strings seen in Somali mode with letters but no translation — collected
// so tests (and developers) can list what is still missing.
const missing = new Set();
const cache = new Map();

function translateCore(s, depth = 0, split = false, quiet = false) {
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
  const core = s.slice(lead.length, s.length - trail.length);
  if (!core) return s;
  let t = exact(core);
  // Export documents (server side only): "A · B · C" lines are translated
  // piece by piece. The browser never splits — there a dotted line may be
  // user data such as a company tagline.
  if (t == null && split && /\s·\s/.test(core)) {
    const pieces = core.split(/(\s+·\s+)/);
    const out = pieces.map((p, i) => (i % 2 ? p : translateCore(p, depth + 1, true, true)));
    t = out.join("");
  }
  if (t == null) t = viaPattern(core, depth);
  // ALL-CAPS headings ("ACCOUNT STATEMENT") use the same entry as their
  // normal-case form, shown in capitals.
  if (t == null && /[A-Z]{2}/.test(core) && core === core.toUpperCase()) {
    const lower = SO_LOWER.get(norm(core).toLowerCase());
    if (lower != null) t = lower.toUpperCase();
    else {
      const viaP = viaPattern(core, depth, true);
      if (viaP != null) t = viaP.toUpperCase();
    }
  }
  if (t == null && /\d/.test(core) && MONTH_RE.test(core)) {
    MONTH_RE.lastIndex = 0;
    t = core.replace(MONTH_RE, (m) => MONTHS_SO[m] || m).replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, (d) => DAYS_SO[d]);
  }
  MONTH_RE.lastIndex = 0;
  if (t == null) {
    if (!quiet && /[A-Za-z]{3}/.test(core)) missing.add(core);
    return s;
  }
  return lead + t + trail;
}

// translate(text[, lang]) — the text in `lang` (default: the current
// language). Never throws; anything unknown comes back unchanged.
function translate(s, lang) {
  if (typeof s !== "string" || (lang || currentLang) !== "so" || !s || !/[A-Za-z]/.test(s)) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const t = translateCore(s);
  if (cache.size > 20000) cache.clear();
  cache.set(s, t);
  return t;
}

// translateDoc(text, lang) — the same, for export documents (PDF / Excel /
// CSV), which may also translate "A · B · C" lines piece by piece.
function translateDoc(s, lang) {
  if (typeof s !== "string" || lang !== "so" || !s || !/[A-Za-z]/.test(s)) return s;
  const key = "\u0001" + s;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const t = translateCore(s, 0, true);
  if (cache.size > 20000) cache.clear();
  cache.set(key, t);
  return t;
}

// Somali interface text back to its English key (exact, case-insensitive) —
// lets a file exported in Somali (e.g. the accounts CSV) be imported again.
let REVERSE = null;
function untranslate(s) {
  if (typeof s !== "string") return s;
  if (!REVERSE) {
    REVERSE = new Map();
    for (const [k, v] of Object.entries(SO)) { const key = norm(v).toLowerCase(); if (!REVERSE.has(key)) REVERSE.set(key, k); }
  }
  const hit = REVERSE.get(norm(s).toLowerCase());
  return hit != null ? hit : s;
}

module.exports = { translate, translateDoc, untranslate, setLang, getLang, LANGS, missing, SO_SIZE: Object.keys(SO).length, PATTERN_SIZE: compiled.length };
