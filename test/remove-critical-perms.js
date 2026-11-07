"use strict";
// Owner-approved cleanup: scripts/remove-critical-perms.js leaves CRITICAL
// permissions with the Super Admin only. Dry run changes nothing; --confirm
// removes only the critical keys, signs holders out, writes audit entries,
// never touches financial records. Run with: npm run test:remove-critical-perms
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("critperms");
const PORT = Number(process.env.CRIT_TEST_PORT || 4697);
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
const { spawnSync } = require("child_process");
const runScript = (name, ...args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", name), ...args], { env: ENV, encoding: "utf8" });
  return `${r.stdout || ""}${r.stderr || ""}`;
};
const login = async (u) => ok(await api("/api/auth/login", { method: "POST", body: { username: u, password: u === "super.admin" ? process.env.SUPER_ADMIN_INITIAL_PASSWORD : PW } }), `login ${u}`).token;

async function run() {
  const saP = await login("super.admin");
  const cos = ok(await api("/api/platform/companies", { token: saP }), "companies");
  const cid = (cos.companies || cos)[0].id;
  const sa = ok(await api("/api/platform/switch-company", { method: "POST", token: saP, body: { companyId: cid } }), "switch").token;
  const roles0 = ok(await api("/api/roles", { token: sa }), "roles").roles;
  const critOf = (r) => (r.permissions || []).filter((k) => require("../src/permissions").permissionLevel(k) === "critical");
  const before = Object.fromEntries(roles0.map((r) => [r.id, r]));
  const acc = await login("faadumo.warsame");
  const counts = async () => { const t = ok(await api("/api/transactions", { token: sa }), "tx").transactions.length; const a = ok(await api("/api/accounts", { token: sa }), "acc"); return `${t}/${JSON.stringify(a).length}`; };
  const c0 = await counts();

  await check("before: several roles besides Super Admin hold critical permissions", async () => {
    const n = roles0.filter((r) => !r.isSuperAdmin && critOf(r).length).length;
    assert(n >= 2, `only ${n}`);
  });
  await check("dry run lists the changes and changes nothing", async () => {
    const out = runScript("remove-critical-perms.js");
    assert(/DRY RUN/.test(out) && /Nothing was changed/.test(out), out.slice(-300));
    const now = ok(await api("/api/roles", { token: sa }), "roles").roles;
    for (const r of now) assert(JSON.stringify(r.permissions) === JSON.stringify(before[r.id].permissions), `${r.name} changed in dry run`);
  });
  await check("--confirm: no role but Super Admin keeps a critical permission; everything else kept", async () => {
    const out = runScript("remove-critical-perms.js", "--confirm");
    assert(/role\(s\) and \d+ personal grant\(s\) changed/.test(out), out.slice(-400));
    const now = ok(await api("/api/roles", { token: sa }), "roles").roles;
    for (const r of now) {
      if (r.isSuperAdmin) { assert(r.permissions === null, "Super Admin lost ALL"); continue; }
      assert(!critOf(r).length, `${r.name} still has ${critOf(r).join(",")}`);
      const expected = (before[r.id].permissions || []).filter((k) => !critOf({ permissions: [k] }).length);
      assert(JSON.stringify(r.permissions) === JSON.stringify(expected), `${r.name}: non-critical permissions changed`);
    }
  });
  await check("the Accountant is signed out and, signed in again, cannot delete", async () => {
    const r = await api("/api/auth/me", { token: acc });
    assert(r.status === 401, `old session still works (${r.status})`);
    const acc2 = await login("faadumo.warsame");
    const accounts = ok(await api("/api/accounts", { token: sa }), "accounts");
    const a = (accounts.accounts || accounts)[0];
    const del = await api(`/api/accounts/${a.id}`, { method: "DELETE", token: acc2 });
    assert(del.status === 403, `delete account answered ${del.status}`);
    const still = await api(`/api/accounts/${a.id}`, { token: sa });
    assert(still.status === 200, "account gone");
  });
  await check("Super Admin keeps full access", async () => {
    const r = await api("/api/roles", { token: sa });
    assert(r.status === 200, "super admin blocked");
  });
  await check("audit log records each role change", async () => {
    const log = ok(await api("/api/reports/audit-log", { token: sa }), "audit");
    const rows = log.entries || log.rows || log.logs || log;
    assert(JSON.stringify(rows).includes("owner-approved cleanup"), "no audit entry");
  });
  await check("financial records untouched; second run finds nothing; roles-review reports 0", async () => {
    assert((await counts()) === c0, "records changed");
    const again = runScript("remove-critical-perms.js", "--confirm");
    assert(/0 role\(s\) and 0 personal grant/.test(again), again.slice(-300));
    const rev = runScript("roles-review.js");
    assert(/\n0 role\(s\) hold critical permissions/.test(rev), rev.slice(-300));
  });
}

let srv;
async function main() {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "ignore"] });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 25000) throw new Error("server did not start"); await sleep(200); }
    await run();
  } finally { srv.kill(); }
  TESTDB.drop();
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* */ } process.exit(1); });
