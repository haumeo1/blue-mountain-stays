# Payment, worker and calendar service contract

Services return data objects; controllers wrap them in `{data}` / map `HttpError`. Money state changes **only** through `manager_event` after a verified webhook signature and a fresh re-retrieval of the Stripe object. Checkout creation, browser redirects, admin actions, and workers never confirm a payment or finalize a refund.

## `server/services/payments.js`

| Export | Route use | Returns |
| --- | --- | --- |
| `bookingAction(id, body, actor, request)` | `POST /api/admin/bookings/:id/actions`, body `{action: approve\|decline\|cancel\|complete, reason?}` | `{booking: mapBooking, payment_pending}` |
| `guestCheckout(request)` | `POST /api/guest/checkout` (guest bearer) | `{url}` (https `checkout.stripe.com`) |
| `requestRefund(body, actor)` | `POST /api/admin/refunds`, body `{booking_id, amount_cents, reason, idempotency_key}` | `{refund}` (no idempotency key / payment intent) |
| `webhook(request)` | `POST /api/stripe/webhook` (raw body, ≤1 MiB) | `{received:true}`; 400 bad signature; 503 effect failed (Stripe retries) |
| `processVerifiedEvent(event)` | webhook + worker for stored events | `manager_event` result |
| `reconcileAttempt(attempt)` / `reconcileRefund(refund)` | worker, cancel path | `{outcome, …}` |

**Approve.** `manager_action` commits first. Then a Checkout Session is ensured. If Stripe or the readiness gate fails, a safe code is recorded on the attempt (`manager_payment error`), the approval stays saved, and `payment_pending: true` means "no open checkout link yet". The worker retries.
**Cancel.** For `payment_due`, the open session is expired, re-retrieved, and the hold is released only when Stripe reports `expired` + `unpaid`. A paid session waits for the webhook (`awaiting_verified_webhook`). Cancelling a confirmed booking never refunds automatically.

**Checkout rules.**
- An existing session is retrieved and must match exactly: `metadata.attempt_id`, `metadata.booking_id`, `client_reference_id`, `amount_total`, `currency`, `mode=payment`, and `livemode`. On any mismatch it throws and the hold is kept.
- A new session needs a valid Stripe mode (test, or live with `APP_ENV=production` + `LIVE_CHECKOUT_ENABLED=true`) and a booking `idempotency_key` (the guest token is derived from it).
- **Live** checkout also requires `tax_configured === true` and complete published policies. Completeness is derived on the server (`policiesComplete`: `policies_confirmed === true` and both policies non-blank), the same rule SQL `manager_content_out` uses. A stored `policies_complete` flag is ignored, and tax confirmation is never implied. **Test mode** may run with incomplete setup so the owner can rehearse; it is never live.
- **Legacy bookings** (`quote_snapshot.legacy = true`, no capability): on `approve`, *before* `manager_action`, the service calls `manager_guest_access` (005) with key `legacy:<booking id>` and HMAC-scoped guest/calendar token hashes derived from that key. An identical retry is a no-op; a different existing capability is a 409 `conflict`. Legacy confirmed bookings are never marked paid.
- `expires_at` is exactly the stored `hold_expires_at`. A hold more than 24h away (or less than 31 min) is rejected before any Stripe call, not clipped. Retries with the same key send identical params (expiry, amount, description).
- An idempotent replay may return a session that is already `complete`/`expired` with `url: null`. In that case `createCheckout` returns `{id, url: null, expiresAt}`, and the service re-retrieves and binds it. Only a new **open** session needs a trusted Checkout URL.
- If the attempt is ≥23h old (beyond Stripe's 24h idempotency window) or the hold has <31 min left, nothing new is created. The service recovers through a bounded `sessions.list` scan (≤1000 rows, created range, `metadata.attempt_id`). If nothing matches, it records `review_*` and **never** releases.
- A recovered session is checked (amount, currency, metadata, mode, livemode) and then bound. An open session with a URL binds through `manager_payment attached`; any other status binds through `manager_bind_recovered` (005), which needs no URL, changes no status, and never confirms. After binding, `expired` + `unpaid` releases through `terminal_unpaid`, and `complete` waits for the verified webhook. A Checkout URL is never fabricated.

**Refunds.**
- `reserve` happens first, so pending refunds hold funds. Then Stripe `refunds.create` runs with the stable key, and only the id is attached; it is never marked succeeded. A provider error records `last_error` and keeps the refund pending.
- After 23h, the service recovers through a bounded `refunds.list` scan by `metadata.refund_id` and never re-creates.
- A pending refund that would exceed captured funds given succeeded refunds, or that is flagged `review_overcommitted_*`, is not sent.

**Webhook events.**
- The only checkout types handled are `completed`, `async_payment_succeeded` and `expired`. Every other `checkout.session.*` (including `async_payment_failed` and future types) is recorded as `ignored` without retrieval, so it is never retried forever.
- `checkout.session.completed` / `async_payment_succeeded`: the `paid` effect applies only when the session is `complete` + `paid`. A completed-but-unpaid session (async method) is durably `ignored`; the later `async_payment_succeeded` is a different event and applies then.
- `checkout.session.expired`: binds the session if it is unbound, then `terminal_unpaid`, then `ignored`.
- A failure is recorded once through `manager_event('failed')`. SQL schedules the exponential backoff and clears the lease atomically, so the worker does **not** also call `settle_event`. Exhausted events are reset only by the explicit owner action `POST /api/admin/jobs/retry-events` (`manager_retry_events`, audited), never by cron.
- `refund.*`: the refund is re-retrieved (with `payment_intent`), mapped through the verified attempt, then `finalize`d.
- Sessions or refunds without our metadata are `ignored`. Ours that point at missing or unpaid rows fail and are retried.
- Receipt URLs are kept only when they are https on `*.stripe.com`.

**Migration 003 fix.**
- External verified refunds are capped only against succeeded refunds plus Stripe-sourced pending ones, so local pending reservations can never block an authoritative fact.
- Unsent local reservations that become over-committed stay `pending` with `last_error = review_overcommitted_by_external_refund`.
- `ignored` is now allowed for refund event types, for refunds unrelated to this app.

## `server/services/jobs.js`

- `requireCron(request)`: strict `Authorization: Bearer <CRON_SECRET>`. The secret must be at least 32 characters, otherwise the call returns 503. It is compared as sha256 digests with `timingSafeEqual`, and the secret is never logged.
- `runJobs({limit=10})` returns `{processed, failed, stopped_early}`. Each run uses a fresh `run:<uuid>` worker id. Jobs are claimed in this order: events, attempts, refunds, outbox (1..25 each, through `manager_work`).
- Each job is caught on its own and settled with backoff. No new work starts after 45s; unprocessed leases expire after 2 min and are recovered.
- Outbox:
  - Recipients are resolved at send time (`properties.owner_email` / `bookings.guest_email`). Messages render escaped HTML plus text.
  - Subjects contain only the property name and reference.
  - Guest link is `/booking#token=…`; owner link is `/admin`.
  - `payment_due` is sent only while the booking is still `payment_due`/unpaid with an open session. `booking_confirmed` is suppressed once the booking is `cancelled`/`expired`/`declined` (`completed` still sends). Intentionally obsolete messages are acknowledged without sending.
  - A missing recipient, booking, or template is **not** acknowledged. It fails with `missing_recipient` / `missing_booking` / `unknown_template` and shows as failed once attempts run out. An `owner_email` that was absent when the booking was created means no owner row was ever queued; health reports this as a warning.
  - The Resend adapter redirects non-production mail, times out after 10s, and treats an error, a timeout, or a missing `data.id` as not sent (`send_failed` / `send_rejected` / `send_outcome_unknown`). Rows are never acked in those cases, and the `outbox/<id>` idempotency key makes retries safe.
- `deliverNotifications({limit=2, deadlineMs=15000})`: immediate best-effort email. It claims **only** outbox rows, at most `limit`, and returns by the deadline. It never throws, and failures stay recorded on the row. It does nothing when email isn't configured. The router awaits it inside try/catch **after** a committed booking request, booking action, refund, webhook, or notification retry. It never changes that response. `runJobs` stays behind the cron secret or owner auth.
- Provider timeouts: Supabase SDK fetch 10s (`AbortSignal.timeout`, combined with any caller signal), Stripe 10s with 1 network retry, Resend 10s.
- Test hooks (server-only): `setDatabaseForTesting`, `setStripeForTesting`, `setResendForTesting`.
- **Scheduling.** The default Vercel deployment cron is daily. Timely hold release, retries, and email need a high-frequency external scheduler (e.g. every 1–5 min) calling the jobs endpoint.

## `server/services/calendar.js`

- `guestCalendar(query)` and `ownerCalendar(query)` take `query.token` (must be a `calendar_…` token) and return `{body, filename}`. The route sets `text/calendar`.
- Guest feed: the token hash is looked up in `bookings.calendar_token_hash`. The feed has one event for that stay: status `TENTATIVE`, `CONFIRMED`, or `CANCELLED` (cancelled, expired, or declined).
- Owner feed: the token must be in `calendar_tokens` with `revoked_at is null`, and using it updates `last_used_at`. The feed covers one year in the past to two years ahead. It contains holds ("Hold: awaiting payment"), confirmed or completed stays ("Reserved stay"), cancelled or expired stays as `STATUS:CANCELLED` tombstones, and "Owner block" events.
- There are no guest names or contact details.
- UIDs are stable (`booking-<id>` / `block-<id>`), and `SEQUENCE` follows `updated_at`.
- Deleted blocks are simply omitted; subscribing calendars reconcile them by UID.
- Dates are UTC all-day and half-open (`DTEND` = check-out).
