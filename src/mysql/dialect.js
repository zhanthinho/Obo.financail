"use strict";
// MYSQL round — translates the app's SQL (written for SQLite) into the MySQL
// dialect, and routes every table name to the right company's tables.
//
// Company separation: each company's tables carry that company's prefix
// (CMP-0002 -> cmp0002_clients, cmp0002_users, ...) and the shared platform
// tables carry ctl_. A statement is translated for exactly ONE scope — one
// company, or the platform registry — so a query can only ever name the
// tables of the company the request was authorized for. There is no syntax
// the app can write that reaches another company's tables.
//
// Only constructs the app actually uses are translated; anything else that is
// SQLite-only is REFUSED with an error (never passed through to behave
// differently on MySQL). Translations are cached per scope + SQL text.

const CACHE_MAX = 5000;

class DialectError extends Error {
  constructor(message, sql) { super(`${message} — in SQL: ${String(sql).replace(/\s+/g, " ").slice(0, 200)}`); this.code = "SQL_DIALECT"; }
}

// Splits SQL into tokens, keeping the original text of each.
function tokenize(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new DialectError("Unterminated string literal", sql);
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      out.push({ t: "str", v: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '"' || c === "`") {
      const j = sql.indexOf(c, i + 1);
      if (j < 0) throw new DialectError("Unterminated quoted identifier", sql);
      out.push({ t: "qid", v: sql.slice(i, j + 1), name: sql.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (c === "[") { throw new DialectError("[bracket] identifiers are not supported", sql); }
    if (c === "-" && sql[i + 1] === "-") { const j = sql.indexOf("\n", i); const e = j < 0 ? n : j; out.push({ t: "ws", v: " " }); i = e; continue; }
    if (c === "/" && sql[i + 1] === "*") { const j = sql.indexOf("*/", i + 2); const e = j < 0 ? n : j + 2; out.push({ t: "ws", v: " " }); i = e; continue; }
    if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(sql[j])) j++; out.push({ t: "ws", v: sql.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++; out.push({ t: "word", v: sql.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] || ""))) { let j = i + 1; while (j < n && /[0-9.eE]/.test(sql[j])) j++; out.push({ t: "num", v: sql.slice(i, j) }); i = j; continue; }
    const two = sql.slice(i, i + 2);
    if (["==", "!=", "<>", "<=", ">=", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    out.push({ t: "op", v: c }); i++;
  }
  return out;
}

// Index of the next / previous non-whitespace token.
function nextSig(toks, i) { for (let j = i + 1; j < toks.length; j++) if (toks[j].t !== "ws") return j; return -1; }
function prevSig(toks, i) { for (let j = i - 1; j >= 0; j--) if (toks[j].t !== "ws") return j; return -1; }
function up(tok) { return tok && tok.t === "word" ? tok.v.toUpperCase() : null; }
// Index of the ")" matching the "(" at index i.
function matchParen(toks, i, sql) {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== "op") continue;
    if (toks[j].v === "(") depth++;
    else if (toks[j].v === ")") { depth--; if (depth === 0) return j; }
  }
  throw new DialectError("Unbalanced parentheses", sql);
}

const REFUSED_FUNCS = new Set(["GLOB", "JULIANDAY", "STRFTIME", "DATETIME", "TIME", "PRINTF", "TYPEOF", "IIF", "TOTAL", "GROUP_CONCAT", "RANDOMBLOB", "ZEROBLOB", "UNICODE", "LIKELIHOOD", "SQLITE_VERSION", "CHANGES", "LAST_INSERT_ROWID"]);
const REFUSED_WORDS = new Set(["PRAGMA", "SQLITE_MASTER", "SQLITE_SCHEMA", "ROWID", "_ROWID_", "OID", "VACUUM", "ATTACH", "DETACH", "AUTOINCREMENT", "GLOB", "RETURNING", "EXCLUDED"]);
const LIKE_COLLATION = "utf8mb4_general_ci"; // SQLite LIKE is case-insensitive

// scope: { prefix: "cmp0002_", tables: Set<string> }
function translateUncached(sql, scope) {
  const toks = tokenize(sql);
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === "qid") {
      if (/^(cmp\d{4,}|ctl)_/i.test(tk.name)) throw new DialectError(`Direct table name ${tk.name} is not allowed — use the plain table name`, sql);
      if (scope.tables.has(tk.name.toLowerCase())) tk.v = `"${scope.prefix}${tk.name.toLowerCase()}"`;
      else tk.v = `"${tk.name}"`;
      continue;
    }
    if (tk.t === "op" && tk.v === "==") { tk.v = "="; continue; }
    if (tk.t !== "word") continue;
    const U = tk.v.toUpperCase();
    const pi = prevSig(toks, i);
    const prev = pi >= 0 ? toks[pi] : null;
    const ni = nextSig(toks, i);
    const next = ni >= 0 ? toks[ni] : null;
    const isCall = next && next.t === "op" && next.v === "(";
    const afterDot = prev && prev.t === "op" && prev.v === ".";

    // Table names -> this scope's own tables.
    if (!afterDot && scope.tables.has(tk.v.toLowerCase()) && up(prev) !== "AS") {
      tk.v = scope.prefix + tk.v.toLowerCase();
      continue;
    }
    // Another scope's physical table names can never be written directly.
    if (/^(cmp\d{4,}|ctl)_/i.test(tk.v)) throw new DialectError(`Direct table name ${tk.v} is not allowed — use the plain table name`, sql);
    if (afterDot) {
      // t.key — a column named with a MySQL reserved word.
      if (U === "KEY") tk.v = '"key"';
      continue;
    }
    if (REFUSED_WORDS.has(U)) throw new DialectError(`SQLite-only keyword ${U} is not supported on MySQL`, sql);
    if (isCall && REFUSED_FUNCS.has(U)) throw new DialectError(`SQLite-only function ${U}() is not supported on MySQL`, sql);

    if (U === "KEY") {
      const p = up(prev);
      if (!["PRIMARY", "FOREIGN", "UNIQUE", "DUPLICATE"].includes(p)) tk.v = '"key"';
      continue;
    }
    if (U === "INSERT" && up(next) === "OR") {
      const ki = nextSig(toks, ni);
      const what = up(toks[ki]);
      if (what === "IGNORE") { toks[ni].v = ""; toks[ni].t = "ws"; toks[ki].v = "IGNORE"; continue; }
      if (what === "REPLACE") { tk.v = "REPLACE"; toks[ni].v = ""; toks[ni].t = "ws"; toks[ki].v = ""; toks[ki].t = "ws"; continue; }
      throw new DialectError(`INSERT OR ${what} is not supported`, sql);
    }
    if (U === "ON" && up(next) === "CONFLICT") throw new DialectError("ON CONFLICT is not supported — use upsert() in src/db.js", sql);
    if (U === "COLLATE" && up(next) === "NOCASE") { toks[ni].v = LIKE_COLLATION; continue; }
    if (U === "COLLATE" && ["BINARY", "RTRIM"].includes(up(next))) throw new DialectError(`COLLATE ${up(next)} is not supported`, sql);
    if (U === "LENGTH" && isCall) { tk.v = "CHAR_LENGTH"; continue; }
    if ((U === "MIN" || U === "MAX") && isCall) {
      // Scalar MIN(a, b) / MAX(a, b) -> LEAST / GREATEST (aggregate form untouched).
      const close = matchParen(toks, ni, sql);
      let depth = 0, commas = 0;
      for (let j = ni; j <= close; j++) { const t = toks[j]; if (t.t !== "op") continue; if (t.v === "(") depth++; else if (t.v === ")") depth--; else if (t.v === "," && depth === 1) commas++; }
      if (commas > 0) tk.v = U === "MIN" ? "LEAST" : "GREATEST";
      continue;
    }
    if (U === "DATE" && isCall && up(prev) !== "AS") {
      // SQLite date(x) on the app's ISO-8601 text -> its first 10 characters
      // (YYYY-MM-DD). date('now') -> today's UTC date. Modifiers are refused.
      const close = matchParen(toks, ni, sql);
      let depth = 0;
      for (let j = ni; j <= close; j++) { const t = toks[j]; if (t.t === "op" && t.v === "(") depth++; else if (t.t === "op" && t.v === ")") depth--; else if (t.t === "op" && t.v === "," && depth === 1) throw new DialectError("date() with modifiers is not supported", sql); }
      const inner = toks.slice(ni + 1, close).filter((t) => t.t !== "ws");
      if (inner.length === 1 && inner[0].t === "str" && inner[0].v.toLowerCase() === "'now'") {
        tk.v = "DATE_FORMAT"; inner[0].v = "UTC_TIMESTAMP(), '%Y-%m-%d'";
      } else {
        tk.v = "LEFT";
        toks[close].v = ", 10)";
      }
      continue;
    }
    if (U === "AS" && next && next.t === "word") {
      // CAST(x AS INTEGER|REAL|TEXT|NUMERIC)
      const after = nextSig(toks, ni);
      if (after >= 0 && toks[after].t === "op" && toks[after].v === ")") {
        const T = up(next);
        if (T === "INTEGER" || T === "INT") next.v = "SIGNED";
        else if (T === "REAL" || T === "NUMERIC" || T === "FLOAT") next.v = "DOUBLE";
        else if (T === "TEXT") next.v = "CHAR";
      }
      continue;
    }
    if (U === "LIKE") {
      // Case-insensitive like SQLite: collate the pattern operand.
      if (!next) throw new DialectError("LIKE without a pattern", sql);
      let end = ni;
      if (next.t === "op" && next.v === "(") end = matchParen(toks, ni, sql);
      else if (!(next.t === "str" || (next.t === "op" && next.v === "?") || next.t === "word" || next.t === "qid")) throw new DialectError("Unsupported LIKE pattern", sql);
      const after = nextSig(toks, end);
      if (after >= 0 && up(toks[after]) === "ESCAPE") throw new DialectError("LIKE ... ESCAPE is not supported", sql);
      toks[end].v = `${toks[end].v} COLLATE ${LIKE_COLLATION}`;
      continue;
    }
    if (U === "IS") {
      let k = ni;
      if (up(toks[k]) === "NOT") k = nextSig(toks, k);
      if (up(toks[k]) !== "NULL" && up(toks[k]) !== "TRUE" && up(toks[k]) !== "FALSE") throw new DialectError("IS / IS NOT with a non-NULL value is not supported (use = or IS NULL)", sql);
      continue;
    }
  }
  return toks.map((t) => t.v).join("");
}

function makeTranslator(scope) {
  const cache = new Map();
  return function translate(sql) {
    let out = cache.get(sql);
    if (out !== undefined) return out;
    out = translateUncached(sql, scope);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(sql, out);
    return out;
  };
}

// Splits a script of several statements (only used for schema scripts and
// exec()) on top-level semicolons.
function splitStatements(sql) {
  const toks = tokenize(sql);
  const out = [];
  let cur = "";
  for (const t of toks) {
    if (t.t === "op" && t.v === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += t.v;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = { makeTranslator, translateUncached, splitStatements, tokenize, DialectError, LIKE_COLLATION };
