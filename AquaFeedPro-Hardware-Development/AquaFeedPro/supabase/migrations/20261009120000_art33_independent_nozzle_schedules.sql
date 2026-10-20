-- ART-33 / D4: desired/applied configuration, schedule reads and device ACKs.
-- Review and apply only through the coordinator's isolated development gate.

alter table public.device_config_revisions
  add column request_id uuid,
  add column based_on_revision bigint,
  add column error_code text;
create unique index device_config_revisions_request_id
  on public.device_config_revisions(device_id, request_id) where request_id is not null;
alter table public.devices
  add column last_attempt_revision bigint,
  add column last_attempt_status text,
  add column configuration_error_code text,
  add constraint devices_configuration_attempt_status_check
    check (last_attempt_status is null or last_attempt_status in ('pending', 'applied', 'rejected'));

-- These are the only fixture profiles upgraded by this migration. Missing
-- simulator clock/settling limits remain unknown for every other device.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.devices d where d.device_id in (
    '22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid
  );
  if v_count <> 2 then raise exception 'ART-33 simulator profile fixtures are missing'; end if;
  if exists (
    select 1 from public.devices d where d.device_id in (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    ) and not (
      d.is_simulated and d.capabilities_revision=1 and d.capabilities =
      '{"do_monitoring":true,"feed_remaining_monitoring":true,"max_schedules":8,"local_schedule_execution":true,"max_clock_uncertainty_ms":null,"scheduler_wake_grace_ms":30000,"maximum_settling_ms":null,"nozzles":{"1":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null},"2":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null}}}'::jsonb
    ) and not (
      d.is_simulated and d.capabilities_revision=2 and d.capabilities =
      '{"do_monitoring":true,"feed_remaining_monitoring":true,"max_schedules":8,"local_schedule_execution":true,"max_clock_uncertainty_ms":1000,"scheduler_wake_grace_ms":30000,"maximum_settling_ms":1000,"nozzles":{"1":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null},"2":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null}}}'::jsonb
    )
  ) then raise exception 'ART-33 simulator profile differs from the reviewed revision 1 fixture'; end if;
  update public.devices d set
    capabilities_revision = 2,
    capabilities = jsonb_set(
      jsonb_set(d.capabilities, '{max_clock_uncertainty_ms}', '1000'::jsonb),
      '{maximum_settling_ms}', '1000'::jsonb
    )
  where d.device_id in (
    '22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid
  ) and d.capabilities_revision = 1;
end $$;

create or replace function private.art33_snapshot_json(p_device_id uuid, p_revision bigint)
returns jsonb
language sql stable
set search_path = ''
as $$
  select r.requested_snapshot || jsonb_build_object(
    'revision', r.revision,
    'based_on_revision', coalesce(r.based_on_revision, r.revision - 1)
  )
  from public.device_config_revisions r
  where r.device_id = p_device_id and r.revision = p_revision
    and jsonb_typeof(r.requested_snapshot) = 'object'
$$;
revoke all on function private.art33_snapshot_json(uuid, bigint) from public, anon, authenticated;
grant execute on function private.art33_snapshot_json(uuid, bigint) to service_role;

create or replace function private.art33_configuration_state(p_device_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'desired_revision', d.desired_revision,
    'applied_revision', d.applied_revision,
    'last_attempt_revision', d.last_attempt_revision,
    'last_attempt_status', d.last_attempt_status,
    'error_code', d.configuration_error_code
  ) from public.devices d where d.device_id = p_device_id
$$;
revoke all on function private.art33_configuration_state(uuid) from public, anon, authenticated;
grant execute on function private.art33_configuration_state(uuid) to service_role;

create or replace function private.art33_validate_snapshot(p_device_id uuid, p_snapshot jsonb)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_schedule jsonb;
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
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    return 'VALIDATION_FAILED';
  end if;
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
  if not exists (select 1 from public.devices d where d.device_id=p_device_id
      and d.capabilities->>'local_schedule_execution'='true'
      and coalesce((d.capabilities->>'max_schedules')::integer,0)>0
      and d.capabilities->>'max_clock_uncertainty_ms' is not null
      and coalesce((d.capabilities->>'max_clock_uncertainty_ms')::integer,-1)>=0
      and d.capabilities->>'maximum_settling_ms' is not null
      and coalesce((d.capabilities->>'maximum_settling_ms')::integer,0)>0
      and d.capabilities->>'scheduler_wake_grace_ms' is not null
      and coalesce((d.capabilities->>'scheduler_wake_grace_ms')::integer,-1)>=0) then
    return 'CAPABILITY_MISMATCH';
  end if;
  for v_schedule in select value from jsonb_array_elements(p_snapshot->'schedules') loop
    if jsonb_typeof(v_schedule) <> 'object'
       or v_schedule - array['schedule_id','local_time','weekdays','enabled','dose','nozzle_number']::text[] <> '{}'::jsonb
       or not (v_schedule ?& array['schedule_id','local_time','weekdays','enabled','dose','nozzle_number'])
       or jsonb_typeof(v_schedule->'schedule_id') <> 'string'
       or (v_schedule->>'schedule_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(v_schedule->'local_time') <> 'string'
       or (v_schedule->>'local_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or jsonb_typeof(v_schedule->'weekdays') <> 'array'
       or jsonb_array_length(v_schedule->'weekdays') not between 1 and 7
       or jsonb_typeof(v_schedule->'enabled') <> 'boolean'
       or jsonb_typeof(v_schedule->'nozzle_number') <> 'number'
       or (v_schedule->>'nozzle_number') not in ('1','2')
       or jsonb_typeof(v_schedule->'dose') <> 'object' then
      return 'VALIDATION_FAILED';
    end if;
    v_schedule_id := lower(v_schedule->>'schedule_id');
    v_number := (v_schedule->>'nozzle_number')::integer;
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
    select d.* into v_device from public.devices d where d.device_id = p_device_id;
    if not (v_device.capabilities->'nozzles'->v_number::text->>'enabled')::boolean then
      return 'CAPABILITY_MISMATCH';
    end if;
    v_nozzle := v_device.capabilities->'nozzles'->v_number::text;
    if v_nozzle->>'max_actuation_ms' is null
       or coalesce((v_nozzle->>'max_actuation_ms')::integer,0)<=0 then
      return 'CAPABILITY_MISMATCH';
    end if;
    v_dose := v_schedule->'dose';
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
  if jsonb_array_length(p_snapshot->'schedules') > coalesce((select (capabilities->>'max_schedules')::integer from public.devices where device_id = p_device_id), 0) then
    return 'CAPABILITY_MISMATCH';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_snapshot->'schedules') as a(value)
    join jsonb_array_elements(p_snapshot->'schedules') as b(value) on a.value->>'schedule_id' < b.value->>'schedule_id'
    where a.value->>'nozzle_number' = b.value->>'nozzle_number'
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

create or replace function public.art33_read_configuration(
  p_device_id uuid, p_installation_id uuid, p_request_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_receipt jsonb := null;
  v_request_status text := null;
  v_request_error text := null;
begin
  perform 1 from public.device_access a where a.device_id = p_device_id
    and a.installation_id = p_installation_id and a.status = 'active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  select d.* into v_device from public.devices d where d.device_id = p_device_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if p_request_id is not null then
    select case when r.state = 'rejected' then null else jsonb_build_object(
      'revision', r.revision, 'based_on_revision', r.based_on_revision,
      'snapshot', r.requested_snapshot
    ) end, case when r.state='requested' then 'pending' else r.state end, r.error_code
      into v_receipt,v_request_status,v_request_error from public.device_config_revisions r
      where r.device_id = p_device_id and r.request_id = p_request_id;
  end if;
  return jsonb_build_object(
    'status','ok',
    'receipt',v_receipt,
    'request_status',v_request_status,
    'request_error_code',v_request_error,
    'current_state',private.art33_configuration_state(p_device_id),
    'desired_snapshot',case when v_device.desired_revision is not null and v_device.last_attempt_status = 'pending'
      then private.art33_snapshot_json(p_device_id,v_device.desired_revision) else null end,
    'applied_snapshot',case when v_device.applied_revision is not null
      then private.art33_snapshot_json(p_device_id,v_device.applied_revision) else null end
  );
end;
$$;
revoke all on function public.art33_read_configuration(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.art33_read_configuration(uuid, uuid, uuid) to service_role;

create or replace function public.art33_write_configuration(
  p_device_id uuid, p_installation_id uuid, p_request_id uuid,
  p_based_on_revision bigint, p_snapshot jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_existing public.device_config_revisions%rowtype;
  v_revision bigint;
  v_error text;
  v_schedule jsonb;
  v_day jsonb;
  v_id uuid;
begin
  perform 1 from public.device_access a where a.device_id = p_device_id
    and a.installation_id = p_installation_id and a.status = 'active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  select d.* into v_device from public.devices d where d.device_id = p_device_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select r.* into v_existing from public.device_config_revisions r
    where r.device_id = p_device_id and r.request_id = p_request_id;
  if found then
    if v_existing.based_on_revision is distinct from p_based_on_revision
       or v_existing.requested_snapshot is distinct from p_snapshot then
      return jsonb_build_object('status','idempotency_conflict','current_state',private.art33_configuration_state(p_device_id));
    end if;
    return jsonb_build_object('status',case when v_existing.state = 'rejected' then 'rejected' else 'ok' end,
      'receipt',case when v_existing.state = 'rejected' then null else jsonb_build_object(
        'revision',v_existing.revision,'based_on_revision',v_existing.based_on_revision,'snapshot',v_existing.requested_snapshot) end,
      'current_state',private.art33_configuration_state(p_device_id),'error_code',v_existing.error_code);
  end if;
  if p_based_on_revision is distinct from coalesce(v_device.desired_revision,0) then
    return jsonb_build_object('status','conflict','current_state',private.art33_configuration_state(p_device_id));
  end if;
  if v_device.desired_revision is not null and v_device.last_attempt_status = 'pending' then
    return jsonb_build_object('status','pending','current_state',private.art33_configuration_state(p_device_id));
  end if;
  v_revision := coalesce((select max(revision) from public.device_config_revisions where device_id=p_device_id),0)+1;
  v_error := private.art33_validate_snapshot(p_device_id,p_snapshot);
  if v_error is null and coalesce(v_device.applied_revision,v_device.desired_revision) is not null then
    if (select requested_snapshot->'monitoring_limits' from public.device_config_revisions
      where device_id=p_device_id and revision=coalesce(v_device.applied_revision,v_device.desired_revision)) is distinct from p_snapshot->'monitoring_limits'
       or (select requested_snapshot->'low_feed_threshold_pct' from public.device_config_revisions
      where device_id=p_device_id and revision=coalesce(v_device.applied_revision,v_device.desired_revision)) is distinct from p_snapshot->'low_feed_threshold_pct' then
      v_error := 'VALIDATION_FAILED';
    end if;
  end if;
  insert into public.device_config_revisions(device_id,revision,requested_snapshot,state,request_id,based_on_revision,error_code)
    values (p_device_id,v_revision,coalesce(p_snapshot,'{}'::jsonb),case when v_error is null then 'requested' else 'rejected' end,
      p_request_id,p_based_on_revision,v_error);
  update public.devices set desired_revision=case when v_error is null then v_revision else desired_revision end,
    last_attempt_revision=v_revision,
    last_attempt_status=case when v_error is null then 'pending' else 'rejected' end,
    configuration_error_code=v_error where device_id=p_device_id;
  if v_error is not null then
    return jsonb_build_object('status','rejected','receipt',null,
      'current_state',private.art33_configuration_state(p_device_id),'error_code',v_error);
  end if;
  for v_schedule in select value from jsonb_array_elements(p_snapshot->'schedules') loop
    v_id := (v_schedule->>'schedule_id')::uuid;
    insert into public.device_schedule_identities(device_id,schedule_id)
      values(p_device_id,v_id) on conflict do nothing;
    insert into public.device_config_schedules(device_id,revision,schedule_id,nozzle_number,requested_dose,timezone,enabled)
      values(p_device_id,v_revision,v_id,(v_schedule->>'nozzle_number')::smallint,v_schedule->'dose',p_snapshot->>'timezone',(v_schedule->>'enabled')::boolean);
    for v_day in select value from jsonb_array_elements(v_schedule->'weekdays') loop
      insert into public.device_config_schedule_slots(device_id,revision,schedule_id,nozzle_number,iso_weekday,local_time)
        values(p_device_id,v_revision,v_id,(v_schedule->>'nozzle_number')::smallint,(v_day::text)::smallint,(v_schedule->>'local_time')::time);
    end loop;
  end loop;
  return jsonb_build_object('status','ok','receipt',jsonb_build_object(
    'revision',v_revision,'based_on_revision',p_based_on_revision,'snapshot',p_snapshot),
    'current_state',private.art33_configuration_state(p_device_id));
exception when unique_violation then
  raise;
end;
$$;
revoke all on function public.art33_write_configuration(uuid, uuid, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.art33_write_configuration(uuid, uuid, uuid, bigint, jsonb) to service_role;

create or replace function public.art33_device_configuration_report(
  p_device_id uuid, p_device_verifier_hex text,
  p_applied_revision bigint, p_last_attempt_revision bigint,
  p_last_attempt_status text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_credential_device_id uuid;
  v_revision public.device_config_revisions%rowtype;
  v_old_snapshot jsonb;
begin
  if p_device_verifier_hex is null or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status','auth_required');
  end if;
  select c.device_id into v_credential_device_id from private.device_credentials c
    where c.device_id=p_device_id and c.credential_verifier=pg_catalog.decode(pg_catalog.lower(p_device_verifier_hex),'hex')
      and c.revoked_at is null for share;
  if not found then return jsonb_build_object('status','auth_required'); end if;
  select d.* into v_device from public.devices d where d.device_id=p_device_id for update;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if p_last_attempt_status is null and p_last_attempt_revision is null
     and p_error_code is null and p_applied_revision is not distinct from v_device.applied_revision then
    return jsonb_build_object('status','ok','desired_configuration',case
      when v_device.desired_revision is not null and v_device.last_attempt_status='pending'
      then private.art33_snapshot_json(p_device_id,v_device.desired_revision) else null end);
  end if;
  if v_device.last_attempt_status='pending'
     and p_last_attempt_status in ('applied','rejected')
     and p_last_attempt_revision is distinct from v_device.desired_revision
     and p_last_attempt_revision is not null
     and p_last_attempt_revision <= v_device.desired_revision
     and p_applied_revision is not distinct from v_device.applied_revision then
    return jsonb_build_object('status','ok','desired_configuration',private.art33_snapshot_json(p_device_id,v_device.desired_revision));
  end if;
  if v_device.last_attempt_status='rejected'
     and v_device.last_attempt_revision > coalesce(v_device.applied_revision,0)
     and p_last_attempt_status='applied'
     and p_last_attempt_revision is not distinct from v_device.applied_revision
     and p_applied_revision is not distinct from v_device.applied_revision then
    return jsonb_build_object('status','ok','desired_configuration',null);
  end if;
  if p_last_attempt_status='rejected' and p_last_attempt_revision is distinct from v_device.desired_revision then
    return jsonb_build_object('status','stale');
  end if;
  if p_applied_revision is distinct from v_device.applied_revision
     and (p_last_attempt_status is distinct from 'applied'
       or p_applied_revision is null
       or p_applied_revision is distinct from p_last_attempt_revision) then
    return jsonb_build_object('status','invalid');
  end if;
  if p_last_attempt_status not in ('pending','applied','rejected')
     or (p_last_attempt_status = 'rejected' and (p_error_code is null or p_error_code not in
       ('VALIDATION_FAILED','DOSE_UNSUPPORTED','DOSE_OUT_OF_RANGE','CAPABILITY_MISMATCH','CLOCK_UNTRUSTED','CONFIG_CONFLICT','IDEMPOTENCY_CONFLICT')))
     or (p_last_attempt_status <> 'rejected' and p_error_code is not null) then
    return jsonb_build_object('status','invalid');
  end if;
  if p_last_attempt_status = 'pending' then
    if p_last_attempt_revision is distinct from v_device.desired_revision
       or p_applied_revision is distinct from v_device.applied_revision
       or v_device.last_attempt_status is distinct from 'pending' then
      return jsonb_build_object('status','stale');
    end if;
    return jsonb_build_object('status','ok','desired_configuration',case
      when v_device.desired_revision is not null and v_device.last_attempt_status='pending'
      then private.art33_snapshot_json(p_device_id,v_device.desired_revision) else null end);
  end if;
  if p_last_attempt_revision is null or p_last_attempt_revision is distinct from v_device.desired_revision then
    return jsonb_build_object('status','stale');
  end if;
  select r.* into v_revision from public.device_config_revisions r
    where r.device_id=p_device_id and r.revision=p_last_attempt_revision for update;
  if not found or v_revision.state not in ('requested','applied','rejected') then
    return jsonb_build_object('status','stale');
  end if;
  if p_last_attempt_status='rejected' and v_revision.state='rejected'
     and v_revision.error_code=p_error_code and v_device.last_attempt_status='rejected'
     and v_device.last_attempt_revision=p_last_attempt_revision
     and p_applied_revision is not distinct from v_device.applied_revision then
    return jsonb_build_object('status','ok','desired_configuration',null);
  end if;
  if p_last_attempt_status='rejected' and v_revision.state<>'requested' then
    return jsonb_build_object('status','stale');
  end if;
  if p_last_attempt_status='applied' then
    if v_revision.state='rejected' then return jsonb_build_object('status','stale'); end if;
    if v_device.applied_revision is distinct from p_applied_revision and v_device.applied_revision is not null then
      v_old_snapshot := private.art33_snapshot_json(p_device_id,v_device.applied_revision)->'schedules';
      insert into public.device_schedule_tombstones(device_id,schedule_id)
        select p_device_id,(old_item->>'schedule_id')::uuid
        from jsonb_array_elements(coalesce(v_old_snapshot,'[]'::jsonb)) as old_item(value)
        where not exists (select 1 from jsonb_array_elements(v_revision.requested_snapshot->'schedules') as new_item(value)
          where new_item.value->>'schedule_id'=old_item.value->>'schedule_id') on conflict do nothing;
    end if;
    update public.device_config_revisions set state='applied',applied_at=coalesce(applied_at,pg_catalog.clock_timestamp()),error_code=null
      where device_id=p_device_id and revision=p_last_attempt_revision;
    update public.devices set applied_revision=p_applied_revision,last_attempt_revision=p_last_attempt_revision,
      last_attempt_status='applied',configuration_error_code=null where device_id=p_device_id;
  else
    update public.device_config_revisions set state='rejected',error_code=p_error_code
      where device_id=p_device_id and revision=p_last_attempt_revision and state='requested';
    update public.devices set last_attempt_revision=p_last_attempt_revision,last_attempt_status='rejected',
      configuration_error_code=p_error_code where device_id=p_device_id;
  end if;
  return jsonb_build_object('status','ok','desired_configuration',null);
end;
$$;
revoke all on function public.art33_device_configuration_report(uuid,text,bigint,bigint,text,text) from public, anon, authenticated;
grant execute on function public.art33_device_configuration_report(uuid,text,bigint,bigint,text,text) to service_role;

create or replace function public.art33_next_applied_occurrence(
  p_device_id uuid, p_installation_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_occurrence jsonb;
  v_timezone text;
begin
  perform 1 from public.device_access a where a.device_id=p_device_id
    and a.installation_id=p_installation_id and a.status='active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  select private.art33_snapshot_json(d.device_id,d.applied_revision) into v_snapshot
    from public.devices d where d.device_id=p_device_id;
  v_timezone := v_snapshot->>'timezone';
  if v_snapshot is null then return jsonb_build_object('status','ok','timezone',null,'occurrence',null); end if;
  with candidates as (
    select (day_value)::date as local_date, s.value->>'local_time' as local_time,
      (s.value->>'nozzle_number')::integer as nozzle_number, s.value->>'schedule_id' as schedule_id, s.value->'dose' as dose,
      v_snapshot->>'timezone' as timezone,
      ((day_value)::date + (s.value->>'local_time')::time) at time zone (v_snapshot->>'timezone') as due_at
    from generate_series(
      (pg_catalog.clock_timestamp() at time zone (v_snapshot->>'timezone'))::date,
      (pg_catalog.clock_timestamp() at time zone (v_snapshot->>'timezone'))::date + 14,
      interval '1 day'
    ) day_value
    cross join lateral jsonb_array_elements(v_snapshot->'schedules') as s(value)
    where s.value->>'enabled'='true'
      and extract(isodow from day_value)::integer in (select (w.value::text)::integer from jsonb_array_elements(s.value->'weekdays') as w(value))
      and not exists (select 1 from public.scheduled_occurrences o
        where o.device_id=p_device_id and o.schedule_id=(s.value->>'schedule_id')::uuid
          and o.occurrence_local_date=(day_value)::date)
      and (((day_value)::date + (s.value->>'local_time')::time) at time zone (v_snapshot->>'timezone')) at time zone (v_snapshot->>'timezone')
        = ((day_value)::date + (s.value->>'local_time')::time)
  ), next_due as (
    select min(due_at) due_at from candidates where due_at >= pg_catalog.clock_timestamp()
  ), grouped as (
    select c.* from candidates c join next_due n using (due_at)
  )
  select jsonb_build_object(
    'occurrence_local_date',min(local_date),
    'local_time',min(local_time),
    'timezone',min(timezone),
    'at',to_char(min(due_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'targets',jsonb_agg(jsonb_build_object('schedule_id',schedule_id,'nozzle_number',nozzle_number,'dose',dose) order by nozzle_number,schedule_id)
  ) into v_occurrence from grouped having count(*)>0;
  return jsonb_build_object('status','ok','timezone',v_timezone,'occurrence',v_occurrence);
end;
$$;
revoke all on function public.art33_next_applied_occurrence(uuid,uuid) from public, anon, authenticated;
grant execute on function public.art33_next_applied_occurrence(uuid,uuid) to service_role;

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
       or (v_event->>'measurement_quality'='valid' and (v_event->'measured_dispensed_g'='null'::jsonb or v_event->>'event_type'<>'completed'))
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
      measured_dispensed_g=case when v_quality='valid' and v_status='completed' then v_measured else null end,
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
revoke all on function public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid) from public, anon, authenticated;
grant execute on function public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid) to service_role;
