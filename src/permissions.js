"use strict";
// Central catalog of every granular permission this app understands, plus
// the mapping from the OLD coarse permission keys (the flat booleans
// src/rbac.js used to hard-code per role) to the new granular ones.
// SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 1: this
// file has ZERO dependency on db.js on purpose — both db.js (at seed time)
// and rbac.js (at request time) require it, and a require of db.js from
// here would be circular.
//
// MODULES below matches what this app actually has today (Accounts,
// Exchange, Transfers, Quotations, Deposits & Withdrawals, Reports, Audit
// Log, Settings, Users, Roles), not a generic template — every action listed
// is a real, distinct capability somewhere in the codebase, even where
// Phase 1 doesn't yet wire a check to it directly (some are reserved for the
// Phase 2 Role/User Management UI and the Phase 3 full enforcement sweep).

const ACTION_LABELS = {
  view: "View", viewAll: "View All (not just own)", create: "Create", update: "Update", delete: "Delete",
  deactivate: "Deactivate", activate: "Activate", export: "Export", print: "Print",
  manageRate: "Set Exchange Rate", settle: "Settle (Pay/Refund)", duplicate: "Duplicate",
  resetPassword: "Reset Password", assignRole: "Assign Role", managePermissions: "Manage Permissions",
  // TABLE CUSTOMIZATION round: a brand-new, granular-only capability (no
  // legacy equivalent, same precedent as users.managePermissions) — sets
  // the SYSTEM-WIDE default column layout/density for a list table, which
  // every user who hasn't saved their own personal layout inherits.
  manageTableDefaults: "Manage Table Defaults",
  // ENTERPRISE FINANCIAL DASHBOARD round: same "brand-new, granular-only"
  // precedent as manageTableDefaults above — customize (show/hide/reorder/
  // resize widgets, system-wide default) and export (PDF/CSV/Print) are each
  // their own gated action per spec, distinct from just VIEWING the
  // dashboard (which every authenticated user can already do — individual
  // widgets are gated by the same existing reports/exchangeCreate/
  // exchangeAll/quotationsManage/quotationsApprove/accountsManage keys the
  // rest of the app already uses, not a new per-widget catalog).
  customizeDashboard: "Customize Dashboard",
  exportDashboard: "Export Dashboard",
  // CURRENCY / RATE / PROFIT PERMISSIONS round: brand-new action labels for
  // the three modules added below. usd/slsh have no generic ACTION_LABELS
  // equivalent (they're not a CRUD verb, they're which currency's accounts
  // are visible at all), so they're spelled out fully rather than composed
  // with a module suffix that would otherwise read "USD — Account/Currency
  // Access" (kept short instead: see MODULES.currency's own label).
  usd: "USD", slsh: "SLSH",
  updateDaily: "Update Daily Rate", updateSale: "Update Sale Rate",
  viewHistory: "View History", exportHistory: "Export History",
  viewCompany: "View Company", viewExchange: "View Exchange", viewDashboard: "View Dashboard", viewReports: "View Reports",
  // ACCOUNT IMPORT & EXPORT round: brand-new, granular-only capabilities (no
  // legacy equivalent — the old flat PERMS never had bulk import at all).
  // import gates uploading/previewing/committing a bulk accounts file;
  // importOpeningBalance is a SEPARATE, narrower gate specifically for
  // letting an imported row set a NEW account's opening balance (a real
  // financial entry via the existing opening-balance mechanism) — a role can
  // have accounts.import (create/update master data in bulk) without also
  // being trusted to seed opening balances, same "split the risky part out"
  // precedent as rates.delete vs rates.create.
  import: "Import", importOpeningBalance: "Import Opening Balances",
  // CASH IN HAND round: brand-new, granular-only action labels for the two
  // modules added below (no legacy equivalent — neither feature existed
  // before this round).
  deposit: "Record Credit", withdraw: "Record Debit",
  transfer: "Transfer Between Accounts", exchange: "Exchange",
  repay: "Record Repayment", writeOff: "Write Off",
  // QUOTATION PAYMENT DELETE round: brand-new, granular-only capability (no
  // legacy equivalent — deleting an individual Quotation Payment record
  // never existed before this round) — distinct from quotations.delete,
  // which removes the whole quotation DOCUMENT, not one payment inside it.
  deletePayment: "Delete Payment",
  // COMPANY EXPENSES round.
  cancel: "Cancel / Reverse", manageCategories: "Manage Categories",
};

const MODULES = {
  accounts: { label: "Accounts", actions: ["view", "create", "update", "delete", "deactivate", "activate", "export", "print", "import", "importOpeningBalance"] },
  exchange: { label: "Exchange", actions: ["view", "viewAll", "create", "update", "delete", "manageRate", "export", "print"] },
  transfers: { label: "Transfers", actions: ["view", "create", "update", "delete"] },
  // QUOTATION PAYMENT DELETE round: "deletePayment" added — a SEPARATE,
  // narrower gate than "delete" (which removes the whole quotation
  // document). Super Admin always has both automatically (ALL_ACCESS); no
  // other role gets deletePayment by default (not in ADMIN_EXTRA_GRANTS —
  // same "Super Admin only until explicitly granted" precedent as cash.*/
  // loans.* below), since it reverses real money already recorded as paid.
  quotations: { label: "Quotations", actions: ["view", "create", "update", "delete", "settle", "duplicate", "export", "print", "deletePayment"] },
  payments: { label: "Credits & Debits", actions: ["view", "create", "update", "delete", "export", "print"] },
  reports: { label: "Reports", actions: ["view", "export", "print"] },
  auditLog: { label: "Audit Log", actions: ["view"] },
  settings: { label: "Settings", actions: ["view", "update", "manageTableDefaults"] },
  users: { label: "Users", actions: ["view", "create", "update", "deactivate", "activate", "delete", "resetPassword", "assignRole", "managePermissions"] },
  roles: { label: "Roles & Permissions", actions: ["view", "create", "update", "delete", "managePermissions"] },
  // ENTERPRISE FINANCIAL DASHBOARD round: no "view" action here on purpose —
  // the dashboard itself is universally viewable (requireAuth only, like the
  // pre-existing Dashboard), matching spec's own "every role sees SOME
  // dashboard, scoped by their other real permissions" model (items 45-47).
  dashboard: { label: "Dashboard", actions: ["customize", "export"] },
  // CURRENCY / RATE / PROFIT PERMISSIONS round: three new, independent
  // permission groups added ON TOP of the existing granular catalog (not a
  // replacement of anything above) — see src/rbac.js's allowedCurrencies()/
  // hasCurrencyAccess() and the enforcement added to routes/accounts.js,
  // routes/ledger.js, routes/transfers.js, routes/transactions.js,
  // routes/rate.js, routes/rateHistory.js, routes/saleRate.js.
  //
  // currency.usd / currency.slsh scope which currency's ACCOUNTS a user can
  // see or touch at all, everywhere an account, its balance, or its ledger
  // appears — this is a data-scoping permission, not a CRUD action on a
  // "currency" resource, hence the short usd/slsh action names.
  currency: { label: "Account / Currency Access", actions: ["usd", "slsh"] },
  // rates.* replaces the single coarse "rateManage" flag with the finer
  // split the spec asks for. rates.create gates the unified POST
  // /api/rate-history endpoint (sets Daily + Sale Rate together in one new
  // rate_history row — see its own comment for why that's the one true
  // "create a new rate entry" action); rates.updateDaily/updateSale gate the
  // single-value legacy POST /api/rate and POST /api/sale-rate endpoints
  // respectively; rates.delete has no legacy endpoint at all (routes/
  // rateHistory.js gains a new DELETE /api/rate-history/:id for it).
  rates: { label: "Rate Management", actions: ["view", "create", "updateDaily", "updateSale", "delete", "viewHistory", "exportHistory"] },
  // profit.viewExchange gates the one real profit figure this app has today
  // (exchange_transactions.profit_usd, shown as `profitUsd` on every
  // exchange transaction and as the "Profit (USD)" column in its CSV
  // export). profit.viewCompany/viewDashboard/viewReports/export are seeded
  // and selectable now (per spec item 13's full toggle set) but reserved —
  // there is no separate company-wide profit dashboard or dedicated Profit
  // Reports page anywhere in this app yet to gate with them; they'll wire up
  // the moment one is built, the same "reserved for a later round" pattern
  // already used above for several settings/users/roles actions.
  profit: { label: "Profit & Financial Visibility", actions: ["viewCompany", "viewExchange", "viewDashboard", "viewReports", "export"] },
  // CASH IN HAND round: company-owned cash accounts (bank/mobile money/
  // physical cash), fully separate from the customer-facing `accounts`
  // module above — see schema.sql's cash_accounts/cash_ledger table family.
  // No legacy equivalent exists (this feature is brand new), so every one of
  // these keys is granular-only, same precedent as `currency`/`rates`/
  // `profit` above. Per spec: Super Admin always has full access (the usual
  // ALL_ACCESS bypass); Admin gets NOTHING here by default and must be
  // explicitly granted by a Super Admin via Roles Management — so, unlike
  // most other modules, this is deliberately left OUT of ADMIN_EXTRA_GRANTS
  // in db.js.
  cash: { label: "Cash Account", actions: ["view", "create", "update", "deactivate", "activate", "delete", "deposit", "withdraw", "transfer", "exchange"] },
  // LOAN/DEBT feature, built alongside Cash in Hand (every loan draws from a
  // specific Cash Account) — see cash_loans/cash_loan_payments in
  // schema.sql. Same "no legacy equivalent, Super Admin only by default"
  // treatment as `cash` above.
  loans: { label: "Loans & Debts", actions: ["view", "create", "repay", "writeOff", "delete"] },
  // COMPANY EXPENSES round: the company's own spending, paid out of a Cash in
  // Hand account (see routes/expenses.js). Granular-only (no legacy flag);
  // Admin receives all of these by default (db.js ADMIN_EXTRA_GRANTS), any
  // other role only when a Super Admin grants them. "view" also covers the
  // expense dashboard and reports; "export" gates CSV/PDF/Excel downloads.
  expenses: { label: "Company Expenses", actions: ["view", "create", "update", "cancel", "manageCategories", "export"] },
};

function permKey(moduleKey, action) {
  return `${moduleKey}.${action}`;
}

// Flat list, e.g. [{ key: "accounts.view", module: "accounts", moduleLabel: "Accounts", action: "view", label: "View Accounts" }, ...]
const PERMISSION_CATALOG = [];
for (const [moduleKey, mod] of Object.entries(MODULES)) {
  for (const action of mod.actions) {
    PERMISSION_CATALOG.push({
      key: permKey(moduleKey, action),
      module: moduleKey,
      moduleLabel: mod.label,
      action,
      label: `${ACTION_LABELS[action] || action} — ${mod.label}`,
    });
  }
}
const PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
function isValidPermissionKey(key) {
  return PERMISSION_KEYS.has(key);
}

// LEGACY COMPATIBILITY — the exact old coarse keys from src/rbac.js's
// PERMS object (and the frontend's duplicated copy), each mapped to the
// granular key(s) that together reproduce its old meaning. A legacy key
// resolves true only when the role/user has ALL of its mapped granular
// keys — this is what lets Phase 1 swap the resolution ENGINE (static
// object -> dynamic DB-backed roles) without changing behavior for the 52
// backend + 59 frontend call sites that still check these old names; that
// call-site sweep to the granular keys directly is Phase 3's job.
const LEGACY_KEY_MAP = {
  // routes/users.js's single PATCH /api/users/:id endpoint — gated only by
  // "users" — already lets a "users"-permitted caller toggle body.active
  // (deactivate/activate), change body.password (reset), and reassign
  // body.role (assign role), all through the one flag; there was never a
  // finer-grained split. users.delete and users.managePermissions have no
  // legacy equivalent at all (no DELETE endpoint or override system existed
  // before this round) and are granted separately (see ADMIN_EXTRA_GRANTS
  // in db.js), not from this key.
  users: ["users.view", "users.create", "users.update", "users.deactivate", "users.activate", "users.resetPassword", "users.assignRole"],
  rateManage: ["exchange.manageRate"],
  // The Exchange sidebar item itself is gated by `exchangeCreate ||
  // exchangeAll` in app.jsx (NOT universally visible like Accounts) — so
  // exchange.view has to come from either legacy flag, same OR-via-union
  // technique used for payments.view under accountsManage/reports below.
  exchangeCreate: ["exchange.create", "exchange.view"],
  exchangeAll: ["exchange.viewAll", "exchange.view"],
  exchangeUpdate: ["exchange.update"],
  exchangeDelete: ["exchange.delete"],
  transferUpdate: ["transfers.update"],
  transferDelete: ["transfers.delete"],
  quotationsManage: ["quotations.create", "quotations.update", "quotations.settle", "quotations.duplicate", "quotations.view"],
  // quotationsApprove is, in the actual app, purely a VIEW-level flag: it
  // shows the Quotations sidebar group (Pending/Paid/Refunded tabs) to
  // roles like Manager who couldn't otherwise see it, but the Settle/Edit/
  // Duplicate/Delete buttons all separately require quotationsManage (see
  // app.jsx lines ~1665-1668) and the Pay/Refund API endpoints only check
  // quotationsManage too (routes/quotations.js) — quotationsApprove never
  // actually gates a settle action on its own today, despite its name.
  quotationsApprove: ["quotations.view"],
  quotationsDelete: ["quotations.delete"],
  // "reports" today also gates the Audit Log tab (it lives inside the
  // Reports page — /api/reports/audit-log[/export.csv|.pdf] — there is no
  // separate audit-log flag in the old PERMS), and it gates every report's
  // CSV/PDF export the same way it gates viewing (see routes/reports.js and
  // routes/history.js — every endpoint checks the single "reports" flag,
  // list or export alike). It is ALSO one of the two ways to satisfy
  // routes/ledger.js's canView() (accountsManage OR reports) — see the
  // payments.* note under accountsManage below for why payments.view/
  // export/print appear in BOTH mappings rather than just one.
  reports: ["reports.view", "reports.export", "reports.print", "auditLog.view", "payments.view", "payments.export", "payments.print"],
  // accountsManage also happens to be the real gate on:
  //  - creating a Transfer (POST /api/transfers checks accountsManage, not
  //    a transfer-specific flag — a Transfer is initiated from an account's
  //    own Quick Actions);
  //  - creating a deposit/withdrawal from an account's Quick Actions
  //    (POST /api/accounts/:id/deposit and /:id/withdraw in
  //    routes/accounts.js both check accountsManage, not a payments-
  //    specific flag);
  //  - editing/deleting a plain (unlinked) deposit or withdrawal ledger
  //    entry (PATCH/DELETE /api/account-ledger/:id in routes/ledger.js);
  //  - viewing/exporting the account ledger at all — routes/ledger.js's
  //    canView() is `accountsManage OR reports`, an OR a single mapping
  //    entry can't express on its own. Listing payments.view/export/print
  //    under BOTH accountsManage and reports (and unioning per-role at seed
  //    time) reproduces that OR exactly: a role gets ledger-view if it has
  //    EITHER legacy flag, matching production behavior today.
  accountsManage: [
    "accounts.create", "accounts.update", "accounts.deactivate", "accounts.activate",
    "transfers.create",
    "payments.create", "payments.update", "payments.delete", "payments.view", "payments.export", "payments.print",
  ],
  accountsDelete: ["accounts.delete"],
  // Settings > General is entirely gated by settingsManage — there is no
  // separate "view only" mode in the current app (view and update share one
  // flag), so settings.view has to come from the same legacy key as
  // settings.update, not from a universal grant.
  settingsManage: ["settings.view", "settings.update"],
};

module.exports = { MODULES, ACTION_LABELS, PERMISSION_CATALOG, PERMISSION_KEYS, isValidPermissionKey, LEGACY_KEY_MAP, permKey };
