-- ART-97: Keep shared hopper capacity distinct from each nozzle's supported dose.
-- Only the three existing synthetic fixture devices are upgraded here.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.devices d where d.device_id in (
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid
  );
  if v_count<>3 then raise exception 'ART-97 synthetic device profile fixtures are missing'; end if;
  if exists (
    select 1 from public.devices d where d.device_id in (
      '11111111-1111-4111-8111-111111111111'::uuid,
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    ) and not (
      d.is_simulated and d.protocol_major=2 and d.capabilities_revision in (1,2)
      and d.capabilities->'nozzles'->'1'->>'min_dose_g'='5'
      and d.capabilities->'nozzles'->'1'->>'max_dose_g'='100'
      and d.capabilities->'nozzles'->'1'->>'dose_step_g'='1'
      and d.capabilities->'nozzles'->'2'->>'min_dose_g'='5'
      and d.capabilities->'nozzles'->'2'->>'max_dose_g'='100'
      and d.capabilities->'nozzles'->'2'->>'dose_step_g'='1'
      and not (d.capabilities ? 'feed_capacity_g')
    )
  ) then raise exception 'ART-97 synthetic device profiles differ from the reviewed 5-100 g fixtures'; end if;
  update public.devices d set
    capabilities_revision=3,
    capabilities=jsonb_set(
      jsonb_set(d.capabilities,'{feed_capacity_g}','20000'::jsonb),
      '{maximum_settling_ms}',coalesce(d.capabilities->'maximum_settling_ms','null'::jsonb)
    )
    where d.device_id in (
      '11111111-1111-4111-8111-111111111111'::uuid,
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    );
end $$;

-- Preserve incoming inventory fields separately from their current-profile
-- interpretation so exact retries remain immutable after normalization.
alter table public.device_telemetry
  add column if not exists input_feed_remaining_g numeric,
  add column if not exists input_feed_percent numeric,
  add column if not exists input_feed_quality text,
  add column if not exists input_calibration_revision integer;
update public.device_telemetry set
  input_feed_remaining_g=coalesce(input_feed_remaining_g,feed_remaining_g),
  input_feed_percent=coalesce(input_feed_percent,feed_percent),
  input_feed_quality=coalesce(input_feed_quality,feed_quality),
  input_calibration_revision=coalesce(input_calibration_revision,calibration_revision);


-- Update the simulator-only provisioning path to the shared 20 kg profile.
create or replace function public.art38_provision_simulated_device(
  p_device_id uuid,
  p_credential_verifier_hex text,
  p_allow_rotation boolean default false
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_capabilities jsonb := '{
    "do_monitoring": true,
    "feed_remaining_monitoring": true,
    "feed_capacity_g": 20000,
    "max_schedules": 8,
    "local_schedule_execution": true,
    "max_clock_uncertainty_ms": null,
    "scheduler_wake_grace_ms": 30000,
    "maximum_settling_ms": null,
    "nozzles": {
      "1": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 100, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null},
      "2": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 100, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null}
    }
  }'::jsonb;
  v_existing_verifier bytea;
  v_existing_revoked_at timestamptz;
  v_credential_exists boolean := false;
begin
  if p_device_id is null or p_device_id not in (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    ) then
    return jsonb_build_object('status', 'fixture_device_id_required');
  end if;
  if p_credential_verifier_hex is null or p_credential_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_device_id::text, 0)
  );
  -- Lock credentials before touching device or membership rows, matching the
  -- pairing paths. The per-device lock also serializes first provisioning,
  -- where no credential row exists yet. A same-credential retry is a no-op.
  select c.credential_verifier, c.revoked_at
    into v_existing_verifier, v_existing_revoked_at
    from private.device_credentials c
    where c.device_id = p_device_id
    for update;
  v_credential_exists := found;
  if exists (
    select 1 from public.devices d where d.device_id = p_device_id and not d.is_simulated
  ) then
    return jsonb_build_object('status', 'not_simulated');
  end if;
  if v_credential_exists
    and v_existing_revoked_at is null
    and v_existing_verifier = decode(lower(p_credential_verifier_hex), 'hex')
    and exists (select 1 from public.devices d where d.device_id = p_device_id and d.is_simulated) then
    return jsonb_build_object('status', 'already_provisioned', 'device_id', p_device_id, 'simulated', true);
  end if;
  if v_credential_exists and p_allow_rotation is not true then
    return jsonb_build_object('status', 'credential_conflict');
  end if;
  if not v_credential_exists and exists (
    select 1 from public.devices d where d.device_id = p_device_id
  ) then
    return jsonb_build_object('status', 'credential_conflict');
  end if;

  insert into public.devices
    (device_id, model, firmware_version, protocol_major, is_simulated,
     capabilities_revision, capabilities)
  values (p_device_id, 'AquaFeed controlled simulator', 'sim-2.0.0', 2, true, 3, v_capabilities)
  on conflict (device_id) do update set
    model = excluded.model,
    firmware_version = excluded.firmware_version,
    protocol_major = 2,
    is_simulated = true,
    capabilities_revision = 3,
    capabilities = v_capabilities;

  insert into public.device_state
    (device_id, contact_freshness, sample_freshness, sample_quality, safety_lockout)
  values (p_device_id, 'unknown', 'unknown', 'unavailable', false)
  on conflict (device_id) do nothing;

  insert into private.device_credentials (device_id, credential_verifier, created_at, revoked_at)
  values (p_device_id, decode(lower(p_credential_verifier_hex), 'hex'), now(), null)
  on conflict (device_id) do update set
    credential_verifier = excluded.credential_verifier,
    created_at = now(), revoked_at = null;
  update public.device_access
    set status = 'revoked', revoked_at = now()
    where device_id = p_device_id and status = 'active';
  update private.pairing_challenges
    set consumed_at = coalesce(consumed_at, now())
    where device_id = p_device_id and consumed_at is null;
  return jsonb_build_object('status', 'provisioned', 'device_id', p_device_id, 'simulated', true);
end;
$$;

-- Validate telemetry against capacity when a profile declares one; retain invalid readings as error quality.
create or replace function public.art27_sync_telemetry(
  p_device_id uuid,
  p_device_verifier_hex text,
  p_boot_id uuid,
  p_live_sequence bigint,
  p_latest_sample jsonb,
  p_backlog_samples jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_sample jsonb;
  v_device public.devices%rowtype;
  v_capacity numeric;
  v_latest_sample jsonb := coalesce(p_latest_sample, 'null'::jsonb);
  v_boot uuid;
  v_sequence bigint;
  v_measured_at timestamptz;
  v_time_quality text;
  v_do numeric;
  v_do_quality text;
  v_remaining numeric;
  v_percent numeric;
  v_feed_quality text;
  v_calibration integer;
  v_input_remaining numeric;
  v_input_percent numeric;
  v_input_feed_quality text;
  v_input_calibration integer;
  v_existing public.device_telemetry%rowtype;
  v_ack jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_identity text;
  v_rows jsonb;
  v_state public.device_state%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_is_live boolean;
  v_existing_identity boolean;
  v_quality text;
  v_freshness text;
begin
  if p_device_id is null or p_device_verifier_hex is null
     or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status','auth_required');
  end if;
  perform 1 from private.device_credentials c
    where c.device_id = p_device_id
      and c.credential_verifier = pg_catalog.decode(pg_catalog.lower(p_device_verifier_hex),'hex')
      and c.revoked_at is null for share;
  if not found then return jsonb_build_object('status','auth_required'); end if;
  if p_boot_id is null or p_live_sequence is null or p_live_sequence < 0
     or jsonb_typeof(v_latest_sample) not in ('object','null')
     or p_backlog_samples is null or jsonb_typeof(p_backlog_samples) <> 'array'
     or jsonb_array_length(p_backlog_samples) >
       (case when v_latest_sample = 'null'::jsonb then 100 else 99 end)
     or jsonb_array_length(p_backlog_samples) +
       (case when v_latest_sample = 'null'::jsonb then 0 else 1 end) > 100 then
    raise exception using errcode='22023', message='invalid telemetry batch';
  end if;
  select * into strict v_state from public.device_state s where s.device_id=p_device_id for update;
  select d.* into v_device from public.devices d where d.device_id=p_device_id and d.protocol_major=2 for update;
  if not found then raise exception using errcode='22023', message='unknown device'; end if;

  v_rows := p_backlog_samples;
  if v_latest_sample <> 'null'::jsonb then
    v_rows := v_rows || jsonb_build_array(v_latest_sample || jsonb_build_object('boot_id',p_boot_id,'live_sequence',p_live_sequence));
  end if;
  for v_sample in select value from jsonb_array_elements(v_rows) loop
    if jsonb_typeof(v_sample) <> 'object'
       or not (v_sample ?& array['boot_id','sequence','measured_at','time_quality','do_mg_l','do_quality','feed_remaining_g','feed_percent','feed_quality','calibration_revision'])
       or (v_sample - array['boot_id','sequence','live_sequence','measured_at','time_quality','do_mg_l','do_quality','feed_remaining_g','feed_percent','feed_quality','calibration_revision']::text[]) <> '{}'::jsonb then
      raise exception using errcode='22023', message='invalid telemetry sample keys';
    end if;
    v_boot := (v_sample->>'boot_id')::uuid;
    v_sequence := (v_sample->>'sequence')::bigint;
    v_identity := v_boot::text || ':' || v_sequence::text;
    if v_sequence < 0 or v_identity = any(v_seen) then
      raise exception using errcode='22023', message='duplicate or invalid telemetry identity';
    end if;
    v_seen := array_append(v_seen,v_identity);
    v_is_live := v_latest_sample <> 'null'::jsonb
      and v_boot=p_boot_id and v_sequence=p_live_sequence;
    if v_is_live and v_sample->>'live_sequence' is distinct from p_live_sequence::text then
      raise exception using errcode='22023', message='live sequence mismatch';
    end if;
    if not v_is_live and v_sample ? 'live_sequence' then
      raise exception using errcode='22023', message='historical sample cannot be live';
    end if;
    v_time_quality := v_sample->>'time_quality';
    if v_time_quality not in ('synced','rtc','uncertain','invalid')
       or (v_time_quality='invalid' and v_sample->'measured_at' <> 'null'::jsonb)
       or (v_time_quality<>'invalid' and jsonb_typeof(v_sample->'measured_at') <> 'string') then
      raise exception using errcode='22023', message='invalid telemetry time quality';
    end if;
    v_measured_at := case when v_sample->'measured_at' = 'null'::jsonb then null else (v_sample->>'measured_at')::timestamptz end;
    v_do_quality := v_sample->>'do_quality';
    v_feed_quality := v_sample->>'feed_quality';
    v_do := case when v_sample->'do_mg_l'='null'::jsonb then null else (v_sample->>'do_mg_l')::numeric end;
    v_remaining := case when v_sample->'feed_remaining_g'='null'::jsonb then null else (v_sample->>'feed_remaining_g')::numeric end;
    v_percent := case when v_sample->'feed_percent'='null'::jsonb then null else (v_sample->>'feed_percent')::numeric end;
    v_calibration := case when v_sample->'calibration_revision'='null'::jsonb then null else (v_sample->>'calibration_revision')::integer end;
    v_input_remaining := v_remaining;
    v_input_percent := v_percent;
    v_input_feed_quality := v_feed_quality;
    v_input_calibration := v_calibration;
    if v_do_quality not in ('valid','unavailable','uncalibrated','error')
       or v_feed_quality not in ('valid','unavailable','uncalibrated','error')
       or (v_do_quality='valid') <> (v_do is not null)
       or (v_feed_quality='valid') <> (v_remaining is not null and v_percent is not null and v_calibration is not null and v_calibration>0)
       or (v_feed_quality<>'valid' and (v_remaining is not null or v_percent is not null or v_calibration is not null))
       or v_do < 0 or v_remaining < 0 or v_percent not between 0 and 100 then
      raise exception using errcode='22023', message='invalid telemetry values';
    end if;
    select * into v_existing from public.device_telemetry t
      where t.device_id=p_device_id and t.boot_id=v_boot and t.sample_sequence=v_sequence;
    v_existing_identity := found;
    if v_existing_identity then
      if v_existing.measured_at is distinct from v_measured_at
         or v_existing.time_quality is distinct from v_time_quality
         or v_existing.do_mg_l is distinct from v_do
         or v_existing.do_quality is distinct from v_do_quality
         or v_existing.input_feed_remaining_g is distinct from v_input_remaining
         or v_existing.input_feed_percent is distinct from v_input_percent
         or v_existing.input_feed_quality is distinct from v_input_feed_quality
         or v_existing.input_calibration_revision is distinct from v_input_calibration then
        raise exception using errcode='23505', message='immutable telemetry identity conflict';
      end if;
    else
      -- Interpret new readings against the current profile. Existing identities
      -- retain their original immutable values across capability upgrades.
      if v_device.capabilities ? 'feed_capacity_g'
         and v_device.capabilities->'feed_capacity_g'<>'null'::jsonb then
        if jsonb_typeof(v_device.capabilities->'feed_capacity_g')<>'number' then
          raise exception using errcode='22023', message='invalid device feed capacity';
        end if;
        v_capacity := (v_device.capabilities->>'feed_capacity_g')::numeric;
        if v_capacity<=0 then raise exception using errcode='22023', message='invalid device feed capacity'; end if;
        if v_feed_quality='valid' and v_remaining is not null and v_percent is not null
           and (v_remaining>v_capacity or abs(v_percent-round(v_remaining*100/v_capacity,2))>0.05) then
          v_feed_quality:='error';
          v_remaining:=null;
          v_percent:=null;
          v_calibration:=null;
        end if;
      end if;
      insert into public.device_telemetry(device_id,boot_id,sample_sequence,measured_at,time_quality,
        do_mg_l,do_quality,feed_remaining_g,feed_percent,feed_quality,calibration_revision,
        input_feed_remaining_g,input_feed_percent,input_feed_quality,input_calibration_revision,received_at)
      values(p_device_id,v_boot,v_sequence,v_measured_at,v_time_quality,v_do,v_do_quality,
        v_remaining,v_percent,v_feed_quality,v_calibration,
        v_input_remaining,v_input_percent,v_input_feed_quality,v_input_calibration,v_now);
    end if;
    v_ack := v_ack || jsonb_build_array(jsonb_build_object('boot_id',v_boot,'sequence',v_sequence));
    if v_is_live and p_live_sequence > v_state.live_sequence and not v_existing_identity then
      v_quality := case when v_do_quality='valid' or v_feed_quality='valid' then 'valid'
        when v_do_quality='error' or v_feed_quality='error' then 'error'
        when v_do_quality='uncalibrated' or v_feed_quality='uncalibrated' then 'uncalibrated' else 'unavailable' end;
      v_freshness := case when v_measured_at is not null and v_time_quality in ('synced','rtc')
        and v_measured_at <= v_now and v_measured_at >= v_now - interval '30 seconds'
        and v_quality='valid' then 'fresh' else 'stale' end;
      update public.device_state set
        live_sequence=p_live_sequence,
        latest_telemetry_boot_id=v_boot,
        latest_telemetry_sequence=v_sequence,
        last_sample_at=case when v_time_quality in ('synced','rtc') then v_measured_at else null end,
        sample_freshness=case when v_time_quality in ('synced','rtc') and v_measured_at is not null then v_freshness else 'unknown' end,
        sample_quality=v_quality,
        updated_at=v_now
        where device_id=p_device_id;
      v_state.live_sequence := p_live_sequence;
    end if;
  end loop;
  update public.device_state set last_authenticated_contact_at=v_now,
    contact_freshness='fresh', updated_at=v_now where device_id=p_device_id;
  if p_live_sequence > v_state.live_sequence then
    update public.device_state set live_sequence=p_live_sequence,updated_at=v_now where device_id=p_device_id;
  end if;
  return jsonb_build_object('status','ok','server_time',v_now,'acknowledged_samples',v_ack);
end;
$$;

-- Failed scheduled results may retain an actual valid measurement for inventory accounting.
create or replace function public.art33_record_scheduled_events(
  p_device_id uuid, p_device_verifier_hex text, p_events jsonb,
  p_clock_quality text, p_clock_uncertainty_ms integer,
  p_actuator_state text, p_active_sequence_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_event jsonb;
  v_saved public.device_events%rowtype;
  v_seq public.feed_sequences%rowtype;
  v_schedule uuid;
  v_sequence uuid;
  v_date date;
  v_revision bigint;
  v_time time;
  v_timezone text;
  v_due timestamptz;
  v_start_before timestamptz;
  v_first public.feed_steps%rowtype;
  v_step public.feed_steps%rowtype;
  v_count integer;
  v_previous bigint;
  v_step_index smallint;
  v_nozzle smallint;
  v_event_at timestamptz;
  v_status text;
  v_quality text;
  v_measured numeric;
  v_targets jsonb;
  v_ack jsonb := '[]'::jsonb;
  v_unsafe boolean;
  v_late_terminal boolean;
  v_already_terminal boolean;
  v_dst_gap_remainder boolean;
  v_roundtrip_valid boolean;
  v_has_reservation boolean;
  v_max_operation_ms integer;
  v_credential_device_id uuid;
begin
  if p_device_verifier_hex is null or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status','auth_required');
  end if;
  select c.device_id into v_credential_device_id from private.device_credentials c
    where c.device_id=p_device_id and c.credential_verifier=pg_catalog.decode(pg_catalog.lower(p_device_verifier_hex),'hex')
      and c.revoked_at is null for share;
  if not found then return jsonb_build_object('status','auth_required'); end if;
  select d.* into v_device from public.devices d where d.device_id=p_device_id for update;
  if not found or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>100
     or p_clock_quality is null or p_clock_quality not in ('synced','rtc','uncertain','invalid')
     or p_actuator_state is null or p_actuator_state not in ('idle','feeding','fault','unknown')
     or p_clock_quality='invalid' and p_clock_uncertainty_ms is not null
     or p_clock_quality<>'invalid' and (p_clock_uncertainty_ms is null or p_clock_uncertainty_ms<0) then
    raise exception 'invalid scheduled event batch';
  end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if v_event - array['sequence_id','event_sequence','event_type','outcome_status','source','device_at','time_quality','command_id','schedule_id','configuration_revision','occurrence_local_date','requested_dose','estimated_dispensed_g','measured_dispensed_g','measurement_quality','reason_code','maintenance_resolution','lockout_cleared','nozzle_number','step_index']::text[] <> '{}'::jsonb
      or not (v_event ?& array['sequence_id','event_sequence','event_type','outcome_status','source','device_at','time_quality','command_id','schedule_id','configuration_revision','occurrence_local_date','requested_dose','estimated_dispensed_g','measured_dispensed_g','measurement_quality','reason_code','maintenance_resolution','lockout_cleared','nozzle_number','step_index'])
      or coalesce(v_event->>'source','')<>'scheduled' or v_event->'command_id'<>'null'::jsonb
      or coalesce(v_event->>'event_type','') not in ('accepted','running','completed','failed','rejected','expired','unknown','skipped','not_started')
      or v_event->>'event_type' is distinct from v_event->>'outcome_status'
      or coalesce(v_event->>'time_quality','') not in ('synced','rtc','uncertain','invalid')
      or coalesce(v_event->>'measurement_quality','') not in ('valid','unavailable','uncalibrated','error')
      or jsonb_typeof(v_event->'schedule_id')<>'string'
      or jsonb_typeof(v_event->'configuration_revision')<>'number'
      or jsonb_typeof(v_event->'occurrence_local_date')<>'string'
      or jsonb_typeof(v_event->'requested_dose')<>'object'
      or v_event->'maintenance_resolution'<>'null'::jsonb or v_event->'lockout_cleared'<>'false'::jsonb
      or (v_event->>'nozzle_number') not in ('1','2') or (v_event->>'step_index') not in ('1','2') then
      raise exception 'invalid scheduled event batch';
    end if;
    v_sequence := (v_event->>'sequence_id')::uuid;
    v_schedule := (v_event->>'schedule_id')::uuid;
    v_date := (v_event->>'occurrence_local_date')::date;
    v_revision := (v_event->>'configuration_revision')::bigint;
    v_step_index := (v_event->>'step_index')::smallint;
    v_nozzle := (v_event->>'nozzle_number')::smallint;
    v_event_at := case when v_event->'device_at'='null'::jsonb then null else (v_event->>'device_at')::timestamptz end;
    if (v_event->>'time_quality'='invalid' and v_event_at is not null)
       or (v_event->>'time_quality'<>'invalid' and v_event_at is null)
       or (v_event->>'measurement_quality'='valid' and (v_event->'measured_dispensed_g'='null'::jsonb or v_event->>'event_type' not in ('completed','failed')))
       or (v_event->>'measurement_quality'<>'valid' and v_event->'measured_dispensed_g'<>'null'::jsonb) then
      raise exception 'invalid scheduled event batch';
    end if;
    select e.* into v_saved from public.device_events e
      where e.device_id=p_device_id and e.sequence_id=v_sequence
        and e.event_sequence=(v_event->>'event_sequence')::bigint;
    if found then
      if v_saved.payload is distinct from v_event then raise exception 'invalid scheduled event batch'; end if;
      v_ack := v_ack || jsonb_build_array(jsonb_build_object('sequence_id',v_sequence,'event_sequence',(v_event->>'event_sequence')::bigint));
      continue;
    end if;
    if not exists (select 1 from public.device_config_revisions r
      where r.device_id=p_device_id and r.revision=v_revision and r.state='applied') then
      raise exception 'invalid scheduled event batch';
    end if;
    select s.local_time,c.timezone into v_time,v_timezone
      from public.device_config_schedule_slots s join public.device_config_schedules c
      on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
      where s.device_id=p_device_id and s.revision=v_revision and s.schedule_id=v_schedule
        and s.iso_weekday=extract(isodow from v_date)::smallint
        and c.enabled and c.nozzle_number=v_nozzle and c.requested_dose=v_event->'requested_dose';
    if not found then raise exception 'invalid scheduled event batch'; end if;
    if v_event_at is not null and (v_event_at at time zone v_timezone)::date<>v_date then
      raise exception 'invalid scheduled event batch';
    end if;
    v_due := (v_date + v_time) at time zone v_timezone;
    v_roundtrip_valid := (v_due at time zone v_timezone) = (v_date + v_time);
    v_dst_gap_remainder := v_event->>'event_type'='not_started' and v_step_index=2
      and v_event->>'reason_code'='SIMULATOR_DST_GAP' and v_event_at is null
      and v_event->>'time_quality'='invalid'
      and exists(select 1 from public.device_events e where e.device_id=p_device_id and e.sequence_id=v_sequence
        and e.step_index=1 and e.payload->>'event_type'='skipped'
        and e.payload->>'reason_code'='SIMULATOR_DST_GAP' and e.payload->>'occurrence_local_date'=v_date::text
        and e.payload->>'configuration_revision'=v_revision::text and e.payload->'device_at'='null'::jsonb);
    if not v_roundtrip_valid and not (
      v_event->>'reason_code'='SIMULATOR_DST_GAP' and v_event_at is null and v_event->>'time_quality'='invalid'
      and (v_event->>'event_type'='skipped' or v_dst_gap_remainder)
    ) then
      raise exception 'invalid scheduled event batch';
    end if;
    if v_roundtrip_valid and v_event->>'reason_code'='SIMULATOR_DST_GAP' then raise exception 'invalid scheduled event batch'; end if;
    if not v_roundtrip_valid then v_due := null; end if;
    if v_event->>'event_type'='accepted' and v_event_at is not null
       and (v_event_at<v_due or v_event_at>v_due+(coalesce((v_device.capabilities->>'scheduler_wake_grace_ms')::integer,0)*interval '1 millisecond')) then
      raise exception 'invalid scheduled event batch';
    end if;
    v_targets := null;
    select jsonb_agg(jsonb_build_object('schedule_id',c.schedule_id,'nozzle_number',c.nozzle_number,
      'dose',c.requested_dose) order by c.nozzle_number,c.schedule_id),count(*)::integer
      into v_targets,v_count
      from public.device_config_schedule_slots s join public.device_config_schedules c
        on c.device_id=s.device_id and c.revision=s.revision and c.schedule_id=s.schedule_id
      where s.device_id=p_device_id and s.revision=v_revision and s.iso_weekday=extract(isodow from v_date)::smallint
        and s.local_time=v_time and c.enabled
        and not exists (select 1 from public.scheduled_occurrences o
          where o.device_id=s.device_id and o.schedule_id=c.schedule_id
            and o.occurrence_local_date=v_date and o.sequence_id<>v_sequence);
    if v_count not between 1 and 2 or v_step_index>v_count or v_count=2 and
       ((v_targets->0->>'nozzle_number')::integer<>1 or (v_targets->1->>'nozzle_number')::integer<>2)
       or v_targets->(v_step_index-1)->>'schedule_id'<>v_schedule::text then
      raise exception 'invalid scheduled event batch';
    end if;

    select * into v_seq from public.feed_sequences s
      where s.device_id=p_device_id and s.sequence_id=v_sequence for update;
    if not found then
      if v_step_index<>1 then raise exception 'invalid scheduled event batch'; end if;
      if v_device.capabilities->>'max_clock_uncertainty_ms' is null
         or v_device.capabilities->>'maximum_settling_ms' is null
         or v_device.capabilities->>'scheduler_wake_grace_ms' is null then
        raise exception 'invalid scheduled event batch';
      end if;
      select exists(select 1 from public.device_execution_reservations r
        where r.device_id=p_device_id and r.phase in ('active','settling')) into v_has_reservation;
      if v_has_reservation and v_event->>'event_type' not in ('skipped','expired','rejected','not_started') then
        raise exception 'scheduled occurrence collided with an active device reservation';
      end if;
      v_start_before := v_due + (v_device.capabilities->>'scheduler_wake_grace_ms')::integer * interval '1 millisecond';
      insert into public.feed_sequences(device_id,sequence_id,source,target_count,capabilities_revision,due_at,admitted_at,
        start_before,scheduler_wake_grace_ms,maximum_settling_ms,status,unresolved)
      values(p_device_id,v_sequence,'scheduled',v_count,v_device.capabilities_revision,v_due,pg_catalog.clock_timestamp(),
        v_start_before,(v_device.capabilities->>'scheduler_wake_grace_ms')::integer,
        (v_device.capabilities->>'maximum_settling_ms')::integer,'accepted',true);
      insert into public.feed_sequence_targets(device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number)
        select p_device_id,v_sequence,ordinality::smallint,(value->>'nozzle_number')::smallint,value->'dose',1,
          (v_targets->0->>'nozzle_number')::smallint
        from jsonb_array_elements(v_targets) with ordinality;
      insert into public.feed_steps(device_id,sequence_id,step_index,nozzle_number,requested_dose,status,measurement_quality,start_before)
        select p_device_id,v_sequence,ordinality::smallint,(value->>'nozzle_number')::smallint,value->'dose','queued','unavailable',
          case when ordinality=1 then v_start_before else null end
        from jsonb_array_elements(v_targets) with ordinality;
      insert into public.scheduled_occurrences(device_id,schedule_id,occurrence_local_date,sequence_id,outcome)
        select p_device_id,(value->>'schedule_id')::uuid,v_date,v_sequence,'admitted'
        from jsonb_array_elements(v_targets);
      if not v_has_reservation and v_event->>'event_type' not in ('skipped','expired','rejected','not_started') then
        insert into public.device_execution_reservations(device_id,sequence_id,phase)
          values(p_device_id,v_sequence,'active');
      end if;
      select * into v_seq from public.feed_sequences s where s.device_id=p_device_id and s.sequence_id=v_sequence;
    end if;
    select * into v_step from public.feed_steps f where f.device_id=p_device_id and f.sequence_id=v_sequence and f.step_index=v_step_index for update;
    if not found or v_step.nozzle_number<>v_nozzle or v_step.requested_dose<>v_event->'requested_dose' then
      raise exception 'invalid scheduled event batch';
    end if;
    v_status := v_event->>'outcome_status';
    v_quality := v_event->>'measurement_quality';
    v_measured := case when v_event->'measured_dispensed_g'='null'::jsonb then null else (v_event->>'measured_dispensed_g')::numeric end;
    v_late_terminal := v_seq.safety_lockout and v_seq.status in ('unknown','partial');
    v_already_terminal := v_seq.status in ('completed','failed','rejected','expired')
      and v_status='not_started' and v_step.status='not_started'
      or v_seq.status='rejected' and v_status='not_started' and v_step.status='queued' and v_dst_gap_remainder;
    if v_seq.status in ('completed','failed','rejected','expired')
       and not (v_status='not_started' and v_step.status='not_started') and not v_already_terminal then
      raise exception 'invalid scheduled event batch';
    end if;
    if v_status='accepted' and v_step.status not in ('queued','accepted')
       or v_status='running' and v_step.status not in ('accepted','running')
       or v_status='completed' and v_step.status not in ('running','completed')
       or v_status='failed' and v_step.status not in ('running','failed')
       or v_status='unknown' and v_step.status not in ('accepted','running','unknown')
       or v_status in ('rejected','expired') and v_step.status not in ('queued','accepted','rejected','expired')
       or v_status in ('not_started','skipped') and v_step.status not in ('queued','accepted','not_started') then
      raise exception 'invalid scheduled event batch';
    end if;
    select coalesce(max(e.event_sequence),0) into v_previous from public.device_events e
      where e.device_id=p_device_id and e.sequence_id=v_sequence;
    if (v_event->>'event_sequence')::bigint<>v_previous+1 then raise exception 'invalid scheduled event batch'; end if;
    if v_step_index=2 and v_status in ('running','completed','failed','unknown') then
      select * into v_first from public.feed_steps f where f.device_id=p_device_id and f.sequence_id=v_sequence and f.step_index=1 for update;
      if v_first.status<>'completed' or v_first.measurement_quality<>'valid' or v_first.baseline_ready_at is null then
        raise exception 'invalid scheduled event batch';
      end if;
    end if;
    v_unsafe := v_status='running' and (
      v_event_at is null or p_clock_quality not in ('synced','rtc') or v_event->>'time_quality' not in ('synced','rtc')
      or v_device.capabilities->>'max_clock_uncertainty_ms' is null
      or p_clock_uncertainty_ms is null or p_clock_uncertainty_ms>(v_device.capabilities->>'max_clock_uncertainty_ms')::integer
      or v_step.start_before is null or v_event_at<v_due or v_event_at>v_step.start_before
      or v_step_index=2 and v_event_at<v_first.baseline_ready_at
    );
    if v_status='completed' then
      v_max_operation_ms := coalesce((v_device.capabilities->'nozzles'->v_nozzle::text->>'max_actuation_ms')::integer,0)
        + coalesce(v_seq.maximum_settling_ms,0);
      v_unsafe := v_event_at is null or p_clock_quality not in ('synced','rtc')
        or v_event->>'time_quality' not in ('synced','rtc')
        or v_device.capabilities->>'max_clock_uncertainty_ms' is null
        or p_clock_uncertainty_ms is null
        or p_clock_uncertainty_ms>(v_device.capabilities->>'max_clock_uncertainty_ms')::integer
        or v_step.started_at is null or v_event_at<v_step.started_at
        or v_event_at>v_step.started_at+(v_max_operation_ms*interval '1 millisecond');
    end if;
    if v_unsafe then v_status:='unknown'; v_quality:='unavailable'; v_measured:=null; end if;
    insert into public.device_events(device_id,sequence_id,event_sequence,step_index,nozzle_number,requested_dose,event_type,payload)
      values(p_device_id,v_sequence,(v_event->>'event_sequence')::bigint,v_step_index,v_nozzle,v_event->'requested_dose',v_event->>'event_type',v_event);
    update public.feed_steps set status=case when v_status='skipped' then 'not_started' else v_status end,
      estimated_dispensed_g=case when v_status='unknown' then null else (v_event->>'estimated_dispensed_g')::numeric end,
      measured_dispensed_g=case when v_quality='valid' and v_status in ('completed','failed') then v_measured else null end,
      measurement_quality=case when v_status in ('not_started','skipped','unknown') then 'unavailable' else v_quality end,
      started_at=case when v_status='running' then coalesce(started_at,v_event_at) else started_at end,
      stopped_at=case when v_status in ('completed','failed','rejected','expired','unknown','not_started','skipped') then coalesce(v_event_at,stopped_at) else stopped_at end,
      baseline_ready_at=case when v_step_index=1 and v_status='completed' and v_quality='valid' and v_event_at is not null then v_event_at else baseline_ready_at end
      where device_id=p_device_id and sequence_id=v_sequence and step_index=v_step_index;
    if v_late_terminal or v_already_terminal then
      v_ack := v_ack || jsonb_build_array(jsonb_build_object('sequence_id',v_sequence,'event_sequence',(v_event->>'event_sequence')::bigint));
      continue;
    end if;
    if v_step_index=1 and v_status='completed' and v_quality='valid' and v_seq.target_count=2 then
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
      where device_id=p_device_id and sequence_id=v_sequence;
    v_ack := v_ack || jsonb_build_array(jsonb_build_object('sequence_id',v_sequence,'event_sequence',(v_event->>'event_sequence')::bigint));
  end loop;
  return jsonb_build_object('status','ok','acknowledged_events',v_ack);
exception when unique_violation then
  return jsonb_build_object('status','conflict');
when others then
  return jsonb_build_object('status','invalid');
end;
$$;

-- Normalize unknown capacity as null in the monitoring profile DTO without rewriting device profiles.
create or replace function public.art27_monitoring_snapshot(
  p_device_id uuid, p_installation_id uuid, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_state public.device_state%rowtype;
  v_sample public.device_telemetry%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_contact_age integer;
  v_sample_age integer;
  v_ingestion_age integer;
  v_do_quality text;
  v_feed_quality text;
  v_do numeric;
  v_remaining numeric;
  v_percent numeric;
  v_capacity numeric;
  v_do_freshness text;
  v_feed_freshness text;
begin
  perform 1 from public.device_access a where a.device_id=p_device_id and a.installation_id=p_installation_id and a.status='active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  select * into v_device from public.devices d where d.device_id=p_device_id;
  select * into v_state from public.device_state s where s.device_id=p_device_id;
  if v_device.device_id is null or v_state.device_id is null then return jsonb_build_object('status','not_found'); end if;
  if v_state.last_authenticated_contact_at is not null then v_contact_age:=greatest(0,floor(extract(epoch from v_now-v_state.last_authenticated_contact_at))::integer); end if;
  if v_state.latest_telemetry_boot_id is not null then
    select * into v_sample from public.device_telemetry t where t.device_id=p_device_id and t.boot_id=v_state.latest_telemetry_boot_id and t.sample_sequence=v_state.latest_telemetry_sequence;
    v_ingestion_age:=greatest(0,floor(extract(epoch from v_now-v_sample.received_at))::integer);
    if v_sample.measured_at is not null and v_sample.time_quality in ('synced','rtc') and v_sample.measured_at<=v_now then
      v_sample_age:=greatest(0,floor(extract(epoch from v_now-v_sample.measured_at))::integer);
    end if;
    v_do_quality:=case when coalesce((v_device.capabilities->>'do_monitoring')::boolean,false) then v_sample.do_quality else 'unavailable' end;
    v_feed_quality:=case when coalesce((v_device.capabilities->>'feed_remaining_monitoring')::boolean,false) then v_sample.feed_quality else 'unavailable' end;
    if v_sample.time_quality not in ('synced','rtc') or v_sample.measured_at is null or v_sample.measured_at>v_now then
      v_do_quality:=case when v_do_quality='valid' then 'unavailable' else v_do_quality end;
      v_feed_quality:=case when v_feed_quality='valid' then 'unavailable' else v_feed_quality end;
    end if;
    -- Old immutable samples may predate the currently advertised hopper size.
    -- Keep the row for history, but never present its incompatible reading as
    -- valid inventory under the upgraded profile.
    if v_feed_quality='valid' and v_device.capabilities ? 'feed_capacity_g'
       and v_device.capabilities->'feed_capacity_g'<>'null'::jsonb then
      if jsonb_typeof(v_device.capabilities->'feed_capacity_g')<>'number' then
        v_feed_quality:='error';
      else
        v_capacity:=(v_device.capabilities->>'feed_capacity_g')::numeric;
        if v_capacity<=0 or v_sample.feed_remaining_g>v_capacity
           or abs(v_sample.feed_percent-round(v_sample.feed_remaining_g*100/v_capacity,2))>0.05 then
          v_feed_quality:='error';
        end if;
      end if;
    end if;
    v_do:=case when v_do_quality='valid' then v_sample.do_mg_l else null end;
    v_remaining:=case when v_feed_quality='valid' then v_sample.feed_remaining_g else null end;
    v_percent:=case when v_feed_quality='valid' then v_sample.feed_percent else null end;
    v_do_freshness:=case when v_do_quality<>'valid' then 'unknown' when v_sample_age<=30 then 'fresh' else 'stale' end;
    v_feed_freshness:=case when v_feed_quality<>'valid' then 'unknown' when v_sample_age<=30 then 'fresh' else 'stale' end;
  end if;
  return jsonb_build_object('status','ok','request_id',p_request_id,'device_id',p_device_id,'server_time',v_now,
    'profile',jsonb_build_object('firmware_version',v_device.firmware_version,'protocol_major',v_device.protocol_major,
      'capabilities_revision',v_device.capabilities_revision,'capabilities',case when v_device.capabilities ? 'feed_capacity_g' then v_device.capabilities else v_device.capabilities || jsonb_build_object('feed_capacity_g',null) end,'is_simulated',v_device.is_simulated),
    'contact',jsonb_build_object('authenticated_at',v_state.last_authenticated_contact_at,'age_seconds',v_contact_age,
      'freshness',case when v_contact_age is null then 'unknown' when v_contact_age<=45 then 'fresh' else 'stale' end),
    'configuration',jsonb_build_object('desired_revision',v_device.desired_revision,'applied_revision',v_device.applied_revision,
      'pending_revision',case when v_device.last_attempt_status='pending' then v_device.last_attempt_revision else null end,
      'last_attempt_status',v_device.last_attempt_status,'error_code',v_device.configuration_error_code),
    'latest_sample',case when v_state.latest_telemetry_boot_id is null then null else jsonb_build_object(
      'boot_id',v_sample.boot_id,'sequence',v_sample.sample_sequence,'live_sequence',v_sample.sample_sequence,
      'measured_at',v_sample.measured_at,'time_quality',v_sample.time_quality,'do_mg_l',v_do,'do_quality',v_do_quality,
      'feed_remaining_g',v_remaining,'feed_percent',v_percent,'feed_quality',v_feed_quality,
      'calibration_revision',case when v_feed_quality='valid' then v_sample.calibration_revision else null end,
      'received_at',v_sample.received_at,'sample_age_seconds',v_sample_age,'ingestion_age_seconds',v_ingestion_age,
      'do_freshness',v_do_freshness,'feed_freshness',v_feed_freshness) end,
    'display_policy',jsonb_build_object('kind','planning_display_policy','device_offline_after_seconds',45,
      'metric_outdated_after_seconds',30,'foreground_refresh_after_seconds',15));
end;
$$;
