"use strict";
// ACCOUNT-LEVEL ACCESS round — per account access on top of the role
// permissions, set on a ROLE (table role_account_access: everyone holding
// the role) and/or on one USER (table user_account_access). Both are the
// company's own tables. A user's effective level on an account is the MOST
// RESTRICTIVE of the two (no row = "full").
//
// Levels (per role + account, per user + account):
//   full    — everything the user's ROLE already allows (the default: an
//             account with no row is "full", so nothing changes for existing
//             users until an administrator restricts them)
//   view    — see the account, its balance and history; no credit, no debit,
//             no edit / delete / reversal
//   credit  — view + money INTO the account (credit)
//   debit   — view + money OUT of the account (debit)
//   none    — the account does not exist for this user: not listed, not
//             searchable, not selectable, no balance, no history, 404 on
//             every direct request
//
// The most restrictive rule wins: the role must allow the action AND the
// account level must allow it. Account levels never add anything a role
// does not grant. A Super Admin is never restricted.
//
// Which accounts an operation touches, and how:
//   deposit -> credit · withdrawal -> debit
//   transfer: source -> debit, destination -> credit
//   exchange: From Account -> debit, Receiving Account -> credit
//   quotation charge -> debit · quotation payment -> credit
//   edit / delete / void / reverse of a posted record, account edit,
//   deactivate, delete, link -> full
const { all } = require("./db");
const { sendJSON } = require("./http-helpers");

const LEVELS = ["full", "view", "credit", "debit", "none"];
const LEVEL_LABELS = { full: "Full Access", view: "View Only", credit: "View + Credit Only", debit: "View + Debit Only", none: "No Access" };
// What each level allows on the account itself.
const ALLOWS = {
  full: { view: true, credit: true, debit: true, manage: true },
  view: { view: true, credit: false, debit: false, manage: false },
  credit: { view: true, credit: true, debit: false, manage: false },
  debit: { view: true, credit: false, debit: true, manage: false },
  none: { view: false, credit: false, debit: false, manage: false },
};
// A level is "within" another when it allows nothing the other doesn't.
function levelWithin(level, ceiling) {
  const a = ALLOWS[level], c = ALLOWS[ceiling];
  return Object.keys(a).every((k) => !a[k] || c[k]);
}

function isUnrestricted(user) {
  if (!user) return true;
  const rbac = require("./rbac");
  return rbac.isSuperAdmin(user);
}

// Map accountId -> level for this user (rows only; missing = "full"),
// loaded once per request and kept on the user object.
// The more restrictive of two levels (allows only what BOTH allow).
function stricter(a, b) {
  if (!a) return b; if (!b) return a;
  const x = ALLOWS[a], y = ALLOWS[b];
  const m = { view: x.view && y.view, credit: x.credit && y.credit, debit: x.debit && y.debit, manage: x.manage && y.manage };
  return LEVELS.find((l) => Object.keys(m).every((k) => ALLOWS[l][k] === m[k])) || "none";
}
function roleIdOf(user) {
  if (user.role_id) return user.role_id;
  const r = require("./rbac").loadRoleForUser(user);
  return r ? r.id : null;
}
function accessMap(user) {
  if (!user || isUnrestricted(user)) return null;
  if (!user._accountAccess) {
    const m = new Map();
    const roleId = roleIdOf(user);
    if (roleId) for (const r of all("SELECT account_id, level FROM role_account_access WHERE role_id = ?", [roleId])) m.set(r.account_id, r.level);
    for (const r of all("SELECT account_id, level FROM user_account_access WHERE user_id = ?", [user.id])) m.set(r.account_id, stricter(m.get(r.account_id), r.level));
    user._accountAccess = m;
  }
  return user._accountAccess;
}
function levelFor(user, accountId) {
  const m = accessMap(user);
  if (!m || !accountId) return "full";
  return m.get(accountId) || "full";
}
function can(user, accountId, action) {
  return !!ALLOWS[levelFor(user, accountId)][action];
}
function canView(user, accountId) { return can(user, accountId, "view"); }
// Account ids this user may not see at all (empty set = no restriction).
function hiddenIds(user) {
  const m = accessMap(user);
  const out = new Set();
  if (!m) return out;
  for (const [id, lvl] of m) if (lvl === "none") out.add(id);
  return out;
}
// What the account's screen may offer this user (the role still decides too).
function describe(user, accountId) {
  const level = levelFor(user, accountId);
  return { level, label: LEVEL_LABELS[level], canView: ALLOWS[level].view, canCredit: ALLOWS[level].credit, canDebit: ALLOWS[level].debit, canManage: ALLOWS[level].manage };
}

const MESSAGES = {
  credit: "You do not have permission to create credits for this account.",
  debit: "You do not have permission to create debits for this account.",
  manage: "You do not have permission to change transactions for this account.",
};

// Refuses (403/404) unless the user may do `action` on every listed account.
// checks: [{ accountId, action: "view"|"credit"|"debit"|"manage" }]
// A hidden account answers 404 (its existence isn't confirmed).
function require_(user, res, checks) {
  if (isUnrestricted(user)) return true;
  for (const c of checks) {
    if (!c || !c.accountId) continue;
    const level = levelFor(user, c.accountId);
    if (ALLOWS[level][c.action]) continue;
    require("./rbac").auditDenied(user, `account access (${LEVEL_LABELS[level]}) refused ${c.action} on account ${c.accountId}`);
    if (level === "none") sendJSON(res, 404, { error: "Account not found." });
    else if (c.action === "view") sendJSON(res, 404, { error: "Account not found." });
    else sendJSON(res, 403, { error: level === "view" ? "You do not have permission to create transactions for this account." : MESSAGES[c.action] || MESSAGES.manage, code: "ACCOUNT_ACCESS" });
    return false;
  }
  return true;
}

// Rows of any shape filtered to accounts the user can see; `ids(row)` returns
// every account id the row involves (a row is hidden if ANY of them is).
function filterRows(user, rows, ids) {
  const hidden = hiddenIds(user);
  if (!hidden.size) return rows;
  return rows.filter((r) => !ids(r).some((id) => id && hidden.has(id)));
}

module.exports = { stricter, LEVELS, LEVEL_LABELS, ALLOWS, levelWithin, levelFor, can, canView, hiddenIds, describe, require: require_, filterRows, isUnrestricted };
