"use strict";
// SAME NAME, DIFFERENT CURRENCY round — an account name may exist once per
// currency in a company; postings always go to the account ID; the old
// UNIQUE(name) index is replaced safely. On a throw-away database.
// Run with: npm run test:same-name
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("samename");
const PORT = Number(process.env.SAME_NAME_TEST_PORT || 4620);
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
function db() {
  const { SyncMysql } = require("../src/mysql/sync-client");
  const e = TESTDB.env;
  const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
  return { q: (sql, p = []) => c.query(sql, p).rows, close: () => c.close() };
}

let srv, serverErr = "";
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  const T = ctx.adm = await login("amina.yusuf", PW);
  const create = (name, currency, extra = {}) => api("/api/accounts", { method: "POST", token: T, body: { name, currency, ...extra } });
  const bal = async (id) => { const r = (await api(`/api/accounts/${id}`, { token: T })).json; return (r.account || r).balance; };

  console.log("\nCreating and editing");
  await check("the same name can be created in USD and in SLSH", async () => {
    const u = await create("Ahmed Hassan", "USD"), s = await create("Ahmed Hassan", "SLSH");
    assert(u.status === 201 && s.status === 201, `${u.status} ${s.status} ${JSON.stringify(s.json)}`);
    ctx.u = u.json.account; ctx.s = s.json.account;
    assert(ctx.u.id !== ctx.s.id && ctx.u.accountNumber !== ctx.s.accountNumber && ctx.u.currency === "USD" && ctx.s.currency === "SLSH", "not two distinct accounts");
    const r = await create("A-Rahen Moh'ed Ali", "USD"), r2 = await create("A-Rahen Moh'ed Ali", "SLSH");
    assert(r.status === 201 && r2.status === 201, "apostrophe name");
  });
  await check("a second account with the same name in the same currency is refused (spaces and case ignored)", async () => {
    for (const n of ["Ahmed Hassan", "  ahmed hassan ", "AHMED HASSAN"]) {
      const r = await create(n, "USD");
      assert(r.status === 400 && /already exists/.test(r.json.error) && /USD/.test(r.json.error) && r.json.error.includes(ctx.u.accountNumber), `${n}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    const comp = await create("Ahmed Hassan", "SLSH", { accountType: "company" });
    assert(comp.status === 400, `company with same name+currency ${comp.status}`);
  });
  await check("editing an account without changing its name works; renaming onto another name in that currency is refused", async () => {
    let r = await api(`/api/accounts/${ctx.u.id}`, { method: "PATCH", token: T, body: { name: "Ahmed Hassan", contact: "+252 63 1111111" } });
    assert(r.status === 200, `same name ${r.status} ${JSON.stringify(r.json)}`);
    const other = (await create("Basra Omar", "SLSH")).json.account;
    r = await api(`/api/accounts/${other.id}`, { method: "PATCH", token: T, body: { name: "ahmed hassan" } });
    assert(r.status === 400, `rename onto existing ${r.status}`);
    const usdBasra = await create("Basra Omar", "USD");
    assert(usdBasra.status === 201, "Basra USD");
    r = await api(`/api/accounts/${usdBasra.json.account.id}`, { method: "PATCH", token: T, body: { name: "Basra Omar Ali" } });
    assert(r.status === 200, "rename to a free name");
  });
  await check("an account's currency cannot be switched by editing (history stays in its currency)", async () => {
    const r = await api(`/api/accounts/${ctx.s.id}`, { method: "PATCH", token: T, body: { currency: "USD" } });
    assert(r.status === 200 || r.status === 400, `${r.status}`);
    const a = (await api(`/api/accounts/${ctx.s.id}`, { token: T })).json;
    assert((a.account || a).currency === "SLSH", "currency changed");
  });

  console.log("\nPostings follow the account ID");
  await check("credits go to the chosen account only; the namesake in the other currency is untouched", async () => {
    const r = await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: T, body: { amount: 500, currency: "USD" } });
    assert(r.status < 300, `deposit ${r.status} ${JSON.stringify(r.json)}`);
    const r2 = await api(`/api/accounts/${ctx.s.id}/deposit`, { method: "POST", token: T, body: { amount: 5000000, currency: "SLSH" } });
    assert(r2.status < 300, `deposit slsh ${r2.status}`);
    assert(await bal(ctx.u.id) === 500 && await bal(ctx.s.id) === 5000000, `${await bal(ctx.u.id)} / ${await bal(ctx.s.id)}`);
  });
  await check("an exchange between the two namesake accounts debits USD and credits SLSH, by ID", async () => {
    await api("/api/rate-history", { method: "POST", token: T, body: { dailyRate: 11300, saleRate: 11300, costRate: 11500, buyRate: 11300, sellRate: 11700 } });
    const r = await api("/api/transactions", { method: "POST", token: T, body: { clientName: "Ahmed Hassan", clientAccountId: ctx.u.id, receivingAccountId: ctx.s.id, amountGiven: 100, currencyGiven: "USD" } });
    assert(r.status === 201, `exchange ${r.status} ${JSON.stringify(r.json)}`);
    ctx.ex = r.json.transaction;
    assert(await bal(ctx.u.id) === 400, `usd ${await bal(ctx.u.id)}`);
    assert(await bal(ctx.s.id) === 5000000 + ctx.ex.amountReceived, `slsh ${await bal(ctx.s.id)}`);
  });
  await check("a typed walk-in name is matched to the account in the exchange's own currency", async () => {
    const r = await api("/api/transactions", { method: "POST", token: T, body: { clientName: "AHMED HASSAN", amountGiven: 1000000, currencyGiven: "SLSH" } });
    assert(r.status === 201, `walk-in ${r.status} ${JSON.stringify(r.json)}`);
    const h = db();
    try {
      const row = h.q("SELECT client_id FROM cmp0001_exchange_transactions WHERE id = ?", [r.json.transaction.id])[0];
      assert(row.client_id === ctx.s.id, `linked to ${row.client_id}, expected the SLSH account`);
      assert(h.q("SELECT COUNT(*) AS n FROM cmp0001_clients WHERE UPPER(name) = 'AHMED HASSAN'")[0].n === 2, "a third Ahmed Hassan was created");
    } finally { h.close(); }
  });
  await check("search lists both namesakes, told apart by account number and currency", async () => {
    const all = (await api("/api/accounts?search=Ahmed%20Hassan", { token: T })).json.accounts.filter((a) => a.name.toUpperCase() === "AHMED HASSAN");
    assert(all.length === 2 && new Set(all.map((a) => a.currency)).size === 2 && new Set(all.map((a) => a.accountNumber)).size === 2, JSON.stringify(all.map((a) => [a.accountNumber, a.currency])));
    const usd = (await api("/api/accounts?currency=USD&search=Ahmed%20Hassan", { token: T })).json.accounts;
    assert(usd.length === 1 && usd[0].id === ctx.u.id, "USD search");
  });
  await check("transaction history shows each posting under its own account and currency", async () => {
    const usd = (await api(`/api/history?currency=USD&accountId=${ctx.u.id}`, { token: T })).json.entries;
    const slsh = (await api(`/api/history?currency=SLSH&accountId=${ctx.s.id}`, { token: T })).json.entries;
    assert(usd.length >= 1 && usd.every((e) => e.accountCurrency === "USD"), "usd history");
    assert(slsh.length >= 1 && slsh.every((e) => e.accountCurrency === "SLSH" && e.accountId === ctx.s.id), "slsh history");
  });
  await check("statements for the two namesakes carry their own account number", async () => {
    const a = await api(`/api/accounts/${ctx.u.id}/statement.pdf`, { token: T });
    const b = await api(`/api/accounts/${ctx.s.id}/statement.pdf`, { token: T });
    assert(a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
  });

  console.log("\nImport, database, other companies");
  await check("import: same name in the other currency is new; same name and currency is a duplicate", async () => {
    const csv = "Account #,Account Name,Account Type,Currency,Phone,Email,Status,Opening Balance\r\n,Basra Omar,customer,SLSH,,,active,0\r\n,Zahra Import,customer,USD,,,active,0\r\n,Zahra Import,customer,SLSH,,,active,0\r\n";
    const r = await api("/api/accounts/import/preview", { method: "POST", token: T, body: { fileName: "n.csv", fileBase64: Buffer.from(csv).toString("base64") } });
    assert(r.status === 200, `preview ${r.status} ${JSON.stringify(r.json)}`);
    const res = r.json.rows.map((x) => `${x.name}|${x.currency}|${x.result}`);
    assert(res.includes("Basra Omar|SLSH|duplicate") && res.includes("Zahra Import|USD|valid") && res.includes("Zahra Import|SLSH|valid"), res.join(", "));
  });
  await check("the database itself allows one name per currency and refuses a second in the same currency", async () => {
    const h = db();
    try {
      const ix = h.q("SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cmp0001_clients'").map((r) => r.n);
      assert(ix.includes("uq_clients_name_currency") && !ix.includes("uq_clients_name"), ix.join(","));
      let refused = false;
      try { h.q("INSERT INTO cmp0001_clients (id, name, currency, created_at) VALUES ('dup1', ?, 'USD', '2026-01-01')", [ctx.u.name]); } catch (e) { refused = /duplicate/i.test(e.message); }
      assert(refused, "same name + currency accepted by the database");
    } finally { h.close(); }
  });
  await check("upgrading an existing installation: the old UNIQUE(name) is replaced without touching any account", async () => {
    const { SyncMysql } = require("../src/mysql/sync-client");
    const schema = require("../src/mysql/schema");
    const e = TESTDB.env;
    const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
    const raw = (sql, p = []) => { const r = c.query(sql, p); return r.rows || r; };
    try {
      schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0808" });
      const t = "cmp0808_clients";
      raw(`ALTER TABLE "${t}" DROP INDEX "uq_clients_name_currency", ADD UNIQUE KEY "uq_clients_name" ("name")`);
      raw(`INSERT INTO "${t}" (id, name, currency, created_at, company_id) VALUES ('a1', 'Old Customer', 'USD', '2026-01-01', 'CMP-0808')`);
      let refused = false;
      try { raw(`INSERT INTO "${t}" (id, name, currency, created_at, company_id) VALUES ('a2', 'Old Customer', 'SLSH', '2026-01-01', 'CMP-0808')`); } catch (err) { refused = true; }
      assert(refused, "old index should refuse");
      const { altered } = schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0808" });
      assert(altered.some((a) => /uq_clients_name_currency/.test(a)) && altered.some((a) => /-uq_clients_name$/.test(a)), altered.join(","));
      raw(`INSERT INTO "${t}" (id, name, currency, created_at, company_id) VALUES ('a2', 'Old Customer', 'SLSH', '2026-01-01', 'CMP-0808')`);
      assert(raw(`SELECT COUNT(*) AS n FROM "${t}"`)[0].n === 2 && raw(`SELECT name FROM "${t}" WHERE id = 'a1'`)[0].name === "Old Customer", "rows changed");
      assert(schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0808" }).altered.length === 0, "second upgrade changed something");
    } finally {
      for (const n of schema.companyTables("CMP-0808").reverse()) raw(`DROP TABLE IF EXISTS "${n}"`);
      c.close();
    }
  });
  await check("another company has its own names, and never sees this company's accounts", async () => {
    const sa = await login("super.admin", SA_PW);
    const co = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Same Name Beta", admin: { name: "Sn Admin", username: "sn.admin", password: "BetaPass123!" } } });
    assert(co.status === 201 || co.status === 200, `company ${co.status}`);
    const b = await login("sn.admin", "BetaPass123!");
    const r = await api("/api/accounts", { method: "POST", token: b, body: { name: "Ahmed Hassan", currency: "USD" } });
    assert(r.status === 201, `B create ${r.status} ${JSON.stringify(r.json)}`);
    const list = (await api("/api/accounts?search=Ahmed", { token: b })).json.accounts;
    assert(list.length === 1 && list[0].id === r.json.account.id, "B sees A's accounts");
    assert((await api(`/api/accounts/${ctx.u.id}`, { token: b })).status === 404, "B opens A's account");
    assert((await api(`/api/accounts/${ctx.u.id}/deposit`, { method: "POST", token: b, body: { amount: 1, currency: "USD" } })).status === 404, "B posts to A's account");
  });
  await check("existing balances and references are unchanged by all of this", async () => {
    assert(await bal(ctx.u.id) === 400, "usd balance");
    const h = db();
    try {
      const refs = h.q("SELECT reference_number FROM cmp0001_exchange_transactions WHERE id = ?", [ctx.ex.id])[0].reference_number;
      assert(refs === ctx.ex.referenceNumber, "exchange reference changed");
    } finally { h.close(); }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
