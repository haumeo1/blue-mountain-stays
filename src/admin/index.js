// Owner portal entry. Bundled to dist/assets/admin.js. Must not import server/, api/, or secrets.
// Protected data is fetched only after Supabase reports a session; the server authorises every call.
import { loadConfig } from "../shared/api.js";
import { initAuth, currentSession, sendMagicLink, signOut } from "./client.js";
import { $, $$, announce, busy } from "./ui.js";
import { loadOverview, loadBookings, openBooking, initBookings } from "./bookings.js";
import { loadAvailability, initAvailability } from "./availability.js";
import { loadPricing, initPricing } from "./pricing.js";
import { loadContent, initContent } from "./content.js";
import { loadPayments, initPayments } from "./payments.js";
import { loadNotifications, initNotifications, loadSettings, initSettings } from "./ops.js";

const VIEWS = {
  overview: ["Overview", loadOverview],
  bookings: ["Bookings", loadBookings],
  availability: ["Availability", loadAvailability],
  pricing: ["Pricing", loadPricing],
  property: ["Property", loadContent],
  payments: ["Payments", loadPayments],
  notifications: ["Notifications", loadNotifications],
  settings: ["Settings", loadSettings]
};
// rejectedUser: a user the API refused (401/403) in this page; late auth callbacks for them are ignored.
const state = { signedIn: false, initialised: false, view: null, rejectedUser: null };

function currentView() {
  const name = location.hash.slice(1);
  return VIEWS[name] ? name : "overview";
}

function showView(name, { reload = true } = {}) {
  state.view = name;
  for (const key of Object.keys(VIEWS)) $(`#view-${key}`).hidden = key !== name;
  $$("#admin-nav a").forEach((a) => { if (a.dataset.view === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("#breadcrumb").textContent = VIEWS[name][0];
  $("#admin-nav a[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (reload && state.signedIn) VIEWS[name][1]();
}

function showLogin(message = "") {
  state.signedIn = false;
  $("#app").hidden = true;
  $("#auth-view").hidden = false;
  $("#auth-message").textContent = message;
  for (const dialog of $$("dialog")) if (dialog.open) dialog.close();
}

async function enterApp(session) {
  if (state.signedIn || failing) return;
  if (state.rejectedUser && session?.user?.id === state.rejectedUser) return;
  // A deferred auth callback may arrive after sign-out; re-check the live session first.
  const live = await currentSession();
  if (!live || live.user?.id !== session?.user?.id || state.signedIn || failing) return;
  state.signedIn = true;
  $("#admin-email").textContent = session.user?.email || "Owner";
  $("#auth-view").hidden = true;
  $("#app").hidden = false;
  if (!state.initialised) {
    state.initialised = true;
    initBookings(); initAvailability(); initPricing(); initContent(); initPayments(); initNotifications(); initSettings();
  }
  showView(currentView());
}

let failing = false;
async function handleAuthFailure(error) {
  if (failing || !state.signedIn) return;
  failing = true;
  const session = await currentSession();
  if (session?.user?.id) state.rejectedUser = session.user.id;
  let message = error.status === 403 ? "This account isn't an approved administrator." : "Your session has expired. Please sign in again.";
  showLogin(message);
  // The token was rejected, so a server-side sign-out may fail; clearing this tab's session is what matters.
  const cleared = await signOut({ scope: "local" });
  if (!cleared) message += " We couldn't clear the saved session in this tab — close the tab to finish signing out.";
  showLogin(message);
  failing = false;
}

function readAuthErrorFromUrl() {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  if (!params.get("error") && !params.get("error_code")) return "";
  history.replaceState(null, "", location.pathname);
  return params.get("error_code") === "otp_expired" ? "That sign-in link has expired. Request a new one." : "That sign-in link couldn't be used. Request a new one.";
}

async function initialize() {
  const linkError = readAuthErrorFromUrl();
  let config;
  try { config = await loadConfig(); }
  catch (error) {
    showLogin(error.message || "The server couldn't be reached. Refresh to try again.");
    $("#login-form button").disabled = true;
    return;
  }
  $("#demo-banner").hidden = config.demoMode !== true;
  try {
    initAuth(config, {
      onSession: (event, session) => {
        // A fresh sign-in (new magic link) lifts the rejection; token refreshes for a rejected user don't.
        if (event === "SIGNED_IN" && session?.user?.id !== state.rejectedUser) state.rejectedUser = null;
        if (session) enterApp(session);
        else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") { if (state.signedIn) showLogin("You have been signed out."); else showLogin($("#auth-message").textContent); }
      },
      onAuthFailure: handleAuthFailure
    });
  } catch (error) {
    showLogin(error.message);
    $("#login-form button").disabled = true;
    return;
  }
  const session = await currentSession();
  if (session) await enterApp(session);
  else showLogin(linkError);
  if (location.hash.includes("access_token")) history.replaceState(null, "", `${location.pathname}#overview`);
}

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const email = $("#login-email").value.trim();
  busy(form, async () => {
    $("#auth-message").textContent = "Sending your secure link…";
    try {
      await sendMagicLink(email);
      $("#auth-message").textContent = "Check your inbox for the sign-in link. Only approved admin accounts can open the dashboard.";
    } catch (error) { $("#auth-message").textContent = error.message; }
  });
});

$("#logout-button").addEventListener("click", async (event) => {
  const cleared = await busy(event.currentTarget, () => signOut());
  showLogin(cleared === false
    ? "We couldn't clear your session in this tab. Close the tab to finish signing out."
    : "You have been signed out.");
});

window.addEventListener("hashchange", () => { if (state.signedIn && VIEWS[location.hash.slice(1)]) { showView(currentView()); $("#main").focus({ preventScroll: true }); } });

document.addEventListener("click", (event) => {
  const reload = event.target.closest("[data-reload]");
  if (reload && state.signedIn) { busy(reload, () => VIEWS[reload.dataset.reload][1]()).then(() => announce("Refreshed.")); }
  const open = event.target.closest("[data-open-booking]");
  if (open && state.signedIn) openBooking(open.dataset.openBooking);
  const close = event.target.closest("dialog [data-close]");
  if (close) close.closest("dialog").close();
});

$("#today").textContent = new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
initialize();
