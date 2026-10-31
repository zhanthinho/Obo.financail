"use strict";
// MARK AS PAID round — the ONE implementation of an ordinary customer
// Payment (Credit = deposit, Debit = withdrawal), shared by:
//   * POST /api/accounts/:id/deposit|withdraw (the Payments module), and
//   * POST /api/transactions with markPaid (Quick Exchange -> Mark as Paid).
// Both go through preparePayment() (validation) and postPayment() (the
// writes), so a Credit made from Quick Exchange is exactly the same kind of
// record as one made in Payments: same table (account_ledger, source_type
// NULL), same reference series (DEP-/WDR-), same Cash Account leg, same
// balance rebuild.
const { get, run } = require("./db");
const { isValidAmount, toNumber, uid, resolvePaymentDate } = require("./util");
const { nextLedgerReference, rebuildAccountBalance } = require("./domain");

// Lazily required: routes/cash.js requires domain.js, and loading it at the
// top of this file would create a require cycle through routes/accounts.js.
const cash = () => require("./routes/cash");

// Validates a payment against ONE account. Returns { error } or { plan }.
// Nothing is written.
function preparePayment({ account, type, amount, paymentDate, cashAccountId, notes, reference, currency }) {
  if (!account) return { error: "Account not found." };
  if (type !== "deposit" && type !== "withdrawal") return { error: "Unknown payment type." };
  if (account.status !== "active") return { error: "This account is deactivated — reactivate it before making new transactions." };
  const cur = account.currency; // an account only ever transacts in its own currency
  if (currency && currency !== cur) return { error: `This account is ${cur} — amounts must be in ${cur}.` };
  const amt = toNumber(amount);
  if (!isValidAmount(amt)) return { error: "Enter a positive amount." };
  const date = resolvePaymentDate(paymentDate);
  if (date === null) return { error: "Enter a valid Payment Date." };
  // A Payment names the company Cash Account the money physically came
  // from / went to — required once any active Cash Account exists for this
  // currency (an installation with none behaves as before).
  if (!cashAccountId && cash().hasActiveCashAccountsFor(cur)) return { error: "Please select a Cash Account." };
  const { cashAccount, error } = cash().validatePaymentCashAccount(cashAccountId || null, cur, type, amt);
  if (error) return { error };
  return {
    plan: {
      account, type, currency: cur, amount: amt, date, cashAccount,
      notes: typeof notes === "string" && notes.trim() ? notes : null,
      reference: typeof reference === "string" && reference.trim() ? reference.trim().slice(0, 120) : null,
    },
  };
}

// Writes a prepared payment. Must run inside the caller's tx(). Returns the
// new account_ledger id.
function postPayment(plan, user, createdAt) {
  const { account, type, currency, amount, date, cashAccount, notes, reference } = plan;
  // balance_after is a placeholder; rebuildAccountBalance recomputes every
  // row in true date order (a payment may be back- or post-dated).
  const ledgerId = uid("ldg");
  run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, created_at, reference_number, cash_account_id, reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [ledgerId, account.id, type, currency, amount, 0, notes, user.id, user.name, date, createdAt, nextLedgerReference(type), cashAccount ? cashAccount.id : null, reference]);
  rebuildAccountBalance(account.id, currency);
  // Mirrored Cash Account leg — same direction as the customer-side entry,
  // traceable back to this payment via source_type/source_id.
  if (cashAccount) {
    cash().postPaymentCashLeg({
      cashAccount, type, amount, date, createdAt,
      staffId: user.id, staffName: user.name, reference,
      counterpartyClientId: account.id, counterpartyLabel: account.name,
      description: `${type === "deposit" ? "Payment from" : "Payment to"} ${account.name}`,
      sourceId: ledgerId,
    });
  }
  return ledgerId;
}

// A payment as shown next to the exchange it belongs to.
function paymentSummary(ledgerId) {
  if (!ledgerId) return null;
  const l = get("SELECT id, client_id, type, currency, amount, date, reference_number, reference, cash_account_id, notes FROM account_ledger WHERE id = ?", [ledgerId]);
  if (!l) return { ledgerId, deleted: true };
  const acc = get("SELECT id, name, account_number FROM clients WHERE id = ?", [l.client_id]);
  const ca = l.cash_account_id ? get("SELECT id, name, currency FROM cash_accounts WHERE id = ?", [l.cash_account_id]) : null;
  return {
    ledgerId: l.id, type: l.type, currency: l.currency, amount: l.amount, date: l.date,
    referenceNumber: l.reference_number, reference: l.reference, notes: l.notes,
    account: acc ? { id: acc.id, name: acc.name, accountNumber: acc.account_number } : null,
    cashAccount: ca ? { id: ca.id, name: ca.name, currency: ca.currency } : null,
    deleted: false,
  };
}

module.exports = { preparePayment, postPayment, paymentSummary };
