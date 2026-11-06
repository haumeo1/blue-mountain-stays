# Payment database contract

Migration: `supabase/migrations/202611050003_payment_rpcs.sql`. Builds on the helpers in `202611050002_booking_rpcs.sql`.

All three RPCs are `SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp`. `EXECUTE` is revoked from `public`, `anon`, and `authenticated` and granted only to `service_role`. Browsers never call them. Errors use a SQLSTATE plus a stable `message` code (listed below).

**Lock order** (the same in every path): event advisory lock `(3, hashtext(event_id))` → property advisory lock `(2, hashtext(property_id))` → `bookings` row → `payment_attempts` row → `refunds` row.

**Principles**
- Booking status (`bookings.status`) and payment status (`bookings.payment_status`, `payment_attempts.status`, `refunds.status`) are tracked separately.
- Captured money and succeeded refunds are facts that only verified Stripe effects can write, and only through `manager_event`. A trigger (`enforce_payment_facts`) makes the session id, payment intent, `captured_cents`, `verified_paid_at`, refund amount, and a `succeeded` refund status write-once.
- Nothing expires because of the wall clock alone. Releasing a hold needs Stripe evidence that the session is terminal and unpaid.
- Cancelling never triggers an automatic refund.

## Schema additions

| Table | Column | Notes |
| --- | --- | --- |
| `payment_attempts` | `captured_cents int not null default 0` | Set once, from the verified paid effect. |
| | `verified_paid_at timestamptz` | Check: `(captured_cents > 0) = (verified_paid_at is not null)`; requires a payment intent. |
| | `receipt_url text`, `session_url text` | |
| | `paid_event_id text` | The Stripe event that recorded the capture. |
| `refunds` | `verified_at timestamptz` | Set when a verified Stripe result is applied. |
| | `source text` (`admin` \| `stripe`) | `stripe` means an external refund, such as one made in the dashboard. |

The attempt status check is unchanged: `created, session_open, processing, review, succeeded, failed, expired, cancelled`.

---

## `manager_payment(p_attempt_id uuid, p_action text, p_data jsonb) → jsonb`

Returns `{ "booking": <manager_booking_out>, "attempt": <attempt> }`. Duplicate `paid` replays also return `"replay": true`.

`attempt` fields: `id, booking_id, idempotency_key, expected_total_cents, currency, status, stripe_checkout_session_id, session_url, stripe_payment_intent_id, captured_cents, verified_paid_at, receipt_url, attempt_count, next_retry_at, last_error, created_at, updated_at`.

### `attached`
After the server creates a Checkout Session (using `attempt.idempotency_key` as the Stripe idempotency key).

| `p_data` field | Type | Rule |
| --- | --- | --- |
| `session_id` | text | `^cs_…`. If one is already stored, it must match exactly (otherwise `23505 session_conflict`). |
| `session_url` | text | Must start with `https://checkout.stripe.com/`. |
| `amount_cents` | int | Must equal `expected_total_cents`. |
| `currency` | text | Must equal the attempt currency (upper-case ISO). |

- `created` becomes `session_open`. Any other status is left alone, so `review`, `succeeded`, and `expired` are never downgraded.
- `manager_notify(booking, 'payment_due')` is queued only when the attempt is `session_open`, the booking is `payment_due`, and `cancel_requested` is false. Outbox dedupe makes replays safe.

```sql
select public.manager_payment($1::uuid, 'attached',
  jsonb_build_object('session_id', $2, 'session_url', $3, 'amount_cents', $4, 'currency', $5));
```

### `error`
`p_data`: `{ "error": text }`. The error is sanitized to `[A-Za-z0-9 _.:,()/-]` and capped at 300 characters (`manager_safe_error`: `null` → `null`, input that sanitizes to empty → `unknown_error`; a missing `error` here is stored as `unknown_error`). This applies only when the attempt is `created` or `session_open`. It increments `attempt_count` and sets `next_retry_at = now() + min(3600, 30·2^n)` seconds. The hold is not released.

### `terminal_unpaid`
The server must first retrieve the session from Stripe (and expire it if it is still open), then pass on what Stripe reported.

| `p_data` field | Rule |
| --- | --- |
| `session_id` | Must equal the attached session (otherwise `55000 session_mismatch`). |
| `status` | Must be the literal `expired`. |
| `payment_status` | Must be the literal `unpaid`. |

Timestamps are never accepted as evidence. If the attempt is `succeeded`, `review`, or has captured money, the call fails with `55000 invalid_transition`. A replay on an attempt that is already `expired` or `cancelled` is a no-op. When the booking is `payment_due`, the call:

- releases the inventory claim
- sets the booking to `cancelled` if `cancel_requested`, otherwise `expired`
- clears `hold_expires_at`
- sets the attempt to the same status
- queues `booking_cancelled` or `booking_expired`
- writes an audit event

### `paid` (internal only)
This action raises `42501 verified_event_required` unless it is called from inside `manager_event` with `p_effect = 'paid'`. `p_data` is the same object that is passed to `manager_event` (see below).

1. Validation: `booking_id` and `attempt_id` must match the attempt row, `amount_cents` and `currency` must exactly match the expected values, and `payment_intent` must be `^pi_…`. Any mismatch raises an error and writes nothing.
2. If the session is not stored yet, it is adopted, because the webhook can race the attachment. A different stored session raises `session_mismatch`.
3. If the attempt is already verified with the same payment intent and amount, the call is a no-op replay. This holds whatever the booking state is (completed, cancelled, refunded); the booking is never revived. A different payment intent raises `payment_conflict`.
4. The capture is recorded: `captured_cents`, `verified_paid_at`, `stripe_payment_intent_id`, `receipt_url`, `paid_event_id`.
5. If the booking is `payment_due` and has an active claim that matches its dates:
   - with `cancel_requested`: the attempt becomes `succeeded`, the claim is released, the booking becomes `cancelled`, payment stays `paid`, and `booking_cancelled` is queued
   - otherwise: the attempt becomes `succeeded`, the booking becomes `confirmed` and `paid`, the hold is cleared, the claim stays active, and `booking_confirmed` is queued
6. Otherwise the attempt becomes `review` and the booking's `payment_status` becomes `paid`. The booking status is not changed, no reservation is invented, and no confirmation is sent.

---

## `manager_refund(p_action text, p_actor uuid, p_data jsonb) → jsonb`

Returns a refund object: `id, booking_id, payment_attempt_id, payment_intent, idempotency_key, amount_cents, currency, status, stripe_refund_id, reason, source, next_retry_at, last_error, verified_at, created_at, updated_at`. Replays of `finalize` add `"replay": true`.

### `reserve` (admin)
`p_actor` must be a member of `admin_users` (otherwise `42501 forbidden`).

| `p_data` field | Rule |
| --- | --- |
| `booking_id` | uuid |
| `amount_cents` | Positive integer. |
| `idempotency_key` | `^[A-Za-z0-9:_-]{8,200}$`. Must not start with `stripe:`. Must stay stable across retries; it is also the Stripe idempotency key. |
| `reason` | Non-empty, up to 500 characters. |

- Replaying the same key with the same booking, amount, and reason returns the existing row. Any other reuse of the key raises `23505 idempotency_conflict`.
- The booking must have a verified captured attempt (otherwise `55000 no_captured_payment`).
- The sum of `pending` and `succeeded` refunds plus the new amount must not exceed `captured_cents` (otherwise `55000 refund_exceeds_captured`).
- The refund is inserted as `pending`. Pending refunds hold their share of the funds, including after an ambiguous provider error.

```sql
select public.manager_refund('reserve', $1::uuid, jsonb_build_object(
  'booking_id', $2, 'amount_cents', $3, 'idempotency_key', $4, 'reason', $5));
```

### `attach` (from the Stripe API create response)
`p_data`: `{ "refund_id": uuid, "stripe_refund_id": "re_…" }`. This only stores the Stripe id, the first time it is given; the same id again is a no-op and a different id raises `refund_conflict`. The status stays `pending` even when the API response says `succeeded`.

### `error`
`p_data`: `{ "refund_id": uuid, "error": text }`. If the refund is `pending`, this records the sanitized `last_error` and sets `next_retry_at = now() + 5 min`. The refund stays `pending`, because the error is not treated as a definitive failure.

### `finalize` (internal only)
This action raises `42501 verified_event_required` unless it is called from `manager_event` with `p_effect = 'refund'`. `p_data` holds the refund object from the latest verified Stripe result:

| Field | Rule |
| --- | --- |
| `refund_id` | Optional local uuid (taken from the Stripe refund metadata). |
| `stripe_refund_id` | `re_…`. Required. |
| `booking_id` | uuid. Required. Must match. |
| `payment_intent` | `pi_…`. Required. Must belong to a verified attempt for this booking. |
| `amount_cents`, `currency` | Must equal the local row. |
| `status` | `pending`, `succeeded`, `failed`, or `canceled` (stored as `cancelled`). |
| `failure_reason` | Optional; sanitized. |

- If no local row is found (no `refund_id`, unknown `stripe_refund_id`), the refund is treated as external. It is inserted with `idempotency_key = 'stripe:' || stripe_refund_id` and `source = 'stripe'`, after the captured-total check.
- Transitions are monotonic. A `succeeded` refund never changes. A stale `pending` arriving after a terminal status is a replay. A conflicting terminal status raises `55000 refund_state_conflict`.
- When a refund becomes `succeeded`:
  - the booking's `payment_status` is recomputed from the sum of succeeded refunds against the captured total (`paid`, `partially_refunded`, or `refunded`)
  - a `refund_succeeded` outbox row is queued, deduped per refund (`refund_succeeded:<refund_id>:<recipient>`)
  - an audit event is written
- The booking status is never changed.

---

## `manager_event(p_event_id text, p_type text, p_livemode boolean, p_payload jsonb, p_effect text, p_data jsonb) → jsonb`

The caller must already have verified the Stripe signature, and for effects it must have re-retrieved the latest object from Stripe. Returns `{ "event_id", "status", "replay", "result"? }`.

| Param | Rule |
| --- | --- |
| `p_event_id` | `^evt_…`. Must equal `p_payload->>'id'`. |
| `p_type` | The Stripe event type. |
| `p_livemode` | Must match the stored row on replay (along with `type`). Otherwise `23505 event_conflict`. |
| `p_payload` | The full verified event JSON. |
| `p_effect` | `received`, `paid`, `refund`, `ignored`, or `failed`. |
| `p_data` | For `paid`: `{attempt_id, booking_id, session_id, payment_intent, amount_cents, currency, receipt_url?}`. For `refund`: the `finalize` object. For `failed`: `{error}`. For other effects: `{}`. |

Allowed effects by event type (`received` and `failed` are always allowed):

| Type | Allowed effects |
| --- | --- |
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `paid`; `ignored` (for example, a completed session whose payment is still `unpaid`) |
| `refund.created`, `refund.updated`, `refund.failed` | `refund` |
| anything else | `ignored` |

Any other combination raises `22023 effect_type_mismatch`.

Flow:
1. Take the event advisory lock and insert into `stripe_events` (`on conflict (stripe_event_id) do nothing`).
2. If the event is already `processed` or `ignored`, return a replay no-op.
3. `received`: the row is persisted and nothing else happens.
4. `failed`: in one update, set `status = 'failed'`, store the sanitized `last_error` (`unknown_error` if omitted), schedule `next_retry_at = now() + min(3600, 30·2^(attempts−1))` seconds, and clear the lease. The event can be retried.
5. `paid` / `refund`: apply the effect, then stamp `processed`. `ignored`: stamp `ignored`. Both clear the lease and `next_retry_at` in the same transaction, so if the effect raises, nothing is stamped and the event stays `received` or `failed`.

**Attempt counting.** Each processing attempt is counted exactly once. If the row holds a live lease (`lease_expires_at > now()`), `manager_work('claim_events')` has already incremented `attempts`, so steps 4–5 leave it unchanged. Otherwise (a direct webhook call, or an expired lease) they increment it once, capped at 25. `received` never counts. Because every path takes the event advisory lock first, a duplicate webhook that races a worker waits, then sees `processed` and returns a replay. A worker whose lease was cleared this way gets `lease_lost` from `settle_event` and does not need to settle. Owners requeue exhausted events with `manager_retry_events` (see the admin contract).

### Recommended webhook endpoint
```sql
-- 1) After verifying the signature, persist the event (its own transaction):
select public.manager_event($1, $2, $3, $4::jsonb, 'received', '{}'::jsonb);
-- 2) Re-retrieve the object from Stripe, build p_data, then:
select public.manager_event($1, $2, $3, $4::jsonb, 'paid', $5::jsonb);   -- or 'refund' / 'ignored'
-- 3) If step 2 raises, record it (separate transaction) so a worker can retry:
select public.manager_event($1, $2, $3, $4::jsonb, 'failed', jsonb_build_object('error', $5));
```
Workers claim due rows with `manager_work('claim_events')` and repeat step 2 with the stored payload. If step 2 raises, the worker calls step 3 itself (still holding its lease); that records the failure and schedules the backoff without a second increment.

`stripe_events.next_retry_at` is added by this migration (004 repeats it with `if not exists`).

## Error codes

| SQLSTATE | Messages |
| --- | --- |
| `22023` | `invalid_action`, `invalid_amount`, `invalid_session_id`, `invalid_session_url`, `amount_mismatch`, `terminal_evidence_required`, `invalid_payment_evidence`, `invalid_refund_data`, `invalid_refund_request`, `invalid_stripe_refund_id`, `invalid_refund_evidence`, `invalid_event`, `invalid_event_data`, `effect_type_mismatch` |
| `23505` | `session_conflict`, `idempotency_conflict`, `refund_conflict`, `event_conflict` |
| `42501` | `forbidden`, `verified_event_required` |
| `55000` | `session_mismatch`, `invalid_transition`, `payment_conflict`, `no_captured_payment`, `refund_exceeds_captured`, `payment_intent_mismatch`, `refund_mismatch`, `refund_state_conflict`, `payment_facts_immutable`, `refund_facts_immutable` |
| `P0002` | `attempt_not_found`, `booking_not_found`, `refund_not_found` |
