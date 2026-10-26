"use strict";
// GLOBAL LOGIN round — regression tests.
// Proves on a throw-away installation with two companies that the login page
// is one neutral entry point for the whole platform, and that after sign-in
// the SERVER decides where each account goes:
//   1. a Super Admin lands on the Super Admin console (no company forced),
//      and can open any company's workspace from there;
//   2. a Company Admin lands in their own company only;
//   3. the account that can reach several companies (the Super Admin) gets a
//      company selector, and nobody else can use it;
//   4. a staff user with restricted permissions lands in their own company
//      with those restrictions intact;
//   5. an account with no valid company gets a clear, safe refusal — never
//      some other company.
// Company branding is only ever returned to a session bound to that company.
//
// Run with: npm run test:global-login
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".global-login-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("global-login");
const PORT = Number(process.env.GLOBAL_LOGIN_TEST_PORT || 4370);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const C1_NAME = "Hargeysa First Co";
const C2_NAME = "Berbera Second Co";
const C2_ADMIN = { name: "Hodan Berbera", username: "hodan.berbera", password: "Berbera-Admin-Pass-31" };
const C3_NAME = "Burao Closed Co";
const C3_ADMIN = { name: "Warsame Burao", username: "warsame.burao", password: "Burao-Admin-Pass-47" };
const C1_DETAILS = { address: "Airport Road, Hargeysa", phone: "+252 63 400 0001", email: "info@first.example" };

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = (username, password) => api("/api/auth/login", { method: "POST", body: { username, password } });
// Every piece of company-identifying text a response must NOT carry.
const leaksCompany = (text) => [C1_NAME, C2_NAME, C1_DETAILS.address, C1_DETAILS.phone, C1_DETAILS.email, "Berbera Port"].filter((x) => text.includes(x));

let sa, C1, C2, C3;
async function setup() {
  sa = (await login("super.admin", SA_PW)).json.token;
  C1 = (await api("/api/platform/companies", { token: sa })).json.companies[0].id;
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  let r = await api(`/api/platform/companies/${C1}`, { method: "PATCH", token: sa, body: { name: C1_NAME, logoDataUrl: tiny, ...C1_DETAILS } });
  assert(r.status === 200, `rename Company 1: ${r.status}`);
  r = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: C2_NAME, address: "Berbera Port", admin: C2_ADMIN } });
  assert(r.status === 201, `create Company 2: ${r.status} ${r.text}`);
  C2 = r.json.company.id;
  r = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: C3_NAME, admin: C3_ADMIN } });
  assert(r.status === 201, `create Company 3: ${r.status}`);
  C3 = r.json.company.id;
  r = await api(`/api/platform/companies/${C3}/status`, { method: "POST", token: sa, body: { action: "deactivate", reason: "test" } });
  assert(r.status === 200, `deactivate Company 3: ${r.status} ${r.text}`);
}

async function apiChecks() {
  console.log("\nThe login page (before sign-in)");
  await check("shows the neutral platform identity — no company's name, logo or details", async () => {
    const r = await api("/api/settings/company");
    const c = r.json.company;
    assert(r.status === 200 && c.name === "OBO Financial System" && c.isDefault, JSON.stringify({ name: c.name }));
    assert(!c.logoDataUrl && !c.faviconDataUrl && !c.brandColor && !c.address && !c.phone && !c.email && !c.registrationNumber && !c.taxNumber, "a company detail is exposed");
    const leaks = leaksCompany(r.text);
    assert(!leaks.length, `exposes ${leaks.join(", ")}`);
  });
  await check("a forged / garbage token gets the same neutral identity", async () => {
    const r = await api("/api/settings/company", { token: "eyJhbGciOiJIUzI1NiJ9.eyJjaWQiOiJDTVAtMDAwMSJ9.bad" });
    assert(r.json.company.isDefault && !leaksCompany(r.text).length, r.text.slice(0, 120));
  });
  await check("the browser cannot pick a company at sign-in (an extra companyId is ignored)", async () => {
    const r = await api("/api/auth/login", { method: "POST", body: { username: C2_ADMIN.username, password: C2_ADMIN.password, companyId: C1 } });
    assert(r.status === 200 && r.json.user.company && r.json.user.company.name === C2_NAME, `got ${JSON.stringify(r.json && r.json.user && r.json.user.company)}`);
  });

  console.log("\n1. Super Admin");
  await check("signs in to the Super Admin console — no company is forced", async () => {
    const r = await login("super.admin", SA_PW);
    assert(r.status === 200 && r.json.user.isPlatformAdmin && !r.json.user.company, JSON.stringify(r.json.user.company));
    const b = (await api("/api/settings/company", { token: r.json.token })).json.company;
    assert(b.isDefault && b.name === "OBO Financial System", `console branding: ${b.name}`);
    const acc = await api("/api/accounts", { token: r.json.token });
    assert(acc.status === 403 && acc.json.code === "COMPANY_REQUIRED", `company data without opening a workspace: ${acc.status}`);
  });
  await check("sees the Companies list and opens any company's workspace, with that company's branding", async () => {
    const list = (await api("/api/platform/companies", { token: sa })).json.companies.map((c) => c.id);
    assert([C1, C2, C3].every((id) => list.includes(id)), `list: ${list}`);
    for (const [id, name] of [[C1, C1_NAME], [C2, C2_NAME]]) {
      const t = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: id } })).json.token;
      const b = (await api("/api/settings/company", { token: t })).json.company;
      assert(b.name === name && b.companyId === id, `${id}: ${b.name}`);
    }
  });

  console.log("\n2. Company Admin (one company)");
  let c2t;
  await check("lands in their own company with its own branding", async () => {
    const r = await login(C2_ADMIN.username, C2_ADMIN.password);
    assert(r.status === 200 && !r.json.user.isPlatformAdmin && r.json.user.company.name === C2_NAME, JSON.stringify(r.json.user.company));
    c2t = r.json.token;
    const b = (await api("/api/settings/company", { token: c2t })).json.company;
    assert(b.name === C2_NAME && !b.logoDataUrl && !b.isDefault, `branding: ${b.name}`);
    assert(!leaksCompany(JSON.stringify(b)).filter((x) => x !== C2_NAME && x !== "Berbera Port").length, "another company's details leaked");
  });
  await check("cannot see another company's data or open another workspace", async () => {
    const acc = (await api("/api/accounts", { token: c2t })).json.accounts;
    const c1acc = (await api("/api/accounts", { token: (await login("amina.yusuf", PW)).json.token })).json.accounts;
    const theirs = new Set(acc.map((a) => a.id));
    assert(c1acc.length > 0 && !c1acc.some((a) => theirs.has(a.id)), "Company 1 accounts visible to Company 2");
    const sw = await api("/api/platform/switch-company", { method: "POST", token: c2t, body: { companyId: C1 } });
    assert(sw.status === 401 || sw.status === 403, `switch-company allowed: ${sw.status}`);
    const list = await api("/api/platform/companies", { token: c2t });
    assert(list.status === 401 || list.status === 403, `companies list allowed: ${list.status}`);
  });

  console.log("\n3. Account with several companies");
  await check("only the Super Admin can reach several companies — a username belongs to one company", async () => {
    const r = await api(`/api/platform/companies/${C1}/admins`, { method: "POST", token: sa, body: { name: "Hodan Again", username: C2_ADMIN.username, password: "Another-Pass-2026x" } });
    assert(r.status === 409 || r.status === 400, `same username accepted in a second company: ${r.status}`);
  });

  console.log("\n4. Staff with restricted permissions");
  await check("a viewer lands in their own company, with their restrictions intact", async () => {
    const r = await login("sahra.ismail", PW);
    assert(r.status === 200 && r.json.user.company.name === C1_NAME, JSON.stringify(r.json.user.company));
    const b = (await api("/api/settings/company", { token: r.json.token })).json.company;
    assert(b.name === C1_NAME, `branding: ${b.name}`);
    const create = await api("/api/accounts", { method: "POST", token: r.json.token, body: { name: "Should Not Exist", accountType: "customer", currency: "USD" } });
    assert(create.status === 403, `viewer could create an account: ${create.status}`);
  });

  console.log("\n5. No valid company");
  await check("a user of a deactivated company is refused with a clear message (only after a correct password)", async () => {
    const wrong = await login(C3_ADMIN.username, "Wrong-Password-123");
    assert(wrong.status === 401 && !/deactivated/i.test(wrong.text), `wrong password reveals status: ${wrong.status} ${wrong.text}`);
    const r = await login(C3_ADMIN.username, C3_ADMIN.password);
    assert(r.status === 403 && r.json.code === "COMPANY_SUSPENDED" && /deactivated/i.test(r.json.error) && !r.json.token, `${r.status} ${r.text}`);
  });
  await check("an unknown account gets the same answer as a wrong password — nothing about any company", async () => {
    const r = await login("nobody.here", "Some-Password-2026");
    assert(r.status === 401 && !leaksCompany(r.text).length && !r.json.token, `${r.status} ${r.text}`);
  });
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  console.log("\nBrowser");
  const errors = [];
  try {
    const shot = async (p) => p.evaluate(() => ({ text: document.body.innerText, imgs: [...document.querySelectorAll("img")].filter((i) => i.offsetParent).length, brand: document.documentElement.style.getPropertyValue("--c-navy").trim() }));
    const signIn = async (p, u, pw) => { await p.locator("input").first().fill(u); await p.fill('input[type="password"]', pw); await p.keyboard.press("Enter"); await p.waitForTimeout(1800); };
    for (const [label, vp] of [["desktop", { width: 1366, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport: vp });
      const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(BASE); await p.waitForTimeout(900);
      await check(`${label}: the login page is neutral and keeps its fields, eye toggle, SO/EN and Sign in`, async () => {
        const s = await shot(p);
        assert(s.text.includes("Financial System") && s.text.includes("Welcome — sign in to access your company"), s.text.slice(0, 160));
        const leaks = leaksCompany(s.text);
        assert(!leaks.length && s.imgs === 0, `leaks: ${leaks.join(", ")} imgs=${s.imgs}`);
        assert(await p.locator('input[type="password"]').count() === 1 && await p.locator(".gk-login-eye").count() === 1, "password field / eye toggle missing");
        assert(await p.locator(".gk-lang-toggle").first().isVisible() && await p.locator(".gk-login-submit").isVisible(), "SO/EN or Sign in missing");
        const scroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert(!scroll, "page scrolls sideways");
      });
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
    await p.goto(BASE); await p.waitForTimeout(700);
    await check("an empty sign-in shows the validation message", async () => {
      await p.locator(".gk-login-submit").click(); await p.waitForTimeout(300);
      assert(/Enter your username and password/.test(await p.locator("body").innerText()), "no validation message");
    });
    await signIn(p, C2_ADMIN.username, C2_ADMIN.password);
    await check("Company Admin lands in Company 2 with Company 2's branding", async () => {
      const name = await p.locator(".gk-brand-name").first().innerText();
      assert(name === C2_NAME, `sidebar shows "${name}"`);
    });
    await check("after signing out, the login page is neutral again (no Company 2 branding left behind)", async () => {
      await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/token|user/i.test(k)) localStorage.removeItem(k); });
      await p.reload(); await p.waitForTimeout(1000);
      const s = await shot(p);
      assert(!leaksCompany(s.text).length && s.imgs === 0 && s.brand === "", `leaks: ${leaksCompany(s.text)} imgs=${s.imgs} brand=${s.brand}`);
    });
    await signIn(p, "super.admin", SA_PW);
    await check("Super Admin lands on the console with every company listed, not inside a company", async () => {
      const t = await p.locator("body").innerText();
      assert(/Super Admin Console/.test(t) && t.includes(C1_NAME) && t.includes(C2_NAME), t.slice(0, 200));
      assert(await p.locator(".gk-sidebar").count() === 0, "a company workspace was opened automatically");
    });
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/token|user/i.test(k)) localStorage.removeItem(k); });
    await p.reload(); await p.waitForTimeout(900);
    await signIn(p, C3_ADMIN.username, C3_ADMIN.password);
    await check("a user of a deactivated company sees a clear message and stays on the login page", async () => {
      const t = await p.locator("body").innerText();
      assert(/deactivated/i.test(t) && await p.locator(".gk-sidebar").count() === 0, t.slice(0, 200));
    });
    await ctx.close();
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await setup(); await apiChecks(); await browserChecks(); } finally { srv.kill(); }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
