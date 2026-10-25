import { getBaseUrl, handleError, methodNotAllowed, sendJson } from "../_lib/http.js";
import { requireAdmin } from "../_lib/supabase.js";

export default async function handler(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    await requireAdmin(request);
    if (!process.env.CALENDAR_FEED_TOKEN || process.env.CALENDAR_FEED_TOKEN.length < 32) {
      return sendJson(response, 503, { error: "Calendar feed token is not configured", code: "CALENDAR_NOT_CONFIGURED" });
    }
    const httpUrl = `${getBaseUrl(request)}/api/calendar/feed?token=${encodeURIComponent(process.env.CALENDAR_FEED_TOKEN)}`;
    const webcalUrl = httpUrl.replace(/^https?:/, "webcal:");
    sendJson(response, 200, { httpUrl, webcalUrl });
  } catch (error) {
    handleError(response, error);
  }
}
