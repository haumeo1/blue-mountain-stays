// Real-Postgres tests for supabase/migrations. Opt-in: set DATABASE_TEST_URL to a FRESH,
// disposable, loopback database whose name contains "test" (see docs/testing.md).
// Without it the suite is skipped (unless DATABASE_TEST_REQUIRED=1, as in CI).
// One parent suite; tests run sequentially and share fixtures. Concurrency is only
// exercised explicitly, through separate connections in race().
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const URL_ENV = process.env.DATABASE_TEST_URL || '';
const REQUIRED = process.env.DATABASE_TEST_REQUIRED === '1';
const MIGRATIONS = new URL('../supabase/', import.meta.url);
const ORIGINAL = 'migrations/202610250001_booking_platform.sql';
const NEW = ['202611050001_manager_schema', '202611050002_booking_rpcs', '202611050003_payment_rpcs',
  '202611050004_admin_rpcs', '202611050005_legacy_access'].map((n) => `migrations/${n}.sql`);

const PROPERTY = '7b894869-13bb-4a2d-9b2a-84a963fe8c2c';
const ADMIN = '00000000-0000-4000-8000-00000000a001';
const OTHER = '00000000-0000-4000-8000-00000000a002';
const LEGACY = '00000000-0000-4000-8000-0000000b0001';
const LEGACY_BLOCK = '00000000-0000-4000-8000-0000000c0001';
const LEGACY_TOKEN = '00000000-0000-4000-8000-0000000d0001';
const LEGACY_CREATED = '2026-10-01T12:00:00.000Z';
const RATE = 39900; // custom legacy nightly rate (original seed was 42500)
const CLEANING = 15000;

const hex = () => randomBytes(32).toString('hex');
const id = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guardUrl(raw) {
  const u = new URL(raw);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('DATABASE_TEST_URL must be postgres://');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) || u.searchParams.has('host')) {
    throw new Error('Refusing DATABASE_TEST_URL: host must be loopback');
  }
  if (!/test/i.test(db)) throw new Error('Refusing DATABASE_TEST_URL: database name must contain "test"');
  return db;
}

describe('database (real Postgres)', { skip: !URL_ENV && !REQUIRED && 'DATABASE_TEST_URL not set' }, () => {
  let root; // superuser: migrations, seeding, inspection, clock manipulation
  let svc; // service_role session, as the server uses
  let today;
  let changed = false;
  const clients = new Set();

  const day = (n) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  async function connect(role) {
    const c = new pg.Client({ connectionString: URL_ENV });
    await c.connect();
    clients.add(c);
    await c.query("set statement_timeout = '20s'");
    if (role) await c.query(`set role ${role}`);
    return c;
  }
  async function close(c) { clients.delete(c); await c.end(); }
  const rpc = async (c, expr, params = []) => (await c.query(`select ${expr} as r`, params)).rows[0].r;
  const one = async (sql, params = []) => (await root.query(sql, params)).rows[0];
  async function rejects(promise, code, message) {
    await assert.rejects(promise, (e) => {
      assert.equal(e.code, code, `${e.code} ${e.message}`);
      if (message) assert.equal(e.message, message);
      return true;
    });
  }

  // first(c1) runs inside an open transaction; second(c2) must observably block on a
  // lock held by c1 before c1 commits. Returns { first, second: {value}|{error} }.
  async function race(first, second) {
    const c1 = await connect('service_role');
    const c2 = await connect('service_role');
    try {
      await c1.query('begin');
      const a = await first(c1);
      const pid = (await c2.query('select pg_backend_pid() as p')).rows[0].p;
      const pending = second(c2).then((value) => ({ value }), (error) => ({ error }));
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i += 1) {
        const row = await one('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
        blocked = row?.wait_event_type === 'Lock';
        if (!blocked) await sleep(25);
      }
      assert.ok(blocked, 'second connection never blocked on the first');
      await c1.query('commit');
      return { first: a, second: await pending };
    } finally {
      await close(c1);
      await close(c2);
    }
  }

  // Domain helpers ----------------------------------------------------------
  const guest = () => ({ name: 'Synthetic Guest', email: `guest+${randomBytes(4).toString('hex')}@example.test` });
  async function requested(ci, co, c = svc) {
    const quote = await rpc(c, 'public.manager_quote($1::date, $2::date, 2)', [day(ci), day(co)]);
    const key = id('request_key'); const hash = hex();
    const args = [quote.id, JSON.stringify(guest()), key, hash, hex(), hex()];
    const booking = await rpc(c, 'public.manager_request($1::uuid, $2::jsonb, $3, $4, $5, $6)', args);
    return { quote, booking, key, hash, args };
  }
  const approve = (bookingId, c = svc) =>
    rpc(c, "public.manager_action($1::uuid, 'approve', $2::uuid, null)", [bookingId, ADMIN]);
  async function approved(ci, co) {
    const r = await requested(ci, co);
    const a = await approve(r.booking.id);
    return { ...r, booking: a.booking, attempt: a.attempt };
  }
  const attach = (attempt, session, c = svc) => rpc(c, "public.manager_payment($1::uuid, 'attached', $2::jsonb)", [
    attempt.id, JSON.stringify({ session_id: session, session_url: `https://checkout.stripe.com/c/pay/${session}`,
      amount_cents: attempt.expected_total_cents, currency: attempt.currency })]);
  const paidData = (booking, attempt, session, pi) => ({ attempt_id: attempt.id, booking_id: booking.id,
    session_id: session, payment_intent: pi, amount_cents: attempt.expected_total_cents, currency: attempt.currency });
  const event = (c, evt, type, effect, data = {}) => rpc(c,
    'public.manager_event($1, $2, false, $3::jsonb, $4, $5::jsonb)',
    [evt, type, JSON.stringify({ id: evt, type }), effect, JSON.stringify(data)]);
  async function paid(ci, co) {
    const r = await approved(ci, co);
    const session = id('cs_test'); const pi = id('pi_test'); const evt = id('evt_test');
    await attach(r.attempt, session);
    const result = await event(svc, evt, 'checkout.session.completed', 'paid', paidData(r.booking, r.attempt, session, pi));
    assert.equal(result.result.booking.status, 'confirmed');
    return { ...r, session, pi, evt, total: r.attempt.expected_total_cents };
  }
  const work = (action, data, c = svc) => rpc(c, 'public.manager_work($1, $2::jsonb)', [action, JSON.stringify(data)]);
  const reserve = (c, bookingId, key, amount) => rpc(c, "public.manager_refund('reserve', $1::uuid, $2::jsonb)",
    [ADMIN, JSON.stringify({ booking_id: bookingId, amount_cents: amount, idempotency_key: key, reason: 'Synthetic test refund' })]);
  const eventRow = (evt) => one('select * from public.stripe_events where stripe_event_id = $1', [evt]);
  const makeDue = (table, rowId) => root.query(`update public.${table} set next_retry_at = now() - interval '1 second' where id = $1`, [rowId]);

  // Setup: guard, apply original, seed legacy, apply new ----------------------
  before(async () => {
    if (!URL_ENV) throw new Error('DATABASE_TEST_REQUIRED=1 but DATABASE_TEST_URL is not set');
    const dbName = guardUrl(URL_ENV);
    root = await connect();
    const info = await one(`select current_database() as db, to_regclass('public.bookings') as bookings,
      to_regclass('public.quotes') as quotes`);
    if (info.db !== dbName || !/test/i.test(info.db)) throw new Error('Refusing: connected database mismatch');
    if (info.bookings) {
      const { n } = await one('select count(*)::int as n from public.bookings');
      if (n > 0) throw new Error('Refusing: public.bookings is not empty (not a fresh test database)');
    }
    if (info.quotes) throw new Error('Refusing: manager migrations already applied; recreate the test database');

    today = (await one(`select to_char((now() at time zone 'America/Toronto')::date, 'YYYY-MM-DD') as d`)).d;

    changed = true;
    const sql = async (file) => root.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
    await sql('tests/bootstrap.sql');
    await sql(ORIGINAL);

    // Legacy data written under the original schema, before any new migration.
    await root.query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'other@example.test')`, [ADMIN, OTHER]);
    await root.query('insert into public.admin_users (user_id) values ($1)', [ADMIN]);
    await root.query('update public.properties set nightly_rate_cents = $2, cleaning_fee_cents = $3 where id = $1',
      [PROPERTY, RATE, CLEANING]);
    const service = Math.round(3 * RATE * 0.08);
    await root.query(`insert into public.bookings (id, confirmation_code, property_id, guest_name, guest_email, guest_count,
        check_in, check_out, nights, nightly_rate_cents, cleaning_fee_cents, service_fee_cents, total_cents, currency,
        status, payment_status, calendar_token, created_at, updated_at)
      values ($1, 'BMH-LEGACY01', $2, 'Legacy Synthetic', 'legacy-guest@example.test', 2, $3, $4, 3, $5, $6, $7, $8,
        'CAD', 'confirmed', 'paid', $9, $10, $10)`,
    [LEGACY, PROPERTY, day(200), day(203), RATE, CLEANING, service, 3 * RATE + CLEANING + service, LEGACY_TOKEN, LEGACY_CREATED]);
    await root.query(`insert into public.blocked_dates (id, property_id, start_date, end_date, reason, created_by)
      values ($1, $2, $3, $4, 'Legacy synthetic block', $5)`, [LEGACY_BLOCK, PROPERTY, day(210), day(212), ADMIN]);

    for (const file of NEW) await sql(file);
    svc = await connect('service_role');
  });

  after(async () => {
    for (const c of [...clients]) if (c !== root) await close(c).catch(() => {});
    if (root && changed && process.env.DATABASE_TEST_KEEP !== '1') {
      // Return the guarded, disposable test database to its fresh state.
      await root.query(`drop schema if exists public cascade; create schema public; grant usage on schema public to public;
        drop schema if exists auth cascade; drop schema if exists storage cascade;`);
    }
    if (root) await close(root);
  });

  test('migrations preserve legacy IDs, prices, claims and history', async () => {
    const legacy = await one('select * from public.bookings where id = $1', [LEGACY]);
    assert.equal(legacy.confirmation_code, 'BMH-LEGACY01');
    const service = Math.round(3 * RATE * 0.08);
    assert.equal(legacy.total_cents, 3 * RATE + CLEANING + service);
    assert.equal(legacy.status, 'confirmed');
    assert.equal(legacy.payment_status, 'paid');
    assert.equal(legacy.created_at.toISOString(), LEGACY_CREATED);
    assert.equal(legacy.quote_snapshot.legacy, true);
    assert.equal(legacy.quote_snapshot.lodging_cents, 3 * RATE);
    assert.equal(legacy.quote_snapshot.total_cents, legacy.total_cents);
    assert.equal(legacy.calendar_token_hash, sha256(LEGACY_TOKEN));
    assert.equal('calendar_token' in legacy, false);
    assert.equal(legacy.guest_email, 'legacy-guest@example.test');

    const p = await one('select * from public.properties where id = $1', [PROPERTY]);
    assert.equal(p.nightly_rate_cents, RATE);
    assert.equal(p.cleaning_fee_cents, CLEANING);
    assert.equal(Number(p.service_rate), 0.08);
    assert.equal((await one('select count(*)::int as n from public.properties')).n, 1);

    const claims = (await root.query('select kind, booking_id, block_id, active, lower(stay)::text as s, upper(stay)::text as e from public.inventory_claims order by kind')).rows;
    assert.deepEqual(claims.map((c) => [c.kind, c.booking_id ?? c.block_id, c.active, c.s, c.e]), [
      ['block', LEGACY_BLOCK, true, day(210), day(212)],
      ['booking', LEGACY, true, day(200), day(203)],
    ]);

    // Enable booking (settings save bumps version 1 -> 2); new quotes use the custom rate.
    const s = await rpc(svc, "public.manager_configure('settings', $1::uuid, $2::jsonb)", [ADMIN, JSON.stringify({
      timezone: 'America/Toronto', currency: 'CAD', owner_email: 'owner@example.test', booking_enabled: true, version: 1 })]);
    assert.equal(s.version, 2);
    await rejects(rpc(svc, 'public.manager_quote($1::date, $2::date, 2)', [day(201), day(202)]), '23P01', 'dates_unavailable');
    await rejects(rpc(svc, 'public.manager_quote($1::date, $2::date, 2)', [day(211), day(213)]), '23P01', 'dates_unavailable');
    const q = await rpc(svc, 'public.manager_quote($1::date, $2::date, 2)', [day(30), day(32)]);
    assert.equal(q.stay_cents, 2 * RATE);
    assert.equal(q.cleaning_fee_cents, CLEANING);
  });

  test('anon and authenticated are denied; every manager_* function is locked down', async () => {
    for (const role of ['anon', 'authenticated']) {
      const c = await connect(role);
      try {
        await rejects(c.query('select public.manager_quote(current_date + 40, current_date + 42, 2)'), '42501');
        await rejects(c.query(`select public.manager_event('evt_x', 'x.y', false, '{"id":"evt_x"}', 'received', '{}')`), '42501');
        await rejects(c.query(`select public.manager_work('claim_events', '{"worker":"w"}')`), '42501');
        await rejects(c.query('select public.manager_retry_events($1::uuid)', [ADMIN]), '42501');
        await rejects(c.query('select * from public.bookings'), '42501');
        await rejects(c.query('select * from public.stripe_events'), '42501');
      } finally { await close(c); }
    }
    const leaks = (await root.query(`select p.oid::regprocedure::text as f from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'manager\\_%'
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))`)).rows;
    assert.deepEqual(leaks, []);
    const definer = await one(`select prosecdef from pg_proc where proname = 'manager_retry_events'`);
    assert.equal(definer.prosecdef, true);
    await rejects(rpc(svc, 'public.manager_retry_events($1::uuid)', [OTHER]), '42501', 'forbidden');
    await rejects(rpc(svc, 'public.manager_overview($1::uuid)', [OTHER]), '42501', 'forbidden');
  });

  test('request: quote snapshot, idempotency and immutable totals', async () => {
    const r = await requested(40, 42);
    assert.equal(r.booking.status, 'pending');
    assert.equal(r.booking.payment_status, 'unpaid');
    assert.equal(r.booking.total_cents, r.quote.total_cents);
    assert.equal(r.booking.stay_cents, 2 * RATE);
    const replay = await rpc(svc, 'public.manager_request($1::uuid, $2::jsonb, $3, $4, $5, $6)', r.args);
    assert.equal(replay.id, r.booking.id);
    await rejects(rpc(svc, 'public.manager_request($1::uuid, $2::jsonb, $3, $4, $5, $6)',
      [r.args[0], r.args[1], r.key, hex(), hex(), hex()]), '23505', 'idempotency_conflict');
    await rejects(rpc(svc, 'public.manager_request($1::uuid, $2::jsonb, $3, $4, $5, $6)',
      [r.args[0], r.args[1], id('request_key'), hex(), hex(), hex()]), '55000', 'quote_used');
    assert.equal((await one('select count(*)::int as n from public.inventory_claims where booking_id = $1', [r.booking.id])).n, 0);
    await rejects(root.query('update public.bookings set total_cents = 1 where id = $1', [r.booking.id]), '55000');
    await rejects(root.query('update public.quotes set total_cents = 1 where id = $1', [r.quote.id]), '55000');
    await rejects(root.query('delete from public.quotes where id = $1', [r.quote.id]), '55000');
  });

  test('currency locks once any booking exists, before any capture; overview reports currency', async () => {
    const ov = await rpc(svc, 'public.manager_overview($1::uuid)', [ADMIN]);
    assert.equal(ov.currency, 'CAD');
    await requested(44, 46); // an unpaid CAD request
    assert.equal((await one(`select count(*)::int as n from public.payment_attempts a join public.bookings b on b.id = a.booking_id
      where b.property_id = $1 and coalesce(a.captured_cents, 0) > 0`, [PROPERTY])).n, 0, 'no captured money yet');
    const { version } = await one('select version from public.properties where id = $1', [PROPERTY]);
    const settings = (currency) => rpc(svc, "public.manager_configure('settings', $1::uuid, $2::jsonb)", [ADMIN, JSON.stringify({
      timezone: 'America/Toronto', currency, owner_email: 'owner@example.test', booking_enabled: true, version })]);
    await rejects(settings('USD'), '55000', 'currency_locked');
    const p = await one('select currency, version from public.properties where id = $1', [PROPERTY]);
    assert.deepEqual([p.currency, p.version], ['CAD', version]);
  });

  test('concurrent approvals of overlapping requests: exactly one wins', async () => {
    const a = await requested(50, 53);
    const b = await requested(51, 54);
    const out = await race((c) => approve(a.booking.id, c), (c) => approve(b.booking.id, c));
    assert.equal(out.first.booking.status, 'payment_due');
    assert.equal(out.second.error?.code, '23P01');
    assert.equal(out.second.error?.message, 'dates_unavailable');
    assert.equal((await one('select status from public.bookings where id = $1', [b.booking.id])).status, 'pending');
    const again = await approve(a.booking.id);
    assert.equal(again.attempt.id, out.first.attempt.id);
    assert.equal((await one('select count(*)::int as n from public.payment_attempts where booking_id = $1', [a.booking.id])).n, 1);
  });

  test('concurrent approval and owner block: exclusion holds', async () => {
    const c = await requested(60, 63);
    const out = await race((cl) => approve(c.booking.id, cl),
      (cl) => rpc(cl, "public.manager_block('create', $1::uuid, $2::jsonb)",
        [ADMIN, JSON.stringify({ start_date: day(61), end_date: day(62), reason: 'Synthetic' })]));
    assert.equal(out.first.booking.status, 'payment_due');
    assert.equal(out.second.error?.code, '23P01');
    assert.equal((await one('select count(*)::int as n from public.blocked_dates where start_date = $1', [day(61)])).n, 0);
  });

  test('paid and refund finalize require a verified event; money facts are write-once', async () => {
    const r = await approved(65, 67);
    const session = id('cs_test');
    await attach(r.attempt, session);
    const data = paidData(r.booking, r.attempt, session, id('pi_test'));
    await rejects(rpc(svc, "public.manager_payment($1::uuid, 'paid', $2::jsonb)", [r.attempt.id, JSON.stringify(data)]),
      '42501', 'verified_event_required');
    await rejects(rpc(svc, "public.manager_refund('finalize', null, $1::jsonb)", [JSON.stringify({})]),
      '42501', 'verified_event_required');
    await rejects(event(svc, id('evt_test'), 'checkout.session.completed', 'refund', data), '22023', 'effect_type_mismatch');
    const row = await one('select status, captured_cents from public.payment_attempts where id = $1', [r.attempt.id]);
    assert.deepEqual(row, { status: 'session_open', captured_cents: 0 });
    const evt = id('evt_test');
    await event(svc, evt, 'checkout.session.completed', 'paid', data);
    await rejects(root.query('update public.payment_attempts set captured_cents = 1 where id = $1', [r.attempt.id]),
      '55000', 'payment_facts_immutable');
  });

  test('duplicate and reordered Stripe events apply once', async () => {
    const r = await approved(70, 72);
    const session = id('cs_test'); const pi = id('pi_test'); const evt = id('evt_test');
    const data = paidData(r.booking, r.attempt, session, pi);
    // Webhook arrives before the session is attached: the session is adopted.
    const first = await event(svc, evt, 'checkout.session.completed', 'paid', data);
    assert.equal(first.status, 'processed');
    assert.equal(first.result.attempt.status, 'succeeded');
    assert.equal(first.result.attempt.stripe_checkout_session_id, session);
    const late = await attach(r.attempt, session);
    assert.equal(late.attempt.status, 'succeeded');
    await rejects(attach(r.attempt, id('cs_test')), '23505', 'session_conflict');
    const dup = await event(svc, evt, 'checkout.session.completed', 'paid', data);
    assert.deepEqual(dup, { event_id: evt, status: 'processed', replay: true });
    const other = await event(svc, id('evt_test'), 'checkout.session.async_payment_succeeded', 'paid', data);
    assert.equal(other.result.replay, true);
    const conflictEvt = id('evt_test');
    await rejects(event(svc, conflictEvt, 'checkout.session.completed', 'paid', { ...data, payment_intent: id('pi_test') }),
      '55000', 'payment_conflict');
    assert.equal(await eventRow(conflictEvt), undefined);
    await rejects(event(svc, evt, 'customer.updated', 'ignored'), '23505', 'event_conflict');
    const a = await one('select captured_cents, paid_event_id from public.payment_attempts where id = $1', [r.attempt.id]);
    assert.deepEqual(a, { captured_cents: r.attempt.expected_total_cents, paid_event_id: evt });
    assert.equal((await one(`select count(*)::int as n from public.audit_events where action = 'payment.paid' and entity_id = $1`, [r.attempt.id])).n, 1);
    assert.equal((await eventRow(evt)).attempts, 1);
  });

  test('concurrent refunds respect the captured cap; replays are idempotent', async () => {
    const p = await paid(80, 82);
    const amount = Math.floor(p.total * 0.6);
    const k1 = id('refund_key'); const k2 = id('refund_key');
    const out = await race((c) => reserve(c, p.booking.id, k1, amount), (c) => reserve(c, p.booking.id, k2, amount));
    assert.equal(out.first.status, 'pending');
    assert.equal(out.second.error?.message, 'refund_exceeds_captured');
    assert.equal((await reserve(svc, p.booking.id, k1, amount)).id, out.first.id);
    await rejects(reserve(svc, p.booking.id, k1, amount - 1), '23505', 'idempotency_conflict');

    const sr = id('re_test');
    await rpc(svc, "public.manager_refund('attach', null, $1::jsonb)", [JSON.stringify({ refund_id: out.first.id, stripe_refund_id: sr })]);
    const fin = (status) => ({ refund_id: out.first.id, stripe_refund_id: sr, booking_id: p.booking.id,
      payment_intent: p.pi, amount_cents: amount, currency: 'CAD', status });
    const evt = id('evt_test');
    const done = await event(svc, evt, 'refund.updated', 'refund', fin('succeeded'));
    assert.equal(done.result.status, 'succeeded');
    const stale = await event(svc, id('evt_test'), 'refund.created', 'refund', fin('pending'));
    assert.equal(stale.result.replay, true);
    assert.equal(stale.result.status, 'succeeded');
    assert.equal((await event(svc, evt, 'refund.updated', 'refund', fin('succeeded'))).replay, true);
    assert.equal((await one('select payment_status from public.bookings where id = $1', [p.booking.id])).payment_status, 'partially_refunded');
    const rest = await reserve(svc, p.booking.id, id('refund_key'), p.total - amount);
    assert.equal(rest.status, 'pending');
    await rejects(reserve(svc, p.booking.id, id('refund_key'), 1), '55000', 'refund_exceeds_captured');
  });

  test('005: legacy access provisioning is idempotent and recovered session binding has no financial effect', async () => {
    const gh = hex(); const ch = hex(); const key = `legacy:${LEGACY}`;
    const call = (g, c) => rpc(svc, 'public.manager_guest_access($1::uuid, $2::uuid, $3, $4, $5)', [LEGACY, ADMIN, key, g, c]);
    await rejects(rpc(svc, 'public.manager_guest_access($1::uuid, $2::uuid, $3, $4, $5)', [LEGACY, OTHER, key, gh, ch]), '42501', 'forbidden');
    assert.deepEqual(await call(gh, ch), { booking_id: LEGACY, status: 'provisioned' });
    assert.deepEqual(await call(gh, ch), { booking_id: LEGACY, status: 'already_provisioned' });
    await rejects(call(hex(), ch), '23505', 'legacy_access_conflict');
    const legacy = await one('select * from public.bookings where id = $1', [LEGACY]);
    assert.equal(legacy.guest_access_hash, gh);
    assert.equal(legacy.calendar_token_hash, ch);
    assert.equal(legacy.total_cents, 3 * RATE + CLEANING + Math.round(3 * RATE * 0.08));
    assert.equal(legacy.status, 'confirmed');
    assert.equal(legacy.created_at.toISOString(), LEGACY_CREATED);
    assert.equal((await one(`select count(*)::int as n from public.audit_events where action = 'booking.legacy_access_provisioned' and entity_id = $1`, [LEGACY])).n, 1);

    const r = await approved(100, 102);
    const session = id('cs_test');
    const bind = (s) => rpc(svc, 'public.manager_bind_recovered($1::uuid, $2::jsonb)', [r.attempt.id, JSON.stringify({
      session_id: s, status: 'expired', amount_cents: r.attempt.expected_total_cents, currency: 'cad',
      attempt_id: r.attempt.id, booking_id: r.booking.id })]);
    const bound = await bind(session);
    assert.equal(bound.replay, false);
    assert.equal(bound.attempt.status, 'created');
    assert.equal(bound.attempt.captured_cents, 0);
    assert.equal((await bind(session)).replay, true);
    await rejects(bind(id('cs_test')), '23505', 'session_conflict');
    const b = await one('select status, payment_status, hold_expires_at from public.bookings where id = $1', [r.booking.id]);
    assert.equal(b.status, 'payment_due');
    assert.equal(b.payment_status, 'unpaid');
    assert.ok(b.hold_expires_at);
    assert.equal((await one('select active from public.inventory_claims where booking_id = $1', [r.booking.id])).active, true);
    assert.equal((await one('select count(*)::int as n from public.refunds where booking_id = $1', [r.booking.id])).n, 0);
  });

  test('content draft/publish versioning is independent of overview money totals', async () => {
    const overview = () => rpc(svc, 'public.manager_overview($1::uuid)', [ADMIN]);
    const before1 = await overview();
    const sums = await one(`select (select coalesce(sum(captured_cents), 0)::int from public.payment_attempts) as paid,
      (select coalesce(sum(amount_cents), 0)::int from public.refunds where status = 'succeeded') as refunded`);
    assert.equal(before1.paid_cents, sums.paid);
    assert.equal(before1.refunded_cents, sums.refunded);
    const { version } = await one('select version from public.properties where id = $1', [PROPERTY]);
    const content = (title) => ({ title, policies_confirmed: true, contact: { email: 'Owner@Example.test' },
      policies: { cancellation: 'Synthetic policy', house_rules: 'Synthetic rules' } });
    const configure = (section, data) => rpc(svc, 'public.manager_configure($1, $2::uuid, $3::jsonb)', [section, ADMIN, JSON.stringify(data)]);
    const saved = await configure('content', { content: content('Synthetic A'), version });
    assert.equal(saved.version, version + 1);
    assert.equal(saved.draft.title, 'Synthetic A');
    assert.equal(saved.draft.policies_complete, true);
    assert.equal(saved.draft.contact.email, 'owner@example.test');
    assert.equal(saved.published, null);
    await rejects(configure('content', { content: content('Stale'), version }), '55000', 'version_conflict');
    await rejects(configure('content', { content: { ...content('X'), script: '<b>' }, version: version + 1 }), '22023', 'invalid_input');
    const pub = await configure('publish', { version: version + 1 });
    assert.equal(pub.published.title, 'Synthetic A');
    const draft2 = await configure('content', { content: content('Synthetic B'), version: version + 2 });
    assert.equal(draft2.draft.title, 'Synthetic B');
    assert.equal(draft2.published.title, 'Synthetic A');
    assert.deepEqual(await overview(), before1);
  });

  test('overview refuses to sum verified money in a currency other than the property currency', async () => {
    assert.ok((await one('select count(*)::int as n from public.payment_attempts where captured_cents > 0')).n > 0);
    // Simulate preexisting mixed data by relabelling only the property, inside a rolled-back transaction.
    await root.query('begin');
    try {
      await root.query("update public.properties set currency = 'USD' where id = $1", [PROPERTY]);
      await rejects(root.query('select public.manager_overview($1::uuid)', [ADMIN]), '55000', 'currency_mismatch');
    } finally { await root.query('rollback'); }
    assert.equal((await rpc(svc, 'public.manager_overview($1::uuid)', [ADMIN])).currency, 'CAD');
  });

  test('worker lease/backoff: a failed event attempt is counted exactly once', async () => {
    const type = 'customer.updated';
    const claim = async (worker, evt) => (await work('claim_events', { worker, limit: 25 })).jobs.find((j) => j.stripe_event_id === evt);
    const evt = id('evt_test');
    await event(svc, evt, type, 'received');
    assert.equal((await eventRow(evt)).attempts, 0);
    let job = await claim('w1', evt);
    assert.equal(job.attempts, 1);
    assert.equal(job.lease_owner, 'w1');

    await event(svc, evt, type, 'failed', { error: 'boom <script>' });
    let row = await eventRow(evt);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.lease_owner, null);
    assert.equal(row.last_error, 'boom script');
    let delay = (await one('select extract(epoch from next_retry_at - now())::int as s from public.stripe_events where id = $1', [row.id])).s;
    assert.ok(delay > 20 && delay <= 30, `first backoff ${delay}`);
    await rejects(work('settle_event', { worker: 'w1', id: row.id, delay_seconds: 0 }), '55000', 'lease_lost');
    assert.equal(await claim('w1', evt), undefined, 'not claimable during backoff');

    await makeDue('stripe_events', row.id);
    job = await claim('w2', evt);
    assert.equal(job.attempts, 2);
    await event(svc, evt, type, 'failed', { error: 'again' });
    row = await eventRow(evt);
    assert.equal(row.attempts, 2);
    delay = (await one('select extract(epoch from next_retry_at - now())::int as s from public.stripe_events where id = $1', [row.id])).s;
    assert.ok(delay > 50 && delay <= 60, `second backoff ${delay}`);

    await makeDue('stripe_events', row.id);
    job = await claim('w3', evt);
    assert.equal(job.attempts, 3);
    const ok = await event(svc, evt, type, 'ignored');
    assert.equal(ok.status, 'ignored');
    row = await eventRow(evt);
    assert.deepEqual([row.attempts, row.lease_owner, row.next_retry_at, row.last_error], [3, null, null, null]);
    assert.equal((await event(svc, evt, type, 'ignored')).replay, true);
    assert.equal((await eventRow(evt)).attempts, 3);

    // Direct webhook failures (no lease) count once each.
    const direct = id('evt_test');
    await event(svc, direct, type, 'failed', { error: 'x' });
    await event(svc, direct, type, 'failed', {});
    row = await eventRow(direct);
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, 'unknown_error');

    // Exhaustion at 25.
    const capped = id('evt_test');
    await event(svc, capped, type, 'received');
    await root.query(`update public.stripe_events set status = 'failed', attempts = 24, next_retry_at = now() - interval '1 second' where stripe_event_id = $1`, [capped]);
    assert.equal((await claim('w4', capped)).attempts, 25);
    await event(svc, capped, type, 'failed', { error: 'still failing' });
    row = await eventRow(capped);
    assert.equal(row.attempts, 25);
    await makeDue('stripe_events', row.id);
    assert.equal(await claim('w4', capped), undefined, 'exhausted events are not claimed');
  });

  test('concurrent duplicate webhook vs claimed worker: one effect, one attempt', async () => {
    const r = await approved(110, 112);
    const session = id('cs_test'); const evt = id('evt_test');
    await attach(r.attempt, session);
    const data = paidData(r.booking, r.attempt, session, id('pi_test'));
    const type = 'checkout.session.completed';
    await event(svc, evt, type, 'received');
    const job = (await work('claim_events', { worker: 'wpay', limit: 25 })).jobs.find((j) => j.stripe_event_id === evt);
    assert.equal(job.attempts, 1);
    const out = await race((c) => event(c, evt, type, 'paid', data), (c) => event(c, evt, type, 'paid', data));
    assert.equal(out.first.replay, false);
    assert.deepEqual(out.second.value, { event_id: evt, status: 'processed', replay: true });
    const row = await eventRow(evt);
    assert.deepEqual([row.status, row.attempts, row.lease_owner], ['processed', 1, null]);
    const a = await one('select captured_cents from public.payment_attempts where id = $1', [r.attempt.id]);
    assert.equal(a.captured_cents, r.attempt.expected_total_cents);
    assert.equal((await one(`select count(*)::int as n from public.audit_events where action = 'payment.paid' and entity_id = $1`, [r.attempt.id])).n, 1);
    await rejects(work('settle_event', { worker: 'wpay', id: row.id, delay_seconds: 0, error: 'late' }), '55000', 'lease_lost');
    assert.equal((await eventRow(evt)).status, 'processed');
  });

  test('worker settles preserve review errors unless explicitly cleared', async () => {
    assert.equal((await one('select public.manager_safe_error(null) as e')).e, null);
    assert.equal((await one(`select public.manager_safe_error('<>') as e`)).e, 'unknown_error');

    // External Stripe refund over-commits a local reservation -> review flag.
    const p = await paid(90, 92);
    const amount = Math.floor(p.total * 0.6);
    const local = await reserve(svc, p.booking.id, id('refund_key'), amount);
    await event(svc, id('evt_test'), 'refund.created', 'refund', { stripe_refund_id: id('re_test'), booking_id: p.booking.id,
      payment_intent: p.pi, amount_cents: amount, currency: 'CAD', status: 'succeeded' });
    const flag = 'review_overcommitted_by_external_refund';
    assert.equal((await one('select last_error from public.refunds where id = $1', [local.id])).last_error, flag);
    const rj = (await work('claim_refunds', { worker: 'wr', limit: 25 })).jobs.find((j) => j.id === local.id);
    assert.ok(rj);
    const settled = await work('settle_refund', { worker: 'wr', id: local.id, delay_seconds: 0 });
    assert.equal(settled.job.last_error, flag);
    assert.equal(settled.job.lease_owner, null);

    const r = await approved(120, 122);
    await rpc(svc, "public.manager_payment($1::uuid, 'error', $2::jsonb)", [r.attempt.id, JSON.stringify({ error: 'stripe timeout' })]);
    await makeDue('payment_attempts', r.attempt.id);
    const claimAttempt = async () => (await work('claim_attempts', { worker: 'wa', limit: 25 })).jobs.find((j) => j.id === r.attempt.id);
    assert.ok(await claimAttempt());
    assert.equal((await work('settle_attempt', { worker: 'wa', id: r.attempt.id, delay_seconds: 0 })).job.last_error, 'stripe timeout');
    assert.ok(await claimAttempt());
    assert.equal((await work('settle_attempt', { worker: 'wa', id: r.attempt.id, delay_seconds: 0, error: 'bad <x>' })).job.last_error, 'bad x');
    assert.ok(await claimAttempt());
    assert.equal((await work('settle_attempt', { worker: 'wa', id: r.attempt.id, delay_seconds: 0, error: null })).job.last_error, null);
  });

  test('owner requeue of exhausted received/failed events is admin-only, lease-safe and audited', async () => {
    const type = 'customer.updated';
    const mk = async (lease, status = 'failed') => {
      const evt = id('evt_test');
      await event(svc, evt, type, 'failed', { error: 'exhausted' });
      await root.query(`update public.stripe_events set status = $4, attempts = 25, lease_owner = $2,
        lease_expires_at = case when $2::text is null then null else now() + $3::interval end where stripe_event_id = $1`,
      [evt, lease?.owner ?? null, lease?.ttl ?? '0 seconds', status]);
      return evt;
    };
    const free = await mk(null);
    const expired = await mk({ owner: 'ghost', ttl: '-1 minute' });
    const leased = await mk({ owner: 'ghost', ttl: '1 hour' });
    // Worker crashed after claiming: still 'received', attempts exhausted, lease expired.
    const crashed = await mk({ owner: 'crashed', ttl: '-1 minute' }, 'received');
    const receivedLeased = await mk({ owner: 'live', ttl: '1 hour' }, 'received');
    const processed = await mk(null, 'processed');
    const ignored = await mk(null, 'ignored');
    await rejects(rpc(svc, 'public.manager_retry_events($1::uuid)', [OTHER]), '42501', 'forbidden');
    const res = await rpc(svc, 'public.manager_retry_events($1::uuid)', [ADMIN]);
    for (const evt of [free, expired, crashed]) assert.ok(res.event_ids.includes(evt), `requeued ${evt}`);
    for (const evt of [leased, receivedLeased, processed, ignored]) assert.ok(!res.event_ids.includes(evt), `not requeued ${evt}`);
    assert.equal(res.requeued, res.event_ids.length);
    for (const [evt, status] of [[free, 'failed'], [expired, 'failed'], [crashed, 'received']]) {
      const row = await eventRow(evt);
      assert.deepEqual([row.status, row.attempts, row.lease_owner, row.lease_expires_at, row.last_error], [status, 0, null, null, 'exhausted']);
      assert.ok(row.next_retry_at <= new Date(Date.now() + 1000));
    }
    for (const [evt, status, owner] of [[leased, 'failed', 'ghost'], [receivedLeased, 'received', 'live'], [processed, 'processed', null], [ignored, 'ignored', null]]) {
      const row = await eventRow(evt);
      assert.deepEqual([row.status, row.attempts, row.lease_owner], [status, 25, owner]);
    }
    const audit = await one(`select actor_id, data from public.audit_events where action = 'stripe_events.requeued' order by created_at desc limit 1`);
    assert.equal(audit.actor_id, ADMIN);
    assert.equal(audit.data.count, res.requeued);
    const jobs = (await work('claim_events', { worker: 'wq', limit: 25 })).jobs;
    assert.equal(jobs.find((j) => j.stripe_event_id === free)?.attempts, 1);
    assert.equal(jobs.find((j) => j.stripe_event_id === crashed)?.attempts, 1);
    assert.equal(jobs.find((j) => j.stripe_event_id === leased), undefined);
    assert.equal(jobs.find((j) => j.stripe_event_id === receivedLeased), undefined);
  });
});
