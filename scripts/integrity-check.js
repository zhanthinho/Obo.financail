"use strict";
// SECURITY & INTEGRITY AUDIT round — READ-ONLY financial integrity check.
//
//   node scripts/integrity-check.js
//
// MYSQL round: reads every company's tables over a READ-ONLY MySQL session
// (it never writes, creates, migrates or repairs anything) and reports, per
// company:
//   * customer accounts whose stored balance differs from their ledger;
//   * Cash in Hand accounts whose stored balance differs from their ledger;
//   * amounts or balances that are not real numbers (Infinity / NaN);
//   * ledger rows pointing at accounts that no longer exist;
//   * expenses without (or with more than one) cash movement, and cancelled
//     expenses without exactly one reversal;
//   * possible double submissions — two identical deposits/withdrawals on the
//     same account, by the same person, within 10 seconds — listed by
//     reference number for a person to review (they may be genuine).
// Uses the same DB_PATH / CONTROL_DB_PATH / COMPANIES_DIR settings as the
// server. Exit code 0 = nothing found, 1 = something to review.
require("../src/env");
const { SyncMysql } = require("../src/mysql/sync-client");
const { readConfig } = require("../src/mysql/connection");
const { CompatDb } = require("../src/mysql/compat-db");
const schema = require("../src/mysql/schema");

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const client = new SyncMysql(readConfig());
client.query("SET SESSION TRANSACTION READ ONLY");
const present = new Set(client.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").rows.map((r) => r.n));
function open(companyId) {
  return new CompatDb(client, { kind: "tenant", companyId, prefix: schema.companyPrefix(companyId), tables: new Set(schema.tableNames("tenant")) });
}
function has(db, table) { return present.has(db.table(table)); }

function companies() {
  if (!present.has(`${schema.CONTROL_PREFIX}companies`)) return [];
  return client.query(`SELECT id, name FROM "${schema.CONTROL_PREFIX}companies" ORDER BY seq`).rows;
}

function checkCompany(co) {
  const out = [];
  const db = open(co.id);
  if (!has(db, "clients")) return ["company tables missing"];
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  try {
    for (const c of q("SELECT id, account_number, balance_usd, balance_slsh FROM clients")) {
      for (const [cur, col] of [["USD", "balance_usd"], ["SLSH", "balance_slsh"]]) {
        const s = q("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM account_ledger WHERE client_id=? AND currency=?", c.id, cur)[0].n;
        if (!Number.isFinite(Number(c[col])) || !near(s, c[col])) out.push(`account ${c.account_number} ${cur}: stored ${c[col]} vs ledger ${s}`);
      }
    }
    if (has(db, "cash_accounts")) {
      for (const a of q("SELECT id, name, balance FROM cash_accounts")) {
        const s = q("SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) AS n FROM cash_ledger WHERE cash_account_id=?", a.id)[0].n;
        if (!Number.isFinite(Number(a.balance)) || !near(s, a.balance)) out.push(`cash account "${a.name}": stored ${a.balance} vs ledger ${s}`);
      }
    }
    // (MySQL cannot store Infinity/NaN at all; absurd magnitudes are still reported.)
    for (const [table, col] of [["account_ledger", "amount"], ["cash_ledger", "amount"], ["exchange_transactions", "amount_given"], ["exchange_transactions", "amount_received"], ["transfers", "amount"], ["expenses", "amount"]]) {
      if (!has(db, table)) continue;
      const n = q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL AND ABS(${col}) > 1e15`)[0].n;
      if (n) out.push(`${n} row(s) in ${table}.${col} are not real amounts (Infinity/NaN/absurd)`);
    }
    const orphanChecks = [
      ["account ledger rows with no account", "SELECT COUNT(*) AS n FROM account_ledger WHERE client_id NOT IN (SELECT id FROM clients)"],
      ["cash ledger rows with no cash account", "SELECT COUNT(*) AS n FROM cash_ledger WHERE cash_account_id NOT IN (SELECT id FROM cash_accounts)"],
      ["posted expenses without exactly one cash movement", "SELECT COUNT(*) AS n FROM expenses e WHERE e.status='posted' AND (SELECT COUNT(*) FROM cash_ledger l WHERE l.source_type='expense' AND l.source_id=e.id) <> 1"],
      ["cancelled expenses without exactly one reversal", "SELECT COUNT(*) AS n FROM expenses e WHERE e.status='cancelled' AND (SELECT COUNT(*) FROM cash_ledger l WHERE l.source_type='expense_reversal' AND l.source_id=e.id) <> 1"],
    ];
    for (const [label, sql] of orphanChecks) {
      try { const n = q(sql)[0].n; if (n) out.push(`${n} ${label}`); } catch (e) { /* table not present in this database */ }
    }
    const dups = q(`SELECT a.reference_number AS r1, b.reference_number AS r2, a.created_at AS t1, b.created_at AS t2 FROM account_ledger a JOIN account_ledger b
                      ON a.client_id = b.client_id AND a.type = b.type AND a.currency = b.currency AND a.amount = b.amount
                     AND COALESCE(a.staff_id,'') = COALESCE(b.staff_id,'') AND a.id < b.id AND a.source_type IS NULL AND b.source_type IS NULL`)
      .filter((d) => Math.abs(Date.parse(d.t1) - Date.parse(d.t2)) <= 10000);
    for (const d of dups.slice(0, 50)) out.push(`possible double submission to review: ${d.r1 || "?"} and ${d.r2 || "?"}`);
  } finally { /* shared read-only session */ }
  return out;
}

let total = 0;
for (const co of companies()) {
  let findings;
  try { findings = checkCompany(co); } catch (e) { findings = [`could not be checked: ${e.message}`]; }
  total += findings.length;
  console.log(`\n${co.name} (${co.id}): ${findings.length ? `${findings.length} item(s) to review` : "OK — balances reconcile, nothing orphaned"}`);
  for (const f of findings) console.log(`  - ${f}`);
}
console.log(total ? `\n${total} item(s) to review. Nothing was changed.` : "\nAll companies reconcile. Nothing was changed.");
client.close();
process.exit(total ? 1 : 0);
