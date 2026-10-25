import { getQuery, handleError, methodNotAllowed, readJsonBody, sendJson } from "../_lib/http.js";
import { callRpc, requireAdmin, supabaseAdmin } from "../_lib/supabase.js";

const STATUSES = new Set(["pending", "confirmed", "cancelled", "completed"]);

export default async function handler(request, response) {
  if (!["GET", "PATCH"].includes(request.method)) return methodNotAllowed(response, ["GET", "PATCH"]);
  try {
    await requireAdmin(request);
    if (request.method === "GET") {
      const query = getQuery(request);
      const statusFilter = query.status && STATUSES.has(query.status) ? `&status=eq.${query.status}` : "";
      const rows = await supabaseAdmin(`/rest/v1/bookings?select=*&order=check_in.asc${statusFilter}`);
      return sendJson(response, 200, { bookings: rows });
    }

    const body = await readJsonBody(request);
    if (!body.id || !STATUSES.has(body.status)) {
      return sendJson(response, 400, { error: "A booking id and valid status are required", code: "INVALID_UPDATE" });
    }
    const result = await callRpc("set_booking_status", {
      p_booking_id: body.id,
      p_status: body.status
    });
    const booking = Array.isArray(result) ? result[0] : result;
    return sendJson(response, 200, { booking });
  } catch (error) {
    handleError(response, error);
  }
}
