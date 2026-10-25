// PROPERTY CONFIGURATION
// Replace these placeholder photo URLs later. Keep the same order:
// 1 exterior/hero, 2 living room, 3 kitchen, 4 bedroom, 5 outdoor space, 6 lifestyle/detail.
const PROPERTY = {
  name: "The Blue Mountain House",
  location: "The Blue Mountains, Ontario",
  nightlyRate: 425,
  cleaningFee: 145,
  serviceRate: 0.08,
  maxGuests: 8,
  photos: [
    { url: "https://images.unsplash.com/photo-1601918774946-25832a4be0d6?auto=format&fit=crop&w=1800&q=88", alt: "Exterior of the Blue Mountain house in a forest setting" },
    { url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=86", alt: "Bright living room with comfortable seating" },
    { url: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1200&q=86", alt: "Modern kitchen and dining area" },
    { url: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=86", alt: "Warm, peaceful bedroom" },
    { url: "https://images.unsplash.com/photo-1523217582562-09d0def993a6?auto=format&fit=crop&w=1200&q=86", alt: "House exterior and outdoor area" },
    { url: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=86", alt: "Relaxing interior detail" }
  ]
};

const currency = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" });
const bookingForm = document.querySelector("#booking-form");
const confirmationModal = document.querySelector("#confirmation-modal");
const lightbox = document.querySelector("#lightbox");
const toast = document.querySelector("#toast");
const appState = { config: null, unavailable: [] };
let galleryIndex = 0;
let toastTimer;

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function readBookings() {
  try {
    return (JSON.parse(localStorage.getItem("blue-mountain-house-bookings")) || []).map((booking) => ({
      ...booking,
      confirmationCode: booking.confirmationCode || booking.id,
      totalCents: booking.totalCents ?? Math.round((booking.total || 0) * 100)
    }));
  } catch { return []; }
}

function writeBookings(bookings) {
  localStorage.setItem("blue-mountain-house-bookings", JSON.stringify(bookings));
}

function applyPhotos() {
  const hero = document.querySelector("#hero-photo");
  hero.src = PROPERTY.photos[0].url;
  hero.alt = PROPERTY.photos[0].alt;
  for (let index = 0; index < 5; index += 1) {
    const image = document.querySelector(`#gallery-photo-${index}`);
    image.src = PROPERTY.photos[index].url;
    image.alt = PROPERTY.photos[index].alt;
  }
  const story = document.querySelector("#story-photo");
  story.src = PROPERTY.photos[5].url;
  story.alt = PROPERTY.photos[5].alt;
}

async function initialize() {
  applyPhotos();
  initializeForms();
  try {
    appState.config = await fetch("/api/config").then((response) => response.json());
  } catch {
    appState.config = { databaseConnected: false, stripeEnabled: false };
  }
  document.querySelector("#booking-mode").textContent = appState.config.databaseConnected
    ? "Secure booking request · No payment is collected at this stage."
    : "Preview mode · Connect Supabase to send real booking requests. This booking will stay on your device.";
  if (appState.config.databaseConnected) await refreshAvailability();
}

function initializeForms() {
  const selectOptions = Array.from({ length: PROPERTY.maxGuests }, (_, index) => `<option value="${index + 1}">${index + 1} guest${index ? "s" : ""}</option>`).join("");
  document.querySelectorAll("#hero-guests, #booking-guests").forEach((select) => {
    select.innerHTML = selectOptions;
    select.value = "2";
  });
  const checkin = dateOffset(14);
  const checkout = dateOffset(17);
  document.querySelectorAll("#hero-checkin, #booking-checkin").forEach((input) => { input.min = dateOffset(1); input.value = checkin; });
  document.querySelectorAll("#hero-checkout, #booking-checkout").forEach((input) => { input.min = dateOffset(2); input.value = checkout; });
  document.querySelector("#nightly-price").textContent = currency.format(PROPERTY.nightlyRate);
  updatePrice();
  updateManageButton();
}

async function refreshAvailability() {
  try {
    const response = await fetch(`/api/availability?from=${dateOffset(0)}&to=${dateOffset(400)}`);
    if (!response.ok) throw new Error();
    appState.unavailable = (await response.json()).unavailable;
  } catch {
    showToast("Live availability could not be refreshed. Final availability will be checked when you submit.");
  }
}

function calculatePrice() {
  const checkin = new Date(`${document.querySelector("#booking-checkin").value}T12:00:00`);
  const checkout = new Date(`${document.querySelector("#booking-checkout").value}T12:00:00`);
  const nights = Math.max(1, Math.round((checkout - checkin) / 86_400_000) || 1);
  const stay = nights * PROPERTY.nightlyRate;
  const service = Math.round(stay * PROPERTY.serviceRate);
  return { nights, stay, cleaning: PROPERTY.cleaningFee, service, total: stay + PROPERTY.cleaningFee + service };
}

function updatePrice() {
  const price = calculatePrice();
  document.querySelector("#price-breakdown").innerHTML = `
    <div class="price-row"><span>${currency.format(PROPERTY.nightlyRate)} × ${price.nights} night${price.nights === 1 ? "" : "s"}</span><span>${currency.format(price.stay)}</span></div>
    <div class="price-row"><span>Cleaning fee</span><span>${currency.format(price.cleaning)}</span></div>
    <div class="price-row"><span>Guest service fee</span><span>${currency.format(price.service)}</span></div>
    <div class="price-row total"><span>Total CAD</span><span>${currency.format(price.total)}</span></div>
  `;
  return price;
}

function syncHeroToBooking() {
  document.querySelector("#booking-checkin").value = document.querySelector("#hero-checkin").value;
  document.querySelector("#booking-checkout").value = document.querySelector("#hero-checkout").value;
  document.querySelector("#booking-guests").value = document.querySelector("#hero-guests").value;
  updatePrice();
}

async function checkAvailability(event) {
  event.preventDefault();
  syncHeroToBooking();
  document.querySelector("#book").scrollIntoView({ behavior: "smooth" });
  if (appState.config?.databaseConnected) await refreshAvailability();
  const dates = getBookingDates();
  showToast(hasConflict(dates.checkIn, dates.checkOut) ? "Those dates are unavailable. Try another stay." : "Those dates look available. Complete your details to request the stay.");
}

function getBookingDates() {
  return { checkIn: document.querySelector("#booking-checkin").value, checkOut: document.querySelector("#booking-checkout").value };
}

function hasConflict(checkIn, checkOut) {
  const localRanges = readBookings().filter((booking) => booking.localOnly && booking.status !== "cancelled").map((booking) => ({ start: booking.checkIn, end: booking.checkOut }));
  return [...appState.unavailable, ...localRanges].some((range) => checkIn < range.end && checkOut > range.start);
}

async function submitBooking(event) {
  event.preventDefault();
  const { checkIn, checkOut } = getBookingDates();
  if (!checkIn || !checkOut || new Date(checkOut) <= new Date(checkIn)) return showToast("Check-out must be after check-in.");
  if (hasConflict(checkIn, checkOut)) return showToast("Those dates overlap an existing reservation or owner block.");

  const price = updatePrice();
  const payload = {
    checkIn,
    checkOut,
    guests: Number(document.querySelector("#booking-guests").value),
    guestName: document.querySelector("#guest-name").value.trim(),
    guestEmail: document.querySelector("#guest-email").value.trim(),
    guestPhone: document.querySelector("#guest-phone").value.trim(),
    guestNotes: document.querySelector("#guest-notes").value.trim()
  };
  const button = document.querySelector("#booking-submit");
  button.disabled = true;
  button.firstChild.textContent = "Sending request ";
  try {
    let booking;
    if (appState.config?.databaseConnected) {
      const response = await fetch("/api/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The booking request could not be sent");
      booking = data.booking;
    } else {
      booking = {
        id: crypto.randomUUID(),
        confirmationCode: `PREVIEW-${Date.now().toString().slice(-6)}`,
        ...payload,
        totalCents: price.total * 100,
        currency: "CAD",
        status: "preview",
        localOnly: true
      };
    }
    writeBookings([booking, ...readBookings().filter((item) => item.id !== booking.id)].slice(0, 10));
    updateManageButton();
    renderConfirmation(booking);
    showLayer(confirmationModal);
    if (!booking.localOnly) await refreshAvailability();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.firstChild.textContent = "Send booking request ";
  }
}

function renderConfirmation(booking = readBookings()[0]) {
  if (!booking) return;
  const local = booking.localOnly || booking.status === "preview";
  document.querySelector("#confirmation-eyebrow").textContent = local ? "Preview booking saved" : "Booking request received";
  document.querySelector("#confirmation-copy").textContent = local
    ? "This preview is stored only on this device. Connect Supabase before accepting real reservations."
    : "No payment was collected. The owner can now review your request and confirm the stay.";
  document.querySelector("#confirmation-details").innerHTML = `
    <div><span>Confirmation</span><strong>${escapeHtml(booking.confirmationCode || booking.id)}</strong></div>
    <div><span>Dates</span><strong>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</strong></div>
    <div><span>Guests</span><strong>${booking.guests}</strong></div>
    <div><span>Total</span><strong>${currency.format((booking.totalCents || 0) / 100)} CAD</strong></div>
    <div><span>Status</span><strong>${escapeHtml(local ? "Preview only" : booking.status)}</strong></div>
  `;
  const calendarLink = document.querySelector("#booking-calendar-link");
  calendarLink.hidden = !booking.calendarUrl;
  if (booking.calendarUrl) calendarLink.href = booking.calendarUrl;
}

function updateManageButton() {
  document.querySelector("[data-manage-booking]").hidden = readBookings().length === 0;
}

function openGallery(index) {
  galleryIndex = index;
  const photo = PROPERTY.photos[galleryIndex];
  document.querySelector("#lightbox-image").src = photo.url;
  document.querySelector("#lightbox-image").alt = photo.alt;
  document.querySelector("#lightbox-caption").textContent = `${galleryIndex + 1} / ${PROPERTY.photos.length} · ${photo.alt}`;
  showLayer(lightbox);
}

function moveGallery(direction) { galleryIndex = (galleryIndex + direction + PROPERTY.photos.length) % PROPERTY.photos.length; openGallery(galleryIndex); }
function showLayer(layer) { layer.hidden = false; document.body.classList.add("layer-open"); }
function hideLayer(layer) { layer.hidden = true; if ([lightbox, confirmationModal].every((item) => item.hidden)) document.body.classList.remove("layer-open"); }
function showToast(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3600); }
function formatDate(value) { return dateFormat.format(new Date(`${value}T12:00:00`)); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

document.querySelector("#hero-booking-form").addEventListener("submit", checkAvailability);
bookingForm.addEventListener("submit", submitBooking);
document.querySelectorAll("#booking-checkin, #booking-checkout").forEach((input) => input.addEventListener("change", () => {
  if (input.id === "booking-checkin") document.querySelector("#booking-checkout").min = input.value;
  updatePrice();
}));

document.addEventListener("click", (event) => {
  const galleryTrigger = event.target.closest("[data-open-gallery]");
  if (galleryTrigger) openGallery(Number(galleryTrigger.dataset.openGallery));
  if (event.target.closest("[data-close-gallery]")) hideLayer(lightbox);
  if (event.target.closest("[data-gallery-prev]")) moveGallery(-1);
  if (event.target.closest("[data-gallery-next]")) moveGallery(1);
  if (event.target.closest("[data-close-confirmation]")) hideLayer(confirmationModal);
  if (event.target.closest("[data-manage-booking]")) { renderConfirmation(); showLayer(confirmationModal); }
  if (event.target.closest("[data-book-now]")) document.querySelector("#book").scrollIntoView({ behavior: "smooth" });
  const season = event.target.closest("[data-season]");
  if (season) {
    const copy = {
      winter: "Skiing, snowshoeing, village evenings, and a warm house waiting when the lifts close.",
      summer: "Trail rides, Georgian Bay swims, patio lunches, and long evenings outdoors.",
      anytime: "Spa days, local markets, good food, and unrushed time together in every season."
    };
    document.querySelectorAll("[data-season]").forEach((button) => button.classList.toggle("active", button === season));
    document.querySelector("#season-copy").textContent = copy[season.dataset.season];
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") [lightbox, confirmationModal].forEach(hideLayer);
  if (!lightbox.hidden && event.key === "ArrowLeft") moveGallery(-1);
  if (!lightbox.hidden && event.key === "ArrowRight") moveGallery(1);
});

initialize();
