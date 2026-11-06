// Guest site entry. Bundled to dist/assets/guest.js. Must not import server/, api/, or secrets.
// All prices come from POST /api/quotes; the browser never calculates a live price.
import { apiFetch, ApiError } from "../shared/api.js";
import { formatMoney, formatDate, addDays, isIsoDate, safeHttpsUrl, newIdempotencyKey } from "../shared/format.js";

// Default photography (placeholder). Published content photos replace these. Order:
// 1 exterior/hero, 2 living room, 3 kitchen, 4 bedroom, 5 outdoor space, 6 lifestyle/detail.
const DEFAULT_PHOTOS = [
  { url: "https://images.unsplash.com/photo-1601918774946-25832a4be0d6?auto=format&fit=crop&w=1800&q=88", alt: "Exterior of the Blue Mountain house in a forest setting" },
  { url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=86", alt: "Bright living room with comfortable seating" },
  { url: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=86", alt: "Modern kitchen and dining area" },
  { url: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=86", alt: "Warm, peaceful bedroom" },
  { url: "https://images.unsplash.com/photo-1523217582562-09d0def993a6?auto=format&fit=crop&w=1200&q=86", alt: "House exterior and outdoor area" },
  { url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=86", alt: "Relaxing interior detail" }
];

const $ = (selector) => document.querySelector(selector);
const lightbox = $("#lightbox");
const confirmationModal = $("#confirmation-modal");
const toast = $("#toast");

const DEFAULT_TIMEZONE = "America/Toronto";

const state = {
  mode: "loading", // loading | live | demo | unavailable
  maxGuests: 8,
  timezone: DEFAULT_TIMEZONE,
  photos: DEFAULT_PHOTOS,
  quoteExpiryTimer: 0,
  quote: null,
  quoteSeq: 0,
  quoteTimer: 0,
  submitting: false,
  idempotency: { fingerprint: "", key: "" },
  lastBooking: null
};
let galleryIndex = 0;
let toastTimer;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function clearLegacyStorage() {
  try { localStorage.removeItem("blue-mountain-house-bookings"); } catch { /* storage unavailable */ }
}

// ---------- Content ----------
// Photos fill tiles in order; tiles without a photo are hidden (no wrap-around, never modulo zero).
// With no photos at all, the hero image, gallery, and story image are hidden.
function applyPhotos() {
  const photos = state.photos;
  const set = (image, photo) => {
    if (photo) { image.src = photo.url; image.alt = photo.alt || ""; image.hidden = false; }
    else { image.removeAttribute("src"); image.alt = ""; image.hidden = true; }
  };
  set($("#hero-photo"), photos[0]);
  for (let index = 0; index < 5; index += 1) {
    set($(`#gallery-photo-${index}`), photos[index]);
    $(`#gallery-photo-${index}`).closest("button").hidden = !photos[index];
  }
  set($("#story-photo"), photos[5] || photos[photos.length - 1]);
  $(".story-image").hidden = photos.length === 0;
  $("#gallery").hidden = photos.length === 0;
  $(".hero-gallery-link").hidden = photos.length === 0;
  $(".photo-note").hidden = photos !== DEFAULT_PHOTOS;
}

function str(value) { return typeof value === "string" ? value.trim() : ""; }

function setNavVisible(hash, visible) {
  document.querySelectorAll(`a[href="${hash}"]`).forEach((a) => { a.hidden = !visible; });
}

function applyProperty(property) {
  const max = Number(property?.max_guests);
  if (Number.isInteger(max) && max >= 1 && max <= 100) {
    state.maxGuests = max;
    $("#hero-guest-badge").textContent = `Up to ${max} guest${max === 1 ? "" : "s"}`;
    $("#fact-guests").textContent = String(max);
  }
  if (isTimeZone(property?.timezone)) state.timezone = property.timezone;
  if (str(property?.name)) setPropertyName(str(property.name));
}

function setPropertyName(name) {
  document.title = `${name} — Direct booking`;
  document.querySelectorAll("[data-property-name]").forEach((node) => { node.textContent = name; });
  document.querySelectorAll("[data-property-label]").forEach((node) => node.setAttribute("aria-label", `${name} home`));
}

// Published content fully replaces the built-in defaults: anything removed in the admin is
// removed here too. Built-in defaults are used only when nothing is published (content null).
function applyContent(content) {
  if (!content || typeof content !== "object") return;
  if (str(content.title)) setPropertyName(str(content.title));
  const headline = str(content.hero_title) || str(content.title);
  if (headline) $("#hero-title").textContent = headline;
  $("#intro-lead").textContent = str(content.description);
  $("#intro-lead").hidden = !str(content.description);

  state.photos = (Array.isArray(content.photos) ? content.photos : [])
    .map((p) => ({ url: safeHttpsUrl(p?.url), alt: str(p?.alt) }))
    .filter((p) => p.url);

  const amenities = (Array.isArray(content.amenities) ? content.amenities : []).filter((a) => str(a?.title));
  $("#amenities-note").hidden = true;
  $(".amenity-grid").replaceChildren(...amenities.map((a) => el("article", {}, el("span", { "aria-hidden": "true", text: "✦" }), el("h3", { text: str(a.title) }), el("p", { text: str(a.description) }))));
  $("#amenities").hidden = amenities.length === 0;
  setNavVisible("#amenities", amenities.length > 0);

  const faqs = (Array.isArray(content.faq) ? content.faq : []).filter((f) => str(f?.question) && str(f?.answer)).map((f) => [str(f.question), str(f.answer)]);
  const policies = content.policies || {};
  if (str(policies.cancellation)) faqs.push(["What is the cancellation policy?", str(policies.cancellation)]);
  if (str(policies.house_rules)) faqs.push(["What are the house rules?", str(policies.house_rules)]);
  $(".faq-list").replaceChildren(...faqs.map(([q, a]) => el("details", {}, el("summary", {}, q, el("span", { "aria-hidden": "true", text: "＋" })), el("p", { text: a }))));

  const contact = content.contact || {};
  const parts = [];
  if (str(contact.email)) parts.push(el("a", { href: `mailto:${encodeURIComponent(str(contact.email)).replace(/%40/g, "@")}`, text: str(contact.email) }));
  if (str(contact.phone)) parts.push(el("a", { href: `tel:${str(contact.phone).replace(/[^\d+]/g, "")}`, text: str(contact.phone) }));
  const line = $("#contact-line");
  line.replaceChildren(...(parts.length ? ["Questions? Contact the host: ", ...parts.flatMap((p, i) => (i ? [" · ", p] : [p]))] : []));
  line.hidden = parts.length === 0;
  $(".faq-list").hidden = faqs.length === 0;
  $("#faq").hidden = faqs.length === 0 && parts.length === 0;
  setNavVisible("#faq", !$("#faq").hidden);
}

// ---------- Property-local dates ----------
function isTimeZone(value) {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
}
// Today's calendar date in the property's time zone (not the browser's).
function propertyToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: state.timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ---------- Booking form ----------
function initializeForms() {
  const options = () => Array.from({ length: state.maxGuests }, (_, i) => el("option", { value: String(i + 1), text: `${i + 1} guest${i ? "s" : ""}` }));
  document.querySelectorAll("#hero-guests, #booking-guests").forEach((select) => {
    const current = select.value || "2";
    select.replaceChildren(...options());
    select.value = Number(current) <= state.maxGuests ? current : "1";
  });
  const today = propertyToday();
  document.querySelectorAll("#hero-checkin, #booking-checkin").forEach((input) => { if (!input.value) input.value = addDays(today, 14); });
  document.querySelectorAll("#hero-checkout, #booking-checkout").forEach((input) => { if (!input.value) input.value = addDays(today, 17); });
  refreshDateLimits();
}

// Same-day check-in is allowed (the server decides availability). Recomputed before each quote so a
// page left open past midnight (property time) doesn't keep a stale minimum.
function refreshDateLimits() {
  const today = propertyToday();
  for (const [checkinId, checkoutId] of [["#hero-checkin", "#hero-checkout"], ["#booking-checkin", "#booking-checkout"]]) {
    const checkin = $(checkinId);
    const checkout = $(checkoutId);
    checkin.min = today;
    if (isIsoDate(checkin.value) && checkin.value < today) checkin.value = today;
    const firstOut = isIsoDate(checkin.value) ? addDays(checkin.value, 1) : addDays(today, 1);
    checkout.min = firstOut;
    if (isIsoDate(checkout.value) && checkout.value < firstOut) checkout.value = firstOut;
  }
}

function readSelection() {
  return { check_in: $("#booking-checkin").value, check_out: $("#booking-checkout").value, guest_count: Number($("#booking-guests").value) };
}
function sameSelection(a, b) { return a && b && a.check_in === b.check_in && a.check_out === b.check_out && Number(a.guest_count) === Number(b.guest_count); }
function bookable() { return state.mode === "live" || state.mode === "demo"; }

function updateSubmit() {
  const button = $("#booking-submit");
  button.disabled = !bookable() || !state.quote || state.submitting;
  button.setAttribute("aria-busy", String(state.submitting));
  button.firstChild.textContent = state.submitting ? "Sending request " : "Send booking request ";
}

function renderPriceMessage(message, tone = "") {
  const box = $("#price-breakdown");
  box.replaceChildren(el("p", { className: `price-message ${tone}`.trim(), text: message }));
  box.setAttribute("aria-busy", tone === "loading" ? "true" : "false");
}

function renderQuote(quote) {
  const row = (labelText, cents, extra = "") => el("div", { className: `price-row ${extra}`.trim() }, el("span", { text: labelText }), el("span", { text: formatMoney(cents, quote.currency) }));
  const rows = [row(`Stay · ${quote.nights} night${quote.nights === 1 ? "" : "s"}`, quote.stay_cents)];
  if (quote.cleaning_fee_cents) rows.push(row("Cleaning fee", quote.cleaning_fee_cents));
  if (quote.service_fee_cents) rows.push(row("Guest service fee", quote.service_fee_cents));
  if (quote.tax_cents) rows.push(row("Taxes", quote.tax_cents));
  rows.push(row(`Total ${quote.currency}`, quote.total_cents, "total"));
  $("#price-breakdown").replaceChildren(...rows);
  $("#price-breakdown").setAttribute("aria-busy", "false");
  const nightly = quote.nights ? Math.round(quote.stay_cents / quote.nights) : quote.stay_cents;
  $("#nightly-price").textContent = formatMoney(nightly, quote.currency);
  $("#nightly-label").textContent = "Avg / night";
}

function invalidateQuote() {
  state.quote = null;
  clearTimeout(state.quoteExpiryTimer);
  updateSubmit();
}

function quoteExpired(quote) { return !quote || !(quote.localDeadline > Date.now()); }

function scheduleQuote(delay = 300) {
  invalidateQuote();
  clearTimeout(state.quoteTimer);
  if (!bookable()) return;
  refreshDateLimits();
  const selection = readSelection();
  if (!isIsoDate(selection.check_in) || !isIsoDate(selection.check_out)) return renderPriceMessage("Choose your dates to see the full price.");
  if (selection.check_out <= selection.check_in) return renderPriceMessage("Check-out must be after check-in.", "error");
  renderPriceMessage("Updating your price…", "loading");
  state.quoteTimer = setTimeout(() => requestQuote(selection), delay);
}

async function requestQuote(selection) {
  const seq = ++state.quoteSeq;
  try {
    const data = await apiFetch("/api/quotes", { method: "POST", body: selection });
    if (seq !== state.quoteSeq || !sameSelection(selection, readSelection())) return; // stale
    const quote = data?.quote;
    if (!quote?.id || !Number.isInteger(quote.total_cents) || !sameSelection(quote, selection)) throw new ApiError("malformed", "We couldn't price those dates. Please try again.");
    // Local deadline: 15 s before expires_at, but at least 30 s from now so a fast browser clock
    // can't cause a re-quote loop. The server still rejects truly expired quotes on submit.
    const expires = Date.parse(quote.expires_at);
    const lifetime = Number.isFinite(expires) ? Math.max(30_000, expires - 15_000 - Date.now()) : 30_000;
    state.quote = { ...quote, localDeadline: Date.now() + lifetime };
    renderQuote(quote);
    // Disable the quote when it lapses and fetch a fresh one, so an expired price is never submitted.
    clearTimeout(state.quoteExpiryTimer);
    state.quoteExpiryTimer = setTimeout(() => {
      if (state.quote?.id !== quote.id || state.submitting) return;
      renderPriceMessage("Your price expired. Refreshing…", "loading");
      scheduleQuote(0);
    }, lifetime);
  } catch (error) {
    if (seq !== state.quoteSeq || !sameSelection(selection, readSelection())) return; // stale error
    state.quote = null;
    renderPriceMessage(guestMessage(error), "error");
  }
  updateSubmit();
}

function guestMessage(error) {
  const messages = {
    dates_unavailable: "Those dates aren't available. Please try another stay.",
    booking_disabled: "Online booking is paused right now. Please contact the host.",
    quote_expired: "Your price expired, so we've refreshed it. Please review and send again.",
    quote_invalid: "Your price needed refreshing. Please review and send again.",
    rate_limited: "Too many attempts. Please wait a moment and try again."
  };
  if (error instanceof ApiError) return messages[error.code] || (error.code === "validation_failed" || error.status === 422 || error.status === 400 ? error.message : error.code === "network" ? error.message : "Something went wrong. Please try again.");
  return "Something went wrong. Please try again.";
}

function readGuest() {
  return {
    guest_name: $("#guest-name").value.trim(),
    guest_email: $("#guest-email").value.trim(),
    guest_phone: $("#guest-phone").value.trim(),
    guest_notes: $("#guest-notes").value.trim()
  };
}

async function submitBooking(event) {
  event.preventDefault();
  if (!bookable()) return showToast($("#booking-mode").textContent);
  if (!state.quote || state.submitting) return;
  // The quote must still match the visible selection and be unexpired.
  if (!sameSelection(state.quote, readSelection()) || quoteExpired(state.quote)) {
    showToast("Your price needed refreshing. Please review it and send again.");
    return scheduleQuote(0);
  }
  if (!event.target.reportValidity()) return;
  const body = { quote_id: state.quote.id, ...readGuest() };
  // Same quote + same details reuse the key, so a retry after a network error can't create a duplicate.
  const fingerprint = JSON.stringify(body);
  if (state.idempotency.fingerprint !== fingerprint) state.idempotency = { fingerprint, key: newIdempotencyKey() };
  state.submitting = true;
  updateSubmit();
  try {
    const data = await apiFetch("/api/bookings", { method: "POST", body: { ...body, idempotency_key: state.idempotency.key } });
    if (!data?.booking || typeof data.guest_token !== "string") throw new ApiError("malformed", "Unexpected response");
    state.idempotency = { fingerprint: "", key: "" };
    state.lastBooking = { booking: data.booking, token: data.guest_token };
    $("[data-manage-booking]").hidden = false;
    renderConfirmation();
    showLayer(confirmationModal);
    scheduleQuote(0);
  } catch (error) {
    if (["quote_expired", "quote_invalid", "dates_unavailable"].includes(error?.code)) {
      state.idempotency = { fingerprint: "", key: "" };
      scheduleQuote(0);
    }
    showToast(guestMessage(error));
  } finally {
    state.submitting = false;
    updateSubmit();
  }
}

function renderConfirmation() {
  const record = state.lastBooking;
  if (!record) return;
  const { booking, token } = record;
  const demo = state.mode === "demo";
  $("#confirmation-eyebrow").textContent = demo ? "Demo request received" : "Booking request received";
  $("#confirmation-title").textContent = "Your request is pending.";
  $("#confirmation-copy").textContent = `${demo ? "Demo environment — no owner is notified. " : ""}The owner will review your request. Nothing is confirmed and no payment is taken until it's approved; you'll then pay securely from your booking page.`;
  const item = (name, value) => el("div", {}, el("span", { text: name }), el("strong", { text: value }));
  $("#confirmation-details").replaceChildren(
    item("Confirmation", booking.confirmation_code || "—"),
    item("Dates", `${formatDate(booking.check_in)} – ${formatDate(booking.check_out)}`),
    item("Guests", String(booking.guest_count ?? "—")),
    item("Total", formatMoney(booking.total_cents, booking.currency)),
    item("Status", "Pending owner review")
  );
  const link = $("#booking-page-link");
  link.href = `/booking#token=${encodeURIComponent(token)}`;
  link.hidden = false;
}

// ---------- Mode ----------
async function initialize() {
  clearLegacyStorage();
  applyPhotos();
  initializeForms();
  updateSubmit();
  let config = null;
  try { config = await apiFetch("/api/config"); } catch { config = null; }
  if (!config) state.mode = "unavailable";
  else if (config.bookingEnabled === false) state.mode = "unavailable";
  else state.mode = config.demoMode === true ? "demo" : "live";

  try {
    const data = await apiFetch("/api/property");
    applyProperty(data?.property);
    applyContent(data?.content);
    if (data?.property?.booking_enabled === false) state.mode = "unavailable";
    applyPhotos();
    initializeForms();
  } catch { /* keep built-in content */ }

  const messages = {
    live: "Request to book · The owner reviews every request. You pay only after approval.",
    demo: "Demo environment · Requests are handled by a test server and never reach the owner.",
    unavailable: config ? "Online booking isn't available right now. Please contact the host directly." : "We couldn't reach the booking service. Check your connection and refresh to try again."
  };
  $("#booking-mode").textContent = messages[state.mode];
  $("#booking-mode").dataset.state = state.mode;
  if (bookable()) scheduleQuote(0);
  else renderPriceMessage("Pricing appears here when online booking is available.");
}

function syncHeroToBooking() {
  $("#booking-checkin").value = $("#hero-checkin").value;
  $("#booking-checkout").value = $("#hero-checkout").value;
  $("#booking-guests").value = $("#hero-guests").value;
  scheduleQuote(0);
}

// ---------- Layers ----------
function openGallery(index) {
  if (!state.photos.length) return;
  galleryIndex = Math.min(Math.max(0, index), state.photos.length - 1);
  const photo = state.photos[galleryIndex];
  $("#lightbox-image").src = photo.url;
  $("#lightbox-image").alt = photo.alt || "";
  $("#lightbox-caption").textContent = `${galleryIndex + 1} / ${state.photos.length}${photo.alt ? ` · ${photo.alt}` : ""}`;
  showLayer(lightbox);
}
function moveGallery(direction) { if (!state.photos.length) return; openGallery((galleryIndex + direction + state.photos.length) % state.photos.length); }
function showLayer(layer) { layer.hidden = false; document.body.classList.add("layer-open"); layer.querySelector("button")?.focus(); }
function hideLayer(layer) { layer.hidden = true; if ([lightbox, confirmationModal].every((item) => item.hidden)) document.body.classList.remove("layer-open"); }
function showToast(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 4200); }

$("#hero-booking-form").addEventListener("submit", (event) => {
  event.preventDefault();
  syncHeroToBooking();
  $("#book").scrollIntoView({ behavior: "smooth" });
  if (!bookable()) showToast($("#booking-mode").textContent);
});
$("#booking-form").addEventListener("submit", submitBooking);
document.querySelectorAll("#booking-checkin, #booking-checkout, #booking-guests").forEach((input) => input.addEventListener("change", () => {
  if (input.id === "booking-checkin" && isIsoDate(input.value)) {
    const checkout = $("#booking-checkout");
    checkout.min = addDays(input.value, 1);
    if (checkout.value <= input.value) checkout.value = addDays(input.value, 1);
  }
  scheduleQuote();
}));
$("#hero-checkin").addEventListener("change", (event) => {
  const checkout = $("#hero-checkout");
  if (isIsoDate(event.target.value)) { checkout.min = addDays(event.target.value, 1); if (checkout.value <= event.target.value) checkout.value = addDays(event.target.value, 1); }
});

document.addEventListener("click", (event) => {
  const galleryTrigger = event.target.closest("[data-open-gallery]");
  if (galleryTrigger) openGallery(Number(galleryTrigger.dataset.openGallery));
  if (event.target.closest("[data-close-gallery]")) hideLayer(lightbox);
  if (event.target.closest("[data-gallery-prev]")) moveGallery(-1);
  if (event.target.closest("[data-gallery-next]")) moveGallery(1);
  if (event.target.closest("[data-close-confirmation]")) hideLayer(confirmationModal);
  if (event.target.closest("[data-manage-booking]")) { renderConfirmation(); showLayer(confirmationModal); }
  if (event.target.closest("[data-book-now]")) $("#book").scrollIntoView({ behavior: "smooth" });
  const season = event.target.closest("[data-season]");
  if (season) {
    const copy = {
      winter: "Skiing, snowshoeing, village evenings, and a warm house waiting when the lifts close.",
      summer: "Trail rides, Georgian Bay swims, patio lunches, and long evenings outdoors.",
      anytime: "Spa days, local markets, good food, and unrushed time together in every season."
    };
    document.querySelectorAll("[data-season]").forEach((button) => button.classList.toggle("active", button === season));
    $("#season-copy").textContent = copy[season.dataset.season];
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") [lightbox, confirmationModal].forEach(hideLayer);
  if (!lightbox.hidden && event.key === "ArrowLeft") moveGallery(-1);
  if (!lightbox.hidden && event.key === "ArrowRight") moveGallery(1);
});

initialize();
