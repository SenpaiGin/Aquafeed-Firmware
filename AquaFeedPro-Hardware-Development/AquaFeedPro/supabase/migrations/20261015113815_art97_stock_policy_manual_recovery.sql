-- ART-97 correction: fresh shared-stock admission and safe saved-request recovery.
-- No stock is reserved or subtracted on admission. Recovery writes a terminal
-- rejected receipt under the same per-device lock as feed admission.
-- Bump only the three controlled synthetic devices; real device dose limits are untouched.
update public.devices
set capabilities_revision = 4,
    capabilities = jsonb_set(
      jsonb_set(capabilities, '{nozzles,1,max_dose_g}', '20000'::jsonb),
      '{nozzles,2,max_dose_g}', '20000'::jsonb
    )
where device_id in (
  '11111111-1111-4111-8111-111111111111'::uuid,
  '22222222-2222-4222-8222-222222222222'::uuid,
  '33333333-3333-4333-8333-333333333333'::uuid
) and is_simulated and protocol_major = 2;
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
      "1": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 20000, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null},
      "2": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 20000, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null}
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
  values (p_device_id, 'AquaFeed controlled simulator', 'sim-2.0.0', 2, true, 4, v_capabilities)
  on conflict (device_id) do update set
    model = excluded.model,
    firmware_version = excluded.firmware_version,
    protocol_major = 2,
    is_simulated = true,
    capabilities_revision = 4,
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
revoke all on function public.art38_provision_simulated_device(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.art38_provision_simulated_device(uuid, text, boolean) to service_role;
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
  v_stock jsonb;
  v_latest_sample jsonb;
  v_stock_remaining numeric;
  v_total_requested numeric := 0;
  v_fixed_portions integer := 0;
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
      v_total_requested := v_total_requested + v_amount;
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
      v_fixed_portions := v_fixed_portions + 1;
    else
      return jsonb_build_object('status', 'dose_unsupported');
    end if;
  end loop;

  v_stock := public.art27_monitoring_snapshot(p_device_id, p_installation_id, p_request_id);
  if v_stock->>'status' <> 'ok' then
    return jsonb_build_object('status', 'inventory_unavailable');
  end if;
  v_latest_sample := v_stock->'latest_sample';
  if jsonb_typeof(v_latest_sample) <> 'object'
     or v_latest_sample->>'feed_quality' <> 'valid'
     or v_latest_sample->>'feed_freshness' <> 'fresh'
     or jsonb_typeof(v_latest_sample->'feed_remaining_g') <> 'number' then
    return jsonb_build_object('status', 'inventory_unavailable');
  end if;
  v_stock_remaining := (v_latest_sample->>'feed_remaining_g')::numeric;
  if v_stock_remaining < v_total_requested
     or (v_fixed_portions > 0 and v_stock_remaining <= v_total_requested) then
    return jsonb_build_object('status', 'insufficient_inventory');
  end if;
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
create or replace function public.art31_resolve_manual_feed_no_admission(
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
  v_access uuid;
  v_existing public.feed_sequences%rowtype;
  v_existing_targets jsonb;
  v_target jsonb;
  v_dose jsonb;
  v_nozzle_number smallint;
  v_index smallint;
  v_count integer;
  v_sequence uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_device_id is null or p_installation_id is null or p_request_id is null
     or p_idempotency_key is null or p_capabilities_revision is null or p_capabilities_revision < 1
     or p_targets is null or jsonb_typeof(p_targets) <> 'array'
     or jsonb_array_length(p_targets) not between 1 and 2 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_count := jsonb_array_length(p_targets);
  if exists (
    select 1 from jsonb_array_elements(p_targets) with ordinality target(value, ordinal)
    where jsonb_typeof(target.value) <> 'object'
       or target.value->>'nozzle_number' not in ('1', '2')
       or jsonb_typeof(target.value->'dose') <> 'object'
       or (v_count = 2 and ((target.ordinal = 1 and target.value->>'nozzle_number' <> '1')
                         or (target.ordinal = 2 and target.value->>'nozzle_number' <> '2')))
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_targets) target(value)
    where not (
      (target.value->'dose'->>'mode' = 'grams'
       and jsonb_typeof(target.value->'dose'->'amount_g') = 'number'
       and (target.value->'dose'->>'amount_g')::numeric > 0)
      or (target.value->'dose'->>'mode' = 'fixed_portion'
          and jsonb_typeof(target.value->'dose'->'fixed_portion_id') = 'string'
          and length(target.value->'dose'->>'fixed_portion_id') > 0)
    )
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Serialize the fence with admission. An in-flight original POST commits
  -- first; otherwise this terminal receipt prevents later admission for its key.
  select * into v_device from public.devices d
    where d.device_id = p_device_id for update;
  if not found or v_device.protocol_major <> 2 then
    return jsonb_build_object('status', 'not_found');
  end if;
  select a.device_id into v_access from public.device_access a
    where a.device_id = p_device_id and a.installation_id = p_installation_id
      and a.status = 'active' for share;
  if not found then return jsonb_build_object('status', 'not_active'); end if;

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
    if v_existing.request_id is distinct from p_request_id
       or v_existing.capabilities_revision <> p_capabilities_revision
       or v_existing_targets <> p_targets then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'command', private.art31_command_status_json(p_device_id, v_existing.sequence_id)
    );
  end if;

  insert into public.feed_sequences (
    device_id, sequence_id, source, installation_id, idempotency_key, request_id,
    target_count, capabilities_revision, start_before, scheduler_wake_grace_ms,
    maximum_settling_ms, status, status_sequence, unresolved
  ) values (
    p_device_id, v_sequence, 'manual', p_installation_id, p_idempotency_key, p_request_id,
    v_count, p_capabilities_revision, v_now,
    nullif(v_device.capabilities->>'scheduler_wake_grace_ms', '')::integer,
    nullif(v_device.capabilities->>'maximum_settling_ms', '')::integer,
    'rejected', 1, false
  );
  for v_index in 1..v_count loop
    v_target := p_targets->(v_index - 1);
    v_dose := v_target->'dose';
    v_nozzle_number := (v_target->>'nozzle_number')::smallint;
    insert into public.feed_sequence_targets (
      device_id, sequence_id, step_index, nozzle_number, requested_dose,
      first_step_index, first_nozzle_number
    ) values (
      p_device_id, v_sequence, v_index, v_nozzle_number, v_dose, 1,
      case when v_count = 2 then 1 else v_nozzle_number end
    );
    insert into public.feed_steps (
      device_id, sequence_id, step_index, nozzle_number, requested_dose,
      status, measurement_quality, stopped_at
    ) values (
      p_device_id, v_sequence, v_index, v_nozzle_number, v_dose,
      'rejected', 'unavailable', v_now
    );
  end loop;
  return jsonb_build_object(
    'status', 'created',
    'command', private.art31_command_status_json(p_device_id, v_sequence)
  );
end;
$$;
revoke all on function public.art31_resolve_manual_feed_no_admission(uuid, uuid, uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.art31_resolve_manual_feed_no_admission(uuid, uuid, uuid, uuid, jsonb, integer) to service_role;
