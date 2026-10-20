\set ON_ERROR_STOP on
-- ART-95 acceptance. Run only on a quiescent, isolated, owner-approved
-- PostgreSQL clone after the additive migration. Reserved simulator devices
-- 222/333 must have fresh alert history; this test refuses existing facts and
-- never overwrites or deletes unrelated history. Every fixture mutation rolls
-- back at the end.
begin;
set constraints all deferred;

do $$
begin
  if exists (
    select 1 from public.alert_events
    where device_id in (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    )
  ) then
    raise exception 'ART-95 acceptance requires fresh alert history for reserved simulator devices 222/333';
  end if;
end $$;

do $$
begin
  if not has_function_privilege('service_role','public.art95_list_alert_events(uuid,uuid,timestamptz,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.art95_set_alert_event_state(uuid,uuid,uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art95_bulk_alert_event_state(uuid,uuid,text,timestamptz,uuid)','EXECUTE')
    or has_function_privilege('anon','public.art95_list_alert_events(uuid,uuid,timestamptz,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.art95_list_alert_events(uuid,uuid,timestamptz,uuid)','EXECUTE')
    or has_function_privilege('anon','public.art95_set_alert_event_state(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.art95_set_alert_event_state(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.art95_bulk_alert_event_state(uuid,uuid,text,timestamptz,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.art95_bulk_alert_event_state(uuid,uuid,text,timestamptz,uuid)','EXECUTE') then
    raise exception 'ART-95 service RPC grants are not service_role-only';
  end if;
  if has_function_privilege('service_role','private.art95_evaluate_alert_crossings()','EXECUTE')
    or has_table_privilege('service_role','private.device_alert_state','SELECT')
    or has_table_privilege('service_role','private.installation_alert_event_state','SELECT')
    or has_table_privilege('service_role','private.installation_alert_bulk_state','SELECT') then
    raise exception 'private alert helpers and preference tables must remain private';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.alert_events'::regclass)
    or has_table_privilege('anon','public.alert_events','SELECT')
    or not has_table_privilege('authenticated','public.alert_events','SELECT')
    or has_table_privilege('authenticated','public.alert_events','TRUNCATE')
    or has_table_privilege('authenticated','public.alert_events','INSERT')
    or has_table_privilege('authenticated','public.alert_events','UPDATE')
    or has_table_privilege('authenticated','public.alert_events','DELETE') then
    raise exception 'alert_events must expose RLS-protected SELECT only';
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.alert_events'::regclass and contype='u'
        and pg_catalog.pg_get_constraintdef(oid) like '%device_id, boot_id, sample_sequence, alert_kind%')
    or not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.alert_events'::regclass and contype='c'
        and pg_catalog.pg_get_constraintdef(oid) like '%metric_value%') then
    raise exception 'alert event sample uniqueness and finite value constraints are required';
  end if;
  if not exists(select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='alert_events')
    or exists(select 1 from pg_catalog.pg_publication_tables where schemaname='private') then
    raise exception 'Realtime must include only approved public state and no private table';
  end if;
end $$;

do $$
begin
  if exists(select 1 from auth.users where id in (
      '51515151-5151-4151-8151-515151515151'::uuid,
      '52525252-5252-4252-8252-525252525252'::uuid,
      '53535353-5353-4353-8353-535353535353'::uuid)
      and email not in ('art95-install-a@invalid.example','art95-install-b@invalid.example','art95-install-c@invalid.example')) then
    raise exception 'ART-95 fixture installation UUID is already owned by an unrelated auth user';
  end if;
end $$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000','51515151-5151-4151-8151-515151515151',
   'authenticated','authenticated','art95-install-a@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true),
  ('00000000-0000-0000-0000-000000000000','52525252-5252-4252-8252-525252525252',
   'authenticated','authenticated','art95-install-b@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true),
  ('00000000-0000-0000-0000-000000000000','53535353-5353-4353-8353-535353535353',
   'authenticated','authenticated','art95-install-c@invalid.example','',pg_catalog.clock_timestamp(),
   '{"provider":"email","providers":["email"]}','{}',true)
on conflict (id) do nothing;

set local role postgres;
do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_second_device constant uuid := '33333333-3333-4333-8333-333333333333';
  v_install_a constant uuid := '51515151-5151-4151-8151-515151515151';
  v_install_b constant uuid := '52525252-5252-4252-8252-525252525252';
  v_install_c constant uuid := '53535353-5353-4353-8353-535353535353';
  v_boot constant uuid := '61000000-0000-4000-8000-000000000001';
  v_second_boot constant uuid := '61000000-0000-4000-8000-000000000002';
  v_credential constant text := repeat('a',64);
  v_second_credential constant text := repeat('b',64);
  v_verifier text;
  v_second_verifier text;
  v_device_row public.devices%rowtype;
  v_second_row public.devices%rowtype;
  v_current jsonb;
  v_snapshot jsonb;
  v_result jsonb;
  v_sample jsonb;
  v_page jsonb;
  v_item jsonb;
  v_case record;
  v_seq bigint := 0;
  v_live bigint;
  v_second_live bigint;
  v_applied bigint;
  v_pending bigint;
  v_second_applied bigint;
  v_low_count bigint;
  v_feed_count bigint;
  v_high_count bigint;
  v_event_count bigint;
  v_old_pointer_boot uuid;
  v_old_pointer_sequence bigint;
  v_event uuid;
  v_cutoff_at timestamptz;
  v_cutoff_id uuid;
  v_new_event uuid;
  v_failed boolean;
  v_index integer;
begin
  v_result := public.art38_provision_simulated_device(v_device,v_credential,true);
  if v_result->>'status' not in ('provisioned','already_provisioned') then
    raise exception 'primary simulator fixture unavailable: %',v_result;
  end if;
  v_result := public.art38_provision_simulated_device(v_second_device,v_second_credential,true);
  if v_result->>'status' not in ('provisioned','already_provisioned') then
    raise exception 'second simulator fixture unavailable: %',v_result;
  end if;
  insert into public.device_access(device_id,installation_id,status,revoked_at)
  values
    (v_device,v_install_a,'active',null),
    (v_device,v_install_b,'active',null),
    (v_device,v_install_c,'active',null),
    (v_second_device,v_install_a,'active',null)
  on conflict (device_id,installation_id) do update set status='active',revoked_at=null;
  select encode(c.credential_verifier,'hex') into v_verifier
    from private.device_credentials c where c.device_id=v_device and c.revoked_at is null;
  select encode(c.credential_verifier,'hex') into v_second_verifier
    from private.device_credentials c where c.device_id=v_second_device and c.revoked_at is null;
  if v_verifier is null or v_second_verifier is null then
    raise exception 'simulator verifier material unavailable';
  end if;
  select coalesce(live_sequence,0) into v_live from public.device_state where device_id=v_device;
  select coalesce(live_sequence,0) into v_second_live from public.device_state where device_id=v_second_device;
  v_live := coalesce(v_live,0);
  v_seq := v_live;
  v_second_live := coalesce(v_second_live,0);
  select * into v_device_row from public.devices where device_id=v_device for update;
  if not found or not v_device_row.is_simulated or v_device_row.applied_revision is null
     or v_device_row.desired_revision is distinct from v_device_row.applied_revision
     or v_device_row.last_attempt_status='pending'
     or exists(select 1 from public.device_execution_reservations r where r.device_id=v_device and r.phase in ('active','settling'))
     or exists(select 1 from public.feed_sequences s where s.device_id=v_device and s.unresolved) then
    raise exception 'primary simulator must start on an applied, idle configuration baseline';
  end if;

  v_current := public.art33_read_configuration(v_device,v_install_a,null);
  if v_current->>'status'<>'ok' or v_current->'applied_snapshot' is null then
    raise exception 'primary applied snapshot unavailable';
  end if;
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}','4'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_high_mg_l}','8'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{low_feed_threshold_pct}','20'::jsonb);
  v_result := public.art33_write_configuration(v_device,v_install_a,gen_random_uuid(),v_device_row.desired_revision,v_snapshot);
  if v_result->>'status'<>'ok' or v_result#>>'{current_state,last_attempt_status}'<>'pending'
     or v_result#>>'{receipt,revision}' is null then
    raise exception 'test limits were not admitted: %',v_result;
  end if;
  v_applied := (v_result#>>'{current_state,applied_revision}')::bigint;
  v_pending := (v_result#>>'{receipt,revision}')::bigint;
  v_result := public.art33_device_configuration_report(v_device,v_verifier,v_pending,v_pending,'applied',null);
  if v_result->>'status'<>'ok' then raise exception 'test limits were not applied: %',v_result; end if;
  select * into v_device_row from public.devices where device_id=v_device;
  if v_device_row.applied_revision<>v_pending then raise exception 'applied revision did not advance'; end if;
  v_applied := v_pending;

  -- A pending desired threshold of 6 must not replace the applied threshold of 4.
  v_current := public.art33_read_configuration(v_device,v_install_a,null);
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}','6'::jsonb);
  v_result := public.art33_write_configuration(v_device,v_install_a,gen_random_uuid(),v_applied,v_snapshot);
  if v_result->>'status'<>'ok' or v_result#>>'{current_state,last_attempt_status}'<>'pending'
     or v_result#>>'{receipt,revision}' is null then
    raise exception 'desired-only threshold was not pending: %',v_result;
  end if;
  v_pending := (v_result#>>'{receipt,revision}')::bigint;
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',5.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  if v_result->>'status'<>'ok' or exists(select 1 from public.alert_events where device_id=v_device and alert_kind='do_low') then
    raise exception 'pending desired limit raised an alert before device apply';
  end if;
  v_result := public.art33_device_configuration_report(v_device,v_verifier,v_applied,v_pending,'rejected','VALIDATION_FAILED');
  if v_result->>'status'<>'ok' then raise exception 'rejected configuration report failed: %',v_result; end if;
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','synced',
    'do_mg_l',5.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  select * into v_device_row from public.devices where device_id=v_device;
  if v_result->>'status'<>'ok' or v_device_row.applied_revision<>v_applied
     or exists(select 1 from public.alert_events where device_id=v_device and alert_kind='do_low') then
    raise exception 'rejected desired threshold became applied or raised an alert';
  end if;

  -- Actual fresh pointer promotions drive the crossing state machine.
  for v_case in
    select * from (values
      ('baseline-inside'::text,5.0::numeric,'valid'::text,40.0::numeric,'valid'::text,'rtc'::text,0,0,0),
      ('low-crossing',3.0,'valid',40.0,'valid','synced',0,1,0),
      ('sustained-outside',2.8,'valid',40.0,'valid','rtc',0,1,0),
      ('equality-clears',4.0,'valid',40.0,'valid','rtc',0,1,0),
      ('inside',5.0,'valid',40.0,'valid','rtc',0,1,0),
      ('re-crossing',3.0,'valid',40.0,'valid','rtc',0,2,0),
      ('invalid-do-does-not-clear',null::numeric,'error',40.0,'valid','rtc',0,2,0),
      ('untrusted-inside-does-not-clear',4.1,'valid',40.0,'valid','invalid',0,2,0),
      ('valid-outside-after-untrusted',3.0,'valid',40.0,'valid','rtc',0,2,0),
      ('equality-before-stale',4.0,'valid',40.0,'valid','rtc',0,2,0),
      ('stale-outside-do-not-raise',3.0,'valid',40.0,'valid','rtc',31,2,0),
      ('fresh-after-stale',3.0,'valid',40.0,'valid','rtc',0,3,0),
      ('equality-before-future',4.0,'valid',40.0,'valid','rtc',0,3,0),
      ('future-outside-do-not-raise',3.0,'valid',40.0,'valid','rtc',-60,3,0),
      ('fresh-after-future',3.0,'valid',40.0,'valid','rtc',0,4,0),
      ('equality-before-mixed-quality',4.0,'valid',40.0,'valid','rtc',0,4,0),
      ('mixed-invalid-do-valid-feed',null::numeric,'error',10.0,'valid','rtc',0,4,1),
      ('invalid-feed-does-not-clear',4.0,'valid',null::numeric,'error','rtc',0,4,1),
      ('feed-outside-still-active',4.0,'valid',10.0,'valid','rtc',0,4,1),
      ('feed-equality-clears',4.0,'valid',20.0,'valid','rtc',0,4,1),
      ('feed-stale-do-not-raise',4.0,'valid',10.0,'valid','rtc',31,4,1),
      ('feed-fresh-after-stale',4.0,'valid',10.0,'valid','rtc',0,4,2),
      ('feed-equality-before-future',4.0,'valid',20.0,'valid','rtc',0,4,2),
      ('feed-future-do-not-raise',4.0,'valid',10.0,'valid','rtc',-60,4,2),
      ('feed-fresh-after-future',4.0,'valid',10.0,'valid','rtc',0,4,3),
      ('do-new-crossing',3.0,'valid',40.0,'valid','rtc',0,5,3),
      ('invalid-time-inside-do-does-not-clear',4.1,'valid',40.0,'valid','invalid',0,5,3),
      ('valid-do-still-outside',3.0,'valid',40.0,'valid','rtc',0,5,3)
    ) as scenario(name,do_value,do_quality,feed_value,feed_quality,time_quality,age_seconds,expected_low,expected_feed)
  loop
    v_seq := v_seq+1; v_live := v_live+1;
    v_sample := jsonb_build_object(
      'sequence',v_seq,
      'measured_at',case when v_case.time_quality='invalid' then null
        else pg_catalog.clock_timestamp()-pg_catalog.make_interval(secs=>v_case.age_seconds) end,
      'time_quality',v_case.time_quality,
      'do_mg_l',v_case.do_value,'do_quality',v_case.do_quality,
      'feed_remaining_g',case when v_case.feed_quality='error' then null else 400 end,
      'feed_percent',v_case.feed_value,'feed_quality',v_case.feed_quality,
      'calibration_revision',case when v_case.feed_quality='error' then null else 2 end
    );
    v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
    if v_result->>'status'<>'ok' then raise exception 'telemetry scenario % failed: %',v_case.name,v_result; end if;
    select count(*) into v_low_count from public.alert_events where device_id=v_device and alert_kind='do_low';
    select count(*) into v_feed_count from public.alert_events where device_id=v_device and alert_kind='feed_low';
    if v_low_count<>v_case.expected_low or v_feed_count<>v_case.expected_feed then
      raise exception 'crossing scenario % produced counts do_low=% feed_low=%',v_case.name,v_low_count,v_feed_count;
    end if;
  end loop;

  -- Invalid payloads cannot mutate the promoted pointer or clear active state.
  select count(*) into v_event_count from public.alert_events where device_id=v_device;
  select latest_telemetry_boot_id,latest_telemetry_sequence
    into v_old_pointer_boot,v_old_pointer_sequence
    from public.device_state where device_id=v_device;
  v_failed := false;
  begin
    v_seq := v_seq+1; v_live := v_live+1;
    v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,
      jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
        'do_mg_l','not-a-number','do_quality','valid','feed_remaining_g',400,'feed_percent',40,
        'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
  v_failed := coalesce(v_result->>'status','')<>'ok';
  exception when others then
    v_failed := true;
  end;
  if not v_failed
     or (select count(*) from public.alert_events where device_id=v_device)<>v_event_count
     or (select latest_telemetry_boot_id from public.device_state where device_id=v_device) is distinct from v_old_pointer_boot
     or (select latest_telemetry_sequence from public.device_state where device_id=v_device) is distinct from v_old_pointer_sequence then
    raise exception 'malformed telemetry changed alert history or the live pointer';
  end if;

  -- A null applied limit resets the crossing even on a low fresh sample.
  v_current := public.art33_read_configuration(v_device,v_install_a,null);
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}','null'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{low_feed_threshold_pct}','null'::jsonb);
  select * into v_device_row from public.devices where device_id=v_device;
  v_result := public.art33_write_configuration(v_device,v_install_a,gen_random_uuid(),v_device_row.desired_revision,v_snapshot);
  if v_result->>'status'<>'ok' or v_result#>>'{current_state,last_attempt_status}'<>'pending'
     or v_result#>>'{receipt,revision}' is null then
    raise exception 'disabling limits was not admitted: %',v_result;
  end if;
  v_pending := (v_result#>>'{receipt,revision}')::bigint;
  v_result := public.art33_device_configuration_report(v_device,v_verifier,v_pending,v_pending,'applied',null);
  if v_result->>'status'<>'ok' then raise exception 'disabled limits were not applied: %',v_result; end if;
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',3.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',10,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  if v_result->>'status'<>'ok'
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='do_low')<>5
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='feed_low')<>3 then
    raise exception 'disabled limits generated a crossing instead of resetting state';
  end if;

  -- Re-enable; the same outside sample is a fresh crossing after reset.
  v_current := public.art33_read_configuration(v_device,v_install_a,null);
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}','4'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{low_feed_threshold_pct}','20'::jsonb);
  select * into v_device_row from public.devices where device_id=v_device;
  v_result := public.art33_write_configuration(v_device,v_install_a,gen_random_uuid(),v_device_row.desired_revision,v_snapshot);
  if v_result->>'status'<>'ok' or v_result#>>'{current_state,last_attempt_status}'<>'pending'
     or v_result#>>'{receipt,revision}' is null then
    raise exception 're-enabling limits was not admitted: %',v_result;
  end if;
  v_pending := (v_result#>>'{receipt,revision}')::bigint;
  v_result := public.art33_device_configuration_report(v_device,v_verifier,v_pending,v_pending,'applied',null);
  if v_result->>'status'<>'ok' then raise exception 're-enabled limits were not applied: %',v_result; end if;
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',3.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',10,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  if v_result->>'status'<>'ok'
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='do_low')<>6
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='feed_low')<>4 then
    raise exception 're-enabled limits did not create one fresh crossing per kind';
  end if;

  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',9.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',9.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',8.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  v_seq := v_seq+1; v_live := v_live+1;
  v_sample := jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
    'do_mg_l',9.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2);
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  if v_result->>'status'<>'ok'
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='do_high')<>2 then
    raise exception 'DO high sustained/equality/re-cross sequence did not produce two crossings';
  end if;

  -- One fresh event per equality clear / outside transition; repeated IDs do not duplicate facts.
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,v_sample,'[]'::jsonb);
  if v_result->>'status'<>'ok' or (select count(*) from public.alert_events where device_id=v_device and alert_kind='do_low')<>6 then
    raise exception 'replayed promoted sample created another server alert';
  end if;
  -- Backlog insertion plus contact advancement is not a promotion evaluation point.
  v_live := v_live+1;
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,null,
    jsonb_build_array(jsonb_build_object('boot_id',v_boot,'sequence',v_seq+1,'measured_at',pg_catalog.clock_timestamp(),
      'time_quality','rtc','do_mg_l',2.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',10,
      'feed_quality','valid','calibration_revision',2)));
  if v_result->>'status'<>'ok'
     or (select count(*) from public.alert_events where device_id=v_device and alert_kind='do_low')<>6
     or (select latest_telemetry_sequence from public.device_state where device_id=v_device) is distinct from v_seq then
    raise exception 'backlog row or routine contact advanced the alert pointer';
  end if;
  v_seq := v_seq+1;

  -- Second device: missing applied config cannot evaluate; restoring it allows its own crossing.
  select * into v_second_row from public.devices where device_id=v_second_device for update;
  if not found or v_second_row.applied_revision is null
     or v_second_row.desired_revision is distinct from v_second_row.applied_revision
     or v_second_row.last_attempt_status='pending' then
    raise exception 'second device baseline lacks a settled applied revision';
  end if;
  v_current := public.art33_read_configuration(v_second_device,v_install_a,null);
  if v_current->>'status'<>'ok' or v_current->'applied_snapshot' is null then
    raise exception 'second device applied snapshot unavailable';
  end if;
  v_snapshot := (v_current->'applied_snapshot') - array['revision','based_on_revision']::text[];
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_low_mg_l}','4'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{monitoring_limits,do_high_mg_l}','8'::jsonb);
  v_snapshot := jsonb_set(v_snapshot,'{low_feed_threshold_pct}','20'::jsonb);
  v_result := public.art33_write_configuration(v_second_device,v_install_a,gen_random_uuid(),v_second_row.desired_revision,v_snapshot);
  if v_result->>'status'<>'ok' or v_result#>>'{current_state,last_attempt_status}'<>'pending'
     or v_result#>>'{receipt,revision}' is null then
    raise exception 'second device test limits were not admitted: %',v_result;
  end if;
  v_second_applied := (v_result#>>'{receipt,revision}')::bigint;
  v_result := public.art33_device_configuration_report(v_second_device,v_second_verifier,
    v_second_applied,v_second_applied,'applied',null);
  if v_result->>'status'<>'ok' then raise exception 'second device test limits were not applied: %',v_result; end if;
  update public.devices set applied_revision=null where device_id=v_second_device;
  v_second_live := v_second_live+1;
  v_result := public.art27_sync_telemetry(v_second_device,v_second_credential,v_second_boot,v_second_live,
    jsonb_build_object('sequence',v_second_live,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
      'do_mg_l',0.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
  if v_result->>'status'<>'ok' or exists(select 1 from public.alert_events where device_id=v_second_device) then
    raise exception 'missing applied configuration created an alert';
  end if;
  update public.devices set applied_revision=v_second_applied where device_id=v_second_device;
  v_second_live := v_second_live+1;
  v_result := public.art27_sync_telemetry(v_second_device,v_second_credential,v_second_boot,v_second_live,
    jsonb_build_object('sequence',v_second_live,'measured_at',pg_catalog.clock_timestamp(),'time_quality','synced',
      'do_mg_l',0.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
  if v_result->>'status'<>'ok' or (select count(*) from public.alert_events where device_id=v_second_device and alert_kind='do_low')<>1 then
    raise exception 'second device crossing did not create its independent fact';
  end if;

  -- Generate >50 valid alternating crossings to check bounded stable pagination.
  for v_index in 1..45 loop
    v_seq := v_seq+1; v_live := v_live+1;
    v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,
      jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
        'do_mg_l',4.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
    if v_result->>'status'<>'ok' then raise exception 'pagination clear sample failed'; end if;
    v_seq := v_seq+1; v_live := v_live+1;
    v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,
      jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
        'do_mg_l',3.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
    if v_result->>'status'<>'ok' then raise exception 'pagination crossing sample failed'; end if;
  end loop;
  v_page := public.art95_list_alert_events(v_device,v_install_a,null,null);
  if v_page->>'status'<>'ok' or jsonb_array_length(v_page->'events')<>51 or v_page->'has_more'<>'true'::jsonb then
    raise exception 'history page must return 51 rows for a bounded 50-row page with lookahead';
  end if;
  v_item := v_page->'events'->49;
  v_result := public.art95_list_alert_events(v_device,v_install_a,(v_item->>'raised_at')::timestamptz,(v_item->>'event_id')::uuid);
  if v_result->>'status'<>'ok' or exists(
      select 1 from jsonb_array_elements(v_result->'events') as event_rows(item)
      where (item->>'raised_at')::timestamptz > (v_item->>'raised_at')::timestamptz
        or ((item->>'raised_at')::timestamptz=(v_item->>'raised_at')::timestamptz and (item->>'event_id')::uuid >= (v_item->>'event_id')::uuid)) then
    raise exception 'history cursor did not preserve descending stable timestamp/id order';
  end if;

  -- One installation's event preferences cannot modify shared facts or another installation.
  v_item := v_page->'events'->0;
  v_event := (v_item->>'event_id')::uuid;
  v_cutoff_at := (v_item->>'raised_at')::timestamptz;
  v_cutoff_id := v_event;
  v_result := public.art95_set_alert_event_state(v_device,v_event,v_install_a,'read');
  if v_result->>'status'<>'ok' or v_result->>'is_read'<>'true' then raise exception 'installation read action failed'; end if;
  v_page := public.art95_list_alert_events(v_device,v_install_a,null,null);
  select item into v_item from jsonb_array_elements(v_page->'events') as event_rows(item)
    where item->>'event_id'=v_event::text;
  if v_item is null or v_item->>'is_read'<>'true' or v_item ? 'read_at' then raise exception 'read state is missing or leaks its private timestamp'; end if;
  v_page := public.art95_list_alert_events(v_device,v_install_b,null,null);
  select item into v_item from jsonb_array_elements(v_page->'events') as event_rows(item)
    where item->>'event_id'=v_event::text;
  if v_item is null or v_item->>'is_read'<>'false' then raise exception 'second installation inherited another installation read state'; end if;
  v_result := public.art95_set_alert_event_state(v_device,v_event,v_install_a,'dismiss');
  if v_result->>'status'<>'ok' or v_result->>'is_dismissed'<>'true' then raise exception 'installation dismiss action failed'; end if;
  v_page := public.art95_list_alert_events(v_device,v_install_a,null,null);
  if exists(select 1 from jsonb_array_elements(v_page->'events') as event_rows(item) where item->>'event_id'=v_event::text)
     or not exists(select 1 from public.alert_events where event_id=v_event) then
    raise exception 'dismissal must hide only the installation view and preserve the immutable fact';
  end if;
  v_page := public.art95_list_alert_events(v_device,v_install_b,null,null);
  if not exists(select 1 from jsonb_array_elements(v_page->'events') as event_rows(item) where item->>'event_id'=v_event::text) then
    raise exception 'another installation lost a shared alert fact after dismissal';
  end if;

  -- Capture a bulk cutoff, create a newer crossing, and confirm the captured action leaves it alone.
  v_seq := v_seq+1; v_live := v_live+1;
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,
    jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
      'do_mg_l',4.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
  v_seq := v_seq+1; v_live := v_live+1;
  v_result := public.art27_sync_telemetry(v_device,v_credential,v_boot,v_live,
    jsonb_build_object('sequence',v_seq,'measured_at',pg_catalog.clock_timestamp(),'time_quality','rtc',
      'do_mg_l',3.0,'do_quality','valid','feed_remaining_g',400,'feed_percent',40,'feed_quality','valid','calibration_revision',2),'[]'::jsonb);
  select event_id into v_new_event from public.alert_events
    where device_id=v_device and alert_kind='do_low' order by raised_at desc,event_id desc limit 1;
  if v_new_event is null or v_new_event=v_cutoff_id then raise exception 'new crossing was not created after captured cutoff'; end if;
  v_result := public.art95_bulk_alert_event_state(v_device,v_install_a,'dismiss',v_cutoff_at,v_cutoff_id);
  if v_result->>'status'<>'ok' then raise exception 'captured bulk dismissal failed: %',v_result; end if;
  v_page := public.art95_list_alert_events(v_device,v_install_a,null,null);
  if jsonb_array_length(v_page->'events')<>1
     or v_page#>>'{events,0,event_id}'<>v_new_event::text
     or v_page#>>'{events,0,is_read}'<>'false'
     or v_page->>'unread_count'<>'1' then
    raise exception 'newer event was included in the captured bulk cutoff';
  end if;
  v_page := public.art95_list_alert_events(v_device,v_install_c,null,null);
  if v_page->>'status'<>'ok' or coalesce((v_page->>'unread_count')::integer,0)<2 then
    raise exception 'new installation did not receive a fresh local unread count';
  end if;
  if not exists(select 1 from jsonb_array_elements(v_page->'events') as event_rows(item)
      where item->>'event_id'=v_event::text and item->>'is_read'='false') then
    raise exception 'new installation did not receive independent default preferences';
  end if;

  -- Revoke membership and prove every privileged operation rechecks it.
  update public.device_access set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where device_id=v_device and installation_id=v_install_b;
  if public.art95_list_alert_events(v_device,v_install_b,null,null)->>'status'<>'not_active'
     or public.art95_set_alert_event_state(v_device,v_event,v_install_b,'read')->>'status'<>'not_active'
     or public.art95_bulk_alert_event_state(v_device,v_install_b,'mark_read',v_cutoff_at,v_cutoff_id)->>'status'<>'not_active' then
    raise exception 'revoked installation retained alert history/action access';
  end if;

  begin
    update public.alert_events set metric_value=metric_value+1 where event_id=v_event;
    raise exception 'immutable alert fact unexpectedly accepted an update';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.alert_events where event_id=v_event;
    raise exception 'immutable alert fact unexpectedly accepted a delete';
  exception when object_not_in_prerequisite_state then null;
  end;
  if not exists(select 1 from public.alert_events where event_id=v_event) then
    raise exception 'event fact was removed by a local state action';
  end if;
end $$;

-- Service_role has no direct fact/private-state table grant; exercise only the
-- three SECURITY DEFINER boundaries and prove each independently checks access.
set local role service_role;
do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_install_a constant uuid := '51515151-5151-4151-8151-515151515151';
  v_install_b constant uuid := '52525252-5252-4252-8252-525252525252';
  v_page jsonb;
  v_result jsonb;
  v_event uuid;
  v_raised_at timestamptz;
begin
  v_page := public.art95_list_alert_events(v_device,v_install_a,null,null);
  if v_page->>'status'<>'ok' or jsonb_array_length(v_page->'events')<1 then
    raise exception 'active service-role history call was denied or empty';
  end if;
  v_event := (v_page#>>'{events,0,event_id}')::uuid;
  v_raised_at := (v_page#>>'{events,0,raised_at}')::timestamptz;
  v_result := public.art95_set_alert_event_state(v_device,v_event,v_install_a,'read');
  if v_result->>'status'<>'ok' or v_result->>'is_read'<>'true' then
    raise exception 'active service-role single-event action failed';
  end if;
  v_result := public.art95_bulk_alert_event_state(v_device,v_install_a,'mark_read',v_raised_at,v_event);
  if v_result->>'status'<>'ok' or v_result->>'action'<>'mark_read' then
    raise exception 'active service-role bulk action failed';
  end if;
  if public.art95_list_alert_events(v_device,v_install_b,null,null)->>'status'<>'not_active'
     or public.art95_set_alert_event_state(v_device,v_event,v_install_b,'read')->>'status'<>'not_active'
     or public.art95_bulk_alert_event_state(v_device,v_install_b,'mark_read',v_raised_at,v_event)->>'status'<>'not_active' then
    raise exception 'service-role RPCs did not deny the revoked installation';
  end if;
end $$;

-- Direct client reads are membership-filtered, while clients receive no write grant.
select set_config('request.jwt.claim.sub','53535353-5353-4353-8353-535353535353',true);
set local role authenticated;
do $$
begin
  if not exists(select 1 from public.alert_events where device_id='22222222-2222-4222-8222-222222222222'::uuid)
     or exists(select 1 from public.alert_events where device_id='33333333-3333-4333-8333-333333333333'::uuid) then
    raise exception 'alert event SELECT RLS did not follow active device membership';
  end if;
  begin
    insert into public.alert_events(device_id,boot_id,sample_sequence,alert_kind,applied_revision,
      metric_value,limit_value,measured_at,is_simulated)
    values ('22222222-2222-4222-8222-222222222222'::uuid,'61000000-0000-4000-8000-000000000001'::uuid,
      999999,'do_low',1,1,4,pg_catalog.clock_timestamp(),true);
    raise exception 'authenticated client unexpectedly inserted an alert event';
  exception when insufficient_privilege then null;
  end;
end $$;


-- ART-100: feeding outcomes become alert events once, only at a final status,
-- with no invented reading facts, and enqueue the same push delivery path.
reset role;
set local role postgres;
do $$
declare
  v_device constant uuid := '33333333-3333-4333-8333-333333333333';
  v_installation uuid;
  v_seq uuid;
  v_status text;
  v_expected text;
  v_case record;
  v_count integer;
begin
  select a.installation_id into v_installation from public.device_access a
    where a.device_id = v_device order by a.granted_at desc limit 1;
  if v_installation is null then
    raise exception 'ART-100 needs an installation membership row for device 333';
  end if;
  for v_case in
    select * from (values
      ('failed', 'feeding_failed', 'failed', 'not_started', 'valid'),
      ('partial', 'feeding_partial', 'failed', 'completed', 'valid'),
      ('unknown', 'feeding_unknown', 'unknown', 'not_started', 'unavailable'),
      ('completed_unmeasured', 'feeding_unmeasured', 'completed', 'completed', 'error'),
      ('completed', null, 'completed', 'completed', 'valid'),
      ('expired', null, 'expired', 'not_started', 'unavailable'),
      ('rejected', null, 'rejected', 'not_started', 'unavailable')
    ) as c(final_status, kind, step1_status, step2_status, step1_quality)
  loop
    v_seq := gen_random_uuid();
    v_status := case v_case.final_status when 'completed_unmeasured' then 'completed' else v_case.final_status end;
    insert into public.feed_sequences(device_id, sequence_id, source, installation_id, idempotency_key,
      request_id, target_count, capabilities_revision, start_before, status, status_sequence, unresolved)
    values (v_device, v_seq, 'manual', v_installation, gen_random_uuid(), gen_random_uuid(), 2, 5,
      pg_catalog.clock_timestamp() + interval '1 minute', 'running', 1, true);
    insert into public.feed_sequence_targets(device_id, sequence_id, step_index, nozzle_number,
      requested_dose, first_step_index, first_nozzle_number)
    values (v_device, v_seq, 1, 1, '{"mode":"grams","amount_g":25}', 1, 1),
           (v_device, v_seq, 2, 2, '{"mode":"grams","amount_g":40}', 1, 1);
    insert into public.feed_steps(device_id, sequence_id, step_index, nozzle_number, requested_dose,
      status, measurement_quality, measured_dispensed_g)
    values (v_device, v_seq, 1, 1, '{"mode":"grams","amount_g":25}', v_case.step1_status,
        v_case.step1_quality, case when v_case.step1_quality = 'valid' then 10 end),
      (v_device, v_seq, 2, 2, '{"mode":"grams","amount_g":40}', v_case.step2_status,
        case when v_case.step2_status = 'completed' then 'valid' else 'unavailable' end,
        case when v_case.step2_status = 'completed' then 39 end);
    if exists (select 1 from public.alert_events e where e.device_id = v_device and e.sequence_id = v_seq) then
      raise exception 'case %: a running sequence raised a feeding alert', v_case.final_status;
    end if;
    update public.feed_sequences set status = v_status, status_sequence = status_sequence + 1,
      unresolved = v_status = 'unknown', safety_lockout = v_status = 'unknown'
      where device_id = v_device and sequence_id = v_seq;
    -- A repeated write of the same final status (replayed sync) adds nothing.
    update public.feed_sequences set status = v_status, status_sequence = status_sequence + 1
      where device_id = v_device and sequence_id = v_seq;
    select count(*) into v_count from public.alert_events e
      where e.device_id = v_device and e.sequence_id = v_seq;
    if v_count <> (case when v_case.kind is null then 0 else 1 end)
       or (v_case.kind is not null and not exists (
         select 1 from public.alert_events e
         where e.device_id = v_device and e.sequence_id = v_seq and e.alert_kind = v_case.kind
           and e.metric_value is null and e.limit_value is null and e.boot_id is null
           and e.sample_sequence is null and e.applied_revision is null and e.measured_at is null)) then
      raise exception 'case %: expected one % event with null reading facts, found %',
        v_case.final_status, coalesce(v_case.kind, 'no'), v_count;
    end if;
    if v_case.final_status = 'unknown' then
      -- Later reliable evidence is a second linked event; the first is never rewritten.
      update public.feed_sequences set status = 'failed', status_sequence = status_sequence + 1,
        unresolved = false, safety_lockout = false
        where device_id = v_device and sequence_id = v_seq;
      if (select array_agg(e.alert_kind order by e.raised_at) from public.alert_events e
            where e.device_id = v_device and e.sequence_id = v_seq)
         <> array['feeding_unknown', 'feeding_failed'] then
        raise exception 'unknown then failed did not keep both linked events in order';
      end if;
    end if;
  end loop;

  begin
    insert into public.alert_events(device_id, sequence_id, alert_kind, metric_value, is_simulated)
      values (v_device, v_seq, 'feeding_failed', 0, true);
    raise exception 'a feeding event with an invented reading was accepted';
  exception when check_violation or unique_violation then null;
  end;
  begin
    insert into public.alert_events(device_id, boot_id, sample_sequence, alert_kind, applied_revision,
      metric_value, limit_value, measured_at, is_simulated, sequence_id)
    select v_device, t.boot_id, t.sample_sequence, 'do_low', 1, 1, 4, t.measured_at, true, v_seq
      from public.device_telemetry t where t.device_id = v_device limit 1;
    if found then raise exception 'a reading crossing referencing a feed sequence was accepted'; end if;
  exception when check_violation then null;
  end;
  begin
    insert into public.alert_events(device_id, alert_kind, is_simulated)
      values (v_device, 'feeding_partial', true);
    raise exception 'a feeding event without a sequence was accepted';
  exception when check_violation then null;
  end;

  if exists (
    select 1 from public.alert_events a join public.alert_events b
      on a.device_id = b.device_id and a.event_id < b.event_id and a.raised_at = b.raised_at
    where a.device_id = v_device
  ) then
    raise exception 'feeding events broke strictly increasing raised_at per device';
  end if;
end $$;

rollback;
