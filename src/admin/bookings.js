// Overview + bookings sections.
import { api } from "./client.js";
import { $, h, announce, showError, busy, openDialog, confirmDialog, pill, renderPager, emptyRow } from "./ui.js";
import { formatMoney, formatDate, formatDateTime, label, isIsoDate, todayIso } from "../shared/format.js";

// ---------- Overview (independent of any filters) ----------
export async function loadOverview() {
  const section = $("#view-overview");
  showError(section, null);
  try {
    const o = await api("/api/admin/overview");
    const stat = (name, value, note) => `<article><div><span>${h(name)}</span></div><strong>${h(value)}</strong><small>${h(note)}</small></article>`;
    $("#overview-stats").innerHTML = [
      stat("Pending requests", o.pending_requests ?? 0, "Awaiting your review"),
      stat("Confirmed arrivals", o.confirmed_arrivals ?? 0, "Upcoming confirmed stays"),
      stat("Paid", formatMoney(o.paid_cents, o.currency), `Refunded ${formatMoney(o.refunded_cents, o.currency)}`),
      stat("Occupancy", `${Number(o.occupancy_percent) || 0}%`, `Next 30 nights · ${o.failed_notifications || 0} failed notifications`)
    ].join("");
    const next = o.next_arrival;
    $("#overview-arrival").innerHTML = next
      ? `<div><p class="eyebrow">UP NEXT</p><h2>${h(next.guest_name)} arrives ${h(formatDate(next.check_in))}</h2><p>${h(formatDate(next.check_in))} – ${h(formatDate(next.check_out))} · ${h(next.guest_count)} guests · ${h(next.confirmation_code)}</p><button class="light-button" type="button" data-open-booking="${h(next.id)}">Open booking →</button></div>`
      : `<div><p class="eyebrow">UP NEXT</p><h2>No arrivals scheduled.</h2><p>New requests will appear under Bookings.</p></div>`;
  } catch (error) { showError(section, error); }
}

// ---------- Bookings list ----------
const listState = { page: 1, search: "", status: "" };
// Mirrors manager_action; the server is authoritative and rejects anything else.
function actionsFor(b) {
  if (b.status === "pending") return [["approve", "Approve"], ["decline", "Decline"], ["cancel", "Cancel request"]];
  if (b.status === "payment_due") return b.cancel_requested ? [] : [["cancel", "Cancel booking"]];
  if (b.status === "confirmed") {
    // Completion is only possible after check-out; the server enforces this in the property time zone.
    const actions = [["cancel", "Cancel booking"]];
    if (isIsoDate(b.check_out) && b.check_out <= todayIso()) actions.unshift(["complete", "Mark completed"]);
    return actions;
  }
  return [];
}
const STATUS_NOTE = {
  pending: "Awaiting your review. No dates are held and no payment has been requested.",
  payment_due: "Approved. The dates are held while the guest pays.",
  confirmed: "Confirmed.",
  declined: "Declined. No dates were held.",
  cancelled: "Cancelled. Any refunds are issued separately under Payments.",
  expired: "Expired: payment wasn't completed before the hold ended, so the dates were released.",
  completed: "Stay completed."
};
// Confirmed note reflects the actual payment_status; never claims "paid" unless it is.
const CONFIRMED_PAYMENT_NOTE = {
  paid: "Paid and confirmed.",
  partially_refunded: "Confirmed. Payment was received and partially refunded.",
  refunded: "Confirmed. Payment was received and fully refunded.",
  not_required: "Confirmed. No online payment was required for this booking."
};
function statusNote(b) {
  if (b.status !== "confirmed") return STATUS_NOTE[b.status] || "";
  return CONFIRMED_PAYMENT_NOTE[b.payment_status] || `Confirmed. Payment status: ${label(b.payment_status || "unknown").toLowerCase()}.`;
}

export async function loadBookings() {
  const section = $("#view-bookings");
  showError(section, null);
  const params = new URLSearchParams({ page: String(listState.page), page_size: "20" });
  if (listState.search) params.set("search", listState.search);
  if (listState.status) params.set("status", listState.status);
  const tbody = $("#booking-rows");
  tbody.setAttribute("aria-busy", "true");
  try {
    const data = await api(`/api/admin/bookings?${params}`);
    const items = Array.isArray(data.items) ? data.items : [];
    tbody.innerHTML = items.length ? items.map((b) => `<tr>
      <td><strong>${h(b.guest_name)}</strong><span>${h(b.guest_email)}</span></td>
      <td><strong>${h(formatDate(b.check_in))} – ${h(formatDate(b.check_out))}</strong><span>${h(b.nights)} nights · ${h(b.guest_count)} guests · ${h(b.confirmation_code)}</span></td>
      <td>${h(formatMoney(b.total_cents, b.currency))}</td>
      <td>${pill(b.status)}${b.cancel_requested ? "<span>Cancel requested</span>" : b.status === "payment_due" && b.hold_expires_at ? `<span>Hold until ${h(formatDateTime(b.hold_expires_at))}</span>` : ""}</td><td>${pill(b.payment_status)}</td>
      <td><button class="secondary small" type="button" data-open-booking="${h(b.id)}">Details</button></td></tr>`).join("") : emptyRow(6, "No bookings match this view.");
    renderPager($("#booking-pager"), { page: data.page || listState.page, total: data.total, pageSize: data.page_size || 20 }, (page) => { listState.page = page; loadBookings(); });
  } catch (error) { showError(section, error); }
  finally { tbody.removeAttribute("aria-busy"); }
}

// ---------- Booking detail ----------
let openBookingId = null;
let openBookingData = null;
export async function openBooking(id) {
  const dialog = $("#booking-dialog");
  openBookingId = id;
  openBookingData = null;
  $("#booking-dialog-body").innerHTML = `<p class="form-note">Loading…</p>`;
  openDialog(dialog);
  try {
    const data = await api(`/api/admin/bookings/${encodeURIComponent(id)}`);
    if (openBookingId !== id) return;
    renderDetail(data);
  } catch (error) { $("#booking-dialog-body").innerHTML = ""; showError(dialog, error); }
}

function renderDetail({ booking: b, history = [], payments = [], refunds = [] }) {
  openBookingData = b;
  $("#booking-dialog-code").textContent = b.confirmation_code || "RESERVATION";
  $("#booking-dialog-title").textContent = b.guest_name || "Booking";
  const row = (k, v) => `<div><dt>${h(k)}</dt><dd>${v}</dd></div>`;
  const notices = [];
  if (b.status === "payment_due" && b.hold_expires_at) notices.push(`Payment hold expires ${formatDateTime(b.hold_expires_at)}. If the guest hasn't paid by then, the booking expires and the dates are released.`);
  if (b.cancel_requested) notices.push("Cancellation requested. The dates are released only after payment reconciliation finishes (a payment already in progress may still complete). Refunds, if any, are issued separately under Payments.");
  if (b.status === "confirmed" && !(isIsoDate(b.check_out) && b.check_out <= todayIso())) notices.push("This stay can be marked completed after check-out.");
  const actions = actionsFor(b).map(([action, text]) => `<button class="${action === "cancel" || action === "decline" ? "secondary danger" : "primary"}" type="button" data-booking-action="${action}">${h(text)}</button>`).join("");
  $("#booking-dialog-body").innerHTML = `
    <dl class="detail-grid">
      ${row("Status", pill(b.status))}${row("Payment", pill(b.payment_status))}
      ${row("Dates", `${h(formatDate(b.check_in))} – ${h(formatDate(b.check_out))} (${h(b.nights)} nights)`)}
      ${row("Guests", h(b.guest_count))}
      ${row("Email", `<a href="mailto:${h(encodeURIComponent(b.guest_email || "").replace(/%40/g, "@"))}">${h(b.guest_email)}</a>`)}
      ${row("Phone", h(b.guest_phone || "—"))}
      ${row("Stay", h(formatMoney(b.stay_cents, b.currency)))}${row("Cleaning", h(formatMoney(b.cleaning_fee_cents, b.currency)))}
      ${row("Service fee", h(formatMoney(b.service_fee_cents, b.currency)))}${row("Tax", h(formatMoney(b.tax_cents, b.currency)))}
      ${row("Total", `<strong>${h(formatMoney(b.total_cents, b.currency))}</strong>`)}${row("Requested", h(formatDateTime(b.created_at)))}
      ${b.hold_expires_at ? row("Hold expires", h(formatDateTime(b.hold_expires_at))) : ""}
    </dl>
    <p class="form-note">${h(statusNote(b))}</p>
    ${notices.map((n) => `<p class="notice" role="note">${h(n)}</p>`).join("")}
    <h3>Guest notes</h3><p class="notes">${h(b.guest_notes || "No notes.")}</p>
    ${actions ? `<div class="button-row action-row">${actions}</div>` : `<p class="form-note">No actions available${b.cancel_requested ? " while cancellation is being reconciled" : ` for a ${h(label(b.status).toLowerCase())} booking`}.</p>`}
    <h3>Payments</h3>${payments.length ? `<ul class="mini-list">${payments.map((p) => `<li>${pill(p.status)} ${h(formatMoney(p.amount_cents, p.currency))} · ${h(formatDateTime(p.created_at))}</li>`).join("")}</ul>` : `<p class="form-note">No payments yet.</p>`}
    <h3>Refunds</h3>${refunds.length ? `<ul class="mini-list">${refunds.map((r) => `<li>${pill(r.status)} ${h(formatMoney(r.amount_cents, r.currency))} · ${h(r.reason)} · ${h(formatDateTime(r.created_at))}</li>`).join("")}</ul>` : `<p class="form-note">No refunds.</p>`}
    <h3>History</h3>${history.length ? `<ol class="mini-list">${history.map((e) => `<li><strong>${h(label(e.action))}</strong> · ${h(formatDateTime(e.created_at))}${e.details && Object.keys(e.details).length ? ` · <code>${h(JSON.stringify(e.details))}</code>` : ""}</li>`).join("")}</ol>` : `<p class="form-note">No history recorded.</p>`}`;
}

const CANCEL_MESSAGE = {
  pending: "The request will be cancelled and the guest notified. No dates were held and no payment was taken.",
  payment_due: "The cancellation is recorded now, but the held dates are released only after payment reconciliation finishes — a payment already in progress may still complete. Refunds are issued separately under Payments.",
  confirmed: "The dates will be released and both parties notified. Refunds are not automatic; issue them separately under Payments."
};

function actionMessage(action, data) {
  const b = data?.booking || {};
  if (action === "approve") return data?.payment_pending
    ? "Approval saved. Dates are held; the guest's payment link is pending and will be sent once checkout is ready."
    : "Approval saved. Dates are held while the guest pays.";
  if (action === "cancel" && (data?.reconciliation_required || b.cancel_requested)) return "Cancellation requested. Dates release after payment reconciliation; refunds are separate.";
  if (action === "cancel") return "Booking cancelled. Refunds, if any, are issued separately under Payments.";
  if (action === "decline") return "Request declined.";
  if (action === "complete") return b.status === "completed" ? "Stay marked completed." : `Booking is ${label(b.status || "unchanged").toLowerCase()}.`;
  return "Booking updated.";
}

let actionInFlight = false;
async function runAction(button) {
  if (actionInFlight) return;
  const action = button.dataset.bookingAction;
  const id = openBookingId;
  const status = openBookingData?.status;
  const prompts = {
    approve: { title: "Approve this request?", message: "The dates will be held for up to 24 hours while the guest pays. The stay is confirmed only after payment succeeds.", confirmLabel: "Approve" },
    decline: { title: "Decline this request?", message: "The guest will be notified. No dates were held and no payment was taken.", confirmLabel: "Decline", askReason: true, danger: true },
    cancel: { title: status === "pending" ? "Cancel this request?" : "Cancel this booking?", message: CANCEL_MESSAGE[status] || CANCEL_MESSAGE.confirmed, confirmLabel: "Cancel booking", askReason: true, danger: true },
    complete: { title: "Mark stay completed?", message: "Only possible after check-out; the server checks the date.", confirmLabel: "Mark completed" }
  };
  const { ok, reason } = await confirmDialog(prompts[action]);
  if (!ok || actionInFlight || openBookingId !== id) return;
  actionInFlight = true;
  // Lock every action button so two actions can't be sent at once.
  const all = [...document.querySelectorAll("#booking-dialog [data-booking-action]")];
  all.forEach((b) => { b.disabled = true; });
  try {
    await busy(button, async () => {
      try {
        const data = await api(`/api/admin/bookings/${encodeURIComponent(id)}/actions`, { method: "POST", body: { action, reason } });
        announce(actionMessage(action, data));
        await openBooking(id);
        loadBookings();
        loadOverview();
      } catch (error) {
        showError($("#booking-dialog"), error);
        all.forEach((b) => { b.disabled = false; });
      }
    });
  } finally { actionInFlight = false; }
}

export function initBookings() {
  $("#booking-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    listState.search = $("#booking-search").value.trim();
    listState.status = $("#booking-status").value;
    listState.page = 1;
    loadBookings();
  });
  $("#booking-dialog").addEventListener("click", (event) => {
    const button = event.target.closest("[data-booking-action]");
    if (button) runAction(button);
  });
}
