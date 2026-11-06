// JSON API wrapper. Unwraps {data}, normalises {error:{code,message},requestId}.
// Never surfaces raw response bodies; messages are safe for display.
export class ApiError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = extra.fields || null;
    this.requestId = extra.requestId || null;
  }
  get isAuth() { return this.status === 401 || this.status === 403; }
}

const FALLBACK = {
  network: "We couldn't reach the server. Check your connection and try again.",
  malformed: "The server sent an unexpected response. Please try again.",
  internal: "Something went wrong on our side. Please try again shortly."
};

export async function apiFetch(path, { method = "GET", body, token, signal, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("network", FALLBACK.network);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const err = payload && typeof payload === "object" ? payload.error : null;
    const code = typeof err?.code === "string" ? err.code : response.status >= 500 ? "internal" : "bad_request";
    const message = typeof err?.message === "string" && err.message.length < 300 ? err.message : (response.status >= 500 ? FALLBACK.internal : FALLBACK.malformed);
    throw new ApiError(code, message, response.status, { fields: err?.fields, requestId: payload?.requestId });
  }
  if (!payload || typeof payload !== "object" || !("data" in payload)) throw new ApiError("malformed", FALLBACK.malformed, response.status);
  return payload.data;
}

export async function loadConfig() {
  const data = await apiFetch("/api/config");
  if (!data || typeof data !== "object") throw new ApiError("malformed", FALLBACK.malformed);
  return data;
}
