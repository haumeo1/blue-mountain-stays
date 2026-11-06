// Browser regression suite: owner portal + guest request/pay flow.
// Runs ONLY against the synthetic fixture (tests/browser/fixture-server.mjs). It exercises the
// production UI bundles against an in-memory MOCK API. Passing here does NOT verify real Stripe,
// Supabase, or email behaviour — only that the UI follows the documented contract.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_HOST = "127.0.0.1";

// ---------- dates (property time zone, matches the fixture) ----------
const torontoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Seeded fixture occupies today+21..24 (confirmed) and today+50..52 (block). Use ranges well clear of those.
const stay = (offset, nights = 3) => { const ci = addDays(torontoToday(), offset); return { checkIn: ci, checkOut: addDays(ci, nights), nights }; };
let seq = 0;
const syntheticGuest = (label) => { seq += 1; const id = `${Date.now().toString(36)}${seq}`; return { name: `Synthetic ${label} ${id}`, email: `synthetic.${label.toLowerCase()}.${id}@example.invalid` }; };

// ---------- per-test isolation ----------
test.beforeEach(async ({ context, request }) => {
  // Fixture control endpoint only (synthetic reset). Nothing else is called via `request`.
  const reset = await request.post("/__fixture/reset", { maxRedirects: 0 });
  expect(reset.status()).toBe(303);
  // Never touch the real network: stub external fonts/images, and a fake checkout page for checkout.stripe.com.
  await context.route((url) => url.hostname !== LOCAL_HOST, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "checkout.stripe.com") {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fake checkout (test stub)</title><h1>FAKE CHECKOUT — TEST STUB</h1><p>No payment is taken here.</p>" });
    }
    return route.fulfill({ status: 204, body: "" });
  });
});

// ---------- helpers (UI locators + fixture controls only) ----------
async function fixtureControl(page, buttonName) {
  await page.goto("/__fixture");
  await expect(page.getByRole("note")).toContainText("SYNTHETIC CONTRACT FIXTURE");
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForURL("**/__fixture");
  await expect(page.getByRole("heading", { name: "Fixture control" })).toBeVisible();
}

async function ownerSignIn(page) {
  await page.goto("/__fixture");
  await page.getByRole("link", { name: "Owner portal (fixture sign-in)" }).click();
  await expect(page.getByRole("heading", { name: "A little clarity for your day." })).toBeVisible();
  await expect(page.locator("#overview-stats article")).toHaveCount(4);
  // Token must not linger in the address bar.
  await expect(page).not.toHaveURL(/access_token/);
}

const adminNav = (page) => page.getByRole("navigation", { name: "Admin sections" });
async function goSection(page, linkName, heading) {
  await adminNav(page).getByRole("link", { name: linkName, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

const stat = (page, name) => page.locator("#overview-stats article", { hasText: name }).locator("strong");
const detailValue = (dialog, label) => dialog.locator(".detail-grid > div").filter({ has: dialog.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");

async function openBookingFor(page, guestName) {
  await goSection(page, "Bookings", "Bookings");
  await page.getByRole("searchbox", { name: "Search bookings" }).fill(guestName);
  await page.getByRole("button", { name: "Apply" }).click();
  const row = page.locator("#booking-rows tr", { hasText: guestName });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Details" }).click();
  const dialog = page.getByRole("dialog", { name: guestName });
  await expect(dialog).toBeVisible();
  await expect(detailValue(dialog, "Status")).not.toBeEmpty();
  return dialog;
}

async function confirmIn(page, title, confirmLabel, reason) {
  const confirm = page.getByRole("dialog", { name: title });
  await expect(confirm).toBeVisible();
  if (reason) await confirm.getByLabel("Reason").fill(reason);
  await confirm.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(confirm).toBeHidden();
  return confirm;
}

async function approve(page, guestName) {
  const dialog = await openBookingFor(page, guestName);
  await expect(detailValue(dialog, "Status")).toHaveText("pending");
  await expectNoHorizontalOverflow(page);
  const approveButton = dialog.getByRole("button", { name: "Approve" });
  await expectDialogFits(page, dialog, approveButton);
  await approveButton.click();
  await confirmIn(page, "Approve this request?", "Approve");
  await expect(detailValue(dialog, "Status")).toHaveText("payment due");
  await expect(detailValue(dialog, "Payment")).toHaveText("payment due");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

async function quoteDates(page, { checkIn, checkOut }) {
  const form = page.locator("#booking-form");
  await expect(page.locator("#booking-mode")).toContainText("Request to book");
  await form.getByLabel("Check in").fill(checkIn);
  await form.getByLabel("Check out").fill(checkOut);
  return form;
}

async function requestStay(page, dates, guest) {
  await page.goto("/");
  const form = await quoteDates(page, dates);
  // The price shown comes from the server quote for exactly these dates.
  await expect(form.locator("#price-breakdown")).toContainText(`Stay · ${dates.nights} nights`);
  await expect(form.locator("#price-breakdown")).toContainText("Total");
  await form.getByLabel("Full name").fill(guest.name);
  await form.getByLabel("Email address").fill(guest.email);
  const submit = form.getByRole("button", { name: /Send booking request/ });
  await expect(submit).toBeEnabled();
  await submit.click();
  const modal = page.getByRole("dialog", { name: "Your request is pending." });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Pending owner review");
  const link = modal.getByRole("link", { name: /Open my private booking page/ });
  await expect(link).toHaveAttribute("href", /^\/booking#token=/);
  return link.getAttribute("href");
}

async function expectNoGuestPiiInStorage(page, guest) {
  const dump = await page.evaluate(() => {
    const read = (s) => { const out = {}; for (let i = 0; i < s.length; i += 1) { const k = s.key(i); out[k] = s.getItem(k); } return out; };
    return { local: read(localStorage), session: read(sessionStorage) };
  });
  const all = JSON.stringify(dump).toLowerCase();
  expect(all).not.toContain(guest.email.toLowerCase());
  expect(all).not.toContain(guest.name.toLowerCase());
  expect(JSON.stringify(dump.local)).not.toContain("access_token");
}

// Compare against documentElement.clientWidth (the device/CSS viewport). window.innerWidth is
// inflated on mobile when content widens the layout viewport, which would hide the overflow.
async function expectNoHorizontalOverflow(page) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollsX = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true; } return false; };
    const offenders = [...document.body.querySelectorAll("*")]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > vw + 1 && !scrollsX(el) && !el.closest("dialog:not([open])"))
      .slice(0, 8).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { vw, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, scrollX: window.scrollX, offenders };
  });
  expect(r.scrollWidth - r.vw, `horizontal overflow ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
  expect(r.innerWidth - r.vw, `layout viewport widened ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
  expect(r.scrollX).toBe(0);
}

// Dialog must fit the actual viewport and the action must be the real hit target (no force).
async function expectDialogFits(page, dialog, action) {
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  if (action) {
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport();
    const hit = await action.evaluate((el) => { const b = el.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return el === top || el.contains(top); });
    expect(hit, "action button is the topmost element at its centre").toBe(true);
  }
}

// ---------- tests ----------
test.describe("owner access", () => {
  test("unauthenticated visitor sees only the login form; magic link request is acknowledged", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin sections" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "A little clarity for your day." })).toBeHidden();
    await page.getByLabel("Email address").fill("owner@example.invalid");
    await page.getByRole("button", { name: /Email me a sign-in link/ }).click();
    await expect(page.locator("#auth-message")).toContainText("Check your inbox");
    await expect(page.getByRole("navigation", { name: "Admin sections" })).toBeHidden();
  });

  test("synthetic owner sign-in reaches all 8 sections; sign-out returns to login", async ({ page }) => {
    await ownerSignIn(page);
    const sections = [
      ["Bookings", "Bookings"], ["Availability", "Availability"], ["Pricing", "Pricing"], ["Property", "Property content"],
      ["Payments", "Payments"], ["Notifications", "Notifications & calendar"], ["Settings", "Settings"], ["Overview", "A little clarity for your day."]
    ];
    for (const [link, heading] of sections) {
      await goSection(page, link, heading);
      await expect(adminNav(page).getByRole("link", { name: link, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#breadcrumb")).toHaveText(link);
      await expect(page.locator("main [role=alert]:visible")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(page.locator("#auth-message")).toContainText("signed out");
  });
});

test.describe("pricing and content", () => {
  test("tax confirmation requires the explicit checkbox; saved rate drives guest quotes", async ({ page, context }) => {
    await ownerSignIn(page);
    await goSection(page, "Pricing", "Pricing");
    const form = page.locator("#pricing-form");
    const save = form.getByRole("button", { name: "Save pricing" });
    await expect(save).toBeEnabled();
    await expect(page.locator("#tax-status")).toHaveText("(not confirmed)");

    // Saving without ticking the checkbox must not confirm tax.
    await form.getByLabel("Nightly rate").fill("450.00");
    await expect(form.getByRole("checkbox", { name: /I confirm the tax rate/ })).not.toBeChecked();
    await save.click();
    await expect(page.locator("#live")).toHaveText(/Pricing saved/);
    await expect(form.getByLabel("Nightly rate")).toHaveValue("450.00");
    await expect(page.locator("#tax-status")).toHaveText("(not confirmed)");

    await form.getByRole("checkbox", { name: /I confirm the tax rate/ }).check();
    await save.click();
    await expect(page.locator("#tax-status")).toHaveText("(confirmed)");

    // Persisted across a full reload.
    await page.reload();
    await goSection(page, "Pricing", "Pricing");
    await expect(form.getByLabel("Nightly rate")).toHaveValue("450.00");
    await expect(form.getByRole("checkbox", { name: /I confirm the tax rate/ })).toBeChecked();

    const guest = await context.newPage();
    await guest.goto("/");
    await quoteDates(guest, stay(60));
    await expect(guest.locator("#price-breakdown")).toContainText("Total");
    await expect(guest.locator("#nightly-price")).toHaveText("$450.00");
  });

  test("content draft is invisible to guests until published", async ({ page, context }) => {
    const headline = `Synthetic headline ${Date.now().toString(36)}`;
    await ownerSignIn(page);
    await goSection(page, "Property", "Property content");
    const form = page.locator("#content-form");
    await expect(form.getByRole("button", { name: "Save draft" })).toBeEnabled();
    await form.getByLabel("Hero headline").fill(headline);
    await form.getByRole("button", { name: "Save draft" }).click();
    await expect(page.locator("#live")).toHaveText(/Draft saved/);

    const guest = await context.newPage();
    await guest.goto("/");
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Your place to come together.");
    await expect(guest.getByRole("heading", { level: 1 })).not.toHaveText(headline);

    await page.getByRole("button", { name: "Publish" }).click();
    await confirmIn(page, "Publish this draft?", "Publish");
    await expect(page.locator("#live")).toHaveText(/Published/);

    await guest.reload();
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText(headline);

    // Draft persisted on the server, not just in the form.
    await page.reload();
    await goSection(page, "Property", "Property content");
    await expect(form.getByLabel("Hero headline")).toHaveValue(headline);
  });
});

test.describe("request → approve → pay", () => {
  test("guest pays only via verified payment; redirect alone never confirms", async ({ page, context }) => {
    const guest = syntheticGuest("Payer");
    const dates = stay(70);
    const guestPage = await context.newPage();
    const href = await requestStay(guestPage, dates, guest);
    await expectNoGuestPiiInStorage(guestPage, guest);

    await guestPage.goto(href);
    await expect(guestPage.getByRole("heading", { name: "Request pending" })).toBeVisible();
    await expect(guestPage.getByRole("button", { name: /Pay securely/ })).toBeHidden();
    await expect(guestPage).not.toHaveURL(/token=/);

    await ownerSignIn(page);
    await approve(page, guest.name);

    await guestPage.getByRole("button", { name: "Refresh status" }).click();
    await expect(guestPage.getByRole("heading", { name: "Approved — payment due" })).toBeVisible();
    const pay = guestPage.getByRole("button", { name: /Pay securely/ });
    await expect(pay).toBeVisible();

    // Start checkout. The fixture returns a FAKE checkout.stripe.com URL which the context route
    // intercepts with a local stub page — validates redirect behaviour only; no real Stripe or network.
    await pay.click();
    await guestPage.waitForURL((u) => u.hostname === "checkout.stripe.com");
    expect(guestPage.url()).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_fixture_/);
    await expect(guestPage.getByRole("heading", { name: /FAKE CHECKOUT/ })).toBeVisible();

    // Simulated "success" return URL without a verified payment event must not confirm anything.
    await guestPage.goto("/booking?checkout=success&session_id=cs_test_fixture_unverified");
    await expect(guestPage.getByRole("heading", { name: "Approved — payment due" })).toBeVisible();
    await expect(guestPage.locator("#booking-status")).toHaveText("Payment due");

    // Verified payment (fixture control, standing in for a signed webhook) → refresh → confirmed.
    const control = await context.newPage();
    await fixtureControl(control, /Simulate verified payment/);
    await guestPage.getByRole("button", { name: "Refresh status" }).click();
    await expect(guestPage.getByRole("heading", { name: "Stay confirmed" })).toBeVisible();
    await expect(guestPage.locator("#booking-status")).toHaveText("Paid");
    await expect(guestPage.getByRole("button", { name: /Pay securely/ })).toBeHidden();
    await expectNoGuestPiiInStorage(guestPage, guest);

    const dialog = await openBookingFor(page, guest.name);
    await expect(detailValue(dialog, "Status")).toHaveText("confirmed");
    await expect(detailValue(dialog, "Payment")).toHaveText("paid");
    await expectNoGuestPiiInStorage(page, guest);
  });

  test("approved hold blocks the dates; expiry releases them and the guest sees it", async ({ page, context }) => {
    const guest = syntheticGuest("Holder");
    const dates = stay(80);
    const guestPage = await context.newPage();
    const href = await requestStay(guestPage, dates, guest);

    await ownerSignIn(page);
    await approve(page, guest.name);

    const other = await context.newPage();
    await other.goto("/");
    await quoteDates(other, dates);
    await expect(other.locator("#price-breakdown")).toContainText("aren't available");

    const control = await context.newPage();
    await fixtureControl(control, /Simulate expiry/);

    await guestPage.goto(href);
    await expect(guestPage.getByRole("heading", { name: "Request expired" })).toBeVisible();
    await expect(guestPage.getByRole("button", { name: /Pay securely/ })).toBeHidden();

    await other.reload();
    await quoteDates(other, dates);
    await expect(other.locator("#price-breakdown")).toContainText("Total");
  });
});

test.describe("cancellation and refunds", () => {
  test("owner cancel keeps payment; partial refund is a separate explicit step", async ({ page }) => {
    await ownerSignIn(page);
    const dialog = await openBookingFor(page, "Synthetic Guest One");
    const code = (await page.locator("#booking-dialog-code").textContent()).trim();
    await expect(detailValue(dialog, "Status")).toHaveText("confirmed");
    await expect(detailValue(dialog, "Payment")).toHaveText("paid");

    await dialog.getByRole("button", { name: "Cancel booking" }).click();
    const confirm = page.getByRole("dialog", { name: "Cancel this booking?" });
    await expect(confirm).toContainText("Refunds are not automatic");
    await confirmIn(page, "Cancel this booking?", "Cancel booking", "Synthetic test cancellation");

    await expect(detailValue(dialog, "Status")).toHaveText("cancelled");
    await expect(detailValue(dialog, "Payment")).toHaveText("paid");
    await expect(dialog).toContainText("No refunds.");
    await dialog.getByRole("button", { name: "Close" }).click();

    await goSection(page, "Payments", "Payments");
    const row = page.locator("#payment-rows tr", { hasText: code });
    await expect(row).toContainText("paid");
    await expect(row.locator("td").nth(3)).toHaveText("$0.00");
    await row.getByRole("button", { name: /Refund/ }).click();

    const refund = page.getByRole("dialog", { name: "Issue refund" });
    await expect(refund).toBeVisible();
    await expect(refund).toContainText("Up to");
    await refund.getByLabel("Amount").fill("100.00");
    await refund.getByLabel("Reason").fill("Synthetic partial refund");
    await refund.getByRole("button", { name: "Send refund via Stripe" }).click();
    await confirmIn(page, "Refund $100.00?", "Send refund");
    await expect(page.locator("#live")).toHaveText(/Refund of \$100\.00/);

    await expect(row).toContainText("partially refunded");
    await expect(row.locator("td").nth(3)).toHaveText("$100.00");

    await row.getByRole("button", { name: "Open booking" }).click();
    const after = page.getByRole("dialog", { name: "Synthetic Guest One" });
    await expect(detailValue(after, "Status")).toHaveText("cancelled");
    await expect(detailValue(after, "Payment")).toHaveText("partially refunded");
  });
});

test.describe("resilience and overview", () => {
  test("a failed API request shows an error and recovers on retry", async ({ page, context }) => {
    await ownerSignIn(page);
    const control = await context.newPage();
    await fixtureControl(control, "Fail next API request");
    await expect(control.getByRole("note")).toContainText("Next API request will fail");

    const section = page.locator("#view-overview");
    await section.getByRole("button", { name: /Refresh/ }).click();
    await expect(section.getByRole("alert")).toContainText("Simulated failure");
    await section.getByRole("button", { name: /Refresh/ }).click();
    await expect(section.getByRole("alert")).toBeHidden();
    await expect(stat(page, "Pending requests")).toHaveText("1");
    // Still signed in (a 500 is not an auth failure).
    await expect(adminNav(page)).toBeVisible();
  });

  test("booking list filters do not change overview totals", async ({ page }) => {
    await ownerSignIn(page);
    const before = await page.locator("#overview-stats").innerText();
    await goSection(page, "Bookings", "Bookings");
    await page.getByLabel("Status").selectOption("confirmed");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator("#booking-rows tr", { hasText: "Synthetic Guest Two" })).toHaveCount(0);
    await expect(page.locator("#booking-rows tr", { hasText: "Synthetic Guest One" })).toHaveCount(1);
    await goSection(page, "Overview", "A little clarity for your day.");
    await expect(stat(page, "Pending requests")).toHaveText("1");
    // innerText on both sides (toHaveText defaults to textContent, whose whitespace differs).
    await expect(page.locator("#overview-stats")).toHaveText(before, { useInnerText: true });
  });

  test("owner overview screenshot after saved data", async ({ page }, testInfo) => {
    await ownerSignIn(page);
    await goSection(page, "Pricing", "Pricing");
    const form = page.locator("#pricing-form");
    await expect(form.getByRole("button", { name: "Save pricing" })).toBeEnabled();
    await form.getByRole("checkbox", { name: /I confirm the tax rate/ }).check();
    await form.getByRole("button", { name: "Save pricing" }).click();
    await expect(page.locator("#tax-status")).toHaveText("(confirmed)");

    await approve(page, "Synthetic Guest Two");
    await goSection(page, "Overview", "A little clarity for your day.");
    await expect(stat(page, "Pending requests")).toHaveText("0");
    await expect(page.locator("#overview-arrival")).toContainText("Synthetic Guest One");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(ROOT, ".context", `manager-${testInfo.project.name}.png`), fullPage: true });
  });
});
