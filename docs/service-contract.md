# Service contract (`server/services/`)

Route handlers parse the request, authorize, call one service, and wrap the return value as `{"data": …}`.
Every service takes an optional trailing `db` (Supabase SDK client) for tests; it defaults to `getDatabase()`.
Errors are `HttpError`s (validation → `400 validation_failed` with `details.fields`); handlers pass them to `handleError`.

## `data.js` (shared, internal)

| Export | Notes |
| --- | --- |
| `PROPERTY_SLUG` | `"blue-mountain-house"` |
| `getProperty(db)` / `getBooking(id, db)` / `getAttemptForBooking(bookingId, db)` | **Internal rows** (PII, hashes). Never return directly. Latest attempt or `null`. |
| `mapBooking(row)` | Admin allowlist (accepts a row or `manager_booking_out`). `stay_cents` from the quote snapshot. |
| `safeGuestBooking(row)` | Guest allowlist: no id, email, phone, notes, tokens, hashes, keys. |
| `run(builder)` / `rpc(name, args, db)` | SDK wrappers → result / data, or mapped `HttpError`. |
| `uuid`, `isoDate`, `dateRange(from,to,{max=366})`, `enumValue`, `text`, `integer`, `bool`, `onlyKeys`, `pagination(query)`, `listOf` | Validators. Pagination: `page` ≥1, `page_size` default 20, max 100. |
| `searchPattern`, `parseStay`, `claimsBetween`, `contentOut`, `safeDetails`, `safeError`, `safeHttpsUrl` | Helpers. |

Search: only letters, digits, space and `@ . + ' - _` survive; the value is double-quoted in the PostgREST `or()` filter and `_` is LIKE-escaped. Commas, parentheses, quotes, `*`, `%` and backslashes are removed, so the filter can't be broken out of.

## `public.js`

| Export | Route | Returns |
| --- | --- | --- |
| `publicConfig(db?)` | `GET /api/config` | `{supabaseUrl, supabasePublishableKey, demoMode, bookingEnabled}`. Never throws. If the DB is not configured or unreachable, `bookingEnabled:false`. `demoMode` = `demoModeEnabled()`, which is always false when deployed. |
| `publicProperty(db?)` | `GET /api/property` | `{property, content|null}`. Published content only. |
| `availability(query, db?)` | `GET /api/availability` | `{ranges:[{start,end,type:"unavailable"}]}`. The range is at most 366 days, and overlapping ranges are merged. |
| `quote(body, request, db?)` | `POST /api/quotes` | `{quote}` (the `manager_quote` result). Rate limit: 20/min. |
| `requestBooking(body, request, db?)` | `POST /api/bookings` | `{booking:{id,…safeGuestBooking}, guest_token}`. Rate limit: 5/min. The route responds 201 (replays can't be told apart, so they also return 201). |
| `requireGuest(request, db?)` | used by payments | **Internal booking row.** The token must be `Bearer guest_…`, and calendar tokens are rejected. Otherwise 401. |
| `guestBooking(request, db?)` | `GET /api/guest/booking` | `{booking, payment:{status, receipt_url}, calendar_url}` |
| `guestPaymentStatus(row)`, `rateLimit(request, endpoint, limit, db?, seconds=60)` | helpers | |

- **Body rules:** request bodies reject unknown keys.
- **Request hash:** sha256 of `JSON.stringify([quote_id, name, email(lowercased), phone, notes, idempotency_key])`.
- **Tokens:** the guest and calendar tokens are derived from the key, and only their hashes are sent to the DB.
- **Rate limiting:** uses `manager_rate_limit` (migration 004). The key is `endpoint:HMAC(GUEST_TOKEN_SECRET, endpoint:ip)`, so raw IPs are never stored. The IP comes from `x-vercel-forwarded-for` only when `VERCEL` is set; otherwise it is `socket.remoteAddress`. `X-Forwarded-For` is never trusted.
- **Guest `booking.status`:** the true DB status, so it includes `payment_due` and `expired`.
- **Guest `payment.status`:** passes `processing`, `paid`, `partially_refunded`, `refunded` and `failed` through. `unpaid` becomes `payment_due` when the booking is `payment_due`; everything else is `not_due`.
- **`receipt_url`:** only `https` on `*.stripe.com`, and only once the booking is paid.
- **`calendar_url`:** `${getBaseUrl()}/api/calendar/guest?token=<deterministicCalendarToken(key)>` when the booking has an idempotency key, otherwise `null`.

## `admin.js`

`actor` is the user returned by `requireAdmin(request)`; services verify that `actor.id` is a UUID. Mutations pass `p_actor` to RPCs, which re-check admin membership.

| Export | Route | Returns / notes |
| --- | --- | --- |
| `overview(actor)` | GET overview | `manager_overview` result |
| `listBookings(query, actor)` | GET bookings | list of `mapBooking`. `status` must be a valid status. `search` matches name, email or code (ILIKE). Uses `count: exact` and `range`. |
| `bookingDetail(id, actor)` | GET bookings/:id | `{booking, history, payments, refunds}`. History is up to 200 entries with safe details. Payment `amount_cents` is captured, or expected if nothing was captured. |
| `bookingAction(id, body, actor)` | POST bookings/:id/actions | **Raw** `{booking, attempt, reconciliation_required}` for the payment coordinator. |
| `actionResponse(result)` | ← | `{booking, payment_pending, reconciliation_required}`. **Routes must respond with this** (the attempt carries an idempotency key). |
| `adminAvailability(query, actor)` | GET availability | `{ranges:[{id,start,end,type:booking|hold|block,label,booking_id,block_id}]}`. At most 366 days. |
| `createBlock(body, actor)` / `deleteBlock(id, actor)` | POST blocks / DELETE blocks/:id | `{block}` (route 201) / `{deleted:true}` |
| `getPricing(actor)` / `savePricing(body, actor)` | GET/PUT pricing | Pricing shape. **PUT requires a boolean `tax_configured`.** |
| `getContent(actor)` / `saveContent(body, actor)` / `publishContent(body, actor)` | GET/PUT content, POST publish | `{draft, published|null, version}`. Body `{content, version}` / `{version}`. |
| `uploadPhoto(body, actor)` | POST photos/upload | `{signed_url, path, public_url}` |
| `listPayments(query, actor)` | GET payments | list. Adds `attempt_status`. `refunded_cents` sums only `succeeded` refunds, and only for attempts on the current page. |
| `listNotifications(query, actor)` / `retryNotification(id, actor)` | GET notifications / POST retry | `recipient` is the email address resolved at read time. `last_error` is sanitised. Also includes `booking_id`. |
| `calendarSettings(actor)` / `rotateCalendar(actor, request)` / `revokeCalendar(actor)` | GET / POST rotate / DELETE | Rotate returns the raw URLs once; only the hash is stored. |
| `getSettings(actor)` / `saveSettings(body, actor)` | GET/PUT settings | Currency must be `CAD` or `USD`. An empty `owner_email` is stored as `null`. |
| `activity(query, actor)` | GET activity | list of `{created_at, actor_id, action, booking_id, details}` |
| `health(actor)` | GET health | `{services:[{name,configured,reachable,message}]}` |

Notes:

- **Content `policies_confirmed`:** the UI must send this boolean. `policies_complete` is always derived (`policies_confirmed === true` and non-blank cancellation and house rules), both in SQL `manager_content_out` and in `data.contentOut` / `policiesComplete`. A stored flag is never trusted.
- **Content photo URLs:** a new photo's `url` must equal exactly `https://<SUPABASE_URL host>/storage/v1/object/public/property-photos/<path>`, where `path` is `property/<uuid>.<ext>`. An unchanged `(url, path)` pair already in the draft or published content may be re-saved. The server never fetches photos.
- **Text:** all text is plain and bounded, matching SQL 004: title 120, hero_title 160, amenity title 80, each policy 4000, and 50 amenities/photos/FAQ entries.
- **`retryNotification`:** `manager_configure('outbox_retry')` returns a normalized row, so the service re-reads the raw outbox row by id before mapping `template`/`booking_id`/`recipient`. Stored `last_error` is preserved.
- **`retryEvents(actor)`** → `{requeued}`: `POST /api/admin/jobs/retry-events` (owner auth). Calls `manager_retry_events(p_actor)` to requeue exhausted failed webhook events, audited in SQL. It is never called by cron or `runJobs`.
- **Guest booking view** (`safeGuestBooking`) includes `hold_expires_at`.
- **Errors:** every stable 002–005 SQL token is mapped to a safe 400/404/409 code in `KNOWN_ERRORS` (refund caps and conflicts are 409, bad input is 400, missing rows are 404, version is 409). User errors never become 502, and SQL details are never returned.
- **Upload:** the path is `property/<randomUUID>.<ext>`, chosen by the server. The extension must match `content_type` (jpeg/png/webp), and the size must be 10 MiB or less (the bucket enforces this too).
- **Health checks:**
  - **supabase:** a real property read.
  - **stripe:** `accounts.retrieve()`.
  - **email:** Resend `domains.list()`, where the `RESEND_FROM` domain must be `verified` (no email is sent).
  - **tokens:** `GUEST_TOKEN_SECRET` must be at least 32 characters and a canonical base URL must be configured.
  - **cron:** only checks that `CRON_SECRET` is present (stated in the message).

  Failures report a generic message.

## Dependencies on migration 004 (not yet verified here)

- **RPCs used:** `manager_overview(p_actor)`, `manager_configure(p_section, p_actor, p_data)` and `manager_rate_limit(p_key, p_limit, p_seconds)`.
- **Assumed return shapes for `manager_configure`:**
  - `pricing` returns a pricing object with `service_bps` or `service_rate`, plus `overrides` and `version`.
  - `content` and `publish` return `{draft, published, version}`, or the property row.
  - `settings` returns the settings object.
  - `outbox_retry` returns an outbox row.
- **Calendar sections:** `calendar_rotate` takes `{token_hash}` and `calendar_revoke` takes `{}`.

The 004 error tokens `version_conflict` and `forbidden` are already mapped. Any new tokens (for example a currency-change conflict) must be added to `KNOWN_ERRORS` in `server/integrations/supabase.js`.
