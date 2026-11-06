// Router regression tests. All services are injected fakes; no network, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { HttpError } from "../server/http.js";
import { ROUTES, createHandler, parseRoute } from "../server/routes.js";
import routerModule, { config as routerConfig } from "../api/router.js";

const ACTOR = { id: "11111111-1111-4111-8111-111111111111" };
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";

function req({ route, method = "GET", headers = {}, body, query = {}, url } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const r = Readable.from(chunks);
  r.method = method;
  r.headers = { ...(body !== undefined && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers };
  r.url = url ?? `/api/${route}`;
  if (route !== undefined) r.query = { ...query, route };
  return r;
}

function res() {
  return {
    headers: {}, statusCode: 200, body: "", headersSent: false,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    end(chunk) { this.body = chunk === undefined ? "" : String(chunk); this.headersSent = true; },
    json() { return JSON.parse(this.body); }
  };
}

// Records every service call; any call is a "business call".
function fakes({ adminOk = false } = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push({ name, args }); return typeof value === "function" ? value(...args) : value; };
  const proxy = (prefix, values = {}) => new Proxy({}, {
    get: (_, key) => typeof key === "string" ? record(`${prefix}.${key}`, values[key] ?? { ok: `${prefix}.${key}` }) : undefined
  });
  const deps = {
    calls,
    public: proxy("public"),
    admin: proxy("admin"),
    payments: proxy("payments", {
      bookingAction: { booking: { id: BOOKING_ID, status: "payment_due" }, payment_pending: true,
        attempt: { idempotency_key: "booking:x:attempt:1" } },
      guestCheckout: { url: "https://checkout.stripe.com/c/pay/cs_1" },
      requestRefund: { refund: { id: "r1", booking_id: BOOKING_ID, amount_cents: 500, currency: "CAD", status: "pending",
        reason: "x", created_at: "t", idempotency_key: "secret-key-123", stripe_refund_id: "re_1", last_error: "boom" } },
      webhook: async (r) => { const chunks = []; for await (const c of r) chunks.push(c); calls.push({ name: "raw", args: [Buffer.concat(chunks)] }); return { received: true }; }
    }),
    jobs: {
      requireCron: (r) => { if (r.headers.authorization !== "Bearer cron") throw new HttpError(401, "Unauthorized", "unauthorized"); },
      runJobs: record("jobs.runJobs", { processed: 3, failed: 1, internal: "x" })
    },
    calendar: {
      ownerCalendar: record("calendar.owner", { body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", filename: "owner\"\r\nX: y.ics" }),
      guestCalendar: record("calendar.guest", { body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", filename: "stay.ics" })
    },
    requireAdmin: async (r) => {
      calls.push({ name: "requireAdmin" });
      if (adminOk && r.headers.authorization === "Bearer good") return ACTOR;
      throw new HttpError(401, "Sign in is required", "unauthorized");
    }
  };
  return deps;
}

async function call(deps, options) {
  const response = res();
  await createHandler(deps)(req(options), response);
  return response;
}

const concrete = (pattern) => pattern.replace(":id", BOOKING_ID);
const ADMIN_ENDPOINTS = ROUTES.filter((r) => r.pattern.startsWith("admin/"))
  .flatMap((r) => r.methods.map((method) => ({ route: concrete(r.pattern), method })));

test("api/router is a thin delegate with body parsing disabled", () => {
  assert.equal(typeof routerModule, "function");
  assert.deepEqual(routerConfig, { api: { bodyParser: false } });
});

test("every documented endpoint is routed", () => {
  const expected = {
    config: ["GET"], property: ["GET"], availability: ["GET"], quotes: ["POST"], bookings: ["POST"],
    "guest/booking": ["GET"], "guest/checkout": ["POST"], "stripe/webhook": ["POST"], "calendar/feed": ["GET"],
    "calendar/guest": ["GET"], "jobs/run": ["GET", "POST"], "admin/overview": ["GET"], "admin/bookings": ["GET"],
    "admin/bookings/:id": ["GET"], "admin/bookings/:id/actions": ["POST"], "admin/availability": ["GET"],
    "admin/blocks": ["POST"], "admin/blocks/:id": ["DELETE"], "admin/pricing": ["GET", "PUT"],
    "admin/content": ["GET", "PUT"], "admin/content/publish": ["POST"], "admin/photos/upload": ["POST"],
    "admin/payments": ["GET"], "admin/refunds": ["POST"], "admin/notifications": ["GET"],
    "admin/notifications/:id/retry": ["POST"], "admin/calendar": ["GET", "DELETE"], "admin/calendar/rotate": ["POST"],
    "admin/settings": ["GET", "PUT"], "admin/health": ["GET"], "admin/jobs/run": ["POST"],
    "admin/jobs/retry-events": ["POST"], "admin/activity": ["GET"]
  };
  assert.deepEqual(Object.fromEntries(ROUTES.map((r) => [r.pattern, r.methods])), expected);
});

for (const { route, method } of ADMIN_ENDPOINTS) {
  test(`${method} /api/${route} rejects unauthenticated callers before any business call`, async () => {
    const deps = fakes();
    const response = await call(deps, { route, method, body: method === "GET" || method === "DELETE" ? undefined : "{not json" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "unauthorized");
    assert.match(response.json().requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(deps.calls.map((c) => c.name), ["requireAdmin"]);
  });
}

test("admin auth runs before 404/405, with the real requireAdmin and no database configured", async () => {
  const keys = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const { requireAdmin, ...rest } = fakes();
    for (const [route, method] of [["admin/overview", "GET"], ["admin/nope", "GET"], ["admin/overview", "DELETE"]]) {
      const response = await call(rest, { route, method });
      assert.equal(response.statusCode, 401, `${method} ${route}`);
    }
    assert.equal(rest.calls.length, 0);
    // Cookies are never an admin credential.
    const response = await call(rest, { route: "admin/overview", headers: { cookie: "sb-access-token=abc" } });
    assert.equal(response.statusCode, 401);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("guest tokens and wrong schemes are not admin credentials", async () => {
  for (const authorization of ["Bearer guest_" + "a".repeat(43), "Basic abc", "bearer good"]) {
    const deps = fakes({ adminOk: true });
    const response = await call(deps, { route: "admin/bookings", headers: { authorization } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(deps.calls.map((c) => c.name), ["requireAdmin"]);
  }
});

test("authenticated admin calls map path ids, query, and body to the service", async () => {
  const deps = fakes({ adminOk: true });
  const headers = { authorization: "Bearer good" };
  let response = await call(deps, { route: "admin/bookings", headers, query: { search: "ada", page: "2" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(deps.calls.at(-1), { name: "admin.listBookings", args: [{ search: "ada", page: "2" }, ACTOR] });
  response = await call(deps, { route: `admin/blocks/${BOOKING_ID}`, method: "DELETE", headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(deps.calls.at(-1), { name: "admin.deleteBlock", args: [BOOKING_ID, ACTOR] });
  response = await call(deps, { route: "admin/blocks", method: "POST", headers, body: { start_date: "2026-12-10", end_date: "2026-12-12" } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(deps.calls.at(-1).args, [{ start_date: "2026-12-10", end_date: "2026-12-12" }, ACTOR]);
  response = await call(deps, { route: "admin/pricing", method: "PUT", headers, body: { version: 3 } });
  assert.deepEqual(deps.calls.at(-1), { name: "admin.savePricing", args: [{ version: 3 }, ACTOR] });
  response = await call(deps, { route: "admin/calendar/rotate", method: "POST", headers });
  assert.equal(deps.calls.at(-1).name, "admin.rotateCalendar");
  response = await call(deps, { route: `admin/notifications/${BOOKING_ID}/retry`, method: "POST", headers });
  assert.deepEqual(deps.calls.at(-1).args, [BOOKING_ID, ACTOR]);
});

test("booking actions go through payments.bookingAction and never leak the attempt", async () => {
  const deps = fakes({ adminOk: true });
  const response = await call(deps, { route: `admin/bookings/${BOOKING_ID}/actions`, method: "POST",
    headers: { authorization: "Bearer good" }, body: { action: "approve" } });
  assert.equal(response.statusCode, 200);
  assert.equal(deps.calls.at(-1).name, "payments.bookingAction");
  assert.deepEqual(deps.calls.at(-1).args.slice(0, 3), [BOOKING_ID, { action: "approve" }, ACTOR]);
  assert.deepEqual(response.json(), { data: { booking: { id: BOOKING_ID, status: "payment_due" }, payment_pending: true } });
  assert.doesNotMatch(response.body, /idempotency|attempt/);
});

test("refund responses are allowlisted (no idempotency key or provider internals)", async () => {
  const deps = fakes({ adminOk: true });
  const response = await call(deps, { route: "admin/refunds", method: "POST", headers: { authorization: "Bearer good" },
    body: { booking_id: BOOKING_ID, amount_cents: 500, reason: "x", idempotency_key: "secret-key-123" } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(Object.keys(response.json().data.refund).sort(), ["amount_cents", "booking_id", "created_at", "currency", "id", "reason", "status"]);
  assert.doesNotMatch(response.body, /secret-key|re_1|boom/);
});

test("owner jobs require admin; cron jobs require the cron secret and no origin", async () => {
  let deps = fakes({ adminOk: true });
  let response = await call(deps, { route: "admin/jobs/run", method: "POST", headers: { authorization: "Bearer good" } });
  assert.deepEqual(response.json(), { data: { processed: 3, failed: 1 } });
  for (const method of ["GET", "POST"]) {
    deps = fakes();
    response = await call(deps, { route: "jobs/run", method });
    assert.equal(response.statusCode, 401);
    assert.equal(deps.calls.length, 0);
    response = await call(deps, { route: "jobs/run", method, headers: { authorization: "Bearer cron", origin: "https://evil.example" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { processed: 3, failed: 1 } });
  }
});

test("browser mutations from a foreign origin are rejected before services run", async () => {
  const deps = fakes({ adminOk: true });
  for (const [route, extra] of [["quotes", {}], ["bookings", {}], ["guest/checkout", {}], ["admin/settings", { authorization: "Bearer good" }]]) {
    const method = route === "admin/settings" ? "PUT" : "POST";
    const response = await call(deps, { route, method, body: {}, headers: { origin: "https://evil.example", ...extra } });
    assert.equal(response.statusCode, 403, route);
    assert.equal(response.json().error.code, "forbidden");
  }
  assert.ok(deps.calls.every((c) => c.name === "requireAdmin"));
});

test("stripe webhook receives the exact raw bytes, ignores Origin, and is POST-only", async () => {
  const deps = fakes();
  const raw = Buffer.from('{"id":"evt_1",  "type":"x"}\né', "utf8");
  const response = await call(deps, { route: "stripe/webhook", method: "POST", body: raw,
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc", origin: "https://evil.example" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: { received: true } });
  assert.ok(deps.calls.find((c) => c.name === "raw").args[0].equals(raw));
  const get = await call(fakes(), { route: "stripe/webhook", method: "GET" });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, "POST");
});

test("guest checkout returns only the url; guest bodies cannot set prices or status", async () => {
  const deps = fakes();
  let response = await call(deps, { route: "guest/checkout", method: "POST", body: { amount_cents: 1, status: "paid" } });
  assert.deepEqual(response.json(), { data: { url: "https://checkout.stripe.com/c/pay/cs_1" } });
  assert.deepEqual(deps.calls.at(-1).args.length, 1); // request only; body never forwarded
  response = await call(deps, { route: "bookings", method: "POST", body: { quote_id: "q", total_cents: 1 } });
  assert.equal(response.statusCode, 201);
  // The body is forwarded unchanged to a service that rejects unknown keys (see services.test.js).
  assert.deepEqual(deps.calls.at(-1).args[0], { quote_id: "q", total_cents: 1 });
});

test("committed mutations trigger bounded best-effort delivery; failures never change the response", async () => {
  for (const fail of [false, true]) {
    const deps = fakes({ adminOk: true });
    const seen = [];
    deps.jobs.deliverNotifications = async (opts) => { seen.push(opts); if (fail) throw new Error("smtp down"); return { sent: 1 }; };
    const headers = { authorization: "Bearer good" };
    const cases = [
      [{ route: "bookings", method: "POST", body: { quote_id: "q" } }, 201],
      [{ route: `admin/bookings/${BOOKING_ID}/actions`, method: "POST", headers, body: { action: "approve" } }, 200],
      [{ route: "admin/refunds", method: "POST", headers, body: {} }, 201],
      [{ route: `admin/notifications/${BOOKING_ID}/retry`, method: "POST", headers }, 200],
      [{ route: "stripe/webhook", method: "POST", body: Buffer.from("{}"), headers: { "stripe-signature": "x" } }, 200]
    ];
    for (const [options, status] of cases) {
      const response = await call(deps, options);
      assert.equal(response.statusCode, status, options.route);
      assert.ok(response.json().data);
    }
    assert.equal(seen.length, cases.length);
    assert.ok(seen.every((o) => o.limit === 2 && o.deadlineMs <= 15_000));
  }
});

test("delivery is not attempted when the mutation fails or for read-only routes", async () => {
  const deps = fakes({ adminOk: true });
  let n = 0;
  deps.jobs.deliverNotifications = async () => { n += 1; };
  deps.public = new Proxy({}, { get: () => async () => { throw new HttpError(409, "Those dates are no longer available", "dates_unavailable"); } });
  const response = await call(deps, { route: "bookings", method: "POST", body: { quote_id: "q" } });
  assert.equal(response.statusCode, 409);
  await call(deps, { route: "admin/overview", headers: { authorization: "Bearer good" } });
  await call(deps, { route: "guest/checkout", method: "POST", body: {} });
  assert.equal(n, 0);
});

test("retry-events is an authenticated owner action returning only a count", async () => {
  const deps = fakes({ adminOk: true });
  deps.admin = new Proxy({}, { get: (_, k) => async (...args) => { deps.calls.push({ name: `admin.${String(k)}`, args }); return { requeued: 4, internal: "x" }; } });
  const response = await call(deps, { route: "admin/jobs/retry-events", method: "POST", headers: { authorization: "Bearer good" } });
  assert.deepEqual(response.json(), { data: { requeued: 4 } });
  assert.deepEqual(deps.calls.at(-1), { name: "admin.retryEvents", args: [ACTOR] });
  assert.ok(!deps.calls.some((c) => c.name === "jobs.runJobs"));
});

test("405 lists allowed methods; unknown and malformed routes 404 with an error envelope", async () => {
  let response = await call(fakes(), { route: "config", method: "POST" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET");
  response = await call(fakes({ adminOk: true }), { route: "admin/pricing", method: "DELETE", headers: { authorization: "Bearer good" } });
  assert.equal(response.headers.allow, "GET, PUT");
  for (const route of ["nope", "router", "admin", "", "config/", "/config", "a//b", "../config", "admin/./overview",
    "admin%2Foverview", "config\\x", "bookings/%2e%2e", "admin/bookings/a.b", "x".repeat(201)]) {
    const deps = fakes({ adminOk: true });
    response = await call(deps, { route, headers: { authorization: "Bearer good" } });
    assert.equal(response.statusCode, 404, JSON.stringify(route));
    const body = response.json();
    assert.equal(body.error.code, "not_found");
    assert.ok(body.requestId);
    assert.ok(!deps.calls.some((c) => c.name !== "requireAdmin"));
  }
  response = await call(fakes(), { route: undefined, url: "/api/router", query: undefined });
  assert.equal(response.statusCode, 404);
  const arrayRoute = req({ route: "config" });
  arrayRoute.query.route = ["config", "admin/overview"];
  const r2 = res();
  await createHandler(fakes())(arrayRoute, r2);
  assert.equal(r2.statusCode, 404);
});

test("parseRoute falls back to the original path only when no route query exists", () => {
  assert.deepEqual(parseRoute({ url: "/api/admin/overview?x=1" }), ["admin", "overview"]);
  assert.equal(parseRoute({ url: "/api/router?x=1" }), null);
  assert.deepEqual(parseRoute({ url: "/api/router?route=config" }), ["config"]);
  assert.equal(parseRoute({ url: "/api/admin%2Foverview" }), null);
});

test("service errors use the error envelope without internals; unknown errors are generic", async () => {
  const deps = fakes();
  deps.public = { publicProperty: () => { throw new Error("SELECT * FROM secret"); } };
  const saved = console.error;
  console.error = () => {};
  try {
    const response = await call(deps, { route: "property" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(Object.keys(response.json()).sort(), ["error", "requestId"]);
    assert.equal(response.json().error.code, "internal");
    assert.doesNotMatch(response.body, /SELECT|secret/);
  } finally { console.error = saved; }
  deps.public = { quote: () => { throw new HttpError(400, "Some details are invalid", "validation_failed", { fields: { check_in: "Use YYYY-MM-DD" } }); } };
  const response = await call(deps, { route: "quotes", method: "POST", body: {} });
  assert.deepEqual(response.json().error, { code: "validation_failed", message: "Some details are invalid", fields: { check_in: "Use YYYY-MM-DD" } });
});

test("JSON routes require a JSON object body", async () => {
  let response = await call(fakes(), { route: "quotes", method: "POST", body: "[1]" });
  assert.equal(response.statusCode, 400);
  const r = req({ route: "quotes", method: "POST", body: Buffer.from("{}") });
  r.headers["content-type"] = "text/plain";
  response = res();
  await createHandler(fakes())(r, response);
  assert.equal(response.statusCode, 415);
});

test("success responses use the data envelope and security headers", async () => {
  const response = await call(fakes(), { route: "config" });
  assert.deepEqual(response.json(), { data: { ok: "public.publicConfig" } });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("calendar feeds are text/calendar with a sanitized attachment filename", async () => {
  const deps = fakes();
  const response = await call(deps, { route: "calendar/feed", query: { token: "calendar_x" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/calendar; charset=utf-8");
  assert.match(response.headers["content-disposition"], /^attachment; filename="[A-Za-z0-9_-]+\.ics"$/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(deps.calls.at(-1).args, [{ token: "calendar_x" }]);
  const guest = await call(deps, { route: "calendar/guest", query: { token: "calendar_y" } });
  assert.equal(guest.headers["content-disposition"], 'attachment; filename="stay.ics"');
});

test("missing jobs/calendar modules fail closed with 503", async () => {
  const deps = fakes();
  deps.jobs = async () => { throw new HttpError(503, "This feature is not available right now", "service_unavailable"); };
  const response = await call(deps, { route: "jobs/run", method: "POST", headers: { authorization: "Bearer cron" } });
  assert.equal(response.statusCode, 503);
});
