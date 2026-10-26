"use strict";
// SOMALI / ENGLISH LANGUAGE round — regression tests.
// Proves on a throw-away installation that:
//  - the translation engine translates interface text but never names,
//    references or amounts, and English mode returns text unchanged;
//  - API messages, CSV / Excel / PDF exports follow the X-Lang header,
//    while every number and every piece of data stays identical;
//  - a CSV exported in Somali can be imported again;
//  - nothing in the books moves;
//  - in the browser the SO / EN switch changes the whole interface,
//    persists across refresh and sign-in, and works at phone width.
//
// Run with: npm run test:language
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(__dirname, ".language-tmp");
const TESTDB = require("./helpers/mysql").createTestDatabase("language");
const PORT = Number(process.env.LANGUAGE_TEST_PORT || 4350);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

const i18n = require("../src/i18n");
const SO = require("../src/i18n/so.json");
const PATTERNS = require("../src/i18n/so-patterns.json");

let passed = 0;
const failures = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try { await fn(); passed += 1; console.log("ok"); } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`FAILED\n      ${e.message}`); }
}
async function raw(p, { method = "GET", body, token, lang } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lang) headers["X-Lang"] = lang;
  return fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function api(p, opts) {
  const res = await raw(p, opts);
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
const login = async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PW } })).json.token;
async function balances(t) {
  const out = {};
  for (const cur of ["USD", "SLSH"]) {
    const r = await api(`/api/accounts?currency=${cur}`, { token: t });
    for (const a of r.json.accounts) out[a.id] = a.balance;
  }
  return out;
}
const csvRows = (text) => text.replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(","));

function engineChecks() {
  console.log("\nTranslation dictionaries and engine");
  return Promise.resolve()
    .then(() => check("every dictionary entry has a non-empty Somali text", async () => {
      const bad = Object.entries(SO).filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
      assert(!bad.length, `empty: ${bad.slice(0, 5).join(" | ")}`);
    }))
    .then(() => check("every pattern keeps its {n} placeholders (only English plural endings may drop)", async () => {
      const ph = (s) => new Set(s.match(/\{\d+\}/g) || []);
      const bad = Object.entries(PATTERNS).filter(([k, v]) => {
        const kk = ph(k), vv = ph(v);
        if ([...vv].some((x) => !kk.has(x))) return true;
        // a dropped part must be an English plural ending glued to a word, e.g. "transaction{2}"
        return [...kk].some((x) => !vv.has(x) && !new RegExp("[a-z]" + x.replace(/[{}]/g, "\\$&")).test(k));
      }).map(([k]) => k);
      assert(!bad.length, `mismatched: ${bad.slice(0, 5).join(" | ")}`);
    }))
    .then(() => check("interface text is translated (consistent terminology)", async () => {
      const want = { Dashboard: "Guudmar", Accounts: "Akoonnada", Settings: "Dejinta", "Money Exchange": "Sarrifka Lacagta", "Cash in Hand": "Lacagta Gacanta", Save: "Kaydi", Cancel: "Jooji", "Opening Balance": "Haraaga Furitaanka" };
      for (const [en, so] of Object.entries(want)) assert(i18n.translate(en, "so") === so, `${en} -> ${i18n.translate(en, "so")}`);
    }))
    .then(() => check("names, references and amounts are never translated", async () => {
      for (const s of ["Opening Test Trading Co", "Exchange Point Ltd", "View Hodan Hotel", "Hodan Hotel", "QT-2026-0001", "ACC-0004", "$1,250.00", "SLSH 2,000,000", "amina.yusuf", "CMP-0001"]) {
        assert(i18n.translate(s, "so") === s, `"${s}" became "${i18n.translate(s, "so")}"`);
      }
    }))
    .then(() => check("numbers inside sentences are kept exactly", async () => {
      const t = i18n.translate("Totals for this list (USD) — 23 transactions", "so");
      assert(t.includes("(USD)") && t.includes("23") && t !== "Totals for this list (USD) — 23 transactions", t);
    }))
    .then(() => check("English mode returns every string unchanged", async () => {
      for (const s of ["Dashboard", "Save changes", "Opening $1,250.00"]) assert(i18n.translate(s, "en") === s, s);
    }))
    .then(() => check("unknown text falls back to English (never blank)", async () => {
      assert(i18n.translate("Zzqx unknown label", "so") === "Zzqx unknown label", "fallback changed the text");
    }));
}

async function httpChecks() {
  const admin = await login("amina.yusuf");
  const before = await balances(admin);
  const company = ((await api("/api/settings/company", { token: admin })).json || {}).company || {};

  console.log("\nServer messages");
  await check("an error message comes back in Somali with X-Lang: so", async () => {
    const r = await api("/api/accounts/does-not-exist", { token: admin, lang: "so" });
    assert(r.status === 404 && r.json.error === SO["Account not found."], JSON.stringify(r.json));
  });
  await check("... and in English without it", async () => {
    const r = await api("/api/accounts/does-not-exist", { token: admin });
    assert(r.status === 404 && r.json.error === "Account not found.", JSON.stringify(r.json));
  });
  await check("a failed sign-in message is translated too", async () => {
    const r = await api("/api/auth/login", { method: "POST", lang: "so", body: { username: "amina.yusuf", password: "wrong-password" } });
    assert(r.status === 401 && r.json.error && !/Invalid username/.test(r.json.error), JSON.stringify(r.json));
  });
  await check("the language header grants nothing: no token is still 401", async () => {
    const r = await api("/api/accounts", { lang: "so" });
    assert(r.status === 401, `got ${r.status}`);
  });

  console.log("\nExports");
  let soCsv, enCsv;
  await check("accounts CSV: Somali headings, same data and numbers as English", async () => {
    enCsv = csvRows((await api("/api/accounts/export.csv", { token: admin })).text);
    soCsv = csvRows((await api("/api/accounts/export.csv", { token: admin, lang: "so" })).text);
    assert(enCsv[0][0] === "Account #" && soCsv[0][0] !== "Account #", `headings: ${soCsv[0].join("|")}`);
    assert(soCsv.length === enCsv.length, "row count differs");
    for (let r = 1; r < enCsv.length; r++) {
      for (const c of [0, 1, 3, 4, 5, 7, 8, 9]) assert(soCsv[r][c] === enCsv[r][c], `row ${r} col ${c}: "${soCsv[r][c]}" vs "${enCsv[r][c]}"`);
    }
  });
  await check("the import template stays English (it is the importer's format)", async () => {
    const t = (await api("/api/accounts/import-template.csv", { token: admin, lang: "so" })).text;
    assert(/^﻿?Account #,Account Name,Account Type/.test(t), t.slice(0, 60));
  });
  await check("a CSV exported in Somali can be imported again (preview recognises it)", async () => {
    const header = soCsv[0].slice(0, 7).join(",") + "," + soCsv[0][7];
    const row = ["", "Language Probe Ltd", soCsv[1][2], "USD", "", "", soCsv[1][6], "0"].join(",");
    const fileBase64 = Buffer.from("﻿" + header + "\r\n" + row + "\r\n").toString("base64");
    const r = await api("/api/accounts/import/preview", { method: "POST", token: admin, lang: "so", body: { fileName: "so.csv", fileBase64 } });
    assert(r.status === 200, JSON.stringify(r.json));
    const p = r.json.rows[0];
    assert(p.name === "Language Probe Ltd" && p.result === "valid" && ["customer", "company"].includes(p.accountType) && p.accountStatus === "active", JSON.stringify(p));
  });
  await check("accounts Excel: Somali labels, valid workbook, identical numbers, company profile untouched", async () => {
    const ExcelJS = require("exceljs");
    const load = async (lang) => { const res = await raw("/api/accounts/export.xlsx", { token: admin, lang }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer())); return wb; };
    const en = await load(), so = await load("so");
    const ws1 = en.worksheets[0], ws2 = so.worksheets[0];
    assert(ws1.name !== ws2.name, `sheet name not translated (${ws2.name})`);
    let nums = 0, textDiff = 0;
    ws1.eachRow((row, r) => row.eachCell((cell, c) => {
      const other = ws2.getRow(r).getCell(c).value;
      if (typeof cell.value === "number") { nums++; assert(other === cell.value, `number at ${r},${c} changed`); }
      else if (typeof cell.value === "string" && other !== cell.value) textDiff++;
    }));
    assert(nums > 0 && textDiff > 0, `nums=${nums} textDiff=${textDiff}`);
    assert(company.name && company.tagline, `company profile not loaded: ${JSON.stringify(company).slice(0, 120)}`);
    if (company && company.name) {
      let seen = false;
      ws2.eachRow((row) => row.eachCell((cell) => { if (cell.value === company.name) seen = true; }));
      assert(seen, "company name missing or changed in the Somali workbook");
    }
    if (company && company.tagline) {
      let seen = false;
      ws2.eachRow((row) => row.eachCell((cell) => { if (cell.value === company.tagline) seen = true; }));
      assert(seen, `company tagline was altered (expected "${company.tagline}")`);
    }
  });
  await check("PDF exports render in Somali (accounts, history, reports, quotation)", async () => {
    const q = (await api("/api/quotations", { token: admin })).json;
    const qid = (q.quotations || q.items || [])[0]?.id;
    const urls = ["/api/accounts/export.pdf", "/api/history/export.pdf", "/api/reports/audit-log/export.pdf", "/api/dashboard/export.pdf"].concat(qid ? [`/api/quotations/${qid}/pdf`] : []);
    for (const u of urls) {
      const res = await raw(u, { token: admin, lang: "so" });
      const buf = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200 && buf.slice(0, 4).toString() === "%PDF", `${u}: ${res.status}`);
    }
  });
  await check("no balance moved after all of the above", async () => {
    const after = await balances(admin);
    for (const [id, b] of Object.entries(before)) assert(after[id] === b, `account ${id} changed ${b} -> ${after[id]}`);
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
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.dismiss());
    const signIn = async () => {
      await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW);
      await p.keyboard.press("Enter"); await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(800);
    };
    const pressed = async () => (await p.locator('.gk-lang-toggle button[aria-pressed="true"]').first().innerText()).trim();
    await p.goto(BASE); await p.waitForTimeout(600);
    await check("the sign-in screen has the SO / EN switch, English by default", async () => {
      assert(await p.locator(".gk-lang-toggle").first().isVisible(), "no switch on sign-in");
      assert((await pressed()) === "EN", `pressed: ${await pressed()}`);
    });
    await signIn();
    await check("SO switches the whole interface to Somali", async () => {
      await p.locator(".gk-lang-toggle button", { hasText: "SO" }).first().click(); await p.waitForTimeout(900);
      const nav = await p.locator(".gk-sidebar").innerText();
      assert(/Guudmar/.test(nav) && /Dejinta/.test(nav) && !/\bDashboard\b/.test(nav), nav.slice(0, 200));
      const missing = await p.evaluate(() => [...window.__i18n.missing].filter((s) => /\b(the|and|your|for|with|this)\b/i.test(s)));
      assert(!missing.length, `untranslated sentences: ${missing.slice(0, 5).join(" | ")}`);
    });
    await check("the switch is keyboard accessible (Tab + Enter)", async () => {
      await p.locator(".gk-lang-toggle button", { hasText: "EN" }).first().focus();
      await p.keyboard.press("Enter"); await p.waitForTimeout(900);
      assert((await pressed()) === "EN" && /Dashboard/.test(await p.locator(".gk-sidebar").innerText()), "Enter did not switch to English");
      await p.locator(".gk-lang-toggle button", { hasText: "SO" }).first().focus();
      await p.keyboard.press("Space"); await p.waitForTimeout(900);
      assert((await pressed()) === "SO", "Space did not switch back to Somali");
    });
    await check("the choice survives a refresh", async () => {
      await p.reload(); await p.waitForTimeout(1500);
      assert((await pressed()) === "SO" && /Guudmar/.test(await p.locator(".gk-sidebar").innerText()), "not Somali after refresh");
    });
    await check("... and signing out and in again", async () => {
      await p.evaluate(() => { localStorage.removeItem("geeska_token"); });
      await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/token/i.test(k)) localStorage.removeItem(k); });
      await p.reload(); await p.waitForTimeout(800);
      assert((await pressed()) === "SO", "sign-in screen lost the language");
      await signIn();
      assert((await pressed()) === "SO", "lost after sign-in");
    });
    await check("EN switches everything back to English", async () => {
      await p.locator(".gk-lang-toggle button", { hasText: "EN" }).first().click(); await p.waitForTimeout(900);
      const nav = await p.locator(".gk-sidebar").innerText();
      assert(/Dashboard/.test(nav) && !/Guudmar/.test(nav), nav.slice(0, 200));
    });
    await ctx.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const m = await phone.newPage();
    m.on("pageerror", (e) => errors.push(e.message));
    await m.goto(BASE); await m.waitForTimeout(600);
    await m.locator("input").first().fill("amina.yusuf"); await m.fill('input[type="password"]', PW);
    await m.keyboard.press("Enter"); await m.waitForTimeout(2200);
    await check("phone width: the switch is visible, on screen and works", async () => {
      const t = m.locator(".gk-lang-toggle").first();
      const box = await t.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 390, `switch off screen: ${JSON.stringify(box)}`);
      await m.locator(".gk-lang-toggle button", { hasText: "SO" }).first().tap(); await m.waitForTimeout(900);
      assert(/Guudmar/.test(await m.locator("body").innerText()), "did not switch on phone");
      const scroll = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert(!scroll, "page scrolls sideways on a phone");
    });
    await phone.close();
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await engineChecks();
  console.log("\nSeeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await httpChecks(); await browserChecks(); } finally { srv.kill(); }
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
