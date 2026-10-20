-- ART-102: one shared name/location per feeder instead of one per installation.
-- Additive: device_access.alias/location are kept as the unreconciled originals and no
-- longer written or read by the app.
alter table public.devices
  add column alias text check (alias is null or (char_length(alias) between 1 and 100 and alias = btrim(alias))),
  add column location text check (location is null or (char_length(location) between 1 and 160 and location = btrim(location))),
  add column metadata_revision bigint not null default 1 check (metadata_revision > 0),
  add column metadata_conflict boolean not null default false;

-- Deterministic backfill from active memberships, per field: no distinct nonempty value
-- -> null; exactly one -> copy; several -> leave null and flag the conflict so an
-- authorized phone chooses explicitly. Nothing is picked by sync order.
with labels as (
  select d.device_id,
         count(distinct nullif(btrim(a.alias), '')) as alias_count,
         min(nullif(btrim(a.alias), '')) as alias_value,
         count(distinct nullif(btrim(a.location), '')) as location_count,
         min(nullif(btrim(a.location), '')) as location_value
    from public.devices d
    left join public.device_access a on a.device_id = d.device_id and a.status = 'active'
   group by d.device_id
)
update public.devices d
   set alias = case when l.alias_count = 1 then l.alias_value end,
       location = case when l.location_count = 1 then l.location_value end,
       metadata_conflict = l.alias_count > 1 or l.location_count > 1
  from labels l
 where l.device_id = d.device_id;

comment on column public.device_access.alias is
  'Deprecated by ART-102: legacy per-installation original; shared name is public.devices.alias.';
comment on column public.device_access.location is
  'Deprecated by ART-102: legacy per-installation original; shared location is public.devices.location.';

drop function public.art38_update_device_alias(uuid, uuid, text, text, boolean, boolean);

-- Whole-record compare-and-set: any active installation may edit; a stale
-- expected revision never overwrites and returns the current values instead.
create function public.art102_update_device_metadata(
  p_device_id uuid,
  p_installation_id uuid,
  p_alias text,
  p_location text,
  p_expected_revision bigint
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_alias text := nullif(pg_catalog.btrim(p_alias), '');
  v_location text := nullif(pg_catalog.btrim(p_location), '');
  v_device public.devices%rowtype;
begin
  if p_expected_revision is null or p_expected_revision < 1
    or pg_catalog.char_length(coalesce(v_alias, '')) > 100
    or pg_catalog.char_length(coalesce(v_location, '')) > 160 then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  perform 1 from public.device_access a
   where a.device_id = p_device_id and a.installation_id = p_installation_id and a.status = 'active'
     for share;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_active');
  end if;
  update public.devices d
     set alias = v_alias, location = v_location,
         metadata_revision = d.metadata_revision + 1, metadata_conflict = false
   where d.device_id = p_device_id and d.metadata_revision = p_expected_revision
  returning * into v_device;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'conflict');
  end if;
  insert into private.security_audit_events (device_id, installation_id, event_type)
    values (p_device_id, p_installation_id, 'device_label_updated');
  return pg_catalog.jsonb_build_object(
    'status', 'updated', 'device_id', v_device.device_id,
    'alias', v_device.alias, 'location', v_device.location,
    'metadata_revision', v_device.metadata_revision, 'metadata_conflict', v_device.metadata_conflict
  );
end;
$$;
revoke all on function public.art102_update_device_metadata(uuid, uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.art102_update_device_metadata(uuid, uuid, text, text, bigint) to service_role;

-- Phone push names the feeder from the shared name, exactly as the app does.
create or replace function public.art96_claim_push_deliveries(p_limit integer default 100, p_lease_seconds integer default 120)
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
    'device_name', coalesce(nullif(pg_catalog.btrim(d.alias), ''), d.model)
  ) order by e.raised_at desc, e.event_id), '[]'::jsonb)
    into v_rows
    from leased l join public.alert_events e on e.event_id = l.event_id
    join public.device_access a on a.device_id = l.device_id and a.installation_id = l.installation_id and a.status = 'active'
    join public.devices d on d.device_id = l.device_id;
  return pg_catalog.jsonb_build_object('status', 'ok', 'project_id', v_project, 'deliveries', v_rows);
end;
$$;

create or replace function public.art96_begin_push_send(p_delivery_id uuid, p_lease_id uuid, p_generation bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_row record;
begin
  select d.*, t.expo_push_token, dev.alias, dev.model, e.alert_kind, e.metric_value, e.limit_value,
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

-- Realtime wake-up for other phones; the app refetches through RLS, never trusts the payload.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'devices') then
    alter publication supabase_realtime add table public.devices;
  end if;
end;
$$;
