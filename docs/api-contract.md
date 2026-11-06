# API contract (normative)

The browser code in `src/` is written against this contract. The server maps the database to it.

## Conventions

- All bodies are JSON (`Content-Type: application/json`), UTF-8.
- Success: `{"data": <payload>}` with 2xx.
- Error: `{"error": {"code": "<snake_code>", "message": "<safe human text>"}, "requestId": "<id>"}` with 4xx/5xx. `message` must be safe to show a guest; never include stack traces, SQL, or provider payloads.
- Dates are `YYYY-MM-DD` (property-local calendar dates). Timestamps are ISO 8601 UTC (`2026-11-05T14:00:00Z`).
- **Date ranges are half-open: `end` / `check_out` / `end_date` is exclusive** (the morning the guest leaves, or the first day after a block).
- Money is integer cents (`*_cents`); `currency` is ISO 4217 upper case (`CAD`). Rates in basis points (`*_bps`, 800 = 8%).
- Data fields are `snake_case`. Exception: `/api/config` uses camelCase (public config, unchanged).
- Lists: `{"items": [...], "total": <int>, "page": <int>, "page_size": <int>}`; `page` is 1-based, default `page_size` 20, max 100.
- Auth: `Authorization: Bearer <token>`. Admin routes take a Supabase access token for an approved admin; guest routes take the opaque `guest_token`. Missing/invalid/expired → `401 unauthorized`; authenticated but not admin → `403 forbidden`. The browser treats only 401/403 as "sign in again".
- Optimistic concurrency: resources with `version` (int) reject a stale `version` with `409 version_conflict`.
- Standard codes: `bad_request`, `validation_failed` (may include `error.fields: {name: message}`), `unauthorized`, `forbidden`, `not_found`, `conflict`, `version_conflict`, `dates_unavailable`, `quote_expired`, `quote_invalid`, `booking_disabled`, `rate_limited`, `payment_unavailable`, `internal`.

## Public

### GET /api/config
```json
{"data":{"supabaseUrl":"https://x.supabase.co","supabasePublishableKey":"sb_publishable_...","demoMode":false,"bookingEnabled":true}}
```
If config cannot be produced in production, return 5xx error; the browser does not fall back. Demo behaviour only when `demoMode === true`.

### GET /api/property
Published content only.
```json
{"data":{
  "property":{"name":"The Blue Mountain House","timezone":"America/Toronto","currency":"CAD","max_guests":8,"booking_enabled":true},
  "content":{
    "title":"The Blue Mountain House","description":"…","hero_title":"Your place to come together.",
    "amenities":[{"title":"Private hot tub","description":"…"}],
    "photos":[{"path":"property/abc.jpg","url":"https://…","alt":"Exterior"}],
    "faq":[{"question":"…","answer":"…"}],
    "policies":{"cancellation":"…","house_rules":"…"},
    "contact":{"email":"host@example.com","phone":"+1 705 555 0123"},
    "policies_complete":true
  }}}
```
All strings are plain text (rendered with `textContent`). Photo `url` must be `https:`. `policies_complete` is server-derived output only.
- `content` is `null` if nothing is published; **only then** does the guest page show its built-in defaults.
- When `content` is non-null it fully replaces the defaults: empty `amenities`, `faq` (plus policies), `photos`, or `contact` hide the corresponding section rather than falling back. With no photos the hero image, gallery, and story image are hidden. `title` replaces the visible property name and document title.
- `property.max_guests` is an integer 1..100. `property.timezone` (default `America/Toronto`) defines "today" for date pickers; same-day check-in is allowed and availability is decided by the server.

### GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
```json
{"data":{"ranges":[{"start":"2026-12-20","end":"2026-12-27","type":"unavailable"}]}}
```
No PII, no reasons. `type` is `unavailable` (server may merge holds, bookings, blocks).

### POST /api/quotes
Request `{"check_in":"2026-12-01","check_out":"2026-12-04","guest_count":2}`
```json
{"data":{"quote":{"id":"q_…","check_in":"2026-12-01","check_out":"2026-12-04","guest_count":2,"nights":3,
 "stay_cents":127500,"cleaning_fee_cents":14500,"service_fee_cents":10200,"tax_cents":0,"total_cents":152200,
 "currency":"CAD","expires_at":"2026-11-05T15:00:00Z"}}}
```
Errors: `validation_failed`, `dates_unavailable` (409), `booking_disabled` (403).

### POST /api/bookings
Request
```json
{"quote_id":"q_…","guest_name":"Ada","guest_email":"ada@example.com","guest_phone":"","guest_notes":"","idempotency_key":"uuid"}
```
Response 201 (or 200 when replaying the same `idempotency_key` with the same body):
```json
{"data":{"booking":{"id":"…","confirmation_code":"BMH-7Q2K","status":"pending","total_cents":152200,"currency":"CAD",
 "check_in":"2026-12-01","check_out":"2026-12-04","guest_count":2},"guest_token":"opaque"}}
```
Errors: `quote_expired` / `quote_invalid` (409/410) → browser re-quotes; `dates_unavailable` (409); `conflict` (409, idempotency key reused with different body).

### GET /api/guest/booking  (Bearer guest_token)
```json
{"data":{"booking":{"confirmation_code":"BMH-7Q2K","status":"pending","check_in":"…","check_out":"…","guest_count":2,
 "nights":3,"stay_cents":127500,"cleaning_fee_cents":14500,"service_fee_cents":10200,"tax_cents":0,"total_cents":152200,"currency":"CAD"},
 "payment":{"status":"payment_due","receipt_url":null},
 "calendar_url":"https://…/api/calendar/guest?token=…"}}
```
`booking.status` is the true database status: `pending | payment_due | confirmed | declined | cancelled | expired | completed` (`payment_due` is never hidden or mapped). `payment.status`: `not_due | payment_due | processing | paid | partially_refunded | refunded | failed`. `booking.hold_expires_at` (ISO timestamp) may be included while `payment_due`; when absent the page states the 24-hour payment window. `booking.cancel_requested` (boolean) is true while a cancellation awaits payment reconciliation; the page then shows "Cancellation pending" and hides Pay. `calendar_url` is server-generated, scoped to this booking, may be `null`.
The page offers Pay only when `booking.status` and `payment.status` are both `payment_due`, `cancel_requested` is not true, and `hold_expires_at` (if present) has not passed; `expired` bookings never show Pay.

### POST /api/guest/checkout  (Bearer guest_token)
Request `{}` → `{"data":{"url":"https://checkout.stripe.com/…"}}`. Only valid when payment status is `payment_due`. The browser redirects only if the URL is `https:` with host exactly `checkout.stripe.com`. (`receipt_url` is validated separately: `https:` on `*.stripe.com`.) Stripe success/cancel returns to `/booking#token=<guest_token>`; the page re-fetches status (webhook is authoritative).

## Admin (Bearer Supabase access token, admin only)

### GET /api/admin/overview
```json
{"data":{"pending_requests":2,"confirmed_arrivals":5,"paid_cents":450000,"refunded_cents":0,"occupancy_percent":42,
 "failed_notifications":0,"next_arrival":{"id":"…","guest_name":"Ada","check_in":"2026-12-01","check_out":"2026-12-04","guest_count":2,"confirmation_code":"BMH-7Q2K"}}}
```
`next_arrival` may be `null`. Unaffected by any list filters. Occupancy = next 30 nights.

### GET /api/admin/bookings?search=&status=&page=1&page_size=20
`items[]` booking fields: `id, confirmation_code, status, payment_status, guest_name, guest_email, guest_phone, guest_notes, guest_count, check_in, check_out, nights, stay_cents, cleaning_fee_cents, service_fee_cents, tax_cents, total_cents, currency, hold_expires_at, cancel_requested, created_at, updated_at`.
`status` filter and values: `pending | payment_due | confirmed | declined | cancelled | expired | completed`. `hold_expires_at` is non-null exactly when `payment_due`.

### GET /api/admin/bookings/:id
```json
{"data":{"booking":{…},"history":[{"created_at":"…","actor_id":"…","action":"approved","details":{}}],
 "payments":[{"id":"…","status":"paid","amount_cents":152200,"currency":"CAD","stripe_session_id":"cs_…","stripe_payment_intent_id":"pi_…","receipt_url":"https://pay.stripe.com/…","created_at":"…"}],
 "refunds":[{"id":"…","amount_cents":5000,"currency":"CAD","reason":"…","status":"succeeded","created_at":"…"}]}}
```

### POST /api/admin/bookings/:id/actions
Request `{"action":"approve|decline|cancel|complete","reason":"optional text"}` → `{"data":{"booking":{…},"payment_pending":true,"reconciliation_required":false}}`.
Allowed transitions (server-enforced):
- `pending → approve` (→ `payment_due`, dates held, `hold_expires_at = now + 24h`), `pending → decline`, `pending → cancel`.
- `payment_due → cancel`: sets `cancel_requested = true` and returns `reconciliation_required: true`; the hold stays until payment reconciliation, after which the booking becomes `cancelled`. Refunds are separate.
- `confirmed → cancel` (dates released; refunds separate), `confirmed → complete` only when `check_out` ≤ today in the property time zone.
- Invalid → `409 conflict`.

`payment_pending: true` means the payment link/integration step is still pending (no checkout email has been sent yet); the UI reports "approval saved · payment link pending", never "payment requested".

### GET /api/admin/availability?from=&to=
```json
{"data":{"ranges":[{"id":"…","start":"2026-12-01","end":"2026-12-04","type":"booking|hold|block","label":"Ada · BMH-7Q2K","booking_id":"…","block_id":null}]}}
```

### POST /api/admin/blocks
Request `{"start_date":"2026-12-10","end_date":"2026-12-12","reason":"Maintenance"}` (end exclusive) → 201 `{"data":{"block":{"id":"…","start_date":"…","end_date":"…","reason":"…"}}}`. Overlap → `409 dates_unavailable`.

### DELETE /api/admin/blocks/:id
→ `{"data":{"deleted":true}}`

### GET /api/admin/pricing · PUT /api/admin/pricing
```json
{"data":{"nightly_rate_cents":42500,"cleaning_fee_cents":14500,"service_bps":800,"tax_bps":1300,"tax_configured":true,
 "min_nights":2,"max_nights":28,"max_guests":8,"overrides":[{"start_date":"2026-12-20","end_date":"2027-01-02","nightly_rate_cents":59500}],"version":3}}
```
PUT body — exactly these keys:
```json
{"nightly_rate_cents":42500,"cleaning_fee_cents":14500,"service_bps":800,"tax_bps":1300,"tax_configured":true,
 "min_nights":2,"max_nights":28,"max_guests":8,"overrides":[{"start_date":"2026-12-20","end_date":"2027-01-02","nightly_rate_cents":59500}],"version":3}
```
`tax_configured` is a **required boolean** set by an owner checkbox confirming the tax rate (including 0%). It is initialised from GET and is never derived from the act of saving. `max_guests` 1..100; nights 1..365 with min ≤ max. Amounts are in the property currency (`CAD` or `USD`). Returns the saved object with new `version`. Changes apply to new quotes only.

### GET /api/admin/content · PUT /api/admin/content · POST /api/admin/content/publish
GET → `{"data":{"draft":<content|null>,"published":<content|null>,"version":7}}`. Each content object includes `policies_confirmed` (boolean) and the server-derived `policies_complete` (= confirmed AND both policies non-empty).
PUT body:
```json
{"content":{"title":"…","hero_title":"…","description":"…",
  "amenities":[{"title":"…","description":"…"}],"photos":[{"path":"property/abc.jpg","url":"https://…","alt":"…"}],
  "faq":[{"question":"…","answer":"…"}],"policies":{"cancellation":"…","house_rules":"…"},
  "contact":{"email":"","phone":""},"policies_confirmed":true},
 "version":7}
```
`policies_confirmed` is a **required boolean** from an owner checkbox confirming the published house and cancellation policies. `policies_complete` is output only and is not sent. Saves the draft only → same shape as GET with new version.
POST publish body `{"version":8}` → same shape as GET. Published content replaces the guest page's defaults entirely (removed items disappear).

Admin forms (pricing, content, settings) do not allow save or publish until a GET has succeeded and supplied `version`; on `409 version_conflict` the UI shows a visible "Reload latest (discard my changes)" action and never silently overwrites.

### POST /api/admin/photos/upload
Request `{"filename":"deck.jpg","content_type":"image/jpeg","size":2400000}` (types `image/jpeg|image/png|image/webp`, ≤ 10 485 760 bytes)
→ `{"data":{"signed_url":"https://…","path":"property/uuid.jpg","public_url":"https://…"}}`.
Browser then `PUT signed_url` with the file body and `Content-Type` = `content_type`. The photo is added to the draft only when the draft is saved.

### GET /api/admin/payments?page=
`items[]`: `id, booking_id, confirmation_code, total_cents, currency, payment_status, stripe_session_id, stripe_payment_intent_id, receipt_url, refunded_cents` + `total`, `page`, `page_size`.

### POST /api/admin/refunds
Request `{"booking_id":"…","amount_cents":5000,"reason":"…","idempotency_key":"uuid"}` → 201 `{"data":{"refund":{"id":"…","amount_cents":5000,"currency":"CAD","status":"pending|succeeded","reason":"…","created_at":"…"}}}`. Amount above refundable → `validation_failed`.

### GET /api/admin/notifications?page=
`items[]`: `id, template, recipient, status (queued|sent|failed), attempts, last_error, created_at`. `last_error` is a sanitised short string.

### POST /api/admin/notifications/:id/retry → `{"data":{"notification":{…}}}`

### GET /api/admin/calendar → `{"data":{"configured":true,"created_at":"…","last_used_at":"…|null"}}`
### POST /api/admin/calendar/rotate → `{"data":{"http_url":"https://…/api/calendar/feed?token=…","webcal_url":"webcal://…"}}` (only time the URL is returned)
### DELETE /api/admin/calendar → `{"data":{"configured":false}}`

### GET /api/admin/settings · PUT /api/admin/settings
`{"data":{"timezone":"America/Toronto","currency":"CAD","owner_email":"owner@example.com","booking_enabled":true,"version":2}}`. PUT body is exactly `{timezone, currency, owner_email, booking_enabled, version}`. `currency` is `CAD` or `USD` only. Changing `currency` after any captured payment → `409 conflict`.

### GET /api/admin/health → `{"data":{"services":[{"name":"supabase","configured":true,"reachable":true,"message":"OK"}]}}` (never secrets)
### POST /api/admin/jobs/run → `{"data":{"processed":3,"failed":0}}`
### POST /api/admin/jobs/retry-events
Request `{}` → `{"data":{"requeued":2}}` (non-negative integer). Requeues stored, signature-verified Stripe events whose processing failed; it never re-contacts Stripe for new charges or refunds and does not itself run jobs. Owner-triggered only (UI button with confirmation); the browser never calls it automatically. Requeued events are processed by the next job run (`POST /api/admin/jobs/run` or the protected scheduler).
### GET /api/admin/activity?page= → `items[]`: `created_at, actor_id, action, booking_id, details` (details plain object).
