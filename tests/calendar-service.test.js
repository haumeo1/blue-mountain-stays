// Behavioural tests for server/services/calendar.js against an in-memory PostgREST-like fake.
// No network or real providers: the fake evaluates filters over fixture rows.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../server/http.js";
import { setDatabaseForTesting } from "../server/integrations/supabase.js";
import { hashToken } from "../server/integrations/tokens.js";
import { guestCalendar, ownerCalendar, PAGE_SIZE, MAX_ROWS } from "../server/services/calendar.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const PROPERTY = { id: "7b894869-13bb-4a2d-9b2a-84a963fe8c2c", slug: "blue-mountain-house", name: "The Blue Mountain House" };
const OWNER_TOKEN = `calendar_${"o".repeat(43)}`;
const GUEST_TOKEN = `calendar_${"g".repeat(43)}`;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Fake SDK. `serverCap` simulates a hosted max-rows lower than the requested limit.
function fakeDb(tables, { serverCap = Infinity, failUpdate = false, failSelect = null } = {}) {
  const log = [];
  const from = (table) => {
    const filters = [];
    let order = null, limit = Infinity, single = false, update = null;
    const b = {
      select: () => b,
      update: (v) => { update = v; return b; },
      eq: (k, v) => (filters.push((r) => r[k] === v), b),
      is: (k, v) => (filters.push((r) => (r[k] ?? null) === v), b),
      in: (k, vs) => (filters.push((r) => vs.includes(r[k])), b),
      gte: (k, v) => (filters.push((r) => r[k] >= v), b),
      lte: (k, v) => (filters.push((r) => r[k] <= v), b),
      gt: (k, v) => (filters.push((r) => r[k] > v), b),
      order: (k, { ascending = true } = {}) => { order = [k, ascending]; return b; },
      limit: (n) => { limit = n; return b; },
      maybeSingle: () => { single = true; return b; },
      then(resolve, reject) {
        const entry = { table, update, limit };
        log.push(entry);
        if (update) return Promise.resolve(failUpdate ? { error: { message: "boom" } } : { data: null }).then(resolve, reject);
        if (failSelect === table) return Promise.resolve({ error: { message: "boom" } }).then(resolve, reject);
        let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
        if (order) rows = [...rows].sort((a, c) => (a[order[0]] < c[order[0]] ? -1 : a[order[0]] > c[order[0]] ? 1 : 0) * (order[1] ? 1 : -1));
        rows = rows.slice(0, Math.min(limit, serverCap));
        entry.returned = rows.length;
        return Promise.resolve({ data: single ? rows[0] ?? null : rows }).then(resolve, reject);
      }
    };
    return b;
  };
  return { from, log };
}

const booking = (n, extra = {}) => ({
  id: id(n), property_id: PROPERTY.id, status: "cancelled", check_in: "2026-06-01", check_out: "2026-06-03",
  confirmation_code: `BMH-${n}`, updated_at: "2026-10-01T00:00:00Z",
  guest_name: "Private Person", guest_email: "private@example.com", guest_phone: "+15551234567", guest_notes: "secret note",
  calendar_token_hash: hashToken(`calendar_${String(n).padStart(43, "x")}`), ...extra
});

function tables({ bookings = [], blocks = [], tokens } = {}) {
  return {
    properties: [PROPERTY],
    calendar_tokens: tokens ?? [{ id: id(9001), property_id: PROPERTY.id, token_hash: hashToken(OWNER_TOKEN), revoked_at: null }],
    bookings, blocked_dates: blocks
  };
}

const notFound = (e) => e instanceof HttpError && e.status === 404;
const events = (body) => body.split("BEGIN:VEVENT").slice(1);
afterEach(() => setDatabaseForTesting(null));

test("owner feed pages past the boundary and includes the latest stay hidden behind many cancellations", async () => {
  const n = PAGE_SIZE * 2 + 37;
  const bookings = Array.from({ length: n }, (_, i) => booking(i + 1));
  bookings.push(booking(n + 1, { status: "confirmed", check_in: "2026-12-20", check_out: "2026-12-27", confirmation_code: "BMH-LATEST" }));
  const db = fakeDb(tables({ bookings }));
  setDatabaseForTesting(db);
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  assert.equal(events(body).length, n + 1);
  assert.match(body, /Reference BMH-LATEST/);
  assert.ok(db.log.filter((e) => e.table === "bookings").every((e) => e.limit <= PAGE_SIZE));
});

test("a backend returning fewer rows than requested does not end the scan; only an empty page does", async () => {
  const bookings = Array.from({ length: 95 }, (_, i) => booking(i + 1, { status: "confirmed" }));
  const db = fakeDb(tables({ bookings }), { serverCap: 40 });
  setDatabaseForTesting(db);
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  assert.equal(events(body).length, 95);
  const pages = db.log.filter((e) => e.table === "bookings").map((e) => e.returned);
  assert.deepEqual(pages, [40, 40, 15, 0]);
});

test("empty tables produce a valid feed with no events", async () => {
  setDatabaseForTesting(fakeDb(tables()));
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  assert.match(body, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  assert.equal(events(body).length, 0);
});

test("exceeding the safety bound is an explicit 503, not a truncated calendar", async () => {
  const blocks = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ id: id(i + 1), property_id: PROPERTY.id,
    start_date: "2026-07-01", end_date: "2026-07-02", created_at: "2026-01-01T00:00:00Z" }));
  setDatabaseForTesting(fakeDb(tables({ blocks })));
  await assert.rejects(ownerCalendar({ token: OWNER_TOKEN }, NOW), (e) => e instanceof HttpError && e.status === 503);
});

test("database errors while paging fail closed", async () => {
  setDatabaseForTesting(fakeDb(tables({ bookings: [booking(1)] }), { failSelect: "blocked_dates" }));
  await assert.rejects(ownerCalendar({ token: OWNER_TOKEN }, NOW), (e) => e instanceof HttpError && e.status >= 500);
});

test("window and status semantics are preserved", async () => {
  const bookings = [
    booking(1, { status: "confirmed", check_in: "2025-10-01", check_out: "2025-10-05" }), // ends before window
    booking(2, { status: "confirmed", check_in: "2029-01-01", check_out: "2029-01-03" }), // starts after window
    booking(3, { status: "pending" }), booking(4, { status: "declined" }),
    booking(5, { status: "payment_due", confirmation_code: "BMH-HOLD" })
  ];
  setDatabaseForTesting(fakeDb(tables({ bookings })));
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  assert.equal(events(body).length, 1);
  assert.match(body, /SUMMARY:Hold: awaiting payment/);
  assert.match(body, /STATUS:TENTATIVE/);
});

test("owner feed has no guest contact data; cancellations are stable transparent tombstones", async () => {
  const bookings = [booking(7, { status: "cancelled" })];
  const blocks = [{ id: id(8), property_id: PROPERTY.id, start_date: "2026-08-01", end_date: "2026-08-04", created_at: "2026-02-01T00:00:00Z" }];
  setDatabaseForTesting(fakeDb(tables({ bookings, blocks })));
  const first = (await ownerCalendar({ token: OWNER_TOKEN }, NOW)).body;
  const second = (await ownerCalendar({ token: OWNER_TOKEN }, NOW + 3_600_000)).body;
  for (const leak of ["Private Person", "private@example.com", "5551234567", "secret note", "token_hash"]) assert.ok(!first.includes(leak), leak);
  assert.match(first, new RegExp(`UID:booking-${id(7)}@blue-mountain-house`));
  assert.match(first, /STATUS:CANCELLED\r\nTRANSP:TRANSPARENT/);
  assert.equal(first.match(/UID:.*/g).join(), second.match(/UID:.*/g).join());
  // All-day, exclusive DTEND (checkout day is not occupied).
  assert.match(first, /DTSTART;VALUE=DATE:20260801\r\nDTEND;VALUE=DATE:20260804/);
  assert.match(first, /DTSTART;VALUE=DATE:20260601\r\nDTEND;VALUE=DATE:20260603/);
});

test("lines fold at <=75 UTF-8 octets without splitting characters", async () => {
  setDatabaseForTesting(fakeDb({ ...tables(), properties: [{ ...PROPERTY, name: "Maison 🏔️ des Montagnes Bleues — chalet été ".repeat(4) }] }));
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  for (const line of body.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
  assert.ok(!body.includes("�"));
  assert.match(body.replace(/\r\n /g, ""), /X-WR-CALNAME:Maison 🏔️ des Montagnes/);
});

test("revoked, unknown, malformed, and wrong-property tokens are 404", async () => {
  const revoked = [{ id: id(9001), property_id: PROPERTY.id, token_hash: hashToken(OWNER_TOKEN), revoked_at: "2026-11-01T00:00:00Z" }];
  setDatabaseForTesting(fakeDb(tables({ tokens: revoked })));
  await assert.rejects(ownerCalendar({ token: OWNER_TOKEN }, NOW), notFound);
  const other = [{ id: id(9001), property_id: id(1234), token_hash: hashToken(OWNER_TOKEN), revoked_at: null }];
  setDatabaseForTesting(fakeDb(tables({ tokens: other })));
  await assert.rejects(ownerCalendar({ token: OWNER_TOKEN }, NOW), notFound);
  setDatabaseForTesting(fakeDb(tables()));
  for (const token of [undefined, "", `guest_${"a".repeat(43)}`, `calendar_${"z".repeat(43)}`, `calendar_${"o".repeat(42)}`, ["x"]]) {
    await assert.rejects(ownerCalendar({ token }, NOW), notFound);
  }
});

test("a guest calendar token cannot open the owner feed, and the guest feed is scoped to one booking", async () => {
  const mine = booking(1, { status: "confirmed", calendar_token_hash: hashToken(GUEST_TOKEN), confirmation_code: "BMH-MINE" });
  const other = booking(2, { status: "confirmed", confirmation_code: "BMH-OTHER" });
  setDatabaseForTesting(fakeDb(tables({ bookings: [mine, other] })));
  await assert.rejects(ownerCalendar({ token: GUEST_TOKEN }, NOW), notFound);
  const { body } = await guestCalendar({ token: GUEST_TOKEN });
  assert.equal(events(body).length, 1);
  assert.match(body, /BMH-MINE/);
  assert.ok(!body.includes("BMH-OTHER") && !body.includes("private@example.com") && !body.includes("Private Person"));
  await assert.rejects(guestCalendar({ token: OWNER_TOKEN }), notFound);
});

test("a failing last_used_at write does not prevent the feed", async () => {
  setDatabaseForTesting(fakeDb(tables({ bookings: [booking(1, { status: "confirmed" })] }), { failUpdate: true }));
  const { body } = await ownerCalendar({ token: OWNER_TOKEN }, NOW);
  assert.equal(events(body).length, 1);
});
