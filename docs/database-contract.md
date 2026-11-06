# Database contract

Migrations: `202611050001_manager_schema.sql` (schema), `202611050002_booking_rpcs.sql` (core RPCs).
Local Postgres runs need `supabase/tests/bootstrap.sql` applied first, to stub the Supabase roles and `auth`.

All RPCs are `SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp`. Only
`service_role` can execute them; `public`, `anon`, and `authenticated` cannot. Client roles
have no grants on `bookings`, `properties`, `blocked_dates`, or any manager table.

## Errors

The server maps errors by SQLSTATE. The message is a stable token.

| SQLSTATE | HTTP | Messages |
| --- | --- | --- |
| `22023` | 400 | `invalid_input`, `invalid_dates`, `invalid_guest_count`, `invalid_nights`, `invalid_guest`, `invalid_idempotency_key`, `invalid_action`, `invalid_notification` |
| `42501` | 403 | `forbidden` (the actor is null or not in `admin_users`) |
| `P0002` | 404 | `booking_not_found`, `quote_not_found`, `block_not_found`, `property_not_found` |
| `23505` | 409 | `idempotency_conflict` (same key, different request hash) |
| `23P01` | 409 | `dates_unavailable` |
| `55000` | 409 | `booking_disabled`, `quote_expired`, `quote_stale`, `quote_used`, `invalid_transition`, `stay_started`, `invalid_total`; trigger messages for immutable or append-only rows |

## Money naming

`quotes.lodging_cents` is returned as `stay_cents`. The total is
`stay + cleaning_fee + service_fee + tax`, with:

- `service_fee = round(stay * service_rate)`
- `tax = round((stay + cleaning + service) * tax_bps / 10000)`

The nightly rate comes from a date-level `pricing_overrides` entry, falling back to `properties.nightly_rate_cents`.

## Functions

### `manager_quote(p_check_in date, p_check_out date, p_guest_count int) → jsonb`
Returns `{id, check_in, check_out, guest_count, nights, nightly_lines[{date, rate_cents}], stay_cents, cleaning_fee_cents, service_fee_cents, tax_bps, tax_cents, total_cents, currency, expires_at, property_version}`.

- The quote expires 15 minutes after it is created.
- "Today" is the date in the property's timezone.
- Minimum nights come from the check-in night's override, falling back to the property's value.
- Any active inventory claim on the dates makes them unavailable.

### `manager_request(p_quote_id uuid, p_guest jsonb, p_key text, p_hash text, p_guest_hash text, p_calendar_hash text) → booking`
- **Input:** `p_guest` is `{name, email, phone?, notes?}`. `p_key` must match `^[A-Za-z0-9_:-]{16,128}$`. Each hash is 64 lowercase hex characters (sha256 computed by the server).
- **Idempotency:** the function takes a transaction advisory lock on the key before any lookup.
  - Same key and same hash: returns the original booking, even if the quote has since expired.
  - Same key and a different hash: raises `idempotency_conflict`.
- **Result:** creates a `pending` / `unpaid` booking that reserves no inventory. It stores an immutable `quote_snapshot` and only the token hashes.
- **Side effects:** writes an audit event and queues `booking_requested` notifications for the owner and guest.

### `manager_action(p_booking_id uuid, p_action text, p_actor uuid, p_reason text) → {booking, attempt, reconciliation_required}`
`p_action` is one of `approve`, `decline`, `cancel`, `complete`.

| From | Action | Result |
| --- | --- | --- |
| `pending` | approve | `payment_due`, inventory claim, `hold_expires_at = now() + 24h`, payment attempt `booking:<id>:attempt:1` for the expected total. No email is sent yet. |
| `payment_due` | approve | Returns the existing booking and attempt; nothing changes. |
| `pending` | decline | `declined`; guest and owner notified. |
| `pending` | cancel | `cancelled`; notified. |
| `payment_due` | cancel | `cancel_requested = true` and `reconciliation_required: true`. The hold stays in place. |
| `confirmed` | cancel | `cancelled`; the claim is released, `payment_status` is unchanged (refunds come later), and both parties are notified. |
| `confirmed` | complete | `completed`. Only allowed when `check_out <= today`. |

Any other transition raises `invalid_transition`. Approval raises `dates_unavailable` if the dates are already claimed.

### `manager_block(p_action text, p_actor uuid, p_data jsonb) → {id, start_date, end_date, reason, created_at}`
- `create` takes `{start_date, end_date, reason?}`, with at most 366 nights. It adds a `blocked_dates` row and its inventory claim.
- `delete` takes `{block_id}`. It removes only an owner block; its claim is removed by cascade.
- Every call is audited.

### `manager_notify(p_booking_id uuid, p_topic text) → void`
- Queues `outbox` rows with `{topic, booking_id, recipient}`, where recipient is `owner` or `guest`, deduplicated by `topic:booking_id:recipient`.
- Addresses are resolved when the message is sent. Raw tokens are never stored.
- If `owner_email` is unset, the owner row is skipped and the guest row is still queued.

## Invariants

- `status = 'payment_due'` if and only if `hold_expires_at is not null`, so leaving `payment_due` must clear the hold.
- An active `inventory_claims` row of kind `booking` exists for `payment_due` and `confirmed` stays. A GiST exclusion stops active claims from overlapping.
- A quote can back at most one booking, and quotes are immutable.
- Booking dates, guest count, money fields, currency, quote link, confirmation code, and snapshot are immutable.
- `audit_events` is append-only: a trigger blocks changes, and `service_role` has no `UPDATE`, `DELETE`, or `TRUNCATE`.
- Only one open payment attempt (`created`, `session_open`, `processing`, or `review`) can exist per booking.

## Not yet implemented

Payment verification and checkout, the payment_due email, hold expiry, refunds, the pricing/settings RPCs, and calendar feed RPCs.
