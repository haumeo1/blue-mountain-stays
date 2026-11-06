// Outbox delivery and worker behaviour with injected fake Supabase + Resend clients. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { setDatabaseForTesting } from "../server/integrations/supabase.js";
import { setResendForTesting } from "../server/integrations/email.js";
import { setStripeForTesting } from "../server/integrations/stripe.js";
import { deliverNotifications, runJobs } from "../server/services/jobs.js";

const EMAIL_ENV = { APP_ENV: "staging", RESEND_API_KEY: "re_placeholder_not_real", RESEND_FROM: "Stays <stays@example.test>",
  EMAIL_TEST_RECIPIENT: "qa@example.test", GUEST_TOKEN_SECRET: "test-only-secret-not-used-anywhere-0123456789",
  STRIPE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_placeholder_not_real" };
Object.assign(process.env, EMAIL_ENV);
for (const k of ["PUBLIC_SITE_URL", "VERCEL", "VERCEL_ENV", "LIVE_CHECKOUT_ENABLED"]) delete process.env[k];

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING = { id: BOOKING_ID, status: "confirmed", payment_status: "paid", cancel_requested: false, guest_email: "guest@example.com",
  confirmation_code: "BMH-1", check_in: "2026-12-01", check_out: "2026-12-04", guest_count: 2, total_cents: 50000, currency: "CAD",
  idempotency_key: "key-0123456789abcdef" };
const job = (patch = {}) => ({ id: "55555555-5555-4555-8555-555555555555", topic: "booking_confirmed", recipient: "guest",
  booking_id: BOOKING_ID, attempts: 1, payload: {}, ...patch });

function setup({ jobs = [job()], booking = BOOKING, property = { slug: "blue-mountain-house", name: "Home", owner_email: "owner@example.com" }, kinds = {} } = {}) {
  const log = [];
  const from = (table) => {
    const b = new Proxy({}, { get(_, key) {
      if (key === "then") {
        const data = table === "bookings" ? booking : table === "properties" ? property : null;
        return (resolve) => resolve({ data, error: null });
      }
      return () => b;
    } });
    return b;
  };
  setDatabaseForTesting({
    from,
    rpc: async (name, args) => {
      log.push({ name, action: args.p_action, data: args.p_data, args });
      if (name === "manager_work" && args.p_action === "claim_outbox") return { data: { jobs }, error: null };
      if (name === "manager_work" && args.p_action?.startsWith("claim_")) return { data: { jobs: kinds[args.p_action] || [] }, error: null };
      if (name === "manager_event") return { data: {}, error: null };
      return { data: {}, error: null };
    }
  });
  return log;
}

function resend(result = { data: { id: "em_1" }, error: null }) {
  const calls = [];
  setResendForTesting({ emails: { send: async (p, o) => { calls.push({ p, o }); return typeof result === "function" ? result() : result; } } });
  return calls;
}

const actions = (log) => log.filter((e) => e.name === "manager_work").map((e) => e.action);
test.afterEach(() => { setDatabaseForTesting(null); setResendForTesting(null); setStripeForTesting(null); Object.assign(process.env, EMAIL_ENV); });

test("deliverNotifications drains only the outbox, limit 2, and acks a confirmed send", async () => {
  const log = setup();
  const sent = resend();
  const counts = await deliverNotifications();
  assert.deepEqual(counts, { sent: 1, suppressed: 0, failed: 0 });
  assert.deepEqual(actions(log), ["claim_outbox", "ack_outbox"]);
  assert.equal(log[0].data.limit, 2);
  assert.deepEqual(sent[0].p.to, ["qa@example.test"], "redirected outside production");
  assert.equal(sent[0].o.idempotencyKey, `outbox/${job().id}`);
});

test("send failures and unknown outcomes are retained (fail_outbox), never acked, and never touch the booking", async () => {
  for (const result of [{ data: null, error: { name: "application_error" } }, { data: {}, error: null }, () => { throw new Error("net"); }]) {
    const log = setup();
    resend(result);
    const counts = await deliverNotifications();
    assert.equal(counts.failed, 1);
    assert.deepEqual(actions(log), ["claim_outbox", "fail_outbox"]);
    assert.ok(log.every((e) => e.name === "manager_work"), "no booking/payment RPC");
  }
  const log = setup();
  resend({ data: {}, error: null });
  await deliverNotifications();
  assert.equal(log.find((e) => e.action === "fail_outbox").data.error, "send_outcome_unknown");
});

test("missing recipient is recorded as a failure, not sent", async () => {
  const log = setup({ jobs: [job({ recipient: "owner" })], property: { slug: "blue-mountain-house", owner_email: null } });
  const sent = resend();
  const counts = await deliverNotifications();
  assert.equal(counts.failed, 1);
  assert.equal(sent.length, 0);
  assert.equal(log.find((e) => e.action === "fail_outbox").data.error, "missing_recipient");
  assert.ok(!actions(log).includes("ack_outbox"));
});

test("stale confirmation mail is suppressed after cancellation/expiry/decline", async () => {
  for (const status of ["cancelled", "expired", "declined"]) {
    const log = setup({ booking: { ...BOOKING, status } });
    const sent = resend();
    const counts = await deliverNotifications();
    assert.deepEqual(counts, { sent: 0, suppressed: 1, failed: 0 }, status);
    assert.equal(sent.length, 0);
    assert.deepEqual(actions(log), ["claim_outbox", "ack_outbox"]);
  }
  const log = setup({ booking: { ...BOOKING, status: "completed" } });
  resend();
  assert.equal((await deliverNotifications()).sent, 1, "completed stays still get their confirmation");
  assert.ok(actions(log).includes("ack_outbox"));
});

test("without email configuration nothing is claimed (rows stay pending for the worker)", async () => {
  delete process.env.RESEND_API_KEY;
  const log = setup();
  assert.deepEqual(await deliverNotifications(), { sent: 0, suppressed: 0, failed: 0 });
  assert.equal(log.length, 0);
});

test("deliverNotifications never throws and is bounded by its deadline", async () => {
  setDatabaseForTesting({ from: () => { throw new Error("db"); }, rpc: async () => { throw new Error("db down"); } });
  const counts = await deliverNotifications();
  assert.equal(counts.failed, 1);
  setup();
  resend(() => new Promise(() => {})); // provider hangs
  const started = Date.now();
  const out = await deliverNotifications({ deadlineMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.equal(out.timed_out, true);
});

test("worker does not double-settle a failed event; manager_event('failed') owns the backoff", async () => {
  const ev = { id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_1" } } };
  const log = setup({ jobs: [], kinds: { claim_events: [{ id: "e1", attempts: 1, payload: ev }] } });
  setStripeForTesting({ checkout: { sessions: { retrieve: async () => { throw Object.assign(new Error("x"), { type: "StripeConnectionError" }); } } } });
  const counts = await runJobs({ limit: 1 });
  assert.equal(counts.failed, 1);
  assert.ok(!actions(log).includes("settle_event"));
  assert.deepEqual(log.filter((e) => e.name === "manager_event").map((e) => e.args.p_effect), ["failed"]);
  assert.ok(!log.some((e) => e.name === "manager_retry_events"), "cron never resets exhausted events");
});
