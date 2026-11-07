# FINMAN — System Audit, Security Check & Repair (November 2026)

Scope: the whole application in this repository, inspected from source and verified by running it against throw-away MySQL databases (never production data). Nothing was deployed; no production record was read or changed.

## 1. System map (discovery)

| Layer | What it is |
|---|---|
| Frontend | One React single-page app (`frontend/app.jsx`, bundled to `public/app.bundle.js` by esbuild). Lucide-style inline SVG icons, Inter, tabular numerals. Somali/English via `src/i18n/so.json`. |
| Backend | Node 22, own HTTP router (`src/server.js`, `src/http-helpers.js`), 33 route modules with 249 endpoints (`src/routes/*.js`), shared domain code in `src/*.js`. |
| Database | MySQL 8. Control tables (companies, platform users, directory, sessions) + 46 per-company tables prefixed `cmpXXXX_` (`src/mysql/schema.json`, additive DDL via `ensureScope`). Every request is bound to one company (`src/tenancy.js`). |
| Auth | PBKDF2-SHA512 (100 000 rounds) password hashes, HMAC-signed tokens (12 h), server-side revocation on sign-out, per-username and per-IP lockout, forced change of published default passwords. |
| Authorization | Role-based (`roles`, `role_permissions`, `user_permission_overrides`), 118 granular permissions in `src/permissions.js`, enforced in every route by `requirePerm`; currency (USD / SLSH) and per-account access scopes; sessions end as soon as a role or a user's permissions change. |
| Background jobs | Daily snapshot scheduler and daily financial history (`src/daily-snapshots.js`, `src/daily-history.js`), backup scheduler (`src/backup.js`). |
| Documents | PDF engine (`src/pdf.js`, company PDF templates), Excel engine (`src/xlsx-engine.js`, company Excel templates). |
| External services | None at runtime (no payment, e-mail or cloud API). GitHub only for source control. |

Main data flows: Accounts ← Payments (credits / debits) ← Cash Accounts; Money Exchange → customer accounts + Cash Accounts + profit; Transfers → two accounts; Quotations → charges and payments on accounts; Expenses → Cash Accounts; all of them → Transaction History, Reports, Dashboard, Daily Snapshots / Daily Financial History, Daily Operations.

## 2. Health summary

| Area | Status |
|---|---|
| Security | Good — no injection, XSS, CSRF or secret exposure found; one upload weakness fixed (A-02). One moderate third-party advisory left (A-07). |
| Financial integrity | Good — balances reconcile with their ledgers in every test company; the read-only integrity check was extended (A-04). |
| Database | Good — additive schema, company isolation verified. |
| API connections | Good — all module connections exercised by the regression suite. |
| PDF / Excel | Working; template permissions fixed (previous round); version history is a missing feature (A-09). |
| System time | **Fixed** — company calendar day now used everywhere (A-01, A-03). |
| Module integration | Good — Transaction History, reports, dashboard, daily history and Daily Operations reconcile. |
| Performance | Acceptable for current data sizes; see A-10. |

## 3. Issues found

| ID | Module | Description | Severity | Root cause | Repair |
|---|---|---|---|---|---|
| A-01 | Dates (all date filters) | A transaction made between 00:00 and 03:00 Mogadishu time was filed under the **previous** day in Transaction History, Payments ledger, Cash Account ledger, statements, reports, dashboard, transfers, exchange list, expenses and Daily Operations' list — while Daily Reports / Daily Operations cards counted it on the correct day, so the two disagreed. | High (financial reporting) | 30 SQL filters compared `DATE(stored UTC timestamp)` with the chosen day. | **Fixed** — `src/company-day.js`: a day filter now means the company's calendar day (its Daily Snapshot time zone, default Africa/Mogadishu); bare dates are still compared as dates. Verified failing before / passing after (`test/company-day.js`). |
| A-02 | Company settings / Platform | Logo and favicon uploads were accepted on the strength of the `data:image/png;base64,` prefix only; any bytes could be stored and later fed to the PDF / Excel engines. | Medium (security) | Prefix-only validation. | **Fixed** — `src/image-validate.js` checks the decoded bytes are really PNG / JPEG / ICO (company settings and platform company edit). |
| A-03 | "Today" defaults | `todayStr()` (server) and the browser's default date were the UTC date — between 00:00 and 03:00 local, a payment / quotation without a date was given yesterday's date, and the dashboard's "Today" was yesterday. | High (dates) | `new Date().toISOString().slice(0, 10)`. | **Fixed** — server uses the company day; browser uses the local day; dashboard ranges start from the company day. |
| A-04 | Integrity checker | The read-only integrity check did not look for cross-currency ledger rows, cross-currency transfers, duplicate references or exchange arithmetic errors. | Low | Not covered. | **Fixed** — added to `scripts/integrity-check.js` (still read-only, never repairs). |
| A-05 | Templates permissions | `pdfTemplates.manage` / `excelTemplates.manage` were not in the permission registry — only Super Admin could ever use the template pages. | Medium | Unregistered keys. | **Fixed** in the Roles & Permissions round (granular view / create / update / delete). |
| A-06 | Quotations sort | "Oldest First" did not order quotations by date inside the page. | Low | Sort comparator ignored the table's own date field. | **Fixed** in the sorting round. |
| A-07 | Dependencies | `exceljs` depends on `uuid` < 11.1.1 (GHSA-w5hq-g745-h8pq, moderate: buffer bounds check in v3/v5/v6 **when a buffer is passed**). FINMAN never calls uuid with a buffer. | Low (not reachable) | Upstream. | **Needs approval** — the only automatic fix downgrades exceljs to 3.4 (breaking). Recommend waiting for an exceljs release. |
| A-08 | Existing system roles | Seeded Manager, Accountant and Sales roles hold critical delete permissions (e.g. Manager: accounts.delete, payments.delete, quotations.delete); Cashier / Teller has no Cash In / Cash Out. | Medium (least privilege) | Inherited from the original coarse roles. | **Needs approval** — changing them would change what current users can do. The recommended templates are ready (Users & Roles → New role → Start from). See `docs/RBAC-AUDIT.md`. |
| A-09 | PDF / Excel templates | No version history / restore-previous-version (only archive, restore, reset to defaults, duplicate). | Medium (missing feature) | Not built. | **Needs approval** — new feature (schema + UI). |
| A-10 | Performance | Account View / Transaction History load full result sets per page request (server-side paging exists for Transaction History). Fine at current volumes. | Low | Design. | Monitor; no change. |
| A-11 | Users across companies | A user belongs to exactly one company (company databases are separate). Assigning one login to several companies is only possible for platform Super Admins. | — | Architecture (tenant separation). | **Needs approval** — would touch tenant separation; not changed. |

Checked and found sound (no change needed): password hashing, constant-time comparison, login lockout, failed-login and permission-change audit entries (passwords / tokens never logged), session revocation on sign-out, session end on role / permission change and on deactivation, `X-Frame-Options`, `X-Content-Type-Options`, Content-Security-Policy, CORS limited to the own origin, Bearer tokens (no cookies → no CSRF), parameterised SQL (interpolated parts are internal constants or whitelisted sort columns), no `dangerouslySetInnerHTML`, 5 MB request limit, generic 500 messages, no secrets in the repository, company isolation of every module, idempotency keys on postings.

## 4. Files changed in this audit round

- `src/company-day.js` (new) — company calendar day, day-range SQL.
- `src/image-validate.js` (new) — real-image check for uploads.
- `src/util.js` — `todayStr()` uses the company day.
- `src/routes/history.js`, `ledger.js`, `cash.js`, `transfers.js`, `transactions.js`, `reports.js`, `accounts.js`, `accountStatements.js`, `cashAccountStatements.js`, `dashboard.js`, `src/expenses.js` — day filters.
- `src/routes/settings.js`, `src/routes/platform.js` — upload validation.
- `scripts/integrity-check.js` — extra read-only checks.
- `frontend/app.jsx` — local "today".
- `test/company-day.js` (new), `package.json`.

No database migration was needed. No record was changed.

## 5. Test results

Executed on throw-away databases (MySQL 8 + Chromium), 48 suites, 1012 checks passed, failing suites: none.

| Suite | Result |
|---|---|
| account-access | 19 checks passed, 0 failed. |
| account-fields | 7 checks passed, 0 failed. |
| account-search | 11 checks passed, 0 failed. |
| account-view | 20 checks passed, 0 failed. |
| account-view-order | 10 checks passed, 0 failed. (re-run after fixes) |
| accounts-console | 19 checks passed, 0 failed. |
| audit | 14 checks passed, 0 failed. |
| audit-fixes | 15 checks passed, 0 failed. |
| balance-sheet | 36 checks passed, 0 failed. |
| bulk-search | 9 checks passed, 0 failed. |
| company-branding | 21 checks passed, 0 failed. |
| company-day | 7 checks passed, 0 failed. |
| copy-to-online | 6 checks passed, 0 failed. |
| customer-linking | 25 checks passed, 0 failed. |
| daily-history | 19 checks passed, 0 failed. |
| daily-ops | 27 checks passed, 0 failed. (re-run after fixes) |
| daily-reports | 42 checks passed, 0 failed. |
| dashboard | 23 checks passed, 0 failed. (re-run after fixes) |
| data-reset | 12 checks passed, 0 failed. |
| exchange-margin | 25 checks passed, 0 failed. |
| expenses | 39 checks passed, 0 failed. (re-run after fixes) |
| fund-selector | 26 checks passed, 0 failed. |
| global-login | 19 checks passed, 0 failed. |
| header | 43 checks passed, 0 failed. |
| history-console | 18 checks passed, 0 failed. (re-run after fixes) |
| import-negative | 6 checks passed, 0 failed. |
| integrity-security | 31 checks passed, 0 failed. |
| language | 25 checks passed, 0 failed. |
| mark-paid | 19 checks passed, 0 failed. |
| migration | 13 checks passed, 0 failed. |
| mysql | 22 checks passed, 0 failed. |
| numeric-typography | 13 checks passed, 0 failed. |
| opening-balance | 16 checks passed, 0 failed. |
| optional-notes | 14 checks passed, 0 failed. (re-run after fixes) |
| quick-exchange | 19 checks passed, 0 failed. |
| rbac | All RBAC checks passed. |
| rbac-advanced | 28 checks passed, 0 failed. |
| rbac-update | 17 checks passed, 0 failed. (re-run after fixes) |
| reconciliation | 14 checks passed, 0 failed. (re-run after fixes) |
| route-sweep | 12 checks passed, 0 failed. |
| same-name | 15 checks passed, 0 failed. |
| security | 29 checks passed, 0 failed. |
| table-design | 23 checks passed, 0 failed. |
| templates | 31 checks passed, 0 failed. |
| tenancy | 68 checks passed, 0 failed. |
| terminology | 12 checks passed, 0 failed. |
| transaction-history-unified | 34 checks passed, 0 failed. (re-run after fixes) |
| tx-sort | 39 checks passed, 0 failed. |

Also adjusted while running the suite: `test/optional-notes.js` now chooses "Newest First" before opening the latest exchange (the default in-page order is Oldest First since the sorting round); the integrity check's duplicate-reference rule ignores the legs an exchange / transfer / quotation posts under one shared reference.

Not run: `e2e` (pre-existing failure: it expects the old brand name "Geeska Exchange" on the sign-in page — unrelated). Manual verification recommended: printing on the office printer, and the app on a real phone.
