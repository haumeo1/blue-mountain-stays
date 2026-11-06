# Testing

All commands use Node 22 (in Conductor, prefix with `./scripts/with-node.sh`).

| Command | What it runs |
| --- | --- |
| `npm run check` | Syntax and import-boundary checks. |
| `npm test` | Every `tests/**/*.test.js`. `tests/database.test.js` is skipped unless `DATABASE_TEST_URL` is set. |
| `npm run build` | Builds `dist/` and scans it for server-only env values. |

## Real-Postgres suite (`tests/database.test.js`)

Applies `supabase/tests/bootstrap.sql` and the original `202610250001` migration, seeds a synthetic
legacy booking, block, admin, and custom nightly rate, then applies `202611050001`–`005` and checks
that IDs, prices, claims, and history survived. It then exercises the RPCs: role denial, quote and
idempotency, concurrent approval/approval and approval/block (real concurrency on separate
connections), the verified-event-only paid guard, duplicate and reordered events, the concurrent
refund cap, 005 legacy access and recovered-session binding, content versioning vs. overview, the
event worker lease/backoff, error preservation on settle, and owner requeue.

**Requirements.** It needs a **fresh, disposable** database. It refuses to run unless:

- the host is loopback (`localhost`, `127.0.0.1`, `::1`) and the database name contains `test`
- `public.bookings` is absent or empty, and the manager migrations are not applied yet

The role must be a superuser (it creates `anon`, `authenticated`, and `service_role`, and uses
`SET ROLE`). Only synthetic `@example.test` data is written. When it finishes, the suite drops and
recreates the `public`, `auth`, and `storage` schemas of that test database so it can be rerun.
Set `DATABASE_TEST_KEEP=1` to keep the data for debugging, then recreate the database before the next run.

```sh
# Postgres 16 running locally; run from the repository root.
createdb manager_local_test
DATABASE_TEST_URL=postgres://$USER@127.0.0.1:5432/manager_local_test node --test tests/database.test.js
```

Tests within the file run sequentially and share fixtures. Concurrency happens only where a test
asks for it, through `race()`, which asserts that the second connection really blocked on a lock.

## CI

`.github/workflows/ci.yml` starts a `postgres:16` service with an ephemeral `manager_ci_test`
database and synthetic credentials on `127.0.0.1`. It sets `DATABASE_TEST_REQUIRED=1`, so a missing
URL fails the job instead of skipping it. Check, test, and build otherwise run as before.

After the build, the same required `test` job runs `npx playwright install --with-deps chromium`
and then `npm run test:browser`. If anything fails, `.context/playwright-results` (traces,
screenshots) is uploaded with `actions/upload-artifact@v4`. The browser suite has no secrets.

## Browser suite (synthetic fixture)

`tests/browser/fixture-server.mjs` serves the built `dist/` bundles against an in-memory **mock**
API. Each test resets it to synthetic data first.

- **Checkout:** `POST /api/guest/checkout` returns a fake
  `https://checkout.stripe.com/c/pay/cs_test_fixture_…` URL, and only while the booking is payment-due.
  The test context intercepts every non-local request, and checkout.stripe.com gets a local
  "FAKE CHECKOUT — TEST STUB" page. This checks the client-side redirect only. It is **not** a
  Stripe test: no session exists and nothing is charged. A synthetic `?checkout=success` return
  must still show payment due. Only the fixture's "Simulate verified payment" (standing in for a
  verified webhook) confirms the booking.
- **Mobile overflow:** `expectNoHorizontalOverflow` compares `scrollWidth` and `innerWidth` with
  `document.documentElement.clientWidth`. On mobile emulation, `innerWidth` grows along with
  overflowing content, so comparing against it would hide the bug. On failure it lists the elements
  that overflow. `expectDialogFits` checks that a dialog fits inside the real viewport and that the
  action button is the topmost element where it is tapped. It never uses `force`.
