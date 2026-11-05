# Architecture

## Intent

A direct-booking site and private owner portal for one vacation home.

- **Vercel** hosts static assets from `dist/` and runs server handlers from `api/`.
- **Supabase** is the authoritative source for bookings, availability, owner blocks, admin auth, and (later) file storage.
- **Stripe** is the authoritative source for payment state. Payment status changes only through signature-verified webhooks, never from browser input.
- Code is written by Opus and reviewed and tested by GPT.

## Layout

| Path | Layer | Notes |
| --- | --- | --- |
| `public/` | Static source | HTML and CSS. Only files on the allow-list in `scripts/build.mjs` are copied. |
| `src/guest/`, `src/admin/` | Browser | Bundled by esbuild to `dist/assets/guest.js` and `dist/assets/admin.js`. |
| `api/` | Vercel handlers | One file per route. Parse the request, authorize, call `server/`, respond. No shared helpers here. |
| `server/` | Server-only | `http.js`, `validation.js`, `config.js`, `integrations/` (Supabase, calendar, later Stripe and Resend). `server/services/` will hold domain logic. |
| `supabase/migrations/` | Database | Schema, RLS, and transactional functions. |
| `scripts/` | Tooling | Build, dev server, checks, Node wrapper. |
| `tests/` | Tests | `node --test`. |
| `dist/` | Generated | The only directory served. Git-ignored. |

## Import boundaries (enforced by `npm run check` and the build)

- `src/` → only `src/` and browser-safe packages. No `server/`, `api/`, Node built-ins, `stripe`, `resend`, `pg`, or `process.env`.
- `api/` → only `server/` and packages.
- `server/` → only `server/` and packages.
- Page scripts in `public/*.html` must be `/assets/guest.js` or `/assets/admin.js`.

## Runtime configuration

- Secrets exist only in Vercel environment variables or a local `.env.local`, which the dev server loads into its own process. They are never bundled; the build fails if a server-only env value appears in `dist/`.
- `GET /api/config` returns only public values: `demoMode`, `databaseConnected`, the Supabase URL and publishable key, and feature flags.
- `DEMO_MODE=true` is honoured only off Vercel deployments and outside `NODE_ENV=production`. With demo mode on, the guest site simulates requests in memory for the current tab.
- If the config cannot be loaded, or booking isn't configured and demo mode is off, the guest site disables submission and tells the guest what to do. It never falls back to storing bookings locally.
- Guest PII and confirmations are never written to browser storage; legacy `localStorage` data from older builds is deleted.

## Local development

`npm run dev` builds `dist/`, then serves on `127.0.0.1` only:

- static files from `dist/` with Vercel-style clean URLs (`/`, `/admin`; `*.html` and trailing slashes redirect)
- API routes discovered from regular `.js` files in `api/` (names beginning `_` or `.` and symlinks are skipped)
- handlers are awaited; dotfiles, traversal, malformed escapes, and symlinks that point outside `dist/` are rejected

## CI

GitHub Actions on Node 22 runs `npm ci`, `npm run check`, `npm test`, and `npm run build`, with no secrets configured.

## Phase status

Phase 1 (foundation) is done: the `public/`/`src/`/`server/` layout, esbuild build to `dist/`, the hardened dev server, boundary checks, explicit local-only demo mode, no PII in browser storage, `vercel.json` pointing at `dist`, and CI.

Before Phase 2:

1. GPT runs `npm install` to regenerate `package-lock.json`, bumping the pinned versions to current releases if appropriate, then runs `npm run ci`.
2. Confirm Vercel project settings don't override `vercel.json` build/output, and check that `/admin` resolves on a preview deployment.
3. Phase 2 can then add `server/services/` (server-side quotes and booking), move guest pricing to a server quote endpoint, and start Stripe/Resend integration behind verified webhooks.
