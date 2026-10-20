\set ON_ERROR_STOP on
-- ART-96 isolated acceptance. Use only the reserved 222/333 simulator profiles,
-- synthetic Auth IDs, and synthetic Expo token strings; the runner rolls back.
begin;
set constraints all deferred;

do $$
declare
  v_install_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_install_b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_install_c uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_device_a uuid := '22222222-2222-4222-8222-222222222222';
  v_device_b uuid := '33333333-3333-4333-8333-333333333333';
  v_boot_a uuid := '77777777-7777-4777-8777-777777777777';
  v_boot_b uuid := '88888888-8888-4888-8888-888888888888';
  v_event_1 uuid := '11111111-1111-4111-8111-111111111101';
  v_event_2 uuid := '11111111-1111-4111-8111-111111111102';
  v_event_3 uuid := '11111111-1111-4111-8111-111111111103';
  v_event_4 uuid := '11111111-1111-4111-8111-111111111104';
  v_event_5 uuid := '11111111-1111-4111-8111-111111111105';
  v_event_6 uuid := '11111111-1111-4111-8111-111111111106';
  v_event_7 uuid := '11111111-1111-4111-8111-111111111107';
  v_event_8 uuid := '11111111-1111-4111-8111-111111111108';
  v_event_9 uuid := '11111111-1111-4111-8111-111111111109';
  v_project uuid := '1b3dc89f-3111-49d4-b91f-d5567e71d996';
  v_result jsonb;
  v_claim jsonb;
  v_delivery jsonb;
  v_receipt jsonb;
  v_generation bigint;
  v_count integer;
  v_delivery_id uuid;
  v_lease_id uuid;
  v_attempt integer;
begin
  if exists(select 1 from public.alert_events where device_id in (v_device_a, v_device_b)) then
    raise exception 'ART-96 acceptance requires fresh alert history for reserved simulator profiles 222/333';
  end if;
  if exists(select 1 from public.device_access where device_id in (v_device_a, v_device_b)) then
    raise exception 'ART-96 acceptance requires clean access rows for reserved simulator profiles 222/333';
  end if;
  if not has_function_privilege('service_role','public.art96_register_push_token(uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_revoke_push_token(uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_read_alert_event(uuid,uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_claim_push_deliveries(integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_begin_push_send(uuid,uuid,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_validate_push_send_batch(jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_record_push_send(uuid,uuid,bigint,text,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_claim_push_receipts(integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_record_push_receipt(uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.art96_push_sender_status()','EXECUTE') then
    raise exception 'service_role is missing an ART-96 RPC grant';
  end if;
  if has_function_privilege('anon','public.art96_register_push_token(uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.art96_register_push_token(uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('anon','public.art96_claim_push_deliveries(integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.art96_claim_push_deliveries(integer,integer)','EXECUTE')
    or has_function_privilege('anon','public.art96_validate_push_send_batch(jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.art96_validate_push_send_batch(jsonb)','EXECUTE') then
    raise exception 'ART-96 RPCs are callable by app roles';
  end if;
  if exists (
    select 1 from pg_catalog.pg_publication_tables p
    where p.schemaname = 'private'
  ) then raise exception 'private push tables were added to Realtime'; end if;

  insert into auth.users(id, is_anonymous) values
    (v_install_a, true), (v_install_b, true), (v_install_c, true);
  insert into public.device_access(device_id, installation_id, status, alias) values
    (v_device_a, v_install_a, 'active', 'First feeder'),
    (v_device_b, v_install_a, 'active', null),
    (v_device_a, v_install_b, 'active', 'Shared feeder'),
    (v_device_b, v_install_c, 'active', 'Third feeder');

  v_result := public.art96_register_push_token(v_install_a, v_project, 'android', 'ExponentPushToken[synthetic_android_token_A001]');
  if v_result->>'status' <> 'ok' then raise exception 'active installation A registration failed'; end if;
  v_generation := (v_result->>'generation')::bigint;
  v_result := public.art96_register_push_token(v_install_a, v_project, 'android', 'ExponentPushToken[synthetic_android_token_A001]');
  if (v_result->>'generation')::bigint <> v_generation then raise exception 'same-token registration was not idempotent'; end if;
  v_result := public.art96_register_push_token(v_install_b, v_project, 'android', 'ExponentPushToken[synthetic_android_token_B001]');
  if v_result->>'status' <> 'ok' then raise exception 'active installation B registration failed'; end if;
  v_result := public.art96_register_push_token('dddddddd-dddd-4ddd-8ddd-dddddddddddd', v_project, 'android', 'ExponentPushToken[synthetic_android_token_D001]');
  if v_result->>'status' <> 'not_active' then raise exception 'registration without active membership was accepted'; end if;

  insert into public.device_telemetry(
    device_id, boot_id, sample_sequence, measured_at, time_quality,
    do_mg_l, do_quality, feed_remaining_g, feed_percent, feed_quality,
    calibration_revision
  ) values
    (v_device_a, v_boot_a, 1, pg_catalog.clock_timestamp(), 'rtc', 2.5, 'valid', null, null, 'unavailable', null),
    (v_device_a, v_boot_a, 2, pg_catalog.clock_timestamp(), 'rtc', 2.2, 'valid', null, null, 'unavailable', null),
    (v_device_a, v_boot_a, 3, pg_catalog.clock_timestamp(), 'rtc', 2.0, 'valid', null, null, 'unavailable', null),
    (v_device_a, v_boot_a, 4, pg_catalog.clock_timestamp(), 'rtc', 1.8, 'valid', null, null, 'unavailable', null),
    (v_device_b, v_boot_b, 1, pg_catalog.clock_timestamp(), 'rtc', 2.4, 'valid', null, null, 'unavailable', null),
    (v_device_b, v_boot_b, 2, pg_catalog.clock_timestamp(), 'rtc', 2.1, 'valid', null, null, 'unavailable', null);
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_1, v_device_a, v_boot_a, 1, 'do_low', 1, 2.5, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  select count(*) into v_count from private.alert_push_deliveries
   where event_id = v_event_1 and state = 'queued';
  if v_count <> 2 then raise exception 'one event did not enqueue once for each active token installation'; end if;

  -- Reusing a globally unique Expo token transfers it and invalidates the old generation.
  v_result := public.art96_register_push_token(v_install_b, v_project, 'android', 'ExponentPushToken[synthetic_android_token_A001]');
  if v_result->>'status' <> 'ok' then raise exception 'global token reuse did not move to the new installation'; end if;
  if exists(select 1 from private.installation_push_tokens where installation_id = v_install_a and expo_push_token is not null) then
    raise exception 'old holder retained a globally reused token';
  end if;
  if not exists(select 1 from private.alert_push_deliveries where event_id = v_event_1 and installation_id = v_install_a and state = 'cancelled') then
    raise exception 'global token reuse did not cancel the previous unsent delivery';
  end if;
  select count(*) into v_count from private.alert_push_deliveries where event_id = v_event_1 and installation_id = v_install_a;
  if v_count <> 1 then raise exception 'token rotation re-enqueued old alert history'; end if;
  v_result := public.art96_register_push_token(v_install_a, v_project, 'android', 'ExponentPushToken[synthetic_android_token_A002]');
  if v_result->>'status' <> 'ok' then raise exception 'replacement token registration failed'; end if;

  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_2, v_device_b, v_boot_b, 1, 'do_low', 1, 2.4, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true),
    (v_event_3, v_device_a, v_boot_a, 2, 'do_low', 1, 2.2, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  v_claim := public.art96_claim_push_deliveries(100, 120);
  if v_claim->>'status' <> 'ok' or jsonb_array_length(v_claim->'deliveries') > 100 then
    raise exception 'bounded send claim returned an invalid result';
  end if;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'installation B had no current-generation delivery claim'; end if;
  v_result := public.art96_register_push_token(v_install_b, v_project, 'android', 'ExponentPushToken[synthetic_android_token_B002]');
  if v_result->>'status' <> 'ok' then raise exception 'token rotation after claim failed'; end if;
  v_result := public.art96_begin_push_send(
    (v_delivery->>'delivery_id')::uuid, (v_delivery->>'lease_id')::uuid,
    (v_delivery->>'token_generation')::bigint
  );
  if v_result->>'status' <> 'stale' then raise exception 'old-generation lease survived token rotation'; end if;

  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_4, v_device_a, v_boot_a, 3, 'do_low', 1, 2.0, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  -- ART-102: the push names the feeder from the shared name, never a per-phone legacy alias.
  update public.devices set alias = 'Shared pond feeder' where device_id = v_device_a;
  v_claim := public.art96_claim_push_deliveries(100, 120);
  v_delivery := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text and v_delivery->>'event_id' = v_event_4::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'current-generation delivery was not claimed'; end if;
  if v_delivery->>'device_name' <> 'Shared pond feeder' then
    raise exception 'claim did not use the shared feeder name';
  end if;
  v_result := public.art96_begin_push_send(
    (v_delivery->>'delivery_id')::uuid, (v_delivery->>'lease_id')::uuid,
    (v_delivery->>'token_generation')::bigint
  );
  if v_result->>'status' <> 'ok' or v_result->>'expo_push_token' <> 'ExponentPushToken[synthetic_android_token_B002]' then
    raise exception 'claim did not revalidate active access and current token generation';
  end if;
  if v_result->>'device_name' <> 'Shared pond feeder' then
    raise exception 'send did not use the shared feeder name';
  end if;
  v_delivery_id := (v_delivery->>'delivery_id')::uuid;
  v_lease_id := (v_delivery->>'lease_id')::uuid;
  v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
    (v_delivery->>'token_generation')::bigint, 'accepted', 'synthetic-ticket-0001', null);
  if v_result->>'status' <> 'ok' then raise exception 'accepted synthetic ticket was not recorded'; end if;
  update private.alert_push_deliveries set receipt_next_at = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id and state = 'accepted';
  v_claim := public.art96_claim_push_receipts(100, 120);
  v_receipt := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'receipts') loop
    if v_delivery->>'delivery_id' = v_delivery_id::text then v_receipt := v_delivery; exit; end if;
  end loop;
  if v_receipt is null or v_receipt->>'ticket_id' <> 'synthetic-ticket-0001' then raise exception 'accepted ticket was not eligible for bounded receipt polling'; end if;
  v_result := public.art96_record_push_receipt(v_delivery_id, (v_receipt->>'lease_id')::uuid, 'ok', null);
  if v_result->>'status' <> 'ok' or not exists(select 1 from private.alert_push_deliveries where delivery_id = v_delivery_id and state = 'delivered') then
    raise exception 'synthetic accepted receipt was not finalized';
  end if;

  -- A batch loser becomes stale after begin, and only active current-generation leases validate.
  insert into public.device_telemetry(
    device_id, boot_id, sample_sequence, measured_at, time_quality,
    do_mg_l, do_quality, feed_remaining_g, feed_percent, feed_quality,
    calibration_revision
  ) values
    (v_device_a, v_boot_a, 5, pg_catalog.clock_timestamp(), 'rtc', 1.6, 'valid', null, null, 'unavailable', null),
    (v_device_a, v_boot_a, 6, pg_catalog.clock_timestamp(), 'rtc', 1.4, 'valid', null, null, 'unavailable', null),
    (v_device_a, v_boot_a, 7, pg_catalog.clock_timestamp(), 'rtc', 1.2, 'valid', null, null, 'unavailable', null);
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_6, v_device_a, v_boot_a, 4, 'do_low', 1, 1.8, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  v_claim := public.art96_claim_push_deliveries(100, 120);
  v_delivery := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text and v_delivery->>'event_id' = v_event_6::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'retry ceiling test delivery was not claimed'; end if;
  v_delivery_id := (v_delivery->>'delivery_id')::uuid;
  v_lease_id := (v_delivery->>'lease_id')::uuid;
  v_result := public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint);
  if v_result->>'status' <> 'ok' then raise exception 'first send lease was not acquired'; end if;
  if public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint)->>'status' <> 'stale' then
    raise exception 'concurrent send loser reused a claimed lease';
  end if;
  v_result := public.art96_validate_push_send_batch(jsonb_build_array(jsonb_build_object(
    'delivery_id', v_delivery_id, 'lease_id', v_lease_id,
    'token_generation', (v_delivery->>'token_generation')::bigint
  )));
  if v_result->>'status' <> 'ok' or v_result->'delivery_ids' <> jsonb_build_array(v_delivery_id) then
    raise exception 'current sending lease failed active-access and generation validation';
  end if;
  v_result := public.art96_validate_push_send_batch(jsonb_build_array(jsonb_build_object(
    'delivery_id', v_delivery_id, 'lease_id', v_lease_id,
    'token_generation', (v_delivery->>'token_generation')::bigint,
    'extra_token', 'ExponentPushToken[synthetic_unknown_key_probe]'
  )));
  if v_result->>'status' <> 'invalid_input' then raise exception 'batch claim accepted an unknown field'; end if;
  v_result := public.art96_validate_push_send_batch(jsonb_build_array(jsonb_build_object(
    'delivery_id', v_delivery_id, 'lease_id', v_lease_id,
    'token_generation', 9223372036854775808::numeric
  )));
  if v_result->>'status' <> 'invalid_input' then raise exception 'batch claim accepted a generation above bigint bounds'; end if;
  v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
    (v_delivery->>'token_generation')::bigint, 'retry', null, 'transport_retry');
  for v_attempt in 2..5 loop
    update private.alert_push_deliveries set next_attempt_at = pg_catalog.clock_timestamp() - interval '1 second'
     where delivery_id = v_delivery_id and state = 'retry';
    v_claim := public.art96_claim_push_deliveries(100, 120);
    v_delivery := null;
    for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
      if v_delivery->>'delivery_id' = v_delivery_id::text then exit; end if;
      v_delivery := null;
    end loop;
    if v_delivery is null then raise exception 'bounded retry attempt % was not claimed', v_attempt; end if;
    v_lease_id := (v_delivery->>'lease_id')::uuid;
    v_result := public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint);
    if v_result->>'status' <> 'ok' then raise exception 'bounded retry attempt % was not started', v_attempt; end if;
    v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
      (v_delivery->>'token_generation')::bigint, 'retry', null, 'transport_retry');
  end loop;
  if not exists(select 1 from private.alert_push_deliveries where delivery_id = v_delivery_id and state = 'failed' and attempt_count = 5) then
    raise exception 'send retries exceeded the five-attempt ceiling';
  end if;

  -- Accepted ticket retries keep the ticket and stop permanently after three receipt leases.
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_7, v_device_a, v_boot_a, 5, 'do_low', 1, 1.6, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  v_claim := public.art96_claim_push_deliveries(100, 120);
  v_delivery := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text and v_delivery->>'event_id' = v_event_7::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'receipt retry test delivery was not claimed'; end if;
  v_delivery_id := (v_delivery->>'delivery_id')::uuid;
  v_lease_id := (v_delivery->>'lease_id')::uuid;
  v_result := public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint);
  v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
    (v_delivery->>'token_generation')::bigint, 'accepted', 'synthetic-ticket-retry-0001', null);
  update private.alert_push_deliveries set receipt_next_at = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id;
  v_claim := public.art96_claim_push_receipts(100, 120);
  v_receipt := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'receipts') loop
    if v_delivery->>'delivery_id' = v_delivery_id::text then v_receipt := v_delivery; exit; end if;
  end loop;
  v_result := public.art96_record_push_receipt(v_delivery_id, (v_receipt->>'lease_id')::uuid, 'retry', 'receipt_not_ready');
  if not exists(select 1 from private.alert_push_deliveries where delivery_id = v_delivery_id and state = 'accepted' and ticket_id = 'synthetic-ticket-retry-0001') then
    raise exception 'missing receipt incorrectly discarded an accepted ticket';
  end if;
  update private.alert_push_deliveries set receipt_next_at = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id;
  v_claim := public.art96_claim_push_receipts(100, 120);
  v_receipt := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'receipts') loop
    if v_delivery->>'delivery_id' = v_delivery_id::text then v_receipt := v_delivery; exit; end if;
  end loop;
  update private.alert_push_deliveries set receipt_lease_until = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id and receipt_lease_id = (v_receipt->>'lease_id')::uuid;
  perform public.art96_claim_push_receipts(100, 120);
  if not exists(select 1 from private.alert_push_deliveries where delivery_id = v_delivery_id and state = 'accepted' and receipt_attempts = 2 and receipt_lease_id is null and ticket_id = 'synthetic-ticket-retry-0001') then
    raise exception 'expired receipt lease did not preserve the accepted ticket for bounded retry';
  end if;
  update private.alert_push_deliveries set receipt_next_at = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id;
  v_claim := public.art96_claim_push_receipts(100, 120);
  v_receipt := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'receipts') loop
    if v_delivery->>'delivery_id' = v_delivery_id::text then v_receipt := v_delivery; exit; end if;
  end loop;
  if v_receipt is null then raise exception 'third bounded receipt lease was not issued'; end if;
  update private.alert_push_deliveries set receipt_lease_until = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id and receipt_lease_id = (v_receipt->>'lease_id')::uuid;
  perform public.art96_claim_push_receipts(100, 120);
  if not exists(select 1 from private.alert_push_deliveries where delivery_id = v_delivery_id and state = 'failed' and receipt_attempts = 3 and ticket_id = 'synthetic-ticket-retry-0001') then
    raise exception 'third expired receipt lease remained eligible or discarded its ticket';
  end if;

  -- Receipt credentials fail closed and sanitize owner status; a new send credential failure pauses too.
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_8, v_device_a, v_boot_a, 6, 'do_low', 1, 1.4, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  v_claim := public.art96_claim_push_deliveries(100, 120);
  v_delivery := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text and v_delivery->>'event_id' = v_event_8::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'receipt credential test delivery was not claimed'; end if;
  v_delivery_id := (v_delivery->>'delivery_id')::uuid;
  v_lease_id := (v_delivery->>'lease_id')::uuid;
  v_result := public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint);
  v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
    (v_delivery->>'token_generation')::bigint, 'accepted', 'synthetic-ticket-credentials-0001', null);
  update private.alert_push_deliveries set receipt_next_at = pg_catalog.clock_timestamp() - interval '1 second'
   where delivery_id = v_delivery_id;
  v_claim := public.art96_claim_push_receipts(100, 120);
  v_receipt := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'receipts') loop
    if v_delivery->>'delivery_id' = v_delivery_id::text then v_receipt := v_delivery; exit; end if;
  end loop;
  v_result := public.art96_record_push_receipt(v_delivery_id, (v_receipt->>'lease_id')::uuid, 'retry', 'InvalidCredentials');
  if public.art96_push_sender_status()->>'reason' <> 'invalid_credentials' then
    raise exception 'receipt endpoint credentials did not pause delivery safely';
  end if;
  update private.alert_push_sender_state set paused = false, pause_reason = null where singleton;
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_9, v_device_a, v_boot_a, 7, 'do_low', 1, 1.2, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  v_claim := public.art96_claim_push_deliveries(100, 120);
  v_delivery := null;
  for v_delivery in select value from jsonb_array_elements(v_claim->'deliveries') loop
    if v_delivery->>'installation_id' = v_install_b::text and v_delivery->>'event_id' = v_event_9::text then exit; end if;
    v_delivery := null;
  end loop;
  if v_delivery is null then raise exception 'send credential test delivery was not claimed'; end if;
  v_delivery_id := (v_delivery->>'delivery_id')::uuid;
  v_lease_id := (v_delivery->>'lease_id')::uuid;
  v_result := public.art96_begin_push_send(v_delivery_id, v_lease_id, (v_delivery->>'token_generation')::bigint);
  v_result := public.art96_record_push_send(v_delivery_id, v_lease_id,
    (v_delivery->>'token_generation')::bigint, 'invalid_credentials', null, 'invalid_credentials');
  if public.art96_push_sender_status()->>'reason' <> 'invalid_credentials' then
    raise exception 'send credentials did not pause delivery safely';
  end if;

  v_result := public.art96_read_alert_event(v_device_a, v_event_1, v_install_b);
  if v_result->>'status' <> 'ok' then raise exception 'active member could not read its event'; end if;
  v_result := public.art38_revoke_device_access(v_device_a, v_install_a);
  if v_result->>'status' <> 'revoked' then raise exception 'direct authorized access revocation failed'; end if;
  if not exists(select 1 from private.installation_push_tokens where installation_id = v_install_a and expo_push_token = 'ExponentPushToken[synthetic_android_token_A002]') then
    raise exception 'revoking one feeder removed a token still used by another active feeder';
  end if;
  if (public.art96_read_alert_event(v_device_a, v_event_1, v_install_a)->>'status') <> 'not_active' then
    raise exception 'revoked feeder event remained readable';
  end if;
  v_result := public.art38_revoke_device_access(v_device_a, v_install_b);
  if v_result->>'status' <> 'revoked' then raise exception 'last-membership revocation failed'; end if;
  if exists(select 1 from private.installation_push_tokens where installation_id = v_install_b and expo_push_token is not null) then
    raise exception 'last membership revocation retained the installation token';
  end if;

  v_result := public.art96_register_push_token(v_install_c, v_project, 'android', 'ExponentPushToken[synthetic_android_token_C001]');
  if v_result->>'status' <> 'ok' then raise exception 'installation C registration failed'; end if;
  v_result := public.art96_revoke_push_token(v_install_c);
  if v_result->>'status' <> 'ok' or exists(select 1 from private.installation_push_tokens where installation_id = v_install_c and expo_push_token is not null) then
    raise exception 'direct authorized token revocation did not remove the current token';
  end if;
  v_result := public.art96_register_push_token(v_install_c, v_project, 'android', 'ExponentPushToken[synthetic_android_token_C002]');
  if v_result->>'status' <> 'ok' then raise exception 'installation C token re-registration failed'; end if;
  insert into public.alert_events(
    event_id, device_id, boot_id, sample_sequence, alert_kind, applied_revision,
    metric_value, limit_value, measured_at, raised_at, is_simulated
  ) values
    (v_event_5, v_device_b, v_boot_b, 2, 'do_low', 1, 2.1, 4, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), true);
  delete from auth.users where id = v_install_c;
  if not exists(select 1 from private.alert_push_deliveries where event_id = v_event_5 and installation_id = v_install_c and state = 'cancelled') then
    raise exception 'Auth user deletion did not cancel unsent delivery';
  end if;

  if exists(select 1 from private.alert_push_deliveries where state = 'sending' and lease_until < pg_catalog.clock_timestamp()) then
    raise exception 'expired leases remained in sending state after claim processing';
  end if;
end $$;

rollback;
