// Browser-safe formatting helpers shared by guest and admin bundles.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
export function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ESCAPES[c]); }

const moneyFormats = new Map();
export function formatMoney(cents, currency = "CAD") {
  const key = currency || "CAD";
  if (!moneyFormats.has(key)) moneyFormats.set(key, new Intl.NumberFormat("en-CA", { style: "currency", currency: key, minimumFractionDigits: 2 }));
  return moneyFormats.get(key).format((Number(cents) || 0) / 100);
}

// "12.34" -> 1234 without float error. Returns null when invalid.
export function dollarsToCents(text) {
  const match = /^\s*(\d{1,9})(?:\.(\d{0,2}))?\s*$/.exec(String(text ?? ""));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
}
export function centsToDollars(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0));
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
export function bpsToPercent(bps) { return (Number(bps) || 0) / 100; }
export function percentToBps(text) {
  const match = /^\s*(\d{1,3})(?:\.(\d{0,2}))?\s*$/.exec(String(text ?? ""));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
}

const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" });
export function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
export function formatDate(value) { return isIsoDate(value) ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : "—"; }
export function formatDateTime(value) { const d = new Date(value); return value && !Number.isNaN(d.getTime()) ? dateTimeFormat.format(d) : "—"; }
export function addDays(iso, days) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function daysBetween(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000); }
export function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
export function label(value) { const s = String(value ?? "").replaceAll("_", " "); return s.charAt(0).toUpperCase() + s.slice(1); }

// Only allow https links to known hosts (or any https host when hosts omitted).
export function safeHttpsUrl(value, hosts) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return null;
    if (hosts && !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null;
    return url.href;
  } catch { return null; }
}

export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
