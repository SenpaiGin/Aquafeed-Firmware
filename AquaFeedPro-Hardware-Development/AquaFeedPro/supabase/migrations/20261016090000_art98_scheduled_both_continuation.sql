-- ART-98: one logical schedule may target Both nozzles, and a failed nozzle 1 may
-- continue to the already-authorized nozzle 2 only with device-authored proof.
-- Results aggregate from every selected step. Apply only through the isolated
-- development gate; this migration does not provision devices or actuate anything.

-- Every profile states whether it runs Both schedules. Only the three controlled
-- simulator fixtures enable it, under a new capability revision that also states the
-- simulator's 1,000 ms clock and settling bounds (re-provisioning had reset them to unknown).
update public.devices set capabilities = capabilities || '{"scheduled_both": false}'::jsonb
  where not (capabilities ? 'scheduled_both');
update public.devices
set capabilities_revision = 5,
    capabilities = capabilities || '{"scheduled_both": true, "max_clock_uncertainty_ms": 1000, "maximum_settling_ms": 1000}'::jsonb
where device_id in (
  '11111111-1111-4111-8111-111111111111'::uuid,
  '22222222-2222-4222-8222-222222222222'::uuid,
  '33333333-3333-4333-8333-333333333333'::uuid
) and is_simulated and protocol_major = 2;

-- One schedule row and one slot row per target nozzle. The existing
-- unique(device, revision, nozzle, weekday, local_time) still rejects a nozzle
-- that two schedules (including Both against a single) would run at once.
alter table public.device_config_schedules
  drop constraint device_config_schedules_pkey,
  add constraint device_config_schedules_pkey primary key (device_id, revision, schedule_id, nozzle_number);
alter table public.device_config_schedule_slots
  drop constraint device_config_schedule_slots_pkey,
  add constraint device_config_schedule_slots_pkey
    primary key (device_id, revision, schedule_id, nozzle_number, iso_weekday);

-- Rewrite stored requested/applied snapshots to the 2.5.0 targets shape. Schedule
-- identities, revisions, occurrences and results are unchanged.
update public.device_config_revisions r
set requested_snapshot = jsonb_set(r.requested_snapshot, '{schedules}', (
  select coalesce(jsonb_agg(
    (s.value - 'nozzle_number' - 'dose') || jsonb_build_object('targets', jsonb_build_array(
      jsonb_build_object('nozzle_number', s.value->'nozzle_number', 'dose', s.value->'dose')))
    order by s.ordinality), '[]'::jsonb)
  from jsonb_array_elements(r.requested_snapshot->'schedules') with ordinality as s(value, ordinality)))
where jsonb_typeof(r.requested_snapshot->'schedules') = 'array'
  and jsonb_array_length(r.requested_snapshot->'schedules') > 0
  and not exists (
    select 1 from jsonb_array_elements(r.requested_snapshot->'schedules') as s(value)
    where jsonb_typeof(s.value) <> 'object' or not (s.value ?& array['nozzle_number', 'dose'])
      or s.value ? 'targets'
  );

create or replace function private.art33_validate_snapshot(p_device_id uuid, p_snapshot jsonb)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_schedule jsonb;
  v_target jsonb;
  v_nozzle jsonb;
  v_dose jsonb;
  v_schedule_id text;
  v_timezone text;
  v_weekdays jsonb;
  v_day jsonb;
  v_number integer;
  v_amount numeric;
  v_min numeric;
  v_max numeric;
  v_step numeric;
  v_fixed text;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
     or p_snapshot - array['timezone','monitoring_limits','low_feed_threshold_pct','schedules']::text[] <> '{}'::jsonb
     or not (p_snapshot ?& array['timezone','monitoring_limits','low_feed_threshold_pct','schedules'])
     or jsonb_typeof(p_snapshot->'schedules') <> 'array'
     or jsonb_typeof(p_snapshot->'monitoring_limits') <> 'object'
     or (p_snapshot->'monitoring_limits') - array['do_low_mg_l','do_high_mg_l']::text[] <> '{}'::jsonb
     or not (p_snapshot->'monitoring_limits' ?& array['do_low_mg_l','do_high_mg_l'])
     or jsonb_typeof(p_snapshot->'monitoring_limits'->'do_low_mg_l') not in ('number','null')
     or jsonb_typeof(p_snapshot->'monitoring_limits'->'do_high_mg_l') not in ('number','null')
     or jsonb_typeof(p_snapshot->'timezone') <> 'string'
     or jsonb_typeof(p_snapshot->'low_feed_threshold_pct') not in ('number','null') then
    return 'VALIDATION_FAILED';
  end if;
  v_timezone := p_snapshot->>'timezone';
  if (p_snapshot->'monitoring_limits'->'do_low_mg_l' <> 'null'::jsonb
      and (p_snapshot->'monitoring_limits'->>'do_low_mg_l')::numeric < 0)
     or (p_snapshot->'monitoring_limits'->'do_high_mg_l' <> 'null'::jsonb
      and (p_snapshot->'monitoring_limits'->>'do_high_mg_l')::numeric < 0) then
    return 'VALIDATION_FAILED';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = v_timezone) then
    return 'VALIDATION_FAILED';
  end if;
  if p_snapshot->'low_feed_threshold_pct' <> 'null'::jsonb
     and ((p_snapshot->>'low_feed_threshold_pct')::numeric < 0
       or (p_snapshot->>'low_feed_threshold_pct')::numeric > 100) then
    return 'VALIDATION_FAILED';
  end if;
  select d.* into v_device from public.devices d where d.device_id = p_device_id
    and d.capabilities->>'local_schedule_execution'='true'
    and coalesce((d.capabilities->>'max_schedules')::integer,0)>0
    and d.capabilities->>'max_clock_uncertainty_ms' is not null
    and coalesce((d.capabilities->>'max_clock_uncertainty_ms')::integer,-1)>=0
    and d.capabilities->>'maximum_settling_ms' is not null
    and coalesce((d.capabilities->>'maximum_settling_ms')::integer,0)>0
    and d.capabilities->>'scheduler_wake_grace_ms' is not null
    and coalesce((d.capabilities->>'scheduler_wake_grace_ms')::integer,-1)>=0;
  if not found then
    return 'CAPABILITY_MISMATCH';
  end if;
  for v_schedule in select value from jsonb_array_elements(p_snapshot->'schedules') loop
    if jsonb_typeof(v_schedule) <> 'object'
       or v_schedule - array['schedule_id','local_time','weekdays','enabled','targets']::text[] <> '{}'::jsonb
       or not (v_schedule ?& array['schedule_id','local_time','weekdays','enabled','targets'])
       or jsonb_typeof(v_schedule->'schedule_id') <> 'string'
       or (v_schedule->>'schedule_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(v_schedule->'local_time') <> 'string'
       or (v_schedule->>'local_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(v_schedule->'weekdays') <> 'array'
       or jsonb_array_length(v_schedule->'weekdays') not between 1 and 7
       or jsonb_typeof(v_schedule->'enabled') <> 'boolean'
       or jsonb_typeof(v_schedule->'targets') <> 'array'
       or jsonb_array_length(v_schedule->'targets') not between 1 and 2 then
      return 'VALIDATION_FAILED';
    end if;
    v_schedule_id := lower(v_schedule->>'schedule_id');
    v_weekdays := v_schedule->'weekdays';
    for v_day in select value from jsonb_array_elements(v_weekdays) loop
      if jsonb_typeof(v_day) <> 'number' or (v_day::text)::numeric not between 1 and 7
         or trunc((v_day::text)::numeric) <> (v_day::text)::numeric then
        return 'VALIDATION_FAILED';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements(v_weekdays)) <>
       (select count(distinct value) from jsonb_array_elements(v_weekdays)) then
      return 'VALIDATION_FAILED';
    end if;
    if (select count(*) from jsonb_array_elements(p_snapshot->'schedules') as x(value)
      where lower(x.value->>'schedule_id') = v_schedule_id) > 1 then
      return 'VALIDATION_FAILED';
    end if;
    -- Both is exactly nozzle 1 then nozzle 2 and only for a profile that runs it as one sequence.
    if jsonb_array_length(v_schedule->'targets') = 2 then
      if v_schedule->'targets'->0->'nozzle_number' is distinct from '1'::jsonb
         or v_schedule->'targets'->1->'nozzle_number' is distinct from '2'::jsonb then
        return 'VALIDATION_FAILED';
      end if;
      if v_device.capabilities->'scheduled_both' is distinct from 'true'::jsonb then
        return 'CAPABILITY_MISMATCH';
      end if;
    end if;
    for v_target in select value from jsonb_array_elements(v_schedule->'targets') loop
      if jsonb_typeof(v_target) <> 'object'
         or v_target - array['nozzle_number','dose']::text[] <> '{}'::jsonb
         or not (v_target ?& array['nozzle_number','dose'])
         or jsonb_typeof(v_target->'nozzle_number') <> 'number'
         or (v_target->>'nozzle_number') not in ('1','2')
         or jsonb_typeof(v_target->'dose') <> 'object' then
        return 'VALIDATION_FAILED';
      end if;
      v_number := (v_target->>'nozzle_number')::integer;
      if not (v_device.capabilities->'nozzles'->v_number::text->>'enabled')::boolean then
        return 'CAPABILITY_MISMATCH';
      end if;
      v_nozzle := v_device.capabilities->'nozzles'->v_number::text;
      if v_nozzle->>'max_actuation_ms' is null
         or coalesce((v_nozzle->>'max_actuation_ms')::integer,0)<=0 then
        return 'CAPABILITY_MISMATCH';
      end if;
      v_dose := v_target->'dose';
      if v_dose->>'mode' = 'grams' then
        if not (v_dose ?& array['mode','amount_g'])
           or v_dose - array['mode','amount_g']::text[] <> '{}'::jsonb
           or not (v_nozzle->'dose_modes' ? 'grams')
           or jsonb_typeof(v_dose->'amount_g') <> 'number' then return 'DOSE_UNSUPPORTED'; end if;
        v_amount := (v_dose->>'amount_g')::numeric;
        v_min := (v_nozzle->>'min_dose_g')::numeric;
        v_max := (v_nozzle->>'max_dose_g')::numeric;
        v_step := (v_nozzle->>'dose_step_g')::numeric;
        if v_min is null or v_max is null or v_step is null or v_step<=0 then return 'CAPABILITY_MISMATCH'; end if;
        if v_amount < v_min or v_amount > v_max or mod(v_amount - v_min, v_step) <> 0 then
          return 'DOSE_OUT_OF_RANGE';
        end if;
      elsif v_dose->>'mode' = 'fixed_portion' then
        v_fixed := v_dose->>'fixed_portion_id';
        if not (v_dose ?& array['mode','fixed_portion_id'])
           or v_dose - array['mode','fixed_portion_id']::text[] <> '{}'::jsonb
           or jsonb_typeof(v_dose->'fixed_portion_id') <> 'string'
           or v_fixed !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
           or not (v_nozzle->'dose_modes' ? 'fixed_portion')
           or not (v_nozzle->'fixed_portion_ids' ? v_fixed) then return 'DOSE_UNSUPPORTED'; end if;
      else return 'DOSE_UNSUPPORTED'; end if;
    end loop;
  end loop;
  -- max_schedules counts logical schedules; a Both schedule is one.
  if jsonb_array_length(p_snapshot->'schedules') > coalesce((v_device.capabilities->>'max_schedules')::integer, 0) then
    return 'CAPABILITY_MISMATCH';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_snapshot->'schedules') as a(value)
    cross join lateral jsonb_array_elements(a.value->'targets') as at(value)
    join jsonb_array_elements(p_snapshot->'schedules') as b(value) on a.value->>'schedule_id' < b.value->>'schedule_id'
    cross join lateral jsonb_array_elements(b.value->'targets') as bt(value)
    where at.value->'nozzle_number' = bt.value->'nozzle_number'
      and a.value->>'local_time' = b.value->>'local_time'
      and exists (select 1 from jsonb_array_elements(a.value->'weekdays') x
        join jsonb_array_elements(b.value->'weekdays') y on x.value = y.value)
  ) then return 'VALIDATION_FAILED'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_snapshot->'schedules') as s(value)
    where exists (select 1 from public.device_schedule_tombstones t
      where t.device_id=p_device_id and t.schedule_id=(s.value->>'schedule_id')::uuid)
  ) then return 'VALIDATION_FAILED'; end if;
  return null;
exception when others then
  return 'VALIDATION_FAILED';
end;
$$;
revoke all on function private.art33_validate_snapshot(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.art33_validate_snapshot(uuid, jsonb) to service_role;

-- The device proves, for the same sequence and step 1, that the failed nozzle 1
-- stopped safely, no device-wide fault exists and the shared scale has a fresh
-- settled baseline. The server also checks timing, clock trust, nozzle 2 support
-- and the lockout. Anything missing, malformed or inconsistent returns false.
create or replace function private.art98_valid_continuation(
  p_device_id uuid, p_sequence_id uuid, p_event jsonb,
  p_clock_quality text, p_clock_uncertainty_ms integer
) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_seq public.feed_sequences%rowtype;
  v_first public.feed_steps%rowtype;
  v_evidence jsonb := p_event->'continuation_evidence';
  v_at timestamptz;
  v_baseline timestamptz;
begin
  select * into v_device from public.devices d where d.device_id = p_device_id;
  select * into v_seq from public.feed_sequences s
    where s.device_id = p_device_id and s.sequence_id = p_sequence_id;
  select * into v_first from public.feed_steps f
    where f.device_id = p_device_id and f.sequence_id = p_sequence_id and f.step_index = 1;
  if coalesce(
       v_device.device_id is null or v_seq.sequence_id is null or v_first.sequence_id is null
       or jsonb_typeof(v_evidence) <> 'object'
       or v_evidence - array['safe_stop','device_fault','baseline_ready_at']::text[] <> '{}'::jsonb
       or v_evidence->'safe_stop' is distinct from 'true'::jsonb
       or v_evidence->'device_fault' is distinct from 'false'::jsonb
       or jsonb_typeof(v_evidence->'baseline_ready_at') <> 'string'
       or p_event->>'event_type' <> 'failed' or p_event->>'outcome_status' <> 'failed'
       or p_event->'step_index' <> '1'::jsonb or p_event->'nozzle_number' <> '1'::jsonb
       or p_event->>'measurement_quality' <> 'valid'
       or p_event->>'time_quality' not in ('synced','rtc')
       or p_clock_quality not in ('synced','rtc')
       or p_clock_uncertainty_ms > (v_device.capabilities->>'max_clock_uncertainty_ms')::integer
       or v_seq.target_count <> 2 or v_seq.scheduler_wake_grace_ms is null
       or v_first.status not in ('running','failed') or v_first.started_at is null
       or v_device.capabilities->'nozzles'->'2'->'enabled' is distinct from 'true'::jsonb
       or exists (select 1 from public.device_state ds
         where ds.device_id = p_device_id and ds.safety_lockout),
     true) then
    return false;
  end if;
  v_at := (p_event->>'device_at')::timestamptz;
  v_baseline := (v_evidence->>'baseline_ready_at')::timestamptz;
  return coalesce(
    v_baseline >= v_first.started_at and v_baseline <= v_at
      and v_at <= v_first.started_at + (
        (v_device.capabilities->'nozzles'->'1'->>'max_actuation_ms')::integer
        + v_seq.maximum_settling_ms) * interval '1 millisecond',
    false);
exception when others then
  return false;
end;
$$;
revoke all on function private.art98_valid_continuation(uuid, uuid, jsonb, text, integer) from public, anon, authenticated;
grant execute on function private.art98_valid_continuation(uuid, uuid, jsonb, text, integer) to service_role;

-- Patch the current effective functions in place. Every replaced fragment must
-- occur exactly once, so a drifted definition aborts the migration.
create function pg_temp.art98_patch(p_function regprocedure, p_pairs text[])
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
      raise exception 'ART-98 patch % does not match % exactly once', (i + 1) / 2, p_function;
    end if;
    v_source := replace(v_source, p_pairs[i], p_pairs[i + 1]);
    v_definition := replace(v_definition, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_definition;
end
$$;

-- Simulator provisioning issues the revision 5 profile.
select pg_temp.art98_patch('public.art38_provision_simulated_device(uuid,text,boolean)'::regprocedure, array[
$o$    "max_schedules": 8,
$o$, $n$    "max_schedules": 8,
    "scheduled_both": true,
$n$,
$o$    "max_clock_uncertainty_ms": null,$o$, $n$    "max_clock_uncertainty_ms": 1000,$n$,
$o$    "maximum_settling_ms": null,$o$, $n$    "maximum_settling_ms": 1000,$n$,
$o$'sim-2.0.0', 2, true, 4, v_capabilities)$o$, $n$'sim-2.0.0', 2, true, 5, v_capabilities)$n$,
$o$    capabilities_revision = 4,$o$, $n$    capabilities_revision = 5,$n$
]);

-- Nozzle 2 may act after nozzle 1 completed, or failed with a proven continuation
-- (valid settled weighing and a recorded baseline). Partial keeps exactly one completed nozzle.
select pg_temp.art98_patch('private.assert_sequence_integrity()'::regprocedure, array[
$o$      where device_id = did and sequence_id = sid and step_index = 1 and status = 'completed') then
      raise exception using errcode = '23514', message = 'nozzle 2 cannot start before nozzle 1 completes';$o$,
$n$      where device_id = did and sequence_id = sid and step_index = 1
        and (status = 'completed' or (status = 'failed' and measurement_quality = 'valid'
          and baseline_ready_at is not null))) then
      raise exception using errcode = '23514', message = 'nozzle 2 cannot start before nozzle 1 completes or continues';$n$,
$o$      and first.nozzle_number = 1 and first.status = 'completed'
      and second.step_index = 2 and second.nozzle_number = 2
      and second.status in ('failed', 'unknown', 'not_started')
  ) then
    raise exception using errcode = '23514', message = 'partial sequence requires nozzle 1 complete and nozzle 2 stopped';$o$,
$n$      and first.nozzle_number = 1 and second.step_index = 2 and second.nozzle_number = 2
      and ((first.status = 'completed' and second.status in ('failed', 'unknown', 'not_started'))
        or (first.status = 'failed' and second.status = 'completed'))
  ) then
    raise exception using errcode = '23514', message = 'partial sequence requires exactly one completed nozzle';$n$
]);

-- Each schedule target becomes its own row and slots under one schedule identity.
select pg_temp.art98_patch('public.art33_write_configuration(uuid,uuid,uuid,bigint,jsonb)'::regprocedure, array[
$o$    insert into public.device_config_schedules(device_id,revision,schedule_id,nozzle_number,requested_dose,timezone,enabled)
      values(p_device_id,v_revision,v_id,(v_schedule->>'nozzle_number')::smallint,v_schedule->'dose',p_snapshot->>'timezone',(v_schedule->>'enabled')::boolean);
    for v_day in select value from jsonb_array_elements(v_schedule->'weekdays') loop
      insert into public.device_config_schedule_slots(device_id,revision,schedule_id,nozzle_number,iso_weekday,local_time)
        values(p_device_id,v_revision,v_id,(v_schedule->>'nozzle_number')::smallint,(v_day::text)::smallint,(v_schedule->>'local_time')::time);
    end loop;$o$,
$n$    insert into public.device_config_schedules(device_id,revision,schedule_id,nozzle_number,requested_dose,timezone,enabled)
      select p_device_id,v_revision,v_id,(t.value->>'nozzle_number')::smallint,t.value->'dose',p_snapshot->>'timezone',(v_schedule->>'enabled')::boolean
      from jsonb_array_elements(v_schedule->'targets') as t(value);
    insert into public.device_config_schedule_slots(device_id,revision,schedule_id,nozzle_number,iso_weekday,local_time)
      select p_device_id,v_revision,v_id,(t.value->>'nozzle_number')::smallint,(d.value::text)::smallint,(v_schedule->>'local_time')::time
      from jsonb_array_elements(v_schedule->'targets') as t(value)
      cross join jsonb_array_elements(v_schedule->'weekdays') as d(value);$n$
]);

select pg_temp.art98_patch('public.art33_next_applied_occurrence(uuid,uuid)'::regprocedure, array[
$o$      (s.value->>'nozzle_number')::integer as nozzle_number, s.value->>'schedule_id' as schedule_id, s.value->'dose' as dose,$o$,
$n$      (t.value->>'nozzle_number')::integer as nozzle_number, s.value->>'schedule_id' as schedule_id, t.value->'dose' as dose,$n$,
$o$    cross join lateral jsonb_array_elements(v_snapshot->'schedules') as s(value)
$o$, $n$    cross join lateral jsonb_array_elements(v_snapshot->'schedules') as s(value)
    cross join lateral jsonb_array_elements(s.value->'targets') as t(value)
$n$
]);

-- Manual sequences: verify continuation proof, keep the reservation and arm nozzle 2
-- from the proven baseline, and aggregate Failed + Completed as partial.
select pg_temp.art98_patch('public.art31_sync_manual_feed(uuid,text,integer,jsonb,text,uuid,text,integer)'::regprocedure, array[
$o$  v_command jsonb := null;
begin$o$, $n$  v_command jsonb := null;
  v_evidence jsonb;
begin$n$,
$o$      raise exception using errcode = '22023', message = 'event time quality is invalid';
    end if;
$o$, $n$      raise exception using errcode = '22023', message = 'event time quality is invalid';
    end if;
    v_evidence := nullif(v_event->'continuation_evidence', 'null'::jsonb);
    if v_evidence is not null and not private.art98_valid_continuation(
         p_device_id, v_sequence.sequence_id, v_event, p_clock_quality, p_clock_uncertainty_ms) then
      raise exception using errcode = '22023', message = 'continuation evidence is invalid';
    end if;
$n$,
$o$      if not found or v_first.status <> 'completed'
         or v_first.measurement_quality <> 'valid'$o$,
$n$      if not found or v_first.status not in ('completed', 'failed')
         or v_first.measurement_quality <> 'valid'$n$,
$o$           and e.step_index = 1 and e.event_type = 'completed'
           and e.payload->>'outcome_status' = 'completed'
           and e.payload->>'measurement_quality' = 'valid'$o$,
$n$           and e.step_index = 1 and e.event_type in ('completed', 'failed')
           and e.payload->>'outcome_status' = e.event_type
           and e.payload->>'measurement_quality' = 'valid'
           and (e.event_type = 'completed' or jsonb_typeof(e.payload->'continuation_evidence') = 'object')$n$,
$o$      if v_first.status = 'completed' then
        v_step_status := 'not_started';$o$,
$n$      if v_first.status = 'completed' or v_first.baseline_ready_at is not null then
        v_step_status := 'not_started';$n$,
$o$        then v_event_at else baseline_ready_at end$o$,
$n$        then v_event_at
        when v_step_index = 1 and v_step_status = 'failed' and v_evidence is not null
        then (v_evidence->>'baseline_ready_at')::timestamptz else baseline_ready_at end$n$,
$o$    if v_step_index = 1 and v_step_status in ('failed', 'rejected', 'expired', 'unknown')
       and v_sequence.target_count = 2 then$o$,
$n$    if v_step_index = 1 and v_step_status in ('failed', 'rejected', 'expired', 'unknown')
       and v_sequence.target_count = 2
       and not (v_step_status = 'failed' and v_evidence is not null) then$n$,
$o$    if v_step_index = 1 and v_step_status = 'completed' and v_sequence.target_count = 2 then
      select * into v_first$o$,
$n$    if v_step_index = 1 and v_sequence.target_count = 2
       and (v_step_status = 'completed' or v_step_status = 'failed' and v_evidence is not null) then
      select * into v_first$n$,
$o$    elsif v_step_index = 1 and v_step_status = 'completed' and v_sequence.target_count = 2 then
      update public.feed_sequences set status = 'running', status_sequence = status_sequence + 1$o$,
$n$    elsif v_step_status = 'completed' and v_step_index = 2 then
      -- Nozzle 1 failed with a proven continuation: one completed nozzle is partial.
      v_sequence_status := 'partial';
      update public.feed_sequences set status = 'partial', unresolved = false,
        status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_execution_reservations set phase = 'released',
        released_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and phase in ('active', 'settling');
    elsif v_step_index = 1 and v_sequence.target_count = 2
       and (v_step_status = 'completed' or v_step_status = 'failed' and v_evidence is not null) then
      update public.feed_sequences set status = 'running', status_sequence = status_sequence + 1$n$,
$o$      if v_step_index = 2 then v_sequence_status := 'partial';$o$,
$n$      if v_step_index = 2 and exists (select 1 from public.feed_steps f where f.device_id = p_device_id
          and f.sequence_id = v_sequence.sequence_id and f.status = 'completed') then
        v_sequence_status := 'partial';
      elsif v_step_index = 2 then v_sequence_status := 'failed';$n$,
$o$      elsif v_sequence.target_count = 2 and v_first.status = 'completed' then v_sequence_status := 'partial';$o$,
$n$      elsif v_sequence.target_count = 2 and v_first.status = 'completed' then v_sequence_status := 'partial';
      elsif v_sequence.target_count = 2 and v_first.status = 'failed' then v_sequence_status := 'failed';$n$
]);

-- Scheduled sequences: one occurrence per logical schedule, the same continuation
-- gate, and outcomes derived from every selected step.
select pg_temp.art98_patch('public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid)'::regprocedure, array[
$o$  v_credential_device_id uuid;
begin$o$, $n$  v_credential_device_id uuid;
  v_evidence jsonb;
  v_baseline timestamptz;
  v_done integer;
  v_total integer;
  v_failed integer;
begin$n$,
$o$'lockout_cleared','nozzle_number','step_index']::text[] <> '{}'::jsonb$o$,
$n$'lockout_cleared','nozzle_number','step_index','continuation_evidence']::text[] <> '{}'::jsonb$n$,
$o$c
      on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
$o$, $n$c
      on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
        and c.nozzle_number=s.nozzle_number
$n$,
$o$c
        on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
$o$, $n$c
        on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
          and c.nozzle_number=s.nozzle_number
$n$,
$o$        select p_device_id,(value->>'schedule_id')::uuid,v_date,v_sequence,'admitted'$o$,
$n$        select distinct p_device_id,(value->>'schedule_id')::uuid,v_date,v_sequence,'admitted'$n$,
$o$    if not found or v_step.nozzle_number<>v_nozzle or v_step.requested_dose<>v_event->'requested_dose' then
      raise exception 'invalid scheduled event batch';
    end if;
$o$, $n$    if not found or v_step.nozzle_number<>v_nozzle or v_step.requested_dose<>v_event->'requested_dose' then
      raise exception 'invalid scheduled event batch';
    end if;
    v_evidence := nullif(v_event->'continuation_evidence','null'::jsonb);
    if v_evidence is not null and not private.art98_valid_continuation(
         p_device_id,v_sequence,v_event,p_clock_quality,p_clock_uncertainty_ms) then
      raise exception 'invalid scheduled event batch';
    end if;
$n$,
$o$      and v_status='not_started' and v_step.status='not_started'$o$,
$n$      and v_status in ('not_started','skipped') and v_step.status='not_started'$n$,
$o$      if v_first.status<>'completed' or v_first.measurement_quality<>'valid' or v_first.baseline_ready_at is null then$o$,
$n$      if v_first.status not in ('completed','failed') or v_first.measurement_quality<>'valid' or v_first.baseline_ready_at is null then$n$,
$o$      baseline_ready_at=case when v_step_index=1 and v_status='completed' and v_quality='valid' and v_event_at is not null then v_event_at else baseline_ready_at end$o$,
$n$      baseline_ready_at=case when v_step_index=1 and v_status='completed' and v_quality='valid' and v_event_at is not null then v_event_at
        when v_step_index=1 and v_status='failed' and v_evidence is not null then (v_evidence->>'baseline_ready_at')::timestamptz
        else baseline_ready_at end$n$,
$o$    if v_step_index=1 and v_status='completed' and v_quality='valid' and v_seq.target_count=2 then
      update public.feed_steps set baseline_ready_at=v_event_at,
        start_before=v_event_at+(v_seq.scheduler_wake_grace_ms*interval '1 millisecond')
        where device_id=p_device_id and sequence_id=v_sequence and step_index=2;
      update public.device_execution_reservations set phase='settling' where device_id=p_device_id and sequence_id=v_sequence;
    end if;
    if v_status='unknown' then
      update public.feed_sequences set status=case when v_step_index=2 then 'partial' else 'unknown' end,
        safety_lockout=true,unresolved=true,status_sequence=status_sequence+1
        where device_id=p_device_id and sequence_id=v_sequence;
      update public.device_state set safety_lockout=true,lockout_sequence_id=v_sequence,updated_at=pg_catalog.clock_timestamp()
        where device_id=p_device_id;
      update public.device_execution_reservations set phase='settling',released_at=null where device_id=p_device_id and sequence_id=v_sequence;
    elsif v_status='skipped' or v_status in ('failed','rejected','expired','not_started') and v_seq.target_count=1
       or v_step_index=1 and v_status in ('failed','rejected','expired','not_started')
       or v_step_index=2 and v_status in ('failed','rejected','expired','not_started') then
      if v_step_index=1 and v_seq.target_count=2 then
        update public.feed_steps set status='not_started',measurement_quality='unavailable',
          measured_dispensed_g=null,estimated_dispensed_g=null,stopped_at=coalesce(v_event_at,stopped_at)
          where device_id=p_device_id and sequence_id=v_sequence and step_index=2 and status='queued';
      end if;
      update public.feed_sequences set status=case when v_status='skipped' then 'rejected' when v_status='expired' then 'expired'
        when v_status='not_started' and v_step_index=2 then 'partial' when v_step_index=2 then 'partial' else 'failed' end,
        unresolved=false,status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
      update public.device_execution_reservations set phase='released',released_at=pg_catalog.clock_timestamp()
        where device_id=p_device_id and sequence_id=v_sequence and phase<>'released';
    elsif v_status='completed' and (v_step_index=v_seq.target_count or v_seq.target_count=1) then
      update public.feed_sequences set status='completed',unresolved=false,status_sequence=status_sequence+1
        where device_id=p_device_id and sequence_id=v_sequence;
      update public.device_execution_reservations set phase='released',released_at=pg_catalog.clock_timestamp()
        where device_id=p_device_id and sequence_id=v_sequence and phase<>'released';
    elsif v_status='completed' and v_step_index=1 then
      update public.feed_sequences set status='running',status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
    elsif v_status='running' then
      update public.feed_sequences set status='running',status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
    end if;
    update public.scheduled_occurrences set outcome=case
      when v_status='skipped' or v_status='not_started' and v_step_index=1 then 'skipped'
      when v_status='unknown' then 'unknown'
      when v_status='failed' and v_step_index=1 then 'failed'
      when v_status in ('failed','rejected','expired','not_started') then 'partial'
      when v_status='completed' then 'completed' else outcome end
      where device_id=p_device_id and sequence_id=v_sequence;$o$,
$n$    if v_step_index=1 and v_seq.target_count=2
       and (v_status='completed' and v_quality='valid' or v_status='failed' and v_evidence is not null) then
      -- Arm nozzle 2 from the settled baseline; the reservation stays held.
      v_baseline := case when v_status='failed' then (v_evidence->>'baseline_ready_at')::timestamptz else v_event_at end;
      update public.feed_steps set baseline_ready_at=v_baseline,
        start_before=v_baseline+(v_seq.scheduler_wake_grace_ms*interval '1 millisecond')
        where device_id=p_device_id and sequence_id=v_sequence and step_index=2;
      update public.device_execution_reservations set phase='settling' where device_id=p_device_id and sequence_id=v_sequence;
      update public.feed_sequences set status='running',status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
    elsif v_status='unknown' then
      update public.feed_sequences set status=case when exists(select 1 from public.feed_steps f
          where f.device_id=p_device_id and f.sequence_id=v_sequence and f.status='completed') then 'partial' else 'unknown' end,
        safety_lockout=true,unresolved=true,status_sequence=status_sequence+1
        where device_id=p_device_id and sequence_id=v_sequence;
      update public.device_state set safety_lockout=true,lockout_sequence_id=v_sequence,updated_at=pg_catalog.clock_timestamp()
        where device_id=p_device_id;
      update public.device_execution_reservations set phase='settling',released_at=null where device_id=p_device_id and sequence_id=v_sequence;
      update public.scheduled_occurrences set outcome='unknown' where device_id=p_device_id and sequence_id=v_sequence;
    elsif v_status='running' or v_status='completed' and v_step_index<v_seq.target_count then
      update public.feed_sequences set status='running',status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
    elsif v_status<>'accepted' then
      -- A terminal step outcome without a proven continuation finishes the sequence;
      -- the sequence and occurrence outcomes come from every selected step.
      update public.feed_steps set status='not_started',measurement_quality='unavailable',
        measured_dispensed_g=null,estimated_dispensed_g=null,stopped_at=coalesce(v_event_at,stopped_at)
        where device_id=p_device_id and sequence_id=v_sequence and step_index>v_step_index and status in ('queued','accepted');
      select count(*) filter (where f.status='completed'),count(*),count(*) filter (where f.status='failed')
        into v_done,v_total,v_failed
        from public.feed_steps f where f.device_id=p_device_id and f.sequence_id=v_sequence;
      update public.feed_sequences set status=case when v_done=v_total then 'completed' when v_done=1 then 'partial'
          when v_status='skipped' then 'rejected' when v_status='expired' and v_step_index=1 then 'expired' else 'failed' end,
        unresolved=false,status_sequence=status_sequence+1 where device_id=p_device_id and sequence_id=v_sequence;
      update public.device_execution_reservations set phase='released',released_at=pg_catalog.clock_timestamp()
        where device_id=p_device_id and sequence_id=v_sequence and phase<>'released';
      update public.scheduled_occurrences set outcome=case when v_done=v_total then 'completed' when v_done=1 then 'partial'
          when v_failed>0 then 'failed' else 'skipped' end
        where device_id=p_device_id and sequence_id=v_sequence;
    end if;$n$
]);

drop function pg_temp.art98_patch(regprocedure, text[]);

revoke all on function public.art38_provision_simulated_device(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.art38_provision_simulated_device(uuid, text, boolean) to service_role;
revoke all on function private.assert_sequence_integrity() from public, anon, authenticated;
grant execute on function private.assert_sequence_integrity() to service_role;
revoke all on function public.art33_write_configuration(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.art33_write_configuration(uuid, uuid, uuid, bigint, jsonb) to service_role;
revoke all on function public.art33_next_applied_occurrence(uuid, uuid) from public, anon, authenticated;
grant execute on function public.art33_next_applied_occurrence(uuid, uuid) to service_role;
revoke all on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) to service_role;
revoke all on function public.art33_record_scheduled_events(uuid, text, jsonb, text, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.art33_record_scheduled_events(uuid, text, jsonb, text, integer, text, uuid) to service_role;
