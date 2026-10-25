export function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
}

export function sendJson(response, status, payload) {
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function methodNotAllowed(response, methods) {
  response.setHeader("Allow", methods.join(", "));
  sendJson(response, 405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
}

export async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_000) throw new HttpError(413, "Request body is too large", "PAYLOAD_TOO_LARGE");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_JSON");
  }
}

export function getQuery(request) {
  if (request.query) return request.query;
  const url = new URL(request.url, "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

export function getBaseUrl(request) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const forwardedProtocol = request.headers["x-forwarded-proto"] || "http";
  const forwardedHost = request.headers["x-forwarded-host"] || request.headers.host;
  return `${forwardedProtocol}://${forwardedHost}`;
}

export class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED", details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function handleError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : "Something went wrong";
  const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
  if (status >= 500 && (!(error instanceof HttpError) || error.code !== "DATABASE_NOT_CONFIGURED")) console.error(error);
  sendJson(response, status, { error: message, code, ...(error.details ? { details: error.details } : {}) });
}
