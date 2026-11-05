create extension if not exists pgcrypto;
create extension if not exists btree_gist;
revoke create on schema public from public;

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'America/Toronto',
  currency text not null default 'CAD' check (currency ~ '^[A-Z]{3}$'),
  nightly_rate_cents integer not null check (nightly_rate_cents > 0),
  cleaning_fee_cents integer not null default 0 check (cleaning_fee_cents >= 0),
  service_rate numeric(5,4) not null default 0 check (service_rate between 0 and 1),
  max_guests integer not null check (max_guests > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.properties (id, name, slug, nightly_rate_cents, cleaning_fee_cents, service_rate, max_guests)
values ('7b894869-13bb-4a2d-9b2a-84a963fe8c2c', 'The Blue Mountain House', 'blue-mountain-house', 42500, 14500, 0.08, 8)
on conflict (slug) do update set
  nightly_rate_cents = excluded.nightly_rate_cents,
  cleaning_fee_cents = excluded.cleaning_fee_cents,
  service_rate = excluded.service_rate,
  max_guests = excluded.max_guests,
  updated_at = now();

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  confirmation_code text not null unique,
  property_id uuid not null references public.properties(id),
  guest_name text not null,
  guest_email text not null,
  guest_phone text,
  guest_notes text,
  guest_count integer not null check (guest_count > 0),
  check_in date not null,
  check_out date not null,
  nights integer not null check (nights > 0),
  nightly_rate_cents integer not null check (nightly_rate_cents >= 0),
  cleaning_fee_cents integer not null check (cleaning_fee_cents >= 0),
  service_fee_cents integer not null check (service_fee_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  currency text not null default 'CAD' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'completed')),
  payment_status text not null default 'not_required' check (payment_status in ('not_required', 'unpaid', 'processing', 'paid', 'refunded', 'failed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  calendar_token uuid not null default gen_random_uuid() unique,
  source text not null default 'direct',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_dates_valid check (check_out > check_in)
);

create index if not exists bookings_property_dates_idx on public.bookings (property_id, check_in, check_out);
create index if not exists bookings_status_idx on public.bookings (status);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_confirmed_dates_excl') then
    alter table public.bookings add constraint bookings_confirmed_dates_excl
      exclude using gist (property_id with =, daterange(check_in, check_out, '[)') with &&)
      where (status = 'confirmed');
  end if;
end;
$$;

create table if not exists public.blocked_dates (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  start_date date not null,
  end_date date not null,
  reason text not null default 'Owner block',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint blocked_dates_valid check (end_date > start_date)
);

create index if not exists blocked_dates_property_dates_idx on public.blocked_dates (property_id, start_date, end_date);

alter table public.properties enable row level security;
alter table public.admin_users enable row level security;
alter table public.bookings enable row level security;
alter table public.blocked_dates enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.properties, public.admin_users, public.bookings, public.blocked_dates to service_role;

drop policy if exists "Admins can identify themselves" on public.admin_users;
create policy "Admins can identify themselves" on public.admin_users for select to authenticated using (auth.uid() = user_id);

create or replace function public.create_booking(
  p_check_in date,
  p_check_out date,
  p_guest_count integer,
  p_guest_name text,
  p_guest_email text,
  p_guest_phone text default null,
  p_guest_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_property public.properties%rowtype;
  v_booking public.bookings%rowtype;
  v_nights integer;
  v_stay integer;
  v_service integer;
begin
  select * into v_property from public.properties where slug = 'blue-mountain-house' and active = true;
  if not found then raise exception 'Property is not available'; end if;
  perform pg_advisory_xact_lock(hashtext(v_property.id::text));
  v_nights := p_check_out - p_check_in;
  if v_nights < 1 or v_nights > 60 or p_check_in < current_date then raise exception 'Invalid stay dates'; end if;
  if p_guest_count < 1 or p_guest_count > v_property.max_guests then raise exception 'Invalid guest count'; end if;

  if exists (
    select 1 from public.bookings
    where property_id = v_property.id and status = 'confirmed'
      and p_check_in < check_out and p_check_out > check_in
  ) or exists (
    select 1 from public.blocked_dates
    where property_id = v_property.id and p_check_in < end_date and p_check_out > start_date
  ) then
    raise exception using errcode = '23P01', message = 'Dates are not available';
  end if;

  v_stay := v_nights * v_property.nightly_rate_cents;
  v_service := round(v_stay * v_property.service_rate);
  insert into public.bookings (
    confirmation_code, property_id, guest_name, guest_email, guest_phone, guest_notes, guest_count,
    check_in, check_out, nights, nightly_rate_cents, cleaning_fee_cents, service_fee_cents, total_cents, currency
  ) values (
    'BMH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_property.id,
    left(trim(p_guest_name), 100), lower(left(trim(p_guest_email), 254)), nullif(left(trim(p_guest_phone), 40), ''),
    nullif(left(trim(p_guest_notes), 1000), ''), p_guest_count, p_check_in, p_check_out, v_nights,
    v_property.nightly_rate_cents, v_property.cleaning_fee_cents, v_service,
    v_stay + v_property.cleaning_fee_cents + v_service, v_property.currency
  ) returning * into v_booking;

  return to_jsonb(v_booking);
end;
$$;

create or replace function public.create_date_block(
  p_start_date date,
  p_end_date date,
  p_reason text,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_property_id uuid;
  v_block public.blocked_dates%rowtype;
begin
  select id into v_property_id from public.properties where slug = 'blue-mountain-house' and active = true;
  perform pg_advisory_xact_lock(hashtext(v_property_id::text));
  if p_end_date <= p_start_date then raise exception 'Invalid blocked dates'; end if;
  if exists (
    select 1 from public.bookings where property_id = v_property_id and status = 'confirmed'
      and p_start_date < check_out and p_end_date > check_in
  ) or exists (
    select 1 from public.blocked_dates where property_id = v_property_id
      and p_start_date < end_date and p_end_date > start_date
  ) then
    raise exception using errcode = '23P01', message = 'Dates are not available';
  end if;
  insert into public.blocked_dates (property_id, start_date, end_date, reason, created_by)
  values (v_property_id, p_start_date, p_end_date, left(coalesce(nullif(trim(p_reason), ''), 'Owner block'), 200), p_created_by)
  returning * into v_block;
  return to_jsonb(v_block);
end;
$$;

create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if p_status not in ('pending', 'confirmed', 'cancelled', 'completed') then
    raise exception 'Invalid booking status';
  end if;
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found then raise exception 'Booking not found'; end if;
  perform pg_advisory_xact_lock(hashtext(v_booking.property_id::text));

  if p_status = 'confirmed' and (
    exists (
      select 1 from public.bookings
      where property_id = v_booking.property_id and id <> v_booking.id and status = 'confirmed'
        and v_booking.check_in < check_out and v_booking.check_out > check_in
    ) or exists (
      select 1 from public.blocked_dates
      where property_id = v_booking.property_id
        and v_booking.check_in < end_date and v_booking.check_out > start_date
    )
  ) then
    raise exception using errcode = '23P01', message = 'Dates are not available';
  end if;

  update public.bookings set status = p_status, updated_at = now() where id = p_booking_id returning * into v_booking;
  return to_jsonb(v_booking);
end;
$$;

revoke all on function public.create_booking(date, date, integer, text, text, text, text) from public, anon, authenticated;
revoke all on function public.create_date_block(date, date, text, uuid) from public, anon, authenticated;
revoke all on function public.set_booking_status(uuid, text) from public, anon, authenticated;
grant execute on function public.create_booking(date, date, integer, text, text, text, text) to service_role;
grant execute on function public.create_date_block(date, date, text, uuid) to service_role;
grant execute on function public.set_booking_status(uuid, text) to service_role;
