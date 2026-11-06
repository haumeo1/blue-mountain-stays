// Real payment-service workflows against injected fake Supabase + Stripe clients.
// Placeholder credentials only; the injected clients make no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { setDatabaseForTesting } from "../server/integrations/supabase.js";
import { setStripeForTesting } from "../server/integrations/stripe.js";
import { deterministicCalendarToken, deterministicGuestToken, hashToken } from "../server/integrations/tokens.js";
import * as payments from "../server/services/payments.js";

Object.assign(process.env, { STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_placeholder_not_real",
  GUEST_TOKEN_SECRET: "test-only-secret-not-used-anywhere-0123456789" });
for (const k of ["PUBLIC_SITE_URL", "VERCEL", "VERCEL_ENV", "APP_ENV", "LIVE_CHECKOUT_ENABLED"]) delete process.env[k];

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR = { id: "11111111-1111-4111-8111-111111111111" };
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const PROPERTY = { id: "p1", slug: "blue-mountain-house", tax_configured: false, published_content: {} };
const booking = (patch = {}) => ({ id: BOOKING_ID, status: "payment_due", payment_status: "unpaid", cancel_requested: false,
  idempotency_key: "key-0123456789abcdef", guest_access_hash: "h".repeat(64), guest_email: "g@example.com",
  confirmation_code: "BMH-1", check_in: "2026-12-01", check_out: "2026-12-04", hold_expires_at: iso(NOW + 60 * 60_000),
  quote_snapshot: {}, ...patch });
const attemptRow = (patch = {}) => ({ id: ATTEMPT_ID, booking_id: BOOKING_ID, status: "created", expected_total_cents: 50000,
  currency: "CAD", idempotency_key: `checkout/${ATTEMPT_ID}`, stripe_checkout_session_id: null, created_at: iso(NOW - 60_000), ...patch });
const session = (patch = {}) => ({ id: "cs_test_1", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_test_1",
  mode: "payment", livemode: false, amount_total: 50000, currency: "cad", client_reference_id: BOOKING_ID,
  metadata: { attempt_id: ATTEMPT_ID, booking_id: BOOKING_ID }, expires_at: 0, ...patch });

const eqOf = (calls, col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];

// Stateful fake: state.booking / state.attempt mutate through RPC handlers.
function setup({ bookingRow = booking(), attempt = attemptRow(), rpcs = {}, property = PROPERTY } = {}) {
  const state = { booking: bookingRow, attempt, log: [] };
  const from = (table) => {
    const calls = [];
    const b = new Proxy({}, { get(_, key) {
      if (key === "then") {
        let data = null;
        if (table === "properties") data = property;
        if (table === "bookings") data = state.booking;
        if (table === "payment_attempts") data = state.attempt;
        state.log.push({ table, calls });
        return (resolve) => resolve({ data, error: null });
      }
      return (...args) => { calls.push([key, ...args]); return b; };
    } });
    return b;
  };
  const defaults = {
    manager_rate_limit: () => true,
    manager_payment: (a) => {
      if (a.p_action === "attached") state.attempt = { ...state.attempt, status: "session_open", stripe_checkout_session_id: a.p_data.session_id };
      if (a.p_action === "terminal_unpaid") { state.attempt = { ...state.attempt, status: "expired" }; state.booking = { ...state.booking, status: "expired" }; }
      return { attempt: { id: state.attempt.id } };
    },
    manager_bind_recovered: (a) => { state.attempt = { ...state.attempt, stripe_checkout_session_id: a.p_data.session_id }; return { attempt: { id: ATTEMPT_ID } }; }
  };
  const handlers = { ...defaults, ...rpcs };
  setDatabaseForTesting({
    from,
    rpc: async (name, args) => {
      state.log.push({ rpc: name, args });
      if (!handlers[name]) return { data: null, error: { message: "unexpected rpc" } };
      return { data: await handlers[name](args, state), error: null };
    }
  });
  return state;
}

function fakeStripe({ retrieve = session(), list = [], createStatus } = {}) {
  const calls = [];
  const client = { calls, checkout: { sessions: {
    create: async (p, o) => { calls.push(["create", p, o]); return { ...retrieve, expires_at: p.expires_at, ...(createStatus ? { status: createStatus, url: null } : {}) }; },
    retrieve: async (id) => { calls.push(["retrieve", id]); return typeof retrieve === "function" ? retrieve(id) : retrieve; },
    list: async (p) => { calls.push(["list", p]); return { data: list, has_more: false }; },
    expire: async (id) => { calls.push(["expire", id]); }
  } } };
  setStripeForTesting(client);
  return client;
}

const rpcNames = (state) => state.log.filter((e) => e.rpc).map((e) => e.rpc);
const guestReq = () => ({ headers: { authorization: `Bearer ${deterministicGuestToken("key-0123456789abcdef")}` }, socket: {} });

test.afterEach(() => { setDatabaseForTesting(null); setStripeForTesting(null); });

test("guest checkout returns {url} (contract), creates once and never confirms payment", async () => {
  const state = setup();
  const stripe = fakeStripe();
  const out = await payments.guestCheckout(guestReq());
  assert.deepEqual(out, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.equal(stripe.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(stripe.calls[0][1].expires_at, Math.floor(Date.parse(state.booking.hold_expires_at) / 1000));
  assert.ok(!rpcNames(state).includes("manager_event"), "no money finalization from a browser/API path");
  assert.ok(!state.log.some((e) => e.rpc === "manager_payment" && e.args.p_action !== "attached"));
});

test("live checkout requires explicit tax confirmation and derived complete policies; test mode may rehearse", () => {
  const complete = { policies_confirmed: true, policies: { cancellation: "c", house_rules: "h" } };
  assert.doesNotThrow(() => payments.checkoutGate({ tax_configured: false, published_content: {} }, "test"));
  for (const p of [
    { tax_configured: false, published_content: complete },
    { tax_configured: true, published_content: { policies_complete: true } }, // stored flag is not trusted
    { tax_configured: true, published_content: { ...complete, policies_confirmed: false } },
    { tax_configured: "true", published_content: complete }
  ]) assert.throws(() => payments.checkoutGate(p, "live"), /checkout_not_ready/);
  assert.doesNotThrow(() => payments.checkoutGate({ tax_configured: true, published_content: complete }, "live"));
});

test("legacy bookings get guest capability via manager_guest_access BEFORE approval", async () => {
  const legacy = booking({ status: "pending", idempotency_key: null, guest_access_hash: null, quote_snapshot: { legacy: true } });
  const state = setup({ bookingRow: legacy, attempt: null, rpcs: { manager_guest_access: () => ({ status: "provisioned" }),
    manager_action: () => ({ booking: legacy }) } });
  fakeStripe();
  await payments.bookingAction(BOOKING_ID, { action: "approve" }, ACTOR);
  const names = rpcNames(state);
  assert.ok(names.indexOf("manager_guest_access") >= 0 && names.indexOf("manager_guest_access") < names.indexOf("manager_action"));
  const args = state.log.find((e) => e.rpc === "manager_guest_access").args;
  const key = `legacy:${BOOKING_ID}`;
  assert.deepEqual(args, { p_booking_id: BOOKING_ID, p_actor: ACTOR.id, p_key: key,
    p_guest_hash: hashToken(deterministicGuestToken(key)), p_calendar_hash: hashToken(deterministicCalendarToken(key)) });

  // Non-legacy, or already provisioned, or non-approve actions: no provisioning.
  for (const [row, action] of [[booking({ status: "pending" }), "approve"], [legacy, "decline"]]) {
    const s = setup({ bookingRow: row, attempt: null, rpcs: { manager_action: () => ({ booking: row }) } });
    await payments.bookingAction(BOOKING_ID, { action }, ACTOR);
    assert.ok(!rpcNames(s).includes("manager_guest_access"));
  }
});

test("recovered terminal session with url null binds via manager_bind_recovered, then expired+unpaid releases", async () => {
  const expired = session({ status: "expired", url: null });
  const state = setup({ bookingRow: booking({ hold_expires_at: iso(NOW - 60_000) }) });
  fakeStripe({ list: [expired], retrieve: expired });
  const out = await payments.reconcileAttempt(attemptRow(), NOW);
  assert.equal(out.outcome, "released");
  const names = rpcNames(state);
  assert.ok(names.indexOf("manager_bind_recovered") < names.lastIndexOf("manager_payment"));
  const bind = state.log.find((e) => e.rpc === "manager_bind_recovered").args.p_data;
  assert.deepEqual(bind, { session_id: "cs_test_1", status: "expired", amount_cents: 50000, currency: "CAD", attempt_id: ATTEMPT_ID, booking_id: BOOKING_ID });
  assert.ok(!state.log.some((e) => e.rpc === "manager_payment" && e.args.p_action === "attached"), "no fabricated URL");
});

test("recovered complete+paid session binds and awaits the verified webhook (no money effect)", async () => {
  const paid = session({ status: "complete", payment_status: "paid", url: null });
  const state = setup({ bookingRow: booking({ hold_expires_at: iso(NOW - 60_000) }) });
  fakeStripe({ list: [paid], retrieve: paid });
  const out = await payments.reconcileAttempt(attemptRow(), NOW);
  assert.equal(out.outcome, "awaiting_webhook");
  assert.ok(rpcNames(state).includes("manager_bind_recovered"));
  assert.ok(!rpcNames(state).includes("manager_event"));
  assert.ok(!state.log.some((e) => e.rpc === "manager_payment" && e.args.p_action === "terminal_unpaid"));
});

test("idempotent create replay returning a finished session (url null) is re-retrieved and bound, not failed", async () => {
  const done = session({ status: "expired", url: null });
  const state = setup();
  fakeStripe({ retrieve: done, createStatus: "expired" });
  await assert.rejects(payments.guestCheckout(guestReq()), (e) => e.status === 503);
  assert.ok(rpcNames(state).includes("manager_bind_recovered"));
});

const event = (type, object = { id: "cs_test_1" }) => ({ id: "evt_1", type, livemode: false, data: { object } });
const effectOf = (state) => state.log.filter((e) => e.rpc === "manager_event").map((e) => e.args.p_effect);

test("webhook effects: only completed/async_succeeded/expired are checkout types; unknown checkout.* durably ignored", async () => {
  for (const type of ["checkout.session.async_payment_failed", "checkout.session.something_new"]) {
    const state = setup({ rpcs: { manager_event: () => ({ ok: true }) } });
    const stripe = fakeStripe();
    await payments.processVerifiedEvent(event(type));
    assert.deepEqual(effectOf(state), ["ignored"], type);
    assert.equal(stripe.calls.length, 0, "unknown types are not retrieved or applied");
  }
  // completed but unpaid (async method): ignored durably, not failed.
  let state = setup({ attempt: attemptRow({ status: "session_open", stripe_checkout_session_id: "cs_test_1" }), rpcs: { manager_event: () => ({}) } });
  fakeStripe({ retrieve: session({ status: "complete", payment_status: "unpaid" }) });
  await payments.processVerifiedEvent(event("checkout.session.completed"));
  assert.deepEqual(effectOf(state), ["ignored"]);
  // async success later: paid from the re-retrieved object.
  state = setup({ attempt: attemptRow({ status: "session_open", stripe_checkout_session_id: "cs_test_1" }), rpcs: { manager_event: () => ({}) } });
  fakeStripe({ retrieve: session({ status: "complete", payment_status: "paid", payment_intent: "pi_1" }) });
  await payments.processVerifiedEvent(event("checkout.session.async_payment_succeeded"));
  assert.deepEqual(effectOf(state), ["paid"]);
});

test("event failure is recorded once via manager_event('failed') and surfaces 503", async () => {
  const state = setup({ attempt: null, rpcs: { manager_event: () => ({}) } });
  fakeStripe();
  await assert.rejects(payments.processVerifiedEvent(event("checkout.session.completed")), (e) => e.status === 503);
  assert.deepEqual(effectOf(state), ["failed"]);
});
