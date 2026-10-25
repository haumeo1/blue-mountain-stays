import test from "node:test";
import assert from "node:assert/strict";
import { bookingEvent, blockEvent, createCalendar } from "../api/_lib/ics.js";

test("creates a valid all-day booking calendar", () => {
  const calendar = createCalendar([bookingEvent({
    id: "booking-1",
    confirmation_code: "BMH-1234",
    guest_name: "Ada, Inc.",
    guest_count: 4,
    check_in: "2099-05-01",
    check_out: "2099-05-04",
    status: "confirmed",
    created_at: "2099-01-01T00:00:00.000Z"
  })]);
  assert.match(calendar, /BEGIN:VCALENDAR\r\n/);
  assert.match(calendar, /DTSTART;VALUE=DATE:20990501/);
  assert.match(calendar, /DTEND;VALUE=DATE:20990504/);
  assert.match(calendar, /Ada\\, Inc\./);
  assert.match(calendar, /STATUS:CONFIRMED/);
  assert.match(calendar, /END:VCALENDAR\r\n$/);
});

test("marks cancelled stays and owner blocks", () => {
  assert.ok(bookingEvent({ id: "b", check_in: "2099-01-01", check_out: "2099-01-02", status: "cancelled" }).includes("STATUS:CANCELLED"));
  assert.ok(bookingEvent({ id: "p", check_in: "2099-01-01", check_out: "2099-01-02", status: "pending" }).includes("STATUS:TENTATIVE"));
  assert.ok(blockEvent({ id: "x", start_date: "2099-01-03", end_date: "2099-01-04", reason: "Repairs" }).some((line) => line.includes("Blocked")));
});
