-- ART-100: feeding outcomes become saved alert events alongside the telemetry crossings.
-- A feeding event references its real sequence and never invents a sample or limit;
-- one event per (sequence, kind) is created when the sequence reaches that final status.

alter table public.alert_events
  add column sequence_id uuid,
  alter column boot_id drop not null,
  alter column sample_sequence drop not null,
  alter column applied_revision drop not null,
  alter column metric_value drop not null,
  alter column limit_value drop not null,
  alter column measured_at drop not null,
  drop constraint alert_events_alert_kind_check,
  add constraint alert_events_alert_kind_check check (alert_kind in (
    'do_low', 'do_high', 'feed_low',
    'feeding_failed', 'feeding_partial', 'feeding_unknown', 'feeding_unmeasured')),
  -- Telemetry events keep every reading fact; feeding events carry only their sequence.
  add constraint alert_events_source_facts check (
    case when alert_kind in ('do_low', 'do_high', 'feed_low') then
      sequence_id is null and boot_id is not null and sample_sequence is not null
      and applied_revision is not null and metric_value is not null
      and limit_value is not null and measured_at is not null
    else
      sequence_id is not null and boot_id is null and sample_sequence is null
      and applied_revision is null and metric_value is null
      and limit_value is null and measured_at is null
    end),
  add constraint alert_events_feeding_once unique (device_id, sequence_id, alert_kind),
  add constraint alert_events_sequence_fkey foreign key (device_id, sequence_id)
    references public.feed_sequences(device_id, sequence_id) on delete restrict;

-- Final feeding outcomes worth a phone alert. Expired and rejected never moved feed.
-- A completed sequence alerts only when a completed step has no valid final weighing.
create function private.art100_feeding_alert_kind(p_device_id uuid, p_sequence_id uuid, p_status text)
returns text
language sql
stable
set search_path = ''
as $$
  select case p_status
    when 'failed' then 'feeding_failed'
    when 'partial' then 'feeding_partial'
    when 'unknown' then 'feeding_unknown'
    when 'completed' then case when exists (
      select 1 from public.feed_steps f
      where f.device_id = p_device_id and f.sequence_id = p_sequence_id
        and f.status = 'completed' and f.measurement_quality <> 'valid'
    ) then 'feeding_unmeasured' end
  end
$$;
revoke all on function private.art100_feeding_alert_kind(uuid, uuid, text) from public, anon, authenticated, service_role;

create function private.art100_raise_feeding_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := private.art100_feeding_alert_kind(new.device_id, new.sequence_id, new.status);
  v_latest_raised_at timestamptz;
begin
  if v_kind is null then
    return new;
  end if;
  -- Serialize with the telemetry crossing path, which holds this row lock, so
  -- raised_at stays strictly increasing per device for bulk read/dismiss cutoffs.
  perform 1 from public.device_state s where s.device_id = new.device_id for update;
  select e.raised_at into v_latest_raised_at
    from public.alert_events e
    where e.device_id = new.device_id
    order by e.raised_at desc, e.event_id desc
    limit 1;
  insert into public.alert_events(device_id, sequence_id, alert_kind, raised_at, is_simulated)
  select new.device_id, new.sequence_id, v_kind,
    greatest(
      pg_catalog.clock_timestamp(),
      coalesce(v_latest_raised_at + interval '1 microsecond', pg_catalog.clock_timestamp())
    ),
    d.is_simulated
  from public.devices d
  where d.device_id = new.device_id
  -- A replayed or repeated transition to the same outcome never adds a second event.
  on conflict (device_id, sequence_id, alert_kind) do nothing;
  return new;
end;
$$;
revoke all on function private.art100_raise_feeding_alert() from public, anon, authenticated, service_role;

create trigger feed_sequences_feeding_alert
  after insert or update of status on public.feed_sequences
  for each row
  when (new.status in ('failed', 'partial', 'unknown', 'completed'))
  execute function private.art100_raise_feeding_alert();

-- Every reader returns sequence_id; feeding events have null reading facts.
create function pg_temp.art100_patch(p_function regprocedure, p_pairs text[])
returns void
language plpgsql
as $$
declare
  v_source text;
  v_definition text;
  i integer;
begin
  select p.prosrc, pg_catalog.pg_get_functiondef(p.oid) into v_source, v_definition
    from pg_catalog.pg_proc p where p.oid = p_function;
  -- Some live bodies were created with CRLF line endings; compare on LF.
  v_source := replace(v_source, E'\r\n', E'\n');
  v_definition := replace(v_definition, E'\r\n', E'\n');
  for i in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
    if length(v_source) - length(replace(v_source, p_pairs[i], '')) <> length(p_pairs[i])
       or length(v_definition) - length(replace(v_definition, p_pairs[i], '')) <> length(p_pairs[i]) then
      raise exception 'ART-100 patch % does not match % exactly once', (i + 1) / 2, p_function;
    end if;
    v_source := replace(v_source, p_pairs[i], p_pairs[i + 1]);
    v_definition := replace(v_definition, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_definition;
end
$$;

select pg_temp.art100_patch('public.art95_list_alert_events(uuid,uuid,timestamptz,uuid)'::regprocedure, array[
$o$      e.sample_sequence, e.is_simulated,
$o$, $n$      e.sample_sequence, e.is_simulated, e.sequence_id,
$n$,
$o$        'sample_sequence', sample_sequence,
        'is_simulated', is_simulated,$o$, $n$        'sample_sequence', sample_sequence,
        'sequence_id', sequence_id,
        'is_simulated', is_simulated,$n$
]);

select pg_temp.art100_patch('public.art96_read_alert_event(uuid,uuid,uuid)'::regprocedure, array[
$o$    'boot_id', e.boot_id, 'sample_sequence', e.sample_sequence,
$o$, $n$    'boot_id', e.boot_id, 'sample_sequence', e.sample_sequence, 'sequence_id', e.sequence_id,
$n$
]);

drop function pg_temp.art100_patch(regprocedure, text[]);

revoke all on function public.art95_list_alert_events(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.art95_list_alert_events(uuid, uuid, timestamptz, uuid) to service_role;
revoke all on function public.art96_read_alert_event(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.art96_read_alert_event(uuid, uuid, uuid) to service_role;
