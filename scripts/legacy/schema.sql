-- OBO Financial System — database schema (SQLite, node:sqlite)
-- Swap-out note: this schema uses standard SQL and should port to
-- PostgreSQL/MySQL with only minor type changes (TEXT -> VARCHAR/UUID,
-- REAL -> NUMERIC, INTEGER booleans -> BOOLEAN).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- Legacy fixed-role label — kept for backward compatibility with code that
  -- hasn't been swept to the new dynamic RBAC engine yet (see "roles" below).
  -- role_id is the real source of truth for permissions; this column is kept
  -- in sync with it (best-effort legacy label) but is never itself consulted
  -- for a security decision post-RBAC-round.
  role TEXT NOT NULL CHECK(role IN ('admin','manager','accountant','cashier','sales','viewer')),
  role_id TEXT REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated','suspended')),
  active INTEGER NOT NULL DEFAULT 1,
  -- Bumped whenever this user's role assignment or their own permission
  -- overrides change — embedded in issued JWTs so an already-logged-in
  -- session is invalidated the moment its permissions actually change
  -- (SESSION SECURITY, SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round).
  permissions_version INTEGER NOT NULL DEFAULT 1,
  last_login TEXT,
  quotation_column_prefs TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL
);

-- RBAC — dynamic roles + granular, module/action permissions. Replaces the
-- old hard-coded PERMS object (src/rbac.js) as the real source of truth.
-- SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 1.
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  -- Unconditional, unrestricted bypass of every permission check — never
  -- gated by role_permissions rows at all. Only another Super Admin may
  -- create, edit or remove a role carrying this flag (see rbac.js).
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  -- A protected system role can't be renamed or deleted. Super Admin is
  -- always protected AND unrestricted; Admin is protected from deletion but
  -- its permissions stay fully editable by a Super Admin, per spec.
  is_protected INTEGER NOT NULL DEFAULT 0,
  -- Bumped whenever this role's role_permissions rows change — embedded in
  -- issued JWTs for every user holding this role, so editing a role's
  -- permissions revalidates every session using it, not just future logins.
  permissions_version INTEGER NOT NULL DEFAULT 1,
  -- ROLE STATUS (Phase 2): an 'inactive' role can't be newly assigned to a
  -- user (see routes/users.js) but is never force-removed from anyone
  -- already holding it — deactivating a role is a deliberate, reversible
  -- "stop handing this out" switch, not a delete. NOTE: on a database that
  -- already has a `roles` table from an earlier round, this column is added
  -- via ensureColumn in db.js instead (this CREATE TABLE is a no-op there —
  -- see the schema.sql/db.js split documented near idx_users_role_id below).
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

-- Per-user permission overrides, layered on top of the role (spec: "Custom
-- Permission Override" / "Role vs User Permissions"). granted=1 is an extra
-- grant beyond the role; granted=0 is an explicit deny even if the role
-- would otherwise allow it. Never consulted for a Super Admin (unrestricted
-- regardless of any row that might exist here).
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id TEXT NOT NULL REFERENCES users(id),
  permission_key TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK(granted IN (0,1)),
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user ON user_permission_overrides(user_id);
-- NOTE: no "CREATE INDEX ... ON users(role_id)" here on purpose. On a
-- brand-new database this whole file runs in one batch, so it would work —
-- but on a real PRE-EXISTING database (the common case: this schema.sql
-- re-runs on every single startup, and "CREATE TABLE IF NOT EXISTS users" is
-- then a no-op against the OLD users table shape, which has no role_id
-- column yet), indexing users(role_id) here would run BEFORE db.js's own
-- ensureColumn("users", "role_id", ...) ever gets a chance to add that
-- column — crashing every existing installation on startup with
-- "no such column: role_id". db.js already creates this exact index itself,
-- correctly, right after its ensureColumn("users", "role_id", ...) call —
-- see the "CREATE INDEX IF NOT EXISTS idx_users_role_id" line there.

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  set_by_name TEXT NOT NULL,
  at TEXT NOT NULL
);

-- SALE RATE / EXCHANGE PROFIT round: a brand new table (no ensureColumn
-- ordering hazard — see db.js's own comment on that rule), logged exactly
-- like exchange_rates above (same shape, same history-of-values pattern),
-- but deliberately kept as its own separate table rather than a column on
-- exchange_rates — the two rates are set independently, on independent
-- schedules, by the same rateManage-permitted people, and mixing them into
-- one row would make "what was the Sale Rate on this date" an awkward
-- self-join instead of the same simple "ORDER BY at DESC" every other rate
-- lookup already uses. `rate` here is the wholesale/cost rate the business
-- actually sources USD<->SLSH at (1 USD = SLSH `rate`), kept completely
-- separate from the customer-facing Daily Rate above — the spread between
-- the two is what src/domain.js's computeExchangeProfit() uses to
-- auto-calculate each exchange's Profit.
CREATE TABLE IF NOT EXISTS sale_rates (
  id TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  set_by_name TEXT NOT NULL,
  at TEXT NOT NULL
);

-- RATE MANAGEMENT UNIFICATION round: the person asked for Daily Rate and
-- Sale Rate to be managed and reviewed through ONE interface, with ONE
-- unified history — not two separate controls each with its own history —
-- while their underlying financial values must stay genuinely independent
-- (never merged into a single number). This table is that: a brand-new
-- table (no ensureColumn ordering hazard), one row per "rate set" moment,
-- carrying BOTH current values together, so a save always produces exactly
-- one combined history record even when only one of the two actually
-- changed (the other is carried forward unchanged into the new row) — see
-- db.js's saveRateHistory-style helper and its one-time migration that
-- merges the old exchange_rates/sale_rates tables into this one.
--
-- `currency_pair` is forward-looking, ready for more than one pair (as
-- asked for), even though this business today only ever trades one pair
-- (USD<->SLSH, stored as 'USD_SLSH') — a genuinely independent second pair
-- (its own Daily/Sale Rate, its own spread) is just a new value in this
-- column away, with no further schema change, whenever a real second pair
-- exists to configure. `daily_rate`/`sale_rate`/`rate_difference` are all
-- nullable, mirroring getCurrentRate()/getCurrentSaleRate()'s existing
-- "never fabricate a value that was never actually set" rule for a
-- database that predates either rate ever being configured.
-- DAILY SLSH RATE round: daily_slsh_rate is a RECORD-ONLY companion to
-- daily_rate — the "opposite direction" rate a Super Admin can optionally
-- note down alongside the Daily (USD) Rate and Sale Rate, same nullable
-- "never fabricate a value that was never actually set" shape sale_rate
-- already uses. It is never read by convert()/getCurrentRate() or any
-- money-calculation path (Money Exchange, Quotations, Dashboard, Reports
-- all keep converting exactly as before) — see getCurrentDailySlshRate()
-- in domain.js.
CREATE TABLE IF NOT EXISTS rate_history (
  id TEXT PRIMARY KEY,
  currency_pair TEXT NOT NULL DEFAULT 'USD_SLSH',
  daily_rate REAL,
  sale_rate REAL,
  daily_slsh_rate REAL,
  rate_difference REAL,
  -- GLOBAL RATE & PROFIT round: Cost / Buy / Sell rates (SLSH per 1 USD),
  -- nullable until set; formulas in src/exchange-calc.js.
  cost_rate REAL,
  buy_rate REAL,
  sell_rate REAL,
  note TEXT,
  set_by TEXT NOT NULL REFERENCES users(id),
  set_by_name TEXT NOT NULL,
  at TEXT NOT NULL
);

-- CASH IN HAND — INDEPENDENT RATE round: the Cash in Hand module's own
-- exchange rate (used for its own USD<->SLSH Cash Exchanges and its
-- Net Cash in Hand conversion), kept in its own history table so it is
-- genuinely separate from the company-wide Daily/Sale Rate in
-- rate_history above — editing one never touches the other. Mirrors
-- rate_history's own immutable-row-per-change shape (see
-- getCurrentCashRate()/saveCashRateHistory() in domain.js), just a single
-- rate value instead of a Daily+Sale pair.
CREATE TABLE IF NOT EXISTS cash_rate_history (
  id TEXT PRIMARY KEY,
  currency_pair TEXT NOT NULL DEFAULT 'USD_SLSH',
  rate REAL NOT NULL,
  note TEXT,
  set_by TEXT NOT NULL REFERENCES users(id),
  set_by_name TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  account_number TEXT,
  account_type TEXT NOT NULL DEFAULT 'customer' CHECK(account_type IN ('customer','company')),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','SLSH')),
  linked_account_id TEXT REFERENCES clients(id),
  contact TEXT,
  email TEXT,
  id_number TEXT,
  address TEXT,
  balance_usd REAL NOT NULL DEFAULT 0,
  balance_slsh REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_ledger (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  notes TEXT,
  staff_id TEXT,
  staff_name TEXT,
  date TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  -- Denormalized copy of the linked record's own human-readable reference
  -- (currently just a quotation's number, e.g. "QT-2026-0007"), stored
  -- directly on the ledger row itself rather than looked up via source_id.
  -- This is what lets both legs of a settled quotation keep showing their
  -- reference number permanently — including after the quotation DOCUMENT
  -- is deleted (allowed once Paid/Refunded) — without depending on a JOIN
  -- to a row that may no longer exist.
  reference_number TEXT,
  -- PAYMENT & TRANSFER UPGRADE round: the real system timestamp this row was
  -- inserted, kept separate from `date` above (the user-editable ACCOUNTING/
  -- Payment Date every balance calculation actually uses) — see db.js's
  -- migration comment for the full rationale. Nullable only so ensureColumn's
  -- migration path for pre-existing databases and this fresh-install DDL stay
  -- in sync; every row written by the app from this round on always sets it.
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS exchange_transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id),
  client_name TEXT NOT NULL,
  from_account_id TEXT REFERENCES clients(id),
  to_account_id TEXT REFERENCES clients(id),
  amount_given REAL NOT NULL,
  currency_given TEXT NOT NULL CHECK(currency_given IN ('USD','SLSH')),
  amount_received REAL NOT NULL,
  currency_received TEXT NOT NULL CHECK(currency_received IN ('USD','SLSH')),
  rate_used REAL NOT NULL,
  cost_rate REAL, -- GLOBAL RATE & PROFIT round: the Cost Rate this exchange was valued at
  profit_usd REAL NOT NULL DEFAULT 0,
  staff_id TEXT NOT NULL REFERENCES users(id),
  staff_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
  notes TEXT,
  void_reason TEXT,
  voided_by TEXT,
  voided_at TEXT
);

-- A Transfer moves money between two accounts of the SAME currency (e.g. two
-- different customers' USD accounts). This is distinct from an Exchange,
-- which always converts between USD and SLSH. Both accounts must be active.
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  from_account_id TEXT NOT NULL REFERENCES clients(id),
  to_account_id TEXT NOT NULL REFERENCES clients(id),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  amount REAL NOT NULL,
  notes TEXT,
  staff_id TEXT REFERENCES users(id),
  staff_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
  void_reason TEXT,
  voided_by TEXT,
  voided_at TEXT,
  -- PAYMENT & TRANSFER UPGRADE round: see the matching column on
  -- account_ledger above for created_at's rationale. `reference` is the
  -- transfer's own free-text field (e.g. an external invoice/wire number),
  -- separate from the system-generated reference_number (TR-YYYY-####).
  created_at TEXT,
  reference TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_account_id);

CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id TEXT REFERENCES clients(id),
  client_name TEXT NOT NULL,
  client_contact TEXT,
  client_address TEXT,
  issue_date TEXT NOT NULL,
  valid_until TEXT,
  -- A quotation is charged to an account the instant it's created — see
  -- "TWO-STEP ACCOUNT LEDGER LOGIC": Pending (just created, money withdrawn
  -- and awaiting settlement) -> Paid (settled via the Pay action) or
  -- Refunded (settled via the Refund action). Mutually exclusive terminals.
  -- PARTIAL PAYMENT UPGRADE round: 'Partially Paid' added between Pending
  -- and Paid — see quotation_payments below for the individual payment
  -- records this status is now computed from. (An already-existing database
  -- has this widened in place by db.js's guarded rebuild, since SQLite can't
  -- ALTER a CHECK constraint.)
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Partially Paid','Paid','Refunded')),
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
  created_by TEXT NOT NULL REFERENCES users(id),
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_by_name TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  extra_fields TEXT
);

-- PARTIAL PAYMENT UPGRADE round: every individual payment recorded against a
-- quotation (never a rewrite of the quotation's own amount — see
-- routes/quotations.js's "Original Amount is never destroyed" comment).
-- amount/currency/date/method/reference/notes are exactly the "Quotation
-- Payment" modal's own fields; ledger_id links to the real linked
-- account_ledger Deposit this payment posts (source_type='quotation_paid',
-- same as the pre-existing single full-payment flow), so every payment is a
-- REAL transaction, never just a number bumped on the quotation row.
CREATE TABLE IF NOT EXISTS quotation_payments (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id),
  reference_number TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  date TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT,
  staff_id TEXT REFERENCES users(id),
  staff_name TEXT NOT NULL,
  ledger_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotation_payments_quotation ON quotation_payments(quotation_id);

CREATE TABLE IF NOT EXISTS opening_balances (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  usd REAL NOT NULL,
  slsh REAL NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  name TEXT NOT NULL,
  tagline TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  logo_data_url TEXT,
  pdf_accent_color TEXT,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);

-- TABLE CUSTOMIZATION round: per-table column visibility/order + row
-- density, saved either as one user's own personal preference (user_id =
-- a real users.id) or as the SYSTEM-WIDE default a Super Admin/Admin sets
-- for everyone who hasn't saved their own override (user_id = the literal
-- sentinel '__system__', a value uid("u") — see util.js — can never
-- produce, so it never collides with a real user). Brand new table, so
-- unlike roles.status above there's no pre-existing-database ordering
-- hazard here: this table and its own unique index are safe to create
-- together, in this same batch — see the long comment near
-- idx_users_role_id below for why that split exists elsewhere and why it
-- doesn't apply to a table that has never existed before this round.
CREATE TABLE IF NOT EXISTS table_layouts (
  id TEXT PRIMARY KEY,
  table_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  density TEXT CHECK(density IN ('compact','comfortable') OR density IS NULL),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_layouts_key_user ON table_layouts(table_key, user_id);

CREATE INDEX IF NOT EXISTS idx_tx_date ON exchange_transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_staff ON exchange_transactions(staff_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_items_quotation ON quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_ledger_client ON account_ledger(client_id);

-- PDF TEMPLATE CONTROL round: a brand new table (no ensureColumn ordering
-- hazard — see db.js's own comment on that rule), so it's safe to create it
-- and its indexes together in this same exec batch. Round 1 is deliberately
-- form-based rather than the spec's full drag-and-drop visual editor (see
-- README's "SUPER ADMIN PDF TEMPLATE CONTROL" section for the scope
-- decision) — every column here controls a real, already-existing element
-- of the quotation PDF layout (renderQuotationPDF in src/pdf.js), never a
-- free-position/free-size one.
CREATE TABLE IF NOT EXISTS pdf_templates (
  id TEXT PRIMARY KEY,
  -- Only "quotation" exists in Round 1 — renderTablePDF's generic report
  -- exports aren't per-document templates in the same sense and stay out
  -- of scope for now. Kept as its own column (rather than hard-coding
  -- "quotation" everywhere) so a future "report" kind is a pure addition.
  kind TEXT NOT NULL CHECK(kind IN ('quotation')),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  -- The one seeded template every install starts with — always exactly
  -- reproduces the pre-this-round hard-coded layout, and (like the
  -- protected system roles) can never be deleted, so there's always at
  -- least one usable template to fall back to.
  is_builtin INTEGER NOT NULL DEFAULT 0,
  show_signature_lines INTEGER NOT NULL DEFAULT 1,
  show_notes INTEGER NOT NULL DEFAULT 1,
  show_bill_to_address INTEGER NOT NULL DEFAULT 1,
  show_bill_to_contact INTEGER NOT NULL DEFAULT 1,
  -- Free text rendered under the company tagline / above the footer
  -- timestamp respectively. Support {{company_name}}/{{company_address}}/
  -- {{company_phone}}/{{company_email}}/{{company_website}} placeholders,
  -- substituted at render time (SUPER ADMIN PDF DYNAMIC FIELDS, scoped to
  -- the company.* fields for this round — see applyPlaceholders in
  -- src/pdf.js). NULL/empty footer_text falls back to the original
  -- auto-generated "Generated {date} · {company} Financial System" line.
  header_note TEXT,
  footer_text TEXT,
  -- Bumped on every PATCH. Round 1 stops short of full version history
  -- (snapshots + rollback) — see the README for that explicit deferral —
  -- but this at least makes "has this template changed since I last
  -- looked" a real, queryable fact from day one.
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT
);
-- At most one default template per kind — enforced in the database, not
-- just by the API's own read-modify-write logic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_templates_one_default_per_kind ON pdf_templates(kind) WHERE is_default = 1;

-- EXCEL TEMPLATE & CUSTOMIZATION ENGINE round: the Excel counterpart of
-- pdf_templates above — same "one centralized template per document kind,
-- Super Admin customizes it, every export just renders through it" model,
-- adapted for what an Excel workbook actually needs (no page-canvas
-- geometry like margins/paper size — a worksheet has no fixed page — but
-- its own real concerns: table theme, freeze/filter behavior, date format,
-- and print setup for when it IS printed). This table is brand new (no
-- prior "quotation-only" shape ever shipped), so — unlike pdf_templates —
-- it's created here already at its full column set; no db.js recreate-
-- migration is needed the way pdf_templates required one.
CREATE TABLE IF NOT EXISTS excel_templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('global','account','quotation','exchange','transaction','reports','deposit','withdrawal','transfer')),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  -- The one seeded template every install starts with — always exactly
  -- reproduces the pre-this-round hard-coded workbook look, and (like the
  -- PDF system's builtin) can never be deleted.
  is_builtin INTEGER NOT NULL DEFAULT 0,
  preset_key TEXT,
  -- ---- Header / company branding block ----
  show_logo INTEGER NOT NULL DEFAULT 1,
  show_company_name INTEGER NOT NULL DEFAULT 1,
  show_company_subtitle INTEGER NOT NULL DEFAULT 1,
  show_company_address INTEGER NOT NULL DEFAULT 1,
  show_company_phone INTEGER NOT NULL DEFAULT 1,
  show_company_email INTEGER NOT NULL DEFAULT 1,
  show_company_website INTEGER NOT NULL DEFAULT 1,
  show_doc_title INTEGER NOT NULL DEFAULT 1,
  show_doc_number INTEGER NOT NULL DEFAULT 1,
  show_generated_date INTEGER NOT NULL DEFAULT 1,
  show_generated_by INTEGER NOT NULL DEFAULT 1,
  show_date_range INTEGER NOT NULL DEFAULT 1,
  -- ---- Document-body toggles (kept in sync with pdf_templates' own, since
  -- the quotation Excel workbook mirrors the quotation PDF's line items) ----
  show_notes INTEGER NOT NULL DEFAULT 1,
  show_bill_to_address INTEGER NOT NULL DEFAULT 1,
  show_bill_to_contact INTEGER NOT NULL DEFAULT 1,
  -- ---- Brand colors — NULL means "inherit company.brand_color", exactly
  -- like pdf_templates.color_primary ----
  color_primary TEXT,
  color_secondary TEXT,
  color_accent TEXT,
  color_text TEXT,
  color_muted TEXT,
  color_table_header TEXT,
  table_header_text_color TEXT,
  -- ---- Typography — real installed font family names (an .xlsx isn't
  -- limited to pdf-lib's 3 built-in families) ----
  font_family TEXT NOT NULL DEFAULT 'Calibri' CHECK(font_family IN ('Calibri','Arial','Times New Roman','Georgia')),
  font_size_title REAL NOT NULL DEFAULT 16,
  font_size_heading REAL NOT NULL DEFAULT 13,
  font_size_body REAL NOT NULL DEFAULT 10,
  -- ---- Table styling ----
  table_theme TEXT NOT NULL DEFAULT 'medium_blue' CHECK(table_theme IN ('medium_blue','medium_green','medium_gray','medium_gold','dark_navy','light','none')),
  table_alt_rows INTEGER NOT NULL DEFAULT 1,
  freeze_header INTEGER NOT NULL DEFAULT 1,
  enable_filters INTEGER NOT NULL DEFAULT 1,
  -- ---- Date format applied to every date cell/column across every export
  -- (spec item 15: "Do not mix multiple date formats within the same
  -- document") — an ExcelJS/Excel-native number format string. ----
  date_format TEXT NOT NULL DEFAULT 'dd mmm yyyy',
  -- ---- Footer ----
  show_footer INTEGER NOT NULL DEFAULT 1,
  footer_show_company_name INTEGER NOT NULL DEFAULT 1,
  footer_show_generated_by INTEGER NOT NULL DEFAULT 1,
  footer_show_generated_date INTEGER NOT NULL DEFAULT 1,
  footer_show_page_number INTEGER NOT NULL DEFAULT 1,
  footer_custom_text TEXT,
  footer_align TEXT NOT NULL DEFAULT 'left' CHECK(footer_align IN ('left','center','right')),
  -- ---- Print setup (spec item 17) ----
  page_orientation TEXT NOT NULL DEFAULT 'auto' CHECK(page_orientation IN ('auto','portrait','landscape')),
  fit_to_page INTEGER NOT NULL DEFAULT 1,
  repeat_header_rows INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_excel_templates_one_default_per_kind ON excel_templates(kind) WHERE is_default = 1;

-- ACCOUNT IMPORT & EXPORT round: one history row per bulk-import run (never
-- per account row — the per-row detail lives inside report_json instead, so
-- this table can't grow unbounded on a huge file). Brand new table, so
-- exactly like table_layouts/pdf_templates/excel_templates above, it's safe
-- to create alongside the rest of the schema at any time, including
-- retroactively for an existing database. Never touched by ordinary account
-- create/update/delete — only ever written by POST /api/accounts/import/commit.
CREATE TABLE IF NOT EXISTS account_imports (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  -- Full per-row report: [{row, accountNumber, accountName, result, reason}, ...]
  -- — powers both "View Import Report" and the downloadable Error Report.
  report_json TEXT NOT NULL,
  imported_by TEXT,
  imported_by_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_imports_created ON account_imports(created_at);

-- CASH IN HAND round: a deliberately SEPARATE table family from
-- clients/account_ledger (not a new clients.account_type value) — see the
-- design-decision notes in the Cash in Hand feature doc. A cash_account
-- represents money the COMPANY itself controls (a bank account, a mobile
-- money wallet, or physical till cash), as opposed to `clients`, which is
-- always money owed TO or BY a customer/business client. Keeping this fully
-- separate means zero schema changes to the existing clients/account_ledger/
-- exchange_transactions/transfers tables and zero risk to their CHECK
-- constraints, balances, or queries — Cash in Hand is additive only.
CREATE TABLE IF NOT EXISTS cash_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('bank','mobile_money','physical_cash','other')),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  -- Unlike `clients` (which allows negative balances, a deliberate debt
  -- policy), a cash account represents REAL physical/bank money — see the
  -- feature's explicit "block if insufficient funds" rule, enforced in
  -- routes/cash.js at withdrawal/transfer/exchange/loan time, not here.
  balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated')),
  reference TEXT,
  notes TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  deactivated_at TEXT,
  deactivated_by TEXT,
  deactivation_reason TEXT
);

-- The generic cash ledger — every deposit/withdrawal against a cash account,
-- exactly mirroring account_ledger's own shape and source_type/source_id
-- tagging convention (transfer/exchange/loan/loan_repayment legs are tagged
-- here the same way transfer/exchange/quotation legs tag account_ledger),
-- so a linked leg can never be edited/deleted as a plain entry (see
-- rejectIfLinked-style guard added to the cash ledger's own PATCH/DELETE).
CREATE TABLE IF NOT EXISTS cash_ledger (
  id TEXT PRIMARY KEY,
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  description TEXT,
  reference_number TEXT,
  -- When a cash movement is the company's side of a transaction WITH a real
  -- customer (a loan given, a payment collected from a customer, etc.), this
  -- names the counterpart so "Recent Cash Movements" can show "To: Abdi —
  -- Customer" per spec — purely informational, never drives any customer
  -- balance math (that stays entirely inside clients/account_ledger,
  -- untouched by this table).
  counterparty_client_id TEXT REFERENCES clients(id),
  counterparty_label TEXT,
  staff_id TEXT,
  staff_name TEXT,
  date TEXT NOT NULL,
  created_at TEXT,
  source_type TEXT,
  source_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_account ON cash_ledger(cash_account_id);

-- A Cash Transfer moves money between two of the company's OWN cash
-- accounts of the SAME currency (e.g. Physical Cash USD -> Main Bank USD) —
-- the Cash-in-Hand analogue of `transfers`, same same-currency rule.
CREATE TABLE IF NOT EXISTS cash_transfers (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  from_cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  to_cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  amount REAL NOT NULL,
  notes TEXT,
  reference_number TEXT,
  staff_id TEXT,
  staff_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
  created_at TEXT NOT NULL
);

-- A Cash Exchange converts between the company's own USD and SLSH cash
-- accounts — the Cash-in-Hand analogue of exchange_transactions. Always
-- uses the one, already-existing system exchange rate (rate_history) —
-- never a second/private rate — per spec's explicit "one central rate"
-- requirement.
CREATE TABLE IF NOT EXISTS cash_exchanges (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  from_cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  to_cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  amount_given REAL NOT NULL,
  currency_given TEXT NOT NULL CHECK(currency_given IN ('USD','SLSH')),
  amount_received REAL NOT NULL,
  currency_received TEXT NOT NULL CHECK(currency_received IN ('USD','SLSH')),
  rate_used REAL NOT NULL,
  notes TEXT,
  reference_number TEXT,
  staff_id TEXT,
  staff_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
  created_at TEXT NOT NULL
);

-- LOAN/DEBT feature (built alongside Cash in Hand, since every loan is
-- money LEAVING a specific Cash Account to a customer). Deliberately its
-- own table, never touching clients.balance_usd/balance_slsh — a loan's
-- "debt receivable" lives entirely in this table's own outstanding_amount,
-- so this feature is 100% additive and cannot corrupt an existing
-- customer's real account balance or ledger history.
CREATE TABLE IF NOT EXISTS cash_loans (
  id TEXT PRIMARY KEY,
  reference_number TEXT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  client_name TEXT NOT NULL,
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  principal_amount REAL NOT NULL,
  outstanding_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paid','written_off')),
  notes TEXT,
  date TEXT NOT NULL,
  staff_id TEXT,
  staff_name TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  written_off_at TEXT,
  written_off_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_loans_client ON cash_loans(client_id);

CREATE TABLE IF NOT EXISTS cash_loan_payments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES cash_loans(id),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  date TEXT NOT NULL,
  notes TEXT,
  reference_number TEXT,
  staff_id TEXT,
  staff_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_loan_payments_loan ON cash_loan_payments(loan_id);

-- COMPANY EXPENSES round ---------------------------------------------------
-- An expense is money the COMPANY spends (rent, salaries, fuel...) out of one
-- of its own Cash in Hand accounts. Accounting: each posted expense owns
-- exactly ONE cash_ledger withdrawal (source_type 'expense', source_id =
-- expenses.id) — the same "record + one linked ledger leg" model Loans use —
-- so the paying account's balance is still derived only by
-- rebuildCashAccountBalance (domain.js), never by a second calculation here.
-- Cancelling posts one reversing deposit (source_type 'expense_reversal')
-- instead of deleting anything, so the original movement, its reference and
-- the cancellation all stay in the history. Like every other table in a
-- company database, these rows live only in that company's own file and get
-- the company_id stamp + triggers from db.js's stampCompanyId.
CREATE TABLE IF NOT EXISTS expense_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name ON expense_categories(lower(name));

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  reference_number TEXT NOT NULL,
  -- One id per "Add expense" form, sent again on a retry: a repeated click or
  -- a retried request returns the expense already saved instead of posting
  -- a second withdrawal.
  client_request_id TEXT,
  date TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES expense_categories(id),
  category_name TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL CHECK(currency IN ('USD','SLSH')),
  cash_account_id TEXT NOT NULL REFERENCES cash_accounts(id),
  external_reference TEXT,
  notes TEXT,
  cash_ledger_id TEXT,
  reversal_ledger_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','cancelled')),
  created_by_id TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_by_id TEXT,
  updated_by_name TEXT,
  updated_at TEXT,
  cancelled_at TEXT,
  cancelled_by_id TEXT,
  cancelled_by_name TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_reference ON expenses(reference_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_client_request ON expenses(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_cash_account ON expenses(cash_account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);

-- An optional receipt (image or PDF) per expense, kept apart from `expenses`
-- so lists never load file data. Served only through the authenticated
-- GET /api/expenses/:id/attachment — there is no public URL.
CREATE TABLE IF NOT EXISTS expense_attachments (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data_base64 TEXT NOT NULL,
  uploaded_by_id TEXT,
  uploaded_by_name TEXT,
  uploaded_at TEXT NOT NULL
);
