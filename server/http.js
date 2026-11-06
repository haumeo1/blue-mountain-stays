// Server-only HTTP helpers. Never imported by browser code.
import { randomUUID } from "node:crypto";

export const RAW_BODY_LIMIT = 1024 * 1024;
export const JSON_BODY_LIMIT = 64 * 1024;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class HttpError extends Error {
  constructor(status, message, code = "internal", details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = String(code).toLowerCase();
    this.details = details;
  }
}

// One server-generated UUID per request. Incoming x-request-id is accepted only if it is a UUID.
export function getRequestId(request) {
  if (request && typeof request.requestId === "string") return request.requestId;
  const incoming = request?.headers?.["x-request-id"];
  const id = typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();
  if (request && typeof request === "object") request.requestId = id;
  return id;
}

export function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}

export function sendJson(response, status, payload) {
  setSecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function sendData(response, status, data) {
  sendJson(response, status, { data });
}

export function sendError(response, request, status, code, message, fields) {
  const error = { code: String(code).toLowerCase(), message };
  if (fields && typeof fields === "object") error.fields = fields;
  sendJson(response, status, { error, requestId: getRequestId(request) });
}

export function methodNotAllowed(response, methods, request) {
  response.setHeader("Allow", methods.map((method) => method.toUpperCase()).join(", "));
  sendError(response, request, 405, "method_not_allowed", "Method not allowed");
}

// Legacy handlers call handleError(response, error); new ones pass the request for a stable requestId.
export function handleError(response, error, request) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "internal";
  const message = known ? error.message : "Something went wrong";
  const requestId = getRequestId(request);
  if (status >= 500) console.error(`[${requestId}] ${status} ${code}${known ? "" : ` ${error?.name || "Error"}`}`);
  if (response.headersSent) return response.end();
  const fields = known && error.details?.fields ? error.details.fields : undefined;
  sendError(response, { requestId }, status, code, message, fields);
}
export { handleError as error };

// Collects via "data"/"end" events (not the async iterator): Vercel's Node helpers consume the
// real stream, then replay the exact raw bytes by overriding on/addListener("data"|"end") and read().
function collectBody(request, limit) {
  const declared = Number(request.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, "Request body is too large", "payload_too_large"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error) reject(error); else resolve(value);
    };
    request.on("data", (chunk) => {
      if (done) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) return finish(new HttpError(413, "Request body is too large", "payload_too_large"));
      chunks.push(buffer);
    });
    request.on("end", () => finish(null, Buffer.concat(chunks, size)));
    request.on("error", () => finish(new HttpError(400, "Request body could not be read", "bad_request")));
  });
}

function sizedBuffer(value, limit) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (buffer.length > limit) throw new HttpError(413, "Request body is too large", "payload_too_large");
  return buffer;
}

const RAW_UNAVAILABLE = () => new HttpError(400, "Raw request body is unavailable", "bad_request");

// Exact bytes for signature verification (Stripe). Never reserialises a parsed body.
// Deliberately never evaluates a `body` getter: on Vercel, request.body is a lazy accessor that
// JSON.parses the payload, which would destroy the exact bytes. Only an own *data* property holding
// a Buffer/string (tests, adapters that pre-buffer raw bytes) is used directly; otherwise the stream
// (or Vercel's replay of it) is read.
export async function readRawBody(request, limit = RAW_BODY_LIMIT) {
  const descriptor = Object.getOwnPropertyDescriptor(request, "body");
  if (descriptor && "value" in descriptor) {
    const body = descriptor.value;
    if (Buffer.isBuffer(body) || typeof body === "string") {
      const buffer = sizedBuffer(body, limit);
      if (!buffer.length) throw RAW_UNAVAILABLE();
      return buffer;
    }
    if (body !== undefined && body !== null) throw RAW_UNAVAILABLE();
  }
  // A natively consumed stream will never emit "end" again; only a replaying wrapper (own `on`) can.
  if (request.readableEnded && !Object.prototype.hasOwnProperty.call(request, "on")) throw RAW_UNAVAILABLE();
  const buffer = await collectBody(request, limit);
  if (!buffer.length) throw RAW_UNAVAILABLE();
  return buffer;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseJsonObject(text) {
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new HttpError(400, "Request body must be valid JSON", "bad_request");
  }
  return checkedObject(parsed);
}

// Rejects arrays/null/class instances and any "__proto__" key (at any depth) so later merges can't pollute prototypes.
function hasProtoKey(value, depth = 0) {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => hasProtoKey(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.keys(value).some((key) => key === "__proto__" || hasProtoKey(value[key], depth + 1));
  }
  return false;
}

function checkedObject(value) {
  if (!isPlainObject(value) || hasProtoKey(value)) throw new HttpError(400, "Request body must be a JSON object", "bad_request");
  return value;
}

export function requireJsonContentType(request) {
  const type = String(request.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Content-Type must be application/json", "unsupported_media_type");
}

export async function readJsonBody(request, { limit = JSON_BODY_LIMIT, requireContentType = MUTATION_METHODS.has(request.method) } = {}) {
  if (requireContentType) requireJsonContentType(request);
  // A pre-parsed body (e.g. Vercel's lazy JSON getter) is acceptable here; it may throw on bad JSON.
  let body;
  try { body = request.body; } catch {
    throw new HttpError(400, "Request body must be valid JSON", "bad_request");
  }
  if (Buffer.isBuffer(body)) {
    if (body.length > limit) throw new HttpError(413, "Request body is too large", "payload_too_large");
    return parseJsonObject(body.toString("utf8"));
  }
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > limit) throw new HttpError(413, "Request body is too large", "payload_too_large");
    return parseJsonObject(body);
  }
  if (body !== undefined) {
    checkedObject(body); // rejects pre-parsed null too
    let size;
    try { size = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch {
      throw new HttpError(400, "Request body must be valid JSON", "bad_request");
    }
    if (size > limit) throw new HttpError(413, "Request body is too large", "payload_too_large");
    return body;
  }
  return parseJsonObject((await collectBody(request, limit)).toString("utf8"));
}

export function getQuery(request) {
  if (request.query) return request.query;
  const url = new URL(request.url || "/", "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

function isDeployment() {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

// Returns exact origin or throws. Never consults Host / X-Forwarded-* headers.
export function getBaseUrl() {
  const configured = process.env.PUBLIC_SITE_URL;
  if (configured) {
    let url;
    try { url = new URL(configured); } catch { url = null; }
    const valid = url && url.protocol === "https:" && !url.username && !url.password
      && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash
      && !configured.includes("?") && !configured.includes("#")
      && configured.replace(/\/$/, "") === url.origin;
    if (valid) return url.origin;
    if (isDeployment()) throw new HttpError(500, "Site address is not configured", "internal");
  } else if (isDeployment()) {
    throw new HttpError(500, "Site address is not configured", "internal");
  }
  const rawPort = process.env.PORT || "3000";
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new HttpError(500, "Site address is not configured", "internal");
  }
  return `http://127.0.0.1:${Number(rawPort)}`;
}

// Browser mutations carry Origin; it must match the canonical origin. API clients with
// bearer tokens and no Origin are allowed (CSRF needs ambient credentials, which we don't use).
export function assertSameOrigin(request) {
  if (!MUTATION_METHODS.has(request.method)) return;
  const origin = request.headers?.origin;
  if (origin === undefined) return;
  if (typeof origin !== "string" || origin !== getBaseUrl()) throw new HttpError(403, "Request origin is not allowed", "forbidden");
}
