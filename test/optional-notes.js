"use strict";
// COLLAPSIBLE NOTES round — every optional Notes field is closed by default
// ("Add Note (optional)") and opens on its own when the record already has a
// note. On a throw-away installation this proves that:
//   * no form still renders an always-visible optional Notes input (source
//     audit over the whole frontend);
//   * a new form starts collapsed; the field opens/closes; text survives
//     collapsing and is shown as a preview; keyboard works;
//   * an exchange saves with or without a note (Notes is never required),
//     and the saved note is back, already open, when the record is reopened;
//   * a record without a note opens collapsed;
//   * other modules (Company Expenses) use the same control;
//   * Somali labels and a phone-width screen work.
//
// Run with: npm run test:optional-notes
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TESTDB = require("./helpers/mysql").createTestDatabase("optionalnotes");
const PORT = Number(process.env.NOTES_TEST_PORT || 4397);
const BASE = `http://localhost:${PORT}`;
const ENV = { ...process.env, ...TESTDB.env, PORT: String(PORT), JWT_SECRET: crypto.randomBytes(32).toString("hex"), BACKUP_ENABLED: "0" };
const PW = process.env.SEED_DEMO_PASSWORD;

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
  return { status: res.status, json };
}
async function waitUp() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}
const login = async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PW } })).json.token;
let admin;
const latestTx = async () => (await api("/api/transactions", { token: admin })).json.transactions[0];

// ---- 1. Source audit: no always-visible optional Notes input is left ----
async function sourceAudit() {
  const src = fs.readFileSync(path.join(ROOT, "frontend", "app.jsx"), "utf8");
  const lines = src.split("\n");
  await check("audit: no <Field label=\"Note(s)…\"> wraps an input any more", () => {
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /<Field label="(Notes?|Notes? \(optional\)|Description \(optional\))"/.test(l));
    assert(!bad.length, bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`).join(" | "));
  });
  await check("audit: every note/notes input is inside OptionalNotes", () => {
    // Any line that edits a notes value (setNotes/setNote/set("notes")) from an
    // input's onChange must be an OptionalNotes line.
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) =>
      /onChange=\{(\(e\) => (setNotes|setNote)\(e\.target\.value\)|\(e\) => set\("notes", e\.target\.value\)|set\("notes"\))\}/.test(l) && !/<OptionalNotes\b/.test(l));
    assert(!bad.length, bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`).join(" | "));
  });
  await check("audit: the shared control is used across the modules (>= 19 places)", () => {
    const n = (src.match(/<OptionalNotes\b/g) || []).length;
    assert(n >= 19, `only ${n}`);
  });
}

async function apiChecks() {
  admin = await login("amina.yusuf");
  await check("4. API: an exchange without a note saves (Notes is optional)", async () => {
    const r = await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 10, currencyGiven: "USD" } });
    assert(r.status < 300, JSON.stringify(r.json));
    assert(!r.json.transaction.notes, `notes = ${JSON.stringify(r.json.transaction.notes)}`);
  });
}

async function browserChecks() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const errors = [];
  const signIn = async (viewport, lang) => {
    const c = await browser.newContext({ viewport });
    if (lang) await c.addInitScript((l) => { try { localStorage.setItem("obo_lang", l); } catch (e) { /* ignore */ } }, lang);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE); await p.waitForTimeout(400);
    await p.locator("input").first().fill("amina.yusuf"); await p.fill('input[type="password"]', PW); await p.keyboard.press("Enter");
    await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
    return { c, p };
  };
  const goExchange = async (p, lang, mobile) => {
    if (mobile) { const ham = p.locator(".gk-mobile-hamburger"); if (await ham.count()) { await ham.click(); await p.waitForTimeout(400); } }
    await p.getByText(lang === "so" ? "Sarrifka Lacagta" : "Money Exchange", { exact: true }).first().click(); await p.waitForTimeout(1000);
  };
  const newExchange = async (p, lang) => {
    await p.getByRole("button", { name: lang === "so" ? /Macaamil cusub/ : /New transaction/ }).first().click();
    await p.waitForSelector("#qx-amount", { timeout: 10000 });
  };
  const notesBox = (p) => p.locator(".gk-qx .gk-notes");
  const notesHead = (p) => p.locator(".gk-qx .gk-notes-head");
  try {
    {
      const { c, p } = await signIn({ width: 1366, height: 1000 });
      await goExchange(p);
      await newExchange(p);
      await p.fill("#qx-amount", "100");
      await p.click('button[aria-controls="qx-details"]'); await p.waitForTimeout(200);
      await check("1. new exchange: Notes collapsed, no input, 'Add Note (optional)' shown", async () => {
        assert(await notesBox(p).getAttribute("data-open") === "false", "open by default");
        assert(!(await p.locator("#qx-notes").count()), "input rendered while collapsed");
        assert(/Add Note \(optional\)/.test(await notesHead(p).innerText()), await notesHead(p).innerText());
        assert(await notesHead(p).getAttribute("aria-expanded") === "false", "aria-expanded not false");
      });
      await check("2. clicking opens it, focuses the field, and turns the chevron", async () => {
        await notesHead(p).click(); await p.waitForTimeout(250);
        assert(await p.locator("#qx-notes").isVisible(), "field not shown");
        assert(await notesHead(p).getAttribute("aria-expanded") === "true", "aria-expanded not true");
        const rot = await p.locator(".gk-qx .gk-notes-chev").evaluate((el) => getComputedStyle(el).transform);
        assert(rot && rot !== "none", `chevron not turned (${rot})`);
        assert(await p.evaluate(() => document.activeElement && document.activeElement.id === "qx-notes"), "field not focused");
      });
      await check("3. text survives collapsing and shows as a preview", async () => {
        await p.fill("#qx-notes", "Paid in cash at branch");
        await notesHead(p).click(); await p.waitForTimeout(200);
        assert(!(await p.locator("#qx-notes").count()), "still visible");
        assert(/Paid in cash at branch/.test(await p.locator(".gk-qx .gk-notes-preview").innerText()), "no preview");
        await notesHead(p).focus(); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
        assert((await p.inputValue("#qx-notes")) === "Paid in cash at branch", "text lost");
        await notesHead(p).focus(); await p.keyboard.press(" "); await p.waitForTimeout(200);
        assert(!(await p.locator("#qx-notes").count()), "keyboard (Space) did not collapse");
      });
      await check("5. saving with the section collapsed still saves the note", async () => {
        await p.locator('button:has-text("Record Exchange")').click(); await p.waitForTimeout(2500);
        const t = await latestTx();
        assert(t.notes === "Paid in cash at branch" && t.amountGiven === 100, JSON.stringify({ notes: t.notes, amt: t.amountGiven }));
      });
      await check("6/8. reopening the saved record: Notes already open with the note", async () => {
        await p.locator("button", { hasText: /^Update$/ }).first().click();
        await p.waitForSelector("#qx-amount", { timeout: 10000 }); await p.waitForTimeout(300);
        assert(await notesBox(p).getAttribute("data-open") === "true", "collapsed although a note exists");
        assert((await p.inputValue("#qx-notes")) === "Paid in cash at branch", "saved note not shown");
        await p.locator("button", { hasText: /^Cancel$/ }).first().click(); await p.waitForTimeout(800);
      });
      await check("7. a record without a note opens with Notes collapsed", async () => {
        await api("/api/transactions", { method: "POST", token: admin, body: { clientName: "Walk-in", amountGiven: 12, currencyGiven: "USD" } });
        await p.reload(); await p.waitForSelector(".gk-sidebar", { state: "attached", timeout: 15000 }); await p.waitForTimeout(1500);
        await goExchange(p);
        await p.locator("button", { hasText: /^Update$/ }).first().click();
        await p.waitForSelector("#qx-amount", { timeout: 10000 }); await p.waitForTimeout(300);
        assert((await p.inputValue("#qx-amount")).replace(/,/g, "") === "12", "opened the wrong record");
        assert(await notesBox(p).getAttribute("data-open") === "false", "open although there's no note");
        assert(!(await p.locator("#qx-notes").count()), "input shown");
        await p.locator("button", { hasText: /^Cancel$/ }).first().click(); await p.waitForTimeout(800);
      });
      await check("9. Company Expenses uses the same collapsed Notes control", async () => {
        await p.locator(".gk-nav-btn", { hasText: "Company Expenses" }).first().click(); await p.waitForTimeout(1500);
        await p.locator("button", { hasText: "Add New Expense" }).click(); await p.waitForTimeout(300);
        const d = p.locator('[role="dialog"]').last();
        const box = d.locator(".gk-notes");
        assert(await box.count() === 1, `found ${await box.count()}`);
        assert(await box.getAttribute("data-open") === "false", "open by default");
        assert(!(await d.locator(".gk-notes textarea").count()), "textarea shown while collapsed");
        await d.locator(".gk-notes-head").click(); await p.waitForTimeout(200);
        const ta = d.locator(".gk-notes textarea");
        assert(await ta.isVisible(), "textarea not shown");
        assert(await ta.getAttribute("maxlength") === "2000", "maxLength lost");
      });
      await c.close();
    }
    {
      const { c, p } = await signIn({ width: 1366, height: 1000 }, "so");
      await check("Somali: the closed header reads 'Ku dar Qoraal (ikhtiyaari)'", async () => {
        await goExchange(p, "so"); await newExchange(p, "so");
        await p.click('button[aria-controls="qx-details"]'); await p.waitForTimeout(200);
        assert(/Ku dar Qoraal \(ikhtiyaari\)/.test(await notesHead(p).innerText()), await notesHead(p).innerText());
      });
      await c.close();
    }
    {
      const { c, p } = await signIn({ width: 390, height: 844 });
      await check("390px wide: Notes open with a long note, no sideways scrolling", async () => {
        await goExchange(p, null, true); await newExchange(p);
        await p.fill("#qx-amount", "100");
        await p.click('button[aria-controls="qx-details"]'); await notesHead(p).click(); await p.waitForTimeout(200);
        await p.fill("#qx-notes", "A very long reference note that keeps going ".repeat(4));
        await notesHead(p).click(); await p.waitForTimeout(200);
        assert(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "page scrolls sideways");
      });
      await c.close();
    }
    await check("no browser errors", async () => { assert(!errors.length, errors.slice(0, 3).join(" | ")); });
  } finally { await browser.close(); }
}

async function main() {
  await sourceAudit();
  console.log("Seeding a scratch installation...");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed.js")], { env: ENV, stdio: "ignore" });
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  let serverErr = "";
  srv.stderr.on("data", (d) => { serverErr += d.toString(); });
  try { await waitUp(); await apiChecks(); await browserChecks(); } finally { srv.kill(); }
  await new Promise((r) => setTimeout(r, 400));
  TESTDB.drop();
  const bad = serverErr.split("\n").filter((l) => /Unhandled error|Blocked data access/.test(l));
  if (bad.length) failures.push("server logged unexpected errors:\n      " + bad.join("\n      "));
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) { for (const f of failures) console.log(" - " + f); process.exit(1); }
}
main().catch((e) => { console.error(e); try { TESTDB.drop(); } catch (x) { /* ignore */ } process.exit(1); });
