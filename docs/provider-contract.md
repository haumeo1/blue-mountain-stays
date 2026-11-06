# Provider contract

Server-only adapters in `server/integrations/`. Every function takes an injectable client (and `env` where relevant) so tests run without network. Services call these. Routes never call them directly.

## `stripe.js`

| Export | Shape / behaviour |
| --- | --- |
| `stripeMode(env)` | Returns `"test"` or `"live"`, or throws. Needs `STRIPE_ENABLED=true`. `sk_/rk_test_` keys give test mode. Live keys work only when `APP_ENV=production` and `LIVE_CHECKOUT_ENABLED=true`. |
| `stripeConfigured(env)` | Boolean for health checks. True when the mode is valid and `STRIPE_WEBHOOK_SECRET` is set. |
| `getStripe(env)` | Lazy cached client. Checks the mode first. |
| `createCheckout({attempt, booking, guestToken, siteUrl}, client, now)` | `attempt {id, idempotency_key, expected_total_cents, currency}`, `booking {id, hold_expires_at, guest_email?, description?}`. Creates one card-only line item for the full saved amount, with the currency lowercased. Session and PaymentIntent metadata are `{booking_id, attempt_id}`, and `client_reference_id` is the booking id. `expires_at` is the hold expiry, capped at 24h. If the hold has less than about 31 minutes left it **rejects** and never extends the hold. Success and cancel URLs are `/booking#token=…&checkout=success|cancelled` and the token is only ever in the fragment. Uses idempotency key `attempt.idempotency_key`. Returns `{id, url, expiresAt}`, and `url` must be https on `checkout.stripe.com`. |
| `getCheckout(id, client)` | Session with `payment_intent.latest_charge` expanded, used for the receipt URL. |
| `expireCheckout(id, client)` | Expires the session. |
| `createRefund({refund, paymentIntentId}, client)` | `refund {id, booking_id, amount_cents, idempotency_key}`. Metadata is `{refund_id, booking_id}` and the idempotency key is `refund.idempotency_key`. |
| `retrieveRefund(id, client)` | Refund object. |
| `verifyWebhook(rawBuffer, signature, client, env)` | Needs the raw `Buffer` and `STRIPE_WEBHOOK_SECRET`. Checks the signature with `constructEvent` and rejects the event if `event.livemode` doesn't match the mode. |

Only verified webhook events change payment state. Browser redirects are informational. The service layer must also check that policies are published and tax is configured before it calls `createCheckout`.

## `email.js`

| Export | Shape / behaviour |
| --- | --- |
| `emailConfigured(env)` | Needs `RESEND_API_KEY` and `RESEND_FROM`. Outside production it also needs `EMAIL_TEST_RECIPIENT`. |
| `sendNotification({id, recipient, subject, html?, text?}, client, env)` | Sends through Resend with idempotency key `outbox/<id>`. When `APP_ENV !== "production"`, all mail goes to `EMAIL_TEST_RECIPIENT` and the subject gets an `[env]` tag. If that variable is missing it throws. Returns `{providerId, redirected}`. Errors set `err.retryable`. Never logs the body, key or recipient. |

## `tokens.js`

`GUEST_TOKEN_SECRET` must be at least 32 characters.

| Export | Behaviour |
| --- | --- |
| `deterministicGuestToken(key, env)` | `guest_` + base64url HMAC-SHA256 of `guest:<key>`. |
| `deterministicCalendarToken(key, env)` | `calendar_` + base64url HMAC-SHA256 of `calendar:<key>`. |
| `randomCalendarToken()` | `calendar_` + 32 random bytes. |
| `hashToken(token)` | sha256 hex. Only hashes are stored. |
| `safeEqual(hashA, hashB)` | Constant-time comparison. Returns false if the types or lengths differ. |
| `tokenMatches(token, storedHash)` | `safeEqual(hashToken(token), storedHash)`. |
| `tokenScope(token)` | `"guest"`, `"calendar"` or `null`. |

Guest tokens travel only in URL fragments. Calendar tokens may appear only in the calendar feed link's query.
