-- Rollback-only RT-01 acceptance for an isolated development database after migration.
-- Run the complete file in a privileged Supabase SQL Editor session; it rolls back.
begin;
set constraints all deferred;

do $$
begin
  if has_function_privilege('anon', 'public.rt01_device_work_token(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rt01_device_work_token(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.rt01_device_work_token(uuid)', 'EXECUTE') then
    raise exception 'device work token RPC is not service_role only';
  end if;
end $$;

do $$
begin
  if exists (select 1 from public.devices where device_id in (
      '22222222-2222-4222-8222-922222222292',
      '33333333-3333-4333-8333-933333333393'
    )) then
    raise exception 'an RT-01 synthetic device fixture ID is already in use';
  end if;
  if exists (select 1 from auth.users where id = '41414141-4141-4414-8414-414141414192'
      and email <> 'rt01-installation@invalid.example') then
    raise exception 'RT-01 installation UUID is already owned by another auth user';
  end if;
end $$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,is_anonymous)
values ('00000000-0000-0000-0000-000000000000','41414141-4141-4414-8414-414141414192',
  'authenticated','authenticated','rt01-installation@invalid.example','',pg_catalog.clock_timestamp(),
  '{"provider":"email","providers":["email"]}','{}',true)
on conflict (id) do nothing;

insert into public.devices (device_id,model,firmware_version,protocol_major,is_simulated,capabilities_revision,capabilities)
values
  ('22222222-2222-4222-8222-922222222292','RT-01 test','test',2,true,1,'{"nozzles":{"1":{},"2":{}}}'::jsonb),
  ('33333333-3333-4333-8333-933333333393','RT-01 test','test',2,true,1,'{"nozzles":{"1":{},"2":{}}}'::jsonb);

insert into public.device_config_revisions (device_id,revision,requested_snapshot,state)
values
  ('22222222-2222-4222-8222-922222222292',1,'{}'::jsonb,'requested'),
  ('22222222-2222-4222-8222-922222222292',2,'{}'::jsonb,'requested');
update public.devices set desired_revision=1
  where device_id='22222222-2222-4222-8222-922222222292';

do $$
declare
  v_device constant uuid := '22222222-2222-4222-8222-922222222292';
  v_other_device constant uuid := '33333333-3333-4333-8333-933333333393';
  v_installation constant uuid := '41414141-4141-4414-8414-414141414192';
  v_initial text;
  v_repeat text;
  v_manual text;
begin
  v_initial := public.rt01_device_work_token(v_device);
  v_repeat := public.rt01_device_work_token(v_device);
  if v_initial <> v_repeat then
    raise exception 'work token changed without new work';
  end if;

  insert into public.feed_sequences (device_id,sequence_id,source,installation_id,idempotency_key,request_id,
    target_count,capabilities_revision,status,unresolved)
  values (v_device,'44444444-4444-4444-8444-444444444444','manual',v_installation,
    '55555555-5555-4555-8555-555555555551','66666666-6666-4666-8666-666666666661',
    1,1,'completed',false);
  v_manual := public.rt01_device_work_token(v_device);
  if v_manual = v_initial then
    raise exception 'work token did not change after a manual feed was created';
  end if;
  if public.rt01_device_work_token(v_device) <> v_manual then
    raise exception 'work token changed without new work after the manual feed';
  end if;

  insert into public.feed_sequences (device_id,sequence_id,source,installation_id,idempotency_key,request_id,
    target_count,capabilities_revision,status,unresolved)
  values (v_other_device,'77777777-7777-4777-8777-777777777777','manual',v_installation,
    '88888888-8888-4888-8888-888888888881','99999999-9999-4999-8999-999999999991',
    1,1,'completed',false);
  if public.rt01_device_work_token(v_device) <> v_manual then
    raise exception 'another feeder changed this device work token';
  end if;

  update public.devices set desired_revision=2 where device_id=v_device;
  if public.rt01_device_work_token(v_device) = v_manual then
    raise exception 'work token did not change after desired_revision increased';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='feed_sequences')
     or not exists (select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='feed_steps') then
    raise exception 'feed sequences and steps are not both in supabase_realtime';
  end if;
  if exists (select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='devices')
     or exists (select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='private') then
    raise exception 'devices or a private table is in supabase_realtime';
  end if;
end $$;

rollback;
