"use strict";
const { isValidAmount, toNumber } = require("../util");
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, sendCSV, sendPDF, sendXLSX, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, allowedCurrencies } = require("../rbac");
const { getCurrentRate, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, findOrCreateClient, addAudit, effectiveStatus, quotationTotals, nextQuotationNumber, rebuildAccountBalance, nextQuotationPaymentReference, quotationPaymentSummary } = require("../domain");
const { uid, nowISO, todayStr, fmtMoney, resolvePaymentDate } = require("../util");
const PAYMENT_METHODS = ["Cash", "Bank", "Transfer", "Other"];
const { toCSV } = require("../csv");
const { renderReportPDF, renderQuotationDocumentPDF } = require("../pdf");
const { buildQuotationWorkbook } = require("../xlsx-documents");

// Thrown by createAndChargeQuotation() for an expected, user-facing problem
// (bad account, deactivated account, etc.) so route handlers can turn it
// into a 400 instead of it falling through to the generic 500 handler.
class QuotationChargeError extends Error {}

function loadItems(quotationId) {
  return all("SELECT * FROM quotation_items WHERE quotation_id = ?", [quotationId]);
}
// PARTIAL PAYMENT UPGRADE round: every payment ever recorded against this
// quotation, oldest first — the permanent Payment History the settlement
// modal, PDF, and Excel export all read from (never recomputed differently
// by each one — see quotationPaymentSummary in domain.js).
function loadPayments(quotationId) {
  return all("SELECT * FROM quotation_payments WHERE quotation_id = ? ORDER BY date ASC, created_at ASC, id ASC", [quotationId]);
}
function parseExtra(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}
function serialize(q) {
  const items = loadItems(q.id);
  const totals = quotationTotals(items, q.discount_percent, q.tax_percent, q.rate_used);
  const chargedAccount = q.charged_account_id ? get("SELECT id, name, account_number, currency FROM clients WHERE id = ?", [q.charged_account_id]) : null;
  // PARTIAL PAYMENT UPGRADE round: payments is the permanent Payment History
  // (section 5 of the spec); payment is the same quotationPaymentSummary()
  // math every other surface (table, PDF, Excel) reads from, so Paid/
  // Remaining/Status can never disagree between them. The quotation's own
  // charged_amount/currency (its ORIGINAL value) is never touched by any of
  // this — see createAndChargeQuotation/PATCH above, both completely
  // unchanged by this round.
  const payments = loadPayments(q.id);
  const payment = quotationPaymentSummary(q, payments);
  return {
    id: q.id, number: q.number, clientId: q.client_id, clientName: q.client_name, clientContact: q.client_contact, clientAddress: q.client_address,
    issueDate: q.issue_date, validUntil: q.valid_until, status: q.status, effectiveStatus: effectiveStatus(q),
    invoiced: !!q.invoiced, paid: !!q.paid, paidAt: q.paid_at, paidBy: q.paid_by, discountPercent: q.discount_percent, taxPercent: q.tax_percent, rateUsed: q.rate_used,
    currencyMode: q.currency_mode || (q.charged_currency === "SLSH" ? "SLSH" : "USD"),
    notes: q.notes, createdBy: q.created_by, createdByName: q.created_by_name, createdAt: q.created_at,
    updatedBy: q.updated_by, updatedByName: q.updated_by_name, updatedAt: q.updated_at,
    items: items.map((it) => ({ id: it.id, description: it.description, qty: it.qty, unitPrice: it.unit_price, currency: it.currency, extraFields: parseExtra(it.extra_fields) })),
    totals,
    charged: !!q.charged, chargedAt: q.charged_at, chargedBy: q.charged_by, chargedAmount: q.charged_amount, chargedCurrency: q.charged_currency,
    chargedAccount: chargedAccount ? { id: chargedAccount.id, name: chargedAccount.name, accountNumber: chargedAccount.account_number, currency: chargedAccount.currency } : null,
    refunded: !!q.refunded, refundedAt: q.refunded_at, refundedBy: q.refunded_by,
    originalAmount: payment.originalAmount, totalPaid: payment.totalPaid, remaining: payment.remaining, percentPaid: payment.percentPaid,
    payments: payments.map((p) => ({
      id: p.id, reference: p.reference_number, amount: p.amount, currency: p.currency, date: p.date,
      method: p.method, externalReference: p.reference, notes: p.notes, staffName: p.staff_name, createdAt: p.created_at,
      // QUOTATION PAYMENT INTEGRATION round (spec section 17 — "View
      // Transaction" from inside Payment History): the id of this payment's
      // OWN account_ledger row, so the frontend can jump straight to its
      // Transaction History detail rather than just its status tab.
      ledgerId: p.ledger_id,
    })),
  };
}
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "At least one line item is required.";
  for (const it of items) {
    if (!it.description || !it.description.trim()) return "Each item needs a description.";
    if (!it.currency || !["USD", "SLSH"].includes(it.currency)) return "Each item needs a currency (USD or SLSH).";
    // FULL SYSTEM AUDIT round: strict numbers (true / [5] are not a quantity).
    if (!(toNumber(it.qty) > 0)) return "Each item needs a quantity greater than 0.";
    if (Number.isNaN(toNumber(it.unitPrice))) return "Each item needs a valid numeric unit price.";
    if (!Number.isFinite(toNumber(it.qty)) || toNumber(it.qty) > 1e9 || !Number.isFinite(toNumber(it.unitPrice)) || Math.abs(toNumber(it.unitPrice)) > 1e12) return "An item quantity or unit price is too large.";
  }
  return null;
}
const VALID_CURRENCY_MODES = new Set(["USD", "SLSH", "BOTH"]);
// PROFESSIONAL QUOTATION CUSTOMIZATION & MULTI-CURRENCY SYSTEM round: when
// the quotation's currency mode is single-currency (USD or SLSH, not BOTH),
// every line item is forced to that same currency server-side — the
// frontend doesn't even offer a per-line currency picker in that mode, but
// this coercion is the actual source of truth, so a direct API call can
// never sneak in a mismatched line. In BOTH mode, each line keeps whatever
// currency it was given (already validated to be USD or SLSH).
function coerceItemCurrencies(items, currencyMode) {
  if (currencyMode === "BOTH") return items;
  return items.map((it) => ({ ...it, currency: currencyMode }));
}
// Shared WHERE-clause builder for GET /api/quotations, its CSV export, and
// anywhere else that needs to filter the same quotation list — used by the
// three status submenus (Pending/Paid/Refunded) in the sidebar plus the
// Account/Currency/Quotation Date/Valid Until/Amount/Search filters in the
// filter bar (see "FINAL QUOTATION MANAGEMENT SYSTEM"). `search` matches
// quotation number, customer name/contact/address, notes, or the charged
// account's own name/contact — a superset of the old, narrower `client`
// param (still accepted for backward compatibility).
// SECURITY & INTEGRITY AUDIT round: reading quotations now requires
// quotations.view (held by quotationsManage and quotationsApprove roles —
// exactly who the Quotations menu is shown to). Before, any signed-in user,
// e.g. a cashier or viewer, could list them, open them and export them by
// calling the API directly. A role limited to one currency sees only
// quotations charged in that currency, the same rule as Accounts.
function requireQuotationRead(user, res) {
  return requirePerm(user, res, "quotations.view");
}
function quotationVisible(user, q) {
  const allowed = allowedCurrencies(user);
  return !q.charged_currency || allowed.includes(q.charged_currency);
}
function buildQuotationFilter(query, user) {
  const clauses = [], params = [];
  if (user) {
    const allowed = allowedCurrencies(user);
    if (allowed.length === 0) clauses.push("1 = 0");
    else if (allowed.length < 2) { clauses.push(`(q.charged_currency IS NULL OR q.charged_currency IN (${allowed.map(() => "?").join(",")}))`); params.push(...allowed); }
  }
  if (query.status && query.status !== "all") { clauses.push("q.status = ?"); params.push(query.status); }
  const search = query.search || query.client;
  if (search) {
    clauses.push("(q.number LIKE ? OR q.client_name LIKE ? OR q.client_contact LIKE ? OR q.client_address LIKE ? OR q.notes LIKE ? OR ca.name LIKE ? OR ca.contact LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (query.currency && ["USD", "SLSH"].includes(query.currency)) { clauses.push("q.charged_currency = ?"); params.push(query.currency); }
  if (query.account) { clauses.push("ca.name LIKE ?"); params.push(`%${query.account}%`); }
  if (query.dateFrom) { clauses.push("q.issue_date >= ?"); params.push(query.dateFrom); }
  if (query.dateTo) { clauses.push("q.issue_date <= ?"); params.push(query.dateTo); }
  if (query.validFrom) { clauses.push("q.valid_until >= ?"); params.push(query.validFrom); }
  if (query.validTo) { clauses.push("q.valid_until <= ?"); params.push(query.validTo); }
  if (query.amountMin !== undefined && query.amountMin !== "" && !Number.isNaN(Number(query.amountMin))) { clauses.push("q.charged_amount >= ?"); params.push(Number(query.amountMin)); }
  if (query.amountMax !== undefined && query.amountMax !== "" && !Number.isNaN(Number(query.amountMax))) { clauses.push("q.charged_amount <= ?"); params.push(Number(query.amountMax)); }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}
function insertItems(quotationId, items) {
  for (const it of items) {
    run("INSERT INTO quotation_items (id, quotation_id, description, qty, unit_price, currency, extra_fields) VALUES (?,?,?,?,?,?,?)", [
      uid("it"), quotationId, it.description, toNumber(it.qty), toNumber(it.unitPrice), it.currency,
      it.extraFields && Object.keys(it.extraFields).length ? JSON.stringify(it.extraFields) : null,
    ]);
  }
}

// TWO-STEP ACCOUNT LEDGER LOGIC — the heart of the new quotation model.
// Every quotation is charged to a real account the instant it's created:
// this is the ONE place that happens, shared by both POST /api/quotations
// and the duplicate endpoint, so the two can never drift out of sync.
//
// "account to charge" defaults to the quotation's own client (every client
// row already IS an account — it has its own balance/currency), but can be
// overridden (e.g. someone else pays on the client's behalf). The currency
// withdrawn always matches that account's own currency (USD stays USD,
// SLSH stays SLSH — never mixed), and — per standing business policy — this
// never blocks for insufficient funds; an account may go into debt.
function createAndChargeQuotation({ user, clientName, clientContact, clientAddress, issueDate, validUntil, discountPercent, taxPercent, rateUsed, notes, items, accountId, currency: expectedCurrency, currencyMode }) {
  // currencyMode is the quotation DOCUMENT's own USD/SLSH/BOTH display mode
  // (spec section 4) — a separate concept from expectedCurrency (which
  // account currency actually gets charged, unchanged below). Falls back to
  // expectedCurrency for old callers/tests that don't pass it explicitly, so
  // a plain USD/SLSH quotation still gets a sensible single-currency mode
  // rather than silently defaulting to BOTH.
  const mode = VALID_CURRENCY_MODES.has(currencyMode) ? currencyMode : (expectedCurrency === "SLSH" ? "SLSH" : "USD");
  items = coerceItemCurrencies(items, mode);
  const clientId = findOrCreateClient(clientName, clientContact, clientAddress, expectedCurrency);
  // Use the resolved client's actual stored name (correct casing for its
  // account type — uppercase for a person, as-typed for a company) for the
  // denormalized client_name column, rather than the raw typed value.
  const resolvedClientName = clientId ? (get("SELECT name FROM clients WHERE id = ?", [clientId]) || {}).name || clientName : clientName;
  const targetAccountId = accountId || clientId;
  if (!targetAccountId) throw new QuotationChargeError("Choose an account to charge this quotation to.");
  const account = get("SELECT * FROM clients WHERE id = ?", [targetAccountId]);
  if (!account) throw new QuotationChargeError("The account to charge was not found.");
  if (account.deleted_at) throw new QuotationChargeError("The account to charge was not found.");
  if (account.status !== "active") throw new QuotationChargeError(`${account.name}'s account is deactivated — reactivate it before charging.`);
  // ACCOUNT / CLIENT SEARCH — CURRENCY SEPARATION (spec item 11): the
  // frontend's Currency selector drives which accounts are even searchable,
  // but a stale selection (or a direct API call) could still pair an
  // accountId with a mismatched currency — reject that here as well as
  // client-side, using the exact wording the spec requires.
  if (expectedCurrency && ["USD", "SLSH"].includes(expectedCurrency) && account.currency !== expectedCurrency) {
    throw new QuotationChargeError("Selected account currency does not match the transaction currency.");
  }

  const rate = rateUsed !== undefined && rateUsed !== "" && rateUsed !== null && Number(rateUsed) > 0 ? Number(rateUsed) : getCurrentRate();
  const totals = quotationTotals(items, discountPercent, taxPercent, rate);
  const currency = account.currency;
  const amount = currency === "USD" ? totals.totalUSD : totals.totalSLSH;

  const number = nextQuotationNumber();
  const id = uid("q");
  const ledgerId = uid("ldg");
  const now = nowISO();
  const quotation = tx(() => {
    run(
      `INSERT INTO quotations (
         id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until, status,
         invoiced, discount_percent, tax_percent, rate_used, currency_mode, notes,
         charged, charged_at, charged_by, charged_account_id, charged_amount, charged_currency, charged_ledger_id,
         created_by, created_by_name, created_at
       ) VALUES (?,?,?,?,?,?,?,?,'Pending',0,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
      [
        id, number, clientId, resolvedClientName, clientContact || null, clientAddress || null, issueDate || todayStr(), validUntil || null,
        Number(discountPercent) || 0, Number(taxPercent) || 0, rate, mode, notes || null,
        now, user.name, account.id, amount, currency, ledgerId,
        user.id, user.name, now,
      ]
    );
    insertItems(id, items);
    run(
      "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [ledgerId, account.id, "withdrawal", currency, amount, 0, `Quotation — ${number}`, user.id, user.name, now, "quotation_charge", id, number]
    );
    rebuildAccountBalance(account.id, currency);
    return get("SELECT * FROM quotations WHERE id = ?", [id]);
  });
  return { quotation, amount, currency, account };
}

function register(router) {
  router.get("/api/quotations", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const { where, params: sqlParams } = buildQuotationFilter(query, user);
    const rows = all(`SELECT q.* FROM quotations q LEFT JOIN clients ca ON ca.id = q.charged_account_id ${where} ORDER BY q.created_at DESC`, sqlParams);
    sendJSON(res, 200, { quotations: rows.map(serialize) });
  });

  // Live per-status counts for the sidebar's Pending/Paid/Refunded submenu
  // badges — computed straight from the database (never hard-coded), and
  // independent of whatever filters are currently applied in the list view
  // below, since the sidebar always reflects the true total per status.
  router.get("/api/quotations/counts", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const f = buildQuotationFilter({}, user);
    const rows = all(`SELECT q.status, COUNT(*) as n FROM quotations q ${f.where} GROUP BY q.status`, f.params);
    const counts = { Pending: 0, "Partially Paid": 0, Paid: 0, Refunded: 0 };
    rows.forEach((r) => { if (r.status in counts) counts[r.status] = r.n; });
    sendJSON(res, 200, counts);
  });

  // NOTE: literal routes like /export.csv must be registered before the
  // generic /:id route below, since the router matches in registration
  // order and :id would otherwise greedily match "export.csv" as an id.
  router.get("/api/quotations/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const { where, params: sqlParams } = buildQuotationFilter(query, user);
    const rows = all(`SELECT q.* FROM quotations q LEFT JOIN clients ca ON ca.id = q.charged_account_id ${where} ORDER BY q.created_at DESC`, sqlParams);
    const csv = toCSV(
      ["Number", "Client", "Issue date", "Valid until", "Status", "Total (USD)", "Total (SLSH)", "Created by"],
      rows.map((q) => {
        const items = loadItems(q.id);
        const t = quotationTotals(items, q.discount_percent, q.tax_percent, q.rate_used);
        return [q.number, q.client_name, q.issue_date, q.valid_until || "", effectiveStatus(q), t.totalUSD.toFixed(2), Math.round(t.totalSLSH), q.created_by_name];
      })
    );
    addAudit(user, "Quotations exported (CSV)", `${rows.length} quotation(s)`);
    sendCSV(res, "obo-quotations.csv", csv);
  });

  router.get("/api/quotations/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    // FIX: this used to run an unconditional `SELECT * FROM quotations`,
    // ignoring whatever status/search/currency/date/amount filters were
    // active — so exporting from, say, the "Paid" view (or any filtered
    // search) silently produced a PDF of every quotation in the system
    // instead of the filtered list the user was actually looking at. The
    // sibling /export.csv route already filtered correctly via
    // buildQuotationFilter(query, user); this now does the same, so PDF and CSV
    // (and the on-screen list) always agree on what "this view" means.
    const { where, params: sqlParams } = buildQuotationFilter(query, user);
    const rows = all(`SELECT q.* FROM quotations q LEFT JOIN clients ca ON ca.id = q.charged_account_id ${where} ORDER BY q.created_at DESC`, sqlParams);
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: "Quotations Summary",
      meta: `${rows.length} quotation(s)`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("quotation"),
      columns: [
        { label: "Number", width: 1.1 }, { label: "Client", width: 1.6 }, { label: "Status", width: 0.9 },
        { label: "Total (USD)", width: 1, align: "right" }, { label: "Total (SLSH)", width: 1.2, align: "right" },
      ],
      rows: rows.map((q) => {
        const items = loadItems(q.id);
        const t = quotationTotals(items, q.discount_percent, q.tax_percent, q.rate_used);
        return [q.number, q.client_name, effectiveStatus(q), `$${t.totalUSD.toFixed(2)}`, `SLSH ${Math.round(t.totalSLSH)}`];
      }),
    });
    addAudit(user, "Quotations exported (PDF)", `${rows.length} quotation(s)`);
    sendPDF(res, "obo-quotations.pdf", pdf);
  });

  // QUOTATION LINE-ITEM COLUMN DEFAULTS (spec items 12-14) — a system-wide
  // default for the "Customize Columns" line-item picker in the quotation
  // editor, mirroring routes/tableLayouts.js's own system-default/personal
  // split (same settings.manageTableDefaults permission gate) but stored on
  // company_settings instead, since a line-item column definition carries a
  // custom label alongside its key — richer than table_layouts' plain
  // columns_json array of keys. Reading is open to anyone who can reach the
  // quotation editor at all; only writing (setting the default for
  // everyone) requires the privileged permission. A personal per-user
  // override still lives separately at PATCH /api/auth/me/quotation-column-
  // prefs (routes/auth.js), completely unchanged — this is purely the
  // fallback shown to anyone who hasn't set one of their own.
  //
  // Registered BEFORE the generic "/api/quotations/:id" routes below — this
  // router matches routes in registration order and ":id" would otherwise
  // greedily swallow "column-defaults" as if it were a quotation id.
  router.get("/api/quotations/column-defaults", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    const settings = getCompanySettings();
    let columns = null;
    try { columns = settings && settings.quotation_column_defaults ? JSON.parse(settings.quotation_column_defaults) : null; } catch (e) { columns = null; }
    sendJSON(res, 200, { columns });
  });

  router.patch("/api/quotations/column-defaults", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "settings.manageTableDefaults")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const json = body.columns === null ? null : JSON.stringify(body.columns || {});
    run("UPDATE company_settings SET quotation_column_defaults = ? WHERE id = 1", [json]);
    addAudit(user, "Quotation column defaults changed", json ? "Updated the default line-item columns for all users" : "Reset to built-in defaults");
    const settings = getCompanySettings();
    let columns = null;
    try { columns = settings && settings.quotation_column_defaults ? JSON.parse(settings.quotation_column_defaults) : null; } catch (e) { columns = null; }
    sendJSON(res, 200, { columns });
  });

  router.get("/api/quotations/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q || !quotationVisible(user, q)) return notFound(res, "Quotation not found.");
    sendJSON(res, 200, { quotation: serialize(q) });
  });

  // Creating a quotation IS the charge — see createAndChargeQuotation()
  // above. There is no separate Draft stage and no separate "Charge
  // Account" step anymore: the instant this succeeds, a real Withdrawal has
  // already posted against the chosen account.
  router.post("/api/quotations", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!body.clientName) return badRequest(res, "clientName is required.");
    const itemErr = validateItems(body.items);
    if (itemErr) return badRequest(res, itemErr);
    if (body.rateUsed !== undefined && body.rateUsed !== "" && body.rateUsed !== null && !(toNumber(body.rateUsed) > 0 && toNumber(body.rateUsed) <= 1e9)) {
      return badRequest(res, "Rate must be a positive number.");
    }
    if (body.currencyMode !== undefined && body.currencyMode !== "" && body.currencyMode !== null && !VALID_CURRENCY_MODES.has(body.currencyMode)) {
      return badRequest(res, "currencyMode must be one of: USD, SLSH, BOTH.");
    }
    try {
      const { quotation, amount, currency, account } = createAndChargeQuotation({
        user, clientName: body.clientName, clientContact: body.clientContact, clientAddress: body.clientAddress,
        issueDate: body.issueDate, validUntil: body.validUntil, discountPercent: body.discountPercent, taxPercent: body.taxPercent,
        rateUsed: body.rateUsed, notes: body.notes, items: body.items, accountId: body.accountId, currency: body.currency,
        currencyMode: body.currencyMode,
      });
      addAudit(user, "Quotation created & charged", `${quotation.number}: ${fmtMoney(amount, currency)} debited from ${account.name}'s account`);
      sendJSON(res, 201, { quotation: serialize(quotation) });
    } catch (e) {
      if (e instanceof QuotationChargeError) return badRequest(res, e.message);
      throw e;
    }
  });

  // UPDATE — while a quotation is still Pending, its client, items, rate,
  // discount, and tax are all editable (the "FINAL QUOTATION MANAGEMENT
  // SYSTEM" spec's Update page). This never creates a second quotation —
  // the SAME record is updated in place, and any resulting change in the
  // charged amount is captured as a new "quotation adjustment" ledger entry
  // (a Withdrawal if the total went up, a Deposit if it went down) rather
  // than silently rewriting the original charge — history is never
  // rewritten, only ever added to. Once a quotation is Paid or Refunded,
  // its charge AND settlement have both already posted against those exact
  // figures, so items/rate/discount/tax lock again at that point (same as
  // before) — only contact/address/valid-until/notes stay editable; use
  // Duplicate to issue a revised version instead. The charged ACCOUNT is
  // never changeable here either way — Duplicate is also how to charge a
  // different account.
  router.patch("/api/quotations/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    const existing = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!existing) return notFound(res, "Quotation not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }

    if (body.accountId !== undefined && body.accountId !== existing.charged_account_id) {
      return badRequest(res, "The account a quotation is charged to can't be changed here — duplicate the quotation to charge a different account instead.");
    }
    const wantsFinancialEdit = body.items !== undefined || body.rateUsed !== undefined || body.discountPercent !== undefined || body.taxPercent !== undefined || body.currencyMode !== undefined;
    if (wantsFinancialEdit && existing.status !== "Pending") {
      return badRequest(res, "Items, rate, discount, and tax can only be changed while a quotation is still Pending — its charge (and, once settled, its settlement) has already posted against an account. Duplicate it to issue a revised version instead.");
    }
    if (body.currencyMode !== undefined && body.currencyMode !== "" && body.currencyMode !== null && !VALID_CURRENCY_MODES.has(body.currencyMode)) {
      return badRequest(res, "currencyMode must be one of: USD, SLSH, BOTH.");
    }

    let items, rateUsed, discountPercent, taxPercent, currencyMode;
    if (wantsFinancialEdit) {
      currencyMode = VALID_CURRENCY_MODES.has(body.currencyMode) ? body.currencyMode : (existing.currency_mode || "USD");
      items = body.items !== undefined ? body.items : loadItems(existing.id).map((it) => ({ description: it.description, qty: it.qty, unitPrice: it.unit_price, currency: it.currency, extraFields: parseExtra(it.extra_fields) }));
      items = coerceItemCurrencies(items, currencyMode);
      const itemErr = validateItems(items);
      if (itemErr) return badRequest(res, itemErr);
      // Exchange Rate is OPTIONAL/AUTO (spec items 3/11/19) — only USD-only or
      // SLSH-only accounts even use it for the charged amount (single-currency
      // conversion is a no-op, see util.js's convert()), so a missing/blank
      // rate here just falls back to the existing rate (or the live Daily
      // Rate at creation time) rather than blocking the save.
      rateUsed = body.rateUsed !== undefined && body.rateUsed !== "" && body.rateUsed !== null ? toNumber(body.rateUsed) : existing.rate_used;
      if (!(rateUsed > 0)) return badRequest(res, "Rate must be a positive number.");
      discountPercent = body.discountPercent !== undefined ? Number(body.discountPercent) : existing.discount_percent;
      taxPercent = body.taxPercent !== undefined ? Number(body.taxPercent) : existing.tax_percent;
    }

    let clientId = existing.client_id;
    let resolvedClientName = existing.client_name;
    if (body.clientName !== undefined && body.clientName !== null && String(body.clientName).trim() && String(body.clientName).trim() !== existing.client_name) {
      clientId = findOrCreateClient(body.clientName, body.clientContact ?? existing.client_contact, body.clientAddress ?? existing.client_address, existing.charged_currency) || existing.client_id;
      resolvedClientName = clientId ? (get("SELECT name FROM clients WHERE id = ?", [clientId]) || {}).name || body.clientName : body.clientName;
    }

    let adjustment = null;
    tx(() => {
      if (wantsFinancialEdit) {
        const totals = quotationTotals(items, discountPercent, taxPercent, rateUsed);
        const currency = existing.charged_currency;
        const newAmount = currency === "USD" ? totals.totalUSD : totals.totalSLSH;
        const diff = newAmount - existing.charged_amount;
        run("DELETE FROM quotation_items WHERE quotation_id = ?", [existing.id]);
        insertItems(existing.id, items);
        run("UPDATE quotations SET discount_percent=?, tax_percent=?, rate_used=?, currency_mode=?, charged_amount=? WHERE id=?", [discountPercent, taxPercent, rateUsed, currencyMode, newAmount, existing.id]);
        if (Math.abs(diff) > 0.001) {
          const account = get("SELECT * FROM clients WHERE id = ?", [existing.charged_account_id]);
          const type = diff > 0 ? "withdrawal" : "deposit";
          const amt = Math.abs(diff);
          run(
            "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("ldg"), account.id, type, currency, amt, 0, `Quotation adjustment — ${existing.number} (${diff > 0 ? "increased" : "decreased"} while Pending)`, user.id, user.name, nowISO(), "quotation_charge", existing.id, existing.number]
          );
          rebuildAccountBalance(account.id, currency);
          adjustment = { type, amount: amt, currency };
        }
      }
      run(
        "UPDATE quotations SET client_id=?, client_name=?, client_contact=?, client_address=?, issue_date=?, valid_until=?, notes=?, updated_by=?, updated_by_name=?, updated_at=? WHERE id=?",
        [clientId, resolvedClientName, body.clientContact ?? existing.client_contact, body.clientAddress ?? existing.client_address, body.issueDate ?? existing.issue_date, body.validUntil ?? existing.valid_until, body.notes ?? existing.notes, user.id, user.name, nowISO(), existing.id]
      );
    });
    const auditDetails = adjustment
      ? `${existing.number}: items/amount revised — ${adjustment.type === "withdrawal" ? "additional" : "reduced"} ${fmtMoney(adjustment.amount, adjustment.currency)} ${adjustment.type === "withdrawal" ? "debited from" : "credited back to"} the charged account`
      : existing.number;
    addAudit(user, "Quotation updated", auditDetails);
    sendJSON(res, 200, { quotation: serialize(get("SELECT * FROM quotations WHERE id = ?", [existing.id])) });
  });

  // PARTIAL PAYMENT UPGRADE round — RECORD PAYMENT: replaces the old
  // one-click "mark fully Paid" flow. A quotation can now receive any number
  // of legitimate payments, each one a REAL linked account_ledger Deposit
  // (never just a number bumped on the quotation row — spec section 6), until
  // the remaining balance reaches zero, at which point (and only then) the
  // quotation becomes Paid. The ORIGINAL charged_amount is never touched —
  // see serialize()/quotationPaymentSummary for how Paid/Remaining are
  // derived from the sum of these rows instead (spec sections 1/7/20).
  function recordQuotationPayment(user, q, { amount, date, method, reference, notes }) {
    if (q.status === "Refunded") throw new QuotationChargeError("This quotation has already been refunded — it cannot receive further payments.");
    const amt = Number(amount);
    if (!(amt > 0)) throw new QuotationChargeError("Payment amount must be greater than 0.");
    if (!isValidAmount(amt)) throw new QuotationChargeError("Payment amount is too large.");
    const existingPayments = loadPayments(q.id);
    const before = quotationPaymentSummary(q, existingPayments);
    // Section 3: never allow a payment beyond the remaining balance — a small
    // epsilon absorbs float rounding on the exact "pay remaining" shortcut.
    if (amt > before.remaining + 0.005) {
      throw new QuotationChargeError(`Payment exceeds the remaining quotation balance. Remaining: ${fmtMoney(before.remaining, q.charged_currency)}.`);
    }
    const paymentDate = resolvePaymentDate(date);
    if (paymentDate === null) throw new QuotationChargeError("Enter a valid Payment Date.");
    const account = get("SELECT * FROM clients WHERE id = ?", [q.charged_account_id]);
    if (!account) throw new QuotationChargeError("The originally charged account no longer exists.");
    const methodResolved = PAYMENT_METHODS.includes(method) ? method : "Cash";
    const payRef = nextQuotationPaymentReference();
    const paymentId = uid("qp");
    const ledgerId = uid("ldg");
    const now = nowISO();
    tx(() => {
      run(
        "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [ledgerId, account.id, "deposit", q.charged_currency, amt, 0, `Quotation Payment — ${q.number} (${methodResolved})`, user.id, user.name, paymentDate, now, "quotation_paid", q.id, payRef]
      );
      rebuildAccountBalance(account.id, q.charged_currency);
      run(
        "INSERT INTO quotation_payments (id, quotation_id, reference_number, amount, currency, date, method, reference, notes, staff_id, staff_name, ledger_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [paymentId, q.id, payRef, amt, q.charged_currency, paymentDate, methodResolved, reference || null, notes || null, user.id, user.name, ledgerId, now]
      );
      const after = quotationPaymentSummary(q, [...existingPayments, { amount: amt }]);
      run("UPDATE quotations SET status=?, paid=?, paid_at=?, paid_by=?, paid_ledger_id=? WHERE id=?", [
        after.computedStatus,
        after.computedStatus === "Paid" ? 1 : 0,
        after.computedStatus === "Paid" ? now : q.paid_at,
        after.computedStatus === "Paid" ? user.name : q.paid_by,
        after.computedStatus === "Paid" ? ledgerId : q.paid_ledger_id,
        q.id,
      ]);
    });
    addAudit(user, "Quotation payment recorded", `${q.number}: ${fmtMoney(amt, q.charged_currency)} received via ${methodResolved} (${payRef})`);
    return payRef;
  }

  router.post("/api/quotations/:id/payments", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q) return notFound(res, "Quotation not found.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    try {
      recordQuotationPayment(user, q, { amount: body.amount, date: body.date, method: body.method, reference: body.reference, notes: body.notes });
      sendJSON(res, 201, { quotation: serialize(get("SELECT * FROM quotations WHERE id = ?", [q.id])) });
    } catch (e) {
      if (e instanceof QuotationChargeError) return badRequest(res, e.message);
      throw e;
    }
  });

  // QUOTATION PAYMENT DELETE round: permanently removes ONE payment record
  // from a quotation (not the whole quotation document — that's the
  // existing DELETE /api/quotations/:id below) — and, since every real
  // payment recordQuotationPayment() posts is also a REAL linked
  // account_ledger Deposit (source_type='quotation_paid'), reverses that
  // same ledger entry and rebuilds the account's balance so deleting a
  // mistaken/duplicate payment actually undoes the money movement, not just
  // the paperwork. The quotation's status/paid/paid_at/paid_by/
  // paid_ledger_id are then recomputed from whatever payments remain, via
  // the exact same quotationPaymentSummary() every other surface already
  // trusts — so a quotation that was Paid correctly drops back to
  // Partially Paid or Pending the moment the payment that completed it is
  // removed.
  //
  // Gated by a brand-new, granular-only permission (quotations.deletePayment
  // — no legacy coarse-key equivalent, same precedent as cash.*/loans.*):
  // a Super Admin always has it automatically (ALL_ACCESS bypass), and it
  // is NOT auto-granted to Admin or any other role — a Super Admin must
  // explicitly turn it on per role (or per user) from Settings > Users &
  // Roles > Roles, same place every other granular permission is assigned.
  //
  // A Refunded quotation's payments are left alone — refund-charge already
  // posts its own separate reversal ledger entry on TOP of whatever was
  // paid, so deleting a payment underneath a completed refund would
  // desynchronize that reversal from what was actually received.
  router.delete("/api/quotations/:id/payments/:paymentId", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotations.deletePayment")) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q) return notFound(res, "Quotation not found.");
    if (q.status === "Refunded") return badRequest(res, "This quotation has been refunded — its payment records can no longer be deleted.");
    const payment = get("SELECT * FROM quotation_payments WHERE id = ? AND quotation_id = ?", [params.paymentId, q.id]);
    if (!payment) return notFound(res, "Payment not found.");
    const account = get("SELECT * FROM clients WHERE id = ?", [q.charged_account_id]);
    tx(() => {
      run("DELETE FROM quotation_payments WHERE id = ?", [payment.id]);
      if (payment.ledger_id) run("DELETE FROM account_ledger WHERE id = ?", [payment.ledger_id]);
      if (account) rebuildAccountBalance(account.id, q.charged_currency);
      // BUGFIX: quotationPaymentSummary() has a legacy fallback — "a
      // quotation whose stored status is already 'Paid' with ZERO
      // quotation_payments rows must predate this table, so treat it as
      // fully paid anyway" (see its own comment in domain.js). That
      // fallback is exactly wrong here: `q` is the row as it was BEFORE
      // this delete, so a quotation that just had its one-and-only payment
      // removed looks identical to that legacy case (status still "Paid",
      // zero rows left) and would wrongly stay "Paid" with the money it no
      // longer has. This delete is real modern data, never the legacy
      // case, so the fallback must never fire here — passing a
      // post-delete status that's neither "Paid" nor "Refunded" disables
      // it (q.status === "Refunded" was already rejected above, so this
      // never masks a real Refunded quotation).
      const after = quotationPaymentSummary({ ...q, status: q.status === "Paid" ? "Partially Paid" : q.status }, loadPayments(q.id));
      run("UPDATE quotations SET status=?, paid=?, paid_at=?, paid_by=?, paid_ledger_id=? WHERE id=?", [
        after.computedStatus,
        after.computedStatus === "Paid" ? 1 : 0,
        after.computedStatus === "Paid" ? (q.paid_at || nowISO()) : null,
        after.computedStatus === "Paid" ? q.paid_by : null,
        after.computedStatus === "Paid" ? q.paid_ledger_id : null,
        q.id,
      ]);
    });
    addAudit(user, "Quotation payment deleted", `${q.number}: ${fmtMoney(payment.amount, payment.currency)} payment (${payment.reference_number}) permanently removed — account balance reversed`);
    sendJSON(res, 200, { ok: true, quotation: serialize(get("SELECT * FROM quotations WHERE id = ?", [q.id])) });
  });

  // Kept for backward compatibility with anything still calling the old
  // one-click endpoint — now just records a single payment for the FULL
  // remaining balance, going through the exact same recordQuotationPayment()
  // path (and therefore the exact same validation/ledger/status logic) as a
  // partial payment would.
  router.post("/api/quotations/:id/pay", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q) return notFound(res, "Quotation not found.");
    const before = quotationPaymentSummary(q, loadPayments(q.id));
    if (before.remaining <= 0) return badRequest(res, "This quotation has no remaining balance to pay.");
    try {
      recordQuotationPayment(user, q, { amount: before.remaining, date: todayStr(), method: "Cash" });
      sendJSON(res, 200, { quotation: serialize(get("SELECT * FROM quotations WHERE id = ?", [q.id])) });
    } catch (e) {
      if (e instanceof QuotationChargeError) return badRequest(res, e.message);
      throw e;
    }
  });

  // REFUND — the other possible settlement: void the quotation and credit
  // the originally withdrawn amount straight back, as a NEW ledger entry
  // (history is never rewritten). Terminal — a quotation can only be
  // refunded once. PARTIAL PAYMENT UPGRADE round: previously blocked once a
  // quotation was already Paid; now that a quotation may carry any number of
  // partial payments (or be fully Paid) before something goes wrong with the
  // job and money needs to go back, refund is allowed from Pending,
  // Partially Paid, or Paid alike — every quotation_payments row already
  // recorded stays exactly as it is (spec section 13: "Do NOT delete payment
  // records when a refund is made"), and the quotation's own payment history
  // keeps showing them; only its status becomes Refunded and its Remaining
  // reads 0 (see quotationPaymentSummary).
  router.post("/api/quotations/:id/refund-charge", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q) return notFound(res, "Quotation not found.");
    if (q.status === "Refunded") return badRequest(res, "This quotation has already been refunded — it cannot be refunded twice.");
    // Reverse only what's still OUTSTANDING (charged_amount minus whatever
    // has already been paid via recordQuotationPayment above), never the
    // full original charged_amount unconditionally — crediting the full
    // amount back on top of payments already separately deposited would
    // double-credit the account for anything already paid. A quotation with
    // nothing paid yet behaves exactly as before (remaining = the whole
    // charge). A quotation that's already fully Paid has nothing outstanding
    // left to cancel — refunding money already fully received back to a
    // customer is a real cash Withdrawal, not a charge-cancellation, so it's
    // handled via the existing Payment > Withdraw flow instead of here.
    const outstanding = quotationPaymentSummary(q, loadPayments(q.id)).remaining;
    if (outstanding <= 0) {
      return badRequest(res, "This quotation is already fully paid — there is no outstanding charge left to refund. To return money already received, record it as a Debit from the account instead.");
    }
    const account = get("SELECT * FROM clients WHERE id = ?", [q.charged_account_id]);
    if (!account) return notFound(res, "The originally charged account no longer exists.");
    tx(() => {
      run(
        "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("ldg"), account.id, "deposit", q.charged_currency, outstanding, 0, `Refund — quotation charge reversed (${q.number})`, user.id, user.name, nowISO(), "quotation_refund", q.id, q.number]
      );
      rebuildAccountBalance(account.id, q.charged_currency);
      run("UPDATE quotations SET status='Refunded', refunded=1, refunded_at=?, refunded_by=? WHERE id=?", [nowISO(), user.name, q.id]);
    });
    addAudit(user, "Quotation refunded", `${q.number}: ${fmtMoney(outstanding, q.charged_currency)} back to ${account.name}'s account`);
    sendJSON(res, 200, { quotation: serialize(get("SELECT * FROM quotations WHERE id = ?", [q.id])) });
  });

  // Removes a quotation entirely — for ANY status (Pending, Paid, or
  // Refunded). Per the "FINAL QUOTATION MANAGEMENT SYSTEM" spec: deleting a
  // quotation is a RECORD MANAGEMENT operation, not a financial one, and
  // must never be confused with Refund. So this NEVER touches the account
  // balance and NEVER touches the account_ledger rows the quotation
  // produced (the charge, and — once settled — the settlement) — those are
  // genuine financial history and stay exactly as they are, permanently,
  // falling back to showing on their own (via their own reference_number)
  // once their parent quotation document is gone (see accounts.js's
  // activity-feed logic). Only the quotation document and its line items
  // are removed.
  //
  // Note this means deleting a still-Pending quotation leaves its original
  // Withdrawal permanently outstanding in the ledger with no document left
  // to explain it — that's accepted and intentional per the spec (deletion
  // must work "regardless of its current status," and must not "silently
  // destroy financial transaction history" or "automatically alter account
  // balances" either way); the frontend's confirmation modal calls this out
  // explicitly so it's never a surprise.
  //
  // Gated by BOTH quotationsManage (day-to-day quotation access) AND the
  // stricter quotationsDelete (permanent-delete specifically) — the same
  // two-tier pattern as accountsManage/accountsDelete. An optional
  // free-text `reason` is recorded in the audit log alongside the
  // quotation's financial details (account, customer, amount, previous
  // status) before the row is removed.
  router.delete("/api/quotations/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    if (!requirePerm(user, res, "quotationsDelete")) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q) return notFound(res, "Quotation not found.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* reason is optional */ }
    const account = q.charged_account_id ? get("SELECT id, name FROM clients WHERE id = ?", [q.charged_account_id]) : null;
    tx(() => {
      run("DELETE FROM quotation_items WHERE quotation_id = ?", [q.id]);
      run("DELETE FROM quotations WHERE id = ?", [q.id]);
    });
    addAudit(
      user,
      "Quotation deleted",
      `${q.number} for ${q.client_name} — Account: ${account ? `${account.name} (${account.id})` : "n/a"}, Customer ID: ${q.client_id || "n/a"}, Amount: ${fmtMoney(q.charged_amount, q.charged_currency)}, Previous status: ${q.status}, Reason: ${body && body.reason ? body.reason : "not specified"}`
    );
    sendJSON(res, 200, { deleted: true, id: q.id });
  });

  // Duplicating a quotation creates a brand-new one — which, like any other
  // quotation, is charged to an account the instant it's created. Defaults
  // to charging the SAME account the original was charged to, but an
  // optional body.accountId can point it at a different one.
  router.post("/api/quotations/:id/duplicate", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "quotationsManage")) return;
    const src = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!src) return notFound(res, "Quotation not found.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* accountId is optional */ }
    const items = loadItems(src.id).map((it) => ({ description: it.description, qty: it.qty, unitPrice: it.unit_price, currency: it.currency, extraFields: parseExtra(it.extra_fields) }));
    try {
      const { quotation, amount, currency, account } = createAndChargeQuotation({
        user, clientName: src.client_name, clientContact: src.client_contact, clientAddress: src.client_address,
        issueDate: todayStr(), validUntil: null, discountPercent: src.discount_percent, taxPercent: src.tax_percent,
        rateUsed: getCurrentRate(), notes: src.notes, items, accountId: body.accountId || src.charged_account_id,
        currencyMode: src.currency_mode,
      });
      addAudit(user, "Quotation duplicated & charged", `${quotation.number} copied from ${src.number}: ${fmtMoney(amount, currency)} debited from ${account.name}'s account`);
      sendJSON(res, 201, { quotation: serialize(quotation) });
    } catch (e) {
      if (e instanceof QuotationChargeError) return badRequest(res, e.message);
      throw e;
    }
  });

  router.get("/api/quotations/:id/pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q || !quotationVisible(user, q)) return notFound(res, "Quotation not found.");
    const items = loadItems(q.id);
    const totals = quotationTotals(items, q.discount_percent, q.tax_percent, q.rate_used);
    let columns = null;
    if (query && query.columns) {
      try { columns = JSON.parse(query.columns); if (!Array.isArray(columns)) columns = null; } catch (e) { columns = null; }
    }
    // MASTER PROMPT: every quotation PDF now renders through the shared
    // Professional Document Engine (renderQuotationDocumentPDF, built on
    // renderProfessionalDocument in pdf.js) instead of the old bespoke
    // renderQuotationPDF, while still respecting whichever "quotation" PDF
    // Template is currently the default (falls back to sensible defaults if
    // none is set, which can't actually happen post-seed).
    const template = getDefaultPdfTemplate("quotation");
    const paymentRows = loadPayments(q.id);
    const payment = quotationPaymentSummary(q, paymentRows);
    const pdf = await renderQuotationDocumentPDF({
      quotation: q, items, totals, statusLabel: payment.computedStatus, company: getCompanySettings(), columns, template, generatedBy: user.name,
      payment, payments: paymentRows.map((p) => ({ amount: p.amount, currency: p.currency, date: p.date, method: p.method, staffName: p.staff_name, reference: p.reference_number, externalReference: p.reference })),
    });
    addAudit(user, "Quotation exported (PDF)", q.number);
    sendPDF(res, `${q.number}.pdf`, pdf);
  });

  // MASTER PROMPT: new genuinely-editable Excel counterpart of the PDF
  // above, built from the exact same quotation/items/totals/template data
  // (never separately recomputed) via the shared xlsx-engine.
  router.get("/api/quotations/:id/xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requireQuotationRead(user, res)) return;
    const q = get("SELECT * FROM quotations WHERE id = ?", [params.id]);
    if (!q || !quotationVisible(user, q)) return notFound(res, "Quotation not found.");
    const items = loadItems(q.id);
    const totals = quotationTotals(items, q.discount_percent, q.tax_percent, q.rate_used);
    let columns = null;
    if (query && query.columns) {
      try { columns = JSON.parse(query.columns); if (!Array.isArray(columns)) columns = null; } catch (e) { columns = null; }
    }
    const template = getDefaultExcelTemplate("quotation");
    const paymentRows2 = loadPayments(q.id);
    const payment2 = quotationPaymentSummary(q, paymentRows2);
    const xlsx = await buildQuotationWorkbook({
      quotation: q, items, totals, statusLabel: payment2.computedStatus, company: getCompanySettings(), columns, template, generatedBy: user.name,
      payment: payment2, payments: paymentRows2.map((p) => ({ amount: p.amount, currency: p.currency, date: p.date, method: p.method, staffName: p.staff_name, reference: p.reference_number, externalReference: p.reference })),
    });
    addAudit(user, "Quotation exported (Excel)", q.number);
    sendXLSX(res, `${q.number}.xlsx`, xlsx);
  });

}

module.exports = { register, serialize };
