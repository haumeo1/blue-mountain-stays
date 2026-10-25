import { methodNotAllowed, sendJson } from "../_lib/http.js";

export default function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (process.env.STRIPE_ENABLED !== "true") {
    return sendJson(response, 503, { error: "Stripe webhooks are disabled", code: "STRIPE_NOT_ENABLED" });
  }
  return sendJson(response, 501, {
    error: "Webhook signature verification must be implemented before payments are enabled.",
    code: "STRIPE_IMPLEMENTATION_REQUIRED"
  });
}
