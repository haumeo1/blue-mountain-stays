import { getQuery, handleError, methodNotAllowed, sendJson } from "./_lib/http.js";
import { supabaseAdmin } from "./_lib/supabase.js";
import { parseIsoDate } from "./_lib/validation.js";

export default async function handler(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const query = getQuery(request);
    const from = parseIsoDate(query.from, "From date");
    const to = parseIsoDate(query.to, "To date");
    const [bookings, blocks] = await Promise.all([
      supabaseAdmin(`/rest/v1/bookings?select=check_in,check_out&status=eq.confirmed&check_out=gt.${from}&check_in=lt.${to}`),
      supabaseAdmin(`/rest/v1/blocked_dates?select=start_date,end_date&end_date=gt.${from}&start_date=lt.${to}`)
    ]);
    const unavailable = [
      ...bookings.map((item) => ({ start: item.check_in, end: item.check_out, type: "booking" })),
      ...blocks.map((item) => ({ start: item.start_date, end: item.end_date, type: "block" }))
    ];
    sendJson(response, 200, { unavailable });
  } catch (error) {
    handleError(response, error);
  }
}
