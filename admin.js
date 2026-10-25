const state = { config: null, session: null, bookings: [], blocks: [], calendar: null };
const currency = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" });
const authView = document.querySelector("#auth-view");
const dashboard = document.querySelector("#dashboard");
const toast = document.querySelector("#toast");
let toastTimer;

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function readSession() {
  try { return JSON.parse(sessionStorage.getItem("bmh-admin-session")); } catch { return null; }
}

function saveSession(session) {
  state.session = session;
  if (session) sessionStorage.setItem("bmh-admin-session", JSON.stringify(session));
  else sessionStorage.removeItem("bmh-admin-session");
}

function captureMagicLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.get("access_token")) return;
  saveSession({
    accessToken: params.get("access_token"),
    refreshToken: params.get("refresh_token"),
    expiresAt: Date.now() + Number(params.get("expires_in") || 3600) * 1000
  });
  history.replaceState(null, "", location.pathname);
}

async function refreshSessionIfNeeded() {
  if (!state.session?.refreshToken || state.session.expiresAt - Date.now() > 60_000) return;
  const response = await fetch(`${state.config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: state.config.supabasePublishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.session.refreshToken })
  });
  if (!response.ok) throw new Error("Your session has expired. Please sign in again.");
  const data = await response.json();
  saveSession({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 });
}

async function api(path, options = {}) {
  await refreshSessionIfNeeded();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(state.session ? { Authorization: `Bearer ${state.session.accessToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) saveSession(null);
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function initialize() {
  state.config = await fetch("/api/config").then((response) => response.json());
  const connected = state.config.databaseConnected;
  document.querySelector("#connection-label").textContent = connected ? "Database connected" : "Setup required";
  document.querySelector("#connection-dot").classList.toggle("online", connected);
  captureMagicLink();
  state.session = readSession();
  if (!connected) {
    showAuth("Supabase is not configured. Add the environment variables from .env.example to continue.");
    document.querySelector("#login-form button").disabled = true;
    return;
  }
  if (!state.session) return showAuth();
  await loadDashboard();
}

function showAuth(message = "") {
  authView.hidden = false;
  dashboard.hidden = true;
  document.querySelector("#auth-message").textContent = message;
}

async function loadDashboard() {
  try {
    const status = document.querySelector("#status-filter").value;
    const [bookingData, blockData, calendarData] = await Promise.all([
      api(`/api/admin/bookings${status ? `?status=${status}` : ""}`),
      api("/api/admin/blocks"),
      api("/api/admin/calendar").catch(() => null)
    ]);
    state.bookings = bookingData.bookings;
    state.blocks = blockData.blocks;
    state.calendar = calendarData;
    authView.hidden = true;
    dashboard.hidden = false;
    renderDashboard();
  } catch (error) {
    showAuth(error.message);
  }
}

function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  document.querySelector("#daypart").textContent = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric" }).format(now);
  renderStats();
  renderBookings();
  renderBlocks();
  renderCalendar();
}

function renderStats() {
  const today = dateOffset(0);
  const upcoming = state.bookings.filter((booking) => booking.check_out > today && ["pending", "confirmed"].includes(booking.status));
  const confirmedValue = upcoming.filter((booking) => booking.status === "confirmed").reduce((sum, booking) => sum + booking.total_cents, 0);
  const next = [...upcoming].sort((a, b) => a.check_in.localeCompare(b.check_in))[0];
  const horizon = dateOffset(30);
  const occupiedNights = upcoming.filter((booking) => booking.status === "confirmed").reduce((sum, booking) => {
    const start = booking.check_in < today ? today : booking.check_in;
    const end = booking.check_out > horizon ? horizon : booking.check_out;
    return sum + Math.max(0, daysBetween(start, end));
  }, 0);
  document.querySelector("#stat-upcoming").textContent = upcoming.length;
  document.querySelector("#stat-revenue").textContent = currency.format(confirmedValue / 100);
  document.querySelector("#stat-arrival").textContent = next ? dateFormat.format(new Date(`${next.check_in}T12:00:00`)) : "None";
  document.querySelector("#stat-arrival-note").textContent = next ? `${next.guest_name} · ${next.guest_count} guests` : "No stay scheduled";
  document.querySelector("#stat-occupancy").textContent = `${Math.min(100, Math.round((occupiedNights / 30) * 100))}%`;
}

function renderBookings() {
  const rows = document.querySelector("#booking-rows");
  document.querySelector("#booking-empty").hidden = state.bookings.length > 0;
  rows.innerHTML = state.bookings.map((booking) => `
    <tr>
      <td><strong>${escapeHtml(booking.guest_name)}</strong><span>${escapeHtml(booking.guest_email)}${booking.guest_phone ? ` · ${escapeHtml(booking.guest_phone)}` : ""}</span></td>
      <td><strong>${formatDate(booking.check_in)} – ${formatDate(booking.check_out)}</strong><span>${booking.guest_count} guests · ${escapeHtml(booking.confirmation_code)}</span></td>
      <td><strong>${currency.format(booking.total_cents / 100)}</strong><span>${booking.nights} nights</span></td>
      <td><span class="payment-pill">${escapeHtml(booking.payment_status.replaceAll("_", " "))}</span></td>
      <td><select class="status-select" data-booking-status="${booking.id}" aria-label="Status for ${escapeHtml(booking.confirmation_code)}">${["pending", "confirmed", "cancelled", "completed"].map((status) => `<option value="${status}" ${booking.status === status ? "selected" : ""}>${capitalize(status)}</option>`).join("")}</select></td>
      <td><a class="calendar-link" href="/api/calendar/booking?id=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(booking.calendar_token)}">Download .ics</a></td>
    </tr>
  `).join("");
}

function renderBlocks() {
  const list = document.querySelector("#block-list");
  document.querySelector("#block-empty").hidden = state.blocks.length > 0;
  list.innerHTML = state.blocks.map((block) => `
    <div class="block-row"><strong>${formatDate(block.start_date)} – ${formatDate(block.end_date)}</strong><span>${escapeHtml(block.reason)}</span><button type="button" data-delete-block="${block.id}">Remove</button></div>
  `).join("");
}

function renderCalendar() {
  const code = document.querySelector("#calendar-url");
  const link = document.querySelector("#subscribe-calendar");
  if (!state.calendar) {
    code.textContent = "Add CALENDAR_FEED_TOKEN to enable the private feed";
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  code.textContent = state.calendar.httpUrl;
  link.href = state.calendar.webcalUrl;
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#login-email").value.trim();
  const message = document.querySelector("#auth-message");
  message.textContent = "Sending your secure link…";
  try {
    const redirectTo = encodeURIComponent(`${location.origin}/admin`);
    const response = await fetch(`${state.config.supabaseUrl}/auth/v1/otp?redirect_to=${redirectTo}`, {
      method: "POST",
      headers: { apikey: state.config.supabasePublishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: false, gotrue_meta_security: {} })
    });
    if (!response.ok) throw new Error("Could not send the sign-in email.");
    message.textContent = "Check your inbox for the sign-in link. Only approved admin accounts can open the dashboard.";
  } catch (error) { message.textContent = error.message; }
});

document.querySelector("#status-filter").addEventListener("change", loadDashboard);
document.querySelector("#refresh-button").addEventListener("click", async () => { await loadDashboard(); showToast("Dashboard refreshed"); });
document.querySelector("#logout-button").addEventListener("click", () => { saveSession(null); showAuth("You have been signed out."); });

document.querySelector("#block-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/blocks", { method: "POST", body: JSON.stringify({ startDate: document.querySelector("#block-start").value, endDate: document.querySelector("#block-end").value, reason: document.querySelector("#block-reason").value }) });
    event.target.reset();
    initializeBlockDates();
    await loadDashboard();
    showToast("Dates blocked");
  } catch (error) { showToast(error.message); }
});

document.addEventListener("change", async (event) => {
  const select = event.target.closest("[data-booking-status]");
  if (!select) return;
  try {
    await api("/api/admin/bookings", { method: "PATCH", body: JSON.stringify({ id: select.dataset.bookingStatus, status: select.value }) });
    await loadDashboard();
    showToast("Reservation updated");
  } catch (error) { showToast(error.message); await loadDashboard(); }
});

document.addEventListener("click", async (event) => {
  const scrollButton = event.target.closest("[data-scroll]");
  if (scrollButton) document.querySelector(`#${scrollButton.dataset.scroll}`).scrollIntoView({ behavior: "smooth" });
  const deleteButton = event.target.closest("[data-delete-block]");
  if (deleteButton) {
    try {
      await api(`/api/admin/blocks?id=${encodeURIComponent(deleteButton.dataset.deleteBlock)}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Date block removed");
    } catch (error) { showToast(error.message); }
  }
});

document.querySelector("#copy-calendar").addEventListener("click", async () => {
  if (!state.calendar) return showToast("Calendar feed is not configured");
  await navigator.clipboard.writeText(state.calendar.httpUrl);
  showToast("Private calendar link copied");
});

function initializeBlockDates() {
  document.querySelector("#block-start").min = dateOffset(0);
  document.querySelector("#block-end").min = dateOffset(1);
  document.querySelector("#block-start").value = dateOffset(7);
  document.querySelector("#block-end").value = dateOffset(8);
}

function showToast(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2800); }
function formatDate(value) { return dateFormat.format(new Date(`${value}T12:00:00`)); }
function daysBetween(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000); }
function capitalize(value) { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

initializeBlockDates();
initialize().catch((error) => showAuth(error.message));
