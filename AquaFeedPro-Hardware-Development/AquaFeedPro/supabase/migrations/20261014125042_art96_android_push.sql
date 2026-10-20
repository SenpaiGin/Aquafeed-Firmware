-- ART-96: private, best-effort Expo delivery for immutable ART-95 events.
-- One transaction advisory lock serializes registration, token transfer, enqueue,
-- and access revocation. It is acquired before any push-owned row lock; claim
-- workers lock only outbox rows and never acquire this lock after them.

create table private.installation_push_tokens (
  installation_id uuid primary key references auth.users(id) on delete cascade,
  platform text not null default 'android' check (platform = 'android'),
  eas_project_id uuid not null,
  expo_push_token text,
  generation bigint not null default 1 check (generation > 0),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (expo_push_token is null or expo_push_token ~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,255}\]$')
);
create unique index installation_push_tokens_token_unique
  on private.installation_push_tokens(expo_push_token)
  where expo_push_token is not null;

create table private.alert_push_deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.alert_events(event_id) on delete restrict,
  device_id uuid not null references public.devices(device_id) on delete restrict,
  installation_id uuid not null,
  token_generation bigint not null check (token_generation > 0),
  eas_project_id uuid not null,
  state text not null default 'queued' check (state in (
    'queued', 'leased', 'sending', 'retry', 'accepted', 'delivered',
    'failed', 'cancelled'
  )),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null default (pg_catalog.clock_timestamp() + interval '1 hour'),
  lease_id uuid,
  lease_until timestamptz,
  ticket_id text,
  receipt_attempts integer not null default 0 check (receipt_attempts between 0 and 3),
  receipt_next_at timestamptz,
  receipt_lease_id uuid,
  receipt_lease_until timestamptz,
  last_error text check (last_error is null or last_error in (
    'transport_retry', 'message_rate_exceeded', 'device_not_registered',
    'invalid_credentials', 'invalid_payload', 'receipt_expired', 'rejected'
  )),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (event_id, installation_id),
  check ((state in ('leased', 'sending')) = (lease_id is not null and lease_until is not null)),
  check (state <> 'accepted' or (ticket_id is not null and receipt_next_at is not null))
);
create index alert_push_due_idx on private.alert_push_deliveries(next_attempt_at, created_at)
  where state in ('queued', 'retry');
create index alert_push_receipt_due_idx on private.alert_push_deliveries(receipt_next_at, created_at)
  where state = 'accepted';
create index alert_push_device_installation_idx
  on private.alert_push_deliveries(device_id, installation_id, state);

create table private.alert_push_sender_state (
  singleton boolean primary key default true check (singleton),
  paused boolean not null default false,
  pause_reason text check (pause_reason is null or pause_reason in ('invalid_credentials', 'invalid_payload')),
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (paused = (pause_reason is not null))
);
insert into private.alert_push_sender_state(singleton) values (true);

revoke all on private.installation_push_tokens from public, anon, authenticated, service_role;
revoke all on private.alert_push_deliveries from public, anon, authenticated, service_role;
revoke all on private.alert_push_sender_state from public, anon, authenticated, service_role;

create function private.art96_cancel_unsent(p_installation_id uuid, p_generation bigint default null, p_device_id uuid default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.alert_push_deliveries d
     set state = 'cancelled', lease_id = null, lease_until = null,
         last_error = null
   where d.installation_id = p_installation_id
     and (p_generation is null or d.token_generation = p_generation)
     and (p_device_id is null or d.device_id = p_device_id)
     and d.state in ('queued', 'leased', 'sending', 'retry');
$$;
revoke all on function private.art96_cancel_unsent(uuid, bigint, uuid) from public, anon, authenticated, service_role;

create function private.art96_enqueue_alert_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(964209601);
  insert into private.alert_push_deliveries(
    event_id, device_id, installation_id, token_generation, eas_project_id
  )
  select new.event_id, new.device_id, a.installation_id, t.generation, t.eas_project_id
    from public.device_access a
    join private.installation_push_tokens t on t.installation_id = a.installation_id
   where a.device_id = new.device_id
     and a.status = 'active'
     and t.expo_push_token is not null
  on conflict (event_id, installation_id) do nothing;
  return new;
end;
$$;
revoke all on function private.art96_enqueue_alert_push() from public, anon, authenticated, service_role;
create trigger alert_events_push_enqueue
  after insert on public.alert_events
  for each row execute function private.art96_enqueue_alert_push();

create function private.art96_access_revoked_push_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device_id uuid := old.device_id;
  v_installation_id uuid := old.installation_id;
  v_generation bigint;
begin
  if tg_op = 'UPDATE' and not (old.status = 'active' and new.status <> 'active') then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(964209601);
  update private.alert_push_deliveries d
     set state = 'cancelled', lease_id = null, lease_until = null
   where d.device_id = v_device_id
     and d.installation_id = v_installation_id
     and d.state in ('queued', 'leased', 'sending', 'retry');
  if not exists (
    select 1 from public.device_access a
     where a.installation_id = v_installation_id and a.status = 'active'
  ) then
    select t.generation into v_generation
      from private.installation_push_tokens t
     where t.installation_id = v_installation_id
     for update;
    if found then
      update private.installation_push_tokens
         set expo_push_token = null, generation = generation + 1,
             updated_at = pg_catalog.clock_timestamp()
       where installation_id = v_installation_id;
      perform private.art96_cancel_unsent(v_installation_id, v_generation, null);
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.art96_access_revoked_push_cleanup() from public, anon, authenticated, service_role;
create trigger device_access_push_cleanup
  after update of status or delete on public.device_access
  for each row execute function private.art96_access_revoked_push_cleanup();

create function private.art96_auth_user_push_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(964209601);
  update private.alert_push_deliveries d
     set state = 'cancelled', lease_id = null, lease_until = null
   where d.installation_id = old.id
     and d.state in ('queued', 'leased', 'sending', 'retry');
  update private.installation_push_tokens
     set expo_push_token = null, generation = generation + 1,
         updated_at = pg_catalog.clock_timestamp()
   where installation_id = old.id and expo_push_token is not null;
  return old;
end;
$$;
revoke all on function private.art96_auth_user_push_cleanup() from public, anon, authenticated, service_role;
create trigger auth_user_push_cleanup
  after delete on auth.users
  for each row execute function private.art96_auth_user_push_cleanup();

create function public.art96_register_push_token(
  p_installation_id uuid, p_eas_project_id uuid, p_platform text, p_expo_push_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_generation bigint;
  v_current private.installation_push_tokens%rowtype;
  v_holder uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(964209601);
  if p_platform is distinct from 'android'
     or p_expo_push_token is null
     or length(p_expo_push_token) > 280
     or p_expo_push_token !~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{1,255}\]$'
     or not exists (
       select 1 from public.device_access a
        where a.installation_id = p_installation_id and a.status = 'active'
     ) then
    return pg_catalog.jsonb_build_object('status', 'not_active');
  end if;
  select t.installation_id into v_holder
    from private.installation_push_tokens t
   where t.expo_push_token = p_expo_push_token
   for update;
  if found and v_holder <> p_installation_id then
    select t.generation into v_old_generation
      from private.installation_push_tokens t
     where t.installation_id = v_holder;
    update private.installation_push_tokens
       set expo_push_token = null, generation = generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where installation_id = v_holder;
    perform private.art96_cancel_unsent(v_holder, v_old_generation, null);
  end if;
  select t.* into v_current
    from private.installation_push_tokens t
   where t.installation_id = p_installation_id
   for update;
  if found then
    if v_current.expo_push_token = p_expo_push_token
       and v_current.eas_project_id = p_eas_project_id
       and v_current.platform = p_platform then
      return pg_catalog.jsonb_build_object('status', 'ok', 'generation', v_current.generation);
    end if;
    v_old_generation := v_current.generation;
    update private.installation_push_tokens
       set platform = p_platform, eas_project_id = p_eas_project_id,
           expo_push_token = p_expo_push_token, generation = generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where installation_id = p_installation_id
     returning generation into v_current.generation;
    perform private.art96_cancel_unsent(p_installation_id, v_old_generation, null);
  else
    insert into private.installation_push_tokens(
      installation_id, platform, eas_project_id, expo_push_token, generation
    ) values (p_installation_id, p_platform, p_eas_project_id, p_expo_push_token, 1)
    returning * into v_current;
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok', 'generation', v_current.generation);
end;
$$;
revoke all on function public.art96_register_push_token(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.art96_register_push_token(uuid, uuid, text, text) to service_role;

create function public.art96_revoke_push_token(p_installation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_generation bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(964209601);
  if not exists (select 1 from public.device_access a where a.installation_id = p_installation_id and a.status = 'active') then
    return pg_catalog.jsonb_build_object('status', 'not_active');
  end if;
  select t.generation into v_generation
    from private.installation_push_tokens t
   where t.installation_id = p_installation_id
   for update;
  if found then
    update private.installation_push_tokens
       set expo_push_token = null, generation = generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where installation_id = p_installation_id and expo_push_token is not null;
    perform private.art96_cancel_unsent(p_installation_id, v_generation, null);
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.art96_revoke_push_token(uuid) from public, anon, authenticated;
grant execute on function public.art96_revoke_push_token(uuid) to service_role;

create function public.art96_read_alert_event(p_device_id uuid, p_event_id uuid, p_installation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if not exists (select 1 from public.device_access a where a.device_id = p_device_id and a.installation_id = p_installation_id and a.status = 'active') then
    return pg_catalog.jsonb_build_object('status', 'not_active');
  end if;
  select pg_catalog.jsonb_build_object(
    'event_id', e.event_id, 'device_id', e.device_id, 'kind', e.alert_kind,
    'value', e.metric_value, 'limit', e.limit_value, 'measured_at', e.measured_at,
    'raised_at', e.raised_at, 'applied_revision', e.applied_revision,
    'boot_id', e.boot_id, 'sample_sequence', e.sample_sequence,
    'is_simulated', e.is_simulated,
    'is_read', coalesce(s.read_at is not null or (b.read_through_raised_at, b.read_through_event_id) >= (e.raised_at, e.event_id), false),
    'is_dismissed', coalesce(s.dismissed_at is not null or (b.dismissed_through_raised_at, b.dismissed_through_event_id) >= (e.raised_at, e.event_id), false)
  ) into v_result
    from public.alert_events e
    left join private.installation_alert_event_state s
      on s.device_id = e.device_id and s.event_id = e.event_id and s.installation_id = p_installation_id
    left join private.installation_alert_bulk_state b
      on b.device_id = e.device_id and b.installation_id = p_installation_id
   where e.device_id = p_device_id and e.event_id = p_event_id;
  if v_result is null then return pg_catalog.jsonb_build_object('status', 'not_found'); end if;
  return v_result || pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.art96_read_alert_event(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.art96_read_alert_event(uuid, uuid, uuid) to service_role;

create function public.art96_claim_push_deliveries(p_limit integer default 100, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_rows jsonb;
begin
  if p_limit < 1 or p_limit > 100 or p_lease_seconds < 30 or p_lease_seconds > 300 then
    return pg_catalog.jsonb_build_object('status', 'invalid_input');
  end if;
  if exists (select 1 from private.alert_push_sender_state s where s.singleton and s.paused) then
    return pg_catalog.jsonb_build_object('status', 'paused');
  end if;
  update private.alert_push_deliveries d
     set state = 'retry', lease_id = null, lease_until = null,
         next_attempt_at = pg_catalog.clock_timestamp()
   where d.state in ('leased', 'sending') and d.lease_until < pg_catalog.clock_timestamp()
     and d.attempt_count < 5 and d.expires_at > pg_catalog.clock_timestamp();
  update private.alert_push_deliveries d
     set state = 'failed', lease_id = null, lease_until = null, last_error = 'receipt_expired'
   where d.state in ('leased', 'sending')
     and (d.expires_at <= pg_catalog.clock_timestamp() or d.attempt_count >= 5);
  update private.alert_push_deliveries d
     set state = 'failed', last_error = 'receipt_expired'
   where (d.state in ('queued', 'retry') and (d.expires_at <= pg_catalog.clock_timestamp() or d.attempt_count >= 5))
      or (d.state = 'accepted' and d.receipt_next_at < pg_catalog.clock_timestamp() - interval '24 hours');
  select d.eas_project_id into v_project
    from private.alert_push_deliveries d
    join private.installation_push_tokens t on t.installation_id = d.installation_id and t.generation = d.token_generation and t.expo_push_token is not null
    join public.device_access a on a.device_id = d.device_id and a.installation_id = d.installation_id and a.status = 'active'
   where d.state in ('queued', 'retry') and d.next_attempt_at <= pg_catalog.clock_timestamp()
     and d.expires_at > pg_catalog.clock_timestamp() and d.attempt_count < 5
   order by d.next_attempt_at, d.created_at
   limit 1;
  if v_project is null then return pg_catalog.jsonb_build_object('status', 'ok', 'project_id', null, 'deliveries', '[]'::jsonb); end if;
  with candidates as (
    select d.delivery_id from private.alert_push_deliveries d
    join private.installation_push_tokens t on t.installation_id = d.installation_id and t.generation = d.token_generation and t.eas_project_id = d.eas_project_id and t.expo_push_token is not null
    join public.device_access a on a.device_id = d.device_id and a.installation_id = d.installation_id and a.status = 'active'
    where d.eas_project_id = v_project and d.state in ('queued', 'retry')
      and d.next_attempt_at <= pg_catalog.clock_timestamp() and d.expires_at > pg_catalog.clock_timestamp() and d.attempt_count < 5
    order by d.next_attempt_at, d.created_at
    for update of d skip locked limit p_limit
  ), leased as (
    update private.alert_push_deliveries d
       set state = 'leased', lease_id = gen_random_uuid(), lease_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)
      from candidates c where d.delivery_id = c.delivery_id
    returning d.delivery_id, d.event_id, d.device_id, d.installation_id, d.token_generation, d.eas_project_id, d.lease_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'delivery_id', l.delivery_id, 'event_id', e.event_id, 'device_id', e.device_id,
    'installation_id', l.installation_id, 'token_generation', l.token_generation,
    'eas_project_id', l.eas_project_id, 'lease_id', l.lease_id,
    'kind', e.alert_kind, 'value', e.metric_value, 'limit', e.limit_value,
    'raised_at', e.raised_at, 'is_simulated', e.is_simulated,
    'device_name', coalesce(nullif(pg_catalog.btrim(a.alias), ''), d.model)
  ) order by e.raised_at desc, e.event_id), '[]'::jsonb)
    into v_rows
    from leased l join public.alert_events e on e.event_id = l.event_id
    join public.device_access a on a.device_id = l.device_id and a.installation_id = l.installation_id and a.status = 'active'
    join public.devices d on d.device_id = l.device_id;
  return pg_catalog.jsonb_build_object('status', 'ok', 'project_id', v_project, 'deliveries', v_rows);
end;
$$;
revoke all on function public.art96_claim_push_deliveries(integer, integer) from public, anon, authenticated;
grant execute on function public.art96_claim_push_deliveries(integer, integer) to service_role;

create function public.art96_begin_push_send(p_delivery_id uuid, p_lease_id uuid, p_generation bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_row record;
begin
  select d.*, t.expo_push_token, a.alias, dev.model, e.alert_kind, e.metric_value, e.limit_value,
         e.raised_at, e.is_simulated
    into v_row
    from private.alert_push_deliveries d
    join private.installation_push_tokens t on t.installation_id = d.installation_id
    join public.device_access a on a.device_id = d.device_id and a.installation_id = d.installation_id
    join public.devices dev on dev.device_id = d.device_id
    join public.alert_events e on e.event_id = d.event_id
   where d.delivery_id = p_delivery_id and d.lease_id = p_lease_id
     and d.token_generation = p_generation and d.state = 'leased'
     and d.lease_until > pg_catalog.clock_timestamp()
     and d.attempt_count < 5
     and t.generation = d.token_generation and t.expo_push_token is not null
     and a.status = 'active'
   for update of d;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'stale');
  end if;
  update private.alert_push_deliveries d
     set state = 'sending', attempt_count = d.attempt_count + 1
   where d.delivery_id = p_delivery_id and d.lease_id = p_lease_id and d.state = 'leased'
     and d.lease_until > pg_catalog.clock_timestamp() and d.attempt_count < 5;
  if not found then return pg_catalog.jsonb_build_object('status', 'stale'); end if;
  return pg_catalog.jsonb_build_object(
    'status', 'ok', 'delivery_id', v_row.delivery_id, 'event_id', v_row.event_id,
    'device_id', v_row.device_id, 'token_generation', v_row.token_generation,
    'expo_push_token', v_row.expo_push_token, 'eas_project_id', v_row.eas_project_id,
    'kind', v_row.alert_kind, 'value', v_row.metric_value, 'limit', v_row.limit_value,
    'raised_at', v_row.raised_at, 'is_simulated', v_row.is_simulated,
    'device_name', coalesce(nullif(pg_catalog.btrim(v_row.alias), ''), v_row.model)
  );
end;
$$;
revoke all on function public.art96_begin_push_send(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.art96_begin_push_send(uuid, uuid, bigint) to service_role;

create function public.art96_validate_push_send_batch(p_claims jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_claim jsonb; v_delivery_ids jsonb; v_key_count integer;
begin
  if p_claims is null or pg_catalog.jsonb_typeof(p_claims) <> 'array' then
    return pg_catalog.jsonb_build_object('status', 'invalid_input');
  end if;
  if pg_catalog.jsonb_array_length(p_claims) > 100 then
    return pg_catalog.jsonb_build_object('status', 'invalid_input');
  end if;
  for v_claim in select item.value from pg_catalog.jsonb_array_elements(p_claims) as item(value) loop
    if pg_catalog.jsonb_typeof(v_claim) <> 'object' then
      return pg_catalog.jsonb_build_object('status', 'invalid_input');
    end if;
    select pg_catalog.count(*)::integer into v_key_count
      from pg_catalog.jsonb_object_keys(v_claim);
    if v_key_count <> 3
       or not (v_claim ? 'delivery_id')
       or not (v_claim ? 'lease_id')
       or not (v_claim ? 'token_generation')
       or coalesce(v_claim->>'delivery_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(v_claim->>'lease_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or pg_catalog.jsonb_typeof(v_claim->'token_generation') <> 'number'
       or coalesce(v_claim->>'token_generation', '') !~ '^[1-9][0-9]{0,18}$'
       or (pg_catalog.length(v_claim->>'token_generation') = 19 and v_claim->>'token_generation' > '9223372036854775807') then
      return pg_catalog.jsonb_build_object('status', 'invalid_input');
    end if;
  end loop;
  with claims as (
    select (item.value->>'delivery_id')::uuid as delivery_id,
           (item.value->>'lease_id')::uuid as lease_id,
           (item.value->>'token_generation')::bigint as token_generation
      from pg_catalog.jsonb_array_elements(p_claims) as item(value)
  )
  select coalesce(pg_catalog.jsonb_agg(c.delivery_id), '[]'::jsonb)
    into v_delivery_ids
    from claims c
    join private.alert_push_deliveries d on d.delivery_id = c.delivery_id
      and d.lease_id = c.lease_id and d.token_generation = c.token_generation
      and d.state = 'sending' and d.lease_until > pg_catalog.clock_timestamp()
    join private.installation_push_tokens t on t.installation_id = d.installation_id
      and t.generation = d.token_generation and t.eas_project_id = d.eas_project_id
      and t.expo_push_token is not null
    join public.device_access a on a.device_id = d.device_id
      and a.installation_id = d.installation_id and a.status = 'active';
  return pg_catalog.jsonb_build_object('status', 'ok', 'delivery_ids', v_delivery_ids);
end;
$$;
revoke all on function public.art96_validate_push_send_batch(jsonb) from public, anon, authenticated;
grant execute on function public.art96_validate_push_send_batch(jsonb) to service_role;

create function public.art96_record_push_send(
  p_delivery_id uuid, p_lease_id uuid, p_generation bigint,
  p_outcome text, p_ticket_id text default null, p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_installation uuid; v_attempt integer; v_expires timestamptz;
begin
  if p_outcome = 'device_not_registered' then
    perform pg_catalog.pg_advisory_xact_lock(964209601);
  end if;
  select d.installation_id, d.attempt_count, d.expires_at
    into v_installation, v_attempt, v_expires
    from private.alert_push_deliveries d
    join private.installation_push_tokens t on t.installation_id = d.installation_id and t.generation = d.token_generation and t.expo_push_token is not null
    join public.device_access a on a.device_id = d.device_id and a.installation_id = d.installation_id and a.status = 'active'
   where d.delivery_id = p_delivery_id and d.lease_id = p_lease_id
     and d.token_generation = p_generation and d.state = 'sending'
     and d.lease_until > pg_catalog.clock_timestamp()
   for update of d;
  if not found then
    update private.alert_push_deliveries d set state = 'cancelled', lease_id = null, lease_until = null
     where d.delivery_id = p_delivery_id and d.lease_id = p_lease_id and d.state = 'sending';
    return pg_catalog.jsonb_build_object('status', 'stale');
  end if;
  if p_outcome = 'accepted' and p_ticket_id ~ '^[A-Za-z0-9-]{1,200}$' then
    update private.alert_push_deliveries set state = 'accepted', lease_id = null, lease_until = null,
      ticket_id = p_ticket_id, receipt_attempts = 0,
      receipt_next_at = pg_catalog.clock_timestamp() + interval '15 minutes', last_error = null
     where delivery_id = p_delivery_id;
  elsif p_outcome = 'invalid_credentials' or p_outcome = 'invalid_payload' then
    update private.alert_push_sender_state set paused = true, pause_reason = p_outcome,
      changed_at = pg_catalog.clock_timestamp() where singleton;
    update private.alert_push_deliveries set state = 'failed', lease_id = null, lease_until = null, last_error = p_outcome
     where delivery_id = p_delivery_id;
  elsif p_outcome = 'device_not_registered' then
    update private.installation_push_tokens set expo_push_token = null, generation = generation + 1,
      updated_at = pg_catalog.clock_timestamp()
     where installation_id = v_installation and generation = p_generation and expo_push_token is not null;
    perform private.art96_cancel_unsent(v_installation, p_generation, null);
    update private.alert_push_deliveries set state = 'failed', lease_id = null, lease_until = null,
      last_error = 'device_not_registered' where delivery_id = p_delivery_id;
  elsif p_outcome in ('retry', 'ambiguous', 'rejected') then
    if v_attempt < 5 and v_expires > pg_catalog.clock_timestamp() then
      update private.alert_push_deliveries set state = 'retry', lease_id = null, lease_until = null,
        next_attempt_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => least(900, (30 * (2 ^ greatest(0, v_attempt - 1))::integer) + (pg_catalog.random() * 30)::integer)),
        last_error = case when p_error = 'message_rate_exceeded' then 'message_rate_exceeded' else 'transport_retry' end
       where delivery_id = p_delivery_id;
    else
      update private.alert_push_deliveries set state = 'failed', lease_id = null, lease_until = null, last_error = 'rejected'
       where delivery_id = p_delivery_id;
    end if;
  else
    update private.alert_push_deliveries set state = 'failed', lease_id = null, lease_until = null, last_error = 'invalid_payload'
     where delivery_id = p_delivery_id;
    update private.alert_push_sender_state set paused = true, pause_reason = 'invalid_payload', changed_at = pg_catalog.clock_timestamp() where singleton;
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.art96_record_push_send(uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.art96_record_push_send(uuid, uuid, bigint, text, text, text) to service_role;

create function public.art96_claim_push_receipts(p_limit integer default 100, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_rows jsonb;
begin
  if p_limit < 1 or p_limit > 100 or p_lease_seconds < 30 or p_lease_seconds > 300 then return pg_catalog.jsonb_build_object('status', 'invalid_input'); end if;
  update private.alert_push_deliveries set receipt_lease_id = null, receipt_lease_until = null,
    receipt_next_at = case
      when receipt_attempts < 3 and receipt_next_at > pg_catalog.clock_timestamp() - interval '24 hours'
        then pg_catalog.clock_timestamp() + interval '5 minutes'
      else receipt_next_at
    end
   where state = 'accepted' and receipt_lease_until <= pg_catalog.clock_timestamp();
  with candidates as (
    select d.delivery_id from private.alert_push_deliveries d
     where d.state = 'accepted' and d.receipt_next_at <= pg_catalog.clock_timestamp()
       and d.receipt_attempts < 3 and d.receipt_next_at > pg_catalog.clock_timestamp() - interval '24 hours'
       and d.receipt_lease_id is null
     order by d.receipt_next_at, d.created_at for update skip locked limit p_limit
  ), leased as (
    update private.alert_push_deliveries d set receipt_lease_id = gen_random_uuid(),
      receipt_lease_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
      receipt_attempts = d.receipt_attempts + 1
      from candidates c where d.delivery_id = c.delivery_id
    returning d.delivery_id, d.ticket_id, d.token_generation, d.receipt_lease_id, d.eas_project_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('delivery_id', delivery_id, 'ticket_id', ticket_id, 'token_generation', token_generation, 'lease_id', receipt_lease_id, 'eas_project_id', eas_project_id)), '[]'::jsonb)
    into v_rows from leased;
  update private.alert_push_deliveries set state = 'failed', last_error = 'receipt_expired'
   where state = 'accepted' and (receipt_attempts >= 3 or receipt_next_at <= pg_catalog.clock_timestamp() - interval '24 hours')
     and receipt_lease_id is null;
  return pg_catalog.jsonb_build_object('status', 'ok', 'receipts', v_rows);
end;
$$;
revoke all on function public.art96_claim_push_receipts(integer, integer) from public, anon, authenticated;
grant execute on function public.art96_claim_push_receipts(integer, integer) to service_role;

create function public.art96_record_push_receipt(
  p_delivery_id uuid, p_lease_id uuid, p_status text, p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_installation uuid; v_generation bigint; v_ticket text;
begin
  if p_error = 'DeviceNotRegistered' then
    perform pg_catalog.pg_advisory_xact_lock(964209601);
  end if;
  select installation_id, token_generation, ticket_id into v_installation, v_generation, v_ticket
    from private.alert_push_deliveries where delivery_id = p_delivery_id and state = 'accepted'
      and receipt_lease_id = p_lease_id and receipt_lease_until > pg_catalog.clock_timestamp()
    for update;
  if not found then return pg_catalog.jsonb_build_object('status', 'stale'); end if;
  if p_status = 'ok' then
    update private.alert_push_deliveries set state = 'delivered', receipt_lease_id = null, receipt_lease_until = null, last_error = null where delivery_id = p_delivery_id;
  elsif p_error = 'DeviceNotRegistered' then
    update private.installation_push_tokens set expo_push_token = null, generation = generation + 1, updated_at = pg_catalog.clock_timestamp()
      where installation_id = v_installation and generation = v_generation and expo_push_token is not null;
    perform private.art96_cancel_unsent(v_installation, v_generation, null);
    update private.alert_push_deliveries set state = 'failed', receipt_lease_id = null, receipt_lease_until = null, last_error = 'device_not_registered' where delivery_id = p_delivery_id;
  elsif p_error = 'InvalidCredentials' then
    update private.alert_push_sender_state set paused = true, pause_reason = 'invalid_credentials', changed_at = pg_catalog.clock_timestamp() where singleton;
    update private.alert_push_deliveries set state = 'failed', receipt_lease_id = null, receipt_lease_until = null, last_error = 'invalid_credentials' where delivery_id = p_delivery_id;
  elsif p_error = 'MessageRateExceeded' then
    update private.alert_push_deliveries set state = case when attempt_count < 5 and expires_at > pg_catalog.clock_timestamp() then 'retry' else 'failed' end,
      next_attempt_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => least(900, (30 * (2 ^ greatest(0, attempt_count - 1))::integer) + (pg_catalog.random() * 30)::integer)),
      receipt_next_at = null, receipt_lease_id = null, receipt_lease_until = null,
      last_error = 'message_rate_exceeded' where delivery_id = p_delivery_id;
  elsif p_status = 'retry' then
    update private.alert_push_deliveries set receipt_lease_id = null, receipt_lease_until = null,
      receipt_next_at = pg_catalog.clock_timestamp() + interval '5 minutes'
     where delivery_id = p_delivery_id;
  else
    update private.alert_push_deliveries set state = 'failed', receipt_lease_id = null, receipt_lease_until = null, last_error = 'rejected' where delivery_id = p_delivery_id;
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.art96_record_push_receipt(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.art96_record_push_receipt(uuid, uuid, text, text) to service_role;

create function public.art96_push_sender_status()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('status', case when s.paused then 'paused' else 'ready' end, 'reason', s.pause_reason)
    from private.alert_push_sender_state s where s.singleton;
$$;
revoke all on function public.art96_push_sender_status() from public, anon, authenticated;
grant execute on function public.art96_push_sender_status() to service_role;

-- Realtime remains limited to public.alert_events; private delivery/token data is never published.
