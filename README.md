# The Blue Mountain House

A direct-booking website and private owner portal for one vacation home in The Blue Mountains, Ontario.

The public site works in preview mode without credentials. When Supabase is configured, booking requests, availability, owner date blocks, admin status changes, and private iCalendar feeds are backed by the same database. Stripe is deliberately disabled until the payment rules and account are ready.

## What is included

- Responsive property and direct-booking website at `/`
- Server-authoritative pricing and overlap protection
- Supabase schema, row-level security, and atomic booking/block functions
- Passwordless owner portal at `/admin`
- Booking status management and owner date blocking
- Private subscribable calendar feed for Apple Calendar, Google Calendar, and Outlook
- Per-booking `.ics` download for guests
- Vercel serverless API functions
- Stripe-ready database fields, environment variables, and disabled endpoint boundaries
- Local preview fallback when Supabase has not been connected

## Local development

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env.local
npm run dev
```

The local server defaults to <http://localhost:3000>. In Conductor, the repository run script uses the workspace-specific `$CONDUCTOR_PORT`, so multiple workspaces can run at once.

Run the checks with:

```sh
npm test
npm run check
```

## 1. Connect Supabase

1. Create a Supabase project.
2. Open the SQL editor and run [`supabase/migrations/202610250001_booking_platform.sql`](supabase/migrations/202610250001_booking_platform.sql).
3. Copy `.env.example` to `.env.local` and set:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `CALENDAR_FEED_TOKEN` (use a long random value)
   - `PUBLIC_SITE_URL`
4. In Supabase Authentication URL Configuration, set the deployed site URL and allow both `https://YOUR_DOMAIN/admin` and the local `/admin` URL as redirect URLs.

The secret key is used only by Vercel functions. Never put it in browser code, commit it, or prefix it with `PUBLIC_`. Existing projects may still use the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; the code accepts both while preferring the current key types.

### Create the first administrator

In the Supabase dashboard, open Authentication → Users and invite the owner's email address. Then run this in the Supabase SQL editor, replacing the email:

```sql
insert into public.admin_users (user_id)
select id from auth.users where email = 'owner@example.com'
on conflict (user_id) do nothing;
```

Open `/admin` and request a sign-in link. The portal never creates new Auth users, and only users present in `admin_users` can access the owner APIs.

## 2. Deploy with Vercel and GitHub

1. Push this repository to GitHub.
2. In Vercel, create a project by importing the GitHub repository.
3. Keep the framework preset as **Other** and leave the build/output settings empty; Vercel serves the static files and `/api` functions directly.
4. Add the environment variables from `.env.example` for Production and Preview. Use different `CALENDAR_FEED_TOKEN` values for non-production environments.
5. Deploy, then set `PUBLIC_SITE_URL` to the final `https://…` domain and redeploy.
6. Add that domain to the Supabase Auth redirect allow list.

GitHub Actions runs syntax and unit checks on pushes to `main` and on pull requests. Vercel handles deployment through its GitHub integration.

## 3. Connect a calendar app

Sign into `/admin`, open **Calendar**, and use the private feed URL.

- Apple Calendar: File → New Calendar Subscription, then paste the URL.
- Google Calendar: Other calendars → From URL, then paste the `https://` URL.
- Outlook: Add calendar → Subscribe from web, then paste the URL.

Calendar subscriptions refresh on the calendar provider's schedule; they are not instant push notifications. Treat the feed URL like a password because it includes a secret token and shows guest names and dates. Rotate `CALENDAR_FEED_TOKEN` in Vercel if it is shared accidentally.

## 4. Enable Stripe later

Stripe is currently off and no card details are requested or collected. The schema already contains payment status and Stripe identifier fields, and placeholder routes live at:

- `POST /api/stripe/checkout`
- `POST /api/stripe/webhook`

Before setting `STRIPE_ENABLED=true`, implement and review all of the following:

1. Create Checkout Sessions server-side from a validated booking ID and the database total—not a browser-provided amount.
2. Verify webhook signatures from the raw request body.
3. Make webhook processing idempotent and transition `payment_status` safely.
4. Define deposit, tax, currency, cancellation, refund, and abandoned-checkout rules.
5. Add Stripe secrets only to Vercel environment variables.
6. Test end-to-end with Stripe test mode before accepting live payments.

The placeholder endpoints return `503` while disabled and `501` if someone enables the flag before the implementation exists. This prevents an incomplete payment flow from appearing live.

## Production checklist

- Replace all placeholder photography, house details, travel times, and policies.
- Review nightly price, fees, maximum guests, taxes, and currency in the Supabase property seed.
- Configure transactional email for new guest and owner notifications.
- Add bot protection/rate limiting to the public booking endpoint before promoting broadly.
- Confirm privacy, cancellation, rental agreement, accessibility, and local licensing requirements.
- Back up Supabase and test calendar-token rotation.

## Architecture notes

Browser code never writes directly to booking tables. Vercel functions validate input and call `security definer` database functions using the server-only service role. The SQL functions take a transaction-level advisory lock before checking date overlap, preventing two simultaneous requests from reserving the same dates. Row-level security is enabled on every application table, with no public booking policies.
