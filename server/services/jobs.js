// Background worker: stored verified events, payment attempts, refunds, outbox email.
// Each job is isolated; failures are settled with backoff and never undo booking/payment state.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError, getBaseUrl } from "../http.js";
import { emailConfigured, sendNotification } from "../integrations/email.js";
import { deterministicGuestToken } from "../integrations/tokens.js";
import { database, getProperty, rpc, run, safeError } from "./data.js";
import { processVerifiedEvent, reconcileAttempt, reconcileRefund } from "./payments.js";

const BUDGET_MS = 45_000;
const sha = (v) => createHash("sha256").update(String(v)).digest();

// Strict "Bearer <CRON_SECRET>"; compared as fixed-length hashes in constant time. Never logged.
export function requireCron(request) {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new HttpError(503, "Jobs are not configured", "service_unavailable");
  const header = request?.headers?.authorization;
  const match = typeof header === "string" ? /^Bearer (\S{1,512})$/.exec(header) : null;
  if (!match || !timingSafeEqual(sha(match[1]), sha(secret))) throw new HttpError(401, "Unauthorized", "unauthorized");
}

const backoff = (n) => Math.min(3600, 60 * 2 ** Math.min(Math.max(n - 1, 0), 6));
const work = (action, data) => rpc("manager_work", { p_action: action, p_data: data });
const settle = (action, worker, id, delay, error) =>
  work(action, { worker, id, delay_seconds: Math.max(0, Math.min(86400, Math.round(delay))), ...(error ? { error } : {}) })
    .catch(() => null); // lease_lost or settled by the payment RPC already: lease recovery handles it

// Outbox rendering -------------------------------------------------------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency}`;

const TEMPLATES = {
  booking_requested: { guest: ["Booking request received", "We received your request and will reply soon."],
    owner: ["New booking request", "A new booking request is waiting for your review."] },
  payment_due: { guest: ["Your booking is approved: payment due", "Your request was approved. Complete payment from your booking page before the hold expires."],
    owner: ["Booking approved, awaiting payment", "The guest has been sent a payment link."] },
  booking_confirmed: { guest: ["Your booking is confirmed", "Payment received. Your stay is confirmed."],
    owner: ["Booking confirmed", "Payment was verified and the stay is confirmed."] },
  booking_declined: { guest: ["Update on your booking request", "Unfortunately those dates could not be accepted."],
    owner: ["Booking declined", "The booking request was declined."] },
  booking_cancelled: { guest: ["Your booking was cancelled", "This booking has been cancelled."],
    owner: ["Booking cancelled", "A booking was cancelled."] },
  booking_expired: { guest: ["Your booking hold expired", "Payment was not completed in time and the hold was released."],
    owner: ["Booking hold expired", "An unpaid hold expired and the dates were released."] },
  refund_succeeded: { guest: ["Your refund was processed", "A refund has been issued to your original payment method."],
    owner: ["Refund processed", "A refund was completed by Stripe."] }
};

const permanent = (code) => Object.assign(new Error(code), { code, retryable: false });
// A confirmation is obsolete once the booking ended without the stay going ahead.
const ENDED = new Set(["cancelled", "expired", "declined"]);

// Returns "sent" | "suppressed" (intentionally obsolete; acked). Throws to leave the row failed.
async function deliver(job) {
  const tpl = TEMPLATES[job.topic]?.[job.recipient];
  if (!tpl) throw permanent("unknown_template");
  if (!job.booking_id) throw permanent("missing_booking");
  const db = database();
  const { data: b } = await run(db.from("bookings").select("id,status,payment_status,cancel_requested,guest_email,confirmation_code,check_in,check_out,guest_count,total_cents,currency,idempotency_key").eq("id", job.booking_id).maybeSingle());
  if (!b) throw permanent("missing_booking");
  if (job.topic === "payment_due") {
    const { data: a } = await run(db.from("payment_attempts").select("status").eq("booking_id", b.id).order("created_at", { ascending: false }).limit(1).maybeSingle());
    if (b.status !== "payment_due" || b.payment_status !== "unpaid" || b.cancel_requested || a?.status !== "session_open") return "suppressed";
  }
  if (job.topic === "booking_confirmed" && ENDED.has(b.status)) return "suppressed";
  const property = await getProperty(db);
  const to = job.recipient === "owner" ? property.owner_email : b.guest_email;
  if (!to) throw permanent("missing_recipient"); // never acked as sent; surfaces as failed
  let extra = "";
  if (job.topic === "refund_succeeded" && job.payload?.refund_id) {
    const { data: r } = await run(db.from("refunds").select("amount_cents,currency").eq("id", job.payload.refund_id).maybeSingle());
    if (r) extra = `Refund amount: ${money(r.amount_cents, r.currency)}`;
  }
  const base = getBaseUrl();
  const link = job.recipient === "owner" ? `${base}/admin`
    : b.idempotency_key ? `${base}/booking#token=${deterministicGuestToken(b.idempotency_key)}` : null;
  const lines = [tpl[1], `Reference: ${b.confirmation_code}`, `Dates: ${b.check_in} to ${b.check_out} (${b.guest_count} guests)`,
    `Total: ${money(b.total_cents, b.currency)}`, extra].filter(Boolean);
  const subject = `${property.name || "Your stay"}: ${tpl[0]} (${b.confirmation_code})`;
  const html = `<p>${lines.map(esc).join("</p><p>")}</p>${link ? `<p><a href="${esc(link)}">Open ${job.recipient === "owner" ? "admin" : "your booking"}</a></p>` : ""}`;
  await sendNotification({ id: job.id, recipient: to, subject, html, text: [...lines, link].filter(Boolean).join("\n\n") });
  return "sent";
}

function outboxError(e) {
  if (!emailConfigured()) return "email_not_configured";
  if (e?.code && e.retryable === false) return safeError(e.code);
  if (e?.unknownOutcome) return "send_outcome_unknown";
  return e?.retryable === false ? "send_rejected" : "send_failed";
}

async function runOutbox(job, worker) {
  let outcome;
  try { outcome = await deliver(job); }
  catch (e) {
    await work("fail_outbox", { worker, id: job.id, error: outboxError(e) }).catch(() => null);
    throw e;
  }
  await work("ack_outbox", { worker, id: job.id }); // "sent" or intentionally obsolete
  return outcome;
}

// Runner -----------------------------------------------------------------------
const KINDS = [
  // processVerifiedEvent records failures through manager_event('failed'), which schedules
  // backoff and clears the lease atomically, so the worker must not settle_event again.
  { claim: "claim_events", run: async (job) => { await processVerifiedEvent(job.payload); } },
  { claim: "claim_attempts", run: async (job, worker) => {
    let r;
    try { r = await reconcileAttempt(job); }
    catch (e) { await settle("settle_attempt", worker, job.id, backoff(job.attempt_count), safeError(e?.code || "reconcile_failed")); throw e; }
    if (r.outcome === "released") return;
    const untilHold = r.hold_expires_at ? (Date.parse(r.hold_expires_at) - Date.now()) / 1000 + 30 : 0;
    const delay = ["open", "complete"].includes(r.outcome) ? Math.max(60, untilHold) : r.outcome === "review" ? 86400 : backoff(job.attempt_count);
    await settle("settle_attempt", worker, job.id, delay);
  } },
  { claim: "claim_refunds", run: async (job, worker) => {
    const r = await reconcileRefund(job);
    const delay = r.outcome === "error" ? backoff(job.attempts) * 5 : r.outcome === "review" ? 86400 : 3600;
    await settle("settle_refund", worker, job.id, delay, r.error ? "refund_retry" : undefined);
    if (r.error) throw new Error("refund");
  } },
  { claim: "claim_outbox", run: runOutbox }
];

// Immediate, best-effort email after a committed mutation. Drains ONLY the outbox, bounded
// by count and deadline. Never throws; failures stay recorded on the outbox row for retry.
export async function deliverNotifications({ limit = 2, deadlineMs = 15_000 } = {}) {
  const counts = { sent: 0, suppressed: 0, failed: 0 };
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ ...counts, timed_out: true }), deadlineMs); });
  return Promise.race([drain(counts, limit, deadlineMs), deadline]).finally(() => clearTimeout(timer));
}

async function drain(counts, limit, deadlineMs) {
  const started = Date.now();
  try {
    if (!emailConfigured()) return counts; // rows stay pending for the protected worker
    const size = Math.max(1, Math.min(5, Number.isInteger(limit) ? limit : 2));
    const worker = `notify:${randomUUID()}`;
    const jobs = (await work("claim_outbox", { worker, limit: size }))?.jobs || [];
    for (const job of jobs) {
      if (Date.now() - started > deadlineMs) break; // unprocessed leases expire and recover
      try { counts[(await runOutbox(job, worker)) === "sent" ? "sent" : "suppressed"] += 1; } catch { counts.failed += 1; }
    }
  } catch { counts.failed += 1; }
  return counts;
}

// POST /api/jobs (cron) → {processed, failed, stopped_early}
export async function runJobs({ limit = 10 } = {}) {
  const started = Date.now();
  const worker = `run:${randomUUID()}`;
  const size = Math.max(1, Math.min(25, Number.isInteger(limit) ? limit : 10));
  const counts = { processed: 0, failed: 0, stopped_early: false };
  for (const kind of KINDS) {
    if (Date.now() - started > BUDGET_MS) { counts.stopped_early = true; break; }
    let jobs = [];
    try { jobs = (await work(kind.claim, { worker, limit: size }))?.jobs || []; } catch { counts.failed += 1; continue; }
    for (const job of jobs) {
      if (Date.now() - started > BUDGET_MS) { counts.stopped_early = true; break; } // unprocessed leases expire and recover
      try { await kind.run(job, worker); counts.processed += 1; } catch { counts.failed += 1; }
    }
  }
  return counts;
}
