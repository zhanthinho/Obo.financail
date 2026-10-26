"use strict";
// SECURITY AUDIT round: the published defaults (Demo123! / SuperAdmin123!)
// now force a password change at sign-in, so test installs are seeded with
// their own non-default passwords instead.
process.env.SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "Test-Demo-Pass-2026";
process.env.SUPER_ADMIN_INITIAL_PASSWORD = process.env.SUPER_ADMIN_INITIAL_PASSWORD || "Test-Super-Pass-2026";
const DEMO_PW = process.env.SEED_DEMO_PASSWORD;
const SA_PW = process.env.SUPER_ADMIN_INITIAL_PASSWORD;
// Real end-to-end smoke test: starts the server, drives an actual (headless)
// browser through login, each module, a role-restriction check, and a file
// download. Requires Playwright with a browser installed:
//   npm install --include=dev && npx playwright install chromium
// Run with: npm run test:e2e
const { spawn } = require("child_process");
const path = require("path");

const PORT = process.env.E2E_PORT || 4100;
const BASE = `http://localhost:${PORT}`;

function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch (e) { /* not up yet */ }
      if (Date.now() - start > timeoutMs) return reject(new Error("Server did not start in time"));
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (e) {
    console.error('Playwright is not installed. Run "npm install --include=dev && npx playwright install chromium".');
    process.exit(1);
  }

  console.log("Starting server on a scratch database...");
  // MYSQL round: a disposable MySQL database (test/helpers/mysql.js).
  const TESTDB = require("./helpers/mysql").createTestDatabase("e2e");
  const server = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "seed.js")], {
    env: { ...process.env, ...TESTDB.env },
    stdio: "inherit",
  });
  await new Promise((r) => server.on("exit", r));

  const srv = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { ...process.env, ...TESTDB.env, PORT: String(PORT) },
    stdio: "inherit",
  });

  try {
    await waitFor(`${BASE}/api/health`);
    console.log("Server is up. Launching browser...");

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const problems = [];
    page.on("pageerror", (err) => problems.push("Uncaught JS error: " + err.message));
    page.on("response", (res) => { if (res.status() >= 500) problems.push(`HTTP ${res.status()} ${res.url()}`); });

    async function check(label, fn) {
      process.stdout.write(`  ${label} ... `);
      await fn();
      console.log("ok");
    }
    // Sidebar groups stay expanded once opened (by design). Clicking an
    // already-open group toggles it shut, so tests that just need a group's
    // children visible should ensure-open rather than unconditionally click.
    async function ensureGroupOpen(groupName) {
      const header = page.getByRole("button", { name: groupName, exact: true });
      const expanded = await header.getAttribute("aria-expanded");
      if (expanded !== "true") {
        await header.click();
        await page.waitForTimeout(350);
      }
    }

    // FINAL QUOTATION MANAGEMENT SYSTEM: the sidebar's flat "Quotations" nav
    // button was replaced with a "Quotations" GROUP containing exactly three
    // submenus — Pending / Paid / Refunded — each a filtered view of the
    // same table. Scoped to that one group's own submenu so "Pending" etc.
    // can't accidentally match unrelated text elsewhere on the page.
    async function openQuotationSubmenu(statusLabel) {
      await ensureGroupOpen("Quotations");
      const group = page.locator('div:has(> button.gk-nav-group-header:has-text("Quotations"))').first();
      await group.locator('.gk-submenu button.gk-nav-btn', { hasText: statusLabel }).first().click();
      await page.waitForTimeout(350);
    }

    await page.goto(BASE, { waitUntil: "networkidle" });
    await check("login screen renders", () => page.waitForSelector("text=Geeska Exchange", { timeout: 5000 }));

    await page.fill('input[placeholder="e.g. amina.yusuf"]', "amina.yusuf");
    await page.fill('input[type="password"]', DEMO_PW);
    await page.click('button:has-text("Sign in")');
    await check("admin logs in and sees dashboard", () => page.waitForSelector("text=Welcome back", { timeout: 8000 }));

    // Topbar live clock — date + ticking time next to the hamburger
    await check("date and a live time are shown together in the topbar", async () => {
      await page.waitForSelector("text=/\\d{1,2} [A-Za-z]+ \\d{4}/", { timeout: 3000 });
      await page.waitForSelector("text=/\\d{2}:\\d{2}:\\d{2}/", { timeout: 3000 });
    });
    await check("the clock actually ticks (updates over time, isn't a static string)", async () => {
      const timeLocator = page.locator("text=/\\d{2}:\\d{2}:\\d{2}/").first();
      const before = await timeLocator.textContent();
      await page.waitForTimeout(2200);
      const after = await timeLocator.textContent();
      if (before === after) throw new Error("expected the topbar clock to have changed after 2+ seconds");
    });

    // Topbar: notification bell + profile menu
    await check("notification bell is present in the topbar with an unseen-count badge", async () => {
      await page.locator('[aria-label="Notifications"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(600); // let the initial fetch resolve
    });
    await check("clicking the bell opens a dropdown of recent activity", async () => {
      await page.click('[aria-label="Notifications"]');
      await page.waitForSelector("text=Recent updates", { timeout: 3000 });
      const count = await page.locator("text=Recent updates").locator("xpath=../..").locator("div").count();
      if (count === 0) throw new Error("expected at least one notification entry from the seeded audit log");
    });
    await check("clicking elsewhere closes the notification dropdown", async () => {
      await page.click("body", { position: { x: 5, y: 5 } });
      await page.waitForTimeout(200);
      const visible = await page.locator("text=Recent updates").isVisible().catch(() => false);
      if (visible) throw new Error("expected the dropdown to close after clicking outside it");
    });
    await check("profile menu shows the signed-in user's name and role, with initials avatar", () => page.waitForSelector("text=Amina Yusuf", { timeout: 3000 }));
    await check("clicking the profile menu opens a dropdown with Sign out", async () => {
      await page.click('[aria-label="Account menu"]');
      await page.waitForSelector('button:has-text("Sign out")', { timeout: 3000 });
      await page.click('[aria-label="Account menu"]'); // close it again — we're not signing out yet
      await page.waitForTimeout(200);
    });

    // Collapsible sidebar — desktop collapse/expand
    await check("sidebar starts expanded with nav labels visible", () => page.locator(".gk-sidebar[data-collapsed=\"false\"]").waitFor({ timeout: 3000 }));
    await check("desktop toggle (×) collapses the sidebar to icons only", async () => {
      await page.locator(".gk-sidebar-toggle.gk-desktop-only").click();
      await page.waitForTimeout(350); // let the CSS transition finish
      await page.locator(".gk-sidebar[data-collapsed=\"true\"]").waitFor({ timeout: 3000 });
      const sidebarBox = await page.locator(".gk-sidebar").boundingBox();
      if (sidebarBox.width > 90) throw new Error(`expected a narrow icons-only sidebar, got width ${sidebarBox.width}`);
    });
    await check("nav icons are still visible and clickable while collapsed", () => page.locator(".gk-sidebar button svg").first().waitFor({ timeout: 3000 }));
    await check("collapsed state persists across a reload", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("text=Welcome back", { timeout: 8000 });
      await page.locator(".gk-sidebar[data-collapsed=\"true\"]").waitFor({ timeout: 3000 });
    });
    await check("toggle (☰) expands the sidebar back", async () => {
      await page.locator(".gk-sidebar-toggle.gk-desktop-only").click();
      await page.waitForTimeout(350);
      await page.locator(".gk-sidebar[data-collapsed=\"false\"]").waitFor({ timeout: 3000 });
      const sidebarBox = await page.locator(".gk-sidebar").boundingBox();
      if (sidebarBox.width < 150) throw new Error(`expected the full sidebar back, got width ${sidebarBox.width}`);
    });
    await check("navigating still works normally after collapse/expand", async () => {
      await page.click('button:has-text("Money Exchange")');
      await page.waitForSelector("text=New transaction", { timeout: 5000 });
      await page.click('button:has-text("Dashboard")');
      await page.waitForSelector("text=Welcome back", { timeout: 5000 });
    });

    // Collapsible sidebar — mobile hamburger overlay
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(200);
    await check("on a narrow viewport, the sidebar is hidden off-canvas by default", async () => {
      const box = await page.locator(".gk-sidebar").boundingBox();
      if (box.x > -10) throw new Error(`expected the sidebar translated off-screen, got x=${box.x}`);
    });
    await check("mobile hamburger button is visible in the topbar", () => page.locator(".gk-mobile-hamburger").waitFor({ timeout: 3000, state: "visible" }));
    await check("tapping the hamburger slides the sidebar in as an overlay with a backdrop", async () => {
      await page.locator(".gk-mobile-hamburger").click();
      await page.waitForTimeout(350);
      const box = await page.locator(".gk-sidebar").boundingBox();
      if (box.x < -5) throw new Error(`expected the sidebar to have slid on-screen, got x=${box.x}`);
      await page.locator('.gk-mobile-backdrop[data-visible="true"]').waitFor({ timeout: 3000 });
    });
    await check("a clear × close button is visible while the mobile menu is open", () => page.locator('.gk-sidebar[data-mobile-open="true"] .gk-sidebar-toggle:visible').first().waitFor({ timeout: 3000 }));
    await check("clicking the backdrop closes the mobile menu", async () => {
      await page.locator(".gk-mobile-backdrop").click({ position: { x: 350, y: 400 } });
      await page.waitForTimeout(350);
      const box = await page.locator(".gk-sidebar").boundingBox();
      if (box.x > -10) throw new Error(`expected the sidebar to slide back off-screen, got x=${box.x}`);
    });
    await check("tapping a nav item on mobile navigates and auto-closes the menu", async () => {
      await page.locator(".gk-mobile-hamburger").click();
      await page.waitForTimeout(350);
      await page.click('button:has-text("Money Exchange")');
      await page.waitForSelector("text=New transaction", { timeout: 5000 });
      await page.waitForTimeout(350);
      const box = await page.locator(".gk-sidebar").boundingBox();
      if (box.x > -10) throw new Error("expected the mobile menu to auto-close after navigating");
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(200);

    await page.click('button:has-text("Money Exchange")');
    await check("exchange ledger loads", () => page.waitForSelector("text=New transaction", { timeout: 5000 }));
    await page.waitForTimeout(500);

    // Fund Hodan Hotel's USD account first (needed for the account-linked exchange test below)
    await ensureGroupOpen("Payment");
    await page.waitForTimeout(350);
    await page.click('button:has-text("USD Payment")');
    await page.waitForSelector("text=New USD deposit / withdrawal", { timeout: 5000 });
    await page.click('button:has-text("+ New USD deposit / withdrawal")');
    await page.waitForSelector("text=Search for a USD account");
    await page.fill('input[placeholder="Start typing…"]', "Hodan Hotel");
    await page.waitForTimeout(500);
    // Scoped to the open dialog — the background Payment ledger can also
    // render a "Hodan Hotel" account-name-link button in its rows, and an
    // unscoped locator can match that (obscured, unclickable) one instead.
    await page.getByRole("dialog").last().locator('button:has-text("Hodan Hotel"):not(:has-text("SLSH"))').click();
    await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("1000");
    await page.getByRole("dialog").last().getByRole("button", { name: "Deposit", exact: true }).last().click();
    await page.waitForTimeout(700);

    await page.click('button:has-text("Money Exchange")');
    await page.waitForSelector("text=New transaction", { timeout: 5000 });
    await page.click('button:has-text("New transaction")');
    await page.waitForSelector("text=New exchange transaction");
    const clientInput = page.getByRole("dialog").last().getByText("Client / customer name", { exact: true }).locator("xpath=following-sibling::input");
    await clientInput.fill("Hodan Hotel");
    await page.waitForTimeout(500);
    await check("account search suggestions appear while typing the client name", () => page.getByRole("dialog").last().locator('button:has-text("ACC-0002")').first().waitFor({ timeout: 3000 }));
    await check("search results are grouped into USD accounts / SLSH accounts", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("USD accounts", { exact: true }).waitFor({ timeout: 3000 });
      await dialog.getByText("SLSH accounts", { exact: true }).waitFor({ timeout: 3000 });
    });
    await page.getByRole("dialog").last().locator('button:has-text("ACC-0002")').first().click();
    await check("selecting an account shows FROM/TO boxes and locks the currency", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("FROM (debited)", { exact: true }).waitFor({ timeout: 3000 });
      await dialog.getByText("TO (credited)", { exact: true }).waitFor({ timeout: 3000 });
      const disabled = await dialog.locator("select").first().isDisabled();
      if (!disabled) throw new Error("currency selector should be locked once an account is selected");
    });
    await check("Date & time and Rate fields are present", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('input[type="datetime-local"]').waitFor({ timeout: 3000 });
      await dialog.locator('[aria-label="Rate"]').waitFor({ timeout: 3000 });
    });
    await check("swap button flips which account is FROM vs TO", async () => {
      const dialog = page.getByRole("dialog").last();
      const fromNameBefore = await dialog.locator('text=FROM (debited)').locator("xpath=following-sibling::div[1]").innerText();
      await dialog.locator('button[title="Swap given/received currency"]').click();
      await page.waitForTimeout(400);
      const fromNameAfter = await dialog.locator('text=FROM (debited)').locator("xpath=following-sibling::div[1]").innerText();
      if (fromNameBefore === fromNameAfter) throw new Error("expected swap to change which account is FROM");
    });
    await page.getByRole("dialog").last().locator('[aria-label="Amount given"]').fill("200");
    await page.getByRole("dialog").last().getByRole("button", { name: "Record transaction" }).click();
    await page.waitForTimeout(700);
    await check("account-linked exchange shows a Linked pill in the ledger", () => page.waitForSelector("text=/Linked · both accounts/", { timeout: 5000 }));
    await check("clicking anywhere in a linked exchange row (not just the name) opens that account's details", async () => {
      const row = page.locator('table tr:has-text("Hodan Hotel"):has-text("Linked")').first();
      await row.locator("td").nth(3).click(); // amount cell, not the name link
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("clicking Update on a linked exchange row opens the edit modal, not the account details (stopPropagation)", async () => {
      const row = page.locator('table tr:has-text("Hodan Hotel"):has-text("Linked")').first();
      await row.locator('button:has-text("Update")').click();
      await page.waitForSelector("text=Edit exchange transaction", { timeout: 5000 });
      if (await page.locator("text=Account summary").count() > 0) throw new Error("Update click should not also open Account Detail");
      await page.click('button:has-text("Cancel")');
      await page.waitForTimeout(300);
    });
    await check("a walk-in (non-linked) exchange row is not clickable", async () => {
      const row = page.locator('table tbody tr').filter({ hasNotText: "Linked" }).first();
      const cursor = await row.evaluate((el) => getComputedStyle(el).cursor);
      if (cursor === "pointer") throw new Error("expected a non-linked row to not have a pointer cursor");
    });

    // Sidebar grouping: Account / Payment / Transaction History are expandable groups
    await check("Account/Payment/Transaction History groups start collapsed with a chevron, not auto-expanded on an unrelated page", async () => {
      const chevron = page.locator('button.gk-nav-group-header:has-text("Account") .gk-nav-chevron');
      await chevron.waitFor({ timeout: 3000 });
      const open = await chevron.getAttribute("data-open");
      if (open === "true") throw new Error("Account group should not be expanded while on the Money Exchange page");
    });
    await check("clicking the Account group rotates its chevron and expands its two sub-items", async () => {
      const chevron = page.locator('button.gk-nav-group-header:has-text("Account") .gk-nav-chevron');
      await page.locator('button.gk-nav-group-header:has-text("Account")').click();
      await page.waitForTimeout(350);
      const open = await chevron.getAttribute("data-open");
      if (open !== "true") throw new Error("expected the chevron's data-open to flip to true after clicking");
      await page.locator('button:has-text("USD Accounts")').waitFor({ timeout: 3000, state: "visible" });
      await page.locator('button:has-text("SLSH Accounts")').waitFor({ timeout: 3000, state: "visible" });
    });
    await check("the Account group header stays visually active while a sub-page is open", async () => {
      await page.click('button:has-text("USD Accounts")');
      await page.waitForSelector("text=Add USD account", { timeout: 5000 });
      await page.waitForTimeout(250); // let the background-color transition settle before sampling it
      const header = page.locator('button.gk-nav-group-header:has-text("Account")');
      const bg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") throw new Error("expected the Account group header to show an active highlight while USD Accounts is open");
    });

    await page.click('button:has-text("SLSH Accounts")');
    await page.waitForSelector("text=Add SLSH account", { timeout: 5000 });
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("after the swap, Hodan Hotel's SLSH account (now FROM) actually dropped from the seeded 2,000,000", async () => {
      const text = await page.locator('table tr:has-text("Hodan Hotel (SLSH)")').innerText();
      if (text.includes("SLSH 2,000,000")) throw new Error("expected the SLSH balance to have decreased from the seeded 2,000,000");
    });
    await page.click('button:has-text("USD Accounts")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("Hodan Hotel's USD (now TO after swap) balance increased from the seeded 1,000.00", async () => {
      const text = await page.locator('table tr:has-text("ACC-0002")').innerText();
      if (text.includes("$1,000.00")) throw new Error("expected the USD balance to have changed from the seeded 1,000.00 after the swapped exchange credited it");
    });

    // EXCHANGE DELETE — PERMANENT FULL DATA DELETION: Void is gone entirely
    // from the Exchange module, replaced by a real permanent Delete that
    // reverses any real balance effect first, then removes the record and
    // its own ledger entries for good — no "Voided" status left behind.
    // Uses its own throwaway, freshly-linked account pair (built here via
    // direct API calls) rather than the Hodan Hotel pair the earlier
    // swap-exchange test just set up — later checks (SLSH Transaction
    // History) still depend on THAT exchange existing, so this section must
    // not touch it.
    await page.click('button:has-text("Money Exchange")');
    await page.waitForTimeout(600);
    await check('there is NO "Void" anywhere in the Exchange module — only Delete', async () => {
      const voidCount = await page.getByRole("button", { name: "Void", exact: true }).count();
      if (voidCount > 0) throw new Error(`expected zero "Void" buttons in the Exchange ledger, found ${voidCount}`);
      const statusOptions = await page.locator('select:near(:text("Status"))').first().locator("option").allInnerTexts();
      if (statusOptions.some((o) => /voided/i.test(o))) throw new Error(`expected the Status filter to have no "Voided" option, got: ${JSON.stringify(statusOptions)}`);
    });
    // EXCHANGE UPDATE — the spec's [Update] action alongside [Delete]. Since
    // this app has no separate Pending/Accepted step (every exchange posts
    // its effect immediately), editing an already-posted exchange has to
    // reverse the OLD ledger effect and re-apply the NEW one, same as
    // Delete reverses it. Uses its own throwaway, freshly-linked account
    // pair — independent of the Hodan Hotel pair and of the Delete Flow
    // fixture below — so this section can't interfere with either.
    const updateFlowLocator = 'table tr:has-text("Update Flow Test Co")';
    await check("(setup) a fresh, isolated, linked USD/SLSH account pair + one exchange between them, purely to test Update against", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const result = await page.evaluate(async (tok) => {
        const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
        const mk = (name, currency, openingBalance) => fetch("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name, accountType: "company", currency, openingBalance }) }).then((r) => r.json());
        const usd = await mk("Update Flow Test Co", "USD", 1000);
        const slsh = await mk("Update Flow Test Co (SLSH)", "SLSH", 2000000);
        await fetch(`/api/accounts/${usd.account.id}/link`, { method: "POST", headers, body: JSON.stringify({ targetAccountId: slsh.account.id }) });
        const txRes = await fetch("/api/transactions", { method: "POST", headers, body: JSON.stringify({ clientName: "Update Flow Test Co", clientAccountId: usd.account.id, amountGiven: 100, currencyGiven: "USD", rateUsed: 11500 }) });
        const created = (await txRes.json()).transaction;
        return { usdId: usd.account.id, slshId: slsh.account.id, txId: created.id };
      }, adminToken);
      if (!result.txId) throw new Error("expected the setup exchange transaction to be created");
    });
    // Same in-app-navigation refresh trick used below for the Delete Flow
    // fixture — avoids a full page.reload() collapsing the sidebar nav
    // groups that later steps assume are still open.
    await page.click('button:has-text("Reports")');
    await page.waitForSelector("text=Total transactions", { timeout: 5000 });
    await page.click('button:has-text("Money Exchange")');
    await page.waitForSelector("text=New transaction", { timeout: 5000 });
    await page.waitForTimeout(400);
    await check("Update opens a pre-filled 'Edit exchange transaction' modal (showing the linked FROM/TO account cards) with the existing amount — and Cancel leaves the transaction unchanged", async () => {
      const row = page.locator(updateFlowLocator).first();
      // .gk-icon-btn (not just ":has-text") — this row's own account is named
      // "Update Flow Test Co", so its gk-account-name-link button ALSO
      // matches ":has-text('Update')" and must be excluded explicitly.
      await row.locator('button.gk-icon-btn:has-text("Update")').click();
      await page.waitForSelector("text=Edit exchange transaction", { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("FROM (debited)", { exact: true }).waitFor({ timeout: 3000 });
      const givenValue = await dialog.locator('[aria-label="Amount given"]').inputValue();
      if (givenValue !== "100") throw new Error(`expected the Given amount to be pre-filled with the existing 100, got ${givenValue}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForTimeout(300);
      const unchanged = await page.locator(`${updateFlowLocator}:has-text("$100.00")`).count();
      if (unchanged === 0) throw new Error("Cancel must not change the transaction");
    });
    await check("Save changes edits the amounts AND updates both linked accounts' balances to reflect ONLY the new amounts (proves the OLD ledger effect was reversed, not left in place alongside the new one)", async () => {
      const row = page.locator(updateFlowLocator).first();
      await row.locator('button.gk-icon-btn:has-text("Update")').click();
      await page.waitForSelector("text=Edit exchange transaction", { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('[aria-label="Amount given"]').fill("250");
      await dialog.locator('[aria-label="Amount received"]').fill("2875000");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await page.waitForTimeout(700);
      await page.waitForSelector("text=/Exchange updated/", { timeout: 5000 }); // success toast
      await page.waitForSelector(`${updateFlowLocator}:has-text("$250.00")`, { timeout: 5000 });
    });
    await ensureGroupOpen("Account");
    await page.waitForTimeout(300);
    await page.click('button:has-text("USD Accounts")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("USD balance reflects ONLY the edited amount (1,000 opening − 250 new given = 750.00), not the old 100 debited a second time on top", () => page.waitForSelector('table tr:has-text("Update Flow Test Co"):has-text("$750.00")', { timeout: 5000 }));
    await page.click('button:has-text("SLSH Accounts")');
    await page.waitForTimeout(600);
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("SLSH balance reflects ONLY the edited received amount (2,000,000 opening + 2,875,000 new received = 4,875,000)", () => page.waitForSelector('table tr:has-text("Update Flow Test Co (SLSH)"):has-text("SLSH 4,875,000")', { timeout: 5000 }));
    await page.click('button:has-text("Money Exchange")');
    await page.waitForTimeout(500);
    await check("a direct API call confirms updating an exchange requires the exchangeUpdate permission specifically — a Cashier (exchangeCreate yes, exchangeUpdate no) is blocked with 403", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const anyActive = await page.evaluate(async (tok) => {
        const res = await fetch("/api/transactions?status=active", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.transactions[0];
      }, adminToken);
      if (!anyActive) throw new Error("expected at least one active exchange transaction to test against");
      const loginRes = await page.evaluate(async () => {
        const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "cabdi.maxamed", password: DEMO_PW }) });
        return res.json();
      });
      if (!loginRes.token) throw new Error("expected the seeded Cashier-role user (cabdi.maxamed) to log in successfully");
      const status = await page.evaluate(async ({ tok, id, body }) => {
        const res = await fetch(`/api/transactions/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return res.status;
      }, { tok: loginRes.token, id: anyActive.id, body: { clientName: anyActive.clientName, amountGiven: anyActive.amountGiven, currencyGiven: anyActive.currencyGiven } });
      if (status !== 403) throw new Error(`expected a Cashier-role user to be blocked from updating an exchange with 403, got ${status}`);
    });

    const deleteFlowLocator = 'table tr:has-text("Delete Flow Test Co")';
    await check("(setup) a fresh, isolated, linked USD/SLSH account pair + one exchange between them, purely to test Delete against — independent of the Hodan Hotel pair used above", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const result = await page.evaluate(async (tok) => {
        const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
        const mk = (name, currency, openingBalance) => fetch("/api/accounts", { method: "POST", headers, body: JSON.stringify({ name, accountType: "company", currency, openingBalance }) }).then((r) => r.json());
        const usd = await mk("Delete Flow Test Co", "USD", 1000);
        const slsh = await mk("Delete Flow Test Co (SLSH)", "SLSH", 2000000);
        await fetch(`/api/accounts/${usd.account.id}/link`, { method: "POST", headers, body: JSON.stringify({ targetAccountId: slsh.account.id }) });
        const txRes = await fetch("/api/transactions", { method: "POST", headers, body: JSON.stringify({ clientName: "Delete Flow Test Co", clientAccountId: usd.account.id, amountGiven: 100, currencyGiven: "USD" }) });
        const created = (await txRes.json()).transaction;
        return { usdId: usd.account.id, slshId: slsh.account.id, txId: created.id };
      }, adminToken);
      if (!result.txId) throw new Error("expected the setup exchange transaction to be created");
    });
    // Refetch the ledger to pick up the transaction created directly via API
    // above — navigating away and back remounts/refetches the Money
    // Exchange page without a full browser reload, which would otherwise
    // reset every sidebar group (Account/Payment/Transaction History) back
    // to collapsed and break later steps that assume they're still open.
    await page.click('button:has-text("Reports")');
    await page.waitForSelector("text=Total transactions", { timeout: 5000 });
    await page.click('button:has-text("Money Exchange")');
    await page.waitForSelector("text=New transaction", { timeout: 5000 });
    await page.waitForTimeout(400);
    await check("Delete opens a confirmation modal titled 'Delete Exchange Permanently?' showing client/date/given/received/accounts/status, with Cancel + Delete Permanently buttons — and Cancel leaves the transaction untouched", async () => {
      const row = page.locator(deleteFlowLocator).first();
      // .gk-icon-btn — this row's account is named "Delete Flow Test Co",
      // so its gk-account-name-link button also matches ":has-text('Delete')".
      await row.locator('button.gk-icon-btn:has-text("Delete")').click();
      await page.waitForSelector("text=Delete Exchange Permanently?", { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("Linked · both accounts", { exact: true }).waitFor({ timeout: 3000 });
      await dialog.getByText(/This action will permanently delete this Exchange/).waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForTimeout(300);
      const stillThere = await page.locator(deleteFlowLocator).count();
      if (stillThere === 0) throw new Error("Cancel must not delete the transaction");
    });
    await check("Delete Permanently reverses the real balance movement on both linked accounts AND permanently removes the record (not just marks it Voided)", async () => {
      await page.locator(deleteFlowLocator).first().locator('button.gk-icon-btn:has-text("Delete")').click();
      await page.waitForSelector("text=Delete Exchange Permanently?", { timeout: 3000 });
      await page.getByRole("dialog").last().getByRole("button", { name: "Delete Permanently", exact: true }).click();
      await page.waitForTimeout(700);
      await page.waitForSelector("text=/permanently deleted/", { timeout: 5000 }); // success toast
      const stillThere = await page.locator(deleteFlowLocator).count();
      if (stillThere > 0) throw new Error("expected the deleted exchange to be completely gone from the ledger, not just marked Voided");
    });
    // ensureGroupOpen is a no-op if the Account group is already expanded
    // (as it should still be, from earlier in this flow) — kept here as a
    // safety net since the exact nav state at this point depends on steps
    // above it.
    await ensureGroupOpen("Account");
    await page.waitForTimeout(300);
    await page.click('button:has-text("USD Accounts")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("USD balance reverted back to its pre-exchange 1,000.00 after deleting", () => page.waitForSelector('table tr:has-text("Delete Flow Test Co"):has-text("$1,000.00")', { timeout: 5000 }));
    await page.click('button:has-text("SLSH Accounts")');
    await page.waitForTimeout(600);
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("SLSH balance reverted back to its pre-exchange 2,000,000 after deleting", () => page.waitForSelector('table tr:has-text("Delete Flow Test Co"):has-text("SLSH 2,000,000")', { timeout: 5000 }));
    await page.click('button:has-text("Money Exchange")');
    await page.waitForTimeout(500);
    await check("a direct API call confirms deleting an exchange requires the exchangeDelete permission specifically — a Cashier (exchangeCreate yes, exchangeDelete no) is blocked with 403", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const anyActive = await page.evaluate(async (tok) => {
        const res = await fetch("/api/transactions?status=active", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.transactions[0];
      }, adminToken);
      if (!anyActive) throw new Error("expected at least one active exchange transaction to test against");
      const loginRes = await page.evaluate(async () => {
        const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "cabdi.maxamed", password: DEMO_PW }) });
        return res.json();
      });
      if (!loginRes.token) throw new Error("expected the seeded Cashier-role user (cabdi.maxamed) to log in successfully");
      const status = await page.evaluate(async ({ tok, id }) => {
        const res = await fetch(`/api/transactions/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
        return res.status;
      }, { tok: loginRes.token, id: anyActive.id });
      if (status !== 403) throw new Error(`expected a Cashier-role user to be blocked from deleting an exchange with 403, got ${status}`);
    });
    await check("a direct API call confirms deleting the SAME exchange twice fails cleanly the second time — DELETE ALL RELATED DATA + PREVENT DOUBLE DELETE together, not a double reversal", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      // Create a fresh, disposable, unlinked exchange (no account effect to
      // reverse) purely to delete it twice — isolated from every other
      // transaction this suite depends on for later checks.
      const created = await page.evaluate(async (tok) => {
        const res = await fetch("/api/transactions", {
          method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ clientName: "Double Delete Test", amountGiven: 5, currencyGiven: "USD", rateUsed: 9000 }),
        });
        return (await res.json()).transaction;
      }, adminToken);
      if (!created?.id) throw new Error("expected the disposable double-delete test transaction to be created");
      const [firstStatus, secondStatus] = await page.evaluate(async ({ tok, id }) => {
        const del = () => fetch(`/api/transactions/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.status);
        const first = await del();
        const second = await del();
        return [first, second];
      }, { tok: adminToken, id: created.id });
      if (firstStatus !== 200) throw new Error(`expected the first delete to succeed with 200, got ${firstStatus}`);
      if (secondStatus !== 404) throw new Error(`expected the second delete of an already-gone transaction to fail cleanly with 404, got ${secondStatus}`);
    });

    await page.click('button:has-text("Money Exchange")');
    await page.waitForTimeout(500);
    await check("custom Rate and backdated Date are respected for a walk-in (non-linked) client", async () => {
      await page.click('button:has-text("New transaction")');
      await page.waitForSelector("text=New exchange transaction");
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("Client / customer name", { exact: true }).locator("xpath=following-sibling::input").fill("Rate Test Walkin");
      await dialog.locator('[aria-label="Amount given"]').fill("10");
      await dialog.locator('[aria-label="Rate"]').fill("9999");
      await dialog.locator('input[type="datetime-local"]').fill("2026-01-15T09:30");
      await dialog.getByRole("button", { name: "Record transaction" }).click();
      await page.waitForTimeout(700);
      await page.waitForSelector("text=Rate Test Walkin", { timeout: 5000 });
      await page.waitForSelector('table >> text=/SLSH 99,990/', { timeout: 3000 }); // 10 * 9999
      await page.waitForSelector("text=/15 Jan 2026/", { timeout: 3000 });
    });

    await check("clicking a column header actually re-sorts the table", async () => {
      const firstClientBefore = await page.locator("table tbody tr").first().locator("td").nth(1).textContent();
      await page.locator('th:has-text("Client")').first().click();
      await page.waitForTimeout(150);
      const firstClientAfterAsc = await page.locator("table tbody tr").first().locator("td").nth(1).textContent();
      await page.locator('th:has-text("Client")').first().click();
      await page.waitForTimeout(150);
      const firstClientAfterDesc = await page.locator("table tbody tr").first().locator("td").nth(1).textContent();
      if (firstClientAfterAsc === firstClientAfterDesc) throw new Error("sorting the same column ascending vs descending produced identical order");
      if (firstClientBefore === firstClientAfterAsc && firstClientBefore === firstClientAfterDesc) throw new Error("clicking the sort header had no visible effect at all");
    });

    await check("active filter chips appear once a filter is set, and are absent when none are set", async () => {
      const beforeCount = await page.locator("text=Active filters:").count();
      if (beforeCount !== 0) throw new Error("expected no active-filter chips before any filter is set");
      await page.getByText("Client", { exact: true }).locator("xpath=following-sibling::div//input").fill("Rate Test");
      await page.waitForTimeout(500);
      await page.waitForSelector("text=Active filters:", { timeout: 3000 });
      await page.waitForSelector('span:has-text("Client: Rate Test")', { timeout: 3000 });
    });
    await check("clicking the × on a chip clears just that filter", async () => {
      await page.locator('span:has-text("Client: Rate Test") button').click();
      await page.waitForTimeout(400);
      const clientValue = await page.getByText("Client", { exact: true }).locator("xpath=following-sibling::div//input").inputValue();
      if (clientValue !== "") throw new Error("expected the Client filter to be cleared");
    });
    await check("Clear all removes every active filter at once", async () => {
      await page.getByText("Client", { exact: true }).locator("xpath=following-sibling::div//input").fill("Rate Test");
      await page.locator('select:near(:text("Status"))').selectOption("active").catch(() => {});
      await page.waitForTimeout(500);
      await page.waitForSelector("text=Active filters:", { timeout: 3000 });
      await page.click('button:has-text("Clear all")');
      await page.waitForTimeout(400);
      const count = await page.locator("text=Active filters:").count();
      if (count !== 0) throw new Error("expected all active-filter chips to disappear after Clear all");
    });

    await check("the exchange ledger table has a bold Total footer with separate USD/SLSH given+received figures, never combined into one number", async () => {
      const footText = await page.locator("table tfoot").innerText();
      if (!/Total/.test(footText)) throw new Error("expected a 'Total' label in the exchange footer");
      if (!/\$/.test(footText) || !/SLSH/.test(footText)) throw new Error(`expected both a $ and a SLSH figure in the exchange footer — got: ${JSON.stringify(footText)}`);
      const footRowInTbody = await page.locator("table tbody tr:has-text('Total')").count();
      if (footRowInTbody > 0) throw new Error("exchange footer total leaked into tbody rows");
    });

    // -----------------------------------------------------------------
    // RATE MANAGEMENT UNIFICATION round — the old separate Daily Rate
    // section + Sale Rate section (each with its own stat strip and its
    // own history table) are gone: this is now ONE "Recent Rate History"
    // interface — one summary strip, one searchable/filterable/sortable
    // table, one "Set Rates" action — backed by the unified rate_history
    // table (one history record per save, never two). Still logged in as
    // amina.yusuf / Admin (has rateManage). No check earlier in this suite
    // ever POSTs to /api/rate-history, so the Sale Rate is still genuinely
    // unset at this point — exercising the real "never set yet" state.
    // -----------------------------------------------------------------
    let dailyRateAtTest = null;
    await check("Rate history tab shows the unified Exchange Rates summary (Sale Rate correctly unset by default)", async () => {
      await page.click('button:has-text("Rate history")');
      await page.waitForSelector("text=Current Daily Rate", { timeout: 3000 });
      await page.waitForSelector("text=Current Sale Rate", { timeout: 3000 });
      await page.waitForSelector("text=Current Spread", { timeout: 3000 });
      await page.waitForSelector("text=Not set", { timeout: 3000 }); // the "Current Sale Rate" stat card
      const rowCount = await page.locator("table.gk-table tbody tr").count();
      if (rowCount === 0) throw new Error("expected at least one seeded rate-history row");
      const bodyText = await page.locator("body").innerText();
      const m = bodyText.match(/Current Daily Rate\s*SLSH\s*([\d,]+)/);
      if (!m) throw new Error("could not read the current Daily Rate from the summary strip");
      dailyRateAtTest = Number(m[1].replace(/,/g, ""));
    });
    await check("Set Rates modal opens, computes the Rate Difference live, and saves both rates as ONE unified history record", async () => {
      await page.click('button:has-text("Set Rates")');
      await page.waitForSelector("text=Manage Exchange Rates");
      const dialog = page.getByRole("dialog", { name: "Manage Exchange Rates" });
      const numberInputs = dialog.locator('input[type="number"]');
      await numberInputs.nth(0).fill(String(dailyRateAtTest)); // Daily Rate — left unchanged
      await numberInputs.nth(1).fill("8650"); // Sale Rate
      await page.waitForTimeout(200);
      const expectedDiff = dailyRateAtTest - 8650;
      await page.waitForSelector(`text=/Rate Difference:\\s*\\+?${expectedDiff}\\s*SLSH/`, { timeout: 3000 }); // computed live, not typed
      await dialog.getByRole("button", { name: "Save Rates", exact: true }).click();
      await page.waitForTimeout(500);
      await page.waitForSelector("text=Exchange rates updated.", { timeout: 3000 });
      await page.waitForSelector("text=/Current Sale Rate/", { timeout: 3000 });
      await page.waitForSelector("text=/SLSH\\s*8,650/", { timeout: 3000 });
      const firstRow = page.locator("table.gk-table tbody tr").first();
      const firstRowText = await firstRow.innerText();
      // ONE combined row, not two: the SAME newest row must show both
      // values together (spec point 11 — a save always snapshots both
      // sides into a single record, never two separate ones).
      if (!firstRowText.includes(dailyRateAtTest.toLocaleString("en-US")) || !firstRowText.includes("8,650")) {
        throw new Error(`expected the newest unified history row to show BOTH the Daily Rate and the new Sale Rate together — got: ${firstRowText}`);
      }
      if (!firstRowText.includes("Active")) throw new Error("expected the newest row to be marked Active");
    });
    // Follow-up: the unified header card AND the Dashboard both show the
    // same Daily/Sale/Spread summary with a single "Manage Rates" control
    // (gated by rateManage — the Sale Rate is a back-office figure).
    await check("topbar header shows the unified Exchange Rates card (Daily/Sale/Spread) with a single Manage Rates control", async () => {
      const headerText = await page.locator("body").innerText();
      if (!/EXCHANGE RATES/.test(headerText)) throw new Error("expected the 'EXCHANGE RATES' label in the header");
      if (!headerText.includes(`Daily ${dailyRateAtTest.toLocaleString("en-US")}`)) throw new Error("expected the header to show the current Daily Rate");
      if (!headerText.includes("Sale 8,650")) throw new Error("expected the header to show the new Sale Rate");
      const headerManageButtons = await page.locator('button:has-text("Manage Rates")').count();
      if (headerManageButtons < 1) throw new Error("expected a 'Manage Rates' button in the header");
    });
    await check("Dashboard also shows the unified Sale Rate + Spread with its own Manage Rates control", async () => {
      await page.click('button:has-text("Dashboard")');
      await page.waitForSelector("text=Welcome back", { timeout: 5000 });
      await page.waitForSelector("text=/Sale rate:\\s*SLSH\\s*8,650/", { timeout: 3000 });
      const manageButtons = await page.locator('button:has-text("Manage Rates")').count();
      if (manageButtons < 2) throw new Error("expected 'Manage Rates' buttons in both the header and the Dashboard card");
      await page.click('button:has-text("Money Exchange")');
      await page.waitForTimeout(300);
    });
    await page.getByRole("button", { name: "Transactions", exact: true }).click();
    await page.waitForTimeout(300);
    await check("New exchange transaction: Profit auto-calculates live from the Sale Rate spread as Amount given changes", async () => {
      await page.click('button:has-text("New transaction")');
      await page.waitForSelector("text=New exchange transaction");
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("Client / customer name", { exact: true }).locator("xpath=following-sibling::input").fill("Sale Rate Profit Test");
      await dialog.locator('[aria-label="Amount given"]').fill("100");
      await page.waitForTimeout(400);
      const profitField = dialog.locator('label:text-is("Profit / margin (USD)")').locator("xpath=following-sibling::input");
      const val = Number(await profitField.inputValue());
      const expected = 100 * (dailyRateAtTest - 8650) / 8650;
      if (Math.abs(val - expected) > 0.02) throw new Error(`expected auto-profit ~${expected.toFixed(2)} (Daily ${dailyRateAtTest} vs Sale 8650), got ${val}`);
      await page.waitForSelector("text=Auto-calculated from the Sale Rate spread", { timeout: 3000 });
    });
    await check("manually editing Profit shows a 'Use automatic value' link, which reverts it back to live-tracking", async () => {
      const dialog = page.getByRole("dialog").last();
      const profitField = dialog.locator('label:text-is("Profit / margin (USD)")').locator("xpath=following-sibling::input");
      await profitField.fill("777");
      await page.waitForTimeout(150);
      await page.waitForSelector("text=Manually set — not tracking the Sale Rate spread.", { timeout: 3000 });
      const useAutoBtn = page.locator('button:has-text("Use automatic value")');
      await useAutoBtn.waitFor({ timeout: 3000 });
      await useAutoBtn.click();
      await page.waitForTimeout(150);
      const val = Number(await profitField.inputValue());
      const expected = 100 * (dailyRateAtTest - 8650) / 8650;
      if (Math.abs(val - expected) > 0.02) throw new Error(`expected reverting to auto-profit ~${expected.toFixed(2)}, got ${val}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    });

    // ================= TABLE CUSTOMIZATION (Round 2) — same reusable "⚙
    // Customize table" system from Round 1, now also wired into the Money
    // Exchange ledger, Payment (Deposits & Withdrawals), and Quotations
    // tables. One full open/hide/save/verify/reset pass here on the
    // Exchange ledger (its footer is column-key-driven, the most complex of
    // the three) stands in for all of them — the identical component and
    // API path is already proven end-to-end by the Round 1 Users coverage
    // above, and `test/rbac.js` separately confirms all 4 new table keys
    // (exchange, payments.usd, payments.slsh, quotations) are wired into
    // the backend's VALID_TABLE_KEYS with the same permission gating. =================
    await check("⚙ Customize table is available on the Exchange ledger; required Client column is locked", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      const clientCheckbox = page.locator('button[aria-label="Move Client up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (await clientCheckbox.isEnabled()) throw new Error("expected the required Client column's checkbox to be disabled");
      const rateCheckbox = page.locator('button[aria-label="Move Rate up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (!(await rateCheckbox.isEnabled())) throw new Error("expected the non-required Rate column's checkbox to be enabled");
      await rateCheckbox.click();
      await page.click('button:has-text("Save my layout")');
      await page.waitForSelector("text=Your layout was saved.", { timeout: 5000 });
    });
    await check("hiding Rate via Customize table actually removes it from the live ledger header", async () => {
      const headText = (await page.locator("table thead").innerText()).toUpperCase();
      if (/\bRATE\b/.test(headText)) throw new Error(`expected Rate to be hidden from the ledger header, got: ${JSON.stringify(headText)}`);
      if (!/GIVEN/.test(headText) || !/RECEIVED/.test(headText)) throw new Error(`expected Given/Received to remain visible, got: ${JSON.stringify(headText)}`);
    });
    await check("Reset to default brings Rate back", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      await page.click('button:has-text("Reset to default")');
      await page.waitForSelector("text=Your layout was reset to the shipped default.", { timeout: 5000 });
      const headText = (await page.locator("table thead").innerText()).toUpperCase();
      if (!/\bRATE\b/.test(headText)) throw new Error(`expected Rate back after reset, got: ${JSON.stringify(headText)}`);
    });

    await openQuotationSubmenu("Pending");
    await check("Pending quotations list loads", () => page.waitForSelector("text=New quotation", { timeout: 5000 }));
    await check("Pending Quotations shows a count + Total (USD)/(SLSH) stat strip", async () => {
      await page.waitForSelector("text=Pending quotations", { timeout: 3000 });
      await page.waitForSelector("text=Total (USD)", { timeout: 3000 });
      await page.waitForSelector("text=Total (SLSH)", { timeout: 3000 });
    });
    await check("the three-submenu QUOTATION nav has exactly Pending/Paid/Refunded — no 'All' tab", async () => {
      const group = page.locator('div:has(> button.gk-nav-group-header:has-text("Quotations"))').first();
      const labels = await group.locator(".gk-submenu button.gk-nav-btn").allInnerTexts();
      const allCount = labels.filter((t) => /\ball\b/i.test(t)).length;
      if (allCount > 0) throw new Error(`expected no "All" submenu — got labels: ${JSON.stringify(labels)}`);
      if (labels.length !== 3) throw new Error(`expected exactly 3 submenus (Pending/Paid/Refunded), got ${labels.length}: ${JSON.stringify(labels)}`);
    });
    // GLOBAL TABLE UX round — CORRECTED behavior: the quotation row's own
    // click now opens the QUOTATION's own Detail view (matching every other
    // table's "row click opens this table's own record" convention), not
    // Account Detail. The chargedAccount name is a separate, stopPropagation'd
    // link inside the row that still jumps to Account Detail on its own.
    await check("clicking a quotation row (not the account-name link) opens the QUOTATION Detail view, not Account Detail", async () => {
      const row = page.locator("table tbody tr").first();
      const qNumber = (await row.locator("td").nth(1).innerText()).trim();
      await row.locator("td").nth(2).click(); // Issue date cell, not the name link
      await page.waitForSelector(`text=Quotation ${qNumber}`, { timeout: 5000 });
      if (await page.locator("text=Account summary").count() > 0) throw new Error("Quotation row click incorrectly opened Account Detail");
    });
    await check("Quotation Detail shows the full required field set (Reference/Status/Account/Currency/Rate/Date/Valid Until/Created By/Created Date/Updated By/Updated Date/Note) plus Items and a Subtotal/Discount/Tax/Total breakdown", async () => {
      const dlg = page.getByRole("dialog").last();
      for (const label of ["Reference", "Status", "Account", "Currency", "Rate", "Valid Until", "Created By", "Created Date", "Updated By", "Updated Date", "Note", "Items", "Subtotal", "Discount", "Tax", "Total"]) {
        await dlg.locator(`text=${label}`).first().waitFor({ timeout: 3000 });
      }
    });
    await check("a never-edited quotation shows a dash for Updated By/Updated Date rather than a blank", async () => {
      const dlg = page.getByRole("dialog").last();
      const text = await dlg.innerText();
      if (!/Updated By[\s\S]{0,20}—/.test(text) && !/Updated Date[\s\S]{0,20}—/.test(text)) {
        throw new Error("expected a dash placeholder for an unedited quotation's Updated By/Date");
      }
    });
    await check("Update and Delete actions are present on the Quotation Detail view for a permitted role", async () => {
      const dlg = page.getByRole("dialog").last();
      await dlg.locator('button:has-text("Update")').waitFor({ timeout: 3000 });
      await dlg.locator('button:has-text("Delete")').waitFor({ timeout: 3000 });
    });
    await check("Close dismisses the Quotation Detail view", async () => {
      await page.getByRole("dialog").last().locator('button:has-text("Close")').click();
      await page.waitForTimeout(300);
    });
    await check("clicking View on a quotation row opens the SAME quotation's Detail view as the row click did", async () => {
      const row = page.locator("table tbody tr").first();
      const qNumber = (await row.locator("td").nth(1).innerText()).trim();
      await row.locator('button:has-text("View")').click();
      await page.waitForSelector(`text=Quotation ${qNumber}`, { timeout: 5000 });
      if (await page.locator("text=Account summary").count() > 0) throw new Error("View click should not also open Account Detail");
      await page.getByRole("dialog").last().locator('button:has-text("Close")').click();
      await page.waitForTimeout(300);
    });
    await check("clicking the account-name link inside a quotation row opens Account Detail instead (stopPropagation) — no double navigation, only one dialog open", async () => {
      const row = page.locator("table tbody tr").first();
      const nameLinkCount = await row.locator("button.gk-account-name-link").count();
      if (nameLinkCount === 0) throw new Error("expected the seeded pending quotation to have a chargedAccount name-link");
      await row.locator("button.gk-account-name-link").click();
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      const dialogCount = await page.getByRole("dialog").count();
      if (dialogCount !== 1) throw new Error(`expected exactly one dialog open after the name-link click, got ${dialogCount}`);
      if (await page.locator("text=Subtotal").count() > 0) throw new Error("name-link click should not also open Quotation Detail");
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("no leftover 'Open...' tooltip on a quotation row (per spec: no such tooltip anywhere)", async () => {
      const html = await page.content();
      if (/title="Open account details"/.test(html) || /title="Open [^"]*'s account details"/.test(html)) {
        throw new Error("found a leftover 'Open...' tooltip");
      }
    });
    await check("the Pending Quotations table shows a bold Balance/Total summary footer, never confused with a real row (not part of the tbody)", async () => {
      const tfootCount = await page.locator("table tfoot").count();
      if (tfootCount === 0) throw new Error("expected a tfoot summary row on the quotations table");
      const footRowInTbody = await page.locator("table tbody tr:has-text('Total')").count();
      if (footRowInTbody > 0) throw new Error("footer total leaked into tbody rows");
    });

    // Quotation editor: editable dates, Set Rate modal, dynamic columns
    await page.click('button:has-text("New quotation")');
    await page.waitForSelector("text=New quotation", { timeout: 5000 });
    await check("Issue date defaults to today and Valid until is empty/editable", async () => {
      const issueVal = await page.getByText("Issue date", { exact: true }).locator("xpath=following-sibling::input").inputValue();
      if (!issueVal) throw new Error("expected Issue date to default to today's date");
      await page.getByText("Valid until", { exact: true }).locator("xpath=following-sibling::input").fill("2026-12-31");
    });
    await check("exchange rate is shown with a Set Rate button", () => page.waitForSelector('button:has-text("Set Rate")', { timeout: 3000 }));
    await check("Account to charge is required, with its own independent search", () => page.waitForSelector("text=Account to charge", { timeout: 3000 }));

    // ACCOUNT / CLIENT SEARCH — CURRENCY SEPARATION: the seed data gives
    // "Hodan Hotel" a separate, linked "Hodan Hotel (SLSH)" account — same
    // client, two distinct account records in different currencies. That
    // makes it the perfect real-data case to prove USD/SLSH never mix in
    // either the Client-name search or the Account-to-charge search.
    const clientNameField = page.getByText("Client name", { exact: true }).locator("xpath=following-sibling::input");
    const usdToggle = page.getByRole("button", { name: "USD", exact: true }).first();
    const slshToggle = page.getByRole("button", { name: "SLSH", exact: true }).first();
    await check("Currency selector defaults to USD", () => usdToggle.waitFor({ timeout: 3000 }));
    await check("Client-name search scoped to USD shows only Hodan Hotel's USD account — never its separate SLSH account", async () => {
      await clientNameField.fill("Hodan Hotel");
      await page.waitForTimeout(500);
      const names = await page.locator('button:has-text("Hodan Hotel")').allInnerTexts();
      if (names.length !== 1) throw new Error(`expected exactly 1 client search result, got ${names.length}: ${JSON.stringify(names)}`);
      if (/SLSH/.test(names[0])) throw new Error(`USD-scoped client search must not surface the SLSH account, got: ${names[0]}`);
      if (!/USD/.test(names[0])) throw new Error(`expected a USD currency badge on the result, got: ${names[0]}`);
    });
    await check("Switching the Currency selector to SLSH updates the (still open) client-name search live to show only the SLSH account", async () => {
      await slshToggle.click();
      await page.waitForTimeout(500);
      const names = await page.locator('button:has-text("Hodan Hotel")').allInnerTexts();
      if (names.length !== 1) throw new Error(`expected exactly 1 client search result after switching to SLSH, got ${names.length}: ${JSON.stringify(names)}`);
      if (!/SLSH/.test(names[0])) throw new Error(`SLSH-scoped client search must show the SLSH account, got: ${names[0]}`);
      if (/USD/.test(names[0])) throw new Error(`SLSH-scoped client search must not surface the USD account, got: ${names[0]}`);
    });
    // Close the client-name dropdown before exercising the Account-to-charge
    // box's OWN independent search below, so its "Hodan Hotel" results can't
    // collide with an unrelated still-open client-name dropdown.
    await clientNameField.fill("");
    await page.waitForTimeout(300);
    await check('Empty state reads "No SLSH account found." — never falls back to another currency', async () => {
      const accountSearch = page.getByPlaceholder("Search SLSH accounts by name, number, or phone…");
      await accountSearch.fill("Zzz-Nonexistent-Query-000");
      await page.waitForTimeout(500);
      await page.waitForSelector("text=No SLSH account found.", { timeout: 3000 });
      await accountSearch.fill("");
    });
    await check("Account-to-charge's own independent search, scoped to SLSH, selecting Hodan Hotel's SLSH account works", async () => {
      const accountSearch = page.getByPlaceholder("Search SLSH accounts by name, number, or phone…");
      await accountSearch.fill("Hodan Hotel");
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Hodan Hotel (SLSH)")').first().click();
      await page.waitForSelector('button:has-text("Change")', { timeout: 3000 });
      await page.waitForSelector("text=/ACC-/", { timeout: 3000 });
    });
    await check("AUTO-CLEAR INVALID SELECTION: switching Currency back to USD after an account was selected clears it, forcing a fresh (correctly-scoped) selection", async () => {
      await usdToggle.click();
      await page.waitForTimeout(300);
      // Back to the search box — the previously-selected SLSH account and its
      // "Change" button must be gone.
      const changeBtnCount = await page.getByRole("button", { name: "Change", exact: true }).count();
      if (changeBtnCount > 0) throw new Error("expected the SLSH account selection to be auto-cleared after switching to USD");
      await page.waitForSelector('input[placeholder="Search USD accounts by name, number, or phone…"]', { timeout: 3000 });
    });
    // The client/account fields are already empty at this point (both were
    // cleared above), so the rest of this section's flow can drive its own
    // client name straight away.
    const clientField = clientNameField;
    await clientField.fill("Column Test Co");
    const descInput = page.locator('input[placeholder="Description"]').first();
    await descInput.fill("Test Widget");
    await page.locator('input[placeholder="Qty"]').first().fill("3");
    await page.locator('input[placeholder="Unit price"]').first().fill("20");

    await check("Set Rate modal opens, validates, and updates the total when saved", async () => {
      await page.getByRole("button", { name: "Set Rate", exact: true }).click();
      await page.waitForSelector("text=Set exchange rate for this quotation");
      const rateInput = page.locator("#gk-rate-input");
      await rateInput.fill("0");
      page.once("dialog", (d) => d.accept());
      await page.getByRole("dialog").last().getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(300);
      const stillOpen = await page.locator("text=Set exchange rate for this quotation").isVisible().catch(() => false);
      if (!stillOpen) { await page.getByRole("button", { name: "Set Rate", exact: true }).click(); await page.waitForSelector("text=Set exchange rate for this quotation"); }
      await page.locator("#gk-rate-input").fill("10000");
      await page.getByRole("dialog").last().getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(300);
      await page.waitForSelector("text=/1 USD = SLSH 10,000/", { timeout: 3000 });
      await page.waitForSelector("text=/\\$60\\.00/", { timeout: 3000 }); // 3 * 20 = 60 USD total
    });

    await check("Customize Columns opens and shows the default + optional columns", async () => {
      await page.click('button:has-text("Customize Columns")');
      await page.waitForSelector("text=Customize columns", { timeout: 3000 });
      await page.waitForSelector("text=Hidden columns", { timeout: 3000 });
      await page.waitForSelector('button:has-text("+ SKU")', { timeout: 3000 });
    });
    await check("enabling the SKU column adds it to the line items table", async () => {
      await page.click('button:has-text("+ SKU")');
      await page.waitForTimeout(300);
      await page.locator('th:has-text("SKU")').first().waitFor({ timeout: 3000 });
    });
    await check("adding a custom column makes it appear in the table immediately", async () => {
      await page.getByPlaceholder("New column name (e.g. Brand)").fill("Brand");
      await page.click('button:has-text("+ Add")');
      await page.waitForTimeout(300);
      await page.locator('th:has-text("Brand")').first().waitFor({ timeout: 3000 });
    });
    await check("data entered into a custom column is preserved (not lost when toggled)", async () => {
      const brandColIndex = await page.locator("th").allTextContents();
      const idx = brandColIndex.findIndex((t) => t.includes("Brand"));
      const brandInput = page.locator("table tbody tr").first().locator("td").nth(idx).locator("input");
      await brandInput.fill("Acme");
      await page.waitForTimeout(200);
      const val = await brandInput.inputValue();
      if (val !== "Acme") throw new Error("expected the custom column's typed value to stick");
    });
    await check("Save as default persists the column layout to the backend", async () => {
      await page.getByRole("button", { name: "Save as default", exact: true }).click();
      await page.waitForSelector("text=/Column layout saved/", { timeout: 5000 });
    });
    await check("Restore defaults resets the visible columns", async () => {
      await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
      await page.waitForTimeout(300);
      const count = await page.locator('th:has-text("SKU")').count();
      if (count > 0) throw new Error("expected SKU column to be hidden again after Restore defaults");
    });
    await page.click('[aria-label="Close column customizer"]'); // close the column panel before leaving
    await page.waitForTimeout(200);

    await check("saving without an account to charge is blocked with a clear message", async () => {
      let message = null;
      page.once("dialog", (d) => { message = d.message(); d.accept(); });
      await page.getByRole("button", { name: "Save quotation" }).click();
      await page.waitForTimeout(300);
      if (!message || !/account to charge/i.test(message)) throw new Error(`expected an "account to charge" validation message, got: ${message}`);
      // still on the editor — nothing was created
      await page.waitForSelector("text=New quotation", { timeout: 3000 });
    });

    let hodanBalanceBeforeCharge;
    let chargeTestQuoteNumber;
    const hodanBalanceNow = async () => {
      await page.click('button:has-text("USD Accounts")');
      await page.waitForSelector("text=Add USD account", { timeout: 5000 });
      await page.click('button:has-text("Company accounts")');
      await page.waitForTimeout(500);
      const rowText = await page.locator('table tr:has-text("ACC-0002")').innerText();
      return rowText.match(/\$[\d,]+\.\d{2}/)[0];
    };
    const asNum = (money) => Number(money.replace(/[$,]/g, ""));

    await check("picking an existing company account as the client also defaults the required Account to charge (still overridable), and TWO-STEP LOGIC: creating immediately withdraws — no separate charge step", async () => {
      await ensureGroupOpen("Account");
      await page.waitForTimeout(300);
      hodanBalanceBeforeCharge = await hodanBalanceNow();

      await openQuotationSubmenu("Pending");
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.click('button:has-text("New quotation")');
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.getByText("Client name", { exact: true }).locator("xpath=following-sibling::input").fill("Hodan Hotel");
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Hodan Hotel")').first().click();
      // The Account-to-charge box should now show Hodan Hotel by default,
      // with a "Change" button rather than the search box.
      await page.waitForSelector('button:has-text("Change")', { timeout: 3000 });
      await page.waitForSelector("text=/ACC-0002/", { timeout: 3000 });
      await page.locator('input[placeholder="Description"]').first().fill("Charge Test Item");
      await page.locator('input[placeholder="Unit price"]').first().fill("50");
      // A preview of the immediate withdrawal is shown before saving.
      await page.waitForSelector("text=/Will withdraw immediately/", { timeout: 3000 });
      await page.getByRole("button", { name: "Save quotation" }).click();
      await page.waitForTimeout(700);
      await page.waitForSelector("text=/withdrawn from/", { timeout: 5000 }); // success toast
      // The seed data already has a settled "Hodan Hotel" quotation
      // (QT-2026-0001), so every later step in this test must target OUR new
      // quotation specifically by number — never by the client name alone.
      // The list now leads with a display-order "#" column, so the
      // quotation NUMBER itself is the SECOND cell, not the first. That
      // number cell also contains a "{amount} → {account}" subtitle on its
      // own line underneath — split it off so we're left with just the bare
      // quotation number (a raw multi-line innerText breaks :has-text()
      // selectors built from it later).
      const numberCellText = await page.locator('table tbody tr:has-text("Hodan Hotel"):has-text("Pending")').first().locator("td").nth(1).innerText();
      chargeTestQuoteNumber = numberCellText.split("\n")[0].trim();

      const afterBalance = await hodanBalanceNow();
      const before = asNum(hodanBalanceBeforeCharge), after = asNum(afterBalance);
      if (Math.abs(before - after - 50) > 0.001) throw new Error(`expected balance to drop by exactly $50 immediately on save, was ${before} now ${after}`);
    });
    await check("a Pending quotation offers View, Edit, and a single Settle action (Pay/Refund are merged — both post an identical Deposit, only the resulting status differs) — AND now also Delete, since Delete is a record-management action independent of settlement", async () => {
      await openQuotationSubmenu("Pending");
      await page.waitForTimeout(500);
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      await row.locator('button:has-text("Settle")').waitFor({ timeout: 3000 });
      const payCount = await row.locator('button:has-text("Pay")').count();
      const refundCount = await row.locator('button:has-text("Refund")').count();
      if (payCount > 0 || refundCount > 0) throw new Error("expected the separate Pay/Refund buttons to be gone, replaced by a single Settle button");
      await row.locator('button:has-text("View")').waitFor({ timeout: 3000 });
      await row.locator('button:has-text("Edit")').waitFor({ timeout: 3000 });
      const deleteCount = await row.locator('button:has-text("Delete")').count();
      if (deleteCount === 0) throw new Error("expected a Delete button on a Pending quotation too — FINAL RULE: delete is a record-management operation, never a financial one, so it no longer waits for settlement");
    });
    await check("the Pending submenu shows a live, database-computed count badge", async () => {
      const group = page.locator('div:has(> button.gk-nav-group-header:has-text("Quotations"))').first();
      const pendingBtn = group.locator('.gk-submenu button.gk-nav-btn', { hasText: "Pending" }).first();
      const text = await pendingBtn.innerText();
      if (!/\d+/.test(text)) throw new Error(`expected a numeric count badge next to Pending, got "${text}"`);
    });
    await check("View opens a read-only detail page — Status/Account/Currency/Amount/Date/Valid Until — with an Update action that hands off to the same editor", async () => {
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      await row.locator('button:has-text("View")').click();
      await page.waitForSelector(`text=Quotation ${chargeTestQuoteNumber}`, { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("Status", { exact: true }).first().waitFor({ timeout: 3000 });
      await dialog.getByText("Currency", { exact: true }).first().waitFor({ timeout: 3000 });
      await dialog.getByText("Date", { exact: true }).first().waitFor({ timeout: 3000 });
      await dialog.getByText("Valid Until", { exact: true }).first().waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Update" }).click();
      await page.waitForSelector(`text=Edit ${chargeTestQuoteNumber}`, { timeout: 5000 });
    });
    await check("Update on a still-Pending quotation opens the FULL form — items/qty/price are editable, the customer can be re-linked — but the charged account itself stays locked", async () => {
      await page.waitForSelector("text=/Still Pending/", { timeout: 3000 });
      const itemInputCount = await page.locator('input[placeholder="Description"]').count();
      if (itemInputCount === 0) throw new Error("expected editable line-item inputs while the quotation is still Pending — the spec opens full editing up until settlement");
      await page.waitForSelector("text=/locked — duplicate the quotation/", { timeout: 3000 });
      // Exact match: a loose has-text("Change") also catches "Money Exchange"
      // in the sidebar and the "Save changes" submit button, both benign.
      const changeCount = await page.getByRole("button", { name: "Change", exact: true }).count();
      if (changeCount > 0) throw new Error("expected no exact 'Change' button on the charged account — it can't be reassigned via Update");
    });
    await check("lowering the unit price shows a live 'credit back' adjustment preview, and Save changes posts a NEW Deposit adjustment rather than rewriting the original Withdrawal", async () => {
      await page.locator('input[placeholder="Unit price"]').first().fill("30");
      await page.waitForSelector("text=/credit the difference back/", { timeout: 3000 });
      await page.waitForSelector("text=/\\+ \\$20\\.00/", { timeout: 3000 });
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.waitForSelector("text=/Quotation updated/", { timeout: 5000 });
    });
    await check("the edited quotation stays Pending at its new (reduced) amount, and the account was credited back $20 — net $30 down from the original balance", async () => {
      await openQuotationSubmenu("Pending");
      await page.waitForTimeout(500);
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      await row.locator("text=/\\$30\\.00/").first().waitFor({ timeout: 3000 });
      const balance = await hodanBalanceNow();
      const before = asNum(hodanBalanceBeforeCharge), now = asNum(balance);
      if (Math.abs(before - now - 30) > 0.001) throw new Error(`expected the balance to sit exactly $30 below the original after the $50→$30 edit, was ${before} now ${now}`);
    });
    await check("the now-edited quotation's Detail view shows a real Updated By/Updated Date (no longer a dash), proving PATCH actually persists them", async () => {
      // hodanBalanceNow() (just used above) navigates away to USD Accounts to
      // read the balance — back to the Pending Quotations list first.
      await openQuotationSubmenu("Pending");
      await page.waitForTimeout(500);
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`).first();
      await row.locator('button:has-text("View")').click();
      await page.waitForSelector(`text=Quotation ${chargeTestQuoteNumber}`, { timeout: 5000 });
      const dlg = page.getByRole("dialog").last();
      const text = await dlg.innerText();
      if (!/Updated By[\s\S]{0,30}Amina Yusuf/i.test(text)) throw new Error(`expected Updated By to show the editor's name (Amina Yusuf) after a PATCH edit — got: ${text}`);
      if (/Updated Date[\s\S]{0,10}—/.test(text)) throw new Error("expected a real Updated Date after a PATCH edit, not the unedited dash placeholder");
      await dlg.locator('button:has-text("Close")').click();
      await page.waitForTimeout(300);
    });
    await check("Settle → Paid (the default choice) posts a real settlement Deposit, moves status to Paid, drops out of the Pending list, and restores the account balance", async () => {
      await openQuotationSubmenu("Pending");
      await page.waitForTimeout(500);
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      await row.locator('button:has-text("Settle")').click();
      await page.waitForSelector(`text=Settle ${chargeTestQuoteNumber}`, { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      // "Paid" is the default-selected choice — confirm directly with "Mark Paid".
      await dialog.getByRole("button", { name: "Mark Paid" }).click();
      await page.waitForTimeout(700);
      const stillPending = await page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`).count();
      if (stillPending > 0) throw new Error("expected the now-Paid quotation to drop out of the Pending-filtered submenu");

      await openQuotationSubmenu("Paid");
      await page.waitForTimeout(500);
      const paidRow = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      await paidRow.locator("text=Paid").first().waitFor({ timeout: 5000 });
      await paidRow.locator("text=/\\$30\\.00/").first().waitFor({ timeout: 3000 });

      const restoredBalance = await hodanBalanceNow();
      if (restoredBalance !== hodanBalanceBeforeCharge) throw new Error(`expected balance restored to ${hodanBalanceBeforeCharge} after Pay, got ${restoredBalance}`);
    });
    await check("all three ledger legs stay visible, standalone (never folded), in the account's own Transactions table — the original $50 Charge, the $20 Pending-time Adjustment, and the final $30 Settlement", async () => {
      await page.click('table tr:has-text("ACC-0002") >> text=Hodan Hotel');
      await page.waitForSelector("text=/Transactions \\(\\d+\\)/", { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      const chargeRow = dialog.locator(`table tbody tr:has-text("Quotation — ${chargeTestQuoteNumber}")`);
      const adjustRow = dialog.locator(`table tbody tr:has-text("Quotation adjustment — ${chargeTestQuoteNumber}")`);
      const settleRow = dialog.locator(`table tbody tr:has-text("Quotation Paid — ${chargeTestQuoteNumber}")`);
      await chargeRow.first().waitFor({ timeout: 3000 });
      await adjustRow.first().waitFor({ timeout: 3000 });
      await settleRow.first().waitFor({ timeout: 3000 });
      await chargeRow.locator("text=/\\$50\\.00/").first().waitFor({ timeout: 3000 });
      await adjustRow.locator("text=/\\$20\\.00/").first().waitFor({ timeout: 3000 });
      await settleRow.locator("text=/\\$30\\.00/").first().waitFor({ timeout: 3000 });
      await dialog.locator('button[aria-label="Close"], button:has-text("×")').first().click();
      await page.waitForTimeout(300);
    });

    let refundTestQuoteNumber;
    await check("a second quotation, charged then Refunded, restores the balance and moves into the Refunded submenu (not folded away either)", async () => {
      await openQuotationSubmenu("Pending");
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.click('button:has-text("New quotation")');
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.getByText("Client name", { exact: true }).locator("xpath=following-sibling::input").fill("Hodan Hotel");
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Hodan Hotel")').first().click();
      await page.locator('input[placeholder="Description"]').first().fill("Refund Test Item");
      await page.locator('input[placeholder="Unit price"]').first().fill("15");
      await page.getByRole("button", { name: "Save quotation" }).click();
      await page.waitForTimeout(700);
      const refundNumberCellText = await page.locator('table tbody tr:has-text("Hodan Hotel"):has-text("Pending")').first().locator("td").nth(1).innerText();
      refundTestQuoteNumber = refundNumberCellText.split("\n")[0].trim();

      const row = page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`);
      await row.locator('button:has-text("Settle")').click();
      await page.waitForSelector(`text=Settle ${refundTestQuoteNumber}`, { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      // The toggle button's accessible name also includes its subtitle text
      // ("Refunded" + "Quotation voided — no revenue"), so match by
      // substring via :has-text rather than an exact accessible-name match.
      await dialog.locator('button:has-text("Refunded")').first().click(); // switch the choice away from the "Paid" default
      await dialog.getByRole("button", { name: "Refund", exact: true }).click(); // confirm
      await page.waitForTimeout(700);
      const stillPending = await page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`).count();
      if (stillPending > 0) throw new Error("expected the now-Refunded quotation to drop out of the Pending-filtered submenu");

      await openQuotationSubmenu("Refunded");
      await page.waitForTimeout(500);
      await page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`).locator("text=Refunded").first().waitFor({ timeout: 5000 });

      const restoredBalance = await hodanBalanceNow();
      if (restoredBalance !== hodanBalanceBeforeCharge) throw new Error(`expected balance restored to ${hodanBalanceBeforeCharge} after Refund, got ${restoredBalance}`);
    });
    await check("double-settlement is prevented — a Paid quotation can't also be Refunded, and vice versa", async () => {
      await openQuotationSubmenu("Paid");
      await page.waitForTimeout(500);
      const paidRow = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      if (await paidRow.locator('button:has-text("Settle")').count() > 0) throw new Error("a Paid quotation should not offer Settle again");
      await openQuotationSubmenu("Refunded");
      await page.waitForTimeout(500);
      const refundedRow = page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`);
      if (await refundedRow.locator('button:has-text("Settle")').count() > 0) throw new Error("a Refunded quotation should not offer Settle again");
    });
    await check("a direct API call confirms permanently deleting a quotation requires the quotationsDelete permission specifically — quotationsManage alone (e.g. the Sales role) is not enough", async () => {
      const adminToken = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const target = await page.evaluate(async ({ tok, number }) => {
        const res = await fetch("/api/quotations", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.quotations.find((q) => q.number === number);
      }, { tok: adminToken, number: chargeTestQuoteNumber });
      if (!target) throw new Error(`could not find quotation ${chargeTestQuoteNumber} to test against`);
      const loginRes = await page.evaluate(async () => {
        const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "ilhan.nuur", password: DEMO_PW }) });
        return res.json();
      });
      if (!loginRes.token) throw new Error("expected the seeded Sales-role user (ilhan.nuur) to log in successfully");
      const status = await page.evaluate(async ({ tok, id }) => {
        const res = await fetch(`/api/quotations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } });
        return res.status;
      }, { tok: loginRes.token, id: target.id });
      if (status !== 403) throw new Error(`expected a Sales-role user (quotationsManage yes, quotationsDelete no) to be blocked from deleting with 403, got ${status}`);
      const stillThere = await page.evaluate(async ({ tok, number }) => {
        const res = await fetch("/api/quotations", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return !!d.quotations.find((q) => q.number === number);
      }, { tok: adminToken, number: chargeTestQuoteNumber });
      if (!stillThere) throw new Error("expected the quotation to survive the blocked delete attempt");
    });
    await check("Delete on a settled (Refunded) quotation opens a confirmation modal titled 'Delete Quotation Permanently?' showing the quotation number, account, amount, and status, with a permanent-delete warning", async () => {
      await openQuotationSubmenu("Refunded");
      await page.waitForTimeout(500);
      const row = page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`);
      await row.locator('button:has-text("Delete")').waitFor({ timeout: 3000 });
      await row.locator('button:has-text("Delete")').click();
      await page.waitForSelector("text=Delete Quotation Permanently?", { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText(refundTestQuoteNumber, { exact: false }).first().waitFor({ timeout: 3000 });
      await dialog.getByText("Are you sure you want to permanently delete this quotation?", { exact: true }).waitFor({ timeout: 3000 });
      await dialog.getByText("stays intact and visible in the ledger", { exact: false }).first().waitFor({ timeout: 3000 });
    });
    await check("confirming Delete Permanently removes the document from the Refunded list while its ledger history survives, untouched", async () => {
      await page.getByRole("dialog").last().getByRole("button", { name: "Delete Permanently" }).click();
      await page.waitForTimeout(700);
      const remaining = await page.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`).count();
      if (remaining > 0) throw new Error("expected the settled quotation to be gone from the list after Delete");

      // Balance is untouched by deleting the document — the real ledger legs
      // that already posted are never removed.
      const afterDeleteBalance = await hodanBalanceNow();
      if (afterDeleteBalance !== hodanBalanceBeforeCharge) throw new Error(`expected balance unaffected by deleting the quotation document, was ${hodanBalanceBeforeCharge} now ${afterDeleteBalance}`);

      await page.click('table tr:has-text("ACC-0002") >> text=Hodan Hotel');
      await page.waitForSelector("text=/Transactions \\(\\d+\\)/", { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`).first().waitFor({ timeout: 3000 });
      const legCount = await dialog.locator(`table tbody tr:has-text("${refundTestQuoteNumber}")`).count();
      if (legCount !== 2) throw new Error(`expected both ledger legs of the deleted quotation to still show its reference number, found ${legCount}`);
      await dialog.locator('button[aria-label="Close"], button:has-text("×")').first().click();
      await page.waitForTimeout(300);
    });

    let pendingDeleteQuoteNumber;
    let hodanBalanceBeforePendingDeleteTest;
    await check("FINAL RULE: Delete is a record-management operation, never a financial one — deleting a still-Pending quotation is now allowed, but its outstanding Withdrawal is NOT reversed and survives permanently, unexplained, in the account's own ledger", async () => {
      hodanBalanceBeforePendingDeleteTest = await hodanBalanceNow();

      await openQuotationSubmenu("Pending");
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.click('button:has-text("New quotation")');
      await page.waitForSelector("text=New quotation", { timeout: 5000 });
      await page.getByText("Client name", { exact: true }).locator("xpath=following-sibling::input").fill("Hodan Hotel");
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Hodan Hotel")').first().click();
      await page.locator('input[placeholder="Description"]').first().fill("Pending Delete Test Item");
      await page.locator('input[placeholder="Unit price"]').first().fill("10");
      await page.getByRole("button", { name: "Save quotation" }).click();
      await page.waitForTimeout(700);
      const cellText = await page.locator('table tbody tr:has-text("Hodan Hotel"):has-text("Pending")').first().locator("td").nth(1).innerText();
      pendingDeleteQuoteNumber = cellText.split("\n")[0].trim();

      const row = page.locator(`table tbody tr:has-text("${pendingDeleteQuoteNumber}")`);
      await row.locator('button:has-text("Delete")').click();
      await page.waitForSelector("text=Delete Quotation Permanently?", { timeout: 5000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("no quotation left to explain it", { exact: false }).first().waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Delete Permanently" }).click();
      await page.waitForTimeout(700);

      const remaining = await page.locator(`table tbody tr:has-text("${pendingDeleteQuoteNumber}")`).count();
      if (remaining > 0) throw new Error("expected the deleted Pending quotation to be gone from the Pending list");

      // The balance must stay exactly where the still-outstanding $10
      // Withdrawal left it — deleting the DOCUMENT never touches the ledger
      // or the balance, Pending or not.
      const balanceAfter = await hodanBalanceNow();
      const before = asNum(hodanBalanceBeforePendingDeleteTest), after = asNum(balanceAfter);
      if (Math.abs(before - after - 10) > 0.001) throw new Error(`expected the balance to stay down by the outstanding $10 withdrawal (unreversed by Delete), was ${before} now ${after}`);

      await page.click('table tr:has-text("ACC-0002") >> text=Hodan Hotel');
      await page.waitForSelector("text=/Transactions \\(\\d+\\)/", { timeout: 5000 });
      const txDialog = page.getByRole("dialog").last();
      await txDialog.locator(`table tbody tr:has-text("${pendingDeleteQuoteNumber}")`).first().waitFor({ timeout: 3000 });
      await txDialog.locator('button[aria-label="Close"], button:has-text("×")').first().click();
      await page.waitForTimeout(300);
    });


    await page.click('button:has-text("Reports")');
    await check("reports load", () => page.waitForSelector("text=Total transactions", { timeout: 5000 }));
    // Previously untested tab — opening it used to be the only way to find
    // out whether it actually worked. Now covered directly: it must load
    // cleanly (no uncaught JS error crashing the page) and show its own
    // summary strip at the top of the table, matching the other Reports
    // tabs (Exchange summary / Quotation report / Currency position all
    // already had one).
    await check("Staff activity report loads cleanly (previously untested) and shows a summary strip above its table", async () => {
      await page.click('button:has-text("Staff activity")');
      await page.waitForSelector("text=Staff active", { timeout: 5000 });
      await page.waitForSelector("text=Total volume", { timeout: 3000 });
      await page.waitForSelector("text=Total profit", { timeout: 3000 });
      if (problems.length) throw new Error(`unexpected page error(s) after opening Staff activity: ${JSON.stringify(problems)}`);
    });
    await check("Audit log also shows a summary strip above its table (entries shown / unique actors / actions today / most recent)", async () => {
      await page.click('button:has-text("Audit log")');
      await page.waitForSelector("text=Entries shown", { timeout: 5000 });
      await page.waitForSelector("text=Unique actors", { timeout: 3000 });
      await page.waitForSelector("text=Actions today", { timeout: 3000 });
      await page.waitForSelector("text=Most recent", { timeout: 3000 });
      if (problems.length) throw new Error(`unexpected page error(s) after opening Audit log: ${JSON.stringify(problems)}`);
    });

    // Phase 2 (ULTIMATE USER ROLES & PERMISSIONS): "Users & Roles" is now a
    // GROUP (like Account/Payment/Quotations) with two submenus — Users and
    // Roles — instead of a single flat nav button, so it must be expanded
    // before its "Users" child is clickable.
    await ensureGroupOpen("Users & Roles");
    const usersRolesGroup = page.locator('div:has(> button.gk-nav-group-header:has-text("Users & Roles"))').first();
    await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Users" }).first().click();
    await check("user admin panel loads", () => page.waitForSelector("text=Add user", { timeout: 5000 }));
    await check("Users & Roles shows a Total/Active/Inactive/Never-logged-in stat strip", async () => {
      await page.waitForSelector("text=Total users", { timeout: 3000 });
      await page.waitForSelector("text=Inactive", { timeout: 3000 });
      await page.waitForSelector("text=Never logged in", { timeout: 3000 });
    });

    // ================= ROLE MANAGEMENT (Phase 2: ULTIMATE USER ROLES &
    // PERMISSIONS MANAGEMENT SYSTEM) — Roles list, custom role creation via
    // the permission matrix, duplication, and live wiring into the Users
    // module's role dropdown + per-user permission overrides panel. =================
    await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Roles" }).first().click();
    await check("Roles module loads, listing the seeded system roles", async () => {
      await page.waitForSelector("text=Define what each role can see and do", { timeout: 5000 });
      await page.waitForSelector('table tbody tr:has-text("Admin")', { timeout: 3000 });
      await page.waitForSelector('table tbody tr:has-text("Cashier / Teller")', { timeout: 3000 });
      await page.waitForSelector('table tbody tr:has-text("Super Admin")', { timeout: 3000 });
    });
    // Scoped to the first (Role name) column only, anchored at the start —
    // the Description column legitimately contains the substring "Super
    // Admin" for several roles (e.g. Admin's own description: "...
    // configurable by a Super Admin."), so a whole-row hasText match would
    // false-positive across rows. Anchoring on the name cell's own text
    // disambiguates "Admin" from "Super Admin" cleanly.
    const superAdminRoleRow = page.locator("table tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^Super Admin/ }) });
    const adminRoleRow = page.locator("table tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^Admin/ }) });
    await check("SUPER ADMIN PROTECTION: the Super Admin row exposes no Edit/Duplicate/Delete actions", async () => {
      const btnCount = await superAdminRoleRow.locator("button").count();
      if (btnCount !== 0) throw new Error(`expected zero action buttons on the Super Admin role row, found ${btnCount}`);
    });
    await check("a protected role (Admin) can have its permissions edited but not be deleted", async () => {
      await adminRoleRow.getByRole("button", { name: "Edit", exact: true }).waitFor({ timeout: 3000 });
      const deleteCount = await adminRoleRow.getByRole("button", { name: "Delete", exact: true }).count();
      if (deleteCount !== 0) throw new Error("Admin is protected and must not offer a Delete action");
    });

    const newRoleName = `QA Custom Role ${Date.now()}`;
    await check("+ New role opens a create-role modal with a searchable, module-grouped permission matrix", async () => {
      await page.click('button:has-text("+ New role")');
      await page.getByRole("dialog", { name: "New role" }).waitFor({ timeout: 3000 });
    });
    await check("creating a custom role via a module's Select All checkbox (Reports: view/export/print)", async () => {
      const dialog = page.getByRole("dialog", { name: "New role" });
      await dialog.locator('input[placeholder="e.g. Finance Manager"]').fill(newRoleName);
      await dialog.locator("textarea").fill("QA smoke-test role — safe to delete.");
      const reportsHeader = dialog.locator('div:has(> span:text-is("Reports"))').first();
      await reportsHeader.locator('input[type="checkbox"]').first().click();
      await dialog.locator("text=3 of").waitFor({ timeout: 2000 });
      await dialog.getByRole("button", { name: "Create role", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${newRoleName}")`, { timeout: 5000 });
    });
    await check("the new custom role was created with exactly the 3 Reports permissions (verified via API, not just the UI)", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const role = await page.evaluate(async ({ tok, name }) => {
        const res = await fetch("/api/roles", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.roles.find((r) => r.name === name);
      }, { tok: token, name: newRoleName });
      if (!role) throw new Error("new role not found via GET /api/roles");
      if (role.permissionCount !== 3) throw new Error(`expected 3 permissions, got ${role.permissionCount}`);
      if (!role.permissions.every((k) => k.startsWith("reports."))) throw new Error(`expected only reports.* keys, got ${role.permissions.join(", ")}`);
    });
    await check("Duplicate creates an independent copy pre-filled with the source role's own permissions", async () => {
      const row = page.locator("table tbody tr", { hasText: newRoleName });
      await row.getByRole("button", { name: "Duplicate", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Duplicate "${newRoleName}"` });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${newRoleName} (Copy)")`, { timeout: 5000 });
    });
    await check("cleanup: the duplicate role (unused, zero users) deletes immediately with a simple confirm", async () => {
      const row = page.locator("table tbody tr", { hasText: `${newRoleName} (Copy)` });
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Delete "${newRoleName} (Copy)"` });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.getByText(/cannot be undone/).waitFor({ timeout: 2000 });
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${newRoleName} (Copy)")`, { state: "detached", timeout: 5000 });
    });

    await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Users" }).first().click();
    await page.waitForSelector("text=Add user", { timeout: 5000 });
    await check("the newly created custom role is immediately selectable in the Add user role dropdown (live roles list, not a hard-coded set)", async () => {
      await page.click('button:has-text("+ Add user")');
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await dialog.waitFor({ timeout: 3000 });
      const optionCount = await dialog.locator(`select option`, { hasText: newRoleName }).count();
      if (optionCount === 0) throw new Error("expected the new custom role to appear as a selectable option in the role dropdown");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    });

    await check("EFFECTIVE PERMISSIONS / USER-SPECIFIC OVERRIDES: granting a direct GRANT override on a Cashier persists and reflects as Effective: Allow", async () => {
      const row = page.locator("table tbody tr", { hasText: "cabdi.maxamed" });
      await row.getByRole("button", { name: "Permissions", exact: true }).click();
      const dialog = page.locator('[role="dialog"]', { hasText: "Permissions — " }).last();
      await dialog.waitFor({ timeout: 3000 });
      const permRow = dialog.locator('div:has(> div:text-is("View — Roles & Permissions"))').first();
      await permRow.waitFor({ timeout: 3000 });
      // Cashier holds none of the roles.* grants by default, so this starts
      // as Effective: Deny (INHERIT, following the role) before the toggle.
      await permRow.getByText("Effective: Deny", { exact: true }).waitFor({ timeout: 2000 });
      await permRow.locator("button", { hasText: "grant" }).click();
      await permRow.getByText("Effective: Allow", { exact: true }).waitFor({ timeout: 2000 });
      await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
      await page.waitForSelector("text=Permissions updated.", { timeout: 5000 });
    });
    await check("the override actually persisted server-side (verified via GET /api/users/:id/permissions, not just the UI state)", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const perms = await page.evaluate(async (tok) => {
        const usersRes = await fetch("/api/users", { headers: { Authorization: `Bearer ${tok}` } });
        const users = (await usersRes.json()).users;
        const cashier = users.find((u) => u.username === "cabdi.maxamed");
        const res = await fetch(`/api/users/${cashier.id}/permissions`, { headers: { Authorization: `Bearer ${tok}` } });
        return res.json();
      }, token);
      const override = (perms.overrides || []).find((o) => o.permissionKey === "roles.view");
      if (!override || override.granted !== true) throw new Error(`expected a persisted GRANT override on roles.view, got ${JSON.stringify(perms.overrides)}`);
      if (!perms.effective || !perms.effective.includes("roles.view")) throw new Error("roles.view should now be in this cashier's effective permission set");
    });
    await check("cleanup: reverting the override back to Inherit removes it and restores the role's own default", async () => {
      const row = page.locator("table tbody tr", { hasText: "cabdi.maxamed" });
      await row.getByRole("button", { name: "Permissions", exact: true }).click();
      const dialog = page.locator('[role="dialog"]', { hasText: "Permissions — " }).last();
      await dialog.waitFor({ timeout: 3000 });
      const permRow = dialog.locator('div:has(> div:text-is("View — Roles & Permissions"))').first();
      await permRow.locator("button", { hasText: "inherit" }).click();
      await permRow.getByText("Effective: Deny", { exact: true }).waitFor({ timeout: 2000 });
      await dialog.getByRole("button", { name: "Save permissions", exact: true }).click();
      await page.waitForSelector("text=Permissions updated.", { timeout: 5000 });
    });
    await check("cleanup: the QA custom role (zero users) deletes cleanly, leaving Roles Management tidy", async () => {
      await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Roles" }).first().click();
      const row = page.locator("table tbody tr", { hasText: newRoleName });
      await row.waitFor({ timeout: 5000 });
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Delete "${newRoleName}"` });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${newRoleName}")`, { state: "detached", timeout: 5000 });
      await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Users" }).first().click();
      await page.waitForSelector("text=Add user", { timeout: 5000 });
    });

    // ================= SUPER ADMIN SYSTEM OVERVIEW round — a third
    // sub-item under "Users & Roles", gated by the same "users" permission
    // as the Users list itself. Aggregates Users/Roles/Permissions counts,
    // database status, and recent audit/login activity onto one screen. =================
    await check("Users & Roles group has a third sub-item, System Overview", async () => {
      await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "System Overview" }).first().waitFor({ timeout: 3000 });
    });
    await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "System Overview" }).first().click();
    await check("System Overview loads with Users/Roles/Permissions/Audit activity stat tiles reflecting live data", async () => {
      await page.waitForSelector("text=System Overview", { timeout: 5000 });
      await page.waitForSelector("text=Audit activity", { timeout: 3000 });
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (!/\bUsers\b/.test(bodyText) || !/\bRoles\b/.test(bodyText) || !/\bPermissions\b/.test(bodyText)) {
        throw new Error("expected Users/Roles/Permissions stat tiles on System Overview");
      }
    });
    await check("System Overview shows System status and Database status panels with live values (not placeholders)", async () => {
      await page.waitForSelector("text=System status", { timeout: 3000 });
      await page.waitForSelector("text=Server uptime", { timeout: 3000 });
      await page.waitForSelector("text=Database status", { timeout: 3000 });
      await page.waitForSelector("text=Write-ahead log", { timeout: 3000 });
    });
    await check("System Overview shows Recent changes (from the same audit log) and Recent login activity panels", async () => {
      await page.waitForSelector("text=Recent changes", { timeout: 3000 });
      await page.waitForSelector("text=Recent login activity", { timeout: 3000 });
      // amina.yusuf just logged in as part of this very test run, so her own
      // name must appear in the live Recent login activity list.
      await page.waitForSelector("text=Amina Yusuf", { timeout: 3000 });
    });
    await check("Refresh re-fetches the overview without erroring", async () => {
      await page.click('button:has-text("Refresh")');
      await page.waitForSelector("text=System status", { timeout: 5000 });
      if (problems.length) throw new Error(`unexpected page error(s) after refreshing System Overview: ${JSON.stringify(problems)}`);
    });
    await check("System Overview is blocked for a role without the 'users' permission (Cashier can't even see the sub-item)", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const cashierLogin = await page.evaluate(async () => {
        const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "cabdi.maxamed", password: DEMO_PW }) });
        return res.json();
      });
      const res = await page.evaluate(async (tok) => {
        const r = await fetch("/api/system-overview", { headers: { Authorization: `Bearer ${tok}` } });
        return r.status;
      }, cashierLogin.token);
      if (res !== 403) throw new Error(`expected 403 for a Cashier calling /api/system-overview directly, got ${res}`);
    });
    await usersRolesGroup.locator('.gk-submenu button.gk-nav-btn', { hasText: "Users" }).first().click();
    await page.waitForSelector("text=Add user", { timeout: 5000 });

    // ================= TABLE CUSTOMIZATION (Round 1) — the reusable "⚙
    // Customize table" show/hide + reorder (↑/↓) + row-density system,
    // exercised here on the Users table while still logged in as
    // amina.yusuf (Admin, holds the new settings.manageTableDefaults
    // grant). Explicitly out of scope for this round: live drag, column
    // resize, and any color/border/hover styling. =================
    await check("the Users table starts with its shipped default column set, in order", async () => {
      // Header cells render uppercase via CSS (text-transform), so compare
      // case-insensitively rather than against the column defs' own labels.
      const headText = (await page.locator("table thead").innerText()).toUpperCase();
      const order = ["NAME", "USERNAME", "ROLE", "STATUS", "LAST LOGIN"].map((l) => headText.indexOf(l));
      if (order.some((i) => i === -1)) throw new Error(`expected all 5 default columns in the header, got: ${JSON.stringify(headText)}`);
      for (let i = 1; i < order.length; i++) {
        if (order[i] < order[i - 1]) throw new Error(`expected default column order Name/Username/Role/Status/Last login, got: ${JSON.stringify(headText)}`);
      }
    });
    await check("⚙ Customize table opens a modal listing every column; the required Name column's checkbox is disabled", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      await page.getByText("(always shown)").waitFor({ timeout: 2000 });
      const nameCheckbox = page.locator('button[aria-label="Move Name up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (await nameCheckbox.isEnabled()) throw new Error("expected the required Name column's checkbox to be disabled");
      const usernameCheckbox = page.locator('button[aria-label="Move Username up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (!(await usernameCheckbox.isEnabled())) throw new Error("expected a non-required column's checkbox to be enabled");
    });
    await check("reordering a column with ↑ and hiding another, then Save my layout, updates the live table immediately", async () => {
      // Default order is Name/Username/Role/Status/Last login. Move Status up
      // twice (Role, then Username) so it lands right after Name — a change
      // that stays visible even after Last login is hidden, unlike moving a
      // column that would end up there anyway once a later column disappears.
      await page.click('button[aria-label="Move Status up"]');
      await page.waitForTimeout(150);
      await page.click('button[aria-label="Move Status up"]');
      await page.waitForTimeout(150);
      const lastLoginCheckbox = page.locator('button[aria-label="Move Last login up"]').locator("xpath=..").locator('input[type="checkbox"]');
      await lastLoginCheckbox.click();
      await page.click('button:has-text("Save my layout")');
      await page.waitForSelector("text=Your layout was saved.", { timeout: 5000 });
    });
    await check("the saved layout is reflected in the live table: Status moved up next to Name, Last login hidden", async () => {
      const headText = (await page.locator("table thead").innerText()).toUpperCase();
      if (/LAST LOGIN/.test(headText)) throw new Error(`expected Last login to be hidden, got header: ${JSON.stringify(headText)}`);
      const iName = headText.indexOf("NAME"), iStatus = headText.indexOf("STATUS"), iUsername = headText.indexOf("USERNAME"), iRole = headText.indexOf("ROLE");
      if (!(iName < iStatus && iStatus < iUsername && iUsername < iRole)) {
        throw new Error(`expected reordered header Name < Status < Username < Role, got: ${JSON.stringify(headText)}`);
      }
    });
    await check("re-opening the modal shows the just-saved layout, and Set as System Default is offered to this Admin", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      await page.getByRole("button", { name: "Set as System Default", exact: true }).waitFor({ timeout: 2000 });
      const lastLoginCheckbox = page.locator('button[aria-label="Move Last login up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (await lastLoginCheckbox.isChecked()) throw new Error("expected Last login to still be unchecked after reopening the just-saved layout");
      await page.click('button:has-text("Cancel")');
    });
    await check("Reset to default restores the shipped column set and order", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      await page.click('button:has-text("Reset to default")');
      await page.waitForSelector("text=Your layout was reset to the shipped default.", { timeout: 5000 });
      const headText = (await page.locator("table thead").innerText()).toUpperCase();
      const order = ["NAME", "USERNAME", "ROLE", "STATUS", "LAST LOGIN"].map((l) => headText.indexOf(l));
      if (order.some((i) => i === -1)) throw new Error(`expected all 5 default columns back after reset, got: ${JSON.stringify(headText)}`);
      for (let i = 1; i < order.length; i++) {
        if (order[i] < order[i - 1]) throw new Error(`expected the shipped default order restored, got: ${JSON.stringify(headText)}`);
      }
    });

    await page.click('button:has-text("USD Accounts")');
    await check("USD accounts module loads", () => page.waitForSelector("text=Add USD account", { timeout: 5000 }));
    await check("Accounts shows an Accounts/Total held/Positive balance/In debt stat strip", async () => {
      await page.waitForSelector("text=Total held (USD)", { timeout: 3000 });
      await page.waitForSelector("text=Positive balance", { timeout: 3000 });
      await page.getByText("In debt", { exact: true }).waitFor({ timeout: 3000 });
    });
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("company accounts tab shows data", async () => {
      const count = await page.locator("table tbody tr").count();
      if (count === 0) throw new Error("expected company accounts in seed data");
    });
    await check("account numbers are shown", () => page.waitForSelector("text=/ACC-\\d{4}/", { timeout: 3000 }));
    await check("the USD Accounts table shows a bold Total balance footer, distinct from any row and not counted as an account", async () => {
      const footText = await page.locator("table tfoot").innerText();
      if (!/Total/.test(footText)) throw new Error(`expected a Total label in the accounts footer — got: ${JSON.stringify(footText)}`);
      if (!/\$/.test(footText)) throw new Error(`expected a $ figure in the USD accounts footer — got: ${JSON.stringify(footText)}`);
      if (/SLSH/.test(footText)) throw new Error("USD Accounts footer must never show a SLSH figure (currency separation)");
      const footRowInTbody = await page.locator("table tbody tr:has-text('Total')").count();
      if (footRowInTbody > 0) throw new Error("accounts footer total leaked into tbody rows");
    });
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(500);
    await check("customer accounts tab shows Aisha Nur", () => page.waitForSelector("text=Aisha Nur", { timeout: 3000 }));

    // Deposit/Withdraw no longer live in the account view — do the deposit via the
    // standalone Deposits & Withdrawals module instead, then verify it shows up
    // correctly in the account's own (now read-only) transaction history.
    await page.click('button:has-text("USD Payment")');
    await page.waitForSelector("text=New USD deposit / withdrawal", { timeout: 5000 });
    await page.click('button:has-text("+ New USD deposit / withdrawal")');
    await page.waitForSelector("text=Search for a USD account");
    await page.fill('input[placeholder="Start typing…"]', "Aisha");
    await page.waitForTimeout(500);
    await page.getByRole("dialog").last().locator('button:has-text("Aisha Nur")').click();
    await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("150");
    await page.getByRole("dialog").last().getByRole("button", { name: "Deposit", exact: true }).last().click();
    await page.waitForTimeout(700);
    await check("withdrawing more than the balance is now allowed — the account goes into debt instead of being blocked", async () => {
      await page.click('button:has-text("+ New USD deposit / withdrawal")');
      await page.waitForSelector("text=Search for a USD account");
      await page.fill('input[placeholder="Start typing…"]', "Aisha");
      await page.waitForTimeout(500);
      await page.getByRole("dialog").last().locator('button:has-text("Aisha Nur")').click();
      await page.getByRole("dialog").last().getByRole("button", { name: "Withdraw", exact: true }).first().click();
      await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("9999999");
      await page.getByRole("dialog").last().getByRole("button", { name: "Withdraw", exact: true }).last().click();
      await page.waitForTimeout(700);
      const rows = page.locator("table tbody tr");
      const rowText = await rows.filter({ hasText: "Aisha" }).first().innerText();
      if (!rowText.includes("-$")) throw new Error(`expected the huge withdrawal to succeed and show a negative (debt) balance, got: ${rowText}`);
      // Deposit the same amount straight back so downstream balance checks
      // in this test (which expect the original $150.00) aren't disturbed.
      await page.click('button:has-text("+ New USD deposit / withdrawal")');
      await page.waitForSelector("text=Search for a USD account");
      await page.fill('input[placeholder="Start typing…"]', "Aisha");
      await page.waitForTimeout(500);
      await page.getByRole("dialog").last().locator('button:has-text("Aisha Nur")').click();
      await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("9999999");
      await page.getByRole("dialog").last().getByRole("button", { name: "Deposit", exact: true }).last().click();
      await page.waitForTimeout(700);
    });

    await page.click('button:has-text("USD Accounts")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(500);
    await page.click('table >> text=View >> nth=0');
    // Scoped to the dialog (not the whole page) — the accounts list table
    // behind the modal overlay also shows "$150.00" in its Balance column,
    // so an unscoped page-wide wait can resolve against that stale
    // background text before the modal has finished its own async load.
    await check("balance reflects the deposit made via the standalone module", () => page.getByRole("dialog").last().getByText("$150.00", { exact: true }).first().waitFor({ timeout: 5000 }));
    // NOTE: these Quick Action buttons are matched with the plain CSS
    // `button:text-is(...)` selector (exact textContent match) rather than
    // getByRole(..., {exact:true}) — the latter proved flaky this deep into
    // a long-running, DOM-heavy suite (its accessible-name resolution
    // intermittently missed an otherwise-present, enabled button), while a
    // direct textContent match is unaffected by that a11y-tree recompute.
    // Each button is awaited individually with a retrying waitFor (not a
    // one-shot count()) since the modal loads its full detail (including
    // the Quick Actions row) via its own async fetch after opening.
    await check("Quick Actions (Deposit, Withdraw, Transfer, Exchange, Edit Account) are present in the account detail view", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('button:text-is("Deposit")').waitFor({ timeout: 5000 });
      await dialog.locator('button:text-is("Withdraw")').waitFor({ timeout: 5000 });
      await dialog.locator('button:text-is("Transfer")').waitFor({ timeout: 5000 });
      await dialog.locator('button:text-is("Exchange")').waitFor({ timeout: 5000 });
      await dialog.locator('button:text-is("Edit Account")').waitFor({ timeout: 5000 });
    });
    await check("Deposit Quick Action opens a modal pre-scoped to this account (no account search needed)", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('button:text-is("Deposit")').click();
      await page.waitForSelector("text=New USD deposit / withdrawal", { timeout: 3000 });
      const searchCount = await page.locator("text=Search for a USD account").count();
      if (searchCount > 0) throw new Error("expected the account to be pre-selected, not a fresh account search");
      await page.getByRole("dialog").last().getByText("Aisha Nur", { exact: false }).first().waitFor({ timeout: 3000 });
      await page.getByRole("dialog").last().locator('button:text-is("Cancel")').click();
      await page.waitForTimeout(300);
    });
    await check("Deactivate button is present for an active account", () => page.getByRole("dialog").last().locator('button:text-is("Deactivate")').waitFor({ timeout: 3000 }));
    await check("Account summary now appears AFTER the Transactions table (moved to the bottom)", async () => {
      const dialog = page.getByRole("dialog").last();
      const summaryY = await dialog.getByText("Account summary", { exact: true }).evaluate((el) => el.getBoundingClientRect().top);
      const transactionsY = await dialog.getByText(/^Transactions \(/).evaluate((el) => el.getBoundingClientRect().top);
      if (summaryY < transactionsY) throw new Error("Account summary should render below Transactions, not above");
    });
    await check("summary shows Total deposited / withdrawn / turnover", () => page.getByText("Total turnover", { exact: true }).waitFor({ timeout: 3000 }));
    await check("reconciliation formula (Deposited − Withdrawn = Balance) is shown", () => page.waitForSelector("text=/Deposited − Withdrawn = Balance/", { timeout: 3000 }));

    await check("account view shows ONE unified Transactions table", () => page.waitForSelector("text=/Transactions \\(\\d+\\)/", { timeout: 5000 }));
    await check("unified table includes the exchange transaction alongside the deposit", () => page.getByRole("dialog").last().locator('table >> text=Exchange').first().waitFor({ timeout: 3000 }));
    await check("unified table has a Type filter including Exchanges", () => page.getByRole("dialog").last().locator('option[value="exchange"]').waitFor({ timeout: 3000, state: "attached" }));
    await check("customer account's Type filter has no separate Quotations option (legs show as Deposit/Withdrawal)", async () => {
      const count = await page.getByRole("dialog").last().locator('option[value="quotation"]').count();
      if (count > 0) throw new Error("there should be no dedicated Quotations filter option — quotation legs are plain deposits/withdrawals now");
    });
    await check("sortable column headers are present in the transactions table", () => page.getByRole("dialog").last().locator('th:has-text("Deposit")').first().waitFor({ timeout: 3000 }));
    await check("transactions table has separate Deposit and Withdrawal columns", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('th:has-text("Deposit")').first().waitFor({ timeout: 3000 });
      await dialog.locator('th:has-text("Withdrawal")').first().waitFor({ timeout: 3000 });
    });
    await check("transactions table has a leading # display-order column, starting at 1 for the newest row", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('th:has-text("#")').first().waitFor({ timeout: 3000 });
      const firstCell = await dialog.locator("table tbody tr").first().locator("td").first().innerText();
      if (firstCell.trim() !== "1") throw new Error(`expected the first row's # cell to be "1", got "${firstCell}"`);
    });
    await check("transactions table's Date column shows date only, no time/clock", async () => {
      const dialog = page.getByRole("dialog").last();
      const dateCellText = await dialog.locator("table tbody tr").first().locator("td").nth(1).innerText();
      if (/\d{1,2}:\d{2}/.test(dateCellText)) throw new Error(`expected a date-only cell (no HH:MM), got "${dateCellText}"`);
    });
    await check("transactions table shows a Total row at the bottom", () => page.getByRole("dialog").last().locator('tfoot >> text=Total').waitFor({ timeout: 3000 }));
    const detailDownloadPromise = page.waitForEvent("download");
    await page.getByRole("dialog").last().getByRole("button", { name: "Export CSV" }).click();
    const detailDownload = await detailDownloadPromise;
    await check("account-scoped CSV export downloads", async () => { if (!detailDownload.suggestedFilename().endsWith(".csv")) throw new Error("expected a .csv file"); });

    await check("quotations are restricted to company accounts — button absent for this customer account", async () => {
      const count = await page.locator('button:has-text("New quotation for this account")').count();
      if (count > 0) throw new Error("expected no quotation button on a customer-type account");
    });
    await check("explanation text shown instead, for a customer account", () => page.waitForSelector("text=/Quotations are for company accounts only/", { timeout: 3000 }));
    await page.locator('div[role="dialog"] button:has-text("×")').first().click();
    await page.waitForTimeout(300);

    // Switch to a company account to confirm the quotation shortcut IS available there
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await page.click('table tr:has-text("Hodan Hotel") >> text=View');
    await check("new-quotation-from-account button is present for a company account", () => page.waitForSelector('button:has-text("New quotation for this account")', { timeout: 3000 }));
    await check("company account's unified table includes its quotation's Withdrawal leg as a plain row, with a status pill (no PDF/Mark-paid actions here)", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.locator('table >> text=/Quotation/').first().waitFor({ timeout: 3000 });
      const pdfCount = await dialog.locator('table tr:has-text("Quotation") >> button:has-text("PDF")').count();
      if (pdfCount > 0) throw new Error("account detail table rows should not have a PDF action — that lives in the Quotations module");
    });
    await check("company account's Type filter also has no dedicated Quotations option", async () => {
      const count = await page.getByRole("dialog").last().locator('option[value="quotation"]').count();
      if (count > 0) throw new Error("there should be no dedicated Quotations filter option for company accounts either");
    });
    await check("no 'Mark paid' action exists anywhere in the account detail table (Pay/Refund now live in the Quotations module)", async () => {
      const count = await page.getByRole("dialog").last().locator('button:has-text("Mark paid")').count();
      if (count > 0) throw new Error("Mark paid button should have been removed entirely from AccountDetailModal");
    });
    await page.click('button:has-text("New quotation for this account")');
    await check("navigates straight into a prefilled quotation editor", () => page.waitForSelector("text=New quotation", { timeout: 5000 }));
    await check("client name was prefilled from the account", async () => {
      const val = await page.getByText("Client name", { exact: true }).locator("xpath=following-sibling::input").inputValue();
      if (!val) throw new Error("expected prefilled client name, got empty");
    });
    await page.click('button:has-text("Cancel")');

    // Deposit/Withdraw row-buttons were deliberately removed from the Accounts list
    // (per feedback) — only View/Edit remain there; Deposit/Withdraw live in the
    // account detail view and the standalone Deposits & Withdrawals module.
    await page.click('button:has-text("USD Accounts")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(500);
    await check("Deposit/Withdraw buttons are gone from the Accounts list row", async () => {
      const row = page.locator('table tr:has-text("Aisha Nur")');
      const depositCount = await row.locator('button:has-text("Deposit")').count();
      const withdrawCount = await row.locator('button:has-text("Withdraw")').count();
      if (depositCount > 0 || withdrawCount > 0) throw new Error("expected no Deposit/Withdraw buttons on the Accounts list row");
    });
    await check("View and Edit still work on the Accounts list row", () => page.locator('table tr:has-text("Aisha Nur") >> button:has-text("View")').first().waitFor({ timeout: 3000 }));
    await check("clicking the Account Name itself opens the account details (no separate View click needed)", async () => {
      await page.click('table tr:has-text("Aisha Nur") button.gk-account-name-link');
      await page.waitForSelector("text=Aisha Nur", { timeout: 5000 });
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } }); // click the modal backdrop to close it
      await page.waitForTimeout(300);
    });
    await check("clicking anywhere else in the Accounts row (not just the name) also opens the account details", async () => {
      const row = page.locator('table tr:has-text("Aisha Nur")').first();
      await row.locator("td").nth(2).click(); // Contact cell, not the name link
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("clicking Edit on an Accounts row opens the edit modal, not the account details (stopPropagation)", async () => {
      const row = page.locator('table tr:has-text("Aisha Nur")').first();
      await row.locator('button:has-text("Edit")').click();
      await page.waitForSelector("text=Edit account", { timeout: 5000 });
      if (await page.locator("text=Account summary").count() > 0) throw new Error("Edit click should not also open Account Detail");
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("the earlier deposit is still reflected in the list balance", () => page.waitForSelector('table >> text=$150.00', { timeout: 5000 }));
    await check("Transactions/Quotations/Since columns were removed from the Accounts table", async () => {
      const headerText = await page.locator("table thead").first().innerText();
      if (headerText.includes("Transactions") || headerText.includes("Quotations") || headerText.includes("Since")) {
        throw new Error("expected those columns to be removed from the Accounts list");
      }
    });
    await check("Balance filter (positive/negative) is present and works", async () => {
      await page.selectOption('select:near(:text("Balance"))', "positive").catch(async () => {
        // fallback: locate by the field wrapper directly
        await page.getByText("Balance", { exact: true }).locator("xpath=following-sibling::select").selectOption("positive");
      });
      await page.waitForTimeout(500);
      const count = await page.locator("table tbody tr").count();
      if (count === 0) throw new Error("expected at least one account with a positive balance (Aisha Nur was just deposited into)");
    });

    // Accounts SLSH — a separate menu, its own table, and the seeded USD⇄SLSH link
    await page.click('button:has-text("SLSH Accounts")');
    await check("SLSH accounts module loads", () => page.waitForSelector("text=Add SLSH account", { timeout: 5000 }));
    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(500);
    await check("Hodan Hotel (SLSH) demo account appears in the SLSH table", () => page.waitForSelector("text=Hodan Hotel (SLSH)", { timeout: 5000 }));
    await check("SLSH balances render in SLSH, not USD", () => page.waitForSelector("text=/SLSH 2,000,000/", { timeout: 3000 }));

    await page.click('table tr:has-text("Hodan Hotel (SLSH)") >> text=View');
    await check("linked USD account is shown in the detail view", () => page.waitForSelector("text=Linked USD account", { timeout: 5000 }));
    await check("the actual linked account number is shown", () => page.waitForSelector("text=/ACC-0002/", { timeout: 3000 }));
    await page.getByRole("dialog").last().getByRole("button", { name: "View" }).click();
    await check("clicking View jumps to the linked USD account's own detail", () => page.waitForSelector("text=Hodan Hotel ·", { timeout: 5000 }));
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator('div[role="dialog"] button:has-text("×")').first().click().catch(() => {});
    await page.locator('div[role="dialog"] button:has-text("×")').first().click().catch(() => {});
    await page.waitForTimeout(300);

    // Standalone Deposits & Withdrawals — split into its own USD and SLSH menus
    await page.click('button:has-text("USD Payment")');
    await check("USD deposits & withdrawals module loads", () => page.waitForSelector("text=New USD deposit / withdrawal", { timeout: 5000 }));
    await page.waitForTimeout(500);
    await check("existing USD deposits show in the ledger", () => page.waitForSelector("text=Aisha Nur", { timeout: 5000 }));

    await page.click('button:has-text("+ New USD deposit / withdrawal")');
    await page.waitForSelector("text=Search for a USD account");
    await page.fill('input[placeholder="Start typing…"]', "Hodan Hotel");
    await page.waitForTimeout(500);
    await check("account search is scoped to USD only", () => page.waitForSelector("text=ACC-0002", { timeout: 3000 }));
    await check("no currency dropdown in the standalone new-move form", async () => {
      const selectCount = await page.getByRole("dialog").last().locator("select").count();
      if (selectCount !== 0) throw new Error("expected no currency selector once currency is implied by the menu");
    });
    await page.getByRole("dialog").last().locator('button:has-text("Hodan Hotel"):not(:has-text("SLSH"))').click();
    await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("400");
    await page.getByRole("dialog").last().getByText("Notes (optional)", { exact: true }).locator("xpath=following-sibling::textarea").fill("EditDeleteTestEntry");
    await page.getByRole("dialog").last().getByRole("button", { name: "Deposit", exact: true }).last().click();
    await page.waitForTimeout(700);
    await check("new standalone deposit appears in the USD ledger", () => page.waitForSelector("text=EditDeleteTestEntry", { timeout: 5000 }));
    await check("clicking a deposits/withdrawals row (not the account-name link) opens that account's details", async () => {
      const row = page.locator('table tbody tr:has-text("EditDeleteTestEntry")').first();
      await row.locator("td").nth(3).click(); // Date cell
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("clicking Edit on a deposits/withdrawals row opens the edit modal, not the account details (stopPropagation)", async () => {
      const row = page.locator('table tbody tr:has-text("EditDeleteTestEntry")').first();
      await row.locator('button:has-text("Edit")').click();
      await page.waitForSelector("text=Edit deposit", { timeout: 5000 });
      if (await page.locator("text=Account summary").count() > 0) throw new Error("Edit click should not also open Account Detail");
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });

    await page.click('button:has-text("Daily Transactions")');
    await page.waitForTimeout(600);
    await check("daily transactions tab shows single-currency totals", () => page.waitForSelector("text=Withdrawn", { timeout: 5000 }));
    await check("clicking a row on the daily transactions tab opens that account's details", async () => {
      const row = page.locator("table tbody tr").first();
      const hasRow = await row.count();
      if (hasRow > 0) {
        await row.locator("td").nth(1).click(); // Date cell
        await page.waitForSelector("text=Account summary", { timeout: 5000 });
        await page.click('body', { position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);
      }
    });

    await page.getByRole("button", { name: "Transactions", exact: true }).click();
    await page.waitForTimeout(600);
    await check("totals summary appears below the transactions list", () => page.waitForSelector("text=/Totals for this list \\(USD\\)/", { timeout: 5000 }));
    await check("standalone table also has separate Deposit/Withdrawal columns and an Amount footer row", async () => {
      await page.locator('th:has-text("Deposit")').first().waitFor({ timeout: 3000 });
      await page.locator('th:has-text("Withdrawal")').first().waitFor({ timeout: 3000 });
      await page.locator('tfoot >> text=Amount').waitFor({ timeout: 3000 });
    });

    await check("edit/delete buttons appear on rows", () => page.locator('table tbody tr:has-text("EditDeleteTestEntry") >> button:has-text("Edit")').first().waitFor({ timeout: 3000 }));
    await page.locator('table tbody tr:has-text("EditDeleteTestEntry") >> button:has-text("Edit")').first().click();
    await page.waitForSelector("text=Edit deposit");
    const editAmountInput = page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input");
    await editAmountInput.fill("999999");
    await page.getByRole("dialog").last().getByRole("button", { name: "Save changes" }).click();
    await page.waitForTimeout(700);
    await check("edited amount reflects in the list", () => page.waitForSelector("text=/999,999/", { timeout: 5000 }));

    const rowCountBeforeDelete = await page.locator("table tbody tr").count();
    await page.locator('table tbody tr:has-text("EditDeleteTestEntry") >> button:has-text("Delete")').first().click();
    await page.waitForSelector("text=Delete deposit");
    await page.getByRole("dialog").last().getByRole("button", { name: "Delete entry" }).click();
    await page.waitForTimeout(700);
    await check("row removed after delete", async () => {
      const count = await page.locator("table tbody tr").count();
      if (count !== rowCountBeforeDelete - 1) throw new Error(`expected ${rowCountBeforeDelete - 1} rows, got ${count}`);
    });

    await page.click('button:has-text("SLSH Payment")');
    await check("SLSH deposits & withdrawals module loads separately", () => page.waitForSelector("text=New SLSH deposit / withdrawal", { timeout: 5000 }));
    await page.waitForTimeout(500);
    await check("SLSH ledger shows the seeded SLSH opening balance entry", () => page.waitForSelector("text=Hodan Hotel (SLSH)", { timeout: 5000 }));

    await ensureGroupOpen("Transaction History");
    await page.waitForTimeout(350);
    await page.click('button:has-text("USD Transactions")');
    await check("USD transaction history loads with mixed record types", () => page.waitForSelector("text=Exchange", { timeout: 5000 }));
    // SUMMARY FOR EVERY TABLE: a type-breakdown strip (not a dollar total,
    // which is meaningless across mixed exchange/transfer/ledger rows).
    await check("Transaction History shows an Entries/Exchanges/Transfers/Quotation legs/Deposits & withdrawals stat strip", async () => {
      await page.waitForSelector("text=Entries", { timeout: 3000 });
      await page.waitForSelector("text=Quotation legs", { timeout: 3000 });
      await page.waitForSelector("text=Deposits & withdrawals", { timeout: 3000 });
    });
    await check("SLSH-only exchange does not appear in the USD history", async () => {
      const count = await page.locator('table tbody tr:has-text("Hodan Hotel (SLSH)")').count();
      if (count > 0) throw new Error("expected the SLSH-account exchange to be excluded from USD history");
    });
    await check("the USD Transaction History table shows a bold In/Out/Net Balance footer, recalculated from the currently-filtered rows", async () => {
      const footText = await page.locator("table tfoot").innerText();
      if (!/In:/.test(footText) || !/Out:/.test(footText) || !/Net:/.test(footText)) {
        throw new Error(`expected In/Out/Net in the history footer — got: ${JSON.stringify(footText)}`);
      }
      if (/SLSH/.test(footText)) throw new Error("USD Transaction History footer must never show a SLSH figure (currency separation)");
    });
    // REGRESSION — GLOBAL TABLE UX round: a brand-new walk-in client (typed
    // name, no existing account) doing a large SLSH exchange used to get
    // silently tagged as a USD account (findOrCreateClient / accountCurrency
    // both defaulted to USD, ignoring the actual currencyGiven), which let a
    // multi-million-SLSH figure leak into the USD history footer's Out total
    // — see the "CRITICAL, UNRESOLVED" bug in this round's own investigation
    // notes. Both the root cause (accountCurrency now derives from the
    // exchange's own currency_given; findOrCreateClient now tags a fresh
    // walk-in with the currency of the transaction creating it) and a
    // defensive frontend guard (historyFooterTotals only folds in a row
    // whose own raw currency matches the page) are covered here together.
    await check("a brand-new walk-in client's SLSH exchange never pollutes the USD history footer with a SLSH-magnitude number", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      // NOTE: this suite's own earlier fixtures (Aisha Nur's "goes into debt"
      // test) already leave a legitimate $9,999,999 USD withdrawal+deposit
      // pair in the USD history, so an absolute magnitude threshold isn't a
      // safe check here — the correct assertion is that the footer's exact
      // Out figure (and the exchange-only row count) is BYTE-FOR-BYTE
      // unchanged by creating a SLSH-tagged walk-in exchange, not "under some
      // limit" — that new row must contribute nothing at all to this page.
      const before = await page.evaluate(async (tok) => {
        const r = await fetch("/api/history?currency=USD&type=exchange", { headers: { Authorization: `Bearer ${tok}` } });
        return (await r.json()).entries.length;
      }, token);
      const footBefore = await page.locator("table tfoot").innerText();
      const info = await page.evaluate(async (tok) => {
        const txRes = await fetch("/api/transactions", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ clientName: "Global UX Walkin SLSH", amountGiven: 9000000, currencyGiven: "SLSH", rateUsed: 8700 }),
        });
        const tx = await txRes.json();
        const acctRes = await fetch("/api/accounts?currency=SLSH", { headers: { Authorization: `Bearer ${tok}` } });
        const accts = await acctRes.json();
        const walkIn = accts.accounts.find((a) => a.name === "GLOBAL UX WALKIN SLSH");
        return { ok: txRes.ok, walkInFound: !!walkIn, walkInCurrency: walkIn ? walkIn.currency : null };
      }, token);
      if (!info.ok) throw new Error("failed to create the walk-in SLSH exchange via the API");
      if (info.walkInCurrency !== "SLSH") throw new Error(`expected the new walk-in client to be tagged SLSH, got ${info.walkInCurrency}`);
      if (!info.walkInFound) throw new Error("new walk-in SLSH client not found under SLSH Accounts — currency mistagging regressed");
      // In-app-navigation refresh trick (same one used by the Update/Delete
      // Flow fixtures above) — forces the module to remount and refetch
      // without a full page.reload(), which would otherwise collapse the
      // sidebar nav groups later steps assume are still open.
      await page.click('button:has-text("Reports")');
      await page.waitForSelector("text=Total transactions", { timeout: 5000 });
      await ensureGroupOpen("Transaction History");
      await page.waitForTimeout(300);
      await page.click('button:has-text("USD Transactions")');
      await page.waitForTimeout(600);
      const rowsWithWalkin = await page.locator('table tbody tr:has-text("Global UX Walkin SLSH")').count();
      if (rowsWithWalkin > 0) throw new Error("the SLSH walk-in exchange leaked into the USD Transaction History table");
      const after = await page.evaluate(async (tok) => {
        const r = await fetch("/api/history?currency=USD&type=exchange", { headers: { Authorization: `Bearer ${tok}` } });
        return (await r.json()).entries.length;
      }, token);
      if (after !== before) throw new Error(`USD exchange history count changed (${before} -> ${after}) — the SLSH exchange was miscounted as USD`);
      const footAfter = await page.locator("table tfoot").innerText();
      if (footAfter !== footBefore) {
        throw new Error(`USD history footer changed after a SLSH-only walk-in exchange was created — it should contribute nothing to this page. Before: ${JSON.stringify(footBefore)} After: ${JSON.stringify(footAfter)}`);
      }
      // And it SHOULD show up, correctly, on the SLSH side.
      await page.click('button:has-text("SLSH Transactions")');
      await page.waitForTimeout(600);
      const slshRows = await page.locator('table tbody tr:has-text("Global UX Walkin SLSH")').count();
      if (slshRows === 0) throw new Error("the walk-in SLSH exchange is missing from the SLSH Transaction History table");
      await page.click('button:has-text("USD Transactions")');
      await page.waitForTimeout(400);
    });
    await check("Global Transaction History has a leading # display-order column and date-only cells (no time)", async () => {
      await page.locator('button:not(.gk-nav-btn):has-text("All")').first().click();
      await page.waitForTimeout(400);
      await page.locator('th:has-text("#")').first().waitFor({ timeout: 3000 });
      const firstCell = await page.locator("table tbody tr").first().locator("td").first().innerText();
      if (firstCell.trim() !== "1") throw new Error(`expected the first row's # cell to be "1", got "${firstCell}"`);
      const dateCellText = await page.locator("table tbody tr").first().locator("td").nth(3).innerText();
      if (/\d{1,2}:\d{2}/.test(dateCellText)) throw new Error(`expected a date-only Date cell (no HH:MM), got "${dateCellText}"`);
    });
    // ================= TABLE CUSTOMIZATION (Round 3) — same reusable
    // system, now also on Transaction History (its own leading "#" column
    // stays fixed; this table has no Actions column at all, since the whole
    // row opens the Detail modal instead). One quick hide+verify+reset pass
    // stands in for both USD/SLSH layouts — `test/rbac.js` separately
    // confirms both history.usd/history.slsh table keys are wired into the
    // backend with the same permission gating as every other table. =================
    await check("⚙ Customize table on Transaction History: hiding Reference removes it live, Reset brings it back", async () => {
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      const accountCheckbox = page.locator('button[aria-label="Move Account up"]').locator("xpath=..").locator('input[type="checkbox"]');
      if (await accountCheckbox.isEnabled()) throw new Error("expected the required Account column's checkbox to be disabled");
      const referenceCheckbox = page.locator('button[aria-label="Move Reference up"]').locator("xpath=..").locator('input[type="checkbox"]');
      await referenceCheckbox.click();
      await page.click('button:has-text("Save my layout")');
      await page.waitForSelector("text=Your layout was saved.", { timeout: 5000 });
      let headText = (await page.locator("table thead").innerText()).toUpperCase();
      if (/REFERENCE/.test(headText)) throw new Error(`expected Reference to be hidden, got: ${JSON.stringify(headText)}`);
      await page.click('button:has-text("⚙ Customize table")');
      await page.getByRole("dialog", { name: "Customize table" }).waitFor({ timeout: 3000 });
      await page.click('button:has-text("Reset to default")');
      await page.waitForSelector("text=Your layout was reset to the shipped default.", { timeout: 5000 });
      headText = (await page.locator("table thead").innerText()).toUpperCase();
      if (!/REFERENCE/.test(headText)) throw new Error(`expected Reference back after reset, got: ${JSON.stringify(headText)}`);
    });
    // Scoped to exclude the sidebar's own "Quotations" nav button (same text,
    // same <button> tag) — a plain button:has-text("Quotations") would match
    // that one first since it sits earlier in the DOM.
    await page.locator('button:not(.gk-nav-btn):has-text("Quotations")').first().click();
    await page.waitForTimeout(500);
    await check("Quotations filter shows all three ledger legs of the earlier Paid quotation, labeled Quotation Charge / Quotation Adjustment / Quotation Settlement — the mid-Pending adjustment is never mislabeled as a settlement", async () => {
      await page.waitForSelector(`text=${chargeTestQuoteNumber}`, { timeout: 5000 });
      const rows = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`);
      const count = await rows.count();
      if (count !== 3) throw new Error(`expected 3 ledger legs (charge + Pending-time adjustment + settlement) for ${chargeTestQuoteNumber} in the Quotations filter, found ${count}`);
      await rows.locator("text=Quotation Charge").first().waitFor({ timeout: 3000 });
      await rows.locator("text=Quotation Adjustment").first().waitFor({ timeout: 3000 });
      await rows.locator("text=Quotation Settlement").first().waitFor({ timeout: 3000 });
      await rows.locator("text=Paid").first().waitFor({ timeout: 3000 });
    });
    await page.click('button:has-text("All")');
    await page.fill('input[placeholder="Search…"]', "700");
    await page.waitForTimeout(600);
    await check("free-text search filters by phone fragment", async () => {
      const count = await page.locator("table tbody tr").count();
      if (count === 0) throw new Error("expected phone-number search to find results");
    });

    await page.click('button:has-text("SLSH Transactions")');
    await check("SLSH transaction history is a separate menu with its own records", () => page.waitForSelector("text=/Transaction History — SLSH/", { timeout: 5000 }));
    await page.waitForTimeout(500);
    await check("the seeded SLSH opening-balance-linked exchange appears here instead", () => page.waitForSelector("text=Hodan Hotel (SLSH)", { timeout: 5000 }));

    await check("Settings is a sidebar GROUP (not a flat item), so Deactivated Accounts can live under it", async () => {
      const header = page.getByRole("button", { name: "Settings", exact: true });
      await header.waitFor({ timeout: 3000 });
      const expanded = await header.getAttribute("aria-expanded");
      if (expanded === null) throw new Error("expected Settings to be an expandable group header, not a flat nav item");
    });
    await ensureGroupOpen("Settings");
    await check("Settings group has General and Deactivated Accounts sub-items", async () => {
      await page.getByRole("button", { name: "General", exact: true }).waitFor({ timeout: 3000 });
      await page.getByRole("button", { name: "Deactivated Accounts", exact: true }).waitFor({ timeout: 3000 });
    });
    await page.click('button:has-text("General")');
    await check("settings module loads", () => page.waitForSelector("text=Save changes", { timeout: 5000 }));
    const nameInput = page.getByText("Company name", { exact: true }).locator("xpath=following-sibling::input");
    await nameInput.fill("Test Renamed Co.");
    await page.click('button:has-text("Save changes")');
    await page.waitForTimeout(800);
    await page.click('button:has-text("Dashboard")');
    await check("renamed company appears in sidebar immediately", () => page.waitForSelector("text=Test Renamed Co.", { timeout: 5000 }));

    await ensureGroupOpen("Settings");
    await page.click('button:has-text("General")');
    await page.waitForSelector("text=Save changes", { timeout: 5000 });
    await check("Document appearance section with a PDF accent color picker is present", () => page.waitForSelector('[aria-label="PDF accent color picker"]', { timeout: 5000 }));
    await check("picking a swatch updates the color text field and live preview", async () => {
      await page.click('[aria-label="Use #7a1f2b"]');
      await page.waitForTimeout(200);
      const colorInput = page.getByText("PDF accent color", { exact: true }).locator("xpath=following-sibling::div//input").last();
      const val = await colorInput.inputValue();
      if (val.toLowerCase() !== "#7a1f2b") throw new Error(`expected the text field to sync to the picked swatch, got ${val}`);
    });
    await check("Save PDF appearance persists the accent color", async () => {
      await page.click('button:has-text("Save PDF appearance")');
      await page.waitForSelector("text=/PDF appearance saved/", { timeout: 5000 });
    });

    // -----------------------------------------------------------------
    // APPEARANCE & BRANDING round: Website field, Favicon upload control,
    // and the new live-app Brand Color (separate from the PDF accent color
    // just tested above — that one only affects exported documents).
    // -----------------------------------------------------------------
    await check("Website field is present and saves alongside the other company fields", async () => {
      const websiteInput = page.getByText("Website", { exact: true }).locator("xpath=following-sibling::input");
      await websiteInput.fill("www.geeska-test.example");
      await page.click('button:has-text("Save changes")');
      await page.waitForSelector("text=/Company settings saved/", { timeout: 5000 });
      await page.reload();
      await ensureGroupOpen("Settings");
      await page.click('button:has-text("General")');
      await page.waitForSelector("text=Save changes", { timeout: 5000 });
      const val = await page.getByText("Website", { exact: true }).locator("xpath=following-sibling::input").inputValue();
      if (val !== "www.geeska-test.example") throw new Error(`expected the saved website to survive a reload, got ${JSON.stringify(val)}`);
    });
    await check("Favicon upload control is present under Logo", async () => {
      await page.getByText("Favicon", { exact: true }).waitFor({ timeout: 3000 });
      const faviconInputs = page.locator('input[type="file"][accept*="x-icon"]');
      if ((await faviconInputs.count()) < 1) throw new Error("expected a favicon file input accepting image/x-icon");
    });
    await check("App appearance section with a Brand Color picker is present, separate from PDF accent color", () => page.waitForSelector('[aria-label="Brand color picker"]', { timeout: 5000 }));
    await check("picking a brand-color swatch updates the color text field", async () => {
      await page.click('[aria-label="Use #1d6b4a as brand color"]');
      await page.waitForTimeout(200);
      const colorInput = page.getByText("Brand color", { exact: true }).locator("xpath=following-sibling::div//input").last();
      const val = await colorInput.inputValue();
      if (val.toLowerCase() !== "#1d6b4a") throw new Error(`expected the text field to sync to the picked swatch, got ${val}`);
    });
    await check("Save brand color persists it and applies it live as --c-navy across the app (sidebar, buttons, links)", async () => {
      await page.click('button:has-text("Save brand color")');
      await page.waitForSelector("text=/Brand color saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const navyVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-navy").trim());
      if (navyVar.toLowerCase() !== "#1d6b4a") throw new Error(`expected --c-navy to be live-overridden to the saved brand color, got ${navyVar}`);
    });
    await check("reloading keeps the custom brand color applied (persisted, not just in-memory)", async () => {
      await page.reload();
      await page.waitForTimeout(600);
      const navyVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-navy").trim());
      if (navyVar.toLowerCase() !== "#1d6b4a") throw new Error(`expected the brand color override to survive a reload, got ${navyVar}`);
    });
    await ensureGroupOpen("Settings");
    await page.click('button:has-text("General")');
    await page.waitForSelector("text=Save changes", { timeout: 5000 });
    await check("resetting brand color back to the default swatch restores the built-in --c-navy", async () => {
      await page.click('[aria-label="Use #084b83 as brand color"]');
      await page.click('button:has-text("Save brand color")');
      await page.waitForSelector("text=/Brand color saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const navyVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-navy").trim());
      if (navyVar.toLowerCase() !== "#084b83") throw new Error(`expected --c-navy back to the default swatch value, got ${navyVar}`);
    });

    // -----------------------------------------------------------------
    // APPEARANCE & BRANDING round 2: Theme Presets, Global Colors
    // (Secondary/Accent/Status), and Typography (Font Family/Font Size).
    // -----------------------------------------------------------------
    await check("Theme presets section is present with at least the Geeska Default and Ocean Breeze swatches", async () => {
      await page.getByText("Theme presets", { exact: true }).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Apply Geeska Default theme" }).waitFor({ timeout: 3000 });
      await page.getByRole("button", { name: "Apply Ocean Breeze theme" }).waitFor({ timeout: 3000 });
    });
    await check("applying the Ocean Breeze preset saves immediately and live-overrides --c-navy/--c-mint/--c-cyan", async () => {
      await page.getByRole("button", { name: "Apply Ocean Breeze theme" }).click();
      await page.waitForSelector("text=/theme applied/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const vars = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return { navy: cs.getPropertyValue("--c-navy").trim(), mint: cs.getPropertyValue("--c-mint").trim(), cyan: cs.getPropertyValue("--c-cyan").trim() };
      });
      if (vars.navy.toLowerCase() !== "#0e7490") throw new Error(`expected --c-navy from the Ocean Breeze preset, got ${vars.navy}`);
      if (vars.mint.toLowerCase() !== "#a5f3fc") throw new Error(`expected --c-mint from the Ocean Breeze preset, got ${vars.mint}`);
      if (vars.cyan.toLowerCase() !== "#22d3ee") throw new Error(`expected --c-cyan from the Ocean Breeze preset, got ${vars.cyan}`);
    });
    await check("applying the Geeska Default preset resets Brand/Secondary/Accent back to their built-in values", async () => {
      await page.getByRole("button", { name: "Apply Geeska Default theme" }).click();
      await page.waitForSelector("text=/theme applied/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const vars = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return { navy: cs.getPropertyValue("--c-navy").trim(), mint: cs.getPropertyValue("--c-mint").trim(), cyan: cs.getPropertyValue("--c-cyan").trim() };
      });
      if (vars.navy.toLowerCase() !== "#084b83") throw new Error(`expected --c-navy back to the default, got ${vars.navy}`);
      if (vars.mint.toLowerCase() !== "#bbe6e4") throw new Error(`expected --c-mint back to the default, got ${vars.mint}`);
      if (vars.cyan.toLowerCase() !== "#42bfdd") throw new Error(`expected --c-cyan back to the default, got ${vars.cyan}`);
    });
    await check("Global colors section has Secondary/Accent/Pending/Paid/Refunded fields, and Save colors persists a custom set live", async () => {
      for (const label of ["Secondary color", "Accent color", "Pending status", "Paid status", "Refunded status"]) {
        await page.getByText(label, { exact: true }).waitFor({ timeout: 3000 });
      }
      const setHex = async (label, hex) => {
        const input = page.getByText(label, { exact: true }).locator("xpath=following-sibling::div//input").last();
        await input.fill(hex);
      };
      await setHex("Accent color", "#8b5cf6");
      await setHex("Pending status", "#92400e");
      await setHex("Paid status", "#065f46");
      await setHex("Refunded status", "#5b21b6");
      await page.click('button:has-text("Save colors")');
      await page.waitForSelector("text=/Global colors saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const vars = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          cyan: cs.getPropertyValue("--c-cyan").trim(),
          pending: cs.getPropertyValue("--c-status-pending").trim(),
          paid: cs.getPropertyValue("--c-status-paid").trim(),
          refunded: cs.getPropertyValue("--c-status-refunded").trim(),
        };
      });
      if (vars.cyan.toLowerCase() !== "#8b5cf6") throw new Error(`expected --c-cyan to reflect the saved accent color, got ${vars.cyan}`);
      if (vars.pending.toLowerCase() !== "#92400e") throw new Error(`expected --c-status-pending to reflect the saved value, got ${vars.pending}`);
      if (vars.paid.toLowerCase() !== "#065f46") throw new Error(`expected --c-status-paid to reflect the saved value, got ${vars.paid}`);
      if (vars.refunded.toLowerCase() !== "#5b21b6") throw new Error(`expected --c-status-refunded to reflect the saved value, got ${vars.refunded}`);
    });
    await check("reloading keeps the custom global colors applied (persisted, not just in-memory)", async () => {
      await page.reload();
      await page.waitForTimeout(600);
      const cyan = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-cyan").trim());
      if (cyan.toLowerCase() !== "#8b5cf6") throw new Error(`expected the accent color override to survive a reload, got ${cyan}`);
      await ensureGroupOpen("Settings");
      await page.click('button:has-text("General")');
      await page.waitForSelector("text=Save changes", { timeout: 5000 });
    });
    await check("restoring the built-in status/accent colors resets --c-cyan/--c-status-* accordingly", async () => {
      const setHex = async (label, hex) => {
        const input = page.getByText(label, { exact: true }).locator("xpath=following-sibling::div//input").last();
        await input.fill(hex);
      };
      await setHex("Accent color", "#42bfdd");
      await setHex("Pending status", "#c98a2e");
      await setHex("Paid status", "#2f8f6a");
      await setHex("Refunded status", "#42bfdd");
      await page.click('button:has-text("Save colors")');
      await page.waitForSelector("text=/Global colors saved/", { timeout: 5000 });
    });
    await check("Typography section has Font Family and Font Size selects, and saving Font Family applies --c-font-family live", async () => {
      await page.getByText("Typography", { exact: true }).waitFor({ timeout: 3000 });
      await page.getByText("Font family", { exact: true }).waitFor({ timeout: 3000 });
      await page.getByText("Font size", { exact: true }).waitFor({ timeout: 3000 });
      const familySelect = page.getByText("Font family", { exact: true }).locator("xpath=following-sibling::select");
      await familySelect.selectOption("georgia");
      await page.click('button:has-text("Save typography")');
      await page.waitForSelector("text=/Typography saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const fam = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-font-family").trim());
      if (!fam.toLowerCase().includes("georgia")) throw new Error(`expected --c-font-family to include Georgia, got ${fam}`);
    });
    await check("saving Font Size = Large applies the --c-zoom override, and Medium removes it again", async () => {
      const sizeSelect = page.getByText("Font size", { exact: true }).locator("xpath=following-sibling::select");
      await sizeSelect.selectOption("large");
      await page.click('button:has-text("Save typography")');
      await page.waitForSelector("text=/Typography saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      const zoomLarge = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-zoom").trim());
      if (zoomLarge !== "1.075") throw new Error(`expected --c-zoom to be 1.075 for Large, got ${zoomLarge}`);
      await sizeSelect.selectOption("medium");
      const familySelect = page.getByText("Font family", { exact: true }).locator("xpath=following-sibling::select");
      await familySelect.selectOption("inter");
      await page.click('button:has-text("Save typography")');
      await page.waitForSelector("text=/Typography saved/", { timeout: 5000 });
      await page.waitForTimeout(300);
      // --c-zoom's own default (declared once in THEME_CSS's :root block) is
      // "1", so clearing the inline override at Medium falls back to that
      // stylesheet value rather than to an empty string.
      const zoomMedium = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-zoom").trim());
      if (zoomMedium !== "1") throw new Error(`expected --c-zoom to fall back to its default of 1 at Medium, got ${JSON.stringify(zoomMedium)}`);
    });

    // -----------------------------------------------------------------
    // SUPER ADMIN PDF TEMPLATE CONTROL round (Round 1 — form-based, not
    // the full drag-and-drop visual editor; see README for the scope
    // decision). A third sub-item under Settings, alongside General and
    // Deactivated Accounts.
    // -----------------------------------------------------------------
    await check("Settings group has a PDF Templates sub-item", async () => {
      await ensureGroupOpen("Settings");
      await page.getByRole("button", { name: "PDF Templates", exact: true }).waitFor({ timeout: 3000 });
    });
    await page.click('button:has-text("PDF Templates")');
    await check("PDF Templates module loads, listing the seeded built-in default template", async () => {
      await page.waitForSelector("text=PDF Templates", { timeout: 5000 });
      await page.waitForSelector('table tbody tr:has-text("Standard Quotation")', { timeout: 5000 });
      await page.waitForSelector("text=Built-in", { timeout: 3000 });
      await page.waitForSelector("text=Default", { timeout: 3000 });
    });
    const builtinTemplateRow = page.locator("table tbody tr", { hasText: "Standard Quotation" });
    await check("the built-in default template has no Delete or Archive action while it's the default", async () => {
      const deleteCount = await builtinTemplateRow.getByRole("button", { name: "Delete", exact: true }).count();
      const archiveCount = await builtinTemplateRow.getByRole("button", { name: "Archive", exact: true }).count();
      if (deleteCount !== 0) throw new Error("expected no Delete action on the current default template");
      if (archiveCount !== 0) throw new Error("expected no Archive action on the current default template");
    });
    const qaTemplateName = `QA Template ${Date.now()}`;
    await check("+ New template opens a create-template modal with signature/notes/bill-to toggles and header/footer fields", async () => {
      await page.click('button:has-text("+ New template")');
      const dialog = page.getByRole("dialog", { name: "New template" });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.getByText("Signature lines", { exact: true }).waitFor({ timeout: 2000 });
      await dialog.getByText("Notes section", { exact: true }).waitFor({ timeout: 2000 });
      await dialog.getByText("Template name", { exact: true }).locator("xpath=following-sibling::input").fill(qaTemplateName);
      // Turn off signature lines and add a header note with a placeholder token.
      // "Signature lines" text sits directly inside the <label> alongside its
      // own checkbox (not a separate sibling), so the checkbox is found
      // within the same matched element, not via a parent/sibling traversal.
      await dialog.getByText("Signature lines", { exact: true }).locator('input[type="checkbox"]').click();
      await dialog.locator("textarea").first().fill("Licensed by {{company_name}}");
      await dialog.getByRole("button", { name: "Create template", exact: true }).click();
      await page.waitForSelector("text=/Template created/", { timeout: 5000 });
      await page.waitForSelector(`table tbody tr:has-text("${qaTemplateName}")`, { timeout: 5000 });
    });
    const qaTemplateRow = page.locator("table tbody tr", { hasText: qaTemplateName });
    await check("Preview PDF on the new (non-default) template downloads a real PDF reflecting its settings", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const templates = await page.evaluate(async (tok) => {
        const res = await fetch("/api/pdf-templates", { headers: { Authorization: `Bearer ${tok}` } });
        return (await res.json()).templates;
      }, token);
      const tpl = templates.find((t) => t.name === qaTemplateName);
      if (!tpl) throw new Error("expected the new template to be findable via the API");
      if (tpl.showSignatureLines !== false) throw new Error("expected showSignatureLines to have been turned off");
      if (tpl.headerNote !== "Licensed by {{company_name}}") throw new Error(`expected the header note to persist, got ${JSON.stringify(tpl.headerNote)}`);
      const pdfInfo = await page.evaluate(async ({ tok, id }) => {
        const res = await fetch(`/api/pdf-templates/${id}/preview.pdf`, { headers: { Authorization: `Bearer ${tok}` } });
        const buf = await res.arrayBuffer();
        const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)));
        return { status: res.status, head, size: buf.byteLength };
      }, { tok: token, id: tpl.id });
      if (pdfInfo.status !== 200 || pdfInfo.head !== "%PDF" || pdfInfo.size < 100) throw new Error(`expected a real PDF from preview.pdf, got ${JSON.stringify(pdfInfo)}`);
    });
    await check("Set default on the new template makes it the default, and the old default becomes archivable", async () => {
      await qaTemplateRow.getByRole("button", { name: "Set default", exact: true }).click();
      await page.waitForSelector("text=/is now the default/", { timeout: 5000 });
      await qaTemplateRow.getByText("Default", { exact: true }).waitFor({ timeout: 3000 });
      await builtinTemplateRow.getByRole("button", { name: "Archive", exact: true }).waitFor({ timeout: 3000 });
    });
    await check("Duplicate creates an independent copy with '(Copy)' in the name", async () => {
      await qaTemplateRow.getByRole("button", { name: "Duplicate", exact: true }).click();
      await page.waitForSelector("text=/Duplicated/", { timeout: 5000 });
      await page.waitForSelector(`table tbody tr:has-text("${qaTemplateName} (Copy)")`, { timeout: 5000 });
    });
    await check("cleanup: delete the duplicate, set the built-in back as default, then delete the QA template", async () => {
      const copyRow = page.locator("table tbody tr", { hasText: `${qaTemplateName} (Copy)` });
      await copyRow.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog", { name: `Delete "${qaTemplateName} (Copy)"?` }).getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${qaTemplateName} (Copy)")`, { state: "detached", timeout: 5000 });
      await builtinTemplateRow.getByRole("button", { name: "Set default", exact: true }).click();
      await page.waitForSelector("text=/is now the default/", { timeout: 5000 });
      await qaTemplateRow.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog", { name: `Delete "${qaTemplateName}"?` }).getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForSelector(`table tbody tr:has-text("${qaTemplateName}")`, { state: "detached", timeout: 5000 });
    });
    await check("a real quotation PDF export reflects whichever template is currently the default (builtin — signature lines back)", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const check_ = await page.evaluate(async (tok) => {
        const accRes = await fetch("/api/accounts?currency=USD", { headers: { Authorization: `Bearer ${tok}` } });
        const accId = (await accRes.json()).accounts[0].id;
        const qRes = await fetch("/api/quotations", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientName: "PDF Template QA Client", accountId: accId, items: [{ description: "QA item", qty: 1, unitPrice: 10, currency: "USD" }] }) });
        const q = (await qRes.json()).quotation;
        const pdfRes = await fetch(`/api/quotations/${q.id}/pdf`, { headers: { Authorization: `Bearer ${tok}` } });
        const buf = await pdfRes.arrayBuffer();
        return { status: pdfRes.status, size: buf.byteLength };
      }, token);
      if (check_.status !== 200 || check_.size < 100) throw new Error(`expected a real PDF export, got ${JSON.stringify(check_)}`);
    });

    // -----------------------------------------------------------------
    // ENTERPRISE FINANCIAL MANAGEMENT DASHBOARD round — the full rebuilt
    // Dashboard, driven as amina.yusuf (Admin: has reports + exchangeAll +
    // quotationsApprove + accountsManage + the new dashboard.customize/
    // dashboard.export grants), so every gated widget and action below is
    // expected to be visible. The cashier-role restricted view is checked
    // separately further down, once that role is already logged in for the
    // sidebar-restriction check.
    // -----------------------------------------------------------------
    await page.click('button:has-text("Dashboard")');
    await page.waitForSelector("text=Welcome back", { timeout: 5000 });
    await check("Dashboard renders the full widget set for a reports-permitted role", async () => {
      for (const label of [
        "Total USD Balance", "Total SLSH Balance", "Money In (period)", "Money Out (period)", "Total Payments", "Total Transactions",
        "Account Balance Overview", "Money Flow Trend", "USD / SLSH Balance Trends", "Transaction Distribution", "Transaction Activity — counts",
        "Deposits vs Withdrawals", "Quotation Performance", "Exchange Activity", "Top Accounts — USD", "Top Accounts — SLSH",
        "Recent Transactions", "Recent Payments", "Recent Quotations", "Attention Required",
      ]) {
        await page.getByText(label, { exact: true }).first().waitFor({ timeout: 5000 });
      }
    });
    await check("global filter bar has Date range / Currency / Account / Quotation status / Granularity controls", async () => {
      for (const label of ["Date range", "Currency", "Account", "Quotation status", "Granularity"]) {
        await page.locator(`label:text-is("${label}")`).first().waitFor({ timeout: 3000 });
      }
    });
    await check("Quick Actions are shown for a role that can act on accounts/exchange/quotations", async () => {
      for (const label of ["+ New Account", "+ Deposit / Withdraw", "+ Exchange", "+ New Quotation"]) {
        await page.getByRole("button", { name: label, exact: true }).waitFor({ timeout: 3000 });
      }
    });
    await check("Customize Dashboard and Export buttons are shown (Admin has dashboard.customize/dashboard.export)", async () => {
      await page.getByRole("button", { name: "⚙ Customize Dashboard", exact: true }).waitFor({ timeout: 3000 });
      // HEADER REDESIGN: exports live in the header's ⋯ menu.
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Export CSV", exact: true }).waitFor({ timeout: 3000 });
      await page.getByRole("menuitem", { name: "Export PDF", exact: true }).waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
    });
    await check("changing Date range reloads the dashboard and shows an active-filter chip", async () => {
      const rangeSelect = page.getByText("Date range", { exact: true }).locator("xpath=following-sibling::select");
      await rangeSelect.selectOption("last6Months");
      await page.waitForTimeout(700);
      await page.getByText("Range: Last 6 Months", { exact: false }).waitFor({ timeout: 3000 });
    });
    await check("CURRENCY SAFETY: setting Currency=USD narrows Money Flow Trend to a single USD chart (no SLSH sub-chart)", async () => {
      const currencySelect = page.getByText("Currency", { exact: true }).first().locator("xpath=following-sibling::select");
      await currencySelect.selectOption("USD");
      await page.waitForTimeout(500);
      const moneyFlowCard = page.locator('div.gk-widget-card:has-text("Money Flow Trend")').first();
      await moneyFlowCard.getByText("USD", { exact: true }).first().waitFor({ timeout: 3000 });
      const slshCount = await moneyFlowCard.getByText("SLSH", { exact: true }).count();
      if (slshCount !== 0) throw new Error("expected no SLSH sub-chart in Money Flow Trend while Currency=USD — USD and SLSH must never share one chart");
      await currencySelect.selectOption("all");
      await page.waitForTimeout(500);
    });
    await check("the Account filter scopes the whole dashboard to one account (drill-down)", async () => {
      const accountInput = page.getByPlaceholder("All accounts…");
      await accountInput.fill("Berbera");
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: /Berbera/ }).first().click();
      await page.waitForTimeout(900);
      await page.getByText("Scoped to account:", { exact: false }).waitFor({ timeout: 3000 });
      const topAccountsCount = await page.getByText("Top Accounts — USD", { exact: true }).count();
      if (topAccountsCount !== 0) throw new Error("Top Accounts is a whole-portfolio widget and should disappear once scoped to one account");
    });
    await check("Clear all resets every dashboard filter, including the account drill-down", async () => {
      await page.getByText("Clear all", { exact: true }).click();
      await page.waitForTimeout(700);
      const scopedCount = await page.getByText("Scoped to account:", { exact: false }).count();
      if (scopedCount !== 0) throw new Error("expected the account scope banner to be gone after Clear all");
      await page.getByText("Top Accounts — USD", { exact: true }).waitFor({ timeout: 3000 });
    });
    await check("Customize Dashboard: hiding a widget and saving removes it, and it stays hidden across a reload", async () => {
      await page.getByRole("button", { name: "⚙ Customize Dashboard", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Customize Dashboard" });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.locator('input[type="checkbox"]').first().click(); // "Summary cards" is the first row
      await dialog.getByRole("button", { name: "Save my layout", exact: true }).click();
      await page.waitForSelector("text=/dashboard layout was saved/", { timeout: 5000 });
      const visibleAfterSave = await page.getByText("Total USD Balance", { exact: true }).count();
      if (visibleAfterSave !== 0) throw new Error("expected the Summary cards widget to be hidden immediately after saving");
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("text=Welcome back", { timeout: 8000 });
      const visibleAfterReload = await page.getByText("Total USD Balance", { exact: true }).count();
      if (visibleAfterReload !== 0) throw new Error("expected the hidden widget to stay hidden after a reload (persisted via GET/PATCH /api/dashboard-layout)");
    });
    await check("Reset to default in Customize Dashboard brings the hidden widget back", async () => {
      await page.getByRole("button", { name: "⚙ Customize Dashboard", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Customize Dashboard" });
      await dialog.waitFor({ timeout: 3000 });
      await dialog.getByRole("button", { name: "Reset to default", exact: true }).click();
      await page.waitForTimeout(700);
      await page.getByText("Total USD Balance", { exact: true }).waitFor({ timeout: 3000 });
    });
    await check("Export CSV downloads a real CSV file", async () => {
      const dl = page.waitForEvent("download");
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Export CSV", exact: true }).click();
      const download = await dl;
      if (!download.suggestedFilename().endsWith(".csv")) throw new Error(`expected a .csv download, got ${download.suggestedFilename()}`);
    });
    await check("Export PDF downloads a real PDF file", async () => {
      const dl = page.waitForEvent("download");
      await page.getByRole("button", { name: "More actions" }).first().click();
      await page.getByRole("menuitem", { name: "Export PDF", exact: true }).click();
      const download = await dl;
      if (!download.suggestedFilename().endsWith(".pdf")) throw new Error(`expected a .pdf download, got ${download.suggestedFilename()}`);
    });
    await check("+ Exchange Quick Action navigates to Money Exchange", async () => {
      await page.getByRole("button", { name: "+ Exchange", exact: true }).click();
      await page.waitForSelector('button:has-text("+ New transaction")', { timeout: 5000 });
      await page.click('button:has-text("Dashboard")');
      await page.waitForSelector("text=Welcome back", { timeout: 5000 });
    });

    // -----------------------------------------------------------------
    // Uppercase person-name formatting + full account lifecycle
    // (Deactivate / Reactivate / Permanent Delete) + Transfer
    // -----------------------------------------------------------------
    await ensureGroupOpen("Account");
    await page.click('button:has-text("USD Accounts")');
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("+ Add USD account")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    await page.fill('input[placeholder="e.g. Aisha Nur"]', "lifecycle test person");
    await page.click('button:has-text("Create account")');
    await page.waitForTimeout(600);
    await check("a customer account name is auto-uppercased on save", async () => {
      await page.waitForSelector("text=LIFECYCLE TEST PERSON", { timeout: 5000 });
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (!bodyText.includes("LIFECYCLE TEST PERSON")) throw new Error("expected the customer account name to be stored/shown in full uppercase");
    });

    await page.click('button:has-text("Company accounts")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("+ Add USD account")');
    await page.waitForSelector("text=Add USD account", { timeout: 5000 });
    // The "Company accounts" tab was active before opening this modal, so it
    // defaults to accountType "company" already (placeholder confirms it).
    await page.waitForSelector('input[placeholder="e.g. Hodan Hotel"]', { timeout: 3000 });
    await page.fill('input[placeholder="e.g. Hodan Hotel"]', "Zulu Lifecycle Co.");
    await page.click('button:has-text("Create account")');
    await page.waitForTimeout(600);
    await check("a company account name is left exactly as typed (never uppercased)", () => page.waitForSelector("text=Zulu Lifecycle Co.", { timeout: 5000 }));
    await check("...and specifically NOT shouted in all caps anywhere on the page (case-sensitive check — Playwright's text= matcher is case-insensitive so this uses a strict JS comparison)", async () => {
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes("ZULU LIFECYCLE CO.")) throw new Error("company account name should never be uppercased, but found it in all caps on the page");
      if (!bodyText.includes("Zulu Lifecycle Co.")) throw new Error("expected to find the company account name in its original casing");
    });

    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(300);
    await page.click('table >> text=LIFECYCLE TEST PERSON');
    await page.waitForSelector("text=Account summary", { timeout: 5000 });
    await check("Deactivate button opens a confirmation modal with an optional reason", async () => {
      await page.getByRole("dialog").last().locator('button:text-is("Deactivate")').click();
      await page.waitForSelector("text=/Deactivate LIFECYCLE TEST PERSON\\?/", { timeout: 3000 });
    });
    await page.fill('textarea', "Closing this test account");
    await page.click('button:has-text("Deactivate account")');
    await page.waitForTimeout(600);
    await check("account shows a Deactivated status pill after deactivating", () => page.getByRole("dialog").last().getByText("Deactivated", { exact: true }).first().waitFor({ timeout: 5000 }));
    await check("Quick Action buttons are disabled while deactivated", async () => {
      const disabled = await page.getByRole("dialog").last().locator('button:text-is("Deposit")').isDisabled();
      if (!disabled) throw new Error("expected Deposit Quick Action to be disabled on a deactivated account");
    });
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(400);
    await check("the account no longer appears in the normal USD customer accounts list", async () => {
      const count = await page.locator("table >> text=LIFECYCLE TEST PERSON").count();
      if (count > 0) throw new Error("expected a deactivated account to disappear from the normal accounts list");
    });

    await ensureGroupOpen("Settings");
    await page.click('button:has-text("Deactivated Accounts")');
    await check("Deactivated Accounts page (under Settings) lists the account with reason and who deactivated it", async () => {
      await page.waitForSelector("text=LIFECYCLE TEST PERSON", { timeout: 5000 });
      await page.waitForSelector("text=Closing this test account", { timeout: 3000 });
      await page.waitForSelector("text=Amina Yusuf", { timeout: 3000 });
    });
    await check("Deactivated Accounts shows a Deactivated/USD/SLSH/In debt stat strip reflecting the freshly-deactivated account", async () => {
      await page.waitForSelector("text=Deactivated accounts", { timeout: 3000 });
      await page.waitForSelector("text=USD accounts", { timeout: 3000 });
      await page.waitForSelector("text=SLSH accounts", { timeout: 3000 });
      const count = await page.locator("table tbody tr").count();
      if (count === 0) throw new Error("expected the just-deactivated account to be counted in the strip and listed in the table");
    });
    await check("clicking a Deactivated Accounts row (not the name link or action buttons) opens that account's details", async () => {
      const row = page.locator('table tr:has-text("LIFECYCLE TEST PERSON")').first();
      await row.locator("td").nth(2).click(); // Currency cell
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("clicking View on a Deactivated Accounts row still works, guarded by stopPropagation like the row click", async () => {
      const row = page.locator('table tr:has-text("LIFECYCLE TEST PERSON")').first();
      await row.locator('button:has-text("View")').click();
      await page.waitForSelector("text=Account summary", { timeout: 5000 });
      await page.click('body', { position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    });
    await check("the Deactivated Accounts table shows a Total balance footer, showing USD only (no stray SLSH row) since only a USD account is deactivated so far", async () => {
      const footText = await page.locator("table tfoot").innerText();
      if (!/Total/.test(footText)) throw new Error(`expected a Total label in the deactivated-accounts footer — got: ${JSON.stringify(footText)}`);
      if (!/\$/.test(footText)) throw new Error(`expected a $ figure in the deactivated-accounts footer — got: ${JSON.stringify(footText)}`);
      if (/SLSH/.test(footText)) throw new Error("deactivated-accounts footer should not show a SLSH figure when no SLSH account is deactivated yet");
    });
    await check("a direct API call confirms deactivating blocks new transactions server-side", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const row = await page.evaluate(async (tok) => {
        const res = await fetch("/api/accounts/deactivated", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.accounts.find((a) => a.name === "LIFECYCLE TEST PERSON");
      }, token);
      const result = await page.evaluate(async ({ tok, id }) => {
        const res = await fetch(`/api/accounts/${id}/deposit`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ amount: 10 }) });
        return res.status;
      }, { tok: token, id: row.id });
      if (result !== 400) throw new Error(`expected deposit on a deactivated account to be rejected with 400, got ${result}`);
    });
    await page.click('table tr:has-text("LIFECYCLE TEST PERSON") >> button:has-text("Reactivate")');
    await page.waitForTimeout(500);
    await check("reactivating removes it from the Deactivated Accounts list", async () => {
      const count = await page.locator("table >> text=LIFECYCLE TEST PERSON").count();
      if (count > 0) throw new Error("expected the reactivated account to leave the Deactivated Accounts list");
    });
    await ensureGroupOpen("Account");
    await page.click('button:has-text("USD Accounts")');
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(300);
    await check("reactivating restores it to the normal USD customer accounts list", () => page.waitForSelector("table >> text=LIFECYCLE TEST PERSON", { timeout: 5000 }));

    await check("deleting an ACTIVE account is blocked server-side", async () => {
      const token = await page.evaluate(() => localStorage.getItem("geeska_token"));
      const acct = await page.evaluate(async (tok) => {
        const res = await fetch("/api/accounts?search=LIFECYCLE", { headers: { Authorization: `Bearer ${tok}` } });
        const d = await res.json();
        return d.accounts.find((a) => a.name === "LIFECYCLE TEST PERSON");
      }, token);
      const status = await page.evaluate(async ({ tok, id }) => {
        const res = await fetch(`/api/accounts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirmName: "LIFECYCLE TEST PERSON" }) });
        return res.status;
      }, { tok: token, id: acct.id });
      if (status !== 400) throw new Error(`expected deleting an active account to be rejected with 400, got ${status}`);
    });

    await page.click('table >> text=LIFECYCLE TEST PERSON');
    await page.waitForSelector("text=Account summary", { timeout: 5000 });
    await page.getByRole("dialog").last().locator('button:text-is("Deactivate")').click();
    await page.click('button:has-text("Deactivate account")');
    await page.waitForTimeout(600);
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(400);
    await ensureGroupOpen("Settings");
    await page.click('button:has-text("Deactivated Accounts")');
    await page.waitForSelector("text=LIFECYCLE TEST PERSON", { timeout: 5000 });
    await check("Delete Account requires typing the exact account name to confirm", async () => {
      await page.click('table tr:has-text("LIFECYCLE TEST PERSON") >> button:has-text("Delete Account")');
      await page.waitForSelector("text=/Permanently delete LIFECYCLE TEST PERSON\\?/", { timeout: 3000 });
      const deleteBtn = page.getByRole("dialog").last().locator('button:text-is("Delete permanently")');
      await page.getByRole("dialog").last().locator("input").first().fill("wrong name");
      if (!(await deleteBtn.isDisabled())) throw new Error("expected the confirm button to stay disabled until the name matches exactly");
      await page.getByRole("dialog").last().locator("input").first().fill("LIFECYCLE TEST PERSON");
      if (await deleteBtn.isDisabled()) throw new Error("expected the confirm button to enable once the name matches exactly");
      await deleteBtn.click();
      await page.waitForTimeout(600);
    });
    await check("permanently deleted account disappears from the Deactivated Accounts list entirely, preserving its history intact", async () => {
      const count = await page.locator("table >> text=LIFECYCLE TEST PERSON").count();
      if (count > 0) throw new Error("expected the permanently-deleted account to be gone from every list");
    });

    // Transfer — same-currency money movement between two different accounts.
    await ensureGroupOpen("Account");
    await page.click('button:has-text("USD Accounts")');
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(300);
    await page.click('table >> text=Aisha Nur');
    await page.waitForSelector("text=Account summary", { timeout: 5000 });
    await page.getByRole("dialog").last().locator('button:text-is("Transfer")').click();
    await page.waitForSelector("text=Transfer USD", { timeout: 3000 });
    await check("Transfer modal locks the FROM side to the account it was opened from", () => page.getByRole("dialog").last().getByText("Aisha Nur").first().waitFor({ timeout: 3000 }));
    const toSearchInputs = page.getByRole("dialog").last().locator('input[placeholder="Start typing…"]');
    await toSearchInputs.last().fill("Warsame");
    await page.waitForTimeout(500);
    await page.getByRole("dialog").last().locator('button:has-text("Warsame Trading Co.")').first().click();
    await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("25");
    await page.getByRole("dialog").last().locator('button:text-is("Transfer")').last().click();
    await page.waitForTimeout(700);
    await check("transfer shows up as a Transfer row in the source account's activity", () => page.getByRole("dialog").last().locator('table >> text=Transfer to').first().waitFor({ timeout: 5000 }));

    // Close the account detail modal — its backdrop otherwise intercepts
    // pointer events on the sidebar nav for the next step.
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    // -----------------------------------------------------------------
    // UNIFIED TRANSACTION HISTORY — row-click Detail view, with each
    // record type's own Update/Delete flow (never a reimplementation):
    // Transfer (new PATCH/DELETE replacing the old Void), a plain
    // (previously entirely invisible here) deposit/withdrawal routed to
    // the generic account-ledger endpoints, a quotation ledger leg
    // offering only a source-module link (never edited here directly),
    // and permission gating for a view-only role.
    // -----------------------------------------------------------------
    await ensureGroupOpen("Transaction History");
    await page.click('button:has-text("USD Transactions")');
    await page.waitForTimeout(400);
    await page.locator('button:not(.gk-nav-btn):has-text("Transfers")').first().click();
    await page.waitForTimeout(400);
    await check("the Aisha Nur -> Warsame transfer appears in the Transfers filter with a formatted TR-YYYY-#### reference", async () => {
      const row = page.locator('table tbody tr:has-text("Aisha Nur")').first();
      await row.waitFor({ timeout: 5000 });
      const text = await row.innerText();
      if (!/TR-\d{4}-\d{4}/.test(text)) throw new Error(`expected a formatted TR-YYYY-#### reference, got row text: ${text}`);
    });
    await page.locator('table tbody tr:has-text("Aisha Nur")').first().click();
    await check("clicking a Transfer row opens its Detail view with Update/Delete actions (admin has transferUpdate/transferDelete)", async () => {
      await page.waitForSelector("text=Transfer ·", { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("$25.00", { exact: false }).first().waitFor({ timeout: 3000 });
      await dialog.locator('button:text-is("Update")').waitFor({ timeout: 3000 });
      await dialog.locator('button:text-is("Delete")').waitFor({ timeout: 3000 });
    });
    await page.getByRole("dialog").last().locator('button:text-is("Update")').click();
    await page.waitForSelector("text=Edit transfer", { timeout: 3000 });
    await check("the Transfer edit form is prefilled from the existing record", async () => {
      const dialog = page.getByRole("dialog").last();
      await dialog.getByText("Aisha Nur", { exact: false }).first().waitFor({ timeout: 3000 });
      await dialog.getByText("Warsame Trading Co.", { exact: false }).first().waitFor({ timeout: 3000 });
    });
    await page.getByRole("dialog").last().getByText(/^Amount/).locator("xpath=following-sibling::input").fill("40");
    await page.getByRole("dialog").last().locator('button:text-is("Save changes")').click();
    await page.waitForTimeout(700);
    await check("Transaction History reflects the updated transfer amount, and the account balances stayed consistent, after Update", async () => {
      const row = page.locator('table tbody tr:has-text("Aisha Nur")').first();
      await row.waitFor({ timeout: 5000 });
      const text = await row.innerText();
      if (!text.includes("$40.00")) throw new Error(`expected the updated $40.00 amount in the row, got: ${text}`);
    });

    const rowCountBeforeTransferDelete = await page.locator("table tbody tr").count();
    await page.locator('table tbody tr:has-text("Aisha Nur")').first().click();
    await page.waitForSelector("text=Transfer ·", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('button:text-is("Delete")').click();
    await page.waitForSelector("text=Delete Transfer Permanently?", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('button:text-is("Delete Permanently")').click();
    await page.waitForTimeout(700);
    await check("the transfer is permanently gone from Transaction History after Delete (replaces the old Void flow entirely)", async () => {
      const count = await page.locator("table tbody tr").count();
      if (count !== rowCountBeforeTransferDelete - 1) throw new Error(`expected ${rowCountBeforeTransferDelete - 1} rows, got ${count}`);
      const stillThere = await page.locator('table tbody tr:has-text("Aisha Nur")').count();
      if (stillThere > 0) throw new Error("expected the deleted transfer to no longer appear anywhere in this filter");
    });

    // Plain (unlinked) deposit — previously the single biggest gap in
    // Transaction History: a manual deposit/withdrawal never appeared here
    // at all before this round.
    await ensureGroupOpen("Account");
    await page.click('button:has-text("USD Accounts")');
    await page.click('button:has-text("Customer accounts")');
    await page.waitForTimeout(300);
    await page.click('table >> text=Aisha Nur');
    await page.waitForSelector("text=Account summary", { timeout: 5000 });
    await page.getByRole("dialog").last().locator('button:text-is("Deposit")').click();
    await page.waitForSelector("text=New USD deposit / withdrawal", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('input[type="number"]').fill("77");
    await page.getByRole("dialog").last().locator('button:text-is("Deposit")').last().click();
    await page.waitForTimeout(600);
    await check("fresh deposit recorded via the account's Quick Action", () => page.getByRole("dialog").last().getByText("$77.00", { exact: false }).first().waitFor({ timeout: 5000 }));
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    await ensureGroupOpen("Transaction History");
    await page.click('button:has-text("USD Transactions")');
    await page.waitForTimeout(300);
    await page.locator('button:not(.gk-nav-btn):has-text("Deposits")').first().click();
    await page.waitForTimeout(400);
    // Aisha Nur already carries other plain deposits from earlier tests in
    // this same run (a seeded $150 deposit, plus a $9,999,999 withdraw/
    // redeposit pair from the debt test above) — "Aisha Nur" alone is
    // ambiguous among several rows, so this pins down the ONE fresh $77.00
    // row by its own just-assigned reference number and uses that reference
    // (never plain "Aisha Nur" text) for every subsequent step below.
    let freshDepositRef;
    await check("the fresh deposit appears under the Deposits filter with a formatted DEP-YYYY-#### reference", async () => {
      const row = page.locator('table tbody tr:has-text("Aisha Nur")').filter({ hasText: "$77.00" }).first();
      await row.waitFor({ timeout: 5000 });
      const text = await row.innerText();
      const m = text.match(/DEP-\d{4}-\d{4}/);
      if (!m) throw new Error(`expected a formatted DEP-YYYY-#### reference, got: ${text}`);
      freshDepositRef = m[0];
    });
    await page.locator(`table tbody tr:has-text("${freshDepositRef}")`).first().click();
    await page.waitForSelector("text=Deposit ·", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('button:text-is("Update")').click();
    await page.waitForSelector("text=Edit deposit", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('input[type="number"]').fill("88");
    await page.getByRole("dialog").last().locator('button:text-is("Save changes")').click();
    await page.waitForTimeout(700);
    await check("the Deposits filter reflects the updated amount — routed to the generic account-ledger endpoint, correctly, since this row is unlinked", async () => {
      const row = page.locator(`table tbody tr:has-text("${freshDepositRef}")`).first();
      await row.waitFor({ timeout: 5000 });
      const text = await row.innerText();
      if (!text.includes("$88.00")) throw new Error(`expected the updated $88.00 amount, got: ${text}`);
    });

    const rowCountBeforeDepositDelete = await page.locator("table tbody tr").count();
    await page.locator(`table tbody tr:has-text("${freshDepositRef}")`).first().click();
    await page.waitForSelector("text=Deposit ·", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('button:text-is("Delete")').click();
    await page.waitForSelector("text=Delete deposit", { timeout: 3000 });
    await page.getByRole("dialog").last().locator('button:text-is("Delete entry")').click();
    await page.waitForTimeout(700);
    await check("the deposit is gone from the Deposits filter after Delete via Transaction History", async () => {
      const count = await page.locator("table tbody tr").count();
      if (count !== rowCountBeforeDepositDelete - 1) throw new Error(`expected ${rowCountBeforeDepositDelete - 1} rows, got ${count}`);
      const stillThere = await page.locator(`table tbody tr:has-text("${freshDepositRef}")`).count();
      if (stillThere > 0) throw new Error("expected the deleted deposit to no longer appear");
    });

    // A quotation ledger leg is one leg of a two-step settlement the
    // Quotations module itself owns — Transaction History must never let it
    // be edited/deleted directly, only link into its source module.
    await page.locator('button:not(.gk-nav-btn):has-text("Quotations")').first().click();
    await page.waitForTimeout(400);
    await check("a Quotation-leg row's Detail view shows no Update/Delete, only a source-module link into Quotations", async () => {
      const row = page.locator(`table tbody tr:has-text("${chargeTestQuoteNumber}")`).filter({ hasText: "Quotation Settlement" }).first();
      await row.waitFor({ timeout: 5000 });
      await row.click();
      await page.waitForSelector("text=Quotation Settlement ·", { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      const mutating = await dialog.locator('button:text-is("Update"), button:text-is("Delete")').count();
      if (mutating > 0) throw new Error("expected no direct Update/Delete action on a quotation ledger leg from Transaction History");
      await dialog.locator('button:text-is("Open in Quotations")').waitFor({ timeout: 3000 });
    });
    await page.getByRole("dialog").last().locator('button:text-is("Open in Quotations")').click();
    await page.waitForTimeout(400);
    await check("Open in Quotations navigates straight to that quotation's own status tab", () => page.waitForSelector(`text=${chargeTestQuoteNumber}`, { timeout: 5000 }));

    // Permission gating: a role with Transaction History view access
    // (reports) but none of exchangeUpdate/exchangeDelete/transferUpdate/
    // transferDelete/accountsManage must see NO Update/Delete action on ANY
    // row's Detail view — respecting each type's own existing permission
    // rather than a blanket new one.
    await page.click('[aria-label="Account menu"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[placeholder="e.g. amina.yusuf"]');
    await page.fill('input[placeholder="e.g. amina.yusuf"]', "sahra.ismail");
    await page.fill('input[type="password"]', DEMO_PW);
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector("text=Viewer / Auditor", { timeout: 8000 });
    await ensureGroupOpen("Transaction History");
    await page.click('button:has-text("USD Transactions")');
    await page.waitForTimeout(400);
    await check("the viewer role sees Transaction History rows but no Update/Delete action on any row's Detail view", async () => {
      await page.locator("table tbody tr").first().waitFor({ timeout: 5000 });
      await page.locator("table tbody tr").first().click();
      await page.waitForSelector('button:text-is("Close")', { timeout: 3000 });
      const dialog = page.getByRole("dialog").last();
      const mutating = await dialog.locator('button:text-is("Update"), button:text-is("Delete")').count();
      if (mutating > 0) throw new Error("expected the read-only viewer role to see no Update/Delete action in Transaction History's Detail view");
    });
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    await page.click('[aria-label="Account menu"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[placeholder="e.g. amina.yusuf"]');
    await page.fill('input[placeholder="e.g. amina.yusuf"]', "amina.yusuf");
    await page.fill('input[type="password"]', DEMO_PW);
    await page.click('button:has-text("Sign in")');
    await check("back to admin for the remaining checks", () => page.waitForSelector("text=Welcome back", { timeout: 8000 }));

    await page.click('button:has-text("Money Exchange")');
    await page.waitForTimeout(400);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "More actions" }).first().click();
    await page.click('[role="menuitem"]:has-text("Export PDF")');
    const download = await downloadPromise;
    await check("PDF export downloads", async () => { if (!download.suggestedFilename().endsWith(".pdf")) throw new Error("not a pdf"); });

    await page.click('[aria-label="Account menu"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[placeholder="e.g. amina.yusuf"]');
    await page.fill('input[placeholder="e.g. amina.yusuf"]', "cabdi.maxamed");
    await page.fill('input[type="password"]', DEMO_PW);
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector("text=Cashier / Teller", { timeout: 8000 });
    await check("cashier role is correctly restricted in the UI", async () => {
      const navText = (await page.locator('div:has-text("Financial System")').first().locator("xpath=..").innerText());
      if (navText.includes("Users & Roles") || navText.includes("Reports") || navText.includes("Quotations") || navText.includes("Payment")) {
        throw new Error("cashier can see a module they should not have access to");
      }
      if (!navText.includes("USD Accounts") || !navText.includes("SLSH Accounts")) {
        throw new Error("cashier should still see both Accounts menus (view-only)");
      }
    });

    await check("cashier (no 'reports' permission) sees only the currency converter on the Dashboard — no filter bar, Quick Actions, Customize/Export buttons, or widget grid", async () => {
      await page.waitForSelector("text=Welcome back", { timeout: 5000 });
      const bodyText = await page.locator("body").innerText();
      const forbidden = ["Customize Dashboard", "Export CSV", "Export PDF", "Quick Actions", "Granularity", "Quotation status"];
      for (const label of forbidden) {
        if (bodyText.includes(label)) throw new Error(`cashier (no 'reports') should not see "${label}" on the Dashboard`);
      }
      const widgetLabels = ["Total USD Balance", "Money Flow Trend", "Balance Trend", "Top Accounts", "Recent Transactions", "Attention Required"];
      for (const label of widgetLabels) {
        if (bodyText.includes(label)) throw new Error(`cashier (no 'reports') should not see the "${label}" widget on the Dashboard`);
      }
    });

    await check("cashier (no 'rateManage') sees no Sale Rate anywhere — not the header, not the Dashboard", async () => {
      const bodyText = await page.locator("body").innerText();
      // RATE MANAGEMENT UNIFICATION round: the unified "EXCHANGE RATES" card,
      // its "Manage Rates" button (header + Dashboard), and the "Sale rate:"
      // line are all gated on rateManage — a cashier should see none of
      // them, only the plain public "1 USD = SLSH …" Daily Rate text.
      if (/EXCHANGE RATES/.test(bodyText) || bodyText.includes("Manage Rates") || bodyText.includes("Set Rates") || /Sale rate:/i.test(bodyText) || bodyText.includes("Set sale rate")) {
        throw new Error("cashier (no 'rateManage') should not see the Sale Rate anywhere in the app");
      }
    });

    // SUPER ADMIN + ADVANCED ROLE & PERMISSION MANAGEMENT round, Phase 3:
    // confirm the dedicated super.admin bootstrap account (src/db.js) — a
    // REAL is_super_admin=1 role, distinct from the legacy "admin" role — is
    // correctly wired end-to-end through the new server-resolved
    // user.perms/user.roleLabel (routes/auth.js's publicUser ->
    // resolveUserPermissions's ALL_ACCESS bypass), not just at the API level
    // (already covered by test/rbac.js) but all the way through to what the
    // rewired app.jsx sidebar actually renders.
    await page.click('[aria-label="Account menu"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[placeholder="e.g. amina.yusuf"]');
    await page.fill('input[placeholder="e.g. amina.yusuf"]', "super.admin");
    await page.fill('input[type="password"]', SA_PW);
    await page.click('button:has-text("Sign in")');
    await page.waitForSelector("text=Welcome back", { timeout: 8000 });
    await check("SUPER ADMIN: displayed role is the real 'Super Admin' role, not the legacy 'Admin' label", () =>
      page.waitForSelector("text=Super Admin", { timeout: 5000 })
    );
    await check("SUPER ADMIN: sees every module in the sidebar unconditionally (ALL_ACCESS bypass, not a hard-coded table)", async () => {
      const navText = await page.locator('div:has-text("Financial System")').first().locator("xpath=..").innerText();
      for (const label of ["USD Accounts", "SLSH Accounts", "USD Payment", "SLSH Payment", "Money Exchange", "Quotations", "Transaction History", "Reports", "Users & Roles", "Settings"]) {
        if (!navText.includes(label)) throw new Error(`Super Admin should see "${label}" in the sidebar but it's missing`);
      }
    });
    await page.click('button:has-text("Money Exchange")');
    await check("SUPER ADMIN: can reach a module a normal Admin can already reach too (sanity: not just an empty shell)", () =>
      page.waitForSelector('button:has-text("+ New transaction")', { timeout: 5000 })
    );
    await page.click('[aria-label="Account menu"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[placeholder="e.g. amina.yusuf"]');
    await page.fill('input[placeholder="e.g. amina.yusuf"]', "amina.yusuf");
    await page.fill('input[type="password"]', DEMO_PW);
    await page.click('button:has-text("Sign in")');
    await check("back to admin after the Super Admin check", () => page.waitForSelector("text=Welcome back", { timeout: 8000 }));

    // Dark / White theme toggle
    await check("theme toggle (sun/moon pill) is present in the topbar", () => page.waitForSelector('[aria-label="Dark theme"]', { timeout: 5000 }));
    const paperBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-paper").trim());
    await page.click('[aria-label="Dark theme"]');
    await page.waitForTimeout(300);
    await check("data-theme attribute flips to dark", async () => {
      const attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      if (attr !== "dark") throw new Error(`expected data-theme="dark", got "${attr}"`);
    });
    await check("page background color actually changes", async () => {
      const paperAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-paper").trim());
      if (paperAfter === paperBefore) throw new Error("background CSS variable did not change after toggling theme");
    });
    await check("the Light-theme pill button is still there to switch back", () => page.waitForSelector('[aria-label="Light theme"]', { timeout: 3000 }));
    await page.reload({ waitUntil: "networkidle" });
    await check("theme choice persists across a page reload", async () => {
      const attr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      if (attr !== "dark") throw new Error(`expected persisted data-theme="dark" after reload, got "${attr}"`);
    });

    await browser.close();

    if (problems.length) {
      console.log("\nProblems detected:");
      problems.forEach((p) => console.log("  - " + p));
      process.exitCode = 1;
    } else {
      console.log("\nAll checks passed.");
    }
  } finally {
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
