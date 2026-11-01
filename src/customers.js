"use strict";
// CROSS-CURRENCY CUSTOMER LINKING round.
//
// A customer profile (table `customers`, CUST-0001…) groups the separate
// currency accounts (table `clients`) that belong to one real person, e.g.
// "A-Rahen Moh'ed Ali" USD ACC-0006 and SLSH ACC-0012. Only the link
// (clients.customer_id) is shared: every account keeps its own ID, number,
// currency, balance, ledger, status and history. Nothing here ever reads or
// writes a balance, a ledger row or a transaction.
//
// Matching is done on the server only and only inside the current company
// (every table here is the company's own tenant table):
//   * same normalized name (trimmed, repeated spaces collapsed, case and
//     curly/straight apostrophes ignored), no conflicting phone / ID number,
//     exactly one such profile and it has no account in this currency yet
//     -> "high" confidence: linked automatically;
//   * same name but a conflicting phone or ID number, several profiles with
//     that name, the profile already holding an account in this currency,
//     or a name that only matches once punctuation/spaces are ignored
//     -> "needs review": the account gets its own profile and a review item
//     is recorded; nothing is merged until an authorised user decides;
//   * anything else -> no match, the account gets its own profile.
// Only customer accounts are linked; company (internal) accounts are not
// people and stay without a profile.
const { all, get, run, tx } = require("./db");
const { addAudit } = require("./domain");
const { uid, nowISO } = require("./util");

const SYSTEM = { id: null, name: "system", role: "system" };

function nameKey(name) {
  return String(name || "").normalize("NFKC").replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}
// Letters and digits only — "A-Rahen Moh'ed" and "A Rahen Mohed" collide here.
function looseKey(name) { return nameKey(name).replace(/[^\p{L}\p{N}]/gu, ""); }
function phoneKey(p) { const d = String(p || "").replace(/\D/g, ""); return d.length >= 6 ? d.slice(-9) : ""; }
function idKey(v) { return String(v || "").replace(/\s+/g, "").toLowerCase(); }

function nextCustomerNumber() {
  const rows = all("SELECT customer_number FROM customers");
  let max = 0;
  for (const r of rows) { const m = /^CUST-(\d+)$/.exec(r.customer_number || ""); if (m) max = Math.max(max, Number(m[1])); }
  return `CUST-${String(max + 1).padStart(4, "0")}`;
}

function createCustomer(name, actor) {
  const id = uid("cus");
  const at = nowISO();
  run("INSERT INTO customers (id, customer_number, name, name_key, status, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, nextCustomerNumber(), String(name).trim(), nameKey(name), "active", at, actor?.name || "system", at]);
  return get("SELECT * FROM customers WHERE id = ?", [id]);
}

function linkedAccounts(customerId, exceptId) {
  const rows = all("SELECT * FROM clients WHERE customer_id = ? AND deleted_at IS NULL ORDER BY created_at ASC", [customerId]);
  return exceptId ? rows.filter((r) => r.id !== exceptId) : rows;
}

// Why the account `acc` can't safely join `customer` (null = no conflict).
function conflictWith(acc, customer) {
  const others = linkedAccounts(customer.id, acc.id);
  const sameCurrency = others.find((o) => o.currency === acc.currency);
  if (sameCurrency) return `the profile already has a ${acc.currency} account (${sameCurrency.account_number})`;
  const p = phoneKey(acc.contact), i = idKey(acc.id_number);
  for (const o of others) {
    const op = phoneKey(o.contact), oi = idKey(o.id_number);
    if (p && op && p !== op) return `phone differs from ${o.account_number} (${o.contact})`;
    if (i && oi && i !== oi) return `ID number differs from ${o.account_number}`;
  }
  return null;
}

// Classifies one account against the company's other profiles.
// Returns { confidence: "high"|"needs_review"|"none", customer?, reviews: [{customer, reason}] }.
function evaluate(acc) {
  const key = nameKey(acc.name), loose = looseKey(acc.name);
  // A pair someone already decided to keep apart is never proposed again.
  const keptApart = new Set(all("SELECT candidate_customer_id AS c FROM customer_link_reviews WHERE client_id = ? AND status = 'dismissed'", [acc.id]).map((r) => r.c));
  const profiles = all("SELECT * FROM customers WHERE status = 'active'").filter((c) => c.id !== acc.customer_id && !keptApart.has(c.id));
  const exact = profiles.filter((c) => c.name_key === key && linkedAccounts(c.id, acc.id).length > 0);
  const similar = profiles.filter((c) => c.name_key !== key && loose && looseKey(c.name) === loose && linkedAccounts(c.id, acc.id).length > 0);
  const reviews = [];
  if (exact.length === 1) {
    const why = conflictWith(acc, exact[0]);
    if (!why) return { confidence: "high", customer: exact[0], reviews: [] };
    reviews.push({ customer: exact[0], reason: `Same name, but ${why}.` });
  } else if (exact.length > 1) {
    for (const c of exact) reviews.push({ customer: c, reason: `Same name as ${exact.length} different customer profiles — choose the right one.` });
  }
  for (const c of similar) reviews.push({ customer: c, reason: `Similar name ("${c.name}") — spelling differs only in spaces or punctuation.` });
  return { confidence: reviews.length ? "needs_review" : "none", reviews };
}

function addReviews(acc, reviews, source) {
  let added = 0;
  for (const r of reviews) {
    const dup = get("SELECT id FROM customer_link_reviews WHERE client_id = ? AND candidate_customer_id = ? AND status = 'pending'", [acc.id, r.customer.id]);
    if (dup) continue;
    run("INSERT INTO customer_link_reviews (id, client_id, candidate_customer_id, reason, confidence, status, source, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [uid("clr"), acc.id, r.customer.id, r.reason, "needs_review", "pending", source, nowISO()]);
    added += 1;
  }
  return added;
}

// Gives one account its customer profile (links it when the match is
// reliable). Safe to call repeatedly: an account that already has a
// profile is left as it is.
function assignCustomer(clientId, actor = SYSTEM, source = "create") {
  const acc = get("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!acc || acc.deleted_at || acc.account_type !== "customer" || acc.customer_id) return { skipped: true };
  const ev = evaluate(acc);
  if (ev.confidence === "high") {
    run("UPDATE clients SET customer_id = ? WHERE id = ?", [ev.customer.id, acc.id]);
    const sib = linkedAccounts(ev.customer.id, acc.id).map((o) => `${o.account_number} ${o.currency}`).join(", ");
    addAudit(actor, "Customer accounts linked automatically", `${ev.customer.customer_number} ${ev.customer.name}: ${acc.account_number} ${acc.currency} joined ${sib} (same name, no conflicting phone / ID)`);
    return { customerId: ev.customer.id, linked: true, confidence: "high" };
  }
  const c = createCustomer(acc.name, actor);
  run("UPDATE clients SET customer_id = ? WHERE id = ?", [c.id, acc.id]);
  const n = addReviews(acc, ev.reviews, source);
  if (n) addAudit(actor, "Customer match needs review", `${acc.account_number} ${acc.name} (${acc.currency}): ${ev.reviews.map((r) => `${r.customer.customer_number} — ${r.reason}`).join("; ")}`);
  return { customerId: c.id, linked: false, confidence: ev.confidence, reviews: n };
}

function retireIfEmpty(customerId, mergedInto) {
  if (!customerId) return;
  if (linkedAccounts(customerId).length) return;
  run("UPDATE customers SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ? AND status = 'active'", [mergedInto || null, nowISO(), customerId]);
}

// After an account is edited. Renaming an account that shares its profile
// takes it out of that profile (a different name is a different match); a
// lone account's profile simply follows the new name. Turning a customer
// account into a company account removes the profile link.
function afterAccountEdit(before, actor) {
  const acc = get("SELECT * FROM clients WHERE id = ?", [before.id]);
  if (!acc) return;
  if (acc.account_type !== "customer") {
    if (acc.customer_id) {
      run("UPDATE clients SET customer_id = NULL WHERE id = ?", [acc.id]);
      retireIfEmpty(acc.customer_id, null);
      addAudit(actor, "Customer account unlinked", `${acc.account_number} is now a company account — removed from its customer profile`);
    }
    return;
  }
  if (!acc.customer_id) { assignCustomer(acc.id, actor, "edit"); return; }
  if (nameKey(before.name) === nameKey(acc.name)) return;
  const siblings = linkedAccounts(acc.customer_id, acc.id);
  if (siblings.length) {
    const old = get("SELECT * FROM customers WHERE id = ?", [acc.customer_id]);
    run("UPDATE clients SET customer_id = NULL WHERE id = ?", [acc.id]);
    addAudit(actor, "Customer account unlinked", `${acc.account_number} renamed to "${acc.name}" — removed from ${old.customer_number} ${old.name}`);
    assignCustomer(acc.id, actor, "edit");
    return;
  }
  run("UPDATE customers SET name = ?, name_key = ?, updated_at = ? WHERE id = ?", [acc.name, nameKey(acc.name), nowISO(), acc.customer_id]);
  const ev = evaluate(acc);
  if (ev.confidence === "high") {
    const old = acc.customer_id;
    run("UPDATE clients SET customer_id = ? WHERE id = ?", [ev.customer.id, acc.id]);
    retireIfEmpty(old, ev.customer.id);
    addAudit(actor, "Customer accounts linked automatically", `${ev.customer.customer_number} ${ev.customer.name}: ${acc.account_number} ${acc.currency} joined after rename`);
  } else if (addReviews(acc, ev.reviews, "edit")) {
    addAudit(actor, "Customer match needs review", `${acc.account_number} ${acc.name} (${acc.currency}) after rename`);
  }
}

// Existing data: every customer account without a profile, oldest first,
// so the first account of a person founds the profile and later currency
// accounts are matched against it. Idempotent.
function backfill(actor = SYSTEM, source = "migration") {
  const pending = all("SELECT id FROM clients WHERE customer_id IS NULL AND deleted_at IS NULL AND account_type = 'customer' ORDER BY created_at ASC, id ASC");
  const out = { accounts: pending.length, linked: 0, needsReview: 0, noMatch: 0 };
  if (!pending.length) return out;
  tx(() => {
    for (const p of pending) {
      const r = assignCustomer(p.id, actor, source);
      if (r.skipped) continue;
      if (r.linked) out.linked += 1; else if (r.reviews) out.needsReview += 1; else out.noMatch += 1;
    }
  });
  addAudit(actor, source === "migration" ? "Customer profiles migrated" : "Customer profiles assigned", `${source}: ${out.accounts} account(s): ${out.linked} linked (high confidence), ${out.needsReview} need review, ${out.noMatch} no match`);
  return out;
}

const backfilled = new Set();
function ensureBackfilled(companyId) {
  const k = companyId || "default";
  if (backfilled.has(k)) return;
  backfill();
  backfilled.add(k);
}

// Manual link: account joins `customerId`. The caller checks permissions.
function linkAccount(customerId, clientId, actor, note) {
  const c = get("SELECT * FROM customers WHERE id = ?", [customerId]);
  if (!c || c.status !== "active") return { status: 404, error: "Customer profile not found." };
  const acc = get("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!acc || acc.deleted_at) return { status: 404, error: "Account not found." };
  if (acc.account_type !== "customer") return { status: 400, error: "Only customer accounts can be linked to a customer profile." };
  if (acc.customer_id === c.id) return { status: 400, error: `${acc.account_number} is already linked to ${c.customer_number}.` };
  const same = linkedAccounts(c.id, acc.id).find((o) => o.currency === acc.currency);
  if (same) return { status: 400, error: `${c.customer_number} already has a ${acc.currency} account (${same.account_number}). A profile holds one account per currency.` };
  const old = acc.customer_id;
  tx(() => {
    run("UPDATE clients SET customer_id = ? WHERE id = ?", [c.id, acc.id]);
    retireIfEmpty(old, c.id);
    run("UPDATE customer_link_reviews SET status = 'linked', resolved_at = ?, resolved_by = ?, resolution = ? WHERE client_id = ? AND status = 'pending' AND candidate_customer_id = ?",
      [nowISO(), actor.name, `Linked to ${c.customer_number}`, acc.id, c.id]);
    run("UPDATE customer_link_reviews SET status = 'dismissed', resolved_at = ?, resolved_by = ?, resolution = ? WHERE client_id = ? AND status = 'pending'",
      [nowISO(), actor.name, `Linked to ${c.customer_number} instead`, acc.id]);
  });
  addAudit(actor, "Customer account linked", `${acc.account_number} ${acc.name} (${acc.currency}) -> ${c.customer_number} ${c.name}${note ? ` — ${note}` : ""}`);
  return { status: 200 };
}

// Manual unlink: the account leaves the profile and gets its own.
function unlinkAccount(customerId, clientId, actor) {
  const c = get("SELECT * FROM customers WHERE id = ?", [customerId]);
  const acc = get("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!c || !acc || acc.customer_id !== c.id) return { status: 404, error: "That account is not linked to this customer profile." };
  if (!linkedAccounts(c.id, acc.id).length) return { status: 400, error: `${acc.account_number} is the only account on ${c.customer_number} — there is nothing to unlink it from.` };
  let fresh;
  tx(() => {
    fresh = createCustomer(acc.name, actor);
    run("UPDATE clients SET customer_id = ? WHERE id = ?", [fresh.id, acc.id]);
    // Remember the decision so the same pair is not proposed again.
    run("INSERT INTO customer_link_reviews (id, client_id, candidate_customer_id, reason, confidence, status, source, created_at, resolved_at, resolved_by, resolution) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [uid("clr"), acc.id, c.id, "Unlinked manually", "needs_review", "dismissed", "manual", nowISO(), nowISO(), actor.name, "Kept separate"]);
  });
  addAudit(actor, "Customer account unlinked", `${acc.account_number} ${acc.name} (${acc.currency}) removed from ${c.customer_number} — now ${fresh.customer_number}`);
  return { status: 200, customerId: fresh.id };
}

module.exports = { nameKey, looseKey, evaluate, assignCustomer, afterAccountEdit, backfill, ensureBackfilled, linkAccount, unlinkAccount, linkedAccounts, retireIfEmpty };
