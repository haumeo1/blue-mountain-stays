// SYNTHETIC BROWSER CONTRACT FIXTURE — local UI testing only.
// Serves built dist/ assets plus an in-memory MOCK of the API and Supabase Auth so the
// production bundles can be exercised end to end on 127.0.0.1:55004.
// Never imported by api/, server/, src/, or the build. Sends no email, calls no providers,
// stores no real data. Fake tokens here are accepted ONLY by this process.
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.env.VERCEL || process.env.NODE_ENV === "production") {
  console.error("fixture-server refuses to run on Vercel or with NODE_ENV=production.");
  process.exit(1);
}

const HOST = "127.0.0.1";
const PORT = 55004;
const ORIGIN = `http://${HOST}:${PORT}`;
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const TZ = "America/Toronto";
const OWNER = { id: "00000000-0000-4000-8000-0000000000a1", email: "owner@example.invalid" };
const PUBLISHABLE_KEY = "sb_publishable_fixture_not_a_real_key";
const MAX_BODY = 64 * 1024;

// ---------- helpers ----------
const b64url = (value) => Buffer.from(value).toString("base64url");
const clone = (value) => (value == null ? value : structuredClone(value));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const str = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const code = () => `BMH-${randomBytes(3).toString("hex").toUpperCase().slice(0, 4)}`;

class HttpError extends Error {
  constructor(status, errCode, message, fields) { super(message); this.status = status; this.code = errCode; this.fields = fields; }
}
const fail = (status, errCode, message, fields) => { throw new HttpError(status, errCode, message, fields); };

// ---------- fake auth (fixture-only) ----------
const accessTokens = new Map(); // token -> exp (seconds)
const refreshTokens = new Set(["fixture-refresh"]);
function issueJwt() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const token = [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "fixture" })),
    b64url(JSON.stringify({ iss: `${ORIGIN}/auth/v1`, sub: OWNER.id, aud: "authenticated", role: "authenticated", email: OWNER.email, iat, exp, session_id: randomUUID(), fixture: true })),
    b64url("fixture-signature-not-valid-anywhere")
  ].join(".");
  accessTokens.set(token, exp);
  return { token, exp };
}
const ownerUser = () => ({ id: OWNER.id, aud: "authenticated", role: "authenticated", email: OWNER.email, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: { provider: "email", fixture: true }, user_metadata: {}, created_at: "2026-01-01T00:00:00Z", updated_at: nowIso() });
function bearer(req) { const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ""); return m ? m[1] : null; }
function requireOwner(req) {
  const token = bearer(req);
  const exp = token && accessTokens.get(token);
  if (!exp || exp * 1000 < Date.now()) fail(401, "unauthorized", "Please sign in again.");
}
let ownerLink = issueJwt();

// ---------- synthetic state ----------
const DEFAULT_PHOTOS = [
  ["https://images.unsplash.com/photo-1601918774946-25832a4be0d6?auto=format&fit=crop&w=1800&q=88", "Exterior of the Blue Mountain house in a forest setting"],
  ["https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=86", "Bright living room with comfortable seating"],
  ["https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=86", "Modern kitchen and dining area"],
  ["https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=86", "Warm, peaceful bedroom"],
  ["https://images.unsplash.com/photo-1523217582562-09d0def993a6?auto=format&fit=crop&w=1200&q=86", "House exterior and outdoor area"],
  ["https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=86", "Relaxing interior detail"]
].map(([url, alt], i) => ({ path: `fixture/default-${i + 1}.jpg`, url, alt }));

function defaultContent() {
  return {
    title: "The Blue Mountain House",
    hero_title: "Your place to come together.",
    description: "A forest-edge home near Blue Mountain Village for families and friends. (Synthetic fixture content.)",
    amenities: [{ title: "Private hot tub", description: "Year-round, under the trees." }, { title: "Fast Wi-Fi", description: "Good for remote work." }],
    photos: clone(DEFAULT_PHOTOS),
    faq: [{ question: "Is this a live listing?", answer: "No. This page is served by a synthetic browser test fixture." }],
    policies: { cancellation: "Full refund up to 14 days before arrival.", house_rules: "No parties. Quiet hours 10pm–8am." },
    contact: { email: "host@example.invalid", phone: "" },
    policies_confirmed: true
  };
}
const withDerived = (c) => (c ? { ...c, policies_complete: Boolean(str(c.policies?.cancellation) && str(c.policies?.house_rules) && c.policies_confirmed === true) } : null);

let S; // state
let versionSeq = 0;
const nextVersion = () => ++versionSeq;
let failNext = false;
const idempotency = new Map(); // scope:key -> {fingerprint, status, payload}

function priceStay(checkIn, checkOut) {
  let stay = 0;
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    const o = S.pricing.overrides.find((x) => d >= x.start_date && d < x.end_date);
    stay += o ? o.nightly_rate_cents : S.pricing.nightly_rate_cents;
  }
  const cleaning = S.pricing.cleaning_fee_cents;
  const service = Math.round((stay * S.pricing.service_bps) / 10000);
  const tax = Math.round(((stay + cleaning + service) * S.pricing.tax_bps) / 10000);
  return { nights: nightsBetween(checkIn, checkOut), stay_cents: stay, cleaning_fee_cents: cleaning, service_fee_cents: service, tax_cents: tax, total_cents: stay + cleaning + service + tax };
}

function log(action, bookingId = null, details = {}, actor = OWNER.id) {
  const entry = { created_at: nowIso(), actor_id: actor, action, booking_id: bookingId, details };
  S.activity.unshift(entry);
  return entry;
}
function notify(template, recipient, bookingId) {
  // Recorded in memory only. Nothing is ever delivered.
  S.notifications.unshift({ id: randomUUID(), template, recipient, status: "sent", attempts: 1, last_error: null, created_at: nowIso(), booking_id: bookingId });
}

function makeBooking({ checkIn, checkOut, guests, name, email, phone = "", notes = "", status, paymentStatus, createdAt }) {
  const price = priceStay(checkIn, checkOut);
  const b = {
    id: randomUUID(), confirmation_code: code(), status, payment_status: paymentStatus,
    guest_name: name, guest_email: email, guest_phone: phone, guest_notes: notes, guest_count: guests,
    check_in: checkIn, check_out: checkOut, ...price, currency: "CAD", hold_expires_at: null, cancel_requested: false,
    created_at: createdAt || nowIso(), updated_at: createdAt || nowIso(),
    history: [], payments: [], refunds: []
  };
  S.bookings.push(b);
  const token = `fixture-guest-${randomBytes(18).toString("base64url")}`;
  S.guestTokens.set(token, b.id);
  b.guest_token = token;
  return b;
}
function addPayment(b, status) {
  const p = { id: randomUUID(), status, amount_cents: b.total_cents, currency: b.currency, stripe_session_id: `fixture_cs_${b.id.slice(0, 8)}`, stripe_payment_intent_id: null, receipt_url: null, created_at: nowIso() };
  b.payments.push(p);
  return p;
}
function setPayment(b, status) {
  b.payment_status = status;
  const p = b.payments.at(-1);
  if (p) p.status = status;
  b.updated_at = nowIso();
}
function history(b, action, details = {}, actor = OWNER.id) { b.history.push(log(action, b.id, details, actor)); }

function reset() {
  versionSeq = 0;
  idempotency.clear();
  failNext = false;
  S = {
    failedEvents: 1, // synthetic count of stored verified payment events that failed processing
    pricing: { nightly_rate_cents: 42500, cleaning_fee_cents: 14500, service_bps: 800, tax_bps: 0, tax_configured: false, min_nights: 2, max_nights: 28, max_guests: 8, overrides: [], version: nextVersion() },
    content: { draft: defaultContent(), published: defaultContent(), version: nextVersion() },
    settings: { timezone: TZ, currency: "CAD", owner_email: OWNER.email, booking_enabled: true, version: nextVersion() },
    calendar: { configured: false, created_at: null, last_used_at: null },
    bookings: [], blocks: [], notifications: [], activity: [], quotes: new Map(), guestTokens: new Map()
  };
  const t = today();
  const confirmed = makeBooking({ checkIn: addDays(t, 21), checkOut: addDays(t, 24), guests: 4, name: "Synthetic Guest One", email: "guest.one@example.invalid", status: "confirmed", paymentStatus: "paid", createdAt: new Date(Date.now() - 5 * 86400000).toISOString() });
  addPayment(confirmed, "paid");
  confirmed.payments[0].stripe_payment_intent_id = `fixture_pi_${confirmed.id.slice(0, 8)}`;
  history(confirmed, "requested", {}, null); history(confirmed, "approved"); history(confirmed, "payment_succeeded", { fixture: true }, null);
  const pending = makeBooking({ checkIn: addDays(t, 35), checkOut: addDays(t, 38), guests: 2, name: "Synthetic Guest Two", email: "guest.two@example.invalid", notes: "Arriving late (synthetic).", status: "pending", paymentStatus: "not_due", createdAt: new Date(Date.now() - 3 * 3600000).toISOString() });
  history(pending, "requested", { approval_due_by: new Date(Date.parse(pending.created_at) + 86400000).toISOString() }, null);
  S.blocks.push({ id: randomUUID(), start_date: addDays(t, 50), end_date: addDays(t, 52), reason: "Maintenance (synthetic)" });
  S.notifications.push({ id: randomUUID(), template: "owner_new_request", recipient: OWNER.email, status: "failed", attempts: 1, last_error: "fixture: simulated delivery failure", created_at: nowIso(), booking_id: pending.id });
  log("fixture_reset", null, { synthetic: true }, null);
}
reset();

// payment_due holds dates (including while cancel_requested awaits reconciliation); confirmed books them.
const holdsInventory = (b) => b.status === "payment_due" || b.status === "confirmed";
function conflicts(start, end, excludeId) {
  return S.bookings.some((b) => b.id !== excludeId && holdsInventory(b) && overlaps(start, end, b.check_in, b.check_out))
    || S.blocks.some((x) => overlaps(start, end, x.start_date, x.end_date));
}
const bookingView = (b) => { const { history: _h, payments: _p, refunds: _r, guest_token: _g, ...rest } = b; return rest; };
const refundedCents = (b) => b.refunds.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amount_cents, 0);
const findBooking = (id) => S.bookings.find((b) => b.id === id) || fail(404, "not_found", "Booking not found.");
function paginate(items, url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("page_size"), 10) || 20));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize };
}
function checkVersion(resource, version) {
  if (!Number.isInteger(version)) fail(422, "validation_failed", "version is required.", { version: "Required" });
  if (version !== resource.version) fail(409, "version_conflict", "Someone else changed this. Reload and try again.");
}
function withIdempotency(scope, key, body, run) {
  if (typeof key !== "string" || key.length < 8 || key.length > 200) fail(422, "validation_failed", "idempotency_key is required.", { idempotency_key: "Required" });
  const id = `${scope}:${key}`;
  const fingerprint = JSON.stringify(body);
  const prior = idempotency.get(id);
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail(409, "conflict", "This request key was already used with different details.");
    return { status: 200, data: clone(prior.data) };
  }
  const data = run();
  idempotency.set(id, { fingerprint, data: clone(data) });
  return { status: 201, data };
}

// ---------- public + guest API ----------
function propertyView() {
  return { name: "The Blue Mountain House", timezone: S.settings.timezone, currency: S.settings.currency, max_guests: S.pricing.max_guests, booking_enabled: S.settings.booking_enabled };
}
function quote(body) {
  if (!S.settings.booking_enabled) fail(403, "booking_disabled", "Online booking is paused.");
  const { check_in: ci, check_out: co, guest_count: gc } = body || {};
  const fields = {};
  if (!isIso(ci)) fields.check_in = "Choose a valid check-in date.";
  if (!isIso(co)) fields.check_out = "Choose a valid check-out date.";
  if (!isInt(gc, 1, S.pricing.max_guests)) fields.guest_count = `Guests must be 1–${S.pricing.max_guests}.`;
  if (Object.keys(fields).length) fail(422, "validation_failed", Object.values(fields)[0], fields);
  if (ci < today()) fail(422, "validation_failed", "Check-in can't be in the past.", { check_in: "Too early" }); // same-day allowed
  const n = nightsBetween(ci, co);
  if (n < S.pricing.min_nights || n > S.pricing.max_nights) fail(422, "validation_failed", `Stays must be ${S.pricing.min_nights}–${S.pricing.max_nights} nights.`, { check_out: "Length" });
  if (conflicts(ci, co)) fail(409, "dates_unavailable", "Those dates aren't available.");
  const q = { id: `q_fixture_${randomBytes(8).toString("hex")}`, check_in: ci, check_out: co, guest_count: gc, ...priceStay(ci, co), currency: S.settings.currency, expires_at: new Date(Date.now() + 30 * 60000).toISOString() };
  S.quotes.set(q.id, q);
  return { quote: q };
}
function createBooking(body) {
  const q = S.quotes.get(body?.quote_id);
  if (!q) fail(409, "quote_invalid", "Your price needed refreshing.");
  if (Date.parse(q.expires_at) < Date.now()) fail(410, "quote_expired", "Your price expired.");
  const name = str(body.guest_name, 120); const email = str(body.guest_email, 254);
  const fields = {};
  if (!name) fields.guest_name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.guest_email = "Enter a valid email.";
  if (Object.keys(fields).length) fail(422, "validation_failed", Object.values(fields)[0], fields);
  const clean = { quote_id: q.id, guest_name: name, guest_email: email, guest_phone: str(body.guest_phone, 40), guest_notes: str(body.guest_notes, 2000) };
  return withIdempotency("booking", body.idempotency_key, clean, () => {
    if (conflicts(q.check_in, q.check_out)) fail(409, "dates_unavailable", "Those dates aren't available.");
    // Pending requests do not hold inventory.
    const b = makeBooking({ checkIn: q.check_in, checkOut: q.check_out, guests: q.guest_count, name, email, phone: clean.guest_phone, notes: clean.guest_notes, status: "pending", paymentStatus: "not_due" });
    Object.assign(b, { stay_cents: q.stay_cents, cleaning_fee_cents: q.cleaning_fee_cents, service_fee_cents: q.service_fee_cents, tax_cents: q.tax_cents, total_cents: q.total_cents });
    S.quotes.delete(q.id);
    history(b, "requested", { approval_due_by: new Date(Date.now() + 86400000).toISOString() }, null);
    notify("guest_request_received", email, b.id); notify("owner_new_request", S.settings.owner_email, b.id);
    const { id, confirmation_code, status, total_cents, currency, check_in, check_out, guest_count } = b;
    return { booking: { id, confirmation_code, status, total_cents, currency, check_in, check_out, guest_count }, guest_token: b.guest_token };
  });
}
function guestBooking(req) {
  const id = S.guestTokens.get(bearer(req) || "");
  if (!id) fail(401, "unauthorized", "This booking link isn't valid.");
  return findBooking(id);
}

// ---------- admin API ----------
function overview() {
  const t = today(); const end = addDays(t, 30);
  let booked = 0;
  for (let d = t; d < end; d = addDays(d, 1)) if (S.bookings.some((b) => holdsInventory(b) && d >= b.check_in && d < b.check_out)) booked += 1;
  const upcoming = S.bookings.filter((b) => b.status === "confirmed" && b.check_in >= t).sort((a, b) => a.check_in.localeCompare(b.check_in));
  const paid = S.bookings.flatMap((b) => b.payments).filter((p) => ["paid", "partially_refunded", "refunded"].includes(p.status));
  const n = upcoming[0];
  return {
    currency: S.settings.currency,
    pending_requests: S.bookings.filter((b) => b.status === "pending").length,
    confirmed_arrivals: upcoming.length,
    paid_cents: paid.reduce((s, p) => s + p.amount_cents, 0),
    refunded_cents: S.bookings.reduce((s, b) => s + refundedCents(b), 0),
    occupancy_percent: Math.round((booked / 30) * 100),
    failed_notifications: S.notifications.filter((x) => x.status === "failed").length,
    next_arrival: n ? { id: n.id, guest_name: n.guest_name, check_in: n.check_in, check_out: n.check_out, guest_count: n.guest_count, confirmation_code: n.confirmation_code } : null
  };
}
function bookingAction(b, body) {
  const action = body?.action; const reason = str(body?.reason, 500);
  const allowed = { pending: ["approve", "decline", "cancel"], payment_due: b.cancel_requested ? [] : ["cancel"], confirmed: ["cancel", "complete"] }[b.status] || [];
  if (!allowed.includes(action)) fail(409, "conflict", `Can't ${action || "do that"} a ${b.status} booking.`);
  if (action === "complete" && b.check_out > today()) fail(409, "conflict", "A stay can be completed only after check-out.");
  let reconciliation = false;
  if (action === "approve") {
    if (conflicts(b.check_in, b.check_out, b.id)) fail(409, "dates_unavailable", "These dates now conflict with another booking or block.");
    b.status = "payment_due"; b.hold_expires_at = new Date(Date.now() + 86400000).toISOString();
    addPayment(b, "payment_due"); setPayment(b, "payment_due");
    notify("guest_payment_due", b.guest_email, b.id);
  } else if (action === "decline") { b.status = "declined"; notify("guest_declined", b.guest_email, b.id); }
  else if (action === "cancel" && b.status === "payment_due") {
    // Hold stays until reconciliation (control page "Simulate reconciliation").
    b.cancel_requested = true; reconciliation = true;
  } else if (action === "cancel") {
    b.status = "cancelled"; notify("guest_cancelled", b.guest_email, b.id);
  } else b.status = "completed";
  b.updated_at = nowIso();
  history(b, reconciliation ? "cancel_requested" : { approve: "approved", decline: "declined", cancel: "cancelled", complete: "completed" }[action], reason ? { reason } : {});
  // Synthetic fixture: the payment link is reported as pending (no Stripe).
  return { booking: bookingView(b), payment_pending: action === "approve", reconciliation_required: reconciliation };
}
function adminRanges(url) {
  const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
  if (!isIso(from) || !isIso(to) || to <= from) fail(400, "bad_request", "from and to are required dates.");
  const ranges = [
    ...S.bookings.filter(holdsInventory).map((b) => ({ id: b.id, start: b.check_in, end: b.check_out, type: b.status === "payment_due" ? "hold" : "booking", label: `${b.guest_name} · ${b.confirmation_code}`, booking_id: b.id, block_id: null })),
    ...S.blocks.map((x) => ({ id: x.id, start: x.start_date, end: x.end_date, type: "block", label: x.reason || "Blocked", booking_id: null, block_id: x.id }))
  ];
  return ranges.filter((r) => overlaps(r.start, r.end, from, to)).sort((a, b) => a.start.localeCompare(b.start));
}
const pricingView = () => clone(S.pricing);
function savePricing(body) {
  checkVersion(S.pricing, body?.version);
  const fields = {};
  for (const [k, min, max] of [["nightly_rate_cents", 100, 10000000], ["cleaning_fee_cents", 0, 10000000], ["service_bps", 0, 5000], ["tax_bps", 0, 5000], ["min_nights", 1, 365], ["max_nights", 1, 365], ["max_guests", 1, 100]]) {
    if (!isInt(body[k], min, max)) fields[k] = "Enter a whole number in range.";
  }
  if (typeof body.tax_configured !== "boolean") fields.tax_configured = "Required boolean.";
  if (!fields.min_nights && !fields.max_nights && body.min_nights > body.max_nights) fields.max_nights = "Must be at least the minimum.";
  const overrides = Array.isArray(body.overrides) ? body.overrides : [];
  overrides.forEach((o, i) => { if (!isIso(o?.start_date) || !isIso(o?.end_date) || o.end_date <= o.start_date || !isInt(o.nightly_rate_cents, 100, 10000000)) fields[`overrides.${i}`] = "Invalid date override."; });
  if (Object.keys(fields).length) fail(422, "validation_failed", "Check the highlighted pricing fields.", fields);
  S.pricing = { nightly_rate_cents: body.nightly_rate_cents, cleaning_fee_cents: body.cleaning_fee_cents, service_bps: body.service_bps, tax_bps: body.tax_bps, tax_configured: body.tax_configured, min_nights: body.min_nights, max_nights: body.max_nights, max_guests: body.max_guests, overrides: overrides.map((o) => ({ start_date: o.start_date, end_date: o.end_date, nightly_rate_cents: o.nightly_rate_cents })), version: nextVersion() };
  log("pricing_updated", null, { version: S.pricing.version });
  return pricingView();
}
const contentView = () => ({ draft: withDerived(clone(S.content.draft)), published: withDerived(clone(S.content.published)), version: S.content.version });
function sanitizeContent(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) fail(422, "validation_failed", "Content is required.");
  if (typeof c.policies_confirmed !== "boolean") fail(422, "validation_failed", "policies_confirmed is required.", { policies_confirmed: "Required boolean" });
  const list = (v) => (Array.isArray(v) ? v.slice(0, 50) : []);
  const photos = list(c.photos).map((p) => ({ path: str(p?.path, 300), url: str(p?.url, 1000), alt: str(p?.alt, 200) }));
  if (photos.some((p) => !p.url.startsWith("https://"))) fail(422, "validation_failed", "Photo URLs must be https.");
  return {
    title: str(c.title, 120), hero_title: str(c.hero_title, 160), description: str(c.description, 4000),
    amenities: list(c.amenities).map((a) => ({ title: str(a?.title, 80), description: str(a?.description, 500) })).filter((a) => a.title),
    photos,
    faq: list(c.faq).map((f) => ({ question: str(f?.question, 300), answer: str(f?.answer, 2000) })).filter((f) => f.question && f.answer),
    policies: { cancellation: str(c.policies?.cancellation, 4000), house_rules: str(c.policies?.house_rules, 4000) },
    contact: { email: str(c.contact?.email, 254), phone: str(c.contact?.phone, 40) },
    policies_confirmed: c.policies_confirmed === true
  };
}
function refund(body) {
  const b = findBooking(body?.booking_id);
  const clean = { booking_id: b.id, amount_cents: body.amount_cents, reason: str(body.reason, 500) };
  return withIdempotency("refund", body.idempotency_key, clean, () => {
    if (!["paid", "partially_refunded"].includes(b.payment_status)) fail(409, "conflict", "Only paid bookings can be refunded.");
    const refundable = b.total_cents - refundedCents(b);
    if (!isInt(clean.amount_cents, 1, refundable)) fail(422, "validation_failed", `Refund must be between 1 and ${refundable} cents.`, { amount_cents: "Out of range" });
    const r = { id: randomUUID(), amount_cents: clean.amount_cents, currency: b.currency, status: "succeeded", reason: clean.reason, created_at: nowIso() };
    b.refunds.push(r);
    setPayment(b, refundedCents(b) >= b.total_cents ? "refunded" : "partially_refunded");
    history(b, "refunded", { amount_cents: r.amount_cents, fixture: true });
    notify("guest_refund_issued", b.guest_email, b.id);
    return { refund: r };
  });
}

// ---------- routing ----------
async function readJson(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return undefined;
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, "bad_request", "Request too large."); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const ct = req.headers["content-type"] || "";
  if (ct.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { fail(400, "bad_request", "Malformed JSON."); }
}

async function handleApi(req, url, body) {
  const p = url.pathname; const m = req.method;
  if (failNext) { failNext = false; fail(500, "internal", "Simulated failure (synthetic fixture: Fail next API request)."); }
  // Public
  if (m === "GET" && p === "/api/config") return { data: { supabaseUrl: ORIGIN, supabasePublishableKey: PUBLISHABLE_KEY, demoMode: false, bookingEnabled: S.settings.booking_enabled } };
  if (m === "GET" && p === "/api/property") return { data: { property: propertyView(), content: withDerived(clone(S.content.published)) } };
  if (m === "GET" && p === "/api/availability") {
    const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
    if (!isIso(from) || !isIso(to)) fail(400, "bad_request", "from and to are required dates.");
    return { data: { ranges: adminRanges(url).map((r) => ({ start: r.start, end: r.end, type: "unavailable" })) } };
  }
  if (m === "POST" && p === "/api/quotes") return { data: quote(body) };
  if (m === "POST" && p === "/api/bookings") { const r = createBooking(body); return { status: r.status, data: r.data }; }
  // Guest (scoped fixture guest token)
  if (m === "GET" && p === "/api/guest/booking") {
    const b = guestBooking(req);
    const { confirmation_code, status, check_in, check_out, guest_count, nights, stay_cents, cleaning_fee_cents, service_fee_cents, tax_cents, total_cents, currency, hold_expires_at, cancel_requested } = b;
    return { data: { booking: { confirmation_code, status, check_in, check_out, guest_count, nights, stay_cents, cleaning_fee_cents, service_fee_cents, tax_cents, total_cents, currency, hold_expires_at, cancel_requested }, payment: { status: b.payment_status, receipt_url: null }, calendar_url: null } };
  }
  if (m === "POST" && p === "/api/guest/checkout") {
    const b = guestBooking(req);
    if (b.status !== "payment_due" || b.payment_status !== "payment_due" || b.cancel_requested) fail(409, "conflict", "Payment isn't due for this booking.");
    // MOCK ONLY: a fake, never-valid checkout URL. Browser tests intercept checkout.stripe.com with a
    // local stub page; no Stripe session exists and nothing is charged. Opening this URL does not
    // change payment state — only "Simulate verified payment" on /__fixture does.
    const fakeSession = `cs_test_fixture_${randomBytes(12).toString("hex")}`;
    const p = b.payments.at(-1);
    if (p) p.stripe_session_id = fakeSession;
    return { data: { url: `https://checkout.stripe.com/c/pay/${fakeSession}`, fixture: "mock checkout URL — not a real Stripe session" } };
  }
  // Admin
  if (!p.startsWith("/api/admin/")) fail(404, "not_found", "Not found.");
  requireOwner(req);
  const seg = p.slice("/api/admin/".length).split("/");
  if (m === "GET" && p === "/api/admin/overview") return { data: overview() };
  if (m === "GET" && p === "/api/admin/bookings") {
    const q = (url.searchParams.get("search") || "").trim().toLowerCase(); const st = url.searchParams.get("status") || "";
    const items = S.bookings.filter((b) => (!st || b.status === st) && (!q || [b.guest_name, b.guest_email, b.confirmation_code].some((v) => v.toLowerCase().includes(q))))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(bookingView);
    return { data: paginate(items, url) };
  }
  if (seg[0] === "bookings" && seg.length === 2 && m === "GET") {
    const b = findBooking(decodeURIComponent(seg[1]));
    return { data: { booking: bookingView(b), history: clone(b.history), payments: clone(b.payments), refunds: clone(b.refunds) } };
  }
  if (seg[0] === "bookings" && seg[2] === "actions" && seg.length === 3 && m === "POST") return { data: bookingAction(findBooking(decodeURIComponent(seg[1])), body) };
  if (m === "GET" && p === "/api/admin/availability") return { data: { ranges: adminRanges(url) } };
  if (m === "POST" && p === "/api/admin/blocks") {
    const { start_date: s, end_date: e } = body || {};
    if (!isIso(s) || !isIso(e) || e <= s) fail(422, "validation_failed", "End date must be after start date.", { end_date: "Invalid" });
    if (conflicts(s, e)) fail(409, "dates_unavailable", "Those dates overlap a booking, hold, or block.");
    const block = { id: randomUUID(), start_date: s, end_date: e, reason: str(body.reason, 200) };
    S.blocks.push(block); log("block_created", null, { start_date: s, end_date: e });
    return { status: 201, data: { block } };
  }
  if (seg[0] === "blocks" && seg.length === 2 && m === "DELETE") {
    const i = S.blocks.findIndex((x) => x.id === decodeURIComponent(seg[1]));
    if (i < 0) fail(404, "not_found", "Block not found.");
    S.blocks.splice(i, 1); log("block_deleted");
    return { data: { deleted: true } };
  }
  if (p === "/api/admin/pricing" && m === "GET") return { data: pricingView() };
  if (p === "/api/admin/pricing" && m === "PUT") return { data: savePricing(body || {}) };
  if (p === "/api/admin/content" && m === "GET") return { data: contentView() };
  if (p === "/api/admin/content" && m === "PUT") {
    checkVersion(S.content, body?.version);
    S.content.draft = sanitizeContent(body.content); S.content.version = nextVersion(); log("content_saved");
    return { data: contentView() };
  }
  if (p === "/api/admin/content/publish" && m === "POST") {
    checkVersion(S.content, body?.version);
    S.content.published = clone(S.content.draft); S.content.version = nextVersion(); log("content_published");
    return { data: contentView() };
  }
  if (p === "/api/admin/photos/upload" && m === "POST") fail(501, "not_supported", "Photo uploads aren't supported by the synthetic fixture (no storage). Existing photos can still be edited.");
  if (p === "/api/admin/payments" && m === "GET") {
    const items = S.bookings.filter((b) => b.payments.length).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((b) => {
      const pay = b.payments.at(-1);
      return { id: pay.id, booking_id: b.id, confirmation_code: b.confirmation_code, total_cents: b.total_cents, currency: b.currency, payment_status: b.payment_status, stripe_session_id: pay.stripe_session_id, stripe_payment_intent_id: pay.stripe_payment_intent_id, receipt_url: null, refunded_cents: refundedCents(b) };
    });
    return { data: paginate(items, url) };
  }
  if (p === "/api/admin/refunds" && m === "POST") { const r = refund(body || {}); return { status: r.status, data: r.data }; }
  if (p === "/api/admin/notifications" && m === "GET") return { data: paginate(S.notifications.map(({ booking_id: _b, ...n }) => n), url) };
  if (seg[0] === "notifications" && seg[2] === "retry" && seg.length === 3 && m === "POST") {
    const n = S.notifications.find((x) => x.id === decodeURIComponent(seg[1])) || fail(404, "not_found", "Notification not found.");
    if (n.status !== "failed") fail(409, "conflict", "Only failed notifications can be retried.");
    Object.assign(n, { status: "sent", attempts: n.attempts + 1, last_error: null }); log("notification_retried", n.booking_id, { fixture: "not delivered" });
    const { booking_id: _b, ...view } = n;
    return { data: { notification: view } };
  }
  if (p === "/api/admin/jobs/run" && m === "POST") return { data: { processed: 0, failed: 0 } };
  if (p === "/api/admin/jobs/retry-events" && m === "POST") {
    const requeued = S.failedEvents; S.failedEvents = 0;
    log("payment_events_requeued", null, { requeued, fixture: true });
    return { data: { requeued } };
  }
  if (p === "/api/admin/calendar" && m === "GET") return { data: clone(S.calendar) };
  if (p === "/api/admin/calendar/rotate" && m === "POST") {
    S.calendar = { configured: true, created_at: nowIso(), last_used_at: null }; log("calendar_rotated");
    const t = randomBytes(12).toString("hex");
    return { data: { http_url: `https://example.invalid/fixture-calendar/feed.ics?token=${t}`, webcal_url: `webcal://example.invalid/fixture-calendar/feed.ics?token=${t}` } };
  }
  if (p === "/api/admin/calendar" && m === "DELETE") { S.calendar = { configured: false, created_at: null, last_used_at: null }; log("calendar_revoked"); return { data: { configured: false } }; }
  if (p === "/api/admin/settings" && m === "GET") return { data: clone(S.settings) };
  if (p === "/api/admin/settings" && m === "PUT") {
    checkVersion(S.settings, body?.version);
    const owner = str(body.owner_email, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) fail(422, "validation_failed", "Enter a valid owner email.", { owner_email: "Invalid" });
    if (!["CAD", "USD"].includes(body.currency)) fail(422, "validation_failed", "Currency must be CAD or USD.", { currency: "Invalid" });
    if (body.currency !== S.settings.currency && S.bookings.length) fail(409, "conflict", "Currency cannot change while bookings exist");
    S.settings = { timezone: str(body.timezone, 64) || TZ, currency: body.currency, owner_email: owner, booking_enabled: body.booking_enabled === true, version: nextVersion() };
    log("settings_updated");
    return { data: clone(S.settings) };
  }
  if (p === "/api/admin/health" && m === "GET") {
    return { data: { services: [
      { name: "fixture", configured: true, reachable: true, message: "Synthetic browser fixture — in-memory mock API" },
      ...["supabase", "stripe", "email"].map((name) => ({ name, configured: false, reachable: false, message: "Not connected (synthetic fixture)" }))
    ] } };
  }
  if (p === "/api/admin/activity" && m === "GET") return { data: paginate(clone(S.activity), url) };
  fail(404, "not_found", "Not found.");
}

async function handleAuth(req, url, body) {
  const p = url.pathname.replace(/^\/auth\/v1/, "");
  if (p === "/user" && req.method === "GET") { requireOwner(req); return { raw: ownerUser() }; }
  if (p === "/token" && req.method === "POST") {
    if (url.searchParams.get("grant_type") !== "refresh_token" || !refreshTokens.has(body?.refresh_token)) return { status: 400, raw: { error: "invalid_grant", error_description: "Invalid fixture refresh token" } };
    const { token, exp } = issueJwt();
    return { raw: { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: body.refresh_token, user: ownerUser() } };
  }
  if (p === "/logout" && req.method === "POST") { const t = bearer(req); if (t) accessTokens.delete(t); return { status: 204 }; }
  if (p === "/otp" && req.method === "POST") return { raw: {} }; // no email is ever sent
  return { status: 404, raw: { error: "not_found" } };
}

// ---------- control page ----------
const latest = (pred) => S.bookings.filter(pred).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
function control(req, url, body) {
  if (req.method === "POST") {
    const action = url.pathname.slice("/__fixture/".length);
    if (action === "pay") {
      const b = latest((x) => x.status === "payment_due" && x.payment_status === "payment_due" && !x.cancel_requested);
      if (b) {
        b.status = "confirmed"; b.hold_expires_at = null;
        setPayment(b, "paid"); b.payments.at(-1).stripe_payment_intent_id = `fixture_pi_${b.id.slice(0, 8)}`;
        history(b, "payment_succeeded", { fixture: "simulated verified webhook" }, null);
        notify("guest_booking_confirmed", b.guest_email, b.id); notify("owner_payment_received", S.settings.owner_email, b.id);
      }
    } else if (action === "expire") {
      const b = latest((x) => x.status === "payment_due" && !x.cancel_requested);
      if (b) { b.status = "expired"; b.hold_expires_at = null; setPayment(b, "not_due"); history(b, "hold_expired", { fixture: true }, null); notify("guest_hold_expired", b.guest_email, b.id); }
    } else if (action === "reconcile") {
      for (const b of S.bookings.filter((x) => x.status === "payment_due" && x.cancel_requested)) {
        b.status = "cancelled"; b.cancel_requested = false; b.hold_expires_at = null; setPayment(b, "not_due");
        history(b, "cancelled", { fixture: "simulated reconciliation" }, null); notify("guest_cancelled", b.guest_email, b.id);
      }
    } else if (action === "fail-event") S.failedEvents += 1;
    else if (action === "fail-next") failNext = true;
    else if (action === "reset") reset();
    else return { status: 404, html: "Not found" };
    return { status: 303, location: "/__fixture" };
  }
  if (url.pathname !== "/__fixture") return { status: 404, html: "Not found" };
  if (!accessTokens.has(ownerLink.token) || ownerLink.exp * 1000 < Date.now() + 300000) ownerLink = issueJwt();
  const owner = `/admin#access_token=${ownerLink.token}&refresh_token=fixture-refresh&expires_in=3600&expires_at=${ownerLink.exp}&token_type=bearer`;
  const guest = latest(() => true);
  const rows = S.bookings.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map((b) => `<tr><td>${esc(b.confirmation_code)}</td><td>${esc(b.guest_name)}</td><td>${esc(b.check_in)} → ${esc(b.check_out)}</td><td>${esc(b.status)}</td><td>${esc(b.payment_status)}</td><td><a href="/booking#token=${esc(encodeURIComponent(b.guest_token))}">guest page</a></td></tr>`).join("");
  const button = (action, label) => `<form method="post" action="/__fixture/${action}"><button type="submit">${esc(label)}</button></form>`;
  return { status: 200, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Synthetic contract fixture</title>
<style>body{font:15px system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}.banner{background:#fff3cd;border:2px solid #b58900;padding:12px;border-radius:8px}form{display:inline-block;margin:4px}button{padding:10px 14px;font-size:15px}table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}td,th{border:1px solid #ccc;padding:6px;text-align:left}</style></head><body>
<p class="banner" role="note"><strong>SYNTHETIC CONTRACT FIXTURE — MOCK API.</strong> In-memory fake data served to the production UI bundles. No Supabase, Stripe, or email provider is contacted; no email is sent; the owner token is fake and accepted only by this local fixture.${failNext ? " <strong>Next API request will fail.</strong>" : ""}</p>
<h1>Fixture control</h1>
<ul><li><a href="/">Guest site</a></li><li><a href="${esc(owner)}">Owner portal (fixture sign-in)</a></li>${guest ? `<li><a href="/booking#token=${esc(encodeURIComponent(guest.guest_token))}">Latest guest booking status (${esc(guest.confirmation_code)})</a></li>` : ""}</ul>
<h2>Simulations</h2>
${button("pay", "Simulate verified payment (latest approved booking)")}${button("expire", "Simulate expiry (latest unpaid hold)")}${button("reconcile", "Simulate reconciliation (cancel-requested holds)")}${button("fail-event", `Add failed payment event (now ${S.failedEvents})`)}${button("fail-next", "Fail next API request")}${button("reset", "Reset synthetic fixtures")}
<h2>Synthetic bookings</h2><table><thead><tr><th>Code</th><th>Guest</th><th>Dates</th><th>Status</th><th>Payment</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</body></html>` };
}

// ---------- static (dist only) ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json" };
const PAGES = { "/": "index.html", "/admin": "admin.html", "/booking": "booking.html" };
async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return text(res, 400, "Bad request"); }
  if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").some((s) => s.startsWith(".") )) return text(res, 404, "Not found");
  if (pathname.endsWith(".html")) {
    const clean = pathname === "/index.html" ? "/" : pathname.slice(0, -5);
    if (PAGES[clean]) { res.writeHead(308, { Location: clean + url.search }); return res.end(); }
    return text(res, 404, "Not found");
  }
  const rel = PAGES[pathname] || (pathname.startsWith("/assets/") || /^\/[\w-]+\.(css|svg|png|jpg|webp|ico|txt)$/.test(pathname) ? pathname.slice(1) : null);
  if (!rel) return text(res, 404, "Not found");
  try {
    const root = await realpath(DIST);
    const file = await realpath(path.join(root, rel));
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) return text(res, 404, "Not found");
    const bodyBuf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : bodyBuf);
  } catch { text(res, 404, "Not found"); }
}
function text(res, status, body) { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(body); }
function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Fixture": "synthetic-mock" });
  res.end(payload === undefined ? undefined : JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const requestId = `fixture_${randomBytes(6).toString("hex")}`;
  let url;
  try { url = new URL(req.url, ORIGIN); } catch { return text(res, 400, "Bad request"); }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/v1/") || url.pathname.startsWith("/__fixture")) {
      const body = await readJson(req);
      if (url.pathname.startsWith("/__fixture")) {
        const r = control(req, url, body);
        if (r.location) { res.writeHead(r.status, { Location: r.location }); return res.end(); }
        res.writeHead(r.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(r.html);
      }
      if (url.pathname.startsWith("/auth/v1/")) { const r = await handleAuth(req, url, body); return json(res, r.status || 200, r.raw); }
      const r = await handleApi(req, url, body);
      return json(res, r.status || 200, { data: r.data });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof HttpError) {
      if (url.pathname.startsWith("/auth/v1/")) return json(res, error.status, { error: error.code, error_description: error.message, msg: error.message });
      return json(res, error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) }, requestId });
    }
    console.error(`[fixture] ${requestId}`, error?.message);
    return json(res, 500, { error: { code: "internal", message: "Fixture error." }, requestId });
  }
});

try { await stat(path.join(DIST, "index.html")); } catch {
  console.error("dist/ not found. Run ./scripts/with-node.sh npm run build first.");
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log(`SYNTHETIC CONTRACT FIXTURE (mock API) on ${ORIGIN}`);
  console.log(`Control page: ${ORIGIN}/__fixture`);
});
