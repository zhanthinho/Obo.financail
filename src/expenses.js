"use strict";
// COMPANY EXPENSES round — the accounting service behind routes/expenses.js.
//
// Accounting model (follows the existing Cash in Hand ledger, see the
// expenses table note in schema.sql):
//   * An expense is paid out of ONE active Cash in Hand account (bank,
//     mobile money or physical cash) — the company's own money. Customer
//     accounts (`clients`) are never touched: they hold money owed to/by
//     customers, not the company's spending money.
//   * Posting writes the expense row AND exactly one cash_ledger withdrawal
//     (source_type 'expense', source_id = expense id) in a single database
//     transaction, then replays the account with the existing
//     rebuildCashAccountBalance — the one authoritative balance calculation.
//   * Editing a posted expense updates that same withdrawal in place (amount,
//     account, date, description) and replays every account involved — the
//     same convention a Payment edit uses for its own cash leg.
//   * Cancelling never deletes: it posts one reversing deposit (source_type
//     'expense_reversal') and marks the expense cancelled. A cancelled
//     expense can be neither edited nor cancelled again.
//   * USD and SLSH are never added together and no exchange rate is used.
const { all, get, run, tx } = require("./db");
const domain = require("./domain");
const { uid, nowISO, resolvePaymentDate, fmtMoney } = require("./util");

class ExpenseError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (msg, code) => new ExpenseError(400, msg, code);
const notFound = (msg) => new ExpenseError(404, msg);

const CURRENCIES = ["USD", "SLSH"];
const MAX_AMOUNT = 1e12;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const ATTACHMENT_TYPES = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

// Money is kept to 2 decimals (the same precision fmtMoney shows), so a total
// can never drift from the balances by a fraction of a cent.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function nextExpenseReference() {
  const year = new Date().getFullYear();
  const prefix = `EXP-${year}-`;
  const row = get("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM expenses WHERE reference_number LIKE ?", [prefix.length + 1, prefix + "%"]);
  return `${prefix}${String((row?.n || 0) + 1).padStart(4, "0")}`;
}

function ledgerDescription(categoryName, description) {
  return `Expense — ${categoryName}: ${description}`.slice(0, 500);
}

/* ------------------------------ validation ------------------------------ */
function cleanText(v, max) {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}
// Validates (and normalises) every field of a create/edit body. `existing`
// is the current row on an edit — absent fields keep their current value.
function validateInput(body, existing) {
  const b = body || {};
  const pick = (k, cur) => (b[k] !== undefined ? b[k] : cur);

  const dateIn = pick("date", existing ? existing.date : undefined);
  if (dateIn === undefined || dateIn === null || String(dateIn).trim() === "") throw bad("Expense Date is required.", "date");
  const date = resolvePaymentDate(dateIn);
  if (date === null || !/^\d{4}-\d{2}-\d{2}/.test(date)) throw bad("Enter a valid Expense Date.", "date");

  const categoryId = pick("categoryId", existing ? existing.category_id : undefined);
  if (!categoryId) throw bad("Expense Category is required.", "categoryId");
  const category = get("SELECT * FROM expense_categories WHERE id = ?", [String(categoryId)]);
  if (!category) throw bad("Choose a valid Expense Category.", "categoryId");
  // An archived category stays valid for the expenses that already use it,
  // but can't be picked for a new expense or a change of category.
  if (category.status !== "active" && (!existing || existing.category_id !== category.id)) throw bad(`${category.name} is archived — choose another category.`, "categoryId");

  const description = cleanText(pick("description", existing ? existing.description : ""), 500);
  if (!description) throw bad("Description is required.", "description");

  const amountIn = pick("amount", existing ? existing.amount : undefined);
  if (amountIn === undefined || amountIn === null || String(amountIn).trim() === "") throw bad("Amount is required.", "amount");
  const amountNum = typeof amountIn === "number" ? amountIn : Number(String(amountIn).replace(/,/g, ""));
  if (!Number.isFinite(amountNum)) throw bad("Amount must be a number.", "amount");
  if (amountNum <= 0) throw bad("Amount must be greater than zero.", "amount");
  if (amountNum > MAX_AMOUNT) throw bad("Amount is too large.", "amount");
  const amount = round2(amountNum);
  if (amount <= 0) throw bad("Amount must be greater than zero.", "amount");

  const currency = pick("currency", existing ? existing.currency : undefined);
  if (!CURRENCIES.includes(currency)) throw bad("Currency must be USD or SLSH.", "currency");

  const cashAccountId = pick("cashAccountId", existing ? existing.cash_account_id : undefined);
  if (!cashAccountId) throw bad("Paid From Account is required.", "cashAccountId");
  // Company isolation: this query runs against the CURRENT company's own
  // database only, so an account id from any other company simply does not
  // exist here.
  const account = get("SELECT * FROM cash_accounts WHERE id = ?", [String(cashAccountId)]);
  if (!account) throw bad("Paid From Account was not found.", "cashAccountId");
  if (account.status !== "active" && (!existing || existing.cash_account_id !== account.id)) throw bad(`${account.name} is deactivated — choose another account.`, "cashAccountId");
  if (account.currency !== currency) throw bad(`${account.name} is a ${account.currency} account — this expense is in ${currency}.`, "cashAccountId");

  const externalReference = cleanText(pick("externalReference", existing ? existing.external_reference : ""), 100) || null;
  const notes = cleanText(pick("notes", existing ? existing.notes : ""), 2000) || null;
  return { date, category, description, amount, currency, account, externalReference, notes };
}

// Optional receipt: { fileName, dataUrl } (PNG, JPEG or PDF, max 3 MB).
function validateAttachment(att) {
  if (att === undefined) return undefined; // not touched
  if (att === null) return null;           // remove
  if (typeof att !== "object" || typeof att.dataUrl !== "string") throw bad("The receipt file could not be read.", "attachment");
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(att.dataUrl);
  if (!m || !ATTACHMENT_TYPES[m[1].toLowerCase()]) throw bad("Receipt must be a PNG, JPEG or PDF file.", "attachment");
  const mime = m[1].toLowerCase();
  const data = m[2].replace(/\s+/g, "");
  const buf = Buffer.from(data, "base64");
  if (!buf.length) throw bad("The receipt file is empty.", "attachment");
  if (buf.length > MAX_ATTACHMENT_BYTES) throw bad("Receipt file is too large (maximum 3 MB).", "attachment");
  // Check the real file signature, not just the declared type.
  const sig = buf.slice(0, 5).toString("latin1");
  const ok = (mime === "image/png" && buf[0] === 0x89 && sig.slice(1, 4) === "PNG")
    || (mime === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8)
    || (mime === "application/pdf" && sig === "%PDF-");
  if (!ok) throw bad("The receipt file's contents do not match its type.", "attachment");
  let fileName = cleanText(att.fileName, 120).replace(/[\\/:*?"<>|\r\n]+/g, "_");
  if (!fileName) fileName = `receipt.${ATTACHMENT_TYPES[mime]}`;
  return { fileName, mime, size: buf.length, data };
}

function saveAttachment(expenseId, att, user) {
  if (att === undefined) return;
  run("DELETE FROM expense_attachments WHERE expense_id = ?", [expenseId]);
  if (att === null) return;
  run("INSERT INTO expense_attachments (id, expense_id, file_name, mime_type, size_bytes, data_base64, uploaded_by_id, uploaded_by_name, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [uid("expatt"), expenseId, att.fileName, att.mime, att.size, att.data, user.id, user.name, nowISO()]);
}

/* -------------------------------- reading -------------------------------- */
function toJSON(e, extra = {}) {
  if (!e) return null;
  const acct = get("SELECT id, name, type, currency, status FROM cash_accounts WHERE id = ?", [e.cash_account_id]);
  return {
    id: e.id, referenceNumber: e.reference_number, date: e.date,
    categoryId: e.category_id, categoryName: e.category_name,
    description: e.description, amount: e.amount, currency: e.currency,
    cashAccountId: e.cash_account_id,
    cashAccount: acct ? { id: acct.id, name: acct.name, type: acct.type, currency: acct.currency, status: acct.status } : null,
    externalReference: e.external_reference, notes: e.notes, status: e.status,
    createdById: e.created_by_id, createdByName: e.created_by_name, createdAt: e.created_at,
    updatedByName: e.updated_by_name, updatedAt: e.updated_at,
    cancelledAt: e.cancelled_at, cancelledByName: e.cancelled_by_name, cancelReason: e.cancel_reason,
    ...extra,
  };
}
function attachmentMeta(expenseId) {
  const a = get("SELECT id, file_name, mime_type, size_bytes, uploaded_by_name, uploaded_at FROM expense_attachments WHERE expense_id = ?", [expenseId]);
  return a ? { fileName: a.file_name, mimeType: a.mime_type, size: a.size_bytes, uploadedByName: a.uploaded_by_name, uploadedAt: a.uploaded_at } : null;
}
function detail(id) {
  const e = get("SELECT * FROM expenses WHERE id = ?", [id]);
  if (!e) return null;
  const leg = e.cash_ledger_id ? get("SELECT id, reference_number, type, amount, currency, date, balance_after FROM cash_ledger WHERE id = ?", [e.cash_ledger_id]) : null;
  const rev = e.reversal_ledger_id ? get("SELECT id, reference_number, type, amount, currency, date, balance_after FROM cash_ledger WHERE id = ?", [e.reversal_ledger_id]) : null;
  const legJSON = (l) => (l ? { id: l.id, referenceNumber: l.reference_number, type: l.type, amount: l.amount, currency: l.currency, date: l.date, balanceAfter: l.balance_after } : null);
  return toJSON(e, { ledgerEntry: legJSON(leg), reversalEntry: legJSON(rev), attachment: attachmentMeta(e.id) });
}

/* ------------------------------- posting -------------------------------- */
function createExpense(user, body) {
  const clientRequestId = body && typeof body.clientRequestId === "string" ? body.clientRequestId.trim().slice(0, 80) : "";
  if (clientRequestId) {
    const prior = get("SELECT * FROM expenses WHERE client_request_id = ?", [clientRequestId]);
    if (prior) {
      if (prior.created_by_id !== user.id) throw new ExpenseError(409, "This request id was already used.");
      return { expense: detail(prior.id), duplicate: true };
    }
  }
  const v = validateInput(body, null);
  const att = validateAttachment(body.attachment);
  const id = uid("exp");
  const now = nowISO();
  const result = tx(() => {
    // Re-checked inside the transaction so two identical requests racing each
    // other can still only ever post once.
    if (clientRequestId) {
      const prior = get("SELECT id FROM expenses WHERE client_request_id = ?", [clientRequestId]);
      if (prior) return { duplicateId: prior.id };
    }
    const reference = nextExpenseReference();
    const legId = uid("csl");
    run(`INSERT INTO expenses (id, reference_number, client_request_id, date, category_id, category_name, description, amount, currency, cash_account_id, external_reference, notes, cash_ledger_id, status, created_by_id, created_by_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'posted', ?,?,?)`,
      [id, reference, clientRequestId || null, v.date, v.category.id, v.category.name, v.description, v.amount, v.currency, v.account.id, v.externalReference, v.notes, legId, user.id, user.name, now]);
    run(`INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, reference, counterparty_label, staff_id, staff_name, date, created_at, source_type, source_id)
         VALUES (?,?, 'withdrawal', ?,?, 0, ?,?,?,?,?,?,?,?, 'expense', ?)`,
      [legId, v.account.id, v.currency, v.amount, ledgerDescription(v.category.name, v.description), domain.nextCashLedgerReference("withdrawal"), reference, v.category.name, user.id, user.name, v.date, now, id]);
    saveAttachment(id, att, user);
    domain.rebuildCashAccountBalance(v.account.id);
    return { reference };
  });
  if (result.duplicateId) return { expense: detail(result.duplicateId), duplicate: true };
  domain.addAudit(user, "Expense recorded", `${result.reference} — ${fmtMoney(v.amount, v.currency)} ${v.category.name} from ${v.account.name}`);
  return { expense: detail(id), duplicate: false };
}

function updateExpense(user, id, body) {
  const existing = get("SELECT * FROM expenses WHERE id = ?", [id]);
  if (!existing) throw notFound("Expense not found.");
  if (existing.status !== "posted") throw bad("A cancelled expense can't be edited.");
  const v = validateInput(body, existing);
  const att = validateAttachment(body.attachment);
  const now = nowISO();
  const changes = [];
  if (v.amount !== existing.amount || v.currency !== existing.currency) changes.push(`amount ${fmtMoney(existing.amount, existing.currency)} -> ${fmtMoney(v.amount, v.currency)}`);
  if (v.account.id !== existing.cash_account_id) changes.push("paid-from account changed");
  if (v.date !== existing.date) changes.push(`date ${existing.date} -> ${v.date}`);
  if (v.category.id !== existing.category_id) changes.push(`category ${existing.category_name} -> ${v.category.name}`);
  if (v.description !== existing.description) changes.push("description changed");
  if (att !== undefined) changes.push(att === null ? "receipt removed" : "receipt replaced");
  tx(() => {
    run(`UPDATE expenses SET date=?, category_id=?, category_name=?, description=?, amount=?, currency=?, cash_account_id=?, external_reference=?, notes=?, updated_by_id=?, updated_by_name=?, updated_at=? WHERE id=?`,
      [v.date, v.category.id, v.category.name, v.description, v.amount, v.currency, v.account.id, v.externalReference, v.notes, user.id, user.name, now, id]);
    const leg = existing.cash_ledger_id ? get("SELECT * FROM cash_ledger WHERE id = ?", [existing.cash_ledger_id]) : null;
    if (!leg) throw new ExpenseError(500, "This expense's cash movement is missing — it can't be edited safely.");
    run(`UPDATE cash_ledger SET cash_account_id=?, currency=?, amount=?, description=?, counterparty_label=?, date=? WHERE id=?`,
      [v.account.id, v.currency, v.amount, ledgerDescription(v.category.name, v.description), v.category.name, v.date, leg.id]);
    saveAttachment(id, att, user);
    domain.rebuildCashAccountBalance(v.account.id);
    if (leg.cash_account_id !== v.account.id) domain.rebuildCashAccountBalance(leg.cash_account_id);
  });
  domain.addAudit(user, "Expense updated", `${existing.reference_number}${changes.length ? ` — ${changes.join("; ")}` : ""}`);
  return detail(id);
}

function cancelExpense(user, id, reason) {
  const why = cleanText(reason, 500);
  if (!why) throw bad("Enter a reason for cancelling this expense.", "reason");
  const now = nowISO();
  const today = now.slice(0, 10);
  const done = tx(() => {
    // Status is checked inside the transaction: a double click or two users
    // at once can only ever reverse an expense once.
    const e = get("SELECT * FROM expenses WHERE id = ?", [id]);
    if (!e) throw notFound("Expense not found.");
    if (e.status !== "posted") throw bad("This expense is already cancelled.");
    const revId = uid("csl");
    // The reversal is dated today (when the money came back), never before
    // the original, so the paying account's history stays truthful.
    const revDate = today >= String(e.date).slice(0, 10) ? today : String(e.date).slice(0, 10);
    run(`INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, reference, counterparty_label, staff_id, staff_name, date, created_at, source_type, source_id)
         VALUES (?,?, 'deposit', ?,?, 0, ?,?,?,?,?,?,?,?, 'expense_reversal', ?)`,
      [revId, e.cash_account_id, e.currency, e.amount, `Expense cancelled — ${e.reference_number}: ${why}`.slice(0, 500), domain.nextCashLedgerReference("deposit"), e.reference_number, e.category_name, user.id, user.name, revDate, now, e.id]);
    run(`UPDATE expenses SET status='cancelled', reversal_ledger_id=?, cancelled_at=?, cancelled_by_id=?, cancelled_by_name=?, cancel_reason=? WHERE id=?`,
      [revId, now, user.id, user.name, why, e.id]);
    domain.rebuildCashAccountBalance(e.cash_account_id);
    return e;
  });
  domain.addAudit(user, "Expense cancelled", `${done.reference_number} — ${fmtMoney(done.amount, done.currency)} returned to the paying account. Reason: ${why}`);
  return detail(id);
}

/* ---------------------------- listing & totals --------------------------- */
// Shared WHERE builder for the list, the dashboard and every report/export,
// so a report can never count different rows from the table it summarises.
function buildFilter(q, { includeStatus = true } = {}) {
  const clauses = [], p = [];
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { clauses.push("date(e.date) >= date(?)"); p.push(q.from); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { clauses.push("date(e.date) <= date(?)"); p.push(q.to); }
  if (q.currency && CURRENCIES.includes(q.currency)) { clauses.push("e.currency = ?"); p.push(q.currency); }
  if (q.categoryId && q.categoryId !== "all") { clauses.push("e.category_id = ?"); p.push(String(q.categoryId)); }
  if (q.cashAccountId && q.cashAccountId !== "all") { clauses.push("e.cash_account_id = ?"); p.push(String(q.cashAccountId)); }
  if (includeStatus) {
    const status = q.status || "posted";
    if (status !== "all") { clauses.push("e.status = ?"); p.push(status === "cancelled" ? "cancelled" : "posted"); }
  } else {
    clauses.push("e.status = 'posted'");
  }
  if (q.search) {
    const s = `%${String(q.search).trim().slice(0, 100)}%`;
    clauses.push("(e.description LIKE ? OR e.reference_number LIKE ? OR e.external_reference LIKE ? OR e.category_name LIKE ? OR e.notes LIKE ? OR e.created_by_name LIKE ?)");
    p.push(s, s, s, s, s, s);
  }
  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params: p };
}

const SORTS = { date: "e.date", reference: "e.reference_number", category: "e.category_name", description: "e.description", amount: "e.amount", currency: "e.currency", createdBy: "e.created_by_name", status: "e.status", paidFrom: "a.name" };

function listExpenses(q) {
  const f = buildFilter(q);
  const sortCol = SORTS[q.sort] || "e.date";
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 25));
  const total = get(`SELECT COUNT(*) as n FROM expenses e ${f.where}`, f.params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const rows = all(`SELECT e.* FROM expenses e LEFT JOIN cash_accounts a ON a.id = e.cash_account_id ${f.where} ORDER BY ${sortCol} ${dir}, e.created_at ${dir}, e.id ${dir} LIMIT ? OFFSET ?`,
    [...f.params, pageSize, (page - 1) * pageSize]);
  // Per-currency totals of the POSTED expenses that match the filters —
  // cancelled ones never count towards money spent.
  const fp = buildFilter({ ...q, status: "posted" });
  const sums = all(`SELECT e.currency, COUNT(*) as n, COALESCE(SUM(e.amount),0) as total FROM expenses e ${fp.where} GROUP BY e.currency`, fp.params);
  const totals = { USD: { count: 0, total: 0 }, SLSH: { count: 0, total: 0 } };
  for (const r of sums) totals[r.currency] = { count: r.n, total: round2(r.total) };
  return { expenses: rows.map((r) => toJSON(r)), total, page, pageSize, pages, totals };
}

// Bucket key for a YYYY-MM-DD date: day, ISO week (Monday start), month, year.
function bucketOf(date, unit) {
  const d = String(date).slice(0, 10);
  if (unit === "year") return d.slice(0, 4);
  if (unit === "month") return d.slice(0, 7);
  if (unit === "week") {
    const dt = new Date(d + "T00:00:00Z");
    const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
    dt.setUTCDate(dt.getUTCDate() - dow);
    return dt.toISOString().slice(0, 10);
  }
  return d;
}
function autoUnit(from, to) {
  if (!from || !to) return "month";
  const days = (new Date(to) - new Date(from)) / 86400000;
  if (days <= 45) return "day";
  if (days <= 190) return "week";
  if (days <= 800) return "month";
  return "year";
}

function summary(q) {
  const f = buildFilter(q, { includeStatus: false });
  const rows = all(`SELECT e.date, e.amount, e.currency, e.category_id, e.category_name FROM expenses e ${f.where}`, f.params);
  const unit = ["day", "week", "month", "year"].includes(q.bucket) ? q.bucket : autoUnit(q.from, q.to);
  const cur = () => ({ total: 0, count: 0 });
  const totals = { USD: cur(), SLSH: cur() };
  const buckets = {};
  const cats = {};
  for (const r of rows) {
    totals[r.currency].total += r.amount; totals[r.currency].count += 1;
    const b = bucketOf(r.date, unit);
    buckets[b] = buckets[b] || { bucket: b, USD: 0, SLSH: 0 };
    buckets[b][r.currency] += r.amount;
    cats[r.category_id] = cats[r.category_id] || { categoryId: r.category_id, categoryName: r.category_name, USD: 0, SLSH: 0, count: 0 };
    cats[r.category_id][r.currency] += r.amount; cats[r.category_id].count += 1;
  }
  for (const c of CURRENCIES) {
    totals[c].total = round2(totals[c].total);
    totals[c].average = totals[c].count ? round2(totals[c].total / totals[c].count) : 0;
  }
  const byDate = Object.values(buckets).sort((a, b) => a.bucket.localeCompare(b.bucket)).map((b) => ({ ...b, USD: round2(b.USD), SLSH: round2(b.SLSH) }));
  const byCategory = Object.values(cats).map((c) => ({ ...c, USD: round2(c.USD), SLSH: round2(c.SLSH) })).sort((a, b) => (b.USD - a.USD) || (b.SLSH - a.SLSH));
  return { totals, count: totals.USD.count + totals.SLSH.count, bucketUnit: unit, byDate, byCategory };
}

// Report rows for one grouping. Every row keeps USD and SLSH apart; the
// grand totals are computed from the same rows that are shown/exported.
const REPORT_GROUPS = ["day", "week", "month", "year", "category", "account", "currency", "detail"];
function report(q) {
  const groupBy = REPORT_GROUPS.includes(q.groupBy) ? q.groupBy : "month";
  const f = buildFilter(q, { includeStatus: false });
  const rows = all(`SELECT e.*, a.name AS account_name FROM expenses e LEFT JOIN cash_accounts a ON a.id = e.cash_account_id ${f.where} ORDER BY e.date ASC, e.created_at ASC, e.id ASC`, f.params);
  const grand = { USD: 0, SLSH: 0, countUSD: 0, countSLSH: 0, count: rows.length };
  for (const r of rows) { grand[r.currency] += r.amount; grand[`count${r.currency}`] += 1; }
  grand.USD = round2(grand.USD); grand.SLSH = round2(grand.SLSH);
  if (groupBy === "detail") {
    return {
      groupBy, grand,
      rows: rows.map((r) => ({ date: String(r.date).slice(0, 10), reference: r.reference_number, category: r.category_name, description: r.description, paidFrom: r.account_name || "—", currency: r.currency, amount: r.amount, createdBy: r.created_by_name || "—" })),
    };
  }
  const keyOf = (r) => (groupBy === "category" ? r.category_name : groupBy === "account" ? (r.account_name || "—") : groupBy === "currency" ? r.currency : bucketOf(r.date, groupBy));
  const map = {};
  for (const r of rows) {
    const k = keyOf(r);
    map[k] = map[k] || { key: k, USD: 0, SLSH: 0, countUSD: 0, countSLSH: 0, count: 0 };
    map[k][r.currency] += r.amount; map[k][`count${r.currency}`] += 1; map[k].count += 1;
  }
  let out = Object.values(map).map((g) => ({ ...g, USD: round2(g.USD), SLSH: round2(g.SLSH) }));
  out = ["category", "account"].includes(groupBy) ? out.sort((a, b) => (b.USD - a.USD) || (b.SLSH - a.SLSH) || a.key.localeCompare(b.key)) : out.sort((a, b) => a.key.localeCompare(b.key));
  return { groupBy, grand, rows: out };
}

/* ------------------------------- categories ------------------------------ */
function categoryJSON(c) {
  const used = get("SELECT COUNT(*) as n FROM expenses WHERE category_id = ?", [c.id]).n;
  return { id: c.id, name: c.name, status: c.status, isBuiltin: !!c.is_builtin, sortOrder: c.sort_order, usedCount: used };
}
function listCategories() {
  return all("SELECT * FROM expense_categories ORDER BY status ASC, sort_order ASC, name ASC").map(categoryJSON);
}
function createCategory(user, body) {
  const name = cleanText(body && body.name, 80);
  if (!name) throw bad("Category name is required.", "name");
  if (get("SELECT id FROM expense_categories WHERE lower(name) = lower(?)", [name])) throw new ExpenseError(409, "A category with that name already exists.", "name");
  const id = uid("expcat");
  const order = (get("SELECT MAX(sort_order) as n FROM expense_categories").n || 0) + 1;
  run("INSERT INTO expense_categories (id, name, status, is_builtin, sort_order, created_at, created_by) VALUES (?,?, 'active', 0, ?,?,?)", [id, name, order, nowISO(), user.name]);
  domain.addAudit(user, "Expense category created", name);
  return categoryJSON(get("SELECT * FROM expense_categories WHERE id = ?", [id]));
}
function updateCategory(user, id, body) {
  const c = get("SELECT * FROM expense_categories WHERE id = ?", [id]);
  if (!c) throw notFound("Category not found.");
  const name = body && body.name !== undefined ? cleanText(body.name, 80) : c.name;
  if (!name) throw bad("Category name is required.", "name");
  if (get("SELECT id FROM expense_categories WHERE lower(name) = lower(?) AND id != ?", [name, id])) throw new ExpenseError(409, "A category with that name already exists.", "name");
  const status = body && body.status !== undefined ? (body.status === "archived" ? "archived" : "active") : c.status;
  // Renaming changes the label for future expenses; expenses already
  // recorded keep the category name they were saved with.
  run("UPDATE expense_categories SET name = ?, status = ? WHERE id = ?", [name, status, id]);
  domain.addAudit(user, "Expense category updated", `${c.name}${name !== c.name ? ` -> ${name}` : ""}${status !== c.status ? ` (${status})` : ""}`);
  return categoryJSON(get("SELECT * FROM expense_categories WHERE id = ?", [id]));
}

function paymentAccounts() {
  return all("SELECT id, name, type, currency, balance, status FROM cash_accounts WHERE status = 'active' ORDER BY currency ASC, name ASC");
}

function attachmentFile(expenseId) {
  return get("SELECT file_name, mime_type, size_bytes, data_base64 FROM expense_attachments WHERE expense_id = ?", [expenseId]);
}

module.exports = {
  ExpenseError, createExpense, updateExpense, cancelExpense, detail, listExpenses, summary, report, REPORT_GROUPS,
  listCategories, createCategory, updateCategory, paymentAccounts, attachmentFile, buildFilter, round2,
};
