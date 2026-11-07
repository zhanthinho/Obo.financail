"use strict";
// TEMPLATE VERSION HISTORY round — PDF and Excel templates keep the look
// they had before each editing session, reset and restore; a version can be
// previewed and restored (the current look is kept too); permissions apply.
// On a throw-away database. Run with: npm run test:template-versions
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("tplversions");
const PORT = Number(process.env.TPL_VERSIONS_TEST_PORT || 4698);
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
  srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", process.env.TV_DEBUG ? "inherit" : "ignore"] });
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

  for (const [type, base, ext] of [["PDF", "/api/pdf-templates", "pdf"], ["Excel", "/api/excel-templates", "xlsx"]]) {
    let tpl, v;
    await check(`${type}: a new template has no earlier versions`, async () => {
      tpl = ok(await api(base, { method: "POST", token: A, body: { kind: "account", name: `${type} history test` } }), "create").template;
      v = ok(await api(`${base}/${tpl.id}/versions`, { token: A }), "versions");
      assert(v.versions.length === 0 && v.current.version === tpl.version, JSON.stringify(v));
    });
    await check(`${type}: one editing session = one version (autosaves coalesce; a save that changes nothing adds none)`, async () => {
      ok(await api(`${base}/${tpl.id}`, { method: "PATCH", token: A, body: { colorPrimary: "#111111" } }), "save 1");
      ok(await api(`${base}/${tpl.id}`, { method: "PATCH", token: A, body: { colorPrimary: "#222222" } }), "save 2");
      ok(await api(`${base}/${tpl.id}`, { method: "PATCH", token: A, body: { colorPrimary: "#222222" } }), "same");
      v = ok(await api(`${base}/${tpl.id}/versions`, { token: A }), "versions").versions;
      assert(v.length === 1 && v[0].reason === "Before save" && v[0].version === tpl.version, JSON.stringify(v));
    });
    await check(`${type}: reset keeps the look from before the reset`, async () => {
      ok(await api(`${base}/${tpl.id}/reset`, { method: "POST", token: A }), "reset");
      v = ok(await api(`${base}/${tpl.id}/versions`, { token: A }), "versions").versions;
      assert(v.length === 2 && v[0].reason === "Before reset to defaults", JSON.stringify(v));
      const now = ok(await api(`${base}/${tpl.id}`, { token: A }), "get").template;
      assert(now.colorPrimary !== "#222222", "reset did not reset");
    });
    await check(`${type}: a version can be previewed`, async () => {
      const r = await api(`${base}/${tpl.id}/versions/${v[0].id}/preview.${ext}`, { token: A, raw: true });
      assert(r.status === 200 && r.buf.length > 500, `preview ${r.status}`);
      const sig = ext === "pdf" ? "%PDF" : "PK";
      assert(r.buf.slice(0, sig.length).toString() === sig, "not a document");
    });
    await check(`${type}: restore puts the old look back, keeps the current one as a version, and is audited`, async () => {
      const before = ok(await api(`${base}/${tpl.id}`, { token: A }), "get").template;
      const res = ok(await api(`${base}/${tpl.id}/versions/${v[0].id}/restore`, { method: "POST", token: A }), "restore").template;
      assert(res.colorPrimary === "#222222", `colorPrimary ${res.colorPrimary}`);
      assert(res.version === before.version + 1, `version ${res.version}`);
      const after = ok(await api(`${base}/${tpl.id}/versions`, { token: A }), "versions").versions;
      assert(after.length === 3 && /^Before restoring version/.test(after[0].reason), JSON.stringify(after.map((x) => x.reason)));
      // ...so the restore itself can be undone
      const undo = ok(await api(`${base}/${tpl.id}/versions/${after[0].id}/restore`, { method: "POST", token: A }), "undo").template;
      assert(undo.colorPrimary === before.colorPrimary, "undo did not return");
      const acts = ok(await api("/api/reports/audit-log", { token: A }), "audit").entries.map((e) => e.action);
      assert(acts.includes(`${type} template version restored`), "not audited");
    });
    await check(`${type}: a version of another template, or an unknown one, is refused`, async () => {
      const other = ok(await api(base, { method: "POST", token: A, body: { kind: "account", name: `${type} other` } }), "other").template;
      assert((await api(`${base}/${other.id}/versions/${v[0].id}/restore`, { method: "POST", token: A })).status === 404, "cross-template restore allowed");
      assert((await api(`${base}/${tpl.id}/versions/nope/restore`, { method: "POST", token: A })).status === 404, "unknown version");
    });
    await check(`${type}: without the template permissions the history is closed`, async () => {
      const viewer = ok(await api("/api/auth/login", { method: "POST", body: { username: "sahra.ismail", password: PW } }), "viewer").token;
      assert((await api(`${base}/${tpl.id}/versions`, { token: viewer })).status === 403, "viewer can list");
      assert((await api(`${base}/${tpl.id}/versions/${v[0].id}/restore`, { method: "POST", token: viewer })).status === 403, "viewer can restore");
    });
  }

  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("(browser part skipped)"); return; }
  const browser = await chromium.launch();
  const errors = [];
  try {
    const c = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.accept());
    await p.addInitScript(([t, u, v]) => { try { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", u); sessionStorage.setItem("obo_view", v); } catch (e) { /* ignore */ } }, [sw.json.token, JSON.stringify(sw.json.user), "settings-pdf-templates"]);
    await p.goto(BASE); await p.waitForTimeout(1500);
    await check("editor: 'Version history' lists the versions and Restore works", async () => {
      await p.getByRole("button", { name: "Customize" }).first().click({ timeout: 8000 });
      await p.waitForTimeout(1500);
      await p.getByRole("button", { name: "Reset to defaults" }).click(); await p.waitForTimeout(1200);
      await p.getByRole("button", { name: "Version history" }).click(); await p.waitForTimeout(1200);
      const rows = await p.locator("[data-template-versions] [data-version-row]").count();
      assert(rows >= 1, `rows ${rows}`);
      if (process.env.TV_SHOTS) await p.screenshot({ path: require("path").join(process.env.TV_SHOTS, "template-versions.png") });
      await p.locator("[data-template-versions] [data-version-row]").first().getByRole("button", { name: "Restore" }).click();
      await p.waitForTimeout(1500);
      const rows2 = await p.locator("[data-template-versions] [data-version-row]").count();
      assert(rows2 === rows + 1, `after restore ${rows2}`);
      assert(await p.getByText(/restored\./).count() >= 1, "no confirmation");
    });
    await check("no page errors", async () => { assert(!errors.length, errors.join(" | ")); });
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); try { srv && srv.kill(); } catch (x) { /* gone */ } process.exit(1); });
