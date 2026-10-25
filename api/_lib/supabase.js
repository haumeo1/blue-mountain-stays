import { HttpError } from "./http.js";

export function databaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && getPublishableKey() && getSecretKey());
}

export function publicSupabaseConfig() {
  return {
    url: process.env.SUPABASE_URL || "",
    publishableKey: getPublishableKey()
  };
}

function getPublishableKey() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
}

function getSecretKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function requireDatabase() {
  if (!databaseConfigured()) {
    throw new HttpError(503, "Online booking is not configured yet", "DATABASE_NOT_CONFIGURED");
  }
}

export async function supabaseAdmin(path, options = {}) {
  requireDatabase();
  const secretKey = getSecretKey();
  const legacyAuthorization = secretKey.startsWith("eyJ") ? { Authorization: `Bearer ${secretKey}` } : {};
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: secretKey,
      ...legacyAuthorization,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const conflict = response.status === 409 || data?.code === "23P01" || data?.message?.includes("not available");
    const missing = data?.message?.includes("Booking not found");
    throw new HttpError(conflict ? 409 : missing ? 404 : 502, conflict ? "Those dates are no longer available" : missing ? "Booking not found" : "Database request failed", conflict ? "DATES_UNAVAILABLE" : missing ? "NOT_FOUND" : "DATABASE_ERROR");
  }
  return data;
}

export async function callRpc(name, payload) {
  return supabaseAdmin(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(payload) });
}

export async function requireAdmin(request) {
  requireDatabase();
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "Sign in is required", "UNAUTHENTICATED");
  const accessToken = authorization.slice(7);
  const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: getPublishableKey(), Authorization: `Bearer ${accessToken}` }
  });
  if (!userResponse.ok) throw new HttpError(401, "Your session has expired", "UNAUTHENTICATED");
  const user = await userResponse.json();
  if (!user?.id || user.role !== "authenticated") throw new HttpError(401, "Your session is not valid", "UNAUTHENTICATED");
  const rows = await supabaseAdmin(`/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (!rows?.length) throw new HttpError(403, "This account is not an administrator", "FORBIDDEN");
  return user;
}
