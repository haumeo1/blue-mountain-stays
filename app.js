const seededListings = [
  {
    id: "forest-frame",
    title: "Forest Frame Cabin",
    location: "The Blue Mountains, Ontario",
    type: ["Cabin", "Hot tub"],
    badge: "Guest favourite",
    rating: 4.96,
    reviews: 128,
    price: 385,
    guests: 4,
    bedrooms: 2,
    image: "https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?auto=format&fit=crop&w=1200&q=86",
    description: "A quiet cedar cabin framed by old-growth trees, with a wood stove and a private hot tub."
  },
  {
    id: "alpine-house",
    title: "The Alpine House",
    location: "Blue Mountain Village, Ontario",
    type: ["Ski-in / ski-out", "Hot tub"],
    badge: "Slope-side",
    rating: 4.91,
    reviews: 84,
    price: 520,
    guests: 8,
    bedrooms: 4,
    image: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=1200&q=86",
    description: "A refined slope-side chalet with room for the whole crew and après-ski views from the spa."
  },
  {
    id: "georgian-glass",
    title: "Glass House on the Bay",
    location: "Thornbury, Ontario",
    type: ["Pet-friendly"],
    badge: "Waterfront",
    rating: 4.98,
    reviews: 62,
    price: 465,
    guests: 6,
    bedrooms: 3,
    image: "https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?auto=format&fit=crop&w=1200&q=86",
    description: "Floor-to-ceiling Georgian Bay views, a private beach, and a long table made for lingering dinners."
  },
  {
    id: "pine-and-peak",
    title: "Pine & Peak Studio",
    location: "Collingwood, Ontario",
    type: ["Cabin", "Pet-friendly"],
    badge: "New this week",
    rating: 4.88,
    reviews: 34,
    price: 245,
    guests: 2,
    bedrooms: 1,
    image: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=86",
    description: "A compact, sun-filled studio with Nordic details, minutes from cafés and the escarpment."
  },
  {
    id: "cedar-sauna",
    title: "Cedar Sauna Retreat",
    location: "Grey Highlands, Ontario",
    type: ["Cabin", "Hot tub"],
    badge: "Wellness pick",
    rating: 4.94,
    reviews: 76,
    price: 335,
    guests: 4,
    bedrooms: 2,
    image: "https://images.unsplash.com/photo-1510798831971-661eb04b3739?auto=format&fit=crop&w=1200&q=86",
    description: "A secluded hideaway with a barrel sauna, cold plunge, and windows looking into the forest."
  },
  {
    id: "orchard-loft",
    title: "Loft Above the Orchard",
    location: "Meaford, Ontario",
    type: ["Pet-friendly"],
    badge: "Countryside",
    rating: 4.90,
    reviews: 49,
    price: 295,
    guests: 3,
    bedrooms: 1,
    image: "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=1200&q=86",
    description: "A serene loft on a working orchard with sunrise decks and the Bruce Trail close by."
  }
];

const currency = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" });
const state = {
  listings: [...seededListings, ...readStore("nn-host-listings", [])],
  bookings: readStore("nn-bookings", []),
  saved: readStore("nn-saved", []),
  activeFilter: "All",
  query: "",
  guests: 1
};

const grid = document.querySelector("#listing-grid");
const emptyState = document.querySelector("#empty-state");
const bookingModal = document.querySelector("#booking-modal");
const tripsDrawer = document.querySelector("#trips-drawer");
const hostDrawer = document.querySelector("#host-drawer");
const toast = document.querySelector("#toast");

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function writeStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function dateOffset(days) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function initializeDates() {
  const checkin = document.querySelector("#check-in");
  const checkout = document.querySelector("#check-out");
  checkin.min = dateOffset(1);
  checkout.min = dateOffset(2);
  checkin.value = dateOffset(14);
  checkout.value = dateOffset(17);
}

function filteredListings() {
  const normalized = state.query.toLowerCase();
  return state.listings.filter((listing) => {
    const matchesFilter = state.activeFilter === "All" || listing.type.includes(state.activeFilter);
    const matchesQuery = !normalized || `${listing.title} ${listing.location}`.toLowerCase().includes(normalized) || normalized.includes("blue mountain");
    const matchesGuests = listing.guests >= state.guests;
    return matchesFilter && matchesQuery && matchesGuests;
  });
}

function renderListings() {
  const listings = filteredListings();
  grid.innerHTML = listings.map((listing) => `
    <article class="listing-card">
      <div class="listing-image" data-book="${listing.id}" tabindex="0" role="button" aria-label="Book ${escapeHtml(listing.title)}">
        <img src="${escapeAttr(listing.image)}" alt="${escapeAttr(listing.title)}" loading="lazy" />
        <span class="listing-badge">${escapeHtml(listing.badge)}</span>
        <button class="heart-button ${state.saved.includes(listing.id) ? "saved" : ""}" type="button" data-save="${listing.id}" aria-label="Save ${escapeAttr(listing.title)}">${state.saved.includes(listing.id) ? "♥" : "♡"}</button>
      </div>
      <div class="listing-body">
        <h3>${escapeHtml(listing.title)}</h3>
        <span class="listing-rating">★ ${listing.rating.toFixed(2)}</span>
        <span class="listing-location">${escapeHtml(listing.location)}</span>
        <span class="listing-meta">${listing.bedrooms} bed · ${listing.guests} guests</span>
        <span class="listing-price"><strong>${currency.format(listing.price)}</strong> / night</span>
      </div>
    </article>
  `).join("");
  emptyState.hidden = listings.length > 0;
  grid.hidden = listings.length === 0;
}

function openBooking(id) {
  const listing = state.listings.find((item) => item.id === id);
  if (!listing) return;
  document.querySelector("#booking-listing-id").value = listing.id;
  document.querySelector("#booking-title").textContent = listing.title;
  document.querySelector("#booking-location").textContent = `${listing.location} · Up to ${listing.guests} guests`;
  document.querySelector("#booking-image").src = listing.image;
  document.querySelector("#booking-image").alt = listing.title;
  const inField = document.querySelector("#booking-checkin");
  const outField = document.querySelector("#booking-checkout");
  inField.min = dateOffset(1);
  outField.min = dateOffset(2);
  inField.value = document.querySelector("#check-in").value || dateOffset(14);
  outField.value = document.querySelector("#check-out").value || dateOffset(17);
  const guestSelect = document.querySelector("#booking-guests");
  guestSelect.innerHTML = Array.from({ length: listing.guests }, (_, i) => `<option value="${i + 1}">${i + 1} guest${i ? "s" : ""}</option>`).join("");
  guestSelect.value = Math.min(state.guests, listing.guests);
  updatePriceBreakdown();
  showLayer(bookingModal);
  setTimeout(() => document.querySelector("#booking-checkin").focus(), 50);
}

function updatePriceBreakdown() {
  const listing = state.listings.find((item) => item.id === document.querySelector("#booking-listing-id").value);
  if (!listing) return;
  const checkin = new Date(`${document.querySelector("#booking-checkin").value}T12:00:00`);
  const checkout = new Date(`${document.querySelector("#booking-checkout").value}T12:00:00`);
  const nights = Math.max(1, Math.round((checkout - checkin) / 86400000) || 1);
  const stay = nights * listing.price;
  const service = Math.round(stay * .11);
  document.querySelector("#price-breakdown").innerHTML = `
    <div class="price-row"><span>${currency.format(listing.price)} × ${nights} night${nights === 1 ? "" : "s"}</span><span>${currency.format(stay)}</span></div>
    <div class="price-row"><span>Guest service fee</span><span>${currency.format(service)}</span></div>
    <div class="price-row total"><span>Total CAD</span><span>${currency.format(stay + service)}</span></div>
  `;
  return { nights, stay, service, total: stay + service };
}

function submitBooking(event) {
  event.preventDefault();
  const listing = state.listings.find((item) => item.id === document.querySelector("#booking-listing-id").value);
  const checkIn = document.querySelector("#booking-checkin").value;
  const checkOut = document.querySelector("#booking-checkout").value;
  if (!checkIn || !checkOut || new Date(checkOut) <= new Date(checkIn)) {
    showToast("Check-out must be after check-in.");
    return;
  }
  const duplicate = state.bookings.some((booking) => booking.listingId === listing.id && checkIn < booking.checkOut && checkOut > booking.checkIn);
  if (duplicate) {
    showToast("Those demo dates overlap an existing reservation.");
    return;
  }
  const price = updatePriceBreakdown();
  state.bookings.unshift({
    id: `booking-${Date.now()}`,
    listingId: listing.id,
    title: listing.title,
    image: listing.image,
    checkIn,
    checkOut,
    guests: Number(document.querySelector("#booking-guests").value),
    total: price.total,
    guest: "Demo Guest",
    status: "Confirmed"
  });
  writeStore("nn-bookings", state.bookings);
  updateCounts();
  updateHostDashboard();
  hideLayer(bookingModal);
  showToast(`${listing.title} is booked — see it in Trips.`);
}

function renderTrips() {
  const container = document.querySelector("#trips-list");
  if (!state.bookings.length) {
    container.innerHTML = `<div class="empty-trips"><span>⌂</span><strong>No trips booked yet</strong><p>Choose a stay and make a demo reservation.</p><button class="secondary-button" type="button" data-close-trips data-scroll-stays>Explore stays</button></div>`;
    return;
  }
  container.innerHTML = state.bookings.map((booking) => `
    <article class="trip-card">
      <img src="${escapeAttr(booking.image)}" alt="" />
      <div><p>${escapeHtml(booking.status)}</p><h3>${escapeHtml(booking.title)}</h3><p>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</p><p>${booking.guests} guest${booking.guests === 1 ? "" : "s"} · ${currency.format(booking.total)} CAD</p></div>
    </article>
  `).join("");
}

function updateHostDashboard() {
  document.querySelector("#host-revenue").textContent = currency.format(state.bookings.reduce((sum, item) => sum + item.total, 0));
  document.querySelector("#host-bookings").textContent = state.bookings.length;
  document.querySelector("#host-listings").textContent = state.listings.length;
  const reservations = document.querySelector("#host-reservations");
  if (!state.bookings.length) {
    reservations.innerHTML = `<div class="empty-trips"><span>◇</span><p>Guest reservations will appear here.</p></div>`;
  } else {
    reservations.innerHTML = state.bookings.slice(0, 5).map((booking) => `<div class="reservation-item"><strong>${escapeHtml(booking.guest)} · ${escapeHtml(booking.title)}</strong><strong>${escapeHtml(booking.status)}</strong><span>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</span><span>${currency.format(booking.total)}</span></div>`).join("");
  }
}

function addListing(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const custom = {
    id: `host-${Date.now()}`,
    title: data.get("title").trim(),
    location: data.get("location").trim(),
    type: ["Cabin"],
    badge: "New listing",
    rating: 5,
    reviews: 0,
    price: Number(data.get("price")),
    guests: Number(data.get("guests")),
    bedrooms: Math.max(1, Math.ceil(Number(data.get("guests")) / 2)),
    image: data.get("image").trim(),
    description: data.get("description").trim()
  };
  state.listings.unshift(custom);
  const hostListings = state.listings.filter((item) => item.id.startsWith("host-"));
  writeStore("nn-host-listings", hostListings);
  event.currentTarget.reset();
  event.currentTarget.closest("details").open = false;
  updateHostDashboard();
  renderListings();
  showToast(`${custom.title} was added to your demo marketplace.`);
}

function toggleSaved(id) {
  state.saved = state.saved.includes(id) ? state.saved.filter((item) => item !== id) : [...state.saved, id];
  writeStore("nn-saved", state.saved);
  renderListings();
  showToast(state.saved.includes(id) ? "Saved to your favourites." : "Removed from favourites.");
}

function showLayer(layer) {
  layer.hidden = false;
  document.body.classList.add("modal-open");
}

function hideLayer(layer) {
  layer.hidden = true;
  if ([bookingModal, tripsDrawer, hostDrawer].every((item) => item.hidden)) document.body.classList.remove("modal-open");
}

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function updateCounts() {
  document.querySelectorAll(".trip-count").forEach((item) => item.textContent = state.bookings.length);
}

function formatDate(value) { return dateFormat.format(new Date(`${value}T12:00:00`)); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function escapeAttr(value = "") { return escapeHtml(value); }

document.addEventListener("click", (event) => {
  const bookTarget = event.target.closest("[data-book]");
  const saveTarget = event.target.closest("[data-save]");
  if (saveTarget) { event.stopPropagation(); toggleSaved(saveTarget.dataset.save); return; }
  if (bookTarget) openBooking(bookTarget.dataset.book);
  if (event.target.closest("[data-close-modal]")) hideLayer(bookingModal);
  if (event.target.closest("[data-open-trips]")) { renderTrips(); showLayer(tripsDrawer); }
  if (event.target.closest("[data-close-trips]")) hideLayer(tripsDrawer);
  if (event.target.closest("[data-open-host]")) { updateHostDashboard(); showLayer(hostDrawer); }
  if (event.target.closest("[data-close-host]")) hideLayer(hostDrawer);
  if (event.target.closest("[data-scroll-stays]")) document.querySelector("#stays").scrollIntoView({ behavior: "smooth" });
  if (event.target.closest("[data-clear-search]")) {
    state.query = ""; state.guests = 1; state.activeFilter = "All";
    document.querySelector("#destination").value = "Blue Mountains";
    document.querySelectorAll(".filter-chip").forEach((item) => item.classList.toggle("active", item.dataset.filter === "All"));
    renderListings();
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.activeFilter = filter.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((item) => item.classList.toggle("active", item === filter));
    renderListings();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") [bookingModal, tripsDrawer, hostDrawer].forEach(hideLayer);
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-book]")) openBooking(event.target.dataset.book);
});

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.query = data.get("destination").trim();
  state.guests = Number(data.get("guests"));
  renderListings();
  document.querySelector("#stays").scrollIntoView({ behavior: "smooth" });
  showToast(`${filteredListings().length} stays match your search.`);
});
document.querySelector("#booking-form").addEventListener("submit", submitBooking);
document.querySelector("#booking-checkin").addEventListener("change", () => {
  const checkout = document.querySelector("#booking-checkout");
  checkout.min = document.querySelector("#booking-checkin").value;
  updatePriceBreakdown();
});
document.querySelector("#booking-checkout").addEventListener("change", updatePriceBreakdown);
document.querySelector("#listing-form").addEventListener("submit", addListing);

initializeDates();
renderListings();
renderTrips();
updateCounts();
updateHostDashboard();
