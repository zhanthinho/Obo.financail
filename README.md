# OBO Financial System

## 🔗 Fur system-ka (Open the system)

| Halka laga furayo | Link |
|---|---|
| Kombiyuutarka xafiiska (server-ka) | **[http://localhost:4000](http://localhost:4000)** |
| Telefoon / kombiyuutar kale oo isku WiFi ah | `http://<IP-ga kombiyuutarka>:4000` — IP-ga waxaa ku qoran daaqadda FINMAN marka la furo (tusaale `http://192.168.1.5:4000`) |

> System-ku wuxuu ku shaqeeyaa **kombiyuutarka xafiiska (offline)**; xogtu waxay ku jirtaa MySQL-ka kombiyuutarkaas.
> Link-yadu way shaqeeyaan marka kombiyuutarkaas shidan yahay oo FINMAN furan yahay. Internet-ka guud lagama furi karo.

**Sida loo furo:** laba-guji icon-ka **FINMAN** ee Desktop-ka (ama `FINMAN.bat` ee folder-ka mashruuca). Wuxuu hubiyaa database-ka, shidaa system-ka, sameeyaa backup toddobaadle ah, kadibna furaa browser-ka. Daaqadda yar **"FINMAN server - ha xirin"** ha xirin inta la isticmaalayo.

**Backup:** si toos ah toddobaad kasta (folder-ka `Backups\`, 12-ka ugu dambeeya); hadda: `BACKUP-HADDA.bat`. Nuqul ku koobiyee USB si joogto ah. Backups-ka GitHub lama gelin (xog lacageed oo gaar ah).

---

A complete, self-hosted Financial System Management app: currency management,
a money exchange ledger, quotations with a full approval workflow, real
role-based access control, reports, and PDF/CSV export — for a company
operating in USD and SLSH (Somaliland Shilling).

This is a **single, connected application**: one command starts a server
that both runs the API and serves the web UI on the same origin, so there's
no separate frontend to configure and no cross-origin setup.

## What's included

- **Dashboard** — a full enterprise financial dashboard, permission-aware end to end: an always-available currency converter (works even for a role with no reporting access), a global filter bar (Date range/Currency/Account drill-down/Quotation status/Granularity, shared by every trend chart), role-gated Quick Actions, and 11 customizable, reorderable, full/half-width widgets (Summary cards, Account Balance Overview, Money Flow Trend, USD/SLSH Balance Trends, Transaction Activity & Distribution, Deposits vs Withdrawals, Quotation Performance, Exchange Activity, Top Accounts, Recent Activity, Attention Required) — see "Latest round (ENTERPRISE FINANCIAL MANAGEMENT DASHBOARD)" below for the full picture, including the currency-safety rule that USD and SLSH are never summed or charted together
- **Accounts** USD / SLSH — separate menus, each with its own table (now just Account #, Name, Contact, Balance, Linked account — the Transactions/Quotations/Since columns were dropped to keep the list focused; that detail lives in the account's own view), a Positive/Negative balance filter (funds vs debt), and its own "Add account" flow. **The account Name itself is the primary click target** — click it (or the View button, kept for anyone used to it) to open the account's detail view; no separate click required. **Personal names are auto-uppercased** on blur (e.g. "aisha nur" → "AISHA NUR") — this applies only to person-type fields (account holder/customer names, contact person, employee/user names), never to company names, product names, emails, usernames, addresses, or notes, which are always kept exactly as typed. Every account is single-currency; a USD account can be **linked** to an SLSH account (and vice versa) to represent the same customer's two balances, with one click to jump between them. **Accounts can go negative** — deposits, withdrawals, exchanges, transfers, and quotation charges never block for insufficient funds; a debt balance is a normal, filterable state, not an error. **Quick Actions** on the account detail page — Deposit, Withdraw, Transfer, Exchange, and Edit Account buttons scoped directly to that account (no re-searching for it), reusing the same modals/flows as their standalone modules; all disabled while the account is deactivated. **Account lifecycle** — an account can be **Deactivated** (with an optional reason; blocks all new financial transactions on it, both in the UI and enforced server-side, while preserving its balance and full history), **Reactivated** at any time, or, once deactivated, **permanently deleted** (soft-delete only — the record is flagged `deleted_at`/never a real SQL row removal, so linked transactions/exchanges/quotations/transfers are never orphaned; requires typing the account's exact name to confirm, and an active account can never be deleted directly). **Quotations are company-account only** — the shortcut only appears on company accounts, since quotations are a B2B document
- **Deposits & Withdrawals USD / Deposits & Withdrawals SLSH** — likewise split into two menus. Search any account of that currency and deposit/withdraw immediately — no currency picker needed, since the account defines it. Edit or delete any entry (the account's balance is safely recalculated either way), see running totals for whatever's currently filtered, a Daily Transactions view, and CSV/PDF export
- **Sortable tables** — every major table in the app (Money Exchange, Quotations, Accounts, Deposits & Withdrawals, Transaction History, Users, Reports) has clickable column headers to sort ascending/descending
- **Transaction tables: date-only display + a `#` display-order column** — every table that lists individual financial ledger events (Money Exchange, an account's own unified Transactions table, the standalone Deposits & Withdrawals tables — both the filtered list and the single-day drill-down, and Global/USD/SLSH Transaction History) shows its Date column as a plain date (e.g. "18 Sept 2026") with **no time-of-day**, and leads with a compact **`#`** column numbering the currently displayed rows **newest → oldest** (`#1` is always the newest row in whatever's currently sorted/filtered/searched — it's a display-order position, not the record's real ID). The full timestamp is never touched or hidden from the database — sorting (including same-day ties) is always resolved against the real, underlying timestamp, exactly as before; only its time-of-day is hidden from these table cells. (Aggregate/summary tables — daily totals in Reports, staff activity, the audit log, rate history — are unaffected, since they don't list individual transactions.)
- **Account view redesign** — a wide, unified **Transactions** table per account combining deposits, withdrawals, exchange transactions, and transfers in one place, with separate **Deposit**/**Withdrawal** columns and a **Total** row at the bottom, a Type filter (Deposits/Withdrawals/Exchanges/Transfers — no separate "Quotations" entry, see below), date range, and sortable columns. A quotation's two ledger legs show up here as plain Deposit/Withdrawal rows carrying a Pending/Paid/Refunded status pill — there's no PDF or settlement action on this table; those live in the Quotations module itself. Deposit/Withdraw actions are handled by the standalone Deposits & Withdrawals module now — the account view itself stays a clean, read-focused history: linked account, transactions, then an **Account Summary** (total deposited/withdrawn/turnover + a reconciliation line) at the bottom
- **Dark / Light theme** — a toggle at the bottom of the sidebar, persisted across sessions
- **Collapsible sidebar** — every nav item has an icon; a ☰/× toggle in the sidebar header collapses it to icons-only on desktop (persisted across sessions) or expands it back, with a smooth slide transition. On phones and narrow tablets (≤768px) the sidebar is off-canvas by default — a hamburger button in the topbar slides it in as a full overlay with a backdrop and a clear × close button; tapping a nav item or the backdrop closes it again
- **Grouped navigation** — Account, Payment, Quotations, and Transaction History are expandable parent menus (animated chevron, smooth height/opacity transition on expand/collapse), each opening into its sub-pages: Account → USD Accounts / SLSH Accounts; Payment → USD Payment / SLSH Payment; **Quotations → Pending / Paid / Refunded** (see the Quotations bullet below — no "All" tab, and each submenu shows a live, database-computed count badge); Transaction History → USD / SLSH Transactions. A group's header stays highlighted while any of its sub-pages is open, and auto-expands to reveal the active one. Dashboard, Money Exchange, Reports, Users & Roles, and Settings stay as plain top-level items. When the sidebar is collapsed to icons-only on desktop, the whole tree flattens to a single icon list with tooltips (nothing becomes unreachable); on mobile the full grouped tree always shows with working chevrons
- **Topbar** — a live clock (date + ticking HH:MM:SS with a clock icon) sits right next to the mobile hamburger; a sun/moon theme pill, a notification bell (badge for unseen activity, dropdown showing recent updates pulled from the audit log — everyone can see it, not just managers), and a profile menu (avatar initials, name, role, Sign out) replace the old sidebar-footer versions of these
- **Modern table system** — every table in the app (there are 13) shares one upgraded look: a **dark blue header and footer** with white text (sticky — stays visible while a long table scrolls), **light blue row backgrounds**, a smooth row-hover highlight, rounded card containers with a subtle shadow, an animated sort-direction arrow, and icon-illustrated empty/loading states — all theme-aware in both Dark and Light mode. Search fields have a search icon; Export/Edit/Delete/View buttons automatically pick up a matching icon (download/pencil/trash/eye) with a small hover animation (trash shakes, download nudges down) — this all comes from a few shared components (`th`, `SortTh`, `Btn`, `Empty`, `Spinner`, `SearchInput`), so it's consistent everywhere and easy to extend without duplicating styles per table
- **Typography** — Inter (interface) and JetBrains Mono (numbers/currency) via Google Fonts, a clean modern pairing
- **Active filter chips** — on the tables with real filter bars (Money Exchange, Accounts, Deposits & Withdrawals, Quotations, Transaction History), whatever filters are currently set show up as removable chips right under the toolbar, each with its own × to clear just that one, plus a "Clear all" to reset everything at once
- **Transfer** — moves money between two *different* accounts of the *same* currency (e.g. Customer A's USD account → Customer B's USD account) — distinct from Exchange, which always converts USD↔SLSH for one client. Same debt-allowed policy as everywhere else (never blocked for insufficient funds), both accounts must be active and the same currency, and it shows up in each account's activity feed and in Transaction History as its own record type
- **Money Exchange** — ledger, void with audit trail, daily till log, rate history. The "Client / customer name" field searches and groups matches into **USD accounts** / **SLSH accounts**; pick one and the form shows the exact **FROM** (debited) and **TO** (credited, if linked) accounts, locks the currency to match, and the exchange actually moves money — debited from that account, credited into its linked opposite-currency account if it has one — with the ledger entries and balances to match. A receipt-style **Given / Rate / Received** strip with a **swap (⇄) button** flips the exchange direction in one click — including which linked account is debited vs credited. Voiding a linked transaction reverses both sides. The **Date & time** and **Rate** are both editable per transaction (rate defaults to the current one; date defaults to now, for backdating). Walk-in clients without an account still work exactly as before (free text, no balance movement). **Profit is now auto-calculated** from the spread between this Daily Rate and a separate **Sale Rate** (the wholesale/cost rate the business actually sources currency at — set and logged in its own "Sale Rate" section on the Rate history tab, gated by the same permission as the Daily Rate) — still an editable override per transaction, defaulting to the live auto-computed figure until manually changed. See "Latest round (SALE RATE / EXCHANGE PROFIT)" below for the exact formula
- **Quotations** — company accounts only (personal/customer accounts can't have quotations). **Presented as three filtered views of one table** — a "Quotations" sidebar group with exactly **Pending / Paid / Refunded** submenus (no "All" tab), each with its own live, database-computed count badge; every filter, search, and sort works *within* whichever submenu is open, never across all three at once. The list itself leads with a display-order **`#`** column (newest = 1, distinct from the real quotation number), plus Account/Currency/Quotation-date-range/Valid-until-range/Amount-range filters and a broadened Search across number, account, customer, phone, description, and notes. Each row has a **View** action opening a read-only detail page (Status, Account, Currency, Amount, Quotation Date, Valid Until, and whichever settlement date applies) with its own Update/Delete actions. **Two-step account ledger logic**: registering a quotation isn't a paperwork-only event — it's a real financial transaction from the moment it's created. The **Client name** field searches and links to an existing company account (auto-filling contact & address, and defaulting the account to charge to that same account), the same way Money Exchange links to real accounts — or type a new name for a client who isn't registered yet. A new, **required "Account to charge"** field lets you pick (or override) exactly which account pays, independent of the client name. The moment you hit **Save quotation**, two things happen atomically: the quotation is created, *and* a real **Withdrawal** is posted against the chosen account — no separate "Charge Account" step, no Draft/Sent/Accepted approval chain first. **While a quotation is still Pending, Update now opens full editing** — items, quantities, unit prices, discount, tax, and the customer can all be changed (only the charged account itself stays fixed; duplicate the quotation to charge a different one). Any resulting change in the total is never applied by rewriting the original Withdrawal — instead it posts a brand-new **adjustment** ledger entry (an extra Withdrawal if the total went up, a Deposit if it went down), so financial history is never rewritten, only added to; the UI previews the adjustment live, before you save. Once a quotation settles (Paid or Refunded), it goes back to the old locked form — only contact, address, valid-until, and notes stay editable. From Pending, exactly one settlement follows, once, ever, via a single **Settle** action with a Paid/Refunded choice: **Paid** posts a settlement **Deposit** ("Quotation Paid — {number}") crediting the money back and flips status to **Paid**; **Refunded** posts a settlement Deposit ("Refund — quotation charge reversed") and flips status to **Refunded**. The original Withdrawal, any Pending-time adjustment, and the settlement Deposit are all permanent — none is ever deleted, replaced, or hidden, and all three carry the quotation's own number as their reference. **Accounts are allowed to go negative (debt)** — the initial charge never blocks for insufficient funds. **Editable per-quotation exchange rate** — a "Set Rate" button lets you override the rate for that one quotation (validated, positive numbers only); once saved, that rate is locked forever, even if the system's global rate changes later. **Customizable line-item columns** — a "Customize Columns" panel lets you show/hide columns (Quantity, Unit Price, Currency, Total USD/SLSH, plus optional SKU/Product Code/Notes/Delivery Time/Warranty/Serial Number), add your own custom text columns, and "Save as default" to make it your standard layout next time (persisted per-user on the backend). Hiding a column never deletes its data. The PDF export automatically reflects whichever columns are currently visible. **Delete now works regardless of status — including Pending** — it's a record-management action, never a financial one: it removes the quotation document and its line items but never touches the account's balance or any `account_ledger` row the quotation produced. Deleting a still-Pending quotation leaves its original Withdrawal permanently outstanding with no document left to explain it (the confirmation modal — retitled "Delete Quotation Permanently?" — says so explicitly); deleting a settled one behaves as before. Every ledger leg a quotation ever produced keeps showing permanently in the account's own Transactions table and in Transaction History, referenced by number, even after the document itself is gone
- **Transaction History USD / SLSH** — split into two menus, same as Accounts and Deposits & Withdrawals. Each shows a unified, searchable view (across exchanges, transfers, and quotations — every ledger leg a quotation ever produced appears as its own row, labeled **"Quotation Charge"** (the original Withdrawal, or any later upward adjustment), **"Quotation Adjustment"** (a downward revision made via Update while still Pending — never mislabeled as a settlement), or **"Quotation Settlement"** (the final Paid/Refunded Deposit), all filterable together under a single "Quotations" type filter) scoped to accounts of that currency — filter by record type, Customer/Company, date range, or free-text search across ID, name, or phone
- **Reports** — exchange summary, quotation report, currency position, staff activity, audit log
- **Users & Roles** *(admin)* — create/edit/deactivate user accounts, reassign roles. New/edited user names are auto-uppercased the same way personal account names are
- **Settings** *(admin)* — General: company name, tagline, contact details, and logo — used in the sidebar, the login screen, and every generated PDF. **Document appearance** at the bottom lets you pick a PDF accent color (color picker, hex input, or preset swatches, with a live preview) used across every exported PDF — quotations, statements, reports. **Deactivated Accounts** *(a Settings sub-page, not under Account)* — lists every deactivated account (Name, Number, Currency, Balance, Status, Deactivated Date/By, Reason) with View/Reactivate/Delete actions, so a permanent delete always starts from here or from the account's own Quick Actions

## Quick start

The app stores its data in **MySQL 8.0.16 or newer** (GoDaddy's managed
MySQL in production; any local MySQL 8 for development).

```bash
npm install                 # runtime: mysql2, pdf-lib, exceljs (+ esbuild/react/playwright for development)
cp .env.example .env        # then fill in DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET
npm run seed                # DEMO data only (refused when NODE_ENV=production)
npm start                   # http://localhost:4000
```

The tables are created automatically on the first start (empty database).
Never commit `.env` — it holds the database password and `JWT_SECRET`.

Open **http://localhost:4000** and sign in with any demo account (the demo
password is `SEED_DEMO_PASSWORD`, default `Demo123!`):

| Username | Role |
|---|---|
| amina.yusuf | Admin |
| xasan.cali | Manager |
| faadumo.warsame | Accountant |
| cabdi.maxamed | Cashier / Teller |
| ilhan.nuur | Sales Staff |
| sahra.ismail | Viewer / Auditor |

Each account only sees and can do what its role allows — try logging in as
`cabdi.maxamed` (Cashier) after `amina.yusuf` (Admin) and compare the sidebar
and the Money Exchange ledger; the restriction is enforced by the API, not
just hidden in the UI (a modified or bypassed client still gets a 403).

Re-run `npm run seed:force` to wipe and reseed the demo data. Set a real
`JWT_SECRET` before running this anywhere other than your own machine.

## Deploying on GoDaddy Node.js Hosting (MySQL)

See **docs/MYSQL-MIGRATION-PLAN.md** for the full plan, what was verified
and what must still be checked in the GoDaddy dashboard. In short:

- **Database settings** come only from the environment variables GoDaddy
  sets for its managed MySQL database: `DB_HOST`, `DB_PORT`, `DB_NAME`,
  `DB_USER`, `DB_PASSWORD`. Also set `JWT_SECRET` (and, for a brand-new
  installation, `SUPER_ADMIN_INITIAL_PASSWORD`) as secrets in the dashboard.
- **Install / build / start:** `npm install` (production, no dev
  dependencies) → `npm run build` (checks the pre-built frontend is present —
  nothing needs compiling) → `npm start` (`node src/server.js`, listens on
  the platform's `PORT`).
- **Health check:** `GET /api/health` — 200 only when MySQL answers; 503
  (with `"database": "unavailable"`) otherwise. If MySQL is down at start
  the server still starts, answers 503, and connects by itself when MySQL
  comes back.
- **No local files are needed for data**: everything, including backups,
  lives in MySQL (GoDaddy keeps only `public/assets/` between deploys).
- **Moving existing SQLite data:** `scripts/migrate-sqlite-to-mysql.js`
  (dry run first, then execute — see the plan document).

### Super Admin

A separate, permanent **Super Admin** account is created automatically on
first startup of a new installation (`src/db.js`; its password is
`SUPER_ADMIN_INITIAL_PASSWORD`, or the default below — which must be changed at the first sign-in)
| Username | Password | Role |
|---|---|---|
| `super.admin` | `SuperAdmin123!` | Super Admin |

Super Admin has full, unconditional access to everything and can never be
restricted by a role permission — see "Roles & Permissions" below. **Change
this password** (or create your own Super Admin and deactivate this one —
never delete the only Super Admin; the system refuses it) before using this
anywhere real.

## What's actually running

- **`src/`** — the API: authentication (PBKDF2 password hashing, signed
  tokens), server-enforced RBAC, MySQL via `mysql2` (`src/mysql/`), and
  PDF generation via `pdf-lib`. See the full endpoint reference below.
- **`frontend/app.jsx`** — the web UI, plain React, talking to the API with
  `fetch()`. This is the readable source.
- **`public/app.bundle.js`** — the frontend, pre-built and checked in, so
  `npm start` works immediately without a build step. If you edit
  `frontend/app.jsx`, run `npm run build:frontend` to rebuild it (needs the
  dev dependencies: `npm install --include=dev`).
- **`test/e2e.js`** — a real end-to-end test: it starts the server against a
  scratch MySQL database, drives an actual headless browser (Playwright) through
  login, every module, a role-restriction check, and a file download. Run it
  with `npm run test:e2e` (needs `npx playwright install chromium` once).

### Why this dependency footprint

The **runtime** depends on `mysql2` (the MySQL driver), `pdf-lib` (branded
PDFs) and `exceljs` (Excel exports); the API server itself otherwise uses
only Node's built-ins (`node:crypto`, `node:http`, `worker_threads` — no
Express, no `jsonwebtoken`, no `bcrypt`). The frontend is bundled and
checked in specifically so you don't need `react`/`esbuild` installed just
to run the app — they're dev-only, for if you want to edit the UI.

**How MySQL is used without rewriting the app.** Every route was written
against a synchronous database API. `src/mysql/sync-client.js` keeps that
shape: a worker thread owns one MySQL connection, and each query waits for
its answer — one query at a time, exactly the serial behaviour the app had
with SQLite, so a transaction can never interleave with another request.
`src/mysql/dialect.js` translates the few SQLite-only expressions the app
used (and refuses any other SQLite-only SQL instead of letting it behave
differently).

## Frontend ⇄ backend wiring

The React source (`frontend/app.jsx`) calls the API with relative paths
(`fetch("/api/...")`), which is why everything must be served from one
origin — that's what `src/static.js` and the static-file branch in
`src/server.js` are for. The auth token is kept in `localStorage` (this is a
real self-hosted page you control, not a sandboxed environment, so that's a
reasonable and normal choice) so refreshing the page doesn't log you out.
Every list, mutation, and export in the UI is a real API call — nothing in
the frontend computes financial figures independently; the numbers you see
are exactly what the server computed.

**Accounts** — every account is single-currency now (`currency: "USD"|"SLSH"`, fixed at creation). `GET /api/accounts?currency=USD|SLSH&type=customer|company&search=&from=&to=&sort=&balanceSign=positive|negative` (search matches name, account #, email, phone, ID number; `balanceSign` filters funds vs debt; `currency` strictly filters to that one currency — USD and SLSH accounts are never mixed in one response, even for the same client — and when `search` is given without an explicit `sort`, results are relevance-ranked: exact account-number match, then exact name match, then "starts with", then the general partial match) · `GET /api/accounts/:id` (detail + balance + linked account + ledger + recent history) · `POST /api/accounts` `{name, accountType, currency, contact?, email?, idNumber?, address?, openingBalance?}` *(admin/manager/accountant/sales)* · `PATCH /api/accounts/:id` · `POST /api/accounts/:id/deposit` `{amount, notes?}` · `POST /api/accounts/:id/withdraw` `{amount, notes?}` (currency is implied by the account; rejected with 400 if it would go negative) · `POST /api/accounts/:id/link` `{targetAccountId}` (must be the opposite currency) · `POST /api/accounts/:id/unlink`

**Deposits & Withdrawals** (standalone, across all accounts of one currency) — `GET /api/account-ledger?currency=USD|SLSH&type=all|deposit|withdrawal&search=&from=&to=` · `GET /api/account-ledger/daily?date=YYYY-MM-DD&currency=USD|SLSH` (entries + per-currency totals) · `PATCH /api/account-ledger/:id` `{amount?, notes?, date?}` · `DELETE /api/account-ledger/:id` `{reason?}` — both safely recompute every later `balance_after` for that account and update the account's live balance, so editing an old entry never corrupts the running history (+ export.csv, export.pdf)

**Transaction History** — UNIFIED TRANSACTION HISTORY: `GET /api/history?currency=USD|SLSH&type=all|exchange|transfer|quotation|deposit|withdrawal&accountType=all|customer|company&status=&staffId=&accountId=&from&to&search` (one merged, normalized list across exchanges, transfers, quotation ledger legs, and now plain deposits/withdrawals too — previously the one bucket this report never surfaced; `currency` filters by the associated account's currency; `status` matches each record's own status word — `active`/`voided` for exchanges & transfers, `pending`/`paid`/`refunded` for quotation legs, ignored for plain deposits/withdrawals, which have none; `staffId` and `accountId` filter to one staff member or one account (`accountId` matches a Transfer on either its source or destination side); `search` matches reference number, account name, phone, staff/creator name, or notes; quotation legs are sourced from `account_ledger` directly, not the `quotations` table, so they keep showing up even if the quotation they came from is later deleted; every entry carries a formatted reference number — `EX-`/`TR-`/`DEP-`/`WD-` plus year and a sequential 4-digit counter, or `QT-...` for quotation legs — generated once at creation and never reused, even after a permanent delete; + export.csv, export.pdf). Each row's click target opens a Detail view — see "Latest round" below

**Notifications** — `GET /api/notifications?limit=` (default 25, max 50) — recent audit-log activity, open to every signed-in user regardless of role

**Settings** — `GET /api/settings/company` (public — needed for the login screen) · `PATCH /api/settings/company` `{name, tagline?, address?, phone?, email?, website?, logoDataUrl?, faviconDataUrl?, pdfAccentColor?, brandColor?, secondaryColor?, accentColor?, statusPendingColor?, statusPaidColor?, statusRefundedColor?, fontFamily?, fontSize?}` *(admin only; logo must be a PNG/JPEG data URL under ~1.3MB; favicon must be a PNG/JPEG/ICO data URL under ~90KB; pdfAccentColor/brandColor/secondaryColor/accentColor/status*Color must each be a `#rrggbb` hex string — pdfAccentColor affects exported PDFs only, brandColor/secondaryColor/accentColor drive the live app's sidebar/buttons/links/login screen/highlights, status*Color drives the Pending/Paid/Refunded badges; fontFamily and fontSize must each be one of a fixed whitelist — see "APPEARANCE & BRANDING — Round 2" under "What was actually tested")*

## Multi-Company Architecture

One installation can now host many independent companies. A single **Super Admin** registers and manages them, and each company's data stays completely separate.

### How data is separated

All data lives in **one MySQL database** (the one GoDaddy provides), in
separate sets of tables:

| Tables | Holds |
|---|---|
| `ctl_*` (platform) | `ctl_companies` registry, platform Super Admin accounts, username → company directory, platform audit log, stored backups. **No financial data.** |
| `cmp0001_*` | Company `CMP-0001` (the primary company) |
| `cmp000N_*` | Every other company: its accounts, balances, ledgers, payments, exchanges, transfers, quotations, cash accounts, loans, rates, reports data, audit log, users, roles, permissions, settings/branding, PDF/Excel templates |

- **Company ID.** Every company has a unique, permanent ID (`CMP-0001`, `CMP-0002`, …). Every table of a company has a `company_id` column and a database `CHECK (company_id = '<that company>')` — MySQL itself **refuses** any insert or update that would put a different company's ID on a row. A one-row `tenant_meta` table records which company the tables belong to and is checked before they are opened.
- **Server-side isolation.** Every API request starts with *no* company context (`src/tenant-context.js`, AsyncLocalStorage). Only `rbac.requireAuth` sets one, after verifying the signed session token. All database helpers (`run/get/all/tx/db`) operate on that one company's tables and **throw** when there is no company context. Each company's handle can only name its own tables: SQL is rewritten to that company's table set, and naming another company's (or the platform's) tables directly is refused.
- **Trusted context only.** The company is read only from the server-signed token (`cid` claim). It is never taken from a URL, query string, header or request body. A record ID from another company simply doesn't exist in the caller's tables, so the request returns 404.
- **Why separate tables per company?** The app has several hundred hand-written queries. Separate table sets give database-level isolation without relying on every query remembering a `WHERE company_id = ?` — the same guarantee the earlier one-file-per-company SQLite design gave.

### Roles

| Level | Who | Can |
|---|---|---|
| Super Admin | platform account (control DB) | Register/edit/activate/deactivate/suspend companies, assign Company Admins, view per-company summaries, open any company's workspace (`POST /api/platform/switch-company` issues a token bound to that company) |
| Company Admin | the company's built-in **Admin** role | Manage only their company: accounts, users, roles, settings (per granted permissions). Cannot reach `/api/platform/*`. |
| Staff | any other role | Only what their role allows, only inside their company |

Usernames are unique across the whole installation, so login finds the user's company from the username alone. Inactive or suspended companies lock their users out immediately, including live sessions. A Super Admin can still open them.

### Company status rules

Every company (the primary company and the current workspace included) has two **independent** switches, changed only by a Super Admin via `POST /api/platform/companies/:id/status` with `{ "action": "deactivate" | "activate" | "suspend" | "unsuspend", "reason" }`:

| | Suspend → Unsuspend | Deactivate → Activate |
|---|---|---|
| Meaning | Temporary hold (unpaid subscription, investigation…) | Company closed / no longer using the system |
| Reason | Required | Optional |
| Company users | Blocked immediately: "temporarily suspended" | Blocked immediately: "has been deactivated" |
| Super Admin | Can still open the workspace (status banner shown) | Same |
| Data | Never changed or deleted | Never changed or deleted |

A company is usable by its own users only when it is **neither** suspended **nor** deactivated; lifting one switch leaves the other in force. The derived `companies.status` column (`active` / `inactive` / `suspended`) is what every access check reads. Each change affects only that company and is recorded in the platform audit log.

### Super Admin API (`/api/platform/*`, platform token required)

`GET/POST /companies`, `GET/PATCH /companies/:id`, `POST /companies/:id/status` (`action`: deactivate | activate | suspend | unsuspend, + reason; legacy `status` still accepted), `POST /companies/:id/admins` (create a new admin, or `{userId}` to promote), `GET /overview` (separate per-company summaries, never merged), `POST /switch-company` (`{companyId}` or `null` for the console), `POST /me/password`, `GET /username-available`.

### Moving an existing SQLite installation to MySQL

`scripts/migrate-sqlite-to-mysql.js` (full description in
docs/MYSQL-MIGRATION-PLAN.md):

1. Copies the SQLite files byte-for-byte into an immutable, checksummed
   backup (the originals are only read, never opened for writing).
2. Brings a **copy** up to the final SQLite schema with the app's own last
   SQLite upgrade code and reports anything that upgrade changed.
3. Checks that every value fits MySQL exactly (no Infinity/NaN amounts, no
   over-long key values, no duplicate unique keys) — otherwise it stops.
4. `--dry-run`: shows per-company row counts and what would be copied;
   writes nothing. `--execute`: copies each table in its own transaction,
   verifies row count and a SHA-256 of the content before committing, then
   verifies relationships and financial totals for every company.
5. Never overwrites: a target table holding rows it did not write stops the
   run. Re-running resumes and skips verified tables (no duplicates).

**Rollback:** the SQLite files are unchanged; the previous version keeps
working on them. **Backups** after the move: per company, stored in MySQL
(`ctl_backups`), downloadable by a Super Admin (`GET /api/backups/:name`),
restorable with `node scripts/backup.js restore --company CMP-000N --name … --confirm`.

### Tests

`npm run test:tenancy` builds two companies plus a third registration attempt, with Super Admin, Company Admin and Staff users. It checks:

- cross-company reads and writes by ID, URL, body, header and query string
- forged and legacy tokens
- per-company totals and exports (including the Excel letterhead)
- backend permission checks
- suspend and deactivate
- workspace switching, including a browser check that no data from the previous company remains on screen
- database-level `company_id` guards and existing financial workflows

## API reference

All endpoints except `/api/health` and `/api/auth/login` require
`Authorization: Bearer <token>`. Every mutating endpoint (and most reads)
re-checks the caller's role server-side — see `src/rbac.js` for the full
permission matrix, mirrored in the frontend only for UI purposes.

**Auth** — `POST /api/auth/login` `{username, password}` → `{token, user}` · `GET /api/auth/me`

**Users** *(admin only, plus `users.delete` for the new DELETE below)* — `GET /api/users` (excludes soft-deleted users) · `POST /api/users` `{name, username, password, role}` or `{..., roleId}` — `roleId` (a real `roles.id`) is the forward-compatible way to assign a role and is preferred when present; `role` (one of the 6 original legacy role names) still works unchanged for the current UI, and is translated to the matching `roleId` internally · `PATCH /api/users/:id` `{name?, role?, roleId?, active?, status?, password?}` — `status` is the new three-state `active`/`deactivated`/`suspended` field; `active` (boolean) still works and maps onto it (`true`→`active`, `false`→`deactivated`); omitting **both** leaves status untouched (a plain name-only edit, for instance, never silently flips it back to active). Reassigning a role or changing status/permissions takes effect on the affected user's **very next request**, not their next login — see Session Security below · `DELETE /api/users/:id` `{confirmUsername}` — **new this round**: permanent delete, gated by the granular `users.delete` permission (admin/Super Admin only). Only reachable once the user is already `deactivated`/`suspended` (an active user is rejected with a 400), and requires typing the user's exact username to confirm. Always a **soft delete** (`deleted_at`/`deleted_by`) — `exchange_transactions.staff_id`, `quotations.created_by`, `exchange_rates.set_by`, and `transfers.staff_id` all hold real foreign keys to `users(id)`, so a hard delete would orphan real financial history; every historical record made by a deleted user is preserved exactly as before, just no longer editable by that account. **Super Admin protection** applies throughout this file (see below) — a normal Admin can't touch a Super Admin's account at all, nobody can grant the Super Admin role except an existing Super Admin, and the last remaining active Super Admin can never be deactivated, demoted, or deleted by anyone

**Exchange rate** — `GET /api/rate` (current + history) · `POST /api/rate` `{rate}` *(manager/admin)*

**Opening balances** — `GET /api/balances` · `POST /api/balances` `{usd, slsh}` *(manager/admin)*

**Money exchange**
- `GET /api/transactions?from&to&staffId&client&status` — non-`exchangeAll` roles only ever see their own transactions, enforced server-side
- `POST /api/transactions` `{clientName, clientAccountId?, clientContact?, clientAddress?, amountGiven, currencyGiven, amountReceived?, rateUsed?, date?, profitUsd?, notes?}` — with `clientAccountId`, the account (matching `currencyGiven`) is debited for real, and its linked opposite-currency account (if any) is credited; `rateUsed` overrides the current exchange rate for this transaction only, and `date` allows backdating; without `clientAccountId`, behaves as a plain CRM record like before
- `PATCH /api/transactions/:id` — same body shape as `POST` above — EXCHANGE UPDATE: edits an already-posted exchange (client/account, amounts, currency, rate, profit, notes, date), the **Update** action alongside Delete. Requires `exchangeUpdate` (same grantees as `exchangeDelete`: admin/accountant, not the broader `exchangeCreate` set). Since every exchange posts its financial effect immediately (no separate "Accepted" step in this app's data model), an edit is handled the same way a delete's reversal is: inside one database transaction, it deletes this exchange's own tagged `account_ledger` rows and rebuilds the OLD account(s) from what's left (undoing the old effect, exactly like `DELETE` does), writes the new fields onto the *same* `exchange_transactions` row (same id throughout — it's never deleted/recreated), then re-posts fresh ledger rows — still tagged back to this same exchange id — against whichever account(s) the edited form now points at (can be a different account pair entirely) and rebuilds those. Re-reads and re-checks the row from inside the transaction, same anti-corruption pattern as `DELETE`. Rejected with a 400 for a transaction already voided under the old system, for the same reason `DELETE` rejects it (its old reversal isn't tagged, so there's no reliable "old effect" to undo first)
- `DELETE /api/transactions/:id` `{reason?}` — EXCHANGE DELETE — PERMANENT FULL DATA DELETION: there is no more Void. Requires `exchangeDelete` (not `exchangeAll`/`exchangeCreate`). Runs inside one database transaction: reverses any real balance effect by deleting this exchange's own `account_ledger` rows (`source_type='exchange'`) and rebuilding both affected accounts' balances from what's left (no separate "reversal" entry is created or left behind), then deletes the `exchange_transactions` row itself — permanently, not soft-cancelled. Re-reads and re-checks the row from inside the transaction, so two near-simultaneous delete requests can't both succeed (the second gets a clean 404) or double-reverse a balance. Rejected with a 400 for a transaction already voided under the old system (its balance was already reversed then via an untagged, unlinked reversal entry — deleting its tagged rows now on top of that would double the reversal); an optional free-text `reason` is recorded in the audit log alongside the deleted transaction's details
- `GET /api/transactions/daily-log?date=YYYY-MM-DD`
- `GET /api/transactions/export.csv` / `GET /api/transactions/export.pdf`

**Transfers** — moves money between two *different* accounts of the *same* currency; distinct from Exchange (always USD↔SLSH for one client)
- `GET /api/transfers?accountId&from&to&status` — `accountId` matches either the source or the destination account
- `POST /api/transfers` `{fromAccountId, toAccountId, amount, notes?}` *(`accountsManage`)* — both accounts must exist, be active, and share the same currency (rejected with 400 otherwise, pointing at Currency Exchange instead); posts a real Withdrawal on the source and a real Deposit on the destination immediately, both tagged `source_type='transfer'` back to this transfer's id; assigns a formatted `TR-YYYY-####` reference number
- `PATCH /api/transfers/:id` `{fromAccountId, toAccountId, amount, notes?, date?}` *(`transferUpdate` — same grantees as `exchangeUpdate`: admin/accountant)* — TRANSFER UPDATE, added this round alongside Delete for parity with Exchange's Update/Delete pairing. Since a transfer posts its financial effect immediately, an edit is handled the same "undo the OLD effect, then apply the NEW one, in one transaction" way as EXCHANGE UPDATE: deletes this transfer's own tagged `account_ledger` rows and rebuilds whichever account(s) they belonged to, writes the edited fields onto the *same* `transfers` row (never deleted/recreated), then re-posts fresh ledger rows — still tagged to this same transfer id — against the (possibly different) account pair the edited form now points at, and rebuilds those. Re-reads and re-checks the row from inside the transaction, same anti-double-submit pattern as Exchange Update. Rejected with a 400 for a transfer already voided under the old system
- `DELETE /api/transfers/:id` `{reason?}` *(`transferDelete`)* — TRANSFER DELETE — PERMANENT FULL DATA DELETION, replacing the old Void flow entirely: there is no more soft-cancel that leaves a "voided" row plus a separate, untagged reversal entry sitting in the database forever. Runs inside one database transaction: reverses the real balance effect by deleting this transfer's own tagged `account_ledger` rows and rebuilding both accounts' balances from what's left, then deletes the `transfers` row itself — permanently. Re-reads and re-checks the row from inside the transaction, so two near-simultaneous delete requests can't double-reverse a balance. Rejected with a 400 for a transfer already voided under the old system (its balance was already reversed then via an untagged, unlinked entry — deleting tagged rows now on top of that would double the reversal); an optional free-text `reason` is recorded in the audit log

**Quotations** — two-step account ledger model: every quotation posts a real
Withdrawal the instant it's created, and settles later with exactly one
Deposit (Paid or Refunded). See the Quotations bullet under "What's
included" above for the full mechanics.
- `GET /api/quotations?status&search&client&account&currency&dateFrom&dateTo&validFrom&validTo&amountMin&amountMax` · `GET /api/quotations/:id` — `status` is one of `Pending`/`Paid`/`Refunded` (each sidebar submenu is just this list pre-filtered); `search` matches quotation number, customer name/contact/address, notes, or the charged account's own name/contact (the older `client` param still works, narrower); the rest layer on as additional filters, all combinable
- `GET /api/quotations/counts` — `{Pending, Paid, Refunded}` row counts straight from the database, used for the sidebar's live badges; `requireAuth` only (the sidebar itself decides who sees the Quotations group)
- `POST /api/quotations` `{clientName, clientContact?, clientAddress?, accountId, currency?, items:[{description, qty, unitPrice, currency, extraFields?}], rateUsed?, discountPercent?, taxPercent?, issueDate?, validUntil?, notes?}` — **`accountId` is required**: the account to charge, chosen at creation time (no longer defaulted or deferred). Creates the quotation **and its Withdrawal in one atomic step** — the account's balance drops immediately, status starts as `Pending`. Optional `currency` (`"USD"|"SLSH"`) is the frontend's selected transaction currency (from the Quotation editor's Currency selector) — when present, it's cross-checked against `accountId`'s own `currency` column and the request is rejected with 400 `"Selected account currency does not match the transaction currency."` on a mismatch (ACCOUNT / CLIENT SEARCH — CURRENCY SEPARATION, backend half); omit it and only the existing account/deactivation checks apply. `rateUsed` overrides the system rate for this quotation only (must be positive); each item's `extraFields` is a free-form `{key: value}` object for optional/custom columns (SKU, warranty, custom fields, etc.)
- `PATCH /api/quotations/:id` — `{clientName?, clientContact?, clientAddress?, issueDate?, validUntil?, notes?, items?, rateUsed?, discountPercent?, taxPercent?}`. `clientContact`/`clientAddress`/`issueDate`/`validUntil`/`notes` (and `clientName`, which can re-link to a different existing company account via `findOrCreateClient`) are always editable, any status. `items`/`rateUsed`/`discountPercent`/`taxPercent` are **only accepted while the quotation is still `Pending`** — rejected with a 400 once `Paid`/`Refunded` (its charge and settlement have both already posted; duplicate it to issue a revised version instead). `accountId` is **never** accepted here at all, any status — the charged account can't be reassigned via Update; rejected with a 400 if it differs from the existing one. When a financial edit changes the total, the delta is **never** applied by editing the original Withdrawal — it posts a brand-new ledger entry instead (Withdrawal if the total went up, Deposit if it went down), tagged the same `quotation_charge` source type as the original charge (so it automatically reads as `Pending`-status everywhere the app already understands that tag, including Transaction History's "Quotation Adjustment" label — see below)
- `POST /api/quotations/:id/pay` — `Pending` only; posts the settlement Deposit (`"Quotation Paid — {number}"`, tagged `quotation_paid`) back into the originally-charged account and moves status to `Paid`. Rejected with a 400 if already `Paid` or `Refunded`. In the UI, this is one of the two outcomes offered by the single **Settle** button/modal (see the Quotations bullet above) — the endpoint itself is unchanged
- `POST /api/quotations/:id/refund-charge` — `Pending` only; posts the settlement Deposit (`"Refund — quotation charge reversed"`, tagged `quotation_refund`) back into the originally-charged account and moves status to `Refunded`. Mutually exclusive with `/pay` — a quotation settles exactly once, one way or the other; rejected with a 400 otherwise. The other outcome offered by the **Settle** modal
- `DELETE /api/quotations/:id` `{reason?}` — requires **both** `quotationsManage` and `quotationsDelete` (a role can manage quotations day-to-day without being trusted to permanently delete one). **Works for any status now, including `Pending`** — deleting is a record-management action, never a financial one, so it's no longer gated on settlement. Deletes the quotation and its line items, but **never** the `account_ledger` rows it produced — the original Withdrawal, any Pending-time adjustment, and (once settled) the settlement Deposit all stay exactly as they are, permanently, carrying the quotation's number in their own `reference_number` column (not a join), so they keep showing it correctly even after this delete. Deleting while still `Pending` leaves that original Withdrawal permanently outstanding with no document left to explain it — accepted and intentional per spec, and called out explicitly in the confirmation modal. An optional free-text `reason` is recorded, together with the quotation's account/customer/amount/previous-status, in a pre-deletion audit-log entry
- `POST /api/quotations/:id/duplicate` `{accountId?}` — creates a brand-new quotation from the same items/rate, charged (posts its own fresh Withdrawal) immediately like any other creation; defaults to the same account the original was charged to, or pass `accountId` to charge a different one
- `GET /api/quotations/:id/pdf?columns=` — branded single-quotation PDF; `columns` is a URL-encoded JSON array of `{key, label}` controlling which line-item columns render and in what order (defaults to the standard set if omitted)
- `GET /api/quotations/export.csv` / `GET /api/quotations/export.pdf` — same filters as the list endpoint above
- `PATCH /api/auth/me/quotation-column-prefs` `{prefs: {visible: [...], custom: [...]} | null}` — save the signed-in user's own column layout ("Save as default"); returned on login and `GET /api/auth/me` as `quotationColumnPrefs`

**Reports** *(admin/manager/accountant/viewer)* — each with `/export.csv` and `/export.pdf` where noted:
- `GET /api/reports/exchange-summary?from&to` (+ export.csv, export.pdf)
- `GET /api/reports/quotations` — status breakdown, conversion rate, by sales staff
- `GET /api/reports/currency-position` (+ export.csv, export.pdf)
- `GET /api/reports/staff-activity?from&to` (+ export.csv, export.pdf)
- `GET /api/reports/audit-log?actor` (+ export.csv, export.pdf)

**Roles & Permissions** *(new this round — the real, granular data model behind the dynamic RBAC engine; see "SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT" under "What was actually tested" for the full design)*
- `GET /api/permissions` *(`roles.view`)* — the full permission catalog: every `module.action` key the app understands (`accounts.view`, `quotations.settle`, `users.resetPassword`, ...), with its module, module label, and a display label. This is reference data for a future permission-matrix UI — nothing in the current frontend consumes it yet
- `GET /api/roles` / `GET /api/roles/:id` *(`roles.view`)* — every role (the 6 original roles, the permanent Super Admin, and any custom roles), each with its full granted-permission-key list (`null` for Super Admin — it has none stored, see below), live user count, protected/Super-Admin flags, and `permissionsVersion`
- `POST /api/roles` `{name, description?, permissions: [key, ...]}` *(`roles.create`)* — creates a custom role; every key in `permissions` is validated against the real catalog (an unknown key is rejected with a 400, never silently ignored). New custom roles are never protected and never Super Admin
- `POST /api/roles/:id/duplicate` `{name?}` *(`roles.create`)* — copies an existing role's permission set into a brand-new, always-unprotected, always-non-Super-Admin role (defaults to `"<name> (Copy)"`); refused for the Super Admin role itself, which has no stored permission set to copy
- `PATCH /api/roles/:id` `{name?, description?, permissions?}` *(`roles.update`, plus `roles.managePermissions` when `permissions` is included)* — renaming/deleting is refused for a protected role (Super Admin and Admin); **editing Admin's own permission set is still allowed** — only its existence is protected, per spec ("if Super Admin removes Manage Roles from Admin, Admin loses Role Management access"). The Super Admin role refuses every kind of edit outright — it carries no stored permissions to edit. Changing the permission set bumps `permissionsVersion`, which immediately invalidates the session of every user currently holding that role (see Session Security) — re-submitting the identical set is a no-op and does **not** bump it
- `DELETE /api/roles/:id` *(`roles.delete`)* — refused for a protected role, and refused with a 400 (not silently reassigning anyone) while any user still holds it — reassign them first
- `GET /api/users/:id/permissions` *(`users.managePermissions`)* — a user's permissions broken into exactly the three groups the spec calls for: **inherited from role**, **additional/denied user-specific overrides**, and the final **effective** set (role ∪ grants − denials, or `"ALL"`-equivalent `null` for a Super Admin)
- `PATCH /api/users/:id/permissions` `{overrides: [{permissionKey, granted}, ...]}` *(`users.managePermissions`)* — replaces this user's custom permission overrides wholesale (an empty array clears them all); `granted: true` adds a permission beyond their role, `granted: false` explicitly denies one their role would otherwise allow — without touching the role itself or anyone else holding it. Refused for a Super Admin target (nothing to override — already unrestricted) and subject to the same Super Admin protection as the Users API above. Bumps the target's own session version, same immediate-effect guarantee as a role change

**Table Customization** *(new this round — see "TABLE CUSTOMIZATION — Round 1" under "What was actually tested" for the full design)*
- `GET /api/table-layout/:tableKey` — returns `{system, mine}`, each either `{columns, density, updatedAt, updatedBy}` or `null`. `tableKey` is restricted to the 11 tables this feature covers (`accounts.usd`, `accounts.slsh`, `users`, `roles`, `auditLog` from Round 1; `exchange`, `payments.usd`, `payments.slsh`, `quotations` from Round 2; `history.usd`, `history.slsh` from Round 3) — an unrecognized key is a 400, not a silent empty result
- `PATCH /api/table-layout/:tableKey` `{scope?: "me"|"system", columns: [key, ...], density?: "compact"|"comfortable"}` — saving your own (`scope: "me"`, the default) is self-service, no permission needed; `scope: "system"` requires `settings.manageTableDefaults` and becomes the default every user without a personal layout inherits. `columns` is validated (must be an array, no duplicates, ≤40 entries) and audited only when it's the system-wide scope being changed
- `DELETE /api/table-layout/:tableKey?scope=me|system` — clears just that one saved layout (defaults to `scope=me`); same `settings.manageTableDefaults` gate on `scope=system`

**System Overview** *(new this round — see "SUPER ADMIN SYSTEM OVERVIEW" under "What was actually tested" for the full design)*
- `GET /api/system-overview` *(`users`, same legacy-key gate as the Users list)* — one aggregate read: `systemStatus` (uptime, server time, Node version, DB engine), `users`/`roles`/`permissions` counts, `database` (file size, WAL mode, per-table row counts), `recentChanges` (8 most recent audit-log entries), `recentLogins` (8 most-recently-logged-in users), and `auditActivity` (entry counts in the last 24h/7d). Read-only — no mutating counterpart

**PDF Templates** *(new this round — Round 1, form-based; see "SUPER ADMIN PDF TEMPLATE CONTROL" under "What was actually tested" for the full scope decision, including what's explicitly deferred)* — all gated by `settingsManage`, same as the rest of Settings:
- `GET /api/pdf-templates?kind=quotation&includeArchived=` · `GET /api/pdf-templates/:id`
- `POST /api/pdf-templates` `{kind?, name, showSignatureLines?, showNotes?, showBillToAddress?, showBillToContact?, headerNote?, footerText?}` — `kind` defaults to `"quotation"`, currently the only supported value
- `PATCH /api/pdf-templates/:id` — same body shape, all fields optional; bumps `version`
- `POST /api/pdf-templates/:id/duplicate` `{name?}` — copies all toggles/text into a brand-new, never-default, never-builtin, never-archived template (defaults to `"<name> (Copy)"`)
- `POST /api/pdf-templates/:id/set-default` — refused with a 400 for an archived template (restore it first); otherwise unsets the previous default and sets this one, both atomically
- `POST /api/pdf-templates/:id/archive` / `POST /api/pdf-templates/:id/restore` — archiving the current default is refused with a 400 (set a different one as default first)
- `DELETE /api/pdf-templates/:id` — refused with a 400 for the built-in template (can never be deleted) or the current default (set a different one as default first)
- `GET /api/pdf-templates/:id/preview.pdf` — renders a realistic **sample** quotation (clearly fake data) through this template's settings, for previewing before making it the live default
- `GET /api/quotations/:id/pdf` (pre-existing endpoint) now renders through whichever template is the current default for `"quotation"`, falling back to `renderQuotationPDF`'s own pre-this-round defaults if none is set

## What was actually tested

Every endpoint was exercised with `curl` during development — login
success/failure, every role attempting something it shouldn't (verified
403), transaction scoping, the full quotation state machine including
illegal transitions, user validation/deactivation, and every export
(generated PDFs were parsed back with `pdfjs-dist` to confirm they're valid
documents, not just 200 responses).

The connected app was then tested with a real headless browser
(Playwright): loading the login screen, signing in, navigating every module,
creating a transaction through the actual UI and confirming it appeared in
the list, downloading a PDF via a real click-triggered browser download, and
confirming a Cashier login shows a visibly different, correctly restricted
sidebar and ledger than an Admin login. Screenshots taken during this run
showed a correctly styled, fully populated UI with real data — this isn't
just "the code compiles," it's "a browser actually renders and uses it
correctly." Run it yourself anytime with `npm run test:e2e`.

There's also `npm run test:migration`, a dedicated check for the schema
migrations in `src/db.js`. A past version of this app shipped a migration
that recreated the `quotations` table (to widen its status constraint) while
SQLite's foreign-key enforcement was still on — safe against the throwaway
database used to test it at the time, but it crashed on startup (`FOREIGN
KEY constraint failed`) against any real database, because `quotation_items`
rows genuinely reference `quotations(id)` and SQLite checks that by table
name, which is briefly gone mid-migration. That's fixed (foreign keys are
now turned off for just that migration, then always back on afterward), and
`test:migration` guards against it recurring: it seeds a full database with
real foreign-key-linked rows, rolls the schema back to what an existing
installation would actually have, boots the server exactly as `npm start`
would, and confirms it comes up cleanly with every row — and every foreign
key — still correctly in place. Worth keeping in mind for any future
migration that recreates a table other tables reference.

**Previous round (FINAL QUOTATION MANAGEMENT SYSTEM — standardized
Pending/Paid/Refunded submenus, full editing while Pending, status-independent
Delete)** — a complete overhaul of the Quotations module to a single
standardized shape, in four parts:

1. **Sidebar restructure.** The flat "Quotations" nav item became a
   **group** with exactly three submenus — **Pending / Paid / Refunded** —
   each a filtered view of the same `quotations` table (no "All" tab, no
   duplicate quotation entry point anywhere else), each with a live,
   database-computed count badge (`GET /api/quotations/counts`, a plain
   `GROUP BY status`, never hardcoded). The list itself gained a
   display-order **`#`** column (newest = 1, distinct from the real
   quotation number) and a **View** action opening a read-only detail
   page (Status/Account/Currency/Amount/Quotation Date/Valid Until, plus
   whichever settlement date applies) with its own Update/Delete buttons.
   Filters grew substantially — Account, Currency, Quotation Date range,
   Valid Until range, and Amount range, on top of a broadened Search
   (number/account/customer/phone/description/notes) — all scoped
   *within* whichever submenu is currently open, via a shared
   `buildQuotationFilter()` helper reused by the list endpoint, the counts
   endpoint, and the CSV export alike.

2. **Full editing while Pending — the biggest behavior change.** This
   directly reversed a rule from the *previous* round (below): items,
   quantities, unit prices, discount, tax, and the customer can now all be
   changed via Update, as long as the quotation is still `Pending`
   (`PATCH /api/quotations/:id`). The one deliberate exception is the
   charged account itself, which still can't be reassigned via Update —
   changing it would mean reversing one account's Withdrawal and posting a
   fresh one to a possibly different account/currency, which "Duplicate to
   a different account" already handles safely; the account block renders
   read-only in the editor while Pending, with no "Change" control, and the
   backend rejects any `accountId` in the request body outright. Because
   this system's core rule is that financial history is never rewritten
   (only ever added to), a total-amount change from an edit is **never**
   applied to the original Withdrawal — it posts a **new**, additional
   ledger entry instead (an extra Withdrawal if the total went up, a
   Deposit if it went down), reusing the same `quotation_charge` source
   type the original charge uses. That reuse is deliberate: it makes the
   adjustment automatically read as `Pending`-status everywhere the app
   already understands that tag (account activity, Transaction History)
   with zero changes needed there — except one, a genuine mislabeling risk
   this round caught and fixed: a Deposit-type ledger row used to always be
   assumed a real settlement ("Quotation Settlement"), which would have
   been wrong for a *downward* Pending-time adjustment (a Deposit that
   isn't a settlement at all). Transaction History's label logic now checks
   the row's own frozen status first and calls that case **"Quotation
   Adjustment"** instead — distinct from both "Quotation Charge" (any
   Withdrawal-type row, original or upward adjustment) and "Quotation
   Settlement" (the real Paid/Refunded Deposit). The editor shows a live
   preview of the pending adjustment (amount and direction) before you even
   save. Once a quotation settles, Update reverts to the old, fully locked
   form (contact/address/valid-until/notes only) — this part is unchanged.

3. **Delete now works regardless of status — including Pending.** This
   reverses the *other* rule from the previous round below (which blocked
   Delete entirely for a `Pending` quotation). Per the spec's own framing,
   Delete is explicitly a **record-management** operation, never a
   financial one: deleting never touches the account balance and never
   touches any `account_ledger` row the quotation produced, Pending or not
   — deleting a still-Pending quotation simply leaves its original
   Withdrawal permanently outstanding in the ledger with no document left
   to explain it, which is accepted and intentional (the confirmation
   modal, retitled **"Delete Quotation Permanently?"**, spells this out
   explicitly and in different words depending on whether the quotation
   being deleted is still Pending or already settled). Still gated by both
   `quotationsManage` and the stricter `quotationsDelete`, still accepts an
   optional free-text reason recorded in the audit log.

4. **Save-button double-submission guard.** The quotation editor's Save
   button (in both the create form and the newly-opened Pending-edit form)
   now disables itself the instant it's clicked and stays disabled until
   the request settles, so a slow connection or an impatient double-click
   can no longer fire the create/update request twice.

A pre-existing toast-notification bug surfaced (and was fixed) while
building this round's tests: `notify()` scheduled every toast's dismissal
with its own independent `setTimeout(..., 3400ms)`, so firing two toasts
within 3.4s of each other — now routine, given how many actions a single
Update-while-Pending flow involves — let the *first* toast's timer wipe out
the *second*, still-fresh toast well before its own duration was up. Fixed
by tagging each toast with its own id and only clearing on a matching id.

Covered by a substantially rewritten `test/e2e.js`: the sidebar's
three-submenu shape (and the missing "All" tab); a Pending quotation
offering View/Edit/Settle/**Delete** together; the live count badge; the
View page's fields and its Update hand-off; the Pending-edit form's
editable item inputs and locked (no "Change" button) account block; a
lowered unit price showing a live "credit back" preview and, after Save,
posting a real Deposit adjustment while the quotation stays Pending at its
new amount and the account is credited back exactly the difference;
Settling afterward for the full, adjusted amount and dropping out of the
Pending submenu into Paid; all three ledger legs (Charge/Adjustment/
Settlement) showing correctly in the account's own Transactions table and
in Transaction History's Quotations filter (three distinct labels, not
two); Delete now succeeding on a still-Pending quotation with the balance
staying exactly where the outstanding Withdrawal left it; and Delete on a
settled quotation still showing the retitled confirmation copy. Full suite
(`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (ACCOUNT / CLIENT SEARCH — CURRENCY SEPARATION)** — a
system-wide audit of every account/client search and selection component,
against a hard rule: a USD account and a SLSH account must never appear
mixed together in one search/selection UI, even when they belong to the
same client (the seeded "Hodan Hotel" / "Hodan Hotel (SLSH)" pair is
exactly this case — same company, two separate account records). The audit
covered all nine frontend call sites of `GET /api/accounts` individually;
most were already compliant by construction (Money Exchange's dual-column
USD/SLSH client search never merges the two; Deposit/Withdraw and Transfer
lock their currency from the account you're already viewing; Account
Linking deliberately searches only the *opposite* currency; the Accounts
module's own USD/SLSH pages are separate menus). The one real violation was
the **Quotation editor**: its "Account to charge" and client-name searches
queried every currency at once.

Fixed by adding an explicit **Currency selector** (USD/SLSH) to the
Quotation editor, above the Account-to-charge box:

- Both the account-to-charge search and the client-name search now pass
  `currency` through to `GET /api/accounts`, so a search only ever
  surfaces accounts in the selected currency — never both.
- **Auto-clear invalid selection**: switching the Currency selector after
  an account was already chosen immediately clears that selection (but
  never the client name/contact/address, since the same client may hold a
  separate account in the other currency) — the user is always forced back
  into a fresh, correctly-scoped pick.
- **Wrong-currency transactions are rejected on both ends.** The frontend
  refuses to save if the selected account's currency doesn't match the
  chosen transaction currency; `POST /api/quotations` independently
  re-checks the same thing server-side (`createAndChargeQuotation()`
  compares the account's real `currency` column — never just its name —
  against the request's `currency`), returning exactly the wording the
  spec requires: *"Selected account currency does not match the
  transaction currency."* This is defense-in-depth — the currency-scoped
  search means a real mismatch shouldn't normally be reachable through the
  UI, but a stale selection or a direct API call is still caught.
- Every result row (both searches) now shows a clear name / account number
  / colored currency badge, and the empty state reads "No {currency}
  account found." (never silently falling back to the other currency).
- `GET /api/accounts` gained relevance-ranked search ordering — exact
  account-number match, then exact name match, then "starts with", then
  the general partial match — applied automatically whenever a caller
  searches without asking for an explicit sort (every picker; the Accounts
  module's own list always requests a sort explicitly, so its behavior is
  unchanged).

Money Exchange was deliberately left as-is despite being named in the
spec's "apply globally" list: it's a *cross-currency* conversion tool by
definition (in one currency, out the other), so a single-currency filter
would break its core purpose — its existing side-by-side, clearly-labeled
USD/SLSH columns (which never merge the two into one row) already satisfy
the spec's underlying intent of never presenting a USD and a SLSH account
as if they were one and the same. Deposit, Withdraw, Transfer, Account
details, and Account/Payment linking were likewise left unchanged, since
each already locks to a single currency by construction rather than
letting the user pick a currency and a mismatched account independently —
there was no mixed-currency search surface to fix.

Covered by six new `test/e2e.js` checks against the seeded Hodan Hotel /
Hodan Hotel (SLSH) pair: the Currency selector defaulting to USD; the
client-name search returning exactly the USD account (never the SLSH one);
switching to SLSH live-updating that same still-open search to show only
the SLSH account; the "No SLSH account found." empty state; the
Account-to-charge box's own independent search correctly finding and
selecting the SLSH account; and switching back to USD auto-clearing that
selection. Full suite (`npm run test:e2e` and `npm run test:migration`)
passing.

**Latest round (GLOBAL TABLE UX — Phase 1: Quotation row-click/detail +
dynamic Balance footers)** — a broad UX spec ("GLOBAL TABLE UX — QUOTATION
ROW CLICK + BALANCE FOOTER + DRAGGABLE & RESIZABLE COLUMNS") came in with
three parts. Given the size — a brand-new column drag/resize/persist/reset
framework touching ~16 tables on top of footers and the quotation detail
overhaul — the user was asked how to phase it and chose: **Phase 1 now**
(quotation row-click/detail + dynamic balance footers on the important
tables), **Phase 2 later, as its own round** (column drag-to-reorder,
drag-to-resize, per-user persisted layout, and Reset Columns). This round
is Phase 1 only — the column framework is **deliberately not started**,
not an oversight.

*Quotation row-click, corrected* — the previous round ("Row-click opens
Account Detail everywhere", below) sent a quotation row's click to Account
Detail. The new spec is explicit that a quotation row must open its own
**Quotation Detail** instead, matching every other table's "row click opens
this table's own record" convention — so that choice is now reversed:
- Clicking anywhere in a quotation row (except the account-name link and
  the action buttons, both already `stopPropagation`'d) opens **Quotation
  Detail** — the exact same view the **View** button opens, so both paths
  land on one identical record, never two different ones.
- The account name inside the row is now its own small button (with a `→`
  arrow, same pattern used elsewhere) that still jumps to **Account
  Detail** — a secondary, independent affordance, not the row's primary
  action, with its own `stopPropagation` so clicking it never also opens
  Quotation Detail underneath (no double navigation either way).
- The `title="Open account details"` tooltip is gone from every row across
  every module that had it (Exchange ledger, Accounts, Deactivated
  Accounts, Deposits & Withdrawals) — the spec calls for none, since a
  clickable row with a pointer cursor and hover highlight is signal enough
  on its own.

*Quotation Detail, filled out* — now shows every field the spec asks for:
Reference, Date, Valid Until, Account, Currency, Rate, Status, Created By /
Created Date, **Updated By / Updated Date** (new — see below), Note, the
full Items table, and a Subtotal → Discount → Tax → Total breakdown (in the
quotation's own charged currency, never mixing USD and SLSH lines
together). Update and Delete stay exactly where they were, gated by the
same permissions as before. Most of this was already coming back from the
API and only needed rendering; **Updated By/Updated Date genuinely needed
new state** — a quotation is never rewritten in place except through its
own PATCH endpoint, and nothing was recording who last touched it or when.
Added: `updated_by` / `updated_by_name` / `updated_at` columns on
`quotations` (via `ensureColumn` — additive, safe on every existing
install, verified by `test/migration.js`), set by `PATCH
/api/quotations/:id` on every edit and returned by `GET`. A never-edited
quotation shows a dash for both fields rather than a blank.

*Dynamic Balance/Summary footers* — a bold `<tfoot>` row was added to every
table the spec calls "important", each recalculated live from the
**currently filtered/displayed rows** (never a static, page-load-only
number), never counted as a real row (excluded from search, sort,
pagination and row-click), and never combining USD and SLSH into one
figure:
- **Money Exchange ledger** — Total row: given and received, each broken
  out by currency (`FootAmounts`, a small component that renders a USD
  line, a SLSH line, or both stacked in one cell — omitting a currency
  entirely rather than printing a misleading "$0.00" when there's no
  activity in it). Voided exchanges are excluded.
- **Quotations** (Pending/Paid/Refunded) — Total row reusing the module's
  existing USD/SLSH total calculation.
- **Accounts (USD/SLSH)** — Total balance for the currently-filtered list.
- **Deactivated Accounts** — Total balance, gated by **account count**, not
  by "is the sum non-zero" — a deactivated account's balance can be
  negative, so multiple accounts could net to exactly zero and still be
  real; hiding a currency's row must depend on whether any account in that
  currency exists, not on whether they happen to cancel out.
- **Deposits & Withdrawals** — the "Totals for this list" transactions tab
  already had summary stat cards from an earlier round; now also shows a
  running transaction count in that heading, plus an Amount footer row
  under the Deposit/Withdrawal columns. The Daily Transactions tab gained
  its own Net footer, computed straight from that day's filtered entries.
- **Transaction History** (USD/SLSH) — an In / Out / **Net** (bold) footer
  across every mixed record type (exchange, transfer, quotation leg, plain
  deposit/withdrawal), direction-aware per type (a withdrawal-shaped row
  counts as Out, a deposit-shaped row as In, an exchange's `amountGiven`
  as Out, a transfer's `amount` as Out from its source-account side).

*A real currency-mixing bug, found and fixed while building the History
footer* — a walk-in client (a name typed directly into an exchange or
quotation, never an existing account) is created on the fly by
`findOrCreateClient()`, which never took a currency argument and always
fell back to the `clients` table's schema default of `'USD'` — regardless
of whether the walk-in's own transaction was actually given in SLSH. That
mistagging fed straight into `GET /api/history`'s `accountCurrency` field
(used to sort a row onto the USD or SLSH Transaction History page), which
for an exchange row also trusted the client's static `currency` column
instead of the exchange's own `currency_given`. Net effect: a SLSH-given
walk-in exchange could show up on the **USD** Transaction History page and
get summed into its footer's Out total as if it were a USD figure — a
multi-million-SLSH number masquerading as dollars, a direct violation of
the "never combine USD and SLSH" rule this whole round exists to enforce.
Fixed at the root, in two places, plus a defensive guard:
- `findOrCreateClient()` now takes an optional currency hint and tags a
  freshly-created walk-in with the currency of the transaction that's
  creating it, instead of a blind default. Every call site now passes one
  (an exchange's `currencyGiven`, a quotation's intended charge currency).
  Existing clients are never touched — this only affects new ones.
- `GET /api/history`'s exchange branch now derives `accountCurrency` from
  the exchange's own `currency_given` column, never the client's static
  `currency` — which is always correct even for a real linked account,
  since account creation already enforces `fromAccount.currency ===
  currencyGiven`.
- The frontend's History footer reducer now also double-checks each row's
  own raw currency against the page's currency before folding it into the
  total, as a second, independent layer of protection.

Covered by 13 new `test/e2e.js` checks: the corrected row-click/View/
name-link behavior and full field set on Quotation Detail (including the
Updated-By/Date dash placeholder on a never-edited quotation, that same
field turning into a real name and date right after a PATCH edit, and the
"no leftover tooltip" check), a footer-presence-and-currency-separation
check for the Exchange ledger, Accounts, Deactivated Accounts, Quotations,
and Transaction History tables, and one dedicated regression check that
reproduces the currency-mixing bug exactly (creates a brand-new walk-in
client via a large SLSH exchange, then asserts the USD history's
exchange-row count and its footer text are byte-for-byte unchanged, and
that the same exchange correctly appears on the SLSH side instead) — plus
one pre-existing check updated for the Quotation Detail field renamed from
"Quotation Date" to "Date" (matching the spec's field list). The new
`quotations.updated_by`/`updated_by_name`/`updated_at` columns are added
via the same `ensureColumn` pattern (additive, safe on every existing
install) every other column in this codebase already uses, so no separate
`test/migration.js` scenario was needed for them specifically — they're
exercised end-to-end by the two e2e checks above instead. Full suite
(`npm run test:e2e` and `npm run test:migration`) passing — 226 e2e
checks, all green.

---

**Previous round (Row-click opens Account Detail everywhere)** — the
"click the account name to open Account Detail" pattern lived in only one
place (the Accounts module). This round extends full-row-click to every
other table that references an account:

- **Money Exchange ledger** — a row is clickable whenever its transaction
  is tied to a real account (`fromAccountId` set), not just typed as a
  free-text walk-in client; a walk-in row stays plain, non-clickable text.
- **Quotations** (Pending/Paid/Refunded) — a row is clickable whenever the
  quotation has a charged account (`chargedAccount`); every seeded/created
  quotation has one, since a quotation always charges a real account.
- **Deposits & Withdrawals**, both the per-currency "Transactions" list and
  the "Daily Transactions" tab — every row here is always account-linked
  (`accountId` is never null for a ledger entry), so every row is
  clickable.
- **Deactivated Accounts** — already had the click-the-name link from the
  earlier summary-strip round; now the whole row opens it too, matching
  every other table.
- **Accounts (USD/SLSH)** — already had a working name-link button but no
  row-level click; upgraded for consistency with the rest.

Two tables from the original "row-click-to-detail" idea were deliberately
left out:
- **Users & Roles** — a user is not an account; there's no "account view"
  to open for one.
- **Transfers** — there's no standalone Transfers list module. Transfers
  are created from an account's own Quick Actions and appear inside
  Transaction History and each account's own activity table, both of
  which already link back to the right account.

Where a row now opens Account Detail on click, every action button inside
that row (Update/Delete/Edit/Settle/View/Reactivate/Delete Account/PDF/
Duplicate/etc.) stops the click from bubbling to the row first, so using
those buttons still does exactly what it did before — it never also pops
open the Account Detail modal underneath.

Covered by 15 new `test/e2e.js` checks across the five affected modules:
one confirming the row itself opens Account Detail (clicking a cell that
isn't the name link), and a matching one confirming that clicking an
action button on the same row opens *that* button's own modal instead,
proving the stopPropagation guard actually holds. Also fixed several
pre-existing tests whose own custom test-account names (e.g. "Update Flow
Test Co", "Delete Flow Test Co") happened to contain the same word as a
nearby action button label ("Update", "Delete") — now that every row's
account name renders as a button too, an unscoped `button:has-text(...)`
selector could resolve to the wrong one, so those were tightened to be
unambiguous. Full suite (`npm run test:e2e` and `npm run test:migration`)
passing — 213 e2e checks, all green.

**Previous round (Summary strips on every table)** — the "Reports:
Staff activity fix + summary strips" round (below) added a stat-card strip
to the two Reports tabs that were missing one; this round finishes the
job everywhere else. Six tables that had no summary at all now do:

- **Money Exchange → Rate history** — Current rate / Highest recorded /
  Lowest recorded / Changes recorded.
- **Quotations** (Pending/Paid/Refunded — one shared module) — a count for
  the current status plus **Total (USD)** and **Total (SLSH)**, kept
  separate rather than added together, since a quotation can be charged in
  either currency and summing them would silently mix the two.
- **Accounts (USD/SLSH)** — this one already had a single "Total held"
  card wedged into the filter bar; it's now a full four-card strip
  (Accounts / Total held / Positive balance / In debt) matching the shape
  every other module's table uses.
- **Deactivated Accounts** — Deactivated accounts / USD accounts / SLSH
  accounts / In debt.
- **Transaction History (USD/SLSH)** — a type breakdown (Entries /
  Exchanges / Transfers / Quotation legs / Deposits & withdrawals) rather
  than a dollar total, which would be meaningless summed across record
  types that don't share a common "amount" shape (an exchange has a given
  *and* a received amount in two different currencies; a transfer has one
  amount; a quotation leg and a plain deposit/withdrawal each have their
  own). The type breakdown is the one number that's actually true across
  every row in this specifically *unified* table.
- **Users & Roles** — Total users / Active / Inactive / Never logged in.

Three tables were deliberately left as they were, not missed:
- **Money Exchange → Daily log / till** already shows its own opening-
  balance / closing-balance summary in the same two-box style it's had
  since that tab was built — a real summary, just not in stat-card form,
  and rebuilding it into cards for consistency alone risked regressing a
  working, already-reviewed layout for no functional gain.
- **Account Detail's own Transactions table** already has the fullest
  stat strip in the app (Current balance / Available balance / Total
  deposited / withdrawn / charges / exchanges / transfers / turnover) —
  deliberately positioned *below* the table, not above, per an explicit
  decision from an earlier round ("Account summary now appears AFTER the
  Transactions table").
- The small **line-item tables** inside a single quotation's View page and
  its New/Edit editor are a document's own line items, not a list of many
  records — that document's total is already shown as the "Amount" field
  right above the table, so a separate stat-card strip above it would just
  repeat the same number back in a different box.

Covered by 8 new `test/e2e.js` checks — one per new strip, opening each
tab/module and confirming its cards render with the right labels and, for
Deactivated Accounts and Transaction History, checking the shown counts
line up with what was just created in that same test run. Full suite
(`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (UNIFIED TRANSACTION HISTORY)** — Transaction History
becomes the single unified ledger for the whole system: every exchange,
transfer, quotation leg, and now plain deposit/withdrawal too (the one
bucket the report never surfaced before) shows up as one searchable,
filterable row, and clicking a row opens a **Detail view** instead of
acting on the table directly.

**Formatted reference numbers** — every record now carries a real,
permanent, sequential reference instead of a raw id fragment: `EX-YYYY-####`
for exchanges, `TR-YYYY-####` for transfers, `DEP-YYYY-####`/`WD-YYYY-####`
for plain deposits/withdrawals (quotation legs already had `QT-...`). Each
counter is generated the same MAX-based way as the existing quotation/
account-number generators — never `COUNT`-based — so a permanent delete
can never cause two records to collide on the same number later. Existing
data was backfilled in one migration pass, walking each table's rows in
`date ASC, id ASC` order and assigning sequential per-year numbers
retroactively, so historical records read exactly the way a number
assigned at creation time would have.

**Transfer: Void → permanent Delete, plus a new Update** — Transfer now
matches Exchange's own "no Void, permanent Delete only" model from an
earlier round: the old soft-cancel Void flow (`POST /api/transfers/:id/
void`, already unused by the frontend) is gone, replaced by `DELETE /api/
transfers/:id`, which reverses the real balance effect and removes the
transfer permanently — nothing "voided" is ever left sitting in the
database. A new `PATCH /api/transfers/:id` (Transfer Update) was added
alongside it, for the same parity Exchange already has between its own
Update and Delete. Both are gated behind new `transferUpdate`/
`transferDelete` permissions, granted to the same roles (admin/accountant)
as `exchangeUpdate`/`exchangeDelete`, since a transfer moves real money
immediately too and deserves the same risk tier.

**Row click → Detail view, not a duplicate set of forms** — every
Transaction History row's Update/Delete now lives inside a Detail modal
(opened by clicking anywhere on the row) rather than as inline table
buttons, and — deliberately — that Detail view does **not** reimplement
any record type's own mutation logic. Each entry carries a `raw` object
shaped exactly like that type's own existing API response, so the Detail
modal hands it straight to that type's own existing edit/delete component
(the same `AddTxModal`/`DeleteExchangeModal` Money Exchange already uses,
a newly-extended `TransferModal` edit mode plus a new
`DeleteTransferModal` for Transfers, and the existing
`EditLedgerEntryModal`/`DeleteLedgerEntryModal` for plain deposits/
withdrawals) — never a second, parallel implementation of the same form. A
quotation leg gets neither button: settlement (Pay/Refund) is a
specialized two-outcome flow that belongs entirely to the Quotations
module, so its Detail view instead offers a single **"Open in
Quotations"** link that jumps straight to the quotation's own
Pending/Paid/Refunded tab. Every button still respects that record type's
own existing permission — there is no new blanket "can edit history"
permission that would bypass a module's own gate — and a legacy Void'd
transfer or exchange shows neither button at all, with an explanation
banner instead.

Because this app has no client-side routing anywhere (every screen is
in-memory React state), the Detail view is a modal, matching the existing
Account Detail pattern, rather than a real deep-linkable URL — clicking an
account name inside it opens Account Detail on top, reusing the same
"stacked modal" chain that view already uses elsewhere.

New filters: **Status** (active/voided for exchanges & transfers, pending/
paid/refunded for quotation legs) and **Staff**, alongside the existing
type tabs (now including **Deposits** and **Withdrawals** as their own
tabs) and free-text search, which now also matches the staff/creator name
and notes, not just the reference and account name.

Covered by ~35 new `test/e2e.js` checks: a Transfer's formatted reference,
Detail-view Update (amount change reflected in the list) and permanent
Delete; a plain deposit's Detail-view Update and Delete (located by its own
freshly-generated `DEP-YYYY-####` reference rather than by account name, to
stay correct regardless of how many other rows that same test account
already has from earlier tests); a quotation leg's Detail view showing zero
Update/Delete buttons and only "Open in Quotations," which correctly
navigates to that quotation's status tab; and a permission-gating check
confirming a viewer-role user (no mutation permissions) sees no Update/
Delete buttons on any row's Detail view, regardless of record type. Full
suite (`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (Reports: Staff activity fix + summary strips)** — two
things reported together: the **Staff activity** report tab, and a request
for a summary strip above "the important tables in the system."

Root cause of the Staff activity report: it was **never actually broken in
the code** — the backend route, the aggregation logic, the CSV/PDF export,
all ran cleanly, even re-tested directly against a live copy of the
production database. What *was* wrong: the running server process on the
deployed machine hadn't been restarted since **4 days before** this round
(its own log had a single startup line from days earlier, while the
database's write-ahead log showed activity minutes old — proof the process
never restarted even though its own database kept moving). Static files
(the frontend bundle) are read fresh from disk on every request, so UI
changes from every round so far *appeared* to take effect immediately —
but every backend-side change (routes, permissions, business logic) only
takes effect on the *next server restart*, since Node caches `require()`d
route modules in memory for the life of the process. A brand-new frontend
tab calling a backend route that only exists in a process that was never
restarted to pick it up is exactly what "the button gives an error" looks
like. **Restarting the server after every backend-touching delivery is now
essential** — this was flagged directly to whoever operates the server.

Also newly covered by `test/e2e.js`, closing a real gap: the Staff activity
tab had **zero** test coverage before this round (only the general
"Reports load" check ever ran, which never actually opened it) — exactly
the kind of gap that lets a regression like this go unnoticed. It's now
opened directly and checked for a clean render with no uncaught JS error or
5xx response.

Separately, added a **summary strip** (stat cards at the top of the table)
to the two Reports tabs that were missing one — Staff activity (Staff
active / Transactions / Total volume / Total profit) and Audit log
(Entries shown / Unique actors / Actions today / Most recent) — bringing
them in line with Exchange summary, Quotation report, and Currency
position, which already had one. Audit log's "Entries shown" stat notes
when it's capped at the API's 500-row limit, so it's never misread as a
full historical count.

**Previous round (EXCHANGE UPDATE)** — added the **Update** action next to
Delete on every active Money Exchange transaction, closing the gap left by
the previous round: that round shipped Delete but nothing for `[ Update ]`,
the other action the spec calls for alongside it.

Because every exchange posts its financial effect immediately (no separate
"Accepted" step exists in this app — see the Delete round below for the
same observation about this app's data model), simply rewriting an already-
posted exchange's row would leave its *old* ledger effect sitting there
alongside a mismatched new one. So Update is built the same way Delete's
reversal is: `PATCH /api/transactions/:id` (behind a new `exchangeUpdate`
permission — same grantees as `exchangeDelete`, admin/accountant, not the
broader `exchangeCreate` set) runs inside one database transaction that
first deletes this exchange's own tagged `account_ledger` rows and rebuilds
the OLD account(s) from what's left — undoing the old effect exactly like
Delete does — then writes the edited fields onto the *same*
`exchange_transactions` row (same id throughout; it's never deleted and
recreated) and re-posts fresh ledger rows, still tagged back to that same
exchange id, against whichever account(s) the edited form now points at
(the account pair can even be changed entirely, not just the amounts) and
rebuilds those. A transaction already voided under the old system is
rejected with a 400, for the identical reason Delete rejects one: its old
reversal entry isn't tagged, so there's no reliable "old effect" to undo
first.

On the frontend, the existing "New exchange transaction" modal now doubles
as "Edit exchange transaction" when opened via Update: same fields and
layout, pre-filled from the record being edited (including re-fetching and
re-showing its linked FROM/TO account cards, if any), posting to `PATCH`
instead of `POST`. The Cancel/submit buttons are disabled while a save is
in flight, the same double-submit guard `DeleteExchangeModal` already used.

Covered by new `test/e2e.js` checks, run against their own throwaway,
isolated linked USD/SLSH account pair (independent of every other fixture
in the suite): Update opens pre-filled with the existing amount and the
account cards; Cancel leaves the transaction untouched; saving a changed
amount updates both linked accounts' balances to reflect *only* the new
amount (proving the old ledger rows were actually reversed, not left in
place alongside the new ones); and a direct API call confirming a Cashier
(`exchangeCreate` yes, `exchangeUpdate` no) is blocked with 403. Full suite
(`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (EXCHANGE DELETE — PERMANENT FULL DATA DELETION)** — "Void"
is gone completely from the Money Exchange module: no Void button, no
Voided status option in the filter, no `void`/`voided` wording left
anywhere a user can see it. In its place, every active exchange transaction
now gets a real, permanent **Delete**.

The old Void flow was a soft-cancel: it marked the row `status='voided'`
and inserted a *new*, separate reversal ledger entry to net the balance
back out, while the original transaction row and its original ledger
entries stayed in the database forever. Delete is different in kind, not
just in name: `DELETE /api/transactions/:id` (behind a new `exchangeDelete`
permission — same grantees as the old `exchangeVoid`, admin/accountant)
deletes the exchange's own `account_ledger` rows outright (identified
precisely by `source_type='exchange'` + `source_id`, never by account, date
or amount — so it's impossible to catch an unrelated deposit, withdrawal,
transfer, or other exchange in the same account's history) and *then*
rebuilds both affected accounts' balances from whatever ledger rows are
left. That rebuild is what "reverses the financial effect" — there's no
separate offsetting entry created or left behind, because the entries that
caused the effect are simply gone. Only then is the `exchange_transactions`
row itself deleted. All of it runs inside one database transaction
(BEGIN/COMMIT/ROLLBACK), with the row re-read and re-checked *inside* that
transaction — so two near-simultaneous delete clicks can't both succeed,
double-reverse a balance, or leave a partial delete on a mid-way failure;
the second one just gets a clean 404 against a row that's already gone.

A transaction already voided under the old system is deliberately excluded
from this new flow (rejected with a 400): its balance was already reversed
once, via an *untagged* reversal entry with no `source_id` link back to the
original transaction, so there's no reliable way to find and remove that
reversal alongside the original — attempting it would delete only half the
pair and leave the balance permanently off by the transaction's amount. The
handful of already-voided transactions from before this update stay
exactly as they are (visible under "All", just without a dedicated filter
option any more) — nothing about existing accounts, balances, deposits,
withdrawals, transfers, quotations, or Transaction History was touched.

Also scoped and deliberately left out: the spec's own mockups describe a
Pending → Accept/Reject approval workflow (with a dedicated Exchange Detail
page) that doesn't exist anywhere in this app today — every exchange has
always taken financial effect the instant it's created, with only
`active`/`voided` as states. Building that workflow would be a much larger,
separate change; this round maps the spec's "ACCEPTED" case onto the
existing `active` status (Delete reverses it) and its "PENDING"/"REJECTED"
cases don't arise (nothing is ever created in a not-yet-effective state to
begin with), which is what the spec's own repeated emphasis — this is
entirely about *deletion*, not approval — calls for.

Covered by new `test/e2e.js` checks, run against a fresh, isolated,
throwaway linked USD/SLSH account pair (built via direct API calls, kept
independent of the Hodan Hotel pair earlier tests already depend on): no
"Void" button or filter option anywhere in the module; the confirmation
modal's exact title, fields, and Cancel/Delete Permanently buttons; Cancel
leaving the transaction untouched; Delete Permanently reversing both linked
accounts' balances back to their exact pre-exchange values *and* removing
the row completely (not just marking it Voided); a direct API call
confirming a Cashier (`exchangeCreate` yes, `exchangeDelete` no) is blocked
with 403; and a direct double-delete confirming the second call fails
cleanly with 404 rather than double-reversing anything. Full suite
(`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (Pay + Refund merged into one Settle action)** — the
Quotations list used to show two separate buttons, **Pay** and **Refund**,
for a `Pending` quotation. On the ledger they always did the *exact same
thing*: post a Deposit for the same amount back to the same account,
restoring its balance — only the notes text (`"Quotation Paid — {number}"`
vs `"Refund — quotation charge reversed"`), the `source_type` tag
(`quotation_paid` vs `quotation_refund`), and the resulting status (`Paid`
vs `Refunded`) ever differed. Since that distinction still carries real
business meaning downstream — `Paid` means the customer actually paid
(counted as revenue in the Quotation report and the Dashboard's Quotation
pipeline chart), `Refunded` means the quotation was voided (no revenue) —
the two statuses, and their separate `POST /api/quotations/:id/pay` and
`POST /api/quotations/:id/refund-charge` endpoints, were deliberately kept
exactly as they were; only the **UI** was simplified. A single **Settle**
button now opens one confirmation modal with a Paid/Refunded toggle
(`Paid` pre-selected, each option labeled with what it means — "Customer
paid — counted as revenue" / "Quotation voided — no revenue") and a single
Cancel / confirm (**Mark Paid** or **Refund**, depending on the toggle) —
replacing the old separate buttons (Pay used a plain browser `confirm()`
popup; Refund had its own single-purpose modal). Covered by rewritten
`test/e2e.js` checks: a Pending quotation shows exactly one Settle button
(no separate Pay/Refund), settling via the default Paid choice behaves
exactly as the old Pay button did (Deposit posted, balance restored, status
Paid), settling via the Refunded toggle behaves exactly as the old Refund
button did, and double-settlement is still prevented (no Settle button once
a quotation is Paid or Refunded). Full suite
(`npm run test:e2e` and `npm run test:migration`) passing.

**Previous round (Quotation permanent delete)** — a **Delete** action for
quotations, gated by a new, stricter `quotationsDelete` permission that sits
on top of the existing `quotationsManage` (a role that can create/pay/
refund/duplicate quotations is not automatically trusted to permanently
delete one — mirrors the existing `accountsManage`/`accountsDelete`
two-tier pattern; only Admin and Manager have it by default). Delete is
still only ever offered once a quotation is settled (Paid or Refunded) —
exactly the same financial-safety rule the system already enforced (a
Pending quotation always has a real, outstanding Withdrawal against it, so
it must be settled with Pay or Refund first; there's no "no financial
impact" quotation state to freely delete once one has been created, since
every quotation charges an account the instant it's saved). Clicking
Delete now opens a proper confirmation modal (replacing the old browser
`confirm()` popup) showing the quotation number, account, amount, and
quotation date, an explicit "this cannot be undone" warning, an optional
reason dropdown (Created by mistake / Duplicate quotation / Customer no
longer needs it / Incorrect information / Other, with a free-text field for
Other), and Cancel / **Delete Permanently** buttons. Deleting removes the
quotation document and its line items only — the real `account_ledger`
rows it produced (the original charge, and its Paid/Refunded settlement)
are never touched and stay permanently visible, falling back to standalone
display via their `reference_number` once the parent quotation is gone
(unchanged from the original two-step-ledger design below). A pre-deletion
audit-log entry records the quotation number, account, customer, amount,
previous status, and reason. Note: an earlier version of this project's own
"QUOTATION DELETE SYSTEM" request text asked to remove the Refund/Refunded
status entirely in favor of an "Expired" status — that was **not** applied;
Refund/Refunded stays exactly as built (core to the two-step-ledger design
below) and Delete was layered on top of it for Paid/Refunded quotations
specifically, per an explicit choice made when the conflict was raised.
Covered by new `test/e2e.js` checks: a direct-API check that a Sales-role
user (who has `quotationsManage` but not `quotationsDelete`) is blocked
with 403 and the quotation survives; the confirmation modal shows the
right fields and warning; and confirming Delete Permanently removes the
document while both ledger legs still show up, unchanged, in the account's
transaction history. Full suite (`npm run test:e2e` and
`npm run test:migration`) passing.

**Previous round (Transaction table date + numbering standardization)** —
every table that lists individual ledger transactions now shows a
**date-only** Date column (the time-of-day is hidden from the cell — e.g.
"18 Sept 2026" instead of "18 Sept 2026, 15:05") and leads with a new
**`#`** column giving each currently-displayed row a simple 1, 2, 3…
position, newest first. Applied to: the Money Exchange ledger, an
account's own unified Transactions table (`AccountDetailModal`), the
standalone Deposits & Withdrawals tables (both the filtered list and the
single-day drill-down — which gained its own sortable Date column and `#`,
replacing its old time-only column), and Global/USD/SLSH Transaction
History. The `#` is purely a display position, recomputed from whatever
rows are currently sorted/filtered/searched — it is never the record's
real ID/reference, and clicking a different sort column, changing a
filter, or searching renumbers it automatically for free, since it's just
the row's index in the already-reactive sorted array. The full,
millisecond-precision timestamp is untouched in the database and is still
exactly what every sort (including breaking ties between same-day
transactions) is computed against — only the table cell's rendering was
changed, via a `fmtDate()` swap in place of `fmtDateTime()`, not the
underlying `date`/`createdAt` fields or any sort key. Aggregate/summary
tables that don't list individual transactions (daily totals in Reports,
staff activity, the audit log, exchange-rate history) were deliberately
left untouched, since a display-order `#` and a redundant same-day Date
column don't add anything there. Covered by two new `test/e2e.js` checks
(the `#` column starts at 1 for the newest row, and the Date cell contains
no `HH:MM` pattern) alongside the full existing suite (`npm run test:e2e`
and `npm run test:migration`), both passing.

**Previous round (Quotation Two-Step Account Ledger Logic)** — a full rework
of how a quotation touches money, replacing the old Draft → Sent →
Accepted/Rejected/Expired/Cancelled workflow and its separate manual
"Charge Account" step entirely:

- **Every quotation now posts a real Withdrawal the instant it's created**
  — chosen via a new, required **"Account to charge"** field on the
  creation form (independent of, but defaulted from, the linked client
  account) — rather than staying a paperwork-only Draft until someone later
  approves and manually charges it. There is no more pre-charge stage.
- **The status model is now Pending → Paid/Refunded**, full stop. A
  quotation settles exactly once, ever, one way or the other: **Pay**
  posts a settlement Deposit ("Quotation Paid — {number}") and **Refund**
  posts one ("Refund — quotation charge reversed"); both credit the money
  straight back to the account that was originally charged. Both endpoints
  reject outright if the quotation isn't still `Pending` — no double-charge,
  no double-settlement, checked server-side, not just hidden in the UI.
- **Both ledger legs are permanent** — the original Withdrawal is never
  deleted, replaced, or hidden once the settlement Deposit exists; they stay
  linked by the quotation's own reference number, each with its own unique
  ledger ID, forever. A new denormalized `account_ledger.reference_number`
  column stores that reference directly on each ledger row (populated at
  every insert site, with a one-time backfill migration for pre-existing
  rows), so a quotation **document** can be deleted once settled (removing
  it from the working list) while both its ledger legs keep showing their
  correct reference in the account's own Transactions table and in Global
  Transaction History — no fragile join to a row that may no longer exist.
- **Once created, a quotation's financial fields are locked** — client,
  items, rate, discount/tax, and charged account can never be edited after
  the Withdrawal has posted against them (only contact, address,
  valid-until, and notes stay editable); duplicate it to issue a revised
  version, which charges its own fresh Withdrawal.
- **UI**: the Quotations module is one unified, filterable table now (no
  more separate Invoices section); a "Charge Test/Reject/Cancel" flow and
  its modal are gone; `AccountDetailModal`'s Transactions table shows a
  quotation's two legs as plain Deposit/Withdrawal rows with a
  Pending/Paid/Refunded status pill (no dedicated "Quotations" type filter
  or Mark-paid button there anymore — that lives in the Quotations module);
  `TransactionHistoryModule` labels the two legs "Quotation Charge" /
  "Quotation Settlement" under a single "Quotations" filter.
- **Migration safety**: a database created fresh (via `schema.sql`) already
  has the new `Pending/Paid/Refunded` status constraint and the
  `reference_number` column from day one. An *existing* installation is
  upgraded in place on next startup — its `quotations` status constraint is
  widened, and any already-Paid quotation from the old workflow that never
  got a real settlement Deposit (because "Mark Paid" used to just flip a
  flag) has one synthesized for it automatically, restoring its account
  balance to what it should have been all along. Fixed one critical bug in
  the process: the first migration step was guarded only by checking for the
  *old* constraint text, which meant it wrongly re-fired against a brand-new
  database (whose fresh-install constraint also doesn't mention the old
  marker) and crashed on the first status write — the guard now also checks
  for the newest constraint text before deciding a migration is needed.
- Covered by a rewritten `test/migration.js` (seeds a realistic legacy
  database, strips a Paid quotation's settlement Deposit and rolls the
  schema back to a real pre-existing installation's shape, boots the server
  exactly as `npm start` would, and confirms the missing Deposit is
  synthesized correctly while an already-correct Refunded quotation is
  *not* double-synthesized) and an extensively updated `test/e2e.js`
  (immediate-withdrawal-on-save, the required-account validation, the
  locked edit view, Pay/Refund/double-settlement prevention, Delete
  requiring settlement first, and both ledger legs surviving a deleted
  quotation document in both the account view and Transaction History) —
  all passing alongside the full existing suite (`npm run test:e2e` and
  `npm run test:migration`).

**Previous round (quotation Delete / Refund-as-Paid / Invoices section)** —
added `DELETE /api/quotations/:id` (Cancelled-or-refunded only, real ledger
history is never deleted); changed `refund-charge` to mark the quotation
**Paid** instead of clearing it, since a refund is real money paid back out;
tagged the refund's ledger entry (`quotation_refund`) so it surfaces in
Transaction History as its own record; and added an **Invoices** section
at the bottom of the Quotations page that Paid quotations move into
automatically. The account activity-feed fold logic (`accounts.js`) was
also hardened so a charge/exchange ledger row only folds into its parent
row while that parent still exists — a deleted quotation's charge/refund
ledger entries fall back to their own standalone row instead of vanishing.
Covered by new checks in `test/e2e.js` (Delete after Cancel, Delete after
refund, the Paid relabeling, the Invoices section, and the refund showing
up in Transaction History) — all passing alongside the full existing suite.

**Latest round (Account Management + Financial Logic + Settings)** — four
things, all preserving existing behavior/APIs/permissions/navigation
elsewhere:

- **Uppercase personal names** — a single, centralized `formatPersonName()`
  (mirrored in `src/util.js` on the backend and `app.jsx` on the frontend)
  uppercases and normalizes whitespace for every *person*-type name field:
  account holder/customer names, contact person, and employee/user names.
  It's deliberately **never** applied to company names, product names,
  emails, usernames, addresses, or notes — those keep whatever casing was
  typed. Existing data was migrated in place on first startup (an idempotent,
  re-run-safe pass in `src/db.js`), and search stays fully case-insensitive.
- **Debt policy, extended to Transfer** — the existing "accounts can go
  negative" policy (deposits, withdrawals, exchanges, quotation charges
  never block for insufficient funds) now also covers the new Transfer
  feature — a transfer out of an account is never blocked by its balance.
- **Quick Actions + Transfer** — the account detail page gained Deposit /
  Withdraw / Transfer / Exchange / Edit Account buttons, all reusing the
  exact same modals and backend endpoints as their standalone modules
  (just pre-scoped to that account, no re-searching needed). **Transfer**
  is a new feature: same-currency money movement between two *different*
  accounts (`src/routes/transfers.js`, a new `transfers` table), distinct
  from Exchange, which is always a USD↔SLSH conversion for one client. A
  transfer produces two tagged ledger entries (a withdrawal on the source,
  a deposit on the destination) that fold into one row in each account's
  activity feed, and it appears in Transaction History as its own record
  type, alongside Deposit/Withdrawal/Quotation Charge/Exchange/Refund.
- **Account lifecycle: Deactivate / Reactivate / Permanently Delete** — a
  new subsystem in `src/routes/accounts.js`. **Deactivate** (optional
  reason) blocks all *new* financial transactions on that account — enforced
  server-side in every money-moving endpoint (deposit/withdraw, exchange,
  quotation charge, transfer), not just hidden in the UI — while leaving its
  balance and full history untouched. **Reactivate** restores it instantly.
  **Permanently Delete** is only reachable from a deactivated account,
  requires typing the account's exact name to confirm, and is gated behind
  a new `accountsDelete` permission (admin/manager only, checked server-side
  in `src/rbac.js`). It is always a **soft delete** (`deleted_at`/`deleted_by`
  columns) — never a real `DELETE` — so `account_ledger`, `exchange_transactions`,
  `quotations`, and `transfers` rows that reference the account are never
  orphaned; deleting an *active* account is rejected outright. A new
  **Deactivated Accounts** page lives under **Settings** (moved out from
  under Account, per the updated sidebar structure) listing every
  deactivated account with its reason, who deactivated it, and when, plus
  View/Reactivate/Delete actions.

All four are covered by new checks in `test/e2e.js`: uppercase-vs-preserved
casing (customer vs. company), the full deactivate → blocked-transaction →
reactivate → delete-requires-exact-name lifecycle (both through the UI and
via direct API calls confirming the server-side 400s), Quick Actions being
present and functional, and an end-to-end Transfer between two accounts —
all passing alongside the full existing suite (`npm run test:e2e`) and
`npm run test:migration`.

**Earlier round (SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT SYSTEM
— Phase 1: dynamic RBAC foundation)** — a from-scratch rebuild of the
permission system's *foundation*, done deliberately in three phases so a
system this security-sensitive is never mid-migration for long: **Phase 1**
is the database + backend engine, with the UI staying byte-for-byte the
same; **Phase 2** (Role & User Management screens — see the round below;
now built) lets a Super Admin actually build custom roles and assign
granular permissions through the UI instead of the Roles API directly;
**Phase 3** (below) rewires the existing sidebar/buttons/dashboard to check
the new granular permissions directly. Nothing in Phase 1 itself changed
what anyone saw or could do — it was the real architecture both Phase 2 and
Phase 3 are built on.

1. **A real, granular permission catalog** (`src/permissions.js`) — every
   module the app actually has (Accounts, Exchange, Transfers, Quotations,
   Deposits & Withdrawals, Reports, Audit Log, Settings, Users, Roles)
   crossed with every real action it supports (`view`, `create`, `update`,
   `delete`, `deactivate`, `activate`, `export`, `print`, plus module-
   specific ones like `exchange.manageRate` and `quotations.settle`) —
   over 50 distinct `module.action` keys in total, every one of them a real
   capability somewhere in this codebase, not a generic template.

2. **Dynamic roles, stored for real** — three new tables
   (`roles` / `role_permissions` / `user_permission_overrides`) replace the
   old hard-coded, six-role `PERMS` object in `src/rbac.js` as the actual
   source of truth. The 6 original roles were migrated in as real rows with
   their exact original grants translated into the new granular keys (see
   point 3), plus a permanent, protected **Super Admin** role
   (`is_super_admin=1`) with no stored permission rows at all — it's an
   unconditional code-level bypass (`src/rbac.js`), checked *before* any
   permission-table lookup, so it can never be restricted even if
   `role_permissions` data were somehow missing or corrupted. A brand-new,
   separate **Super Admin account** (`super.admin` — see "Super Admin"
   under Quick Start for credentials) is created automatically on first
   boot; the existing Admin account and role are untouched and become an
   ordinary (if still extensive) Super-Admin-configurable Admin, exactly as
   the spec's "SUPER ADMIN cusub oo gooni ah" choice asked for. The old
   `users.role` column is kept, completely unchanged (same CHECK
   constraint, same six legal values) as a best-effort legacy label,
   alongside a new authoritative `users.role_id` — rewriting `role`'s
   constraint was deliberately avoided given how many other tables carry a
   real foreign key to `users.id`.

3. **Zero-visible-change legacy compatibility shim.** The 50+ backend call
   sites (`requirePerm(user, res, "accountsManage")`, etc.) and the
   frontend's own duplicated permission table were **not** touched this
   round — they keep checking exactly the same old coarse key names they
   always did. A `LEGACY_KEY_MAP` in `src/permissions.js` translates each
   old key into the *set* of granular keys that must **all** be granted for
   it to resolve true, so swapping the engine underneath (static object →
   dynamic, DB-backed roles) changes nothing about who can do what today.
   Building this map meant auditing every real `requirePerm`/`can()` call
   site against what its flag's *name* implied versus what it actually
   gated — and that audit caught real, pre-existing surprises worth noting:
   `accountsManage` (not a `transfers`-specific flag) is what actually
   gates creating a Transfer, editing/deleting a plain deposit or
   withdrawal, and — together with `reports`, via an OR the map reproduces
   by listing the same granular view keys under both legacy flags — viewing
   the account ledger at all; and `quotationsApprove` turned out to be a
   pure **view**-level flag in the real app (it only ever unlocks the
   Quotations sidebar tabs for a role like Manager) — the actual Settle/
   Pay/Refund actions have only ever checked `quotationsManage`, despite
   the flag's name. The map documents each of these with the exact route
   file and line that proves it, not just the flag's name.

4. **Dynamic permission engine** (`src/rbac.js`, fully rewritten). `can(user, key)`
   now takes the resolved user (role bypass, then role grants, then
   per-user overrides layered on top — a `granted:1` override adds a
   permission beyond the role, `granted:0` explicitly denies one the role
   would otherwise allow) instead of a bare role string; an unrecognized
   key always fails closed, never silently allows. New exported guards —
   `assertCanManageUser` (only a Super Admin may touch another Super
   Admin's account at all, and the last remaining active Super Admin can
   never be stripped of that status by anyone, including another Super
   Admin) and `assertRoleMutable` (a protected role can't be renamed or
   deleted; the Super Admin role additionally refuses *any* edit, including
   to permissions, since it has none stored to edit — but Admin's
   permission *set*, unlike its existence, stays fully editable by a Super
   Admin) — back the Roles and Users APIs below.

5. **Session Security** — a JWT now carries a `rolePermVer`/`userPermVer`
   snapshot taken at login (`roles.permissions_version` /
   `users.permissions_version`, each bumped whenever that role's grants or
   that user's own role/overrides change). Every authenticated request
   compares the token's snapshot against the live values and rejects
   (`401`, forcing a fresh login) the instant either has moved — so editing
   a role's permissions, reassigning someone's role, or changing their
   custom overrides takes effect on that person's very next request, not
   whenever their token would have naturally expired. Deactivation was
   already immediate via the existing `active` check; this closes the
   "permissions changed while still logged in" gap specifically. (Every
   session issued before this round lacks these claims entirely and is
   treated as stale — expect one unavoidable one-time re-login after
   upgrading.)

6. **Roles + Permissions REST API** and **Users API rewrite** — see the API
   reference above for the full endpoint list. Users gained a real
   `DELETE` (soft, typed-confirmation, mirroring the existing Accounts
   pattern) and a proper three-state `status` (`active`/`deactivated`/
   `suspended`) alongside the original boolean `active`, kept in sync
   without ever recomputing one from the other on an unrelated edit — a
   real regression caught and fixed during this round (a plain name-only
   `PATCH` was, at one point mid-development, silently flipping a
   previously-deactivated user back to active).

7. **`test/rbac.js`** — a new dedicated suite (`npm run test:rbac`),
   direct-engine checks (Super Admin bypass, the legacy AND-semantics
   shim, deny overrides, the fallback for a user with no `role_id` yet,
   every protection guard including the last-Super-Admin rule) plus a real
   HTTP pass against the actual server (session revalidation kicking a
   stale token, the full Roles/Users API lifecycle, every guard reachable
   over HTTP) — run alongside the full existing `test:e2e` (226+ checks,
   confirming the current UI is provably unaffected) and `test:migration`
   suites, all passing.

8. **Startup crash fixed on real, pre-existing databases.** `schema.sql`
   had briefly shipped a `CREATE INDEX ... ON users(role_id)` statement
   inside its own single `db.exec()` batch — harmless against a brand-new
   database (created fresh, with `role_id` from the start), but fatal
   (`Error: no such column: role_id`) against any real installation's
   database, where `CREATE TABLE IF NOT EXISTS users` is a no-op against
   the *old* table shape and that index statement ran before `db.js`'s own
   `ensureColumn("users", "role_id", ...)` — which runs later, correctly,
   and already creates this exact index right after — ever got a chance to
   add the column. Fixed by removing the redundant, unsafely-placed
   statement from `schema.sql`. `test/migration.js` gained a new scenario,
   `testRbacPreExistingUsersTable`, that rolls a seeded database's `users`
   table all the way back to its pre-this-round shape (no `role_id`/
   `status`/`permissions_version`/`deleted_at`/`deleted_by`, no `roles`/
   `role_permissions`/`user_permission_overrides` tables at all) and boots
   the real server against it — reproducing the exact crash before the fix,
   passing cleanly after — so this class of "works on a fresh database,
   crashes on a real one" regression can't ship silently again.

**This round (SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT SYSTEM —
Phase 3: full UI enforcement).** Rewires the *existing* sidebar, buttons and
dashboard widgets in `frontend/app.jsx` to the real, DB-backed granular
permission engine Phase 1 built — nothing added or moved visually, and every
one of the ~59 call sites that decide whether a menu item or button shows up
still checks the exact same old coarse key names (`accountsManage`,
`reports`, `quotationsManage`, etc.) they always did. What changed is *where
the answer comes from*:

1. **The frontend's own hard-coded `PERMS` table is gone.** Previously,
   `app.jsx` carried a second, independent copy of "what each of the 6
   legacy roles can do" — a static object that could never reflect a real
   permission change made through the Roles API, and had no concept of
   Super Admin at all (a Super Admin login would have been treated as a
   plain "admin" role client-side). It's replaced by a single `user.perms`
   object the **server** computes and hands over on every login and
   `GET /api/auth/me` call.

2. **New: `resolvedPermsPayload(user)`** (`src/rbac.js`) — the one function
   that turns a resolved user into what the frontend needs: `perms` (all 15
   legacy key names, each resolved through the exact same
   `resolveUserPermissions` + `LEGACY_KEY_MAP` engine every backend route
   already enforces with — including the Super Admin `ALL_ACCESS` bypass
   and any per-user override), `isSuperAdmin`, and `roleLabel` (the real
   role's display name — `"Super Admin"` for the Super Admin account, not
   the legacy `"Admin"` label its `users.role` column still carries for
   `CHECK`-constraint compatibility). `routes/auth.js`'s `publicUser()` —
   shared by login, `GET /api/auth/me`, and the Users API's own responses —
   now calls it, so a permission or role change a Super Admin makes through
   the Roles API is reflected in the UI the moment the affected user's
   session next revalidates (already immediate per point 5 above), not
   just in what the backend *would* have rejected anyway.

3. **`app.jsx` changes are surgical.** `const perm = (key) => can(user.role, key)`
   (reading the static table) becomes `const perm = (key) => !!(user.perms || {})[key]`
   (reading the server's resolved snapshot) — one line. The ~59
   `perm("...")` call sites gating every sidebar entry, sub-menu, and
   action button across Accounts, Exchange, Transfers, Quotations,
   Deposits & Withdrawals, Reports, Users, and Settings needed **zero**
   changes, since they already only ever called `perm(key)` with the same
   legacy key names `resolvedPermsPayload` still speaks. The three spots
   that displayed a user's role (`ROLE_LABELS[user.role]`, in the profile
   menu and the dashboard welcome banner) now prefer the server's
   `user.roleLabel`, so a Super Admin correctly shows **"Super Admin"**
   instead of "Admin" — falling back to the old static `ROLE_LABELS` table
   only for genuinely legacy display cases (the "New User" role picker and
   historical Audit Log rows, both unchanged, still Phase 2 territory).

4. **Backend enforcement is provably unchanged** — this round touched zero
   `requirePerm`/`can()` call sites in `routes/*.js`. Cross-checked: every
   key `requirePerm` actually calls across the codebase is a subset of the
   15 keys `resolvedPermsPayload` resolves (built from the same
   `LEGACY_KEY_MAP`, by construction they can't drift), plus `exchangeAll`
   (checked directly via `can()` in `routes/transactions.js`, to scope a
   list rather than gate a whole request) and `quotationsApprove` (a real
   flag with no server-side gate at all — confirmed to be a pure
   view-level, sidebar-only flag, exactly as Phase 1's audit found).

5. **New Playwright coverage**, `test/e2e.js`: logs in as the real
   `super.admin` account and confirms the sidebar shows **every** module
   (Accounts, Payment, Exchange, Quotations, Transaction History, Reports,
   Users & Roles, Settings) unconditionally, that the profile menu shows
   "Super Admin" rather than "Admin", and that a module is actually usable
   (not just visible) — end-to-end proof the `ALL_ACCESS` bypass reaches
   all the way from the database through to what renders, not just
   verified at the API level (`test/rbac.js` already covered that).
   `npm run test:rbac`, `npm run test:e2e` (231+ checks now), and
   `npm run test:migration` all pass.

6. **Explicitly out of scope for this round** (per the person's own
   3-phase choice — Phase 2 not started without a separate go-ahead): no
   Role Management UI, no per-role/per-user granular-permission editing
   screen, and none of the brand-new customization systems described in
   the fuller "SUPER ADMIN — FULL SYSTEM CONTROL & MASTER ACCESS" spec that
   don't exist in this app today at all (a visual PDF template editor,
   per-table column customization, an Appearance/Branding theming system,
   an expanded System Overview dashboard) — each of those is its own
   separate project and needs its own scoping conversation before work
   starts on it. **Phase 2 itself is now built — see the round below.**

**Latest round (ULTIMATE USER ROLES & PERMISSIONS MANAGEMENT SYSTEM — Phase
2: Role & User Management screens).** The previously-deferred phase from the
Super Admin round above: a full Role Management UI on top of the exact same
`roles` / `role_permissions` / `user_permission_overrides` engine every
backend route already enforced with (Phase 1), plus a per-user
direct-permission-override panel. Scope was stated up front (the person had
already signalled "no preference" on detailed scoping once before, so this
round proceeded on reasonable engineering judgment rather than blocking on a
second round of questions) and these boundaries were kept throughout:
**single role per user** (no "Additional Roles" / multi-role — the existing
`role_id` FK architecture stays), **no currency-level (USD/SLSH) permission
dimension** (would need a materially different backend model), and **no
PDF-Template-level or Dashboard-Widget-level granular permissions** (those
features don't exist anywhere in the app yet to gate).

1. **Roles gain real lifecycle fields.** `roles.status` (`active` /
   `inactive`, via `ensureColumn` — safe on a database that already has a
   `roles` table from the Phase 1 round) and role JSON now reports
   `permissionCount` (`null` for Super Admin, meaning "all") and the
   existing `userCount`. An **inactive role can never be newly assigned** —
   enforced server-side in both `POST /api/users` and `PATCH /api/users/:id`
   (`routes/users.js`) — but a user already holding one when it's
   deactivated is left completely alone, never silently stripped.

2. **Role Management page** (`RolesModule`, under a new **Users & Roles**
   sidebar *group* — it was a flat item before, now it has two submenus,
   **Users** and **Roles**, exactly like the existing Account/Payment/
   Quotations groups): Name / Description / Users / Permissions / Status /
   Created / Actions, sortable. **Create/Edit** opens a searchable,
   module-grouped permission matrix with per-module and global Select
   All/Clear All, a live "N of M selected" counter, and an optional
   "Start from" template that copies another role's current permissions in
   client-side (still fully editable after). **Duplicate** copies a role's
   current permission set into a new, always-ordinary (never protected,
   never Super Admin) role via `POST /api/roles/:id/duplicate`. **Delete**
   on a role nobody holds is immediate; a role still assigned to users
   instead offers **"Reassign Users & Delete"** — pick a replacement role
   and it moves every affected user and deletes the role in one atomic
   transaction (`DELETE /api/roles/:id` with `reassignToRoleId`, a 409 with
   an `inUse` count when no target is given yet). Reassigning users *into*
   the Super Admin role this way is blocked for anyone but a Super Admin —
   otherwise "delete this role" would be a side door to grant Super Admin
   to several accounts at once. The Super Admin row itself exposes zero
   actions; a protected role (Admin, Manager, etc.) can have its
   permissions edited but never renamed or deleted.

3. **Users' Role dropdown now sources from the live `/api/roles` list**
   (`UserFormModal`) instead of a fixed 6-value set — a brand-new custom
   role is immediately assignable the moment it's created, no redeploy
   needed. Inactive roles show an "(Inactive)" suffix and are blocked from
   being newly picked (matches the backend guard in point 1).

4. **Per-user Permissions panel** (`UserPermissionsModal`, opened via a new
   "Permissions" button gated on `users.managePermissions` — Admin/Super
   Admin only): shows the user's role grants (read-only — edit those from
   Roles Management instead) with a three-way **Grant / Deny / Inherit**
   toggle per permission for a direct override on top, a live "Effective:
   Allow/Deny" pill per row, and search. Saving calls
   `PATCH /api/users/:id/permissions`, which layers the overrides on the
   role (never a second competing permission set) and immediately bumps
   the target's session version — same instant-effect guarantee as a role
   permission edit. A Super Admin target shows an explanatory message
   instead of an editor, since there's nothing to configure.

5. **Backend enforcement is the same engine Phase 1 already built and
   tested** — this round's `routes/roles.js`/`routes/users.js` additions
   (role status, the reassignment-aware DELETE, the two permission-override
   endpoints) were already covered by new `test/rbac.js` checks before any
   UI code was written against them, so the UI is a client of already-
   verified server behavior, not a parallel source of truth for it. Every
   `hasRaw("roles.*")`/`hasRaw("users.managePermissions")` check gating the
   new UI reads the same `rawKeys` array the server resolves per request —
   there is no separate frontend copy of "what Super Admin/Admin can do."

6. **New Playwright coverage**, `test/e2e.js`: opens the Roles page and
   confirms the seeded system roles list correctly, that the Super Admin
   row is fully locked down and Admin (protected) can't be deleted, creates
   a real custom role through the matrix's module Select All (verified via
   a direct API call, not just the DOM), duplicates and deletes it,
   confirms the new role is immediately selectable in the Add User dropdown
   (the live-wiring requirement from point 3), grants a direct permission
   override on a seeded Cashier account and confirms it's actually
   persisted server-side (`GET /api/users/:id/permissions`) and reflected
   as "Effective: Allow", then reverts it back to Inherit — leaving the
   database exactly as it found it. `npm run test:rbac`,
   `npm run test:e2e` (243+ checks now), and `npm run test:migration` all
   pass.

7. **A pre-existing JSX escaping bug was caught by the build step, not
   shipped**: `esbuild` rejected a `\"…\"` inside a quoted JSX attribute
   (JSX wants `&quot;` or a `{'…'}` string expression, not a JS-style
   backslash escape) in the role-matrix search placeholder — fixed by
   switching that one placeholder to a `{'…'}` string literal before the
   bundle was ever built or delivered.

**Latest round (TABLE CUSTOMIZATION — Round 1).** The person re-sent the
original "SUPER ADMIN — FULL SYSTEM CONTROL & MASTER ACCESS" spec and, when
asked, confirmed they want the remaining out-of-scope pieces built (a PDF
Visual Editor, Appearance/Branding, Table Customization, an expanded System
Overview dashboard — each its own separate project) and picked **Table
Customization** to go first. The spec's own "SUPER ADMIN TABLE CONTROL"
section (§7) asks for a lot in one go — add/remove/hide/show/reorder/drag/
resize columns, header/row style, density, border, hover, summary/footer —
so a concrete Round-1 scope was stated up front rather than attempting all
of it at once:

- A reusable **show/hide + reorder (↑/↓ buttons, not live drag) + reset +
  "save as my default"** system, self-service for every user.
- A **Super-Admin/Admin-only "Set as System Default"** capability, gated on
  a new granular permission, `settings.manageTableDefaults`.
- A **Compact/Comfortable row-density** toggle (system-default + per-user
  override).
- Applied to **5 tables**: USD Accounts, SLSH Accounts, Users, Roles, Audit
  Log.
- **Explicitly deferred**: the Money Exchange ledger, Transaction History,
  and Quotations tables (more complex existing footer/grouping logic to
  thread through first); literal column **resize** or live **drag**-to-
  reorder; and all color/border/hover/font **styling** (reserved for the
  separate, later Appearance/Branding round the person already prioritized
  second).

1. **A new, table-agnostic persistence layer**: `table_layouts`
   (`table_key`, `user_id`, `columns_json`, `density`, unique on
   `(table_key, user_id)`) and `GET`/`PATCH`/`DELETE /api/table-layout/:tableKey`
   (`src/routes/tableLayouts.js`). A layout is scoped either to one real user
   (their own personal layout, always self-service — same precedent as the
   pre-existing per-quotation "Customize Columns → Save as default") or to
   the literal sentinel user id `__system__` for the **system-wide
   default** everyone without a personal layout inherits — a scope real
   users can never collide with, since `uid()` can never generate it. Saving
   or clearing the system default is gated on the new
   `settings.manageTableDefaults` permission; saving your own is not.
2. **A brand-new grant reaching an already-seeded Admin role, safely.**
   `settings.manageTableDefaults` was added to `ADMIN_EXTRA_GRANTS` after
   installations may have already seeded their Admin role once — the
   seed-time grant block only ever fires on a role's *creation*, not later.
   `src/db.js` backfills it on every startup with a narrow, safe signal:
   only when that installation's Admin role has never been edited
   (`roles.updated_at IS NULL` — `PATCH /api/roles/:id` unconditionally
   stamps `updated_at` on any real change). This auto-upgrades untouched
   installations while permanently respecting a Super Admin who has
   deliberately revoked the grant from a role they've since customized.
   Covered by a new `test/migration.js` check (`testAdminTableDefaultsBackfill`)
   that verifies both directions.
3. **`useTableLayout`/`resolveColumns`/`resolveDensity` + a "⚙ Customize
   table" button and modal** (`frontend/app.jsx`) — one reusable system
   wired into `AccountsModule` (USD and SLSH tracked as independent
   layouts), `UsersModule`, `RolesModule`, and `AuditLogReport`. The modal
   lists every column with a checkbox (disabled and labeled "(always
   shown)" for a table's one required column — its name/identity column),
   ↑/↓ reorder buttons, a Comfortable/Compact density toggle, "Reset to
   default", "Save my layout", and — only for someone holding
   `settings.manageTableDefaults` — "Set as System Default". A saved
   personal layout always wins over the system default (`mine > system`
   priority); resetting removes just your own override, leaving the system
   default and everyone else's own layouts untouched. Every table's trailing
   **Actions column(s) are deliberately left out of the customizable
   system entirely** — always shown, always last — to keep this addition
   low-risk against the app's existing row actions.
4. **New Playwright coverage**, `test/e2e.js`: on the Users table, opens
   the Customize panel, confirms the required Name column's checkbox is
   disabled, reorders a column with ↑ and hides another, saves, and
   confirms the live table actually changed (new order, hidden column
   gone) — then reopens the modal to confirm "Set as System Default" is
   offered to this Admin account, and finally confirms "Reset to default"
   restores the original shipped column set and order. `npm run test:rbac`
   gained 10 new checks covering the full `/api/table-layout/:tableKey`
   surface (unknown-table rejection, self-service `scope=me`, the
   `scope=system` 403/200 permission gate — including that Admin, not just
   Super Admin, holds the grant — input validation, the mine-over-system
   priority, and DELETE scope gating). `npm run test:rbac`, `npm run
   test:e2e` (249+ checks now), and `npm run test:migration` all pass.

**Latest round (TABLE CUSTOMIZATION — Round 2: Exchange, Payment,
Quotations).** Extends the exact same Round 1 system — no new backend
concept, no new permission, no schema change — to the three tables
originally deferred out of Round 1 as "more complex existing footer/
grouping logic": the **Money Exchange ledger**, **Deposits & Withdrawals
(Payment) USD/SLSH**, and the **Quotations** list. `VALID_TABLE_KEYS`
(`src/routes/tableLayouts.js`) simply grew by 4 keys — `exchange`,
`payments.usd`, `payments.slsh`, `quotations` — reusing the identical
`table_layouts` store and the identical `settings.manageTableDefaults`
gate on the system-wide default.

1. **Money Exchange ledger** (`ExchangeModule`, tab "Transactions" only —
   the Daily log/till and Rate history tabs are untouched): Date, Client
   (required — the row's identity column), Given, Received, Rate, Profit,
   Staff, Status. The leading `#` display-order column and the trailing
   Update/Delete actions column stay fixed, same convention as every
   Round 1 table. The footer's per-currency `FootAmounts` (Given/Received,
   split USD vs SLSH so they're never added together) now tracks whichever
   column position Given/Received end up at after a reorder, and the
   "Total" label is anchored to the required Client column so it's always
   visible regardless of what's shown or hidden.
2. **Deposits & Withdrawals (Payment) USD/SLSH** (`DepositsWithdrawalsModule`,
   "Transactions" tab only — "Daily Transactions" is untouched): Account #,
   Account (required), Date, Notes, Deposit, Withdrawal, Balance after,
   Staff. Two independent layouts, one per currency, same pattern as
   Round 1's USD/SLSH Accounts tables. The footer's deposited/withdrawn
   totals track the Deposit/Withdrawal columns' current position; the
   "Amount" label is anchored to the required Account column (moved there
   from its original fixed position under Notes, for the same
   always-visible-anchor reason as above — a one-column repositioning with
   no change to any figure or behavior).
3. **Quotations** (`QuotationsModule`) — **one shared layout across all
   three Pending/Paid/Refunded submenus**, not three separate ones: they're
   filtered views of the same underlying table, exactly as the module's own
   long-standing comment already said. Columns: Quotation (number), Date,
   Account (required), Amount, Valid until, Status. This is a completely
   separate system from the older per-quotation "Customize Columns" panel
   (line-item fields on a single quotation's PDF, keyed off
   `user.quotationColumnPrefs`) — that one still works exactly as before
   and controls what prints on one document; this one controls what the
   LIST table shows on screen. The footer's per-currency total tracks the
   Amount column; "Total (N pending/paid/refunded)" is anchored to the
   required Account column.
4. **New Playwright coverage**: a full open → hide a column → save → verify
   the live header changed → reset → verify restored pass on the Exchange
   ledger (chosen as the most complex of the three footers). The identical
   component and API path already has full coverage from Round 1's Users
   test, and `test/rbac.js` gained 2 new checks confirming all 4 new table
   keys are accepted (not rejected as "unknown table") and that the same
   self-service `scope=me` / gated `scope=system` rules apply to them.
   `npm run test:rbac`, `npm run test:e2e` (252+ checks now), and
   `npm run test:migration` all pass.

**Round (TABLE CUSTOMIZATION — Round 3: Transaction History).**
Same extension pattern as Round 2 — `VALID_TABLE_KEYS` grew by 2 more keys,
`history.usd` and `history.slsh`, no new permission or schema change.

1. **Transaction History USD/SLSH** (`TransactionHistoryModule`): Type,
   Reference, Date, Account (required), Amount, Status, Staff/Creator. This
   table is a slightly different shape from every other customized table so
   far — it has **no Actions column at all** (the whole row opens the
   shared Detail modal instead of per-row buttons), so only the leading `#`
   display-order column stays fixed; every other column, including the
   rightmost one, is now show/hide/reorder-able. The footer's "Total (N)"
   label and its In/Out/Net balance block track the Account and Amount
   columns' current positions, same pattern as the other three
   footer-bearing tables from Round 2.
2. **New Playwright coverage**: hides the Reference column via Customize
   table, confirms it disappears from the live Global Transaction History
   header, then Resets and confirms it returns — plus confirms the required
   Account column's checkbox is locked. `test/rbac.js` gained 1 more check
   confirming both new table keys are accepted. `npm run test:rbac`,
   `npm run test:e2e` (253+ checks now), and `npm run test:migration` all
   pass.

**Latest round (APPEARANCE & BRANDING — Round 1: Brand Color, Website,
Favicon).** The first round of a separate, larger feature (Settings ->
Appearance & Branding in the original spec) — distinct from TABLE
CUSTOMIZATION above, which only ever covered column show/hide/reorder and
row density, never colors. This round reuses the pre-existing
`settingsManage` permission (the same one that already gated the logo/name/
address/PDF-accent-color fields) rather than introducing a new grant, since
nothing here is a newly-privileged capability — it's the same "who can edit
Settings -> General" boundary, extended to a few more fields.

1. **Brand Color** (`company_settings.brand_color`, new column via
   `ensureColumn` — see `src/db.js`): one hex color, set from Settings ->
   General -> "App appearance", that becomes the live app's single accent
   color everywhere it was previously hard-coded — the sidebar, active
   tabs, buttons, links, and the login screen gradient — in both Light and
   Dark mode. This is deliberately kept separate from the pre-existing "PDF
   accent color" control just below it, which only ever affects exported
   PDF documents and is untouched by this round.

   Rather than ask the Super Admin to pick several colors (header
   background, hover, footer, dark-mode variant, …), the frontend derives
   every shade it needs from that ONE hex value: `frontend/app.jsx` gained
   `hexToHsl` / `hslToHex` / `shadeHex` helpers, and a new `App()` effect
   (keyed on `company.brandColor` and the Light/Dark toggle) that computes
   `--c-navy`, `--c-navy-deep`, `--c-thead-bg`, and `--c-tfoot-bg` from it
   and applies them as inline CSS-variable overrides on `<html>` — which
   win over `THEME_CSS`'s hard-coded defaults regardless of theme. The
   Dark-mode `--c-navy` is automatically lightened/desaturated from the
   same base color (mirroring the built-in light-vs-dark navy relationship)
   so it stays legible on dark surfaces without a second color picker. When
   no brand color has been set, every override is removed and the app looks
   pixel-identical to before this round — existing installations see no
   visual change until a Super Admin actively opts in. `C.navyDeep`, a
   previously-hardcoded hex used only in a handful of places (the login
   gradient and a few accent-colored labels), is now itself a CSS-variable
   token for the same reason.
2. **Website** (`company_settings.website`, new column): a plain free-text
   field alongside the existing Address/Phone/Email, editable and validated
   exactly like those (no format enforcement, matches the existing
   pattern). Returned by the already-public `GET /api/settings/company` so
   it's available wherever company info is shown (currently the Settings
   form; not yet wired into the PDF letterhead template, which is out of
   scope for this round).
3. **Favicon** (`company_settings.favicon_data_url`, new column): a small
   PNG/JPEG/ICO image (capped at ~90KB — a `MAX_FAVICON_CHARS` constant
   separate from the logo's own, much larger cap), uploaded the same way as
   the existing Logo control. A new `App()` effect creates or updates the
   page's `<link rel="icon">` from it, so it actually shows up on the
   browser tab; clearing it removes the custom favicon link entirely
   (falling back to whatever the browser shows by default).
4. **Explicitly deferred to a later round** (per the original spec's
   Section 6, "SUPER ADMIN APPEARANCE CONTROL"): independently configurable
   Secondary/Accent/Status colors, Font Family/Size, per-component
   (Sidebar/Cards/Forms/Modals) styling, table-specific color/border/hover/
   radius/header-color styling, and Theme Presets. All of that remains a
   separate, much larger project, same as the PDF Visual Editor and System
   Overview dashboard mentioned elsewhere in this document.
5. **New Playwright coverage**: Website field saves and survives a reload;
   the Favicon upload control is present; the Brand Color picker is
   present and separate from the PDF accent color picker; picking a swatch
   updates the color field; saving actually overrides the live `--c-navy`
   CSS variable (checked via `getComputedStyle`, not just the form value);
   the override survives a reload; and resetting back to the default
   swatch restores the built-in `--c-navy`. `test/rbac.js` gained 4 new
   checks: the new fields round-trip through the public GET, PATCH is still
   blocked for a role without `settingsManage` (Manager), a malformed
   `brandColor`/`faviconDataUrl` is rejected with 400, and a valid PATCH
   persists and is readable back. `npm run test:rbac`, `npm run test:e2e`
   (260 checks now), and `npm run test:migration` all pass.

**Latest round (SUPER ADMIN SYSTEM OVERVIEW).** A third feature from the
original spec's "SUPER ADMIN — FULL SYSTEM CONTROL" section (distinct from
both TABLE CUSTOMIZATION and APPEARANCE & BRANDING above): a single,
read-only screen that aggregates what used to require checking the Users
list, Roles list, and Audit Log report separately — "is the system
healthy, who has access, and what changed lately." No new schema and no new
permission: it reuses the exact same `"users"` legacy-key gate that already
restricts the Users & Roles module to Admin/Super Admin, since a Manager
who can't see Users & Roles today shouldn't be able to see a page that
summarizes it either.

1. **Backend** (`src/routes/systemOverview.js`, new file, registered in
   `src/server.js`): a single `GET /api/system-overview` that aggregates,
   with plain `SELECT`/`COUNT` queries against tables that already exist —
   - **System status**: server uptime, server time, Node.js version, and
     the `node:sqlite` experimental-engine note.
   - **Database status**: the SQLite file's size on disk (`fs.statSync`
     against the same `DB_PATH` `src/db.js` already exports), whether WAL
     mode is on, and a live row count for every key table (users, roles,
     clients, exchange_transactions, quotations, account_ledger,
     audit_log) — a quick sanity signal that the database is actually
     reachable and populated, not just that the file exists.
   - **Users**: total / active / deactivated / suspended counts.
   - **Roles**: total / active / inactive counts, plus how many are Super
     Admin or protected system roles.
   - **Permissions**: the size of the full granular permission catalog,
     how many role-level grants exist across all roles, and how many
     individual per-user overrides are in effect.
   - **Recent changes**: the 8 most recent `audit_log` entries — the same
     table the existing Audit Log report reads, just surfaced here too.
   - **Recent login activity**: the 8 most-recently-logged-in users (by
     the pre-existing `users.last_login` column — no new tracking needed),
     with their role label and status.
   - **Audit activity**: entry counts in the last 24 hours and the last 7
     days, as a quick activity pulse distinct from the raw recent-changes
     feed above.
2. **Frontend** (`frontend/app.jsx`): a new `SystemOverviewModule`,
   reachable as a third sub-item — "System Overview" — under the existing
   "Users & Roles" sidebar group (alongside Users and Roles), gated by the
   same `perm("users")` check as the Users sub-item itself. Four stat tiles
   up top (Users / Roles / Permissions / Audit activity), then System
   status and Database status side by side, then Recent changes and Recent
   login activity side by side. A "Refresh" button re-fetches on demand;
   otherwise it loads once on open, same as the main Dashboard.
3. **New Playwright coverage**: confirms the new sub-item appears under
   Users & Roles; the page loads with live (not placeholder) Users/Roles/
   Permissions/Audit-activity/System-status/Database-status values; Recent
   changes and Recent login activity render (checking the just-logged-in
   admin's own name actually shows up in the live login feed); Refresh
   re-fetches without error; and a direct API call confirms a Cashier
   (no `users` permission) still gets a 403 from `/api/system-overview`
   even though they can't see the sidebar entry either. `test/rbac.js`
   gained 3 new checks: blocked for Cashier, succeeds for Super Admin with
   the full expected shape, and succeeds for Admin too (same grant as the
   Users list). `npm run test:rbac`, `npm run test:e2e` (266 checks now),
   and `npm run test:migration` all pass.

**Latest round (SUPER ADMIN PDF TEMPLATE CONTROL — Round 1).** The fourth
and final item from the original "SUPER ADMIN — FULL SYSTEM CONTROL" list
(Table Customization, Appearance & Branding, System Overview, and now this)
— and by far the largest one in the spec as written. The spec's "SUPER
ADMIN PDF VISUAL EDITOR" section calls for a full drag-and-drop canvas
editor: move, resize, align, layer, arbitrary text/font/color/image
placement, tables, QR codes, barcodes, signatures — "no source-code editing
should be required." That is a genuinely separate, much larger project
(a new template data model that's both visually editable in the browser
*and* renderable server-side to PDF, essentially a small page-layout engine)
than anything else built in this file, and building a shallow imitation of
it would be worse than being explicit about the trade-off. After presenting
the option directly, the scope agreed for this round was: **a form-based
template manager now** (every toggle controls a real, already-existing
element of the quotation PDF layout), **not** the visual canvas editor,
which remains a distinct, not-yet-started future project. Same
`settingsManage` legacy-key gate as the rest of Settings (company info, PDF
accent color, brand color) — this genuinely lives under Settings -> PDF
Templates per the spec's own text, and isn't a newly-privileged capability.

1. **Schema** (`src/schema.sql`): a brand-new `pdf_templates` table (no
   `ensureColumn` ordering concern — see db.js's own comment on that rule)
   — `kind` (`'quotation'` only for Round 1; a future `'report'` kind is a
   pure addition), `name`, `is_default`/`is_archived`/`is_builtin` flags,
   four `show_*` boolean toggles, `header_note`/`footer_text` free text,
   and a `version` integer bumped on every edit. A partial unique index
   (`WHERE is_default = 1`) enforces **at most one default template per
   kind** at the database level, not just in the API's read-modify-write
   logic. `src/db.js` seeds exactly one built-in template
   (`is_builtin = 1`, `is_default = 1`) on first run — its toggles all
   default to the exact pre-this-round hard-coded behavior, so upgrading
   an existing install changes zero existing PDFs until someone actually
   edits or replaces it. A built-in template can never be **deleted**
   (mirrors the protected-system-role pattern) but, unlike a protected
   role, **can** be freely edited — only its existence is protected.
2. **API** (`src/routes/pdfTemplates.js`, new file): full CRUD plus
   `POST .../duplicate`, `POST .../set-default`, `POST .../archive`,
   `POST .../restore`, and `GET .../preview.pdf` (renders a realistic
   *sample* quotation — clearly fake data, never a real quotation — through
   the same `renderQuotationPDF` used for real exports, so a Super Admin/
   Admin can see exactly what a toggle or header/footer edit will produce
   before making it the live default). Guardrails enforced server-side (not
   just hidden in the UI): the built-in template can't be deleted; the
   current default can't be archived or deleted (set a different one as
   default first) — so there's always exactly one usable, non-archived
   default. **Explicitly deferred**: full version history with snapshots
   and rollback (the spec's "Create Template Versions" / "Restore Previous
   Versions") — the `version` counter exists and is real, but Round 1 stops
   at "has this changed since I looked," not a browsable history.
3. **Dynamic Fields** (spec section 10, scoped to what a header/footer
   free-text field can meaningfully use): `header_note` and `footer_text`
   support `{{company_name}}`, `{{company_address}}`, `{{company_phone}}`,
   `{{company_email}}`, and `{{company_website}}` placeholders, substituted
   at render time (`applyPlaceholders` in `src/pdf.js`). Document-specific
   fields (quotation number, customer name, totals, ...) already have their
   own fixed place in the layout and aren't re-offered as free-text tokens.
4. **`src/pdf.js`**: `renderQuotationPDF` now accepts an optional
   `template` argument. Every toggle defaults to the exact pre-this-round
   value when no template is passed (or a field on it is unset), so
   existing callers and upgrades never change behavior by accident.
   `GET /api/quotations/:id/pdf` now loads the current default `"quotation"`
   template (`getDefaultPdfTemplate` in `src/domain.js`) and renders with
   it — a real, working connection between templates and actual generated
   PDFs, verified end-to-end (not just at the API layer): a live quotation
   export was confirmed via `pdftotext` to reflect a template's custom
   header/footer text (with placeholders substituted) and its signature-line
   toggle, both with the template as the live default and after switching
   back to a different one.
5. **Frontend** (`frontend/app.jsx`): a new `PdfTemplatesModule`, reachable
   as a third sub-item — "PDF Templates" — under the existing "Settings"
   sidebar group (alongside General and Deactivated Accounts), gated by the
   same `perm("settingsManage")` check as General. A plain list (Name /
   Default·Archived·Built-in badges / Version / Updated / actions) — Delete
   and Archive are hidden entirely (not just disabled) for the current
   default, and Delete is hidden for the built-in template, matching what
   the server enforces. The New/Edit form modal has the four show/hide
   checkboxes and the two placeholder-aware text areas, with the available
   `{{...}}` tokens shown as a hint under each field.
6. **New Playwright coverage**: the sub-item appears under Settings; the
   built-in default loads with no Delete/Archive actions available; a new
   template can be created with signature lines turned off and a header
   note using a placeholder; its Preview PDF is confirmed to be a real
   `%PDF`-signed file (fetched and inspected byte-for-byte, not just a
   200 status) with the settings actually persisted; Set Default correctly
   flips which template is flagged default and un-blocks archiving the old
   one; Duplicate produces an independent `"... (Copy)"` template; a full
   cleanup path (delete duplicate → restore built-in as default → delete
   the QA template) leaves the table exactly as it started; and a real
   quotation's PDF export is confirmed (by size/status, and separately via
   `pdftotext` during manual verification) to follow whichever template is
   currently the default. `test/rbac.js` gained 5 new checks: blocked for a
   role without `settingsManage`; the built-in default can't be deleted or
   archived while it's the default; creating a template, setting it
   default, then archiving/restoring/deleting the now-non-default old one
   all work exactly as gated; header/footer placeholders actually
   substitute into a real rendered preview PDF (`%PDF`-signature checked);
   and every action route 404s consistently for an unknown template id.
   `npm run test:rbac`, `npm run test:e2e` (275 checks now), and
   `npm run test:migration` all pass.

**Latest round (APPEARANCE & BRANDING — Round 2: Secondary/Accent/Status
Colors, Font Family, Font Size, Theme Presets).** With all four original
"SUPER ADMIN — FULL SYSTEM CONTROL" items now addressed (Table
Customization, Appearance & Branding Round 1, System Overview, PDF Template
Control), this round returns to the original spec's Section 6 ("SUPER ADMIN
APPEARANCE CONTROL") and picks up six of the items explicitly deferred at
the end of Round 1. Still deliberately **not** covered — per-component
(Sidebar/Header/Buttons/Cards/Forms/Modals) styling and per-table (Header/
Rows/Hover/Borders/Radius) styling, both far more open-ended and
higher-risk than a handful of global tokens — remain a possible future
Round 3. Same `settingsManage` gate as every other Appearance/Branding
field; no new permission.

1. **Secondary Color and Accent Color** (`company_settings.secondary_color`/
   `accent_color`, new columns): extend Round 1's Brand Color pattern to the
   app's other two semantic base tokens. Before this round, `C.cyan`
   (`#42bfdd`) and `C.mint` (`#bbe6e4`) were hardcoded hex constants used
   throughout `frontend/app.jsx` — stat-tile highlight colors, the
   sidebar's active-submenu tint, the search-input focus ring, the "accent"
   `Btn` tone, and decorative tagline text. Both are now CSS variables
   (`--c-cyan`, `--c-mint`) with their original hex values as the `:root`
   default in `THEME_CSS`, overridden inline on `<html>` by a new `App()`
   effect exactly like Brand Color's — so every one of those ~15+ call
   sites picks up a custom color automatically, with zero per-component
   changes. Two small hardcoded `rgba(66,191,221,...)` values (the sidebar
   active-group tint and the search-input focus ring) were switched to
   `color-mix(in srgb, var(--c-cyan) N%, transparent)` so they track a
   custom Accent Color too, instead of staying frozen at the old default.
2. **Status Colors** (`company_settings.status_pending_color`/
   `status_paid_color`/`status_refunded_color`, new columns): the
   Pending/Paid/Refunded quotation-status badges (`STATUS_COLORS` in
   `frontend/app.jsx`, used by the donut chart and every status legend/dot
   across Dashboard, Reports, and Quotations) are now three independent CSS
   variables (`--c-status-pending/paid/refunded`) rather than reusing
   `C.amber`/`C.green`/`C.cyan` directly — so, for example, Refunded can be
   recolored without also changing the general Accent Color, even though
   both default to the same historical `#42bfdd`.
3. **Font Family** (`company_settings.font_family`, new column): a
   whitelisted set of 6 curated stacks (Inter/default, System UI, Georgia,
   Times New Roman, Verdana, Courier New — `FONT_FAMILY_OPTIONS` in
   `frontend/app.jsx`, mirrored server-side by `FONT_FAMILY_KEYS` in
   `src/routes/settings.js`), never free-form CSS text. `FONT_SANS` — the
   constant already used in ~20 places throughout the file via
   `fontFamily: FONT_SANS` — now simply reads `var(--c-font-family)`
   instead of a fixed string, so every one of those call sites follows a
   chosen Font Family with no other changes.
4. **Font Size** (`company_settings.font_size`, new column): a 3-step
   Small/Medium(default)/Large scale (`FONT_SIZE_OPTIONS`), applied as a
   CSS `zoom` on `<html>` (`html { zoom: var(--c-zoom); }` in `THEME_CSS`)
   rather than rewriting the many hardcoded px sizes scattered throughout
   the file into a rem-based system — a much larger refactor for the same
   practical result. `zoom` is a long-supported Chromium/Edge/Safari
   property, which covers this app's actual runtime; it is not yet a CSS
   standard in every browser engine, so this is a deliberate, documented
   trade-off rather than an oversight.
5. **Theme Presets**: six curated one-click combinations (`THEME_PRESETS`
   in `frontend/app.jsx` — Geeska Default, Ocean Breeze, Emerald Trade,
   Sunset Amber, Royal Purple, Slate Charcoal), each just a
   Brand/Secondary/Accent Color triple. This is a pure frontend
   convenience, not a new data model or API — there's no "presets" table;
   clicking one immediately `PATCH`es those three fields and saves (no
   separate "Save" click needed, since the whole point of a preset is that
   it's one click), while Status Colors, Font Family, and Font Size are
   left exactly as they were. "Geeska Default" sets all three back to
   `null`, restoring the original hardcoded hex values.
6. **Frontend** (`frontend/app.jsx`, `SettingsModule`): three new sections
   under Settings -> General, below the existing Brand Color control —
   "Theme presets" (swatch buttons), "Global colors" (5 paired color-picker
   + hex-text fields for Secondary/Accent/Pending/Paid/Refunded, saved
   together with one "Save colors" button), and "Typography" (Font Family
   and Font Size dropdowns with a live text preview, saved together with
   one "Save typography" button) — each independent of Brand Color's own
   save button, matching the existing PDF-accent-color-vs-brand-color
   separation already established in Round 1.
7. **New Playwright coverage**: the Theme Presets section and its swatches
   are present; applying Ocean Breeze saves immediately and live-overrides
   `--c-navy`/`--c-mint`/`--c-cyan` (checked via `getComputedStyle`);
   applying Geeska Default resets all three back to their built-in values;
   the Global Colors fields are present and saving a custom
   Accent/Pending/Paid/Refunded set live-overrides the matching CSS
   variables; the override survives a reload; restoring the built-in
   values is confirmed; the Typography section's Font Family and Font Size
   selects are present, and saving each live-overrides `--c-font-family`/
   `--c-zoom` respectively (with Medium correctly falling back to
   `--c-zoom`'s own `1` default, not an unset value). `test/rbac.js` gained
   4 new checks: the new fields round-trip through the public GET with
   sensible defaults, PATCH is still blocked for a role without
   `settingsManage` (Manager), a malformed color or an out-of-whitelist
   `fontFamily`/`fontSize` is rejected with 400, and a valid PATCH across
   all seven new fields persists and reads back correctly. `npm run
   test:rbac`, `npm run test:e2e` (283 checks now), and
   `npm run test:migration` all pass.

**Latest round (ENTERPRISE FINANCIAL MANAGEMENT DASHBOARD).** The person
supplied a large, separately-uploaded spec — 53 numbered items describing an
"ULTIMATE ENTERPRISE FINANCIAL MANAGEMENT DASHBOARD" — and answered two
explicit questions before any of it was built: (1) use the app's **real**
Pending/Paid/Refunded quotation statuses throughout, not the spec's
fictional "Expired" status (this data model has no such concept — a
quotation is never silently time-barred, only explicitly settled), and (2)
build **the entire spec in one go**, not a phased Phase-1-first rollout.
Both answers are binding and reflected everywhere below. The round needed
**zero schema changes** — the existing `table_layouts` table (from the
TABLE CUSTOMIZATION round) is reused for dashboard-layout persistence via a
hardcoded `table_key='dashboard'` row and a richer `columns_json` shape
(`[{key, visible, size}]` instead of a flat column-key list).

1. **One aggregation endpoint, permission-shaped server-side.**
   `GET /api/dashboard?range|from|to|currency|status|accountId|bucket` (new
   `src/routes/dashboard.js`) computes every widget's data in one request
   against the real `account_ledger`/`exchange_transactions`/`transfers`/
   `quotations` tables — no separate per-widget calls. What comes back
   depends on the caller's own grants, computed once per request:
   `reportsGate = can(user,"reports")` (no `reports` → the response is
   metadata only: no summary, no charts, nothing financial — matching how
   the rest of the app already treats a Cashier); on top of that,
   `exchangeGate = reportsGate && (exchangeCreate || exchangeAll)` gates
   Exchange Activity, and `quotationsGate = reportsGate &&
   (quotationsManage || quotationsApprove)` gates Quotation Performance and
   the Recent Quotations widget. A field the caller isn't entitled to is
   never sent at all — the frontend hides a missing widget by the data
   being absent, not by a client-side permission check it could bypass, so
   there's nothing to defeat by editing the page.
2. **CURRENCY SAFETY (spec item 38), enforced twice.** USD and SLSH are
   never summed into one number or drawn on one shared-axis chart, anywhere
   on the dashboard. Server-side, a `sumByCurrency()` helper always returns
   `{usd, slsh}` — there is no code path that adds a USD amount to an SLSH
   one. Frontend-side, every trend/volume chart that could have carried
   both currencies (Money Flow Trend, USD/SLSH Balance Trends, Deposits vs
   Withdrawals, and Exchange Activity's volume charts) renders as **two
   separate same-currency chart instances** side by side rather than one
   mixed chart — confirmed by a dedicated Playwright check that, with the
   Currency filter set to USD, asserts zero occurrences of "SLSH" anywhere
   inside the Money Flow Trend card.
3. **Global filter bar, one shared Granularity control.** Date
   range/Currency/Account (drill-down)/Quotation status all filter every
   widget from one bar at the top, as active-filter chips ("Clear all"
   resets everything, including the account drill-down). The spec's item 13
   asked for a per-widget Daily/Weekly/Monthly toggle on each trend chart
   individually; since the backend computes one shared bucket per query
   anyway, this was consolidated into a single **Granularity** dropdown
   (`bucket=auto|day|week|month`) that drives every trend chart at once —
   a documented judgment call, not a scope cut. Left on Auto,
   `pickBucketUnit()` picks day buckets for a ≤31-day range, week for
   ≤180 days, and month otherwise, so a chart is never rendered with
   hundreds of illegible daily points.
4. **Account drill-down (spec item 18) reuses the global Account filter**
   rather than a separate page: picking an account scopes the *entire*
   dashboard to it (an `accountId` param on the same `/api/dashboard`
   call) — portfolio-wide widgets like Account Balance Overview and Top
   Accounts correctly disappear, since there's only one account in scope,
   and a "Scoped to account: <name> → Open full account view" banner links
   into the pre-existing Account Detail view rather than duplicating it.
5. **Balance Trend** reconstructs true historical Opening/In/Out/Closing
   balances per bucket with a single forward pass over a currency's full,
   all-time ledger history — not just the rows inside the selected date
   range, since an accurate "opening balance" for the range depends on
   everything before it.
6. **Money In / Money Out** are the literal sum of every ledger row typed
   `deposit` / `withdrawal` respectively (Transfers and Exchange legs are
   shown separately in Transaction Activity & Distribution, not folded
   into Money In/Out, since a transfer isn't new money entering or leaving
   the business and an exchange is a conversion, not a deposit/withdrawal
   in the plain sense). **Transaction Activity & Distribution** buckets by
   Deposit/Withdrawal/Transfer/Exchange/Quotation — "Payment" was not kept
   as a separate bucket of its own, since every payment-module row is
   already a plain Deposit or Withdrawal at the ledger level and would
   otherwise be double-counted.
7. **Attention Required** is data-driven, not a hardcoded rule: for each
   (type, currency) pair in the selected period, an entry is flagged
   "unusually large" only when it is at least **3× the period's own
   median** for that same type+currency **and** there are at least **5**
   comparable entries to make a median meaningful (so a quiet account with
   two transactions never gets a false "spike" flag) — top 6 alerts shown,
   newest/largest first.
8. **Customize Dashboard (spec item 33)** — an 11-widget catalog
   (`DASHBOARD_WIDGET_DEFS`), each independently show/hide-able, reorderable
   (the same ↑/↓ pattern as the existing Table Customization modal), and
   resizable to full or half width (implemented, not scoped out — a plain
   CSS `flex-basis` switch per widget). Persisted via
   `GET/PATCH/DELETE /api/dashboard-layout?scope=me|system` on the reused
   `table_layouts` table; `scope=me` is per-user and always wins over
   `scope=system` (a role's shared default), matching the same layering
   already used for saved table column layouts elsewhere in the app.
   Gated by a new granular-only `dashboard.customize` permission (no
   legacy-key equivalent — same precedent as `settings.manageTableDefaults`).
9. **Export.** `dashboard.export` (also granular-only) gates two new
   endpoints, `GET /api/dashboard/export.csv` and `.../export.pdf`, both
   reflecting whatever filters are currently active, plus a Print button
   using the browser's own print dialog. Both new permissions are added to
   `ADMIN_EXTRA_GRANTS` so an existing Admin role — including one on an
   already-deployed database — picks them up automatically on the next
   server start, the same `updated_at IS NULL`-guarded backfill pattern
   used for every previous admin-only addition (never re-applied once an
   Admin role has been genuinely, deliberately edited).
10. **Quick Actions are navigation-only** — "+ New Account" / "+ Deposit /
    Withdraw" / "+ Exchange" / "+ New Quotation" (each independently gated
    by the same permission its target module already requires) jump
    straight into the existing, already-tested standalone flows rather
    than duplicating a second copy of each form directly on the dashboard.
11. **New hand-rolled chart primitives** — `LineAreaChart` (multi-series
    SVG line/area, hover tooltip, a toggleable per-series legend, and
    label-thinning that scales with the chart's actual pixel width rather
    than a fixed day-count threshold, so labels never overlap in a
    half-width widget) and `GroupedBarChart` (grouped bars per bucket with
    the same width-aware thinning) — no external charting library, matching
    the existing hand-rolled `VBarChart`/`HBarChart`/`DonutChart` already
    in the app.
12. **New Playwright coverage** (14 checks, `npm run test:e2e` now **297
    checks**): the full widget set renders for a reports-permitted role;
    the filter bar's five controls are present; Quick Actions and the
    Customize/Export buttons are present for Admin; changing Date range
    reloads the dashboard and shows an active-filter chip; the currency-
    safety check described above; the account drill-down banner appears
    and Top Accounts disappears; Clear all resets every filter including
    the drill-down; hiding a widget in Customize Dashboard removes it
    immediately and it stays hidden across a full page reload; Reset to
    default restores it; Export CSV and Export PDF both trigger a real
    browser download with the right extension; a Quick Action navigates
    into Money Exchange and back; and a cashier (no `reports` grant) sees
    **only** the currency converter on the Dashboard — no filter bar, no
    Quick Actions, no Customize/Export buttons, no widget grid at all.
    `test/rbac.js` gained 9 checks: unauthenticated access is rejected;
    a Cashier gets metadata only; an Accountant (reports + exchange, no
    quotations) sees exchange data but not quotation data; a Viewer
    (reports only) sees neither exchange nor quotation sections; summary
    money-in/out are always `{usd, slsh}` pairs, never a combined scalar;
    `dashboard.customize`/`dashboard.export` are withheld from a legacy
    role without the new extra grant and correctly granted to Admin via
    `ADMIN_EXTRA_GRANTS`; the dashboard-layout PATCH validates widget shape
    (array, known `size` enum, no duplicate keys); and a personal ('me')
    layout always wins over a system default. No schema changed this
    round, so `npm run test:migration` needed no new checks — it was
    re-run to confirm zero regressions. `npm run test:rbac`, `npm run
    test:e2e`, and `npm run test:migration` all pass.

**Latest round (SALE RATE / EXCHANGE PROFIT).** Money Exchange's Profit
field had existed since the very first round but was always a plain manual
number staff typed in by hand (defaulting to 0) — this round makes it
**automatic**. Before writing any code, four questions were put to the
person and answered explicitly; every design choice below follows directly
from those answers:

1. **What "Sale Rate" means.** It's the wholesale/cost rate the business
   actually sources USD⇄SLSH at — a completely separate figure from the
   Daily Rate quoted to customers (`exchange_rates`, unchanged). The spread
   between the two is what makes an exchange profitable, not the Daily Rate
   in isolation.
2. **The formula**, confirmed against a worked example (Daily Rate 8,700,
   Sale Rate 8,650, a customer converting $100 USD → SLSH): `Profit (USD) =
   Amount(USD) × (Daily Rate − Sale Rate) ÷ Sale Rate` — $100 × 50 ÷ 8,650
   ≈ **$0.58**.
3. **Direction.** The same formula covers both exchange directions, but the
   sign flips between them: a USD→SLSH exchange applies the spread to the
   USD amount *given*; a SLSH→USD exchange applies the mirror-image spread
   (sign inverted) to the USD amount *received* — the business is
   effectively "selling" the opposite currency each time, so a Daily Rate
   above the wholesale Sale Rate is a gain in one direction and the
   matching loss in the other.
4. **The existing manual Profit field stays as an override** — defaulting
   to the auto-computed figure, but still directly editable per
   transaction, exactly like `rateUsed` and `amountReceived` already work
   on the same form.

Implementation:

1. **Sale Rate is logged exactly like the Daily Rate** — a brand new
   `sale_rates` table (`id, rate, set_by, set_by_name, at`, no
   `ensureColumn` ordering hazard since it's a new table), its own
   `GET/POST /api/sale-rate` endpoint (`src/routes/saleRate.js`, mirroring
   `src/routes/rate.js` line for line), gated by the same `rateManage`
   permission as the Daily Rate (so Admin and Manager can set either).
   Kept as its own table/endpoint rather than folded into `exchange_rates`,
   since the two rates are set on independent schedules by the same people
   — merging their histories into one table would turn "what was the Sale
   Rate on this date" into an awkward self-join. Unlike `getCurrentRate()`
   (which defaults to `1` when unset, since the Daily Rate is required for
   basic exchange math to work at all), `getCurrentSaleRate()` returns
   `null` until someone actually sets one — a fabricated default here would
   silently manufacture large, wrong "profit" numbers the moment this
   shipped against an existing database, instead of just leaving Profit at
   its pre-existing `0` baseline until the business supplies a real figure.
2. **`computeExchangeProfit(currencyGiven, amountGiven, amountReceived,
   rateUsed)`** (new, `src/domain.js`) implements the confirmed formula and
   direction rule above, returning `0` whenever no Sale Rate has ever been
   set. `POST`/`PATCH /api/transactions` both use the same
   override-with-server-fallback shape already used for `rateUsed` and
   `amountReceived` on the same routes: an explicit `profitUsd` in the
   request always wins; when it's omitted, the server computes it fresh
   from the current Sale Rate rather than defaulting to `0` — so the
   automatic figure is authoritative even for a caller that bypasses the
   UI.
3. **Frontend**: a new "Sale Rate" section sits directly below the existing
   Daily Rate section on Money Exchange's "Rate history" tab — its own
   stat strip (Current/Highest/Lowest/Changes), its own history table, and
   its own "Set sale rate" button/modal (`SaleRateControl`, mirroring the
   topbar's `RateControl`) — gated by `perm("rateManage")`, same as the
   Daily Rate control. It was deliberately placed on this tab rather than
   in the topbar next to the Daily Rate: unlike the Daily Rate, staff don't
   need the Sale Rate at a glance on every screen — it's a back-office
   figure only Money Exchange's own Profit calculation actually needs.
   On the New/Edit Exchange Transaction form, the Profit field now
   live-recomputes from the Sale Rate spread as Amount given, Currency
   given, or Rate change (`autoProfit`, kept in exact sync with the
   server's own formula) — until the person types into the field directly,
   at which point it stops auto-tracking (a "Manually set — not tracking
   the Sale Rate spread" hint appears, with a "Use automatic value ($X.XX)"
   link to switch back). Editing an *existing* transaction starts in the
   manual state (so opening the edit form never silently rewrites a figure
   someone already chose) rather than immediately recomputing.
4. **New Playwright coverage** (4 checks, `npm run test:e2e` now **301
   checks**): the Sale Rate section renders correctly
   unset ("Not set" / "No sale rate set yet") the first time it's opened;
   the Set sale rate modal opens, validates, and persists to its own
   history; a new exchange transaction's Profit field live-computes the
   correct spread as Amount given changes; and manually editing Profit
   shows the "Manually set" hint plus a working "Use automatic value" link
   that reverts to live-tracking. `test/rbac.js` gained 8 checks:
   `GET /api/sale-rate` requires authentication; `POST` is blocked for a
   role without `rateManage` (Cashier) and succeeds for one that has it
   (Admin and, separately, Manager — same gate as the Daily Rate); with no
   Sale Rate ever set, a new exchange's profit stays at the pre-existing
   `0` baseline; the USD→SLSH and SLSH→USD directions each compute the
   confirmed formula with the correct sign; and an explicit `profitUsd`
   always overrides the auto-computed spread on both create and update. No
   `ensureColumn` was needed (a brand-new table), so `npm run
   test:migration` needed no new checks — it was re-run to confirm zero
   regressions. `npm run test:rbac`, `npm run test:e2e`, and `npm run
   test:migration` all pass.

**Follow-up (SALE RATE also in the header + Dashboard).** After the round
above shipped, the person asked for the Sale Rate to also appear in the
topbar header (next to the Daily Rate) and on the Dashboard, matching a
screenshot of the existing Daily Rate header control — overriding this
round's original placement decision (Rate history tab only). Implemented by
reusing the same `SaleRateControl` component (already built with its own
"Recent history" list, matching the Daily Rate modal's pattern) in two more
places:

- **Topbar header**: right next to the Daily Rate display, separated by a
  thin vertical divider — `Sale: SLSH X,XXX` / `Sale: not set` plus its own
  "Set sale rate" button.
- **Dashboard**: inside the existing "Currency converter" card, below the
  Daily Rate conversion line — `Sale rate: SLSH X,XXX` / `Sale rate: not
  set` plus its own "Set sale rate" button.

Both are gated by `perm("rateManage")` — unlike the Daily Rate's header
display, which is public to every role. This is a deliberate divergence:
the Sale Rate is the wholesale/cost figure the business sources currency
at, a back-office number, so a role without `rateManage` (e.g. Cashier)
should not see it at all, not merely be unable to change it. `App()` fetches
`/api/sale-rate` once (alongside the existing Daily Rate fetch) and passes
`saleRate`/`onSaleRateChanged` down to both the header and `<Dashboard>` as
props, the same way `rate`/`setRate` already flow to `RateControl`.

**New Playwright coverage** (3 checks, `npm run test:e2e` now **304
checks**): the topbar header shows a labeled Sale Rate block reading `SLSH
8,650` with a working "Set sale rate" button once a Sale Rate has been set;
the Dashboard's currency converter card shows the same `Sale rate: SLSH
8,650` line and its own "Set sale rate" button for a `rateManage` holder;
and — logged in as Cashier (no `rateManage`) — neither the header, the
Dashboard, nor anywhere else in the app shows a "Sale Rate" label, "Sale
rate:" line, or a "Set sale rate" button. No schema or backend route
changed, so `test:rbac` and `test:migration` needed no new checks — both
were re-run to confirm zero regressions. All three suites pass.

**Follow-up (SALE RATE header layout).** The initial header placement ran
the Daily Rate and Sale Rate together on one continuous line, separated
only by a thin vertical divider — flagged as reading like one merged
figure rather than two distinct rates. Fixed by giving each rate its own
small bordered block with an uppercase label above the value (`TODAY RATE`
/ `SALE RATE`, each with its own "Set …" button inside the block) — the two
now read as clearly separate, table-like cells rather than one run-on line,
matching the layout the person asked for. Purely a header-markup change
(`App()`'s topbar JSX); no props, routes, or the Dashboard's own Sale Rate
line changed. The two Playwright checks that read the header's daily/sale
rate values via `innerText()` were updated for the new labels — worth
noting `text-transform: uppercase` in CSS makes `innerText()` return the
visually-rendered `TODAY RATE`/`SALE RATE` (not the literal JSX text), so
those two checks match case-insensitively.

**Latest round (RATE MANAGEMENT UNIFICATION).** The person sent a detailed
21-point spec asking to merge the two separate Daily Rate / Sale Rate
controls (header cards, modals, and — critically — their two separate
history lists) built across the rounds above into ONE "Exchange Rates"
system: one header card, one "Manage Rates" form that sets both rates
together, and one unified history where every save produces exactly one
combined record (never two). Before writing any code, two architecturally
expensive-to-reverse questions were put to the person directly:

1. **Permissions** — keep the single existing `rateManage` permission
   (recommended) vs. split it into the spec's proposed 7 granular
   permissions (view/create/update-daily/update-sale/delete/view-history/
   export-history). **Answer: keep the single `rateManage` permission** —
   every rate action (view, save, export) stays gated on it, exactly as
   Daily Rate and Sale Rate already were.
2. **Currency pairs** — keep USD→SLSH only, just relabeled clearly
   (recommended, since it's the only pair the business uses) vs. build a
   full multi-currency-pair-ready architecture now even though no second
   pair exists yet. **Answer: build the full multi-pair-ready system now.**
   Given that answer, the schema and lookups (`rate_history.currency_pair`,
   a `PAIR_LABELS` map) were made genuinely pair-aware — a real second pair
   could be added later with zero schema changes — but `computeExchangeProfit`
   and `getCurrentRate`/`getCurrentSaleRate` were deliberately **not**
   forked into independent per-pair logic, to avoid risking the
   already-verified profit formula (SALE RATE / EXCHANGE PROFIT round
   above) for a capability the business doesn't use yet. This trade-off
   was a judgment call, not put back to the person as a further question.

**What changed:**

1. **One new table, `rate_history`** (`schema.sql`) — `daily_rate` and
   `sale_rate` stay genuinely separate columns (never merged into one
   number, per spec point 4), but every save writes exactly ONE row
   carrying both current values (per spec points 7/9/11) — resolving what
   initially reads as a contradiction in the spec: separate *fields* but
   unified *history* are not actually in tension once history is modeled
   as "one row, two columns" rather than "one row per rate." A brand-new
   table, so no `ensureColumn` ordering hazard.
2. **One-time migration** (`db.js`) — a real installation already has
   months of history split across the two OLD tables (`exchange_rates`,
   `sale_rates`, both kept in the schema untouched for this purpose).
   A two-pointer chronological merge walks both tables together, always
   taking whichever next event happened earliest and carrying forward the
   *other* side's then-current value, producing a fully unified history
   with zero granularity loss from either original source. Guarded on
   `rate_history` being empty, so it runs exactly once.
3. **`saveRateHistory()`** (`domain.js`) — the single save path behind
   every rate-changing action in the app now and going forward. Carries
   forward whichever side isn't explicitly passed, computes
   `rate_difference = dailyRate - saleRate` (nullable if either side is
   unset — matching the already-confirmed Exchange Profit spread
   direction, shown with its honest real sign rather than force-matching
   the spec's own inconsistent illustrative examples), and inserts exactly
   one row.
4. **Backward-compatible old endpoints** — `GET`/`POST /api/rate` and
   `GET`/`POST /api/sale-rate` (`routes/rate.js`, `routes/saleRate.js`)
   keep their exact original request/response shapes, but now read/write
   through the shared `rate_history` table underneath via
   `saveRateHistory()`. This was a deliberate blast-radius-minimization
   choice: the 13+ pre-existing RBAC/e2e checks that exercise those two
   endpoints needed zero changes.
5. **New unified endpoint, `routes/rateHistory.js`** — `GET
   /api/rate-history` (search/status/pair/date-range filtering, sortable,
   returns a summary strip: current Daily/Sale/Spread, last updated, by
   whom), `GET /api/rate-history/export.csv` (registered *before* the
   `:id` route below it, since this router matches routes in registration
   order — `export.csv` would otherwise be swallowed as an `:id` value),
   `GET /api/rate-history/:id` (full detail record), and `POST
   /api/rate-history` (the combined Set Rates form — both Daily Rate and
   Sale Rate required together, matching how the unified form actually
   saves). All four gated on `rateManage`.
6. **`scripts/seed.js` fixed to write into `rate_history`** instead of the
   now-dead-for-writes `exchange_rates` table — caught before shipping via
   a re-read of the seed script; otherwise demo data would have silently
   become invisible to the new `getCurrentRate()`. `rate_history` was also
   added to the `--force` wipe list.
7. **Frontend** (`frontend/app.jsx`) — the header's two separate bordered
   cards from the HEADER LAYOUT follow-up above are replaced with ONE
   "Exchange Rates" card (Daily / Sale / live Spread, one "Manage Rates"
   button), still gated on `rateManage` with the same public
   `1 USD = SLSH X` fallback for everyone else. `RateControl` and
   `SaleRateControl` are deleted entirely. A new `ManageRatesModal` is the
   one combined Set Rates form (Date/From/To read-only, Daily Rate + Sale
   Rate inputs, a live-computed "Rate Difference" that updates as you
   type — never manually entered — Note, Cancel/Save Rates), reused in
   three places: the header, the Dashboard card, and Money Exchange's
   rebuilt "Rate history" tab. That tab now shows one summary strip, one
   search/status-filter/sort-controlled table (Date, Currency Pair, Daily
   Rate, Sale Rate, Rate Difference, Status, Updated By, Actions), CSV
   export, and a `RateHistoryDetailModal` behind each row's "View" action
   — replacing the old separate Daily Rate History / Sale Rate History
   stat-strip-plus-table sections entirely. "Active"/"Expired" status is
   computed (the row matching the table's single latest timestamp is
   Active), not stored.

**Test coverage.** `npm run test:rbac` gained **8 new checks** for
`/api/rate-history` (auth required; blocked for Cashier on both GET and
POST; GET reflects rates set via the OLD endpoints too — proving one
shared history; POST saves one combined record and computes the
difference, and is also confirmed visible back through the OLD `/api/rate`
+ `/api/sale-rate` endpoints; `GET /:id` detail and 404; Manager also
succeeds; `export.csv` gated and returns a real CSV) — **85 checks total**,
all passing. `npm run test:migration` gained a 4th scenario, **rate
history unification migration safety test**: builds a realistic
pre-existing database with 3 hand-picked Daily Rate + 3 Sale Rate legacy
events at precisely interleaved timestamps, wipes `rate_history` to
simulate a pre-this-round install, starts the server exactly as `npm
start` would, and asserts the merge produces exactly 6 rows whose
carry-forward Daily/Sale Rate and computed Rate Difference match the
two-pointer algorithm's expected output at every single step, that the
final row reflects the correct current state, and that a second restart
adds zero further rows (idempotency) — all 4 scenarios pass. `npm run
test:e2e`'s old separate stat-strip/history checks were replaced with 5
checks against the unified UI (summary strip with Sale Rate correctly
unset by default; the Set Rates modal computing the Rate Difference live
and saving ONE combined record proven by the newest row containing both
new values; the unified header card; the unified Dashboard card; the
exchange-transaction auto-profit still tracking the Sale Rate spread
correctly) and the cashier negative-gating check was updated for the new
UI text (`"EXCHANGE RATES"`/`"Manage Rates"`/`"Set Rates"` instead of the
retired `"Set sale rate"` string) — **303 checks total**, all passing.

## Limitations & upgrade path

- **Database**: MySQL 8.0.16+ via `mysql2`, used through a synchronous
  bridge (one connection, one query at a time — the same serial model the
  app had with SQLite). Simple and safe for one business's traffic; a very
  busy installation would move to an async connection pool, which means
  making the route handlers async. The table structure is generated from
  the last SQLite schema (`src/mysql/schema.json`, rebuilt with
  `scripts/dev/generate-mysql-schema.js`).
- **Excel export**: real `.xlsx` needs a binary OOXML writer, which isn't
  something to hand-roll without a way to verify the output opens
  correctly. Every export is **CSV** instead — opens natively in Excel and
  Google Sheets, same data, no native `.xlsx` styling. Add `exceljs` when
  you have registry access and swap it into `src/csv.js`'s call sites.
- **HTTPS**: plain HTTP, fine for local use. Put it behind a reverse proxy
  (nginx, Caddy) or your host's TLS termination before exposing it publicly.
- **Framework**: no Express — a ~40-line router in `src/router.js`. A
  dependency-count trade-off, not a recommendation; swap in Express if the
  team prefers its ecosystem and battle-tested body parsing.
- **JWT**: hand-rolled HS256 in `src/auth.js` using only `crypto` — correct
  (constant-time comparison, expiry checked), but `jsonwebtoken` gets you
  refresh tokens and key rotation for free at scale.
- **Fonts**: the page loads Inter and JetBrains Mono from Google Fonts for
  a clean, modern look; it falls back to system fonts if that's blocked
  (e.g. an offline or locked-down network) — purely cosmetic, never
  functional.
- **Client records**: `clients` are auto-created/deduplicated by name. No
  dedicated client management UI — add `routes/clients.js` if needed.
- **Money storage**: amounts are stored as `DOUBLE` (floating-point, exactly as the earlier SQLite `REAL`)
  and computed with ordinary JS arithmetic, not fixed-point decimals or
  integer minor units (cents). This is standard practice for a system this
  size and the numbers you'll see are correct at display precision, but a
  production system handling very large transaction volumes should switch
  to integer minor-unit storage (or a decimal library) to eliminate any
  theoretical floating-point rounding drift over millions of operations.
- **Accent Color contrast**: the sidebar's active-submenu text and the
  "accent" button tone both use a fixed dark text color (`#04303c`) against
  the Accent Color background, tuned for the default `#42bfdd`. A very dark
  custom Accent Color (from Global Colors or a Theme Preset) can reduce
  contrast there — worth a quick visual check after picking one, same as
  any custom-color feature.
- **Font Size scaling**: applied as a CSS `zoom` on `<html>` rather than a
  full rem-based refactor of the file's many hardcoded px sizes — the
  practical result is the same (everything scales together), but `zoom` is
  a long-supported Chromium/Edge/Safari property rather than a universal
  CSS standard. Fine for this app's actual runtime; worth knowing if it's
  ever embedded in a strict-standards browser context.
