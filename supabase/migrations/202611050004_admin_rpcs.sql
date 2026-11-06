-- Admin RPCs: configure (pricing/content/settings/calendar/outbox), overview,
-- worker leases, rate limiting, and the property-photos storage bucket.
-- Requires 202611050003 (payment_attempts.captured_cents) to be applied first.
-- All functions: SECURITY DEFINER, fixed search_path, service_role only.
-- See docs/admin-database-contract.md.

-- Worker lease columns (no-ops if 003 already added them) -------------------
alter table public.refunds
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempts integer not null default 0;
alter table public.stripe_events add column if not exists next_retry_at timestamptz;

-- Strict JSON helpers (raise 22023 invalid_input, DETAIL = field) -----------
create function public.manager_bad(p_field text) returns void
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin raise exception using errcode = '22023', message = 'invalid_input', detail = p_field; end;
$$;

create function public.manager_keys(p jsonb, p_allowed text[], p_field text) returns void
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform public.manager_bad(p_field); end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (p_allowed)) then
    perform public.manager_bad(p_field);
  end if;
end;
$$;

-- Nullable plain-text string: trimmed, '' -> null, no control chars except \t \n \r.
create function public.manager_str(p jsonb, k text, p_max integer) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  if p->k is null or jsonb_typeof(p->k) = 'null' then return null; end if;
  if jsonb_typeof(p->k) <> 'string' then perform public.manager_bad(k); end if;
  v := nullif(btrim(p->>k), '');
  if length(v) > p_max or v ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then perform public.manager_bad(k); end if;
  return v;
end;
$$;

create function public.manager_int(p jsonb, k text, p_lo bigint, p_hi bigint) returns integer
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v numeric;
begin
  if jsonb_typeof(p->k) is distinct from 'number' then perform public.manager_bad(k); end if;
  v := (p->>k)::numeric;
  if v <> trunc(v) or v < p_lo or v > p_hi then perform public.manager_bad(k); end if;
  return v::integer;
end;
$$;

create function public.manager_bool(p jsonb, k text) returns boolean
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin
  if jsonb_typeof(p->k) is distinct from 'boolean' then perform public.manager_bad(k); end if;
  return (p->k)::boolean;
end;
$$;

create function public.manager_list(p jsonb, k text, p_max integer) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin
  if p->k is null or jsonb_typeof(p->k) = 'null' then return '[]'::jsonb; end if;
  if jsonb_typeof(p->k) <> 'array' or jsonb_array_length(p->k) > p_max then perform public.manager_bad(k); end if;
  return p->k;
end;
$$;

-- Content: rebuilds a clean object from structured input; unknown keys rejected.
create function public.manager_content_clean(c jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare
  i jsonb; v_am jsonb := '[]'; v_ph jsonb := '[]'; v_fq jsonb := '[]';
  v_pol jsonb := coalesce(nullif(c->'policies', 'null'), '{}');
  v_con jsonb := coalesce(nullif(c->'contact', 'null'), '{}');
  v_email text;
begin
  perform public.manager_keys(c, array['title', 'description', 'hero_title', 'amenities', 'photos', 'faq',
    'policies', 'contact', 'policies_confirmed', 'policies_complete'], 'content');
  if octet_length(c::text) > 262144 then perform public.manager_bad('content'); end if;
  perform public.manager_keys(v_pol, array['cancellation', 'house_rules'], 'policies');
  perform public.manager_keys(v_con, array['email', 'phone'], 'contact');
  for i in select * from jsonb_array_elements(public.manager_list(c, 'amenities', 50)) loop
    perform public.manager_keys(i, array['title', 'description'], 'amenities');
    if public.manager_str(i, 'title', 80) is null then perform public.manager_bad('amenities'); end if;
    v_am := v_am || jsonb_build_array(jsonb_build_object('title', public.manager_str(i, 'title', 80),
      'description', public.manager_str(i, 'description', 500)));
  end loop;
  for i in select * from jsonb_array_elements(public.manager_list(c, 'photos', 50)) loop
    perform public.manager_keys(i, array['path', 'url', 'alt'], 'photos');
    if coalesce(public.manager_str(i, 'path', 120), '') !~ '^property/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$'
       or coalesce(public.manager_str(i, 'url', 2048), '') !~ '^https://[^\s<>"''\\]+$' then
      perform public.manager_bad('photos');
    end if;
    v_ph := v_ph || jsonb_build_array(jsonb_build_object('path', public.manager_str(i, 'path', 120),
      'url', public.manager_str(i, 'url', 2048), 'alt', public.manager_str(i, 'alt', 200)));
  end loop;
  for i in select * from jsonb_array_elements(public.manager_list(c, 'faq', 50)) loop
    perform public.manager_keys(i, array['question', 'answer'], 'faq');
    if public.manager_str(i, 'question', 300) is null or public.manager_str(i, 'answer', 2000) is null then
      perform public.manager_bad('faq');
    end if;
    v_fq := v_fq || jsonb_build_array(jsonb_build_object('question', public.manager_str(i, 'question', 300),
      'answer', public.manager_str(i, 'answer', 2000)));
  end loop;
  v_email := lower(public.manager_str(v_con, 'email', 254));
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform public.manager_bad('contact.email'); end if;
  return jsonb_build_object(
    'title', public.manager_str(c, 'title', 120), 'hero_title', public.manager_str(c, 'hero_title', 160),
    'description', public.manager_str(c, 'description', 5000),
    'amenities', v_am, 'photos', v_ph, 'faq', v_fq,
    'policies', jsonb_build_object('cancellation', public.manager_str(v_pol, 'cancellation', 4000),
      'house_rules', public.manager_str(v_pol, 'house_rules', 4000)),
    'contact', jsonb_build_object('email', v_email, 'phone', public.manager_str(v_con, 'phone', 40)),
    'policies_confirmed', public.manager_bool(c, 'policies_confirmed'));
end;
$$;

create function public.manager_content_out(d jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case when d is null or d = '{}'::jsonb then null else d || jsonb_build_object('policies_complete',
    coalesce((d->>'policies_confirmed')::boolean, false)
    and coalesce(d#>>'{policies,cancellation}', '') <> '' and coalesce(d#>>'{policies,house_rules}', '') <> '') end
$$;

create function public.manager_section_out(p_section text, p public.properties) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case p_section
    when 'pricing' then jsonb_build_object('nightly_rate_cents', p.nightly_rate_cents,
      'cleaning_fee_cents', p.cleaning_fee_cents, 'service_bps', round(p.service_rate * 10000)::integer,
      'tax_bps', p.tax_bps, 'tax_configured', p.tax_configured, 'min_nights', p.min_nights,
      'max_nights', p.max_nights, 'max_guests', p.max_guests, 'version', p.version,
      'overrides', coalesce((select jsonb_agg(jsonb_build_object('start_date', o.start_date,
        'end_date', o.end_date, 'nightly_rate_cents', o.nightly_rate_cents) order by o.start_date)
        from public.pricing_overrides o where o.property_id = p.id), '[]'::jsonb))
    when 'settings' then jsonb_build_object('timezone', p.timezone, 'currency', p.currency,
      'owner_email', p.owner_email, 'booking_enabled', p.booking_enabled, 'version', p.version)
    else jsonb_build_object('draft', public.manager_content_out(p.draft_content),
      'published', public.manager_content_out(p.published_content), 'version', p.version) end
$$;

create function public.manager_notification_out(o public.outbox) returns jsonb
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('id', o.id, 'template', o.topic, 'recipient', o.recipient,
    'status', case o.status when 'sent' then 'sent' when 'dead' then 'failed' else 'queued' end,
    'attempts', o.attempts, 'last_error', left(o.last_error, 200), 'created_at', o.created_at)
$$;

-- manager_configure ---------------------------------------------------------
create function public.manager_configure(p_section text, p_actor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_p public.properties%rowtype;
  v_o public.outbox%rowtype;
  v_t public.calendar_tokens%rowtype;
  v_ver integer; i jsonb; v_s date; v_e date; v_min integer; v_max integer;
  v_tz text; v_cur text; v_email text; v_id uuid;
begin
  if p_section is null or p_section not in ('pricing', 'content', 'publish', 'settings',
     'calendar_rotate', 'calendar_revoke', 'outbox_retry') or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  perform public.manager_require_admin(p_actor);
  select id into v_id from public.properties where slug = 'blue-mountain-house';
  if not found then raise exception using errcode = 'P0002', message = 'property_not_found'; end if;
  perform pg_advisory_xact_lock(2, hashtext(v_id::text));
  select * into v_p from public.properties where id = v_id for update;

  if p_section in ('pricing', 'content', 'publish', 'settings') then
    v_ver := public.manager_int(p_data, 'version', 1, 2147483647);
    if v_ver <> v_p.version then raise exception using errcode = '55000', message = 'version_conflict'; end if;
  end if;

  if p_section = 'pricing' then
    perform public.manager_keys(p_data, array['nightly_rate_cents', 'cleaning_fee_cents', 'service_bps', 'tax_bps',
      'tax_configured', 'min_nights', 'max_nights', 'max_guests', 'overrides', 'version'], 'pricing');
    v_min := public.manager_int(p_data, 'min_nights', 1, 365);
    v_max := public.manager_int(p_data, 'max_nights', 1, 365);
    if v_min > v_max then perform public.manager_bad('max_nights'); end if;
    update public.properties set nightly_rate_cents = public.manager_int(p_data, 'nightly_rate_cents', 1, 10000000),
      cleaning_fee_cents = public.manager_int(p_data, 'cleaning_fee_cents', 0, 10000000),
      service_rate = public.manager_int(p_data, 'service_bps', 0, 10000)::numeric / 10000,
      tax_bps = public.manager_int(p_data, 'tax_bps', 0, 10000),
      tax_configured = public.manager_bool(p_data, 'tax_configured'),
      min_nights = v_min, max_nights = v_max, max_guests = public.manager_int(p_data, 'max_guests', 1, 100),
      version = version + 1, updated_at = now()
    where id = v_id returning * into v_p;
    delete from public.pricing_overrides where property_id = v_id;
    for i in select * from jsonb_array_elements(public.manager_list(p_data, 'overrides', 200)) loop
      perform public.manager_keys(i, array['start_date', 'end_date', 'nightly_rate_cents'], 'overrides');
      if coalesce(public.manager_str(i, 'start_date', 10), '') !~ '^\d{4}-\d{2}-\d{2}$'
         or coalesce(public.manager_str(i, 'end_date', 10), '') !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.manager_bad('overrides');
      end if;
      begin
        v_s := (i->>'start_date')::date; v_e := (i->>'end_date')::date;
      exception when others then perform public.manager_bad('overrides');
      end;
      if v_e <= v_s or v_e - v_s > 366 or v_s < date '2000-01-01' or v_e > date '2100-01-01' then
        perform public.manager_bad('overrides');
      end if;
      begin
        insert into public.pricing_overrides (property_id, start_date, end_date, nightly_rate_cents)
        values (v_id, v_s, v_e, public.manager_int(i, 'nightly_rate_cents', 1, 10000000));
      exception when exclusion_violation then
        raise exception using errcode = '22023', message = 'invalid_input', detail = 'overrides_overlap';
      end;
    end loop;
    perform public.manager_audit('admin', p_actor::text, 'pricing.updated', 'property', v_id,
      public.manager_section_out('pricing', v_p));

  elsif p_section = 'content' then
    perform public.manager_keys(p_data, array['content', 'version'], 'content');
    update public.properties set draft_content = public.manager_content_clean(p_data->'content'),
      version = version + 1, updated_at = now()
    where id = v_id returning * into v_p;
    perform public.manager_audit('admin', p_actor::text, 'content.saved', 'property', v_id,
      jsonb_build_object('version', v_p.version));

  elsif p_section = 'publish' then
    perform public.manager_keys(p_data, array['version'], 'publish');
    if v_p.draft_content = '{}'::jsonb then
      raise exception using errcode = '55000', message = 'nothing_to_publish';
    end if;
    update public.properties set published_content = draft_content, version = version + 1, updated_at = now()
    where id = v_id returning * into v_p;
    perform public.manager_audit('admin', p_actor::text, 'content.published', 'property', v_id,
      jsonb_build_object('version', v_p.version));

  elsif p_section = 'settings' then
    perform public.manager_keys(p_data, array['timezone', 'currency', 'owner_email', 'booking_enabled', 'version'], 'settings');
    v_tz := public.manager_str(p_data, 'timezone', 64);
    if v_tz is null or not exists (select 1 from pg_timezone_names where name = v_tz) then
      perform public.manager_bad('timezone');
    end if;
    v_cur := public.manager_str(p_data, 'currency', 3);
    if v_cur is null or v_cur not in ('CAD', 'USD') then perform public.manager_bad('currency'); end if;
    v_email := lower(public.manager_str(p_data, 'owner_email', 254));
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform public.manager_bad('owner_email'); end if;
    -- Currency is locked once ANY booking exists (pending, confirmed, cancelled,
    -- legacy): an unpaid booking keeps its original currency and could still be
    -- paid later. Checked under the property advisory lock + row lock above, so
    -- it cannot race booking creation. The version bump invalidates unused quotes.
    if v_cur <> v_p.currency and exists (select 1 from public.bookings b where b.property_id = v_id) then
      raise exception using errcode = '55000', message = 'currency_locked';
    end if;
    update public.properties set timezone = v_tz, currency = v_cur, owner_email = v_email,
      booking_enabled = public.manager_bool(p_data, 'booking_enabled'), version = version + 1, updated_at = now()
    where id = v_id returning * into v_p;
    perform public.manager_audit('admin', p_actor::text, 'settings.updated', 'property', v_id,
      jsonb_build_object('timezone', v_p.timezone, 'currency', v_p.currency, 'booking_enabled', v_p.booking_enabled,
        'owner_email_set', v_p.owner_email is not null, 'version', v_p.version));

  elsif p_section in ('calendar_rotate', 'calendar_revoke') then
    if p_section = 'calendar_rotate' then
      perform public.manager_keys(p_data, array['token_hash', 'label'], 'calendar');
      if coalesce(public.manager_str(p_data, 'token_hash', 64), '') !~ '^[0-9a-f]{64}$' then
        perform public.manager_bad('token_hash');
      end if;
    else
      perform public.manager_keys(p_data, array[]::text[], 'calendar');
    end if;
    update public.calendar_tokens set revoked_at = now() where property_id = v_id and revoked_at is null;
    if p_section = 'calendar_revoke' then
      perform public.manager_audit('admin', p_actor::text, 'calendar.revoked', 'property', v_id, '{}');
      return jsonb_build_object('configured', false);
    end if;
    insert into public.calendar_tokens (property_id, token_hash, label, created_by)
    values (v_id, p_data->>'token_hash', coalesce(public.manager_str(p_data, 'label', 80), 'Owner feed'), p_actor)
    returning * into v_t;
    perform public.manager_audit('admin', p_actor::text, 'calendar.rotated', 'calendar_token', v_t.id, '{}');
    return jsonb_build_object('configured', true, 'created_at', v_t.created_at, 'last_used_at', v_t.last_used_at);

  else -- outbox_retry
    perform public.manager_keys(p_data, array['id'], 'outbox');
    begin v_id := (p_data->>'id')::uuid;
    exception when others then perform public.manager_bad('id');
    end;
    if v_id is null then perform public.manager_bad('id'); end if;
    select * into v_o from public.outbox where id = v_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'notification_not_found'; end if;
    if v_o.status = 'sent' or (v_o.status = 'leased' and v_o.lease_expires_at > now()) then
      raise exception using errcode = '55000', message = 'invalid_transition';
    end if;
    update public.outbox set status = 'pending', attempts = 0, available_at = now(), lease_owner = null,
      lease_expires_at = null, last_error = null
    where id = v_id returning * into v_o;
    perform public.manager_audit('admin', p_actor::text, 'notification.retried', 'outbox', v_o.id,
      jsonb_build_object('topic', v_o.topic, 'recipient', v_o.recipient));
    return public.manager_notification_out(v_o);
  end if;

  return public.manager_section_out(case when p_section = 'publish' then 'content' else p_section end, v_p);
end;
$$;

-- manager_overview ----------------------------------------------------------
create function public.manager_overview(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_p public.properties%rowtype; v_today date; v_next jsonb; v_nights integer;
begin
  perform public.manager_require_admin(p_actor);
  select * into v_p from public.properties where slug = 'blue-mountain-house';
  if not found then raise exception using errcode = 'P0002', message = 'property_not_found'; end if;
  -- Never sum unlike currencies: if any verified captured/refunded money is in a
  -- currency other than the property currency, fail clearly for manual review.
  if exists (select 1 from public.payment_attempts a join public.bookings b on b.id = a.booking_id
       where b.property_id = v_p.id and coalesce(a.captured_cents, 0) > 0 and a.currency <> v_p.currency)
     or exists (select 1 from public.refunds r join public.bookings b on b.id = r.booking_id
       where b.property_id = v_p.id and r.status = 'succeeded' and r.currency <> v_p.currency) then
    raise exception using errcode = '55000', message = 'currency_mismatch';
  end if;
  v_today := (now() at time zone v_p.timezone)::date;
  select coalesce(sum(least(check_out, v_today + 30) - greatest(check_in, v_today)), 0) into v_nights
  from public.bookings where property_id = v_p.id and status = 'confirmed'
    and check_in < v_today + 30 and check_out > v_today;
  select jsonb_build_object('id', id, 'guest_name', guest_name, 'check_in', check_in, 'check_out', check_out,
    'guest_count', guest_count, 'confirmation_code', confirmation_code) into v_next
  from public.bookings where property_id = v_p.id and status = 'confirmed' and check_in >= v_today
  order by check_in, created_at limit 1;
  return jsonb_build_object(
    'currency', v_p.currency,
    'pending_requests', (select count(*) from public.bookings where property_id = v_p.id and status = 'pending'),
    'confirmed_arrivals', (select count(*) from public.bookings
      where property_id = v_p.id and status = 'confirmed' and check_in >= v_today),
    'paid_cents', (select coalesce(sum(a.captured_cents), 0) from public.payment_attempts a
      where coalesce(a.captured_cents, 0) > 0
        and a.booking_id in (select id from public.bookings where property_id = v_p.id)),
    'refunded_cents', (select coalesce(sum(r.amount_cents), 0) from public.refunds r
      where r.status = 'succeeded' and r.booking_id in (select id from public.bookings where property_id = v_p.id)),
    'occupancy_percent', round(v_nights * 100.0 / 30)::integer,
    'failed_notifications', (select count(*) from public.outbox where status = 'dead'),
    'next_arrival', v_next);
end;
$$;

-- manager_work (internal workers; no owner actor) ---------------------------
create function public.manager_work(p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_worker text; v_limit integer; v_id uuid; v_err text; v_has_err boolean; v_delay integer;
  v_jobs jsonb; v_row jsonb; v_evt text;
  v_o public.outbox%rowtype;
  v_tbl text; v_where text; v_order text; v_count text;
begin
  if p_action is null or p_action not in ('claim_outbox', 'ack_outbox', 'fail_outbox', 'claim_attempts',
     'settle_attempt', 'claim_refunds', 'settle_refund', 'claim_events', 'settle_event')
     or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  v_worker := public.manager_str(p_data, 'worker', 64);
  if coalesce(v_worker, '') !~ '^[A-Za-z0-9_.:-]{1,64}$' then perform public.manager_bad('worker'); end if;

  if p_action like 'claim_%' then
    perform public.manager_keys(p_data, array['worker', 'limit'], 'claim');
    v_limit := case when p_data ? 'limit' then public.manager_int(p_data, 'limit', 1, 25) else 10 end;
    delete from public.rate_buckets where ctid in
      (select ctid from public.rate_buckets where expires_at < now() limit 500);
    if p_action = 'claim_outbox' then
      update public.outbox set status = 'dead', lease_owner = null, lease_expires_at = null
      where status = 'leased' and lease_expires_at <= now() and attempts >= max_attempts;
      with c as (select id from public.outbox
          where ((status = 'pending' and available_at <= now()) or (status = 'leased' and lease_expires_at <= now()))
            and attempts < max_attempts
          order by available_at limit v_limit for update skip locked),
        u as (update public.outbox o set status = 'leased', attempts = o.attempts + 1, lease_owner = v_worker,
          lease_expires_at = now() + interval '2 minutes' from c where o.id = c.id returning o.*)
      select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v_jobs from u;
      return jsonb_build_object('jobs', v_jobs);
    end if;
    select t, w, o, n into v_tbl, v_where, v_order, v_count from (values
      ('claim_attempts', 'payment_attempts', 'status in (''created'',''session_open'',''processing'',''review'') and coalesce(next_retry_at, created_at) <= now()', 'created_at', 'attempt_count'),
      ('claim_refunds', 'refunds', 'status = ''pending'' and coalesce(next_retry_at, created_at) <= now()', 'created_at', 'attempts'),
      ('claim_events', 'stripe_events', 'status in (''received'',''failed'') and coalesce(next_retry_at, received_at) <= now() and attempts < 25', 'received_at', 'attempts')
    ) x(a, t, w, o, n) where a = p_action;
    execute format('with c as (select id from public.%1$I where %2$s and (lease_expires_at is null or lease_expires_at <= now()) '
      'order by %3$I limit %4$s for update skip locked), u as (update public.%1$I t set lease_owner = $1, '
      'lease_expires_at = now() + interval ''2 minutes'', %5$I = t.%5$I + 1 from c where t.id = c.id returning t.*) '
      'select coalesce(jsonb_agg(to_jsonb(u)), ''[]''::jsonb) from u', v_tbl, v_where, v_order, v_limit, v_count)
      into v_jobs using v_worker;
    return jsonb_build_object('jobs', v_jobs);
  end if;

  perform public.manager_keys(p_data, array['worker', 'id', 'error', 'delay_seconds'], 'settle');
  begin v_id := (p_data->>'id')::uuid;
  exception when others then perform public.manager_bad('id');
  end;
  if v_id is null then perform public.manager_bad('id'); end if;
  -- Omitted 'error' key preserves last_error; explicit null (or "") clears it.
  v_has_err := p_data ? 'error';
  v_err := public.manager_safe_error(public.manager_str(p_data, 'error', 2000));

  if p_action = 'ack_outbox' then
    update public.outbox set status = 'sent', sent_at = now(), lease_owner = null, lease_expires_at = null,
      last_error = null
    where id = v_id and status = 'leased' and lease_owner = v_worker returning * into v_o;
  elsif p_action = 'fail_outbox' then
    update public.outbox set lease_owner = null, lease_expires_at = null,
      last_error = coalesce(v_err, 'send_failed'),
      status = case when attempts >= max_attempts then 'dead' else 'pending' end,
      available_at = now() + make_interval(secs => least(86400, 60 * power(2, least(attempts, 20) - 1)))
    where id = v_id and status = 'leased' and lease_owner = v_worker returning * into v_o;
  else
    v_delay := public.manager_int(p_data, 'delay_seconds', 0, 86400);
    v_tbl := case p_action when 'settle_attempt' then 'payment_attempts' when 'settle_refund' then 'refunds'
      else 'stripe_events' end;
    if v_tbl = 'stripe_events' then
      -- Same lock as manager_event, so a settle never interleaves with a webhook/worker effect.
      select stripe_event_id into v_evt from public.stripe_events where id = v_id;
      if found then perform pg_advisory_xact_lock(3, hashtext(v_evt)); end if;
    end if;
    execute format('update public.%1$I t set lease_owner = null, lease_expires_at = null, '
      'next_retry_at = now() + make_interval(secs => $3), '
      'last_error = case when $5 then $4 else t.last_error end %2$s '
      'where t.id = $1 and t.lease_owner = $2 returning to_jsonb(t.*)', v_tbl,
      case when v_tbl = 'stripe_events' then
        ', status = case when $5 and $4 is not null and t.status in (''received'',''failed'') then ''failed'' else t.status end'
      else '' end)
      into v_row using v_id, v_worker, v_delay, v_err, v_has_err;
    if v_row is null then raise exception using errcode = '55000', message = 'lease_lost'; end if;
    return jsonb_build_object('job', v_row);
  end if;
  if v_o.id is null then raise exception using errcode = '55000', message = 'lease_lost'; end if;
  return jsonb_build_object('job', to_jsonb(v_o));
end;
$$;

-- manager_retry_events (owner) ----------------------------------------------
-- Requeues exhausted Stripe events (status 'received' or 'failed', attempts >= 25) whose
-- lease is unset or expired: attempts = 0, next_retry_at = now(), lease cleared; status
-- and last_error kept. 'received' covers a worker that crashed after claiming (lease
-- expired) without recording failure. 'processed'/'ignored' are never touched.
-- Up to 100 per call. Takes each event's advisory lock (3) before its row, the same
-- order as manager_event, and re-checks under lock. Always writes one audit event.
create function public.manager_retry_events(p_actor uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_evt text; v_ids text[] := '{}';
begin
  perform public.manager_require_admin(p_actor);
  for v_evt in select stripe_event_id from public.stripe_events
      where status in ('received', 'failed') and attempts >= 25
        and (lease_expires_at is null or lease_expires_at <= now())
      order by received_at limit 100 loop
    perform pg_advisory_xact_lock(3, hashtext(v_evt));
    update public.stripe_events set attempts = 0, next_retry_at = now(), lease_owner = null, lease_expires_at = null
    where stripe_event_id = v_evt and status in ('received', 'failed') and attempts >= 25
      and (lease_expires_at is null or lease_expires_at <= now());
    if found then v_ids := v_ids || v_evt; end if;
  end loop;
  perform public.manager_audit('admin', p_actor::text, 'stripe_events.requeued', 'stripe_event', null,
    jsonb_build_object('count', cardinality(v_ids), 'event_ids', to_jsonb(v_ids)));
  return jsonb_build_object('requeued', cardinality(v_ids), 'event_ids', to_jsonb(v_ids));
end;
$$;

-- manager_rate_limit --------------------------------------------------------
create function public.manager_rate_limit(p_key text, p_limit integer, p_seconds integer) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_window timestamptz; v_hits integer; v_key text;
begin
  if p_key is null or length(p_key) not between 1 and 256 or p_limit is null or p_limit not between 1 and 100000
     or p_seconds is null or p_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_key := encode(sha256(convert_to(p_seconds || ':' || p_key, 'UTF8')), 'hex');
  v_window := to_timestamp(floor(extract(epoch from now()) / p_seconds) * p_seconds);
  insert into public.rate_buckets (bucket_key, window_start, hits, expires_at)
  values (v_key, v_window, 1, v_window + make_interval(secs => p_seconds))
  on conflict (bucket_key, window_start) do update set hits = public.rate_buckets.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

-- Storage: public-read photo bucket; writes only via service-created signed uploads.
-- No storage.objects policies are granted to anon/authenticated.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('property-photos', 'property-photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Grants --------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['manager_bad(text)', 'manager_keys(jsonb, text[], text)', 'manager_str(jsonb, text, integer)',
    'manager_int(jsonb, text, bigint, bigint)', 'manager_bool(jsonb, text)', 'manager_list(jsonb, text, integer)',
    'manager_content_clean(jsonb)', 'manager_content_out(jsonb)', 'manager_section_out(text, public.properties)',
    'manager_notification_out(public.outbox)', 'manager_configure(text, uuid, jsonb)', 'manager_overview(uuid)',
    'manager_work(text, jsonb)', 'manager_retry_events(uuid)', 'manager_rate_limit(text, integer, integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;
grant execute on function public.manager_configure(text, uuid, jsonb) to service_role;
grant execute on function public.manager_overview(uuid) to service_role;
grant execute on function public.manager_work(text, jsonb) to service_role;
grant execute on function public.manager_retry_events(uuid) to service_role;
grant execute on function public.manager_rate_limit(text, integer, integer) to service_role;
