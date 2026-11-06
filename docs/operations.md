# Operations runbook

Applies to Vercel project `blue-mountain-stays` and Supabase project `Bluemountainstay`. Nothing here has been verified against a live cloud environment by this document; tick each step yourself in staging first, then production.

## 0. Environments

- **Staging**: Vercel Preview + its own Supabase project, Stripe **test** mode, `APP_ENV=staging`, `EMAIL_TEST_RECIPIENT` set. `PUBLIC_SITE_URL` must equal the preview host actually serving staging (a stable preview alias), or Stripe returns, guest links, and the same-origin check break.
- **Production**: separate domain, separate Supabase project, Stripe live mode, `APP_ENV=production`. Never point staging at production data or keys.
- Set variables per environment in Vercel (see `.env.example`). Do not upload `.env.local` to Vercel; enter values in the dashboard.
- Keep `settings.booking_enabled` off (Settings → "Accept new booking requests") and `STRIPE_ENABLED=false` until every step below is done. With missing configuration the site disables booking rather than simulating it.

## 1. Database migrations (staged)

1. Back up the project (Supabase dashboard → Database → Backups, or `pg_dump`).
2. **Never re-run `202610250001_booking_platform.sql`** — it contains the original seed. Existing property IDs, custom prices, and bookings must be preserved.
3. Apply `202611050001` … `202611050005` in order, in staging first. Each is applied once; do not edit an applied file — add a new migration instead.
4. Check: `supabase/tests/` queries, then sign in to `/admin` and confirm pricing and existing bookings look unchanged.
5. Repeat on production during a quiet window with booking disabled.

## 2. Owner access

1. Supabase → Authentication → Providers → Email: **disable sign-ups**; keep magic links enabled.
2. Authentication → URL Configuration: Site URL = `PUBLIC_SITE_URL`; redirect allow-list contains exactly `<PUBLIC_SITE_URL>/admin` (plus `http://127.0.0.1:<port>/admin` for local staging only). No wildcards in production.
3. Invite the owner (Authentication → Users → Invite). Then allow-list them:
   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'owner@example.com'
   on conflict (user_id) do nothing;
   ```
4. Only users in `admin_users` pass the server check; the portal never creates users. Remove access by deleting the row (and the auth user if appropriate).

## 3. Privacy and capability links

- Guest links (`/booking#token=…`) and guest calendar links are per-booking capabilities; only hashes are stored. Owner calendar feed is created/rotated/revoked in Notifications; it shows guest names, so treat it as a password.
- Rotating `GUEST_TOKEN_SECRET` invalidates guest links issued under it.

## 4. Photo storage

- Uploads go through server-issued signed upload URLs to a path the server chooses; there are no client write policies. The bucket enforces image MIME types and a 10 MB limit. Published photos are served via public read URLs, so upload only images meant for the public site.
- User uploads go to Supabase Storage, not to Vercel.

## 5. Stripe

- Checkout charges the **full saved booking total** in the property currency (CAD or USD) for card payment. Amounts come from the stored booking, never the browser.
- Payment state changes only from **signature-verified webhooks** (raw request body; the router never JSON-parses `/api/stripe/webhook`). Events are stored and deduplicated by Stripe event id; the Stripe object is re-retrieved before applying.
- Webhook endpoint: `<PUBLIC_SITE_URL>/api/stripe/webhook`, same mode as the key. Subscribe to: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `refund.failed`.
- Refunds: owner enters an explicit amount (≤ refundable); each request carries an idempotency key so retries never double-refund. Cancelling never refunds automatically.
- Live mode requires `APP_ENV=production`, a live key, **and** `LIVE_CHECKOUT_ENABLED=true`. Before enabling: confirm tax (Pricing → tax checkbox, including 0%) and policies (Property → policies checkbox, then publish), and complete a staging test booking end to end.

## 6. Scheduling

- `vercel.json` keeps one **daily** cron (`/api/jobs/run`, 06:00 UTC) for Hobby-plan compatibility. Vercel sends `Authorization: Bearer $CRON_SECRET`.
- The service also delivers outbox email immediately (bounded) after commits.
- **A daily run alone is not an operational SLA.** Delayed webhooks, failed email retries, and releasing expired holds need frequent runs. Configure an external scheduler (or an upgraded Vercel plan cron) to call, e.g. every 5 minutes:
  ```
  POST <PUBLIC_SITE_URL>/api/jobs/run
  Authorization: Bearer <CRON_SECRET>
  ```
  Always send the secret in the header, never in the URL query.
- The owner can run jobs manually (Notifications → Run pending jobs).

## 7. Reconciliation and recovery

- **Failed stored payment events**: Notifications → "Retry failed payment events" (confirmation required) requeues them; then Run pending jobs. Nothing is resubmitted automatically.
- **Failed emails**: retry individually in Notifications, or let the scheduled worker back off and retry.
- **`cancel_requested` bookings** keep their hold until the worker reconciles the payment attempt with Stripe; if a payment completes anyway, refund it explicitly.
- **Currency**: the property currency locks once any booking exists. If the Overview reports a currency mismatch (verified payments or refunds in a currency other than the property's), review each payment's own currency in Payments and reconcile manually against Stripe. Do not relabel payment rows or reset the property currency to make totals add up.
- **Missing webhook**: the worker re-retrieves open payment attempts and can bind a recovered Checkout Session; it never confirms payment without Stripe's paid status.
- **Incidents**: disable booking in Settings, set `STRIPE_ENABLED=false` if payments misbehave, check `/api/admin/health` (never shows keys) and the activity log, restore from backup only as a last resort.

## 8. Key rotation summary

| Secret | Effect of rotation |
| --- | --- |
| `SUPABASE_SECRET_KEY` | Update Vercel, redeploy, then revoke old key. |
| `GUEST_TOKEN_SECRET` | Outstanding guest links stop working. |
| `CRON_SECRET` | Update Vercel and external scheduler together. |
| `STRIPE_WEBHOOK_SECRET` | Roll in Stripe, update Vercel, redeploy. |
| `STRIPE_SECRET_KEY` / `RESEND_API_KEY` | Update Vercel, redeploy, revoke old key. |
