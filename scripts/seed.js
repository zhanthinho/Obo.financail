"use strict";
const path = require("path");
require(path.join(__dirname, "..", "src", "env"));
// DEMO DATA ONLY — never for a live system. Refused in production.
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data: NODE_ENV is production.");
  process.exit(1);
}
const { db, run, get } = require(path.join(__dirname, "..", "src", "db"));
// MULTI-COMPANY round: the demo data is seeded into the PRIMARY company
// (CMP-0001, the DB_PATH database). Scripts must name their company explicitly.
require(path.join(__dirname, "..", "src", "tenancy")).useScriptTenant();
const authLib = require(path.join(__dirname, "..", "src", "auth"));
const { uid, nowISO } = require(path.join(__dirname, "..", "src", "util"));
const { quotationTotals, rebuildAccountBalance } = require(path.join(__dirname, "..", "src", "domain"));

// SECURITY AUDIT round: overridable, so test runs and demo installs need not
// use the published default (which forces a password change at sign-in).
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Demo123!";

function daysAgoISO(n, hour = 9, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, min, 0, 0);
  // Demo data is never dated in the future: seeded between midnight and
  // 09:00, "today 09:00" would otherwise sort above anything entered now.
  const latest = Date.now() - (n + 1) * 60 * 1000;
  if (d.getTime() > latest) d.setTime(latest);
  return d.toISOString();
}

function main() {
  const force = process.argv.includes("--force");
  // Don't count the "super.admin" bootstrap account requiring db.js
  // (src/db.js) creates on every fresh boot (SUPER ADMIN + ADVANCED ROLE &
  // PERMISSION MANAGEMENT round) — a database holding only that one
  // account is still "empty" from this demo seed's point of view.
  const existing = get("SELECT COUNT(*) as n FROM users WHERE username != 'super.admin'");
  if (existing.n > 0 && !force) {
    console.log(`Database already has ${existing.n} user(s). Run "node scripts/seed.js --force" to wipe and reseed.`);
    return;
  }
  if (force) {
    console.log("Wiping existing data...");
    ["quotation_items", "quotations", "exchange_transactions", "exchange_rates", "rate_history", "audit_log", "opening_balances", "clients", "users"].forEach((t) => run(`DELETE FROM ${t}`));
  }

  console.log("Seeding users (demo password for all accounts: " + DEMO_PASSWORD + ")...");
  const usersSeed = [
    { id: "u-admin", name: "Amina Yusuf", username: "amina.yusuf", role: "admin", createdAt: daysAgoISO(180) },
    { id: "u-mgr", name: "Xasan Cali", username: "xasan.cali", role: "manager", createdAt: daysAgoISO(160) },
    { id: "u-acc", name: "Faadumo Warsame", username: "faadumo.warsame", role: "accountant", createdAt: daysAgoISO(140) },
    { id: "u-cash", name: "Cabdi Maxamed", username: "cabdi.maxamed", role: "cashier", createdAt: daysAgoISO(120) },
    { id: "u-sales", name: "Ilhan Nuur", username: "ilhan.nuur", role: "sales", createdAt: daysAgoISO(100) },
    { id: "u-view", name: "Sahra Ismail", username: "sahra.ismail", role: "viewer", createdAt: daysAgoISO(90) },
  ];
  for (const u of usersSeed) {
    const { hash, salt } = authLib.hashPassword(DEMO_PASSWORD);
    run("INSERT INTO users (id, name, username, password_hash, password_salt, role, active, last_login, created_at) VALUES (?,?,?,?,?,?,1,NULL,?)", [u.id, u.name, u.username, hash, salt, u.role, u.createdAt]);
  }

  console.log("Seeding exchange rate history...");
  const rate = 8750;
  // RATE MANAGEMENT UNIFICATION round: seeded into the unified rate_history
  // table (not the legacy exchange_rates table) since getCurrentRate() now
  // reads only from there. sale_rate is deliberately left null on every
  // seeded row — this demo dataset has never had a Sale Rate configured,
  // matching the app's existing "unset until someone sets one" behavior.
  [
    { id: "rh-1", rate: 8680, setBy: "u-admin", setByName: "Amina Yusuf", at: daysAgoISO(45) },
    { id: "rh-2", rate: 8720, setBy: "u-mgr", setByName: "Xasan Cali", at: daysAgoISO(22) },
    { id: "rh-3", rate, setBy: "u-mgr", setByName: "Xasan Cali", at: daysAgoISO(6) },
  ].forEach((r) => run("INSERT INTO rate_history (id, currency_pair, daily_rate, sale_rate, rate_difference, note, set_by, set_by_name, at) VALUES (?,'USD_SLSH',?,NULL,NULL,NULL,?,?,?)", [r.id, r.rate, r.setBy, r.setByName, r.at]));

  console.log("Seeding opening balances...");
  run("INSERT INTO opening_balances (id, usd, slsh, updated_by, updated_at) VALUES (1, 15000, 45000000, 'Amina Yusuf', ?)", [daysAgoISO(45)]);

  console.log("Seeding clients & transactions...");
  function client(name, contact, address, accountType) {
    const id = uid("cl");
    run("INSERT INTO clients (id, name, account_type, currency, contact, address, created_at) VALUES (?,?,?,?,?,?,?)", [id, name, accountType || "company", "USD", contact || null, address || null, nowISO()]);
    return id;
  }
  const clients = {
    "Warsame Trading Co.": client("Warsame Trading Co.", "+252 63 401 1010", "New Market, Hargeysa", "company"),
    "Hodan Hotel": client("Hodan Hotel", "+252 63 400 1122", "26 June St, Hargeysa", "company"),
    "Berbera Logistics": client("Berbera Logistics", "+252 63 555 7788", "Port Road, Berbera", "company"),
    "Aisha Nur": client("Aisha Nur", "+252 63 700 2233", "", "customer"),
    "Waaberi Traders": client("Waaberi Traders", "+252 63 700 4455", "New Market, Hargeysa", "company"),
    "OBO Supplies": client("OBO Supplies", "+252 63 300 9090", "", "company"),
    "Hargeysa Traders Union": client("Hargeysa Traders Union", "+252 63 220 0044", "", "company"),
    "Sagal Import Export": client("Sagal Import Export", "+252 63 222 3040", "Independence Ave, Hargeysa", "company"),
    "Nomad Fuel Station": client("Nomad Fuel Station", "+252 63 909 1200", "Wadada Jigjiga, Hargeysa", "company"),
    "Baligubadle Cooperative": client("Baligubadle Cooperative", "+252 63 811 6600", "", "company"),
  };

  // Demo: give Hodan Hotel a linked SLSH counterpart account, with a small
  // opening balance, to show off the USD⇄SLSH account linking feature.
  const hodanSlshId = uid("cl");
  run("INSERT INTO clients (id, name, account_type, currency, contact, address, balance_slsh, linked_account_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [hodanSlshId, "Hodan Hotel (SLSH)", "company", "SLSH", "+252 63 400 1122", "26 June St, Hargeysa", 2000000, clients["Hodan Hotel"], nowISO()]);
  run("UPDATE clients SET linked_account_id = ? WHERE id = ?", [hodanSlshId, clients["Hodan Hotel"]]);
  run("INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [uid("ldg"), hodanSlshId, "deposit", "SLSH", 2000000, 2000000, "Opening balance", "u-admin", "Amina Yusuf", daysAgoISO(10)]);

  function conv(amt, from, to) { return from === to ? amt : to === "USD" ? amt / rate : amt * rate; }
  function mkTx(id, d, clientName, given, curGiven, staffId, staffName, profit, spreadPct, status) {
    const curReceived = curGiven === "USD" ? "SLSH" : "USD";
    let received = conv(given, curGiven, curReceived);
    if (spreadPct) received *= 1 - spreadPct / 100;
    received = curReceived === "USD" ? Math.round(received * 100) / 100 : Math.round(received);
    run(
      `INSERT INTO exchange_transactions (id, date, client_id, client_name, amount_given, currency_given, amount_received, currency_received, rate_used, profit_usd, staff_id, staff_name, status, notes, void_reason, voided_by, voided_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, d, clients[clientName], clientName, given, curGiven, received, curReceived, rate, profit, staffId, staffName, status || "active", "", null, null, null]
    );
  }
  mkTx("t1", daysAgoISO(9, 9, 10), "Warsame Trading Co.", 500, "USD", "u-cash", "Cabdi Maxamed", 6, 0.4);
  mkTx("t2", daysAgoISO(8, 11, 0), "Hodan Hotel", 2000000, "SLSH", "u-acc", "Faadumo Warsame", 5, 0.3);
  mkTx("t3", daysAgoISO(7, 15, 20), "Berbera Logistics", 1200, "USD", "u-cash", "Cabdi Maxamed", 9, 0.35);
  mkTx("t4", daysAgoISO(6, 10, 0), "Aisha Nur", 300, "USD", "u-acc", "Faadumo Warsame", 3, 0.3);
  mkTx("t5", daysAgoISO(5, 13, 0), "Waaberi Traders", 5000000, "SLSH", "u-cash", "Cabdi Maxamed", 12, 0.25);
  mkTx("t6", daysAgoISO(4, 9, 45), "OBO Supplies", 800, "USD", "u-acc", "Faadumo Warsame", 6, 0, "voided");
  mkTx("t7", daysAgoISO(3, 12, 0), "Hargeysa Traders Union", 1500, "USD", "u-cash", "Cabdi Maxamed", 10, 0.3);
  mkTx("t8", daysAgoISO(2, 16, 0), "Sagal Import Export", 3000000, "SLSH", "u-acc", "Faadumo Warsame", 7, 0.28);
  mkTx("t9", daysAgoISO(1, 10, 30), "Nomad Fuel Station", 900, "USD", "u-cash", "Cabdi Maxamed", 5, 0.32);
  mkTx("t10", daysAgoISO(0, 9, 0), "Baligubadle Cooperative", 2500000, "SLSH", "u-acc", "Faadumo Warsame", 6, 0.3);
  run("UPDATE exchange_transactions SET void_reason=?, voided_by=?, voided_at=? WHERE id='t6'", ["Duplicate entry — client re-submitted the same exchange twice.", "Amina Yusuf", daysAgoISO(4, 10, 5)]);

  // TWO-STEP ACCOUNT LEDGER LOGIC: every quotation charges a real account the
  // instant it's created (a Withdrawal), and — if settled — posts a second,
  // real settlement Deposit (Paid or Refunded). `settlement` is
  // "pending" | "paid" | "refunded"; the account charged is always the
  // quotation's own client account (each seeded client IS an account here).
  console.log("Seeding quotations (charged + settled against real accounts)...");
  function mkQuotation(id, number, clientName, contact, address, issueDaysAgo, validDaysFromNow, settlement, discountPercent, taxPercent, items, notes) {
    const clientId = clients[clientName] || client(clientName, contact, address);
    const account = get("SELECT * FROM clients WHERE id = ?", [clientId]);
    const issueDate = daysAgoISO(issueDaysAgo).slice(0, 10);
    const validUntil = new Date(Date.now() + validDaysFromNow * 86400000).toISOString().slice(0, 10);
    const createdAt = daysAgoISO(issueDaysAgo);
    // quotationTotals() expects {qty, unit_price/unitPrice, currency} — this
    // function's own item shorthand is {d, qty, price, cur} (matching the
    // quotation_items INSERT below), so normalize before totaling.
    const totals = quotationTotals(items.map((it) => ({ qty: it.qty, unit_price: it.price, currency: it.cur })), discountPercent, taxPercent, rate);
    const currency = account.currency;
    const amount = currency === "USD" ? totals.totalUSD : totals.totalSLSH;
    const chargeLedgerId = uid("ldg");
    const status = settlement === "paid" ? "Paid" : settlement === "refunded" ? "Refunded" : "Pending";

    run(
      `INSERT INTO quotations (
         id, number, client_id, client_name, client_contact, client_address, issue_date, valid_until, status,
         invoiced, discount_percent, tax_percent, rate_used, notes,
         charged, charged_at, charged_by, charged_account_id, charged_amount, charged_currency, charged_ledger_id,
         created_by, created_by_name, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
      [id, number, clientId, clientName, contact, address, issueDate, validUntil, status,
       discountPercent, taxPercent, rate, notes || null,
       createdAt, "Ilhan Nuur", account.id, amount, currency, chargeLedgerId,
       "u-sales", "Ilhan Nuur", createdAt]
    );
    for (const it of items) {
      run("INSERT INTO quotation_items (id, quotation_id, description, qty, unit_price, currency) VALUES (?,?,?,?,?,?)", [uid("it"), id, it.d, it.qty, it.price, it.cur]);
    }
    run(
      "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [chargeLedgerId, account.id, "withdrawal", currency, amount, 0, `Quotation — ${number}`, "u-sales", "Ilhan Nuur", createdAt, "quotation_charge", id, number]
    );
    if (settlement === "paid" || settlement === "refunded") {
      const settleLedgerId = uid("ldg");
      const settleAt = daysAgoISO(Math.max(issueDaysAgo - 3, 0));
      const label = settlement === "paid" ? `Quotation Paid — ${number}` : `Refund — quotation charge reversed (${number})`;
      run(
        "INSERT INTO account_ledger (id, client_id, type, currency, amount, balance_after, notes, staff_id, staff_name, date, source_type, source_id, reference_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [settleLedgerId, account.id, "deposit", currency, amount, 0, label, "u-acc", "Faadumo Warsame", settleAt, settlement === "paid" ? "quotation_paid" : "quotation_refund", id, number]
      );
      if (settlement === "paid") {
        run("UPDATE quotations SET paid=1, paid_at=?, paid_by=?, paid_ledger_id=? WHERE id=?", [settleAt, "Faadumo Warsame", settleLedgerId, id]);
      } else {
        run("UPDATE quotations SET refunded=1, refunded_at=?, refunded_by=? WHERE id=?", [settleAt, "Faadumo Warsame", id]);
      }
    }
    rebuildAccountBalance(account.id, currency);
  }
  mkQuotation("q1", "QT-" + new Date().getFullYear() + "-0001", "Hodan Hotel", "+252 63 400 1122", "26 June St, Hargeysa", 20, -10, "paid", 5, 0,
    [{ d: "Foreign currency handling — monthly retainer", qty: 1, price: 450, cur: "USD" }, { d: "Bulk SLSH cash delivery service", qty: 3, price: 150000, cur: "SLSH" }],
    "Preferred hotel client, quarterly contract.");
  mkQuotation("q2", "QT-" + new Date().getFullYear() + "-0002", "Berbera Logistics", "+252 63 555 7788", "Port Road, Berbera", 12, 3, "pending", 0, 5,
    [{ d: "Bulk currency exchange facilitation", qty: 1, price: 2000, cur: "USD" }, { d: "Courier & escort service", qty: 2, price: 500000, cur: "SLSH" }],
    "");
  mkQuotation("q3", "QT-" + new Date().getFullYear() + "-0003", "Sagal Import Export", "+252 63 222 3040", "Independence Ave, Hargeysa", 28, -14, "pending", 0, 0,
    [{ d: "Quarterly trade-finance advisory", qty: 1, price: 1200, cur: "USD" }],
    "Awaiting board approval on client side.");
  mkQuotation("q4", "QT-" + new Date().getFullYear() + "-0004", "Nomad Fuel Station", "+252 63 909 1200", "Wadada Jigjiga, Hargeysa", 3, 27, "pending", 2, 0,
    [{ d: "Weekly SLSH float top-up", qty: 4, price: 3000000, cur: "SLSH" }], "");
  mkQuotation("q5", "QT-" + new Date().getFullYear() + "-0005", "Waaberi Traders", "+252 63 700 4455", "New Market, Hargeysa", 18, -4, "refunded", 0, 0,
    [{ d: "Bulk exchange facilitation", qty: 1, price: 900, cur: "USD" }], "Client found a more competitive rate elsewhere — refunded in full.");

  console.log("Seeding audit log...");
  [
    { at: daysAgoISO(6, 9, 0), actor: "Xasan Cali", role: "manager", action: "Rate updated", details: `Exchange rate set to 1 USD = SLSH ${rate.toLocaleString("en-US")}` },
    { at: daysAgoISO(4, 10, 5), actor: "Amina Yusuf", role: "admin", action: "Transaction voided", details: "Voided transaction t6 (OBO Supplies) — duplicate entry" },
    { at: daysAgoISO(18, 8, 0), actor: "Ilhan Nuur", role: "sales", action: "Quotation created & charged", details: "QT-0005 for Waaberi Traders" },
    { at: daysAgoISO(20, 8, 30), actor: "Faadumo Warsame", role: "accountant", action: "Quotation marked Paid", details: "QT-0001 for Hodan Hotel" },
  ].forEach((l) => run("INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, details) VALUES (?,?,NULL,?,?,?,?)", [uid("log"), l.at, l.actor, l.role, l.action, l.details]));

  console.log("\nDone. Demo accounts (password for all: " + DEMO_PASSWORD + "):");
  usersSeed.forEach((u) => console.log(`  ${u.username.padEnd(20)} ${u.role}`));
}

try { main(); } finally { require(path.join(__dirname, "..", "src", "mysql", "connection")).close(); }
