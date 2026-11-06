"use strict";
// CROSS-CURRENCY CUSTOMER LINKING round — customer profiles API.
//   GET    /api/customers                         profiles + their accounts (search)
//   GET    /api/customers/reviews                 possible matches waiting for a decision
//   POST   /api/customers/reviews/:id             { action: "link" | "dismiss" }
//   GET    /api/customers/:id                     one profile, its accounts
//   POST   /api/customers/:id/accounts            { accountId, note? } manual link
//   DELETE /api/customers/:id/accounts/:accountId manual unlink
// Viewing needs customers.view or accounts.view; linking, unlinking and
// review decisions need customers.link. Every table is the signed-in
// company's own, so a profile or account of another company is simply not
// found (404). Accounts in a currency the user may not see are left out.
// Combined history for a profile: GET /api/history?customerId=…
const { all, get, run } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, allowedCurrencies, can, auditDenied } = require("../rbac");
const { addAudit } = require("../domain");
const { nowISO } = require("../util");
const customers = require("../customers");
const tenantContext = require("../tenant-context");

function viewer(req, res) {
  const user = requireAuth(req, res); if (!user) return null;
  if (!can(user, "customers.view") && !can(user, "accounts.view")) { requirePerm(user, res, "customers.view"); return null; }
  customers.ensureBackfilled(tenantContext.currentCompany()?.id);
  return user;
}
function linker(req, res) {
  const user = viewer(req, res); if (!user) return null;
  if (!requirePerm(user, res, "customers.link")) return null;
  return user;
}

function accountOut(a) {
  return { id: a.id, accountNumber: a.account_number, name: a.name, currency: a.currency, accountType: a.account_type, balance: a.currency === "USD" ? a.balance_usd : a.balance_slsh, status: a.status || "active", contact: a.contact, idNumber: a.id_number, createdAt: a.created_at };
}
function profileOut(c, allowed, user) {
  const linked = customers.linkedAccounts(c.id);
  const visible = linked.filter((a) => allowed.includes(a.currency) && (!user || require("../account-access").canView(user, a.id)));
  const contact = linked.map((a) => a.contact).find(Boolean) || null;
  return {
    id: c.id, customerNumber: c.customer_number, name: c.name, status: c.status, createdAt: c.created_at, contact,
    accounts: visible.map(accountOut), hiddenAccounts: linked.length - visible.length,
    pendingReviews: get("SELECT COUNT(*) AS n FROM customer_link_reviews WHERE status = 'pending' AND (candidate_customer_id = ? OR client_id IN (SELECT id FROM clients WHERE customer_id = ?))", [c.id, c.id]).n,
  };
}

function reviewOut(r, allowed, user) {
  const acc = get("SELECT * FROM clients WHERE id = ?", [r.client_id]);
  const cand = get("SELECT * FROM customers WHERE id = ?", [r.candidate_customer_id]);
  if (!acc || !cand || !allowed.includes(acc.currency) || (user && !require("../account-access").canView(user, acc.id))) return null;
  const own = acc.customer_id ? get("SELECT customer_number FROM customers WHERE id = ?", [acc.customer_id]) : null;
  return {
    id: r.id, status: r.status, reason: r.reason, confidence: r.confidence, source: r.source, createdAt: r.created_at,
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, resolution: r.resolution,
    account: { ...accountOut(acc), customerNumber: own ? own.customer_number : null },
    candidate: profileOut(cand, allowed, user),
  };
}

function register(router) {
  router.get("/api/customers", (req, res, params, query) => {
    const user = viewer(req, res); if (!user) return;
    const allowed = allowedCurrencies(user);
    const s = String(query.search || "").trim().toLowerCase();
    let rows = all("SELECT * FROM customers WHERE status = 'active' ORDER BY name ASC");
    let out = rows.map((c) => profileOut(c, allowed, user)).filter((p) => p.accounts.length > 0);
    if (s) out = out.filter((p) => p.name.toLowerCase().includes(s) || p.customerNumber.toLowerCase().includes(s) || p.accounts.some((a) => (a.accountNumber || "").toLowerCase().includes(s) || (a.contact || "").toLowerCase().includes(s)));
    if (query.linked === "1") out = out.filter((p) => p.accounts.length + p.hiddenAccounts > 1);
    const pending = all("SELECT * FROM customer_link_reviews WHERE status = 'pending'").map((r) => reviewOut(r, allowed, user)).filter(Boolean).length;
    sendJSON(res, 200, {
      customers: out,
      counts: { profiles: out.length, linked: out.filter((p) => p.accounts.length > 1).length, pendingReviews: pending },
      canLink: can(user, "customers.link"),
    });
  });

  router.get("/api/customers/reviews", (req, res, params, query) => {
    const user = viewer(req, res); if (!user) return;
    const allowed = allowedCurrencies(user);
    const status = ["pending", "linked", "dismissed"].includes(query.status) ? query.status : "pending";
    const rows = all("SELECT * FROM customer_link_reviews WHERE status = ? ORDER BY created_at DESC LIMIT 500", [status]);
    sendJSON(res, 200, { reviews: rows.map((r) => reviewOut(r, allowed, user)).filter(Boolean), canLink: can(user, "customers.link") });
  });

  router.post("/api/customers/reviews/:id", async (req, res, params) => {
    const user = linker(req, res); if (!user) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const r = get("SELECT * FROM customer_link_reviews WHERE id = ?", [params.id]);
    if (!r) return notFound(res, "Review item not found.");
    const acc = get("SELECT * FROM clients WHERE id = ?", [r.client_id]);
    if (!acc || !allowedCurrencies(user).includes(acc.currency)) return notFound(res, "Review item not found.");
    if (r.status !== "pending") return badRequest(res, `This item was already ${r.status === "linked" ? "linked" : "dismissed"}.`);
    if (!require("../account-access").require(user, res, [{ accountId: r.client_id, action: "manage" }])) return;
    if (body.action === "link") {
      const out = customers.linkAccount(r.candidate_customer_id, r.client_id, user, "confirmed from the review list");
      if (out.status !== 200) return sendJSON(res, out.status, { error: out.error });
    } else if (body.action === "dismiss") {
      const cand = get("SELECT customer_number FROM customers WHERE id = ?", [r.candidate_customer_id]);
      run("UPDATE customer_link_reviews SET status = 'dismissed', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?", [nowISO(), user.name, "Kept separate", r.id]);
      addAudit(user, "Customer match dismissed", `${acc.account_number} ${acc.name} (${acc.currency}) kept separate from ${cand ? cand.customer_number : r.candidate_customer_id}`);
    } else {
      return badRequest(res, 'Action must be "link" or "dismiss".');
    }
    sendJSON(res, 200, { review: reviewOut(get("SELECT * FROM customer_link_reviews WHERE id = ?", [r.id]), allowedCurrencies(user), user) });
  });

  router.get("/api/customers/:id", (req, res, params) => {
    const user = viewer(req, res); if (!user) return;
    const c = get("SELECT * FROM customers WHERE id = ?", [params.id]) || get("SELECT * FROM customers WHERE customer_number = ?", [params.id]);
    if (!c) return notFound(res, "Customer profile not found.");
    const allowed = allowedCurrencies(user);
    const p = profileOut(c, allowed, user);
    if (!p.accounts.length && c.status === "active") { auditDenied(user, `customer ${c.customer_number} has no account in an allowed currency`); return sendJSON(res, 403, { error: "You don't have access to this customer's accounts." }); }
    const reviews = all("SELECT * FROM customer_link_reviews WHERE status = 'pending' AND (candidate_customer_id = ? OR client_id IN (SELECT id FROM clients WHERE customer_id = ?)) ORDER BY created_at DESC", [c.id, c.id]).map((r) => reviewOut(r, allowed, user)).filter(Boolean);
    sendJSON(res, 200, { customer: p, mergedInto: c.merged_into || null, reviews, canLink: can(user, "customers.link") });
  });

  router.post("/api/customers/:id/accounts", async (req, res, params) => {
    const user = linker(req, res); if (!user) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!body.accountId) return badRequest(res, "Choose the account to link.");
    if (!require("../account-access").require(user, res, [{ accountId: String(body.accountId), action: "manage" }])) return;
    const acc = get("SELECT currency FROM clients WHERE id = ?", [body.accountId]);
    if (acc && !allowedCurrencies(user).includes(acc.currency)) { auditDenied(user, `link ${acc.currency} account`); return sendJSON(res, 403, { error: `You don't have access to ${acc.currency} accounts.` }); }
    const out = customers.linkAccount(params.id, body.accountId, user, String(body.note || "").slice(0, 200));
    if (out.status !== 200) return sendJSON(res, out.status, { error: out.error });
    sendJSON(res, 200, { customer: profileOut(get("SELECT * FROM customers WHERE id = ?", [params.id]), allowedCurrencies(user), user) });
  });

  router.delete("/api/customers/:id/accounts/:accountId", (req, res, params) => {
    const user = linker(req, res); if (!user) return;
    if (!require("../account-access").require(user, res, [{ accountId: params.accountId, action: "manage" }])) return;
    const acc = get("SELECT currency FROM clients WHERE id = ?", [params.accountId]);
    if (acc && !allowedCurrencies(user).includes(acc.currency)) { auditDenied(user, `unlink ${acc.currency} account`); return sendJSON(res, 403, { error: `You don't have access to ${acc.currency} accounts.` }); }
    const out = customers.unlinkAccount(params.id, params.accountId, user);
    if (out.status !== 200) return sendJSON(res, out.status, { error: out.error });
    sendJSON(res, 200, { customer: profileOut(get("SELECT * FROM customers WHERE id = ?", [params.id]), allowedCurrencies(user), user), newCustomerId: out.customerId });
  });
}

module.exports = { register };
