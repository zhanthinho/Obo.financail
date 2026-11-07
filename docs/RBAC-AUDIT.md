# FINMAN — Roles & Permissions Audit

Generated from the live permission registry (src/permissions.js) and a freshly created company. ✓ = granted. Level: S = standard, ▲ = sensitive, ■ = critical (needs an explicit confirmation to grant).

## 1. Roles found in every company (system roles, protected)

| Role | Permissions | Critical permissions held |
|---|---|---|
| Super Admin | All | all (built-in, cannot be deleted or narrowed) |
| Accountant | 34 | exchange.delete, payments.delete, transfers.delete |
| Admin | 75 | accounts.delete, accounts.importOpeningBalance, exchange.delete, expenses.cancel, payments.delete, quotations.delete, rates.delete, roles.create, roles.delete, roles.managePermissions, roles.update, settings.update, transfers.delete, users.assignRole, users.delete, users.managePermissions, users.resetPassword |
| Cashier / Teller | 10 | — |
| Manager | 38 | accounts.delete, payments.delete, quotations.delete |
| Sales Staff | 24 | payments.delete |
| Viewer / Auditor | 19 | — |

## 2. Recommended role templates (new / updated this round)

| Template | Permissions | Critical |
|---|---|---|
| Company Admin | 92 | 0 |
| Manager | 23 | 0 |
| Accountant | 30 | 0 |
| Cashier | 17 | 0 |
| Exchange Operator | 8 | 0 |
| Viewer / Read-Only | 22 | 0 |

Super Admin is the protected built-in role (every permission, platform-wide). The templates are starting points: Users & Roles → New role → Start from.

## 3. Complete permission matrix

| Permission | Level | Super Admin | Company Admin (template) | Manager (template) | Accountant (template) | Cashier (template) | Exchange Operator (template) | Viewer (template) | Admin (existing) | Manager (existing) | Accountant (existing) | Cashier / Teller (existing) | Sales Staff (existing) | Viewer / Auditor (existing) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `accounts.view` View — Accounts | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounts.create` Create — Accounts | S | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `accounts.update` Update — Accounts | S | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `accounts.delete` Delete — Accounts | ■ | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `accounts.deactivate` Deactivate — Accounts | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `accounts.activate` Activate — Accounts | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `accounts.export` Export — Accounts | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounts.print` Print — Accounts | S | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `accounts.import` Import — Accounts | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `accounts.importOpeningBalance` Import Opening Balances — Accounts | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `exchange.view` View — Exchange | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `exchange.viewAll` View All (not just own) — Exchange | S | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `exchange.create` Create — Exchange | S | ✓ | ✓ |  |  | ✓ | ✓ |  | ✓ |  | ✓ | ✓ |  |  |
| `exchange.update` Update — Exchange | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `exchange.delete` Delete — Exchange | ■ | ✓ |  |  |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `exchange.manageRate` Set Exchange Rate — Exchange | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `exchange.export` Export — Exchange | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `exchange.print` Print — Exchange | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `transfers.view` View — Transfers | S | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `transfers.create` Create — Transfers | ▲ | ✓ | ✓ |  |  | ✓ |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `transfers.update` Update — Transfers | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `transfers.delete` Delete — Transfers | ■ | ✓ |  |  |  |  |  |  | ✓ |  | ✓ |  |  |  |
| `quotations.view` View — Quotations | S | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `quotations.create` Create — Quotations | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  | ✓ |  |
| `quotations.update` Update — Quotations | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  | ✓ |  |
| `quotations.delete` Delete — Quotations | ■ | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `quotations.settle` Settle (Pay/Refund) — Quotations | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |  | ✓ |  |
| `quotations.duplicate` Duplicate — Quotations | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  | ✓ |  |
| `quotations.export` Export — Quotations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `quotations.print` Print — Quotations | S | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `quotations.deletePayment` Delete Payment — Quotations | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `payments.view` View — Credits & Debits | S | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| `payments.create` Create — Credits & Debits | ▲ | ✓ | ✓ |  | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `payments.update` Update — Credits & Debits | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `payments.delete` Delete — Credits & Debits | ■ | ✓ |  |  |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |  |
| `payments.export` Export — Credits & Debits | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| `payments.print` Print — Credits & Debits | S | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| `reports.view` View — Reports | S | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `reports.export` Export — Reports | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `reports.print` Print — Reports | S | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `auditLog.view` View — Audit Log | ▲ | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `settings.view` View — Settings | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `settings.update` Update — Settings | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `settings.manageTableDefaults` Manage Table Defaults — Settings | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.view` View — Users | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.create` Create — Users | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.update` Update — Users | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.deactivate` Deactivate — Users | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.activate` Activate — Users | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.delete` Delete — Users | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.resetPassword` Reset Password — Users | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.assignRole` Assign Role — Users | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `users.managePermissions` Manage Permissions — Users | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `roles.view` View — Roles & Permissions | ▲ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `roles.create` Create — Roles & Permissions | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `roles.update` Update — Roles & Permissions | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `roles.delete` Delete — Roles & Permissions | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `roles.managePermissions` Manage Permissions — Roles & Permissions | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `dashboard.customize` customize — Dashboard | S | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `dashboard.export` Export — Dashboard | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `currency.usd` USD — Account / Currency Access | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `currency.slsh` SLSH — Account / Currency Access | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rates.view` View — Rate Management | S | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rates.create` Create — Rate Management | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `rates.updateDaily` Update Daily Rate — Rate Management | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `rates.updateSale` Update Sale Rate — Rate Management | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `rates.delete` Delete — Rate Management | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `rates.viewHistory` View History — Rate Management | S | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `rates.exportHistory` Export History — Rate Management | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |  |  |  |
| `profit.viewCompany` View Company — Profit & Financial Visibility | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `profit.viewExchange` View Exchange — Profit & Financial Visibility | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `profit.viewDashboard` View Dashboard — Profit & Financial Visibility | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `profit.viewReports` View Reports — Profit & Financial Visibility | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `profit.export` Export — Profit & Financial Visibility | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `cash.view` View — Cash Account | ▲ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `cash.create` Create — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cash.update` Update — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cash.deactivate` Deactivate — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cash.activate` Activate — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cash.delete` Delete — Cash Account | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `cash.deposit` Record Credit — Cash Account | ▲ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `cash.withdraw` Record Debit — Cash Account | ▲ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `cash.transfer` Transfer Between Accounts — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cash.exchange` Exchange — Cash Account | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `loans.view` View — Loans & Debts | ▲ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `loans.create` Create — Loans & Debts | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `loans.repay` Record Repayment — Loans & Debts | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `loans.writeOff` Write Off — Loans & Debts | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `loans.delete` Delete — Loans & Debts | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `expenses.view` View — Company Expenses | S | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |  |  |  |  |  |
| `expenses.create` Create — Company Expenses | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `expenses.update` Update — Company Expenses | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `expenses.cancel` Cancel / Reverse — Company Expenses | ■ | ✓ |  |  |  |  |  |  | ✓ |  |  |  |  |  |
| `expenses.manageCategories` Manage Categories — Company Expenses | ▲ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |  |
| `expenses.export` Export — Company Expenses | ▲ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |  |  |  |
| `dailyReports.view` View — Daily Reports | ▲ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `dailyReports.export` Export — Daily Reports | ▲ | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |
| `dailyReports.manage` Manage Snapshots (settings, manual run, retry) — Daily Reports | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `customers.view` View — Customer Profiles | S | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |  |  |  |  |
| `customers.link` link — Customer Profiles | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `pdfTemplates.view` View — PDF Templates | S | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `pdfTemplates.create` Create — PDF Templates | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `pdfTemplates.update` Update — PDF Templates | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `pdfTemplates.delete` Delete — PDF Templates | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `excelTemplates.view` View — Excel Templates | S | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `excelTemplates.create` Create — Excel Templates | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `excelTemplates.update` Update — Excel Templates | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `excelTemplates.delete` Delete — Excel Templates | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.view` View — Daily Operations | ▲ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.create` Create — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.viewReconciliation` View Daily Reconciliation — Daily Operations | ▲ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.reconcile` Perform Reconciliation — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.snapshot` Save Daily Snapshot — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.updateHistory` Update Historical Snapshot — Daily Operations | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.close` Close Daily Operations — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.reopen` Reopen Closed Day — Daily Operations | ■ | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.print` Print — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `dailyOps.export` Export — Daily Operations | ▲ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
