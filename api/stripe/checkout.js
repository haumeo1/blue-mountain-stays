import { methodNotAllowed, sendJson } from "../_lib/http.js";

export default function handler(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (process.env.STRIPE_ENABLED !== "true") {
    return sendJson(response, 503, {
      error: "Payments are not enabled yet. No card has been charged.",
      code: "STRIPE_NOT_ENABLED"
    });
  }
  return sendJson(response, 501, {
    error: "Stripe checkout requires implementation review before it can be enabled.",
    code: "STRIPE_IMPLEMENTATION_REQUIRED"
  });
}
