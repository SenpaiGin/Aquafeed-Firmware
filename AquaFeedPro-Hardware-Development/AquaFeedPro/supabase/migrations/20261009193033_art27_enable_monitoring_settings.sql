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
