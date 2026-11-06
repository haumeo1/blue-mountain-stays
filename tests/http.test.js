import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import Stripe from "stripe";
import {
  HttpError, JSON_BODY_LIMIT, RAW_BODY_LIMIT, assertSameOrigin, getBaseUrl, getRequestId, handleError,
  methodNotAllowed, readJsonBody, readRawBody, sendData, setSecurityHeaders
} from "../server/http.js";
import { callRpc, dbResult, extractBearerToken, requireAdmin, setDatabaseForTesting } from "../server/integrations/supabase.js";

function req({ method = "POST", headers = { "content-type": "application/json" }, chunks = [], body } = {}) {
  const request = Readable.from(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)));
  request.method = method;
  request.headers = headers;
  if (body !== undefined) request.body = body;
  return request;
}

function res() {
  return {
    headers: {}, statusCode: 200, body: "", headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk) { this.body = chunk ?? ""; this.headersSent = true; },
    json() { return JSON.parse(this.body); }
  };
}

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (error) => error instanceof HttpError && error.status === status && error.code === code);
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) { saved[key] = process.env[key]; }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  let result;
  try { result = fn(); } catch (error) { restore(); throw error; }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

test("readRawBody returns exact bytes from streams, buffers, and strings", async () => {
  const bytes = Buffer.from('{"b":1,  "a":"é"}\n', "utf8");
  assert.ok((await readRawBody(req({ chunks: [bytes.subarray(0, 5), bytes.subarray(5)] }))).equals(bytes));
  assert.ok((await readRawBody(req({ body: bytes }))).equals(bytes));
  assert.ok((await readRawBody(req({ body: bytes.toString("utf8") }))).equals(bytes));
  await rejectsWith(readRawBody(req({ body: { a: 1 } })), 400, "bad_request");
  await rejectsWith(readRawBody(req({ chunks: [Buffer.alloc(RAW_BODY_LIMIT + 1)] })), 413, "payload_too_large");
  await rejectsWith(readRawBody(req({ headers: { "content-length": String(RAW_BODY_LIMIT + 1) } })), 413, "payload_too_large");
});

// Emulates @vercel/node helpers: readBody consumes the stream, restoreBody replays raw bytes via a
// PassThrough by overriding read/on/addListener for data/end, then a lazy JSON.parse body getter.
async function vercelLikeRequest(raw, headers = { "content-type": "application/json" }) {
  const request = Readable.from([raw]);
  request.method = "POST";
  request.headers = { ...headers, "content-length": String(raw.length) };
  const consumed = [];
  for await (const chunk of request) consumed.push(chunk);
  const bytes = Buffer.concat(consumed);
  const replay = new PassThrough();
  replay.end(bytes);
  const originalOn = request.on.bind(request);
  const on = (event, listener) => {
    if (event === "data" || event === "end") { replay.on(event, listener); return request; }
    return originalOn(event, listener);
  };
  request.on = on;
  request.addListener = on;
  request.read = (...args) => replay.read(...args);
  let getterCalls = 0;
  Object.defineProperty(request, "body", {
    configurable: true,
    get() { getterCalls += 1; return JSON.parse(bytes.toString("utf8")); }
  });
  return { request, getterCalls: () => getterCalls };
}

test("readRawBody on a Vercel-helper request returns replayed exact bytes without touching body getter", async () => {
  const payload = '{\n  "id": "evt_test_1",   "object":"event",\n\t"type": "checkout.session.completed", "n": "é"\n}\n';
  const raw = Buffer.from(payload, "utf8");
  const { request, getterCalls } = await vercelLikeRequest(raw);
  const read = await readRawBody(request);
  assert.ok(read.equals(raw));
  assert.equal(getterCalls(), 0);

  const secret = "whsec_synthetic_test_secret";
  const stripe = new Stripe("sk_test_synthetic");
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = stripe.webhooks.constructEvent(read, header, secret);
  assert.equal(event.id, "evt_test_1");
  // A reserialised parsed body must fail verification, proving bytes matter.
  assert.throws(() => stripe.webhooks.constructEvent(JSON.stringify(JSON.parse(payload)), header, secret));

  const big = await vercelLikeRequest(Buffer.alloc(RAW_BODY_LIMIT + 1, 0x20));
  await rejectsWith(readRawBody(big.request), 413, "payload_too_large");
  assert.equal(big.getterCalls(), 0);
});

test("readRawBody rejects parsed-only or empty bodies", async () => {
  await rejectsWith(readRawBody(req({ body: { a: 1 } })), 400, "bad_request");
  await rejectsWith(readRawBody(req()), 400, "bad_request");
  await rejectsWith(readRawBody(req({ body: "" })), 400, "bad_request");
  const consumed = req({ chunks: ["{}"] });
  for await (const _ of consumed) { /* drain */ }
  await rejectsWith(readRawBody(consumed), 400, "bad_request");
  // Getter-only object body with no bytes: getter is ignored and no bytes → reject.
  const getterOnly = req();
  let calls = 0;
  Object.defineProperty(getterOnly, "body", { get() { calls += 1; return { a: 1 }; } });
  await rejectsWith(readRawBody(getterOnly), 400, "bad_request");
  assert.equal(calls, 0);
});

test("readJsonBody rejects JSON null including pre-parsed null", async () => {
  await rejectsWith(readJsonBody(req({ body: null })), 400, "bad_request");
  await rejectsWith(readJsonBody(req({ body: "null" })), 400, "bad_request");
  const { request } = await vercelLikeRequest(Buffer.from('{"a":5}'));
  assert.deepEqual(await readJsonBody(request), { a: 5 });
});

test("readJsonBody accepts plain objects only and enforces 64KB", async () => {
  assert.deepEqual(await readJsonBody(req({ chunks: ['{"a":', "1}"] })), { a: 1 });
  assert.deepEqual(await readJsonBody(req({ body: '{"a":2}' })), { a: 2 });
  assert.deepEqual(await readJsonBody(req({ body: Buffer.from('{"a":3}') })), { a: 3 });
  assert.deepEqual(await readJsonBody(req({ body: { a: 4 } })), { a: 4 });
  assert.deepEqual(await readJsonBody(req()), {});
  for (const bad of ["[]", "null", "1", '"x"', "{bad", '{"__proto__":{"admin":true}}', '{"a":{"__proto__":{}}}']) {
    await rejectsWith(readJsonBody(req({ chunks: [bad] })), 400, "bad_request");
  }
  await rejectsWith(readJsonBody(req({ body: [] })), 400, "bad_request");
  await rejectsWith(readJsonBody(req({ body: new Date() })), 400, "bad_request");
  const big = `{"a":"${"x".repeat(JSON_BODY_LIMIT)}"}`;
  await rejectsWith(readJsonBody(req({ chunks: [big] })), 413, "payload_too_large");
  await rejectsWith(readJsonBody(req({ body: big })), 413, "payload_too_large");
  await rejectsWith(readJsonBody(req({ body: { a: "x".repeat(JSON_BODY_LIMIT) } })), 413, "payload_too_large");
  assert.equal({}.admin, undefined);
});

test("mutations require application/json", async () => {
  await rejectsWith(readJsonBody(req({ headers: { "content-type": "text/plain" }, chunks: ["{}"] })), 415, "unsupported_media_type");
  await rejectsWith(readJsonBody(req({ headers: {}, chunks: ["{}"] })), 415, "unsupported_media_type");
  assert.deepEqual(await readJsonBody(req({ headers: { "content-type": "Application/JSON; charset=utf-8" }, chunks: ["{}"] })), {});
});

test("responses use the contract envelope and security headers", () => {
  const ok = res();
  sendData(ok, 201, { id: 1 });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json(), { data: { id: 1 } });
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["x-content-type-options"], "nosniff");
  assert.equal(ok.headers["referrer-policy"], "no-referrer");
  assert.equal(ok.headers["x-frame-options"], "DENY");

  const notAllowed = res();
  methodNotAllowed(notAllowed, ["get", "POST"]);
  assert.equal(notAllowed.statusCode, 405);
  assert.equal(notAllowed.headers.allow, "GET, POST");
  assert.equal(notAllowed.json().error.code, "method_not_allowed");

  const headers = res();
  setSecurityHeaders(headers);
  assert.equal(headers.headers["x-frame-options"], "DENY");
});

test("errors are sanitized and carry a UUID requestId", () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const failed = res();
    handleError(failed, new Error("relation bookings: ada@example.com Bearer sekrit"), { headers: { "x-request-id": "not a uuid" } });
    const body = failed.json();
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(body.error, { code: "internal", message: "Something went wrong" });
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(logged.every((line) => !line.includes("ada@example.com") && !line.includes("sekrit")));

    const known = res();
    handleError(known, new HttpError(409, "Taken", "DATES_UNAVAILABLE"));
    assert.equal(known.json().error.code, "dates_unavailable");
  } finally {
    console.error = original;
  }
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(getRequestId({ headers: { "x-request-id": id } }), id);
});

test("getBaseUrl validates PUBLIC_SITE_URL and ignores forwarded headers", () => {
  withEnv({ PUBLIC_SITE_URL: "https://stay.example.com/", VERCEL: "1", NODE_ENV: undefined, PORT: undefined }, () => {
    assert.equal(getBaseUrl({ headers: { "x-forwarded-host": "evil.com" } }), "https://stay.example.com");
  });
  for (const bad of ["http://stay.example.com", "https://u:p@stay.example.com", "https://stay.example.com/path", "https://stay.example.com?x=1", "https://stay.example.com#f", "nope", undefined]) {
    withEnv({ PUBLIC_SITE_URL: bad, VERCEL: undefined, NODE_ENV: "production" }, () => {
      assert.throws(() => getBaseUrl(), (error) => error.status === 500);
    });
  }
  withEnv({ PUBLIC_SITE_URL: undefined, VERCEL: undefined, NODE_ENV: undefined, PORT: "4321" }, () => {
    assert.equal(getBaseUrl({ headers: { host: "evil.com", "x-forwarded-proto": "https" } }), "http://127.0.0.1:4321");
  });
  withEnv({ PUBLIC_SITE_URL: undefined, VERCEL: undefined, NODE_ENV: undefined, PORT: "80; evil" }, () => {
    assert.throws(() => getBaseUrl());
  });
});

test("mutation Origin must equal the canonical origin", () => {
  withEnv({ PUBLIC_SITE_URL: "https://stay.example.com", VERCEL: "1" }, () => {
    assert.doesNotThrow(() => assertSameOrigin({ method: "POST", headers: { origin: "https://stay.example.com" } }));
    assert.doesNotThrow(() => assertSameOrigin({ method: "POST", headers: {} }));
    assert.doesNotThrow(() => assertSameOrigin({ method: "GET", headers: { origin: "https://evil.com" } }));
    for (const origin of ["https://evil.com", "https://stay.example.com.evil.com", "http://stay.example.com", "null"]) {
      assert.throws(() => assertSameOrigin({ method: "PUT", headers: { origin } }), (error) => error.status === 403 && error.code === "forbidden");
    }
  });
});

test("bearer extraction is strict", () => {
  assert.equal(extractBearerToken({ headers: { authorization: "Bearer abc.def-ghi" } }), "abc.def-ghi");
  for (const value of [undefined, "", "Bearer", "Bearer ", "bearer abc", "Basic abc", "Bearer a b", "Bearer  abc"]) {
    assert.equal(extractBearerToken({ headers: { authorization: value } }), null);
  }
});

function fakeDatabase({ user, userError, userThrows, member = true, memberError, rpc } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      async getUser(token) {
        calls.push(["getUser", token]);
        if (userThrows) throw new Error("network down");
        return { data: { user: user ?? null }, error: userError ?? null };
      }
    },
    from(table) {
      calls.push(["from", table]);
      const chain = {
        select: () => chain, eq: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: member ? { user_id: user?.id } : null, error: memberError ?? null })
      };
      return chain;
    },
    async rpc(name, args) { calls.push(["rpc", name]); return rpc(name, args); }
  };
}

test("requireAdmin: 401 before database, 403 for non-members, 503 for outages", async (t) => {
  t.after(() => setDatabaseForTesting(null));
  await withEnv({ SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    setDatabaseForTesting(null);
    await rejectsWith(requireAdmin({ headers: {} }), 401, "unauthorized");
    await rejectsWith(requireAdmin({ headers: { authorization: "Token x" } }), 401, "unauthorized");
    await rejectsWith(requireAdmin({ headers: { authorization: "Bearer abc" } }), 503, "service_unavailable");
  });
  const auth = { headers: { authorization: "Bearer abc" } };
  setDatabaseForTesting(fakeDatabase({ userError: { status: 401, name: "AuthApiError", message: "bad jwt" } }));
  await rejectsWith(requireAdmin(auth), 401, "unauthorized");
  setDatabaseForTesting(fakeDatabase({ userError: { status: 503, name: "AuthRetryableFetchError" } }));
  await rejectsWith(requireAdmin(auth), 503, "service_unavailable");
  setDatabaseForTesting(fakeDatabase({ userThrows: true }));
  await rejectsWith(requireAdmin(auth), 503, "service_unavailable");
  setDatabaseForTesting(fakeDatabase({ user: { id: "u1" }, member: false }));
  await rejectsWith(requireAdmin(auth), 403, "forbidden");
  setDatabaseForTesting(fakeDatabase({ user: { id: "u1" }, memberError: { code: "PGRST000" } }));
  await rejectsWith(requireAdmin(auth), 503, "service_unavailable");
  const ok = fakeDatabase({ user: { id: "u1" } });
  setDatabaseForTesting(ok);
  assert.equal((await requireAdmin(auth)).id, "u1");
  assert.deepEqual(ok.calls[0], ["getUser", "abc"]);
});

test("database errors map to safe codes; unknown errors are sanitized 502", async (t) => {
  t.after(() => setDatabaseForTesting(null));
  assert.deepEqual(dbResult({ data: [1], error: null }), [1]);
  assert.throws(() => dbResult({ error: { code: "23P01", message: "dates_unavailable" } }), (e) => e.status === 409 && e.code === "dates_unavailable");
  assert.throws(() => dbResult({ error: { code: "P0001", message: "Booking not found" } }), (e) => e.status === 404 && e.code === "not_found");
  assert.throws(() => dbResult({ error: { code: "22023", message: "invalid_dates" } }), (e) => e.status === 400 && e.code === "validation_failed");
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    assert.throws(() => dbResult({ error: { code: "42P01", message: 'relation "secret_table" ada@example.com', details: "x" } }), (e) => {
      return e.status === 502 && e.code === "internal" && !e.message.includes("secret_table");
    });
    assert.ok(logged.every((line) => !line.includes("secret_table") && !line.includes("ada@")));
  } finally {
    console.error = original;
  }
  setDatabaseForTesting(fakeDatabase({ rpc: async () => ({ data: { id: 7 }, error: null }) }));
  assert.deepEqual(await callRpc("create_quote", {}), { id: 7 });
  setDatabaseForTesting(fakeDatabase({ rpc: async () => ({ data: null, error: { code: "55000", message: "quote_expired" } }) }));
  await rejectsWith(callRpc("create_booking", {}), 409, "quote_expired");
});
