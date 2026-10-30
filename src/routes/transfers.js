"use strict";
const { isValidAmount } = require("../util");
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody, sendPDF } = require("../http-helpers");
const { requireAuth, requirePerm, allowedCurrencies, requireCurrencyAccess } = require("../rbac");
const { addAudit, rebuildAccountBalance, nextTransferReference, getCompanySettings, getDefaultPdfTemplate } = require("../domain");
const { uid, nowISO, fmtMoney, resolvePaymentDate, newestFirst } = require("../util");
const { renderTransferReceiptPDF } = require("../pdf");

// Thrown from inside an Update/Delete transaction for an expected,
// user-facing problem — mirrors TransactionMutationError in transactions.js
// (the Exchange Update/Delete reference implementation this mirrors).
class TransferMutationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A Transfer moves money between two DIFFERENT accounts of the SAME
// currency (e.g. Customer A's USD account -> Customer B's USD account).
// This is deliberately distinct from an Exchange, which always converts
// between USD and SLSH for one client. Like every other money-moving action
// in this system, a transfer is never blocked for insufficient funds — an
// account is allowed to go negative (into debt) per business policy.
function basicInfo(id) {
  if (!id) return null;
  const c = get("SELECT id, name, account_number, currency, status FROM clients WHERE id = ?", [id]);
  return c ? { id: c.id, name: c.name, accountNumber: c.account_number, currency: c.currency, status: c.status } : null;
}
function rowToJSON(t) {
  return {
    id: t.id, date: t.date, createdAt: t.created_at, referenceNumber: t.reference_number, reference: t.reference || null,
    fromAccountId: t.from_account_id, toAccountId: t.to_account_id,
    fromAccount: basicInfo(t.from_account_id), toAccount: basicInfo(t.to_account_id),
    currency: t.currency, amount: t.amount, notes: t.notes,
    staffId: t.staff_id, staffName: t.staff_name,
    status: t.status, voidReason: t.void_reason, voidedBy: t.voided_by, voidedAt: t.voided_at,
  };
}

function register(router) {
  router.get("/api/transfers", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    const allowed = allowedCurrencies(user);
    if (allowed.length === 0) return sendJSON(res, 200, { transfers: [] });
    const clauses = [], sqlParams = [];
    if (allowed.length < 2) { clauses.push(`currency IN (${allowed.map(() => "?").join(",")})`); sqlParams.push(...allowed); }
    if (query.accountId) { clauses.push("(from_account_id = ? OR to_account_id = ?)"); sqlParams.push(query.accountId, query.accountId); }
    if (query.from) { clauses.push("date(date) >= date(?)"); sqlParams.push(query.from); }
    if (query.to) { clauses.push("date(date) <= date(?)"); sqlParams.push(query.to); }
    if (query.status && query.status !== "all") { clauses.push("status = ?"); sqlParams.push(query.status); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(`SELECT * FROM transfers ${where} ORDER BY date DESC, created_at DESC, id DESC`, sqlParams);
    newestFirst(rows);
    sendJSON(res, 200, { transfers: rows.map(rowToJSON) });
  });

  // New "Transfer Receipt" document — Transfers had zero export/PDF
  // capability at all before this round.
  router.get("/api/transfers/:id/receipt.pdf", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    const row = get("SELECT * FROM transfers WHERE id = ?", [params.id]);
    if (!row) return notFound(res, "Transfer not found.");
    if (!requireCurrencyAccess(user, res, row.currency)) return;
    const t = rowToJSON(row);
    const pdf = await renderTransferReceiptPDF({
      company: getCompanySettings(), t, generatedBy: user.name,
      template: getDefaultPdfTemplate("transfer"),
    });
    addAudit(user, "Transfer receipt exported (PDF)", t.referenceNumber || t.id);
    sendPDF(res, `${t.referenceNumber || t.id}.pdf`, pdf);
  });

  router.post("/api/transfers", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "accountsManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const amount = Number(body.amount);
    if (!body.fromAccountId || !body.toAccountId) return badRequest(res, "Both a source and a destination account are required.");
    if (body.fromAccountId === body.toAccountId) return badRequest(res, "Source and destination accounts must be different.");
    if (!isValidAmount(amount)) return badRequest(res, "Enter a positive amount.");

    const fromAccount = get("SELECT * FROM clients WHERE id = ?", [body.fromAccountId]);
    if (!fromAccount) return notFound(res, "Source account not found.");
    const toAccount = get("SELECT * FROM clients WHERE id = ?", [body.toAccountId]);
    if (!toAccount) return notFound(res, "Destination account not found.");
    if (fromAccount.status !== "active") return badRequest(res, `${fromAccount.name}'s account is deactivated — reactivate it before transferring from it.`);
    if (toAccount.status !== "active") return badRequest(res, `${toAccount.name}'s account is deactivated — reactivate it before transferring into it.`);
    if (!requireCurrencyAccess(user, res, fromAccount.currency)) return;
    if (!requireCurrencyAccess(user, res, toAccount.currency)) return;
    // A Transfer is same-currency by definition — moving between USD and
    // SLSH is an Exchange instead.
    if (fromAccount.currency !== toAccount.currency) {
      return badRequest(res, `A transfer must be between two accounts of the same currency — ${fromAccount.name} is ${fromAccount.currency}, ${toAccount.name} is ${toAccount.currency}. Use Currency Exchange instead.`);
    }
    const currency = fromAccount.currency;
    // INSUFFICIENT BALANCE (PAYMENT & TRANSFER UPGRADE round): unlike a plain
    // Deposit/Withdraw or an Exchange — both of which deliberately allow an
    // account to go negative, per long-standing business policy — a Transfer
    // is blocked outright when the source account can't cover it. This is a
    // new, Transfer-specific rule the spec calls for explicitly; it does not
    // change that existing policy anywhere else.
    const availableBalance = currency === "USD" ? fromAccount.balance_usd : fromAccount.balance_slsh;
    if (amount > availableBalance) {
      return badRequest(res, `Insufficient balance in the source account. Available: ${fmtMoney(availableBalance, currency)}. You can transfer up to ${fmtMoney(availableBalance, currency)}.`);
    }
    const paymentDate = resolvePaymentDate(body.paymentDate);
    if (paymentDate === null) return badRequest(res, "Enter a valid Payment Date.");
    const txDate = paymentDate;
    const createdAt = nowISO();
    const id = uid("tr");
    const referenceNumber = nextTransferReference();

    tx(() => {
      run(
        `INSERT INTO transfers (id, date, created_at, from_account_id, to_account_id, currency, amount, notes, reference, staff_id, staff_name, status, reference_number)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?)`,
        [id, txDate, createdAt, fromAccount.id, toAccount.id, currency, amount, body.notes || null, body.reference || null, user.id, user.name, referenceNumber]
      );
      run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("ldg"), fromAccount.id, "withdrawal", currency, amount, 0, `Transfer to ${toAccount.name} (${toAccount.account_number})`, user.id, user.name, txDate, createdAt, "transfer", id]);
      rebuildAccountBalance(fromAccount.id, currency);
      run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("ldg"), toAccount.id, "deposit", currency, amount, 0, `Transfer from ${fromAccount.name} (${fromAccount.account_number})`, user.id, user.name, txDate, createdAt, "transfer", id]);
      rebuildAccountBalance(toAccount.id, currency);
    });
    addAudit(user, "Transfer recorded", `${fmtMoney(amount, currency)} from ${fromAccount.name} to ${toAccount.name}`);
    sendJSON(res, 201, { transfer: rowToJSON(get("SELECT * FROM transfers WHERE id = ?", [id])) });
  });

  // TRANSFER DELETE — PERMANENT FULL DATA DELETION. Replaces the old Void
  // flow entirely (see TRANSACTION HISTORY round): there is no more soft-
  // cancel that leaves a "voided" row plus a separate, untagged reversal
  // entry sitting in the database forever. Delete means permanently gone —
  // the transfer row itself, and every account_ledger row it created, are
  // removed for real; any real balance effect is reversed first by deleting
  // the very ledger rows that caused it and rebuilding from what's left —
  // exactly mirroring EXCHANGE DELETE in transactions.js.
  router.delete("/api/transfers/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "transferDelete")) return;
    const existing = get("SELECT currency FROM transfers WHERE id = ?", [params.id]);
    if (existing && !requireCurrencyAccess(user, res, existing.currency)) return;
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* optional reason */ }

    let deleted;
    try {
      deleted = tx(() => {
        // Re-read inside the transaction — same double-click/double-delete
        // safety as Exchange Delete (node:sqlite runs this whole synchronous
        // callback to completion before any other request's JS can run).
        const t = get("SELECT * FROM transfers WHERE id = ?", [params.id]);
        if (!t) throw new TransferMutationError(404, "Transfer not found.");
        // A transfer voided under the old system already had its effect
        // reversed via a separate, untagged entry not linked back to this
        // id — deleting this transfer's own tagged rows now would double
        // the reversal. Nothing further to reverse for one of these.
        if (t.status === "voided") throw new TransferMutationError(400, "This transfer was already voided and has no remaining financial effect to reverse or delete.");

        const fromAcc = get("SELECT id, currency FROM clients WHERE id = ?", [t.from_account_id]);
        const toAcc = get("SELECT id, currency FROM clients WHERE id = ?", [t.to_account_id]);

        // Delete only the ledger rows this transfer itself created — never
        // anything else belonging to these accounts — identified precisely
        // by source_type/source_id.
        run("DELETE FROM account_ledger WHERE source_type = 'transfer' AND source_id = ?", [t.id]);
        run("DELETE FROM transfers WHERE id = ?", [t.id]);
        if (fromAcc) rebuildAccountBalance(fromAcc.id, fromAcc.currency);
        if (toAcc) rebuildAccountBalance(toAcc.id, toAcc.currency);
        return t;
      });
    } catch (e) {
      if (e instanceof TransferMutationError) return e.status === 404 ? notFound(res, e.message) : badRequest(res, e.message);
      throw e;
    }
    const reasonNote = body.reason && body.reason.trim() ? ` — ${body.reason.trim()}` : "";
    addAudit(user, "Transfer deleted permanently", `${fmtMoney(deleted.amount, deleted.currency)} from ${deleted.from_account_id} to ${deleted.to_account_id}${reasonNote}`);
    sendJSON(res, 200, { deleted: true, id: deleted.id });
  });

  // TRANSFER UPDATE — a transfer takes financial effect the instant it's
  // created, so editing one is handled with the same "undo the OLD effect,
  // then apply the NEW one, in one transaction" care as EXCHANGE UPDATE:
  // delete this transfer's own tagged ledger rows and rebuild whichever
  // account(s) they belonged to (restoring the OLD accounts to their
  // pre-transfer balance), THEN write the edited fields onto the same
  // transfers row and re-post fresh ledger rows — still tagged to this same
  // transfer id — against the (possibly different) account pair the edited
  // form now points at. The transfer row itself is never deleted/recreated.
  router.patch("/api/transfers/:id", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "transferUpdate")) return;
    const existingTransfer = get("SELECT currency FROM transfers WHERE id = ?", [params.id]);
    if (existingTransfer && !requireCurrencyAccess(user, res, existingTransfer.currency)) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const amount = Number(body.amount);
    if (!body.fromAccountId || !body.toAccountId) return badRequest(res, "Both a source and a destination account are required.");
    if (body.fromAccountId === body.toAccountId) return badRequest(res, "Source and destination accounts must be different.");
    if (!isValidAmount(amount)) return badRequest(res, "Enter a positive amount.");

    const newFromAccount = get("SELECT * FROM clients WHERE id = ?", [body.fromAccountId]);
    if (!newFromAccount) return notFound(res, "Source account not found.");
    const newToAccount = get("SELECT * FROM clients WHERE id = ?", [body.toAccountId]);
    if (!newToAccount) return notFound(res, "Destination account not found.");
    if (!requireCurrencyAccess(user, res, newFromAccount.currency)) return;
    if (!requireCurrencyAccess(user, res, newToAccount.currency)) return;
    if (newFromAccount.status !== "active") return badRequest(res, `${newFromAccount.name}'s account is deactivated — reactivate it before transferring from it.`);
    if (newToAccount.status !== "active") return badRequest(res, `${newToAccount.name}'s account is deactivated — reactivate it before transferring into it.`);
    if (newFromAccount.currency !== newToAccount.currency) {
      return badRequest(res, `A transfer must be between two accounts of the same currency — ${newFromAccount.name} is ${newFromAccount.currency}, ${newToAccount.name} is ${newToAccount.currency}. Use Currency Exchange instead.`);
    }
    const newCurrency = newFromAccount.currency;
    const paymentDate = resolvePaymentDate(body.date ?? body.paymentDate);
    if (paymentDate === null) return badRequest(res, "Enter a valid Payment Date.");

    let result;
    try {
      result = tx(() => {
        const t = get("SELECT * FROM transfers WHERE id = ?", [params.id]);
        if (!t) throw new TransferMutationError(404, "Transfer not found.");
        if (t.status === "voided") throw new TransferMutationError(400, "This transfer was voided under the old system and can no longer be edited.");

        const oldFromAcc = get("SELECT id, currency FROM clients WHERE id = ?", [t.from_account_id]);
        const oldToAcc = get("SELECT id, currency FROM clients WHERE id = ?", [t.to_account_id]);

        // Undo the OLD effect first — mirrors DELETE exactly — before
        // touching the row, so an invalid edit leaves nothing half-applied.
        run("DELETE FROM account_ledger WHERE source_type = 'transfer' AND source_id = ?", [t.id]);
        if (oldFromAcc) rebuildAccountBalance(oldFromAcc.id, oldFromAcc.currency);
        if (oldToAcc) rebuildAccountBalance(oldToAcc.id, oldToAcc.currency);

        // INSUFFICIENT BALANCE, re-checked here (not before the tx) so it's
        // evaluated against the source account's balance with the transfer's
        // OWN old effect already undone — otherwise editing a transfer's own
        // amount upward could be wrongly rejected against a balance that
        // still includes the very withdrawal being replaced.
        const freshFrom = get("SELECT * FROM clients WHERE id = ?", [newFromAccount.id]);
        const availableBalance = newCurrency === "USD" ? freshFrom.balance_usd : freshFrom.balance_slsh;
        if (amount > availableBalance) {
          throw new TransferMutationError(400, `Insufficient balance in the source account. Available: ${fmtMoney(availableBalance, newCurrency)}. You can transfer up to ${fmtMoney(availableBalance, newCurrency)}.`);
        }

        const txDate = paymentDate;
        run(
          "UPDATE transfers SET date=?, from_account_id=?, to_account_id=?, currency=?, amount=?, notes=?, reference=? WHERE id=?",
          [txDate, newFromAccount.id, newToAccount.id, newCurrency, amount, body.notes || null, body.reference || null, t.id]
        );

        // Re-apply the NEW effect, tagged back to this same transfer id so a
        // later Update or Delete still finds and reverses exactly these rows.
        // created_at is deliberately NOT touched here — the row's real
        // creation time never changes, no matter how many times its Payment
        // Date/accounts/amount are later edited.
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), newFromAccount.id, "withdrawal", newCurrency, amount, 0, `Transfer to ${newToAccount.name} (${newToAccount.account_number})`, user.id, user.name, txDate, t.created_at || nowISO(), "transfer", t.id]);
        rebuildAccountBalance(newFromAccount.id, newCurrency);
        run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uid("ldg"), newToAccount.id, "deposit", newCurrency, amount, 0, `Transfer from ${newFromAccount.name} (${newFromAccount.account_number})`, user.id, user.name, txDate, t.created_at || nowISO(), "transfer", t.id]);
        rebuildAccountBalance(newToAccount.id, newCurrency);

        return { before: t, after: get("SELECT * FROM transfers WHERE id = ?", [t.id]) };
      });
    } catch (e) {
      if (e instanceof TransferMutationError) return e.status === 404 ? notFound(res, e.message) : badRequest(res, e.message);
      throw e;
    }

    const { before, after } = result;
    addAudit(user, "Transfer updated", `${fmtMoney(before.amount, before.currency)} (${before.from_account_id} → ${before.to_account_id}) changed to ${fmtMoney(after.amount, after.currency)} (${after.from_account_id} → ${after.to_account_id})`);
    sendJSON(res, 200, { transfer: rowToJSON(after) });
  });
}

module.exports = { register, rowToJSON };
