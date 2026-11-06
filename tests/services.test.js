// Behavioural tests for server/services/{public,data,admin}.js using a fake Supabase SDK.
// No network: every query resolves from in-memory fixtures and is recorded for assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../server/http.js";
import * as pub from "../server/services/public.js";
import * as admin from "../server/services/admin.js";
import { contentOut, mapBooking, safeGuestBooking, searchPattern } from "../server/services/data.js";
import { deterministicGuestToken, hashToken } from "../server/integrations/tokens.js";

process.env.GUEST_TOKEN_SECRET = "test-only-secret-not-used-anywhere-0123456789";
process.env.SUPABASE_URL = "https://proj.supabase.co";
delete process.env.PUBLIC_SITE_URL;
delete process.env.VERCEL;

const ACTOR = { id: "11111111-1111-4111-8111-111111111111" };
const PROPERTY = {
  id: "7b894869-13bb-4a2d-9b2a-84a963fe8c2c", name: "The Blue Mountain House", slug: "blue-mountain-house",
  timezone: "America/Toronto", currency: "CAD", max_guests: 8, active: true, booking_enabled: true, version: 4,
  owner_email: "owner-private@example.com", nightly_rate_cents: 42500, cleaning_fee_cents: 14500, service_rate: 0.08,
  tax_bps: 1300, tax_configured: true, min_nights: 2, max_nights: 28,
  draft_content: { title: "DRAFT ONLY TITLE", photos: [] },
  published_content: {
    title: "Published", policies_complete: true,
    photos: [
      { path: "property/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg", url: "https://proj.supabase.co/storage/v1/object/public/property-photos/property/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg", alt: "Deck" },
      { path: "x", url: "http://insecure.example/a.jpg", alt: "bad" },
      { path: "y", url: "javascript:alert(1)", alt: "bad" }
    ]
  }
};

// Minimal chainable PostgREST-like builder. `tables[name]` is a result or (calls) => result.
function fakeDb({ tables = {}, rpcs = {} } = {}) {
  const log = [];
  const builder = (table) => {
    const calls = [];
    const b = new Proxy({}, {
      get(_, key) {
        if (key === "then") {
          const fixture = tables[table];
          const result = typeof fixture === "function" ? fixture(calls) : fixture ?? { data: null };
          return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        }
        return (...args) => { calls.push([key, ...args]); return b; };
      }
    });
    log.push({ table, calls });
    return b;
  };
  return {
    log,
    from: builder,
    rpc(name, args) {
      log.push({ rpc: name, args });
      const fixture = rpcs[name];
      if (fixture === undefined) return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
      return Promise.resolve(typeof fixture === "function" ? fixture(args) : { data: fixture, error: null });
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: (path) => { log.push({ upload: path }); return Promise.resolve({ data: { signedUrl: `https://proj.supabase.co/storage/v1/object/upload/sign/property-photos/${path}?token=t` }, error: null }); },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/property-photos/${path}` } })
      })
    }
  };
}

const rpcCalls = (db, name) => db.log.filter((e) => e.rpc === name);
async function rejectsField(promise, field) {
  await assert.rejects(promise, (e) => e instanceof HttpError && e.status === 400 && e.code === "validation_failed"
    && (field === undefined || Object.hasOwn(e.details?.fields || {}, field)));
}

const BOOKING_ROW = {
  id: "22222222-2222-4222-8222-222222222222", confirmation_code: "BMH-ABCD1234", status: "confirmed", payment_status: "paid",
  guest_name: "Ada Lovelace", guest_email: "ada@example.com", guest_phone: "+1 555", guest_notes: "secret note",
  guest_count: 2, check_in: "2026-12-01", check_out: "2026-12-04", nights: 3, nightly_rate_cents: 42500,
  quote_snapshot: { lodging_cents: 127500 }, cleaning_fee_cents: 14500, service_fee_cents: 10200, tax_cents: 19800,
  total_cents: 172000, currency: "CAD", guest_access_hash: "h".repeat(64), calendar_token_hash: "c".repeat(64),
  idempotency_key: "key-0123456789abcdef", idempotency_hash: "i".repeat(64), hold_expires_at: null, cancel_requested: false,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z"
};
const PII = /ada@example\.com|\+1 555|secret note|key-0123456789abcdef|hhhhhhhh|cccccccc|iiiiiiii/;

// ---------------------------------------------------------------------------------- public

test("public property exposes published content only, never draft or owner email", async () => {
  const db = fakeDb({ tables: { properties: { data: PROPERTY } } });
  const out = await pub.publicProperty(db);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /DRAFT ONLY|owner-private|nightly_rate|tax_bps|version/);
  assert.equal(out.content.title, "Published");
  assert.deepEqual(out.content.photos.map((p) => p.alt), ["Deck"]); // http: and javascript: dropped
  assert.deepEqual(Object.keys(out.property).sort(), ["booking_enabled", "currency", "max_guests", "name", "timezone"]);
});

test("public property returns null content when nothing is published, and 404 when inactive", async () => {
  let out = await pub.publicProperty(fakeDb({ tables: { properties: { data: { ...PROPERTY, published_content: {} } } } }));
  assert.equal(out.content, null);
  await assert.rejects(pub.publicProperty(fakeDb({ tables: { properties: { data: { ...PROPERTY, active: false } } } })),
    (e) => e.status === 404);
  out = await pub.publicConfig(fakeDb({ tables: { properties: { data: { ...PROPERTY, booking_enabled: false } } } }));
  assert.equal(out.bookingEnabled, false);
  assert.deepEqual(Object.keys(out).sort(), ["bookingEnabled", "demoMode", "supabasePublishableKey", "supabaseUrl"]);
});

test("public availability merges claims and leaks no ids or labels", async () => {
  const db = fakeDb({ tables: {
    properties: { data: PROPERTY },
    inventory_claims: { data: [
      { id: "c1", kind: "booking", stay: "[2026-12-01,2026-12-04)", booking_id: "b1", block_id: null },
      { id: "c2", kind: "block", stay: "[2026-12-04,2026-12-06)", booking_id: null, block_id: "k1" },
      { id: "c3", kind: "booking", stay: "[2026-12-10,2026-12-11)", booking_id: "b2", block_id: null }
    ] }
  } });
  const out = await pub.availability({ from: "2026-12-01", to: "2027-01-01" }, db);
  assert.deepEqual(out, { ranges: [
    { start: "2026-12-01", end: "2026-12-06", type: "unavailable" },
    { start: "2026-12-10", end: "2026-12-11", type: "unavailable" }
  ] });
  await rejectsField(pub.availability({ from: "2026-01-01", to: "2027-06-01" }, db), "to");
});

test("quotes ignore client totals: unknown money/status keys are rejected and only dates/guests reach the DB", async () => {
  const db = fakeDb({ rpcs: { manager_rate_limit: true, manager_quote: { id: "q1", total_cents: 1 } } });
  for (const extra of [{ total_cents: 1 }, { stay_cents: 0 }, { nightly_rate_cents: 1 }, { status: "confirmed" }]) {
    await rejectsField(pub.quote({ check_in: "2026-12-01", check_out: "2026-12-04", guest_count: 2, ...extra }, {}, db));
  }
  assert.equal(rpcCalls(db, "manager_quote").length, 0);
  await pub.quote({ check_in: "2026-12-01", check_out: "2026-12-04", guest_count: 2 }, {}, db);
  assert.deepEqual(rpcCalls(db, "manager_quote")[0].args, { p_check_in: "2026-12-01", p_check_out: "2026-12-04", p_guest_count: 2 });
  await rejectsField(pub.quote({ check_in: "2026-12-01", check_out: "2026-12-04", guest_count: "2" }, {}, db), "guest_count");
  await rejectsField(pub.quote({ check_in: "2026-02-30", check_out: "2026-03-04", guest_count: 2 }, {}, db), "check_in");
});

test("rate limiting rejects with 429 and never stores the raw address", async () => {
  const db = fakeDb({ rpcs: { manager_rate_limit: false } });
  await assert.rejects(pub.quote({ check_in: "2026-12-01", check_out: "2026-12-04", guest_count: 2 },
    { socket: { remoteAddress: "203.0.113.7" }, headers: { "x-forwarded-for": "1.2.3.4" } }, db), (e) => e.status === 429 && e.code === "rate_limited");
  const key = rpcCalls(db, "manager_rate_limit")[0].args.p_key;
  assert.match(key, /^quote:[0-9a-f]{64}$/);
  assert.doesNotMatch(key, /203\.0\.113\.7|1\.2\.3\.4/);
});

const BOOKING_BODY = { quote_id: "33333333-3333-4333-8333-333333333333", guest_name: " Ada   Lovelace ", guest_email: "Ada@Example.com",
  guest_phone: "", guest_notes: "", idempotency_key: "idem-0123456789abcdef" };

test("booking requests derive a stable request hash and tokens; only hashes reach the DB", async () => {
  const run = async (body) => {
    const db = fakeDb({ rpcs: { manager_rate_limit: true, manager_request: { ...BOOKING_ROW, status: "pending" } } });
    const out = await pub.requestBooking(body, {}, db);
    return { out, args: rpcCalls(db, "manager_request")[0].args };
  };
  const a = await run(BOOKING_BODY);
  const b = await run({ ...BOOKING_BODY, guest_email: "ada@example.com", guest_name: "Ada Lovelace" });
  const c = await run({ ...BOOKING_BODY, guest_notes: "late arrival" });
  assert.equal(a.args.p_hash, b.args.p_hash, "normalisation yields the same request hash on retry");
  assert.notEqual(a.args.p_hash, c.args.p_hash, "a different body yields a different hash (DB raises idempotency_conflict)");
  assert.equal(a.out.guest_token, deterministicGuestToken(BOOKING_BODY.idempotency_key));
  assert.equal(a.args.p_guest_hash, hashToken(a.out.guest_token));
  assert.doesNotMatch(JSON.stringify(a.args), new RegExp(a.out.guest_token));
  assert.equal(a.args.p_guest.email, "ada@example.com");
  assert.doesNotMatch(JSON.stringify(a.out.booking), PII);
});

test("booking requests reject client prices/status and bad keys before touching the DB", async () => {
  const db = fakeDb({ rpcs: { manager_rate_limit: true, manager_request: BOOKING_ROW } });
  for (const extra of [{ total_cents: 1 }, { status: "confirmed" }, { payment_status: "paid" }]) {
    await rejectsField(pub.requestBooking({ ...BOOKING_BODY, ...extra }, {}, db));
  }
  await rejectsField(pub.requestBooking({ ...BOOKING_BODY, idempotency_key: "short" }, {}, db), "idempotency_key");
  await rejectsField(pub.requestBooking({ ...BOOKING_BODY, guest_email: "nope" }, {}, db), "guest_email");
  await rejectsField(pub.requestBooking({ ...BOOKING_BODY, guest_notes: "x".repeat(1001) }, {}, db), "guest_notes");
  assert.equal(db.log.length, 0);
});

test("guest booking view has no PII/hashes and a fiscally safe payment status", async () => {
  const token = deterministicGuestToken(BOOKING_ROW.idempotency_key);
  const request = { headers: { authorization: `Bearer ${token}` } };
  const db = fakeDb({ tables: {
    bookings: (calls) => {
      assert.deepEqual(calls.find((c) => c[0] === "eq"), ["eq", "guest_access_hash", hashToken(token)]);
      return { data: BOOKING_ROW };
    },
    payment_attempts: { data: { receipt_url: "https://evil.example/receipt" } }
  } });
  const out = await pub.guestBooking(request, db);
  assert.doesNotMatch(JSON.stringify(out.booking), PII);
  assert.equal(out.booking.id, undefined);
  assert.equal(out.payment.status, "paid");
  assert.equal(out.payment.receipt_url, null, "non-Stripe receipt hosts are dropped");
  assert.match(out.calendar_url, /\/api\/calendar\/guest\?token=calendar_/);

  assert.equal(pub.guestPaymentStatus({ status: "pending", payment_status: "unpaid" }), "not_due");
  assert.equal(pub.guestPaymentStatus({ status: "payment_due", payment_status: "unpaid" }), "payment_due");
  assert.equal(pub.guestPaymentStatus({ status: "confirmed", payment_status: "not_required" }), "not_due");
  assert.equal(pub.guestPaymentStatus({ status: "confirmed", payment_status: "partially_refunded" }), "partially_refunded");
  assert.equal(pub.guestPaymentStatus({ status: "confirmed", payment_status: "bogus" }), "not_due");
});

test("guest auth rejects calendar tokens, admin-style tokens, and unknown tokens without a lookup leak", async () => {
  const db = fakeDb({ tables: { bookings: { data: null } } });
  for (const authorization of [undefined, "Bearer calendar_" + "a".repeat(43), "Bearer eyJhbGciOi.x.y", `Bearer guest_${"a".repeat(43)}`]) {
    await assert.rejects(pub.guestBooking({ headers: { authorization } }, db), (e) => e.status === 401 && e.code === "unauthorized");
  }
  assert.equal(db.log.length, 1, "only the well-formed guest token reached the DB");
});

// ---------------------------------------------------------------------------------- data

test("data mappers are allowlists", () => {
  const guest = safeGuestBooking(BOOKING_ROW);
  assert.doesNotMatch(JSON.stringify(guest), PII);
  assert.equal(guest.stay_cents, 127500, "stay comes from the immutable quote snapshot");
  const adminRow = mapBooking(BOOKING_ROW);
  assert.doesNotMatch(JSON.stringify(adminRow), /hhhhhhhh|cccccccc|iiiiiiii|key-0123/);
  assert.equal(adminRow.guest_email, "ada@example.com");
});

test("search patterns cannot break out of the PostgREST filter", () => {
  for (const raw of ['a),id.eq.1', 'x"*,(y)', "%_\\", "a,b"]) {
    const p = searchPattern(raw);
    if (p === null) continue;
    // Only the deliberate LIKE escape "\\_" may contain backslashes.
    assert.doesNotMatch(p.slice(2, -2).replace(/\\\\_/g, ""), /[,()"%*\\]/);
  }
  assert.equal(searchPattern("a_b"), '"*a\\\\_b*"');
});

test("content read normalizer bounds lists and strings", () => {
  const out = contentOut({ title: "t".repeat(500), amenities: Array.from({ length: 80 }, () => ({ title: "x" })), extra: "<script>" });
  assert.equal(out.title.length, 120);
  assert.equal(out.amenities.length, 50);
  assert.equal(out.extra, undefined);
});

test("policies_complete is derived (explicit confirmation + non-blank policies), never trusted from storage", () => {
  const full = { policies_confirmed: true, policies: { cancellation: "c", house_rules: "h" } };
  assert.equal(contentOut(full).policies_complete, true);
  assert.equal(contentOut({ ...full, policies_confirmed: undefined, policies_complete: true }).policies_complete, false);
  assert.equal(contentOut({ ...full, policies: { cancellation: "  ", house_rules: "h" } }).policies_complete, false);
  assert.equal(contentOut({ policies_complete: true }).policies_complete, false);
});

test("guest booking view includes hold expiry", () => {
  const hold = "2026-11-07T00:00:00.000Z";
  assert.equal(safeGuestBooking({ ...BOOKING_ROW, hold_expires_at: hold }).hold_expires_at, hold);
  assert.equal(safeGuestBooking(BOOKING_ROW).hold_expires_at, null);
});

// ---------------------------------------------------------------------------------- admin

const PRICING = { nightly_rate_cents: 42500, cleaning_fee_cents: 14500, service_bps: 800, tax_bps: 1300, tax_configured: true,
  min_nights: 2, max_nights: 28, max_guests: 8, overrides: [{ start_date: "2026-12-20", end_date: "2027-01-02", nightly_rate_cents: 59500 }], version: 3 };

test("pricing validation enforces bounds, explicit tax confirmation, and version", async () => {
  const db = fakeDb({ rpcs: { manager_configure: (args) => ({ data: { ...args.p_data, version: 4 }, error: null }) } });
  const out = await admin.savePricing(PRICING, ACTOR, db);
  assert.equal(out.version, 4);
  assert.deepEqual(rpcCalls(db, "manager_configure")[0].args.p_actor, ACTOR.id);
  const bad = [
    [{ service_bps: 10001 }, "service_bps"], [{ tax_bps: -1 }, "tax_bps"], [{ nightly_rate_cents: 0 }, "nightly_rate_cents"],
    [{ nightly_rate_cents: "42500" }, "nightly_rate_cents"], [{ tax_configured: undefined }, "tax_configured"],
    [{ min_nights: 10, max_nights: 5 }, "max_nights"], [{ version: undefined }, "version"],
    [{ overrides: [{ start_date: "2026-12-20", end_date: "2026-12-20", nightly_rate_cents: 1 }] }, "overrides.0.end_date"],
    [{ overrides: Array.from({ length: 201 }, () => ({})) }, "overrides"], [{ tax_cents: 1 }, "tax_cents"]
  ];
  for (const [patch, field] of bad) await rejectsField(admin.savePricing({ ...PRICING, ...patch }, ACTOR, db), field);
  assert.equal(rpcCalls(db, "manager_configure").length, 1);
});

const PHOTO_PATH = "property/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
const PHOTO_URL = `https://proj.supabase.co/storage/v1/object/public/property-photos/${PHOTO_PATH}`;
const CONTENT = { title: "Home", description: "", hero_title: "", amenities: [{ title: "Hot tub", description: "" }],
  photos: [{ path: PHOTO_PATH, url: PHOTO_URL, alt: "Deck" }], faq: [], policies: { cancellation: "c", house_rules: "h" },
  contact: { email: "host@example.com", phone: "" }, policies_confirmed: true };

test("content validation: photo path/URL provenance, text bounds, explicit policy confirmation", async () => {
  const db = fakeDb({ tables: { properties: { data: PROPERTY } },
    rpcs: { manager_configure: (args) => ({ data: { draft: args.p_data.content, published: PROPERTY.published_content, version: 5 }, error: null }) } });
  const out = await admin.saveContent({ content: CONTENT, version: 4 }, ACTOR, db);
  assert.equal(out.version, 5);
  assert.equal(out.draft.photos[0].url, PHOTO_URL);
  const photo = (p) => ({ ...CONTENT, photos: [{ ...CONTENT.photos[0], ...p }] });
  const bad = [
    [photo({ url: "https://evil.example/storage/v1/object/public/property-photos/property/x.jpg" }), "photos.0.url"],
    [photo({ url: "http://proj.supabase.co/storage/v1/object/public/property-photos/" + PHOTO_PATH }), "photos.0.url"],
    [photo({ url: PHOTO_URL + "?x=1" }), "photos.0.url"],
    [photo({ url: "https://proj.supabase.co/storage/v1/object/public/other-bucket/" + PHOTO_PATH }), "photos.0.url"],
    [photo({ path: "property/../secret.jpg" }), "photos.0.path"],
    [photo({ path: "elsewhere/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg" }), "photos.0.path"],
    // Same bucket prefix but a URL that is not the one derived from the stated path.
    [photo({ url: "https://proj.supabase.co/storage/v1/object/public/property-photos/property/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg" }), "photos.0.url"],
    [photo({ url: "https://proj.supabase.co/storage/v1/object/public/property-photos/property/unrelated/x.jpg" }), "photos.0.url"],
    [photo({ path: null }), "photos.0.path"],
    [{ ...CONTENT, title: "t".repeat(121) }, "title"],
    [{ ...CONTENT, hero_title: "t".repeat(161) }, "hero_title"],
    [{ ...CONTENT, amenities: [{ title: "a".repeat(81) }] }, "amenities.0.title"],
    [{ ...CONTENT, policies: { cancellation: "c".repeat(4001), house_rules: "h" } }, "policies.cancellation"],
    [{ ...CONTENT, amenities: Array.from({ length: 51 }, () => ({ title: "x" })) }, "amenities"],
    [{ ...CONTENT, contact: { email: "nope" } }, "contact.email"],
    [{ ...CONTENT, policies_confirmed: undefined }, "policies_confirmed"],
    [{ ...CONTENT, script: "<b>" }, "script"]
  ];
  for (const [content, field] of bad) await rejectsField(admin.saveContent({ content, version: 4 }, ACTOR, db), field);
  // A URL already present in published content can be re-saved.
  const existing = PROPERTY.published_content.photos[0];
  await admin.saveContent({ content: { ...CONTENT, photos: [existing] }, version: 4 }, ACTOR, db);
  assert.equal(rpcCalls(db, "manager_configure").length, 2);
});

test("notification retry re-reads the raw outbox row and maps template/recipient", async () => {
  const OUT_ID = "33333333-3333-4333-8333-333333333333";
  const db = fakeDb({
    rpcs: { manager_configure: { id: OUT_ID, template: "booking_confirmed", recipient: "guest", status: "queued" } },
    tables: {
      outbox: { data: { id: OUT_ID, topic: "booking_confirmed", booking_id: BOOKING_ROW.id, recipient: "guest", status: "pending", attempts: 3, last_error: "send_failed", created_at: "t" } },
      bookings: { data: [{ id: BOOKING_ROW.id, guest_email: "ada@example.com" }] }
    }
  });
  const { notification } = await admin.retryNotification(OUT_ID, ACTOR, db);
  assert.equal(rpcCalls(db, "manager_configure")[0].args.p_section, "outbox_retry");
  assert.deepEqual({ t: notification.template, b: notification.booking_id, r: notification.recipient, s: notification.status },
    { t: "booking_confirmed", b: BOOKING_ROW.id, r: "ada@example.com", s: "queued" });
  assert.equal(notification.last_error, "send_failed", "stored diagnostics are preserved");
});

test("retryEvents is an explicit audited owner RPC that returns only a count", async () => {
  const db = fakeDb({ rpcs: { manager_retry_events: { requeued: 2, ids: ["x"] } } });
  assert.deepEqual(await admin.retryEvents(ACTOR, db), { requeued: 2 });
  assert.deepEqual(rpcCalls(db, "manager_retry_events")[0].args, { p_actor: ACTOR.id });
  await assert.rejects(admin.retryEvents(null, db), (e) => e.status === 401);
});

test("photo upload paths are server-chosen and type/size bounded", async () => {
  const db = fakeDb();
  const out = await admin.uploadPhoto({ filename: "../../deck.JPG", content_type: "image/jpeg", size: 1000 }, ACTOR, db);
  assert.match(out.path, /^property\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(out.public_url.endsWith(out.path));
  await rejectsField(admin.uploadPhoto({ filename: "deck.png", content_type: "image/jpeg", size: 1000 }, ACTOR, db), "filename");
  await rejectsField(admin.uploadPhoto({ filename: "deck.svg", content_type: "image/svg+xml", size: 1000 }, ACTOR, db), "content_type");
  await rejectsField(admin.uploadPhoto({ filename: "deck.jpg", content_type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }, ACTOR, db), "size");
});

test("settings: currency allowlist, owner email normalisation, version required", async () => {
  const db = fakeDb({ rpcs: { manager_configure: (args) => ({ data: { ...args.p_data, version: 3 }, error: null }) } });
  const body = { timezone: "America/Toronto", currency: "CAD", owner_email: " Owner@Example.com ", booking_enabled: true, version: 2 };
  const out = await admin.saveSettings(body, ACTOR, db);
  assert.equal(rpcCalls(db, "manager_configure")[0].args.p_data.owner_email, "owner@example.com");
  assert.equal(out.version, 3);
  await rejectsField(admin.saveSettings({ ...body, currency: "EUR" }, ACTOR, db), "currency");
  await rejectsField(admin.saveSettings({ ...body, timezone: "../etc" }, ACTOR, db), "timezone");
  await rejectsField(admin.saveSettings({ ...body, booking_enabled: "true" }, ACTOR, db), "booking_enabled");
});

test("admin services refuse a missing actor and map database errors safely", async () => {
  await assert.rejects(admin.overview(null, fakeDb()), (e) => e.status === 401);
  const db = fakeDb({ rpcs: { manager_configure: { data: null, error: { message: "version_conflict", code: "55000" } } } });
  db.rpc = (name, args) => { db.log.push({ rpc: name, args }); return Promise.resolve({ data: null, error: { message: "version_conflict", code: "55000" } }); };
  await assert.rejects(admin.publishContent({ version: 1 }, ACTOR, db), (e) => e.status === 409 && e.code === "version_conflict");
  db.rpc = () => Promise.resolve({ data: null, error: { message: "relation bookings secret detail", code: "XX000" } });
  const saved = console.error; console.error = () => {};
  try {
    await assert.rejects(admin.overview(ACTOR, db), (e) => e.status === 502 && !/relation|secret/.test(e.message));
  } finally { console.error = saved; }
});

test("action response helper never exposes the payment attempt", () => {
  const out = admin.actionResponse({ booking: BOOKING_ROW, attempt: { idempotency_key: "booking:x:attempt:1" }, reconciliation_required: true });
  assert.doesNotMatch(JSON.stringify(out), /attempt:1|hhhhhhhh|iiiiiiii/);
  assert.equal(out.reconciliation_required, true);
});

test("payments list sums only succeeded refunds for listed attempts", async () => {
  const db = fakeDb({ tables: {
    payment_attempts: { data: [{ id: "a1", booking_id: "b1", status: "succeeded", expected_total_cents: 1000, captured_cents: 1000, currency: "CAD",
      receipt_url: "https://pay.stripe.com/r/1", bookings: { confirmation_code: "BMH-1", payment_status: "partially_refunded" } }], count: 1 },
    refunds: (calls) => {
      assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "status" && c[2] === "succeeded"));
      return { data: [{ payment_attempt_id: "a1", amount_cents: 200 }, { payment_attempt_id: "a1", amount_cents: 300 }] };
    }
  } });
  const out = await admin.listPayments({}, ACTOR, db);
  assert.equal(out.items[0].refunded_cents, 500);
  assert.equal(out.items[0].receipt_url, "https://pay.stripe.com/r/1");
  assert.deepEqual([out.total, out.page, out.page_size], [1, 1, 20]);
  await rejectsField(admin.listPayments({ page_size: "101" }, ACTOR, db), "page_size");
});
