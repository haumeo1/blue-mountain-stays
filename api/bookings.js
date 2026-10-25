import { getBaseUrl, handleError, methodNotAllowed, readJsonBody, sendJson } from "./_lib/http.js";
import { callRpc } from "./_lib/supabase.js";
import { normalizeBookingInput } from "./_lib/validation.js";

export default async function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  try {
    const input = normalizeBookingInput(await readJsonBody(request));
    const result = await callRpc("create_booking", {
      p_check_in: input.checkIn,
      p_check_out: input.checkOut,
      p_guest_count: input.guests,
      p_guest_name: input.guestName,
      p_guest_email: input.guestEmail,
      p_guest_phone: input.guestPhone || null,
      p_guest_notes: input.guestNotes || null
    });
    const booking = Array.isArray(result) ? result[0] : result;
    sendJson(response, 201, {
      booking: {
        id: booking.id,
        confirmationCode: booking.confirmation_code,
        checkIn: booking.check_in,
        checkOut: booking.check_out,
        guests: booking.guest_count,
        totalCents: booking.total_cents,
        currency: booking.currency,
        status: booking.status,
        calendarUrl: `${getBaseUrl(request)}/api/calendar/booking?id=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(booking.calendar_token)}`
      }
    });
  } catch (error) {
    handleError(response, error);
  }
}
