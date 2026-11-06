// Server-only Resend transport. Never logs bodies, keys, or recipients.
import { Resend } from "resend";

export const EMAIL_TIMEOUT_MS = 10_000;
let cached;
let injected = null;

const isProduction = (env) => env.APP_ENV === "production";

export function emailConfigured(env = process.env) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  return isProduction(env) || Boolean(env.EMAIL_TEST_RECIPIENT);
}

export function getResend(env = process.env) {
  if (injected) return injected;
  if (!env.RESEND_API_KEY) throw new Error("Email is not configured");
  cached ??= new Resend(env.RESEND_API_KEY);
  return cached;
}

// Test hook (server-only): inject a fake client, or null to restore.
export function setResendForTesting(fake = null) {
  injected = fake;
  cached = undefined;
}

// Outside production every message is redirected to EMAIL_TEST_RECIPIENT; if
// it is missing we fail closed rather than mail a real guest.
export function resolveRecipient(recipient, env = process.env) {
  if (isProduction(env)) return recipient;
  if (!env.EMAIL_TEST_RECIPIENT) throw new Error("EMAIL_TEST_RECIPIENT required outside production");
  return env.EMAIL_TEST_RECIPIENT;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Email send timed out"), { retryable: true, unknownOutcome: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Throws on any non-confirmed outcome (error, timeout, or missing provider id) so the
// outbox row is NOT acknowledged. The idempotency key makes the retry safe.
export async function sendNotification({ id, recipient, subject, html, text }, client, env = process.env) {
  if (!id) throw new Error("Outbox id required");
  if (!recipient || !subject || (!html && !text)) throw Object.assign(new Error("Incomplete notification"), { retryable: false });
  if (!env.RESEND_FROM) throw new Error("RESEND_FROM required");
  const to = resolveRecipient(recipient, env);
  const resend = client ?? getResend(env);
  const tagged = isProduction(env) ? subject : `[${env.APP_ENV || "dev"}] ${subject}`;
  const result = await withTimeout(resend.emails.send(
    { from: env.RESEND_FROM, to: [to], subject: tagged, html, text },
    { idempotencyKey: `outbox/${id}` },
  ), EMAIL_TIMEOUT_MS);
  const { data, error } = result || {};
  if (error) {
    const err = new Error(`Email send failed: ${error.name || "error"}`);
    err.retryable = !["validation_error", "invalid_idempotency_key"].includes(error.name);
    throw err;
  }
  if (typeof data?.id !== "string" || !data.id) {
    throw Object.assign(new Error("Email outcome unknown"), { retryable: true, unknownOutcome: true });
  }
  return { providerId: data.id, redirected: to !== recipient };
}
