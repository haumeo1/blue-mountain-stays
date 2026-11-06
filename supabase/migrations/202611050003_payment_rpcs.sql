-- Payment, refund, and Stripe event RPCs. See docs/payment-database-contract.md.
-- Depends on 202611050002 helpers: manager_require_admin, manager_audit,
-- manager_notify, manager_booking_out. Lock order everywhere:
--   event advisory lock (3) -> property advisory lock (2) -> booking row -> attempt row -> refund row.
-- Money facts (captured cents, payment intent, succeeded refunds) only come from
-- signature-verified Stripe effects routed through manager_event.

-- Schema additions ----------------------------------------------------------
alter table public.payment_attempts
  add column if not exists captured_cents integer not null default 0,
  add column if not exists verified_paid_at timestamptz,
  add column if not exists receipt_url text,
  add column if not exists session_url text,
  add column if not exists paid_event_id text;
alter table public.payment_attempts
  add constraint payment_attempts_captured_valid check (captured_cents >= 0),
  add constraint payment_attempts_capture_verified check (
    (captured_cents > 0) = (verified_paid_at is not null)
    and (verified_paid_at is null or stripe_payment_intent_id is not null));
-- Attempt status check from 001 (includes 'review') is preserved unchanged.

alter table public.refunds
  add column if not exists verified_at timestamptz,
  add column if not exists source text not null default 'admin' check (source in ('admin', 'stripe'));

-- Event retry schedule (manager_event sets it on failure; claim_events in 004 honours it).
alter table public.stripe_events add column if not exists next_retry_at timestamptz;

create index if not exists payment_attempts_booking_idx on public.payment_attempts (booking_id, created_at desc);
create index if not exists payment_attempts_retry_idx on public.payment_attempts (next_retry_at)
  where status in ('created', 'session_open');
create index if not exists refunds_attempt_idx on public.refunds (payment_attempt_id, status);
create index if not exists refunds_retry_idx on public.refunds (next_retry_at) where status = 'pending';
create index if not exists stripe_events_type_idx on public.stripe_events (type, received_at);

-- Verified money facts are write-once.
create function public.enforce_payment_facts() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_table_name = 'payment_attempts' then
    if (old.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id)
       or (old.stripe_payment_intent_id is not null and new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id)
       or (old.verified_paid_at is not null and (new.verified_paid_at is distinct from old.verified_paid_at
           or new.captured_cents is distinct from old.captured_cents))
       or new.expected_total_cents is distinct from old.expected_total_cents
       or new.currency is distinct from old.currency or new.booking_id is distinct from old.booking_id then
      raise exception using errcode = '55000', message = 'payment_facts_immutable';
    end if;
  else
    if old.status = 'succeeded' and new.status <> 'succeeded'
       or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
       or new.booking_id is distinct from old.booking_id or new.payment_attempt_id is distinct from old.payment_attempt_id
       or (old.stripe_refund_id is not null and new.stripe_refund_id is distinct from old.stripe_refund_id) then
      raise exception using errcode = '55000', message = 'refund_facts_immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_payment_facts() from public, anon, authenticated;
create trigger payment_attempts_facts before update on public.payment_attempts
  for each row execute function public.enforce_payment_facts();
create trigger refunds_facts before update on public.refunds
  for each row execute function public.enforce_payment_facts();

-- Helpers -------------------------------------------------------------------
create function public.manager_payment_attempt_out(a public.payment_attempts) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case when a.id is null then null else jsonb_build_object(
    'id', a.id, 'booking_id', a.booking_id, 'idempotency_key', a.idempotency_key,
    'expected_total_cents', a.expected_total_cents, 'currency', a.currency, 'status', a.status,
    'stripe_checkout_session_id', a.stripe_checkout_session_id, 'session_url', a.session_url,
    'stripe_payment_intent_id', a.stripe_payment_intent_id, 'captured_cents', a.captured_cents,
    'verified_paid_at', a.verified_paid_at, 'receipt_url', a.receipt_url,
    'attempt_count', a.attempt_count, 'next_retry_at', a.next_retry_at, 'last_error', a.last_error,
    'created_at', a.created_at, 'updated_at', a.updated_at) end
$$;

create function public.manager_refund_out(r public.refunds) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'booking_id', r.booking_id, 'payment_attempt_id', r.payment_attempt_id,
    'payment_intent', (select stripe_payment_intent_id from public.payment_attempts where id = r.payment_attempt_id),
    'idempotency_key', r.idempotency_key, 'amount_cents', r.amount_cents, 'currency', r.currency,
    'status', r.status, 'stripe_refund_id', r.stripe_refund_id, 'reason', r.reason, 'source', r.source,
    'next_retry_at', r.next_retry_at, 'last_error', r.last_error, 'verified_at', r.verified_at,
    'created_at', r.created_at, 'updated_at', r.updated_at) end
$$;

-- null -> null (callers that need a value coalesce first); otherwise sanitized, never empty.
create function public.manager_safe_error(p text) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case when p is null then null else
    coalesce(nullif(left(regexp_replace(p, '[^[:alnum:] _.:,()/-]', '', 'g'), 300), ''), 'unknown_error') end
$$;

-- True only inside manager_event's effect step (transaction-local marker).
create function public.manager_in_verified_event() returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(current_setting('manager.verified_event', true), '') <> ''
$$;

create function public.manager_lock_booking(p_booking_id uuid) returns public.bookings
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_property uuid; v_b public.bookings%rowtype;
begin
  select property_id into v_property from public.bookings where id = p_booking_id;
  if not found then raise exception using errcode = 'P0002', message = 'booking_not_found'; end if;
  perform pg_advisory_xact_lock(2, hashtext(v_property::text));
  select * into v_b from public.bookings where id = p_booking_id for update;
  return v_b;
end;
$$;

-- manager_payment -----------------------------------------------------------
create function public.manager_payment(p_attempt_id uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_b public.bookings%rowtype;
  v_a public.payment_attempts%rowtype;
  v_booking_id uuid;
  v_d jsonb := coalesce(p_data, '{}'::jsonb);
  v_session text := nullif(v_d->>'session_id', '');
  v_amount bigint;
  v_currency text := upper(nullif(v_d->>'currency', ''));
  v_pi text := nullif(v_d->>'payment_intent', '');
  v_claim boolean;
  v_released boolean := false;
begin
  if p_attempt_id is null or p_action is null
     or p_action not in ('attached', 'error', 'terminal_unpaid', 'paid') then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  if p_action = 'paid' and not public.manager_in_verified_event() then
    raise exception using errcode = '42501', message = 'verified_event_required';
  end if;
  begin
    v_amount := (v_d->>'amount_cents')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_amount';
  end;

  select booking_id into v_booking_id from public.payment_attempts where id = p_attempt_id;
  if not found then raise exception using errcode = 'P0002', message = 'attempt_not_found'; end if;
  v_b := public.manager_lock_booking(v_booking_id);
  select * into v_a from public.payment_attempts where id = p_attempt_id for update;

  if v_session is not null and v_session !~ '^cs_[A-Za-z0-9_]{1,250}$' then
    raise exception using errcode = '22023', message = 'invalid_session_id';
  end if;

  if p_action = 'attached' then
    if v_session is null then raise exception using errcode = '22023', message = 'invalid_session_id'; end if;
    if v_amount is distinct from v_a.expected_total_cents or v_currency is distinct from v_a.currency then
      raise exception using errcode = '22023', message = 'amount_mismatch';
    end if;
    if v_a.stripe_checkout_session_id is not null and v_a.stripe_checkout_session_id <> v_session then
      raise exception using errcode = '23505', message = 'session_conflict';
    end if;
    if nullif(v_d->>'session_url', '') is null or v_d->>'session_url' !~ '^https://checkout\.stripe\.com/' then
      raise exception using errcode = '22023', message = 'invalid_session_url';
    end if;
    update public.payment_attempts set stripe_checkout_session_id = v_session,
      session_url = coalesce(session_url, v_d->>'session_url'),
      status = case when status = 'created' then 'session_open' else status end,
      last_error = case when status = 'created' then null else last_error end,
      next_retry_at = case when status = 'created' then null else next_retry_at end,
      updated_at = now()
    where id = v_a.id returning * into v_a;
    if v_a.status = 'session_open' and v_b.status = 'payment_due' and not v_b.cancel_requested then
      perform public.manager_notify(v_b.id, 'payment_due');
    end if;

  elsif p_action = 'error' then
    if v_a.status in ('created', 'session_open') then
      update public.payment_attempts set attempt_count = attempt_count + 1,
        last_error = public.manager_safe_error(coalesce(v_d->>'error', 'unknown_error')),
        next_retry_at = now() + make_interval(secs => least(3600, 30 * power(2, least(attempt_count, 10))::integer)),
        updated_at = now()
      where id = v_a.id returning * into v_a;
    end if;

  elsif p_action = 'terminal_unpaid' then
    if v_session is null or v_d->>'status' is distinct from 'expired'
       or v_d->>'payment_status' is distinct from 'unpaid' then
      raise exception using errcode = '22023', message = 'terminal_evidence_required';
    end if;
    if v_a.stripe_checkout_session_id is distinct from v_session then
      raise exception using errcode = '55000', message = 'session_mismatch';
    end if;
    if v_a.status in ('expired', 'cancelled') then
      null; -- replay
    elsif v_a.status not in ('created', 'session_open', 'processing') or v_a.captured_cents > 0 then
      raise exception using errcode = '55000', message = 'invalid_transition';
    else
      update public.payment_attempts set
        status = case when v_b.cancel_requested then 'cancelled' else 'expired' end,
        next_retry_at = null, lease_owner = null, lease_expires_at = null, updated_at = now()
      where id = v_a.id returning * into v_a;
      if v_b.status = 'payment_due' then
        update public.inventory_claims set active = false, released_at = now()
        where booking_id = v_b.id and active;
        update public.bookings set status = case when cancel_requested then 'cancelled' else 'expired' end,
          hold_expires_at = null, updated_at = now()
        where id = v_b.id returning * into v_b;
        v_released := true;
        perform public.manager_notify(v_b.id, case when v_b.status = 'cancelled' then 'booking_cancelled' else 'booking_expired' end);
      end if;
      perform public.manager_audit('stripe', v_session, 'payment.terminal_unpaid', 'payment_attempt', v_a.id,
        jsonb_build_object('attempt_status', v_a.status, 'booking_status', v_b.status, 'released', v_released));
    end if;

  else -- paid (verified webhook only)
    if v_session is null or v_pi is null or v_pi !~ '^pi_[A-Za-z0-9_]{1,250}$'
       or (v_d->>'booking_id') is distinct from v_b.id::text
       or (v_d->>'attempt_id') is distinct from v_a.id::text then
      raise exception using errcode = '22023', message = 'invalid_payment_evidence';
    end if;
    if v_amount is distinct from v_a.expected_total_cents or v_currency is distinct from v_a.currency then
      raise exception using errcode = '22023', message = 'amount_mismatch';
    end if;
    if v_a.stripe_checkout_session_id is not null and v_a.stripe_checkout_session_id <> v_session then
      raise exception using errcode = '55000', message = 'session_mismatch';
    end if;
    if v_a.verified_paid_at is not null then
      if v_a.stripe_payment_intent_id = v_pi and v_a.captured_cents = v_amount then
        return jsonb_build_object('booking', public.manager_booking_out(v_b),
          'attempt', public.manager_payment_attempt_out(v_a), 'replay', true);
      end if;
      raise exception using errcode = '55000', message = 'payment_conflict';
    end if;

    select exists (select 1 from public.inventory_claims
      where booking_id = v_b.id and active and property_id = v_b.property_id
        and stay = daterange(v_b.check_in, v_b.check_out, '[)')) into v_claim;

    update public.payment_attempts set stripe_checkout_session_id = v_session,
      stripe_payment_intent_id = v_pi, captured_cents = v_amount, verified_paid_at = now(),
      receipt_url = coalesce(nullif(v_d->>'receipt_url', ''), receipt_url),
      paid_event_id = current_setting('manager.verified_event', true),
      status = case when v_b.status = 'payment_due' and v_claim then 'succeeded' else 'review' end,
      next_retry_at = null, last_error = null, lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = v_a.id returning * into v_a;

    if v_a.status = 'succeeded' and v_b.cancel_requested then
      update public.inventory_claims set active = false, released_at = now()
      where booking_id = v_b.id and active;
      update public.bookings set status = 'cancelled', payment_status = 'paid', hold_expires_at = null,
        updated_at = now() where id = v_b.id returning * into v_b;
      perform public.manager_notify(v_b.id, 'booking_cancelled');
    elsif v_a.status = 'succeeded' then
      update public.bookings set status = 'confirmed', payment_status = 'paid', hold_expires_at = null,
        updated_at = now() where id = v_b.id returning * into v_b;
      perform public.manager_notify(v_b.id, 'booking_confirmed');
    else
      -- Money arrived but the booking cannot be confirmed: record funds, flag for review.
      update public.bookings set
        payment_status = case when payment_status in ('partially_refunded', 'refunded') then payment_status else 'paid' end,
        updated_at = now() where id = v_b.id returning * into v_b;
    end if;
    perform public.manager_audit('stripe', current_setting('manager.verified_event', true), 'payment.paid',
      'payment_attempt', v_a.id, jsonb_build_object('attempt_status', v_a.status, 'booking_status', v_b.status,
        'captured_cents', v_a.captured_cents, 'currency', v_a.currency));
  end if;

  return jsonb_build_object('booking', public.manager_booking_out(v_b),
    'attempt', public.manager_payment_attempt_out(v_a));
end;
$$;

-- Refund bookkeeping helper (caller holds booking lock) -----------------------
create function public.manager_refund_settle(p_booking_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_captured bigint; v_refunded bigint;
begin
  select coalesce(sum(captured_cents), 0) into v_captured from public.payment_attempts
    where booking_id = p_booking_id and verified_paid_at is not null;
  select coalesce(sum(amount_cents), 0) into v_refunded from public.refunds
    where booking_id = p_booking_id and status = 'succeeded';
  if v_captured = 0 then return; end if;
  update public.bookings set payment_status = case when v_refunded = 0 then 'paid'
      when v_refunded < v_captured then 'partially_refunded' else 'refunded' end, updated_at = now()
  where id = p_booking_id and payment_status is distinct from case when v_refunded = 0 then 'paid'
      when v_refunded < v_captured then 'partially_refunded' else 'refunded' end;
end;
$$;

-- manager_refund ------------------------------------------------------------
create function public.manager_refund(p_action text, p_actor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_d jsonb := coalesce(p_data, '{}'::jsonb);
  v_b public.bookings%rowtype;
  v_a public.payment_attempts%rowtype;
  v_r public.refunds%rowtype;
  v_booking_id uuid;
  v_refund_id uuid;
  v_amount bigint;
  v_key text := nullif(trim(v_d->>'idempotency_key'), '');
  v_reason text := nullif(left(trim(v_d->>'reason'), 500), '');
  v_currency text := upper(nullif(v_d->>'currency', ''));
  v_sr text := nullif(v_d->>'stripe_refund_id', '');
  v_status text := case v_d->>'status' when 'canceled' then 'cancelled' else v_d->>'status' end;
  v_reserved bigint;
begin
  if p_action is null or p_action not in ('reserve', 'attach', 'finalize', 'error') then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
  begin
    v_booking_id := nullif(v_d->>'booking_id', '')::uuid;
    v_refund_id := nullif(v_d->>'refund_id', '')::uuid;
    v_amount := (v_d->>'amount_cents')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_refund_data';
  end;
  if v_sr is not null and v_sr !~ '^re_[A-Za-z0-9_]{1,250}$' then
    raise exception using errcode = '22023', message = 'invalid_stripe_refund_id';
  end if;

  if p_action = 'reserve' then
    perform public.manager_require_admin(p_actor);
    if v_booking_id is null or v_amount is null or v_amount <= 0 or v_reason is null
       or v_key is null or v_key !~ '^[A-Za-z0-9:_-]{8,200}$' or v_key like 'stripe:%' then
      raise exception using errcode = '22023', message = 'invalid_refund_request';
    end if;
    v_b := public.manager_lock_booking(v_booking_id);
    select * into v_r from public.refunds where idempotency_key = v_key for update;
    if found then
      if v_r.booking_id <> v_b.id or v_r.amount_cents <> v_amount or v_r.reason is distinct from v_reason then
        raise exception using errcode = '23505', message = 'idempotency_conflict';
      end if;
      return public.manager_refund_out(v_r);
    end if;
    select * into v_a from public.payment_attempts
      where booking_id = v_b.id and verified_paid_at is not null and captured_cents > 0
        and stripe_payment_intent_id is not null
      order by verified_paid_at desc limit 1 for update;
    if not found then raise exception using errcode = '55000', message = 'no_captured_payment'; end if;
    select coalesce(sum(amount_cents), 0) into v_reserved from public.refunds
      where payment_attempt_id = v_a.id and status in ('pending', 'succeeded');
    if v_reserved + v_amount > v_a.captured_cents then
      raise exception using errcode = '55000', message = 'refund_exceeds_captured';
    end if;
    insert into public.refunds (booking_id, payment_attempt_id, idempotency_key, amount_cents, currency,
      reason, requested_by, source)
    values (v_b.id, v_a.id, v_key, v_amount, v_a.currency, v_reason, p_actor, 'admin')
    returning * into v_r;
    perform public.manager_audit('admin', p_actor::text, 'refund.reserved', 'refund', v_r.id,
      jsonb_build_object('booking_id', v_b.id, 'amount_cents', v_amount, 'reason', v_reason));
    return public.manager_refund_out(v_r);
  end if;

  if p_action in ('attach', 'error') then
    if v_refund_id is null then raise exception using errcode = '22023', message = 'invalid_refund_data'; end if;
    select booking_id into v_booking_id from public.refunds where id = v_refund_id;
    if not found then raise exception using errcode = 'P0002', message = 'refund_not_found'; end if;
    v_b := public.manager_lock_booking(v_booking_id);
    select * into v_r from public.refunds where id = v_refund_id for update;
    if p_action = 'attach' then
      -- API create response: may attach the Stripe id only; status changes need a verified event.
      if v_sr is null then raise exception using errcode = '22023', message = 'invalid_stripe_refund_id'; end if;
      if v_r.stripe_refund_id is not null and v_r.stripe_refund_id <> v_sr then
        raise exception using errcode = '23505', message = 'refund_conflict';
      end if;
      update public.refunds set stripe_refund_id = v_sr, last_error = null, next_retry_at = null, updated_at = now()
      where id = v_r.id and stripe_refund_id is null returning * into v_r;
      if not found then select * into v_r from public.refunds where id = v_refund_id; end if;
    elsif v_r.status = 'pending' then
      -- Ambiguous provider error: funds stay reserved, not a definitive failure.
      update public.refunds set last_error = public.manager_safe_error(coalesce(v_d->>'error', 'unknown_error')),
        next_retry_at = now() + interval '5 minutes', updated_at = now()
      where id = v_r.id returning * into v_r;
    end if;
    return public.manager_refund_out(v_r);
  end if;

  -- finalize: verified Stripe refund object, only from manager_event.
  if not public.manager_in_verified_event() then
    raise exception using errcode = '42501', message = 'verified_event_required';
  end if;
  if v_sr is null or v_booking_id is null or v_amount is null or v_amount <= 0 or v_currency is null
     or nullif(v_d->>'payment_intent', '') is null
     or v_status is null or v_status not in ('pending', 'succeeded', 'failed', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid_refund_evidence';
  end if;
  v_b := public.manager_lock_booking(v_booking_id);
  select * into v_a from public.payment_attempts
    where stripe_payment_intent_id = v_d->>'payment_intent' and verified_paid_at is not null for update;
  if not found or v_a.booking_id <> v_b.id then
    raise exception using errcode = '55000', message = 'payment_intent_mismatch';
  end if;
  if v_refund_id is not null then
    select * into v_r from public.refunds where id = v_refund_id for update;
  else
    select * into v_r from public.refunds where stripe_refund_id = v_sr for update;
  end if;
  if v_r.id is null and v_refund_id is not null then
    raise exception using errcode = 'P0002', message = 'refund_not_found';
  end if;

  if v_r.id is null then
    -- External refund (e.g. Stripe dashboard): record it under a stable key.
    -- Cap only against authoritative facts (succeeded + other Stripe-sourced pending); local
    -- admin reservations must never block recording a verified Stripe refund.
    if v_status in ('pending', 'succeeded') then
      select coalesce(sum(amount_cents), 0) into v_reserved from public.refunds
        where payment_attempt_id = v_a.id
          and (status = 'succeeded' or (status = 'pending' and source = 'stripe'));
      if v_reserved + v_amount > v_a.captured_cents then
        raise exception using errcode = '55000', message = 'refund_exceeds_captured';
      end if;
    end if;
    if v_currency <> v_a.currency then raise exception using errcode = '22023', message = 'amount_mismatch'; end if;
    insert into public.refunds (booking_id, payment_attempt_id, idempotency_key, amount_cents, currency,
      status, stripe_refund_id, reason, source, verified_at)
    values (v_b.id, v_a.id, 'stripe:' || v_sr, v_amount, v_currency, 'pending', v_sr, 'external', 'stripe', now())
    returning * into v_r;
    -- Unsent local reservations that now over-commit stay pending (funds reserved, not failed)
    -- but are flagged for owner review; the service will not send them to Stripe.
    if (select coalesce(sum(amount_cents), 0) from public.refunds
        where payment_attempt_id = v_a.id and status in ('pending', 'succeeded')) > v_a.captured_cents then
      update public.refunds set last_error = 'review_overcommitted_by_external_refund', updated_at = now()
      where payment_attempt_id = v_a.id and status = 'pending' and source = 'admin' and stripe_refund_id is null;
    end if;
  end if;

  if v_r.booking_id <> v_b.id or v_r.payment_attempt_id <> v_a.id or v_r.amount_cents <> v_amount
     or v_r.currency <> v_currency or (v_r.stripe_refund_id is not null and v_r.stripe_refund_id <> v_sr) then
    raise exception using errcode = '55000', message = 'refund_mismatch';
  end if;

  if v_r.status = v_status or (v_r.status <> 'pending' and v_status = 'pending')
     or (v_r.status = 'succeeded') then
    -- Replay or stale event: succeeded never downgrades; terminal never returns to pending.
    if v_r.stripe_refund_id is null then
      update public.refunds set stripe_refund_id = v_sr, updated_at = now() where id = v_r.id returning * into v_r;
    end if;
    return public.manager_refund_out(v_r) || jsonb_build_object('replay', true);
  end if;
  if v_r.status in ('failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'refund_state_conflict';
  end if;

  update public.refunds set status = v_status, stripe_refund_id = v_sr, verified_at = now(),
    next_retry_at = null,
    last_error = case when v_status in ('failed', 'cancelled')
      then public.manager_safe_error(coalesce(v_d->>'failure_reason', v_status)) else null end,
    updated_at = now()
  where id = v_r.id returning * into v_r;

  if v_status = 'succeeded' then
    perform public.manager_refund_settle(v_b.id);
    insert into public.outbox (topic, booking_id, recipient, dedupe_key, payload)
    select 'refund_succeeded', v_b.id, rcpt, 'refund_succeeded:' || v_r.id || ':' || rcpt,
      jsonb_build_object('topic', 'refund_succeeded', 'booking_id', v_b.id, 'refund_id', v_r.id, 'recipient', rcpt)
    from unnest(array['owner', 'guest']) rcpt
    where rcpt = 'guest' or exists (select 1 from public.properties p
      where p.id = v_b.property_id and nullif(trim(p.owner_email), '') is not null)
    on conflict (dedupe_key) do nothing;
  end if;
  perform public.manager_audit('stripe', current_setting('manager.verified_event', true), 'refund.' || v_status,
    'refund', v_r.id, jsonb_build_object('booking_id', v_b.id, 'amount_cents', v_r.amount_cents,
      'stripe_refund_id', v_sr));
  return public.manager_refund_out(v_r);
end;
$$;

-- manager_event -------------------------------------------------------------
create function public.manager_event(p_event_id text, p_type text, p_livemode boolean, p_payload jsonb,
  p_effect text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_e public.stripe_events%rowtype;
  v_expected text;
  v_result jsonb;
  v_attempt uuid;
  v_attempts integer;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9_]{1,250}$' or p_type is null
     or p_type !~ '^[a-z_.]{3,100}$' or p_livemode is null or p_payload is null
     or jsonb_typeof(p_payload) <> 'object' or coalesce(p_payload->>'id', '') <> p_event_id
     or p_effect is null or p_effect not in ('received', 'paid', 'refund', 'ignored', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_event';
  end if;
  v_expected := case
    when p_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') then 'paid'
    when p_type in ('refund.created', 'refund.updated', 'refund.failed') then 'refund'
    else 'ignored' end;
  if p_effect not in ('received', 'failed', v_expected)
     and not (p_effect = 'ignored' and v_expected in ('paid', 'refund')) then
    raise exception using errcode = '22023', message = 'effect_type_mismatch';
  end if;

  perform pg_advisory_xact_lock(3, hashtext(p_event_id));
  insert into public.stripe_events (stripe_event_id, type, livemode, payload)
  values (p_event_id, p_type, p_livemode, p_payload)
  on conflict (stripe_event_id) do nothing;
  select * into v_e from public.stripe_events where stripe_event_id = p_event_id for update;
  if v_e.type <> p_type or v_e.livemode <> p_livemode then
    raise exception using errcode = '23505', message = 'event_conflict';
  end if;
  if v_e.status in ('processed', 'ignored') then
    return jsonb_build_object('event_id', p_event_id, 'status', v_e.status, 'replay', true);
  end if;
  if p_effect = 'received' then
    return jsonb_build_object('event_id', p_event_id, 'status', v_e.status, 'replay', false);
  end if;
  -- Count each processing attempt exactly once: a live worker lease means
  -- manager_work('claim_events') already incremented; otherwise (direct webhook,
  -- expired lease) count it here. Capped at 25 (the claim_events exhaustion bound).
  v_attempts := case when v_e.lease_owner is not null and v_e.lease_expires_at > now()
    then v_e.attempts else least(25, v_e.attempts + 1) end;
  if p_effect = 'failed' then
    -- Atomically: record failure, schedule exponential retry (30s * 2^(n-1), max 1h), release lease.
    update public.stripe_events set status = 'failed', attempts = v_attempts,
      last_error = public.manager_safe_error(coalesce(p_data->>'error', 'unknown_error')),
      next_retry_at = now() + make_interval(secs => least(3600, 30 * power(2, least(greatest(v_attempts, 1) - 1, 10)))),
      lease_owner = null, lease_expires_at = null
    where id = v_e.id returning * into v_e;
    return jsonb_build_object('event_id', p_event_id, 'status', v_e.status, 'replay', false);
  end if;

  if p_effect = 'paid' then
    begin
      v_attempt := (p_data->>'attempt_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_event_data';
    end;
    if v_attempt is null then raise exception using errcode = '22023', message = 'invalid_event_data'; end if;
    perform set_config('manager.verified_event', p_event_id, true);
    v_result := public.manager_payment(v_attempt, 'paid', p_data);
  elsif p_effect = 'refund' then
    perform set_config('manager.verified_event', p_event_id, true);
    v_result := public.manager_refund('finalize', null, p_data);
  end if;
  perform set_config('manager.verified_event', '', true);

  update public.stripe_events set status = case when p_effect = 'ignored' then 'ignored' else 'processed' end,
    attempts = v_attempts, processed_at = now(), last_error = null, next_retry_at = null,
    lease_owner = null, lease_expires_at = null
  where id = v_e.id returning * into v_e;
  return jsonb_build_object('event_id', p_event_id, 'status', v_e.status, 'replay', false, 'result', v_result);
end;
$$;

-- Grants --------------------------------------------------------------------
revoke all on function public.manager_payment_attempt_out(public.payment_attempts) from public, anon, authenticated;
revoke all on function public.manager_refund_out(public.refunds) from public, anon, authenticated;
revoke all on function public.manager_safe_error(text) from public, anon, authenticated;
revoke all on function public.manager_in_verified_event() from public, anon, authenticated;
revoke all on function public.manager_lock_booking(uuid) from public, anon, authenticated;
revoke all on function public.manager_refund_settle(uuid) from public, anon, authenticated;
revoke all on function public.manager_payment(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.manager_refund(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.manager_event(text, text, boolean, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.manager_payment(uuid, text, jsonb) to service_role;
grant execute on function public.manager_refund(text, uuid, jsonb) to service_role;
grant execute on function public.manager_event(text, text, boolean, jsonb, text, jsonb) to service_role;
