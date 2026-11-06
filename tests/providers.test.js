import test from "node:test";
import assert from "node:assert/strict";
import {
  stripeMode, createCheckout, getCheckout, createRefund, verifyWebhook, assertCheckoutUrl,
} from "../server/integrations/stripe.js";
import { sendNotification, emailConfigured } from "../server/integrations/email.js";
import {
  deterministicGuestToken, deterministicCalendarToken, randomCalendarToken, hashToken, safeEqual, tokenMatches,
} from "../server/integrations/tokens.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const inMin = (m) => new Date(NOW + m * 60_000).toISOString();
const attempt = { id: "att_1", idempotency_key: "checkout/att_1", expected_total_cents: 123456, currency: "CAD" };
const booking = { id: "bk_1", hold_expires_at: inMin(60) };

function fakeStripe({ url = "https://checkout.stripe.com/c/pay/cs_1", event } = {}) {
  const calls = [];
  return {
    calls,
    checkout: { sessions: {
      create: async (params, opts) => { calls.push({ params, opts }); return { id: "cs_1", url, expires_at: params.expires_at }; },
      retrieve: async (id, opts) => { calls.push({ id, opts }); return { id }; },
    } },
    refunds: { create: async (params, opts) => { calls.push({ params, opts }); return { id: "re_1" }; } },
    webhooks: { constructEvent: (raw, sig, secret) => {
      if (sig !== "good" || secret !== "whsec_x") throw new Error("bad signature");
      return event;
    } },
  };
}

const input = (b = booking) => ({ attempt, booking: b, guestToken: "guest_abc", siteUrl: "https://stay.example" });

test("stripeMode gating", () => {
  assert.throws(() => stripeMode({ STRIPE_SECRET_KEY: "sk_test_1" }));
  assert.equal(stripeMode({ STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_1" }), "test");
  assert.throws(() => stripeMode({ STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_1" }));
  assert.throws(() => stripeMode({ STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_1", APP_ENV: "production" }));
  assert.equal(stripeMode({ STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_1", APP_ENV: "production", LIVE_CHECKOUT_ENABLED: "true" }), "live");
});

test("checkout charges full saved amount with stable idempotency and metadata", async () => {
  const s = fakeStripe();
  const out = await createCheckout(input(), s, NOW);
  await createCheckout(input(), s, NOW);
  const [a, b] = s.calls;
  assert.equal(a.opts.idempotencyKey, "checkout/att_1");
  assert.equal(b.opts.idempotencyKey, a.opts.idempotencyKey);
  assert.equal(a.params.line_items.length, 1);
  assert.equal(a.params.line_items[0].price_data.unit_amount, 123456);
  assert.equal(a.params.line_items[0].price_data.currency, "cad");
  assert.deepEqual(a.params.payment_method_types, ["card"]);
  assert.deepEqual(a.params.metadata, { booking_id: "bk_1", attempt_id: "att_1" });
  assert.deepEqual(a.params.payment_intent_data.metadata, a.params.metadata);
  assert.equal(a.params.client_reference_id, "bk_1");
  assert.equal(a.params.expires_at, Math.floor(Date.parse(booking.hold_expires_at) / 1000));
  assert.match(a.params.success_url, /^https:\/\/stay\.example\/booking#token=guest_abc/);
  assert.ok(!a.params.success_url.includes("?"));
  assert.equal(out.url, "https://checkout.stripe.com/c/pay/cs_1");
});

test("checkout lifetime: rejects <31min and >24h without calling Stripe; boundaries accepted", async () => {
  for (const m of [20, 31 - 1 / 60, 24 * 60 + 1, 60 * 48]) {
    const s = fakeStripe();
    await assert.rejects(createCheckout(input({ ...booking, hold_expires_at: inMin(m) }), s, NOW));
    assert.equal(s.calls.length, 0, `no request for ${m} min`);
  }
  for (const m of [31, 24 * 60]) {
    const s = fakeStripe();
    await createCheckout(input({ ...booking, hold_expires_at: inMin(m) }), s, NOW);
    assert.equal(s.calls[0].params.expires_at, NOW / 1000 + m * 60, "expiry is exactly the stored hold, never clipped");
  }
});

test("idempotent retries send identical immutable params; replays of finished sessions return url null", async () => {
  const s = fakeStripe();
  await createCheckout(input(), s, NOW);
  await createCheckout(input(), s, NOW + 5 * 60_000); // later retry: same key, same expiry
  assert.deepEqual(s.calls[1].params, s.calls[0].params);
  assert.equal(s.calls[1].opts.idempotencyKey, s.calls[0].opts.idempotencyKey);
  for (const status of ["complete", "expired"]) {
    const replay = fakeStripe({ url: null });
    const create = replay.checkout.sessions.create;
    replay.checkout.sessions.create = async (p, o) => ({ ...(await create(p, o)), status });
    const out = await createCheckout(input(), replay, NOW);
    assert.deepEqual(out, { id: "cs_1", url: null, expiresAt: s.calls[0].params.expires_at });
  }
  const open = fakeStripe({ url: null });
  const create = open.checkout.sessions.create;
  open.checkout.sessions.create = async (p, o) => ({ ...(await create(p, o)), status: "open" });
  await assert.rejects(createCheckout(input(), open, NOW), "a new open session needs a trusted URL");
  const drift = fakeStripe();
  drift.checkout.sessions.create = async () => ({ id: "cs_1", url: "https://checkout.stripe.com/x", expires_at: 1 });
  await assert.rejects(createCheckout(input(), drift, NOW), /replay mismatch/);
});

test("provider clients are bounded: Stripe 10s/1 retry, Supabase 10s fetch, Resend 10s", async () => {
  const { STRIPE_TIMEOUT_MS, setStripeForTesting, getStripe } = await import("../server/integrations/stripe.js");
  const { DB_TIMEOUT_MS } = await import("../server/integrations/supabase.js");
  const { EMAIL_TIMEOUT_MS } = await import("../server/integrations/email.js");
  assert.ok(STRIPE_TIMEOUT_MS <= 10_000 && DB_TIMEOUT_MS <= 10_000 && EMAIL_TIMEOUT_MS <= 10_000);
  const fake = { fake: true };
  setStripeForTesting(fake);
  assert.equal(getStripe({}), fake, "injected client needs no credentials and makes no network calls");
  setStripeForTesting(null);
  assert.throws(() => getStripe({}), /disabled/);
});

test("checkout rejects bad amounts and untrusted URLs", async () => {
  await assert.rejects(createCheckout({ ...input(), attempt: { ...attempt, expected_total_cents: 10.5 } }, fakeStripe(), NOW));
  await assert.rejects(createCheckout(input(), fakeStripe({ url: "https://evil.example/pay" }), NOW));
  assert.throws(() => assertCheckoutUrl("http://checkout.stripe.com/x"));
});

test("getCheckout expands latest charge", async () => {
  const s = fakeStripe();
  await getCheckout("cs_1", s);
  assert.deepEqual(s.calls[0].opts.expand, ["payment_intent.latest_charge"]);
});

test("refund idempotency and metadata", async () => {
  const s = fakeStripe();
  const refund = { id: "rf_1", booking_id: "bk_1", amount_cents: 5000, idempotency_key: "refund/rf_1" };
  await createRefund({ refund, paymentIntentId: "pi_1" }, s);
  assert.equal(s.calls[0].opts.idempotencyKey, "refund/rf_1");
  assert.deepEqual(s.calls[0].params.metadata, { refund_id: "rf_1", booking_id: "bk_1" });
});

test("webhook requires signature and matching livemode", () => {
  const env = { STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_x" };
  const raw = Buffer.from("{}");
  assert.equal(verifyWebhook(raw, "good", fakeStripe({ event: { id: "evt", livemode: false } }), env).id, "evt");
  assert.throws(() => verifyWebhook(raw, "bad", fakeStripe({ event: { livemode: false } }), env));
  assert.throws(() => verifyWebhook(raw, "good", fakeStripe({ event: { livemode: true } }), env), /livemode/);
  assert.throws(() => verifyWebhook("{}", "good", fakeStripe({ event: { livemode: false } }), env));
});

function fakeResend() {
  const calls = [];
  return { calls, emails: { send: async (p, o) => { calls.push({ p, o }); return { data: { id: "em_1" }, error: null }; } } };
}
const msg = { id: "ob_1", recipient: "guest@example.com", subject: "Hi", text: "t" };

test("email redirects outside production and fails closed", async () => {
  const r = fakeResend();
  const env = { APP_ENV: "staging", RESEND_FROM: "a@x.test", EMAIL_TEST_RECIPIENT: "qa@x.test" };
  const out = await sendNotification(msg, r, env);
  assert.deepEqual(r.calls[0].p.to, ["qa@x.test"]);
  assert.equal(r.calls[0].o.idempotencyKey, "outbox/ob_1");
  assert.equal(out.redirected, true);
  await assert.rejects(sendNotification(msg, fakeResend(), { APP_ENV: "staging", RESEND_FROM: "a@x.test" }));
  await assert.rejects(sendNotification(msg, fakeResend(), { APP_ENV: "production" }));
  const p = fakeResend();
  await sendNotification(msg, p, { APP_ENV: "production", RESEND_FROM: "a@x.test" });
  assert.deepEqual(p.calls[0].p.to, ["guest@example.com"]);
  assert.equal(emailConfigured({ RESEND_API_KEY: "k", RESEND_FROM: "a", APP_ENV: "staging" }), false);
});

test("email without a provider id or with an error is an unknown/failed outcome (never acked)", async () => {
  const env = { APP_ENV: "production", RESEND_FROM: "a@x.test" };
  const noId = { emails: { send: async () => ({ data: {}, error: null }) } };
  await assert.rejects(sendNotification(msg, noId, env), (e) => e.unknownOutcome === true && e.retryable === true);
  const nullData = { emails: { send: async () => ({ data: null, error: null }) } };
  await assert.rejects(sendNotification(msg, nullData, env), (e) => e.unknownOutcome === true);
  const rejected = { emails: { send: async () => ({ data: null, error: { name: "validation_error" } }) } };
  await assert.rejects(sendNotification(msg, rejected, env), (e) => e.retryable === false);
  await assert.rejects(sendNotification({ ...msg, recipient: "" }, fakeResend(), env), (e) => e.retryable === false);
});

test("tokens are scoped, stable, and compared by hash", () => {
  const env = { GUEST_TOKEN_SECRET: "x".repeat(32) };
  assert.throws(() => deterministicGuestToken("k", { GUEST_TOKEN_SECRET: "short" }));
  const g = deterministicGuestToken("k", env);
  const c = deterministicCalendarToken("k", env);
  assert.equal(g, deterministicGuestToken("k", env));
  assert.ok(g.startsWith("guest_") && c.startsWith("calendar_"));
  assert.notEqual(g.slice(6), c.slice(9));
  assert.notEqual(randomCalendarToken(), randomCalendarToken());
  assert.ok(tokenMatches(g, hashToken(g)));
  assert.ok(!safeEqual(hashToken(g), hashToken(c)));
  assert.ok(!safeEqual(hashToken(g), "short"));
});
