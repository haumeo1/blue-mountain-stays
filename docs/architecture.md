# Architecture

## Intent

A direct-booking site and private owner portal for one vacation home.

- **Vercel** serves static assets from `dist/` and runs one serverless API function.
- **Supabase** is authoritative for bookings, inventory, pricing, content, owner auth, audit, outbox, and photo storage.
- **Stripe** is authoritative for payment state, applied only from signature-verified webhooks (or re-retrieved from Stripe during reconciliation). Browser input never sets prices, totals, or payment status.

## Layout

| Path | Layer | Notes |
| --- | --- | --- |
| `public/` | Static source | `index.html`, `booking.html`, `admin.html`, CSS. Only allow-listed files are copied by `scripts/build.mjs`. |
| `src/guest/`, `src/admin/`, `src/shared/` | Browser | Bundled by esbuild into `dist/assets/`. No server imports, Node built-ins, or `process.env`. |
| `api/router.js` | Vercel handler | The only function. `vercel.json` rewrites `/api/:path*` → `/api/router?route=…`; it delegates to `server/routes.js`. |
| `server/routes.js` | Router | Parse route → authenticate admin paths → match/405 → same-origin check (or cron auth / raw webhook) → read body → call **one** service → JSON envelope. |
| `server/services/` | Domain | `public.js` (config, property, availability, quotes, requests, guest booking), `admin.js`, `payments.js` (Checkout, webhooks, refunds, booking actions), `jobs.js` (worker + cron auth), `calendar.js`, `data.js`. |
| `server/integrations/` | Providers | `supabase.js`, `stripe.js`, `email.js` (Resend), `tokens.js` (HMAC capabilities), `calendar.js`. |
| `server/http.js`, `config.js`, `validation.js` | Shared server | Envelope, errors, origin, body limits; demo-mode gate. |
| `supabase/migrations/` | Database | See below. |
| `tests/` | Tests | `node --test` unit tests; `tests/browser/` synthetic UI fixture (never imported by app code). |
| `dist/` | Generated | The only directory served. Git-ignored. |

## Migrations

`202610250001_booking_platform.sql` is the original schema and seed. It has already run on existing projects and must **never be re-run**. The manager migrations apply in order on top of it and preserve existing property IDs, prices, and bookings:

1. `202611050001_manager_schema.sql` — pricing, immutable quotes, unified inventory, payment attempts, refunds, Stripe events, outbox, audit, calendar tokens, rate limits; RLS with no public policies.
2. `202611050002_booking_rpcs.sql` — transactional quote/request/approve/decline/cancel/complete under a property advisory lock.
3. `202611050003_payment_rpcs.sql` — payment attempts, verified-event application, refunds, worker leases.
4. `202611050004_admin_rpcs.sql` — admin reads/writes with version checks.
5. `202611050005_legacy_access.sql` — guest capabilities for legacy bookings and recovered-Checkout binding.

All write functions are `SECURITY DEFINER`, fixed `search_path`, callable by `service_role` only.

## Booking lifecycle

`pending` → (approve) `payment_due` with `hold_expires_at` ≈ 24 h → (verified payment) `confirmed` → (after check-out) `completed`. Also `declined`, `expired` (hold lapsed unpaid), `cancelled`. Cancelling a `payment_due` booking sets `cancel_requested`; the hold is released only after payment reconciliation. Refunds are separate, explicit owner actions.

## Background work

`server/services/jobs.js` processes stored verified events, payment-attempt reconciliation, refunds, expired holds, and the email outbox, with leases and backoff. Triggers: bounded immediate outbox delivery after commits, `POST /api/admin/jobs/run` (owner), and the cron-authorised `/api/jobs/run`. Owners can also requeue failed stored payment events (`POST /api/admin/jobs/retry-events`); nothing is resubmitted automatically by the UI. Scheduling requirements are in `docs/operations.md`.

## Import boundaries (enforced by `npm run check` and the build)

- `src/` → only `src/` and browser-safe packages.
- `api/` → only `server/` and packages. `server/` → only `server/` and packages.
- Page scripts in `public/*.html` load only bundles from `/assets/`.

## Runtime configuration

- Variables: `.env.example`. Secrets only in Vercel env vars or local `.env.local`; never bundled.
- `GET /api/config` returns public values only. `GET /api/admin/health` reports configured/reachable, never keys.
- `DEMO_MODE=true` is honoured only off Vercel and outside `NODE_ENV=production`. Deployed environments fail closed: booking is disabled with a clear message when configuration is missing.
- Guest PII and confirmations are never written to browser storage. The guest capability token is read from the URL fragment and kept in `sessionStorage` for the tab only; admin sessions are tab-scoped.

## CI

GitHub Actions on Node 22: `npm ci`, `npm run check`, `npm test`, `npm run build`, with no secrets.
