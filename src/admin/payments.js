// Payments list + refunds (Stripe-backed, idempotent).
import { api } from "./client.js";
import { $, h, announce, showError, busy, openDialog, confirmDialog, pill, renderPager, emptyRow } from "./ui.js";
import { formatMoney, dollarsToCents, safeHttpsUrl, newIdempotencyKey } from "../shared/format.js";

const state = { page: 1, items: [], refund: null };
const stripeDashboard = (kind, id) => (/^[A-Za-z0-9_]+$/.test(id || "") ? `https://dashboard.stripe.com/${kind}/${encodeURIComponent(id)}` : null);

export async function loadPayments() {
  const section = $("#view-payments");
  showError(section, null);
  try {
    const data = await api(`/api/admin/payments?page=${state.page}`);
    state.items = Array.isArray(data.items) ? data.items : [];
    $("#payment-rows").innerHTML = state.items.length ? state.items.map((p, index) => {
      const receipt = safeHttpsUrl(p.receipt_url, ["stripe.com"]);
      const dash = stripeDashboard("payments", p.stripe_payment_intent_id);
      const refundable = ["paid", "partially_refunded"].includes(p.payment_status) && (p.total_cents - (p.refunded_cents || 0)) > 0;
      return `<tr><td><strong>${h(p.confirmation_code)}</strong><button class="text-button" type="button" data-open-booking="${h(p.booking_id)}">Open booking</button></td>
        <td>${h(formatMoney(p.total_cents, p.currency))}</td><td>${pill(p.payment_status)}</td><td>${h(formatMoney(p.refunded_cents, p.currency))}</td>
        <td>${receipt ? `<a href="${h(receipt)}" target="_blank" rel="noopener noreferrer">Receipt ↗</a>` : ""} ${dash ? `<a href="${h(dash)}" target="_blank" rel="noopener noreferrer">Dashboard ↗</a>` : ""}</td>
        <td>${refundable ? `<button class="secondary small" type="button" data-refund="${index}">Refund…</button>` : ""}</td></tr>`;
    }).join("") : emptyRow(6, "No payments yet.");
    renderPager($("#payment-pager"), { page: state.page, total: data.total, pageSize: data.page_size || 20 }, (page) => { state.page = page; loadPayments(); });
  } catch (error) { showError(section, error); }
}

function openRefund(item) {
  const max = item.total_cents - (item.refunded_cents || 0);
  // Same booking + unchanged form keeps the same key so retries never double-refund.
  if (state.refund?.booking_id !== item.booking_id) state.refund = { booking_id: item.booking_id, currency: item.currency, max, key: newIdempotencyKey(), fingerprint: "" };
  state.refund.max = max;
  $("#refund-context").textContent = item.confirmation_code || "REFUND";
  $("#refund-limit").textContent = `Up to ${formatMoney(max, item.currency)} can be refunded.`;
  openDialog($("#refund-dialog"));
}

export function initPayments() {
  $("#payment-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-refund]");
    if (button) openRefund(state.items[Number(button.dataset.refund)]);
  });
  $("#refund-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    // One refund submission at a time, including while the confirmation dialog is open.
    if (state.refundInFlight) return;
    const form = event.target;
    const dialog = $("#refund-dialog");
    const r = state.refund;
    if (!r) return;
    const amount = dollarsToCents(form.amount.value);
    const reason = form.reason.value.trim();
    if (!amount || amount > r.max) return showError(dialog, { message: `Enter an amount between 0.01 and ${formatMoney(r.max, r.currency)}.` });
    const fingerprint = `${amount}|${reason}`;
    if (r.fingerprint && r.fingerprint !== fingerprint) r.key = newIdempotencyKey();
    r.fingerprint = fingerprint;
    state.refundInFlight = true;
    try {
      dialog.close();
      const { ok } = await confirmDialog({ title: `Refund ${formatMoney(amount, r.currency)}?`, message: "This sends a real refund through Stripe and can't be undone.", confirmLabel: "Send refund", danger: true });
      openDialog(dialog);
      if (!ok) return;
      await busy(form, async () => {
        try {
          const data = await api("/api/admin/refunds", { method: "POST", body: { booking_id: r.booking_id, amount_cents: amount, reason, idempotency_key: r.key } });
          state.refund = null; // success: next refund gets a fresh key
          form.reset();
          dialog.close();
          announce(data?.refund?.status === "succeeded" ? `Refund of ${formatMoney(amount, r.currency)} succeeded.` : `Refund of ${formatMoney(amount, r.currency)} submitted to Stripe; status updates when Stripe confirms.`);
          loadPayments();
        } catch (error) { showError(dialog, error); }
      });
    } finally { state.refundInFlight = false; }
  });
}
