// Public (guest) application services. Returns contract payloads (the `data` value).
import { createHash, createHmac } from "node:crypto";
import { HttpError, getBaseUrl } from "../http.js";
import { demoModeEnabled } from "../config.js";
import { databaseConfigured, extractBearerToken, publicSupabaseConfig } from "../integrations/supabase.js";
import { deterministicCalendarToken, deterministicGuestToken, hashToken } from "../integrations/tokens.js";
import {
  EMAIL, claimsBetween, contentOut, database, dateRange, getAttemptForBooking, getProperty, integer, invalid,
  onlyKeys, rpc, run, safeGuestBooking, safeHttpsUrl, text, uuid
} from "./data.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:-]{16,128}$/;
const GUEST_TOKEN = /^guest_[A-Za-z0-9_-]{43}$/;

// GET /api/config. Never throws for a missing database: booking is simply disabled.
export async function publicConfig(db) {
  const { url, publishableKey } = publicSupabaseConfig();
  const base = { supabaseUrl: url, supabasePublishableKey: publishableKey, demoMode: demoModeEnabled(), bookingEnabled: false };
  if (!databaseConfigured() && !db) return base;
  try {
    const property = await getProperty(db);
    return { ...base, bookingEnabled: Boolean(property.active && property.booking_enabled) };
  } catch {
    return base;
  }
}

// GET /api/property. Published content only; never draft content or owner_email.
export async function publicProperty(db) {
  const p = await getProperty(db);
  if (!p.active) throw new HttpError(404, "Property not found", "not_found");
  return {
    property: { name: p.name, timezone: p.timezone, currency: p.currency, max_guests: p.max_guests, booking_enabled: Boolean(p.booking_enabled) },
    content: contentOut(p.published_content, { nullIfEmpty: true })
  };
}

// GET /api/availability?from&to. Merged unavailable ranges; no ids, labels, or kinds.
export async function availability(query = {}, db) {
  const { start, end } = dateRange(query.from, query.to);
  const property = await getProperty(db);
  const claims = await claimsBetween(start, end, db, property.id);
  const ranges = [];
  for (const c of claims.sort((a, b) => a.start.localeCompare(b.start))) {
    const last = ranges.at(-1);
    if (last && c.start <= last.end) { if (c.end > last.end) last.end = c.end; }
    else ranges.push({ start: c.start, end: c.end, type: "unavailable" });
  }
  return { ranges };
}

// Client identity for rate limiting: Vercel's own header on Vercel, else the socket. Never
// arbitrary X-Forwarded-For. Stored only as a keyed hash.
function clientAddress(request) {
  if (process.env.VERCEL) {
    const header = request?.headers?.["x-vercel-forwarded-for"];
    const first = typeof header === "string" ? header.split(",")[0].trim() : "";
    if (first) return first.slice(0, 64);
  }
  return String(request?.socket?.remoteAddress || "unknown").slice(0, 64);
}

export async function rateLimit(request, endpoint, limit, db, seconds = 60) {
  const secret = process.env.GUEST_TOKEN_SECRET;
  const material = `${endpoint}:${clientAddress(request)}`;
  const digest = secret && secret.length >= 32
    ? createHmac("sha256", secret).update(`ratelimit:${material}`).digest("hex")
    : createHash("sha256").update(`ratelimit:${material}`).digest("hex");
  const allowed = await rpc("manager_rate_limit", { p_key: `${endpoint}:${digest}`, p_limit: limit, p_seconds: seconds }, db);
  if (allowed !== true) throw new HttpError(429, "Too many requests. Please wait a minute and try again", "rate_limited");
}

// POST /api/quotes → { quote }
export async function quote(body, request, db) {
  onlyKeys(body, ["check_in", "check_out", "guest_count"]);
  const { start, end } = dateRange(body.check_in, body.check_out, { fromField: "check_in", toField: "check_out", max: 365 });
  const guestCount = integer(body.guest_count, "guest_count", { min: 1, max: 100 });
  await rateLimit(request, "quote", 20, db);
  const result = await rpc("manager_quote", { p_check_in: start, p_check_out: end, p_guest_count: guestCount }, db);
  return { quote: result };
}

function normalizeGuest(body) {
  const email = text(body.guest_email, "guest_email", { max: 254, min: 3 }).toLowerCase();
  if (!EMAIL.test(email)) throw invalid("guest_email", "Enter a valid email address");
  return {
    name: text(body.guest_name, "guest_name", { max: 100, min: 1 }).replace(/\s+/g, " "),
    email,
    phone: text(body.guest_phone, "guest_phone", { max: 40 }),
    notes: text(body.guest_notes, "guest_notes", { max: 1000 })
  };
}

// POST /api/bookings → { booking, guest_token }. Replays with the same key+body return the same booking.
export async function requestBooking(body, request, db) {
  onlyKeys(body, ["quote_id", "guest_name", "guest_email", "guest_phone", "guest_notes", "idempotency_key"]);
  const quoteId = uuid(body.quote_id, "quote_id");
  const guest = normalizeGuest(body);
  const key = body.idempotency_key;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) throw invalid("idempotency_key", "Invalid request key");
  await rateLimit(request, "booking", 5, db);

  // Canonical payload (fixed key order) binds quote + guest + key.
  const canonical = JSON.stringify([quoteId, guest.name, guest.email, guest.phone, guest.notes, key]);
  const guestToken = deterministicGuestToken(key);
  const row = await rpc("manager_request", {
    p_quote_id: quoteId, p_guest: guest, p_key: key,
    p_hash: createHash("sha256").update(canonical).digest("hex"),
    p_guest_hash: hashToken(guestToken), p_calendar_hash: hashToken(deterministicCalendarToken(key))
  }, db);
  return { booking: { id: row.id, ...safeGuestBooking(row) }, guest_token: guestToken };
}

// Resolves the bearer guest token to the INTERNAL booking row (for payments service). Calendar tokens are rejected.
export async function requireGuest(request, db) {
  const token = extractBearerToken(request);
  if (!token || !GUEST_TOKEN.test(token)) throw new HttpError(401, "This booking link is invalid or has expired", "unauthorized");
  const { data } = await run(database(db).from("bookings").select("*").eq("guest_access_hash", hashToken(token)).maybeSingle());
  if (!data) throw new HttpError(401, "This booking link is invalid or has expired", "unauthorized");
  return data;
}

const PAYMENT_PASSTHROUGH = new Set(["processing", "paid", "partially_refunded", "refunded", "failed"]);
export function guestPaymentStatus(booking) {
  if (PAYMENT_PASSTHROUGH.has(booking.payment_status)) return booking.payment_status;
  return booking.status === "payment_due" && booking.payment_status === "unpaid" ? "payment_due" : "not_due";
}

// GET /api/guest/booking
export async function guestBooking(request, db) {
  const booking = await requireGuest(request, db);
  const status = guestPaymentStatus(booking);
  const attempt = ["paid", "partially_refunded", "refunded"].includes(status) ? await getAttemptForBooking(booking.id, db) : null;
  const calendarUrl = booking.idempotency_key
    ? `${getBaseUrl()}/api/calendar/guest?token=${encodeURIComponent(deterministicCalendarToken(booking.idempotency_key))}`
    : null;
  return {
    booking: safeGuestBooking(booking),
    payment: { status, receipt_url: attempt?.receipt_url ? safeHttpsUrl(attempt.receipt_url, "stripe.com") : null },
    calendar_url: calendarUrl
  };
}
