\set ON_ERROR_STOP on
-- Run on an isolated database after D1 and the reviewed D2 migration. Every
-- simulator row, credential, pairing and label mutation rolls back below.
begin;
set constraints all deferred;

do $$
begin
  if has_function_privilege('anon','public.art38_take_rate_limit(text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_take_rate_limit(text,text)','EXECUTE')
    or has_function_privilege('anon','public.art38_authenticate_device(text)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_authenticate_device(text)','EXECUTE')
    or has_function_privilege('anon','public.art38_create_pairing_challenge(uuid,uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_create_pairing_challenge(uuid,uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('anon','public.art38_redeem_pairing_challenge(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_redeem_pairing_challenge(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.art102_update_device_metadata(uuid,uuid,text,text,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.art102_update_device_metadata(uuid,uuid,text,text,bigint)','EXECUTE')
    or has_function_privilege('anon','public.art38_revoke_device_access(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_revoke_device_access(uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.art38_provision_simulated_device(uuid,text,boolean)','EXECUTE')
    or has_function_privilege('authenticated','public.art38_provision_simulated_device(uuid,text,boolean)','EXECUTE') then
    raise exception 'a client role can execute a D2 service-only RPC';
  end if;
  if not has_function_privilege('service_role','public.art38_create_pairing_challenge(uuid,uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art38_redeem_pairing_challenge(uuid,uuid,uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art38_provision_simulated_device(uuid,text,boolean)','EXECUTE') then
    raise exception 'service role lost required pairing RPC execution';
  end if;
end $$;

set local role service_role;
do $$
declare
  v jsonb;
  v_device constant uuid := '22222222-2222-4222-8222-222222222222';
  v_installation constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_credential constant text := repeat('a', 64);
  v_rotated_credential constant text := repeat('b', 64);
  v_pairing_verifier constant text := repeat('c', 64);
  attempt integer;
begin
  v := public.art38_provision_simulated_device(v_device, v_credential);
  if v->>'status' <> 'provisioned' then raise exception 'simulator fixture was not provisioned'; end if;
  if not exists (select 1 from public.devices d where d.device_id=v_device
      and d.capabilities_revision=4 and d.capabilities->>'feed_capacity_g'='20000'
      and d.capabilities->'nozzles'->'1'->>'max_dose_g'='20000'
      and d.capabilities->'nozzles'->'2'->>'max_dose_g'='20000') then
    raise exception 'simulator provisioning must separate the 20 kg hopper from both nozzle dose maxima';
  end if;
  v := public.art38_provision_simulated_device(v_device, repeat('9', 64));
  if v->>'status' <> 'credential_conflict'
    or not exists (select 1 from private.device_credentials
      where device_id=v_device and credential_verifier=decode(v_credential, 'hex') and revoked_at is null) then
    raise exception 'ordinary provisioning retry rotated the existing simulator credential';
  end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001', 'malformed', v_credential);
  if v->>'status' <> 'invalid' then raise exception 'malformed challenge verifier was accepted'; end if;
  v := public.art38_redeem_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000001', v_installation, 'malformed');
  if v->>'status' <> 'invalid' then raise exception 'malformed pairing verifier was accepted'; end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001', v_pairing_verifier, v_credential);
  if v->>'status' <> 'created' then raise exception 'first pairing-window request did not create a challenge'; end if;
  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001', repeat('d', 64), v_credential);
  if v->>'status' <> 'request_reused' then raise exception 'duplicate request ID did not return a defined conflict'; end if;

  -- Rotate while a challenge is live. The stale machine credential must not
  -- create a challenge after rotation; rotation consumes all prior windows.
  v := public.art38_provision_simulated_device(v_device, v_rotated_credential, true);
  if v->>'status' <> 'provisioned'
    or not exists (select 1 from private.pairing_challenges
      where challenge_id='40000000-0000-4000-8000-000000000001' and consumed_at is not null) then
    raise exception 'credential rotation failed to consume a live challenge';
  end if;
  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000003', v_pairing_verifier, v_credential);
  if v->>'status' <> 'not_active' then raise exception 'stale machine credential created a challenge'; end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000009',
    '50000000-0000-4000-8000-000000000009', v_pairing_verifier, v_rotated_credential);
  if v->>'status' <> 'created' then raise exception 'active credential challenge was not created'; end if;
  update private.device_credentials set revoked_at=now() where device_id=v_device;
  v := public.art38_redeem_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000009', v_installation, v_pairing_verifier);
  if v->>'status' <> 'not_active' then raise exception 'inactive credential redeemed a challenge'; end if;
  v := public.art38_provision_simulated_device(v_device, v_rotated_credential);
  if v->>'status' <> 'credential_conflict' or not exists (
      select 1 from private.device_credentials
      where device_id=v_device and credential_verifier=decode(v_rotated_credential, 'hex') and revoked_at is not null
    ) then
    raise exception 'ordinary retry changed a revoked simulator credential';
  end if;
  v := public.art38_provision_simulated_device(v_device, v_rotated_credential, true);
  if v->>'status' <> 'provisioned' then raise exception 'explicit simulator credential reactivation failed'; end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000004', repeat('e', 64), v_rotated_credential);
  if v->>'status' <> 'created' then raise exception 'attempt-limit challenge creation failed'; end if;
  for attempt in 1..5 loop
    v := public.art38_redeem_pairing_challenge(v_device,
      '40000000-0000-4000-8000-000000000004', v_installation, repeat('f', 64));
    if attempt < 5 and v->>'status' <> 'invalid' then raise exception 'pairing challenge attempt bound changed'; end if;
    if attempt = 5 and v->>'status' <> 'attempts_exceeded' then raise exception 'fifth invalid attempt did not consume challenge'; end if;
  end loop;
  if not exists (select 1 from private.pairing_challenges
    where challenge_id='40000000-0000-4000-8000-000000000004' and attempt_count=5 and consumed_at is not null) then
    raise exception 'invalid attempts were not counted and bounded';
  end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000005',
    '50000000-0000-4000-8000-000000000005', repeat('1', 64), v_rotated_credential);
  update private.pairing_challenges set expires_at=now()-interval '1 second'
    where challenge_id='40000000-0000-4000-8000-000000000005';
  v := public.art38_redeem_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000005', v_installation, repeat('1', 64));
  if v->>'status' <> 'expired' or not exists (select 1 from private.pairing_challenges
    where challenge_id='40000000-0000-4000-8000-000000000005' and consumed_at is not null) then
    raise exception 'expired challenge was not consumed';
  end if;

  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000006',
    '50000000-0000-4000-8000-000000000006', v_pairing_verifier, v_rotated_credential);
  v := public.art38_redeem_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000006', v_installation, v_pairing_verifier);
  if v->>'status' <> 'paired' or v#>>'{device,protocol_major}' <> '2'
    or v#>>'{access,device_id}' <> v_device::text then
    raise exception 'valid protocol 2 pairing did not return a verified descriptor and membership';
  end if;
  v := public.art38_redeem_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000006', v_installation, v_pairing_verifier);
  if v->>'status' <> 'consumed' then raise exception 'pairing challenge was reusable'; end if;

  v := public.art102_update_device_metadata(v_device, v_installation, 'Pond North', 'North shed', 1);
  if v->>'status' <> 'updated' or (v->>'metadata_revision')::bigint <> 2 then
    raise exception 'shared alias and location update failed';
  end if;
  v := public.art102_update_device_metadata(v_device, v_installation, 'Stale', null, 1);
  if v->>'status' <> 'conflict' or not exists (select 1 from public.devices
    where device_id=v_device and alias='Pond North' and metadata_revision=2) then
    raise exception 'stale revision overwrote or was not reported as a conflict';
  end if;
  v := public.art102_update_device_metadata(v_device, '99999999-9999-4999-8999-999999999999', 'Hijack', null, 2);
  if v->>'status' <> 'not_active' then raise exception 'an installation without access edited shared labels'; end if;
  v := public.art102_update_device_metadata(v_device, v_installation, 'Pond North', 'West shed', 2);
  if v->>'status' <> 'updated' or v->>'alias' <> 'Pond North' or v->>'location' <> 'West shed' then
    raise exception 'whole-record replace did not store both fields';
  end if;
  v := public.art38_create_pairing_challenge(v_device,
    '40000000-0000-4000-8000-000000000010',
    '50000000-0000-4000-8000-000000000010', repeat('a', 64), v_rotated_credential);
  if v->>'status' <> 'created' then raise exception 'preservation challenge creation failed'; end if;
  v := public.art38_provision_simulated_device(v_device, repeat('8', 64));
  if v->>'status' <> 'credential_conflict'
    or not exists (select 1 from private.device_credentials
      where device_id=v_device and credential_verifier=decode(v_rotated_credential, 'hex') and revoked_at is null)
    or not exists (select 1 from public.device_access
      where device_id=v_device and installation_id=v_installation and status='active')
    or not exists (select 1 from public.devices
      where device_id=v_device and alias='Pond North' and location='West shed' and metadata_revision=3)
    or not exists (select 1 from private.pairing_challenges
      where challenge_id='40000000-0000-4000-8000-000000000010' and consumed_at is null) then
    raise exception 'ordinary retry changed live credentials, memberships, labels, or challenges';
  end if;
  v := public.art38_provision_simulated_device(v_device, v_rotated_credential);
  if v->>'status' <> 'already_provisioned' or not exists (
      select 1 from public.device_access
      where device_id=v_device and installation_id=v_installation and status='active'
    ) or not exists (
      select 1 from public.devices
      where device_id=v_device and alias='Pond North' and location='West shed'
    ) then
    raise exception 'same-credential simulator retry changed active membership or labels';
  end if;
  v := public.art102_update_device_metadata(v_device, v_installation, repeat('x', 101), null, 3);
  if v->>'status' <> 'invalid' then raise exception 'alias over 100 characters was accepted'; end if;
  v := public.art102_update_device_metadata(v_device, v_installation, null, repeat('x', 161), 3);
  if v->>'status' <> 'invalid' then raise exception 'location over 160 characters was accepted'; end if;
  v := public.art102_update_device_metadata(v_device, v_installation, 'No revision', null, null);
  if v->>'status' <> 'invalid' then raise exception 'a write without an expected revision was accepted'; end if;

  -- A separate installation gets a separate simulator and membership.
  v := public.art38_provision_simulated_device('33333333-3333-4333-8333-333333333333', repeat('2', 64));
  v := public.art38_create_pairing_challenge('33333333-3333-4333-8333-333333333333',
    '40000000-0000-4000-8000-000000000007', '50000000-0000-4000-8000-000000000007',
    repeat('3', 64), repeat('2', 64));
  v := public.art38_redeem_pairing_challenge('33333333-3333-4333-8333-333333333333',
    '40000000-0000-4000-8000-000000000007',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', repeat('3', 64));
  if v->>'status' <> 'paired' then raise exception 'second simulator membership did not pair'; end if;

  insert into public.device_telemetry
    (device_id, boot_id, sample_sequence, measured_at, time_quality, do_quality, feed_quality)
  values (v_device, '60000000-0000-4000-8000-000000000001', 1, now(), 'synced', 'unavailable', 'unavailable');
  insert into public.device_schedule_identities(device_id, schedule_id)
  values (v_device, '70000000-0000-4000-8000-000000000001');
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
begin
  if (select count(*) from public.devices) <> 1
    or not exists (select 1 from public.devices where device_id='22222222-2222-4222-8222-222222222222')
    or (select count(*) from public.device_access) <> 1 then
    raise exception 'installation A saw another installation device or membership';
  end if;
  begin
    execute 'select public.art38_revoke_device_access(''22222222-2222-4222-8222-222222222222'', ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'')';
    raise exception 'authenticated client executed a service-only revoke RPC';
  exception when insufficient_privilege then null; end;
  begin
    execute 'select count(*) from private.device_credentials';
    raise exception 'authenticated client read private device credentials';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
do $$
begin
  if (select count(*) from public.devices) <> 1
    or not exists (select 1 from public.devices where device_id='33333333-3333-4333-8333-333333333333')
    or exists (select 1 from public.devices where device_id='22222222-2222-4222-8222-222222222222') then
    raise exception 'installation B saw installation A device data';
  end if;
end $$;
reset role;

set local role service_role;
do $$
declare
  v jsonb;
begin
  -- A second phone pairs to the same feeder; losing the first phone must not remove it.
  v := public.art38_create_pairing_challenge('22222222-2222-4222-8222-222222222222',
    '40000000-0000-4000-8000-000000000009', '50000000-0000-4000-8000-000000000009',
    repeat('5', 64), repeat('b', 64));
  v := public.art38_redeem_pairing_challenge('22222222-2222-4222-8222-222222222222',
    '40000000-0000-4000-8000-000000000009', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', repeat('5', 64));
  if v->>'status' <> 'paired' then raise exception 'second phone did not pair to the same feeder'; end if;
  v := public.art38_revoke_device_access('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if v->>'status' <> 'revoked' or v->>'revoked_at' is null then
    raise exception 'membership removal did not return a revocation result';
  end if;
  if not exists (select 1 from public.device_access where device_id='22222222-2222-4222-8222-222222222222'
      and installation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and status='revoked')
    or not exists (select 1 from public.devices where device_id='22222222-2222-4222-8222-222222222222')
    or not exists (select 1 from public.device_state where device_id='22222222-2222-4222-8222-222222222222')
    or not exists (select 1 from public.device_telemetry where device_id='22222222-2222-4222-8222-222222222222')
    or not exists (select 1 from public.device_schedule_identities where device_id='22222222-2222-4222-8222-222222222222') then
    raise exception 'removal changed feeder, schedule identity, or history data';
  end if;
  v := public.art38_revoke_device_access('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if v->>'status' <> 'not_active' then raise exception 'repeated removal returned success'; end if;
  if not exists (select 1 from public.device_access where device_id='22222222-2222-4222-8222-222222222222'
      and installation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and status='active') then
    raise exception 'revoking one phone removed another phone from the same feeder';
  end if;

  v := public.art38_create_pairing_challenge('22222222-2222-4222-8222-222222222222',
    '40000000-0000-4000-8000-000000000008', '50000000-0000-4000-8000-000000000008',
    repeat('4', 64), repeat('b', 64));
  v := public.art38_redeem_pairing_challenge('22222222-2222-4222-8222-222222222222',
    '40000000-0000-4000-8000-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('4', 64));
  if v->>'status' <> 'paired' or not exists (select 1 from public.devices
    where device_id='22222222-2222-4222-8222-222222222222' and alias='Pond North' and location='West shed') then
    raise exception 'safe re-pair did not reactivate membership and preserve local labels';
  end if;
end $$;
reset role;
rollback;
