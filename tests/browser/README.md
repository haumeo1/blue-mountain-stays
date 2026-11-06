# Synthetic browser fixture

`fixture-server.mjs` serves the built `dist/` bundles against an **in-memory mock** of the API and Supabase Auth on `http://127.0.0.1:55004`. It is for UI testing only: it is not a live integration, contacts no Supabase, Stripe, or email provider, and its fake tokens work only in this process. No app code imports it, and it refuses to run on Vercel or with `NODE_ENV=production`.

## Run

```sh
./scripts/with-node.sh npm run build
./scripts/with-node.sh node tests/browser/fixture-server.mjs
```

Open `http://127.0.0.1:55004/__fixture` for links (guest site, owner portal with a fake sign-in, guest status pages) and simulations:

- Simulate verified payment — latest `payment_due` booking → `confirmed`/`paid`.
- Simulate expiry — latest unpaid hold → `expired`.
- Simulate reconciliation — `cancel_requested` holds → `cancelled`.
- Add failed payment event — increments the count requeued by Notifications → "Retry failed payment events".
- Fail next API request, Reset.

The mock follows `docs/api-contract.md`: `payment_due` holds with `hold_expires_at`, `cancel_requested` on payment-due cancellation, required `tax_configured` / `policies_confirmed` booleans, CAD/USD only, `max_guests` 1–100, same-day check-in. Photo upload and Stripe Checkout are not supported.
