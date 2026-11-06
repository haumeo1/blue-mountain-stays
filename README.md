# The Blue Mountain House

A direct-booking site and private owner portal for one vacation home, written in vanilla JavaScript and deployed on Vercel (project `blue-mountain-stays`) with Supabase (project `Bluemountainstay`).

> **Status:** code-complete for staging review. Unit tests, checks, and the build run in CI without secrets. No deployed environment, Supabase project, Stripe account, or email domain is claimed as production-verified here; work through [`docs/operations.md`](docs/operations.md) before taking real bookings.

## What it does

- Guest site (`/`): published property content, server quotes, booking requests. Guest status page (`/booking`) with Stripe Checkout once the owner approves.
- Owner portal (`/admin`): Supabase magic-link sign-in for allow-listed admins. Bookings (approve / decline / cancel / complete), availability and blocks, pricing, content and photos, payments and refunds, notifications and job runs, private calendar feed, settings, health, activity.
- Request → owner approval → `payment_due` (24 h hold) → verified Stripe webhook → `confirmed`. Unpaid holds expire; cancellations during payment are reconciled before dates release. Refunds are explicit owner actions.

## Layout

See [`docs/architecture.md`](docs/architecture.md). In short: `public/` + `src/` (browser) → `dist/`; one thin API router `api/router.js` → `server/routes.js` → `server/services/` → `server/integrations/` (Supabase, Stripe, Resend, tokens, calendar); schema in `supabase/migrations/` 001–005.

## Local development (Node 22)

```sh
npm ci
cp .env.example .env.local   # fill in staging/test values only
npm run dev                  # builds, then serves dist/ and /api on 127.0.0.1
```

In Conductor prefix commands with `./scripts/with-node.sh`. Checks: `npm run check`, `npm test`, `npm run build`.

UI-only testing without any backend: the synthetic fixture in [`tests/browser/README.md`](tests/browser/README.md).

## Configuration

Every variable the server reads is listed, with placeholders, in [`.env.example`](.env.example). Secrets live only in Vercel environment variables or a local `.env.local`; the build fails if a server-only value appears in `dist/`.

## Operations

Migrations, owner invitation, auth settings, Stripe, scheduling, reconciliation, and recovery: [`docs/operations.md`](docs/operations.md). API shapes: [`docs/api-contract.md`](docs/api-contract.md).
