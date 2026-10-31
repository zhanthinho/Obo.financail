"use strict";
// CUSTOMER TRANSACTION SELECTOR round — which of a customer's credits are
// still available to pay for an exchange, and recording which ones an
// exchange used.
//
// Rules (chosen by the owner):
//   * Eligible = every CREDIT on the account (account_ledger type 'deposit'):
//     payments, opening balance, transfers in, exchanges received, quotation
//     settlements, loans — anything that increased the balance.
//   * What is left of each credit:
//       1. an exchange recorded through "View Transactions" names exactly which
//          credits it used (table exchange_fund_allocations) — those amounts
//          come off those credits;
//       2. every other debit (withdrawals, transfers out, older exchanges,
//          quotation charges...) uses credits OLDEST FIRST (FIFO).
//     So nothing historical is invented or rewritten: the remaining amounts
//     are worked out from the ledger every time, and their total never exceeds
//     the account's real balance.
//   * The server works this out again, under the company's write lock,
//     when the exchange is saved (validateSelections) — the figures the
//     browser showed are never trusted.
const { all, run } = require("./db");
const { uid, nowISO, cleanMoney, chronoSortKey, toNumber } = require("./util");

const EPS = 1e-8;

function typeLabel(l) {
  switch (l.source_type) {
    case "transfer": return "Transfer in";
    case "exchange": return "Exchange received";
    case "quotation_paid": case "quotation_charge": case "quotation_refund": return "Quotation";
    case "loan": return "Loan";
    default: return /^opening balance$/i.test(String(l.notes || "").trim()) ? "Opening balance" : "Credit";
  }
}
const TYPES = ["Credit", "Opening balance", "Transfer in", "Exchange received", "Quotation", "Loan"];

const byChrono = (a, b) => {
  const k = chronoSortKey(a.date, a.created_at).localeCompare(chronoSortKey(b.date, b.created_at));
  return k !== 0 ? k : String(a.id).localeCompare(String(b.id));
};

// Every credit of one account with what is still available on it.
function creditsWithAvailability(clientId, currency) {
  const ledger = all("SELECT id, type, amount, date, created_at, notes, source_type, source_id, reference_number, reference FROM account_ledger WHERE client_id = ? AND currency = ?", [clientId, currency]);
  const credits = ledger.filter((l) => l.type === "deposit").sort(byChrono);
  const creditIds = new Set(credits.map((c) => c.id));
  // Allocations of exchanges that still exist (a deleted exchange's rows are
  // removed with it; this join is a second safety net).
  const allocs = all(
    `SELECT a.exchange_id, a.ledger_id, a.amount FROM exchange_fund_allocations a
     JOIN exchange_transactions t ON t.id = a.exchange_id AND t.status = 'active'
     WHERE a.client_id = ? AND a.currency = ?`, [clientId, currency]);
  const explicit = new Map();      // credit id -> amount named by exchanges
  const coveredByExchange = new Map(); // exchange id -> amount it named
  for (const a of allocs) {
    if (!creditIds.has(a.ledger_id)) continue; // that credit was deleted since
    explicit.set(a.ledger_id, cleanMoney((explicit.get(a.ledger_id) || 0) + a.amount));
    coveredByExchange.set(a.exchange_id, cleanMoney((coveredByExchange.get(a.exchange_id) || 0) + a.amount));
  }
  // Debits not paid from named credits use credits oldest-first.
  let fifo = 0;
  for (const l of ledger) {
    if (l.type !== "withdrawal") continue;
    const named = l.source_type === "exchange" ? (coveredByExchange.get(l.source_id) || 0) : 0;
    fifo = cleanMoney(fifo + Math.max(0, l.amount - named));
  }
  return credits.map((c) => {
    let available = Math.max(0, cleanMoney(c.amount - (explicit.get(c.id) || 0)));
    const take = Math.min(available, fifo);
    available = cleanMoney(available - take);
    fifo = cleanMoney(fifo - take);
    return { ...c, label: typeLabel(c), available, consumed: cleanMoney(c.amount - available) };
  });
}

// Reference shown for a credit: its own number, or the exchange/transfer it
// came from.
function referencesFor(rows) {
  const ex = rows.filter((r) => !r.reference_number && r.source_type === "exchange").map((r) => r.source_id);
  const tr = rows.filter((r) => !r.reference_number && r.source_type === "transfer").map((r) => r.source_id);
  const map = new Map();
  const load = (table, ids) => {
    if (!ids.length) return;
    for (const r of all(`SELECT id, reference_number FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ids)) map.set(r.id, r.reference_number);
  };
  load("exchange_transactions", [...new Set(ex)]);
  load("transfers", [...new Set(tr)]);
  return (r) => r.reference_number || (r.source_id && map.get(r.source_id)) || null;
}

function serialize(c, refOf) {
  return {
    ledgerId: c.id, date: c.date, createdAt: c.created_at, type: c.label,
    reference: refOf(c), note: c.notes || "", externalReference: c.reference || "",
    amount: c.amount, consumed: c.consumed, available: c.available,
  };
}

// GET /api/transactions/fund-sources — eligible credits (available > 0),
// newest first, with search / date / type filters and paging.
function listAvailable(account, query) {
  const all_ = creditsWithAvailability(account.id, account.currency).filter((c) => c.available > EPS);
  const refOf = referencesFor(all_);
  let rows = all_.map((c) => serialize(c, refOf));
  const totalAvailable = cleanMoney(rows.reduce((s, r) => s + r.available, 0));
  const eligibleCount = rows.length;
  const q = String(query.search || "").trim().toLowerCase().slice(0, 100);
  if (q) rows = rows.filter((r) => [r.reference, r.note, r.externalReference, r.type, String(r.date).slice(0, 10)].some((v) => String(v || "").toLowerCase().includes(q)));
  const day = (d) => String(d || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ""))) rows = rows.filter((r) => day(r.date) >= query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ""))) rows = rows.filter((r) => day(r.date) <= query.to);
  if (query.type && TYPES.includes(query.type)) rows = rows.filter((r) => r.type === query.type);
  rows.reverse(); // newest first
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
  return {
    account: { id: account.id, name: account.name, accountNumber: account.account_number, currency: account.currency, balance: account.currency === "USD" ? account.balance_usd : account.balance_slsh },
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total, page, pages, pageSize, eligibleCount, totalAvailable, types: TYPES,
  };
}

class SelectionError extends Error { constructor(message) { super(message); this.status = 400; } }

// Checks a selection sent with an exchange against the ledger AS IT IS NOW.
// Must run inside the exchange's tx() so the check and the save are atomic.
// Returns [{ ledgerId, amount }] or throws SelectionError.
function validateSelections(selections, account, amountGiven) {
  if (!Array.isArray(selections) || !selections.length) throw new SelectionError("Select at least one transaction.");
  if (selections.length > 500) throw new SelectionError("Too many transactions selected.");
  const avail = new Map(creditsWithAvailability(account.id, account.currency).map((c) => [c.id, c]));
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const s of selections) {
    const id = s && typeof s.ledgerId === "string" ? s.ledgerId : null;
    const amount = toNumber(s && s.amount);
    if (!id) throw new SelectionError("A selected transaction is missing its id.");
    if (seen.has(id)) throw new SelectionError("The same transaction was selected twice.");
    seen.add(id);
    const c = avail.get(id);
    // Not a credit of THIS account (another account's, another company's,
    // a debit, or deleted): refused without saying which.
    if (!c) throw new SelectionError("A selected transaction is not available on this account.");
    if (!(Number.isFinite(amount) && amount > 0)) throw new SelectionError("Each selected amount must be greater than 0.");
    if (amount - c.available > EPS) {
      throw new SelectionError(`${c.reference_number || "A selected transaction"} has only ${c.available} ${account.currency} left — refresh the list and select again.`);
    }
    total = cleanMoney(total + amount);
    out.push({ ledgerId: id, amount: cleanMoney(amount) });
  }
  if (Math.abs(total - amountGiven) > (account.currency === "USD" ? 0.005 : 0.5)) {
    throw new SelectionError("The amount given must equal the total of the selected transactions.");
  }
  return out;
}

function saveAllocations(exchangeId, account, list, user) {
  const now = nowISO();
  for (const a of list) {
    run("INSERT INTO exchange_fund_allocations (id, exchange_id, ledger_id, client_id, currency, amount, created_by_id, created_by_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [uid("efa"), exchangeId, a.ledgerId, account.id, account.currency, a.amount, user.id, user.name, now]);
  }
}

function removeAllocations(exchangeId) {
  return run("DELETE FROM exchange_fund_allocations WHERE exchange_id = ?", [exchangeId]).changes;
}

// The credits an exchange was paid from (for its detail / history).
function allocationsFor(exchangeIds) {
  const ids = [...new Set(exchangeIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all(
      `SELECT a.exchange_id, a.ledger_id, a.amount, l.reference_number, l.date, l.notes, l.source_type, l.source_id
       FROM exchange_fund_allocations a LEFT JOIN account_ledger l ON l.id = a.ledger_id
       WHERE a.exchange_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    const refOf = referencesFor(rows.filter((r) => r.source_type));
    for (const r of rows) {
      if (!out.has(r.exchange_id)) out.set(r.exchange_id, []);
      out.get(r.exchange_id).push({ ledgerId: r.ledger_id, amount: r.amount, reference: r.date ? refOf(r) : null, date: r.date || null, deleted: !r.date });
    }
  }
  return out;
}

module.exports = { creditsWithAvailability, listAvailable, validateSelections, saveAllocations, removeAllocations, allocationsFor, SelectionError, TYPES };
