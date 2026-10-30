"use strict";
const { isValidAmount, toNumber } = require("../util");
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody, sendPDF, sendXLSX, sendCSV } = require("../http-helpers");
const { requireAuth, requirePerm, allowedCurrencies, requireCurrencyAccess, hasCurrencyAccess, can } = require("../rbac");
const { addAudit, nextAccountNumber, nextLedgerReference, getCompanySettings, getDefaultPdfTemplate, getDefaultExcelTemplate, rebuildAccountBalance } = require("../domain");
const { uid, nowISO, fmtMoney, convert, formatPersonName, resolvePaymentDate, chronoSortKey } = require("../util");
const { renderReportPDF } = require("../pdf");
const { buildProfessionalWorkbook } = require("../xlsx-engine");
const { toCSV, parseCSV } = require("../csv");
const ExcelJS = require("exceljs");
// PAYMENT / CASH IN HAND INTEGRATION round: reuse Cash in Hand's own
// validation + leg-posting helpers rather than duplicating cash_accounts
// logic here — see routes/cash.js for what each one does.
const { accountBasic: cashAccountBasic, validatePaymentCashAccount, hasActiveCashAccountsFor, postPaymentCashLeg } = require("./cash");
// ACCOUNT IMPORT & EXPORT round: shared row-parsing/validation engine (see
// its own header comment for why preview and commit both go through it).
const accountImport = require("../account-import");

// The one real, pre-existing "opening balance" record for an account: the
// single account_ledger row POST /api/accounts inserts at creation time
// (notes = "Opening balance", exact string, see that route below) whenever
// openingBalance is non-zero. An account created with a zero opening balance
// simply has no such row, so this returns 0 for it — never fabricated.
// Reused here for BOTH ordinary export (item 1's "Opening Balance" column)
// and the import commit path uses the exact same mechanism to create one, so
// a freshly-imported account is indistinguishable from one created by hand.
//
// NEGATIVE OPENING BALANCE round: an opening balance can now be negative
// (e.g. a customer who already owed money before being entered into the
// system — see POST /api/accounts below), which is stored as a "withdrawal"
// ledger row whose `amount` column is always a positive magnitude (same
// convention rebuildAccountBalance/every other ledger row already uses) —
// so this must flip the sign back for a withdrawal row, or callers (CSV
// export, Export Accounts + Balances) would silently show a debt as a
// positive opening balance.
// OPENING BALANCE (Customer / Company Information) round: the one parser for
// an Opening Balance typed into the Create or Edit form. Negative is allowed
// (money the customer/company already owed — see POST below). Returns
// { value } or { error }.
const MAX_OPENING_ABS = 1e13;
function parseOpeningBalance(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: 0 };
  // FULL SYSTEM AUDIT round: only a number or text ("1,250.50"); [5] or true
  // used to be accepted as 5 / 1.
  if (typeof raw !== "number" && typeof raw !== "string") return { error: "Opening Balance must be a number." };
  const n = typeof raw === "number" ? raw : toNumber(String(raw).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return { error: "Opening Balance must be a number." };
  if (Math.abs(n) > MAX_OPENING_ABS) return { error: "Opening Balance is too large." };
  return { value: Math.round(n * 100) / 100 };
}

function openingBalanceFor(clientId) {
  const row = get("SELECT amount, type FROM account_ledger WHERE client_id = ? AND notes = 'Opening balance' ORDER BY date ASC LIMIT 1", [clientId]);
  if (!row) return 0;
  return row.type === "withdrawal" ? -row.amount : row.amount;
}

// Shared by GET /api/accounts and its new export.pdf/export.xlsx below, so
// an exported list can never show different rows than the screen it was
// exported from — same WHERE clause, same params, built once.
function buildAccountsFilter(user, query) {
  const allowed = allowedCurrencies(user);
  if (allowed.length === 0) return null;
  const clauses = ["status = 'active'", "deleted_at IS NULL"], sqlParams = [];
  if (allowed.length < 2) { clauses.push("currency = ?"); sqlParams.push(allowed[0]); }
  if (query.currency && ["USD", "SLSH"].includes(query.currency)) { clauses.push("currency = ?"); sqlParams.push(query.currency); }
  if (query.type && ["customer", "company"].includes(query.type)) { clauses.push("account_type = ?"); sqlParams.push(query.type); }
  if (query.from) { clauses.push("date(created_at) >= date(?)"); sqlParams.push(query.from); }
  if (query.to) { clauses.push("date(created_at) <= date(?)"); sqlParams.push(query.to); }
  if (query.search) {
    clauses.push("(name LIKE ? OR contact LIKE ? OR email LIKE ? OR account_number LIKE ? OR id_number LIKE ?)");
    const s = `%${query.search}%`;
    sqlParams.push(s, s, s, s, s);
  }
  if (query.balanceSign === "positive") clauses.push("(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) > 0");
  else if (query.balanceSign === "negative") clauses.push("(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) < 0");
  const where = "WHERE " + clauses.join(" AND ");
  const sortMap = { name: "name ASC", newest: "created_at DESC", oldest: "created_at ASC", balance: "(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) DESC" };
  const orderBy = sortMap[query.sort] || sortMap.name;
  return { where, sqlParams, orderBy };
}

function basicInfo(id) {
  if (!id) return null;
  const c = get("SELECT id, name, account_number, currency FROM clients WHERE id = ?", [id]);
  return c ? { id: c.id, name: c.name, accountNumber: c.account_number, currency: c.currency } : null;
}
function serialize(c) {
  const balance = c.currency === "USD" ? c.balance_usd : c.balance_slsh;
  return {
    id: c.id, accountNumber: c.account_number, name: c.name, accountType: c.account_type, currency: c.currency,
    contact: c.contact, email: c.email, idNumber: c.id_number, address: c.address, notes: c.notes || "",
    balance, balanceUSD: c.balance_usd, balanceSLSH: c.balance_slsh, createdAt: c.created_at,
    // OPENING BALANCE round: read from the account's single "Opening balance"
    // ledger entry — the same record the balance itself already includes, so
    // showing it here never adds anything to any total.
    openingBalance: openingBalanceFor(c.id),
    // LINKED ACCOUNTS REMOVAL round: linkedAccountId/linkedAccount were the
    // only API-level surface of the USD<->SLSH account-pairing feature —
    // removed from the payload along with the /link and /unlink routes and
    // every frontend reference. basicInfo() and clearLink() stay (the
    // latter is still needed so deleting an account clears any FK reference
    // left over from a link made before this removal, and basicInfo is used
    // elsewhere for transfer counterparties).
    transactionCount: get("SELECT COUNT(*) as n FROM exchange_transactions WHERE client_id = ? AND status = 'active'", [c.id]).n,
    quotationCount: get("SELECT COUNT(*) as n FROM quotations WHERE client_id = ?", [c.id]).n,
    status: c.status || "active",
    deactivatedAt: c.deactivated_at, deactivatedBy: c.deactivated_by, deactivationReason: c.deactivation_reason,
    reactivatedAt: c.reactivated_at, reactivatedBy: c.reactivated_by,
  };
}
function clearLink(clientId) {
  const c = get("SELECT linked_account_id FROM clients WHERE id = ?", [clientId]);
  if (c?.linked_account_id) run("UPDATE clients SET linked_account_id = NULL WHERE id = ?", [c.linked_account_id]);
  run("UPDATE clients SET linked_account_id = NULL WHERE id = ?", [clientId]);
}

function register(router) {
  router.get("/api/accounts", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    // The normal Accounts pages and every account-search picker (Money
    // Exchange, Quotation client-linking, account linking, Transfer
    // destination search) all go through this one endpoint, so filtering
    // deactivated/deleted accounts out here is what makes "a deactivated
    // account can't participate in new financial transactions" actually
    // true everywhere at once — it simply can't be found or selected.
    // Deactivated accounts have their own dedicated list at
    // GET /api/accounts/deactivated; permanently deleted accounts never
    // appear in any list again.
    // CURRENCY / RATE / PROFIT PERMISSIONS round: this endpoint is the one
    // shared search/dropdown every account picker in the app goes through
    // (see the comment above), so scoping it here by the caller's
    // currency.usd/currency.slsh grants is what makes an SLSH-restricted
    // user unable to find, search for, or select a USD account ANYWHERE —
    // Money Exchange, Quotation client-linking, account linking, Transfer
    // destination search — in one place, matching spec item 2/3's "apply
    // everywhere" and "must not appear in search results/dropdowns" rules.
    const allowed = allowedCurrencies(user);
    if (allowed.length === 0) return sendJSON(res, 200, { accounts: [] });
    const clauses = ["status = 'active'", "deleted_at IS NULL"], sqlParams = [];
    if (allowed.length < 2) { clauses.push("currency = ?"); sqlParams.push(allowed[0]); }
    if (query.currency && ["USD", "SLSH"].includes(query.currency)) { clauses.push("currency = ?"); sqlParams.push(query.currency); }
    if (query.type && ["customer", "company"].includes(query.type)) { clauses.push("account_type = ?"); sqlParams.push(query.type); }
    if (query.from) { clauses.push("date(created_at) >= date(?)"); sqlParams.push(query.from); }
    if (query.to) { clauses.push("date(created_at) <= date(?)"); sqlParams.push(query.to); }
    if (query.search) {
      clauses.push("(name LIKE ? OR contact LIKE ? OR email LIKE ? OR account_number LIKE ? OR id_number LIKE ?)");
      const s = `%${query.search}%`;
      sqlParams.push(s, s, s, s, s);
    }
    if (query.balanceSign === "positive") clauses.push("(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) > 0");
    else if (query.balanceSign === "negative") clauses.push("(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) < 0");
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const sortMap = { name: "name ASC", newest: "created_at DESC", oldest: "created_at ASC", balance: "(CASE WHEN currency='USD' THEN balance_usd ELSE balance_slsh END) DESC" };
    let orderBy = sortMap[query.sort] || sortMap.name;
    // ACCOUNT / CLIENT SEARCH — CURRENCY SEPARATION (spec item 16): when a
    // caller is searching (every account/client picker across the app) and
    // hasn't asked for an explicit sort (the Accounts module's own list
    // always does, via `sort`), rank an exact account-number match first,
    // then an exact name match, then a "starts with" name match, ahead of
    // the general partial match — so the best match is always at the top.
    if (query.search && !query.sort) {
      orderBy = `(CASE
        WHEN account_number = ? THEN 0
        WHEN name = ? THEN 1
        WHEN name LIKE ? THEN 2
        ELSE 3
      END), name ASC`;
      sqlParams.push(query.search, query.search, `${query.search}%`);
      const rows = all(`SELECT * FROM clients ${where} ORDER BY ${orderBy}`, sqlParams);
      return sendJSON(res, 200, { accounts: rows.map(serialize) });
    }
    const rows = all(`SELECT * FROM clients ${where} ORDER BY ${orderBy}`, sqlParams);
    sendJSON(res, 200, { accounts: rows.map(serialize) });
  });

  // Registered before the generic "/:id" route below, since the router
  // matches in registration order and ":id" would otherwise greedily match
  // "deactivated" as an account id.
  router.get("/api/accounts/deactivated", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const allowed = allowedCurrencies(user);
    if (allowed.length === 0) return sendJSON(res, 200, { accounts: [] });
    const clauses = ["status = 'deactivated'", "deleted_at IS NULL"], sqlParams = [];
    if (allowed.length < 2) { clauses.push("currency = ?"); sqlParams.push(allowed[0]); }
    const rows = all(`SELECT * FROM clients WHERE ${clauses.join(" AND ")} ORDER BY deactivated_at DESC`, sqlParams);
    sendJSON(res, 200, { accounts: rows.map(serialize) });
  });

  // Accounts list export — PDF and Excel, added on request. Uses the exact
  // same filter/sort as the screen (buildAccountsFilter above), so what's
  // exported always matches what's currently shown.
  router.get("/api/accounts/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.export")) return;
    const filter = buildAccountsFilter(user, query);
    const rows = filter ? all(`SELECT * FROM clients ${filter.where} ORDER BY ${filter.orderBy}`, filter.sqlParams) : [];
    const currency = query.currency && ["USD", "SLSH"].includes(query.currency) ? query.currency : null;
    const pdf = await renderReportPDF({
      company: getCompanySettings(),
      title: `Accounts${currency ? ` — ${currency}` : ""}`,
      meta: `${rows.length} account(s)`,
      generatedBy: user.name,
      template: getDefaultPdfTemplate("account"),
      // LINKED ACCOUNTS REMOVAL round: the "Linked account" column is gone
      // from this export along with the rest of the feature.
      columns: [
        { label: "Account #", width: 1 }, { label: "Name", width: 1.6 }, { label: "Contact", width: 1.2 },
        { label: "Balance", width: 1, align: "right" },
      ],
      rows: rows.map((c) => {
        const balance = c.currency === "USD" ? c.balance_usd : c.balance_slsh;
        return [c.account_number, c.name, c.contact || "—", fmtMoney(balance, c.currency)];
      }),
      // TOTAL BALANCE line: the sum of the listed accounts' balances, kept
      // per currency (USD and SLSH are never added together).
      totalsRow: (() => {
        const sum = { USD: 0, SLSH: 0 }, seen = { USD: false, SLSH: false };
        for (const c of rows) {
          const cur = c.currency === "USD" ? "USD" : "SLSH";
          sum[cur] += Number(c.currency === "USD" ? c.balance_usd : c.balance_slsh) || 0;
          seen[cur] = true;
        }
        const parts = ["USD", "SLSH"].filter((k) => seen[k] || k === currency).map((k) => fmtMoney(Math.round(sum[k] * 100) / 100, k));
        return { 1: "TOTAL BALANCE", 3: parts.join("  ·  ") || fmtMoney(0, currency || "USD") };
      })(),
    });
    addAudit(user, "Accounts exported (PDF)", `${rows.length} account(s)${currency ? ` — ${currency}` : ""}`);
    sendPDF(res, `obo-accounts${currency ? `-${currency.toLowerCase()}` : ""}.pdf`, pdf);
  });

  router.get("/api/accounts/export.xlsx", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.export")) return;
    const filter = buildAccountsFilter(user, query);
    const rows = filter ? all(`SELECT * FROM clients ${filter.where} ORDER BY ${filter.orderBy}`, filter.sqlParams) : [];
    const currency = query.currency && ["USD", "SLSH"].includes(query.currency) ? query.currency : null;
    const xlsx = await buildProfessionalWorkbook({
      company: getCompanySettings(),
      generatedBy: user.name,
      template: getDefaultExcelTemplate("account"),
      sheetName: "Accounts",
      docTypeLabel: `ACCOUNTS${currency ? ` — ${currency}` : ""}`,
      subtitleLines: [`Generated ${new Date().toLocaleString("en-GB")} by ${user.name} · ${rows.length} account(s)`],
      table: {
        columns: [
          { key: "accountNumber", label: "Account #", width: 16 },
          { key: "name", label: "Name", width: 28 },
          { key: "contact", label: "Contact", width: 18 },
          { key: "type", label: "Type", width: 12 },
          { key: "currency", label: "Currency", width: 10 },
          // GLOBAL CURRENCY FORMATTING round: this export can mix USD and
          // SLSH accounts in one sheet (no currency filter applied), so
          // the Balance column needs each row's OWN currency's Excel
          // format rather than one fixed format — a function numFmt picks
          // it per row (xlsx-engine.js applies it per cell).
          { key: "balance", label: "Balance", width: 16, align: "right", numFmt: (row) => (row.currency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"') },
          // LINKED ACCOUNTS REMOVAL round: "Linked account" column removed.
        ],
        rows,
        cellValue: (c, key) => {
          if (key === "accountNumber") return c.account_number;
          if (key === "name") return c.name;
          if (key === "contact") return c.contact || "—";
          if (key === "type") return c.account_type === "company" ? "Company" : "Customer";
          if (key === "currency") return c.currency;
          if (key === "balance") return c.currency === "USD" ? c.balance_usd : c.balance_slsh;
          return "";
        },
        totalsRow: { accountNumber: "TOTAL", balance: "sum" },
      },
    });
    addAudit(user, "Accounts exported (Excel)", `${rows.length} account(s)${currency ? ` — ${currency}` : ""}`);
    sendXLSX(res, `obo-accounts${currency ? `-${currency.toLowerCase()}` : ""}.xlsx`, xlsx);
  });

  // ============================================================
  // ACCOUNT IMPORT & EXPORT round — every route below is registered
  // BEFORE the generic "GET /api/accounts/:id" route further down (same
  // router-matching-order constraint documented on export.pdf/export.xlsx
  // above and just fixed for quotations' column-defaults endpoints): a
  // literal path like "export.csv" or "import-history" would otherwise be
  // swallowed by ":id". This whole block is purely ADDITIVE — it touches no
  // existing account creation, balance, ledger, transaction, quotation, or
  // permission behavior; see account-import.js for the shared row
  // validation engine and its own extensive comments on the safety rules it
  // enforces (never overwrite an existing balance, never fake a ledger
  // entry, always preview before committing).
  // ============================================================

  // Full "Export Accounts" (spec item 1) — the one clean, single-sheet CSV
  // with every recommended column, including the two the existing
  // export.xlsx/export.pdf list views don't carry (Opening Balance, Created
  // Date, Notes) since those exports mirror the on-screen table exactly.
  router.get("/api/accounts/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.export")) return;
    const filter = buildAccountsFilter(user, query);
    const rows = filter ? all(`SELECT * FROM clients ${filter.where} ORDER BY ${filter.orderBy}`, filter.sqlParams) : [];
    const csv = toCSV(
      ["Account #", "Account Name", "Account Type", "Currency", "Phone", "Email", "Status", "Opening Balance", "Current Balance", "Created Date", "Notes"],
      rows.map((c) => [
        c.account_number, c.name, c.account_type === "company" ? "Company" : "Customer", c.currency,
        c.contact || "", c.email || "", c.status === "deactivated" ? "Deactivated" : "Active",
        openingBalanceFor(c.id), c.currency === "USD" ? c.balance_usd : c.balance_slsh,
        c.created_at ? c.created_at.slice(0, 10) : "", c.notes || "",
      ])
    );
    addAudit(user, "Accounts exported", `CSV — ${rows.length} account(s)`);
    sendCSV(res, "obo-accounts.csv", csv);
  });

  // "Export Accounts + Balances" (spec item 14) — a separate, simpler
  // backup/migration-oriented export: every account this user can see,
  // regardless of the current screen's filters, with exactly the columns
  // the spec lists. Deliberately NOT the same thing as a transaction/ledger
  // backup (spec item 15's explicit distinction) — no ledger or transaction
  // rows are included here, only account master data + current balances.
  router.get("/api/accounts/export-balances.xlsx", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.export")) return;
    const allowed = allowedCurrencies(user);
    const rows = allowed.length
      ? all(`SELECT * FROM clients WHERE deleted_at IS NULL AND currency IN (${allowed.map(() => "?").join(",")}) ORDER BY account_number ASC`, allowed)
      : [];
    const xlsx = await buildProfessionalWorkbook({
      company: getCompanySettings(),
      generatedBy: user.name,
      template: getDefaultExcelTemplate("account"),
      sheetName: "Accounts",
      docTypeLabel: "ACCOUNTS + BALANCES",
      subtitleLines: [`Generated ${new Date().toLocaleString("en-GB")} by ${user.name} · ${rows.length} account(s) · for backup, reporting, or migration`],
      table: {
        columns: [
          { key: "accountNumber", label: "Account #", width: 16 },
          { key: "name", label: "Account Name", width: 28 },
          { key: "currency", label: "Currency", width: 10 },
          { key: "type", label: "Account Type", width: 14 },
          { key: "status", label: "Status", width: 14 },
          // GLOBAL CURRENCY FORMATTING round: this export spans every
          // currency the user can see in one sheet, so Opening/Current
          // Balance each need a per-row Excel format matching that row's
          // own currency (see the per-row numFmt note above).
          { key: "opening", label: "Opening Balance", width: 18, align: "right", numFmt: (row) => (row.currency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"') },
          { key: "current", label: "Current Balance", width: 18, align: "right", numFmt: (row) => (row.currency === "USD" ? '"$"#,##0.00' : '#,##0 "SLSH"') },
        ],
        rows,
        cellValue: (c, key) => {
          if (key === "accountNumber") return c.account_number;
          if (key === "name") return c.name;
          if (key === "currency") return c.currency;
          if (key === "type") return c.account_type === "company" ? "Company" : "Customer";
          if (key === "status") return c.status === "deactivated" ? "Deactivated" : "Active";
          if (key === "opening") return openingBalanceFor(c.id);
          if (key === "current") return c.currency === "USD" ? c.balance_usd : c.balance_slsh;
          return "";
        },
        totalsRow: { accountNumber: "TOTAL", current: "sum" },
      },
    });
    addAudit(user, "Accounts exported", `Accounts + Balances — ${rows.length} account(s)`);
    sendXLSX(res, "obo-accounts-balances.xlsx", xlsx);
  });

  // Downloadable import templates — spec items 3 & 19: exactly the fields
  // the import engine below accepts, nothing technical (no IDs), a couple
  // of filled-in example rows so a non-technical user immediately sees the
  // expected shape.
  router.get("/api/accounts/import-template.xlsx", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    const buf = await accountImport.buildImportTemplateWorkbook();
    sendXLSX(res, "obo-accounts-import-template.xlsx", buf);
  });
  router.get("/api/accounts/import-template.csv", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    const csv = toCSV(accountImport.TEMPLATE_COLUMNS, [
      ["", "A-Raheen Moh'ed Ali", "Customer", "USD", "252634000000", "araheen@example.com", "Active", "500", ""],
      ["", "Abdirahin Mohamed", "Customer", "USD", "252634000001", "", "Active", "1000", ""],
      ["", "Company Account", "Company", "SLSH", "252634000002", "", "Active", "250000", "Corporate account"],
    ], { raw: true });
    sendCSV(res, "obo-accounts-import-template.csv", csv);
  });

  // Reads an uploaded file's raw rows (as [headers[], values[][]]) from the
  // same { fileName, fileBase64 } JSON-body shape Settings > Branding
  // already uses for the company logo (this app has no multipart/form-data
  // upload support anywhere), dispatching by extension.
  async function readUploadedRows(body) {
    const fileName = String(body.fileName || "").toLowerCase();
    if (!body.fileBase64) throw new Error("No file was uploaded.");
    const buffer = Buffer.from(body.fileBase64, "base64");
    if (fileName.endsWith(".csv")) {
      const { headers, rows } = parseCSV(buffer.toString("utf8"));
      return { headers, rows };
    }
    if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const sheet = wb.worksheets[0];
      if (!sheet) return { headers: [], rows: [] };
      const all2 = [];
      sheet.eachRow((row) => { all2.push(row.values.slice(1).map((v) => (v && v.text !== undefined ? v.text : v))); });
      const headers = (all2.shift() || []).map((h) => String(h == null ? "" : h));
      return { headers, rows: all2 };
    }
    throw new Error("Unsupported file type. Upload a .xlsx or .csv file.");
  }

  // CURRENCY / RATE / PROFIT PERMISSIONS round compatibility: a user
  // restricted to a single currency (currency.usd or currency.slsh only)
  // must not be able to bulk-create accounts in the OTHER currency via
  // import — same rule requireCurrencyAccess already enforces for the
  // ordinary POST /api/accounts. Applied after classification so a row that
  // would otherwise be valid/duplicate, but is in a currency this user
  // can't touch, is downgraded to an error instead.
  function enforceCurrencyAccess(rows, user) {
    const allowed = new Set(allowedCurrencies(user));
    for (const row of rows) {
      // For a duplicate row, the currency that actually matters is the
      // EXISTING account's real currency (never changed by an update) —
      // not whatever the imported file happens to say.
      const effectiveCurrency = row.status === "duplicate" && row.existingAccount ? row.existingAccount.currency : row.currency;
      if (effectiveCurrency && !allowed.has(effectiveCurrency)) {
        row.errors.push(`You don't have permission to import/update ${effectiveCurrency} accounts.`);
        row.status = "invalid";
      }
    }
    return rows;
  }

  function parseAndClassify(body, user) {
    return readUploadedRows(body).then(({ headers, rows }) => {
      const built = rows
        .filter((r) => r.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== ""))
        .map((r, i) => accountImport.buildRow(accountImport.mapRowByHeaders(headers, r), i + 2)); // +2: row 1 is the header, data starts at row 2
      return enforceCurrencyAccess(accountImport.classifyRows(built), user);
    });
  }

  // Stateless preview — parses + validates every row, returns the full
  // categorized breakdown, and NEVER writes anything to the database (spec
  // item 8: "Do NOT import automatically before the user confirms.").
  router.post("/api/accounts/import/preview", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    let rows;
    try { rows = await parseAndClassify(body, user); } catch (e) { return badRequest(res, e.message); }
    sendJSON(res, 200, {
      summary: accountImport.summarize(rows),
      rows: rows.map(accountImport.serializeRowForClient),
      canImportOpeningBalance: can(user, "accounts.importOpeningBalance"),
    });
  });

  // Commit — re-parses and re-classifies the SAME uploaded file completely
  // from scratch (never trusts whatever the client's preview call showed),
  // then only acts on rows whose freshly-computed status permits the
  // requested action. `decisions` maps a row's 1-based rowNumber to
  // "import" | "update" | "skip" — sent back by the Import Preview screen
  // after the user reviews duplicates; any row with no explicit decision
  // defaults to the SAFEST choice for its class (import for a fresh valid
  // row, skip for a duplicate, always skip for an invalid row).
  router.post("/api/accounts/import/commit", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    let rows;
    try { rows = await parseAndClassify(body, user); } catch (e) { return badRequest(res, e.message); }
    const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};
    const canImportOpeningBalance = can(user, "accounts.importOpeningBalance");

    const report = [];
    let importedCount = 0, updatedCount = 0, skippedCount = 0, errorCount = 0;

    tx(() => {
      for (const row of rows) {
        const requested = decisions[String(row.rowNumber)] || decisions[row.rowNumber];
        if (row.status === "invalid") {
          errorCount += 1;
          report.push({ row: row.rowNumber, accountNumber: row.accountNumber || null, accountName: row.name || "(blank)", result: "Error", reason: row.errors.join(" ") });
          continue;
        }
        if (row.status === "duplicate") {
          const action = requested === "update" ? "update" : "skip"; // safest default: never touch an existing account unless explicitly told to
          if (action === "skip") {
            skippedCount += 1;
            report.push({ row: row.rowNumber, accountNumber: row.existingAccount.accountNumber, accountName: row.name, result: "Skipped", reason: "Account already exists — left unchanged." });
            continue;
          }
          // Update Account Details: ONLY non-financial master-data fields
          // ever move here (spec section 11, Balance Safety) — currency,
          // balance_usd, balance_slsh, and account_number are never touched.
          const existing = get("SELECT * FROM clients WHERE id = ?", [row.existingAccount.id]);
          run(
            "UPDATE clients SET name=?, account_type=?, contact=?, email=?, notes=? WHERE id=?",
            [row.name || existing.name, row.accountType || existing.account_type, row.phone || existing.contact, row.email || existing.email, row.notes || existing.notes, existing.id]
          );
          updatedCount += 1;
          report.push({ row: row.rowNumber, accountNumber: existing.account_number, accountName: row.name, result: "Updated", reason: "Master data updated. Balance and currency were not changed." });
          continue;
        }
        // status === "valid": a brand-new account. Skippable if the user
        // unchecked it in the preview screen; otherwise created using the
        // EXACT SAME mechanism as POST /api/accounts above (one real
        // account_ledger "Opening balance" deposit row, never a fake
        // transaction) — see this file's own openingBalanceFor() comment.
        if (requested === "skip") {
          skippedCount += 1;
          report.push({ row: row.rowNumber, accountNumber: row.accountNumber || null, accountName: row.name, result: "Skipped", reason: "Excluded by the user before import." });
          continue;
        }
        if (row.openingBalance > 0 && !canImportOpeningBalance) {
          errorCount += 1;
          report.push({ row: row.rowNumber, accountNumber: row.accountNumber || null, accountName: row.name, result: "Error", reason: "Opening balance import requires the 'Import Opening Balances' permission — account not created." });
          continue;
        }
        const id = uid("cl");
        const accountNumber = (row.accountNumber && row.accountNumber.trim()) || nextAccountNumber();
        const balUSD = row.currency === "USD" ? row.openingBalance : 0;
        const balSLSH = row.currency === "SLSH" ? row.openingBalance : 0;
        run(
          "INSERT INTO clients (id, name, account_number, account_type, currency, contact, email, notes, balance_usd, balance_slsh, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, row.name, accountNumber, row.accountType, row.currency, row.phone || null, row.email || null, row.notes || null, balUSD, balSLSH, row.accountStatus || "active", nowISO()]
        );
        if (row.openingBalance > 0) {
          // BALANCE & LAST TRANSACTION FIX round: this insert was missing
          // `created_at` (every other account_ledger insert sets it) — it
          // did no harm to ordering by itself, since this row's `date` is
          // always a full nowISO() timestamp already, but leaving it unset
          // is inconsistent with the rest of the schema and this column is
          // the fallback chronoSortKey relies on for day-only dates
          // elsewhere. Harmless, additive fix — same value already used for
          // `date` right below.
          const importedAt = nowISO();
          run(
            "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [uid("ldg"), id, "deposit", row.currency, row.openingBalance, row.openingBalance, "Opening balance", user.id, user.name, importedAt, importedAt, nextLedgerReference("deposit")]
          );
        }
        importedCount += 1;
        report.push({ row: row.rowNumber, accountNumber, accountName: row.name, result: "Imported", reason: row.openingBalance > 0 ? `Created with opening balance ${fmtMoney(row.openingBalance, row.currency)}.` : "Created." });
      }

      run(
        "INSERT INTO account_imports (id, file_name, total_rows, imported_count, updated_count, skipped_count, error_count, report_json, imported_by, imported_by_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [uid("imp"), body.fileName || "import", rows.length, importedCount, updatedCount, skippedCount, errorCount, JSON.stringify(report), user.id, user.name, nowISO()]
      );
    });

    addAudit(user, "Accounts imported", `${body.fileName || "file"} — ${importedCount} imported, ${updatedCount} updated, ${skippedCount} skipped, ${errorCount} error(s)`);
    sendJSON(res, 200, {
      summary: { total: rows.length, imported: importedCount, updated: updatedCount, skipped: skippedCount, errors: errorCount },
      report,
    });
  });

  // Import History (spec item 13) — one row per commit run.
  router.get("/api/accounts/import-history", (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    const rows = all("SELECT id, file_name, total_rows, imported_count, updated_count, skipped_count, error_count, imported_by_name, created_at FROM account_imports ORDER BY created_at DESC LIMIT 200", []);
    sendJSON(res, 200, {
      imports: rows.map((r) => ({
        id: r.id, fileName: r.file_name, totalRows: r.total_rows, imported: r.imported_count, updated: r.updated_count,
        skipped: r.skipped_count, errors: r.error_count, importedBy: r.imported_by_name, createdAt: r.created_at,
      })),
    });
  });

  router.get("/api/accounts/import-history/:importId", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    const r = get("SELECT * FROM account_imports WHERE id = ?", [params.importId]);
    if (!r) return notFound(res, "Import record not found.");
    let report = [];
    try { report = JSON.parse(r.report_json) || []; } catch (e) { report = []; }
    sendJSON(res, 200, {
      id: r.id, fileName: r.file_name, totalRows: r.total_rows, imported: r.imported_count, updated: r.updated_count,
      skipped: r.skipped_count, errors: r.error_count, importedBy: r.imported_by_name, createdAt: r.created_at, report,
    });
  });

  // Error Report download (spec item 20) — the failed rows from one import,
  // as a downloadable CSV, straight from that import's own saved report.
  router.get("/api/accounts/import-history/:importId/errors.csv", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accounts.import")) return;
    const r = get("SELECT * FROM account_imports WHERE id = ?", [params.importId]);
    if (!r) return notFound(res, "Import record not found.");
    let report = [];
    try { report = JSON.parse(r.report_json) || []; } catch (e) { report = []; }
    const errorRows = report.filter((row) => row.result === "Error");
    const csv = toCSV(
      ["Row", "Account #", "Account Name", "Error", "Suggested Fix"],
      errorRows.map((row) => [row.row, row.accountNumber || "", row.accountName || "", row.reason || "", "Correct the value in your file and re-upload."])
    );
    sendCSV(res, `obo-import-errors-${r.id}.csv`, csv);
  });

  router.get("/api/accounts/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    const c = get("SELECT * FROM clients WHERE id = ?", [params.id]);
    if (!c) return notFound(res, "Account not found.");
    // A direct URL/API hit on an account whose currency this user isn't
    // permitted to see must be denied server-side, not just hidden from the
    // list above (spec item 16's explicit "USD-only user hits an SLSH
    // account directly -> 403" example).
    if (!requireCurrencyAccess(user, res, c.currency)) return;
    // BALANCE & LAST TRANSACTION FIX round: `date` (the Payment/Accounting
    // Date) can be a bare "YYYY-MM-DD" OR a full ISO timestamp (see
    // util.chronoSortKey for the full rationale) — a plain `ORDER BY date
    // DESC` compares those as raw strings, which can even rank a same-day
    // bare-date row entirely below a same-day timestamped row with an
    // afternoon time, regardless of which actually happened first.
    // CHRONO_SORT_EXPR is the SQL equivalent of util.chronoSortKey: when
    // `date` has no explicit time (length 10), it borrows the TIME portion
    // of `created_at` (the real, always-set insertion timestamp) while
    // keeping date's own calendar day — so `ORDER BY`/`LIMIT` picks the
    // true most recent rows (backdating by day still works; same-day ties
    // fall back to real insertion order). `id` (embeds a real timestamp —
    // see uid() in util.js) is the final tiebreaker. exchange_transactions
    // has no created_at column, but its `date` is always a full timestamp
    // already (see routes/transactions.js), so it needs no CASE at all.
    const CHRONO_SORT_EXPR = "(CASE WHEN length(date) > 10 THEN date ELSE substr(date,1,10) || substr(COALESCE(created_at, date || 'T00:00:00.000Z'), 11) END)";
    const transactions = all("SELECT * FROM exchange_transactions WHERE client_id = ? ORDER BY date DESC, id DESC LIMIT 50", [c.id]);
    const quotations = c.account_type === "company" ? all("SELECT * FROM quotations WHERE client_id = ? ORDER BY created_at DESC LIMIT 50", [c.id]) : [];
    const transfersList = all(`SELECT * FROM transfers WHERE from_account_id = ? OR to_account_id = ? ORDER BY ${CHRONO_SORT_EXPR} DESC, id DESC LIMIT 50`, [c.id, c.id]);
    const ledger = all(`SELECT * FROM account_ledger WHERE client_id = ? ORDER BY ${CHRONO_SORT_EXPR} DESC, id DESC LIMIT 50`, [c.id]);
    // Aggregate over ALL ledger entries (not just what's shown), so the
    // summary is accurate regardless of how much history an account has.
    const agg = get(
      "SELECT SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END) as deposited, SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END) as withdrawn, COUNT(*) as n FROM account_ledger WHERE client_id = ?",
      [c.id]
    );
    const totalDeposited = agg.deposited || 0;
    const totalWithdrawn = agg.withdrawn || 0;
    const totalCharges = (get("SELECT COALESCE(SUM(amount),0) as n FROM account_ledger WHERE client_id = ? AND source_type = 'quotation_charge'", [c.id]) || {}).n || 0;
    const totalExchanges = (get("SELECT COALESCE(SUM(amount),0) as n FROM account_ledger WHERE client_id = ? AND source_type = 'exchange'", [c.id]) || {}).n || 0;
    const totalTransfers = (get("SELECT COALESCE(SUM(amount),0) as n FROM account_ledger WHERE client_id = ? AND source_type = 'transfer'", [c.id]) || {}).n || 0;

    // One unified, chronological activity feed — deposits/withdrawals,
    // exchange transactions, and transfers — so the account view doesn't
    // need several separate mini-lists. Ledger entries auto-generated BY an
    // exchange or a transfer (tagged via source_type/source_id) are folded
    // into that exchange/transfer's own row rather than also appearing as a
    // separate deposit/withdrawal line — one real-world event, one row.
    //
    // A quotation is the deliberate exception: it now posts TWO real,
    // separately visible ledger legs (an immediate Withdrawal at creation,
    // then a settlement Deposit once Paid or Refunded) and per the
    // two-step-ledger design, NEITHER is ever folded away, replaced, or
    // hidden — both must stay visible permanently as their own row, tagged
    // with the quotation's Pending/Paid/Refunded settlement status so it's
    // still legible after the fact (see history.js for the same rule
    // applied to the Transaction History module).
    const transactionIds = new Set(transactions.map((t) => t.id));
    const transferIds = new Set(transfersList.map((t) => t.id));
    const FOLDABLE_PARENTS = { exchange: transactionIds, transfer: transferIds };
    const linkedLedgerByKey = {};
    for (const l of ledger) {
      if (l.source_type && l.source_id) linkedLedgerByKey[`${l.source_type}:${l.source_id}`] = l;
    }
    const QUOTATION_LEG_STATUS = { quotation_charge: "Pending", quotation_paid: "Paid", quotation_refund: "Refunded" };
    // BALANCE & LAST TRANSACTION FIX round: `activityRows` carries each
    // item alongside its own true chronological sort key (real insertion
    // timestamp when available, falling back to its id — see the matching
    // comment on the queries above), kept OUT of the item itself so the
    // final `activity` array sent to the client is byte-for-byte the same
    // shape as before. Previously this merged list was sorted by `date`
    // alone — a plain Payment Date with no time of day, shared by every
    // same-day entry — which left ties in loop/insertion order (all ledger
    // rows, then all exchanges, then all transfers) instead of true
    // newest-first order. A newer same-day Exchange could render BELOW an
    // older same-day Deposit purely because of which loop ran first; this
    // is exactly the bug the "always follow the latest transaction" fix
    // targets.
    const activityRows = [];
    for (const l of ledger) {
      const parents = l.source_type && FOLDABLE_PARENTS[l.source_type];
      if (parents && l.source_id && parents.has(l.source_id)) continue; // folded into its exchange/transfer row instead
      activityRows.push({
        sortDate: chronoSortKey(l.date, l.created_at), sortId: l.id,
        item: {
          id: l.id, kind: l.type, date: l.date, description: l.notes || (l.type === "deposit" ? "Credit" : "Debit"),
          amount: l.amount, currency: l.currency, balanceAfter: l.balance_after, status: QUOTATION_LEG_STATUS[l.source_type] || null, paid: null,
          staffName: l.staff_name, editable: false,
          // PAYMENT / CASH IN HAND INTEGRATION round: which Cash in Hand
          // account this Payment's money came from/went to, if one was
          // selected (null for older entries, or installations with no Cash
          // in Hand accounts configured) — and the free-text Reference field.
          cashAccountId: l.cash_account_id, cashAccount: cashAccountBasic(l.cash_account_id), reference: l.reference,
          // AUTOMATIC SHORT REFERENCE NUMBER round: the official, auto
          // generated reference (e.g. "DEP-2026-0008") — was already stored
          // on every ledger row but never included in this activity feed, so
          // the Account View's own Transactions tab had nothing to show but
          // the separate, optional, user-typed `reference` above (blank for
          // most rows) or fell back to the long internal id. Additive only.
          referenceNumber: l.reference_number,
        },
      });
    }
    for (const t of transactions) {
      const linked = linkedLedgerByKey[`exchange:${t.id}`];
      activityRows.push({
        // exchange_transactions.date is always a full timestamp already
        // (see routes/transactions.js), so chronoSortKey returns it as-is;
        // the linked ledger leg's created_at is passed only as a defensive
        // fallback for the unlikely case of a legacy day-only row.
        sortDate: chronoSortKey(t.date, linked && linked.created_at), sortId: t.id,
        item: {
          id: t.id, kind: "exchange", date: t.date,
          description: `${fmtMoney(t.amount_given, t.currency_given)} → ${fmtMoney(t.amount_received, t.currency_received)}`,
          amount: null, currency: null, balanceAfter: linked ? linked.balance_after : null, status: t.status, paid: null,
          ledgerType: linked ? linked.type : null, ledgerAmount: linked ? linked.amount : null,
          staffName: t.staff_name, editable: false,
          // AUTOMATIC SHORT REFERENCE NUMBER round: an Exchange row in this
          // same activity feed had NO reference field at all before this —
          // ExchangeDetailView already shows referenceNumber correctly when
          // opened on its own, this just makes the Account View list match.
          referenceNumber: t.reference_number,
        },
      });
    }
    for (const t of transfersList) {
      const linked = linkedLedgerByKey[`transfer:${t.id}`];
      const isSender = t.from_account_id === c.id;
      const counterpart = basicInfo(isSender ? t.to_account_id : t.from_account_id);
      activityRows.push({
        sortDate: chronoSortKey(t.date, t.created_at || (linked && linked.created_at)), sortId: t.id,
        item: {
          id: t.id, kind: "transfer", date: t.date,
          description: `${isSender ? "Transfer to" : "Transfer from"} ${counterpart ? counterpart.name : "—"}`,
          amount: null, currency: null, balanceAfter: linked ? linked.balance_after : null, status: t.status, paid: null,
          ledgerType: linked ? linked.type : null, ledgerAmount: linked ? linked.amount : null,
          staffName: t.staff_name, editable: false,
          // AUTOMATIC SHORT REFERENCE NUMBER round: same addition as the
          // Exchange row above — a Transfer row here had no reference field.
          referenceNumber: t.reference_number,
        },
      });
    }
    activityRows.sort((a, b) => {
      const cmp = String(b.sortDate).localeCompare(String(a.sortDate));
      return cmp !== 0 ? cmp : String(b.sortId).localeCompare(String(a.sortId));
    });
    const activity = activityRows.map((r) => r.item);

    sendJSON(res, 200, {
      account: serialize(c),
      summary: {
        totalDeposited, totalWithdrawn, netMovement: totalDeposited - totalWithdrawn, entryCount: agg.n || 0, turnover: totalDeposited + totalWithdrawn,
        totalCharges, totalExchanges, totalTransfers, availableBalance: c.currency === "USD" ? c.balance_usd : c.balance_slsh,
      },
      activity,
      transactions: transactions.map((t) => ({ id: t.id, date: t.date, amountGiven: t.amount_given, currencyGiven: t.currency_given, amountReceived: t.amount_received, currencyReceived: t.currency_received, status: t.status })),
      quotations: quotations.map((q) => ({ id: q.id, number: q.number, status: q.status, issueDate: q.issue_date })),
      transfers: transfersList.map((t) => ({ id: t.id, date: t.date, fromAccountId: t.from_account_id, toAccountId: t.to_account_id, amount: t.amount, currency: t.currency, status: t.status })),
      ledger: ledger.map((l) => ({ id: l.id, type: l.type, currency: l.currency, amount: l.amount, balanceAfter: l.balance_after, notes: l.notes, staffName: l.staff_name, date: l.date, cashAccountId: l.cash_account_id, cashAccount: cashAccountBasic(l.cash_account_id), reference: l.reference, referenceNumber: l.reference_number })),
    });
  });

  router.post("/api/accounts", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const { contact, address, email, idNumber } = body;
    const accountType = body.accountType === "company" ? "company" : "customer";
    // Uppercase formatting applies only to PERSON names (customer accounts).
    // Company names are left exactly as typed.
    const name = accountType === "company" ? (body.name || "").trim() : formatPersonName(body.name);
    const currency = body.currency === "SLSH" ? "SLSH" : "USD";
    if (!requireCurrencyAccess(user, res, currency)) return;
    if (!name || !name.trim()) return badRequest(res, "Account name is required.");
    if (get("SELECT id FROM clients WHERE name = ?", [name])) return badRequest(res, "An account with this name already exists.");
    // NEGATIVE OPENING BALANCE round: a negative opening balance is now
    // allowed — it represents a customer/company that already owed money
    // (debt) before being entered into the system, exactly the same "a
    // customer account is allowed to carry a negative balance" policy the
    // existing deposit/withdraw ledgerMove routes below already apply (no
    // positive-balance check on withdraw) — this just extends that same,
    // already-existing policy to account creation instead of only to
    // post-creation withdrawals. Cash in Hand accounts remain governed by
    // their own, intentionally different rule (see routes/cash.js).
    const parsedOpening = parseOpeningBalance(body.openingBalance);
    if (parsedOpening.error) return badRequest(res, parsedOpening.error);
    const opening = parsedOpening.value;

    const account = tx(() => {
      const id = uid("cl");
      const accountNumber = nextAccountNumber();
      const balUSD = currency === "USD" ? opening : 0;
      const balSLSH = currency === "SLSH" ? opening : 0;
      // BALANCE & LAST TRANSACTION FIX round: one shared timestamp for the
      // account's own created_at AND its Opening Balance ledger row's
      // date/created_at — previously each called nowISO() separately
      // (missing created_at on the ledger row entirely), which could let
      // the ledger row's `date` land a millisecond apart from the account
      // it belongs to. Harmless by itself, but worth tightening now that
      // chronoSortKey elsewhere relies on created_at as the real
      // insertion-order fallback.
      const createdAt = nowISO();
      run(
        "INSERT INTO clients (id, name, account_number, account_type, currency, contact, email, id_number, address, balance_usd, balance_slsh, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, name, accountNumber, accountType, currency, contact || null, email || null, idNumber || null, address || null, balUSD, balSLSH, createdAt]
      );
      if (opening !== 0) {
        // amount is stored as a positive magnitude, same convention every
        // other ledger row uses — `type` alone carries the sign/direction
        // (see rebuildAccountBalance and openingBalanceFor above).
        const openingType = opening > 0 ? "deposit" : "withdrawal";
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), id, openingType, currency, Math.abs(opening), opening, "Opening balance", user.id, user.name, createdAt, createdAt, nextLedgerReference(openingType)]);
      }
      return get("SELECT * FROM clients WHERE id = ?", [id]);
    });
    addAudit(user, "Account created", `${account.account_number} — ${name} (${accountType}, ${currency})`);
    sendJSON(res, 201, { account: serialize(account) });
  });

  router.patch("/api/accounts/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const existing = get("SELECT * FROM clients WHERE id = ?", [params.id]);
    if (!existing) return notFound(res, "Account not found.");
    if (!requireCurrencyAccess(user, res, existing.currency)) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const accountType = body.accountType !== undefined ? (body.accountType === "company" ? "company" : "customer") : existing.account_type;
    // Uppercase formatting applies only to PERSON names (customer accounts).
    // Company names are left exactly as typed.
    const rawName = body.name !== undefined ? body.name : existing.name;
    const name = accountType === "company" ? (rawName || "").trim() : formatPersonName(rawName);
    if (!name || !name.trim()) return badRequest(res, "Account name is required.");
    if (name !== existing.name && get("SELECT id FROM clients WHERE name = ?", [name])) return badRequest(res, "An account with this name already exists.");
    const contact = body.contact !== undefined ? body.contact : existing.contact;
    const email = body.email !== undefined ? body.email : existing.email;
    const idNumber = body.idNumber !== undefined ? body.idNumber : existing.id_number;
    const address = body.address !== undefined ? body.address : existing.address;
    const notes = body.notes !== undefined ? body.notes : existing.notes;
    // OPENING BALANCE (Customer / Company Information) round: an optional new
    // Opening Balance. It is the account's ONE "Opening balance" ledger entry
    // (the same record account creation writes), edited in place — never a
    // second record — and the account's running balances are then replayed,
    // so the current balance moves by exactly the difference and nothing is
    // counted twice. No change requested (or the same value) = nothing touched.
    const previousOpening = openingBalanceFor(existing.id);
    let newOpening = previousOpening;
    if (body.openingBalance !== undefined) {
      const parsed = parseOpeningBalance(body.openingBalance);
      if (parsed.error) return badRequest(res, parsed.error);
      newOpening = parsed.value;
    }
    const openingChanging = Math.abs(newOpening - previousOpening) >= 0.005;
    if (openingChanging && (existing.status || "active") !== "active") {
      return badRequest(res, "This account is deactivated — reactivate it before changing its Opening Balance.");
    }
    // Currency is fixed once an account has any ledger activity — it defines what the account IS.
    tx(() => {
      run("UPDATE clients SET name=?, account_type=?, contact=?, email=?, id_number=?, address=?, notes=? WHERE id=?", [name, accountType, contact, email, idNumber, address, notes, existing.id]);
      if (!openingChanging) return;
      const row = get("SELECT id FROM account_ledger WHERE client_id = ? AND notes = 'Opening balance' ORDER BY date ASC LIMIT 1", [existing.id]);
      const type = newOpening >= 0 ? "deposit" : "withdrawal";
      if (row && newOpening === 0) {
        run("DELETE FROM account_ledger WHERE id = ?", [row.id]);
      } else if (row) {
        run("UPDATE account_ledger SET type = ?, amount = ? WHERE id = ?", [type, Math.abs(newOpening), row.id]);
      } else {
        // Dated at the account's own creation, so it replays first.
        const at = existing.created_at || nowISO();
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), existing.id, type, existing.currency, Math.abs(newOpening), 0, "Opening balance", user.id, user.name, at, at, nextLedgerReference(type)]);
      }
      rebuildAccountBalance(existing.id, existing.currency);
    });
    addAudit(user, "Account updated", `${existing.account_number} — ${name}`);
    if (openingChanging) {
      addAudit(user, "Opening balance changed", `${existing.account_number} — ${name}: ${fmtMoney(previousOpening, existing.currency)} -> ${fmtMoney(newOpening, existing.currency)}`);
    }
    sendJSON(res, 200, { account: serialize(get("SELECT * FROM clients WHERE id = ?", [existing.id])) });
  });

  // LINKED ACCOUNTS REMOVAL round: POST /api/accounts/:id/link and
  // /api/accounts/:id/unlink (the USD<->SLSH account-pairing endpoints) have
  // been removed entirely per explicit request — no frontend code calls
  // them anymore. clearLink() itself is kept (see its comment above) purely
  // as delete-time cleanup for any link made before this removal.

  function ledgerMove(action, type) {
    router.post(`/api/accounts/:id/${action}`, async (req, res, params) => {
      const user = requireAuth(req, res); if (!user) return;
      if (!requirePerm(user, res, "accountsManage")) return;
      const c = get("SELECT * FROM clients WHERE id = ?", [params.id]);
      if (!c) return notFound(res, "Account not found.");
      if (!requireCurrencyAccess(user, res, c.currency)) return;
      if (c.status !== "active") return badRequest(res, "This account is deactivated — reactivate it before making new transactions.");
      let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
      const amount = toNumber(body.amount);
      const currency = c.currency; // an account only ever transacts in its own currency now
      if (body.currency && body.currency !== currency) return badRequest(res, `This account is ${currency} — amounts must be in ${currency}.`);
      if (!isValidAmount(amount)) return badRequest(res, "Enter a positive amount.");
      // PAYMENT DATE (PAYMENT & TRANSFER UPGRADE round): defaults to today,
      // but the user can back/post-date it — that becomes the transaction's
      // real ACCOUNTING date (what every balance/statement/report already
      // sorts and totals by). `created_at` below is set once, here, to the
      // real system clock, and is never touched again by any later edit —
      // that's the separate, permanent "when was this actually entered"
      // record financial auditing needs.
      const paymentDate = resolvePaymentDate(body.paymentDate);
      if (paymentDate === null) return badRequest(res, "Enter a valid Payment Date.");

      // PAYMENT / CASH IN HAND INTEGRATION round: every Payment now names the
      // exact company Cash Account the money physically came from/went to.
      // Required only when at least one active Cash in Hand account exists
      // for this currency — an installation with none configured yet behaves
      // exactly as before this round (cashAccountId stays null throughout).
      if (!body.cashAccountId && hasActiveCashAccountsFor(currency)) {
        return badRequest(res, "Please select a Cash Account.");
      }
      const { cashAccount, error: cashError } = validatePaymentCashAccount(body.cashAccountId, currency, type, amount);
      if (cashError) return badRequest(res, cashError);

      const createdAt = nowISO();
      const result = tx(() => {
        // balance_after is written as a placeholder (0) here and then
        // recomputed for real, in true chronological order, by
        // rebuildAccountBalance below — required now that Payment Date can be
        // backdated/post-dated: a naive "current balance ± amount" would be
        // wrong (and would leave every later-dated row's own balance_after
        // stale) the moment this entry doesn't land at the end of the
        // account's date-ordered history. Same approach POST /api/transfers
        // already uses for exactly this reason.
        const ledgerId = uid("ldg");
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number, cash_account_id, reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [ledgerId, c.id, type, currency, amount, 0, body.notes || null, user.id, user.name, paymentDate, createdAt, nextLedgerReference(type), cashAccount ? cashAccount.id : null, body.reference || null]);
        rebuildAccountBalance(c.id, currency);
        // Mirrored Cash in Hand leg — SAME direction as the customer-side
        // entry (a customer deposit means money physically came IN; a
        // customer withdrawal means it physically went OUT), fully traceable
        // back to this Payment via source_type/source_id.
        if (cashAccount) {
          postPaymentCashLeg({
            cashAccount, type, amount, date: paymentDate, createdAt,
            staffId: user.id, staffName: user.name, reference: body.reference || null,
            counterpartyClientId: c.id, counterpartyLabel: c.name,
            description: `${type === "deposit" ? "Payment from" : "Payment to"} ${c.name}`,
            sourceId: ledgerId,
          });
        }
        return get("SELECT * FROM clients WHERE id = ?", [c.id]);
      });

      addAudit(user, type === "deposit" ? "Account credit" : "Account debit", `${c.account_number} — ${fmtMoney(amount, currency)}${cashAccount ? ` (${cashAccount.name})` : ""}`);
      sendJSON(res, 200, { account: serialize(result) });
    });
  }
  ledgerMove("deposit", "deposit");
  ledgerMove("withdraw", "withdrawal");

  // BULK TRANSACTION WORKSPACE round: posts a whole batch of deposit/
  // withdrawal transactions — potentially against different accounts and
  // different Cash in Hand sources — as ONE atomic unit. Every item is
  // validated up front using the exact same rules ledgerMove enforces for a
  // single transaction above (account exists/active, currency access,
  // currency match, positive amount, valid Payment Date, Cash in Hand
  // requirement + currency match); if ANY item fails validation, nothing is
  // written at all and the whole batch is rejected with a per-item error
  // list so the client can show exactly which draft rows need fixing. Only
  // once every item passes does the whole set get written inside one tx() —
  // SQLite does not support nested transactions, so this loop runs the same
  // raw run()/rebuildAccountBalance()/postPaymentCashLeg() steps ledgerMove
  // uses directly, rather than re-entering ledgerMove's own tx()-wrapped
  // route handler (which would try to BEGIN a second transaction and roll
  // back the outer one). This never changes what a deposit/withdrawal does
  // or how a balance is computed — it only changes how many of them can be
  // prepared and submitted together.
  router.post("/api/accounts/bulk-deposit-withdraw", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0) return badRequest(res, "No transactions to save.");
    if (items.length > 200) return badRequest(res, "A single batch is limited to 200 transactions — split into smaller batches.");

    // Pass 1: validate every item WITHOUT writing anything.
    const prepared = [];
    const itemErrors = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      // DEPOSIT/WITHDRAW → CREDIT/DEBIT round: "credit"/"debit" are accepted as
      // aliases; the stored type stays deposit/withdrawal (unchanged meaning).
      const type = ["withdraw", "withdrawal", "debit"].includes(item.type) ? "withdrawal" : ["deposit", "credit"].includes(item.type) ? "deposit" : null;
      if (!type) { itemErrors.push({ index, error: "Transaction type must be credit or debit." }); continue; }
      const c = item.accountId ? get("SELECT * FROM clients WHERE id = ?", [item.accountId]) : null;
      if (!c) { itemErrors.push({ index, error: "Account not found." }); continue; }
      if (!hasCurrencyAccess(user, c.currency)) { itemErrors.push({ index, error: `Your role does not have access to ${c.currency} accounts.` }); continue; }
      if (c.status !== "active") { itemErrors.push({ index, error: `${c.account_number} is deactivated — reactivate it before making new transactions.` }); continue; }
      const amount = toNumber(item.amount);
      const currency = c.currency;
      if (item.currency && item.currency !== currency) { itemErrors.push({ index, error: `This account is ${currency} — amounts must be in ${currency}.` }); continue; }
      if (!isValidAmount(amount)) { itemErrors.push({ index, error: "Enter a positive amount." }); continue; }
      const paymentDate = resolvePaymentDate(item.paymentDate);
      if (paymentDate === null) { itemErrors.push({ index, error: "Enter a valid Payment Date." }); continue; }
      if (!item.cashAccountId && hasActiveCashAccountsFor(currency)) { itemErrors.push({ index, error: "Please select a Cash Account." }); continue; }
      const { cashAccount, error: cashError } = validatePaymentCashAccount(item.cashAccountId, currency, type, amount);
      if (cashError) { itemErrors.push({ index, error: cashError }); continue; }
      prepared.push({ index, client: c, type, amount, currency, paymentDate, cashAccount, notes: item.notes || null, reference: item.reference || null });
    }

    if (itemErrors.length > 0) {
      return sendJSON(res, 400, {
        error: `${itemErrors.length} of ${items.length} transaction${items.length === 1 ? "" : "s"} failed validation — nothing was saved. Fix them and try again.`,
        itemErrors,
      });
    }

    // Pass 2: every item is valid — write the whole batch inside ONE
    // transaction, so it either lands completely or not at all.
    const createdAt = nowISO();
    const results = tx(() => {
      const out = [];
      for (const p of prepared) {
        const ledgerId = uid("ldg");
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number, cash_account_id, reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [ledgerId, p.client.id, p.type, p.currency, p.amount, 0, p.notes, user.id, user.name, p.paymentDate, createdAt, nextLedgerReference(p.type), p.cashAccount ? p.cashAccount.id : null, p.reference]);
        rebuildAccountBalance(p.client.id, p.currency);
        if (p.cashAccount) {
          postPaymentCashLeg({
            cashAccount: p.cashAccount, type: p.type, amount: p.amount, date: p.paymentDate, createdAt,
            staffId: user.id, staffName: user.name, reference: p.reference,
            counterpartyClientId: p.client.id, counterpartyLabel: p.client.name,
            description: `${p.type === "deposit" ? "Payment from" : "Payment to"} ${p.client.name}`,
            sourceId: ledgerId,
          });
        }
        out.push({ index: p.index, accountId: p.client.id, accountNumber: p.client.account_number, accountName: p.client.name, type: p.type, amount: p.amount, currency: p.currency });
      }
      return out;
    });

    addAudit(user, "Bulk transaction batch", `${results.length} transaction${results.length === 1 ? "" : "s"} saved`);
    sendJSON(res, 200, { results, count: results.length });
  });

  // Deactivate — blocks all NEW financial transactions on this account
  // (deposit/withdraw/exchange/transfer/quotation-charge) while preserving
  // its balance and full history untouched. Fully reversible via Reactivate.
  router.post("/api/accounts/:id/deactivate", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const c = get("SELECT * FROM clients WHERE id = ?", [params.id]);
    if (!c) return notFound(res, "Account not found.");
    if (c.deleted_at) return notFound(res, "Account not found.");
    if (!requireCurrencyAccess(user, res, c.currency)) return;
    if (c.status === "deactivated") return badRequest(res, "This account is already deactivated.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* reason is optional */ }
    const reason = (body && body.reason) || null;
    run(
      "UPDATE clients SET status = 'deactivated', deactivated_at = ?, deactivated_by = ?, deactivation_reason = ?, reactivated_at = NULL, reactivated_by = NULL WHERE id = ?",
      [nowISO(), user.name, reason, c.id]
    );
    addAudit(user, "Account deactivated", `${c.account_number} — ${c.name}${reason ? ` (${reason})` : ""}`);
    sendJSON(res, 200, { account: serialize(get("SELECT * FROM clients WHERE id = ?", [c.id])) });
  });

  // Reactivate — restores the account's ability to transact. History and
  // balance were never touched by deactivation, so there's nothing to restore
  // beyond the status flag itself.
  router.post("/api/accounts/:id/reactivate", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const c = get("SELECT * FROM clients WHERE id = ?", [params.id]);
    if (!c) return notFound(res, "Account not found.");
    if (c.deleted_at) return notFound(res, "Account not found.");
    if (!requireCurrencyAccess(user, res, c.currency)) return;
    if (c.status !== "deactivated") return badRequest(res, "This account is not deactivated.");
    run(
      "UPDATE clients SET status = 'active', reactivated_at = ?, reactivated_by = ? WHERE id = ?",
      [nowISO(), user.name, c.id]
    );
    addAudit(user, "Account reactivated", `${c.account_number} — ${c.name}`);
    sendJSON(res, 200, { account: serialize(get("SELECT * FROM clients WHERE id = ?", [c.id])) });
  });

  // Permanent Delete — only allowed from the Deactivated state (an active
  // account must be deactivated first), and requires the elevated
  // accountsDelete permission on top of accountsManage. This NEVER issues a
  // real SQL DELETE on the clients row itself: exchange_transactions,
  // transfers, and quotations all hold real FK references to clients(id),
  // and destroying the row would either fail the FK check or silently
  // orphan/break financial history that may belong jointly to ANOTHER
  // still-active account (the other leg of a transfer/exchange). So the
  // client row is always soft-deleted (deleted_at/deleted_by) — the account
  // disappears from every list and picker either way.
  //
  // ACCOUNT DELETE HISTORY OPTION round: by explicit user choice, the caller
  // may additionally opt in (body.deleteHistory === true, default false/off
  // — unchanged legacy behavior) to also purge this account's own
  // account_ledger rows (the per-account Deposit/Withdraw/Balance history
  // shown on its Transactions tab). This is deliberately scoped to
  // account_ledger ONLY: those rows belong solely to this one client, unlike
  // exchange_transactions/transfers/quotations rows, which are shared with a
  // counterparty account and must never be touched here, since erasing them
  // would corrupt a different, possibly still-active account's own history
  // and balance. This purge is real SQL DELETE and is irreversible.
  router.delete("/api/accounts/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    if (!requirePerm(user, res, "accountsDelete")) return;
    const c = get("SELECT * FROM clients WHERE id = ?", [params.id]);
    if (!c || c.deleted_at) return notFound(res, "Account not found.");
    if (!requireCurrencyAccess(user, res, c.currency)) return;
    if (c.status !== "deactivated") return badRequest(res, "Only a deactivated account can be permanently deleted. Deactivate it first.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* confirmation text optional */ }
    // Normalize curly/smart quote variants the same way the frontend's
    // confirm-text check does (see normalizeConfirmText in app.jsx) — some
    // account names were entered with a curly apostrophe (’) that a normal
    // keyboard can never type, so a literal === would make deletion
    // impossible for those accounts.
    const normalizeConfirmText = (s) => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
    if (!body || normalizeConfirmText(body.confirmName) !== normalizeConfirmText(c.name)) return badRequest(res, "Type the account's exact name to confirm permanent deletion.");
    const deleteHistory = body.deleteHistory === true;
    let ledgerRowsDeleted = 0;
    tx(() => {
      clearLink(c.id);
      run("UPDATE clients SET deleted_at = ?, deleted_by = ? WHERE id = ?", [nowISO(), user.name, c.id]);
      if (deleteHistory) {
        ledgerRowsDeleted = all("SELECT COUNT(*) as n FROM account_ledger WHERE client_id = ?", [c.id])[0].n;
        run("DELETE FROM account_ledger WHERE client_id = ?", [c.id]);
      }
    });
    addAudit(
      user,
      "Account permanently deleted",
      deleteHistory
        ? `${c.account_number} — ${c.name} (transaction history also deleted: ${ledgerRowsDeleted} ledger entr${ledgerRowsDeleted === 1 ? "y" : "ies"} permanently removed)`
        : `${c.account_number} — ${c.name}`
    );
    sendJSON(res, 200, { ok: true, historyDeleted: deleteHistory, ledgerRowsDeleted });
  });
}

module.exports = { register };
