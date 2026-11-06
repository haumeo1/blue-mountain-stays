// Pricing editor. Dollar/percent inputs are converted to integer cents / basis points exactly.
import { api } from "./client.js";
import { $, $$, h, announce, showError, busy, setFormReady } from "./ui.js";
import { centsToDollars, dollarsToCents, bpsToPercent, percentToBps, isIsoDate } from "../shared/format.js";

let version = null;

function overrideRow(o = {}) {
  const row = document.createElement("div");
  row.className = "repeat-row";
  row.innerHTML = `<label>From<input type="date" data-k="start_date" required value="${h(o.start_date || "")}" /></label>
    <label>Until (exclusive)<input type="date" data-k="end_date" required value="${h(o.end_date || "")}" /></label>
    <label>Nightly rate<input data-k="nightly" inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" required value="${h(o.nightly_rate_cents != null ? centsToDollars(o.nightly_rate_cents) : "")}" /></label>
    <button class="text-button danger" type="button" data-remove-row aria-label="Remove override">Remove</button>`;
  return row;
}

export async function loadPricing() {
  const section = $("#view-pricing");
  const form = $("#pricing-form");
  showError(section, null);
  // No saves until a successful load provides the current version.
  version = null;
  setFormReady(form, false);
  try {
    const p = await api("/api/admin/pricing");
    if (!Number.isInteger(p?.version)) throw Object.assign(new Error("Pricing couldn't be loaded."), { code: "malformed" });
    form.nightly_rate.value = centsToDollars(p.nightly_rate_cents);
    form.cleaning_fee.value = centsToDollars(p.cleaning_fee_cents);
    form.service_pct.value = String(bpsToPercent(p.service_bps));
    form.tax_pct.value = String(bpsToPercent(p.tax_bps));
    form.min_nights.value = p.min_nights;
    form.max_nights.value = p.max_nights;
    form.max_guests.value = p.max_guests;
    // Owner must explicitly confirm the tax rate (including 0%); never derived from saving.
    form.tax_configured.checked = p.tax_configured === true;
    $("#tax-status").textContent = p.tax_configured === true ? "(confirmed)" : "(not confirmed)";
    $("#override-rows").replaceChildren(...(p.overrides || []).map(overrideRow));
    version = p.version;
    setFormReady(form, true);
  } catch (error) {
    showError(section, Object.assign(error, { message: `${error.message || "Pricing couldn't be loaded."} Saving is disabled until pricing loads.` }), { reload: "pricing" });
  }
}

function collect(form) {
  const fail = (message) => { throw Object.assign(new Error(message), { code: "validation_failed" }); };
  const cents = (value, name) => { const c = dollarsToCents(value); if (c == null) fail(`${name} must be an amount like 425.00.`); return c; };
  const bps = (value, name) => { const b = percentToBps(value); if (b == null || b > 10000) fail(`${name} must be a percentage between 0 and 100.`); return b; };
  const body = {
    nightly_rate_cents: cents(form.nightly_rate.value, "Nightly rate"),
    cleaning_fee_cents: cents(form.cleaning_fee.value, "Cleaning fee"),
    service_bps: bps(form.service_pct.value, "Service fee"),
    tax_bps: bps(form.tax_pct.value, "Tax"),
    tax_configured: form.tax_configured.checked === true,
    min_nights: Number(form.min_nights.value),
    max_nights: Number(form.max_nights.value),
    max_guests: Number(form.max_guests.value),
    overrides: $$(".repeat-row", $("#override-rows")).map((row) => {
      const get = (k) => row.querySelector(`[data-k="${k}"]`).value;
      const o = { start_date: get("start_date"), end_date: get("end_date"), nightly_rate_cents: cents(get("nightly"), "Override rate") };
      if (!isIsoDate(o.start_date) || !isIsoDate(o.end_date) || o.end_date <= o.start_date) fail("Each override needs an end date after its start date.");
      return o;
    }),
    version
  };
  const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!whole(body.min_nights, 1, 365) || !whole(body.max_nights, 1, 365)) fail("Nights must be whole numbers between 1 and 365.");
  if (!whole(body.max_guests, 1, 100)) fail("Maximum guests must be a whole number between 1 and 100.");
  if (body.min_nights > body.max_nights) fail("Minimum nights can't exceed maximum nights.");
  if (!Number.isInteger(version)) fail("Pricing hasn't loaded yet. Reload before saving.");
  return body;
}

export function initPricing() {
  $("#add-override").addEventListener("click", () => { const row = overrideRow(); $("#override-rows").append(row); row.querySelector("input").focus(); });
  $("#override-rows").addEventListener("click", (event) => { if (event.target.closest("[data-remove-row]")) event.target.closest(".repeat-row").remove(); });
  $("#pricing-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const section = $("#view-pricing");
    if (!Number.isInteger(version)) return showError(section, { message: "Pricing hasn't loaded yet." }, { reload: "pricing" });
    busy(form, async () => {
      try {
        showError(section, null);
        await api("/api/admin/pricing", { method: "PUT", body: collect(form) });
        announce("Pricing saved. New quotes will use these rates.");
        await loadPricing();
      } catch (error) {
        if (error.code === "version_conflict") {
          error.message = "Pricing was changed elsewhere, so your edits were not saved. Reload the latest version (your unsaved changes will be discarded) and re-apply them.";
          return showError(section, error, { reload: "pricing" });
        }
        showError(section, error);
      }
    });
  });
}
