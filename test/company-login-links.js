"use strict";
// COMPANY LOGIN LINKS round — each company can have its own sign-in page
// (<site>/<slug>, e.g. /bindhe) that shows its name and logo and accepts
// only its own users. Throw-away DB. Run with: npm run test:company-login-links
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("loginlinks");
const PORT = Number(process.env.LOGIN_LINKS_TEST_PORT || 4701);
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

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.LL_DEBUG ? "inherit" : "ignore"] });
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
  const sky = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Sky Test Exchange", address: "Hargeisa secret street", phone: "+252 111", admin: { name: "Sky Admin", username: "sky.admin", password: "Sky-Admin-Pass-2026" } } }), "sky").company;
  const B = "CMP-0001";
  const login = (username, password, companySlug) => api("/api/auth/login", { method: "POST", body: { username, password, ...(companySlug !== undefined ? { companySlug } : {}) } });

  await check("Super Admin sets a login link per company; it shows on the company", async () => {
    const b = ok(await api(`/api/platform/companies/${B}`, { method: "PATCH", token: sa, body: { loginSlug: "Bindhe" } }), "b").company;
    const s = ok(await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "sky" } }), "s").company;
    assert(b.loginSlug === "bindhe" && s.loginSlug === "sky", `${b.loginSlug} ${s.loginSlug}`);
    const list = ok(await api("/api/platform/companies", { token: sa }), "list").companies;
    assert(list.find((c) => c.id === B).loginSlug === "bindhe", "not listed");
  });
  await check("invalid, reserved and duplicate link names are refused", async () => {
    assert((await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "sky exchange!" } })).status === 400, "bad chars accepted");
    assert((await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "api" } })).status === 400, "reserved accepted");
    assert((await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "bindhe" } })).status === 409, "duplicate accepted");
    const s = ok(await api(`/api/platform/companies/${sky.id}`, { token: sa }), "get").company;
    assert(s.loginSlug === "sky", `changed to ${s.loginSlug}`);
  });
  await check("only the Super Admin can set a link", async () => {
    const t = ok(await login("faadumo.warsame", PW), "staff").token;
    assert((await api(`/api/platform/companies/${B}`, { method: "PATCH", token: t, body: { loginSlug: "x1" } })).status >= 401, "staff allowed");
  });
  await check("/bindhe and /sky open the app; an unused name is 'Not found'", async () => {
    const r1 = await fetch(BASE + "/bindhe"), r2 = await fetch(BASE + "/sky/"), r3 = await fetch(BASE + "/nobody");
    assert(r1.status === 200 && (await r1.text()).includes("app.bundle.js"), `bindhe ${r1.status}`);
    assert(r2.status === 200, `sky ${r2.status}`);
    assert(r3.status === 404, `nobody ${r3.status}`);
    assert((await fetch(BASE + "/app.bundle.js")).status === 200, "bundle broken");
  });
  await check("the page shows the company's name and logo only — no contact details or Company ID", async () => {
    const p = ok(await api("/api/public/login-page/sky"), "page").loginPage;
    assert(p.name === "Sky Test Exchange" && p.slug === "sky", JSON.stringify(p).slice(0, 200));
    const txt = JSON.stringify(p);
    assert(!txt.includes("Hargeisa") && !txt.includes("+252 111") && !txt.includes(sky.id), "leaks details");
    assert((await api("/api/public/login-page/nobody")).status === 404, "unknown slug answered");
  });
  await check("a company's page signs in its own users", async () => {
    const b = ok(await login("faadumo.warsame", PW, "bindhe"), "bindhe user");
    assert(b.token && b.user.company && b.user.company.name, JSON.stringify(b.user).slice(0, 200));
    const s = ok(await login("sky.admin", "Sky-Admin-Pass-2026", "sky"), "sky admin");
    assert(s.token, "no token");
  });
  await check("another company's user, or the Super Admin, is refused there with the ordinary message", async () => {
    const r1 = await login("sky.admin", "Sky-Admin-Pass-2026", "bindhe");
    const r2 = await login("faadumo.warsame", PW, "sky");
    const r3 = await login("super.admin", process.env.SUPER_ADMIN_INITIAL_PASSWORD, "sky");
    const r4 = await login("nobody.here", "whatever-123", "sky");
    for (const r of [r1, r2, r3, r4]) assert(r.status === 401 && /Invalid username or password/.test(r.json.error), `${r.status} ${r.text}`);
    assert((await login("sky.admin", "Sky-Admin-Pass-2026", "nobody")).status === 404, "unknown slug");
  });
  await check("the main address still signs in everyone, as before", async () => {
    ok(await login("faadumo.warsame", PW), "b main"); ok(await login("sky.admin", "Sky-Admin-Pass-2026"), "s main");
    ok(await login("super.admin", process.env.SUPER_ADMIN_INITIAL_PASSWORD), "sa main");
  });
  await check("refused attempts are audited; removing a link closes that page", async () => {
    const rows = ok(await api("/api/platform/overview", { token: sa }), "overview").recentActivity;
    assert(JSON.stringify(rows).includes("Not a user of this company's login page"), "not audited");
    ok(await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "" } }), "clear");
    assert((await fetch(BASE + "/sky")).status === 404, "page still served");
    ok(await api(`/api/platform/companies/${sky.id}`, { method: "PATCH", token: sa, body: { loginSlug: "sky" } }), "restore");
  });

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await check("browser: /sky shows Sky's name; Bindhe's user is refused; Sky's admin gets in", async () => {
      await p.goto(BASE + "/sky"); await p.waitForTimeout(1500);
      assert(await p.getByText("Sky Test Exchange").count() >= 1, "name not shown");
      if (process.env.LL_SHOTS) await p.screenshot({ path: path.join(process.env.LL_SHOTS, "login-sky.png") });
      await p.getByPlaceholder("Username").fill("faadumo.warsame"); await p.getByPlaceholder("Password").fill(PW);
      await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(1200);
      assert(await p.getByText(/Invalid username or password/).count() >= 1, "wrong user not refused");
      await p.getByPlaceholder("Username").fill("sky.admin"); await p.getByPlaceholder("Password").fill("Sky-Admin-Pass-2026");
      await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForTimeout(2500);
      assert(await p.getByPlaceholder("Password").count() === 0, "still on the login page");
      assert(new URL(p.url()).pathname === "/sky", `left the link: ${p.url()}`);
    });
    await check("browser: a session of another company is ended on /bindhe — Bindhe's sign-in page is shown", async () => {
      const t = ok(await login("sky.admin", "Sky-Admin-Pass-2026"), "sky").token;
      const u = ok(await api("/api/auth/me", { token: t }), "me").user;
      const c3 = await browser.newContext(); const p3 = await c3.newPage();
      await p3.addInitScript(([tok, usr]) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("geeska_token", tok); localStorage.setItem("geeska_user", usr); sessionStorage.setItem("seeded", "1"); } } catch (e) {} }, [t, JSON.stringify(u)]);
      await p3.goto(BASE + "/bindhe"); await p3.waitForTimeout(2500);
      assert(await p3.getByPlaceholder("Password").count() === 1, "Sky's workspace shown on Bindhe's link");
      assert(await p3.getByText("Sky Test Exchange").count() === 0, "Sky branding shown");
      await c3.close();
    });
    await check("browser: the main page is unchanged (neutral)", async () => {
      const p2 = await (await browser.newContext()).newPage();
      await p2.goto(BASE + "/"); await p2.waitForTimeout(1200);
      assert(await p2.getByText("Financial System").count() >= 1 && await p2.getByText("Sky Test Exchange").count() === 0, "main page changed");
    });
    await check("no page errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
