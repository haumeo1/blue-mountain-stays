// Single API router. api/router.js is a thin delegate; every /api/* request lands here.
// Order per request: parse trusted route → (admin) authenticate → match/405 → origin check
// → (cron) authorize → read body only where needed → call ONE service → envelope.
import {
  HttpError, assertSameOrigin, getQuery, getRequestId, handleError, readJsonBody, sendData, setSecurityHeaders
} from "./http.js";
import { requireAdmin as defaultRequireAdmin } from "./integrations/supabase.js";
import * as publicService from "./services/public.js";
import * as adminService from "./services/admin.js";
import * as paymentService from "./services/payments.js";

const ROUTE_PATTERN = /^[A-Za-z0-9_/-]{1,200}$/;
const unavailable = () => new HttpError(503, "This feature is not available right now", "service_unavailable");

// jobs.js / calendar.js are owned by another worker and may not exist yet: load lazily, fail closed.
// Literal import() specifiers so Vercel's file tracer bundles them.
const lazy = (load) => {
  let loaded;
  return async () => {
    if (!loaded) loaded = load().catch(() => { loaded = undefined; return null; });
    const mod = await loaded;
    if (!mod) throw unavailable();
    return mod;
  };
};
const loadJobs = lazy(() => import("./services/jobs.js"));
const loadCalendar = lazy(() => import("./services/calendar.js"));

// Returns validated segments or null. Accepts only the route value set by the dev server /
// Vercel rewrite (already decoded once). Any "%", ".", "\\", control char, or empty segment
// is refused, so a second decode can never change the meaning.
export function parseRoute(request) {
  let route = getQuery(request)?.route;
  if (route === undefined) {
    // Fallback when platform helpers are disabled and the URL is the original /api/<path>.
    let pathname = "";
    try { pathname = new URL(request.url || "/", "http://localhost").pathname; } catch { return null; }
    if (pathname.startsWith("/api/") && pathname !== "/api/router") route = pathname.slice(5);
  }
  if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) return null;
  const segments = route.split("/");
  if (segments.some((s) => s === "")) return null;
  return segments;
}

const ID = ":id";
// [pattern, {METHOD: spec}]. spec: {run, status?, body?, admin?, cron?, raw?, calendar?}
function table() {
  const pub = (run, extra = {}) => ({ run, ...extra });
  const adm = (run, extra = {}) => ({ run, admin: true, ...extra });
  return [
    ["config", { GET: pub((d) => d.public.publicConfig()) }],
    ["property", { GET: pub((d) => d.public.publicProperty()) }],
    ["availability", { GET: pub((d, c) => d.public.availability(c.query)) }],
    ["quotes", { POST: pub((d, c) => d.public.quote(c.body, c.req), { body: true }) }],
    ["bookings", { POST: pub((d, c) => d.public.requestBooking(c.body, c.req), { body: true, status: 201, notify: true }) }],
    ["guest/booking", { GET: pub((d, c) => d.public.guestBooking(c.req)) }],
    ["guest/checkout", { POST: pub(async (d, c) => {
      const r = await d.payments.guestCheckout(c.req);
      return { url: r?.url ?? null };
    }) }],
    ["stripe/webhook", { POST: pub(async (d, c) => {
      await d.payments.webhook(c.req);
      return { received: true };
    }, { raw: true, notify: true }) }],
    ["calendar/feed", { GET: pub(async (d, c) => (await d.calendar()).ownerCalendar(c.query), { calendar: true }) }],
    ["calendar/guest", { GET: pub(async (d, c) => (await d.calendar()).guestCalendar(c.query), { calendar: true }) }],
    ["jobs/run", {
      GET: pub(async (d) => jobCounts(await (await d.jobs()).runJobs()), { cron: true }),
      POST: pub(async (d) => jobCounts(await (await d.jobs()).runJobs()), { cron: true })
    }],

    ["admin/overview", { GET: adm((d, c) => d.admin.overview(c.actor)) }],
    ["admin/bookings", { GET: adm((d, c) => d.admin.listBookings(c.query, c.actor)) }],
    [`admin/bookings/${ID}`, { GET: adm((d, c) => d.admin.bookingDetail(c.id, c.actor)) }],
    [`admin/bookings/${ID}/actions`, { POST: adm(async (d, c) => {
      const r = await d.payments.bookingAction(c.id, c.body, c.actor, c.req);
      const out = { booking: r?.booking ?? null, payment_pending: Boolean(r?.payment_pending) };
      if (r?.reconciliation_required !== undefined) out.reconciliation_required = Boolean(r.reconciliation_required);
      return out;
    }, { body: true, notify: true }) }],
    ["admin/availability", { GET: adm((d, c) => d.admin.adminAvailability(c.query, c.actor)) }],
    ["admin/blocks", { POST: adm((d, c) => d.admin.createBlock(c.body, c.actor), { body: true, status: 201 }) }],
    [`admin/blocks/${ID}`, { DELETE: adm((d, c) => d.admin.deleteBlock(c.id, c.actor)) }],
    ["admin/pricing", {
      GET: adm((d, c) => d.admin.getPricing(c.actor)),
      PUT: adm((d, c) => d.admin.savePricing(c.body, c.actor), { body: true })
    }],
    ["admin/content", {
      GET: adm((d, c) => d.admin.getContent(c.actor)),
      PUT: adm((d, c) => d.admin.saveContent(c.body, c.actor), { body: true })
    }],
    ["admin/content/publish", { POST: adm((d, c) => d.admin.publishContent(c.body, c.actor), { body: true }) }],
    ["admin/photos/upload", { POST: adm((d, c) => d.admin.uploadPhoto(c.body, c.actor), { body: true }) }],
    ["admin/payments", { GET: adm((d, c) => d.admin.listPayments(c.query, c.actor)) }],
    ["admin/refunds", { POST: adm(async (d, c) => {
      const r = await d.payments.requestRefund(c.body, c.actor);
      return { refund: safeRefund(r?.refund) };
    }, { body: true, status: 201, notify: true }) }],
    ["admin/notifications", { GET: adm((d, c) => d.admin.listNotifications(c.query, c.actor)) }],
    [`admin/notifications/${ID}/retry`, { POST: adm((d, c) => d.admin.retryNotification(c.id, c.actor), { notify: true }) }],
    ["admin/calendar", {
      GET: adm((d, c) => d.admin.calendarSettings(c.actor)),
      DELETE: adm((d, c) => d.admin.revokeCalendar(c.actor))
    }],
    ["admin/calendar/rotate", { POST: adm((d, c) => d.admin.rotateCalendar(c.actor, c.req)) }],
    ["admin/settings", {
      GET: adm((d, c) => d.admin.getSettings(c.actor)),
      PUT: adm((d, c) => d.admin.saveSettings(c.body, c.actor), { body: true })
    }],
    ["admin/health", { GET: adm((d, c) => d.admin.health(c.actor)) }],
    ["admin/jobs/run", { POST: adm(async (d) => jobCounts(await (await d.jobs()).runJobs())) }],
    // Explicit owner action only; cron never resets exhausted events.
    ["admin/jobs/retry-events", { POST: adm(async (d, c) => {
      const r = await d.admin.retryEvents(c.actor);
      return { requeued: count(r?.requeued) };
    }) }],
    ["admin/activity", { GET: adm((d, c) => d.admin.activity(c.query, c.actor)) }]
  ];
}

const REFUND_OUT = ["id", "booking_id", "amount_cents", "currency", "status", "reason", "created_at"];
const safeRefund = (r) => r ? Object.fromEntries(REFUND_OUT.map((k) => [k, r[k] ?? null])) : null;
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const jobCounts = (r) => ({ processed: count(r?.processed), failed: count(r?.failed) });

// Documented paths, for tests and docs. Methods are listed per pattern.
export const ROUTES = table().map(([pattern, methods]) => ({ pattern, methods: Object.keys(methods) }));

function match(segments, routes) {
  for (const [pattern, methods] of routes) {
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    let id = null;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i += 1) {
      if (parts[i] === ID) id = segments[i];
      else ok = parts[i] === segments[i];
    }
    if (ok) return { methods, id };
  }
  return null;
}

const safeFilename = (name) => {
  const base = String(name || "calendar").replace(/\.ics$/i, "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "calendar";
  return `${base}.ics`;
};

function sendCalendar(response, result) {
  if (!result || typeof result.body !== "string") throw new HttpError(500, "Something went wrong", "internal");
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${safeFilename(result.filename)}"`);
  response.end(result.body);
}

export function createHandler(overrides = {}) {
  const deps = {
    public: publicService,
    admin: adminService,
    payments: paymentService,
    requireAdmin: defaultRequireAdmin,
    jobs: loadJobs,
    calendar: loadCalendar,
    ...overrides
  };
  // Allow tests to pass module-like objects for jobs/calendar.
  for (const key of ["jobs", "calendar"]) {
    if (typeof deps[key] !== "function") { const mod = deps[key]; deps[key] = async () => mod; }
  }
  const routes = table();

  async function requireCron(req) {
    const jobs = await deps.jobs();
    if (typeof jobs?.requireCron !== "function") throw unavailable();
    await jobs.requireCron(req);
  }

  // Best-effort immediate email after a COMMITTED mutation: outbox-only, limit 2, ≤15s.
  // Never changes the already-successful response; failures stay on the outbox row.
  async function notify() {
    try {
      const jobs = await deps.jobs();
      if (typeof jobs?.deliverNotifications === "function") await jobs.deliverNotifications({ limit: 2, deadlineMs: 15_000 });
    } catch { /* recorded in outbox; worker retries */ }
  }

  return async function handler(req, res) {
    getRequestId(req);
    try {
      const segments = parseRoute(req);
      if (!segments) throw new HttpError(404, "Not found", "not_found");
      // Any /admin path authenticates first: no route probing, body parsing, or service calls before it.
      const actor = segments[0] === "admin" ? await deps.requireAdmin(req) : null;
      const found = match(segments, routes);
      if (!found) throw new HttpError(404, "Not found", "not_found");
      const spec = found.methods[req.method];
      if (!spec) {
        res.setHeader("Allow", Object.keys(found.methods).join(", "));
        throw new HttpError(405, "Method not allowed", "method_not_allowed");
      }
      if (spec.cron) await requireCron(req);
      else if (!spec.raw) assertSameOrigin(req); // webhook and cron are machine callers
      const query = { ...getQuery(req) };
      delete query.route;
      const ctx = { req, query, actor, id: found.id, body: undefined };
      if (spec.body) ctx.body = await readJsonBody(req);
      const result = await spec.run(deps, ctx);
      if (spec.calendar) return sendCalendar(res, result);
      if (spec.notify) await notify();
      sendData(res, spec.status || 200, result);
    } catch (error) {
      handleError(res, error, req);
    }
  };
}
