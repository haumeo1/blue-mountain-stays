-- Legacy guest access provisioning and recovered-Checkout binding.
-- Depends on 002 (manager_require_admin, manager_audit) and 003 (manager_lock_booking,
-- manager_payment_attempt_out). SECURITY DEFINER, fixed search_path, service_role only.
-- Lock order: property advisory lock (2) -> booking row -> attempt row.

-- manager_guest_access ---------------------------------------------------------
-- Gives a legacy booking (quote_snapshot.legacy = true, no guest capability) the
-- deterministic key `legacy:<booking id>` plus a fresh guest/calendar hash pair.
-- Never overwrites an existing capability; an identical retry is a no-op.
-- IDs, totals, snapshot and history are untouched. Returns a status, never hashes.
create function public.manager_guest_access(p_booking_id uuid, p_actor uuid, p_key text,
  p_guest_hash text, p_calendar_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_b public.bookings%rowtype;
  v_marker text;
begin
  if p_booking_id is null or p_key is null or p_key <> 'legacy:' || p_booking_id::text
     or p_guest_hash is null or p_guest_hash !~ '^[0-9a-f]{64}$'
     or p_calendar_hash is null or p_calendar_hash !~ '^[0-9a-f]{64}$' or p_guest_hash = p_calendar_hash then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  perform public.manager_require_admin(p_actor);
  v_b := public.manager_lock_booking(p_booking_id);
  v_marker := encode(sha256(convert_to('legacy-access:' || p_booking_id::text, 'UTF8')), 'hex');

  if v_b.idempotency_key is not null or v_b.guest_access_hash is not null then
    if v_b.idempotency_key = p_key and v_b.idempotency_hash = v_marker
       and v_b.guest_access_hash = p_guest_hash and v_b.calendar_token_hash = p_calendar_hash then
      return jsonb_build_object('booking_id', v_b.id, 'status', 'already_provisioned');
    end if;
    raise exception using errcode = '23505', message = 'legacy_access_conflict';
  end if;
  if coalesce(v_b.quote_snapshot->>'legacy', '') <> 'true' then
    raise exception using errcode = '55000', message = 'not_legacy_booking';
  end if;

  update public.bookings set idempotency_key = p_key, idempotency_hash = v_marker,
    guest_access_hash = p_guest_hash, calendar_token_hash = p_calendar_hash, updated_at = now()
  where id = v_b.id;
  perform public.manager_audit('admin', p_actor::text, 'booking.legacy_access_provisioned', 'booking', v_b.id,
    jsonb_build_object('status', v_b.status));
  return jsonb_build_object('booking_id', v_b.id, 'status', 'provisioned');
end;
$$;

-- manager_bind_recovered --------------------------------------------------------
-- Binds a Checkout Session found by the recovery scan (any Stripe status, URL not
-- required) to an attempt that has none yet. The service passes the session it
-- re-retrieved from Stripe; amount, currency and metadata must match exactly.
-- Never confirms payment, never releases a hold, never changes attempt status.
create function public.manager_bind_recovered(p_attempt_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_b public.bookings%rowtype;
  v_a public.payment_attempts%rowtype;
  v_booking_id uuid;
  v_session text;
  v_amount bigint;
begin
  if p_attempt_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_session := nullif(p_data->>'session_id', '');
  if v_session is null or v_session !~ '^cs_[A-Za-z0-9_]{1,250}$' then
    raise exception using errcode = '22023', message = 'invalid_session_id';
  end if;
  if coalesce(p_data->>'status', '') not in ('open', 'complete', 'expired') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  begin
    v_amount := (p_data->>'amount_cents')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end;

  select booking_id into v_booking_id from public.payment_attempts where id = p_attempt_id;
  if not found then raise exception using errcode = 'P0002', message = 'attempt_not_found'; end if;
  v_b := public.manager_lock_booking(v_booking_id);
  select * into v_a from public.payment_attempts where id = p_attempt_id for update;

  if (p_data->>'attempt_id') is distinct from v_a.id::text or (p_data->>'booking_id') is distinct from v_b.id::text then
    raise exception using errcode = '55000', message = 'session_mismatch';
  end if;
  if v_amount is distinct from v_a.expected_total_cents or upper(p_data->>'currency') is distinct from v_a.currency then
    raise exception using errcode = '22023', message = 'amount_mismatch';
  end if;
  if v_a.stripe_checkout_session_id = v_session then
    return jsonb_build_object('attempt', public.manager_payment_attempt_out(v_a), 'replay', true);
  end if;
  if v_a.stripe_checkout_session_id is not null then
    raise exception using errcode = '23505', message = 'session_conflict';
  end if;
  if v_a.status not in ('created', 'session_open', 'processing', 'review') then
    raise exception using errcode = '55000', message = 'invalid_transition';
  end if;

  update public.payment_attempts set stripe_checkout_session_id = v_session, updated_at = now()
  where id = v_a.id returning * into v_a;
  perform public.manager_audit('system', null, 'payment.session_recovered', 'payment_attempt', v_a.id,
    jsonb_build_object('stripe_status', p_data->>'status', 'attempt_status', v_a.status, 'booking_id', v_b.id));
  return jsonb_build_object('attempt', public.manager_payment_attempt_out(v_a), 'replay', false);
end;
$$;

revoke all on function public.manager_guest_access(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.manager_bind_recovered(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.manager_guest_access(uuid, uuid, text, text, text) to service_role;
grant execute on function public.manager_bind_recovered(uuid, jsonb) to service_role;
