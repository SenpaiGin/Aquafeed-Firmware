\set ON_ERROR_STOP on
-- Rollback-only ART-27/33 monitoring configuration regression on the approved D5 simulator fixture.
begin;
set constraints all deferred;

do $$
begin
  if exists(select 1 from auth.users where id='41414141-4141-4414-8414-414141414141'::uuid
      and email not in ('art33-installation@invalid.example')) then
    raise exception 'ART-27 settings test installation UUID is already owned by another auth user';
  end if;
end $$;

do $$
declare
  v_verifier text;
begin
  select encode(c.credential_verifier,'hex') into v_verifier
    from private.device_credentials c
    where c.device_id='22222222-2222-4222-8222-222222222222'::uuid and c.revoked_at is null;
  if v_verifier is null then raise exception 'approved simulator verifier unavailable'; end if;
  perform set_config('art27_test.primary_verifier_hex',v_verifier,true);
end $$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000','41414141-4141-4414-8414-414141414141',
   'authenticated','authenticated','art33-installation@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true)
on conflict (id) do nothing;

insert into public.device_access(device_id,installation_id,status,revoked_at)
values ('22222222-2222-4222-8222-222222222222'::uuid,
  '41414141-4141-4414-8414-414141414141'::uuid,'active',null)
on conflict (device_id,installation_id) do update set status='active',revoked_at=null;

set local role service_role;
do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_installation constant uuid := '41414141-4141-4414-8414-414141414141';
  v_device_row public.devices%rowtype;
  v_current jsonb;
  v_snapshot jsonb;
  v_edit_snapshot jsonb;
  v_invalid jsonb;
  v_status jsonb;
  v_request uuid := gen_random_uuid();
  v_revision bigint;
  v_new_revision bigint;
  v_old_low numeric;
  v_old_high numeric;
  v_old_feed numeric;
  v_new_low numeric;
  v_new_high numeric;
  v_new_feed numeric;
begin
  select * into v_device_row from public.devices where device_id=v_device for update;
  if not found or not v_device_row.is_simulated or v_device_row.capabilities_revision<>2
     or v_device_row.desired_revision is null or v_device_row.applied_revision is null
     or v_device_row.desired_revision<>v_device_row.applied_revision
     or v_device_row.last_attempt_status='pending'
     or exists(select 1 from public.device_execution_reservations r
       where r.device_id=v_device and r.phase in ('active','settling'))
     or exists(select 1 from public.feed_sequences s where s.device_id=v_device and s.unresolved) then
    raise exception 'approved simulator fixture is not on an applied, idle ART-33 baseline';
  end if;

  v_current := public.art33_read_configuration(v_device,v_installation,null);
  if v_current->>'status'<>'ok'
     or (v_current#>>'{current_state,desired_revision}')::bigint<>v_device_row.desired_revision
     or (v_current#>>'{current_state,applied_revision}')::bigint<>v_device_row.applied_revision
     or v_current->'applied_snapshot' is null then
    raise exception 'current full applied configuration was unavailable';
  end if;
  v_revision := v_device_row.desired_revision;
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  if private.art33_validate_snapshot(v_device,v_snapshot) is not null then
    raise exception 'existing applied configuration no longer validates';
  end if;

  v_old_low := (v_snapshot#>>'{monitoring_limits,do_low_mg_l}')::numeric;
  v_old_high := (v_snapshot#>>'{monitoring_limits,do_high_mg_l}')::numeric;
  v_old_feed := (v_snapshot->>'low_feed_threshold_pct')::numeric;
  v_new_low := case when v_old_low is not distinct from 3.2 then 3.3 else 3.2 end;
  v_new_high := case when v_old_high is not distinct from 9.5 then 9.6 else 9.5 end;
  v_new_feed := case when v_old_feed is not distinct from 20 then 21 else 20 end;
  v_edit_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}',to_jsonb(v_new_low));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{monitoring_limits,do_high_mg_l}',to_jsonb(v_new_high));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{low_feed_threshold_pct}',to_jsonb(v_new_feed));

  v_status := public.art33_write_configuration(v_device,v_installation,v_request,v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok'
     or (v_status#>>'{receipt,snapshot,monitoring_limits,do_low_mg_l}')::numeric<>v_new_low
     or (v_status#>>'{receipt,snapshot,monitoring_limits,do_high_mg_l}')::numeric<>v_new_high
     or (v_status#>>'{receipt,snapshot,low_feed_threshold_pct}')::numeric<>v_new_feed
     or v_status#>>'{receipt,snapshot,timezone}' is distinct from v_snapshot->>'timezone'
     or v_status#>'{receipt,snapshot,schedules}' is distinct from v_snapshot->'schedules' then
    raise exception 'monitoring-only full snapshot update was rejected or changed timezone/schedules: %',v_status;
  end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;

  v_status := public.art33_write_configuration(v_device,v_installation,v_request,v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' or (v_status#>>'{receipt,revision}')::bigint<>v_new_revision then
    raise exception 'same monitoring request did not return its original pending revision';
  end if;
  v_invalid := jsonb_set(v_edit_snapshot,'{monitoring_limits,do_low_mg_l}',to_jsonb(v_new_low+0.1));
  if public.art33_write_configuration(v_device,v_installation,v_request,v_revision,v_invalid)->>'status'<>'idempotency_conflict' then
    raise exception 'reused monitoring request ID accepted a different setting payload';
  end if;
  if public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision-1,v_edit_snapshot)->>'status'<>'conflict' then
    raise exception 'monitoring update accepted a stale base revision';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_new_revision,v_edit_snapshot);
  if v_status->>'status'<>'pending'
     or (v_status#>>'{current_state,desired_revision}')::bigint<>v_new_revision
     or (select max(revision) from public.device_config_revisions where device_id=v_device)<>v_new_revision then
    raise exception 'a second full snapshot was admitted while monitoring settings were pending';
  end if;

  v_current := public.art33_read_configuration(v_device,v_installation,v_request);
  if v_current->>'request_status'<>'pending'
     or (v_current#>>'{current_state,desired_revision}')::bigint<>v_new_revision
     or (v_current#>>'{current_state,applied_revision}')::bigint<>v_revision
     or v_current#>'{applied_snapshot,monitoring_limits}' is distinct from v_snapshot->'monitoring_limits'
     or v_current#>'{applied_snapshot,low_feed_threshold_pct}' is distinct from v_snapshot->'low_feed_threshold_pct'
     or v_current#>>'{applied_snapshot,timezone}' is distinct from v_snapshot->>'timezone'
     or v_current#>'{applied_snapshot,schedules}' is distinct from v_snapshot->'schedules'
     or (v_current#>>'{desired_snapshot,monitoring_limits,do_low_mg_l}')::numeric<>v_new_low
     or (v_current#>>'{desired_snapshot,monitoring_limits,do_high_mg_l}')::numeric<>v_new_high
     or (v_current#>>'{desired_snapshot,low_feed_threshold_pct}')::numeric<>v_new_feed
     or v_current#>>'{desired_snapshot,timezone}' is distinct from v_snapshot->>'timezone'
     or v_current#>'{desired_snapshot,schedules}' is distinct from v_snapshot->'schedules' then
    raise exception 'pending monitoring settings changed applied values or lost the full desired schedule snapshot';
  end if;

  v_status := public.art33_device_configuration_report(v_device,current_setting('art27_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'monitoring settings apply ACK failed'; end if;
  v_current := public.art33_read_configuration(v_device,v_installation,v_request);
  if v_current->>'request_status'<>'applied'
     or (v_current#>>'{current_state,applied_revision}')::bigint<>v_new_revision
     or (v_current#>>'{applied_snapshot,monitoring_limits,do_low_mg_l}')::numeric<>v_new_low
     or (v_current#>>'{applied_snapshot,monitoring_limits,do_high_mg_l}')::numeric<>v_new_high
     or (v_current#>>'{applied_snapshot,low_feed_threshold_pct}')::numeric<>v_new_feed
     or v_current#>>'{applied_snapshot,timezone}' is distinct from v_snapshot->>'timezone'
     or v_current#>'{applied_snapshot,schedules}' is distinct from v_snapshot->'schedules' then
    raise exception 'monitoring apply ACK did not activate the settings with the prior timezone and full schedules';
  end if;

  v_invalid := jsonb_set(v_edit_snapshot,'{monitoring_limits,do_low_mg_l}','-1'::jsonb);
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_new_revision,v_invalid);
  if v_status->>'status'<>'rejected' or v_status->>'error_code'<>'VALIDATION_FAILED'
     or (v_status#>>'{current_state,desired_revision}')::bigint<>v_new_revision
     or (v_status#>>'{current_state,applied_revision}')::bigint<>v_new_revision then
    raise exception 'invalid monitoring setting was accepted or advanced the applied revision';
  end if;

  update public.device_access set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where device_id=v_device and installation_id=v_installation;
  if public.art33_read_configuration(v_device,v_installation,null)->>'status'<>'not_active'
     or public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_new_revision,v_edit_snapshot)->>'status'<>'not_active' then
    raise exception 'revoked membership retained protected configuration access';
  end if;
end $$;

rollback;
