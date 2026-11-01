"use strict";
// CROSS-CURRENCY CUSTOMER LINKING round — one customer profile per person,
// grouping their USD and SLSH accounts, which stay financially separate.
// On a throw-away database. Run with: npm run test:customer-linking
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("custlink");
const PORT = Number(process.env.CUSTOMER_LINK_TEST_PORT || 4630);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "0" };
process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, json };
}
const login = async (u, p) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json?.token;
function q(sql, p = []) {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  try { const r = c.query(sql, p); return r.rows || r; } finally { c.close(); }
}

let srv, serverErr = "";
async function startServer() {
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
}
async function stopServer() { if (!srv) return; const done = new Promise((r) => srv.once("exit", r)); srv.kill(); await done; srv = null; }

async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  await startServer();
  try { await run(); } finally { await stopServer(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access|\[customers\]/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  let T = ctx.T = await login("amina.yusuf", PW);
  const SA = await login("super.admin", SA_PW);
  const SAC = (await api("/api/platform/switch-company", { method: "POST", token: SA, body: { companyId: "CMP-0001" } })).json.token;
  const create = (name, currency, extra = {}, token = T) => api("/api/accounts", { method: "POST", token, body: { name, currency, ...extra } });
  const account = async (id, token = T) => (await api(`/api/accounts/${id}`, { token })).json;
  const nProfiles = () => q("SELECT COUNT(*) AS n FROM cmp0001_customers WHERE status = 'active'")[0].n;
  const audits = (action) => q("SELECT details FROM cmp0001_audit_log WHERE action = ? ORDER BY at", [action]).map((r) => r.details);

  console.log("\nExisting accounts get profiles on start");
  await check("every customer account already in the company has a profile; company accounts have none", async () => {
    const r = q("SELECT account_type, SUM(customer_id IS NULL) AS missing, COUNT(*) AS n FROM cmp0001_clients WHERE deleted_at IS NULL GROUP BY account_type");
    const cust = r.find((x) => x.account_type === "customer");
    assert(cust && Number(cust.missing) === 0, JSON.stringify(r));
    const comp = r.find((x) => x.account_type === "company");
    assert(!comp || Number(comp.missing) === Number(comp.n), "a company account got a profile");
    assert(audits("Customer profiles migrated").length === 1, "migration not audited exactly once");
  });

  console.log("\nAutomatic linking");
  await check("a USD account then an SLSH account for the same customer are linked to one profile", async () => {
    const u = await create("A-Rahen Moh'ed Ali", "USD", { contact: "+252 63 4401122", idNumber: "SL-778" });
    assert(u.status === 201 && u.json.customerLink && u.json.customerLink.linked === false, JSON.stringify(u.json.customerLink));
    const before = nProfiles();
    const s = await create("a-rahen  moh’ed ali", "SLSH", { contact: "063-4401122" });
    assert(s.status === 201 && s.json.customerLink.linked === true && s.json.customerLink.confidence === "high", JSON.stringify(s.json.customerLink));
    ctx.u = u.json.account; ctx.s = s.json.account;
    assert(ctx.u.customerId && ctx.u.customerId === ctx.s.customerId, "different profiles");
    assert(nProfiles() === before, "a second profile was created");
    assert(ctx.u.id !== ctx.s.id && ctx.u.accountNumber !== ctx.s.accountNumber, "accounts merged");
    assert(audits("Customer accounts linked automatically").some((d) => d.includes(ctx.s.accountNumber) && d.includes(ctx.u.accountNumber)), "auto-link not audited");
  });
  await check("a walk-in typed in an exchange reuses the customer's account and profile — no duplicate profile", async () => {
    await api("/api/rate-history", { method: "POST", token: T, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } });
    const first = await create("Mustafe Jama", "USD");
    const before = nProfiles();
    const r = await api("/api/transactions", { method: "POST", token: T, body: { clientName: "Mustafe Jama", amountGiven: 500000, currencyGiven: "SLSH" } });
    assert(r.status === 201, `walk-in ${r.status} ${JSON.stringify(r.json)}`);
    const row = q("SELECT c.id, c.currency, c.customer_id FROM cmp0001_exchange_transactions t JOIN cmp0001_clients c ON c.id = t.client_id WHERE t.id = ?", [r.json.transaction.id])[0];
    assert(row.customer_id === first.json.account.customerId, JSON.stringify(row));
    const fresh = await api("/api/transactions", { method: "POST", token: T, body: { clientName: "Brand New Walkin", amountGiven: 300000, currencyGiven: "SLSH" } });
    const nr = q("SELECT c.currency, c.customer_id FROM cmp0001_exchange_transactions t JOIN cmp0001_clients c ON c.id = t.client_id WHERE t.id = ?", [fresh.json.transaction.id])[0];
    assert(nr.currency === "SLSH" && nr.customer_id, "a new walk-in got no profile");
    assert(nProfiles() === before + 1, "profiles");
  });
  await check("same name but a different phone number is NOT merged — it is flagged for review", async () => {
    const a = await create("Hodan Ali Farah", "USD", { contact: "+252 63 1110000" });
    const b = await create("Hodan Ali Farah", "SLSH", { contact: "+252 65 9990000" });
    assert(b.json.customerLink.linked === false && b.json.customerLink.reviews === 1, JSON.stringify(b.json.customerLink));
    assert(a.json.account.customerId !== b.json.account.customerId, "merged");
    ctx.hodanA = a.json.account; ctx.hodanB = b.json.account;
    const rv = (await api("/api/customers/reviews", { token: T })).json.reviews.find((x) => x.account.id === b.json.account.id);
    assert(rv && /phone differs/.test(rv.reason) && rv.candidate.id === a.json.account.customerId, JSON.stringify(rv));
    ctx.review = rv;
  });
  await check("a similar but differently spelled name is NOT merged — flagged for review", async () => {
    const a = await create("Cabdi Raxman Yusuf", "USD");
    const b = await create("Cabdi-Raxman Yusuf", "SLSH");
    assert(b.json.customerLink.linked === false && b.json.customerLink.reviews === 1, JSON.stringify(b.json.customerLink));
    assert(a.json.account.customerId !== b.json.account.customerId, "merged");
    const rv = (await api("/api/customers/reviews", { token: T })).json.reviews.find((x) => x.account.id === b.json.account.id);
    assert(rv && /Similar name/.test(rv.reason), JSON.stringify(rv));
    ctx.similar = rv;
  });
  await check("company (internal) accounts are never linked to a customer profile", async () => {
    const c = await create("A-Rahen Moh'ed Ali Trading", "USD", { accountType: "company" });
    assert(c.status === 201 && !c.json.account.customerId && c.json.customerLink === null, JSON.stringify(c.json));
  });

  console.log("\nSeparate money, one profile");
  await check("each linked account keeps its own balance and currency; postings go to the account ID", async () => {
    let r = await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: T, body: { amount: 500, currency: "USD" } });
    assert(r.status < 300, `deposit ${r.status} ${JSON.stringify(r.json)}`);
    r = await api(`/api/accounts/${ctx.s.id}/deposit`, { method: "POST", token: T, body: { amount: 5000000, currency: "SLSH" } });
    assert(r.status < 300, `deposit ${r.status}`);
    r = await api("/api/transactions", { method: "POST", token: T, body: { clientName: "A-Rahen Moh'ed Ali", clientAccountId: ctx.u.id, receivingAccountId: ctx.s.id, amountGiven: 100, currencyGiven: "USD" } });
    assert(r.status === 201, `exchange ${r.status} ${JSON.stringify(r.json)}`);
    ctx.ex = r.json.transaction;
    const u = (await account(ctx.u.id)).account, s = (await account(ctx.s.id)).account;
    assert(u.balance === 400 && u.currency === "USD", `usd ${u.balance}`);
    assert(s.balance === 5000000 + ctx.ex.amountReceived && s.currency === "SLSH", `slsh ${s.balance}`);
  });
  await check("the customer profile lists both accounts with number, currency, status and their own balance", async () => {
    const r = await api(`/api/customers/${ctx.u.customerId}`, { token: T });
    assert(r.status === 200, `${r.status}`);
    const c = r.json.customer;
    assert(/^CUST-\d{4}$/.test(c.customerNumber) && c.accounts.length === 2, JSON.stringify(c));
    const usd = c.accounts.find((a) => a.currency === "USD"), slsh = c.accounts.find((a) => a.currency === "SLSH");
    assert(usd.accountNumber === ctx.u.accountNumber && usd.balance === 400 && usd.status === "active", JSON.stringify(usd));
    assert(slsh.accountNumber === ctx.s.accountNumber && slsh.balance === 5000000 + ctx.ex.amountReceived, JSON.stringify(slsh));
    const byNumber = await api(`/api/customers/${c.customerNumber}`, { token: T });
    assert(byNumber.status === 200 && byNumber.json.customer.id === c.id, "lookup by CUST number");
  });
  await check("an account's page shows its profile and the other currency account", async () => {
    const a = await account(ctx.s.id);
    assert(a.customer && a.customer.id === ctx.u.customerId && a.customer.accounts.length === 2 && a.customer.accounts.find((x) => x.current).id === ctx.s.id, JSON.stringify(a.customer));
  });
  await check("combined history covers both accounts and can be filtered by currency", async () => {
    const all = (await api(`/api/history?customerId=${ctx.u.customerId}`, { token: T })).json.entries;
    const ids = new Set(all.map((e) => e.accountId));
    assert(ids.has(ctx.u.id) && ids.has(ctx.s.id), `ids ${[...ids]}`);
    const usd = (await api(`/api/history?customerId=${ctx.u.customerId}&currency=USD`, { token: T })).json.entries;
    assert(usd.length >= 1 && usd.every((e) => e.accountCurrency === "USD"), "usd filter");
    const other = (await api(`/api/history?customerId=${ctx.hodanA.customerId}`, { token: T })).json.entries;
    assert(!other.some((e) => e.accountId === ctx.u.id), "other profile leaks entries");
  });
  await check("search finds the profile by name, CUST number or account number", async () => {
    for (const s of ["rahen", ctx.s.accountNumber]) {
      const r = (await api(`/api/customers?search=${encodeURIComponent(s)}`, { token: T })).json.customers;
      assert(r.some((p) => p.id === ctx.u.customerId && p.accounts.length === 2), `search ${s}`);
    }
    const list = (await api("/api/customers?linked=1", { token: T })).json;
    assert(list.customers.every((p) => p.accounts.length > 1) && list.counts.pendingReviews >= 2, JSON.stringify(list.counts));
  });

  console.log("\nRenaming, manual linking and audit");
  await check("renaming one linked account takes it out of the shared profile", async () => {
    const x = await create("Sagal Nur Ahmed", "USD"), y = await create("Sagal Nur Ahmed", "SLSH");
    assert(x.json.account.customerId === y.json.account.customerId, "not linked first");
    const r = await api(`/api/accounts/${y.json.account.id}`, { method: "PATCH", token: T, body: { name: "Sagal Nur Hassan" } });
    assert(r.status === 200 && r.json.account.customerId !== x.json.account.customerId, JSON.stringify(r.json.account));
    const p = (await api(`/api/customers/${x.json.account.customerId}`, { token: T })).json.customer;
    assert(p.accounts.length === 1, "old profile still has it");
    const e = await api(`/api/accounts/${x.json.account.id}`, { method: "PATCH", token: T, body: { contact: "+252 63 5550000" } });
    assert(e.status === 200 && e.json.account.customerId === x.json.account.customerId, "edit without rename moved it");
  });
  await check("a Manager without customers.link can view profiles but cannot link, unlink or decide reviews", async () => {
    const adm = ctx.adm = await login("xasan.cali", PW);
    assert((await api(`/api/customers/${ctx.u.customerId}`, { token: adm })).status === 200, "view");
    assert((await api(`/api/customers/reviews/${ctx.review.id}`, { method: "POST", token: adm, body: { action: "link" } })).status === 403, "review");
    assert((await api(`/api/customers/${ctx.u.customerId}/accounts/${ctx.s.id}`, { method: "DELETE", token: adm })).status === 403, "unlink");
    assert((await api(`/api/customers/${ctx.hodanA.customerId}/accounts`, { method: "POST", token: adm, body: { accountId: ctx.hodanB.id } })).status === 403, "link");
    assert(q("SELECT customer_id FROM cmp0001_clients WHERE id = ?", [ctx.s.id])[0].customer_id === ctx.u.customerId, "changed anyway");
  });
  await check("an authorised user confirms a review: the accounts are linked and it is audited", async () => {
    const users = (await api("/api/users", { token: T })).json.users;
    const u = users.find((x) => x.username === "xasan.cali");
    const g = await api(`/api/users/${u.id}/permissions`, { method: "PATCH", token: SAC, body: { overrides: [{ permissionKey: "customers.link", granted: true }] } });
    assert(g.status === 200, `grant ${g.status} ${JSON.stringify(g.json)}`);
    const adm = ctx.adm = await login("xasan.cali", PW);
    const r = await api(`/api/customers/reviews/${ctx.similar.id}`, { method: "POST", token: adm, body: { action: "link" } });
    assert(r.status === 200 && r.json.review.status === "linked", `${r.status} ${JSON.stringify(r.json)}`);
    const p = (await api(`/api/customers/${ctx.similar.candidate.id}`, { token: adm })).json.customer;
    assert(p.accounts.length === 2, "not linked");
    assert(audits("Customer account linked").some((d) => d.includes(ctx.similar.account.accountNumber)), "not audited");
    const again = await api(`/api/customers/reviews/${ctx.similar.id}`, { method: "POST", token: adm, body: { action: "dismiss" } });
    assert(again.status === 400, "decided twice");
  });
  await check("dismissing a review keeps the two people apart and is audited", async () => {
    const r = await api(`/api/customers/reviews/${ctx.review.id}`, { method: "POST", token: ctx.adm, body: { action: "dismiss" } });
    assert(r.status === 200 && r.json.review.status === "dismissed", JSON.stringify(r.json));
    assert(q("SELECT customer_id FROM cmp0001_clients WHERE id = ?", [ctx.hodanB.id])[0].customer_id !== ctx.hodanA.customerId, "linked");
    assert(audits("Customer match dismissed").some((d) => d.includes(ctx.hodanB.accountNumber)), "not audited");
  });
  await check("manual unlink and link are audited; one account per currency per profile", async () => {
    const un = await api(`/api/customers/${ctx.u.customerId}/accounts/${ctx.s.id}`, { method: "DELETE", token: ctx.adm });
    assert(un.status === 200 && un.json.newCustomerId && un.json.customer.accounts.length === 1, JSON.stringify(un.json));
    assert(audits("Customer account unlinked").some((d) => d.includes(ctx.s.accountNumber)), "unlink not audited");
    const lone = await api(`/api/customers/${un.json.newCustomerId}/accounts/${ctx.s.id}`, { method: "DELETE", token: ctx.adm });
    assert(lone.status === 400, "unlinking the only account");
    const ln = await api(`/api/customers/${ctx.u.customerId}/accounts`, { method: "POST", token: ctx.adm, body: { accountId: ctx.s.id, note: "same passport" } });
    assert(ln.status === 200 && ln.json.customer.accounts.length === 2, JSON.stringify(ln.json));
    assert(audits("Customer account linked").some((d) => d.includes(ctx.s.accountNumber) && d.includes("same passport")), "link not audited");
    const second = await create("Rahen Second Usd", "USD");
    const dup = await api(`/api/customers/${ctx.u.customerId}/accounts`, { method: "POST", token: ctx.adm, body: { accountId: second.json.account.id } });
    assert(dup.status === 400 && /already has a USD account/.test(dup.json.error), JSON.stringify(dup.json));
    const comp = q("SELECT id FROM cmp0001_clients WHERE account_type = 'company' LIMIT 1")[0];
    const c2 = await api(`/api/customers/${ctx.u.customerId}/accounts`, { method: "POST", token: ctx.adm, body: { accountId: comp.id } });
    assert(c2.status === 400, "company account linked");
  });
  await check("balances and references were not touched by any linking", async () => {
    assert((await account(ctx.u.id)).account.balance === 400, "usd balance");
    assert((await account(ctx.s.id)).account.balance === 5000000 + ctx.ex.amountReceived, "slsh balance");
    assert(q("SELECT reference_number FROM cmp0001_exchange_transactions WHERE id = ?", [ctx.ex.id])[0].reference_number === ctx.ex.referenceNumber, "reference");
  });

  console.log("\nCurrency access and other companies");
  await check("a USD-only user sees only the USD account of a profile", async () => {
    const users = (await api("/api/users", { token: T })).json.users;
    const u = users.find((x) => x.username === "xasan.cali");
    const o = await api(`/api/users/${u.id}/permissions`, { method: "PATCH", token: SAC, body: { overrides: [{ permissionKey: "customers.link", granted: true }, { permissionKey: "currency.slsh", granted: false }] } });
    assert(o.status === 200, `override ${o.status} ${JSON.stringify(o.json)}`);
    const adm = await login("xasan.cali", PW);
    const p = (await api(`/api/customers/${ctx.u.customerId}`, { token: adm })).json.customer;
    assert(p.accounts.length === 1 && p.accounts[0].currency === "USD" && p.hiddenAccounts === 1, JSON.stringify(p));
    const h = await api(`/api/history?customerId=${ctx.u.customerId}&currency=SLSH`, { token: adm });
    assert(h.status === 403, `slsh history ${h.status}`);
    const un = await api(`/api/customers/${ctx.u.customerId}/accounts/${ctx.s.id}`, { method: "DELETE", token: adm });
    assert(un.status === 403, `unlink slsh ${un.status}`);
    await api(`/api/users/${u.id}/permissions`, { method: "PATCH", token: SAC, body: { overrides: [{ permissionKey: "customers.link", granted: true }] } });
  });
  await check("another company has its own profiles and cannot see or link this company's", async () => {
    const co = await api("/api/platform/companies", { method: "POST", token: SA, body: { name: "Link Beta", admin: { name: "Lb Admin", username: "lb.admin", password: "BetaPass123!" } } });
    assert(co.status === 201 || co.status === 200, `company ${co.status}`);
    const b = await login("lb.admin", "BetaPass123!");
    const mine = await create("A-Rahen Moh'ed Ali", "SLSH", {}, b);
    assert(mine.status === 201 && mine.json.customerLink.linked === false && mine.json.account.customerId !== ctx.u.customerId, JSON.stringify(mine.json));
    assert((await api(`/api/customers/${ctx.u.customerId}`, { token: b })).status === 404, "B opens A's profile");
    const list = (await api("/api/customers?search=rahen", { token: b })).json.customers;
    assert(list.length === 1 && list[0].accounts[0].id === mine.json.account.id, "B sees A's profiles");
    const g = (await api("/api/users", { token: b })).json.users.find((x) => x.username === "lb.admin");
    assert(g, "b admin");
    const tryLink = await api(`/api/customers/${mine.json.account.customerId}/accounts`, { method: "POST", token: b, body: { accountId: ctx.u.id } });
    assert(tryLink.status === 404 || tryLink.status === 403, `B links A's account ${tryLink.status}`);
  });

  await browserPart();

  console.log("\nUpgrading existing data");
  await check("after an upgrade, reliable pairs are linked, conflicts go to review, and no balance or ledger row changes", async () => {
    await stopServer();
    const at = "2026-01-01T08:00:00.000Z";
    const ins = (id, name, cur, contact, n) => q("INSERT INTO cmp0001_clients (id, name, account_number, account_type, currency, contact, balance_usd, balance_slsh, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, name, n, "customer", cur, contact, cur === "USD" ? 75 : 0, cur === "SLSH" ? 90000 : 0, at]);
    ins("old1", "Faisal Old Customer", "USD", "634000001", "ACC-9001");
    ins("old2", "FAISAL OLD CUSTOMER", "SLSH", "634000001", "ACC-9002");
    ins("old3", "Nimco Old", "USD", "634000002", "ACC-9003");
    ins("old4", "Nimco Old", "SLSH", "659999999", "ACC-9004");
    const sum = () => JSON.stringify(q("SELECT id, balance_usd, balance_slsh FROM cmp0001_clients ORDER BY id")) + JSON.stringify(q("SELECT COUNT(*) AS n, SUM(amount) AS s FROM cmp0001_account_ledger")) + JSON.stringify(q("SELECT COUNT(*) AS n FROM cmp0001_exchange_transactions"));
    const before = sum();
    await startServer();
    const rows = Object.fromEntries(q("SELECT id, customer_id FROM cmp0001_clients WHERE id LIKE 'old%'").map((r) => [r.id, r.customer_id]));
    assert(rows.old1 && rows.old1 === rows.old2, "reliable pair not linked");
    assert(rows.old3 && rows.old4 && rows.old3 !== rows.old4, "conflicting pair merged");
    assert(q("SELECT COUNT(*) AS n FROM cmp0001_customer_link_reviews WHERE client_id = 'old4' AND status = 'pending'")[0].n === 1, "no review for the conflict");
    assert(sum() === before, "financial data changed");
    assert(audits("Customer profiles migrated").length === 2, "second migration not audited");
    T = ctx.T = await login("amina.yusuf", PW);
    await stopServer(); await startServer();
    assert(audits("Customer profiles migrated").length === 2, "migration ran again with nothing to do");
  });
}

async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nCustomer Profiles page");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("xasan.cali"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(600);
    const btn = p.locator(".gk-nav-btn:not(.gk-nav-group-header)").filter({ hasText: /^\s*Customer Profiles\s*$/ }).first();
    const group = p.locator(".gk-nav-group").filter({ has: btn });
    if (await group.count()) { const h = group.first().locator(".gk-nav-group-header").first(); if ((await h.getAttribute("aria-expanded")) === "false") { await h.click(); await p.waitForTimeout(300); } }
    const prof = (await api(`/api/customers/${ctx.u.customerId}`, { token: ctx.T })).json.customer;
    await check("the list shows the profile with its USD and SLSH accounts, each with number and balance", async () => {
      await btn.click(); await p.waitForTimeout(1000);
      assert(await p.locator("h1", { hasText: "Customer Profiles" }).count() === 1, "title");
      await p.getByLabel("Search customers").fill("rahen"); await p.waitForTimeout(900);
      const row = p.locator(`tr[data-customer="${prof.customerNumber}"]`);
      assert(await row.count() === 1, "row missing");
      const t = await row.innerText();
      assert(t.includes(ctx.u.accountNumber) && t.includes(ctx.s.accountNumber) && /USD/.test(t) && /SLSH/.test(t), t);
    });
    await check("opening the profile shows both account cards and a combined history filterable by currency", async () => {
      await p.locator(`tr[data-customer="${prof.customerNumber}"]`).click(); await p.waitForTimeout(1200);
      assert((await p.getByTestId("customer-number").innerText()).trim() === prof.customerNumber, "header");
      assert(await p.locator(".gk-cp-account").count() === 2, "account cards");
      assert(/400\.00/.test(await p.locator(`.gk-cp-account[data-account="${ctx.u.accountNumber}"]`).innerText()), "usd balance");
      const all = await p.locator(".gk-cp-hist tbody tr").count();
      assert(all >= 2, `history rows ${all}`);
      await p.getByRole("tab", { name: "SLSH", exact: true }).click(); await p.waitForTimeout(900);
      const cells = await p.locator(".gk-cp-hist tbody tr td:nth-child(4)").allInnerTexts();
      assert(cells.length >= 1 && cells.every((x) => /SLSH/.test(x)), cells.join("|"));
      if (process.env.CP_SHOT) await p.screenshot({ path: process.env.CP_SHOT, fullPage: true });
    });
    await check("an account page shows its customer profile and the other currency account", async () => {
      await p.locator(`.gk-cp-account[data-account="${ctx.s.accountNumber}"]`).getByRole("button", { name: "Open account" }).click(); await p.waitForTimeout(1500);
      const strip = p.getByTestId("customer-link");
      const t = await strip.innerText();
      assert(t.includes(prof.customerNumber) && t.includes(ctx.u.accountNumber) && /this account/.test(t), t);
      if (process.env.CP_SHOT2) await p.screenshot({ path: process.env.CP_SHOT2 });
      await strip.getByRole("button", { name: prof.customerNumber }).click(); await p.waitForTimeout(1200);
      assert((await p.getByTestId("customer-number").innerText()).trim() === prof.customerNumber, "back to profile");
    });
    await check("the Needs Review tab lists decisions", async () => {
      await p.locator(".gk-av-crumbs button").first().click(); await p.waitForTimeout(800);
      await p.getByRole("tab", { name: /Needs Review/ }).click(); await p.waitForTimeout(800);
      await p.getByLabel("Review status").selectOption("dismissed"); await p.waitForTimeout(900);
      assert(await p.locator(".gk-cp-review").count() >= 1, "no dismissed review shown");
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
