// Structured property content editor, photo upload, safe draft preview, publish.
import { api, uploadToSignedUrl } from "./client.js";
import { $, $$, h, announce, showError, busy, confirmDialog, setFormReady } from "./ui.js";
import { safeHttpsUrl } from "../shared/format.js";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const state = { version: null, published: null, dirty: false };

const ROWS = {
  amenities: { list: "#amenity-rows", fields: [["title", "Amenity", 80, "input"], ["description", "Description", 500, "input"]] },
  faq: { list: "#faq-rows", fields: [["question", "Question", 300, "input"], ["answer", "Answer", 2000, "textarea"]] },
  photos: { list: "#photo-rows", fields: [["alt", "Alt text", 200, "input"]] }
};

function repeatRow(kind, item = {}) {
  const row = document.createElement("div");
  row.className = "repeat-row";
  row.dataset.kind = kind;
  if (kind === "photos") { row.dataset.path = item.path || ""; row.dataset.url = item.url || ""; }
  const thumb = kind === "photos" && safeHttpsUrl(item.url) ? `<img class="thumb" src="${h(safeHttpsUrl(item.url))}" alt="" />` : "";
  const fields = ROWS[kind].fields.map(([key, text, max, tag]) => tag === "textarea"
    ? `<label>${h(text)}<textarea data-k="${key}" rows="2" maxlength="${max}">${h(item[key] || "")}</textarea></label>`
    : `<label>${h(text)}<input data-k="${key}" maxlength="${max}" value="${h(item[key] || "")}" ${kind === "photos" ? "required" : ""} /></label>`).join("");
  row.innerHTML = `${thumb}${fields}<div class="row-controls"><button class="text-button" type="button" data-move="-1" aria-label="Move up">↑</button><button class="text-button" type="button" data-move="1" aria-label="Move down">↓</button><button class="text-button danger" type="button" data-remove-row aria-label="Remove">Remove</button></div>`;
  return row;
}

function fill(content = {}) {
  const form = $("#content-form");
  const c = content || {};
  form.title.value = c.title || "";
  form.hero_title.value = c.hero_title || "";
  form.description.value = c.description || "";
  form.cancellation.value = c.policies?.cancellation || "";
  form.house_rules.value = c.policies?.house_rules || "";
  form.policies_confirmed.checked = c.policies_confirmed === true;
  form.contact_email.value = c.contact?.email || "";
  form.contact_phone.value = c.contact?.phone || "";
  for (const kind of Object.keys(ROWS)) $(ROWS[kind].list).replaceChildren(...(Array.isArray(c[kind]) ? c[kind] : []).map((item) => repeatRow(kind, item)));
  state.dirty = false;
}

// policies_complete is server-derived output only and is never sent.
function collect() {
  const form = $("#content-form");
  const rows = (kind) => $$(".repeat-row", $(ROWS[kind].list)).map((row) => {
    const item = Object.fromEntries(ROWS[kind].fields.map(([key]) => [key, row.querySelector(`[data-k="${key}"]`).value.trim()]));
    if (kind === "photos") { item.path = row.dataset.path; item.url = row.dataset.url; }
    return item;
  });
  return {
    title: form.title.value.trim(),
    hero_title: form.hero_title.value.trim(),
    description: form.description.value.trim(),
    amenities: rows("amenities").filter((a) => a.title),
    photos: rows("photos").filter((p) => p.url),
    faq: rows("faq").filter((f) => f.question && f.answer),
    policies: { cancellation: form.cancellation.value.trim(), house_rules: form.house_rules.value.trim() },
    contact: { email: form.contact_email.value.trim(), phone: form.contact_phone.value.trim() },
    policies_confirmed: form.policies_confirmed.checked === true
  };
}

function setState(text) { $("#content-state").textContent = text; }

export async function loadContent() {
  const section = $("#view-property");
  const form = $("#content-form");
  showError(section, null);
  // No save/publish until a successful load provides the current version.
  state.version = null;
  setFormReady(form, false);
  try {
    const data = await api("/api/admin/content");
    if (!Number.isInteger(data?.version)) throw Object.assign(new Error("Property content couldn't be loaded."), { code: "malformed" });
    state.published = data.published;
    fill(data.draft || data.published || {});
    state.version = data.version;
    setFormReady(form, true);
    setState(`Draft version ${data.version}${data.published ? "" : " · nothing published yet"}${data.draft && data.draft.policies_complete !== true ? " · policies incomplete or unconfirmed" : ""}`);
    if (!$("#content-preview").hidden) renderPreview();
  } catch (error) {
    setState("Not loaded");
    showError(section, Object.assign(error, { message: `${error.message || "Property content couldn't be loaded."} Saving and publishing are disabled until it loads.` }), { reload: "property" });
  }
}

// Preview mirrors what the guest page shows for published content: removed sections are hidden,
// never replaced by built-in defaults. Text is escaped; only https photo URLs render.
function renderPreview() {
  const c = collect();
  const photos = c.photos.map((p) => safeHttpsUrl(p.url) ? `<figure><img src="${h(safeHttpsUrl(p.url))}" alt="${h(p.alt)}" /><figcaption>${h(p.alt)}</figcaption></figure>` : "").join("");
  const faqs = [...c.faq.map((f) => [f.question, f.answer]), ...(c.policies.cancellation ? [["What is the cancellation policy?", c.policies.cancellation]] : []), ...(c.policies.house_rules ? [["What are the house rules?", c.policies.house_rules]] : [])];
  const hidden = (what) => `<p class="form-note">${h(what)} hidden on the guest site (nothing entered).</p>`;
  const contact = [c.contact.email, c.contact.phone].filter(Boolean).join(" · ");
  const headline = c.hero_title || c.title;
  $("#content-preview").innerHTML = `<div class="draft-banner" role="note">DRAFT PREVIEW — not visible to guests until published${state.dirty ? " · includes unsaved edits" : ""}</div>
    <div class="preview-body">
      <p class="eyebrow">${h(c.title || "Untitled property (the site keeps its current name)")}</p>
      ${headline ? `<h2 class="preview-hero">${h(headline)}</h2>` : hidden("Hero headline")}
      ${c.description ? `<p>${h(c.description)}</p>` : hidden("Description")}
      ${photos ? `<div class="preview-photos">${photos}</div>` : hidden("Hero image, photo gallery, and story image")}
      ${c.amenities.length ? `<h3>Amenities</h3><ul class="preview-amenities">${c.amenities.map((a) => `<li><strong>${h(a.title)}</strong><span>${h(a.description)}</span></li>`).join("")}</ul>` : hidden("Amenities section")}
      ${faqs.length ? `<h3>Before you arrive</h3>${faqs.map(([q, a]) => `<details><summary>${h(q)}</summary><p>${h(a)}</p></details>`).join("")}` : hidden("FAQ and policies")}
      ${c.policies_confirmed ? "" : `<p class="form-note">Policies are not confirmed, so they won't count as complete.</p>`}
      ${contact ? `<p class="form-note">Questions? Contact the host: ${h(contact)}</p>` : hidden("Host contact line")}
    </div>`;
}

async function uploadPhoto(input) {
  const file = input.files?.[0];
  const section = $("#view-property");
  if (!file) return;
  showError(section, null);
  if (!TYPES.includes(file.type)) { input.value = ""; return showError(section, { message: "Choose a JPEG, PNG, or WebP image." }); }
  if (file.size > MAX_BYTES) { input.value = ""; return showError(section, { message: "Photos must be 10 MB or smaller." }); }
  input.disabled = true;
  announce("Uploading photo…");
  try {
    const target = await api("/api/admin/photos/upload", { method: "POST", body: { filename: file.name.slice(0, 200), content_type: file.type, size: file.size } });
    const url = safeHttpsUrl(target.public_url);
    if (!safeHttpsUrl(target.signed_url) || !url) throw Object.assign(new Error("The upload service returned an invalid address."), { code: "malformed" });
    await uploadToSignedUrl(target.signed_url, file);
    const row = repeatRow("photos", { path: target.path, url, alt: "" });
    $("#photo-rows").append(row);
    state.dirty = true;
    row.querySelector("input").focus();
    announce("Photo uploaded. Add alt text, then save the draft.");
  } catch (error) { showError(section, error); }
  finally { input.disabled = false; input.value = ""; }
}

function conflict(error, message) {
  if (error.code !== "version_conflict") return showError($("#view-property"), error);
  error.message = message;
  showError($("#view-property"), error, { reload: "property" });
}

export function initContent() {
  const form = $("#content-form");
  form.addEventListener("input", () => { state.dirty = true; if (!$("#content-preview").hidden) renderPreview(); });
  form.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add-row]");
    if (add) { const row = repeatRow(add.dataset.addRow); $(ROWS[add.dataset.addRow].list).append(row); row.querySelector("input,textarea").focus(); state.dirty = true; }
    const row = event.target.closest(".repeat-row");
    if (!row) return;
    if (event.target.closest("[data-remove-row]")) { row.remove(); state.dirty = true; }
    const move = event.target.closest("[data-move]");
    if (move) {
      const sibling = move.dataset.move === "-1" ? row.previousElementSibling : row.nextElementSibling;
      if (sibling) { move.dataset.move === "-1" ? sibling.before(row) : sibling.after(row); move.focus(); state.dirty = true; }
    }
    if (!$("#content-preview").hidden) renderPreview();
  });
  $("#photo-file").addEventListener("change", (event) => uploadPhoto(event.target));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!Number.isInteger(state.version)) return showError($("#view-property"), { message: "Content hasn't loaded yet." }, { reload: "property" });
    busy(form, async () => {
      try {
        showError($("#view-property"), null);
        const saved = await api("/api/admin/content", { method: "PUT", body: { content: collect(), version: state.version } });
        if (!Number.isInteger(saved?.version)) throw Object.assign(new Error("The save response was incomplete. Reload before editing further."), { code: "malformed" });
        state.version = saved.version;
        state.dirty = false;
        announce("Draft saved. Publish to show it on the guest site.");
        setState(`Draft version ${saved.version} saved${saved.draft && saved.draft.policies_complete !== true ? " · policies incomplete or unconfirmed" : ""}`);
        if (!$("#content-preview").hidden) renderPreview();
      } catch (error) {
        conflict(error, "The draft was changed elsewhere, so your edits were not saved. Reload the latest draft (your unsaved changes will be discarded) and re-apply them.");
      }
    });
  });

  $("#preview-toggle").addEventListener("click", (event) => {
    const preview = $("#content-preview");
    preview.hidden = !preview.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!preview.hidden));
    event.currentTarget.textContent = preview.hidden ? "Preview draft" : "Hide preview";
    if (!preview.hidden) { renderPreview(); preview.scrollIntoView({ behavior: "smooth" }); }
  });

  $("#publish-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!Number.isInteger(state.version)) return showError($("#view-property"), { message: "Content hasn't loaded yet." }, { reload: "property" });
    if (state.dirty) return showError($("#view-property"), { message: "Save the draft before publishing." });
    const { ok } = await confirmDialog({ title: "Publish this draft?", message: "Guests will see exactly this content immediately. Anything removed from the draft (photos, amenities, FAQ, contact) disappears from the guest site.", confirmLabel: "Publish" });
    if (!ok) return;
    busy(button, async () => {
      try {
        await api("/api/admin/content/publish", { method: "POST", body: { version: state.version } });
        announce("Published. The guest site now shows this content.");
        await loadContent();
      } catch (error) {
        conflict(error, "The content was changed elsewhere before publishing. Reload the latest draft, review it, then publish.");
      }
    });
  });
}
