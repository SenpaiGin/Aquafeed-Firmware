\set ON_ERROR_STOP on
-- Run after the ART-7 migration on an isolated development database. Synthetic
-- auth UUIDs rely on deferred FKs; no auth.users rows or accounts are created.
begin;
do $$
declare
 function_owner name;
 security_definer boolean;
begin
 if to_regprocedure('public.rls_auto_enable()') is null then
   return;
 end if;
 select owner_role.rolname,routine.prosecdef into function_owner,security_definer
 from pg_proc routine join pg_roles owner_role on owner_role.oid=routine.proowner
 where routine.oid=to_regprocedure('public.rls_auto_enable()');
 if has_function_privilege('anon','public.rls_auto_enable()','EXECUTE')
   or has_function_privilege('authenticated','public.rls_auto_enable()','EXECUTE') then
   raise exception 'client roles can execute public.rls_auto_enable()';
 end if;
 if not security_definer or not has_function_privilege(function_owner,'public.rls_auto_enable()','EXECUTE') then
   raise exception 'automatic RLS function must remain SECURITY DEFINER and executable by its owner';
 end if;
end $$;
set constraints all deferred;

insert into public.devices (device_id,model,firmware_version,protocol_major,is_simulated,capabilities_revision,capabilities)
select '22222222-2222-4222-8222-222222222222',model,firmware_version,protocol_major,is_simulated,capabilities_revision,capabilities
from public.devices where device_id='11111111-1111-4111-8111-111111111111';
insert into public.device_state(device_id) values ('22222222-2222-4222-8222-222222222222');
insert into public.device_telemetry(device_id,boot_id,sample_sequence,measured_at,time_quality,do_quality,feed_quality)
values ('11111111-1111-4111-8111-111111111111','ffffffff-0000-4000-8000-000000000001',1,
        '2026-10-04T22:00:00Z','synced','unavailable','unavailable');
insert into public.device_access(device_id,installation_id,status,revoked_at) values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',null),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active',null),
 ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','revoked',now());

insert into public.device_config_revisions(device_id,revision,requested_snapshot,state,applied_at)
values ('11111111-1111-4111-8111-111111111111',1,'{"timezone":"Asia/Manila"}','applied',now());
update public.devices set desired_revision=1,applied_revision=1
where device_id='11111111-1111-4111-8111-111111111111';

insert into public.device_schedule_identities(device_id,schedule_id) values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001'),
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002'),
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000003');
insert into public.device_config_schedules(device_id,revision,schedule_id,nozzle_number,requested_dose,timezone,enabled) values
 ('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000001',1,'{"mode":"grams","amount_g":25}','Asia/Manila',true),
 ('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000002',2,'{"mode":"grams","amount_g":40}','Asia/Manila',true),
 ('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000003',1,'{"mode":"grams","amount_g":30}','Asia/Manila',true);
-- Same-time slots across nozzles are valid; same-nozzle duplicate is checked below.
insert into public.device_config_schedule_slots(device_id,revision,schedule_id,nozzle_number,iso_weekday,local_time) values
 ('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000001',1,1,'06:00'),
 ('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000002',2,1,'06:00');

insert into public.feed_sequences
 (device_id,sequence_id,source,installation_id,idempotency_key,request_id,target_count,capabilities_revision,
  due_at,admitted_at,start_before,scheduler_wake_grace_ms,maximum_settling_ms,status,status_sequence,unresolved,safety_lockout)
values
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001','manual',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001',
  2,1,null,now(),now()+interval '30 seconds',30000,null,'partial',4,false,false),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002','scheduled',
  null,null,null,2,1,'2026-10-04T22:00:00Z','2026-10-04T21:59:30Z','2026-10-04T22:00:30Z',30000,null,'completed',4,false,false),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003','manual',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-0000-4000-8000-000000000003','eeeeeeee-0000-4000-8000-000000000003',
  2,1,null,now(),now()+interval '30 seconds',30000,null,'partial',4,true,true),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000004','scheduled',
  null,null,null,1,1,'2026-10-04T22:00:00Z','2026-10-04T21:59:30Z','2026-10-04T22:00:30Z',30000,null,'queued',1,true,false);
insert into public.feed_sequence_targets
 (device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number) values
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001',1,1,'{"mode":"grams","amount_g":25}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001',2,2,'{"mode":"grams","amount_g":40}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',1,1,'{"mode":"grams","amount_g":25}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',2,2,'{"mode":"grams","amount_g":40}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003',1,1,'{"mode":"grams","amount_g":25}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003',2,2,'{"mode":"grams","amount_g":40}',1,1),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000004',1,2,'{"mode":"grams","amount_g":40}',1,2);
insert into public.feed_steps
 (device_id,sequence_id,step_index,nozzle_number,requested_dose,status,measured_dispensed_g,measurement_quality,baseline_ready_at,start_before,started_at,stopped_at) values
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001',1,1,'{"mode":"grams","amount_g":25}','completed',24.5,'valid',null,null,null,null),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001',2,2,'{"mode":"grams","amount_g":40}','not_started',null,'unavailable',null,null,null,null),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',1,1,'{"mode":"grams","amount_g":25}','completed',24.5,'valid',null,null,'2026-10-04T22:00:05Z','2026-10-04T22:00:40Z'),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',2,2,'{"mode":"grams","amount_g":40}','completed',39.5,'valid','2026-10-04T22:00:45Z','2026-10-04T22:01:15Z','2026-10-04T22:00:50Z','2026-10-04T22:01:00Z'),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003',1,1,'{"mode":"grams","amount_g":25}','completed',24.5,'valid',null,null,null,null),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003',2,2,'{"mode":"grams","amount_g":40}','unknown',null,'unavailable','2026-10-04T22:02:00Z','2026-10-04T22:02:30Z',null,null),
 ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000004',1,2,'{"mode":"grams","amount_g":40}','not_started',null,'unavailable',null,null,null,null);
update public.device_state set safety_lockout=true,lockout_sequence_id='cccccccc-0000-4000-8000-000000000003'
where device_id='11111111-1111-4111-8111-111111111111';

insert into public.scheduled_occurrences(device_id,schedule_id,occurrence_local_date,sequence_id,outcome) values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','2026-10-05','cccccccc-0000-4000-8000-000000000002','completed'),
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002','2026-10-05','cccccccc-0000-4000-8000-000000000002','completed');
insert into public.device_events(device_id,sequence_id,event_sequence,step_index,nozzle_number,requested_dose,event_type)
values ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',1,2,2,'{"mode":"grams","amount_g":40}','completed');
insert into public.device_execution_reservations(device_id,sequence_id,phase)
values ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002','settling');

-- Force only app integrity constraints; synthetic Auth FKs stay deferred.
set constraints feed_sequence_target_anchor_fkey, feed_sequence_integrity, feed_step_integrity, feed_target_integrity, device_state_integrity immediate;
do $$
begin
 if not exists(select 1 from public.device_state where device_id='11111111-1111-4111-8111-111111111111' and safety_lockout)
  or not exists(select 1 from public.feed_steps where sequence_id='cccccccc-0000-4000-8000-000000000003' and status='unknown') then
   raise exception 'unknown per-nozzle result must keep shared device lockout';
 end if;
 if not exists(select 1 from public.scheduled_occurrences where schedule_id='aaaaaaaa-0000-4000-8000-000000000001'
      and sequence_id='cccccccc-0000-4000-8000-000000000002')
  or not exists(select 1 from public.scheduled_occurrences where schedule_id='aaaaaaaa-0000-4000-8000-000000000002'
      and sequence_id='cccccccc-0000-4000-8000-000000000002') then
   raise exception 'same-time nozzle occurrences must share one admitted group sequence';
 end if;
end $$;
set constraints feed_sequence_target_anchor_fkey, feed_sequence_integrity, feed_step_integrity, feed_target_integrity, device_state_integrity deferred;

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
begin
 if (select count(*) from public.devices)<>1
  or not exists(select 1 from public.devices where device_id='11111111-1111-4111-8111-111111111111')
  or exists(select 1 from public.devices where device_id='22222222-2222-4222-8222-222222222222')
  or (select count(*) from public.device_access)<>1
  or not exists(select 1 from public.device_state where safety_lockout) then
   raise exception 'installation A must see only its active device, membership, and lockout';
 end if;
 begin
  insert into public.device_access(device_id,installation_id,status)
   values('22222222-2222-4222-8222-222222222222',auth.uid(),'active');
  raise exception 'membership self-grant unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.device_telemetry(device_id,boot_id,sample_sequence,time_quality,do_quality,feed_quality)
   values('11111111-1111-4111-8111-111111111111','ffffffff-0000-4000-8000-000000000001',1,'synced','unavailable','unavailable');
  raise exception 'telemetry write unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.feed_steps(device_id,sequence_id,step_index,nozzle_number,requested_dose,status,measurement_quality)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001',1,1,'{"mode":"grams","amount_g":25}','not_started','unavailable');
  raise exception 'result write unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
 begin
  execute 'select count(*) from private.device_credentials';
  raise exception 'credential read unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
do $$
begin
 if (select count(*) from public.devices)<>1
  or not exists(select 1 from public.devices where device_id='22222222-2222-4222-8222-222222222222')
  or exists(select 1 from public.devices where device_id='11111111-1111-4111-8111-111111111111') then
   raise exception 'installation B must see only its active device';
 end if;
end $$;
reset role;

-- Revoke A's real test membership as the privileged runner, then prove its
-- next authenticated read sees no device or membership.
update public.device_access set status='revoked',revoked_at=now()
where device_id='11111111-1111-4111-8111-111111111111'
  and installation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
begin
 if exists(select 1 from public.devices) or exists(select 1 from public.device_access) then
  raise exception 'revoked installation retained access';
 end if;
end $$;
reset role;

do $$
begin
 begin
  update public.devices set desired_revision=1 where device_id='22222222-2222-4222-8222-222222222222';
  raise exception 'cross-device config reference unexpectedly succeeded';
 exception when foreign_key_violation then null; end;
 begin
  insert into public.feed_sequences(device_id,sequence_id,source,installation_id,idempotency_key,request_id,target_count,capabilities_revision,status,unresolved)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000005','manual',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-0000-4000-8000-000000000001',
    'eeeeeeee-0000-4000-8000-000000000005',1,1,'completed',false);
  raise exception 'duplicate manual idempotency identity unexpectedly succeeded';
 exception when unique_violation then null; end;
 begin
  insert into public.feed_sequences(device_id,sequence_id,source,installation_id,idempotency_key,request_id,target_count,capabilities_revision,status)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000005','manual',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-0000-4000-8000-000000000005',
    'eeeeeeee-0000-4000-8000-000000000005',1,1,'queued');
  raise exception 'unresolved manual command barrier unexpectedly allowed a second feed';
 exception when unique_violation then null; end;
  begin
    update public.feed_steps set nozzle_number=2,requested_dose='{"mode":"grams","amount_g":40}'
     where device_id='11111111-1111-4111-8111-111111111111'
       and sequence_id='cccccccc-0000-4000-8000-000000000002' and step_index=1;
  raise exception 'step target mismatch unexpectedly succeeded';
 exception when foreign_key_violation then null; end;
  begin
    insert into public.device_events(device_id,sequence_id,event_sequence,step_index,nozzle_number,requested_dose,event_type)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000002',2,2,1,'{"mode":"grams","amount_g":25}','completed');
  raise exception 'event target mismatch unexpectedly succeeded';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.device_telemetry(device_id,boot_id,sample_sequence,measured_at,time_quality,do_quality,feed_quality)
     values('11111111-1111-4111-8111-111111111111','ffffffff-0000-4000-8000-000000000001',1,
      '2026-10-04T22:00:00Z','synced','unavailable','unavailable');
    raise exception 'duplicate telemetry identity unexpectedly succeeded';
  exception when unique_violation then null; end;
  begin
    insert into public.device_telemetry(device_id,boot_id,sample_sequence,time_quality,do_mg_l,do_quality,feed_quality)
     values('11111111-1111-4111-8111-111111111111','ffffffff-0000-4000-8000-000000000002',1,'synced',5.2,'error','unavailable');
    raise exception 'invalid sensor quality with numeric value unexpectedly succeeded';
  exception when check_violation then null; end;
  begin
    insert into public.device_telemetry(device_id,boot_id,sample_sequence,time_quality,do_mg_l,do_quality,feed_remaining_g,feed_percent,feed_quality,calibration_revision)
     values('11111111-1111-4111-8111-111111111111','ffffffff-0000-4000-8000-000000000003',1,'synced',null,'unavailable','Infinity'::numeric,50,'valid',1);
    raise exception 'infinite weighing unexpectedly succeeded';
  exception when check_violation then null; end;
 begin
  insert into public.feed_sequence_targets(device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000004',2,3,'{"mode":"grams","amount_g":30}',1,1);
  raise exception 'unsupported nozzle target unexpectedly succeeded';
 exception when check_violation then null; end;
  begin
    insert into public.scheduled_occurrences(device_id,schedule_id,occurrence_local_date,sequence_id,outcome)
   values('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','2026-10-05','cccccccc-0000-4000-8000-000000000002','completed');
  raise exception 'duplicate occurrence identity unexpectedly succeeded';
  exception when unique_violation then null; end;
  begin
    insert into public.device_execution_reservations(device_id,sequence_id,phase)
     values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000001','active');
    raise exception 'second whole-device reservation unexpectedly succeeded';
  exception when unique_violation then null; end;
 begin
  insert into public.device_config_schedule_slots(device_id,revision,schedule_id,nozzle_number,iso_weekday,local_time)
   values('11111111-1111-4111-8111-111111111111',1,'aaaaaaaa-0000-4000-8000-000000000003',1,1,'06:00');
  raise exception 'same-nozzle duplicate schedule slot unexpectedly succeeded';
 exception when unique_violation then null; end;
end $$;

insert into public.device_config_revisions(device_id,revision,requested_snapshot,state)
values('11111111-1111-4111-8111-111111111111',2,'{"timezone":"Asia/Manila","schedules":[]}','requested');
update public.devices set desired_revision=2 where device_id='11111111-1111-4111-8111-111111111111';
insert into public.device_schedule_tombstones(device_id,schedule_id)
values('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002');
do $$
begin
 begin
  insert into public.device_config_schedules(device_id,revision,schedule_id,nozzle_number,requested_dose,timezone,enabled)
   values('11111111-1111-4111-8111-111111111111',2,'aaaaaaaa-0000-4000-8000-000000000002',2,'{"mode":"grams","amount_g":40}','Asia/Manila',true);
  raise exception 'retired schedule identity was reused';
 exception when check_violation then null; end;
 if has_column_privilege('service_role','public.device_config_revisions','requested_snapshot','UPDATE')
  or has_table_privilege('service_role','public.device_config_schedules','UPDATE')
  or has_table_privilege('service_role','public.device_config_schedules','DELETE') then
   raise exception 'configuration revisions and schedule rows must be immutable';
 end if;
end $$;

-- Maintenance clears the device lockout and unresolved barrier while the
-- nozzle outcome stays unknown. Step 2 uses baseline+grace after the first
-- leg's deadline, while the reservation remains held through settling.
update public.feed_sequences set safety_lockout=false,unresolved=false,
 lockout_resolved_at=now(),lockout_resolution_source='device_maintenance'
where device_id='11111111-1111-4111-8111-111111111111'
  and sequence_id='cccccccc-0000-4000-8000-000000000003';
update public.device_state set safety_lockout=false,lockout_sequence_id=null
where device_id='11111111-1111-4111-8111-111111111111';
insert into public.feed_sequences
 (device_id,sequence_id,source,installation_id,idempotency_key,request_id,target_count,capabilities_revision,status)
values ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000006','manual',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-0000-4000-8000-000000000006','eeeeeeee-0000-4000-8000-000000000006',1,1,'queued');
insert into public.feed_sequence_targets(device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number)
values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000006',1,1,'{"mode":"grams","amount_g":20}',1,1);
insert into public.feed_steps(device_id,sequence_id,step_index,nozzle_number,requested_dose,status,measurement_quality)
values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000006',1,1,'{"mode":"grams","amount_g":20}','not_started','unavailable');
do $$
begin
 begin
  insert into public.feed_sequence_targets(device_id,sequence_id,step_index,nozzle_number,requested_dose,first_step_index,first_nozzle_number)
   values('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000006',2,2,'{"mode":"grams","amount_g":30}',1,1);
  set constraints feed_target_integrity immediate;
  raise exception 'sequence accepted more targets than target_count';
 exception when check_violation then null; end;
end $$;

-- Check deferred ordered-target and lockout constraints without forcing the
-- synthetic auth.users FKs; the transaction is rolled back below.
set constraints feed_sequence_target_anchor_fkey, feed_sequence_integrity, feed_step_integrity, feed_target_integrity, device_state_integrity immediate;
do $$
begin
 if not exists (
  select 1 from public.feed_sequences q join public.feed_steps s
    on s.device_id=q.device_id and s.sequence_id=q.sequence_id
  where q.sequence_id='cccccccc-0000-4000-8000-000000000002'
    and s.step_index=2
    and s.start_before=q.start_before + interval '45 seconds'
    and s.start_before > q.start_before
 ) then raise exception 'nozzle 2 must receive a post-baseline deadline, not nozzle 1 start_before'; end if;
 if not exists(select 1 from public.feed_steps where sequence_id='cccccccc-0000-4000-8000-000000000003' and status='unknown')
   or exists(select 1 from public.device_state where safety_lockout) then
   raise exception 'maintenance may clear lockout without rewriting the unknown nozzle result';
 end if;
 if has_schema_privilege('anon','private','USAGE')
  or has_schema_privilege('authenticated','private','USAGE')
  or has_table_privilege('anon','private.device_credentials','SELECT')
  or has_table_privilege('authenticated','private.device_credentials','SELECT')
  or exists(select 1 from pg_publication_tables where schemaname='private') then
   raise exception 'private credentials are exposed to client roles or Realtime';
 end if;
end $$;
rollback;
