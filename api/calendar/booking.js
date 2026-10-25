import { createCalendar, bookingEvent } from "../_lib/ics.js";
import { getQuery, handleError, HttpError, methodNotAllowed, setSecurityHeaders } from "../_lib/http.js";
import { supabaseAdmin } from "../_lib/supabase.js";

export default async function handler(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const { id, token } = getQuery(request);
    if (!id || !token) throw new HttpError(404, "Calendar event not found", "NOT_FOUND");
    const rows = await supabaseAdmin(`/rest/v1/bookings?select=id,confirmation_code,check_in,check_out,guest_count,status,created_at,updated_at&id=eq.${encodeURIComponent(id)}&calendar_token=eq.${encodeURIComponent(token)}&limit=1`);
    if (!rows?.length) {
      response.statusCode = 404;
      return response.end("Calendar event not found");
    }
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${rows[0].confirmation_code}.ics"`);
    response.end(createCalendar([bookingEvent(rows[0])], { name: "Blue Mountain House stay" }));
  } catch (error) {
    handleError(response, error);
  }
}
