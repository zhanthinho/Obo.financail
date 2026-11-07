"use strict";
// COMPANY STAMP round — the company stamp / seal: uploaded in Settings →
// General (real PNG / JPEG only), printed beside the signature on PDFs when
// the template's "Show company stamp" is on, and the PDF Live preview is no
// longer blocked by the Content-Security-Policy (blob: frames allowed).
// On a throw-away database. Run with: npm run test:company-stamp
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { pdfText } = require("./helpers/pdf-text");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("companystamp");
const PORT = Number(process.env.COMPANY_STAMP_TEST_PORT || 4696);
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
const zlib = require("zlib");
function pngDataUrl(r, g, b, n = 40) {
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(n).fill([r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(n).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const STAMP_BYTES = pngDataUrl(30, 60, 200);
const STAMP = "data:image/png;base64," + STAMP_BYTES.toString("base64");
// Images embedded in a PDF (pdf-lib keeps them in compressed object streams, so read it properly).
let imageCount = async (buf) => {
  const { PDFDocument, PDFName, PDFRawStream } = require(path.join(ROOT, "node_modules", "pdf-lib"));
  const doc = await PDFDocument.load(buf);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) n++;
  }
  return n;
};

let srv;
async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.CS_DEBUG ? "inherit" : "ignore"] });
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
  const sw = await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } });
  const A = sw.json.token;
  const company = ok(await api("/api/settings/company", { token: A }), "settings").company;

  await check("the PDF Live preview is allowed to show (frame-src / object-src include blob:)", async () => {
    const r = await fetch(BASE + "/");
    const csp = r.headers.get("content-security-policy") || "";
    assert(/frame-src 'self' blob:/.test(csp) && /object-src 'self' blob:/.test(csp), csp);
    assert(/frame-ancestors 'none'/.test(csp), "the app itself must still not be framed");
  });
  await check("stamp upload: a fake image is refused, a real PNG is stored and audited", async () => {
    const fake = "data:image/png;base64," + Buffer.from("not an image at all").toString("base64");
    assert((await api("/api/settings/company", { method: "PATCH", token: A, body: { name: company.name, stampDataUrl: fake } })).status === 400, "fake accepted");
    const r = ok(await api("/api/settings/company", { method: "PATCH", token: A, body: { name: company.name, stampDataUrl: STAMP } }), "upload");
    assert(r.company.stampDataUrl === STAMP, "not returned");
    assert((ok(await api("/api/settings/company", { token: A }), "get").company.stampDataUrl) === STAMP, "not stored");
    assert(ok(await api("/api/reports/audit-log", { token: A }), "audit").entries.some((e) => e.action === "Company stamp uploaded"), "not audited");
  });
  let tpl;
  await check("PDF templates (account statement): 'Show company stamp' option, on by default; the stamp is printed only when on", async () => {
    tpl = ok(await api("/api/pdf-templates", { method: "POST", token: A, body: { kind: "account", name: "Stamp test statement" } }), "create").template;
    assert(tpl && tpl.showStamp === true, `showStamp ${tpl && tpl.showStamp}`);
    const on = await api(`/api/pdf-templates/${tpl.id}/preview.pdf`, { token: A, raw: true });
    assert(on.status === 200, `preview ${on.status}`);
    if (process.env.CS_SHOTS) require("fs").writeFileSync(require("path").join(process.env.CS_SHOTS, "stamp-statement.pdf"), on.buf);
    ok(await api(`/api/pdf-templates/${tpl.id}`, { method: "PATCH", token: A, body: { showStamp: false } }), "off");
    const off = await api(`/api/pdf-templates/${tpl.id}/preview.pdf`, { token: A, raw: true });
    const ni = await imageCount(on.buf), nf = await imageCount(off.buf);
    assert(ni === nf + 1, `images on ${ni} / off ${nf}`);
    ok(await api(`/api/pdf-templates/${tpl.id}`, { method: "PATCH", token: A, body: { showStamp: true } }), "on again");
  });
  await check("Excel templates: 'Show company stamp' option, on by default; the stamp is in the .xlsx only when on", async () => {
    const ExcelJS = require("exceljs");
    const look = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const ws = wb.worksheets[0]; let txt = false; ws.eachRow((row) => row.eachCell((c) => { if (c.value === "Company stamp") txt = true; })); return { images: ws.getImages().length, txt }; };
    const xt = ok(await api("/api/excel-templates", { method: "POST", token: A, body: { kind: "account", name: "Stamp test sheet" } }), "create xl").template;
    assert(xt && xt.showStamp === true, `showStamp ${xt && xt.showStamp}`);
    const on = await api(`/api/excel-templates/${xt.id}/preview.xlsx`, { token: A, raw: true });
    assert(on.status === 200, `preview ${on.status}`);
    ok(await api(`/api/excel-templates/${xt.id}`, { method: "PATCH", token: A, body: { showStamp: false } }), "xl off");
    const off = await api(`/api/excel-templates/${xt.id}/preview.xlsx`, { token: A, raw: true });
    const a = await look(on.buf), b = await look(off.buf);
    assert(a.txt && !b.txt && a.images === b.images + 1, `on ${JSON.stringify(a)} / off ${JSON.stringify(b)}`);
  });
  await check("removing the stamp leaves documents without it (and is audited)", async () => {
    ok(await api("/api/settings/company", { method: "PATCH", token: A, body: { name: company.name, stampDataUrl: null } }), "remove");
    const r = await api(`/api/pdf-templates/${tpl.id}/preview.pdf`, { token: A, raw: true });
    const off = await imageCount(r.buf);
    ok(await api("/api/settings/company", { method: "PATCH", token: A, body: { name: company.name, stampDataUrl: STAMP } }), "re-upload");
    const r2 = await api(`/api/pdf-templates/${tpl.id}/preview.pdf`, { token: A, raw: true });
    const n2 = await imageCount(r2.buf);
    assert(n2 === off + 1, `${n2} vs ${off}`);
    const acts = ok(await api("/api/reports/audit-log", { token: A }), "audit").entries.map((e) => e.action);
    assert(acts.includes("Company stamp removed"), "removal not audited");
  });

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  const browser = await chromium.launch();
  const errors = [], csp = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const open = async (view) => {
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => { if (/Content Security Policy|Refused to frame/i.test(m.text())) csp.push(m.text()); });
      await p.addInitScript(([t, u, v]) => { try { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", u); sessionStorage.setItem("obo_view", v); } catch (e) { /* ignore */ }
        document.addEventListener("securitypolicyviolation", (e) => console.log("Content Security Policy violation: " + e.violatedDirective + " " + e.blockedURI)); }, [sw.json.token, JSON.stringify(sw.json.user), view]);
      await p.goto(BASE); await p.waitForTimeout(1500);
      return p;
    };
    const p = await open("settings-general");
    await check("Settings → General has a 'Company stamp' upload; a new stamp is saved", async () => {
      await p.getByText("Company stamp", { exact: true }).first().waitFor({ timeout: 8000 });
      assert(await p.locator("[data-stamp-preview] img").count() === 1, "current stamp not shown");
      await p.getByRole("button", { name: "Remove stamp" }).click();
      const tmp = require("path").join(require("os").tmpdir(), "finman-stamp.png");
      require("fs").writeFileSync(tmp, pngDataUrl(200, 30, 30));
      await p.locator('input[type="file"][aria-labelledby="company-stamp-label"]').setInputFiles(tmp);
      await p.waitForTimeout(400);
      assert(await p.locator("[data-stamp-preview] img").count() === 1, "preview after upload");
      await p.getByRole("button", { name: /^Save/ }).first().click(); await p.waitForTimeout(1200);
      const now = ok(await api("/api/settings/company", { token: A }), "get").company.stampDataUrl;
      assert(now && now !== STAMP && /^data:image\/png;base64,/.test(now), "new stamp not saved");
      if (process.env.CS_SHOTS) await p.screenshot({ path: require("path").join(process.env.CS_SHOTS, "stamp-settings.png"), fullPage: true });
    });
    const t = await open("settings-pdf-templates");
    await check("PDF template editor: the Live preview loads (not blocked) and Signatures has the stamp option", async () => {
      await t.getByRole("button", { name: "Customize" }).first().click({ timeout: 8000 });
      await t.waitForTimeout(2500);
      assert(await t.locator('iframe[title="PDF preview"]').count() === 1, "no preview frame");
      assert(/^blob:/.test(await t.locator('iframe[title="PDF preview"]').getAttribute("src")), "preview is not a blob URL");
      await t.getByRole("button", { name: "Signatures", exact: true }).click(); await t.waitForTimeout(300);
      assert(await t.getByText("Show company stamp beside the signature").count() === 1, "stamp option missing");
      assert(!csp.length, csp.join(" | "));
      if (process.env.CS_SHOTS) await t.screenshot({ path: require("path").join(process.env.CS_SHOTS, "stamp-template.png") });
    });
    await check("no page errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
