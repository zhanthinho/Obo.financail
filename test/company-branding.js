"use strict";
// COMPANY BRANDING FIX — regression tests.
// On a throw-away installation with three companies (Company 1 with a red
// logo and its own brand colour, Company 2 with NO logo, Company 3 with a
// blue logo) proves that each workspace shows only its own name, logo and
// colours — when switching back and forth, after a refresh, when a slow
// reply from the login screen arrives late, in the Super Admin console and
// in exported documents — and that Company 1's branding is never used as a
// fallback for a company that has none.
//
// Run with: npm run test:company-branding
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".branding-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("company-branding");
const PORT = Number(process.env.BRANDING_TEST_PORT || 4360);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const C2_ADMIN = { name: "Hodan Berbera", username: "hodan.berbera", password: "Berbera-Admin-Pass-31" };
const C1_BRAND = "#b91c1c";

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
  return { status: res.status, json, res };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
// A tiny solid-colour PNG as a data: URL — red for Company 1, blue for Company 3.
function pngDataUrl(r, g, b, n = 24) {
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(n).fill([r, g, b]).flat())]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(n).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
  return "data:image/png;base64," + png.toString("base64");
}
const RED = pngDataUrl(220, 30, 30), BLUE = pngDataUrl(30, 60, 220);

let sa, C1, C2 = "", C3 = "", c1Name;
const workspaceToken = async (cid) => (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: cid } })).json.token;
const branding = async (token) => (await api("/api/settings/company", { token })).json.company;

async function setup() {
  sa = (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: SA_PW } })).json.token;
  const list = (await api("/api/platform/companies", { token: sa })).json.companies;
  C1 = list[0].id; c1Name = "Hargeysa First Co"; // a distinctive name, so a leak is visible
  await api(`/api/platform/companies/${C1}`, { method: "PATCH", token: sa, body: { name: c1Name, logoDataUrl: RED } });
  const c1ws = await workspaceToken(C1);
  const r = await api("/api/settings/company", { method: "PATCH", token: c1ws, body: { brandColor: C1_BRAND } });
  assert(r.status === 200, `could not set Company 1 brand colour: ${r.status} ${JSON.stringify(r.json)}`);
  const c2 = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Berbera Second Co", address: "Berbera Port", admin: C2_ADMIN } });
  assert(c2.status === 201, `create Company 2: ${c2.status} ${JSON.stringify(c2.json)}`);
  C2 = c2.json.company.id;
  const c3 = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Burao Third Co", logoDataUrl: BLUE, tagline: "Burao tagline" } });
  assert(c3.status === 201, `create Company 3: ${c3.status}`);
  C3 = c3.json.company.id;
}

async function apiChecks() {
  console.log("\nBranding API");
  await check("each workspace token gets ONLY its own company's branding", async () => {
    const b1 = await branding(await workspaceToken(C1));
    const b2 = await branding(await workspaceToken(C2));
    const b3 = await branding(await workspaceToken(C3));
    assert(b1.companyId === C1 && b1.logoDataUrl === RED && b1.brandColor === C1_BRAND, `Company 1: ${b1.companyId} ${b1.brandColor}`);
    assert(b2.companyId === C2 && b2.name === "Berbera Second Co", `Company 2: ${b2.companyId} ${b2.name}`);
    assert(b3.companyId === C3 && b3.logoDataUrl === BLUE && b3.tagline === "Burao tagline", `Company 3: ${b3.companyId}`);
  });
  await check("a company without a logo or colours gets the defaults — never Company 1's", async () => {
    const b2 = await branding(await workspaceToken(C2));
    assert(b2.logoDataUrl === null, "Company 2 has a logo it never uploaded");
    assert(b2.brandColor === null, `Company 2 inherited brand colour ${b2.brandColor}`);
    assert(b2.tagline !== (await branding(await workspaceToken(C1))).tagline || b2.tagline === "", "Company 2 shows Company 1's tagline");
  });
  await check("a Company Admin of Company 2 gets Company 2's branding", async () => {
    const t = (await api("/api/auth/login", { method: "POST", body: { username: C2_ADMIN.username, password: C2_ADMIN.password } })).json.token;
    const b = await branding(t);
    assert(b.name === "Berbera Second Co" && b.logoDataUrl === null && b.brandColor === null, JSON.stringify({ name: b.name, logo: !!b.logoDataUrl, brand: b.brandColor }));
  });
  await check("the Super Admin console (no company open) gets neutral default branding", async () => {
    const b = await branding(sa);
    assert(!b.companyId && b.logoDataUrl === null && b.brandColor === null && b.name !== c1Name, JSON.stringify({ id: b.companyId, name: b.name, logo: !!b.logoDataUrl, brand: b.brandColor }));
  });
  await check("the shared login page shows the neutral platform identity — not Company 1's", async () => {
    const b = await branding(null);
    assert(b.isDefault && b.name !== c1Name && b.logoDataUrl === null && b.brandColor === null, JSON.stringify({ name: b.name }));
  });
  await check("Company 2's documents carry Company 2's name, never Company 1's", async () => {
    const res = (await api("/api/accounts/export.csv", { token: await workspaceToken(C2) })).res;
    assert(res.status === 200, `csv ${res.status}`);
    const pdf = await fetch(`${BASE}/api/accounts/export.pdf`, { headers: { Authorization: `Bearer ${await workspaceToken(C2)}` } });
    const buf = Buffer.from(await pdf.arrayBuffer());
    assert(pdf.status === 200 && buf.slice(0, 4).toString() === "%PDF", `pdf ${pdf.status}`);
    const text = execPdfText(buf);
    if (text !== null) {
      assert(text.includes("Berbera Second Co"), "Company 2's name missing from its PDF header");
      assert(!text.includes(c1Name), "Company 1's name appears in Company 2's PDF");
    }
  });
}
// pdftotext when available (CI images usually have it); otherwise skip the text part.
function execPdfText(buf) {
  try { const f = path.join(TMP, "probe.pdf"); fs.writeFileSync(f, buf); return execFileSync("pdftotext", [f, "-"], { encoding: "utf8" }); } catch (e) { return null; }
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(`(browser part skipped — ${e.message.split("\n")[0]})`); return; }
  console.log("\nBrowser");
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.accept());
    // What the screen shows: sidebar name, header switcher name, colour of
    // every visible logo, and the applied brand colour variable.
    const look = () => p.evaluate(() => {
      const logos = [...document.querySelectorAll(".gk-brand-logo-wrap img, .gk-company-switcher img, button img")].filter((i) => i.offsetParent).map((i) => {
        const c = document.createElement("canvas"); c.width = c.height = 1;
        try { const x = c.getContext("2d"); x.drawImage(i, 0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return d[0] > 150 && d[2] < 100 ? "red" : d[2] > 150 && d[0] < 100 ? "blue" : "other"; } catch (e) { return "?"; }
      });
      return {
        sidebar: (document.querySelector(".gk-brand-name") || {}).innerText || null,
        switcher: (document.querySelector(".gk-company-badge-name") || {}).innerText || null,
        logos, brand: document.documentElement.style.getPropertyValue("--c-navy").trim(),
      };
    });
    const settle = () => p.waitForTimeout(1300);
    const expectCompany = async (label, name, logo, brand) => {
      const s = await look();
      assert(s.sidebar === name && s.switcher === name, `${label}: sidebar "${s.sidebar}", switcher "${s.switcher}"`);
      if (logo) assert(s.logos.length && s.logos.every((x) => x === logo), `${label}: logos ${JSON.stringify(s.logos)}`);
      else assert(!s.logos.includes("red") && !s.logos.includes("blue"), `${label}: shows a logo it does not have ${JSON.stringify(s.logos)}`);
      assert(brand ? s.brand.toLowerCase() === brand : s.brand === "", `${label}: brand colour "${s.brand}"`);
    };
    const switchTo = async (name) => {
      await p.locator(".gk-company-badge-name").first().click(); await p.waitForTimeout(300);
      await p.locator("button", { hasText: name }).last().click();
      await p.waitForSelector(".gk-sidebar", { state: "attached" }); await settle();
    };

    // 1. A slow reply from the login screen must not overwrite Company 2's branding.
    await p.route("**/api/settings/company", async (route) => {
      if (!route.request().headers()["authorization"]) await new Promise((r) => setTimeout(r, 1500));
      route.continue();
    });
    await p.goto(BASE); await p.waitForTimeout(200);
    await p.locator("input").first().fill(C2_ADMIN.username); await p.fill('input[type="password"]', C2_ADMIN.password);
    await p.keyboard.press("Enter"); await p.waitForSelector(".gk-sidebar", { state: "attached" });
    await check("a late reply from the login screen cannot put Company 1's branding on Company 2", async () => {
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 2800) { const s = await look(); seen.add(`${s.sidebar}|${s.switcher}|${s.logos.join(",")}|${s.brand}`); await p.waitForTimeout(100); }
      for (const s of seen) assert(!s.includes(c1Name), `saw Company 1 branding: ${s}`);
      for (const s of seen) assert(!s.includes("red") && !s.toLowerCase().includes(C1_BRAND), `saw Company 1's logo/colour: ${s}`);
      await expectCompany("Company 2 after sign-in", "Berbera Second Co", null, null);
    });
    await p.unroute("**/api/settings/company");
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/token|user/i.test(k)) localStorage.removeItem(k); });

    // 2. Super Admin: console, open Company 1, then switch around several times.
    await p.goto(BASE); await p.waitForTimeout(600);
    await p.locator("input").first().fill("super.admin"); await p.fill('input[type="password"]', SA_PW);
    await p.keyboard.press("Enter"); await p.waitForTimeout(1800);
    await check("the Super Admin console does not wear Company 1's brand colour", async () => {
      const s = await look();
      assert(s.brand === "", `console brand colour "${s.brand}"`);
    });
    const openBtn = p.locator("div").filter({ hasText: c1Name }).filter({ has: p.locator("button", { hasText: /Open workspace|Fur/ }) }).last().locator("button", { hasText: /Open workspace|Fur/ }).first();
    await openBtn.click(); await p.waitForSelector(".gk-sidebar", { state: "attached" }); await settle();
    await check("1. Company 1 shows its own name, red logo and brand colour", async () => expectCompany("Company 1", c1Name, "red", C1_BRAND));
    for (let round = 1; round <= 3; round++) {
      await switchTo("Berbera Second Co");
      await check(`round ${round}: Company 2 shows its own name, no logo, default colours`, async () => expectCompany("Company 2", "Berbera Second Co", null, null));
      await switchTo("Burao Third Co");
      await check(`round ${round}: Company 3 shows its own name and blue logo`, async () => expectCompany("Company 3", "Burao Third Co", "blue", null));
      await switchTo(c1Name);
      await check(`round ${round}: back to Company 1 — its branding returns`, async () => expectCompany("Company 1", c1Name, "red", C1_BRAND));
    }
    await switchTo("Berbera Second Co");
    await check("Company 2's branding stays correct across its modules", async () => {
      const navs = p.locator(".gk-sidebar-nav .gk-nav-btn");
      const n = Math.min(await navs.count(), 6);
      for (let i = 0; i < n; i++) {
        await navs.nth(i).dispatchEvent("click"); await p.waitForTimeout(500);
        await expectCompany(`module ${i}`, "Berbera Second Co", null, null);
      }
    });
    await check("a refresh keeps Company 2's branding", async () => {
      await p.reload(); await p.waitForSelector(".gk-sidebar", { state: "attached" }); await settle();
      await expectCompany("Company 2 after refresh", "Berbera Second Co", null, null);
    });
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
