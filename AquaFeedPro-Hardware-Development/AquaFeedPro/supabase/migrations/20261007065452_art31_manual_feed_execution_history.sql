-- D3 adds server-owned manual command admission and consistent audit reads.
-- Device I/O remains behind device-api; these RPCs are service_role only.
alter table public.feed_sequences add column delivered_at timestamptz;

create or replace function private.art31_command_status_json(
  p_device_id uuid,
  p_sequence_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'command_id', s.sequence_id,
    'sequence_id', s.sequence_id,
    'device_id', s.device_id,
    'request_id', s.request_id,
    'idempotency_key', s.idempotency_key,
    'status', s.status,
    'status_sequence', s.status_sequence,
    'created_at', s.created_at,
    'start_before', s.start_before,
    'targets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'nozzle_number', t.nozzle_number,
        'dose', t.requested_dose
      ) order by t.step_index), '[]'::jsonb)
      from public.feed_sequence_targets t
      where t.device_id = s.device_id and t.sequence_id = s.sequence_id
    ),
    'nozzle_results', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'nozzle_number', f.nozzle_number,
        'status', f.status,
        'requested_dose', f.requested_dose,
        'estimated_dispensed_g', f.estimated_dispensed_g,
        'measured_dispensed_g', f.measured_dispensed_g,
        'measurement_quality', f.measurement_quality
      ) order by f.step_index), '[]'::jsonb)
      from public.feed_steps f
      where f.device_id = s.device_id and f.sequence_id = s.sequence_id
    ),
    'safety_lockout', s.safety_lockout,
    'lockout_resolution', case when s.lockout_resolved_at is null then null else
      jsonb_build_object(
        'resolution_at', s.lockout_resolved_at,
        'resolution_reason', coalesce((
          select e.payload #>> '{maintenance_resolution,resolution_reason}'
          from public.device_events e
          where e.device_id = s.device_id and e.sequence_id = s.sequence_id
            and e.event_type = 'maintenance_acknowledged'
          order by e.event_sequence desc limit 1
        ), 'Physical maintenance recorded; outcome remains unknown'),
        'source', 'device_maintenance'
      ) end
  )
  from public.feed_sequences s
  where s.device_id = p_device_id and s.sequence_id = p_sequence_id
    and s.source = 'manual';
$$;
revoke all on function private.art31_command_status_json(uuid, uuid) from public, anon, authenticated;
grant execute on function private.art31_command_status_json(uuid, uuid) to service_role;

create or replace function private.art31_reconcile_manual_feed(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_sequence public.feed_sequences%rowtype;
  v_step public.feed_steps%rowtype;
  v_first public.feed_steps%rowtype;
  v_actuation_ms integer;
  v_timeout_ms integer;
  v_timed_out boolean;
  v_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_device from public.devices d
    where d.device_id = p_device_id for update;
  if not found then return; end if;

  for v_sequence in
    select * from public.feed_sequences s
    where s.device_id = p_device_id and s.unresolved
      and s.status in ('queued', 'accepted', 'running')
    order by s.created_at for update
  loop
    if v_sequence.delivered_at is null then
      if v_sequence.status in ('queued', 'accepted')
         and v_now > v_sequence.start_before then
        update public.feed_steps set
          status = case when step_index = 1 then 'expired' else 'not_started' end,
          measurement_quality = 'unavailable', measured_dispensed_g = null,
          estimated_dispensed_g = null, stopped_at = v_now
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id
            and status in ('queued', 'accepted');
        update public.feed_sequences set status = 'expired', unresolved = false,
          status_sequence = status_sequence + 1
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
        update public.device_execution_reservations set phase = 'released',
          released_at = v_now
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id
            and phase in ('active', 'settling');
      end if;
      continue;
    end if;

    select * into v_step from public.feed_steps f
      where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
        and f.status in ('queued', 'accepted', 'running')
      order by f.step_index limit 1 for update;
    if not found then continue; end if;

    if v_step.status in ('queued', 'accepted') then
      v_timed_out := v_step.start_before is not null and v_now > v_step.start_before;
    else
      v_actuation_ms := nullif(v_device.capabilities->'nozzles'->v_step.nozzle_number::text->>'max_actuation_ms', '')::integer;
      v_timeout_ms := v_actuation_ms + coalesce(v_sequence.maximum_settling_ms, 0);
      v_timed_out := v_timeout_ms is not null and v_step.started_at is not null
        and v_now > v_step.started_at + v_timeout_ms * interval '1 millisecond';
    end if;
    if not v_timed_out then continue; end if;

    update public.feed_steps set status = 'unknown', measurement_quality = 'unavailable',
      measured_dispensed_g = null, estimated_dispensed_g = null,
      stopped_at = coalesce(stopped_at, v_now)
      where device_id = p_device_id and sequence_id = v_sequence.sequence_id
        and step_index = v_step.step_index;
    update public.feed_steps set status = 'not_started', measurement_quality = 'unavailable',
      measured_dispensed_g = null, estimated_dispensed_g = null,
      stopped_at = coalesce(stopped_at, v_now)
      where device_id = p_device_id and sequence_id = v_sequence.sequence_id
        and step_index > v_step.step_index and status in ('queued', 'accepted', 'running');

    select * into v_first from public.feed_steps f
      where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
        and f.step_index = 1;
    v_status := case when v_step.step_index = 2 and v_first.status = 'completed'
      then 'partial' else 'unknown' end;
    update public.feed_sequences set status = v_status, safety_lockout = true,
      unresolved = true, status_sequence = status_sequence + 1
      where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
    update public.device_state set safety_lockout = true,
      lockout_sequence_id = v_sequence.sequence_id, updated_at = v_now
      where device_id = p_device_id;
    insert into public.device_execution_reservations (device_id, sequence_id, phase)
      values (p_device_id, v_sequence.sequence_id, 'settling')
      on conflict (device_id, sequence_id) do update set
        phase = case when public.device_execution_reservations.phase = 'released'
          then 'settling' else public.device_execution_reservations.phase end,
        released_at = null;
  end loop;
end;
$$;
revoke all on function private.art31_reconcile_manual_feed(uuid) from public, anon, authenticated;
grant execute on function private.art31_reconcile_manual_feed(uuid) to service_role;

create or replace function public.art31_create_manual_feed(
  p_device_id uuid,
  p_installation_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_targets jsonb,
  p_capabilities_revision integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_state public.device_state%rowtype;
  v_access uuid;
  v_existing public.feed_sequences%rowtype;
  v_existing_targets jsonb;
  v_nozzle jsonb;
  v_dose jsonb;
  v_nozzle_number smallint;
  v_index smallint;
  v_min numeric;
  v_max numeric;
  v_step numeric;
  v_amount numeric;
  v_sequence uuid := pg_catalog.gen_random_uuid();
  v_start_before timestamptz;
  v_now timestamptz;
  v_count integer;
begin
  if p_device_id is null or p_installation_id is null or p_request_id is null
     or p_idempotency_key is null or p_capabilities_revision is null
     or p_targets is null or jsonb_typeof(p_targets) <> 'array' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if jsonb_array_length(p_targets) not between 1 and 2 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_count := jsonb_array_length(p_targets);

  if exists (
    select 1 from jsonb_array_elements(p_targets) as target(value)
    where jsonb_typeof(target.value) <> 'object'
      or target.value->>'nozzle_number' not in ('1', '2')
      or jsonb_typeof(target.value->'dose') <> 'object'
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_targets) with ordinality target(value, ordinal)
    where (v_count = 2 and (target.ordinal = 1 and target.value->>'nozzle_number' <> '1'
                         or target.ordinal = 2 and target.value->>'nozzle_number' <> '2'))
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_count = 1 and p_targets->0->>'nozzle_number' not in ('1', '2') then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_device from public.devices d
    where d.device_id = p_device_id for update;
  if not found or v_device.protocol_major <> 2 then
    return jsonb_build_object('status', 'not_found');
  end if;
  select a.device_id into v_access from public.device_access a
    where a.device_id = p_device_id and a.installation_id = p_installation_id
      and a.status = 'active' for share;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;

  perform private.art31_reconcile_manual_feed(p_device_id);

  select * into v_existing from public.feed_sequences s
    where s.device_id = p_device_id and s.installation_id = p_installation_id
      and s.idempotency_key = p_idempotency_key and s.source = 'manual';
  if found then
    select coalesce(jsonb_agg(jsonb_build_object(
      'nozzle_number', t.nozzle_number, 'dose', t.requested_dose
    ) order by t.step_index), '[]'::jsonb)
      into v_existing_targets
      from public.feed_sequence_targets t
      where t.device_id = p_device_id and t.sequence_id = v_existing.sequence_id;
    if v_existing.capabilities_revision <> p_capabilities_revision
       or v_existing_targets <> p_targets then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'command', private.art31_command_status_json(p_device_id, v_existing.sequence_id)
    );
  end if;

  if v_device.capabilities_revision <> p_capabilities_revision then
    return jsonb_build_object('status', 'capability_mismatch');
  end if;
  if v_count = 2 and nullif(v_device.capabilities->>'scheduler_wake_grace_ms', '') is null then
    return jsonb_build_object('status', 'dose_unsupported');
  end if;
  select * into v_state from public.device_state ds
    where ds.device_id = p_device_id for update;
  if not found then return jsonb_build_object('status', 'unavailable'); end if;
  if v_state.safety_lockout then return jsonb_build_object('status', 'safety_lockout'); end if;
  if exists (select 1 from public.device_execution_reservations r
      where r.device_id = p_device_id and r.phase in ('active', 'settling')) then
    return jsonb_build_object('status', 'device_busy');
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_state.contact_freshness <> 'fresh' or v_state.last_authenticated_contact_at is null
     or v_state.last_authenticated_contact_at < v_now - interval '1 minute' then
    return jsonb_build_object('status', 'device_offline');
  end if;
  v_start_before := v_now + interval '1 minute';

  for v_index in 1..v_count loop
    v_nozzle_number := (p_targets->(v_index - 1)->>'nozzle_number')::smallint;
    v_dose := p_targets->(v_index - 1)->'dose';
    v_nozzle := v_device.capabilities->'nozzles'->(v_nozzle_number::text);
    if coalesce((v_nozzle->>'enabled')::boolean, false) is not true then
      return jsonb_build_object('status', 'dose_unsupported');
    end if;
    if v_dose->>'mode' = 'grams' and jsonb_typeof(v_dose->'amount_g') = 'number'
       and coalesce((v_nozzle->'dose_modes') ? 'grams', false) then
      v_amount := (v_dose->>'amount_g')::numeric;
      v_min := nullif(v_nozzle->>'min_dose_g', '')::numeric;
      v_max := nullif(v_nozzle->>'max_dose_g', '')::numeric;
      v_step := nullif(v_nozzle->>'dose_step_g', '')::numeric;
      if v_amount <= 0 or v_min is null or v_max is null or v_step is null then
        return jsonb_build_object('status', 'dose_unsupported');
      end if;
      if v_amount < v_min or v_amount > v_max or mod(v_amount - v_min, v_step) <> 0 then
        return jsonb_build_object('status', 'dose_out_of_range');
      end if;
    elsif v_dose->>'mode' = 'fixed_portion'
       and jsonb_typeof(v_dose->'fixed_portion_id') = 'string'
       and (v_nozzle->'fixed_portion_ids') ? (v_dose->>'fixed_portion_id')
       and coalesce((v_nozzle->'dose_modes') ? 'fixed_portion', false) then
      null;
    else
      return jsonb_build_object('status', 'dose_unsupported');
    end if;
  end loop;

  insert into public.feed_sequences (
    device_id, sequence_id, source, installation_id, idempotency_key, request_id,
    target_count, capabilities_revision, start_before, scheduler_wake_grace_ms,
    maximum_settling_ms, status, status_sequence, unresolved
  ) values (
    p_device_id, v_sequence, 'manual', p_installation_id, p_idempotency_key, p_request_id,
    v_count, p_capabilities_revision, v_start_before,
    nullif(v_device.capabilities->>'scheduler_wake_grace_ms', '')::integer,
    nullif(v_device.capabilities->>'maximum_settling_ms', '')::integer,
    'queued', 1, true
  );

  for v_index in 1..v_count loop
    v_nozzle_number := (p_targets->(v_index - 1)->>'nozzle_number')::smallint;
    v_dose := p_targets->(v_index - 1)->'dose';
    insert into public.feed_sequence_targets (
      device_id, sequence_id, step_index, nozzle_number, requested_dose,
      first_step_index, first_nozzle_number
    ) values (
      p_device_id, v_sequence, v_index, v_nozzle_number, v_dose, 1,
      case when v_count = 2 then 1 else v_nozzle_number end
    );
    insert into public.feed_steps (
      device_id, sequence_id, step_index, nozzle_number, requested_dose,
      status, measurement_quality, start_before
    ) values (
      p_device_id, v_sequence, v_index, v_nozzle_number, v_dose,
      'queued', 'unavailable', case when v_index = 1 then v_start_before else null end
    );
  end loop;
  insert into public.device_execution_reservations (device_id, sequence_id, phase)
    values (p_device_id, v_sequence, 'active');
  return jsonb_build_object(
    'status', 'created',
    'command', private.art31_command_status_json(p_device_id, v_sequence)
  );
end;
$$;
revoke all on function public.art31_create_manual_feed(uuid, uuid, uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.art31_create_manual_feed(uuid, uuid, uuid, uuid, jsonb, integer) to service_role;

create or replace function public.art31_sync_manual_feed(
  p_device_id uuid,
  p_device_verifier_hex text,
  p_capabilities_revision integer,
  p_events jsonb,
  p_actuator_state text,
  p_active_sequence_id uuid,
  p_clock_quality text,
  p_clock_uncertainty_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_state public.device_state%rowtype;
  v_credential_device_id uuid;
  v_sequence public.feed_sequences%rowtype;
  v_step public.feed_steps%rowtype;
  v_target public.feed_sequence_targets%rowtype;
  v_first public.feed_steps%rowtype;
  v_event_record record;
  v_event jsonb;
  v_saved public.device_events%rowtype;
  v_event_sequence bigint;
  v_previous_sequence bigint;
  v_step_index smallint;
  v_nozzle_number smallint;
  v_outcome text;
  v_step_status text;
  v_sequence_status text;
  v_quality text;
  v_event_time_quality text;
  v_measured numeric;
  v_estimated numeric;
  v_event_at timestamptz;
  v_safe_clock boolean;
  v_late_terminal boolean;
  v_acknowledged jsonb;
  v_command jsonb := null;
begin
  if p_device_verifier_hex is null or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'auth_required');
  end if;
  select c.device_id into v_credential_device_id
    from private.device_credentials c
    where c.device_id = p_device_id
      and c.credential_verifier = pg_catalog.decode(pg_catalog.lower(p_device_verifier_hex), 'hex')
      and c.revoked_at is null
    for share;
  if not found then return jsonb_build_object('status', 'auth_required'); end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100
     or p_actuator_state is null or p_actuator_state not in ('idle', 'feeding', 'fault', 'unknown')
     or p_clock_quality is null or p_clock_quality not in ('synced', 'rtc', 'uncertain', 'invalid')
     or p_clock_uncertainty_ms < 0 then
    raise exception using errcode = '22023', message = 'invalid device sync';
  end if;
  select * into v_device from public.devices d where d.device_id = p_device_id for update;
  if not found or v_device.protocol_major <> 2 then
    raise exception using errcode = '22023', message = 'unknown device';
  end if;
  select * into v_state from public.device_state ds where ds.device_id = p_device_id for update;
  if not found then raise exception using errcode = '22023', message = 'device state unavailable'; end if;

  update public.device_state set
    last_authenticated_contact_at = pg_catalog.clock_timestamp(),
    contact_freshness = 'fresh', updated_at = pg_catalog.clock_timestamp()
    where device_id = p_device_id;

  for v_event_record in
    select input.value from jsonb_array_elements(p_events) with ordinality as input(value, ordinal)
    order by input.ordinal
  loop
    v_event := v_event_record.value;
    v_event_sequence := (v_event->>'event_sequence')::bigint;
    v_step_index := (v_event->>'step_index')::smallint;
    v_nozzle_number := (v_event->>'nozzle_number')::smallint;
    v_outcome := v_event->>'outcome_status';
    v_quality := v_event->>'measurement_quality';
    v_event_time_quality := v_event->>'time_quality';
    v_event_at := nullif(v_event->>'device_at', '')::timestamptz;
    v_measured := nullif(v_event->>'measured_dispensed_g', '')::numeric;
    v_estimated := nullif(v_event->>'estimated_dispensed_g', '')::numeric;

    select * into v_sequence from public.feed_sequences s
      where s.device_id = p_device_id and s.sequence_id = (v_event->>'sequence_id')::uuid
      for update;
    if not found or v_sequence.source <> 'manual'
       or (v_event->>'source') <> 'manual'
       or (v_event->>'command_id')::uuid <> v_sequence.sequence_id
       or v_event->>'schedule_id' is not null
       or v_event->'configuration_revision' <> 'null'::jsonb
       or v_event->'occurrence_local_date' <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'event does not match a manual command';
    end if;
    select * into v_target from public.feed_sequence_targets t
      where t.device_id = p_device_id and t.sequence_id = v_sequence.sequence_id
        and t.step_index = v_step_index and t.nozzle_number = v_nozzle_number
        and t.requested_dose = v_event->'requested_dose';
    select * into v_step from public.feed_steps f
      where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
        and f.step_index = v_step_index and f.nozzle_number = v_nozzle_number;
    if not found or v_target.sequence_id is null then
      raise exception using errcode = '22023', message = 'event target does not match command';
    end if;
    if v_event_time_quality is null
       or v_event_time_quality not in ('synced', 'rtc', 'uncertain', 'invalid') then
      raise exception using errcode = '22023', message = 'event time quality is invalid';
    end if;

    select * into v_saved from public.device_events e
      where e.device_id = p_device_id and e.sequence_id = v_sequence.sequence_id
        and e.event_sequence = v_event_sequence;
    if found then
      if v_saved.payload <> v_event then
        raise exception using errcode = '23505', message = 'event identity reused with different content';
      end if;
      continue;
    end if;
    select coalesce(max(e.event_sequence), 0) into v_previous_sequence
      from public.device_events e
      where e.device_id = p_device_id and e.sequence_id = v_sequence.sequence_id;
    if v_event_sequence <> v_previous_sequence + 1 then
      raise exception using errcode = '22023', message = 'device event sequence is out of order';
    end if;
    v_late_terminal := v_sequence.status in ('unknown', 'partial') and v_sequence.safety_lockout;
    if v_sequence.status in ('completed', 'partial', 'failed', 'rejected', 'expired', 'unknown')
       and not (v_outcome = 'not_started' and v_step.status = 'not_started')
       and v_event->>'event_type' <> 'maintenance_acknowledged'
       and not v_late_terminal then
      raise exception using errcode = '23505', message = 'terminal command cannot be rewritten';
    end if;

    if v_step_index = 2 and v_outcome in ('running', 'completed', 'failed', 'unknown')
       and not v_late_terminal then
      select * into v_first from public.feed_steps f
        where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
          and f.step_index = 1 for update;
      if not found or v_first.status <> 'completed'
         or v_first.measurement_quality <> 'valid'
         or v_first.baseline_ready_at is null or v_step.start_before is null then
        raise exception using errcode = '22023', message = 'nozzle 2 lacks a settled nozzle 1 baseline';
      end if;
    end if;

    if v_step_index = 2 and v_late_terminal and v_outcome <> 'not_started'
       and not exists (
         select 1 from public.device_events e
         where e.device_id = p_device_id and e.sequence_id = v_sequence.sequence_id
           and e.step_index = 1 and e.event_type = 'completed'
           and e.payload->>'outcome_status' = 'completed'
           and e.payload->>'measurement_quality' = 'valid'
       ) then
      raise exception using errcode = '22023', message = 'late nozzle 2 event has no earlier settled nozzle 1 event';
    end if;

    if v_outcome = 'queued' and v_step.status <> 'queued'
       or v_outcome = 'accepted' and v_step.status not in ('queued', 'accepted')
       or v_outcome = 'running' and v_step.status not in ('accepted', 'running')
       or v_outcome = 'completed' and v_step.status not in ('running', 'completed')
       or v_outcome = 'failed' and v_step.status not in ('running', 'failed')
       or v_outcome = 'rejected' and v_step.status not in ('queued', 'accepted', 'rejected')
       or v_outcome = 'expired' and v_step.status not in ('queued', 'accepted', 'expired')
       or v_outcome = 'unknown' and v_step.status not in ('queued', 'accepted', 'running', 'unknown')
       or v_outcome = 'not_started' and v_step.status not in ('queued', 'accepted', 'not_started')
       or v_event->>'event_type' = 'maintenance_acknowledged' and v_step.status <> 'unknown' then
      if not v_late_terminal or v_event->>'event_type' = 'maintenance_acknowledged' then
        raise exception using errcode = '23505', message = 'event would rewrite a nozzle outcome';
      end if;
    end if;

    v_step_status := v_outcome;
    v_sequence_status := v_sequence.status;
    if v_outcome = 'expired' and v_step_index = 2 then
      select * into v_first from public.feed_steps f
        where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
          and f.step_index = 1;
      if v_first.status = 'completed' then
        v_step_status := 'not_started';
        v_quality := case when v_quality in ('error', 'uncalibrated') then v_quality else 'unavailable' end;
      end if;
    end if;
    v_safe_clock := p_clock_quality in ('synced', 'rtc')
      and v_event_time_quality in ('synced', 'rtc')
      and (v_device.capabilities->>'max_clock_uncertainty_ms' is null
        or coalesce(p_clock_uncertainty_ms <= (v_device.capabilities->>'max_clock_uncertainty_ms')::integer, false));
    if v_outcome = 'running'
       and (v_event_at is null or not v_safe_clock
         or v_step.start_before is null or v_event_at > v_step.start_before
         or (v_step_index = 2 and v_event_at < v_first.baseline_ready_at)) then
      v_step_status := 'unknown';
      v_outcome := 'unknown';
      v_quality := 'unavailable';
      v_measured := null;
    end if;

    insert into public.device_events (
      device_id, sequence_id, event_sequence, step_index, nozzle_number,
      requested_dose, event_type, payload
    ) values (
      p_device_id, v_sequence.sequence_id, v_event_sequence, v_step_index,
      v_nozzle_number, v_target.requested_dose, v_event->>'event_type', v_event
    );

    -- Preserve late journal entries for acknowledgment while keeping an accepted unknown result immutable.
    if v_late_terminal and v_event->>'event_type' <> 'maintenance_acknowledged' then
      continue;
    end if;

    if v_event->>'event_type' = 'maintenance_acknowledged' then
      update public.feed_sequences set
        unresolved = false, safety_lockout = false,
        lockout_resolved_at = coalesce(v_event#>>'{maintenance_resolution,resolution_at}', pg_catalog.clock_timestamp())::timestamptz,
        lockout_resolution_source = 'device_maintenance', status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_state set safety_lockout = false, lockout_sequence_id = null,
        updated_at = pg_catalog.clock_timestamp() where device_id = p_device_id;
      update public.device_execution_reservations set phase = 'released',
        released_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and phase in ('active', 'settling');
      continue;
    end if;

    if v_step_status = 'not_started' and v_step_index = 2
       and v_sequence.target_count = 2 then
      v_quality := case when v_quality in ('error', 'uncalibrated') then v_quality else 'unavailable' end;
    end if;
    update public.feed_steps set
      status = v_step_status,
      estimated_dispensed_g = v_estimated,
      measured_dispensed_g = case when v_quality = 'valid' then v_measured else null end,
      measurement_quality = v_quality,
      started_at = case when v_step_status = 'running' then coalesce(started_at, v_event_at) else started_at end,
      stopped_at = case when v_step_status in ('completed', 'failed', 'rejected', 'expired', 'unknown', 'not_started')
        then coalesce(v_event_at, stopped_at) else stopped_at end,
      baseline_ready_at = case when v_step_index = 1 and v_step_status = 'completed'
        and v_quality = 'valid' and v_event_at is not null and v_safe_clock
        then v_event_at else baseline_ready_at end
      where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = v_step_index;

    if v_step_index = 1 and v_step_status in ('failed', 'rejected', 'expired', 'unknown')
       and v_sequence.target_count = 2 then
      update public.feed_steps set status = 'not_started', measurement_quality = 'unavailable',
        measured_dispensed_g = null, estimated_dispensed_g = null
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = 2
          and status = 'queued';
    end if;

    if v_step_index = 1 and v_step_status = 'completed' and v_sequence.target_count = 2 then
      select * into v_first from public.feed_steps f
        where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id and f.step_index = 1;
      if v_first.baseline_ready_at is not null and v_sequence.scheduler_wake_grace_ms is not null then
        update public.feed_steps set
          baseline_ready_at = v_first.baseline_ready_at,
          start_before = v_first.baseline_ready_at + v_sequence.scheduler_wake_grace_ms * interval '1 millisecond'
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = 2;
        update public.device_execution_reservations set phase = 'settling', released_at = null
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      else
        update public.feed_steps set status = 'not_started', measurement_quality = 'unavailable',
          measured_dispensed_g = null, estimated_dispensed_g = null
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = 2;
      end if;
    end if;

    if v_outcome = 'unknown' then
      v_sequence_status := case when v_step_index = 2 and v_sequence.target_count = 2
        and v_first.status = 'completed' then 'partial' else 'unknown' end;
      update public.feed_sequences set status = v_sequence_status, safety_lockout = true,
        unresolved = true, status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_state set safety_lockout = true,
        lockout_sequence_id = v_sequence.sequence_id, updated_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id;
      insert into public.device_execution_reservations (device_id, sequence_id, phase)
        values (p_device_id, v_sequence.sequence_id, 'settling')
        on conflict (device_id, sequence_id) do update set
          phase = case when public.device_execution_reservations.phase = 'released'
            then 'settling' else public.device_execution_reservations.phase end,
          released_at = null;
    elsif v_step_index = 1 and v_step_status = 'completed' and v_sequence.target_count = 2
       and exists (select 1 from public.feed_steps f where f.device_id = p_device_id
         and f.sequence_id = v_sequence.sequence_id and f.step_index = 2 and f.status = 'not_started') then
      v_sequence_status := 'partial';
      update public.feed_sequences set status = 'partial', unresolved = false,
        status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_execution_reservations set phase = 'released',
        released_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and phase in ('active', 'settling');
    elsif v_step_status = 'completed' and not exists (
      select 1 from public.feed_steps f where f.device_id = p_device_id
        and f.sequence_id = v_sequence.sequence_id and f.status <> 'completed'
    ) then
      v_sequence_status := 'completed';
      update public.feed_sequences set status = 'completed', unresolved = false,
        status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_execution_reservations set phase = 'released',
        released_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and phase in ('active', 'settling');
    elsif v_step_index = 1 and v_step_status = 'completed' and v_sequence.target_count = 2 then
      update public.feed_sequences set status = 'running', status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and status <> 'running';
    elsif v_step_status in ('failed', 'rejected', 'expired') then
      if v_step_index = 2 then v_sequence_status := 'partial';
      else v_sequence_status := v_step_status; end if;
      update public.feed_sequences set status = v_sequence_status, unresolved = false,
        status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      update public.device_execution_reservations set phase = 'released',
        released_at = pg_catalog.clock_timestamp()
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and phase in ('active', 'settling');
    elsif v_step_status = 'not_started' then
      select * into v_first from public.feed_steps f
        where f.device_id = p_device_id and f.sequence_id = v_sequence.sequence_id
          and f.step_index = 1;
      if exists (select 1 from public.feed_steps f where f.device_id = p_device_id
          and f.sequence_id = v_sequence.sequence_id and f.status = 'unknown') then
        v_sequence_status := case when v_sequence.target_count = 2 and v_first.status = 'completed'
          then 'partial' else 'unknown' end;
      elsif v_sequence.status = 'partial' then v_sequence_status := 'partial';
      elsif v_sequence.status in ('failed', 'rejected', 'expired') then v_sequence_status := v_sequence.status;
      elsif v_sequence.target_count = 2 and v_first.status = 'completed' then v_sequence_status := 'partial';
      else v_sequence_status := 'expired'; end if;

      if v_sequence_status = 'unknown' then
        update public.feed_sequences set status = 'unknown', safety_lockout = true,
          unresolved = true, status_sequence = case when status = 'unknown'
            then status_sequence else status_sequence + 1 end
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
        update public.device_state set safety_lockout = true,
          lockout_sequence_id = v_sequence.sequence_id, updated_at = pg_catalog.clock_timestamp()
          where device_id = p_device_id;
        insert into public.device_execution_reservations (device_id, sequence_id, phase)
          values (p_device_id, v_sequence.sequence_id, 'settling')
          on conflict (device_id, sequence_id) do update set
            phase = case when public.device_execution_reservations.phase = 'released'
              then 'settling' else public.device_execution_reservations.phase end,
            released_at = null;
      else
        update public.feed_sequences set status = v_sequence_status, safety_lockout = false,
          unresolved = false, status_sequence = case when status = v_sequence_status
            then status_sequence else status_sequence + 1 end
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
        update public.device_execution_reservations set phase = 'released',
          released_at = pg_catalog.clock_timestamp()
          where device_id = p_device_id and sequence_id = v_sequence.sequence_id
            and phase in ('active', 'settling');
      end if;
    elsif v_step_status = 'accepted' then
      update public.feed_sequences set status = 'accepted', status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and status = 'queued';
    elsif v_step_status = 'running' then
      update public.feed_sequences set status = 'running', status_sequence = status_sequence + 1
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id
          and status <> 'running';
      update public.device_execution_reservations set phase = 'active', released_at = null
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
    end if;
  end loop;

  perform private.art31_reconcile_manual_feed(p_device_id);
  select * into v_sequence from public.feed_sequences s
    where s.device_id = p_device_id and s.source = 'manual' and s.unresolved
    order by s.created_at limit 1;
  if found and v_sequence.status in ('queued', 'accepted') then
    if v_sequence.status = 'queued'
       and v_device.capabilities_revision = p_capabilities_revision
       and not v_state.safety_lockout
       and p_actuator_state = 'idle' and p_active_sequence_id is null
       and p_clock_quality in ('synced', 'rtc')
       and (v_device.capabilities->>'max_clock_uncertainty_ms' is null
         or p_clock_uncertainty_ms <= (v_device.capabilities->>'max_clock_uncertainty_ms')::integer) then
      update public.feed_sequences set delivered_at = coalesce(delivered_at, pg_catalog.clock_timestamp())
        where device_id = p_device_id and sequence_id = v_sequence.sequence_id;
      select jsonb_build_object(
        'command_type', 'feed',
        'command_id', s.sequence_id,
        'sequence_id', s.sequence_id,
        'device_id', s.device_id,
        'request_id', s.request_id,
        'idempotency_key', s.idempotency_key,
        'targets', (select coalesce(jsonb_agg(jsonb_build_object(
          'nozzle_number', t.nozzle_number, 'dose', t.requested_dose
        ) order by t.step_index), '[]'::jsonb) from public.feed_sequence_targets t
          where t.device_id = s.device_id and t.sequence_id = s.sequence_id),
        'capabilities_revision', s.capabilities_revision,
        'created_at', s.created_at,
        'start_before', s.start_before,
        'scheduler_wake_grace_ms', s.scheduler_wake_grace_ms,
        'status', s.status
      ) into v_command from public.feed_sequences s
        where s.device_id = p_device_id and s.sequence_id = v_sequence.sequence_id;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence_id', ack.sequence_id, 'event_sequence', ack.event_sequence
  ) order by ack.sequence_id, ack.event_sequence), '[]'::jsonb) into v_acknowledged
  from (select distinct (value->>'sequence_id')::uuid as sequence_id,
      (value->>'event_sequence')::bigint as event_sequence
    from jsonb_array_elements(p_events)) ack;
  return jsonb_build_object(
    'status', 'ok', 'server_time', pg_catalog.clock_timestamp(),
    'acknowledged_events', v_acknowledged, 'command', v_command,
    'next_sync_after_ms', 1000
  );
end;
$$;
revoke all on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) to service_role;

create or replace function public.art31_read_manual_command(
  p_device_id uuid,
  p_installation_id uuid,
  p_lookup uuid,
  p_by_key boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence uuid;
  v_access uuid;
  v_command jsonb;
begin
  select a.device_id into v_access from public.device_access a
    where a.device_id = p_device_id and a.installation_id = p_installation_id
      and a.status = 'active' for share;
  if not found then return jsonb_build_object('status', 'not_active'); end if;
  perform private.art31_reconcile_manual_feed(p_device_id);
  if p_by_key then
    select s.sequence_id into v_sequence from public.feed_sequences s
      where s.device_id = p_device_id and s.installation_id = p_installation_id
        and s.idempotency_key = p_lookup and s.source = 'manual';
  else
    select s.sequence_id into v_sequence from public.feed_sequences s
      where s.device_id = p_device_id and s.sequence_id = p_lookup and s.source = 'manual';
  end if;
  if v_sequence is null then return jsonb_build_object('status', 'not_found'); end if;
  v_command := private.art31_command_status_json(p_device_id, v_sequence);
  return jsonb_build_object('status', 'found', 'command', v_command);
end;
$$;
revoke all on function public.art31_read_manual_command(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.art31_read_manual_command(uuid, uuid, uuid, boolean) to service_role;

create or replace function private.art31_history_record_json(
  p_device_id uuid,
  p_sequence_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sequence_id', s.sequence_id,
    'command_id', case when s.source = 'manual' then s.sequence_id else null end,
    'device_id', s.device_id,
    'source', s.source,
    'request_id', s.request_id,
    'idempotency_key', s.idempotency_key,
    'status', s.status,
    'status_sequence', s.status_sequence,
    'created_at', s.created_at,
    'start_before', s.start_before,
    'started_at', (select min(f.started_at) from public.feed_steps f
      where f.device_id = s.device_id and f.sequence_id = s.sequence_id),
    'completed_at', (select max(f.stopped_at) from public.feed_steps f
      where f.device_id = s.device_id and f.sequence_id = s.sequence_id),
    'reason_code', (select e.payload->>'reason_code' from public.device_events e
      where e.device_id = s.device_id and e.sequence_id = s.sequence_id
        and e.payload->>'reason_code' is not null
      order by e.event_sequence desc limit 1),
    'targets', (select coalesce(jsonb_agg(jsonb_build_object(
      'nozzle_number', t.nozzle_number, 'dose', t.requested_dose
    ) order by t.step_index), '[]'::jsonb) from public.feed_sequence_targets t
      where t.device_id = s.device_id and t.sequence_id = s.sequence_id),
    'nozzle_results', (select coalesce(jsonb_agg(jsonb_build_object(
      'nozzle_number', f.nozzle_number,
      'status', f.status,
      'requested_dose', f.requested_dose,
      'estimated_dispensed_g', f.estimated_dispensed_g,
      'measured_dispensed_g', f.measured_dispensed_g,
      'measurement_quality', f.measurement_quality
    ) order by f.step_index), '[]'::jsonb) from public.feed_steps f
      where f.device_id = s.device_id and f.sequence_id = s.sequence_id),
    'safety_lockout', s.safety_lockout,
    'lockout_resolution', case when s.lockout_resolved_at is null then null else
      jsonb_build_object(
        'resolution_at', s.lockout_resolved_at,
        'resolution_reason', coalesce((select e.payload #>> '{maintenance_resolution,resolution_reason}'
          from public.device_events e where e.device_id = s.device_id
            and e.sequence_id = s.sequence_id and e.event_type = 'maintenance_acknowledged'
          order by e.event_sequence desc limit 1), 'Physical maintenance recorded; outcome remains unknown'),
        'source', 'device_maintenance'
      ) end
  )
  from public.feed_sequences s
  where s.device_id = p_device_id and s.sequence_id = p_sequence_id;
$$;
revoke all on function private.art31_history_record_json(uuid, uuid) from public, anon, authenticated;
grant execute on function private.art31_history_record_json(uuid, uuid) to service_role;

create or replace function public.art31_history_page(
  p_device_id uuid,
  p_installation_id uuid,
  p_from_date date,
  p_to_date date,
  p_source text,
  p_status text,
  p_before_created_at timestamptz default null,
  p_before_sequence_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access uuid;
  v_timezone text;
  v_from_date date;
  v_to_date date;
  v_timezone_known boolean := false;
  v_result jsonb;
begin
  select a.device_id into v_access from public.device_access a
    where a.device_id = p_device_id and a.installation_id = p_installation_id
      and a.status = 'active' for share;
  if not found then return jsonb_build_object('status', 'not_active'); end if;
  perform private.art31_reconcile_manual_feed(p_device_id);
  if p_source not in ('all', 'manual', 'scheduled')
     or p_status not in ('all', 'completed', 'failed', 'in_progress', 'unknown')
     or ((p_before_created_at is null) <> (p_before_sequence_id is null)) then
    return jsonb_build_object('status', 'invalid');
  end if;
  select r.requested_snapshot->>'timezone' into v_timezone
    from public.devices d left join public.device_config_revisions r
      on r.device_id = d.device_id and r.revision = d.applied_revision
    where d.device_id = p_device_id;
  v_timezone_known := v_timezone is not null;
  v_timezone := coalesce(v_timezone, 'UTC');
  v_to_date := coalesce(p_to_date, (pg_catalog.clock_timestamp() at time zone v_timezone)::date);
  v_from_date := coalesce(p_from_date, v_to_date - 6);
  if v_from_date > v_to_date then
    return jsonb_build_object('status', 'invalid');
  end if;

  with filtered as materialized (
    select s.* from public.feed_sequences s
    where s.device_id = p_device_id
      and s.created_at >= (v_from_date::timestamp at time zone v_timezone)
      and s.created_at < ((v_to_date + 1)::timestamp at time zone v_timezone)
      and (p_source = 'all' or s.source = p_source)
      and (p_status = 'all'
        or (p_status = 'completed' and s.status = 'completed')
        or (p_status = 'failed' and s.status in ('failed', 'rejected', 'expired'))
        or (p_status = 'in_progress' and s.status in ('queued', 'accepted', 'running'))
        or (p_status = 'unknown' and s.status in ('partial', 'unknown')))
  ), summary as (
    select count(*)::integer as total,
      count(*) filter (where status = 'completed')::integer as completed,
      count(*) filter (where status in ('partial', 'failed', 'rejected', 'expired', 'unknown'))::integer as needs_attention,
      count(*) filter (where status in ('queued', 'accepted', 'running'))::integer as in_progress
    from filtered
  ), page as (
    select f.* from filtered f
    where p_before_created_at is null
      or (f.created_at, f.sequence_id) < (p_before_created_at, p_before_sequence_id)
    order by f.created_at desc, f.sequence_id desc
    limit 51
  ), limited as (
    select p.* from page p
    order by p.created_at desc, p.sequence_id desc
    limit 50
  )
  select jsonb_build_object(
    'status', 'ok',
    'from_date', v_from_date,
    'to_date', v_to_date,
    'timezone', v_timezone,
    'timezone_known', v_timezone_known,
    'total', summary.total,
    'completed_total', summary.completed,
    'needs_attention_total', summary.needs_attention,
    'in_progress_total', summary.in_progress,
    'records', coalesce((select jsonb_agg(private.art31_history_record_json(p_device_id, l.sequence_id)
      order by l.created_at desc, l.sequence_id desc) from limited l), '[]'::jsonb),
    'has_more', (select count(*) > 50 from page),
    'next', (select jsonb_build_object('created_at', l.created_at, 'sequence_id', l.sequence_id)
      from limited l order by l.created_at asc, l.sequence_id asc limit 1)
  ) into v_result from summary;
  return v_result;
end;
$$;
revoke all on function public.art31_history_page(uuid, uuid, date, date, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.art31_history_page(uuid, uuid, date, date, text, text, timestamptz, uuid) to service_role;

create or replace function public.art31_history_detail(
  p_device_id uuid,
  p_installation_id uuid,
  p_sequence_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access uuid;
  v_timezone text;
  v_timezone_known boolean := false;
  v_record jsonb;
begin
  select a.device_id into v_access from public.device_access a
    where a.device_id = p_device_id and a.installation_id = p_installation_id
      and a.status = 'active' for share;
  if not found then return jsonb_build_object('status', 'not_active'); end if;
  perform private.art31_reconcile_manual_feed(p_device_id);
  select r.requested_snapshot->>'timezone' into v_timezone
    from public.devices d left join public.device_config_revisions r
      on r.device_id = d.device_id and r.revision = d.applied_revision
    where d.device_id = p_device_id;
  v_timezone_known := v_timezone is not null;
  v_record := private.art31_history_record_json(p_device_id, p_sequence_id);
  if v_record is null then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok', 'timezone', coalesce(v_timezone, 'UTC'),
    'timezone_known', v_timezone_known, 'record', v_record);
end;
$$;
revoke all on function public.art31_history_detail(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.art31_history_detail(uuid, uuid, uuid) to service_role;
