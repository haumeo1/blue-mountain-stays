import test from "node:test";
import assert from "node:assert/strict";
import { nightsBetween, normalizeBookingInput, normalizeBlockInput } from "../api/_lib/validation.js";

test("counts nights without local-time drift", () => {
  assert.equal(nightsBetween("2099-03-07", "2099-03-10"), 3);
});

test("normalizes a valid booking", () => {
  assert.deepEqual(normalizeBookingInput({
    checkIn: "2099-03-07",
    checkOut: "2099-03-10",
    guests: "4",
    guestName: "  Ada   Lovelace ",
    guestEmail: " ADA@EXAMPLE.COM ",
    guestPhone: " 555 1234 ",
    guestNotes: " Late   arrival "
  }), {
    checkIn: "2099-03-07",
    checkOut: "2099-03-10",
    guests: 4,
    guestName: "Ada Lovelace",
    guestEmail: "ada@example.com",
    guestPhone: "555 1234",
    guestNotes: "Late arrival"
  });
});

test("rejects invalid booking boundaries", () => {
  assert.throws(() => normalizeBookingInput({ checkIn: "2099-03-07", checkOut: "2099-03-07", guests: 2, guestName: "Ada", guestEmail: "ada@example.com" }), /between 1 and 60 nights/);
  assert.throws(() => normalizeBookingInput({ checkIn: "2099-03-07", checkOut: "2099-03-10", guests: 9, guestName: "Ada", guestEmail: "ada@example.com" }), /between 1 and 8/);
  assert.throws(() => normalizeBookingInput({ checkIn: "2099-03-07", checkOut: "2099-03-10", guests: 2, guestName: "Ada", guestEmail: "not-email" }), /valid email/);
});

test("normalizes date blocks", () => {
  assert.deepEqual(normalizeBlockInput({ startDate: "2099-04-01", endDate: "2099-04-03", reason: "  Owner   stay " }), { startDate: "2099-04-01", endDate: "2099-04-03", reason: "Owner stay" });
});
