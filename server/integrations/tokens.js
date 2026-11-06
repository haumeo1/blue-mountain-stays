// Server-only capability tokens. Only hashes are stored; raw tokens travel in
// URL fragments (guest) or a calendar-scoped feed link, never other queries.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MIN_SECRET = 32;

function secret(env) {
  const value = env.GUEST_TOKEN_SECRET;
  if (typeof value !== "string" || value.length < MIN_SECRET) {
    throw new Error("GUEST_TOKEN_SECRET must be at least 32 characters");
  }
  return value;
}

function scoped(scope, idempotencyKey, env) {
  if (typeof idempotencyKey !== "string" || !idempotencyKey) throw new Error("idempotencyKey required");
  const mac = createHmac("sha256", secret(env)).update(`${scope}:${idempotencyKey}`).digest("base64url");
  return `${scope}_${mac}`;
}

export const deterministicGuestToken = (key, env = process.env) => scoped("guest", key, env);
export const deterministicCalendarToken = (key, env = process.env) => scoped("calendar", key, env);
export const randomCalendarToken = () => `calendar_${randomBytes(32).toString("base64url")}`;
export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

// Constant-time comparison of two hex sha256 hashes.
export function safeEqual(aHash, bHash) {
  if (typeof aHash !== "string" || typeof bHash !== "string") return false;
  const a = Buffer.from(aHash, "utf8");
  const b = Buffer.from(bHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const tokenMatches = (token, storedHash) => safeEqual(hashToken(token), storedHash);

export function tokenScope(token) {
  const match = /^(guest|calendar)_/.exec(String(token));
  return match ? match[1] : null;
}
