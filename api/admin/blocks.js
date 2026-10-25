import { getQuery, handleError, methodNotAllowed, readJsonBody, sendJson } from "../_lib/http.js";
import { callRpc, requireAdmin, supabaseAdmin } from "../_lib/supabase.js";
import { normalizeBlockInput } from "../_lib/validation.js";

export default async function handler(request, response) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return methodNotAllowed(response, ["GET", "POST", "DELETE"]);
  try {
    const user = await requireAdmin(request);
    if (request.method === "GET") {
      const blocks = await supabaseAdmin("/rest/v1/blocked_dates?select=*&order=start_date.asc");
      return sendJson(response, 200, { blocks });
    }
    if (request.method === "POST") {
      const input = normalizeBlockInput(await readJsonBody(request));
      const result = await callRpc("create_date_block", {
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_reason: input.reason,
        p_created_by: user.id
      });
      const block = Array.isArray(result) ? result[0] : result;
      return sendJson(response, 201, { block });
    }
    const { id } = getQuery(request);
    if (!id) return sendJson(response, 400, { error: "Block id is required", code: "INVALID_DELETE" });
    await supabaseAdmin(`/rest/v1/blocked_dates?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return sendJson(response, 200, { deleted: true });
  } catch (error) {
    handleError(response, error);
  }
}
