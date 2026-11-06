// Server-only Stripe adapter. Payment state is authoritative only from
// verified webhooks; nothing returned to the browser is trusted later.
import Stripe from "stripe";

const MIN_LIFETIME_S = 30 * 60 + 60; // Stripe minimum 30 min, plus clock margin
const MAX_LIFETIME_S = 24 * 60 * 60;
const CHECKOUT_HOSTS = new Set(["checkout.stripe.com"]);

let cached;

// Returns "test" | "live". Throws when Stripe must not be used.
export function stripeMode(env = process.env) {
  if (env.STRIPE_ENABLED !== "true") throw new Error("Stripe is disabled");
  const key = env.STRIPE_SECRET_KEY || "";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) {
    if (env.APP_ENV === "production" && env.LIVE_CHECKOUT_ENABLED === "true") return "live";
    throw new Error("Live Stripe key not permitted in this environment");
  }
  throw new Error("Stripe secret key missing or invalid");
}

export function stripeConfigured(env = process.env) {
  try { stripeMode(env); return Boolean(env.STRIPE_WEBHOOK_SECRET); } catch { return false; }
}

export const STRIPE_TIMEOUT_MS = 10_000;
let injected = null;

export function getStripe(env = process.env) {
  if (injected) return injected;
  stripeMode(env);
  cached ??= new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 1, timeout: STRIPE_TIMEOUT_MS });
  return cached;
}

// Test hook (server-only): inject a fake client, or null to restore. Never imported by browser code.
export function setStripeForTesting(fake = null) {
  injected = fake;
  cached = undefined;
}

function bookingUrl(siteUrl, guestToken, status) {
  const base = new URL("/booking", siteUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("siteUrl must be https");
  }
  base.hash = `token=${encodeURIComponent(guestToken)}&checkout=${status}`;
  return base.toString();
}

export function assertCheckoutUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !CHECKOUT_HOSTS.has(parsed.hostname)) {
    throw new Error("Untrusted checkout URL");
  }
  return parsed.toString();
}

export async function createCheckout({ attempt, booking, guestToken, siteUrl }, client = getStripe(), now = Date.now()) {
  const amount = attempt?.expected_total_cents;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Invalid expected_total_cents");
  if (!/^[a-zA-Z]{3}$/.test(attempt.currency || "")) throw new Error("Invalid currency");
  if (!attempt.id || !attempt.idempotency_key || !booking?.id || !guestToken) throw new Error("Missing checkout input");
  // expires_at is exactly the stored hold (stable across idempotent retries); never clipped or extended.
  const holdS = Math.floor(Date.parse(booking.hold_expires_at) / 1000);
  const nowS = Math.floor(now / 1000);
  if (!Number.isFinite(holdS) || holdS - nowS < MIN_LIFETIME_S) throw new Error("Hold expires too soon for checkout");
  if (holdS - nowS > MAX_LIFETIME_S) throw new Error("Hold exceeds Stripe checkout lifetime");
  const expiresAt = holdS;
  const metadata = { booking_id: String(booking.id), attempt_id: String(attempt.id) };

  const session = await client.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: String(booking.id),
      customer_email: booking.guest_email || undefined,
      expires_at: expiresAt,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: attempt.currency.toLowerCase(),
          unit_amount: amount,
          product_data: { name: booking.description || "Stay reservation" },
        },
      }],
      metadata,
      payment_intent_data: { metadata },
      success_url: bookingUrl(siteUrl, guestToken, "success"),
      cancel_url: bookingUrl(siteUrl, guestToken, "cancelled"),
    },
    { idempotencyKey: attempt.idempotency_key },
  );
  if (!session?.id || session.expires_at !== expiresAt) throw new Error("Checkout replay mismatch");
  // An idempotent replay can return a session that is already complete/expired with url=null:
  // hand back the id so the caller re-retrieves it. Only an open session needs a trusted URL.
  if (session.status && session.status !== "open") return { id: session.id, url: null, expiresAt: session.expires_at };
  return { id: session.id, url: assertCheckoutUrl(session.url), expiresAt: session.expires_at };
}

export const getCheckout = (id, client = getStripe()) =>
  client.checkout.sessions.retrieve(id, { expand: ["payment_intent.latest_charge"] });

export const expireCheckout = (id, client = getStripe()) => client.checkout.sessions.expire(id);

export function createRefund({ refund, paymentIntentId }, client = getStripe()) {
  if (!Number.isInteger(refund?.amount_cents) || refund.amount_cents <= 0) throw new Error("Invalid refund amount");
  if (!refund.id || !refund.idempotency_key || !refund.booking_id || !paymentIntentId) throw new Error("Missing refund input");
  return client.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: refund.amount_cents,
      metadata: { refund_id: String(refund.id), booking_id: String(refund.booking_id) },
    },
    { idempotencyKey: refund.idempotency_key },
  );
}

export const retrieveRefund = (id, client = getStripe()) => client.refunds.retrieve(id, { expand: ["payment_intent"] });

const MAX_SCAN = 1000;

// Bounded paginated scan (≤1000 rows). Returns the first match or null; null is NOT evidence of absence.
async function scan(list, params, match) {
  let startingAfter;
  for (let seen = 0; seen < MAX_SCAN;) {
    const page = await list({ ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const rows = page?.data || [];
    const hit = rows.find(match);
    if (hit) return hit;
    seen += rows.length;
    if (!page?.has_more || !rows.length) return null;
    startingAfter = rows.at(-1).id;
  }
  return null;
}

// Recovers a session created with a lost response, by created range + metadata.attempt_id.
export function findCheckoutForAttempt({ attemptId, createdFrom, createdTo }, client = getStripe()) {
  const created = { gte: Math.floor(createdFrom / 1000) - 60, lte: Math.floor(createdTo / 1000) + 60 };
  return scan((p) => client.checkout.sessions.list(p), { created }, (s) => s?.metadata?.attempt_id === String(attemptId));
}

// Recovers a refund created with a lost response, by payment intent + metadata.refund_id.
export function findRefundForLocal({ refundId, paymentIntentId }, client = getStripe()) {
  return scan((p) => client.refunds.list(p), { payment_intent: paymentIntentId }, (r) => r?.metadata?.refund_id === String(refundId));
}

export function verifyWebhook(rawBuffer, signature, client = getStripe(), env = process.env) {
  if (!Buffer.isBuffer(rawBuffer)) throw new Error("Raw body required");
  if (!signature || !env.STRIPE_WEBHOOK_SECRET) throw new Error("Missing signature or secret");
  const event = client.webhooks.constructEvent(rawBuffer, signature, env.STRIPE_WEBHOOK_SECRET);
  if (event.livemode !== (stripeMode(env) === "live")) throw new Error("Webhook livemode mismatch");
  return event;
}
