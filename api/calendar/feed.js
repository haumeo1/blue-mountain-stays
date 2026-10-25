import crypto from "node:crypto";
import { blockEvent, bookingEvent, createCalendar } from "../_lib/ics.js";
import { getQuery, handleError, methodNotAllowed, setSecurityHeaders } from "../_lib/http.js";
import { supabaseAdmin } from "../_lib/supabase.js";

function tokensMatch(provided, expected) {
  if (!provided || !expected || expected.length < 32) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const { token } = getQuery(request);
    if (!tokensMatch(token, process.env.CALENDAR_FEED_TOKEN)) {
      setSecurityHeaders(response);
      response.statusCode = 404;
      return response.end("Calendar not found");
    }
    const [bookings, blocks] = await Promise.all([
      supabaseAdmin("/rest/v1/bookings?select=id,confirmation_code,guest_name,guest_count,check_in,check_out,status,created_at,updated_at&status=in.(pending,confirmed,cancelled)&order=check_in.asc"),
      supabaseAdmin("/rest/v1/blocked_dates?select=id,start_date,end_date,reason,created_at&order=start_date.asc")
    ]);
    const events = [...bookings.map((item) => bookingEvent(item)), ...blocks.map((item) => blockEvent(item))];
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader("Content-Disposition", "inline; filename=blue-mountain-house.ics");
    response.setHeader("Cache-Control", "private, no-store");
    response.end(createCalendar(events));
  } catch (error) {
    handleError(response, error);
  }
}
