// Payment coordination. Money state changes ONLY through manager_event with a verified,
// re-retrieved Stripe object. Checkout creation, browser redirects and workers never confirm.
import { HttpError, getBaseUrl, readRawBody } from "../http.js";
import * as stripe from "../integrations/stripe.js";
import { deterministicCalendarToken, deterministicGuestToken, hashToken } from "../integrations/tokens.js";
import { database, enumValue, getAttemptForBooking, getBooking, getProperty, integer, invalid, mapBooking, onlyKeys,
  policiesComplete, rpc, run, safeError, safeHttpsUrl, text, uuid } from "./data.js";
import { rateLimit, requireGuest } from "./public.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MIN_CREATE_MS = 31 * MIN;      // Stripe needs ≥30 min of session lifetime
const KEY_WINDOW_MS = 23 * HOUR;     // Stripe idempotency keys last 24h; never re-create after this
const OPEN = new Set(["created", "session_open"]);
const REFUND_KEY = /^[A-Za-z0-9:_-]{8,200}$/;

const live = () => stripe.stripeMode() === "live";
const idOf = (v) => (typeof v === "string" ? v : v?.id) || null;
const errCode = (e, fallback) => safeError(e?.code || e?.type || fallback) || fallback;

async function getAttempt(id, db) {
  const { data } = await run(database(db).from("payment_attempts").select("*").eq("id", id).maybeSingle());
  return data ?? null;
}

async function recordAttemptError(attempt, code) {
  try { await rpc("manager_payment", { p_attempt_id: attempt.id, p_action: "error", p_data: { error: code } }); }
  catch { console.error("payment error record failed"); }
}

// Exact binding check; any mismatch throws and the hold is kept.
function assertSession(s, attempt, bookingId) {
  const ok = s && s.metadata?.attempt_id === attempt.id && s.metadata?.booking_id === bookingId
    && s.client_reference_id === bookingId && s.mode === "payment" && s.livemode === live()
    && s.amount_total === attempt.expected_total_cents && String(s.currency || "").toUpperCase() === attempt.currency;
  if (!ok) throw Object.assign(new Error("session_mismatch"), { code: "session_mismatch" });
  return s;
}

// Live checkout requires explicit tax confirmation and complete published policies (derived,
// never a stored flag). Test mode may run on incomplete setup so the owner can rehearse.
export function checkoutGate(property, mode = stripe.stripeMode()) {
  if (mode !== "live") return;
  if (property?.tax_configured !== true || !policiesComplete(property?.published_content)) {
    throw Object.assign(new Error("checkout_not_ready"), { code: "checkout_not_ready" });
  }
}

async function attach(attempt, s) {
  if (s.status !== "open" || !s.url) return attempt;
  await rpc("manager_payment", { p_attempt_id: attempt.id, p_action: "attached", p_data: {
    session_id: s.id, session_url: stripe.assertCheckoutUrl(s.url), amount_cents: s.amount_total, currency: attempt.currency } });
  return (await getAttempt(attempt.id)) || attempt;
}

// Binds a verified, re-retrieved session of any status (no URL needed) to an unbound attempt.
// Never confirms payment or releases the hold.
async function bindRecovered(attempt, s) {
  if (attempt.stripe_checkout_session_id === s.id) return attempt;
  await rpc("manager_bind_recovered", { p_attempt_id: attempt.id, p_data: {
    session_id: s.id, status: s.status, amount_cents: s.amount_total, currency: String(s.currency || "").toUpperCase(),
    attempt_id: s.metadata?.attempt_id, booking_id: s.metadata?.booking_id } });
  return (await getAttempt(attempt.id)) || attempt;
}

const bindSession = (attempt, s) => (s.status === "open" && s.url ? attach(attempt, s) : bindRecovered(attempt, s));

const recover = (attempt, now) => stripe.findCheckoutForAttempt({
  attemptId: attempt.id, createdFrom: Date.parse(attempt.created_at), createdTo: now });

// Makes sure an open, validated session exists for a payment_due booking. Returns {attempt, session}.
async function ensureCheckout(booking, attempt, now = Date.now()) {
  if (booking.status !== "payment_due" || booking.cancel_requested || !attempt || !OPEN.has(attempt.status)) {
    return { attempt, session: null };
  }
  if (attempt.stripe_checkout_session_id) {
    const s = assertSession(await stripe.getCheckout(attempt.stripe_checkout_session_id), attempt, booking.id);
    return { attempt: attempt.status === "created" ? await attach(attempt, s) : attempt, session: s };
  }
  const age = now - Date.parse(attempt.created_at);
  const left = Date.parse(booking.hold_expires_at) - now;
  let s = null;
  if (age >= KEY_WINDOW_MS || left < MIN_CREATE_MS) {
    s = await recover(attempt, now); // never create late; a miss is not evidence of absence
    if (!s) { await recordAttemptError(attempt, "review_checkout_unrecoverable"); return { attempt, session: null }; }
  } else {
    checkoutGate(await getProperty());
    if (!booking.idempotency_key) throw Object.assign(new Error("legacy_booking"), { code: "legacy_booking_no_token" });
    // Same key ⇒ same immutable params (expiry = stored hold, amount, description) on every retry.
    const created = await stripe.createCheckout({
      attempt, siteUrl: getBaseUrl(), guestToken: deterministicGuestToken(booking.idempotency_key),
      booking: { id: booking.id, hold_expires_at: booking.hold_expires_at, guest_email: booking.guest_email,
        description: `Stay ${booking.check_in} to ${booking.check_out} (${booking.confirmation_code})` }
    }, undefined, now);
    s = await stripe.getCheckout(created.id); // replay may be complete/expired with url null
  }
  assertSession(s, attempt, booking.id);
  return { attempt: await bindSession(attempt, s), session: s };
}

// Legacy pending rows have no guest capability. Provision `legacy:<id>` + scoped token hashes
// (SQL 005) BEFORE approval so the payment email and Checkout return link work.
async function provisionLegacyAccess(booking, actorId) {
  if (booking.quote_snapshot?.legacy !== true || booking.idempotency_key || booking.guest_access_hash) return false;
  const key = `legacy:${booking.id}`;
  await rpc("manager_guest_access", { p_booking_id: booking.id, p_actor: actorId, p_key: key,
    p_guest_hash: hashToken(deterministicGuestToken(key)), p_calendar_hash: hashToken(deterministicCalendarToken(key)) });
  return true;
}

async function ensureSafely(booking, attempt) {
  try { return await ensureCheckout(booking, attempt); } catch (e) {
    await recordAttemptError(attempt, errCode(e, "checkout_failed"));
    return { attempt, session: null, error: true };
  }
}

// POST /api/admin/bookings/:id/actions {action, reason?} → {booking, payment_pending}
export async function bookingAction(id, body, actor, _request) {
  onlyKeys(body, ["action", "reason"]);
  const action = enumValue(body?.action, ["approve", "decline", "cancel", "complete"], "action");
  const bookingId = uuid(id);
  const actorId = uuid(actor?.id, "actor");
  const reason = text(body?.reason, "reason", { max: 500 }) || null;
  if (action === "approve") await provisionLegacyAccess(await getBooking(bookingId), actorId);
  const result = await rpc("manager_action", { p_booking_id: bookingId, p_action: action, p_actor: actorId, p_reason: reason });
  let booking = await getBooking(id);
  const attempt = result.attempt?.id ? await getAttempt(result.attempt.id) : await getAttemptForBooking(id);
  let pending = false;
  if (booking.status === "payment_due" && attempt) {
    if (action === "approve" && !booking.cancel_requested) {
      const { session } = await ensureSafely(booking, attempt);
      pending = !(session?.status === "open");
    } else if (action === "cancel" || booking.cancel_requested) {
      try { await reconcileAttempt(attempt); } catch { /* recorded; worker retries */ }
      booking = await getBooking(id);
      pending = booking.status === "payment_due";
    }
  }
  return { booking: mapBooking(booking), payment_pending: pending };
}

// POST /api/guest/checkout → {url}. Never confirms anything.
export async function guestCheckout(request) {
  const booking = await requireGuest(request);
  await rateLimit(request, "checkout", 10);
  if (booking.status !== "payment_due" || booking.payment_status !== "unpaid" || booking.cancel_requested) {
    throw new HttpError(409, "This booking has no payment due", "conflict");
  }
  if (!booking.idempotency_key) throw new HttpError(409, "Online payment is unavailable for this booking", "conflict");
  const { session } = await ensureSafely(booking, await getAttemptForBooking(booking.id));
  if (session?.status !== "open" || !session.url) {
    throw new HttpError(503, "Payment is not available right now. Please try again shortly", "service_unavailable");
  }
  return { url: stripe.assertCheckoutUrl(session.url) };
}

// Worker/cancel reconciliation. Releases ONLY on Stripe evidence {expired, unpaid}.
export async function reconcileAttempt(attemptRow, now = Date.now()) {
  let attempt = (await getAttempt(attemptRow.id)) || attemptRow;
  if (!OPEN.has(attempt.status) && attempt.status !== "processing") return { outcome: attempt.status };
  const booking = await getBooking(attempt.booking_id);
  if (booking.status !== "payment_due") return { outcome: "inactive" };
  const due = booking.cancel_requested || Date.parse(booking.hold_expires_at) <= now;
  let session;
  try {
    if (!attempt.stripe_checkout_session_id) {
      if (!due) {
        const r = await ensureCheckout(booking, attempt, now);
        return { outcome: r.session ? "open" : "pending", hold_expires_at: booking.hold_expires_at };
      }
      session = await recover(attempt, now);
      if (!session) { await recordAttemptError(attempt, "review_no_session_found"); return { outcome: "review" }; }
      assertSession(session, attempt, booking.id);
      attempt = await bindSession(attempt, session); // terminal sessions bind without a URL
      if (!attempt.stripe_checkout_session_id) { await recordAttemptError(attempt, "review_unattached_session"); return { outcome: "review" }; }
    } else {
      session = assertSession(await stripe.getCheckout(attempt.stripe_checkout_session_id), attempt, booking.id);
    }
    if (!due) {
      if (session.status === "open" && attempt.status === "created") await attach(attempt, session);
      if (session.status !== "expired") return { outcome: session.status, hold_expires_at: booking.hold_expires_at };
    }
    if (session.status === "open") {
      try { await stripe.expireCheckout(session.id); } catch { /* re-retrieve decides */ }
      session = assertSession(await stripe.getCheckout(session.id), attempt, booking.id);
    }
    if (session.status === "expired" && session.payment_status === "unpaid") {
      await rpc("manager_payment", { p_attempt_id: attempt.id, p_action: "terminal_unpaid",
        p_data: { session_id: session.id, status: "expired", payment_status: "unpaid" } });
      return { outcome: "released" };
    }
    await recordAttemptError(attempt, session.status === "complete" ? "awaiting_verified_webhook" : "review_session_state");
    return { outcome: "awaiting_webhook" };
  } catch (e) {
    await recordAttemptError(attempt, errCode(e, "reconcile_failed"));
    throw e;
  }
}

// Refunds ----------------------------------------------------------------------
const REFUND_FIELDS = ["id", "booking_id", "amount_cents", "currency", "status", "stripe_refund_id", "reason", "source",
  "last_error", "verified_at", "created_at", "updated_at"];
const safeRefund = (r) => Object.fromEntries(REFUND_FIELDS.map((k) => [k, r[k] ?? null]));

async function refundContext(refund) {
  const db = database();
  const [{ data: row }, { data: attempt }] = await Promise.all([
    run(db.from("refunds").select("*").eq("id", refund.id).maybeSingle()),
    run(db.from("payment_attempts").select("id,captured_cents,stripe_payment_intent_id").eq("id", refund.payment_attempt_id).maybeSingle())
  ]);
  const { data: succeeded } = await run(db.from("refunds").select("amount_cents").eq("payment_attempt_id", refund.payment_attempt_id).eq("status", "succeeded").limit(1000));
  return { row: row || refund, attempt, succeededCents: (succeeded || []).reduce((n, r) => n + r.amount_cents, 0) };
}

async function recordRefundError(id, code) {
  try { return await rpc("manager_refund", { p_action: "error", p_actor: null, p_data: { refund_id: id, error: code } }); }
  catch { console.error("refund error record failed"); return null; }
}

// Sends (or recovers) a pending refund. Never finalizes: only verified refund.* events do.
export async function reconcileRefund(refundRow, now = Date.now()) {
  const { row, attempt, succeededCents } = await refundContext(refundRow);
  if (row.status !== "pending") return { outcome: row.status, refund: row };
  const pi = attempt?.stripe_payment_intent_id;
  try {
    if (row.stripe_refund_id) {
      const re = await stripe.retrieveRefund(row.stripe_refund_id);
      return { outcome: re.status === "pending" ? "awaiting_webhook" : "awaiting_webhook_terminal", refund: row };
    }
    if (row.source !== "admin" || !pi) return { outcome: "review", refund: await recordRefundError(row.id, "review_refund_unbound") };
    if (succeededCents + row.amount_cents > attempt.captured_cents) {
      return { outcome: "review", refund: await recordRefundError(row.id, "review_superseded_by_succeeded_refunds") };
    }
    if (String(row.last_error || "").startsWith("review_overcommitted")) return { outcome: "review", refund: row };
    let re;
    if (now - Date.parse(row.created_at) >= KEY_WINDOW_MS) {
      re = await stripe.findRefundForLocal({ refundId: row.id, paymentIntentId: pi });
      if (!re) return { outcome: "review", refund: await recordRefundError(row.id, "review_refund_unrecoverable") };
    } else {
      re = await stripe.createRefund({ refund: row, paymentIntentId: pi });
    }
    if (idOf(re.payment_intent) !== pi || re.amount !== row.amount_cents || re.metadata?.refund_id !== row.id) {
      return { outcome: "review", refund: await recordRefundError(row.id, "review_refund_mismatch") };
    }
    const attached = await rpc("manager_refund", { p_action: "attach", p_actor: null, p_data: { refund_id: row.id, stripe_refund_id: re.id } });
    return { outcome: "sent", refund: attached };
  } catch (e) {
    const updated = await recordRefundError(row.id, errCode(e, "refund_provider_error"));
    return { outcome: "error", refund: updated || row, error: true };
  }
}

// POST /api/admin/refunds {booking_id, amount_cents, reason, idempotency_key} → {refund}
export async function requestRefund(body, actor) {
  onlyKeys(body, ["booking_id", "amount_cents", "reason", "idempotency_key"]);
  const key = body?.idempotency_key;
  if (typeof key !== "string" || !REFUND_KEY.test(key) || key.startsWith("stripe:")) throw invalid("idempotency_key", "Invalid request key");
  const reserved = await rpc("manager_refund", { p_action: "reserve", p_actor: uuid(actor?.id, "actor"), p_data: {
    booking_id: uuid(body.booking_id, "booking_id"), amount_cents: integer(body.amount_cents, "amount_cents", { min: 1 }),
    reason: text(body.reason, "reason", { min: 1, max: 500, optional: false }), idempotency_key: key } });
  const { refund } = await reconcileRefund(reserved);
  return { refund: safeRefund(refund || reserved) };
}

// Webhooks ---------------------------------------------------------------------
const eventArgs = (event, effect, data = {}) => ({ p_event_id: event.id, p_type: event.type, p_livemode: event.livemode,
  p_payload: event, p_effect: effect, p_data: data });

function receiptUrl(session) {
  const url = safeHttpsUrl(session.payment_intent?.latest_charge?.receipt_url);
  return url && /(^|\.)stripe\.com$/.test(new URL(url).hostname) ? url : null;
}

async function checkoutEffect(event) {
  const s = await stripe.getCheckout(event.data?.object?.id);
  const attemptId = s?.metadata?.attempt_id;
  if (!attemptId && !s?.metadata?.booking_id) return ["ignored"]; // not created by this app
  const attempt = await getAttempt(uuid(attemptId, "attempt_id"));
  if (!attempt) throw Object.assign(new Error("attempt_not_found"), { code: "review_attempt_missing" });
  assertSession(s, attempt, attempt.booking_id);
  if (event.type === "checkout.session.expired") {
    let bound = attempt;
    if (!attempt.stripe_checkout_session_id && OPEN.has(attempt.status)) bound = await bindRecovered(attempt, s);
    if (bound.stripe_checkout_session_id === s.id && s.status === "expired" && s.payment_status === "unpaid" && OPEN.has(bound.status)) {
      await rpc("manager_payment", { p_attempt_id: attempt.id, p_action: "terminal_unpaid",
        p_data: { session_id: s.id, status: "expired", payment_status: "unpaid" } });
    }
    return ["ignored"];
  }
  // completed-but-unpaid (async methods) is durably ignored; a later async_payment_succeeded
  // event is a different event id and is applied then.
  if (s.status !== "complete" || s.payment_status !== "paid") return ["ignored"];
  const pi = idOf(s.payment_intent);
  if (!pi) throw Object.assign(new Error("missing_payment_intent"), { code: "missing_payment_intent" });
  return ["paid", { attempt_id: attempt.id, booking_id: attempt.booking_id, session_id: s.id, payment_intent: pi,
    amount_cents: s.amount_total, currency: attempt.currency, receipt_url: receiptUrl(s) }];
}

async function refundEffect(event) {
  const re = await stripe.retrieveRefund(event.data?.object?.id);
  const pi = idOf(re.payment_intent);
  const piMeta = typeof re.payment_intent === "object" ? re.payment_intent?.metadata || {} : {};
  const { data: attempt } = pi ? await run(database().from("payment_attempts").select("id,booking_id,currency,verified_paid_at")
    .eq("stripe_payment_intent_id", pi).maybeSingle()) : { data: null };
  if (!attempt?.verified_paid_at) {
    if (!piMeta.attempt_id && !re.metadata?.refund_id) return ["ignored"]; // unrelated payment
    throw Object.assign(new Error("payment_not_recorded"), { code: "refund_before_payment" }); // retry later
  }
  const localId = re.metadata?.refund_id;
  return ["refund", {
    refund_id: typeof localId === "string" && /^[0-9a-f-]{36}$/i.test(localId) ? localId : undefined,
    stripe_refund_id: re.id, booking_id: attempt.booking_id, payment_intent: pi, amount_cents: re.amount,
    currency: String(re.currency || "").toUpperCase(),
    status: ["succeeded", "failed", "canceled"].includes(re.status) ? re.status : "pending",
    failure_reason: re.failure_reason || undefined
  }];
}

export const CHECKOUT_TYPES = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired"]);
export const REFUND_TYPES = new Set(["refund.created", "refund.updated", "refund.failed"]);

// Applies one stored or fresh verified event. Re-retrieves the Stripe object; never re-verifies old signatures.
export async function processVerifiedEvent(event) {
  if (!event?.id || !event.type || event.livemode !== live()) throw Object.assign(new Error("event_mode"), { code: "event_livemode_mismatch" });
  try {
    const [effect, data] = CHECKOUT_TYPES.has(event.type) ? await checkoutEffect(event)
      : REFUND_TYPES.has(event.type) ? await refundEffect(event) : ["ignored"]; // unknown checkout.* etc: durable ignore
    return await rpc("manager_event", eventArgs(event, effect, data));
  } catch (e) {
    try { await rpc("manager_event", eventArgs(event, "failed", { error: errCode(e, "effect_failed") })); }
    catch { console.error("event failure record failed"); }
    throw new HttpError(503, "Webhook processing failed", "service_unavailable");
  }
}

// POST /api/stripe/webhook → {received:true}. Non-2xx makes Stripe retry.
export async function webhook(request) {
  const raw = await readRawBody(request);
  let event;
  try { event = stripe.verifyWebhook(raw, request.headers?.["stripe-signature"]); } catch {
    throw new HttpError(400, "Invalid webhook signature", "bad_request");
  }
  const stored = await rpc("manager_event", eventArgs(event, "received"));
  if (stored?.replay) return { received: true };
  await processVerifiedEvent(event);
  return { received: true };
}
