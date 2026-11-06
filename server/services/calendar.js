// iCalendar feeds. Only calendar_-scoped tokens (hash lookup); never guest_ tokens or admin sessions.
// Feeds carry no guest name, email, phone or notes.
import { HttpError } from "../http.js";
import { hashToken } from "../integrations/tokens.js";
import { database, getProperty, run } from "./data.js";

const TOKEN = /^calendar_[A-Za-z0-9_-]{43}$/;
const DOMAIN = "blue-mountain-house";
const notFound = () => new HttpError(404, "Calendar not found", "not_found");

const esc = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001F\u007F]/g, "")
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
const day = (d) => String(d).replaceAll("-", "");
const stamp = (t) => new Date(t || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const seq = (t) => Math.max(0, Math.floor(Date.parse(t || 0) / 1000) - 1_700_000_000) || 0;

function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 74) cut -= 1;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1; // keep surrogate pairs together
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

function vevent({ uid, start, end, summary, status, updated, description }) {
  return ["BEGIN:VEVENT", `UID:${esc(uid)}@${DOMAIN}`, `DTSTAMP:${stamp(updated)}`, `SEQUENCE:${seq(updated)}`,
    `DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`, `SUMMARY:${esc(summary)}`,
    ...(description ? [`DESCRIPTION:${esc(description)}`] : []), `STATUS:${status}`,
    `TRANSP:${status === "CANCELLED" ? "TRANSPARENT" : "OPAQUE"}`, "END:VEVENT"];
}

const calendar = (name, events) => `${["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Blue Mountain House//Manager//EN",
  "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(name)}`, "X-PUBLISHED-TTL:PT30M", ...events.flat(),
  "END:VCALENDAR"].map(fold).join("\r\n")}\r\n`;

const STATUS = { pending: "TENTATIVE", payment_due: "TENTATIVE", confirmed: "CONFIRMED", completed: "CONFIRMED",
  cancelled: "CANCELLED", expired: "CANCELLED", declined: "CANCELLED" };

// Keyset pagination by id ascending. A short page does NOT end the scan (hosted PostgREST may
// cap rows below our limit); only an empty page does. Exceeding the safety bound is a 503,
// never a silently truncated calendar.
export const PAGE_SIZE = 200;
export const MAX_ROWS = 10_000;
const tooLarge = () => new HttpError(503, "Calendar is temporarily unavailable", "service_unavailable");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function fetchAll(base) {
  const rows = [];
  let after = null;
  for (;;) {
    let q = base();
    if (after !== null) q = q.gt("id", after);
    const { data } = await run(q.order("id", { ascending: true }).limit(PAGE_SIZE));
    const page = Array.isArray(data) ? data : [];
    if (page.length === 0) return rows;
    const last = page[page.length - 1].id;
    if (typeof last !== "string" || (after !== null && last <= after)) throw tooLarge(); // non-advancing cursor
    rows.push(...page);
    if (rows.length > MAX_ROWS) throw tooLarge();
    after = last;
  }
}

function tokenHash(query) {
  const token = query?.token;
  if (typeof token !== "string" || !TOKEN.test(token)) throw notFound();
  return hashToken(token);
}

// GET /api/calendar/guest?token=calendar_… → {body, filename}
export async function guestCalendar(query) {
  const hash = tokenHash(query);
  const { data: b } = await run(database().from("bookings")
    .select("id,status,check_in,check_out,confirmation_code,updated_at").eq("calendar_token_hash", hash).maybeSingle());
  if (!b) throw notFound();
  const property = await getProperty();
  const event = vevent({ uid: `booking-${b.id}`, start: b.check_in, end: b.check_out, updated: b.updated_at,
    summary: `Stay at ${property.name || "Blue Mountain House"}`, status: STATUS[b.status] || "TENTATIVE",
    description: `Reference ${b.confirmation_code} (${b.status})` });
  return { body: calendar(`${property.name || "Blue Mountain House"} stay`, [event]), filename: "stay.ics" };
}

// GET /api/calendar/owner?token=calendar_… → {body, filename}. Window: past 1 year to future 2 years.
export async function ownerCalendar(query, now = Date.now()) {
  const hash = tokenHash(query);
  const db = database();
  const { data: token } = await run(db.from("calendar_tokens").select("id,property_id")
    .eq("token_hash", hash).is("revoked_at", null).maybeSingle());
  if (!token) throw notFound();
  const property = await getProperty(db);
  if (token.property_id !== property.id) throw notFound();
  // Best-effort usage stamp: a failed write must not break the subscriber's feed.
  try {
    await run(db.from("calendar_tokens").update({ last_used_at: new Date(now).toISOString() }).eq("id", token.id));
  } catch { /* ignored */ }

  const from = new Date(now - 365 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + 730 * 86_400_000).toISOString().slice(0, 10);
  const [bookings, blocks] = await Promise.all([
    fetchAll(() => db.from("bookings").select("id,status,check_in,check_out,confirmation_code,updated_at").eq("property_id", property.id)
      .in("status", ["payment_due", "confirmed", "completed", "cancelled", "expired"])
      .gte("check_out", from).lte("check_in", to)),
    fetchAll(() => db.from("blocked_dates").select("id,start_date,end_date,created_at").eq("property_id", property.id)
      .gte("end_date", from).lte("start_date", to))
  ]);
  bookings.sort((a, b) => cmp(a.check_in, b.check_in) || cmp(a.id, b.id));
  blocks.sort((a, b) => cmp(a.start_date, b.start_date) || cmp(a.id, b.id));
  const events = [
    ...bookings.map((b) => vevent({ uid: `booking-${b.id}`, start: b.check_in, end: b.check_out, updated: b.updated_at,
      summary: b.status === "payment_due" ? "Hold: awaiting payment" : STATUS[b.status] === "CANCELLED" ? "Cancelled stay" : "Reserved stay",
      status: STATUS[b.status], description: `Reference ${b.confirmation_code}` })),
    ...blocks.map((k) => vevent({ uid: `block-${k.id}`, start: k.start_date, end: k.end_date, updated: k.created_at,
      summary: "Owner block", status: "CONFIRMED" }))
  ];
  return { body: calendar(`${property.name || "Blue Mountain House"} bookings`, events), filename: "blue-mountain-house.ics" };
}
