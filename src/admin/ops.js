// Notifications, calendar feed, jobs, settings, health, activity.
import { api } from "./client.js";
import { $, h, announce, showError, busy, confirmDialog, pill, renderPager, emptyRow, setFormReady } from "./ui.js";
import { formatDateTime, label, safeHttpsUrl } from "../shared/format.js";

const pages = { notifications: 1, activity: 1 };
let settingsVersion = null;

// ---------- Notifications + calendar ----------
export async function loadNotifications() {
  const section = $("#view-notifications");
  showError(section, null);
  await Promise.all([loadNotificationList(section), loadCalendar(section)]);
}

async function loadNotificationList(section) {
  try {
    const data = await api(`/api/admin/notifications?page=${pages.notifications}`);
    const items = Array.isArray(data.items) ? data.items : [];
    $("#notification-rows").innerHTML = items.length ? items.map((n) => `<tr><td>${h(label(n.template))}</td><td>${h(n.recipient)}</td><td>${pill(n.status)}</td><td>${h(n.attempts)}</td><td class="wrap">${h(n.last_error || "—")}</td><td>${h(formatDateTime(n.created_at))}</td>
      <td>${n.status === "failed" ? `<button class="secondary small" type="button" data-retry="${h(n.id)}">Retry</button>` : ""}</td></tr>`).join("") : emptyRow(7, "No notifications sent yet.");
    renderPager($("#notification-pager"), { page: pages.notifications, total: data.total, pageSize: data.page_size || 20 }, (page) => { pages.notifications = page; loadNotificationList(section); });
  } catch (error) { showError(section, error); }
}

async function loadCalendar(section) {
  try {
    const c = await api("/api/admin/calendar");
    $("#calendar-state").textContent = c.configured
      ? `Active since ${formatDateTime(c.created_at)} · last used ${c.last_used_at ? formatDateTime(c.last_used_at) : "never"}. The link is only shown when created; create a new one if you've lost it.`
      : "No calendar link is active.";
    $("#revoke-calendar").hidden = !c.configured;
    $("#rotate-calendar").textContent = c.configured ? "Replace link" : "Create link";
  } catch (error) { showError(section, error); }
}

export function initNotifications() {
  const section = $("#view-notifications");
  $("#notification-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-retry]");
    if (!button) return;
    busy(button, async () => {
      try { await api(`/api/admin/notifications/${encodeURIComponent(button.dataset.retry)}/retry`, { method: "POST", body: {} }); announce("Notification queued for retry."); await loadNotificationList(section); }
      catch (error) { showError(section, error); }
    });
  });
  // Owner-initiated only: requeues stored, already-verified Stripe events that failed processing.
  // Never resubmitted automatically by the UI; jobs are run separately with "Run pending jobs".
  $("#retry-events").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.dataset.busy === "1") return;
    const { ok } = await confirmDialog({ title: "Retry failed payment events?", message: "Verified Stripe events that failed processing will be queued again. Nothing is charged or refunded by this action; queued events are processed on the next job run.", confirmLabel: "Queue for retry" });
    if (!ok) return;
    busy(button, async () => {
      try {
        showError(section, null);
        const r = await api("/api/admin/jobs/retry-events", { method: "POST", body: {} });
        const n = Number.isSafeInteger(r?.requeued) && r.requeued >= 0 ? r.requeued : 0;
        announce(n ? `${n} payment event${n === 1 ? "" : "s"} queued for retry. Run pending jobs to process now.` : "No failed payment events to retry.");
      } catch (error) { showError(section, error); }
    });
  });
  $("#run-jobs").addEventListener("click", (event) => busy(event.currentTarget, async () => {
    try { const r = await api("/api/admin/jobs/run", { method: "POST", body: {} }); announce(`Jobs run: ${Number(r.processed) || 0} processed, ${Number(r.failed) || 0} failed.`); await loadNotificationList(section); }
    catch (error) { showError(section, error); }
  }));
  $("#rotate-calendar").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const { ok } = await confirmDialog({ title: "Create a new calendar link?", message: "Any existing link stops working. Calendar apps using it must be re-subscribed.", confirmLabel: "Create link" });
    if (!ok) return;
    busy(button, async () => {
      try {
        const r = await api("/api/admin/calendar/rotate", { method: "POST", body: {} });
        const http = safeHttpsUrl(r.http_url);
        $("#calendar-url").value = http || "";
        const webcal = /^webcal:\/\//.test(r.webcal_url || "") ? r.webcal_url : null;
        $("#webcal-link").hidden = !webcal;
        if (webcal) $("#webcal-link").href = webcal;
        $("#calendar-url-box").hidden = !http;
        announce("New calendar link created. Copy it now; it won't be shown again.");
        await loadCalendar(section);
      } catch (error) { showError(section, error); }
    });
  });
  $("#revoke-calendar").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const { ok } = await confirmDialog({ title: "Revoke calendar link?", message: "Subscribed calendars will stop updating.", confirmLabel: "Revoke", danger: true });
    if (!ok) return;
    busy(button, async () => {
      try { await api("/api/admin/calendar", { method: "DELETE" }); $("#calendar-url-box").hidden = true; $("#calendar-url").value = ""; announce("Calendar link revoked."); await loadCalendar(section); }
      catch (error) { showError(section, error); }
    });
  });
  $("#copy-calendar").addEventListener("click", async () => {
    const input = $("#calendar-url");
    try { await navigator.clipboard.writeText(input.value); announce("Calendar link copied."); }
    catch { input.focus(); input.select(); announce("Couldn't copy automatically. The link is selected — press Ctrl/Cmd+C."); }
  });
}

// ---------- Settings, health, activity ----------
export async function loadSettings() {
  const section = $("#view-settings");
  showError(section, null);
  await Promise.all([
    (async () => {
      const form = $("#settings-form");
      settingsVersion = null;
      setFormReady(form, false);
      try {
        const s = await api("/api/admin/settings");
        if (!Number.isInteger(s?.version)) throw Object.assign(new Error("Settings couldn't be loaded."), { code: "malformed" });
        if (s.timezone && ![...form.timezone.options].some((o) => o.value === s.timezone)) form.timezone.add(new Option(s.timezone, s.timezone));
        form.timezone.value = s.timezone || "America/Toronto";
        // Only CAD and USD are supported; never add other currencies as options.
        form.currency.value = ["CAD", "USD"].includes(s.currency) ? s.currency : "CAD";
        form.owner_email.value = s.owner_email || "";
        form.booking_enabled.checked = s.booking_enabled === true;
        settingsVersion = s.version;
        setFormReady(form, true);
      } catch (error) {
        showError(section, Object.assign(error, { message: `${error.message || "Settings couldn't be loaded."} Saving is disabled until settings load.` }), { reload: "settings" });
      }
    })(),
    loadHealth(section),
    loadActivity(section)
  ]);
}

async function loadHealth(section) {
  try {
    const data = await api("/api/admin/health");
    const services = Array.isArray(data.services) ? data.services : [];
    $("#health-list").innerHTML = services.map((s) => `<li><span class="dot ${s.configured && s.reachable ? "ok" : "warn"}" aria-hidden="true"></span><strong>${h(label(s.name))}</strong><span>${h(!s.configured ? "Not configured" : s.reachable ? "Reachable" : "Unreachable")}${s.message ? ` · ${h(s.message)}` : ""}</span></li>`).join("") || `<li class="empty">No services reported.</li>`;
  } catch (error) { showError(section, error); }
}

async function loadActivity(section) {
  try {
    const data = await api(`/api/admin/activity?page=${pages.activity}`);
    const items = Array.isArray(data.items) ? data.items : [];
    $("#activity-rows").innerHTML = items.length ? items.map((a) => `<tr><td>${h(formatDateTime(a.created_at))}</td><td>${h(label(a.action))}</td><td><code>${h(String(a.actor_id || "system").slice(0, 8))}</code></td>
      <td>${a.booking_id ? `<button class="text-button" type="button" data-open-booking="${h(a.booking_id)}">Open</button>` : "—"}</td><td class="wrap"><code>${h(a.details && Object.keys(a.details).length ? JSON.stringify(a.details) : "")}</code></td></tr>`).join("") : emptyRow(5, "No activity yet.");
    renderPager($("#activity-pager"), { page: pages.activity, total: data.total, pageSize: data.page_size || 20 }, (page) => { pages.activity = page; loadActivity(section); });
  } catch (error) { showError(section, error); }
}

export function initSettings() {
  const section = $("#view-settings");
  $("#health-refresh").addEventListener("click", (event) => busy(event.currentTarget, () => loadHealth(section)));
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    if (!Number.isInteger(settingsVersion)) return showError(section, { message: "Settings haven't loaded yet." }, { reload: "settings" });
    if (!["CAD", "USD"].includes(form.currency.value)) return showError(section, { message: "Currency must be CAD or USD." });
    busy(form, async () => {
      try {
        showError(section, null);
        const saved = await api("/api/admin/settings", { method: "PUT", body: { timezone: form.timezone.value, currency: form.currency.value, owner_email: form.owner_email.value.trim(), booking_enabled: form.booking_enabled.checked, version: settingsVersion } });
        if (!Number.isInteger(saved?.version)) { settingsVersion = null; setFormReady(form, false); throw Object.assign(new Error("The save response was incomplete. Reload settings."), { code: "malformed" }); }
        settingsVersion = saved.version;
        announce("Settings saved.");
      } catch (error) {
        if (error.code === "version_conflict" || error.code === "conflict") {
          error.message = error.code === "version_conflict"
            ? "Settings were changed elsewhere, so your edits were not saved. Reload the latest values (your unsaved changes will be discarded)."
            : `${error.message || "The change conflicts with existing data."} Reload to see the current values.`;
          return showError(section, error, { reload: "settings" });
        }
        showError(section, error);
      }
    });
  });
}
