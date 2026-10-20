-- ART-95: immutable, server-evaluated crossings and installation-local history state.
-- Evaluation runs only when the authenticated sync path promotes a new live pointer.

create table public.alert_events (
  event_id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(device_id) on delete restrict,
  boot_id uuid not null,
  sample_sequence bigint not null check (sample_sequence >= 0),
  alert_kind text not null check (alert_kind in ('do_low', 'do_high', 'feed_low')),
  applied_revision bigint not null check (applied_revision > 0),
  metric_value numeric not null,
  limit_value numeric not null,
  measured_at timestamptz not null,
  raised_at timestamptz not null default clock_timestamp(),
  is_simulated boolean not null,
  unique (device_id, boot_id, sample_sequence, alert_kind),
  unique (device_id, event_id),
  foreign key (device_id, boot_id, sample_sequence)
    references public.device_telemetry(device_id, boot_id, sample_sequence) on delete restrict,
  foreign key (device_id, applied_revision)
    references public.device_config_revisions(device_id, revision) on delete restrict,
  check (metric_value::text not in ('NaN', 'Infinity', '-Infinity')),
  check (limit_value::text not in ('NaN', 'Infinity', '-Infinity'))
);

create index alert_events_device_order_idx
  on public.alert_events(device_id, raised_at desc, event_id desc);

alter table public.alert_events enable row level security;
revoke all on public.alert_events from public, anon, authenticated;
grant select on public.alert_events to authenticated;
create policy alert_events_active_member_select
  on public.alert_events for select to authenticated
  using (
    exists (
      select 1 from public.device_access a
      where a.device_id = alert_events.device_id
        and a.installation_id = auth.uid()
        and a.status = 'active'
    )
  );

create table private.device_alert_state (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  alert_kind text not null check (alert_kind in ('do_low', 'do_high', 'feed_low')),
  is_outside boolean not null default false,
  last_valid_boot_id uuid,
  last_valid_sample_sequence bigint,
  primary key (device_id, alert_kind),
  check ((last_valid_boot_id is null) = (last_valid_sample_sequence is null))
);

create table private.installation_alert_event_state (
  device_id uuid not null,
  event_id uuid not null,
  installation_id uuid not null,
  read_at timestamptz,
  dismissed_at timestamptz,
  primary key (device_id, event_id, installation_id),
  foreign key (device_id, event_id)
    references public.alert_events(device_id, event_id) on delete restrict,
  foreign key (device_id, installation_id)
    references public.device_access(device_id, installation_id) on delete cascade
);

create table private.installation_alert_bulk_state (
  device_id uuid not null,
  installation_id uuid not null,
  read_through_raised_at timestamptz,
  read_through_event_id uuid,
  dismissed_through_raised_at timestamptz,
  dismissed_through_event_id uuid,
  primary key (device_id, installation_id),
  foreign key (device_id, installation_id)
    references public.device_access(device_id, installation_id) on delete cascade,
  check ((read_through_raised_at is null) = (read_through_event_id is null)),
  check ((dismissed_through_raised_at is null) = (dismissed_through_event_id is null))
);

revoke all on private.device_alert_state from public, anon, authenticated, service_role;
revoke all on private.installation_alert_event_state from public, anon, authenticated, service_role;
revoke all on private.installation_alert_bulk_state from public, anon, authenticated, service_role;

create function private.art95_reject_alert_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'alert event facts are immutable' using errcode = '55000';
end;
$$;
revoke all on function private.art95_reject_alert_event_mutation() from public, anon, authenticated, service_role;

create trigger alert_events_immutable
  before update or delete on public.alert_events
  for each row execute function private.art95_reject_alert_event_mutation();

create function private.art95_evaluate_alert_crossings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_sample public.device_telemetry%rowtype;
  v_snapshot jsonb;
  v_limits jsonb;
  v_rule record;
  v_limit_json jsonb;
  v_limit numeric;
  v_value numeric;
  v_was_outside boolean;
  v_is_outside boolean;
  v_capable boolean;
  v_valid boolean;
  v_sample_time_valid boolean;
  v_now timestamptz := clock_timestamp();
  v_latest_raised_at timestamptz;
  v_raised_at timestamptz;
begin
  if new.latest_telemetry_boot_id is null
     or new.latest_telemetry_sequence is null then
    return new;
  end if;

  select d.* into v_device
  from public.devices d
  where d.device_id = new.device_id;
  if not found or v_device.applied_revision is null then
    return new;
  end if;

  select t.* into v_sample
  from public.device_telemetry t
  where t.device_id = new.device_id
    and t.boot_id = new.latest_telemetry_boot_id
    and t.sample_sequence = new.latest_telemetry_sequence;
  if not found
     then
    return new;
  end if;
  v_sample_time_valid :=
    v_sample.measured_at is not null
    and v_sample.time_quality in ('synced', 'rtc')
    and v_sample.measured_at <= v_now
    and v_sample.measured_at >= v_now - interval '30 seconds';

  select r.requested_snapshot into v_snapshot
  from public.device_config_revisions r
  where r.device_id = new.device_id
    and r.revision = v_device.applied_revision
    and r.state = 'applied'
    and r.applied_at is not null;
  if not found or jsonb_typeof(v_snapshot) is distinct from 'object' then
    return new;
  end if;
  v_limits := v_snapshot -> 'monitoring_limits';
  if jsonb_typeof(v_limits) is distinct from 'object' then
    return new;
  end if;

  for v_rule in
    select *
    from (values
      ('do_low'::text, 'do_mg_l'::text, 'do_low_mg_l'::text, 'do_monitoring'::text, 'below'::text),
      ('do_high'::text, 'do_mg_l'::text, 'do_high_mg_l'::text, 'do_monitoring'::text, 'above'::text),
      ('feed_low'::text, 'feed_percent'::text, 'low_feed_threshold_pct'::text,
        'feed_remaining_monitoring'::text, 'below'::text)
    ) as rules(alert_kind, metric_name, limit_name, capability_name, direction)
  loop
    if v_rule.metric_name = 'feed_percent' then
      if coalesce(v_snapshot ? v_rule.limit_name, false) is not true then
        continue;
      end if;
      v_limit_json := v_snapshot -> v_rule.limit_name;
    else
      if coalesce(v_limits ? v_rule.limit_name, false) is not true then
        continue;
      end if;
      v_limit_json := v_limits -> v_rule.limit_name;
    end if;

    if v_limit_json is null then
      continue;
    end if;
    if jsonb_typeof(v_limit_json) = 'null' then
      insert into private.device_alert_state(device_id, alert_kind, is_outside)
        values (new.device_id, v_rule.alert_kind, false)
        on conflict (device_id, alert_kind) do nothing;
      select s.is_outside into v_was_outside
        from private.device_alert_state s
        where s.device_id = new.device_id and s.alert_kind = v_rule.alert_kind
        for update;
      update private.device_alert_state
        set is_outside = false,
            last_valid_boot_id = null,
            last_valid_sample_sequence = null
        where device_id = new.device_id and alert_kind = v_rule.alert_kind;
      continue;
    end if;
    if jsonb_typeof(v_limit_json) is distinct from 'number' then
      continue;
    end if;

    v_limit := v_limit_json::text::numeric;
    if v_limit::text in ('NaN', 'Infinity', '-Infinity') then
      continue;
    end if;

    v_capable := coalesce(
      v_device.capabilities -> v_rule.capability_name = 'true'::jsonb,
      false
    );
    if not v_capable then
      continue;
    end if;
    if not v_sample_time_valid then
      continue;
    end if;

    if v_rule.metric_name = 'do_mg_l' then
      v_valid := v_sample.do_quality = 'valid' and v_sample.do_mg_l is not null;
      v_value := v_sample.do_mg_l;
    else
      v_valid := v_sample.feed_quality = 'valid' and v_sample.feed_percent is not null;
      v_value := v_sample.feed_percent;
    end if;
    if not v_valid or v_value::text in ('NaN', 'Infinity', '-Infinity') then
      continue;
    end if;

    v_is_outside := case
      when v_rule.direction = 'below' then v_value < v_limit
      else v_value > v_limit
    end;

    insert into private.device_alert_state(device_id, alert_kind, is_outside)
      values (new.device_id, v_rule.alert_kind, false)
      on conflict (device_id, alert_kind) do nothing;
    select s.is_outside into v_was_outside
      from private.device_alert_state s
      where s.device_id = new.device_id and s.alert_kind = v_rule.alert_kind
      for update;

    if not v_was_outside and v_is_outside then
      -- This trigger runs while the sync transaction holds the device_state
      -- row lock, serializing supported event creation for this device. Keep
      -- raised_at strictly increasing even if the wall clock stalls or moves
      -- backward, so a captured bulk cutoff cannot absorb a newer crossing.
      -- The seek follows alert_events_device_order_idx.
      select e.raised_at
        into v_latest_raised_at
        from public.alert_events e
        where e.device_id = new.device_id
        order by e.raised_at desc, e.event_id desc
        limit 1;
      v_raised_at := greatest(
        pg_catalog.clock_timestamp(),
        coalesce(v_latest_raised_at + interval '1 microsecond', pg_catalog.clock_timestamp())
      );

      insert into public.alert_events(
        device_id, boot_id, sample_sequence, alert_kind, applied_revision,
        metric_value, limit_value, measured_at, raised_at, is_simulated
      )
      values (
        new.device_id, v_sample.boot_id, v_sample.sample_sequence,
        v_rule.alert_kind, v_device.applied_revision,
        v_value, v_limit, v_sample.measured_at, v_raised_at, v_device.is_simulated
      )
      on conflict (device_id, boot_id, sample_sequence, alert_kind) do nothing;
    end if;

    update private.device_alert_state
      set is_outside = v_is_outside,
          last_valid_boot_id = v_sample.boot_id,
          last_valid_sample_sequence = v_sample.sample_sequence
      where device_id = new.device_id and alert_kind = v_rule.alert_kind;
  end loop;

  return new;
end;
$$;
revoke all on function private.art95_evaluate_alert_crossings() from public, anon, authenticated, service_role;

create trigger device_state_alert_crossings
  after update of latest_telemetry_boot_id, latest_telemetry_sequence on public.device_state
  for each row
  when (
    old.latest_telemetry_boot_id is distinct from new.latest_telemetry_boot_id
    or old.latest_telemetry_sequence is distinct from new.latest_telemetry_sequence
  )
  execute function private.art95_evaluate_alert_crossings();

create function public.art95_list_alert_events(
  p_device_id uuid,
  p_installation_id uuid,
  p_before_raised_at timestamptz default null,
  p_before_event_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_events jsonb;
  v_has_more boolean;
  v_unread_count bigint;
begin
  perform 1 from public.device_access a
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
    for share;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;

  if (p_before_raised_at is null) <> (p_before_event_id is null) then
    return jsonb_build_object('status', 'invalid_cursor');
  end if;
  if p_before_event_id is not null and not exists (
    select 1 from public.alert_events e
    where e.device_id = p_device_id
      and e.event_id = p_before_event_id
      and e.raised_at = p_before_raised_at
  ) then
    return jsonb_build_object('status', 'invalid_cursor');
  end if;

  select count(*) into v_unread_count
  from public.alert_events e
  left join private.installation_alert_event_state s
    on s.device_id = e.device_id
    and s.event_id = e.event_id
    and s.installation_id = p_installation_id
  left join private.installation_alert_bulk_state b
    on b.device_id = e.device_id
    and b.installation_id = p_installation_id
  where e.device_id = p_device_id
    and s.read_at is null
    and s.dismissed_at is null
    and (
      b.read_through_raised_at is null
      or (e.raised_at, e.event_id) > (b.read_through_raised_at, b.read_through_event_id)
    )
    and (
      b.dismissed_through_raised_at is null
      or (e.raised_at, e.event_id) > (b.dismissed_through_raised_at, b.dismissed_through_event_id)
    );

  with event_state as (
    select e.event_id, e.device_id, e.alert_kind, e.metric_value, e.limit_value,
      e.measured_at, e.raised_at, e.applied_revision, e.boot_id,
      e.sample_sequence, e.is_simulated,
      (
        s.read_at is not null
        or s.dismissed_at is not null
        or (
          b.read_through_raised_at is not null
          and (e.raised_at, e.event_id) <= (b.read_through_raised_at, b.read_through_event_id)
        )
        or (
          b.dismissed_through_raised_at is not null
          and (e.raised_at, e.event_id) <= (b.dismissed_through_raised_at, b.dismissed_through_event_id)
        )
      ) as is_read,
      (
        s.dismissed_at is not null
        or (
          b.dismissed_through_raised_at is not null
          and (e.raised_at, e.event_id) <= (b.dismissed_through_raised_at, b.dismissed_through_event_id)
        )
      ) as is_dismissed
    from public.alert_events e
    left join private.installation_alert_event_state s
      on s.device_id = e.device_id
      and s.event_id = e.event_id
      and s.installation_id = p_installation_id
    left join private.installation_alert_bulk_state b
      on b.device_id = e.device_id
      and b.installation_id = p_installation_id
    where e.device_id = p_device_id
  ), page as (
    select e.*
    from event_state e
    where not e.is_dismissed
      and (
        p_before_event_id is null
        or (e.raised_at, e.event_id) < (p_before_raised_at, p_before_event_id)
      )
    order by e.raised_at desc, e.event_id desc
    limit 51
  )
  select
    count(*) > 50,
    coalesce(
      jsonb_agg(jsonb_build_object(
        'event_id', event_id,
        'device_id', device_id,
        'kind', alert_kind,
        'value', metric_value,
        'limit', limit_value,
        'measured_at', measured_at,
        'raised_at', raised_at,
        'applied_revision', applied_revision,
        'boot_id', boot_id,
        'sample_sequence', sample_sequence,
        'is_simulated', is_simulated,
        'is_read', is_read,
        'is_dismissed', is_dismissed
      ) order by raised_at desc, event_id desc),
      '[]'::jsonb
    )
  into v_has_more, v_events
  from page;

  return jsonb_build_object(
    'status', 'ok',
    'events', v_events,
    'has_more', v_has_more,
    'unread_count', v_unread_count
  );
end;
$$;
revoke all on function public.art95_list_alert_events(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.art95_list_alert_events(uuid, uuid, timestamptz, uuid) to service_role;

create function public.art95_set_alert_event_state(
  p_device_id uuid,
  p_event_id uuid,
  p_installation_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_read boolean;
  v_dismissed boolean;
begin
  perform 1 from public.device_access a
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
    for share;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  if p_action is null or p_action not in ('read', 'dismiss') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if not exists (
    select 1 from public.alert_events e
    where e.device_id = p_device_id and e.event_id = p_event_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into private.installation_alert_event_state(
    device_id, event_id, installation_id, read_at, dismissed_at
  )
  values (
    p_device_id, p_event_id, p_installation_id,
    case when p_action in ('read', 'dismiss') then clock_timestamp() end,
    case when p_action = 'dismiss' then clock_timestamp() end
  )
  on conflict (device_id, event_id, installation_id) do update
    set read_at = coalesce(
          private.installation_alert_event_state.read_at,
          excluded.read_at
        ),
        dismissed_at = coalesce(
          private.installation_alert_event_state.dismissed_at,
          excluded.dismissed_at
        );

  select s.read_at is not null or s.dismissed_at is not null,
         s.dismissed_at is not null
    into v_read, v_dismissed
    from private.installation_alert_event_state s
    where s.device_id = p_device_id
      and s.event_id = p_event_id
      and s.installation_id = p_installation_id;
  return jsonb_build_object(
    'status', 'ok',
    'event_id', p_event_id,
    'is_read', v_read,
    'is_dismissed', v_dismissed
  );
end;
$$;
revoke all on function public.art95_set_alert_event_state(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.art95_set_alert_event_state(uuid, uuid, uuid, text) to service_role;

create function public.art95_bulk_alert_event_state(
  p_device_id uuid,
  p_installation_id uuid,
  p_action text,
  p_through_raised_at timestamptz,
  p_through_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.device_access a
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
    for share;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  if p_action is null or p_action not in ('mark_read', 'dismiss') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_through_raised_at is null or p_through_event_id is null
     or not exists (
       select 1 from public.alert_events e
       where e.device_id = p_device_id
         and e.event_id = p_through_event_id
         and e.raised_at = p_through_raised_at
     ) then
    return jsonb_build_object('status', 'invalid_cutoff');
  end if;

  insert into private.installation_alert_bulk_state(
    device_id, installation_id,
    read_through_raised_at, read_through_event_id,
    dismissed_through_raised_at, dismissed_through_event_id
  )
  values (
    p_device_id, p_installation_id,
    p_through_raised_at, p_through_event_id,
    case when p_action = 'dismiss' then p_through_raised_at end,
    case when p_action = 'dismiss' then p_through_event_id end
  )
  on conflict (device_id, installation_id) do update
    set read_through_raised_at = case
          when private.installation_alert_bulk_state.read_through_raised_at is null
            or (
              private.installation_alert_bulk_state.read_through_raised_at,
              private.installation_alert_bulk_state.read_through_event_id
            ) < (excluded.read_through_raised_at, excluded.read_through_event_id)
          then excluded.read_through_raised_at
          else private.installation_alert_bulk_state.read_through_raised_at
        end,
        read_through_event_id = case
          when private.installation_alert_bulk_state.read_through_raised_at is null
            or (
              private.installation_alert_bulk_state.read_through_raised_at,
              private.installation_alert_bulk_state.read_through_event_id
            ) < (excluded.read_through_raised_at, excluded.read_through_event_id)
          then excluded.read_through_event_id
          else private.installation_alert_bulk_state.read_through_event_id
        end,
        dismissed_through_raised_at = case
          when excluded.dismissed_through_raised_at is not null
            and (
              private.installation_alert_bulk_state.dismissed_through_raised_at is null
              or (
                private.installation_alert_bulk_state.dismissed_through_raised_at,
                private.installation_alert_bulk_state.dismissed_through_event_id
              ) < (excluded.dismissed_through_raised_at, excluded.dismissed_through_event_id)
            )
          then excluded.dismissed_through_raised_at
          else private.installation_alert_bulk_state.dismissed_through_raised_at
        end,
        dismissed_through_event_id = case
          when excluded.dismissed_through_event_id is not null
            and (
              private.installation_alert_bulk_state.dismissed_through_raised_at is null
              or (
                private.installation_alert_bulk_state.dismissed_through_raised_at,
                private.installation_alert_bulk_state.dismissed_through_event_id
              ) < (excluded.dismissed_through_raised_at, excluded.dismissed_through_event_id)
            )
          then excluded.dismissed_through_event_id
          else private.installation_alert_bulk_state.dismissed_through_event_id
        end;

  return jsonb_build_object(
    'status', 'ok',
    'action', p_action,
    'through_raised_at', p_through_raised_at,
    'through_event_id', p_through_event_id
  );
end;
$$;
revoke all on function public.art95_bulk_alert_event_state(uuid, uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.art95_bulk_alert_event_state(uuid, uuid, text, timestamptz, uuid) to service_role;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication p
    where p.pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables p
    where p.pubname = 'supabase_realtime'
      and p.schemaname = 'public'
      and p.tablename = 'alert_events'
  ) then
    alter publication supabase_realtime add table public.alert_events;
  end if;
end;
$$;
