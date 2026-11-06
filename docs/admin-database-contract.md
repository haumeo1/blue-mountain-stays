# Admin database contract

Migration: `202611050004_admin_rpcs.sql`. It must be applied **after** `202611050003` (payment), because it reads `payment_attempts.captured_cents`. Local runs need `supabase/tests/bootstrap.sql` first; it now stubs `storage.buckets` and `storage.objects` too.

All RPCs are `SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp`. Only `service_role` can execute them. Owner actions call `manager_require_admin(p_actor)`. Writes take `pg_advisory_xact_lock(2, hashtext(property_id))` and then `SELECT … FOR UPDATE` on the property row, in the same order as `manager_request`, `manager_action`, and `manager_block`.

## Errors (in addition to docs/database-contract.md)

| SQLSTATE | HTTP | Message | Notes |
| --- | --- | --- | --- |
| `22023` | 400 | `invalid_input` | `DETAIL` names the field, e.g. `tax_bps`, `overrides`, `overrides_overlap`, `photos`, `contact.email`, `timezone`. |
| `22023` | 400 | `invalid_action` | Unknown section or action, or `p_data` is not an object. |
| `42501` | 403 | `forbidden` | |
| `P0002` | 404 | `property_not_found`, `notification_not_found` | |
| `55000` | 409 | `version_conflict` | The supplied `version` is not the current one. The UI should re-GET. |
| `55000` | 409 | `currency_locked`, `currency_mismatch`, `nothing_to_publish`, `invalid_transition`, `lease_lost` | |
| `23505` | 409 | unique violation | A reused `token_hash`. |

Validation is strict: unknown keys are rejected, types must match exactly (a JSON number is not a numeric string), integers must be whole numbers, and strings are trimmed, with `""` treated as `null`. Control characters other than tab, CR, and LF are rejected. Text is stored as-is and never interpreted as HTML, so the UI must render it with `textContent`.

## `manager_configure(p_section text, p_actor uuid, p_data jsonb) → jsonb`

`pricing`, `content`, `publish`, and `settings` share `properties.version`. They **require** `version` (an integer) to match the current value, and each successful save increments it. Any increment makes existing quotes `quote_stale`.

### `pricing`
`p_data` must contain exactly these keys:

- `nightly_rate_cents` (1..10,000,000)
- `cleaning_fee_cents` (0..10,000,000)
- `service_bps` (0..10000)
- `tax_bps` (0..10000)
- `tax_configured` (boolean, **required**)
- `min_nights` and `max_nights` (1..365, with min ≤ max)
- `max_guests` (1..100)
- `overrides` (optional; an array of up to 200 `{start_date, end_date, nightly_rate_cents}`, dates as `YYYY-MM-DD`, end exclusive, end > start, at most 366 nights, within 2000..2100, no overlaps)
- `version`

`service_rate` is stored as `service_bps / 10000`. All overrides are replaced in the same transaction. An overlap is detected by the exclusion constraint and raises `invalid_input` with DETAIL `overrides_overlap`.
Returns `{nightly_rate_cents, cleaning_fee_cents, service_bps, tax_bps, tax_configured, min_nights, max_nights, max_guests, overrides[{start_date,end_date,nightly_rate_cents}], version}`.

### `content`
`p_data` is `{content, version}`. `content` is a bounded object, at most 256 KiB:

- `title` ≤120, `hero_title` ≤160, `description` ≤5000
- `amenities[]` ≤50 of `{title` (required) ≤80, `description` ≤500`}`
- `photos[]` ≤50 of `{path, url, alt}`. `path` must match `^property/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$`, `url` must be `https://` and ≤2048, and `alt` ≤200.
- `faq[]` ≤50 of `{question` ≤300, `answer` ≤2000`}` (both required)
- `policies{cancellation, house_rules}` (each ≤4000)
- `contact{email` (validated) `, phone` ≤40`}`
- `policies_confirmed` (boolean, **required**)
- `policies_complete` is accepted but ignored.

The object is rebuilt from validated fields only. It is saved to the **draft only**.
Returns `{draft, published, version}`. Each content object has `policies_complete = policies_confirmed AND cancellation non-empty AND house_rules non-empty`. An empty draft or published object is returned as `null`.

**The server must also check** that each photo `url` equals the public URL derived from `path` for the `property-photos` bucket. The database checks only the shape.

### `publish`
`p_data` is `{version}`. It copies the draft to published. An empty draft raises `nothing_to_publish`. Returns the same shape as `content`.

### `settings`
`p_data` is exactly `{timezone, currency, owner_email, booking_enabled, version}`:

- `timezone` must be in `pg_timezone_names` (≤64).
- `currency` must be **`CAD` or `USD`**.
- `owner_email` may be null, or a validated address ≤254, lowercased.
- `booking_enabled` must be a boolean.

Changing the currency once **any** booking exists for the property (pending, confirmed, cancelled or legacy, paid or not) raises `currency_locked`. The check runs under the property advisory lock and row lock, so it cannot race booking creation; an unpaid booking keeps its original currency and could still be paid. Every settings save bumps `version`, which invalidates unused quotes.
Returns `{timezone, currency, owner_email, booking_enabled, version}`. The audit log records only `owner_email_set`, not the address.

### `calendar_rotate`
`p_data` is `{token_hash, label?}`. `token_hash` is 64 lowercase hex characters: the sha256 of a raw token that the server generates and returns to the owner once. The function revokes every active property token and inserts a new one.
Returns `{configured:true, created_at, last_used_at:null}`. It never returns a secret, and the audit log stores only the token row id.

### `calendar_revoke`
`p_data` is `{}`. It revokes every active token. Returns `{configured:false}`.

### `outbox_retry`
`p_data` is `{id}`. It raises `notification_not_found` if the row is missing, and `invalid_transition` if the row is `sent` or is `leased` with an unexpired lease. Otherwise it resets the row to `pending`, with `attempts = 0`, `available_at = now()`, the lease cleared, and the error cleared.
Returns `{id, template, recipient, status (queued|sent|failed), attempts, last_error, created_at}`.

`calendar_*` and `outbox_retry` do not take a `version` and do not increment it.

## `manager_overview(p_actor uuid) → jsonb`
Takes no filters. Returns `{currency, pending_requests, confirmed_arrivals, paid_cents, refunded_cents, occupancy_percent, failed_notifications, next_arrival}`:

- `currency` is the property currency; `paid_cents` and `refunded_cents` are in it. If any captured attempt or `succeeded` refund for the property is in a different currency (preexisting mixed data), the call raises `55000 currency_mismatch` (API: `409 conflict`) instead of summing unlike currencies.
- `confirmed_arrivals` counts `confirmed` stays with `check_in >= today`, where today is in the property's timezone.
- `paid_cents` is the sum of `payment_attempts.captured_cents` for the property's bookings, whatever the attempt status (so `review` attempts with captured funds are included). `captured_cents` is set only from verified webhooks.
- `refunded_cents` is the sum of `succeeded` refunds. Each total is a separate subquery, so no join can double-count.
- `occupancy_percent` is `round(confirmed nights within [today, today+30) × 100 / 30)`.
- `failed_notifications` counts `dead` outbox rows.
- `next_arrival` is the earliest confirmed stay with `check_in >= today`, as `{id, guest_name, check_in, check_out, guest_count, confirmation_code}`, or `null`.

## `manager_work(p_action text, p_data jsonb) → jsonb`
This is for internal workers only and takes no owner actor. The API must gate it with cron or owner authentication.

`worker` must match `^[A-Za-z0-9_.:-]{1,64}$`. Leases last 2 minutes.

### Claims: `{worker, limit?}` → `{jobs:[full rows]}`
`limit` is 1..25 and defaults to 10. Claims use `FOR UPDATE SKIP LOCKED`. Every claim also deletes up to 500 expired `rate_buckets`.

| Action | Selects | On claim |
| --- | --- | --- |
| `claim_outbox` | `pending` rows with `available_at <= now()`, or `leased` rows whose lease has expired, where `attempts < max_attempts`. Expired leased rows that have used all their attempts are marked `dead` first. | `status = 'leased'`, `attempts + 1` |
| `claim_attempts` | `payment_attempts` in `created`, `session_open`, `processing`, or `review`, with `coalesce(next_retry_at, created_at) <= now()` and the lease free or expired | `attempt_count + 1` |
| `claim_refunds` | `pending` refunds, with the same due/lease rule. The migration adds `lease_owner`, `lease_expires_at`, and `attempts` to `refunds` if they are missing. | `attempts + 1` |
| `claim_events` | `stripe_events` in `received` or `failed`, with `coalesce(next_retry_at, received_at) <= now()`, `attempts < 25`, and the lease free. | `attempts + 1` (`manager_event` then does not count again while the lease is live) |

### Completing and settling: `{worker, id, error?, delay_seconds?}` → `{job: row}`
The row must still be leased by the same `worker`, otherwise the call raises `lease_lost`. This stops a stale worker from acknowledging or settling a job.

- `ack_outbox`: sets `sent` and `sent_at`, and clears the lease.
`error` is sanitized with `manager_safe_error` (`[A-Za-z0-9 _.:,()/-]`, ≤300 characters).

- `fail_outbox`: clears the lease and stores `error` (default `send_failed`). If `attempts >= max_attempts` the row becomes `dead`. Otherwise it becomes `pending` with `available_at = now() + min(86400, 60·2^(attempts−1))` seconds.
- `settle_attempt`, `settle_refund`, `settle_event`: `delay_seconds` is **required** (0..86400). These clear the lease and set `next_retry_at = now() + delay`.
  - `last_error`: if the `error` key is **omitted**, the existing value is preserved (for example `review_overcommitted_by_external_refund`). An explicit `null` (or `""`) clears it. A string replaces it.
  - `settle_event` takes the event advisory lock `(3, hashtext(stripe_event_id))` first, like `manager_event`. It also sets `status = 'failed'` when a non-null `error` is given and the event is still `received` or `failed`.
  - These calls never change financial or inventory state. Those effects come from the payment RPCs (`manager_event` and others in 003).
  - If a payment RPC already cleared the lease, the worker does not need to settle.

## `manager_retry_events(p_actor uuid) → jsonb`
This is an owner action (`manager_require_admin`), exposed only through an explicit authenticated endpoint and never run automatically. It requeues exhausted events: `status in ('received', 'failed')`, `attempts >= 25`, and the lease unset or expired. `received` is included because a worker that crashes after claiming leaves the event `received` with its attempts consumed; once its lease expires it would otherwise be permanently ineligible. Events with an active lease are never reset, and `processed`/`ignored` events are always excluded. Each requeued event gets `attempts = 0`, `next_retry_at = now()`, and a cleared lease, while its `status` and `last_error` are kept. It handles at most 100 per call, oldest `received_at` first, so call again if `requeued = 100`. For each event it takes the event advisory lock before the row and re-checks the conditions. It always writes one audit event: `stripe_events.requeued` with `{count, event_ids}`.
Returns `{requeued, event_ids[]}`.

## `manager_rate_limit(p_key text, p_limit int, p_seconds int) → boolean`
Arguments: `p_key` is 1..256 characters, `p_limit` is 1..100000, and `p_seconds` is 1..86400.

The bucket key is `sha256(p_seconds || ':' || p_key)`, so raw keys such as IPs are never stored. The window is `floor(epoch / p_seconds) · p_seconds`. A single `INSERT … ON CONFLICT DO UPDATE hits + 1` is atomic and race-free. Returns `hits <= p_limit`. Expired buckets are removed by the worker claims.

## Storage
The `property-photos` bucket is public, with a 10 MiB (10,485,760-byte) limit, and allows `image/jpeg`, `image/png`, and `image/webp`. If the bucket exists it is upserted, and only these three settings are changed.

No `storage.objects` policies are created for `anon` or `authenticated`. Uploads happen only through signed upload URLs created by the server with `service_role`. Reads use the bucket's public endpoint.

## UI and backend corrections
- **Pricing PUT must send `tax_configured`** as an explicit boolean that the owner confirms. This replaces the "server-derived" wording in `docs/api-contract.md`.
- **Content PUT must send `content.policies_confirmed`** as an explicit boolean. The draft GET returns it, along with the derived `policies_complete`.
- Settings `currency` accepts only `CAD` or `USD`. The API maps `currency_locked` and `version_conflict` to `409 conflict`.
- The server generates the raw calendar token, sends only its sha256 to the database, and builds `http_url` and `webcal_url` itself.
