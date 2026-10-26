"use strict";
// LEGACY (SQLite) — OFFLINE USE ONLY. The running app no longer uses SQLite;
// it runs on MySQL (src/db.js). This is the last SQLite version of the
// per-company database code, kept for two offline tools only:
//   * scripts/migrate-sqlite-to-mysql.js — brings a COPY of an older SQLite
//     database up to the final SQLite schema before its rows are moved to
//     MySQL (the original file is never opened for writing);
//   * scripts/dev/generate-mysql-schema.js — builds a fresh SQLite company
//     database to derive the MySQL schema and the new-company seed from.
// Do not require this file from src/.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const tenantContext = require("../../src/tenant-context");

// MULTI-COMPANY round: DB_PATH is now the database of the PRIMARY company
// (Company ID CMP-0001 — the company this installation already belonged to
// before multi-company support existed). It is never moved or renamed, so an
// existing installation's data stays exactly where it always was. Every
// additional company gets its own, separate database file under
// COMPANIES_DIR (see src/tenancy.js), and the companies registry itself lives
// in a separate control database.

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

// MULTI-COMPANY round: every company database carries a one-row tenant_meta
// table naming the company it belongs to. It is checked BEFORE any migration
// touches the file, so a database file that belongs to company A can never be
// opened (let alone migrated or served) as company B — e.g. after a backup is
// restored into the wrong slot.
function assertTenantOwnership(db, companyId, filePath) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_meta'").get();
  if (!has) return false;
  const row = db.prepare("SELECT company_id FROM tenant_meta WHERE id = 1").get();
  if (row && row.company_id !== companyId) {
    throw new Error(`[tenancy] Refusing to open ${filePath}: it belongs to company ${row.company_id}, not ${companyId}.`);
  }
  return !!row;
}

// Opens (creating if needed) one company's database, brings its schema fully
// up to date with every existing migration below, and stamps it with its
// Company ID. Called once per company per process by src/tenancy.js (handles
// are cached there).
function openTenantDb(filePath, companyId, { isPrimary = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    assertTenantOwnership(db, companyId, filePath);
    db.exec(schema);
    migrateTenantDb(db, { seedSuperAdmin: isPrimary });
    stampCompanyId(db, companyId);
  } catch (e) {
    try { db.close(); } catch (_) { /* ignore */ }
    throw e;
  }
  return db;
}

// MULTI-COMPANY round — mandatory Company ID on every record. Every table in a
// company's database gets a company_id column whose DEFAULT is that company's
// own ID (so every existing INSERT statement in the app keeps working
// unchanged and automatically stamps the right company), plus two triggers
// that make the database itself ABORT any insert or update that tries to put a
// different company's ID on a row. Combined with the physical one-database-
// per-company separation, a row can never belong to, or be moved into, the
// wrong company. Idempotent: safe on every startup; ALTER TABLE ADD COLUMN is
// a metadata-only change in SQLite (existing rows are not rewritten).
function stampCompanyId(db, companyId) {
  if (!/^CMP-\d{4,}$/.test(companyId)) throw new Error(`Invalid company id ${companyId}`);
  const lit = `'${companyId}'`;
  db.exec("CREATE TABLE IF NOT EXISTS tenant_meta (id INTEGER PRIMARY KEY CHECK(id = 1), company_id TEXT NOT NULL, stamped_at TEXT NOT NULL)");
  const meta = db.prepare("SELECT company_id FROM tenant_meta WHERE id = 1").get();
  if (!meta) db.prepare("INSERT INTO tenant_meta (id, company_id, stamped_at) VALUES (1, ?, ?)").run(companyId, new Date().toISOString());
  else if (meta.company_id !== companyId) throw new Error(`[tenancy] tenant_meta mismatch: ${meta.company_id} vs ${companyId}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'tenant_meta'").all().map((r) => r.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    if (!cols.includes("company_id")) {
      db.exec(`ALTER TABLE "${t}" ADD COLUMN company_id TEXT NOT NULL DEFAULT ${lit}`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS "trg_${t}_company_ins" BEFORE INSERT ON "${t}" WHEN NEW.company_id IS NOT ${lit}
             BEGIN SELECT RAISE(ABORT, 'company_id mismatch: this database belongs to ${companyId}'); END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS "trg_${t}_company_upd" BEFORE UPDATE OF company_id ON "${t}" WHEN NEW.company_id IS NOT ${lit}
             BEGIN SELECT RAISE(ABORT, 'company_id mismatch: this database belongs to ${companyId}'); END`);
  }
}

// Every pre-existing startup migration, unchanged in substance — now applied to
// whichever company database is being opened (`db` is that company's handle).
function migrateTenantDb(db, { seedSuperAdmin = false } = {}) {
// --- lightweight migrations: safe to run every startup, never touches data ---
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("clients", "account_type", "TEXT NOT NULL DEFAULT 'customer' CHECK(account_type IN ('customer','company'))");
ensureColumn("clients", "account_number", "TEXT");
ensureColumn("clients", "email", "TEXT");
ensureColumn("clients", "id_number", "TEXT");
ensureColumn("clients", "balance_usd", "REAL NOT NULL DEFAULT 0");
ensureColumn("clients", "balance_slsh", "REAL NOT NULL DEFAULT 0");
ensureColumn("clients", "currency", "TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','SLSH'))");
ensureColumn("clients", "linked_account_id", "TEXT REFERENCES clients(id)");

// Backfill account numbers for any accounts that predate this field, in the
// order they were created, so nothing already in your database is left blank.
const missingNumbers = db.prepare("SELECT id FROM clients WHERE account_number IS NULL OR account_number = '' ORDER BY created_at ASC").all();
if (missingNumbers.length) {
  const maxRow = db.prepare("SELECT MAX(CAST(SUBSTR(account_number, 5) AS INTEGER)) as n FROM clients WHERE account_number LIKE 'ACC-%'").get();
  let seq = maxRow?.n || 0;
  const upd = db.prepare("UPDATE clients SET account_number = ? WHERE id = ?");
  for (const row of missingNumbers) {
    seq += 1;
    upd.run(`ACC-${String(seq).padStart(4, "0")}`, row.id);
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_account_number ON clients(account_number) WHERE account_number IS NOT NULL");
ensureColumn("quotations", "paid", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quotations", "paid_at", "TEXT");
ensureColumn("quotations", "paid_by", "TEXT");
ensureColumn("exchange_transactions", "from_account_id", "TEXT REFERENCES clients(id)");
ensureColumn("exchange_transactions", "to_account_id", "TEXT REFERENCES clients(id)");
ensureColumn("quotation_items", "extra_fields", "TEXT");
ensureColumn("users", "quotation_column_prefs", "TEXT");
ensureColumn("company_settings", "pdf_accent_color", "TEXT");
// APPEARANCE & BRANDING round: brand_color drives the app's live UI theme
// (sidebar/buttons/links/login gradient) via CSS custom properties, separate
// from pdf_accent_color above (which only affects generated PDFs). website
// and favicon_data_url round out the Branding spec's company-identity fields.
// None of the three need an index.
ensureColumn("company_settings", "brand_color", "TEXT");
ensureColumn("company_settings", "website", "TEXT");
// DAILY SLSH RATE round: a record-only companion to daily_rate/sale_rate
// for an existing database that predates this column — see schema.sql's
// own comment on rate_history and getCurrentDailySlshRate() in domain.js.
ensureColumn("rate_history", "daily_slsh_rate", "REAL");
ensureColumn("company_settings", "favicon_data_url", "TEXT");
ensureColumn("quotations", "charged", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quotations", "charged_at", "TEXT");
ensureColumn("quotations", "charged_by", "TEXT");
// APPEARANCE & BRANDING round 2: secondary_color/accent_color extend the
// Round 1 brand_color override to the app's remaining two semantic tokens
// (C.mint/C.cyan). status_*_color makes the three Pending/Paid/Refunded
// badge colors configurable independently of accent_color, since a Super
// Admin may want Refunded to differ from the general accent even though
// both default to the same historical hex (#42bfdd). font_family/font_size
// are plain string settings (a curated key, not free-form CSS) applied via
// CSS custom properties — see THEME_CSS/App() in frontend/app.jsx. None of
// these six need an index.
ensureColumn("company_settings", "secondary_color", "TEXT");
ensureColumn("company_settings", "accent_color", "TEXT");
ensureColumn("company_settings", "status_pending_color", "TEXT");
ensureColumn("company_settings", "status_paid_color", "TEXT");
ensureColumn("company_settings", "status_refunded_color", "TEXT");
ensureColumn("company_settings", "font_family", "TEXT");
ensureColumn("company_settings", "font_size", "TEXT");
// BRAND COLOR MANAGEMENT round: the 5 built-in themes (and any Custom Brand
// Color) carry their own exact primary_dark/primary_light/accent_bright
// values rather than having the frontend re-derive them from brand_color via
// lightness shifts — that derivation is still used as a *fallback* for older
// rows saved before this round (see the frontend's brand-color effect), but
// storing the real values keeps each built-in theme visually exact. brand_
// theme_key remembers which of the 5 named themes (or "custom") is active so
// the Settings UI can show "✓ Selected" correctly after a refresh without
// guessing from hex values alone.
ensureColumn("company_settings", "primary_dark", "TEXT");
ensureColumn("company_settings", "primary_light", "TEXT");
ensureColumn("company_settings", "accent_bright", "TEXT");
ensureColumn("company_settings", "brand_theme_key", "TEXT");
// PDF TEMPLATE & CUSTOMIZATION ENGINE round: registration/tax numbers are
// company-identity fields the spec's Branding section asks for that never
// existed anywhere in this app before — plain optional text, shown in a PDF
// header only when a template's show_registration_number/show_tax_number
// toggle is on (default off, so no existing PDF gains a line it didn't have).
ensureColumn("company_settings", "registration_number", "TEXT");
ensureColumn("company_settings", "tax_number", "TEXT");
ensureColumn("quotations", "charged_account_id", "TEXT REFERENCES clients(id)");
ensureColumn("quotations", "charged_currency", "TEXT");
ensureColumn("quotations", "charged_amount", "REAL");
ensureColumn("quotations", "charged_ledger_id", "TEXT");
ensureColumn("quotations", "refunded", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("quotations", "refunded_at", "TEXT");
ensureColumn("quotations", "refunded_by", "TEXT");
ensureColumn("account_ledger", "source_type", "TEXT");
ensureColumn("account_ledger", "source_id", "TEXT");
ensureColumn("account_ledger", "reference_number", "TEXT");
// CASH IN HAND / PAYMENT INTEGRATION round: a plain Deposit/Withdrawal
// against a customer account can now name the exact company Cash Account
// the money physically came from or went to (nullable — existing rows,
// and any new one where no Cash Account was required/selected, simply have
// no source tracked, exactly as before this round). `reference` is a new
// free-text field (distinct from the auto-generated `reference_number`),
// mirroring the same reference_number/reference split `transfers` already
// has, so a payment can carry a human-chosen reference like "ABD-LOAN-1500"
// alongside its system DEP-/WD- number.
ensureColumn("account_ledger", "cash_account_id", "TEXT REFERENCES cash_accounts(id)");
ensureColumn("account_ledger", "reference", "TEXT");
// The mirrored cash_ledger leg a Payment creates (see routes/accounts.js's
// ledgerMove) carries the SAME human-entered reference the customer-side
// account_ledger row got, in addition to its own independent system
// reference_number (CSHDEP-/CSHWD-) — so "Recent Cash Movements" can show
// the exact reference ("ABD-LOAN-1500") the spec asks for, not just the
// auto-generated one.
ensureColumn("cash_ledger", "reference", "TEXT");
// Backfill reference_number for any quotation-tagged ledger rows that
// predate this column, from the quotation they're still (at this point)
// linked to — after this, the column is self-sufficient and survives that
// quotation being deleted later.
db.exec(`
  UPDATE account_ledger
  SET reference_number = (SELECT q.number FROM quotations q WHERE q.id = account_ledger.source_id)
  WHERE reference_number IS NULL
    AND source_type IN ('quotation_charge','quotation_paid','quotation_refund')
    AND source_id IS NOT NULL
`);
ensureColumn("clients", "status", "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated'))");
ensureColumn("clients", "deactivated_at", "TEXT");
ensureColumn("clients", "deactivated_by", "TEXT");
ensureColumn("clients", "deactivation_reason", "TEXT");
ensureColumn("clients", "reactivated_at", "TEXT");
ensureColumn("clients", "reactivated_by", "TEXT");
ensureColumn("clients", "deleted_at", "TEXT");
ensureColumn("clients", "deleted_by", "TEXT");

// UNIFIED TRANSACTION HISTORY — formatted reference numbers. Exchanges and
// Transfers get their own sequential per-year reference (EX-YYYY-####,
// TR-YYYY-####), mirroring quotations' QT-YYYY-#### scheme, instead of a
// raw id fragment. Plain (unlinked) deposits/withdrawals reuse the existing
// account_ledger.reference_number column (already populated for quotation
// legs) with DEP-/WD- prefixes — disjoint from QT- so there's no collision.
ensureColumn("exchange_transactions", "reference_number", "TEXT");
ensureColumn("transfers", "reference_number", "TEXT");
// Quotation Detail now shows an "Updated By / Updated Date" field (GLOBAL
// TABLE UX round) — these are only set once a quotation is actually edited
// via PATCH /api/quotations/:id; a never-edited quotation shows a dash.
ensureColumn("quotations", "updated_by", "TEXT");
ensureColumn("quotations", "updated_by_name", "TEXT");
ensureColumn("quotations", "updated_at", "TEXT");

// PROFESSIONAL QUOTATION CUSTOMIZATION & MULTI-CURRENCY SYSTEM round:
// currency_mode is the quotation's own DISPLAY/CALCULATION mode — 'USD',
// 'SLSH', or 'BOTH' — and is deliberately a SEPARATE concept from
// charged_currency (which account currency actually gets debited; always
// USD or SLSH, never 'BOTH' — see createAndChargeQuotation in
// routes/quotations.js, completely unchanged by this round). A quotation
// whose currency_mode is 'BOTH' still charges exactly one real, single-
// currency account, same as always; 'BOTH' only means its line items and
// totals are shown/calculated in both currencies for the client's benefit.
// ensureColumn's ALTER TABLE ADD COLUMN DEFAULT populates every existing
// row with 'USD' initially — the explicit backfill below immediately
// corrects that to each row's own real historical currency (its
// charged_currency), so no pre-existing quotation's PDF/Excel/Preview
// changes appearance just from this upgrade running.
const hadCurrencyMode = db.prepare("PRAGMA table_info(quotations)").all().some((c) => c.name === "currency_mode");
ensureColumn("quotations", "currency_mode", "TEXT NOT NULL DEFAULT 'USD' CHECK(currency_mode IN ('USD','SLSH','BOTH'))");
if (!hadCurrencyMode) {
  db.exec("UPDATE quotations SET currency_mode = charged_currency WHERE charged_currency IN ('USD','SLSH')");
}

// Same round: an optional SYSTEM-WIDE default for the quotation line-items
// "Customize Columns" layout (src/routes/quotations.js's GET/PATCH
// /api/quotations/column-defaults), gated by the existing
// "settings.manageTableDefaults" granular permission — the same permission
// and "system default a Super Admin sets, everyone else inherits until they
// save their own personal override" pattern src/routes/tableLayouts.js
// already uses for every other customizable table in this app. Personal
// per-user column choices keep living in users.quotation_column_prefs,
// completely unchanged.
ensureColumn("company_settings", "quotation_column_defaults", "TEXT");
// ACCOUNT IMPORT & EXPORT round: a free-text notes field on an account,
// exported/importable alongside the other master-data columns (spec's
// "Notes" export column, item 1). Purely informational — never touched by
// balance/ledger logic, and blank by default for every existing account.
ensureColumn("clients", "notes", "TEXT");
// Backfill: assign references to every existing row that predates these
// columns, in the order they actually happened (date ASC, id ASC), bucketed
// by the YEAR of that row's own date — never today's year — so historical
// references land in the year they belong to, exactly like a fresh row
// created back then would have gotten.
function backfillReferences(table, prefix, idCol = "id", dateCol = "date") {
  const rows = db.prepare(`SELECT ${idCol} as id, ${dateCol} as date FROM ${table} WHERE reference_number IS NULL ORDER BY ${dateCol} ASC, ${idCol} ASC`).all();
  if (!rows.length) return;
  const seqByYear = {};
  const upd = db.prepare(`UPDATE ${table} SET reference_number = ? WHERE ${idCol} = ?`);
  for (const row of rows) {
    const year = (row.date || "").slice(0, 4) || String(new Date().getFullYear());
    const maxRow = db.prepare(`SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM ${table} WHERE reference_number LIKE ?`).get(`${prefix}-${year}-`.length + 1, `${prefix}-${year}-%`);
    if (!(year in seqByYear)) seqByYear[year] = maxRow?.n || 0;
    seqByYear[year] += 1;
    upd.run(`${prefix}-${year}-${String(seqByYear[year]).padStart(4, "0")}`, row.id);
  }
}
backfillReferences("exchange_transactions", "EX");
backfillReferences("transfers", "TR");

// RATE MANAGEMENT UNIFICATION round: one-time backfill that merges the two
// legacy history tables (exchange_rates = Daily Rate, sale_rates = Sale
// Rate) into the new unified `rate_history` table (schema.sql), so nothing
// from either history is lost when a pre-existing database upgrades into
// this round. Runs only while rate_history is still completely empty —
// true for both a genuinely fresh install (nothing to merge, so this is a
// silent no-op) and an existing database that predates this round (real
// data to merge); a database already migrated (or created fresh under this
// round, where every new save only ever lands in rate_history — see
// saveRateHistory in domain.js) has a non-empty rate_history forever after,
// so this becomes a permanent no-op on every later startup.
//
// The merge walks both legacy tables in chronological order together (a
// classic two-pointer merge) and, at every single event from EITHER table,
// writes one rate_history row carrying the CURRENT value of both sides at
// that moment — the side that didn't just change is carried forward from
// whatever it last was (or left null if that side had never been set yet
// at that point in time). This reconstructs the exact same "one combined
// record per change" shape a from-day-one unified system would have
// produced, with zero loss of granularity from either original history.
{
  const alreadyMigrated = db.prepare("SELECT COUNT(*) as n FROM rate_history").get().n > 0;
  if (!alreadyMigrated) {
    const dailyEvents = db.prepare("SELECT rate, set_by, set_by_name, at FROM exchange_rates ORDER BY at ASC, id ASC").all();
    const saleEvents = db.prepare("SELECT rate, set_by, set_by_name, at FROM sale_rates ORDER BY at ASC, id ASC").all();
    if (dailyEvents.length || saleEvents.length) {
      const { uid: mkUid } = require("../../src/util");
      const ins = db.prepare("INSERT INTO rate_history (id, currency_pair, daily_rate, sale_rate, rate_difference, note, set_by, set_by_name, at) VALUES (?,?,?,?,?,?,?,?,?)");
      let i = 0, j = 0, curDaily = null, curSale = null, mergedCount = 0;
      while (i < dailyEvents.length || j < saleEvents.length) {
        const d = dailyEvents[i], s = saleEvents[j];
        const takeDaily = d && (!s || d.at <= s.at);
        const ev = takeDaily ? d : s;
        if (takeDaily) { curDaily = ev.rate; i++; } else { curSale = ev.rate; j++; }
        const difference = curDaily != null && curSale != null ? curDaily - curSale : null;
        ins.run(mkUid("rh"), "USD_SLSH", curDaily, curSale, difference, null, ev.set_by, ev.set_by_name, ev.at);
        mergedCount++;
      }
      // eslint-disable-next-line no-console
      console.log(`[migration] Merged ${dailyEvents.length} Daily Rate + ${saleEvents.length} Sale Rate legacy history row(s) into ${mergedCount} unified rate_history row(s).`);
    }
  }
}
// Plain deposits/withdrawals: only rows with no source tag (a real, unlinked
// manual movement) and no reference yet — quotation-tagged legs already got
// their QT- reference via the migration above this one.
{
  const rows = db.prepare("SELECT id, type, date FROM account_ledger WHERE reference_number IS NULL AND source_type IS NULL ORDER BY date ASC, id ASC").all();
  const seqByKey = {}; // `${prefix}-${year}` -> seq
  const upd = db.prepare("UPDATE account_ledger SET reference_number = ? WHERE id = ?");
  for (const row of rows) {
    const prefix = row.type === "withdrawal" ? "WD" : "DEP";
    const year = (row.date || "").slice(0, 4) || String(new Date().getFullYear());
    const key = `${prefix}-${year}`;
    if (!(key in seqByKey)) {
      const maxRow = db.prepare("SELECT MAX(CAST(SUBSTR(reference_number, ?) AS INTEGER)) as n FROM account_ledger WHERE reference_number LIKE ?").get(`${key}-`.length + 1, `${key}-%`);
      seqByKey[key] = maxRow?.n || 0;
    }
    seqByKey[key] += 1;
    upd.run(`${key}-${String(seqByKey[key]).padStart(4, "0")}`, row.id);
  }
}

// Personal names (Account/Client/User names) are now canonically stored in
// full uppercase (see util.formatPersonName) — this brings any existing rows
// in line with newly created ones. Idempotent: only writes rows whose
// formatted value actually differs, so it's cheap and safe to run on every
// startup. Denormalized copies of a client's name (on exchange_transactions
// and quotations) are normalized the same way so everything stays consistent.
{
  const { formatPersonName } = require("../../src/util");
  // `clients.name` is UNIQUE. Some existing databases already contain two
  // separate customer rows whose names differ only by letter case (e.g.
  // "Aisha Nur" and "AISHA NUR") — pre-dating this uppercase rule, or
  // entered outside the app's own dedup logic. Uppercasing one of those in
  // place would collide with the other and violate the UNIQUE constraint,
  // crashing startup. Rather than crash, or silently merge two accounts
  // that may have entirely different balances/history (a decision only a
  // person should make), a row whose formatted name would collide with
  // ANOTHER existing row is left exactly as it was, with a console warning
  // so it can be reviewed and merged/renamed manually.
  const normalizeNameColumn = (table, column, where) => {
    const rows = db.prepare(`SELECT id, ${column} AS val FROM ${table}${where ? ` WHERE ${where}` : ""}`).all();
    const skipped = [];
    for (const row of rows) {
      const formatted = formatPersonName(row.val);
      if (formatted === row.val) continue;
      const collision = db.prepare(`SELECT id FROM ${table} WHERE ${column} = ? AND id != ?`).get(formatted, row.id);
      if (collision) {
        skipped.push({ id: row.id, from: row.val, to: formatted, collidesWith: collision.id });
        continue;
      }
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(formatted, row.id);
    }
    if (skipped.length) {
      // eslint-disable-next-line no-console
      console.warn(`[migration] Left ${skipped.length} ${table}.${column} value(s) as-is — uppercasing would collide with another row that already has that exact name. These look like duplicate accounts differing only by letter case; review and merge/rename them manually:`);
      for (const s of skipped) console.warn(`  ${table}#${s.id}: "${s.from}" -> "${s.to}" (collides with ${table}#${s.collidesWith})`);
    }
  };
  // Only PERSON (customer-type) account names are uppercased — company
  // account names are left exactly as entered, per business rules.
  normalizeNameColumn("clients", "name", "account_type = 'customer'");
  // Users are always people.
  normalizeNameColumn("users", "name");
  // Denormalized client_name copies on exchange_transactions/quotations are
  // re-synced from the now-corrected clients.name (via the linked client_id)
  // rather than independently uppercased — this automatically inherits the
  // right casing for both customer (now uppercase) and company (untouched)
  // accounts. A row with no linked client_id is left exactly as typed.
  db.exec(`
    UPDATE exchange_transactions
    SET client_name = (SELECT c.name FROM clients c WHERE c.id = exchange_transactions.client_id)
    WHERE client_id IS NOT NULL
      AND client_name IS NOT (SELECT c.name FROM clients c WHERE c.id = exchange_transactions.client_id)
  `);
  db.exec(`
    UPDATE quotations
    SET client_name = (SELECT c.name FROM clients c WHERE c.id = quotations.client_id)
    WHERE client_id IS NOT NULL
      AND client_name IS NOT (SELECT c.name FROM clients c WHERE c.id = quotations.client_id)
  `);
}

// Widen quotations.status to allow 'Cancelled'. SQLite can't ALTER a CHECK
// constraint in place, so this recreates the table with the wider one and
// copies every row across by explicit column name (never SELECT *, so this
// is safe regardless of each database's actual physical column order) —
// guarded to run only once, skipped entirely once already widened.
const quotationsDDL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotations'").get();
// Also skip if the table is already on the NEWER Pending/Paid/Refunded
// constraint below (schema.sql itself now creates fresh installs directly
// with that constraint, so a brand-new database never has 'Cancelled' in
// its DDL either — without this check this migration would wrongly fire on
// every fresh install and try to rebuild the table with the OLD Draft/Sent/
// Accepted/Rejected/Expired/Cancelled CHECK, corrupting the real data.
if (quotationsDDL && !quotationsDDL.sql.includes("'Cancelled'") && !quotationsDDL.sql.includes("'Refunded'")) {
  // Dropping "quotations" mid-migration (even briefly, before the rename
  // lands) trips FOREIGN KEY enforcement for any other table that
  // references it (quotation_items.quotation_id, most importantly) — SQLite
  // validates FK targets by table name, and it's momentarily gone. Foreign
  // key checks can only be toggled outside an active transaction, so this
  // turns them off first, runs the whole migration in one transaction, then
  // always turns them back on afterward (success or failure) before
  // anything else in this file runs.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE quotations_new (
        id TEXT PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        client_id TEXT REFERENCES clients(id),
        client_name TEXT NOT NULL,
        client_contact TEXT,
        client_address TEXT,
        issue_date TEXT NOT NULL,
        valid_until TEXT,
        status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Sent','Accepted','Rejected','Expired','Cancelled')),
        invoiced INTEGER NOT NULL DEFAULT 0,
        paid INTEGER NOT NULL DEFAULT 0,
        paid_at TEXT,
        paid_by TEXT,
        charged INTEGER NOT NULL DEFAULT 0,
        charged_at TEXT,
        charged_by TEXT,
        charged_account_id TEXT REFERENCES clients(id),
        charged_amount REAL,
        charged_currency TEXT,
        charged_ledger_id TEXT,
        refunded INTEGER NOT NULL DEFAULT 0,
        refunded_at TEXT,
        refunded_by TEXT,
        discount_percent REAL NOT NULL DEFAULT 0,
        tax_percent REAL NOT NULL DEFAULT 0,
        rate_used REAL NOT NULL,
        notes TEXT,
        reject_reason TEXT,
        created_by TEXT,
        created_by_name TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO quotations_new (
        id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until, status,
        invoiced, paid, paid_at, paid_by, charged, charged_at, charged_by, charged_account_id, charged_amount,
        charged_currency, charged_ledger_id, refunded, refunded_at, refunded_by, discount_percent, tax_percent,
        rate_used, notes, reject_reason, created_by, created_by_name, created_at
      )
      SELECT
        id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until, status,
        invoiced, paid, paid_at, paid_by, charged, charged_at, charged_by, charged_account_id, charged_amount,
        charged_currency, charged_ledger_id, refunded, refunded_at, refunded_by, discount_percent, tax_percent,
        rate_used, notes, reject_reason, created_by, created_by_name, created_at
      FROM quotations;
      DROP TABLE quotations;
      ALTER TABLE quotations_new RENAME TO quotations;
      CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// TWO-STEP ACCOUNT LEDGER LOGIC: a quotation now moves from the old
// Draft/Sent/Accepted/Rejected/Expired/Cancelled workflow to a simple
// Pending -> Paid/Refunded one, because every quotation now posts a real
// account-ledger Withdrawal the instant it's created (previously an
// optional, later "Charge Account" step) and a real settlement Deposit once
// it's Paid or Refunded. Same "recreate the table" approach as above (SQLite
// can't ALTER a CHECK constraint), guarded to run only once.
const quotationsDDL2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotations'").get();
if (quotationsDDL2 && !quotationsDDL2.sql.includes("'Refunded'")) {
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE quotations_new2 (
        id TEXT PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        client_id TEXT REFERENCES clients(id),
        client_name TEXT NOT NULL,
        client_contact TEXT,
        client_address TEXT,
        issue_date TEXT NOT NULL,
        valid_until TEXT,
        status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Paid','Refunded')),
        invoiced INTEGER NOT NULL DEFAULT 0,
        paid INTEGER NOT NULL DEFAULT 0,
        paid_at TEXT,
        paid_by TEXT,
        paid_ledger_id TEXT,
        charged INTEGER NOT NULL DEFAULT 0,
        charged_at TEXT,
        charged_by TEXT,
        charged_account_id TEXT REFERENCES clients(id),
        charged_amount REAL,
        charged_currency TEXT,
        charged_ledger_id TEXT,
        refunded INTEGER NOT NULL DEFAULT 0,
        refunded_at TEXT,
        refunded_by TEXT,
        discount_percent REAL NOT NULL DEFAULT 0,
        tax_percent REAL NOT NULL DEFAULT 0,
        rate_used REAL NOT NULL,
        notes TEXT,
        reject_reason TEXT,
        created_by TEXT,
        created_by_name TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO quotations_new2 (
        id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until, status,
        invoiced, paid, paid_at, paid_by, charged, charged_at, charged_by, charged_account_id, charged_amount,
        charged_currency, charged_ledger_id, refunded, refunded_at, refunded_by, discount_percent, tax_percent,
        rate_used, notes, reject_reason, created_by, created_by_name, created_at
      )
      SELECT
        id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until,
        -- Old workflow status never mapped 1:1 onto financial state, so this
        -- maps by what ACTUALLY happened to the money, not the old label:
        --   refunded          -> Refunded (a reversal deposit already exists)
        --   charged & paid    -> Paid (the missing settlement deposit this
        --                        implies is synthesized just below, once this
        --                        table is back and FK checks are on again)
        --   anything else     -> Pending (includes never-charged historical
        --                        Draft/Sent/Rejected/Expired/Cancelled rows —
        --                        no money ever moved for these, so nothing is
        --                        back-dated onto any account; they simply
        --                        carry no ledger history, same as before)
        CASE WHEN refunded = 1 THEN 'Refunded' WHEN charged = 1 AND paid = 1 THEN 'Paid' ELSE 'Pending' END,
        invoiced, paid, paid_at, paid_by, charged, charged_at, charged_by, charged_account_id, charged_amount,
        charged_currency, charged_ledger_id, refunded, refunded_at, refunded_by, discount_percent, tax_percent,
        rate_used, notes, reject_reason, created_by, created_by_name, created_at
      FROM quotations;
      DROP TABLE quotations;
      ALTER TABLE quotations_new2 RENAME TO quotations;
      CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }

  // Bring legacy "charged, marked Paid via the old invoice flow, but never
  // actually refunded" rows in line with the new invariant that every Paid
  // quotation has a REAL settlement Deposit ledger entry, not just a flag —
  // synthesize the missing Deposit (crediting the money back, exactly as
  // the new Pay action would have) and rebuild that account's balance.
  // Never destructive: this only ever ADDS a compensating ledger entry.
  const needsSettlement = db.prepare(
    "SELECT * FROM quotations WHERE status = 'Paid' AND charged_account_id IS NOT NULL AND paid_ledger_id IS NULL"
  ).all();
  if (needsSettlement.length) {
    // eslint-disable-next-line no-console
    console.warn(`[migration] Synthesizing the missing settlement Deposit for ${needsSettlement.length} legacy quotation(s) marked Paid under the old invoice flow (charged, never refunded) — bringing them in line with the new two-step ledger model:`);
    for (const q of needsSettlement) {
      const existingSettlement = db.prepare("SELECT id FROM account_ledger WHERE source_type = 'quotation_paid' AND source_id = ?").get(q.id);
      if (existingSettlement) continue; // already has one somehow — never double-post
      const ledgerId = `ldg_migr_${q.id}`;
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(ledgerId, q.charged_account_id, "deposit", q.charged_currency, q.charged_amount, 0, `Quotation Paid — ${q.number} (migrated)`, null, "System", now, "quotation_paid", q.id, q.number);
      // Rebuild the account's balance for that currency from full ledger
      // history — same recompute rebuildAccountBalance() does at runtime,
      // done here with raw SQL since this file is still mid-startup.
      // NOTE: this runs before ensureColumn("account_ledger", "created_at", …)
      // below (still mid-startup here), so `created_at` isn't guaranteed to
      // exist on this table yet — tie-break stays date/id only, matching
      // the tiny set of legacy rows this one-time synthesis ever touches.
      const entries = db.prepare("SELECT id, type, amount FROM account_ledger WHERE client_id = ? AND currency = ? ORDER BY date ASC, id ASC").all(q.charged_account_id, q.charged_currency);
      let balance = 0;
      for (const e of entries) {
        balance += e.type === "deposit" ? e.amount : -e.amount;
        db.prepare("UPDATE account_ledger SET balance_after = ? WHERE id = ?").run(balance, e.id);
      }
      const field = q.charged_currency === "USD" ? "balance_usd" : "balance_slsh";
      db.prepare(`UPDATE clients SET ${field} = ? WHERE id = ?`).run(balance, q.charged_account_id);
      db.prepare("UPDATE quotations SET paid_ledger_id = ? WHERE id = ?").run(ledgerId, q.id);
      console.warn(`  ${q.number}: +${q.charged_amount} ${q.charged_currency} credited back to account ${q.charged_account_id}`);
    }
  }
}

// QUOTATION SETTLEMENT — PARTIAL PAYMENT UPGRADE round: a quotation's status
// must now also allow 'Partially Paid' (between Pending and Paid), so the
// CHECK constraint baked into the table needs widening. Same guarded-rebuild
// approach as quotationsDDL/quotationsDDL2 above (SQLite can't ALTER a CHECK
// constraint) — but instead of hand-retyping every column (which would
// silently drop anything a later ensureColumn call added above, e.g.
// updated_by/updated_at/currency_mode), this rewrites the live CREATE TABLE
// SQL's CHECK clause in place, verbatim, and copies every column across by
// name via PRAGMA table_info. Guarded to run only once (checks the CHECK
// clause already contains 'Partially Paid').
//
// IMPORTANT: after a table has already been through one of the earlier
// guarded rebuilds (quotationsDDL/quotationsDDL2's "ALTER TABLE ... RENAME TO
// quotations"), SQLite stores the renamed identifier QUOTED in
// sqlite_master.sql — i.e. `CREATE TABLE "quotations" (...)`, not
// `CREATE TABLE quotations (...)`. A plain .replace("CREATE TABLE
// quotations", ...) silently fails to match that quoted form, leaving the
// table name untouched while the CHECK clause still gets swapped in — the
// resulting statement then tries to (re)create a table still named
// "quotations", which already exists, and the whole migration (and the
// server) crashes on boot. The regex below matches the table name whether or
// not it's quoted (and whether or not "IF NOT EXISTS" precedes it, in case a
// database is ever built straight from schema.sql's own literal text) so the
// rename always lands. The whole block is additionally wrapped in a
// try/catch that only logs — a CHECK-widening hiccup here must never take
// the rest of the server down with it.
try {
  const quotationsDDL3 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotations'").get();
  if (quotationsDDL3 && !quotationsDDL3.sql.includes("Partially Paid")) {
    const oldCheck = "CHECK(status IN ('Pending','Paid','Refunded'))";
    const newCheck = "CHECK(status IN ('Pending','Partially Paid','Paid','Refunded'))";
    if (quotationsDDL3.sql.includes(oldCheck)) {
      const renameRe = /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["'`\[]?quotations["'`\]]?/i;
      if (renameRe.test(quotationsDDL3.sql)) {
        const newSql = quotationsDDL3.sql
          .replace(renameRe, (_m, ifNotExists) => `CREATE TABLE ${ifNotExists || ""}quotations_new3`)
          .replace(oldCheck, newCheck);
        db.exec("PRAGMA foreign_keys = OFF;");
        db.exec("BEGIN");
        try {
          // Clean up any half-finished attempt from a previous crashed boot
          // before trying again, so a stale quotations_new3 can never block
          // this from ever succeeding.
          db.exec("DROP TABLE IF EXISTS quotations_new3;");
          db.exec(newSql);
          const cols = db.prepare("PRAGMA table_info(quotations)").all().map((c) => c.name).join(", ");
          db.exec(`INSERT INTO quotations_new3 (${cols}) SELECT ${cols} FROM quotations;`);
          db.exec("DROP TABLE quotations;");
          db.exec("ALTER TABLE quotations_new3 RENAME TO quotations;");
          db.exec("CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);");
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        } finally {
          db.exec("PRAGMA foreign_keys = ON;");
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn("[migration] Could not locate the quotations table's own name inside its CREATE statement — skipping the widen-to-'Partially Paid' rebuild this boot. The app will keep starting; recording a partial payment may be rejected by the database until this is resolved.");
      }
    }
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[migration] Failed to widen quotations.status to allow 'Partially Paid' — the server will keep starting regardless, but recording a partial payment may be rejected until this is fixed:", e);
}

// Accounts are now single-currency (each account is either USD or SLSH, not
// both). Any pre-existing account that had a nonzero balance in the "other"
// currency gets a linked counterpart account created automatically, carrying
// that balance over — nothing is lost, and it only runs once per account
// (guarded by linked_account_id already being set).
function nextAccNum() {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(account_number, 5) AS INTEGER)) as n FROM clients WHERE account_number LIKE 'ACC-%'").get();
  return `ACC-${String((row?.n || 0) + 1).padStart(4, "0")}`;
}
const needsSplit = db.prepare("SELECT * FROM clients WHERE balance_slsh != 0 AND linked_account_id IS NULL AND currency = 'USD'").all();
for (const acc of needsSplit) {
  const counterpartId = `cl_split_${acc.id}`;
  const already = db.prepare("SELECT id FROM clients WHERE id = ?").get(counterpartId);
  if (already) continue;
  const now = new Date().toISOString();
  let counterpartName = `${acc.name} (SLSH)`;
  let suffix = 2;
  while (db.prepare("SELECT id FROM clients WHERE name = ?").get(counterpartName)) {
    counterpartName = `${acc.name} (SLSH ${suffix})`;
    suffix += 1;
  }
  db.prepare(
    "INSERT INTO clients (id, name, account_number, account_type, contact, email, id_number, address, balance_usd, balance_slsh, currency, linked_account_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(counterpartId, counterpartName, nextAccNum(), acc.account_type, acc.contact, acc.email, acc.id_number, acc.address, 0, acc.balance_slsh, "SLSH", acc.id, now);
  if (acc.balance_slsh > 0) {
    db.prepare(
      "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(`ldg_split_${acc.id}`, counterpartId, "deposit", "SLSH", acc.balance_slsh, acc.balance_slsh, "Split out from combined account during upgrade", null, "System", now);
  }
  db.prepare("UPDATE clients SET linked_account_id = ?, balance_slsh = 0 WHERE id = ?").run(counterpartId, acc.id);
}

// ============================================================
// RBAC — dynamic roles + granular permissions (SUPER ADMIN + ADVANCED ROLE
// & PERMISSION MANAGEMENT round, Phase 1). The `roles`/`role_permissions`/
// `user_permission_overrides` tables are created fresh by schema.sql above
// (CREATE TABLE IF NOT EXISTS, so this also creates them on an EXISTING
// database that predates this round — no separate "ensureTable" needed).
// These columns on `users`, though, need the usual ensureColumn treatment
// since ALTER TABLE ADD COLUMN is the only way to add them to a database
// that already has a `users` table.
// ============================================================
ensureColumn("users", "role_id", "TEXT REFERENCES roles(id)");
ensureColumn("users", "status", "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated','suspended'))");
ensureColumn("users", "permissions_version", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("users", "deleted_at", "TEXT");
ensureColumn("users", "deleted_by", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id)");
// ROLE MANAGEMENT round, Phase 2: same reasoning as users.role_id right
// above (and the schema.sql/db.js split explained there) — `roles` already
// exists on any database that went through Phase 1, so this column can only
// be added here, via ALTER TABLE, never by the CREATE TABLE IF NOT EXISTS in
// schema.sql alone.
ensureColumn("roles", "status", "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive'))");

{
  const { LEGACY_KEY_MAP } = require("../../src/permissions");
  const nowIso = new Date().toISOString();

  // Universal "view" grants: cross-checked directly against app.jsx's
  // sidebar `show:` conditions (not just which backend GET endpoints happen
  // to skip a requirePerm check — several of those are technically
  // reachable without a permission today but the UI never exposes them
  // without one, and the granular catalog should match real-world access,
  // not the API's laxity). Only the Accounts menu is truly unconditional
  // (`show: true`); Exchange, Quotations, Deposits & Withdrawals, and
  // Settings are each gated behind specific legacy flag combinations in the
  // sidebar, so their view grants come from LEGACY_KEY_MAP entries instead
  // (exchangeCreate/exchangeAll -> exchange.view, quotationsManage/
  // quotationsApprove -> quotations.view, accountsManage/reports ->
  // payments.view, settingsManage -> settings.view). Transfers has no
  // dedicated sidebar entry at all (transfers happen via an account's own
  // Quick Actions) and nothing gates viewing transfer records, so it stays
  // universal.
  const UNIVERSAL_VIEW = ["accounts.view", "transfers.view"];
  // ACCOUNT IMPORT & EXPORT round: GET /api/accounts/export.pdf and
  // export.xlsx were, until now, gated by nothing but requireAuth — ANY
  // authenticated user could export accounts before this round added real
  // permission checks to them. To make the new accounts.export/print
  // (already reserved keys in permissions.js, just never granted or
  // enforced) into a real gate WITHOUT narrowing who can already export
  // today, they're granted the same way UNIVERSAL_VIEW is: to every role,
  // fresh install or pre-existing (see the "still at shipped defaults"
  // backfill below for the pre-existing case).
  const UNIVERSAL_EXPORT = ["accounts.export", "accounts.print"];

  // Exactly what src/rbac.js's PERMS object (the old hard-coded table) used
  // to grant per legacy role, expressed the same way — this is ONLY used to
  // seed the equivalent granular role_permissions rows once, on first boot
  // of this round; it is not consulted at request time (rbac.js is).
  const LEGACY_PERMS_SNAPSHOT = {
    admin: { users: true, rateManage: true, exchangeCreate: true, exchangeAll: true, exchangeUpdate: true, exchangeDelete: true, transferUpdate: true, transferDelete: true, quotationsManage: true, quotationsApprove: true, quotationsDelete: true, reports: true, accountsManage: true, accountsDelete: true, settingsManage: true },
    manager: { users: false, rateManage: true, exchangeCreate: false, exchangeAll: true, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: true, quotationsDelete: true, reports: true, accountsManage: true, accountsDelete: true, settingsManage: false },
    accountant: { users: false, rateManage: false, exchangeCreate: true, exchangeAll: true, exchangeUpdate: true, exchangeDelete: true, transferUpdate: true, transferDelete: true, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: true, accountsManage: true, accountsDelete: false, settingsManage: false },
    cashier: { users: false, rateManage: false, exchangeCreate: true, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: false, accountsManage: false, accountsDelete: false, settingsManage: false },
    sales: { users: false, rateManage: false, exchangeCreate: false, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: true, quotationsApprove: false, quotationsDelete: false, reports: false, accountsManage: true, accountsDelete: false, settingsManage: false },
    viewer: { users: false, rateManage: false, exchangeCreate: false, exchangeAll: false, exchangeUpdate: false, exchangeDelete: false, transferUpdate: false, transferDelete: false, quotationsManage: false, quotationsApprove: false, quotationsDelete: false, reports: true, accountsManage: false, accountsDelete: false, settingsManage: false },
  };
  // Admin additionally gets full Roles management plus the two User
  // capabilities that genuinely have no legacy equivalent — permanently
  // deleting a user and managing a user's custom permission overrides.
  // Neither a DELETE /api/users/:id endpoint nor any permission-override
  // system existed before this round, so there was no legacy flag to derive
  // them from; everything else "users" already grants (view/create/update/
  // deactivate/activate/resetPassword/assignRole) comes from
  // LEGACY_KEY_MAP.users itself now. Nobody but admin gets any of this —
  // matches today's reality that only "admin" could touch Users at all.
  // TABLE CUSTOMIZATION round: same precedent as the Users/Roles grants
  // above — "settings.manageTableDefaults" is another brand-new,
  // granular-only capability with no legacy flag to derive it from, so
  // it's an explicit extra grant rather than something LEGACY_PERMS_SNAPSHOT
  // could ever produce.
  // ACCOUNT IMPORT & EXPORT round: accounts.import / accounts.importOpeningBalance
  // are brand-new, no-legacy-equivalent capabilities (bulk import never
  // existed before), same precedent as users.delete/managePermissions above
  // — Admin (and Super Admin, who bypasses grants entirely) gets them from
  // day one; any other role must be granted them later via Roles Management.
  const ADMIN_EXTRA_GRANTS = ["users.delete", "users.managePermissions", "roles.view", "roles.create", "roles.update", "roles.delete", "roles.managePermissions", "settings.manageTableDefaults", "dashboard.customize", "dashboard.export", "accounts.import", "accounts.importOpeningBalance",
    // COMPANY EXPENSES round: a Company Admin runs their company's spending.
    "expenses.view", "expenses.create", "expenses.update", "expenses.cancel", "expenses.manageCategories", "expenses.export"];

  function computeRoleGrants(legacyFlags) {
    const grants = new Set([...UNIVERSAL_VIEW, ...UNIVERSAL_EXPORT]);
    for (const [legacyKey, isOn] of Object.entries(legacyFlags)) {
      if (!isOn) continue;
      for (const granular of LEGACY_KEY_MAP[legacyKey] || []) grants.add(granular);
    }
    return grants;
  }

  const ROLE_DEFS = [
    { key: "super_admin", name: "Super Admin", description: "Full, unconditional access to the entire system. Cannot be restricted by any permission setting.", isSuperAdmin: 1, isProtected: 1, grants: null },
    { key: "admin", name: "Admin", description: "Extensive management access, configurable by a Super Admin.", isSuperAdmin: 0, isProtected: 1, grants: new Set([...computeRoleGrants(LEGACY_PERMS_SNAPSHOT.admin), ...ADMIN_EXTRA_GRANTS]) },
    { key: "manager", name: "Manager", description: "Oversees accounts, exchange rates, and quotation approvals.", isSuperAdmin: 0, isProtected: 1, grants: computeRoleGrants(LEGACY_PERMS_SNAPSHOT.manager) },
    { key: "accountant", name: "Accountant", description: "Handles day-to-day financial transactions and account management.", isSuperAdmin: 0, isProtected: 1, grants: computeRoleGrants(LEGACY_PERMS_SNAPSHOT.accountant) },
    { key: "cashier", name: "Cashier / Teller", description: "Records exchange transactions at the counter.", isSuperAdmin: 0, isProtected: 1, grants: computeRoleGrants(LEGACY_PERMS_SNAPSHOT.cashier) },
    { key: "sales", name: "Sales Staff", description: "Creates and manages quotations for company accounts.", isSuperAdmin: 0, isProtected: 1, grants: computeRoleGrants(LEGACY_PERMS_SNAPSHOT.sales) },
    { key: "viewer", name: "Viewer / Auditor", description: "Read-only access, including reports.", isSuperAdmin: 0, isProtected: 1, grants: computeRoleGrants(LEGACY_PERMS_SNAPSHOT.viewer) },
  ];

  for (const def of ROLE_DEFS) {
    let role = db.prepare("SELECT * FROM roles WHERE key = ?").get(def.key);
    if (!role) {
      const id = `role_${def.key}`;
      db.prepare(
        "INSERT INTO roles (id, key, name, description, is_super_admin, is_protected, permissions_version, created_at) VALUES (?,?,?,?,?,?,1,?)"
      ).run(id, def.key, def.name, def.description, def.isSuperAdmin, def.isProtected, nowIso);
      role = { id };
      if (def.grants) {
        const ins = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?,?)");
        for (const key of def.grants) ins.run(id, key);
      }
    }
  }

  // TABLE CUSTOMIZATION round: "settings.manageTableDefaults" was added to
  // ADMIN_EXTRA_GRANTS after an existing installation may already have
  // seeded its Admin role — the `if (!role)` block above only inserts a
  // role's grants once, at the moment that role ROW is first created, so a
  // pre-existing Admin role would otherwise never pick up this brand-new
  // capability at all. Backfilling it unconditionally on every startup
  // would be wrong, though: it would silently undo a Super Admin who later
  // uses Roles Management to deliberately revoke it from Admin (Admin's
  // permissions are explicitly "configurable by a Super Admin", by design).
  // `updated_at IS NULL` is the signal that distinguishes those two cases —
  // every role starts with it NULL at creation (see the INSERT above,
  // which never sets it) and PATCH /api/roles/:id (src/routes/roles.js)
  // unconditionally stamps it on ANY edit, whatever changed. So this only
  // ever fires for an Admin role nobody has touched since — the exact
  // "still genuinely at its shipped defaults" condition — and permanently
  // stops the moment a Super Admin edits Admin for any reason at all,
  // including specifically to remove this one grant.
  {
    const adminRole = db.prepare("SELECT id, updated_at FROM roles WHERE key = 'admin'").get();
    if (adminRole && adminRole.updated_at === null) {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, 'settings.manageTableDefaults')").run(adminRole.id);
      // ENTERPRISE FINANCIAL DASHBOARD round: same still-at-shipped-defaults
      // backfill as settings.manageTableDefaults just above — only ever
      // fires for an Admin role nobody has edited since creation, and stops
      // permanently the moment a Super Admin edits Admin for any reason.
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, 'dashboard.customize')").run(adminRole.id);
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, 'dashboard.export')").run(adminRole.id);
    }
  }

  // CURRENCY / RATE / PROFIT PERMISSIONS round: backfills the three new
  // permission groups (src/permissions.js) onto every pre-existing legacy
  // role, so an installation that already has these six roles seeded sees
  // ZERO behavior change — this is an ADDITIVE round, not a replacement (see
  // the request this round implements: "do not break existing permissions").
  // Same "still at shipped defaults" guard as the Admin-only backfill just
  // above (updated_at IS NULL) — a role a Super Admin has since edited is
  // never silently touched again, whatever they changed it to.
  //
  // What each role gets mirrors exactly what was ALREADY true before this
  // round existed, since none of these three groups had any enforcement
  // point until now:
  //   - currency.usd + currency.slsh, for every role: no account was ever
  //     filtered by currency before, so every existing role keeps seeing
  //     both, same as today, until a Super Admin deliberately narrows one.
  //   - rates.view, for every role: GET /api/rate and GET /api/sale-rate
  //     (the current-rate readout) only ever required requireAuth, no
  //     permission at all — universal.
  //   - rates.viewHistory / exportHistory / updateDaily / updateSale /
  //     create, only for the roles that already had legacy rateManage=true
  //     (admin, manager) — GET /api/rate-history and both rate POST
  //     endpoints already required it.
  //   - profit.viewExchange, for every role: exchange_transactions.profit_usd
  //     was returned to anyone who could see the transaction at all, with no
  //     separate check — universal, same as rates.view.
  //   - profit.viewCompany / viewDashboard / viewReports / export: reserved
  //     (see permissions.js) — given to the same roles that already had the
  //     legacy "reports" flag (admin, manager, accountant, viewer), the
  //     closest existing precedent for "sees company financials", so they
  //     start pre-populated for whoever a Super Admin later builds a
  //     profit dashboard/report for, rather than starting at zero for
  //     everyone.
  {
    const RATE_MANAGE_ROLES = new Set(["admin", "manager"]);
    const REPORTS_FLAG_ROLES = new Set(["admin", "manager", "accountant", "viewer"]);
    for (const key of ["admin", "manager", "accountant", "cashier", "sales", "viewer"]) {
      const role = db.prepare("SELECT id, updated_at FROM roles WHERE key = ?").get(key);
      if (!role || role.updated_at !== null) continue; // never touch a role a Super Admin has since edited
      const grants = new Set(["currency.usd", "currency.slsh", "rates.view", "profit.viewExchange"]);
      if (RATE_MANAGE_ROLES.has(key)) {
        for (const g of ["rates.viewHistory", "rates.exportHistory", "rates.updateDaily", "rates.updateSale", "rates.create"]) grants.add(g);
      }
      if (REPORTS_FLAG_ROLES.has(key)) {
        for (const g of ["profit.viewCompany", "profit.viewDashboard", "profit.viewReports", "profit.export"]) grants.add(g);
      }
      const ins = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?,?)");
      for (const g of grants) ins.run(role.id, g);
    }
    // rates.delete has no legacy endpoint at all (there was never a way to
    // delete a rate-history row before this round) — same "brand-new,
    // no-legacy-equivalent" precedent as users.delete/managePermissions:
    // extra-granted to Admin only. Looked up fresh here (the `adminRole`
    // from the settings.manageTableDefaults backfill above is out of scope
    // — it's declared inside that block's own `{ }`).
    const adminRoleForRatesDelete = db.prepare("SELECT id, updated_at FROM roles WHERE key = 'admin'").get();
    if (adminRoleForRatesDelete && adminRoleForRatesDelete.updated_at === null) {
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, 'rates.delete')").run(adminRoleForRatesDelete.id);
    }
  }

  // ACCOUNT IMPORT & EXPORT round backfill. Two separate cases:
  //  1. accounts.export / accounts.print — grant to EVERY pre-existing role
  //     still at shipped defaults, since export was previously ungated for
  //     any authenticated user (see UNIVERSAL_EXPORT's own comment above) —
  //     this preserves today's behavior for existing installs exactly.
  //  2. accounts.import / accounts.importOpeningBalance — brand-new,
  //     no-legacy-equivalent capabilities, so only Admin (still at shipped
  //     defaults) is backfilled, same as the rates.delete backfill above.
  {
    for (const key of ["admin", "manager", "accountant", "cashier", "sales", "viewer"]) {
      const role = db.prepare("SELECT id, updated_at FROM roles WHERE key = ?").get(key);
      if (!role || role.updated_at !== null) continue; // never touch a role a Super Admin has since edited
      const ins = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?,?)");
      ins.run(role.id, "accounts.export");
      ins.run(role.id, "accounts.print");
    }
    const adminRoleForImport = db.prepare("SELECT id, updated_at FROM roles WHERE key = 'admin'").get();
    if (adminRoleForImport && adminRoleForImport.updated_at === null) {
      const ins = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?,?)");
      ins.run(adminRoleForImport.id, "accounts.import");
      ins.run(adminRoleForImport.id, "accounts.importOpeningBalance");
    }
  }

  // COMPANY EXPENSES round backfill: brand-new, no-legacy-equivalent
  // capabilities, so — exactly like accounts.import above — only an Admin
  // role still at its shipped defaults receives them; a role a Super Admin
  // has edited is never touched, and every other role gets them only when
  // a Super Admin grants them in Roles Management.
  {
    const adminRoleForExpenses = db.prepare("SELECT id, updated_at FROM roles WHERE key = 'admin'").get();
    if (adminRoleForExpenses && adminRoleForExpenses.updated_at === null) {
      const ins = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?,?)");
      for (const k of ["expenses.view", "expenses.create", "expenses.update", "expenses.cancel", "expenses.manageCategories", "expenses.export"]) ins.run(adminRoleForExpenses.id, k);
    }
  }
  // COMPANY EXPENSES round: the starting list of expense categories, seeded
  // once into a company that has none yet. These are configuration (like the
  // default roles and templates), never expense records.
  if ((db.prepare("SELECT COUNT(*) AS n FROM expense_categories").get().n || 0) === 0) {
    const ins = db.prepare("INSERT INTO expense_categories (id, name, status, is_builtin, sort_order, created_at, created_by) VALUES (?,?, 'active', 1, ?, ?, 'system')");
    const nowCat = new Date().toISOString();
    ["Office Rent", "Salaries and Wages", "Electricity", "Internet and Telephone", "Transportation and Fuel", "Office Supplies",
      "Maintenance and Repairs", "Utilities", "Marketing", "Bank Charges", "Other Expenses"]
      .forEach((name, i) => ins.run(`expcat_${String(i + 1).padStart(2, "0")}`, name, i + 1, nowCat));
  }

  // Backfill role_id for any user created before this round, from their
  // legacy `role` string — never touches a user that already has a role_id
  // (e.g. re-running this on every startup is a no-op once migrated).
  db.exec(`
    UPDATE users
    SET role_id = (SELECT id FROM roles WHERE key = users.role)
    WHERE role_id IS NULL
  `);

  // Backfill `status` for any user deactivated BEFORE this round: the
  // status column was added with a blanket DEFAULT 'active' (ensureColumn
  // above), so a pre-existing deactivated user (active=0) would otherwise
  // sit at the contradictory active=0/status='active' — routes/users.js's
  // PATCH only ever recomputes one from the other when a caller actually
  // asks to change it, so left alone that stale 'active' status would
  // never self-correct. requireAuth's own `!user.active` check already
  // keeps such a user locked out regardless (this is a display/data-
  // integrity fix, not a live security gap), but it's still real drift
  // worth reconciling once, here, rather than carrying it forward forever.
  db.exec(`
    UPDATE users
    SET status = 'deactivated'
    WHERE active = 0 AND status = 'active'
  `);

  // The new, SEPARATE Super Admin account (per the explicit choice made when
  // this round was scoped: a brand-new account, not promoting the existing
  // "admin" user) — created once, idempotently (guarded by username, like
  // every other seed-once block in this file). Demo credentials, matching
  // this app's existing demo-account convention (see scripts/seed.js).
  // MULTI-COMPANY round: only the PRIMARY company's database still seeds this
  // account (it is then promoted to a platform-level Super Admin by
  // src/tenancy.js). New companies never get a Super Admin user of their own —
  // Super Admins live in the control database and enter a company workspace
  // only through the authorized company switch.
  if (seedSuperAdmin && !db.prepare("SELECT id FROM users WHERE username = ?").get("super.admin")) {
    const superAdminRole = db.prepare("SELECT id FROM roles WHERE key = 'super_admin'").get();
    const { hashPassword } = require("../../src/auth");
    // SECURITY AUDIT round: set SUPER_ADMIN_INITIAL_PASSWORD on a brand-new
    // deployment so the first Super Admin never has a published password.
    // Without it the old default is still used for compatibility — but a
    // sign-in with it is forced to choose a new password before anything else.
    const { hash, salt } = hashPassword(process.env.SUPER_ADMIN_INITIAL_PASSWORD || "SuperAdmin123!");
    const id = "u_super_admin";
    db.prepare(
      "INSERT INTO users (id, name, username, password_hash, password_salt, role, role_id, status, active, permissions_version, last_login, created_at) VALUES (?,?,?,?,?,?,?, 'active', 1, 1, NULL, ?)"
    ).run(id, "SUPER ADMIN", "super.admin", hash, salt, "admin", superAdminRole.id, nowIso);
  }
}

// PDF TEMPLATE & CUSTOMIZATION ENGINE round: pdf_templates originally shipped
// with `kind TEXT NOT NULL CHECK(kind IN ('quotation'))` — a CHECK constraint
// baked into the table at CREATE time. SQLite's ALTER TABLE ADD COLUMN (what
// ensureColumn above uses everywhere else) cannot relax a CHECK constraint on
// an existing column, so widening `kind` to the full document-type list needs
// a one-time table recreate: rename the old table aside, create the new one
// with every customization column below, copy every existing row's original
// 17 columns across unchanged (id/kind/name/toggles/header-footer/version/
// audit fields), then drop the old table. Every new column gets a default
// that reproduces the exact pre-this-round hardcoded rendering (NULL colors
// = inherit the brand color exactly as before, 'A4'/'portrait'/42pt margins =
// the previous fixed PAGE_W/PAGE_H/MARGIN, 'none' table border = no border
// was ever drawn, 'auto' signature style = whatever the caller already
// requested) — so upgrading never changes a single existing PDF's appearance
// until a Super Admin actually customizes a template. Guarded by the absence
// of `color_primary` (the first new column), so this runs at most once.
const PDF_TEMPLATE_COLS = db.prepare("PRAGMA table_info(pdf_templates)").all().map((c) => c.name);
if (!PDF_TEMPLATE_COLS.includes("color_primary")) {
  db.exec("ALTER TABLE pdf_templates RENAME TO pdf_templates_old_v1");
  db.exec(`
    CREATE TABLE pdf_templates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('global','account','quotation','exchange','transaction','reports','deposit','withdrawal','transfer')),
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      preset_key TEXT,
      show_signature_lines INTEGER NOT NULL DEFAULT 1,
      show_notes INTEGER NOT NULL DEFAULT 1,
      show_bill_to_address INTEGER NOT NULL DEFAULT 1,
      show_bill_to_contact INTEGER NOT NULL DEFAULT 1,
      header_note TEXT,
      footer_text TEXT,
      paper_size TEXT NOT NULL DEFAULT 'A4' CHECK(paper_size IN ('A4','A5','Letter','Legal','Custom')),
      orientation TEXT NOT NULL DEFAULT 'portrait' CHECK(orientation IN ('portrait','landscape')),
      page_width REAL,
      page_height REAL,
      margin_top REAL NOT NULL DEFAULT 42,
      margin_bottom REAL NOT NULL DEFAULT 42,
      margin_left REAL NOT NULL DEFAULT 42,
      margin_right REAL NOT NULL DEFAULT 42,
      color_primary TEXT,
      color_secondary TEXT,
      color_accent TEXT,
      color_text TEXT,
      color_muted TEXT,
      color_table_header TEXT,
      color_table_border TEXT,
      color_background TEXT,
      color_success TEXT,
      color_warning TEXT,
      color_danger TEXT,
      font_family TEXT NOT NULL DEFAULT 'helvetica' CHECK(font_family IN ('helvetica','times','courier')),
      font_size_title REAL,
      font_size_heading REAL,
      font_size_body REAL,
      font_size_table REAL,
      font_size_footer REAL,
      header_style TEXT NOT NULL DEFAULT 'professional' CHECK(header_style IN ('minimal','classic','modern','professional','corporate')),
      logo_position TEXT NOT NULL DEFAULT 'left' CHECK(logo_position IN ('left','center','right')),
      logo_max_size REAL NOT NULL DEFAULT 30,
      show_logo INTEGER NOT NULL DEFAULT 1,
      show_company_name INTEGER NOT NULL DEFAULT 1,
      show_company_subtitle INTEGER NOT NULL DEFAULT 1,
      show_company_address INTEGER NOT NULL DEFAULT 1,
      show_company_phone INTEGER NOT NULL DEFAULT 1,
      show_company_email INTEGER NOT NULL DEFAULT 1,
      show_company_website INTEGER NOT NULL DEFAULT 1,
      show_registration_number INTEGER NOT NULL DEFAULT 0,
      show_tax_number INTEGER NOT NULL DEFAULT 0,
      show_doc_number INTEGER NOT NULL DEFAULT 1,
      show_doc_date INTEGER NOT NULL DEFAULT 1,
      show_footer INTEGER NOT NULL DEFAULT 1,
      footer_show_company_name INTEGER NOT NULL DEFAULT 1,
      footer_show_phone INTEGER NOT NULL DEFAULT 0,
      footer_show_email INTEGER NOT NULL DEFAULT 0,
      footer_show_website INTEGER NOT NULL DEFAULT 0,
      footer_show_generated_by INTEGER NOT NULL DEFAULT 1,
      footer_show_generated_date INTEGER NOT NULL DEFAULT 1,
      footer_show_page_number INTEGER NOT NULL DEFAULT 1,
      footer_show_signature INTEGER NOT NULL DEFAULT 1,
      footer_custom_text TEXT,
      footer_align TEXT NOT NULL DEFAULT 'left' CHECK(footer_align IN ('left','center','right')),
      table_header_bg TEXT,
      table_header_text_color TEXT,
      table_alt_rows INTEGER NOT NULL DEFAULT 0,
      table_border_style TEXT NOT NULL DEFAULT 'none' CHECK(table_border_style IN ('none','thin','thick')),
      table_border_color TEXT,
      table_row_padding REAL NOT NULL DEFAULT 0,
      show_summary_cards INTEGER NOT NULL DEFAULT 1,
      summary_card_color TEXT,
      default_notes TEXT,
      default_terms TEXT,
      show_terms INTEGER NOT NULL DEFAULT 0,
      signature_style TEXT NOT NULL DEFAULT 'auto' CHECK(signature_style IN ('auto','lines','full','none')),
      signature_labels TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT,
      updated_by TEXT
    )
  `);
  db.exec(`
    INSERT INTO pdf_templates
      (id, kind, name, is_default, is_archived, is_builtin, show_signature_lines, show_notes, show_bill_to_address, show_bill_to_contact, header_note, footer_text, version, created_at, created_by, updated_at, updated_by)
    SELECT id, kind, name, is_default, is_archived, is_builtin, show_signature_lines, show_notes, show_bill_to_address, show_bill_to_contact, header_note, footer_text, version, created_at, created_by, updated_at, updated_by
    FROM pdf_templates_old_v1
  `);
  db.exec("DROP TABLE pdf_templates_old_v1");
}
// FOOTER SIGNATURE TOGGLE round: a Footer-tab checkbox to show/hide the
// Signatures block (see pdfTemplates.js's FIELD_DEFS and app.jsx's
// PDF_FIELD_CATALOG) — added after the table above was already created on
// most installs, so it needs the normal ensureColumn path rather than
// being reachable only through the one-time recreate guarded by
// `color_primary` above. Defaults to 1 (shown) so no existing template's
// rendered PDF changes until someone actually unchecks it.
ensureColumn("pdf_templates", "footer_show_signature", "INTEGER NOT NULL DEFAULT 1");
// One built-in "global" default template — the fallback every document kind
// renders with when it has no active default of its own (spec: "If no
// specific template is assigned: Use the global default."). All-NULL/
// all-default columns so it reproduces the pre-this-round hardcoded look
// exactly. The existing "quotation" kind keeps its own separate builtin
// default from Round 1 (seeded further below) rather than relying on this
// fallback, since it already has one.
if (!db.prepare("SELECT id FROM pdf_templates WHERE kind = 'global'").get()) {
  const { uid, nowISO } = require("../../src/util");
  const now = nowISO();
  db.prepare(
    `INSERT INTO pdf_templates (id, kind, name, is_default, is_archived, is_builtin, version, created_at, updated_at)
     VALUES (?, 'global', 'Professional Default', 1, 0, 1, 1, ?, ?)`
  ).run(uid("tpl"), now, now);
}

// Seed a default company profile row if none exists yet (fresh installs and
// upgrades from a version before Settings both land here safely).
if (!db.prepare("SELECT id FROM company_settings WHERE id = 1").get()) {
  db.prepare(
    "INSERT INTO company_settings (id, name, tagline, address, phone, email, logo_data_url, updated_by, updated_at) VALUES (1,?,?,?,?,?,NULL,NULL,?)"
  ).run(
    "OBO Financial System",
    "Currency Exchange · Trade Finance · Hargeysa, Somaliland",
    "Airport Road, Hargeysa, Somaliland",
    "+252 63 400 9911",
    "info@geeska-exchange.example",
    new Date().toISOString()
  );
}

// PDF TEMPLATE CONTROL round: seed exactly one built-in "quotation" template
// on a fresh install (or an upgrade from before this round) so there's
// always a usable default — same "seed-if-none-exists" pattern as
// company_settings above. Its toggles all default to the pre-this-round
// hard-coded behavior (signature lines, notes, and both bill-to lines all
// shown; no custom header/footer text), so upgrading never changes a single
// existing PDF until a Super Admin/Admin actually edits or replaces it.
if (!db.prepare("SELECT id FROM pdf_templates WHERE kind = 'quotation'").get()) {
  const { uid, nowISO } = require("../../src/util");
  db.prepare(
    `INSERT INTO pdf_templates
       (id, kind, name, is_default, is_archived, is_builtin, show_signature_lines, show_notes, show_bill_to_address, show_bill_to_contact, header_note, footer_text, version, created_at, created_by, updated_at, updated_by)
     VALUES (?, 'quotation', ?, 1, 0, 1, 1, 1, 1, 1, NULL, NULL, 1, ?, NULL, NULL, NULL)`
  ).run(uid("tpl"), "Standard Quotation", nowISO());
}

// EXCEL TEMPLATE & CUSTOMIZATION ENGINE round: seed exactly one built-in
// "global" Excel template on a fresh install/upgrade — every column above
// already defaults to the pre-this-round hardcoded buildProfessionalWorkbook
// look (see xlsx-engine.js), so this row's mere existence is what makes
// "there's always at least one usable default" true; it changes nothing
// about how any Excel file looks until a Super Admin actually customizes it
// or another kind gets its own default. Same seed-if-none-exists pattern as
// pdf_templates' global default above.
if (!db.prepare("SELECT id FROM excel_templates WHERE kind = 'global'").get()) {
  const { uid, nowISO } = require("../../src/util");
  const now = nowISO();
  db.prepare(
    `INSERT INTO excel_templates (id, kind, name, is_default, is_archived, is_builtin, version, created_at, updated_at)
     VALUES (?, 'global', 'Professional Default', 1, 0, 1, 1, ?, ?)`
  ).run(uid("tpl"), now, now);
}

// PAYMENT & TRANSFER UPGRADE round: PAYMENT DATE. Every money-moving row
// (account_ledger = deposit/withdrawal, transfers) now carries its
// ACCOUNTING DATE (the existing `date` column — user-editable, defaults to
// today, and is what every balance/statement/report calculation already
// sorts and totals by) separately from a brand-new `created_at`, the real,
// never-editable system timestamp of when the row was actually inserted.
// This is the exact distinction financial auditing needs: "when did this
// really happen in the books" vs. "when was it actually entered." Backfilled
// from each row's own existing `date` so nothing already in the database
// looks like it was created at the epoch — a reasonable stand-in given
// neither table tracked a separate creation time before this round.
ensureColumn("account_ledger", "created_at", "TEXT");
db.exec("UPDATE account_ledger SET created_at = date WHERE created_at IS NULL");
ensureColumn("transfers", "created_at", "TEXT");
db.exec("UPDATE transfers SET created_at = date WHERE created_at IS NULL");
// A Transfer's own free-text "Reference" field (e.g. an external invoice or
// wire reference the staff member types in) — deliberately separate from
// `reference_number` (the system-generated TR-YYYY-#### id) and from
// `notes`, matching the spec's Transfer form, which shows Reference and
// Notes as two distinct fields.
ensureColumn("transfers", "reference", "TEXT");

// EXCHANGE WORKSPACE round: a client Money Exchange transaction can now
// OPTIONALLY be linked to the company's own Cash in Hand accounts — exactly
// the same "Cash Out From"/"Cash In To" linkage Payments already got via
// account_ledger.cash_account_id (CASH IN HAND INTEGRATION round, above),
// just with two sides instead of one since an exchange always touches two
// currencies. cash_out_account_id is the cash account the GIVEN currency is
// paid out of; cash_in_account_id is the cash account the RECEIVED currency
// is paid into. Both nullable — an exchange with neither set behaves
// exactly as it always has (no Cash in Hand impact at all), so every
// existing exchange transaction, and any staff member who skips the new
// optional picker, is completely unaffected.
ensureColumn("exchange_transactions", "cash_out_account_id", "TEXT REFERENCES cash_accounts(id)");
ensureColumn("exchange_transactions", "cash_in_account_id", "TEXT REFERENCES cash_accounts(id)");

}

module.exports = { openTenantDb, migrateTenantDb, stampCompanyId };
