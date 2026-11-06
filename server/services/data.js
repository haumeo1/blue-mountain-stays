// Server-only data access, mappers, and validators shared by the services.
// Rows returned by get* helpers are INTERNAL (contain PII/hashes); only the
// map*/safe* functions produce browser-facing shapes.
import { HttpError } from "../http.js";
import { getDatabase, mapDatabaseError } from "../integrations/supabase.js";

export const PROPERTY_SLUG = "blue-mountain-house";
export const BOOKING_STATUSES = ["pending", "payment_due", "confirmed", "completed", "declined", "expired", "cancelled"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const database = (db) => db ?? getDatabase();
const unavailable = () => new HttpError(503, "The booking service is unavailable. Please try again", "service_unavailable");

// Awaits an SDK builder; returns the full result ({data,count}) or throws a mapped HttpError.
export async function run(query) {
  let result;
  try { result = await query; } catch { throw unavailable(); }
  if (result?.error) throw mapDatabaseError(result.error);
  return result ?? { data: null };
}

export async function rpc(name, args, db) {
  return (await run(database(db).rpc(name, args))).data;
}

// Validation ------------------------------------------------------------------
export function invalid(field, message) {
  return new HttpError(400, "Some details are invalid", "validation_failed", { fields: { [field]: message } });
}

export function uuid(value, field = "id") {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(field, "Must be a valid id");
  return value.toLowerCase();
}

export function isoDate(value, field) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) throw invalid(field, "Use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw invalid(field, "Not a valid date");
  return value;
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function dateRange(from, to, { fromField = "from", toField = "to", max = 366 } = {}) {
  const start = isoDate(from, fromField);
  const end = isoDate(to, toField);
  const days = daysBetween(start, end);
  if (days < 1) throw invalid(toField, "Must be after the start date");
  if (days > max) throw invalid(toField, `Range is limited to ${max} days`);
  return { start, end };
}

export function enumValue(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) throw invalid(field, "Not an allowed value");
  return value;
}

// Plain text: trims, collapses control characters, enforces a length bound.
export function text(value, field, { max = 200, min = 0, optional = true } = {}) {
  if (value === undefined || value === null) {
    if (optional && min === 0) return "";
    throw invalid(field, "Required");
  }
  if (typeof value !== "string") throw invalid(field, "Must be text");
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (clean.length < min) throw invalid(field, "Required");
  if (clean.length > max) throw invalid(field, `Must be at most ${max} characters`);
  return clean;
}

export function integer(value, field, { min = 0, max = 10_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(field, `Must be a whole number from ${min} to ${max}`);
  return value;
}

export function bool(value, field) {
  if (typeof value !== "boolean") throw invalid(field, "Must be true or false");
  return value;
}

export function onlyKeys(body, allowed) {
  for (const key of Object.keys(body || {})) if (!allowed.includes(key)) throw invalid(key, "Unknown field");
}

// Query-string pagination: default 20, max 100.
export function pagination(query = {}) {
  const parse = (raw, fallback, field, max) => {
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d{1,6}$/.test(String(raw))) throw invalid(field, "Must be a positive whole number");
    return integer(Number(raw), field, { min: 1, max });
  };
  const page = parse(query.page, 1, "page", 100_000);
  const pageSize = parse(query.page_size, 20, "page_size", 100);
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

export const listOf = (items, count, { page, pageSize }) => ({ items, total: count ?? items.length, page, page_size: pageSize });

// Search term for PostgREST or(): only letters, digits, space, @ . + ' - _ survive (no commas,
// parens, quotes, *, %, or backslashes). The value is double-quoted; LIKE metachars are escaped.
export function searchPattern(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const term = String(raw).normalize("NFKC").replace(/[^\p{L}\p{N} @.+'_-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!term) return null;
  // \\_ inside a PostgREST quoted value becomes the LIKE escape \_.
  return `"*${term.replace(/_/g, "\\\\_")}*"`;
}

// Data access -----------------------------------------------------------------
export async function getProperty(db) {
  const { data } = await run(database(db).from("properties").select("*").eq("slug", PROPERTY_SLUG).maybeSingle());
  if (!data) throw new HttpError(404, "Property not found", "not_found");
  return data;
}

export async function getBooking(id, db) {
  const { data } = await run(database(db).from("bookings").select("*").eq("id", uuid(id)).maybeSingle());
  if (!data) throw new HttpError(404, "Booking not found", "not_found");
  return data;
}

export async function getAttemptForBooking(id, db) {
  const { data } = await run(database(db).from("payment_attempts").select("*").eq("booking_id", uuid(id))
    .order("created_at", { ascending: false }).limit(1).maybeSingle());
  return data ?? null;
}

// Mappers -----------------------------------------------------------------------
const stayCents = (row) => Number.isInteger(row.stay_cents) ? row.stay_cents
  : Number.isInteger(row.quote_snapshot?.lodging_cents) ? row.quote_snapshot.lodging_cents
  : row.nights * row.nightly_rate_cents;

const MONEY = (row) => ({
  stay_cents: stayCents(row), cleaning_fee_cents: row.cleaning_fee_cents, service_fee_cents: row.service_fee_cents,
  tax_cents: row.tax_cents ?? 0, total_cents: row.total_cents, currency: row.currency
});

// Admin UI allowlist. Accepts a bookings row or a manager_booking_out object.
export function mapBooking(row) {
  if (!row) return null;
  return {
    id: row.id, confirmation_code: row.confirmation_code, status: row.status, payment_status: row.payment_status,
    guest_name: row.guest_name, guest_email: row.guest_email, guest_phone: row.guest_phone ?? "", guest_notes: row.guest_notes ?? "",
    guest_count: row.guest_count, check_in: row.check_in, check_out: row.check_out, nights: row.nights, ...MONEY(row),
    hold_expires_at: row.hold_expires_at ?? null, cancel_requested: Boolean(row.cancel_requested),
    created_at: row.created_at, updated_at: row.updated_at
  };
}

// Guest-facing: no id, contact details, tokens, hashes, or idempotency data.
export function safeGuestBooking(row) {
  if (!row) return null;
  return {
    confirmation_code: row.confirmation_code, status: row.status, check_in: row.check_in, check_out: row.check_out,
    guest_count: row.guest_count, nights: row.nights, ...MONEY(row), hold_expires_at: row.hold_expires_at ?? null
  };
}

// Parses a Postgres daterange literal like "[2026-12-01,2026-12-04)" into half-open dates.
export function parseStay(value) {
  const match = /^([[(])(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})([\])])$/.exec(String(value || ""));
  if (!match) return null;
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const start = match[1] === "[" ? match[2] : shift(match[2], 1);
  const end = match[4] === ")" ? match[3] : shift(match[3], 1);
  return start < end ? { start, end } : null;
}

// Active inventory claims overlapping [start, end). Bounded.
export async function claimsBetween(start, end, db, propertyId) {
  const { data } = await run(database(db).from("inventory_claims").select("id,kind,stay,booking_id,block_id")
    .eq("property_id", propertyId).eq("active", true).overlaps("stay", `[${start},${end})`).order("stay").limit(1000));
  return (data || []).map((c) => ({ ...c, ...parseStay(c.stay) })).filter((c) => c.start);
}

// Audit details: plain JSON, depth-limited, without secrets or contact data.
const SECRET_KEY = /email|phone|token|hash|key|secret|password|notes|name/i;
export function safeDetails(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value === "string" ? value.slice(0, 300) : value;
  }
  if (depth > 3 || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeDetails(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) if (!SECRET_KEY.test(k)) out[k] = safeDetails(v, depth + 1);
  return out;
}

// Content read-side normalizer: emits only the contract fields as plain strings; drops non-https photos.
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
const list = (v, max, fn) => Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object").map(fn) : [];
// Text bounds shared with SQL 004 manager_configure('content').
export const CONTENT_LIMITS = { title: 120, hero_title: 160, amenity_title: 80, policy: 4000 };

// Same rule as SQL manager_content_out: explicit confirmation AND both policies non-blank.
// Any stored policies_complete flag is ignored; it is always derived.
export function policiesComplete(raw) {
  if (!raw || typeof raw !== "object") return false;
  const p = raw.policies && typeof raw.policies === "object" ? raw.policies : {};
  const filled = (v) => typeof v === "string" && v.trim().length > 0;
  return raw.policies_confirmed === true && filled(p.cancellation) && filled(p.house_rules);
}

export function contentOut(raw, { nullIfEmpty = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  if (nullIfEmpty && Object.keys(raw).length === 0) return null;
  const policies = raw.policies || {};
  const contact = raw.contact || {};
  const L = CONTENT_LIMITS;
  return {
    title: str(raw.title, L.title), description: str(raw.description, 5000), hero_title: str(raw.hero_title, L.hero_title),
    amenities: list(raw.amenities, 50, (a) => ({ title: str(a.title, L.amenity_title), description: str(a.description, 500) })),
    photos: list(raw.photos, 50, (p) => ({ path: typeof p.path === "string" ? p.path.slice(0, 300) : null, url: safeHttpsUrl(p.url), alt: str(p.alt, 200) }))
      .filter((p) => p.url),
    faq: list(raw.faq, 50, (f) => ({ question: str(f.question, 300), answer: str(f.answer, 2000) })),
    policies: { cancellation: str(policies.cancellation, L.policy), house_rules: str(policies.house_rules, L.policy) },
    contact: { email: str(contact.email, 254), phone: str(contact.phone, 40) },
    policies_confirmed: raw.policies_confirmed === true,
    policies_complete: policiesComplete(raw)
  };
}

export const safeError =(value) => value ? String(value).replace(/[^A-Za-z0-9 _.:()/-]/g, "").slice(0, 120) || "error" : null;

export function safeHttpsUrl(value, hostSuffix) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (hostSuffix && url.hostname !== hostSuffix && !url.hostname.endsWith(`.${hostSuffix}`)) return null;
    return url.toString();
  } catch { return null; }
}
