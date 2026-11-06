// Small DOM helpers for the admin portal.
import { escapeHtml } from "../shared/format.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
export const h = escapeHtml;

let toastTimer;
export function announce(message) {
  const live = $("#live");
  live.textContent = "";
  requestAnimationFrame(() => { live.textContent = message; });
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// Shows a plain-text error. `reload` (a view name) adds a visible button that re-fetches the
// section through the existing [data-reload] handler, discarding unsaved edits.
export function showError(container, error, { reload } = {}) {
  const box = container?.querySelector("[data-error]");
  if (!box) return;
  if (!error) { box.hidden = true; box.textContent = ""; return; }
  if (error.isAuth) return; // handled by the auth flow
  box.textContent = `${error.message || "Something went wrong."}${error.requestId ? ` (ref ${error.requestId})` : ""}`;
  if (reload) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary small error-action";
    button.dataset.reload = reload;
    button.textContent = "Reload latest (discard my changes)";
    box.append(button);
  }
  box.hidden = false;
}

// Locks a form's submit buttons until its data has loaded (version known). busy() respects the lock.
export function setFormReady(form, ready) {
  // Submit buttons inside the form, plus related buttons elsewhere marked data-needs-load="<form id>".
  const buttons = [...$$("button[type=submit]", form), ...$$(`[data-needs-load="${form.id}"]`)];
  for (const b of buttons) {
    if (ready) delete b.dataset.locked; else b.dataset.locked = "1";
    if (b.dataset.busy !== "1") b.disabled = !ready;
  }
}

// Disables a button (or all buttons of a form) while fn runs. Locked buttons stay disabled.
export async function busy(target, fn) {
  const buttons = target instanceof HTMLFormElement ? $$("button", target) : [target];
  if (buttons.some((b) => b.dataset.busy === "1")) return undefined;
  buttons.forEach((b) => { b.dataset.busy = "1"; b.disabled = true; b.setAttribute("aria-busy", "true"); });
  try { return await fn(); }
  finally { buttons.forEach((b) => { delete b.dataset.busy; b.disabled = b.dataset.locked === "1"; b.removeAttribute("aria-busy"); }); }
}

export function openDialog(dialog) {
  showError(dialog, null);
  if (!dialog.open) dialog.showModal();
}

// Promise-based confirmation using the native <dialog>. Resolves {ok, reason}.
export function confirmDialog({ title, message, confirmLabel = "Confirm", askReason = false, danger = false }) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-ok").textContent = confirmLabel;
  $("#confirm-ok").classList.toggle("danger", danger);
  $("#confirm-reason-label").hidden = !askReason;
  $("#confirm-reason").value = "";
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve({ ok: dialog.returnValue === "ok", reason: $("#confirm-reason").value.trim() }), { once: true });
  });
}

export function pill(status) {
  const s = String(status ?? "unknown");
  return `<span class="pill pill-${h(s.replace(/[^a-z_]/g, ""))}">${h(s.replaceAll("_", " "))}</span>`;
}

export function renderPager(container, { page, total, pageSize = 20 }, onPage) {
  const pages = Math.max(1, Math.ceil((Number(total) || 0) / pageSize));
  container.innerHTML = `<span>${h(total ?? 0)} total · page ${h(page)} of ${h(pages)}</span><div class="button-row"><button class="secondary" type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>← Previous</button><button class="secondary" type="button" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next →</button></div>`;
  container.onclick = (event) => {
    const button = event.target.closest("[data-page]");
    if (button && !button.disabled) onPage(Number(button.dataset.page));
  };
}

export function emptyRow(cols, text) { return `<tr><td colspan="${cols}" class="empty">${h(text)}</td></tr>`; }
