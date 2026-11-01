"use strict";
// PDF & EXCEL TEMPLATES round — end-to-end tests on a throw-away database.
// Proves that what an administrator saves in Settings > PDF Templates /
// Excel Templates is stored, comes back on reload, and is what the REAL
// document exports use:
//   * create / save / reload / version, presets;
//   * account statement PDF + Excel follow the saved default template,
//     other document types follow their own default (or the Global one);
//   * a template that is not the default changes nothing until it is set
//     as default; switching default switches the output;
//   * Cash Account statements can have their own template (new kind), and
//     the database upgrade that allows it widens the old CHECK safely;
//   * table border colour and header note reach the documents;
//   * invalid settings / unknown fields / bad kinds are refused and nothing
//     is stored; missing optional settings fall back to defaults;
//   * company admins cannot manage templates, anonymous users cannot reach
//     them, and one company never sees or uses another company's template;
//   * amounts in the exported files are identical before and after.
// Run with: npm run test:templates
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const ExcelJS = require("exceljs");
const { PDFDocument } = require("pdf-lib");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("templates");
const PORT = Number(process.env.TEMPLATES_TEST_PORT || 4520);
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET, BACKUP_ENABLED: "0" };
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
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
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* binary */ }
  return { status: r.status, json, buf };
}

// Text drawn by pdf-lib is stored as hex strings inside Flate streams.
function pdfText(buf) {
  const s = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    let data = Buffer.from(s.slice(start, end), "latin1");
    try { data = zlib.inflateSync(data); } catch (e) { /* not compressed */ }
    const txt = data.toString("latin1");
    for (const h of txt.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) out += Buffer.from(h[1].replace(/\s+/g, ""), "hex").toString("latin1") + "\n";
    for (const h of txt.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out += h[1] + "\n";
    re.lastIndex = end;
  }
  return out;
}
async function pdfPage(buf) { const d = await PDFDocument.load(buf); const { width, height } = d.getPage(0).getSize(); return { width, height }; }
async function xlsxCells(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const text = [], numbers = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => {
    const v = c.value && typeof c.value === "object" && "result" in c.value ? c.value.result : c.value;
    if (typeof v === "number") numbers.push(v); else if (v != null) text.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  })));
  const ws = wb.worksheets[0];
  return { text: text.join("\n"), numbers, sheetName: ws.name, headerFooter: JSON.stringify(ws.headerFooter || {}) };
}

async function main() {
  console.log("Seeding a throw-away company (CMP-0001)...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try {
    const t0 = Date.now();
    for (;;) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch (e) { /* not yet */ } if (Date.now() - t0 > 20000) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    await run();
    await browserPart().catch((e) => { failures.push(`browser: ${e.message}`); console.log(`  browser part FAILED: ${e.message}`); });
  } finally { srv.kill(); }
  const leaked = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (leaked.length) failures.push("server logged errors:\n      " + leaked.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}

const ctx = {};
async function run() {
  const sa = (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: SA_PW } })).json.token;
  ctx.saA = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: "CMP-0001" } })).json.token;
  ctx.adm = (await api("/api/auth/login", { method: "POST", body: { username: "amina.yusuf", password: DEMO_PW } })).json.token;
  assert(ctx.saA && ctx.adm, "logins failed");
  const acc = (await api("/api/accounts?currency=USD", { token: ctx.adm })).json.accounts[0];
  ctx.acctPdf = `/api/accounts/${acc.id}/statement.pdf`;
  ctx.acctXlsx = `/api/accounts/${acc.id}/statement.xlsx`;
  const ex = (await api("/api/transactions?limit=1", { token: ctx.adm })).json;
  ctx.exchPdf = `/api/transactions/${(ex.transactions || ex.rows || [])[0].id}/receipt.pdf`;

  const T = ctx.saA;
  const before = {
    acctPdf: pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf),
    acctXlsx: await xlsxCells((await api(ctx.acctXlsx, { token: ctx.adm })).buf),
    balance: (await api(`/api/accounts/${acc.id}`, { token: ctx.adm })).json,
  };

  console.log("\nCreate, save, reload");
  await check("kinds include Cash Account Statement for PDF and Excel", async () => {
    for (const k of ["pdf", "excel"]) {
      const r = await api(`/api/${k}-templates/kinds`, { token: T });
      assert(r.status === 200 && r.json.kinds.some((x) => x.key === "cash_account"), `${k}: ${JSON.stringify(r.json)}`);
    }
  });
  await check("a PDF template is created from a preset, and the preset's table border colour is kept", async () => {
    const r = await api("/api/pdf-templates", { method: "POST", token: T, body: { kind: "account", name: "Statement A", presetKey: "premium_business" } });
    assert(r.status === 201, `create ${r.status} ${JSON.stringify(r.json)}`);
    ctx.pA = r.json.template;
    assert(ctx.pA.colorTableBorder === "#c9a227", `preset border colour lost: ${ctx.pA.colorTableBorder}`);
    assert(ctx.pA.isDefault === false && ctx.pA.version === 1, "new template should be v1, not default");
  });
  await check("saving the whole editor form persists every change and bumps the version", async () => {
    const g = (await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template;
    const body = { ...g, footerCustomText: "TPL-ACCT-FOOTER {{company_name}}", headerNote: "TPL-HEADER-NOTE", colorTableBorder: "#123456", paperSize: "Letter", orientation: "landscape", colorPrimary: "#0b3d91" };
    const r = await api(`/api/pdf-templates/${ctx.pA.id}`, { method: "PATCH", token: T, body });
    assert(r.status === 200, `patch ${r.status} ${JSON.stringify(r.json)}`);
    const again = (await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template; // = reopening / refreshing the page
    for (const k of ["footerCustomText", "headerNote", "colorTableBorder", "paperSize", "orientation", "colorPrimary"]) assert(again[k] === body[k], `${k}: ${again[k]} vs ${body[k]}`);
    assert(again.version === 2, `version ${again.version}`);
    const list = (await api("/api/pdf-templates?kind=account", { token: T })).json.templates;
    assert(list.some((t) => t.id === ctx.pA.id && t.footerCustomText === body.footerCustomText), "list does not show the saved values");
  });
  await check("the preview of a template is rendered from its saved settings", async () => {
    const r = await api(`/api/pdf-templates/${ctx.pA.id}/preview.pdf`, { token: T });
    assert(r.status === 200, `preview ${r.status}`);
    const txt = pdfText(r.buf);
    assert(/TPL-ACCT-FOOTER/.test(txt) && /TPL-HEADER-NOTE/.test(txt), "preview misses the saved footer / header note");
  });

  console.log("\nOnly the default template is used — and then it really is");
  await check("a template that is not the default does not change real documents", async () => {
    const txt = pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf);
    assert(!/TPL-ACCT-FOOTER/.test(txt), "non-default template leaked into the statement");
  });
  await check("after Set default, the real account statement PDF uses the saved footer, header note, paper size and orientation", async () => {
    const d = await api(`/api/pdf-templates/${ctx.pA.id}/set-default`, { method: "POST", token: T });
    assert(d.status === 200 && d.json.template.isDefault, `set-default ${d.status}`);
    const r = await api(ctx.acctPdf, { token: ctx.adm });
    assert(r.status === 200, `statement ${r.status}`);
    const txt = pdfText(r.buf);
    assert(/TPL-ACCT-FOOTER/.test(txt), "footer not applied");
    assert(!/\{\{company_name\}\}/.test(txt), "placeholder not filled in");
    assert(/TPL-HEADER-NOTE/.test(txt), "header note not applied to the account statement");
    const sz = await pdfPage(r.buf);
    assert(Math.round(sz.width) === 792 && Math.round(sz.height) === 612, `expected Letter landscape, got ${sz.width}x${sz.height}`);
  });
  await check("the table border colour saved in the editor is what the PDF engine uses", async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
    const { resolveStyle } = require("../src/pdf");
    const c = resolveStyle({ color_table_border: "#123456" }, {}).colors.tableBorder;
    assert(Math.abs(c.red - 0x12 / 255) < 1e-6 && Math.abs(c.blue - 0x56 / 255) < 1e-6, JSON.stringify(c));
    const legacy = resolveStyle({ table_border_color: "#c9a227" }, {}).colors.tableBorder;
    assert(Math.abs(legacy.red - 0xc9 / 255) < 1e-6, "older preset rows must still work");
  });
  await check("other document types do not use the Account Statement template", async () => {
    const txt = pdfText((await api(ctx.exchPdf, { token: ctx.adm })).buf);
    assert(!/TPL-ACCT-FOOTER/.test(txt), "exchange receipt used the account template");
  });
  await check("the Global default applies to types without their own template; a type's own default wins over it", async () => {
    const g = (await api("/api/pdf-templates?kind=global", { token: T })).json.templates.find((t) => t.isDefault);
    const r = await api(`/api/pdf-templates/${g.id}`, { method: "PATCH", token: T, body: { footerCustomText: "TPL-GLOBAL-FOOTER" } });
    assert(r.status === 200, `patch global ${r.status}`);
    assert(/TPL-GLOBAL-FOOTER/.test(pdfText((await api(ctx.exchPdf, { token: ctx.adm })).buf)), "exchange receipt ignores the Global default");
    const acct = pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf);
    assert(/TPL-ACCT-FOOTER/.test(acct) && !/TPL-GLOBAL-FOOTER/.test(acct), "account statement should use its own default");
  });
  await check("switching the default to another template switches the output", async () => {
    const b = (await api("/api/pdf-templates", { method: "POST", token: T, body: { kind: "account", name: "Statement B", footerCustomText: "TPL-ACCT-B" } })).json.template;
    await api(`/api/pdf-templates/${b.id}/set-default`, { method: "POST", token: T });
    const txt = pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf);
    assert(/TPL-ACCT-B/.test(txt) && !/TPL-ACCT-FOOTER/.test(txt), "statement did not follow the new default");
    const list = (await api("/api/pdf-templates?kind=account", { token: T })).json.templates;
    assert(list.filter((t) => t.isDefault).length === 1, "more than one default for one kind");
    await api(`/api/pdf-templates/${ctx.pA.id}/set-default`, { method: "POST", token: T });
  });
  await check("a template with no optional settings falls back to the built-in look and still renders", async () => {
    const c = (await api("/api/pdf-templates", { method: "POST", token: T, body: { kind: "transfer", name: "Bare transfer" } })).json.template;
    assert(c.colorPrimary === null && c.footerCustomText === "", "optional fields should be empty");
    const r = await api(`/api/pdf-templates/${c.id}/preview.pdf`, { token: T });
    assert(r.status === 200 && r.buf.slice(0, 4).toString() === "%PDF", `preview ${r.status}`);
  });

  console.log("\nExcel templates");
  await check("an Excel template is created, saved, reloaded and used by the real account statement workbook", async () => {
    const c = await api("/api/excel-templates", { method: "POST", token: T, body: { kind: "account", name: "XL Statement", presetKey: "corporate" } });
    assert(c.status === 201, `create ${c.status} ${JSON.stringify(c.json)}`);
    ctx.xA = c.json.template;
    const g = (await api(`/api/excel-templates/${ctx.xA.id}`, { token: T })).json.template;
    const p = await api(`/api/excel-templates/${ctx.xA.id}`, { method: "PATCH", token: T, body: { ...g, footerCustomText: "XL-ACCT-FOOTER" } });
    assert(p.status === 200, `patch ${p.status} ${JSON.stringify(p.json)}`);
    assert((await api(`/api/excel-templates/${ctx.xA.id}`, { token: T })).json.template.footerCustomText === "XL-ACCT-FOOTER", "not persisted");
    let wb = await xlsxCells((await api(ctx.acctXlsx, { token: ctx.adm })).buf);
    assert(!/XL-ACCT-FOOTER/.test(wb.text + wb.headerFooter), "non-default Excel template leaked");
    await api(`/api/excel-templates/${ctx.xA.id}/set-default`, { method: "POST", token: T });
    wb = await xlsxCells((await api(ctx.acctXlsx, { token: ctx.adm })).buf);
    assert(/XL-ACCT-FOOTER/.test(wb.text + wb.headerFooter), "Excel export ignores the default template");
  });
  await check("the Excel template preview is built from the saved settings", async () => {
    const r = await api(`/api/excel-templates/${ctx.xA.id}/preview.xlsx`, { token: T });
    assert(r.status === 200, `preview ${r.status}`);
    const wb = await xlsxCells(r.buf);
    assert(/XL-ACCT-FOOTER/.test(wb.text + wb.headerFooter), "preview misses the saved footer");
  });

  console.log("\nCash Account statements (new template kind)");
  await check("Cash Account PDF and Excel templates can be created and are used by the real cash statement", async () => {
    const ca = await api("/api/cash/accounts", { method: "POST", token: T, body: { name: "Template Test Till", type: "physical_cash", currency: "USD", openingBalance: 150 } });
    assert(ca.status === 201 || ca.status === 200, `cash account ${ca.status} ${JSON.stringify(ca.json)}`);
    const cashId = (ca.json.account || ca.json).id;
    const p = await api("/api/pdf-templates", { method: "POST", token: T, body: { kind: "cash_account", name: "Cash PDF", footerCustomText: "TPL-CASH-PDF" } });
    const x = await api("/api/excel-templates", { method: "POST", token: T, body: { kind: "cash_account", name: "Cash XL", footerCustomText: "TPL-CASH-XL" } });
    assert(p.status === 201 && x.status === 201, `create ${p.status}/${x.status} ${JSON.stringify(p.json || x.json)}`);
    await api(`/api/pdf-templates/${p.json.template.id}/set-default`, { method: "POST", token: T });
    await api(`/api/excel-templates/${x.json.template.id}/set-default`, { method: "POST", token: T });
    const pdf = await api(`/api/cash/accounts/${cashId}/statement.pdf`, { token: T });
    assert(pdf.status === 200 && /TPL-CASH-PDF/.test(pdfText(pdf.buf)), `cash pdf ${pdf.status}`);
    const xl = await api(`/api/cash/accounts/${cashId}/statement.xlsx`, { token: T });
    const wb = await xlsxCells(xl.buf);
    assert(xl.status === 200 && /TPL-CASH-XL/.test(wb.text + wb.headerFooter), `cash xlsx ${xl.status}`);
    const prev = await api(`/api/pdf-templates/${p.json.template.id}/preview.pdf`, { token: T });
    assert(/CASH ACCOUNT STATEMENT/.test(pdfText(prev.buf)), "cash template preview should show a cash statement");
  });
  await check("the database upgrade widens an older template-kind CHECK without touching rows", async () => {
    const { SyncMysql } = require("../src/mysql/sync-client");
    const schema = require("../src/mysql/schema");
    const e = TESTDB.env;
    const c = new SyncMysql({ host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME });
    const raw = (sql, p = []) => c.query(sql, p).rows;
    try {
      // A scratch company's tables, made with the CURRENT schema, then put
      // back to the old (pre-cash_account) CHECK — exactly what an existing
      // installation has.
      schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0909" });
      const t = "cmp0909_pdf_templates";
      const chk = raw("SELECT cc.CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND cc.CHECK_CLAUSE LIKE '%cash_account%'", [t])[0].n;
      raw(`ALTER TABLE "${t}" DROP CHECK "${chk}", ADD CHECK (kind IN ('global','account','quotation','exchange','transaction','reports','deposit','withdrawal','transfer'))`);
      // Required columns without a default, filled with harmless values.
      const req = raw("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL AND COLUMN_NAME NOT IN ('id','kind','name','company_id')", [t]).map((r) => r.n);
      const ins = (id, kind, name) => raw(`INSERT INTO "${t}" (id, kind, name, company_id${req.map((n) => `, "${n}"`).join("")}) VALUES (?, ?, ?, 'CMP-0909'${req.map(() => ", '2026-01-01T00:00:00Z'").join("")})`, [id, kind, name]);
      ins("old-row", "account", "Old row");
      let refused = false;
      try { ins("x", "cash_account", "x"); } catch (err) { refused = /check/i.test(err.message); }
      assert(refused, "old CHECK should refuse cash_account");
      const { altered } = schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0909" });
      assert(altered.some((a) => a.startsWith(`${t}~`)), `upgrade did not widen: ${altered.join(",")}`);
      ins("new-row", "cash_account", "New row");
      assert(raw(`SELECT name FROM "${t}" WHERE id = 'old-row'`)[0].name === "Old row", "existing row changed");
      assert(schema.ensureScope(raw, { kind: "tenant", companyId: "CMP-0909" }).altered.length === 0, "second upgrade should change nothing");
      let stillChecked = false;
      try { ins("y", "bogus", "y"); } catch (err) { stillChecked = /check/i.test(err.message); }
      assert(stillChecked, "the widened CHECK must still refuse unknown kinds");
    } finally {
      for (const name of schema.companyTables("CMP-0909").reverse()) raw(`DROP TABLE IF EXISTS "${name}"`);
      c.close();
    }
  });

  console.log("\nValidation");
  await check("invalid settings are refused with 400 and nothing is stored", async () => {
    const v0 = (await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template;
    const bad = [
      ["pdf", { colorPrimary: "red" }], ["pdf", { paperSize: "A9" }], ["pdf", { fontFamily: "comic" }], ["pdf", { name: "" }],
      ["pdf", { marginTop: "abc" }], ["pdf", { notARealSetting: 1 }], ["pdf", { footerCustomText: "x".repeat(5000) }],
      ["pdf", { headerStyle: null }],
    ];
    for (const [, body] of bad) {
      const r = await api(`/api/pdf-templates/${ctx.pA.id}`, { method: "PATCH", token: T, body });
      assert(r.status === 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`);
    }
    const arr = await api(`/api/pdf-templates/${ctx.pA.id}`, { method: "PATCH", token: T, body: [1, 2] });
    assert(arr.status === 400, `array body -> ${arr.status}`);
    const v1 = (await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template;
    assert(v1.version === v0.version && v1.colorPrimary === v0.colorPrimary && v1.paperSize === v0.paperSize, "a refused save changed the template");
    const xr = await api(`/api/excel-templates/${ctx.xA.id}`, { method: "PATCH", token: T, body: { headerBgColor: "blue", bogus: true } });
    assert(xr.status === 400, `excel invalid -> ${xr.status}`);
  });
  await check("unknown kinds, unknown presets and missing names are refused on create", async () => {
    for (const body of [{ kind: "bogus", name: "x" }, { name: "x" }, { kind: "account", name: "" }, { kind: "account", name: "x", presetKey: "nope" }, { kind: "account", name: "x", sneaky: 1 }]) {
      for (const k of ["pdf", "excel"]) {
        const r = await api(`/api/${k}-templates`, { method: "POST", token: T, body });
        assert(r.status === 400, `${k} ${JSON.stringify(body)} -> ${r.status}`);
      }
    }
  });
  await check("the default template cannot be archived or deleted (documents always have one)", async () => {
    const a = await api(`/api/pdf-templates/${ctx.pA.id}/archive`, { method: "POST", token: T });
    const d = await api(`/api/pdf-templates/${ctx.pA.id}`, { method: "DELETE", token: T });
    assert(a.status === 400 && d.status === 400, `archive ${a.status}, delete ${d.status}`);
  });

  console.log("\nPermissions");
  await check("anonymous requests are refused (401)", async () => {
    for (const p of ["/api/pdf-templates/kinds", `/api/pdf-templates/${ctx.pA.id}`, "/api/excel-templates?kind=global"]) {
      const r = await api(p);
      assert(r.status === 401, `${p} -> ${r.status}`);
    }
  });
  await check("a Company Admin cannot view, create, edit, set default, preview or delete templates (403)", async () => {
    const calls = [
      ["GET", "/api/pdf-templates?kind=account"], ["GET", `/api/pdf-templates/${ctx.pA.id}`], ["POST", "/api/pdf-templates", { kind: "account", name: "x" }],
      ["PATCH", `/api/pdf-templates/${ctx.pA.id}`, { footerCustomText: "HACK" }], ["POST", `/api/pdf-templates/${ctx.pA.id}/set-default`],
      ["GET", `/api/pdf-templates/${ctx.pA.id}/preview.pdf`], ["DELETE", `/api/pdf-templates/${ctx.pA.id}`],
      ["GET", "/api/excel-templates?kind=account"], ["PATCH", `/api/excel-templates/${ctx.xA.id}`, { footerCustomText: "HACK" }],
      ["POST", `/api/excel-templates/${ctx.xA.id}/reset`],
    ];
    for (const [method, p, body] of calls) {
      const r = await api(p, { method, token: ctx.adm, body });
      assert(r.status === 403, `${method} ${p} -> ${r.status}`);
    }
    assert((await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template.footerCustomText !== "HACK", "edit went through");
  });
  await check("the Company Admin can still generate documents (which use the saved templates)", async () => {
    const r = await api(ctx.acctPdf, { token: ctx.adm });
    assert(r.status === 200 && /TPL-ACCT-FOOTER/.test(pdfText(r.buf)), `statement ${r.status}`);
  });

  console.log("\nCompany isolation");
  await check("Company B cannot see, open, edit or default Company A's templates", async () => {
    const c = await api("/api/platform/companies", { method: "POST", token: sa, body: { name: "Template Beta Ltd", admin: { name: "Beta Admin", username: "tb.admin", password: "BetaPass123!" } } });
    assert(c.status === 201 || c.status === 200, `company ${c.status} ${JSON.stringify(c.json)}`);
    ctx.bId = c.json.company.id;
    ctx.saB = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: ctx.bId } })).json.token;
    for (const [method, p, body] of [["GET", `/api/pdf-templates/${ctx.pA.id}`], ["PATCH", `/api/pdf-templates/${ctx.pA.id}`, { footerCustomText: "B-WAS-HERE" }],
      ["POST", `/api/pdf-templates/${ctx.pA.id}/set-default`], ["GET", `/api/pdf-templates/${ctx.pA.id}/preview.pdf`], ["DELETE", `/api/pdf-templates/${ctx.pA.id}`],
      ["GET", `/api/excel-templates/${ctx.xA.id}`], ["PATCH", `/api/excel-templates/${ctx.xA.id}`, { footerCustomText: "B-WAS-HERE" }]]) {
      const r = await api(p, { method, token: ctx.saB, body });
      assert(r.status === 404, `${method} ${p} from company B -> ${r.status}`);
    }
    const listB = (await api("/api/pdf-templates?kind=account", { token: ctx.saB })).json.templates;
    assert(!listB.some((t) => /Statement A|Statement B/.test(t.name)), "B lists A's templates");
    const a = (await api(`/api/pdf-templates/${ctx.pA.id}`, { token: T })).json.template;
    assert(a.footerCustomText === "TPL-ACCT-FOOTER {{company_name}}", "A's template was changed from B");
  });
  await check("Company B's documents use B's own templates and branding, never A's", async () => {
    const bAdm = (await api("/api/auth/login", { method: "POST", body: { username: "tb.admin", password: "BetaPass123!" } })).json.token;
    const acc = await api("/api/accounts", { method: "POST", token: bAdm, body: { name: "Beta Customer", accountType: "customer", currency: "USD", openingBalance: 10 } });
    assert(acc.status === 201 || acc.status === 200, `account ${acc.status} ${JSON.stringify(acc.json)}`);
    const id = (acc.json.account || acc.json).id;
    let txt = pdfText((await api(`/api/accounts/${id}/statement.pdf`, { token: bAdm })).buf);
    assert(!/TPL-ACCT|TPL-GLOBAL|TPL-HEADER-NOTE/.test(txt), "B's statement used A's template");
    const bt = (await api("/api/pdf-templates", { method: "POST", token: ctx.saB, body: { kind: "account", name: "Beta statement", footerCustomText: "BETA-OWN-FOOTER" } })).json.template;
    await api(`/api/pdf-templates/${bt.id}/set-default`, { method: "POST", token: ctx.saB });
    txt = pdfText((await api(`/api/accounts/${id}/statement.pdf`, { token: bAdm })).buf);
    assert(/BETA-OWN-FOOTER/.test(txt) && /Template Beta Ltd/.test(txt), "B's statement does not use B's template / name");
    const aTxt = pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf);
    assert(!/BETA-OWN-FOOTER/.test(aTxt) && /TPL-ACCT-FOOTER/.test(aTxt), "A's statement changed because of B");
    assert((await api(`/api/pdf-templates/${bt.id}`, { token: T })).status === 404, "A can open B's template");
  });

  console.log("\nFinancial values");
  await check("statement amounts and account balances are identical before and after all template changes", async () => {
    const after = await xlsxCells((await api(ctx.acctXlsx, { token: ctx.adm })).buf);
    const nums = (a) => a.numbers.filter((n) => !(n > 40000 && n < 60000 && Number.isInteger(n))).map((n) => n.toFixed(2)).sort().join(",");
    assert(nums(after) === nums(before.acctXlsx), "numbers in the Excel statement changed");
    const bal = (await api(`/api/accounts/${(before.balance.account || before.balance).id}`, { token: ctx.adm })).json;
    const pick = (j) => JSON.stringify([(j.account || j).balance, (j.account || j).currentBalance]);
    assert(pick(bal) === pick(before.balance), `balance changed ${pick(before.balance)} -> ${pick(bal)}`);
    const money = (t) => (t.match(/\$[\d,]+\.\d{2}/g) || []).sort().join(" ");
    const now = pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf);
    assert(money(now) === money(before.acctPdf), "amounts printed in the PDF statement changed");
  });
}

// The editor itself: real status, "not in use" banner, save survives reload.
async function browserPart() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  console.log("\nEditor in the browser");
  const sw = await api("/api/platform/switch-company", { method: "POST", token: (await api("/api/auth/login", { method: "POST", body: { username: "super.admin", password: SA_PW } })).json.token, body: { companyId: "CMP-0001" } });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await c.addInitScript(([tok, user]) => {
      try { localStorage.setItem("geeska_token", tok); localStorage.setItem("geeska_user", user); sessionStorage.setItem("obo_view", "settings-pdf-templates"); } catch (e) { /* ignore */ }
    }, [sw.json.token, JSON.stringify(sw.json.user)]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    const openB = async () => {
      await p.goto(BASE); await p.waitForTimeout(800);
      await p.getByRole("button", { name: /^Account Statement/ }).first().click(); await p.waitForTimeout(600);
      await p.locator("tr").filter({ hasText: "Statement B" }).getByRole("button", { name: "Customize" }).click();
      await p.waitForSelector('[data-save-status="saved"]', { timeout: 8000 });
    };
    await check("the list explains that only the Default template is applied", async () => {
      await p.goto(BASE); await p.waitForTimeout(800);
      await p.getByText(/Only the Default template of a document type is applied/).first().waitFor({ timeout: 8000 });
    });
    await check("opening a non-default template says it is not in use and offers Set as default", async () => {
      await openB();
      assert(await p.locator('[data-usage="not-default"]').count() === 1, "banner missing");
      if (process.env.TEMPLATES_SHOT) await p.screenshot({ path: process.env.TEMPLATES_SHOT.replace(/\.png$/, "-before.png") });
    });
    await check("typing shows 'Unsaved changes', then 'All changes saved'; a reload shows the saved text", async () => {
      await p.getByRole("button", { name: "Footer", exact: true }).click();
      const ta = p.locator("textarea").first();
      await ta.fill("UI-SAVED-FOOTER");
      assert(await p.locator('[data-save-status="dirty"]').count() === 1, "no unsaved indicator");
      await p.waitForSelector('[data-save-status="saved"]', { timeout: 8000 });
      await p.reload(); await p.waitForTimeout(500);
      await openB();
      await p.getByRole("button", { name: "Footer", exact: true }).click();
      assert(await p.locator("textarea").first().inputValue() === "UI-SAVED-FOOTER", "value lost after reload");
    });
    await check("a value the server rejects shows 'Not saved' with the reason — never 'All changes saved'", async () => {
      await p.getByRole("button", { name: "Colors", exact: true }).click();
      const field = p.locator("div").filter({ has: p.locator("label", { hasText: /^Table border$/ }) }).last();
      const box = field.locator('input[type="checkbox"]').first();
      if (!(await box.isChecked())) await box.check();
      await field.locator('input:not([type="checkbox"]):not([type="color"])').first().fill("#12");
      await p.waitForSelector('[data-save-status="error"]', { timeout: 8000 });
      assert(/hex color/i.test(await p.locator('[data-save-status="error"]').innerText()), "no reason shown");
      await field.locator('input:not([type="checkbox"]):not([type="color"])').first().fill("#123456");
      await p.waitForSelector('[data-save-status="saved"]', { timeout: 8000 });
      const t = (await api("/api/pdf-templates?kind=account", { token: ctx.saA })).json.templates.find((x) => x.name === "Statement B");
      assert(t.colorTableBorder === "#123456" && t.footerCustomText === "UI-SAVED-FOOTER", JSON.stringify([t.colorTableBorder, t.footerCustomText]));
    });
    await check("Set as default from the editor puts the template into use for real documents", async () => {
      await p.locator('[data-usage="not-default"]').getByRole("button", { name: "Set as default" }).click();
      await p.waitForSelector('[data-usage="default"]', { timeout: 8000 });
      if (process.env.TEMPLATES_SHOT) await p.screenshot({ path: process.env.TEMPLATES_SHOT });
      assert(/UI-SAVED-FOOTER/.test(pdfText((await api(ctx.acctPdf, { token: ctx.adm })).buf)), "statement does not use it");
    });
    await check("the editor stacks into one column at tablet width without horizontal scrolling", async () => {
      await p.setViewportSize({ width: 820, height: 1000 }); await p.waitForTimeout(300);
      const cols = await p.locator(".gk-tpl-editor").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert(cols === 1, `columns ${cols}`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `horizontal overflow ${over}px`);
    });
    await check("no browser errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
