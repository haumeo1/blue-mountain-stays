-- Manager schema: pricing, immutable quotes, unified inventory, payments, refunds,
-- Stripe events, outbox, audit, calendar tokens, rate limits.
-- Schema only. Transactional write functions live in 202611050002_booking_rpcs.sql.
-- Existing property IDs and prices are preserved; nothing is reseeded.

-- Old write RPCs are replaced by manager_* functions.
drop function if exists public.create_booking(date, date, integer, text, text, text, text);
drop function if exists public.create_date_block(date, date, text, uuid);
drop function if exists public.set_booking_status(uuid, text);

-- Properties ---------------------------------------------------------------
alter table public.properties
  add column if not exists booking_enabled boolean not null default false,
  add column if not exists min_nights integer not null default 1,
  add column if not exists max_nights integer not null default 60,
  add column if not exists tax_bps integer not null default 0,
  add column if not exists tax_configured boolean not null default false,
  add column if not exists version integer not null default 1,
  add column if not exists owner_email text,
  add column if not exists draft_content jsonb not null default '{}'::jsonb,
  add column if not exists published_content jsonb not null default '{}'::jsonb,
  add constraint properties_nights_valid check (min_nights >= 1 and max_nights >= min_nights and max_nights <= 365),
  add constraint properties_tax_bps_valid check (tax_bps between 0 and 10000),
  add constraint properties_version_valid check (version >= 1);

-- Pricing overrides --------------------------------------------------------
create table public.pricing_overrides (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  start_date date not null,
  end_date date not null,
  nightly_rate_cents integer not null check (nightly_rate_cents > 0),
  min_nights integer check (min_nights is null or min_nights >= 1),
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_overrides_dates_valid check (end_date > start_date),
  constraint pricing_overrides_no_overlap exclude using gist
    (property_id with =, daterange(start_date, end_date, '[)') with &&)
);

-- Quotes (immutable). lodging_cents is exposed as stay_cents by the API. ------
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  property_version integer not null,
  check_in date not null,
  check_out date not null,
  guest_count integer not null check (guest_count > 0),
  nights integer not null check (nights > 0),
  nightly_lines jsonb not null,
  lodging_cents integer not null check (lodging_cents >= 0),
  cleaning_fee_cents integer not null check (cleaning_fee_cents >= 0),
  service_fee_cents integer not null check (service_fee_cents >= 0),
  tax_bps integer not null check (tax_bps between 0 and 10000),
  tax_cents integer not null check (tax_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint quotes_dates_valid check (check_out > check_in and nights = check_out - check_in),
  constraint quotes_total_valid check (total_cents = lodging_cents + cleaning_fee_cents + service_fee_cents + tax_cents)
);
create index quotes_property_idx on public.quotes (property_id, created_at);

-- Bookings -----------------------------------------------------------------
alter table public.bookings
  drop constraint if exists bookings_status_check,
  drop constraint if exists bookings_payment_status_check,
  add column if not exists quote_id uuid references public.quotes(id),
  add column if not exists quote_snapshot jsonb,
  add column if not exists tax_cents integer not null default 0 check (tax_cents >= 0),
  add column if not exists guest_access_hash text unique,
  add column if not exists idempotency_key text unique,
  add column if not exists idempotency_hash text,
  add column if not exists hold_expires_at timestamptz,
  add column if not exists calendar_token_hash text unique,
  add column if not exists cancel_requested boolean not null default false;

update public.bookings set quote_snapshot = jsonb_build_object(
  'legacy', true, 'check_in', check_in, 'check_out', check_out, 'nights', nights,
  'guest_count', guest_count, 'nightly_rate_cents', nightly_rate_cents,
  'lodging_cents', nights * nightly_rate_cents,
  'cleaning_fee_cents', cleaning_fee_cents, 'service_fee_cents', service_fee_cents,
  'tax_cents', 0, 'total_cents', total_cents, 'currency', currency)
where quote_snapshot is null;
update public.bookings set calendar_token_hash = encode(digest(calendar_token::text, 'sha256'), 'hex')
where calendar_token_hash is null;

alter table public.bookings
  alter column quote_snapshot set not null,
  alter column calendar_token_hash set not null,
  drop column calendar_token,
  add constraint bookings_status_check check (status in
    ('pending', 'payment_due', 'confirmed', 'completed', 'declined', 'expired', 'cancelled')),
  add constraint bookings_payment_status_check check (payment_status in
    ('not_required', 'unpaid', 'processing', 'paid', 'partially_refunded', 'refunded', 'failed')),
  add constraint bookings_idempotency_pair check ((idempotency_key is null) = (idempotency_hash is null)),
  -- Pending requests reserve nothing; only payment_due carries a hold. Leaving
  -- payment_due must clear hold_expires_at in the same update.
  add constraint bookings_hold_required check ((status = 'payment_due') = (hold_expires_at is not null));
create index bookings_hold_idx on public.bookings (hold_expires_at) where status = 'payment_due';
-- A quote can back at most one booking.
create unique index bookings_quote_once_idx on public.bookings (quote_id) where quote_id is not null;

-- Snapshot / append-only enforcement ---------------------------------------
create function public.enforce_snapshot_immutable() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_table_name = 'quotes' then
    raise exception using errcode = '55000', message = 'Quotes are immutable';
  end if;
  if tg_table_name = 'audit_events' then
    raise exception using errcode = '55000', message = 'Audit events are append-only';
  end if;
  if new.quote_snapshot is distinct from old.quote_snapshot or new.quote_id is distinct from old.quote_id
     or new.property_id is distinct from old.property_id
     or new.check_in is distinct from old.check_in or new.check_out is distinct from old.check_out
     or new.nights is distinct from old.nights or new.guest_count is distinct from old.guest_count
     or new.nightly_rate_cents is distinct from old.nightly_rate_cents
     or new.cleaning_fee_cents is distinct from old.cleaning_fee_cents
     or new.service_fee_cents is distinct from old.service_fee_cents
     or new.tax_cents is distinct from old.tax_cents
     or new.total_cents is distinct from old.total_cents or new.currency is distinct from old.currency
     or new.confirmation_code is distinct from old.confirmation_code
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'Booking quote snapshot is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_snapshot_immutable() from public, anon, authenticated;
create trigger quotes_immutable before update or delete on public.quotes
  for each row execute function public.enforce_snapshot_immutable();
create trigger bookings_snapshot_immutable before update on public.bookings
  for each row execute function public.enforce_snapshot_immutable();

-- Unified inventory. kind 'booking' covers payment_due holds and confirmed
-- stays; display state is derived from bookings.status. ----------------------
create table public.inventory_claims (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  kind text not null check (kind in ('booking', 'block')),
  booking_id uuid unique references public.bookings(id),
  block_id uuid unique references public.blocked_dates(id) on delete cascade,
  stay daterange not null check (not isempty(stay) and lower_inc(stay) and not upper_inc(stay)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint inventory_claims_owner check (
    (kind = 'booking' and booking_id is not null and block_id is null) or
    (kind = 'block' and block_id is not null and booking_id is null)),
  constraint inventory_claims_released check (active = (released_at is null)),
  constraint inventory_claims_no_overlap exclude using gist
    (property_id with =, stay with &&) where (active)
);

insert into public.inventory_claims (property_id, kind, booking_id, stay)
select property_id, 'booking', id, daterange(check_in, check_out, '[)')
from public.bookings where status in ('payment_due', 'confirmed');
insert into public.inventory_claims (property_id, kind, block_id, stay)
select property_id, 'block', id, daterange(start_date, end_date, '[)')
from public.blocked_dates;

alter table public.bookings drop constraint if exists bookings_confirmed_dates_excl;

-- Payment attempts ---------------------------------------------------------
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  idempotency_key text not null unique,
  expected_total_cents integer not null check (expected_total_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'created' check (status in
    ('created', 'session_open', 'processing', 'review', 'succeeded', 'failed', 'expired', 'cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  receipt_url text,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_attempts_lease check ((lease_owner is null) = (lease_expires_at is null))
);
create unique index payment_attempts_one_open_idx on public.payment_attempts (booking_id)
  where status in ('created', 'session_open', 'processing', 'review');

-- Refunds ------------------------------------------------------------------
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  payment_attempt_id uuid not null references public.payment_attempts(id),
  idempotency_key text not null unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  stripe_refund_id text unique,
  reason text,
  requested_by uuid references auth.users(id) on delete set null,
  next_retry_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refunds_booking_idx on public.refunds (booking_id, status);

-- Stripe events (durable, deduplicated by Stripe event id) -----------------
create table public.stripe_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  type text not null,
  livemode boolean not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index stripe_events_pending_idx on public.stripe_events (received_at) where status in ('received', 'failed');

-- Outbox. Rows reference booking + recipient role; senders resolve addresses
-- at send time. Never store raw tokens or capability URLs here. -------------
create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  booking_id uuid references public.bookings(id),
  recipient text check (recipient in ('owner', 'guest')),
  dedupe_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'leased', 'sent', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index outbox_ready_idx on public.outbox (available_at) where status in ('pending', 'leased');

-- Audit events (append-only) -----------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('admin', 'guest', 'system', 'stripe')),
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, created_at);
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.enforce_snapshot_immutable();

-- Calendar feed tokens (hash only) -----------------------------------------
create table public.calendar_tokens (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  token_hash text not null unique,
  label text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Rate limit buckets -------------------------------------------------------
create table public.rate_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  expires_at timestamptz not null,
  primary key (bucket_key, window_start)
);
create index rate_buckets_expiry_idx on public.rate_buckets (expires_at);

-- RLS and grants (no public policies) --------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pricing_overrides', 'quotes', 'inventory_claims', 'payment_attempts', 'refunds',
    'stripe_events', 'outbox', 'audit_events', 'calendar_tokens', 'rate_buckets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;
revoke update, delete, truncate on public.audit_events from service_role;

-- Guest contact data and owner email are never exposed to client roles.
revoke all on public.bookings, public.properties, public.blocked_dates from public, anon, authenticated;
