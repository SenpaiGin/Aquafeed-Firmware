-- Rollback-only ART-33 checks for an isolated development database.
-- The coordinator may run this only after reviewing the migration; it does not
-- provision devices, change credentials, or perform an actuation.
begin;
set constraints all deferred;

do $$
begin
  if has_function_privilege('anon', 'public.art33_read_configuration(uuid,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.art33_read_configuration(uuid,uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.art33_read_configuration(uuid,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.art33_write_configuration(uuid,uuid,uuid,bigint,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.art33_write_configuration(uuid,uuid,uuid,bigint,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.art33_write_configuration(uuid,uuid,uuid,bigint,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.art33_device_configuration_report(uuid,text,bigint,bigint,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.art33_device_configuration_report(uuid,text,bigint,bigint,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.art33_device_configuration_report(uuid,text,bigint,bigint,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.art33_record_scheduled_events(uuid,text,jsonb,text,integer,text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.art33_next_applied_occurrence(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.art33_next_applied_occurrence(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.art33_next_applied_occurrence(uuid,uuid)', 'EXECUTE') then
    raise exception 'an ART-33 service-only RPC is exposed to a client role';
  end if;
  if has_table_privilege('service_role','public.device_events','DELETE')
     or has_table_privilege('service_role','public.scheduled_occurrences','DELETE')
     or has_table_privilege('service_role','public.device_execution_reservations','DELETE') then
    raise exception 'service_role can delete durable feed history or reservations';
  end if;
end $$;

do $$
begin
  if exists (select 1 from auth.users where id in (
      '41414141-4141-4414-8414-414141414141',
      '42424242-4242-4424-8424-424242424242'
    ) and email not in ('art33-installation@invalid.example', 'art33-other@invalid.example')) then
    raise exception 'ART-33 test installation UUID is already owned by another auth user';
  end if;
end $$;

-- Keep existing fixture verifiers transaction-local and out of query results.
do $$
declare
  v_primary text;
  v_secondary text;
begin
  select encode(c.credential_verifier,'hex') into v_primary
    from private.device_credentials c
    where c.device_id='22222222-2222-4222-8222-222222222222'::uuid and c.revoked_at is null;
  select encode(c.credential_verifier,'hex') into v_secondary
    from private.device_credentials c
    where c.device_id='33333333-3333-4333-8333-333333333333'::uuid and c.revoked_at is null;
  if v_primary is null or v_secondary is null then raise exception 'approved simulator verifier unavailable'; end if;
  perform set_config('art33_test.primary_verifier_hex',v_primary,true);
  perform set_config('art33_test.secondary_verifier_hex',v_secondary,true);
end $$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000','41414141-4141-4414-8414-414141414141',
   'authenticated','authenticated','art33-installation@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true),
  ('00000000-0000-0000-0000-000000000000','42424242-4242-4424-8424-424242424242',
   'authenticated','authenticated','art33-other@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true)
on conflict (id) do nothing;

set local role service_role;
do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_other_device constant uuid := '33333333-3333-4333-8333-333333333333';
  v_installation constant uuid := '41414141-4141-4414-8414-414141414141';
  v_other_installation constant uuid := '42424242-4242-4424-8424-424242424242';
  v_device_row public.devices%rowtype;
  v_other_row public.devices%rowtype;
  v_current jsonb;
  v_snapshot jsonb;
  v_invalid jsonb;
  v_status jsonb;
  v_request uuid := gen_random_uuid();
  v_stale_request uuid := gen_random_uuid();
  v_invalid_request uuid := gen_random_uuid();
  v_additive_request uuid := gen_random_uuid();
  v_schedule1 uuid := gen_random_uuid();
  v_schedule2 uuid := gen_random_uuid();
  v_schedule3 uuid := gen_random_uuid();
  v_schedule4 uuid := gen_random_uuid();
  v_failed_sequence uuid := gen_random_uuid();
  v_revision bigint;
  v_previous_desired bigint;
  v_local_time time;
  v_weekday smallint := 1;
  v_next jsonb;
  v_next_after jsonb;
  v_events jsonb;
  v_event jsonb;
  v_due timestamptz;
  v_bad_due timestamptz;
  v_local_date date;
  v_bad_date date;
  v_sequence uuid := gen_random_uuid();
  v_bad_sequence uuid := gen_random_uuid();
  v_collision_sequence uuid := gen_random_uuid();
  v_manual_sequence uuid := gen_random_uuid();
  v_event_result jsonb;
  v_collision_next jsonb;
  v_collision_events jsonb;
  v_targets jsonb;
  v_collision_date date;
  v_collision_due timestamptz;
  v_event_count integer;
  v_edit_request uuid := gen_random_uuid();
  v_rejected_request uuid := gen_random_uuid();
  v_device_rejected_request uuid := gen_random_uuid();
  v_after_reject_request uuid := gen_random_uuid();
  v_invalid_revision bigint;
  v_new_revision bigint;
  v_edit_snapshot jsonb;
  v_later_time time := '08:05';
  v_index integer;
  v_schedule5 uuid := gen_random_uuid();
  v_both_snapshot jsonb;
  v_both_date date;
  v_both_due timestamptz;
  v_both_sequence uuid;
  v_step1 jsonb;
  v_step2 jsonb;
  v_proof jsonb;
  v_case integer;
begin
  select * into v_device_row from public.devices where device_id=v_device;
  select * into v_other_row from public.devices where device_id=v_other_device;
  if v_device_row.device_id is null or v_other_row.device_id is null
     or not v_device_row.is_simulated or not v_other_row.is_simulated
     or v_device_row.capabilities_revision<>5 or v_other_row.capabilities_revision<>5
     or v_device_row.capabilities->>'scheduled_both'<>'true' 
     or v_device_row.capabilities->>'feed_capacity_g'<>'20000'
     or v_other_row.capabilities->>'feed_capacity_g'<>'20000'
     or v_device_row.capabilities->>'max_clock_uncertainty_ms'<>'1000'
     or v_other_row.capabilities->>'max_clock_uncertainty_ms'<>'1000'
     or v_device_row.capabilities->>'maximum_settling_ms'<>'1000'
     or v_other_row.capabilities->>'maximum_settling_ms'<>'1000'
     or v_device_row.desired_revision is not null or v_device_row.applied_revision is not null
     or v_other_row.desired_revision is not null or v_other_row.applied_revision is not null
     or exists(select 1 from public.device_execution_reservations r where r.device_id in (v_device,v_other_device) and r.phase in ('active','settling'))
     or exists(select 1 from public.feed_sequences s where s.device_id in (v_device,v_other_device) and s.unresolved) then
    raise exception 'approved simulator fixtures are not on the clean ART-33 test baseline';
  end if;
  if v_device_row.last_attempt_status='pending' or v_other_row.last_attempt_status='pending' then
    raise exception 'drain existing simulator configuration revisions before this rollback scenario';
  end if;
  insert into public.device_access(device_id,installation_id,status,revoked_at)
    values (v_device,v_installation,'active',null),(v_other_device,v_installation,'active',null)
    on conflict (device_id,installation_id) do update set status='active',revoked_at=null;

  v_current := public.art33_read_configuration(v_device,v_installation,null);
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next->>'status'<>'ok' or v_next->'timezone'<>'null'::jsonb or v_next->'occurrence'<>'null'::jsonb then
    raise exception 'unconfigured device returned a fabricated next applied occurrence';
  end if;
  select coalesce(desired_revision,0) into v_revision from public.devices where device_id=v_device;
  v_previous_desired := v_revision;
  select requested_snapshot into v_snapshot from public.device_config_revisions
    where device_id=v_device and revision=coalesce(v_device_row.applied_revision,v_device_row.desired_revision);
  if v_snapshot is null then
    v_snapshot := '{"timezone":"UTC","monitoring_limits":{"do_low_mg_l":null,"do_high_mg_l":null},"low_feed_threshold_pct":null,"schedules":[]}'::jsonb;
  else
    v_snapshot := (v_snapshot - array['revision','based_on_revision','schedules']::text[])
      || jsonb_build_object('schedules','[]'::jsonb);
  end if;
  v_invalid := v_snapshot - 'timezone';
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'missing required snapshot key passed validation';
  end if;
  v_invalid := v_snapshot || jsonb_build_object('timezone',null);
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'null required snapshot key passed validation';
  end if;
  v_invalid := jsonb_set(v_snapshot,'{schedules}','null'::jsonb);
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'null schedule list passed validation';
  end if;
  v_invalid := v_snapshot || jsonb_build_object('monitoring_limits',(v_snapshot->'monitoring_limits')-'do_low_mg_l');
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'missing required monitoring limit passed validation';
  end if;
  v_invalid := v_snapshot || jsonb_build_object('unexpected_field',true);
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'additive snapshot field passed validation';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'initial empty full configuration was rejected'; end if;
  v_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'initial empty configuration ACK was rejected'; end if;
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next->>'timezone'<>'UTC' or v_next->'occurrence'<>'null'::jsonb then
    raise exception 'applied empty schedule list did not return occurrence:null';
  end if;
  v_previous_desired := v_revision;
  for v_index in 0..1439 loop
    v_local_time := make_time((v_index/60)::integer,(v_index%60)::integer,0);
    if not exists (select 1 from jsonb_array_elements(v_snapshot->'schedules') s(value)
      where s.value->>'local_time'=to_char(v_local_time,'HH24:MI')
        and exists (select 1 from jsonb_array_elements(s.value->'weekdays') d(value) where d.value::text=v_weekday::text)) then
      exit;
    end if;
  end loop;
  v_snapshot := v_snapshot || jsonb_build_object('schedules',jsonb_build_array(
    jsonb_build_object('schedule_id',v_schedule1,'local_time',to_char(v_local_time,'HH24:MI'),'weekdays',jsonb_build_array(v_weekday),
      'enabled',true,'targets',jsonb_build_array(jsonb_build_object('nozzle_number',1,'dose',jsonb_build_object('mode','grams','amount_g',12)))),
    jsonb_build_object('schedule_id',v_schedule2,'local_time',to_char(v_local_time,'HH24:MI'),'weekdays',jsonb_build_array(v_weekday),
      'enabled',true,'targets',jsonb_build_array(jsonb_build_object('nozzle_number',2,'dose',jsonb_build_object('mode','grams','amount_g',19))))));
  v_status := public.art33_write_configuration(v_device,v_installation,v_request,v_revision,v_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'cross-nozzle simultaneous schedules were rejected: %',v_status; end if;
  v_revision := (v_status#>>'{receipt,revision}')::bigint;
  if v_status#>>'{receipt,snapshot,schedules,0,targets,0,nozzle_number}'<>'1'
     or v_status#>>'{receipt,snapshot,schedules,1,targets,0,nozzle_number}'<>'2' then
    raise exception 'different nozzle targets were not retained in order';
  end if;
  if public.art33_write_configuration(v_device,v_installation,v_request,v_previous_desired,v_snapshot)#>>'{receipt,revision}'<>v_revision::text then
    raise exception 'same request ID did not return the original revision';
  end if;
  v_invalid := jsonb_set(v_snapshot,'{schedules,0,targets,0,dose,amount_g}','13'::jsonb);
  if public.art33_write_configuration(v_device,v_installation,v_request,v_previous_desired,v_invalid)->>'status'<>'idempotency_conflict' then
    raise exception 'a reused request ID accepted a different snapshot';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,v_stale_request,v_previous_desired,v_snapshot);
  if v_status->>'status'<>'conflict' then raise exception 'optimistic concurrency accepted a stale full-snapshot edit'; end if;
  v_current := public.art33_read_configuration(v_device,v_installation,v_request);
  if v_current->>'request_status'<>'pending' or (v_current#>>'{receipt,revision}')::bigint<>v_revision
     or (v_current#>>'{current_state,applied_revision}')::bigint<>v_previous_desired
     or v_current#>'{applied_snapshot,schedules}'<>'[]'::jsonb then
    raise exception 'configuration receipt and applied state are not distinct';
  end if;
  if public.art33_read_configuration(v_device,v_other_installation,null)->>'status'<>'not_active'
     or public.art33_next_applied_occurrence(v_device,v_other_installation)->>'status'<>'not_active' then
    raise exception 'another installation read a protected configuration or next occurrence';
  end if;
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next->'occurrence'<>'null'::jsonb then
    raise exception 'a desired schedule appeared before the device ACK';
  end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'two-nozzle desired snapshot ACK was rejected'; end if;
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if jsonb_array_length(v_next#>'{occurrence,targets}')<>2
     or v_next#>>'{occurrence,targets,0,nozzle_number}'<>'1'
     or v_next#>>'{occurrence,targets,1,nozzle_number}'<>'2'
     or v_next#>>'{occurrence,targets,0,dose,amount_g}'<>'12'
     or v_next#>>'{occurrence,targets,1,dose,amount_g}'<>'19' then
    raise exception 'next occurrence did not use applied sequential nozzle targets and distinct doses';
  end if;
  v_local_date := (v_next#>>'{occurrence,occurrence_local_date}')::date;
  v_due := (v_local_date+v_local_time) at time zone 'UTC';

  if timestamp '2026-11-01 01:30' at time zone 'America/New_York'
       is distinct from timestamptz '2026-11-01 06:30:00+00' then
    raise exception 'DST fold resolution did not use the standard-time later instant';
  end if;
  if ((timestamp '2026-03-08 02:30' at time zone 'America/New_York') at time zone 'America/New_York')
       = timestamp '2026-03-08 02:30' then
    raise exception 'DST gap was treated as a valid local time';
  end if;

  v_event := jsonb_build_object(
    'sequence_id',v_sequence,'event_sequence',1,'event_type','accepted','outcome_status','accepted',
    'source','scheduled','device_at',to_char(v_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'time_quality','synced','command_id',null,'schedule_id',v_schedule1,
    'configuration_revision',v_revision,'occurrence_local_date',v_local_date::text,
    'requested_dose','{"mode":"grams","amount_g":12}'::jsonb,
    'estimated_dispensed_g',null,'measured_dispensed_g',null,'measurement_quality','unavailable',
    'reason_code',null,'maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',1,'step_index',1);
  v_events := jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',2,'event_type','running','outcome_status','running');
  v_events := v_events || jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',3,'event_type','completed','outcome_status','completed',
    'device_at',to_char((v_due+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'estimated_dispensed_g',12,'measured_dispensed_g',12,'measurement_quality','valid');
  v_events := v_events || jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',4,'event_type','accepted','outcome_status','accepted',
    'schedule_id',v_schedule2,'requested_dose','{"mode":"grams","amount_g":19}'::jsonb,
    'estimated_dispensed_g',null,'measured_dispensed_g',null,'measurement_quality','unavailable','nozzle_number',2,'step_index',2);
  v_events := v_events || jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',5,'event_type','running','outcome_status','running');
  v_events := v_events || jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',6,'event_type','completed','outcome_status','completed',
    'device_at',to_char((v_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'estimated_dispensed_g',19,'measured_dispensed_g',19,'measurement_quality','valid');
  v_events := v_events || jsonb_build_array(v_event);
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  if v_event_result->>'status'<>'ok' or jsonb_array_length(v_event_result->'acknowledged_events')<>6 then
    raise exception 'offline two-nozzle schedule history upload failed: %',v_event_result->>'status';
  end if;
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  select count(*) into v_event_count from public.device_events e where e.device_id=v_device and e.sequence_id=v_sequence;
  if v_event_result->>'status'<>'ok' or jsonb_array_length(v_event_result->'acknowledged_events')<>6 or v_event_count<>6
     or (select status from public.feed_sequences where device_id=v_device and sequence_id=v_sequence)<>'completed'
     or exists(select 1 from public.feed_steps f where f.device_id=v_device and f.sequence_id=v_sequence
       and (f.status<>'completed' or f.measurement_quality<>'valid' or f.measured_dispensed_g not in (12,19))) then
    raise exception 'duplicate outbox delivery changed truthful per-nozzle results';
  end if;

  -- A failed operation with a valid final weight still records actual depletion.
  v_bad_date := v_local_date+14;
  v_bad_due := (v_bad_date+v_local_time) at time zone 'UTC';
  v_event := jsonb_build_object(
    'sequence_id',v_failed_sequence,'event_sequence',1,'event_type','accepted','outcome_status','accepted',
    'source','scheduled','device_at',to_char(v_bad_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'time_quality','synced','command_id',null,'schedule_id',v_schedule1,'configuration_revision',v_revision,
    'occurrence_local_date',v_bad_date::text,'requested_dose','{"mode":"grams","amount_g":12}'::jsonb,
    'estimated_dispensed_g',null,'measured_dispensed_g',null,'measurement_quality','unavailable',
    'reason_code',null,'maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',1,'step_index',1);
  v_events := jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',2,'event_type','running','outcome_status','running',
    'device_at',to_char((v_bad_due+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  v_events := v_events || jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',3,'event_type','failed','outcome_status','failed',
    'device_at',to_char((v_bad_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'measured_dispensed_g',11.76,'measurement_quality','valid','reason_code','SIMULATOR_MEASURED_FAILURE');
  v_events := v_events || jsonb_build_array(v_event);
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  if v_event_result->>'status'<>'ok'
     or (select status from public.feed_steps where device_id=v_device and sequence_id=v_failed_sequence and step_index=1)<>'failed'
     or (select measured_dispensed_g from public.feed_steps where device_id=v_device and sequence_id=v_failed_sequence and step_index=1)<>11.76
     or (select measurement_quality from public.feed_steps where device_id=v_device and sequence_id=v_failed_sequence and step_index=1)<>'valid'
     or (select status from public.feed_sequences where device_id=v_device and sequence_id=v_failed_sequence)<>'failed' then
    raise exception 'valid measured depletion on a failed scheduled step was not preserved';
  end if;
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  if v_event_result->>'status'<>'ok' or jsonb_array_length(v_event_result->'acknowledged_events')<>3
     or (select count(*) from public.device_events where device_id=v_device and sequence_id=v_failed_sequence)<>3
     or (select measured_dispensed_g from public.feed_steps where device_id=v_device and sequence_id=v_failed_sequence and step_index=1)<>11.76 then
    raise exception 'failed measured depletion replay must ACK without a second movement';
  end if;
  v_next_after := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next_after#>>'{occurrence,occurrence_local_date}'=v_local_date::text then
    raise exception 'next occurrence ignored the stable IDs consumed for this local date';
  end if;

  v_bad_date := v_local_date+7;
  v_bad_due := (v_bad_date+v_local_time) at time zone 'UTC';
  v_event := jsonb_build_object(
    'sequence_id',v_bad_sequence,'event_sequence',1,'event_type','accepted','outcome_status','accepted',
    'source','scheduled','device_at',to_char(v_bad_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'time_quality','synced','command_id',null,'schedule_id',v_schedule1,'configuration_revision',v_revision,
    'occurrence_local_date',v_bad_date::text,'requested_dose','{"mode":"grams","amount_g":12}'::jsonb,
    'estimated_dispensed_g',null,'measured_dispensed_g',null,'measurement_quality','unavailable',
    'reason_code',null,'maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',1,'step_index',1);
  v_events := jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',2,'event_type','running','outcome_status','running',
    'schedule_id',v_schedule2,'requested_dose','{"mode":"grams","amount_g":19}'::jsonb,
    'device_at',to_char((v_bad_due+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'nozzle_number',2,'step_index',2);
  v_events := v_events || jsonb_build_array(v_event);
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  if v_event_result->>'status'<>'invalid'
     or exists(select 1 from public.feed_sequences where device_id=v_device and sequence_id=v_bad_sequence)
     or exists(select 1 from public.scheduled_occurrences where device_id=v_device and sequence_id=v_bad_sequence)
     or exists(select 1 from public.device_events where device_id=v_device and sequence_id=v_bad_sequence) then
    raise exception 'invalid later event committed a partial schedule batch';
  end if;

  v_edit_snapshot := jsonb_set(v_snapshot,'{schedules,0,local_time}',to_jsonb('08:05'::text));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{schedules,1,local_time}',to_jsonb('08:05'::text));
  v_status := public.art33_write_configuration(v_device,v_installation,v_edit_request,v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'stable-ID schedule edit was rejected'; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next#>>'{occurrence,occurrence_local_date}' is distinct from v_next_after#>>'{occurrence,occurrence_local_date}' then
    raise exception 'desired schedule edit changed the applied occurrence before ACK';
  end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'edited configuration ACK failed'; end if;
  v_next := public.art33_next_applied_occurrence(v_device,v_installation);
  if v_next#>>'{occurrence,occurrence_local_date}'=v_local_date::text or v_next#>>'{occurrence,local_time}'<>'08:05' then
    raise exception 'editing a consumed stable ID bypassed same-day deduplication';
  end if;
  v_revision := v_new_revision;

  v_invalid := jsonb_set(v_edit_snapshot,'{schedules,1,targets,0,nozzle_number}','1'::jsonb);
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'same-nozzle overlapping schedule passed validation';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,v_rejected_request,v_revision,v_invalid);
  if v_status->>'status'<>'rejected' or v_status->>'error_code'<>'VALIDATION_FAILED' then
    raise exception 'invalid schedule revision was not recorded as rejected';
  end if;
  v_invalid_revision := (v_status#>>'{current_state,last_attempt_revision}')::bigint;
  v_current := public.art33_read_configuration(v_device,v_installation,v_rejected_request);
  if v_current->>'request_status'<>'rejected' or v_current->>'request_error_code'<>'VALIDATION_FAILED'
     or (v_current#>>'{current_state,desired_revision}')::bigint<>v_revision
     or (v_current#>>'{current_state,applied_revision}')::bigint<>v_revision then
    raise exception 'rejected request lost its error or prior applied revision';
  end if;
  v_invalid := jsonb_set(v_edit_snapshot,'{schedules,0,schedule_id}',to_jsonb(v_schedule2::text));
  v_invalid := jsonb_set(v_invalid,'{schedules,1,schedule_id}',to_jsonb(v_schedule2::text));
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'identical duplicate schedule IDs passed validation';
  end if;

  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'valid revision after an app rejection was blocked'; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'newer applied revision was rejected'; end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_invalid_revision,'rejected','VALIDATION_FAILED');
  if v_status->>'status'<>'stale'
     or (select applied_revision from public.devices where device_id=v_device) is distinct from v_new_revision
     or (select last_attempt_status from public.devices where device_id=v_device)<>'applied' then
    raise exception 'stale rejected ACK downgraded a newer applied revision';
  end if;
  v_current := public.art33_read_configuration(v_device,v_installation,v_rejected_request);
  if v_current->>'request_status'<>'rejected' or v_current->>'request_error_code'<>'VALIDATION_FAILED'
     or (v_current#>>'{current_state,desired_revision}')::bigint<>v_new_revision then
    raise exception 'original rejected receipt did not resolve after a later revision';
  end if;
  v_revision := v_new_revision;

  v_status := public.art33_write_configuration(v_device,v_installation,v_device_rejected_request,v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'device rejection revision was not admitted'; end if;
  v_invalid_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_invalid_revision,'rejected','CLOCK_UNTRUSTED');
  if v_status->>'status'<>'ok' then raise exception 'valid device rejection ACK failed'; end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_invalid_revision,'rejected','CLOCK_UNTRUSTED');
  if v_status->>'status'<>'ok' then raise exception 'duplicate rejected ACK was not idempotent'; end if;
  v_current := public.art33_read_configuration(v_device,v_installation,v_device_rejected_request);
  if v_current->>'request_status'<>'rejected' or v_current->>'request_error_code'<>'CLOCK_UNTRUSTED' then
    raise exception 'device rejection did not preserve the original request error';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,v_after_reject_request,v_invalid_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'valid edit after device rejection was blocked'; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'configuration did not recover after device rejection'; end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_revision,v_invalid_revision,'rejected','CLOCK_UNTRUSTED');
  if v_status->>'status'<>'stale'
     or (select applied_revision from public.devices where device_id=v_device) is distinct from v_new_revision
     or (select last_attempt_status from public.devices where device_id=v_device)<>'applied' then
    raise exception 'late rejected device ACK overwrote an applied revision';
  end if;
  v_current := public.art33_read_configuration(v_device,v_installation,v_device_rejected_request);
  if v_current->>'request_status'<>'rejected' or (v_current#>>'{current_state,desired_revision}')::bigint<>v_new_revision then
    raise exception 'old device-rejected receipt did not resolve after a later applied revision';
  end if;
  v_revision := v_new_revision;

  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{timezone}',to_jsonb('America/New_York'::text));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{schedules,0,local_time}',to_jsonb('02:30'::text));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{schedules,1,local_time}',to_jsonb('02:30'::text));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{schedules,0,weekdays}',jsonb_build_array(7));
  v_edit_snapshot := jsonb_set(v_edit_snapshot,'{schedules,1,weekdays}',jsonb_build_array(7));
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'DST schedule snapshot was rejected'; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'DST schedule snapshot ACK was rejected'; end if;
  v_revision := v_new_revision;

  v_sequence := gen_random_uuid();
  v_event := jsonb_build_object(
    'sequence_id',v_sequence,'event_sequence',1,'event_type','skipped','outcome_status','skipped',
    'source','scheduled','device_at',null,'time_quality','invalid','command_id',null,'schedule_id',v_schedule1,
    'configuration_revision',v_revision,'occurrence_local_date','2026-03-08',
    'requested_dose','{"mode":"grams","amount_g":12}'::jsonb,
    'estimated_dispensed_g',null,'measured_dispensed_g',null,'measurement_quality','unavailable',
    'reason_code','SIMULATOR_DST_GAP','maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',1,'step_index',1);
  v_events := jsonb_build_array(v_event);
  v_event := v_event || jsonb_build_object('event_sequence',2,'event_type','not_started','outcome_status','not_started',
    'schedule_id',v_schedule2,'requested_dose','{"mode":"grams","amount_g":19}'::jsonb,'nozzle_number',2,'step_index',2);
  v_events := v_events || jsonb_build_array(v_event);
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'invalid',null,'idle',null);
  if v_event_result->>'status'<>'ok'
     or exists(select 1 from public.feed_sequences where device_id=v_device and sequence_id=v_sequence and due_at is not null)
     or exists(select 1 from public.scheduled_occurrences where device_id=v_device and sequence_id=v_sequence and outcome<>'skipped')
     or exists(select 1 from public.feed_sequences where device_id=v_device and sequence_id=v_sequence and status<>'rejected')
     or exists(select 1 from public.feed_steps where device_id=v_device and sequence_id=v_sequence and status<>'not_started')
     or exists(select 1 from public.feed_steps where device_id=v_device and sequence_id=v_sequence and measured_dispensed_g is not null) then
    raise exception 'DST gap skip was not retained without a fabricated UTC actuation time';
  end if;

  -- ART-98: one Both schedule keeps one identity, stores one row and slot per target,
  -- and admits one occurrence with two ordered steps.
  v_both_snapshot := jsonb_set(v_edit_snapshot,'{schedules}',(v_edit_snapshot->'schedules') || jsonb_build_array(
    jsonb_build_object('schedule_id',v_schedule5,'local_time','10:00','weekdays',jsonb_build_array(1),'enabled',true,
      'targets',jsonb_build_array(
        jsonb_build_object('nozzle_number',1,'dose',jsonb_build_object('mode','grams','amount_g',30)),
        jsonb_build_object('nozzle_number',2,'dose',jsonb_build_object('mode','grams','amount_g',45))))));
  v_invalid := jsonb_set(v_both_snapshot,'{schedules,2,targets}',
    jsonb_build_array(v_both_snapshot#>'{schedules,2,targets,1}',v_both_snapshot#>'{schedules,2,targets,0}'));
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'reversed Both targets passed validation';
  end if;
  v_invalid := jsonb_set(jsonb_set(v_both_snapshot,'{schedules,1,local_time}',to_jsonb('10:00'::text)),
    '{schedules,1,weekdays}',jsonb_build_array(1));
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'Both against a single nozzle 2 schedule passed validation';
  end if;
  v_invalid := jsonb_set(v_both_snapshot,'{schedules,2}',((v_both_snapshot#>'{schedules,2}') - 'targets')
    || jsonb_build_object('nozzle_number',1,'dose',jsonb_build_object('mode','grams','amount_g',30)));
  if private.art33_validate_snapshot(v_device,v_invalid) is distinct from 'VALIDATION_FAILED' then
    raise exception 'a legacy scalar schedule passed validation';
  end if;
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_both_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'Both schedule snapshot was rejected: %',v_status; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  if (select count(*) from public.device_config_schedules
        where device_id=v_device and revision=v_new_revision and schedule_id=v_schedule5)<>2
     or (select count(*) from public.device_config_schedule_slots
        where device_id=v_device and revision=v_new_revision and schedule_id=v_schedule5)<>2 then
    raise exception 'Both schedule did not keep one identity with one row and slot per target';
  end if;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'Both schedule ACK was rejected'; end if;
  v_revision := v_new_revision;
  select d::date into v_both_date
    from generate_series((pg_catalog.clock_timestamp() at time zone 'America/New_York')::date+7,
      (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date+13,interval '1 day') d
    where extract(isodow from d)=1;

  -- Cases: 1 proven continuation -> partial; 2 forged device fault and 3 baseline before
  -- actuation -> whole batch invalid; 4 unproven failure followed by nozzle 2 -> invalid;
  -- 5 proven continuation with nozzle 2 failing -> failed.
  for v_case in 1..5 loop
    v_both_sequence := gen_random_uuid();
    v_both_due := ((v_both_date+7*v_case)+time '10:00') at time zone 'America/New_York';
    v_step1 := jsonb_build_object('sequence_id',v_both_sequence,'event_sequence',1,'event_type','accepted','outcome_status','accepted',
      'source','scheduled','device_at',to_char((v_both_due) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'time_quality','synced','command_id',null,'schedule_id',v_schedule5,
      'configuration_revision',v_revision,'occurrence_local_date',(v_both_date+7*v_case)::text,
      'requested_dose','{"mode":"grams","amount_g":30}'::jsonb,'estimated_dispensed_g',null,'measured_dispensed_g',null,
      'measurement_quality','unavailable','reason_code',null,'maintenance_resolution',null,'lockout_cleared',false,
      'nozzle_number',1,'step_index',1);
    v_step2 := v_step1 || jsonb_build_object('requested_dose','{"mode":"grams","amount_g":45}'::jsonb,'nozzle_number',2,'step_index',2);
    v_proof := case when v_case=4 then null else jsonb_build_object('safe_stop',true,'device_fault',v_case=2,
      'baseline_ready_at',case when v_case=3 then to_char((v_both_due) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') else to_char((v_both_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') end) end;
    v_events := jsonb_build_array(v_step1,v_step2 || jsonb_build_object('event_sequence',2),
      v_step1 || jsonb_build_object('event_sequence',3,'event_type','running','outcome_status','running',
        'device_at',to_char((v_both_due+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      v_step1 || jsonb_build_object('event_sequence',4,'event_type','failed','outcome_status','failed',
        'device_at',to_char((v_both_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'measured_dispensed_g',12,'measurement_quality','valid',
        'reason_code','SIMULATOR_RECOVERABLE_FAILURE','continuation_evidence',v_proof),
      v_step2 || jsonb_build_object('event_sequence',5,'event_type','running','outcome_status','running',
        'device_at',to_char((v_both_due+interval '3 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      v_step2 || jsonb_build_object('event_sequence',6,'event_type',case when v_case=5 then 'failed' else 'completed' end,
        'outcome_status',case when v_case=5 then 'failed' else 'completed' end,
        'device_at',to_char((v_both_due+interval '4 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'measured_dispensed_g',44.1,'measurement_quality','valid'));
    v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
      v_events,'synced',0,'idle',null);
    if v_case in (2,3,4) then
      if v_event_result->>'status'<>'invalid'
         or exists(select 1 from public.feed_sequences where device_id=v_device and sequence_id=v_both_sequence)
         or exists(select 1 from public.scheduled_occurrences where device_id=v_device and sequence_id=v_both_sequence) then
        raise exception 'case %: forged or missing continuation proof was accepted: %',v_case,v_event_result;
      end if;
      continue;
    end if;
    if v_event_result->>'status'<>'ok' or jsonb_array_length(v_event_result->'acknowledged_events')<>6
       or (select status from public.feed_sequences where device_id=v_device and sequence_id=v_both_sequence)
         <> (case when v_case=5 then 'failed' else 'partial' end)
       or (select array_agg(status order by step_index) from public.feed_steps
         where device_id=v_device and sequence_id=v_both_sequence)
         <> (array['failed',case when v_case=5 then 'failed' else 'completed' end])
       or (select count(*) from public.scheduled_occurrences where device_id=v_device and sequence_id=v_both_sequence)<>1
       or (select outcome from public.scheduled_occurrences where device_id=v_device and sequence_id=v_both_sequence)
         <> (case when v_case=5 then 'failed' else 'partial' end)
       or (select start_before from public.feed_steps where device_id=v_device and sequence_id=v_both_sequence and step_index=2)
         <>v_both_due+interval '32 seconds'
       or exists(select 1 from public.device_execution_reservations
         where device_id=v_device and sequence_id=v_both_sequence and phase<>'released') then
      raise exception 'case %: proven continuation did not run nozzle 2 once with an all-step outcome: %',v_case,v_event_result;
    end if;
    v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
      v_events,'synced',0,'idle',null);
    if v_event_result->>'status'<>'ok'
       or (select count(*) from public.device_events where device_id=v_device and sequence_id=v_both_sequence)<>6 then
      raise exception 'case %: Both replay was not idempotent',v_case;
    end if;
  end loop;

  -- An unproven nozzle 1 failure finishes Failed; the device's later nozzle 2 not_started is accepted.
  v_both_sequence := gen_random_uuid();
  v_both_due := ((v_both_date+42)+time '10:00') at time zone 'America/New_York';
  v_step1 := v_step1 || jsonb_build_object('sequence_id',v_both_sequence,'device_at',to_char((v_both_due) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'occurrence_local_date',(v_both_date+42)::text);
  v_step2 := v_step1 || jsonb_build_object('requested_dose','{"mode":"grams","amount_g":45}'::jsonb,'nozzle_number',2,'step_index',2);
  v_events := jsonb_build_array(v_step1,v_step2 || jsonb_build_object('event_sequence',2),
    v_step1 || jsonb_build_object('event_sequence',3,'event_type','running','outcome_status','running',
      'device_at',to_char((v_both_due+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    v_step1 || jsonb_build_object('event_sequence',4,'event_type','failed','outcome_status','failed',
      'device_at',to_char((v_both_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'measured_dispensed_g',12,'measurement_quality','valid',
      'reason_code','SIMULATOR_MEASURED_FAILURE'),
    v_step2 || jsonb_build_object('event_sequence',5,'event_type','not_started','outcome_status','not_started',
      'device_at',to_char((v_both_due+interval '2 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'reason_code','SIMULATOR_SEQUENCE_STOPPED'));
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_events,'synced',0,'idle',null);
  if v_event_result->>'status'<>'ok'
     or (select status from public.feed_sequences where device_id=v_device and sequence_id=v_both_sequence)<>'failed'
     or (select array_agg(status order by step_index) from public.feed_steps
       where device_id=v_device and sequence_id=v_both_sequence)<>array['failed','not_started']
     or (select outcome from public.scheduled_occurrences where device_id=v_device and sequence_id=v_both_sequence)<>'failed' then
    raise exception 'an unproven nozzle 1 failure did not stop the Both occurrence: %',v_event_result;
  end if;

  -- Restore the two single schedules for the collision fixture; the Both identity is retired.
  v_status := public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_edit_snapshot);
  if v_status->>'status'<>'ok' then raise exception 'restoring the single schedules was rejected'; end if;
  v_new_revision := (v_status#>>'{receipt,revision}')::bigint;
  v_status := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_new_revision,v_new_revision,'applied',null);
  if v_status->>'status'<>'ok' then raise exception 'restored single-schedule ACK was rejected'; end if;
  v_revision := v_new_revision;

  v_collision_next := public.art33_next_applied_occurrence(v_device,v_installation);
  v_collision_date := (v_collision_next#>>'{occurrence,occurrence_local_date}')::date;
  v_collision_due := (v_collision_date+time '02:30') at time zone 'America/New_York';
  v_targets := v_collision_next#>'{occurrence,targets}';
  if jsonb_array_length(v_targets)<>2 then raise exception 'collision fixture lost its two-nozzle group'; end if;
  insert into public.feed_sequences(device_id,sequence_id,source,installation_id,idempotency_key,request_id,
    target_count,capabilities_revision,due_at,admitted_at,start_before,scheduler_wake_grace_ms,maximum_settling_ms,status,unresolved)
  values(v_device,v_manual_sequence,'manual',v_installation,gen_random_uuid(),gen_random_uuid(),1,
    v_device_row.capabilities_revision,v_collision_due,pg_catalog.clock_timestamp(),v_collision_due+interval '30 seconds',
    30000,1000,'running',true);
  insert into public.feed_sequence_targets(device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number)
    values(v_device,v_manual_sequence,1,1,'{"mode":"grams","amount_g":7}'::jsonb,1,1);
  insert into public.feed_steps(device_id,sequence_id,step_index,nozzle_number,requested_dose,status,measurement_quality,start_before,started_at)
    values(v_device,v_manual_sequence,1,1,'{"mode":"grams","amount_g":7}'::jsonb,'running','unavailable',
      v_collision_due+interval '30 seconds',v_collision_due);
  insert into public.device_execution_reservations(device_id,sequence_id,phase)
    values(v_device,v_manual_sequence,'active');
  v_event := jsonb_build_object(
    'sequence_id',v_collision_sequence,'event_sequence',1,'event_type','skipped','outcome_status','skipped',
    'source','scheduled','device_at',to_char(v_collision_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'time_quality','synced','command_id',null,'schedule_id',v_targets->0->>'schedule_id',
    'configuration_revision',v_revision,'occurrence_local_date',v_collision_date::text,
    'requested_dose',v_targets->0->'dose','estimated_dispensed_g',null,'measured_dispensed_g',null,
    'measurement_quality','unavailable','reason_code','SIMULATOR_COLLISION_MANUAL',
    'maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',1,'step_index',1);
  v_collision_events := jsonb_build_array(v_event);
  v_event := jsonb_build_object(
    'sequence_id',v_collision_sequence,'event_sequence',2,'event_type','not_started','outcome_status','not_started',
    'source','scheduled','device_at',to_char(v_collision_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'time_quality','synced','command_id',null,'schedule_id',v_targets->1->>'schedule_id',
    'configuration_revision',v_revision,'occurrence_local_date',v_collision_date::text,
    'requested_dose',v_targets->1->'dose','estimated_dispensed_g',null,'measured_dispensed_g',null,
    'measurement_quality','unavailable','reason_code','SIMULATOR_COLLISION_MANUAL',
    'maintenance_resolution',null,'lockout_cleared',false,'nozzle_number',2,'step_index',2);
  v_collision_events := v_collision_events || jsonb_build_array(v_event);
  v_event_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    v_collision_events,'synced',0,'feeding',v_manual_sequence);
  if v_event_result->>'status'<>'ok'
     or exists(select 1 from public.device_execution_reservations where device_id=v_device and sequence_id=v_collision_sequence)
     or not exists(select 1 from public.device_execution_reservations where device_id=v_device and sequence_id=v_manual_sequence and phase='active')
     or exists(select 1 from public.scheduled_occurrences where device_id=v_device and sequence_id=v_collision_sequence and outcome<>'skipped')
     or exists(select 1 from public.feed_steps where device_id=v_device and sequence_id=v_collision_sequence and status<>'not_started') then
    raise exception 'manual collision was not a durable skip without a competing reservation';
  end if;

  update public.device_access set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where device_id=v_device and installation_id=v_installation;
  if public.art33_read_configuration(v_device,v_installation,null)->>'status'<>'not_active'
     or public.art33_write_configuration(v_device,v_installation,gen_random_uuid(),v_revision,v_edit_snapshot)->>'status'<>'not_active' then
    raise exception 'revoked membership retained protected configuration access';
  end if;

  select coalesce(desired_revision,0) into v_revision from public.devices where device_id=v_other_device;
  select requested_snapshot into v_snapshot from public.device_config_revisions
    where device_id=v_other_device and revision=coalesce(v_other_row.applied_revision,v_other_row.desired_revision);
  if v_snapshot is null then
    v_snapshot := '{"timezone":"UTC","monitoring_limits":{"do_low_mg_l":null,"do_high_mg_l":null},"low_feed_threshold_pct":null,"schedules":[]}'::jsonb;
  else
    v_snapshot := (v_snapshot - array['revision','based_on_revision','schedules']::text[])
      || jsonb_build_object('schedules','[]'::jsonb);
  end if;
  v_snapshot := v_snapshot || jsonb_build_object('schedules',jsonb_build_array(
    jsonb_build_object('schedule_id',v_schedule3,'local_time','12:00','weekdays',jsonb_build_array(1),
      'enabled',true,'targets',jsonb_build_array(jsonb_build_object('nozzle_number',1,'dose',jsonb_build_object('mode','grams','amount_g',12)))),
    jsonb_build_object('schedule_id',v_schedule4,'local_time','12:00','weekdays',jsonb_build_array(1),
      'enabled',true,'targets',jsonb_build_array(jsonb_build_object('nozzle_number',1,'dose',jsonb_build_object('mode','grams','amount_g',20))))));
  v_invalid := public.art33_write_configuration(v_other_device,v_installation,v_invalid_request,v_revision,v_snapshot);
  if v_invalid->>'status'<>'rejected' or v_invalid->>'error_code'<>'VALIDATION_FAILED' then
    raise exception 'same-nozzle overlapping schedule was accepted';
  end if;
  if (select desired_revision from public.devices where device_id=v_other_device) is distinct from nullif(v_revision,0) then
    raise exception 'invalid schedule advanced desired revision';
  end if;
  v_snapshot := (v_snapshot - 'schedules') || jsonb_build_object('schedules','[]'::jsonb,'unexpected_field',true);
  v_invalid := public.art33_write_configuration(v_other_device,v_installation,v_additive_request,v_revision,v_snapshot);
  if v_invalid->>'status'<>'rejected' or v_invalid->>'error_code'<>'VALIDATION_FAILED'
     or (select desired_revision from public.devices where device_id=v_other_device) is distinct from nullif(v_revision,0) then
    raise exception 'additive configuration fields were accepted or advanced desired revision';
  end if;

  v_status := public.art33_device_configuration_report(v_device,repeat('0',64),null,null,null,null);
  if v_status->>'status'<>'auth_required' then raise exception 'configuration ACK accepted an unauthenticated device'; end if;
  v_status := public.art33_record_scheduled_events(v_device,repeat('0',64),'[]'::jsonb,'invalid',null,'idle',null);
  if v_status->>'status'<>'auth_required' then raise exception 'scheduled event sync accepted an unauthenticated device'; end if;
end $$;

reset role;
update private.device_credentials set revoked_at=pg_catalog.clock_timestamp()
  where device_id='22222222-2222-4222-8222-222222222222'::uuid and revoked_at is null;
do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_result jsonb;
begin
  v_result := public.art33_device_configuration_report(v_device,current_setting('art33_test.primary_verifier_hex',true),
    1,1,'applied',null);
  if v_result->>'status'<>'auth_required' then raise exception 'revoked verifier retained configuration ACK access'; end if;
  v_result := public.art33_record_scheduled_events(v_device,current_setting('art33_test.primary_verifier_hex',true),
    '[]'::jsonb,'synced',0,'idle',null);
  if v_result->>'status'<>'auth_required' then raise exception 'revoked verifier retained schedule event upload access'; end if;
end $$;
set constraints all immediate;
rollback;
