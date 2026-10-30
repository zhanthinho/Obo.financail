"use strict";
const { isValidAmount, toNumber } = require("../util");
// LOAN/DEBT feature — built alongside Cash in Hand since every loan is
// money LEAVING a specific Cash Account into a customer's hands. Deliberately
// its own table (cash_loans/cash_loan_payments in schema.sql), never
// touching clients.balance_usd/balance_slsh or account_ledger — a loan's
// "debt receivable" lives entirely in cash_loans.outstanding_amount, so this
// feature cannot corrupt any existing customer account/ledger/balance.
const { all, get, run, tx } = require("../db");
const { sendJSON, badRequest, notFound, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { addAudit, rebuildCashAccountBalance, nextLoanReference, nextLoanPaymentReference, nextCashLedgerReference } = require("../domain");
const { uid, nowISO, fmtMoney, resolvePaymentDate, newestFirst } = require("../util");
const { accountBasic } = require("./cash");

class LoanMutationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function clientBasic(id) {
  if (!id) return null;
  const c = get("SELECT id, name, account_number FROM clients WHERE id = ?", [id]);
  return c ? { id: c.id, name: c.name, accountNumber: c.account_number } : null;
}
function loanToJSON(l) {
  return {
    id: l.id, referenceNumber: l.reference_number,
    clientId: l.client_id, clientName: l.client_name, client: clientBasic(l.client_id),
    cashAccountId: l.cash_account_id, cashAccount: accountBasic(l.cash_account_id),
    currency: l.currency, principalAmount: l.principal_amount, outstandingAmount: l.outstanding_amount,
    status: l.status, notes: l.notes, date: l.date, staffId: l.staff_id, staffName: l.staff_name,
    createdAt: l.created_at, paidAt: l.paid_at, writtenOffAt: l.written_off_at, writtenOffReason: l.written_off_reason,
  };
}
function paymentToJSON(p) {
  return {
    id: p.id, loanId: p.loan_id, cashAccountId: p.cash_account_id, cashAccount: accountBasic(p.cash_account_id),
    amount: p.amount, currency: p.currency, date: p.date, notes: p.notes, referenceNumber: p.reference_number,
    staffId: p.staff_id, staffName: p.staff_name, createdAt: p.created_at,
  };
}

function register(router) {
  router.get("/api/loans", (req, res, params, query) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.view")) return;
    const clauses = [], p = [];
    if (query.clientId) { clauses.push("client_id = ?"); p.push(query.clientId); }
    if (query.cashAccountId) { clauses.push("cash_account_id = ?"); p.push(query.cashAccountId); }
    if (query.currency && query.currency !== "all") { clauses.push("currency = ?"); p.push(query.currency); }
    if (query.status && query.status !== "all") { clauses.push("status = ?"); p.push(query.status); }
    if (query.search) { clauses.push("(client_name LIKE ? OR reference_number LIKE ?)"); p.push(`%${query.search}%`, `%${query.search}%`); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = all(`SELECT * FROM cash_loans ${where} ORDER BY date DESC, created_at DESC, id DESC`, p);
    newestFirst(rows);
    sendJSON(res, 200, { loans: rows.map(loanToJSON) });
  });

  router.get("/api/loans/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.view")) return;
    const l = get("SELECT * FROM cash_loans WHERE id = ?", [params.id]);
    if (!l) return notFound(res, "Loan not found.");
    const payments = all("SELECT * FROM cash_loan_payments WHERE loan_id = ? ORDER BY date ASC, created_at ASC", [params.id]);
    sendJSON(res, 200, { loan: loanToJSON(l), payments: payments.map(paymentToJSON) });
  });

  router.post("/api/loans", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.create")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!body.clientId) return badRequest(res, "Select the customer receiving this loan.");
    const client = get("SELECT id, name FROM clients WHERE id = ?", [body.clientId]);
    if (!client) return notFound(res, "Customer account not found.");
    if (!body.cashAccountId) return badRequest(res, "Select the Cash Account this loan is paid from.");
    const cashAccount = get("SELECT * FROM cash_accounts WHERE id = ?", [body.cashAccountId]);
    if (!cashAccount) return notFound(res, "Cash account not found.");
    if (cashAccount.status !== "active") return badRequest(res, `${cashAccount.name} is deactivated.`);
    const amount = toNumber(body.amount);
    if (!isValidAmount(amount)) return badRequest(res, "Enter a positive loan amount.");
    // CASH IN HAND NEGATIVE BALANCE round: a loan disbursement may take the
    // paying Cash in Hand account negative, same as a plain Cash in Hand
    // withdrawal (see routes/cash.js) — matching the customer-accounts debt
    // policy.
    const paymentDate = resolvePaymentDate(body.date);
    if (paymentDate === null) return badRequest(res, "Enter a valid date.");

    const id = uid("ln");
    const refNum = nextLoanReference();
    const ledgerRef = nextCashLedgerReference("withdrawal");
    const createdAt = nowISO();
    tx(() => {
      run(
        "INSERT INTO cash_loans (id, reference_number, client_id, client_name, cash_account_id, currency, principal_amount, outstanding_amount, status, notes, date, staff_id, staff_name, created_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?)",
        [id, refNum, client.id, client.name, cashAccount.id, cashAccount.currency, amount, amount, body.notes || null, paymentDate, user.id, user.name, createdAt]
      );
      run(
        "INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, counterparty_client_id, counterparty_label, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("csl"), cashAccount.id, "withdrawal", cashAccount.currency, amount, 0, `Loan to ${client.name}`, ledgerRef, client.id, `${client.name} — Customer`, user.id, user.name, paymentDate, createdAt, "loan", id]
      );
      rebuildCashAccountBalance(cashAccount.id);
    });
    addAudit(user, "Loan recorded", `${fmtMoney(amount, cashAccount.currency)} to ${client.name} from ${cashAccount.name}`);
    sendJSON(res, 201, { loan: loanToJSON(get("SELECT * FROM cash_loans WHERE id = ?", [id])) });
  });

  // Record a repayment — deposits the repaid amount back into a chosen cash
  // account and reduces the loan's own outstanding_amount. A loan's
  // "receivable" never touches the customer's real clients balance, so a
  // repayment here is purely a Cash in Hand deposit + this table's own math.
  router.post("/api/loans/:id/payments", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.repay")) return;
    const loan = get("SELECT * FROM cash_loans WHERE id = ?", [params.id]);
    if (!loan) return notFound(res, "Loan not found.");
    if (loan.status !== "active") return badRequest(res, "This loan is already settled or written off.");
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    if (!body.cashAccountId) return badRequest(res, "Select the Cash Account receiving this repayment.");
    const cashAccount = get("SELECT * FROM cash_accounts WHERE id = ?", [body.cashAccountId]);
    if (!cashAccount) return notFound(res, "Cash account not found.");
    if (cashAccount.status !== "active") return badRequest(res, `${cashAccount.name} is deactivated.`);
    if (cashAccount.currency !== loan.currency) return badRequest(res, `This loan is in ${loan.currency} — repayments must go into a ${loan.currency} cash account.`);
    const amount = toNumber(body.amount);
    if (!isValidAmount(amount)) return badRequest(res, "Enter a positive repayment amount.");
    if (round2(amount) > round2(loan.outstanding_amount) + 0.005) {
      return badRequest(res, `Repayment exceeds the outstanding balance of ${fmtMoney(loan.outstanding_amount, loan.currency)}.`);
    }
    const paymentDate = resolvePaymentDate(body.date);
    if (paymentDate === null) return badRequest(res, "Enter a valid date.");

    const id = uid("lnp");
    const refNum = nextLoanPaymentReference();
    const ledgerRef = nextCashLedgerReference("deposit");
    const createdAt = nowISO();
    let newOutstanding;
    tx(() => {
      run(
        "INSERT INTO cash_loan_payments (id, loan_id, cash_account_id, amount, currency, date, notes, reference_number, staff_id, staff_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [id, loan.id, cashAccount.id, amount, loan.currency, paymentDate, body.notes || null, refNum, user.id, user.name, createdAt]
      );
      run(
        "INSERT INTO cash_ledger (id, cash_account_id, type, currency, amount, balance_after, description, reference_number, counterparty_client_id, counterparty_label, staff_id, staff_name, date, created_at, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [uid("csl"), cashAccount.id, "deposit", cashAccount.currency, amount, 0, `Loan repayment from ${loan.client_name}`, ledgerRef, loan.client_id, `${loan.client_name} — Customer`, user.id, user.name, paymentDate, createdAt, "loan_repayment", loan.id]
      );
      rebuildCashAccountBalance(cashAccount.id);
      newOutstanding = round2(loan.outstanding_amount - amount);
      const nowPaidOff = newOutstanding <= 0.005;
      run("UPDATE cash_loans SET outstanding_amount = ?, status = ?, paid_at = ? WHERE id = ?",
        [Math.max(0, newOutstanding), nowPaidOff ? "paid" : "active", nowPaidOff ? createdAt : null, loan.id]);
    });
    addAudit(user, "Loan repayment recorded", `${fmtMoney(amount, loan.currency)} from ${loan.client_name} into ${cashAccount.name}`);
    sendJSON(res, 201, {
      payment: paymentToJSON(get("SELECT * FROM cash_loan_payments WHERE id = ?", [id])),
      loan: loanToJSON(get("SELECT * FROM cash_loans WHERE id = ?", [loan.id])),
    });
  });

  router.post("/api/loans/:id/write-off", async (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.writeOff")) return;
    const loan = get("SELECT * FROM cash_loans WHERE id = ?", [params.id]);
    if (!loan) return notFound(res, "Loan not found.");
    if (loan.status !== "active") return badRequest(res, "This loan is already settled or written off.");
    let body = {}; try { body = await readJSONBody(req); } catch (e) { /* optional reason */ }
    run("UPDATE cash_loans SET status = 'written_off', written_off_at = ?, written_off_reason = ? WHERE id = ?", [nowISO(), body.reason || null, loan.id]);
    addAudit(user, "Loan written off", `${loan.reference_number || loan.id} — ${fmtMoney(loan.outstanding_amount, loan.currency)} outstanding, ${loan.client_name}`);
    sendJSON(res, 200, { loan: loanToJSON(get("SELECT * FROM cash_loans WHERE id = ?", [loan.id])) });
  });

  // Permanent delete — only allowed before any repayment has been recorded
  // (mirrors Transfer/Exchange Delete's "undo the original effect" pattern),
  // reversing the original cash withdrawal.
  router.delete("/api/loans/:id", (req, res, params) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "loans.delete")) return;
    let result;
    try {
      result = tx(() => {
        const loan = get("SELECT * FROM cash_loans WHERE id = ?", [params.id]);
        if (!loan) throw new LoanMutationError(404, "Loan not found.");
        const hasPayments = get("SELECT COUNT(*) as n FROM cash_loan_payments WHERE loan_id = ?", [loan.id])?.n || 0;
        if (hasPayments) throw new LoanMutationError(400, "This loan already has repayments recorded and can't be permanently deleted — write it off instead.");
        run("DELETE FROM cash_ledger WHERE source_type = 'loan' AND source_id = ?", [loan.id]);
        run("DELETE FROM cash_loans WHERE id = ?", [loan.id]);
        rebuildCashAccountBalance(loan.cash_account_id);
        return loan;
      });
    } catch (e) {
      if (e instanceof LoanMutationError) return e.status === 404 ? notFound(res, e.message) : badRequest(res, e.message);
      throw e;
    }
    addAudit(user, "Loan deleted", `${fmtMoney(result.principal_amount, result.currency)} to ${result.client_name}`);
    sendJSON(res, 200, { deleted: true, id: result.id });
  });
}

module.exports = { register };
