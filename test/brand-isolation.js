"use strict";
// BRAND ISOLATION round — two companies with visibly different brand
// colours (red / blue). Every screen must show only the active company's
// brand: anonymous login links, sign-in, sign-out, Super Admin workspace
// switching, a session of another company opening a link, and delayed
// (stale) branding replies. The platform has its own (purple) branding for
// the main address and the Super Admin Console. Theme and language are
// kept per company and per platform. Also: who may change which branding,
// rejected/invalid values (default theme), persistence across devices,
// readable text on light brands, PDFs, and the audit trail.
// Throw-away DB. Run with: npm run test:brand-isolation
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("brandiso");
const PORT = Number(process.env.BRAND_ISO_TEST_PORT || 4702);
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
const FAKE_PNG = "data:image/png;base64," + Buffer.from("this is not an image at all").toString("base64");
const RED = "#b91c1c", BLUE = "#1d4ed8", PURPLE = "#7e22ce";

let srv;
async function main() {
  console.log("Seeding two throw-away companies...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.BI_DEBUG ? "inherit" : "ignore"] });
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
  const B = ok(await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Blue Harbour Exchange", admin: { name: "Blue Admin", username: "blue.admin", password: "Blue-Admin-Pass-2026" } } }), "B").company;
  const A = { id: "CMP-0001" };
  const tokFor = async (cid) => ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: cid } }), "switch").token;
  ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(A.id), body: { name: "Red Rock Exchange", brandColor: RED, brandThemeKey: "custom" } }), "A brand");
  ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(B.id), body: { brandColor: BLUE, brandThemeKey: "custom" } }), "B brand");
  ok(await api(`/api/platform/companies/${A.id}`, { method: "PATCH", token: sa, body: { loginSlug: "red" } }), "slug A");
  ok(await api(`/api/platform/companies/${B.id}`, { method: "PATCH", token: sa, body: { loginSlug: "blue" } }), "slug B");

  await check("platform branding is the Super Admin's alone; it and company branding never touch each other", async () => {
    const staff = ok(await api("/api/auth/login", { method: "POST", body: { username: "faadumo.warsame", password: PW } }), "staff").token;
    assert((await api("/api/platform/branding", { method: "PATCH", token: staff, body: { brandColor: "#000000" } })).status === 403, "company user changed platform branding");
    assert((await api("/api/platform/branding", { method: "PATCH", token: sa, body: { brandColor: "purple" } })).status === 400, "bad colour accepted");
    const pb = ok(await api("/api/platform/branding", { method: "PATCH", token: sa, body: { name: "Purple Platform", brandColor: PURPLE, brandThemeKey: "custom" } }), "platform").branding;
    assert(pb.brandColor === PURPLE && pb.name === "Purple Platform", JSON.stringify(pb).slice(0, 200));
    assert(ok(await api("/api/settings/company", { token: await tokFor(A.id) }), "a").company.brandColor === RED, "platform change reached Red");
    ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(A.id), body: { brandColor: "#991b1b" } }), "red tweak");
    assert(ok(await api("/api/platform/branding", { token: sa }), "pb").branding.brandColor === PURPLE, "company change reached the platform");
    ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(A.id), body: { brandColor: RED } }), "red back");
    const anon = ok(await api("/api/settings/company"), "anon").company;
    assert(anon.brandColor === PURPLE && anon.name === "Purple Platform" && !anon.address && !anon.phone && !anon.updatedBy, "main address does not show the platform brand only");
  });
  await check("server: each company's own branding, by link and by session; the platform's without one", async () => {
    assert(ok(await api("/api/public/login-page/red"), "red").loginPage.brandColor === RED, "red page");
    assert(ok(await api("/api/public/login-page/blue"), "blue").loginPage.brandColor === BLUE, "blue page");
    const blueSess = ok(await api("/api/auth/login", { method: "POST", body: { username: "blue.admin", password: "Blue-Admin-Pass-2026" } }), "blue login").token;
    assert(ok(await api("/api/settings/company", { token: blueSess }), "b").company.brandColor === BLUE, "blue session");
    assert(ok(await api("/api/settings/company", { token: await tokFor(A.id) }), "a").company.brandColor === RED, "red workspace");
    assert(ok(await api("/api/settings/company"), "anon").company.brandColor === PURPLE, "anonymous did not get the platform colour");
    assert(ok(await api("/api/settings/company", { token: sa }), "console").company.brandColor === PURPLE, "console did not get the platform colour");
  });

  await check("permissions: only users with Settings manage their OWN company's branding; nobody else's", async () => {
    const viewer = ok(await api("/api/auth/login", { method: "POST", body: { username: "sahra.ismail", password: PW } }), "viewer").token;
    assert((await api("/api/settings/company", { method: "PATCH", token: viewer, body: { brandColor: "#000000" } })).status === 403, "viewer changed branding");
    const blue = ok(await api("/api/auth/login", { method: "POST", body: { username: "blue.admin", password: "Blue-Admin-Pass-2026" } }), "blue").token;
    ok(await api("/api/settings/company", { method: "PATCH", token: blue, body: { secondaryColor: "#dbeafe" } }), "blue own");
    assert(ok(await api("/api/settings/company", { token: await tokFor(A.id) }), "a").company.secondaryColor !== "#dbeafe", "Blue's change reached Red");
    assert(ok(await api("/api/settings/company", { token: blue }), "b").company.brandColor === BLUE, "Blue lost its colour");
    assert((await api("/api/platform/branding", { method: "PATCH", token: blue, body: { name: "x" } })).status === 403, "company admin changed platform branding");
    assert((await api("/api/platform/branding", { token: blue })).status === 403, "company admin read platform settings");
  });
  await check("validation: bad colours and fake images are refused; nothing is stored", async () => {
    const t = await tokFor(B.id);
    for (const body of [{ brandColor: "blue" }, { accentColor: "#12345" }, { secondaryColor: "#zzzzzz" }, { logoDataUrl: FAKE_PNG }, { faviconDataUrl: FAKE_PNG }, { brandThemeKey: "<script>" }]) {
      const r = await api("/api/settings/company", { method: "PATCH", token: t, body });
      assert(r.status === 400, `company ${JSON.stringify(body).slice(0, 40)} → ${r.status}`);
    }
    for (const body of [{ brandColor: "blue" }, { logoDataUrl: FAKE_PNG }, { faviconDataUrl: FAKE_PNG }, { name: "  " }]) {
      const r = await api("/api/platform/branding", { method: "PATCH", token: sa, body });
      assert(r.status === 400, `platform ${JSON.stringify(body).slice(0, 40)} → ${r.status}`);
    }
    const b = ok(await api("/api/settings/company", { token: t }), "b").company;
    assert(b.brandColor === BLUE && !b.logoDataUrl, "a refused value was stored");
    assert(ok(await api("/api/platform/branding", { token: sa }), "p").branding.brandColor === PURPLE, "platform changed");
  });
  await check("audit: who changed which branding field and when — never image data", async () => {
    const t = await tokFor(B.id);
    const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    ok(await api("/api/settings/company", { method: "PATCH", token: t, body: { accentColor: "#60a5fa", logoDataUrl: tiny } }), "change");
    const e = ok(await api("/api/reports/audit-log", { token: t }), "audit").entries.find((x) => x.action === "Company settings updated");
    assert(e && /accentColor: .* → #60a5fa/.test(e.details) && /logo uploaded/.test(e.details) && e.at && (e.actor_name || e.actorName), e && JSON.stringify(e).slice(0, 300));
    assert(!JSON.stringify(e).includes("base64"), "image data in the audit log");
    const rows = ok(await api("/api/platform/overview", { token: sa }), "ov").recentActivity.filter((x) => x.action === "Platform branding updated");
    assert(rows.length && !JSON.stringify(rows).includes("base64") && rows[0].actorName, "platform change not audited");
    ok(await api("/api/settings/company", { method: "PATCH", token: t, body: { logoDataUrl: null } }), "logo off");
  });
  await check("PDF documents still build after branding changes", async () => {
    const t = await tokFor(B.id);
    const tpls = ok(await api("/api/pdf-templates?kind=global", { token: t }), "tpl").templates;
    const r = await api(`/api/pdf-templates/${tpls[0].id}/preview.pdf`, { token: t, raw: true });
    assert(r.status === 200 && r.buf.slice(0, 4).toString() === "%PDF", `pdf ${r.status}`);
  });

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  // Every value --c-navy takes on <html>, with the address it was on —
  // recorded from the very first paint, so even a momentary flash shows up.
  const RECORDER = () => {
    window.__navyLog = [];
    const rec = () => { try { const v = document.documentElement.style.getPropertyValue("--c-navy").trim().toLowerCase(); const last = window.__navyLog[window.__navyLog.length - 1]; if (!last || last.v !== v) window.__navyLog.push({ v, path: location.pathname, t: Date.now() }); } catch (e) { /* ignore */ } };
    const start = () => {
      if (!document.documentElement) return setTimeout(start, 0);
      new MutationObserver(rec).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
      rec();
    };
    start();
  };
  const navy = (p) => p.evaluate(() => document.documentElement.style.getPropertyValue("--c-navy").trim().toLowerCase());
  const log = (p) => p.evaluate(() => (window.__navyLog || []).map((x) => x.v));
  const newPage = async (ctx) => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); await p.addInitScript(RECORDER); return p; };
  const signIn = async (p, u, pw) => {
    await p.getByPlaceholder("Username").fill(u); await p.getByPlaceholder("Password").fill(pw);
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.waitForFunction(() => !document.querySelector('input[placeholder="Password"]'), null, { timeout: 15000 });
    await p.waitForTimeout(1200);
  };
  const signOut = async (p) => {
    await p.evaluate(() => { try { localStorage.removeItem("geeska_token"); localStorage.removeItem("geeska_user"); } catch (e) {} });
    await p.reload(); await p.waitForTimeout(1500);
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const p = await newPage(ctx);

    await check("anonymous: /red shows only red, /blue only blue, the main page the platform's purple", async () => {
      await p.goto(BASE + "/red"); await p.waitForTimeout(1500);
      assert((await navy(p)) === RED, `red page navy ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === BLUE || v === PURPLE), `other brand on /red: ${(await log(p)).join(",")}`);
      await p.goto(BASE + "/blue"); await p.waitForTimeout(1500);
      assert((await navy(p)) === BLUE, `blue page navy ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === RED || v === PURPLE), `other brand on /blue: ${(await log(p)).join(",")}`);
      await p.goto(BASE + "/"); await p.waitForTimeout(1500);
      assert((await navy(p)) === PURPLE, `main page navy ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === RED || v === BLUE), `company brand on the main page: ${(await log(p)).join(",")}`);
      assert((await p.locator("[data-login-title]").textContent()).includes("Purple Platform"), "platform name not on the main sign-in page");
    });
    await check("sign in on /red → red workspace; sign out → red sign-in page, never blue", async () => {
      await p.goto(BASE + "/red"); await p.waitForTimeout(1200);
      await signIn(p, "faadumo.warsame", PW);
      assert((await navy(p)) === RED, `workspace navy ${await navy(p)}`);
      await signOut(p);
      assert((await navy(p)) === RED, `after sign-out ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === BLUE || v === PURPLE), `other brand: ${(await log(p)).join(",")}`);
    });
    await check("sign in on the main page as Blue → blue; sign out → the platform's purple", async () => {
      await p.goto(BASE + "/"); await p.waitForTimeout(1200);
      await signIn(p, "blue.admin", "Blue-Admin-Pass-2026");
      await p.waitForTimeout(800);
      assert((await navy(p)) === BLUE, `workspace navy ${await navy(p)}`);
      assert(!(await log(p)).includes(RED), `red appeared: ${(await log(p)).join(",")}`);
      await signOut(p);
      assert((await navy(p)) === PURPLE, `after sign-out ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === RED || v === BLUE), `company brand after sign-out: ${(await log(p)).join(",")}`);
    });
    await check("Blue's session opening /red: Red's sign-in page, Blue's workspace never shown", async () => {
      await p.goto(BASE + "/"); await p.waitForTimeout(1000);
      await signIn(p, "blue.admin", "Blue-Admin-Pass-2026");
      await p.goto(BASE + "/red"); await p.waitForTimeout(2000);
      assert(await p.getByPlaceholder("Password").count() === 1, "workspace shown on /red");
      assert((await navy(p)) === RED, `navy ${await navy(p)}`);
      assert(!(await log(p)).some((v) => v === BLUE || v === PURPLE), `other brand on /red: ${(await log(p)).join(",")}`);
      assert(!(await p.evaluate(() => localStorage.getItem("geeska_token"))), "Blue session kept");
    });
    await check("delayed branding: a slow neutral/public reply arriving after sign-in never wins", async () => {
      const p2 = await newPage(ctx);
      await p2.route("**/api/settings/company", async (route) => {
        const auth = route.request().headers()["authorization"];
        if (!auth && route.request().method() === "GET") await sleep(3500); // the public reply comes back LAST
        await route.continue();
      });
      await p2.goto(BASE + "/"); await p2.waitForTimeout(300);
      await signIn(p2, "blue.admin", "Blue-Admin-Pass-2026");
      await p2.waitForTimeout(4500);
      assert((await navy(p2)) === BLUE, `navy after the stale reply ${await navy(p2)}`);
      await signOut(p2); await p2.close();
    });
    await check("delayed branding: a slow reply for the previous company after a session change never wins", async () => {
      const p3 = await newPage(ctx);
      await p3.goto(BASE + "/"); await p3.waitForTimeout(800);
      await signIn(p3, "faadumo.warsame", PW);
      assert((await navy(p3)) === RED, "red first");
      // Red's own branding reply is now slow; the session changes to Blue meanwhile.
      await p3.route("**/api/settings/company", async (route) => { if (route.request().method() === "GET") await sleep(3000); await route.continue(); });
      await p3.evaluate(() => window.dispatchEvent(new Event("finman-test-noop")));
      const blueLogin = ok(await api("/api/auth/login", { method: "POST", body: { username: "blue.admin", password: "Blue-Admin-Pass-2026" } }), "bl");
      await p3.evaluate(([t, u]) => { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", u); }, [blueLogin.token, JSON.stringify(blueLogin.user)]);
      await p3.reload(); await p3.waitForTimeout(500);
      const early = await navy(p3);
      assert(early !== RED, "red still shown for Blue's session while its reply was pending");
      await p3.waitForTimeout(4000);
      assert((await navy(p3)) === BLUE, `navy ${await navy(p3)}`);
      assert(!(await log(p3)).includes(RED), `red flashed for Blue: ${(await log(p3)).join(",")}`);
      await signOut(p3); await p3.close();
    });
    await check("delayed branding inside one page: Red's slow reply after Red signs out and Blue signs in is dropped", async () => {
      const p6 = await newPage(ctx);
      await p6.goto(BASE + "/"); await p6.waitForTimeout(1000);
      // Every company-branding reply now takes 2.5 s.
      await p6.route("**/api/settings/company", async (route) => { if (route.request().method() === "GET" && route.request().headers()["authorization"]) await sleep(2500); await route.continue(); });
      await p6.getByPlaceholder("Username").fill("faadumo.warsame"); await p6.getByPlaceholder("Password").fill(PW);
      await p6.getByRole("button", { name: "Sign in" }).click();
      await p6.waitForFunction(() => !document.querySelector('input[placeholder="Password"]'), null, { timeout: 15000 });
      // Sign out through the menu while Red's reply is still on its way…
      await p6.getByRole("button", { name: "Account menu" }).click();
      await p6.getByRole("button", { name: "Sign out" }).click();
      await p6.waitForSelector('input[placeholder="Password"]', { timeout: 10000 });
      // …and sign straight in as Blue, in the same page.
      await p6.getByPlaceholder("Username").fill("blue.admin"); await p6.getByPlaceholder("Password").fill("Blue-Admin-Pass-2026");
      await p6.getByRole("button", { name: "Sign in" }).click();
      await p6.waitForFunction(() => !document.querySelector('input[placeholder="Password"]'), null, { timeout: 15000 });
      await p6.waitForTimeout(6000);
      const seen = await log(p6);
      assert((await navy(p6)) === BLUE, `final navy ${await navy(p6)} (seen ${seen.join(",")})`);
      assert(!seen.includes(RED), `Red's late reply was applied: ${seen.join(",")}`);
      assert(seen.indexOf(BLUE) === seen.length - 1 || seen.slice(seen.indexOf(BLUE)).every((v) => v === BLUE), `brand changed after Blue: ${seen.join(",")}`);
      await signOut(p6); await p6.close();
    });
    await check("Super Admin: console purple → Red workspace red → console purple again → Blue workspace blue", async () => {
      const p4 = await newPage(ctx);
      await p4.goto(BASE + "/"); await p4.waitForTimeout(800);
      await signIn(p4, "super.admin", process.env.SUPER_ADMIN_INITIAL_PASSWORD);
      assert((await navy(p4)) === PURPLE, `console navy ${await navy(p4)}`);
      assert((await p4.locator("[data-platform-name]").textContent()).includes("Purple Platform"), "platform name not in the console");
      const openWs = async (name) => {
        const card = p4.locator("div").filter({ hasText: name }).filter({ has: p4.getByRole("button", { name: "Open workspace" }) }).last();
        await card.getByRole("button", { name: "Open workspace" }).first().click();
        await p4.waitForLoadState("load"); await p4.waitForTimeout(2500);
      };
      await openWs("Red Rock Exchange");
      assert((await navy(p4)) === RED, `red workspace navy ${await navy(p4)}`);
      assert(!(await log(p4)).some((v) => v === BLUE || v === PURPLE), `other brand in Red's workspace: ${(await log(p4)).join(",")}`);
      // back to the console, then Blue
      const swC = ok(await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: null } }), "console");
      await p4.evaluate(([t, u]) => { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", u); }, [swC.token, JSON.stringify(swC.user)]);
      await p4.reload(); await p4.waitForTimeout(1500);
      assert((await navy(p4)) === PURPLE, `console navy again ${await navy(p4)}`);
      assert(!(await log(p4)).some((v) => v === RED || v === BLUE), `company brand in the console: ${(await log(p4)).join(",")}`);
      await openWs("Blue Harbour Exchange");
      assert((await navy(p4)) === BLUE, `blue workspace navy ${await navy(p4)}`);
      assert(!(await log(p4)).some((v) => v === RED || v === PURPLE), `other brand in Blue's workspace: ${(await log(p4)).join(",")}`);
      await signOut(p4); await p4.close();
    });
    await check("theme and language are kept per company (and separately for the Super Admin console)", async () => {
      const p5 = await newPage(ctx);
      await p5.goto(BASE + "/red"); await p5.waitForTimeout(800);
      await signIn(p5, "faadumo.warsame", PW);
      await p5.evaluate(() => { localStorage.setItem("geeska_theme:company:red", "dark"); localStorage.setItem("obo_lang:company:red", "so"); });
      await p5.reload(); await p5.waitForTimeout(1500);
      assert((await p5.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark", "red not dark");
      await signOut(p5);
      await p5.goto(BASE + "/blue"); await p5.waitForTimeout(1200);
      await signIn(p5, "blue.admin", "Blue-Admin-Pass-2026");
      assert((await p5.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light", "Red's dark theme reached Blue");
      assert(await p5.getByText("Dashboard").count() >= 1 || await p5.getByText("Guudmar").count() === 0, "Red's Somali reached Blue");
      await signOut(p5);
      await p5.goto(BASE + "/"); await p5.waitForTimeout(800);
      await signIn(p5, "super.admin", process.env.SUPER_ADMIN_INITIAL_PASSWORD);
      assert((await p5.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light", "a company's theme reached the Super Admin console");
      await signOut(p5); await p5.close();
    });
    await check("an old shared theme choice is adopted by the first company only, never by another", async () => {
      const ctx2 = await browser.newContext(); const p7 = await newPage(ctx2);
      await p7.goto(BASE + "/red"); await p7.evaluate(() => { localStorage.clear(); localStorage.setItem("geeska_theme", "dark"); });
      await p7.reload(); await p7.waitForTimeout(800);
      await signIn(p7, "faadumo.warsame", PW);
      assert((await p7.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark", "red lost the saved theme");
      assert((await p7.evaluate(() => localStorage.getItem("geeska_theme"))) === null, "shared key still present");
      await signOut(p7);
      await p7.goto(BASE + "/blue"); await p7.waitForTimeout(800);
      await signIn(p7, "blue.admin", "Blue-Admin-Pass-2026");
      assert((await p7.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light", "blue inherited red's theme");
      await ctx2.close();
    });
    await check("console: 'Platform branding' changes the platform's look only", async () => {
      const p8 = await newPage(ctx);
      await p8.goto(BASE + "/"); await p8.waitForTimeout(800);
      await signIn(p8, "super.admin", process.env.SUPER_ADMIN_INITIAL_PASSWORD);
      await p8.getByRole("button", { name: "Platform branding" }).click();
      await p8.waitForSelector("[data-platform-branding]");
      await p8.locator("[data-platform-branding]").getByRole("button", { name: "Ocean Blue" }).click();
      await p8.locator("[data-platform-branding]").getByRole("button", { name: "Save" }).click();
      await p8.waitForTimeout(1500);
      assert((await navy(p8)) === "#075985", `console navy ${await navy(p8)}`);
      assert(ok(await api("/api/settings/company", { token: await tokFor(A.id) }), "a").company.brandColor === RED, "Red changed");
      assert(ok(await api("/api/settings/company", { token: await tokFor(B.id) }), "b").company.brandColor === BLUE, "Blue changed");
      ok(await api("/api/platform/branding", { method: "PATCH", token: sa, body: { brandColor: PURPLE, primaryDark: null, primaryLight: null, brandThemeKey: "custom" } }), "restore");
      await signOut(p8); await p8.close();
    });
    await check("persistence: a company's branding is the same after a refresh and on another device", async () => {
      for (let i = 0; i < 2; i++) {
        const dev = await browser.newContext(); const pd = await newPage(dev);
        await pd.goto(BASE + "/blue"); await pd.waitForTimeout(800);
        await signIn(pd, "blue.admin", "Blue-Admin-Pass-2026");
        assert((await navy(pd)) === BLUE, `device ${i + 1} navy ${await navy(pd)}`);
        await pd.reload(); await pd.waitForTimeout(1500);
        assert((await navy(pd)) === BLUE, `after refresh ${await navy(pd)}`);
        await dev.close();
      }
    });
    await check("missing or invalid stored branding → default theme, page still usable", async () => {
      const db = openScope(TESTDB.env, { companyId: B.id });
      try { db.prepare("UPDATE company_settings SET brand_color = ?, accent_color = ?, secondary_color = ? WHERE id = 1").run("not-a-colour", "#12", ""); } finally { db.close(); }
      const dev = await browser.newContext(); const pd = await newPage(dev);
      await pd.goto(BASE + "/blue"); await pd.waitForTimeout(1200);
      assert((await navy(pd)) === "", `invalid colour applied: ${await navy(pd)}`);
      await signIn(pd, "blue.admin", "Blue-Admin-Pass-2026");
      assert((await navy(pd)) === "" && (await pd.evaluate(() => document.documentElement.style.getPropertyValue("--c-cyan"))) === "", "invalid colours applied in the workspace");
      assert(await pd.getByRole("button", { name: "Account menu" }).count() === 1, "workspace not usable");
      await dev.close();
      ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(B.id), body: { brandColor: BLUE, accentColor: null, secondaryColor: null } }), "restore");
    });
    await check("readability: a very light brand keeps white text readable on the sign-in page; dark text on brand buttons", async () => {
      const LIGHT = "#f1f5f9";
      ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(B.id), body: { brandColor: LIGHT } }), "light");
      const dev = await browser.newContext(); const pd = await newPage(dev);
      await pd.goto(BASE + "/blue"); await pd.waitForTimeout(1500);
      const r = await pd.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const lum = (hex) => { const n = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; const v = parseInt(hex.slice(1), 16); return 0.2126 * n((v >> 16) & 255) + 0.7152 * n((v >> 8) & 255) + 0.0722 * n(v & 255); };
        const hero = cs.getPropertyValue("--c-hero").trim();
        return { hero, heroLum: hero ? lum(hero) : null, onPrimary: cs.getPropertyValue("--c-text-on-primary").trim(), navy: document.documentElement.style.getPropertyValue("--c-navy").trim() };
      });
      assert(r.navy === LIGHT, `brand not applied ${r.navy}`);
      assert(r.hero && r.heroLum <= 0.18, `hero not darkened: ${JSON.stringify(r)}`);
      assert(1.05 / (r.heroLum + 0.05) >= 4.5, `white text contrast too low on ${r.hero}`);
      assert(r.onPrimary === "#0d2436", `text on the light brand is ${r.onPrimary}`);
      await signIn(pd, "blue.admin", "Blue-Admin-Pass-2026");
      assert(await pd.getByRole("button", { name: "Account menu" }).count() === 1, "sign-in failed on the light brand");
      await dev.close();
      ok(await api("/api/settings/company", { method: "PATCH", token: await tokFor(B.id), body: { brandColor: BLUE } }), "restore");
    });
    await check("no page errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
    await ctx.close();
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
