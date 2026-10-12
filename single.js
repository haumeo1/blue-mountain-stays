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
const ownerDrawer = document.querySelector("#owner-drawer");
const lightbox = document.querySelector("#lightbox");
const toast = document.querySelector("#toast");
let galleryIndex = 0;
let toastTimer;

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function readBookings() {
  try { return JSON.parse(localStorage.getItem("blue-mountain-house-bookings")) || []; }
  catch { return []; }
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

function initializeForms() {
  const selectOptions = Array.from({ length: PROPERTY.maxGuests }, (_, index) => `<option value="${index + 1}">${index + 1} guest${index ? "s" : ""}</option>`).join("");
  document.querySelectorAll("#hero-guests, #booking-guests").forEach((select) => {
    select.innerHTML = selectOptions;
    select.value = "2";
  });

  const checkin = dateOffset(14);
  const checkout = dateOffset(17);
  document.querySelectorAll("#hero-checkin, #booking-checkin").forEach((input) => {
    input.min = dateOffset(1);
    input.value = checkin;
  });
  document.querySelectorAll("#hero-checkout, #booking-checkout").forEach((input) => {
    input.min = dateOffset(2);
    input.value = checkout;
  });
  document.querySelector("#nightly-price").textContent = currency.format(PROPERTY.nightlyRate);
  updatePrice();
  updateManageButton();
}

function calculatePrice() {
  const checkin = new Date(`${document.querySelector("#booking-checkin").value}T12:00:00`);
  const checkout = new Date(`${document.querySelector("#booking-checkout").value}T12:00:00`);
  const nights = Math.max(1, Math.round((checkout - checkin) / 86400000) || 1);
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

function checkAvailability(event) {
  event.preventDefault();
  syncHeroToBooking();
  document.querySelector("#book").scrollIntoView({ behavior: "smooth" });
  const dates = getBookingDates();
  const conflict = hasConflict(dates.checkIn, dates.checkOut);
  showToast(conflict ? "Those demo dates already have a booking on this device." : "Your dates are available in this demo.");
}

function getBookingDates() {
  return {
    checkIn: document.querySelector("#booking-checkin").value,
    checkOut: document.querySelector("#booking-checkout").value
  };
}

function hasConflict(checkIn, checkOut) {
  return readBookings().some((booking) => checkIn < booking.checkOut && checkOut > booking.checkIn);
}

function submitBooking(event) {
  event.preventDefault();
  const { checkIn, checkOut } = getBookingDates();
  if (!checkIn || !checkOut || new Date(checkOut) <= new Date(checkIn)) {
    showToast("Check-out must be after check-in.");
    return;
  }
  if (hasConflict(checkIn, checkOut)) {
    showToast("Those dates overlap an existing demo booking.");
    return;
  }
  const price = updatePrice();
  const booking = {
    id: `BMH-${Date.now().toString().slice(-6)}`,
    checkIn,
    checkOut,
    guests: Number(document.querySelector("#booking-guests").value),
    total: price.total,
    status: "Confirmed"
  };
  const bookings = [booking, ...readBookings()];
  writeBookings(bookings);
  updateManageButton();
  renderConfirmation(booking);
  renderOwnerDashboard();
  showLayer(confirmationModal);
}

function renderConfirmation(booking = readBookings()[0]) {
  if (!booking) return;
  document.querySelector("#confirmation-details").innerHTML = `
    <div><span>Confirmation</span><strong>${escapeHtml(booking.id)}</strong></div>
    <div><span>Dates</span><strong>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</strong></div>
    <div><span>Guests</span><strong>${booking.guests}</strong></div>
    <div><span>Demo total</span><strong>${currency.format(booking.total)} CAD</strong></div>
  `;
}

function updateManageButton() {
  document.querySelector("[data-manage-booking]").hidden = readBookings().length === 0;
}

function renderOwnerDashboard() {
  const bookings = readBookings();
  document.querySelector("#owner-booking-count").textContent = bookings.length;
  document.querySelector("#owner-revenue").textContent = currency.format(bookings.reduce((total, booking) => total + booking.total, 0));
  const container = document.querySelector("#owner-bookings");
  if (!bookings.length) {
    container.innerHTML = `<div class="owner-empty">No demo bookings yet.</div>`;
    return;
  }
  container.innerHTML = bookings.map((booking) => `
    <div class="reservation-row"><strong>${escapeHtml(booking.id)} · ${booking.guests} guest${booking.guests === 1 ? "" : "s"}</strong><strong>${currency.format(booking.total)}</strong><span>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</span><span>${escapeHtml(booking.status)}</span></div>
  `).join("");
}

function openGallery(index) {
  galleryIndex = index;
  const photo = PROPERTY.photos[galleryIndex];
  document.querySelector("#lightbox-image").src = photo.url;
  document.querySelector("#lightbox-image").alt = photo.alt;
  document.querySelector("#lightbox-caption").textContent = `${galleryIndex + 1} / ${PROPERTY.photos.length} · ${photo.alt}`;
  showLayer(lightbox);
}

function moveGallery(direction) {
  galleryIndex = (galleryIndex + direction + PROPERTY.photos.length) % PROPERTY.photos.length;
  openGallery(galleryIndex);
}

function showLayer(layer) {
  layer.hidden = false;
  document.body.classList.add("layer-open");
}

function hideLayer(layer) {
  layer.hidden = true;
  if ([lightbox, confirmationModal, ownerDrawer].every((item) => item.hidden)) document.body.classList.remove("layer-open");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

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
  if (event.target.closest("[data-owner]")) { renderOwnerDashboard(); showLayer(ownerDrawer); }
  if (event.target.closest("[data-close-owner]")) hideLayer(ownerDrawer);
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
  if (event.key === "Escape") [lightbox, confirmationModal, ownerDrawer].forEach(hideLayer);
  if (!lightbox.hidden && event.key === "ArrowLeft") moveGallery(-1);
  if (!lightbox.hidden && event.key === "ArrowRight") moveGallery(1);
});

applyPhotos();
initializeForms();
renderOwnerDashboard();
