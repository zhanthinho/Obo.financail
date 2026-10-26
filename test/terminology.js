"use strict";
// DEPOSIT/WITHDRAW → CREDIT/DEBIT TERMINOLOGY round — regression tests.
// The words changed; nothing else did. Proves that:
//   * screens (English and Somali) show Credit/Debit and never the old words;
//   * CSV, Excel and PDF exports and receipts say Credit/Debit;
//   * historical deposit/withdrawal records still load, filter and display
//     (as Credit/Debit) — the stored type values are unchanged;
//   * a credit still adds and a debit still subtracts exactly as before, and
//     the old API values ("deposit"/"withdraw") keep working, with
//     "credit"/"debit" accepted as aliases by the bulk endpoint;
//   * unrelated words (e.g. the Balance Sheet's Total Credit) are untouched.
//
// Run with: npm run test:terminology
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".terminology-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("terminology");
const PORT = Number(process.env.TERMINOLOGY_TEST_PORT || 4398);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
const OLD = /\b(deposit|deposits|deposited|withdraw|withdraws|withdrawal|withdrawals|withdrawn)\b/i;

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function api(p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json, text, buf };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u, p = PW) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: p } })).json.token;
function dbq(sql, ...params) {
  const db = require("./helpers/mysql").openScope(TESTDB.env, { companyId: "CMP-0001", readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
// Text of an export: CSV as-is, PDF via pdftotext, XLSX via its shared strings.
function exportText(buf, kind) {
  const f = path.join(TMP, `x.${kind}`);
  fs.writeFileSync(f, buf);
  if (kind === "pdf") return execFileSync("pdftotext", [f, "-"]).toString();
  if (kind === "xlsx") return execFileSync("unzip", ["-p", f, "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]).toString().replace(/<[^>]+>/g, " ");
  return buf.toString("utf8");
}
const hasTool = (t) => { try { execFileSync("which", [t], { stdio: "ignore" }); return true; } catch (e) { return false; } };

const ctx = {};
async function setup() {
  const sa = await login("super.admin", SA_PW);
  const cid = (await api("/api/platform/companies", { token: sa })).json.companies[0].id;
  ctx.ws = (await api("/api/platform/switch-company", { method: "POST", token: sa, body: { companyId: cid } })).json;
  ctx.t = ctx.ws.token;
  const till = await api("/api/cash/accounts", { method: "POST", token: ctx.t, body: { name: "Term Till", type: "physical_cash", currency: "USD", openingBalance: 500 } });
  assert(till.status === 201, till.text);
  ctx.till = till.json.account;
  ctx.acct = (await api("/api/accounts?currency=USD", { token: ctx.t })).json.accounts.find((a) => a.status === "active");
}
const bal = async () => (await api(`/api/accounts/${ctx.acct.id}`, { token: ctx.t })).json.account.balance;
const cash = async () => (await api("/api/cash/accounts?status=all", { token: ctx.t })).json.accounts.find((a) => a.id === ctx.till.id).balance;

async function apiChecks() {
  console.log("\nSame money, new words");
  await check("historical records keep their stored type (deposit/withdrawal) — nothing was migrated", async () => {
    const types = dbq("SELECT DISTINCT type FROM account_ledger").map((r) => r.type).sort();
    assert(JSON.stringify(types) === JSON.stringify(["deposit", "withdrawal"]), JSON.stringify(types));
    assert(dbq("SELECT COUNT(*) n FROM account_ledger WHERE type IN ('credit','debit')")[0].n === 0, "new type values appeared");
  });
  await check("a credit still adds and a debit still subtracts, through the same endpoints as before", async () => {
    const b0 = await bal(), c0 = await cash();
    const d = await api(`/api/accounts/${ctx.acct.id}/deposit`, { method: "POST", token: ctx.t, body: { amount: 100, currency: "USD", cashAccountId: ctx.till.id } });
    assert(d.status === 200, d.text);
    const w = await api(`/api/accounts/${ctx.acct.id}/withdraw`, { method: "POST", token: ctx.t, body: { amount: 30, currency: "USD", cashAccountId: ctx.till.id } });
    assert(w.status === 200, w.text);
    assert(near(await bal(), b0 + 70) && near(await cash(), c0 + 70), "balance effect changed");
  });
  await check("the bulk endpoint accepts credit/debit as aliases and still stores deposit/withdrawal", async () => {
    const b0 = await bal();
    const r = await api("/api/accounts/bulk-deposit-withdraw", { method: "POST", token: ctx.t, body: { items: [
      { accountId: ctx.acct.id, type: "credit", amount: 11, cashAccountId: ctx.till.id, notes: "alias-credit" },
      { accountId: ctx.acct.id, type: "debit", amount: 4, cashAccountId: ctx.till.id, notes: "alias-debit" },
      { accountId: ctx.acct.id, type: "deposit", amount: 2, cashAccountId: ctx.till.id, notes: "alias-old" },
    ] } });
    assert(r.status === 200 || r.status === 201, r.text);
    assert(near(await bal(), b0 + 9), "alias amounts");
    const t = Object.fromEntries(dbq("SELECT notes, type FROM account_ledger WHERE notes LIKE 'alias-%'").map((x) => [x.notes, x.type]));
    assert(t["alias-credit"] === "deposit" && t["alias-debit"] === "withdrawal" && t["alias-old"] === "deposit", JSON.stringify(t));
    const bad = await api("/api/accounts/bulk-deposit-withdraw", { method: "POST", token: ctx.t, body: { items: [{ accountId: ctx.acct.id, type: "refund", amount: 1 }] } });
    assert(bad.status === 400 && /credit or debit/.test(bad.text), bad.text);
  });
  await check("filters by the old type values still find historical records", async () => {
    const dep = (await api("/api/account-ledger?type=deposit&currency=USD", { token: ctx.t })).json;
    const rows = dep.entries || dep.ledger || dep.rows || [];
    assert(rows.length > 0 && rows.every((e) => e.type === "deposit"), `deposit filter: ${rows.length}`);
    const h = (await api("/api/history?currency=USD&type=withdrawal", { token: ctx.t })).json;
    const hr = h.entries || h.history || h.rows || [];
    assert(hr.length > 0, "history withdrawal filter empty");
  });

  console.log("\nExports say Credit/Debit");
  const exportsList = [
    ["/api/account-ledger/export.csv?currency=USD", "csv"],
    ["/api/history/export.csv?currency=USD", "csv"],
    ["/api/account-ledger/export.pdf?currency=USD", "pdf"],
    ["/api/history/export.pdf?currency=USD&type=deposit", "pdf"],
    [`/api/accounts/${ctx.acct && ctx.acct.id}/statement.pdf`, "pdf"],
    [`/api/accounts/${ctx.acct && ctx.acct.id}/statement.xlsx`, "xlsx"],
    [`/api/cash/accounts/${ctx.till && ctx.till.id}/statement.pdf`, "pdf"],
    [`/api/cash/accounts/${ctx.till && ctx.till.id}/statement.xlsx`, "xlsx"],
  ];
  await check("CSV, PDF and Excel exports and statements use Credit/Debit and never the old words", async () => {
    if (!hasTool("pdftotext") || !hasTool("unzip")) { console.log("(pdftotext/unzip missing — PDF/XLSX text not checked)"); }
    let sawNew = 0;
    for (const [p, kind] of exportsList) {
      if ((kind === "pdf" && !hasTool("pdftotext")) || (kind === "xlsx" && !hasTool("unzip"))) continue;
      const r = await api(p, { token: ctx.t });
      assert(r.status === 200, `${p}: ${r.status} ${r.text.slice(0, 100)}`);
      const text = exportText(r.buf, kind);
      // Reference numbers keep their DEP-/WD- prefixes (references never change).
      const words = text.replace(/\b(DEP|WD)-\d{4}-\d+/g, "");
      const m = words.match(OLD);
      assert(!m, `${p} still says "${m && m[0]}"`);
      if (/\b(Credit|Debit)/.test(words)) sawNew++;
    }
    assert(sawNew >= 4, `only ${sawNew} exports mention Credit/Debit`);
  });
  await check("receipts for a credit and a debit are titled Credit/Debit Receipt", async () => {
    if (!hasTool("pdftotext")) return;
    for (const type of ["deposit", "withdrawal"]) {
      const e = dbq("SELECT id FROM account_ledger WHERE type = ? AND source_type IS NULL ORDER BY created_at DESC LIMIT 1", type)[0];
      const r = await api(`/api/account-ledger/${e.id}/receipt.pdf`, { token: ctx.t });
      const text = exportText(r.buf, "pdf");
      assert(new RegExp(type === "deposit" ? "CREDIT RECEIPT" : "DEBIT RECEIPT").test(text) && !OLD.test(text.replace(/\b(DEP|WD)-\d{4}-\d+/g, "")), text.slice(0, 200));
    }
  });
  await check("server messages use the new words (English and Somali)", async () => {
    await api(`/api/cash/accounts/${ctx.till.id}/deactivate`, { method: "POST", token: ctx.t, body: { reason: "t" } });
    const en = await api(`/api/cash/accounts/${ctx.till.id}/deposit`, { method: "POST", token: ctx.t, body: { amount: 1 } });
    assert(/before recording a credit/.test(en.text), en.text);
    const so = await fetch(`${BASE}/api/cash/accounts/${ctx.till.id}/withdraw`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.t}`, "X-Lang": "so" }, body: JSON.stringify({ amount: 1 }) }).then((r) => r.text());
    assert(/diiwaan gelin debit/.test(so) && !/qaadasho/i.test(so), so);
    await api(`/api/cash/accounts/${ctx.till.id}/activate`, { method: "POST", token: ctx.t });
  });
}

async function browserChecks() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (e) { console.log("\n(browser part skipped — Playwright not installed)"); return; }
  const browser = await chromium.launch();
  console.log("\nScreens");
  const errors = [];
  const VIEWS = ["dashboard", "accounts-usd", "cashInHand", "deposits-usd", "bulk-tx-usd", "history-usd", "reports"];
  try {
    for (const lang of ["en", "so"]) {
      const seen = [];
      const missing = [];
      let newWords = 0;
      for (const v of VIEWS) {
        const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
        await c.addInitScript(([t, u, view, l]) => { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", JSON.stringify(u)); sessionStorage.setItem("obo_view", view); localStorage.setItem("obo_lang", l); }, [ctx.ws.token, ctx.ws.user, v, lang]);
        const p = await c.newPage();
        p.on("pageerror", (e) => errors.push(`${v}: ${e.message}`));
        await p.goto(BASE); await p.waitForTimeout(2000);
        const text = await p.evaluate(() => document.body.innerText + "\n" + [...document.querySelectorAll("option,[title],[placeholder]")].map((e) => `${e.textContent} ${e.getAttribute("title") || ""} ${e.getAttribute("placeholder") || ""}`).join("\n"));
        const clean = text.replace(/\b(DEP|WD)-\d{4}-\d+/g, "");
        const m = clean.match(lang === "en" ? OLD : /\b(dhigasho\w*|qaadasho\w*|dhigash\w*|qaadash\w*)\b/i);
        if (m) seen.push(`${v}: "${m[0]}"`);
        if (lang === "en" ? /\b(Credit|Debit)s?\b/.test(clean) : /\b(Kiredit|Debit)/.test(clean)) newWords++;
        if (lang === "so") missing.push(...(await p.evaluate(() => [...window.__i18n.missing].filter((s) => /\b(credit|debit)/i.test(s) && !/^alias-/.test(s) && !/^[^:]+: [\d$]/.test(s)))).map((s) => `${v}: ${s}`));
        await c.close();
      }
      await check(`${lang === "en" ? "English" : "Somali"}: every main screen shows the new words and none of the old ones`, async () => {
        assert(!seen.length, seen.join(" | "));
        assert(newWords >= 4, `only ${newWords} screens show Credit/Debit`);
        assert(!missing.length, `untranslated: ${missing.slice(0, 5).join(" | ")}`);
      });
    }
    {
      const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await c.addInitScript(([t, u]) => { localStorage.setItem("geeska_token", t); localStorage.setItem("geeska_user", JSON.stringify(u)); sessionStorage.setItem("obo_view", "cashInHand"); }, [ctx.ws.token, ctx.ws.user]);
      const p = await c.newPage();
      await p.goto(BASE); await p.waitForTimeout(2000);
      await check("the Balance Sheet's own 'Credit' (customer funds) is unchanged and still means the same", async () => {
        const t = await p.locator(".gk-balance-sheet").innerText();
        assert(/Total Credit \(USD\)/.test(t) && /Total Debt \(USD\)/.test(t), t.slice(0, 300));
      });
      await check("recording a credit from the Cash in Hand screen still works", async () => {
        const c0 = await cash();
        await p.locator("button", { hasText: /^Credit$/ }).first().click(); await p.waitForTimeout(400);
        const dlg = p.locator('[role="dialog"]').last();
        assert(/Credit to/.test(await dlg.innerText()), "dialog title");
        await dlg.locator("input:not([disabled])").first().fill("5");
        await dlg.locator("button", { hasText: /Record Credit|Save/ }).last().click(); await p.waitForTimeout(1200);
        assert(near(await cash(), c0 + 5), "cash did not go up by 5");
      });
      await c.close();
    }
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
  await new Promise((r) => setTimeout(r, 400));
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
