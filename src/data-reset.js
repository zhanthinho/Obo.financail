"use strict";
// DATA RESET round — Super Admin "Reset Data" for ONE company, choosing what
// to clear category by category.
//
// Rules:
//   * only the current company's own tables are ever touched;
//   * a full backup of the company (kind "prereset", never pruned) is stored
//     BEFORE anything is deleted, and its name is returned so it can be
//     restored (scripts/backup.js restore);
//   * a category always takes its linked ledger rows with it (an exchange
//     with its account and cash legs, a payment with its cash leg, …), so no
//     balance is ever left pointing at a record that no longer exists;
//   * a category that other records depend on pulls those in automatically
//     (deleting accounts also clears their payments, exchanges, …) — the
//     preview shows exactly what will be cleared before anyone confirms;
//   * everything runs in ONE transaction; afterwards every account and cash
//     account balance is rebuilt from what remains, relationships are
//     checked, and any problem rolls the whole reset back;
//   * users, roles, permissions, settings, branding and templates are never
//     part of a reset.
const { get, all, run, tx, db } = require("./db");
const { foreignKeyViolations } = require("./mysql/integrity");

const ACCOUNT_LEDGER_PARENTS = ["exchange", "transfer"];

// key -> { label, requires: [other keys], count(), clear() }
const CATEGORIES = {
  payments: {
    label: "Credits & Debits (payments, opening balances)",
    requires: [],
  },
  exchanges: { label: "Money exchanges", requires: [] },
  transfers: { label: "Account transfers", requires: [] },
  quotations: { label: "Quotations (with their items and payments)", requires: [] },
  cash: { label: "Cash account movements (deposits, withdrawals, cash transfers, cash exchanges)", requires: [] },
  loans: { label: "Loans and loan repayments", requires: [] },
  expenses: { label: "Expenses (with attachments)", requires: [] },
  accounts: { label: "Customer & company accounts", requires: ["payments", "exchanges", "transfers", "quotations", "loans"] },
  cashAccounts: { label: "Cash accounts themselves", requires: ["payments", "exchanges", "quotations", "cash", "loans", "expenses"] },
  rates: { label: "Exchange-rate history (the current rates are kept)", requires: [] },
  openingBalances: { label: "Company currency position (set to 0)", requires: [] },
  audit: { label: "Audit log", requires: [] },
};
const ORDER = Object.keys(CATEGORIES);

// Every category the selection needs, dependencies included.
function resolve(selected) {
  const out = new Set();
  const add = (k) => {
    if (!CATEGORIES[k] || out.has(k)) return;
    out.add(k);
    for (const r of CATEGORIES[k].requires) add(r);
  };
  for (const k of selected || []) add(k);
  return ORDER.filter((k) => out.has(k));
}

const n = (sql, params = []) => (get(sql, params) || {}).n || 0;
const quotationLedgerWhere = "(COALESCE(source_type, '') LIKE 'quotation%' OR id IN (SELECT ledger_id FROM quotation_payments WHERE ledger_id IS NOT NULL))";
const paymentLedgerWhere = `(COALESCE(source_type, '') NOT IN ('exchange', 'transfer') AND NOT ${quotationLedgerWhere})`;
const cashMovementWhere = "(source_type IS NULL OR source_type IN ('opening_balance', 'cash_transfer', 'cash_exchange'))";

function rateKeepIds() {
  const keep = [];
  for (const col of ["daily_rate", "sale_rate", "daily_slsh_rate"]) {
    const r = get(`SELECT id FROM rate_history WHERE ${col} IS NOT NULL ORDER BY at DESC LIMIT 1`);
    if (r) keep.push(["rate_history", r.id]);
  }
  for (const t of ["exchange_rates", "sale_rates", "cash_rate_history"]) {
    const r = get(`SELECT id FROM ${t} ORDER BY at DESC LIMIT 1`);
    if (r) keep.push([t, r.id]);
  }
  return keep;
}

// Record counts per category, for the preview.
function counts() {
  return {
    payments: n(`SELECT COUNT(*) AS n FROM account_ledger WHERE ${paymentLedgerWhere}`),
    exchanges: n("SELECT COUNT(*) AS n FROM exchange_transactions"),
    transfers: n("SELECT COUNT(*) AS n FROM transfers"),
    quotations: n("SELECT COUNT(*) AS n FROM quotations"),
    cash: n(`SELECT COUNT(*) AS n FROM cash_ledger WHERE ${cashMovementWhere}`),
    loans: n("SELECT COUNT(*) AS n FROM cash_loans"),
    expenses: n("SELECT COUNT(*) AS n FROM expenses"),
    accounts: n("SELECT COUNT(*) AS n FROM clients"),
    cashAccounts: n("SELECT COUNT(*) AS n FROM cash_accounts"),
    rates: Math.max(0, n("SELECT COUNT(*) AS n FROM rate_history") + n("SELECT COUNT(*) AS n FROM exchange_rates") + n("SELECT COUNT(*) AS n FROM sale_rates") + n("SELECT COUNT(*) AS n FROM cash_rate_history") - rateKeepIds().length),
    openingBalances: n("SELECT COUNT(*) AS n FROM opening_balances WHERE usd <> 0 OR slsh <> 0"),
    audit: n("SELECT COUNT(*) AS n FROM audit_log"),
  };
}

function preview() {
  const c = counts();
  return {
    categories: ORDER.map((key) => ({ key, label: CATEGORIES[key].label, requires: CATEGORIES[key].requires, count: c[key] })),
    kept: ["users", "roles & permissions", "settings & branding", "PDF / Excel templates", "expense categories", "table layouts"],
  };
}

// Deletes rows of `table` whose id is in the list returned by `idSql` (ids
// are read first: MySQL cannot read a table it is deleting from).
function delWhereIdIn(table, idSql, params = []) {
  const ids = all(idSql, params).map((r) => r.id);
  let removed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    removed += run(`DELETE FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk).changes;
  }
  return removed;
}
// Cash legs of customer payments whose account-ledger row is gone.
function dropOrphanPaymentCashLegs() {
  return delWhereIdIn("cash_ledger", "SELECT c.id FROM cash_ledger c WHERE c.source_type = 'customer_payment' AND NOT EXISTS (SELECT 1 FROM account_ledger a WHERE a.id = c.source_id)");
}

function clearCategory(key) {
  const d = {};
  switch (key) {
    case "payments":
      d.account_ledger = delWhereIdIn("account_ledger", `SELECT id FROM account_ledger WHERE ${paymentLedgerWhere}`);
      d.cash_ledger = dropOrphanPaymentCashLegs();
      break;
    case "exchanges":
      d.account_ledger = delWhereIdIn("account_ledger", "SELECT id FROM account_ledger WHERE source_type = 'exchange'");
      d.cash_ledger = delWhereIdIn("cash_ledger", "SELECT id FROM cash_ledger WHERE source_type = 'exchange'");
      d.exchange_fund_allocations = run("DELETE FROM exchange_fund_allocations").changes;
      d.exchange_transactions = run("DELETE FROM exchange_transactions").changes;
      break;
    case "transfers":
      d.account_ledger = delWhereIdIn("account_ledger", "SELECT id FROM account_ledger WHERE source_type = 'transfer'");
      d.transfers = run("DELETE FROM transfers").changes;
      break;
    case "quotations":
      d.account_ledger = delWhereIdIn("account_ledger", `SELECT id FROM account_ledger WHERE ${quotationLedgerWhere}`);
      d.cash_ledger = dropOrphanPaymentCashLegs();
      d.quotation_payments = run("DELETE FROM quotation_payments").changes;
      d.quotation_items = run("DELETE FROM quotation_items").changes;
      d.quotations = run("DELETE FROM quotations").changes;
      break;
    case "cash":
      d.cash_ledger = delWhereIdIn("cash_ledger", `SELECT id FROM cash_ledger WHERE ${cashMovementWhere}`);
      d.cash_transfers = run("DELETE FROM cash_transfers").changes;
      d.cash_exchanges = run("DELETE FROM cash_exchanges").changes;
      break;
    case "loans":
      d.cash_ledger = delWhereIdIn("cash_ledger", "SELECT id FROM cash_ledger WHERE source_type IN ('loan', 'loan_repayment')");
      d.cash_loan_payments = run("DELETE FROM cash_loan_payments").changes;
      d.cash_loans = run("DELETE FROM cash_loans").changes;
      break;
    case "expenses":
      d.cash_ledger = delWhereIdIn("cash_ledger", "SELECT id FROM cash_ledger WHERE source_type IN ('expense', 'expense_reversal')");
      d.expense_attachments = run("DELETE FROM expense_attachments").changes;
      d.expenses = run("DELETE FROM expenses").changes;
      break;
    case "accounts":
      // Whatever ledger rows are still there belong to these accounts.
      d.account_ledger = run("DELETE FROM account_ledger").changes;
      d.cash_ledger = dropOrphanPaymentCashLegs();
      run("UPDATE cash_ledger SET counterparty_client_id = NULL WHERE counterparty_client_id IS NOT NULL");
      run("UPDATE clients SET linked_account_id = NULL");
      d.account_imports = run("DELETE FROM account_imports").changes;
      d.clients = run("DELETE FROM clients").changes;
      break;
    case "cashAccounts":
      d.cash_ledger = run("DELETE FROM cash_ledger").changes;
      run("UPDATE account_ledger SET cash_account_id = NULL WHERE cash_account_id IS NOT NULL");
      d.cash_accounts = run("DELETE FROM cash_accounts").changes;
      break;
    case "rates": {
      const keep = rateKeepIds();
      for (const t of ["rate_history", "exchange_rates", "sale_rates", "cash_rate_history"]) {
        const ids = keep.filter(([tt]) => tt === t).map(([, id]) => id);
        d[t] = ids.length ? run(`DELETE FROM ${t} WHERE id NOT IN (${ids.map(() => "?").join(",")})`, ids).changes : run(`DELETE FROM ${t}`).changes;
      }
      break;
    }
    case "openingBalances":
      d.opening_balances = run("UPDATE opening_balances SET usd = 0, slsh = 0, updated_by = ?, updated_at = ? WHERE id = 1", ["system (data reset)", new Date().toISOString()]).changes;
      break;
    case "audit":
      d.audit_log = run("DELETE FROM audit_log").changes;
      break;
    default:
      throw new Error(`Unknown category ${key}`);
  }
  return d;
}

function rebuildBalances() {
  const { rebuildAccountBalance, rebuildCashAccountBalance } = require("./domain");
  for (const c of all("SELECT id FROM clients")) {
    rebuildAccountBalance(c.id, "USD");
    rebuildAccountBalance(c.id, "SLSH");
  }
  for (const a of all("SELECT id FROM cash_accounts")) rebuildCashAccountBalance(a.id);
}

const totalOrphans = () => foreignKeyViolations(db, "tenant").reduce((s, v) => s + v.count, 0);

// Runs the reset. `company` = the current company row, `actor` = the Super Admin.
function execute(company, selected, actor) {
  const keys = resolve(selected);
  if (!keys.length) { const e = new Error("Choose at least one thing to reset."); e.status = 400; throw e; }
  const backup = require("./backup").backupNow(company, "prereset", actor.name);
  const orphansBefore = totalOrphans();
  const deleted = {};
  tx(() => {
    db.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const k of keys) deleted[k] = clearCategory(k);
      rebuildBalances();
    } finally {
      db.raw("SET FOREIGN_KEY_CHECKS = 1");
    }
    const orphansAfter = totalOrphans();
    if (orphansAfter > orphansBefore) { const e = new Error(`Reset stopped: it would leave ${orphansAfter - orphansBefore} record(s) pointing at deleted data. Nothing was changed.`); e.status = 409; throw e; }
    require("./domain").addAudit(actor, "Data reset", `Cleared: ${keys.map((k) => CATEGORIES[k].label).join("; ")}. Backup kept: ${backup.name}`);
  });
  return { cleared: keys, deleted, backup: backup.name, counts: counts() };
}

module.exports = { CATEGORIES, resolve, preview, execute, counts };
