import { HttpError } from "./http.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseIsoDate(value, label) {
  if (!ISO_DATE.test(String(value || ""))) throw new HttpError(400, `${label} must use YYYY-MM-DD`, "INVALID_DATE");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} is not a valid date`, "INVALID_DATE");
  }
  return value;
}

export function nightsBetween(checkIn, checkOut) {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

export function normalizeBookingInput(input) {
  const checkIn = parseIsoDate(input.checkIn, "Check-in");
  const checkOut = parseIsoDate(input.checkOut, "Check-out");
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1 || nights > 60) throw new HttpError(400, "Stay must be between 1 and 60 nights", "INVALID_STAY");

  const today = new Date().toISOString().slice(0, 10);
  if (checkIn < today) throw new HttpError(400, "Check-in cannot be in the past", "INVALID_STAY");

  const guestName = cleanText(input.guestName, 100);
  const guestEmail = cleanText(input.guestEmail, 254).toLowerCase();
  const guestPhone = cleanText(input.guestPhone, 40);
  const guestNotes = cleanText(input.guestNotes, 1000);
  const guests = Number(input.guests);
  if (guestName.length < 2) throw new HttpError(400, "Please enter the guest name", "INVALID_GUEST");
  if (!EMAIL.test(guestEmail)) throw new HttpError(400, "Please enter a valid email address", "INVALID_GUEST");
  if (!Number.isInteger(guests) || guests < 1 || guests > 8) throw new HttpError(400, "Guest count must be between 1 and 8", "INVALID_GUEST");

  return { checkIn, checkOut, guests, guestName, guestEmail, guestPhone, guestNotes };
}

export function normalizeBlockInput(input) {
  const startDate = parseIsoDate(input.startDate, "Start date");
  const endDate = parseIsoDate(input.endDate, "End date");
  if (nightsBetween(startDate, endDate) < 1) throw new HttpError(400, "End date must be after start date", "INVALID_BLOCK");
  const reason = cleanText(input.reason, 200) || "Owner block";
  return { startDate, endDate, reason };
}
