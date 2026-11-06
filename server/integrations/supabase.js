// Server-only Supabase access. The secret (service) key never leaves this module.
import { createClient } from "@supabase/supabase-js";
import { HttpError } from "../http.js";

export const DB_TIMEOUT_MS = 10_000;

// Every SDK request is bounded to 10s, composed with any caller-provided signal.
export function timedFetch(input, init = {}) {
  const timeout = AbortSignal.timeout(DB_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: timedFetch }
};
let client = null;

function getUrl() {
  return process.env.SUPABASE_URL || "";
}

function getPublishableKey() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
}

function getSecretKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

export function databaseConfigured() {
  return Boolean(getUrl() && getPublishableKey() && getSecretKey());
}

export function publicSupabaseConfig() {
  return { url: getUrl(), publishableKey: getPublishableKey() };
}

function unavailable() {
  return new HttpError(503, "Online booking is not available right now", "service_unavailable");
}

function requireDatabase() {
  if (!databaseConfigured()) throw unavailable();
}

// Lazy privileged client (service key). Server-side only.
export function getDatabase() {
  if (client) return client;
  requireDatabase();
  client = createClient(getUrl(), getSecretKey(), CLIENT_OPTIONS);
  return client;
}

// Test hook: drop the cached client (e.g. after env changes) or inject a fake.
export function setDatabaseForTesting(fake = null) {
  client = fake;
}

// Known database messages (exact match) → safe client errors. Everything else is a sanitized 502.
const KNOWN_ERRORS = {
  dates_unavailable: [409, "dates_unavailable", "Those dates are no longer available"],
  "Dates are not available": [409, "dates_unavailable", "Those dates are no longer available"],
  booking_disabled: [403, "booking_disabled", "Online booking is currently disabled"],
  quote_expired: [409, "quote_expired", "This quote has expired. Please request a new one"],
  quote_stale: [409, "quote_invalid", "This quote is no longer valid. Please request a new one"],
  quote_used: [409, "quote_invalid", "This quote has already been used"],
  quote_not_found: [404, "quote_invalid", "This quote is no longer valid. Please request a new one"],
  idempotency_conflict: [409, "conflict", "This request conflicts with an earlier one"],
  invalid_transition: [409, "conflict", "That action is not allowed for this booking"],
  stay_started: [409, "conflict", "That action is not allowed after the stay has started"],
  invalid_total: [409, "conflict", "This booking has no amount due"],
  version_conflict: [409, "version_conflict", "This item was changed elsewhere. Reload and try again"],
  booking_not_found: [404, "not_found", "Booking not found"],
  "Booking not found": [404, "not_found", "Booking not found"],
  block_not_found: [404, "not_found", "Block not found"],
  property_not_found: [404, "not_found", "Property not found"],
  forbidden: [403, "forbidden", "This account is not an administrator"],
  invalid_input: [400, "validation_failed", "Some details are invalid"],
  invalid_dates: [400, "validation_failed", "Those dates are invalid"],
  "Invalid stay dates": [400, "validation_failed", "Those dates are invalid"],
  "Invalid blocked dates": [400, "validation_failed", "Those dates are invalid"],
  invalid_guest_count: [400, "validation_failed", "The guest count is invalid"],
  "Invalid guest count": [400, "validation_failed", "The guest count is invalid"],
  invalid_nights: [400, "validation_failed", "That stay length is not allowed"],
  invalid_guest: [400, "validation_failed", "Guest details are invalid"],
  invalid_idempotency_key: [400, "validation_failed", "The request key is invalid"],
  invalid_action: [400, "validation_failed", "That action is invalid"],
  invalid_notification: [400, "validation_failed", "That notification is invalid"],
  "Invalid booking status": [400, "validation_failed", "That status is invalid"],
  "Property is not available": [409, "booking_disabled", "Online booking is currently disabled"],
  // 003 payments/refunds/events
  refund_exceeds_captured: [409, "conflict", "The refund exceeds the amount captured"],
  no_captured_payment: [409, "conflict", "This booking has no captured payment to refund"],
  refund_conflict: [409, "conflict", "This refund conflicts with an earlier one"],
  refund_state_conflict: [409, "conflict", "This refund was changed elsewhere"],
  payment_conflict: [409, "conflict", "This payment conflicts with recorded state"],
  session_conflict: [409, "conflict", "This payment conflicts with recorded state"],
  event_conflict: [409, "conflict", "This event conflicts with an earlier one"],
  payment_facts_immutable: [409, "conflict", "Recorded payment facts cannot change"],
  refund_facts_immutable: [409, "conflict", "Recorded refund facts cannot change"],
  amount_mismatch: [409, "conflict", "The amount does not match"],
  session_mismatch: [409, "conflict", "The payment session does not match"],
  refund_mismatch: [409, "conflict", "The refund does not match"],
  payment_intent_mismatch: [409, "conflict", "The payment does not match"],
  effect_type_mismatch: [409, "conflict", "The event does not match"],
  terminal_evidence_required: [409, "conflict", "That payment state is not final yet"],
  verified_event_required: [409, "conflict", "A verified payment event is required"],
  invalid_amount: [400, "validation_failed", "The amount is invalid"],
  invalid_session_id: [400, "validation_failed", "Some details are invalid"],
  invalid_session_url: [400, "validation_failed", "Some details are invalid"],
  invalid_payment_evidence: [400, "validation_failed", "Some details are invalid"],
  invalid_refund_data: [400, "validation_failed", "Some refund details are invalid"],
  invalid_refund_request: [400, "validation_failed", "Some refund details are invalid"],
  invalid_refund_evidence: [400, "validation_failed", "Some details are invalid"],
  invalid_stripe_refund_id: [400, "validation_failed", "Some details are invalid"],
  invalid_event: [400, "validation_failed", "Some details are invalid"],
  invalid_event_data: [400, "validation_failed", "Some details are invalid"],
  attempt_not_found: [404, "not_found", "Payment not found"],
  refund_not_found: [404, "not_found", "Refund not found"],
  // 004 admin/work
  notification_not_found: [404, "not_found", "Notification not found"],
  nothing_to_publish: [409, "conflict", "There are no draft changes to publish"],
  currency_locked: [409, "conflict", "Currency cannot change while bookings exist"],
  currency_mismatch: [409, "conflict", "Recorded payments use a different currency; review payments manually"],
  lease_lost: [409, "conflict", "This job was taken by another worker"],
  // 005 legacy access
  legacy_access_conflict: [409, "conflict", "Guest access for this booking was already set up differently"],
  not_legacy_booking: [409, "conflict", "This booking is not a legacy booking"]
};

export function mapDatabaseError(error) {
  if (error instanceof HttpError) return error;
  const message = typeof error?.message === "string" ? error.message : "";
  const known = Object.hasOwn(KNOWN_ERRORS, message) ? KNOWN_ERRORS[message] : null;
  if (known) return new HttpError(known[0], known[2], known[1]);
  if (error?.code === "23P01") return new HttpError(409, KNOWN_ERRORS.dates_unavailable[2], "dates_unavailable");
  // Log only the SQLSTATE-style code; never message/details/hint (may contain SQL or PII).
  const code = typeof error?.code === "string" && /^[A-Z0-9]{1,8}$/.test(error.code) ? error.code : "unknown";
  console.error(`database error code=${code}`);
  return new HttpError(502, "The booking service is unavailable. Please try again", "internal");
}

// For SDK results: `{ data, error }` → data, or throws a mapped HttpError.
export function dbResult(result) {
  if (result?.error) throw mapDatabaseError(result.error);
  return result?.data ?? null;
}

export async function callRpc(name, args = {}) {
  const database = getDatabase();
  let result;
  try { result = await database.rpc(name, args); } catch {
    throw unavailable();
  }
  return dbResult(result);
}

// Strict "Bearer <token>" parsing. Returns null when absent/malformed.
export function extractBearerToken(request) {
  const header = request?.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  return match && match[1].length <= 4096 ? match[1] : null;
}

function isAuthRejection(error) {
  const status = Number(error?.status);
  if (error?.name === "AuthSessionMissingError") return true;
  return status >= 400 && status < 500 && status !== 429;
}

// Order matters: no token → 401 before touching the database config or network.
export async function requireAdmin(request) {
  const token = extractBearerToken(request);
  if (!token) throw new HttpError(401, "Sign in is required", "unauthorized");
  const database = getDatabase();

  let userResult;
  try { userResult = await database.auth.getUser(token); } catch {
    throw unavailable();
  }
  if (userResult?.error) {
    if (isAuthRejection(userResult.error)) throw new HttpError(401, "Your session has expired. Please sign in again", "unauthorized");
    throw unavailable();
  }
  const user = userResult?.data?.user;
  if (!user?.id) throw new HttpError(401, "Your session has expired. Please sign in again", "unauthorized");

  let membership;
  try {
    membership = await database.from("admin_users").select("user_id").eq("user_id", user.id).limit(1).maybeSingle();
  } catch {
    throw unavailable();
  }
  if (membership?.error) throw unavailable();
  if (!membership?.data) throw new HttpError(403, "This account is not an administrator", "forbidden");
  return user;
}

// Legacy PostgREST helper for routes not yet migrated to the SDK. Remove with those routes.
export async function supabaseAdmin(path, options = {}) {
  requireDatabase();
  const secretKey = getSecretKey();
  const legacyAuthorization = secretKey.startsWith("eyJ") ? { Authorization: `Bearer ${secretKey}` } : {};
  let response;
  try {
    response = await timedFetch(`${getUrl()}${path}`, {
      ...options,
      headers: { apikey: secretKey, ...legacyAuthorization, "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch {
    throw unavailable();
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    if (response.status === 409) throw new HttpError(409, KNOWN_ERRORS.dates_unavailable[2], "dates_unavailable");
    throw mapDatabaseError(data || { code: String(response.status) });
  }
  return data;
}
