"use strict";
// QUOTATION DELETE FIX — deleting a quotation removes its charge, payments
// and refund from the account and recalculates the balance; entries left by
// quotations deleted before the fix can be listed and removed. Throw-away DB.
// Run with: npm run test:quotation-delete
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("qdelete");
const PORT = Number(process.env.QDELETE_TEST_PORT || 4699);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0", SNAPSHOTS_ENABLED: "1", SNAPSHOT_TICK_MS: "1000", FINMAN_TEST_MODE: "1" };
const PW = process.env.SEED_DEMO_PASSWORD;

let passed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token, raw, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* none */ }
      return { status: r.status, json, text };
    } catch (e) { if (attempt >= 1) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.json; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { openScope } = require("./helpers/mysql");

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.QD_DEBUG ? "inherit" : "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await sleep(200); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

async function run() {
  const sa = ok(await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: process.env.SUPER_ADMIN_INITIAL_PASSWORD } }), "sa").token;
  const A = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  const acct = ok(await api("/api/accounts", { method: "POST", token: A, body: { name: "Qd Customer", currency: "USD" } }), "account").account;
  const other = ok(await api("/api/accounts", { method: "POST", token: A, body: { name: "Qd Other", currency: "USD" } }), "account").account;
  const bal = async (id) => Number(ok(await api(`/api/accounts/${id}`, { token: A }), "acc").account.balance);
  const ledgerCount = async (id) => { const db = openScope(TESTDB.env, { readOnly: true }); try { return db.prepare("SELECT COUNT(*) AS n FROM account_ledger WHERE client_id = ?").get(id).n; } finally { db.close(); } };
  const mkQ = async (account, price) => ok(await api("/api/quotations", { method: "POST", token: A, body: { clientName: account.name, accountId: account.id, currency: "USD", items: [{ description: "Qd item", qty: 1, unitPrice: price, currency: "USD" }] } }), "quotation").quotation;

  const otherQ = await mkQ(other, 70);
  const otherBal = await bal(other.id);

  await check("pending quotation: delete removes its debit and restores the balance", async () => {
    const b0 = await bal(acct.id), n0 = await ledgerCount(acct.id);
    const q = await mkQ(acct, 250);
    assert(Math.abs((await bal(acct.id)) - (b0 - 250)) < 0.001, "charge not posted");
    const r = ok(await api(`/api/quotations/${q.id}`, { method: "DELETE", token: A, body: { reason: "Created by mistake" } }), "delete");
    assert(r.removedEntries === 1, `removed ${r.removedEntries}`);
    assert(Math.abs((await bal(acct.id)) - b0) < 0.001, `balance ${await bal(acct.id)} vs ${b0}`);
    assert((await ledgerCount(acct.id)) === n0, "ledger row left");
    assert((await api(`/api/quotations/${q.id}`, { token: A })).status === 404, "quotation still there");
  });
  await check("partly paid quotation: charge and payments all removed; balance back to before", async () => {
    const b0 = await bal(acct.id), n0 = await ledgerCount(acct.id);
    const q = await mkQ(acct, 400);
    ok(await api(`/api/quotations/${q.id}/payments`, { method: "POST", token: A, body: { amount: 150, method: "Cash" } }), "pay 1");
    ok(await api(`/api/quotations/${q.id}/payments`, { method: "POST", token: A, body: { amount: 50, method: "Cash" } }), "pay 2");
    assert(Math.abs((await bal(acct.id)) - (b0 - 200)) < 0.001, "payments not posted");
    const r = ok(await api(`/api/quotations/${q.id}`, { method: "DELETE", token: A }), "delete");
    assert(r.removedEntries === 3, `removed ${r.removedEntries}`);
    assert(Math.abs((await bal(acct.id)) - b0) < 0.001, "balance not restored");
    assert((await ledgerCount(acct.id)) === n0, "rows left");
  });
  await check("refunded quotation: charge and refund removed (net zero either way)", async () => {
    const b0 = await bal(acct.id), n0 = await ledgerCount(acct.id);
    const q = await mkQ(acct, 90);
    ok(await api(`/api/quotations/${q.id}/refund-charge`, { method: "POST", token: A }), "refund");
    ok(await api(`/api/quotations/${q.id}`, { method: "DELETE", token: A }), "delete");
    assert(Math.abs((await bal(acct.id)) - b0) < 0.001 && (await ledgerCount(acct.id)) === n0, "not clean");
  });
  await check("another account's quotation is untouched", async () => {
    assert(Math.abs((await bal(other.id)) - otherBal) < 0.001, "other balance changed");
    assert((await api(`/api/quotations/${otherQ.id}`, { token: A })).status === 200, "other quotation gone");
  });
  await check("the deletion is audited with what was removed", async () => {
    const e = ok(await api("/api/reports/audit-log", { token: A }), "audit").entries.find((x) => x.action === "Quotation deleted");
    assert(e && /Account entries removed: \d+/.test(e.details) && /Created by mistake|balance recomputed/.test(e.details), e && e.details);
  });

  // An entry left behind by a quotation deleted BEFORE the fix (simulated:
  // the quotation row removed directly, its ledger rows kept).
  let orphanQ;
  await check("entries of quotations deleted before the fix are listed", async () => {
    orphanQ = await mkQ(acct, 333);
    const db = openScope(TESTDB.env);
    try { db.prepare("DELETE FROM quotation_items WHERE quotation_id = ?").run(orphanQ.id); db.prepare("DELETE FROM quotations WHERE id = ?").run(orphanQ.id); } finally { db.close(); }
    const list = ok(await api("/api/quotations/orphan-entries", { token: A }), "list").entries;
    assert(list.length === 1 && Number(list[0].amount) === 333 && list[0].accountId === acct.id && list[0].type === "withdrawal", JSON.stringify(list));
  });
  await check("removing them restores the balance and is audited; a second run finds nothing", async () => {
    const before = await bal(acct.id);
    const r = ok(await api("/api/quotations/orphan-entries/remove", { method: "POST", token: A }), "remove");
    assert(r.removed === 1, `removed ${r.removed}`);
    assert(Math.abs((await bal(acct.id)) - (before + 333)) < 0.001, "balance not restored");
    assert(ok(await api("/api/quotations/orphan-entries", { token: A }), "list2").entries.length === 0, "still listed");
    const acts = ok(await api("/api/reports/audit-log", { token: A }), "audit").entries.map((x) => x.action);
    assert(acts.includes("Deleted-quotation entry removed"), "not audited");
    assert(Math.abs((await bal(other.id)) - otherBal) < 0.001, "other account changed");
  });
  await check("without the delete permission the cleanup is refused", async () => {
    const viewer = ok(await api("/api/auth/login", { method: "POST", body: { username: "sahra.ismail", password: PW } }), "viewer").token;
    assert((await api("/api/quotations/orphan-entries", { token: viewer })).status === 403, "list allowed");
    assert((await api("/api/quotations/orphan-entries/remove", { method: "POST", token: viewer })).status === 403, "remove allowed");
  });
  await check("integrity check passes afterwards", async () => {
    const r = require("child_process").spawnSync(process.execPath, [path.join(ROOT, "scripts", "integrity-check.js")], { env: ENV, encoding: "utf8" });
    assert(r.status === 0, `${r.stdout}${r.stderr}`.slice(-400));
  });
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
