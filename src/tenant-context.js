"use strict";
// MULTI-COMPANY round: request-scoped "which company's database am I
// talking to" context.
//
// Every HTTP request runs inside its own AsyncLocalStorage store (see
// server.js). The store starts EMPTY — no company — and is only filled in by
// rbac.requireAuth() (or the login route) after the signed token has been
// verified and the caller's access to that company confirmed. src/db.js's
// run/get/all/tx helpers read the active tenant from here on every call and
// THROW when there is none, so a code path that forgets to authenticate can
// never silently read or write some company's data — it fails closed.
//
// Outside of a request (CLI scripts, tests, the backup scheduler) there is no
// store at all; those callers must say explicitly which company they mean via
// withTenant() (or, for one-off scripts only, setScriptTenant()).
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
let scriptTenant = null; // only ever set by CLI scripts/tests, never by the server
let scriptTenantLocked = false;

class TenantContextError extends Error {
  constructor(message) {
    super(message || "No company context — the request was not authorized for any company.");
    this.name = "TenantContextError";
    this.code = "NO_COMPANY_CONTEXT";
  }
}

// Runs `fn` inside a fresh, empty request store.
function runRequest(fn, lang) {
  // COMPANY ID VISIBILITY round: every request starts with Company IDs
  // REDACTED; only a verified platform Super Admin session turns it off
  // (rbac.requirePlatformAdmin / requirePlatformWorkspace / platform login).
  // LANGUAGE round: `lang` ("en" | "so", from the X-Lang header) only picks
  // the language of messages and export labels — it carries no authority.
  return als.run({ tenant: null, company: null, showCompanyIds: false, lang: lang === "so" ? "so" : "en" }, fn);
}
// The raw request store (or null) — used by i18n/request.js only.
function requestStore() { return als.getStore() || null; }
// The interface language of the current request ("en" outside a request).
function requestLang() {
  const store = als.getStore();
  return store && store.lang === "so" ? "so" : "en";
}

// Called only after a platform Super Admin token has been verified.
function allowCompanyIds() {
  const store = als.getStore();
  if (store) store.showCompanyIds = true;
}
function companyIdsAllowed() {
  const store = als.getStore();
  return !!(store && store.showCompanyIds);
}
const COMPANY_ID_RE = /\s*(?:\u2014\s*)?\bCMP-\d{4,}\b(?:\s*\u2014)?\s*/g;
// Strips Company IDs (e.g. "CMP-0002") out of free text, e.g. old audit-log
// details, for anyone who is not a Super Admin.
function redactText(text) {
  if (typeof text !== "string" || companyIdsAllowed()) return text;
  return text.replace(COMPANY_ID_RE, (m) => (/^\s/.test(m) && /\s$/.test(m) ? " " : ""));
}
// Deep copy of a JSON-able value with company_id/companyId/cid keys removed
// and Company IDs stripped from strings — the response backstop.
function redactValue(v) {
  if (companyIdsAllowed()) return v;
  if (typeof v === "string") return /CMP-\d{4,}/.test(v) ? redactText(v) : v;
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "company_id" || k === "companyId" || k === "cid") continue;
      out[k] = redactValue(val);
    }
    return out;
  }
  return v;
}

// Fills in the CURRENT request's store. Only rbac.requireAuth/login call this,
// after verifying the token.
function setRequestTenant(tenant, company) {
  const store = als.getStore();
  if (!store) throw new TenantContextError("setRequestTenant called outside a request.");
  store.tenant = tenant;
  store.company = company;
}

// Runs `fn` with an explicit tenant — used by platform (Super Admin) endpoints
// that build per-company summaries one company at a time, and by background
// jobs. Each company's work is isolated in its own nested store.
function withTenant(tenant, company, fn) {
  const outer = als.getStore();
  return als.run({ tenant, company, lang: outer ? outer.lang : "en" }, fn);
}

function currentTenant() {
  const store = als.getStore();
  if (store) return store.tenant || null; // inside a request: never fall back
  return scriptTenant;
}

function currentCompany() {
  const store = als.getStore();
  if (store) return store.company || null;
  return scriptTenant ? scriptTenant.company : null;
}

function setScriptTenant(tenant) {
  if (scriptTenantLocked) throw new Error("Script tenant cannot be set inside the server process.");
  scriptTenant = tenant;
}
// server.js calls this so no code path can ever set a process-wide default.
function lockScriptTenant() {
  scriptTenant = null;
  scriptTenantLocked = true;
}

module.exports = {
  requestLang,
  requestStore,
  TenantContextError,
  runRequest,
  setRequestTenant,
  withTenant,
  currentTenant,
  currentCompany,
  setScriptTenant,
  lockScriptTenant,
  allowCompanyIds,
  companyIdsAllowed,
  redactText,
  redactValue,
};
