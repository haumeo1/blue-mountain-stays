// Availability month grid + owner blocks. All ranges are half-open [start, end).
import { api } from "./client.js";
import { $, h, announce, showError, busy, confirmDialog } from "./ui.js";
import { formatDate, addDays, todayIso, isIsoDate } from "../shared/format.js";

const state = { month: todayIso().slice(0, 7), ranges: [], seq: 0 };
const monthTitle = new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });

function monthBounds(month) {
  const start = `${month}-01`;
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { start, end: d.toISOString().slice(0, 10) };
}
function shiftMonth(delta) {
  const d = new Date(`${state.month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  state.month = d.toISOString().slice(0, 7);
  loadAvailability();
}

export async function loadAvailability() {
  const section = $("#view-availability");
  showError(section, null);
  const { start, end } = monthBounds(state.month);
  $("#month-title").textContent = monthTitle.format(new Date(`${start}T00:00:00Z`));
  const seq = ++state.seq;
  try {
    // Include the week either side so the grid edges are accurate.
    const data = await api(`/api/admin/availability?from=${addDays(start, -7)}&to=${addDays(end, 7)}`);
    if (seq !== state.seq) return;
    state.ranges = Array.isArray(data.ranges) ? data.ranges : [];
  } catch (error) {
    if (seq !== state.seq) return;
    state.ranges = [];
    showError(section, error);
  }
  render(start, end);
}

function render(start, end) {
  const first = new Date(`${start}T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const gridStart = addDays(start, -lead);
  const today = todayIso();
  const cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow" role="columnheader">${d}</div>`);
  for (let i = 0; i < 42; i += 1) {
    const day = addDays(gridStart, i);
    if (i >= 35 && day >= end) break;
    const hits = state.ranges.filter((r) => day >= r.start && day < r.end);
    const types = [...new Set(hits.map((r) => r.type))];
    const desc = hits.map((r) => `${r.type}: ${r.label || ""}`).join("; ");
    cells.push(`<div role="gridcell" class="day ${day < start || day >= end ? "outside" : ""} ${day === today ? "today" : ""} ${types.map((t) => `has-${h(t)}`).join(" ")}" aria-label="${h(formatDate(day))}${desc ? ` — ${h(desc)}` : " — available"}"><span>${Number(day.slice(8))}</span>${hits.slice(0, 2).map((r) => `<i class="tag ${h(r.type)}">${h(r.label || r.type)}</i>`).join("")}</div>`);
  }
  $("#month-grid").innerHTML = cells.join("");
  const inMonth = state.ranges.filter((r) => r.start < end && r.end > start).sort((a, b) => a.start.localeCompare(b.start));
  $("#range-list").innerHTML = inMonth.length ? inMonth.map((r) => `<li><span class="swatch ${h(r.type)}"></span><div><strong>${h(formatDate(r.start))} → ${h(formatDate(r.end))}</strong><small>${h(r.type)} · ${h(r.label || "")}</small></div>
    ${r.type === "block" && r.block_id ? `<button class="text-button danger" type="button" data-delete-block="${h(r.block_id)}">Remove</button>` : r.booking_id ? `<button class="text-button" type="button" data-open-booking="${h(r.booking_id)}">Open</button>` : ""}</li>`).join("") : `<li class="empty">Nothing booked or blocked this month.</li>`;
}

export function initAvailability() {
  $("#month-prev").addEventListener("click", () => shiftMonth(-1));
  $("#month-next").addEventListener("click", () => shiftMonth(1));
  $("#month-today").addEventListener("click", () => { state.month = todayIso().slice(0, 7); loadAvailability(); });
  const startInput = $("#block-start");
  const endInput = $("#block-end");
  startInput.min = todayIso();
  startInput.addEventListener("change", () => { if (isIsoDate(startInput.value)) { endInput.min = addDays(startInput.value, 1); if (endInput.value <= startInput.value) endInput.value = addDays(startInput.value, 1); } });

  $("#block-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const body = { start_date: startInput.value, end_date: endInput.value, reason: $("#block-reason").value.trim() };
    if (!isIsoDate(body.start_date) || !isIsoDate(body.end_date) || body.end_date <= body.start_date) return showError($("#view-availability"), { message: "End date must be after the start date." });
    busy(form, async () => {
      try {
        await api("/api/admin/blocks", { method: "POST", body });
        form.reset();
        announce(`Blocked ${formatDate(body.start_date)} to ${formatDate(body.end_date)}.`);
        state.month = body.start_date.slice(0, 7);
        await loadAvailability();
      } catch (error) { showError($("#view-availability"), error); }
    });
  });

  $("#range-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-block]");
    if (!button) return;
    const { ok } = await confirmDialog({ title: "Remove this block?", message: "These dates will become bookable again.", confirmLabel: "Remove block", danger: true });
    if (!ok) return;
    busy(button, async () => {
      try {
        await api(`/api/admin/blocks/${encodeURIComponent(button.dataset.deleteBlock)}`, { method: "DELETE" });
        announce("Block removed.");
        await loadAvailability();
      } catch (error) { showError($("#view-availability"), error); }
    });
  });
}
