"use strict";
// SECURITY AUDIT round — regression tests for the audit's fixes.
//
// Builds a throw-away installation (seeded with the PUBLISHED demo passwords
// on purpose, to prove they are neutralized) and checks, over real HTTP:
//   * a malformed URL is a 400, not a server crash;
//   * security headers are present and API answers are never cached;
//   * a sign-in with a published default password is forced to change it,
//     and the server refuses every other request until then;
//   * the password policy refuses defaults/common passwords everywhere;
//   * a password reset or change ends the account's existing sessions;
//   * the notifications feed no longer leaks the audit log to staff;
//   * login is rate-limited per source and doesn't reveal valid usernames;
//   * CSV exports neutralize spreadsheet formulas but keep numbers numeric;
//   * report totals ignore permanently deleted accounts;
//   * Cash in Hand running balances replay in true chronological order;
//   * sensitive endpoints refuse anonymous callers.
//
// Run with: npm run test:security
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".security-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("security");
const PORT = Number(process.env.SECURITY_TEST_PORT || 4330);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
// Deliberately the published defaults: this suite proves they are handled.
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0", SEED_DEMO_PASSWORD: "Demo123!", SUPER_ADMIN_INITIAL_PASSWORD: "", RESTORE_TOKEN: "" };
delete ENV.SUPER_ADMIN_INITIAL_PASSWORD;
delete ENV.RESTORE_TOKEN;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
// Each logical "client" gets its own source address (X-Forwarded-For), so the
// per-IP login limiter test can't throttle the other checks.
async function api(p, { method = "GET", body, token, ip = "10.0.0.1", raw = false } = {}) {
  const headers = { "X-Forwarded-For": ip };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, headers: res.headers };
}
const login = (username, password, ip) => api("/api/auth/login", { method: "POST", body: { username, password }, ip });
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

const NEW_PW = "Fresh-Secret-Pw-91";
const tokens = {};

async function run() {
  console.log("\nCrash resistance");
  await check("a malformed URL escape is answered 400 and the server keeps running", async () => {
    const r = await fetch(`${BASE}/api/accounts/%E0%A4%A`);
    assert(r.status === 400, `expected 400, got ${r.status}`);
    const h = await fetch(`${BASE}/api/health`);
    assert(h.ok, "server is no longer answering after the malformed request");
  });

  console.log("\nHeaders");
  await check("security headers are set and API answers are not cacheable", async () => {
    const r = await api("/api/health");
    for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy"]) {
      assert(r.headers.get(h), `missing ${h}`);
    }
    assert(/no-store/.test(r.headers.get("cache-control") || ""), "API JSON should be Cache-Control: no-store");
  });
  await check("CORS never reflects a foreign origin", async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert(!r.headers.get("access-control-allow-origin"), "a foreign Origin was allowed");
  });

  console.log("\nAnonymous access");
  for (const [m, p] of [["GET", "/api/accounts"], ["GET", "/api/users"], ["GET", "/api/backups"], ["GET", "/api/reports/audit-log"], ["GET", "/api/transactions/export.csv"], ["GET", "/api/platform/companies"], ["POST", "/api/auth/me/password"], ["GET", "/api/notifications"]]) {
    await check(`${m} ${p} without a token is refused`, async () => {
      const r = await api(p, { method: m, body: m === "POST" ? {} : undefined });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    });
  }
  await check("the database-restore route is disabled when RESTORE_TOKEN is not set", async () => {
    const r = await api("/api/_restore-db", { method: "POST", body: {} });
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  console.log("\nPublished default passwords");
  let mpcToken;
  await check("company user signing in with Demo123! is flagged mustChangePassword", async () => {
    const r = await login("amina.yusuf", "Demo123!");
    assert(r.status === 200, `login failed: ${r.status}`);
    assert(r.json.user.mustChangePassword === true, "mustChangePassword not set");
    mpcToken = r.json.token;
  });
  await check("...and the server refuses that session everywhere else (403 PASSWORD_CHANGE_REQUIRED)", async () => {
    for (const p of ["/api/accounts", "/api/dashboard", "/api/users", "/api/transactions"]) {
      const r = await api(p, { token: mpcToken });
      assert(r.status === 403 && r.json && r.json.code === "PASSWORD_CHANGE_REQUIRED", `${p}: expected 403 PASSWORD_CHANGE_REQUIRED, got ${r.status}`);
    }
  });
  await check("...but it can still load its own profile", async () => {
    const r = await api("/api/auth/me", { token: mpcToken });
    assert(r.status === 200 && r.json.user.mustChangePassword === true, `expected 200 + flag, got ${r.status}`);
  });
  await check("a new password that is a published default or too short is refused", async () => {
    for (const bad of ["SuperAdmin123!", "demo123!", "short1", "Password123", "amina.yusuf"]) {
      const r = await api("/api/auth/me/password", { method: "POST", token: mpcToken, body: { currentPassword: "Demo123!", newPassword: bad } });
      assert(r.status === 400, `"${bad}" should be refused, got ${r.status}`);
    }
  });
  await check("a wrong current password is refused", async () => {
    const r = await api("/api/auth/me/password", { method: "POST", token: mpcToken, body: { currentPassword: "nope-nope-nope", newPassword: NEW_PW } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  let freshToken;
  await check("changing it returns a normal session; the old one stops working", async () => {
    const r = await api("/api/auth/me/password", { method: "POST", token: mpcToken, body: { currentPassword: "Demo123!", newPassword: NEW_PW } });
    assert(r.status === 200 && r.json.token, `expected 200 + token, got ${r.status} ${JSON.stringify(r.json)}`);
    freshToken = r.json.token;
    assert((await api("/api/accounts", { token: freshToken })).status === 200, "new session can't read accounts");
    assert((await api("/api/auth/me", { token: mpcToken })).status === 401, "old session still accepted");
    assert((await login("amina.yusuf", "Demo123!")).status === 401, "the old default password still works");
    assert((await login("amina.yusuf", NEW_PW)).status === 200, "the new password does not work");
    tokens.admin = freshToken;
  });
  let saToken;
  await check("Super Admin with SuperAdmin123! is forced to change it before managing companies", async () => {
    const r = await login("super.admin", "SuperAdmin123!", "10.0.0.2");
    assert(r.status === 200 && r.json.user.mustChangePassword === true, "Super Admin not flagged");
    const blocked = await api("/api/platform/companies", { token: r.json.token, ip: "10.0.0.2" });
    assert(blocked.status === 403 && blocked.json.code === "PASSWORD_CHANGE_REQUIRED", `expected 403, got ${blocked.status}`);
    const sw = await api("/api/platform/switch-company", { method: "POST", token: r.json.token, body: { companyId: "CMP-0001" }, ip: "10.0.0.2" });
    assert(sw.status === 403, `switching company should be blocked, got ${sw.status}`);
    const ch = await api("/api/platform/me/password", { method: "POST", token: r.json.token, body: { currentPassword: "SuperAdmin123!", newPassword: "SuperAdmin123!" }, ip: "10.0.0.2" });
    assert(ch.status === 400, "re-using the default was accepted");
    const ok = await api("/api/platform/me/password", { method: "POST", token: r.json.token, body: { currentPassword: "SuperAdmin123!", newPassword: "Platform-Owner-Pw-77" }, ip: "10.0.0.2" });
    assert(ok.status === 200 && ok.json.token, `change failed: ${ok.status}`);
    saToken = ok.json.token;
    tokens.sa = saToken;
    assert((await api("/api/platform/companies", { token: saToken, ip: "10.0.0.2" })).status === 200, "new Super Admin session can't list companies");
  });

  console.log("\nPassword policy & session revocation");
  let viewerToken;
  await check("an admin can't create a user with a published default password", async () => {
    const roles = await api("/api/roles", { token: tokens.admin });
    const viewer = roles.json.roles.find((r) => /viewer/i.test(r.key || r.name));
    const r = await api("/api/users", { method: "POST", token: tokens.admin, body: { name: "Policy Probe", username: "policy.probe", password: "Demo123!", roleId: viewer.id } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await check("an admin password reset signs the user out of every existing session", async () => {
    // sahra.ismail (viewer) changes her own default first, then is reset by the admin.
    const first = await login("sahra.ismail", "Demo123!", "10.0.0.3");
    const ch = await api("/api/auth/me/password", { method: "POST", token: first.json.token, body: { currentPassword: "Demo123!", newPassword: "Sahra-Own-Pw-55" }, ip: "10.0.0.3" });
    assert(ch.status === 200, `self change failed: ${ch.status}`);
    viewerToken = ch.json.token;
    assert((await api("/api/auth/me", { token: viewerToken, ip: "10.0.0.3" })).status === 200, "viewer session not working");
    const users = await api("/api/users", { token: tokens.admin });
    const sahra = users.json.users.find((u) => u.username === "sahra.ismail");
    const reset = await api(`/api/users/${sahra.id}`, { method: "PATCH", token: tokens.admin, body: { password: "Reset-By-Admin-33" } });
    assert(reset.status === 200, `reset failed: ${reset.status} ${JSON.stringify(reset.json)}`);
    assert((await api("/api/auth/me", { token: viewerToken, ip: "10.0.0.3" })).status === 401, "the old session survived a password reset");
    const again = await login("sahra.ismail", "Reset-By-Admin-33", "10.0.0.3");
    assert(again.status === 200, "can't sign in with the reset password");
    viewerToken = again.json.token;
  });

  console.log("\nNotifications feed");
  await check("a user without Reports (cashier) sees only their own activity", async () => {
    const first = await login("cabdi.maxamed", "Demo123!", "10.0.0.4");
    const ch = await api("/api/auth/me/password", { method: "POST", token: first.json.token, body: { currentPassword: "Demo123!", newPassword: "Cabdi-Own-Pw-44" }, ip: "10.0.0.4" });
    assert(ch.status === 200, `cashier password change failed: ${ch.status}`);
    const r = await api("/api/notifications?limit=50", { token: ch.json.token, ip: "10.0.0.4" });
    assert(r.status === 200, `got ${r.status}`);
    assert(r.json.notifications.length >= 1, "cashier should still see their own activity");
    const others = r.json.notifications.filter((n) => !/CABDI/i.test(n.actorName || ""));
    assert(others.length === 0, `saw ${others.length} entries by other people (e.g. "${others[0] && others[0].action}")`);
  });
  await check("a user with Reports still sees everyone's activity", async () => {
    const r = await api("/api/notifications?limit=50", { token: tokens.admin });
    const names = new Set(r.json.notifications.map((n) => n.actorName));
    assert(names.size > 1, "admin feed only shows one person");
  });

  console.log("\nLogin abuse");
  await check("one source is throttled after 30 failed sign-ins across many usernames", async () => {
    let last;
    for (let i = 0; i < 31; i++) last = await login(`spray.user${i}`, "Wrong-Pw-000", "10.9.9.9");
    assert(last.status === 429, `expected 429 after 31 failures, got ${last.status}`);
    const other = await login("amina.yusuf", NEW_PW, "10.9.9.10");
    assert(other.status === 200, "a different source was throttled too");
  });
  await check("an unknown username takes about as long as a wrong password (no enumeration by timing)", async () => {
    const time = async (u, ip) => { const t = Date.now(); await login(u, "Wrong-Pw-123", ip); return Date.now() - t; };
    const known = [], unknown = [];
    for (let i = 0; i < 3; i++) { known.push(await time("xasan.cali", `10.7.0.${i}`)); unknown.push(await time(`nobody.${i}.${Date.now()}`, `10.7.1.${i}`)); }
    const k = Math.min(...known), u = Math.min(...unknown);
    assert(u >= k * 0.5, `unknown user answered much faster (${u}ms vs ${k}ms)`);
  });
  await check("non-string credentials are rejected cleanly (400, not 500)", async () => {
    const r = await api("/api/auth/login", { method: "POST", body: { username: { $ne: 1 }, password: ["x"] } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  console.log("\nExports & reports");
  await check("CSV export neutralizes formulas but leaves negative numbers numeric", async () => {
    const make = await api("/api/accounts", { method: "POST", token: tokens.admin, body: { name: "=HYPERLINK(\"http://x\")", currency: "USD", accountType: "customer" } });
    assert(make.status === 201 || make.status === 200, `account create failed: ${make.status} ${JSON.stringify(make.json)}`);
    const csv = await api("/api/accounts/export.csv?currency=USD", { token: tokens.admin, raw: true });
    assert(csv.status === 200, `export failed: ${csv.status}`);
    assert(!/(^|,)"?=HYPERLINK/im.test(csv.text), "a cell still starts with =HYPERLINK");
    assert(/'=HYPERLINK/i.test(csv.text), "the formula cell was not prefixed with an apostrophe");
    const { toCSV } = require("../src/csv");
    const out = toCSV(["a", "b", "c"], [[-1250.5, "-1250.50", "@SUM(A1)"]]);
    assert(out.includes("-1250.5,-1250.50,'@SUM(A1)"), `unexpected CSV: ${JSON.stringify(out)}`);
  });
  await check("Accounts Summary report ignores permanently deleted accounts", async () => {
    const before = (await api("/api/reports/accounts-summary", { token: tokens.admin })).json;
    const acc = await api("/api/accounts", { method: "POST", token: tokens.admin, body: { name: "Temp Delete Probe", currency: "USD", accountType: "customer" } });
    const id = (acc.json.account || acc.json).id;
    const dep = await api(`/api/accounts/${id}/deposit`, { method: "POST", token: tokens.admin, body: { amount: 777 } });
    assert(dep.status === 200 || dep.status === 201, `deposit failed: ${dep.status}`);
    assert((await api(`/api/accounts/${id}/deactivate`, { method: "POST", token: tokens.admin, body: { reason: "test" } })).status === 200, "deactivate failed");
    const del = await api(`/api/accounts/${id}`, { method: "DELETE", token: tokens.admin, body: { confirmName: (acc.json.account || acc.json).name } });
    assert(del.status === 200, `delete failed: ${del.status} ${JSON.stringify(del.json)}`);
    const after = (await api("/api/reports/accounts-summary", { token: tokens.admin })).json;
    assert(after.totalAccounts === before.totalAccounts + 1 - 1 + 0 || after.totalAccounts === before.totalAccounts, `account count changed: ${before.totalAccounts} -> ${after.totalAccounts}`);
    assert(Math.abs(after.totalBalanceUSD - before.totalBalanceUSD) < 0.005, `USD total changed by a deleted account: ${before.totalBalanceUSD} -> ${after.totalBalanceUSD}`);
  });

  console.log("\nCash in Hand running balance");
  await check("entries on the same day replay in true time order (date-only vs timestamp)", async () => {
    const sw = await api("/api/platform/switch-company", { method: "POST", token: tokens.sa, body: { companyId: "CMP-0001" }, ip: "10.0.0.2" });
    assert(sw.status === 200, `switch failed: ${sw.status}`);
    tokens.admin = sw.json.token; // Super Admin workspace (Cash in Hand rights)
    const created = await api("/api/cash/accounts", { method: "POST", token: tokens.admin, body: { name: "Order Probe Till", currency: "USD", type: "physical_cash", accountType: "physical_cash" } });
    assert(created.status === 201 || created.status === 200, `cash account create failed: ${created.status} ${JSON.stringify(created.json)}`);
    const id = (created.json.account || created.json.cashAccount || created.json).id;
    const day = new Date().toISOString().slice(0, 10);
    // 1) a date-only deposit entered now; 2) a deposit explicitly dated 00:05
    // today (earlier in the day); 3) a withdrawal entered now.
    for (const [kind, body] of [["deposit", { amount: 100, date: day }], ["deposit", { amount: 50, date: `${day}T00:05:00.000Z` }], ["withdraw", { amount: 30, date: day }]]) {
      const r = await api(`/api/cash/accounts/${id}/${kind}`, { method: "POST", token: tokens.admin, body });
      assert(r.status === 200 || r.status === 201, `${kind} failed: ${r.status} ${JSON.stringify(r.json)}`);
    }
    const led = await api(`/api/cash/ledger?cashAccountId=${id}`, { token: tokens.admin });
    const rows = (led.json.entries || led.json.ledger || []).slice();
    assert(rows.length === 3, `expected 3 entries, got ${rows.length}`);
    const byAmt = Object.fromEntries(rows.map((r) => [r.amount, r.balanceAfter]));
    assert(byAmt[50] === 50, `the 00:05 deposit should come first (balance 50), got ${byAmt[50]}`);
    assert(byAmt[100] === 150 && byAmt[30] === 120, `running balances wrong: ${JSON.stringify(byAmt)}`);
  });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding a scratch installation with the published demo passwords...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    await waitUp();
    await run();
  } finally {
    srv.kill();
  }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|URIError|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
