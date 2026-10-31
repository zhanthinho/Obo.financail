"use strict";
// ONE-TIME OPERATIONAL DATA RESET (owner-approved, 2026-10).
//
// Controlled ONLY by the RESET_OPERATIONAL_DATA environment variable:
//   unset          -> does nothing (normal operation).
//   "dry-run"      -> logs a full per-company plan with exact record counts.
//                     Changes NOTHING.
//   CONFIRM_CODE   -> executes the reset ONCE per company, after writing a
//                     pre-reset backup that is never auto-pruned. A marker row
//                     in each company's reset_log makes re-runs a no-op.
//
// What the reset does, per company (each company database independently):
//   * KEEPS every current (not deleted) account: id, name, number, currency,
//     type, contact details, status, company association. Balances -> 0.
//   * KEEPS every Cash in Hand account. Balances -> 0.
//   * DELETES all operational records: account ledger (credits/debits,
//     opening-balance rows), money exchanges, transfers, quotations (+items,
//     +payments), cash ledger, cash transfers, cash exchanges, cash loans
//     (+payments).
//   * DELETES accounts that were previously deleted (deleted_at set) — all
//     of their records are already gone with the operational data above.
//   * Company currency position (opening_balances) -> 0 / 0.
//   * Rate history: keeps only the CURRENT Daily / Sale / Daily-SLSH / Cash
//     rate rows, deletes older history.
//   * Audit log: cleared, then one "Operational data reset" entry is written.
//   * KEEPS users, roles, permissions, settings, branding, templates, table
//     layouts, account-import history, companies, platform accounts.
// Balances end at zero because every balance in this system is derived from
// ledger rows (domain.js rebuildAccountBalance / rebuildCashAccountBalance);
// no artificial transactions are created.

const CONFIRM_CODE = "CONFIRM-RESET-2026-10";

const OPERATIONAL_TABLES = [
  // child tables first (foreign-key order)
  "exchange_fund_allocations",
  "quotation_payments", "quotation_items", "quotations",
  // COMPANY EXPENSES round: an expense owns one cash_ledger withdrawal, so
  // it is cleared together with (and before) the cash ledger. Expense
  // categories are configuration and are kept.
  "expense_attachments", "expenses",
  "cash_loan_payments", "cash_loans",
  "cash_transfers", "cash_exchanges", "cash_ledger",
  "account_ledger", "transfers", "exchange_transactions",
];

// MYSQL round: every company has the full, current set of tables, so these
// checks read the live MySQL catalogue for that company's own tables.
function hasTable(h, name) {
  if (!h.scope.tables.has(name)) return false;
  return h.raw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [h.table(name)])[0].n > 0;
}
function hasColumn(h, table, col) {
  return hasTable(h, table) && h.raw("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [h.table(table), col])[0].n > 0;
}
function count(h, table, where = "", params = []) {
  if (!hasTable(h, table)) return null;
  return h.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).get(...params).n;
}

// Rows in client-referencing tables whose account is deleted or missing.
const CLIENT_REFS = [
  ["account_ledger", "client_id"],
  ["exchange_transactions", "client_id"], ["exchange_transactions", "from_account_id"], ["exchange_transactions", "to_account_id"],
  ["transfers", "from_account_id"], ["transfers", "to_account_id"],
  ["quotations", "client_id"], ["quotations", "charged_account_id"],
  ["cash_ledger", "counterparty_client_id"],
  ["cash_loans", "client_id"],
];

function rateKeepIds(h) {
  const keep = { rate_history: [], exchange_rates: [], sale_rates: [], cash_rate_history: [] };
  if (hasTable(h, "rate_history")) {
    for (const col of ["daily_rate", "sale_rate", "daily_slsh_rate"]) {
      if (!hasColumn(h, "rate_history", col)) continue;
      const r = h.prepare(`SELECT id FROM rate_history WHERE ${col} IS NOT NULL ORDER BY at DESC LIMIT 1`).get();
      if (r && !keep.rate_history.includes(r.id)) keep.rate_history.push(r.id);
    }
  }
  for (const t of ["exchange_rates", "sale_rates", "cash_rate_history"]) {
    if (!hasTable(h, t)) continue;
    const r = h.prepare(`SELECT id FROM "${t}" ORDER BY at DESC LIMIT 1`).get();
    if (r) keep[t].push(r.id);
  }
  return keep;
}

function buildPlan(h) {
  const plan = { tables: {}, deletedAccounts: [], deletedAccountRecords: {}, orphans: {}, preserved: {}, balances: {}, rates: {} };
  for (const t of OPERATIONAL_TABLES) plan.tables[t] = count(h, t);

  const hasDel = hasColumn(h, "clients", "deleted_at");
  plan.deletedAccounts = hasDel
    ? h.prepare("SELECT id, account_number, name, currency, deleted_at FROM clients WHERE deleted_at IS NOT NULL ORDER BY account_number").all()
    : [];
  const delIds = plan.deletedAccounts.map((a) => a.id);
  for (const [t, c] of CLIENT_REFS) {
    if (!hasColumn(h, t, c)) continue;
    const key = `${t}.${c}`;
    if (delIds.length) {
      plan.deletedAccountRecords[key] = h.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${c} IN (${delIds.map(() => "?").join(",")})`).get(...delIds).n;
    }
    plan.orphans[key] = h.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${c} IS NOT NULL AND ${c} NOT IN (SELECT id FROM clients)`).get().n;
  }
  if (hasTable(h, "cash_ledger")) plan.orphans["cash_ledger.cash_account_id"] = h.prepare("SELECT COUNT(*) AS n FROM cash_ledger WHERE cash_account_id NOT IN (SELECT id FROM cash_accounts)").get().n;
  if (hasTable(h, "quotation_items")) plan.orphans["quotation_items.quotation_id"] = h.prepare("SELECT COUNT(*) AS n FROM quotation_items WHERE quotation_id NOT IN (SELECT id FROM quotations)").get().n;
  if (hasTable(h, "quotation_payments")) plan.orphans["quotation_payments.quotation_id"] = h.prepare("SELECT COUNT(*) AS n FROM quotation_payments WHERE quotation_id NOT IN (SELECT id FROM quotations)").get().n;

  const activeWhere = hasDel ? "WHERE deleted_at IS NULL" : "";
  plan.preserved.accounts = count(h, "clients", activeWhere);
  plan.preserved.accountList = h.prepare(`SELECT account_number, name, currency, account_type, ${hasColumn(h, "clients", "status") ? "status" : "'active' AS status"}, balance_usd, balance_slsh FROM clients ${activeWhere} ORDER BY account_number`).all();
  plan.preserved.cashAccounts = count(h, "cash_accounts");
  plan.preserved.cashAccountList = hasTable(h, "cash_accounts") ? h.prepare("SELECT name, currency, type, status, balance FROM cash_accounts ORDER BY name").all() : [];
  for (const t of ["users", "roles", "role_permissions", "user_permission_overrides", "company_settings", "pdf_templates", "excel_templates", "table_layouts", "account_imports"]) plan.preserved[t] = count(h, t);

  plan.balances.accountsNonZero = count(h, "clients", `WHERE (balance_usd <> 0 OR balance_slsh <> 0)${hasDel ? " AND deleted_at IS NULL" : ""}`);
  plan.balances.cashNonZero = count(h, "cash_accounts", "WHERE balance <> 0");
  plan.balances.openingBalances = hasTable(h, "opening_balances") ? h.prepare("SELECT usd, slsh FROM opening_balances WHERE id = 1").get() || null : null;

  const keep = rateKeepIds(h);
  for (const t of Object.keys(keep)) {
    const total = count(h, t);
    if (total !== null) plan.rates[t] = { total, keep: keep[t].length, delete: total - keep[t].length };
  }
  plan.auditLog = count(h, "audit_log");
  return plan;
}

function printPlan(company, plan, mode) {
  const L = (s) => console.log(`[reset] ${company.id} ${s}`);
  L(`===== ${mode === "dry-run" ? "DRY RUN (no changes)" : "PLAN"} — ${company.name} =====`);
  L(`Preserve: ${plan.preserved.accounts} accounts, ${plan.preserved.cashAccounts} cash accounts, ${plan.preserved.users} users, ${plan.preserved.roles} roles, settings/templates/layouts/import history`);
  for (const a of plan.preserved.accountList) L(`  keep account ${a.account_number} | ${a.name} | ${a.currency} | ${a.account_type} | ${a.status} | bal USD ${a.balance_usd} SLSH ${a.balance_slsh} -> 0`);
  for (const c of plan.preserved.cashAccountList) L(`  keep cash ${c.name} | ${c.currency} | ${c.type} | ${c.status} | bal ${c.balance} -> 0`);
  L(`Delete operational records: ${JSON.stringify(plan.tables)}`);
  L(`Previously deleted accounts to purge: ${plan.deletedAccounts.length}`);
  for (const a of plan.deletedAccounts) L(`  purge ${a.account_number} | ${a.name} | ${a.currency} | deleted ${a.deleted_at}`);
  L(`Records linked to deleted accounts: ${JSON.stringify(plan.deletedAccountRecords)}`);
  L(`Orphans (parent missing): ${JSON.stringify(plan.orphans)}`);
  L(`Non-zero balances now: accounts ${plan.balances.accountsNonZero}, cash ${plan.balances.cashNonZero}, opening_balances ${JSON.stringify(plan.balances.openingBalances)}`);
  L(`Rates (keep current only): ${JSON.stringify(plan.rates)}`);
  L(`Audit log entries to clear: ${plan.auditLog}`);
}

function execute(h, company, plan) {
  const now = new Date().toISOString();
  h.exec("BEGIN");
  try {
    const deleted = {};
    for (const t of OPERATIONAL_TABLES) {
      if (!hasTable(h, t)) continue;
      deleted[t] = h.prepare(`DELETE FROM "${t}"`).run().changes;
    }
    let purged = 0;
    if (hasColumn(h, "clients", "deleted_at")) {
      // (MySQL cannot read the table it is updating in a subquery; the
      // derived tables below are materialized first — same result.)
      h.prepare("UPDATE clients SET linked_account_id = NULL WHERE linked_account_id IS NOT NULL AND (linked_account_id NOT IN (SELECT id FROM (SELECT id FROM clients) AS live) OR linked_account_id IN (SELECT id FROM (SELECT id FROM clients WHERE deleted_at IS NOT NULL) AS gone))").run();
      purged = h.prepare("DELETE FROM clients WHERE deleted_at IS NOT NULL").run().changes;
    }
    const accountsZeroed = h.prepare("UPDATE clients SET balance_usd = 0, balance_slsh = 0").run().changes;
    const cashZeroed = hasTable(h, "cash_accounts") ? h.prepare("UPDATE cash_accounts SET balance = 0, last_activity_at = NULL").run().changes : 0;
    if (hasTable(h, "opening_balances")) {
      const sets = ["usd = 0", "slsh = 0"];
      if (hasColumn(h, "opening_balances", "updated_by")) sets.push("updated_by = 'system (data reset)'");
      if (hasColumn(h, "opening_balances", "updated_at")) sets.push(`updated_at = '${now}'`);
      h.prepare(`UPDATE opening_balances SET ${sets.join(", ")} WHERE id = 1`).run();
    }
    const keep = rateKeepIds(h);
    const ratesDeleted = {};
    for (const t of Object.keys(keep)) {
      if (!hasTable(h, t)) continue;
      const ids = keep[t];
      ratesDeleted[t] = ids.length
        ? h.prepare(`DELETE FROM "${t}" WHERE id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids).changes
        : h.prepare(`DELETE FROM "${t}"`).run().changes;
    }
    const auditDeleted = hasTable(h, "audit_log") ? h.prepare("DELETE FROM audit_log").run().changes : 0;
    const summary = { deleted, purgedDeletedAccounts: purged, accountsZeroed, cashZeroed, ratesDeleted, auditDeleted };
    if (hasTable(h, "audit_log")) {
      h.prepare("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES (?,?,?,?,?,?,?)")
        .run(`log_reset_${Date.now().toString(36)}`, now, null, "system", "system", "Operational data reset", `Owner-approved reset (${CONFIRM_CODE}). ${JSON.stringify(summary)}`);
    }
    // Verify inside the transaction; any problem rolls everything back.
    const fk = require("./mysql/integrity").foreignKeyViolations(h, "tenant");
    if (fk.length) throw new Error(`foreign key violations after reset: ${JSON.stringify(fk.slice(0, 5))}`);
    const nz = h.prepare("SELECT COUNT(*) AS n FROM clients WHERE balance_usd <> 0 OR balance_slsh <> 0").get().n
      + (hasTable(h, "cash_accounts") ? h.prepare("SELECT COUNT(*) AS n FROM cash_accounts WHERE balance <> 0").get().n : 0);
    if (nz) throw new Error(`${nz} balances still non-zero`);
    const left = OPERATIONAL_TABLES.filter((t) => hasTable(h, t)).reduce((s, t) => s + h.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n, 0);
    if (left) throw new Error(`${left} operational rows still present`);
    h.prepare("INSERT INTO reset_log (code, at, summary) VALUES (?,?,?)").run(CONFIRM_CODE, now, JSON.stringify(summary));
    h.exec("COMMIT");
    return summary;
  } catch (e) {
    try { h.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
}

function alreadyDone(h) {
  return hasTable(h, "reset_log") && !!h.prepare("SELECT code FROM reset_log WHERE code = ?").get(CONFIRM_CODE);
}

// MYSQL round: the rollback point is a full backup of the company stored in
// the database (kind "prereset" — never pruned).
function preResetBackup(company) {
  return require("./backup").backupNow(company, "prereset").name;
}

function runFromEnv() {
  const mode = String(process.env.RESET_OPERATIONAL_DATA || "").trim();
  if (!mode) return;
  if (mode !== "dry-run" && mode !== CONFIRM_CODE) {
    console.warn(`[reset] RESET_OPERATIONAL_DATA="${mode}" is not recognised — nothing done. Use "dry-run" or the confirmation code.`);
    return;
  }
  const tenancy = require("./tenancy");
  const companies = tenancy.listCompanies();
  console.log(`[reset] Mode: ${mode === "dry-run" ? "DRY RUN" : "EXECUTE"} — ${companies.length} compan${companies.length === 1 ? "y" : "ies"}.`);
  let executedAny = false;
  for (const company of companies) {
    let h;
    try { h = tenancy.openTenant(company).db; } catch (e) { console.error(`[reset] ${company.id} cannot open: ${e.message}`); continue; }
    if (alreadyDone(h)) { console.log(`[reset] ${company.id} already reset earlier (${CONFIRM_CODE}) — skipped.`); continue; }
    const plan = buildPlan(h);
    printPlan(company, plan, mode);
    if (mode === "dry-run") continue;
    try {
      const file = preResetBackup(company);
      console.log(`[reset] ${company.id} pre-reset backup stored: ${file}`);
      const summary = execute(h, company, plan);
      executedAny = true;
      console.log(`[reset] ${company.id} DONE: ${JSON.stringify(summary)}`);
    } catch (e) {
      console.error(`[reset] ${company.id} FAILED and was rolled back — no changes made: ${e.message}`);
    }
  }
  if (mode !== "dry-run" && executedAny) {
    try {
      try { require("./backup").backupControl(); console.log("[reset] control database backed up before clearing platform audit."); } catch (e) { console.error("[reset] control backup failed:", e.message); }
      const c = tenancy.controlDb();
      const n = c.prepare("DELETE FROM platform_audit").run().changes;
      c.prepare("INSERT INTO platform_audit (id, at, actor_id, actor_name, action, company_id, details) VALUES (?,?,?,?,?,?,?)")
        .run(`pa_reset_${Date.now().toString(36)}`, new Date().toISOString(), null, "system", "Operational data reset", null, `Owner-approved reset (${CONFIRM_CODE}); ${n} platform audit entries cleared.`);
      console.log(`[reset] platform audit cleared (${n} entries).`);
    } catch (e) { console.error("[reset] platform audit clear failed:", e.message); }
  }
  console.log("[reset] Finished. Remove the RESET_OPERATIONAL_DATA variable now.");
}

module.exports = { runFromEnv, buildPlan, execute, CONFIRM_CODE };
