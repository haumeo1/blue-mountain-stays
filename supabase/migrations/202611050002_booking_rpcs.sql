-- Core manager RPCs: quote, request, admin action, owner block, notify.
-- All functions are SECURITY DEFINER with a fixed search_path and are executable
-- only by service_role. Errors use stable SQLSTATEs with machine-readable messages;
-- see docs/database-contract.md.

-- Internal helpers ----------------------------------------------------------
create function public.manager_booking_out(b public.bookings) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'id', b.id, 'confirmation_code', b.confirmation_code, 'status', b.status,
    'payment_status', b.payment_status, 'check_in', b.check_in, 'check_out', b.check_out,
    'nights', b.nights, 'guest_count', b.guest_count, 'guest_name', b.guest_name,
    'guest_email', b.guest_email, 'guest_phone', b.guest_phone, 'guest_notes', b.guest_notes,
    'stay_cents', coalesce((b.quote_snapshot->>'lodging_cents')::integer, b.nights * b.nightly_rate_cents),
    'cleaning_fee_cents', b.cleaning_fee_cents, 'service_fee_cents', b.service_fee_cents,
    'tax_cents', b.tax_cents, 'total_cents', b.total_cents, 'currency', b.currency,
    'hold_expires_at', b.hold_expires_at, 'cancel_requested', b.cancel_requested,
    'created_at', b.created_at, 'updated_at', b.updated_at)
$$;

create function public.manager_attempt_out(a public.payment_attempts) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case when a.id is null then null else jsonb_build_object(
    'id', a.id, 'booking_id', a.booking_id, 'idempotency_key', a.idempotency_key,
    'expected_total_cents', a.expected_total_cents, 'currency', a.currency, 'status', a.status,
    'created_at', a.created_at) end
$$;

create function public.manager_require_admin(p_actor uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_actor is null or not exists (select 1 from public.admin_users where user_id = p_actor) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

create function public.manager_audit(p_actor_type text, p_actor text, p_action text,
  p_entity_type text, p_entity uuid, p_data jsonb) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.audit_events (actor_type, actor_id, action, entity_type, entity_id, data)
  values (p_actor_type, p_actor, p_action, p_entity_type, p_entity, coalesce(p_data, '{}'::jsonb));
$$;

-- manager_notify ------------------------------------------------------------
create function public.manager_notify(p_booking_id uuid, p_topic text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner_email text;
  v_recipient text;
begin
  if p_booking_id is null or p_topic is null or p_topic !~ '^[a-z_]{3,40}$' then
    raise exception using errcode = '22023', message = 'invalid_notification';
  end if;
  select p.owner_email into v_owner_email
  from public.bookings b join public.properties p on p.id = b.property_id
  where b.id = p_booking_id;
  if not found then raise exception using errcode = 'P0002', message = 'booking_not_found'; end if;

  foreach v_recipient in array array['owner', 'guest'] loop
    continue when v_recipient = 'owner' and nullif(trim(v_owner_email), '') is null;
    insert into public.outbox (topic, booking_id, recipient, dedupe_key, payload)
    values (p_topic, p_booking_id, v_recipient, p_topic || ':' || p_booking_id || ':' || v_recipient,
      jsonb_build_object('topic', p_topic, 'booking_id', p_booking_id, 'recipient', v_recipient))
    on conflict (dedupe_key) do nothing;
  end loop;
end;
$$;

-- manager_quote -------------------------------------------------------------
create function public.manager_quote(p_check_in date, p_check_out date, p_guest_count integer)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_p public.properties%rowtype;
  v_q public.quotes%rowtype;
  v_today date;
  v_nights integer;
  v_min integer;
  v_lines jsonb;
  v_lodging integer;
  v_service integer;
  v_tax integer;
begin
  if p_check_in is null or p_check_out is null or p_guest_count is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  select * into v_p from public.properties where slug = 'blue-mountain-house' for share;
  if not found or not v_p.active or not v_p.booking_enabled then
    raise exception using errcode = '55000', message = 'booking_disabled';
  end if;

  v_today := (now() at time zone v_p.timezone)::date;
  v_nights := p_check_out - p_check_in;
  if p_check_in < v_today or v_nights < 1 then
    raise exception using errcode = '22023', message = 'invalid_dates';
  end if;
  if p_guest_count < 1 or p_guest_count > v_p.max_guests then
    raise exception using errcode = '22023', message = 'invalid_guest_count';
  end if;
  select coalesce(o.min_nights, v_p.min_nights) into v_min
  from (select 1) x left join public.pricing_overrides o
    on o.property_id = v_p.id and p_check_in >= o.start_date and p_check_in < o.end_date;
  if v_nights < v_min or v_nights > v_p.max_nights then
    raise exception using errcode = '22023', message = 'invalid_nights';
  end if;

  if exists (select 1 from public.inventory_claims c where c.property_id = v_p.id and c.active
             and c.stay && daterange(p_check_in, p_check_out, '[)')) then
    raise exception using errcode = '23P01', message = 'dates_unavailable';
  end if;

  select jsonb_agg(jsonb_build_object('date', d.night, 'rate_cents', d.rate) order by d.night),
         sum(d.rate)::integer
    into v_lines, v_lodging
  from (
    select g.night::date as night, coalesce(o.nightly_rate_cents, v_p.nightly_rate_cents) as rate
    from generate_series(p_check_in, p_check_out - 1, interval '1 day') as g(night)
    left join public.pricing_overrides o
      on o.property_id = v_p.id and g.night::date >= o.start_date and g.night::date < o.end_date
  ) d;

  v_service := round(v_lodging * v_p.service_rate)::integer;
  v_tax := round((v_lodging + v_p.cleaning_fee_cents + v_service)::numeric * v_p.tax_bps / 10000)::integer;

  insert into public.quotes (property_id, property_version, check_in, check_out, guest_count, nights,
    nightly_lines, lodging_cents, cleaning_fee_cents, service_fee_cents, tax_bps, tax_cents,
    total_cents, currency, expires_at)
  values (v_p.id, v_p.version, p_check_in, p_check_out, p_guest_count, v_nights, v_lines, v_lodging,
    v_p.cleaning_fee_cents, v_service, v_p.tax_bps, v_tax,
    v_lodging + v_p.cleaning_fee_cents + v_service + v_tax, v_p.currency, now() + interval '15 minutes')
  returning * into v_q;

  return jsonb_build_object(
    'id', v_q.id, 'check_in', v_q.check_in, 'check_out', v_q.check_out, 'guest_count', v_q.guest_count,
    'nights', v_q.nights, 'nightly_lines', v_q.nightly_lines, 'stay_cents', v_q.lodging_cents,
    'cleaning_fee_cents', v_q.cleaning_fee_cents, 'service_fee_cents', v_q.service_fee_cents,
    'tax_bps', v_q.tax_bps, 'tax_cents', v_q.tax_cents, 'total_cents', v_q.total_cents,
    'currency', v_q.currency, 'expires_at', v_q.expires_at, 'property_version', v_q.property_version);
end;
$$;

-- manager_request -----------------------------------------------------------
create function public.manager_request(p_quote_id uuid, p_guest jsonb, p_key text, p_hash text,
  p_guest_hash text, p_calendar_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_b public.bookings%rowtype;
  v_p public.properties%rowtype;
  v_q public.quotes%rowtype;
  v_name text := trim(p_guest->>'name');
  v_email text := lower(trim(p_guest->>'email'));
  v_phone text := nullif(trim(p_guest->>'phone'), '');
  v_notes text := nullif(trim(p_guest->>'notes'), '');
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_:-]{16,128}$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_idempotency_key';
  end if;

  -- Serialize on the key before any lookup so concurrent retries see one result.
  perform pg_advisory_xact_lock(1, hashtext(p_key));
  select * into v_b from public.bookings where idempotency_key = p_key;
  if found then
    if v_b.idempotency_hash = p_hash then return public.manager_booking_out(v_b); end if;
    raise exception using errcode = '23505', message = 'idempotency_conflict';
  end if;

  if p_quote_id is null or p_guest is null or jsonb_typeof(p_guest) <> 'object'
     or p_guest_hash is null or p_guest_hash !~ '^[0-9a-f]{64}$'
     or p_calendar_hash is null or p_calendar_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  if v_name is null or length(v_name) not between 1 and 100
     or v_email is null or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or length(coalesce(v_phone, '')) > 40 or length(coalesce(v_notes, '')) > 1000 then
    raise exception using errcode = '22023', message = 'invalid_guest';
  end if;

  select * into v_q from public.quotes where id = p_quote_id;
  if not found then raise exception using errcode = 'P0002', message = 'quote_not_found'; end if;
  perform pg_advisory_xact_lock(2, hashtext(v_q.property_id::text));
  select * into v_p from public.properties where id = v_q.property_id for share;
  select * into v_q from public.quotes where id = p_quote_id for update;

  if not v_p.active or not v_p.booking_enabled then
    raise exception using errcode = '55000', message = 'booking_disabled';
  end if;
  if v_q.expires_at <= now() then raise exception using errcode = '55000', message = 'quote_expired'; end if;
  if v_q.property_version <> v_p.version then
    raise exception using errcode = '55000', message = 'quote_stale';
  end if;
  if exists (select 1 from public.bookings where quote_id = v_q.id) then
    raise exception using errcode = '55000', message = 'quote_used';
  end if;
  if v_q.check_in < (now() at time zone v_p.timezone)::date then
    raise exception using errcode = '22023', message = 'invalid_dates';
  end if;
  if exists (select 1 from public.inventory_claims c where c.property_id = v_p.id and c.active
             and c.stay && daterange(v_q.check_in, v_q.check_out, '[)')) then
    raise exception using errcode = '23P01', message = 'dates_unavailable';
  end if;

  insert into public.bookings (confirmation_code, property_id, guest_name, guest_email, guest_phone,
    guest_notes, guest_count, check_in, check_out, nights, nightly_rate_cents, cleaning_fee_cents,
    service_fee_cents, tax_cents, total_cents, currency, status, payment_status, quote_id,
    quote_snapshot, guest_access_hash, calendar_token_hash, idempotency_key, idempotency_hash)
  values ('BMH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_p.id,
    v_name, v_email, v_phone, v_notes, v_q.guest_count, v_q.check_in, v_q.check_out, v_q.nights,
    round(v_q.lodging_cents::numeric / v_q.nights)::integer, v_q.cleaning_fee_cents,
    v_q.service_fee_cents, v_q.tax_cents, v_q.total_cents, v_q.currency, 'pending', 'unpaid', v_q.id,
    to_jsonb(v_q) - 'created_at', p_guest_hash, p_calendar_hash, p_key, p_hash)
  returning * into v_b;

  perform public.manager_audit('guest', null, 'booking.requested', 'booking', v_b.id,
    jsonb_build_object('quote_id', v_q.id, 'total_cents', v_q.total_cents));
  perform public.manager_notify(v_b.id, 'booking_requested');
  return public.manager_booking_out(v_b);
end;
$$;

-- manager_action ------------------------------------------------------------
create function public.manager_action(p_booking_id uuid, p_action text, p_actor uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_b public.bookings%rowtype;
  v_a public.payment_attempts%rowtype;
  v_property_id uuid;
  v_tz text;
  v_recon boolean := false;
  v_reason text := nullif(left(trim(p_reason), 500), '');
begin
  if p_booking_id is null or p_action is null
     or p_action not in ('approve', 'decline', 'cancel', 'complete') then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  perform public.manager_require_admin(p_actor);

  select property_id into v_property_id from public.bookings where id = p_booking_id;
  if not found then raise exception using errcode = 'P0002', message = 'booking_not_found'; end if;
  perform pg_advisory_xact_lock(2, hashtext(v_property_id::text));
  select * into v_b from public.bookings where id = p_booking_id for update;
  select timezone into v_tz from public.properties where id = v_b.property_id;

  if p_action = 'approve' then
    if v_b.status = 'payment_due' then
      select * into v_a from public.payment_attempts where booking_id = v_b.id
        order by created_at desc limit 1;
      return jsonb_build_object('booking', public.manager_booking_out(v_b),
        'attempt', public.manager_attempt_out(v_a), 'reconciliation_required', v_b.cancel_requested);
    end if;
    if v_b.status <> 'pending' then
      raise exception using errcode = '55000', message = 'invalid_transition';
    end if;
    if v_b.check_in < (now() at time zone v_tz)::date then
      raise exception using errcode = '55000', message = 'stay_started';
    end if;
    if v_b.total_cents <= 0 then raise exception using errcode = '55000', message = 'invalid_total'; end if;
    begin
      insert into public.inventory_claims (property_id, kind, booking_id, stay)
      values (v_b.property_id, 'booking', v_b.id, daterange(v_b.check_in, v_b.check_out, '[)'));
    exception when exclusion_violation then
      raise exception using errcode = '23P01', message = 'dates_unavailable';
    end;
    update public.bookings set status = 'payment_due', payment_status = 'unpaid',
      hold_expires_at = now() + interval '24 hours', updated_at = now()
    where id = v_b.id returning * into v_b;
    insert into public.payment_attempts (booking_id, idempotency_key, expected_total_cents, currency)
    values (v_b.id, 'booking:' || v_b.id || ':attempt:1', v_b.total_cents, v_b.currency)
    on conflict (idempotency_key) do nothing;
    select * into v_a from public.payment_attempts where idempotency_key = 'booking:' || v_b.id || ':attempt:1';
    -- payment_due email is queued by the checkout RPC once a session exists.

  elsif p_action = 'decline' then
    if v_b.status <> 'pending' then raise exception using errcode = '55000', message = 'invalid_transition'; end if;
    update public.bookings set status = 'declined', updated_at = now()
    where id = v_b.id returning * into v_b;
    perform public.manager_notify(v_b.id, 'booking_declined');

  elsif p_action = 'cancel' then
    if v_b.status = 'pending' then
      update public.bookings set status = 'cancelled', updated_at = now()
      where id = v_b.id returning * into v_b;
      perform public.manager_notify(v_b.id, 'booking_cancelled');
    elsif v_b.status = 'payment_due' then
      -- Payment may be in flight: keep the hold and let Stripe reconciliation decide.
      update public.bookings set cancel_requested = true, updated_at = now()
      where id = v_b.id returning * into v_b;
      v_recon := true;
    elsif v_b.status = 'confirmed' then
      update public.inventory_claims set active = false, released_at = now()
      where booking_id = v_b.id and active;
      update public.bookings set status = 'cancelled', updated_at = now()
      where id = v_b.id returning * into v_b;
      perform public.manager_notify(v_b.id, 'booking_cancelled');
    else
      raise exception using errcode = '55000', message = 'invalid_transition';
    end if;

  else -- complete
    if v_b.status <> 'confirmed' or v_b.check_out > (now() at time zone v_tz)::date then
      raise exception using errcode = '55000', message = 'invalid_transition';
    end if;
    update public.bookings set status = 'completed', updated_at = now()
    where id = v_b.id returning * into v_b;
  end if;

  perform public.manager_audit('admin', p_actor::text, 'booking.' || p_action, 'booking', v_b.id,
    jsonb_build_object('status', v_b.status, 'reason', v_reason, 'reconciliation_required', v_recon));
  return jsonb_build_object('booking', public.manager_booking_out(v_b),
    'attempt', public.manager_attempt_out(v_a), 'reconciliation_required', v_recon);
end;
$$;

-- manager_block -------------------------------------------------------------
create function public.manager_block(p_action text, p_actor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_property_id uuid;
  v_block public.blocked_dates%rowtype;
  v_start date;
  v_end date;
  v_id uuid;
begin
  if p_action is null or p_action not in ('create', 'delete')
     or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  perform public.manager_require_admin(p_actor);
  select id into v_property_id from public.properties where slug = 'blue-mountain-house';
  if not found then raise exception using errcode = 'P0002', message = 'property_not_found'; end if;
  perform pg_advisory_xact_lock(2, hashtext(v_property_id::text));

  if p_action = 'create' then
    begin
      v_start := (p_data->>'start_date')::date;
      v_end := (p_data->>'end_date')::date;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_dates';
    end;
    if v_start is null or v_end is null or v_end <= v_start or v_end - v_start > 366 then
      raise exception using errcode = '22023', message = 'invalid_dates';
    end if;
    insert into public.blocked_dates (property_id, start_date, end_date, reason, created_by)
    values (v_property_id, v_start, v_end,
      left(coalesce(nullif(trim(p_data->>'reason'), ''), 'Owner block'), 200), p_actor)
    returning * into v_block;
    begin
      insert into public.inventory_claims (property_id, kind, block_id, stay)
      values (v_property_id, 'block', v_block.id, daterange(v_start, v_end, '[)'));
    exception when exclusion_violation then
      raise exception using errcode = '23P01', message = 'dates_unavailable';
    end;
  else
    begin
      v_id := (p_data->>'block_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input';
    end;
    -- Only owner blocks are deletable; booking claims are never touched here.
    delete from public.blocked_dates where id = v_id and property_id = v_property_id
    returning * into v_block;
    if not found then raise exception using errcode = 'P0002', message = 'block_not_found'; end if;
  end if;

  perform public.manager_audit('admin', p_actor::text, 'block.' || p_action, 'block', v_block.id,
    jsonb_build_object('start_date', v_block.start_date, 'end_date', v_block.end_date));
  return jsonb_build_object('id', v_block.id, 'start_date', v_block.start_date,
    'end_date', v_block.end_date, 'reason', v_block.reason, 'created_at', v_block.created_at);
end;
$$;

-- Grants --------------------------------------------------------------------
revoke all on function public.manager_booking_out(public.bookings) from public, anon, authenticated;
revoke all on function public.manager_attempt_out(public.payment_attempts) from public, anon, authenticated;
revoke all on function public.manager_require_admin(uuid) from public, anon, authenticated;
revoke all on function public.manager_audit(text, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_notify(uuid, text) from public, anon, authenticated;
revoke all on function public.manager_quote(date, date, integer) from public, anon, authenticated;
revoke all on function public.manager_request(uuid, jsonb, text, text, text, text) from public, anon, authenticated;
revoke all on function public.manager_action(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.manager_block(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.manager_notify(uuid, text) to service_role;
grant execute on function public.manager_quote(date, date, integer) to service_role;
grant execute on function public.manager_request(uuid, jsonb, text, text, text, text) to service_role;
grant execute on function public.manager_action(uuid, text, uuid, text) to service_role;
grant execute on function public.manager_block(text, uuid, jsonb) to service_role;
