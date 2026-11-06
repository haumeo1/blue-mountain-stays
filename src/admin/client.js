// Admin auth + API client. Supabase JS owns sessions (magic link, refresh, sign-out).
// Sessions live in sessionStorage (tab-scoped). No admin bypass exists in the browser.
import { createClient } from "@supabase/supabase-js";
import { apiFetch, ApiError } from "../shared/api.js";

let supabase = null;
let authFailureHandler = () => {};

export function initAuth(config, { onSession, onAuthFailure }) {
  if (supabase) return supabase;
  if (!config.supabaseUrl || !config.supabasePublishableKey) throw new ApiError("not_configured", "Sign-in isn't configured for this site.");
  supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.sessionStorage, storageKey: "bmh-admin-auth" }
  });
  authFailureHandler = onAuthFailure;
  // Single listener for the life of the page.
  supabase.auth.onAuthStateChange((event, session) => {
    // Defer to avoid calling Supabase inside its own callback.
    setTimeout(() => onSession(event, session), 0);
  });
  return supabase;
}

export async function currentSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/admin` }
  });
  if (error) throw new ApiError("auth", "We couldn't send a sign-in link to that address. Check it is an approved admin email.");
}

// Returns true once the session in this tab is cleared. A global sign-out can fail (expired token,
// network); in that case fall back to Supabase's supported local-only sign-out.
export async function signOut({ scope = "global" } = {}) {
  if (!supabase) return true;
  const attempt = async (s) => {
    try { const { error } = await supabase.auth.signOut({ scope: s }); return !error; } catch { return false; }
  };
  if (await attempt(scope)) return true;
  if (scope !== "local" && await attempt("local")) return true;
  return !(await currentSession());
}

// Authenticated admin request. 401/403 trigger the login screen; other errors stay with the section.
export async function api(path, options = {}) {
  const session = await currentSession();
  if (!session?.access_token) {
    const error = new ApiError("unauthorized", "Please sign in again.", 401);
    authFailureHandler(error);
    throw error;
  }
  try {
    return await apiFetch(path, { ...options, token: session.access_token });
  } catch (error) {
    if (error instanceof ApiError && error.isAuth) authFailureHandler(error);
    throw error;
  }
}

// Direct upload to a signed storage URL (no bearer token is sent to the storage host).
export async function uploadToSignedUrl(signedUrl, file) {
  let response;
  try { response = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file }); }
  catch { throw new ApiError("network", "The photo upload couldn't reach storage. Try again."); }
  if (!response.ok) throw new ApiError("upload_failed", "The photo upload was rejected. Try again.");
}
