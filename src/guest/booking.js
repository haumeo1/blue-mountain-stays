// Guest booking page entry (/booking). Bundled to dist/assets/booking.js.
// Reads the guest capability token from the URL fragment (never sent to servers in Referer/logs),
// keeps it in sessionStorage for this tab only so Stripe's return can re-fetch, and never logs it.
import { apiFetch, ApiError } from "../shared/api.js";
import { formatMoney, formatDate, safeHttpsUrl } from "../shared/format.js";

const STORAGE_KEY = "bmh-guest-token";
const $ = (selector) => document.querySelector(selector);
let busy = false;

function readToken() {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get("token");
  if (fromHash) {
    try { sessionStorage.setItem(STORAGE_KEY, fromHash); } catch { /* storage unavailable */ }
    return fromHash;
  }
  try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) key === "text" ? (node.textContent = value) : key === "className" ? (node.className = value) : node.setAttribute(key, value);
  node.append(...children);
  return node;
}

// booking.status is the true database status, including payment_due and expired.
const STATUS_TEXT = {
  pending: ["Request pending", "The owner is reviewing your request. Nothing is confirmed and no payment is due yet."],
  payment_due: ["Approved — payment due", "Your request was approved and the dates are held for you. Complete payment to confirm the stay."],
  confirmed: ["Stay confirmed", "Your stay is confirmed. We look forward to hosting you."],
  declined: ["Request declined", "The owner couldn't accept this request. No payment was taken."],
  cancelled: ["Booking cancelled", "This booking has been cancelled. Any refund is handled separately by the host."],
  expired: ["Request expired", "Payment wasn't completed before the deadline, so the dates were released. You can send a new request from the website."],
  completed: ["Stay completed", "Thanks for staying with us."]
};
const PAYMENT_TEXT = {
  not_due: "No payment due",
  not_required: "No payment required",
  payment_due: "Payment due",
  processing: "Payment processing",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  failed: "Payment failed — try again or contact the host"
};
const deadlineFormat = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" });

function paymentDeadline(booking) {
  const at = Date.parse(booking?.hold_expires_at);
  return Number.isFinite(at)
    ? `Please pay by ${deadlineFormat.format(new Date(at))}. If payment isn't completed by then, the request expires and the dates are released.`
    : "Please pay within 24 hours of approval. If payment isn't completed in time, the request expires and the dates are released.";
}

function showMessage(title, message) {
  $("#booking-title").textContent = title;
  $("#booking-summary").textContent = message;
  $("#booking-body").hidden = true;
  $("#booking-card").setAttribute("aria-busy", "false");
}

function render(data) {
  const { booking, payment, calendar_url: calendarUrl } = data;
  const cancelRequested = booking.cancel_requested === true;
  const holdAt = Date.parse(booking.hold_expires_at);
  const holdPassed = Number.isFinite(holdAt) && holdAt <= Date.now();
  let [title, summary] = STATUS_TEXT[booking.status] || ["Your booking", ""];
  // A cancellation awaiting payment reconciliation is not yet final; say so plainly.
  if (cancelRequested && !["cancelled", "declined", "expired", "completed"].includes(booking.status)) {
    title = "Cancellation pending";
    summary = "This booking is being cancelled. The cancellation is final once any payment in progress has been reconciled. Any refund is handled separately by the host.";
  }
  const paymentStatus = typeof payment?.status === "string" ? payment.status : "not_due";
  // Pay only while the booking itself is payment_due, not being cancelled, and the hold hasn't passed.
  const canPay = booking.status === "payment_due" && paymentStatus === "payment_due" && !cancelRequested && !holdPassed;
  $("#booking-title").textContent = title;
  $("#booking-summary").textContent = booking.status === "payment_due" && !cancelRequested
    ? `${summary} ${paymentStatus === "processing" ? "Your payment is processing; this page updates when it's confirmed."
      : holdPassed ? "The payment deadline has passed. Refresh shortly to see the final status, or contact the host." : paymentDeadline(booking)}`
    : summary;
  $("#booking-status").textContent = PAYMENT_TEXT[paymentStatus] || paymentStatus.replaceAll("_", " ");

  const item = (name, value) => el("div", {}, el("span", { text: name }), el("strong", { text: value }));
  $("#booking-details").replaceChildren(
    item("Confirmation", booking.confirmation_code || "—"),
    item("Check in", formatDate(booking.check_in)),
    item("Check out", formatDate(booking.check_out)),
    item("Guests", String(booking.guest_count ?? "—"))
  );
  const row = (name, cents, cls = "") => el("div", { className: `price-row ${cls}`.trim() }, el("span", { text: name }), el("span", { text: formatMoney(cents, booking.currency) }));
  const rows = [];
  if (Number.isInteger(booking.stay_cents)) rows.push(row(`Stay${booking.nights ? ` · ${booking.nights} nights` : ""}`, booking.stay_cents));
  if (booking.cleaning_fee_cents) rows.push(row("Cleaning fee", booking.cleaning_fee_cents));
  if (booking.service_fee_cents) rows.push(row("Guest service fee", booking.service_fee_cents));
  if (booking.tax_cents) rows.push(row("Taxes", booking.tax_cents));
  rows.push(row(`Total ${booking.currency || ""}`.trim(), booking.total_cents, "total"));
  $("#booking-price").replaceChildren(...rows);

  $("#pay-button").hidden = !canPay;
  const receipt = safeHttpsUrl(payment?.receipt_url, ["stripe.com"]);
  $("#receipt-link").hidden = !receipt;
  if (receipt) $("#receipt-link").href = receipt;
  const calendar = safeHttpsUrl(calendarUrl) && booking.status === "confirmed" ? safeHttpsUrl(calendarUrl) : null;
  $("#calendar-link").hidden = !calendar;
  if (calendar) $("#calendar-link").href = calendar;

  $("#booking-body").hidden = false;
  $("#booking-card").setAttribute("aria-busy", "false");
}

async function load(token) {
  $("#booking-card").setAttribute("aria-busy", "true");
  try {
    const data = await apiFetch("/api/guest/booking", { token });
    if (!data?.booking) throw new ApiError("malformed", "Unexpected response");
    render(data);
  } catch (error) {
    if (error.isAuth || error.code === "not_found") showMessage("Link not recognised", "This booking link is invalid or has expired. Please use the link from your confirmation, or contact the host.");
    else showMessage("We couldn't load your booking", error.code === "network" ? error.message : "Please try again in a moment.");
  }
}

function checkoutUrl(value) {
  const href = safeHttpsUrl(value);
  if (!href) return null;
  const url = new URL(href);
  return url.hostname === "checkout.stripe.com" && !url.username && !url.password && (url.port === "" || url.port === "443") ? url.href : null;
}

async function checkout(token) {
  if (busy) return;
  busy = true;
  const button = $("#pay-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const data = await apiFetch("/api/guest/checkout", { method: "POST", body: {}, token });
    // Checkout redirects go only to Stripe Checkout itself (receipts are validated separately).
    const url = checkoutUrl(data?.url);
    if (!url) throw new ApiError("malformed", "Unexpected response");
    redirecting = true; // stay locked while leaving for Stripe; unlocked on bfcache return
    location.assign(url);
    return;
  } catch (error) {
    await load(token);
    const note = error.code === "network" ? error.message : "Payment couldn't be started. Please refresh and try again.";
    $("#booking-summary").textContent = `${note} ${$("#booking-summary").textContent}`.trim();
  } finally {
    if (!redirecting) {
      busy = false;
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
    }
  }
}
let redirecting = false;
function unlockPay() {
  redirecting = false;
  busy = false;
  $("#pay-button").disabled = false;
  $("#pay-button").setAttribute("aria-busy", "false");
}

const token = readToken();
if (location.hash) history.replaceState(null, "", location.pathname); // drop token and Stripe params from the address bar
if (!token) showMessage("Link not recognised", "Open this page from the link in your booking confirmation.");
else {
  load(token);
  $("#pay-button").addEventListener("click", () => checkout(token));
  $("#refresh-button").addEventListener("click", () => load(token));
  // Returning from Stripe (bfcache) — always re-fetch; the webhook decides payment status.
  window.addEventListener("pageshow", (event) => { if (event.persisted) { unlockPay(); load(token); } });
}
