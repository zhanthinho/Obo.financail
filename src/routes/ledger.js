"use strict";
const { isValidAmount, toNumber } = require("../util");
const { all, get, run, tx } = require("../db");
const { sendJSON, sendCSV, sendPDF, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm, can, allowedCurrencies, requireCurrencyAccess } = require("../rbac");
const { getCompanySettings, getDefaultPdfTemplate, addAudit, rebuildAccountBalance, rebuildCashAccountBalance } = require("../domain");
const { todayStr, newestFirst } = require("../util");
const { toCSV } = require("../csv");
const { renderReportPDF, renderLedgerReceiptPDF } = require("../pdf");
// PAYMENT / CASH IN HAND INTEGRATION round: a Payment's linked Cash in Hand
// leg (if any) must stay synchronized through this same edit/delete — see
// routes/cash.js for what each helper does.
const { accountBasic: cashAccountBasic, validatePaymentCashAccount, findPaymentCashLeg } = require("./cash");

class LedgerMutationError extends Error {
  constructor(message) { super(message); }
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function canView(user) {
  return can(user, "accountsManage") || can(user, "reports");
}

// A ledger row tagged to an Exchange, Transfer, or Quotation leg is one half
// (or one leg) of a multi-row, type-specific record — editing/deleting it
// through this generic endpoint would bypass that type's own dual-leg
// reversal logic (see EXCHANGE/TRANSFER UPDATE/DELETE) and corrupt the
// record. Only a genuinely plain, unlinked row (source_type IS NULL — a
// real manual deposit/withdrawal) may go through here; anything tagged must
// be edited/deleted from its own module (Money Exchange, the account's
// Transfer actions, or Quotations) instead.
const LINKED_SOURCE_TYPES = { exchange: "Money Exchange", transfer: "its Transfer detail", quotation_charge: "Quotations", quotation_paid: "Quotations", quotation_refund: "Quotations" };
function rejectIfLinked(res, entry) {
  const moduleName = entry.source_type && LINKED_SOURCE_TYPES[entry.source_type];
  if (moduleName) {
    badRequest(res, `This entry is part of a ${entry.source_type.replace("_", " ")} record — edit or delete it from ${moduleName} instead.`);
    return true;
  }
  return false;
}

// CURRENCY / RATE / PROFIT PERMISSIONS round: `allowed` (this user's
// currency.usd/currency.slsh grants, via allowedCurrencies) is folded into
// the same WHERE this function already builds from query filters — the
// account-ledger list, its daily summary, and both CSV/PDF exports all call
// this one function, so gating it here covers every one of them at once.
function queryLedger(query, allowed) {
  const clauses = [], params = [];
  if (allowed) { clauses.push(`l.currency IN (${allowed.map(() => "?").join(",") || "'__none__'"})`); params.push(...allowed); }
  if (query.type && ["deposit", "withdrawal"].includes(query.type)) { clauses.push("l.type = ?"); params.push(query.type); }
  if (query.currency && ["USD", "SLSH"].includes(query.currency)) { clauses.push("l.currency = ?"); params.push(query.currency); }
  if (query.from) { clauses.push("date(l.date) >= date(?)"); params.push(query.from); }
  if (query.to) { clauses.push("date(l.date) <= date(?)"); params.push(query.to); }
  if (query.search) {
    clauses.push("(c.name LIKE ? OR c.account_number LIKE ? OR c.contact LIKE ?)");
    const s = `%${query.search}%`;
    params.push(s, s, s);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const rows = all(
    `SELECT l.*, c.name AS account_name, c.account_number, c.account_type
     FROM account_ledger l JOIN clients c ON c.id = l.client_id ${where} ORDER BY l.date DESC, l.created_at DESC, l.id DESC`,
    params
  );
  newestFirst(rows);
  return rows.map((l) => ({
    id: l.id, type: l.type, currency: l.currency, amount: l.amount, balanceAfter: l.balance_after,
    notes: l.notes, staffName: l.staff_name, date: l.date,
    // PAYMENT & TRANSFER UPGRADE round: createdAt is the real, never-edited
    // system timestamp (see db.js's migration comment) — date above remains
    // the user-editable Payment/Accounting date everything else already used.
    createdAt: l.created_at,
    accountId: l.client_id, accountName: l.account_name, accountNumber: l.account_number, accountType: l.account_type,
    // PAYMENT / CASH IN HAND INTEGRATION round: the Cash in Hand source this
    // Payment was recorded against, if one was selected, plus its free-text
    // Reference (distinct from the auto-generated reference_number).
    cashAccountId: l.cash_account_id, cashAccount: cashAccountBasic(l.cash_account_id), reference: l.reference,
    // AUTOMATIC SHORT REFERENCE NUMBER round: the official, auto-generated,
    // unique reference (e.g. "DEP-2026-0008") was computed and stored since
    // this entry was created (see nextLedgerReference() in domain.js) but
    // was never actually included in this list's response — the frontend
    // Payments table/Payment View had nothing to show but the separate,
    // optional, user-typed `reference` above, which is blank for most
    // entries. Adding it here is additive only: no existing field is
    // removed, no query/calculation changes.
    referenceNumber: l.reference_number,
  }));
}

function register(router) {
  router.get("/api/account-ledger", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage"); // sends the 403
    sendJSON(res, 200, { entries: queryLedger(query, allowedCurrencies(user)) });
  });

  router.get("/api/account-ledger/daily", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const date = query.date || todayStr();
    const entries = queryLedger({}, allowedCurrencies(user)).filter((e) => e.date.slice(0, 10) === date);
    const totals = { depositUSD: 0, depositSLSH: 0, withdrawalUSD: 0, withdrawalSLSH: 0 };
    for (const e of entries) {
      const key = `${e.type}${e.currency}`;
      if (key === "depositUSD") totals.depositUSD += e.amount;
      else if (key === "depositSLSH") totals.depositSLSH += e.amount;
      else if (key === "withdrawalUSD") totals.withdrawalUSD += e.amount;
      else if (key === "withdrawalSLSH") totals.withdrawalSLSH += e.amount;
    }
    sendJSON(res, 200, { date, entries, totals });
  });

  router.get("/api/account-ledger/export.csv", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const entries = queryLedger(query, allowedCurrencies(user));
    let totalDeposit = 0, totalWithdrawal = 0;
    const dataRows = entries.map((e) => {
      const isDeposit = e.type === "deposit";
      if (isDeposit) totalDeposit += e.amount; else totalWithdrawal += e.amount;
      return [
        // AUTOMATIC SHORT REFERENCE NUMBER round: the short official
        // reference (e.g. "DEP-2026-0008") is now included in this export,
        // same field the Payments table/Payment View show on screen —
        // added as a new column, nothing else in this row changed.
        e.referenceNumber || e.id, e.accountNumber, e.accountName, e.date, e.notes || "",
        isDeposit ? e.amount.toFixed(2) : "", isDeposit ? "" : e.amount.toFixed(2),
        e.balanceAfter.toFixed(2), e.staffName || "",
      ];
    });
    dataRows.push(["", "", "", "", "Amount", totalDeposit.toFixed(2), totalWithdrawal.toFixed(2), "", ""]);
    const csv = toCSV(
      ["Reference", "Account #", "Account", "Date", "Notes", "Credit", "Debit", "Balance after", "Staff"],
      dataRows
    );
    addAudit(user, "Credits & debits exported (CSV)", `${entries.length} record(s)`);
    sendCSV(res, "obo-deposits-withdrawals.csv", csv);
  });

  router.get("/api/account-ledger/export.pdf", async (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const entries = queryLedger(query, allowedCurrencies(user));
    let totalDeposit = 0, totalWithdrawal = 0;
    const dataRows = entries.map((e) => {
      const isDeposit = e.type === "deposit";
      if (isDeposit) totalDeposit += e.amount; else totalWithdrawal += e.amount;
      return [
        // AUTOMATIC SHORT REFERENCE NUMBER round: same new Reference column
        // as the CSV export above, same source field.
        e.referenceNumber || e.id, e.accountNumber, e.accountName, e.date.slice(0, 10), e.notes || "",
        isDeposit ? fmtNum(e.amount) : "", isDeposit ? "" : fmtNum(e.amount),
        fmtNum(e.balanceAfter), e.staffName || "",
      ];
    });
    dataRows.push(["", "", "", "", "Amount", fmtNum(totalDeposit), fmtNum(totalWithdrawal), "", ""]);
    const pdf = await renderReportPDF({
      title: "Credits & Debits",
      meta: `${entries.length} record(s)`,
      generatedBy: user.name,
      company: getCompanySettings(),
      // This list can mix both deposit and withdrawal rows, so there's no
      // single "deposit" or "withdrawal" kind to point at — falls back
      // through the "reports" default, then the global default, same
      // resolution getDefaultPdfTemplate always uses (see domain.js).
      template: getDefaultPdfTemplate("reports"),
      columns: [
        { label: "Reference", width: 1 }, { label: "Account #", width: 0.9 }, { label: "Account", width: 1.2 }, { label: "Date", width: 0.8 }, { label: "Notes", width: 1.1 },
        { label: "Credit", width: 0.8, align: "right" }, { label: "Debit", width: 0.8, align: "right" }, { label: "Balance after", width: 0.9, align: "right" }, { label: "Staff", width: 0.9 },
      ],
      rows: dataRows,
    });
    addAudit(user, "Credits & debits exported (PDF)", `${entries.length} record(s)`);
    sendPDF(res, "obo-deposits-withdrawals.pdf", pdf);
  });

  // New single-record Deposit/Withdrawal Receipt (spec's "Deposit Receipt" /
  // "Withdrawal Receipt" document types) — previously a ledger entry only
  // ever appeared as one row in the bulk list export above, with no
  // per-record receipt PDF at all. Template kind matches the entry's own
  // type, so a Super Admin can style deposit and withdrawal receipts
  // differently if they want to.
  router.get("/api/account-ledger/:id/receipt.pdf", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!canView(user)) return requirePerm(user, res, "accountsManage");
    const row = get(
      `SELECT l.*, c.name AS account_name, c.account_number, c.account_type FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE l.id = ?`,
      [params.id]
    );
    if (!row) return notFound(res, "Ledger entry not found.");
    if (!requireCurrencyAccess(user, res, row.currency)) return;
    const entry = {
      id: row.id, type: row.type, currency: row.currency, amount: row.amount, balanceAfter: row.balance_after,
      notes: row.notes, staffName: row.staff_name, date: row.date, createdAt: row.created_at, referenceNumber: row.reference_number,
      accountName: row.account_name, accountNumber: row.account_number,
    };
    const pdf = await renderLedgerReceiptPDF({
      company: getCompanySettings(), entry, generatedBy: user.name,
      template: getDefaultPdfTemplate(entry.type === "deposit" ? "deposit" : "withdrawal"),
    });
    addAudit(user, "Ledger receipt exported (PDF)", `${entry.referenceNumber || entry.id}`);
    sendPDF(res, `${entry.referenceNumber || entry.id}.pdf`, pdf);
  });

  router.patch("/api/account-ledger/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const entry = get("SELECT * FROM account_ledger WHERE id = ?", [params.id]);
    if (!entry) return notFound(res, "Ledger entry not found.");
    if (!requireCurrencyAccess(user, res, entry.currency)) return;
    if (rejectIfLinked(res, entry)) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const amount = body.amount !== undefined ? toNumber(body.amount) : entry.amount;
    if (!isValidAmount(amount)) return badRequest(res, "Amount must be a positive number.");
    const notes = body.notes !== undefined ? body.notes : entry.notes;
    const date = body.date !== undefined ? body.date : entry.date;
    const reference = body.reference !== undefined ? body.reference : entry.reference;
    let newBalance;
    try {
      newBalance = tx(() => {
        run("UPDATE account_ledger SET amount = ?, notes = ?, date = ?, reference = ? WHERE id = ?", [amount, notes, date, reference, entry.id]);
        const bal = rebuildAccountBalance(entry.client_id, entry.currency);
        // PAYMENT / CASH IN HAND INTEGRATION round: a Payment can't change
        // its Cash in Hand account here (no selector in the Edit modal — see
        // its own header note) but its linked leg must track the SAME
        // amount/date/reference this edit just applied, never left stale.
        // DO NOT simply overwrite the account's balance here — rebuild it
        // from scratch, same as the customer-side balance above, so the
        // account's full history stays correct even when this isn't the
        // most recent entry.
        if (entry.cash_account_id) {
          const cashRow = findPaymentCashLeg(entry.id);
          if (cashRow) {
            const { error } = validatePaymentCashAccount(cashRow.cash_account_id, cashRow.currency, entry.type, amount, cashRow.id);
            if (error) throw new LedgerMutationError(error);
            run("UPDATE cash_ledger SET amount = ?, date = ?, reference = ? WHERE id = ?", [amount, date, reference, cashRow.id]);
            rebuildCashAccountBalance(cashRow.cash_account_id);
          }
        }
        return bal;
      });
    } catch (e) {
      if (e instanceof LedgerMutationError) return badRequest(res, e.message);
      throw e;
    }
    addAudit(user, "Ledger entry edited", `${entry.type} of ${amount} ${entry.currency} — new account balance ${newBalance}`);
    const updated = get(
      `SELECT l.*, c.name AS account_name, c.account_number, c.account_type FROM account_ledger l JOIN clients c ON c.id = l.client_id WHERE l.id = ?`,
      [entry.id]
    );
    sendJSON(res, 200, {
      entry: {
        id: updated.id, type: updated.type, currency: updated.currency, amount: updated.amount, balanceAfter: updated.balance_after, notes: updated.notes, staffName: updated.staff_name, date: updated.date, createdAt: updated.created_at, accountId: updated.client_id, accountName: updated.account_name, accountNumber: updated.account_number, accountType: updated.account_type,
        cashAccountId: updated.cash_account_id, cashAccount: cashAccountBasic(updated.cash_account_id), reference: updated.reference,
        // AUTOMATIC SHORT REFERENCE NUMBER round: same addition as queryLedger() above.
        referenceNumber: updated.reference_number,
      },
      newBalance,
    });
  });

  router.delete("/api/account-ledger/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    const entry = get("SELECT * FROM account_ledger WHERE id = ?", [params.id]);
    if (!entry) {
      // The account-side ledger row is already gone (e.g. it was removed by
      // an older version of this flow, or the Cash Movements list the user
      // is looking at is simply stale) — but its mirrored Cash in Hand leg
      // can still be hanging around, tagged with this same id as its
      // source_id. Rather than blocking the user with "not found" and
      // leaving that orphaned entry stuck in Cash in Hand forever, clear it
      // out directly so the cleanup still goes through.
      const orphanCashRow = findPaymentCashLeg(params.id);
      if (orphanCashRow) {
        run("DELETE FROM cash_ledger WHERE id = ?", [orphanCashRow.id]);
        const newCashBalance = rebuildCashAccountBalance(orphanCashRow.cash_account_id);
        addAudit(user, "Orphaned Cash Account entry removed", `${orphanCashRow.reference_number || orphanCashRow.id} — originating payment record was already gone; cleared the leftover Cash Account leg — new cash balance ${newCashBalance}`);
        return sendJSON(res, 200, { deleted: true, orphanCleanup: true });
      }
      return notFound(res, "Ledger entry not found.");
    }
    if (!requireCurrencyAccess(user, res, entry.currency)) return;
    if (rejectIfLinked(res, entry)) return;
    let body; try { body = await readJSONBody(req); } catch (e) { body = {}; }
    const newBalance = tx(() => {
      run("DELETE FROM account_ledger WHERE id = ?", [entry.id]);
      const bal = rebuildAccountBalance(entry.client_id, entry.currency);
      // Delete the mirrored Cash in Hand leg too (same "undo" the rest of
      // the system already applies when a Transfer/Exchange is deleted) so
      // Cash in Hand never keeps a leg for a Payment that no longer exists.
      if (entry.cash_account_id) {
        const cashRow = findPaymentCashLeg(entry.id);
        if (cashRow) {
          run("DELETE FROM cash_ledger WHERE id = ?", [cashRow.id]);
          rebuildCashAccountBalance(cashRow.cash_account_id);
        }
      }
      return bal;
    });
    addAudit(user, "Ledger entry deleted", `${entry.type} of ${entry.amount} ${entry.currency}${body.reason ? " — " + body.reason : ""} — new account balance ${newBalance}`);
    sendJSON(res, 200, { deleted: true, newBalance });
  });
}

module.exports = { register };
