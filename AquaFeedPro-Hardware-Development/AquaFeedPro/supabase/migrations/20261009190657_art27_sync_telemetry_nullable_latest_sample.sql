create or replace function public.art27_sync_telemetry(
  p_device_id uuid,
  p_device_verifier_hex text,
  p_boot_id uuid,
  p_live_sequence bigint,
  p_latest_sample jsonb,
  p_backlog_samples jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_sample jsonb;
  v_latest_sample jsonb := coalesce(p_latest_sample, 'null'::jsonb);
  v_boot uuid;
  v_sequence bigint;
  v_measured_at timestamptz;
  v_time_quality text;
  v_do numeric;
  v_do_quality text;
  v_remaining numeric;
  v_percent numeric;
  v_feed_quality text;
  v_calibration integer;
  v_existing public.device_telemetry%rowtype;
  v_ack jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_identity text;
  v_rows jsonb;
  v_state public.device_state%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_is_live boolean;
  v_quality text;
  v_freshness text;
begin
  if p_device_id is null or p_device_verifier_hex is null
     or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status','auth_required');
  end if;
  perform 1 from private.device_credentials c
    where c.device_id = p_device_id
      and c.credential_verifier = pg_catalog.decode(pg_catalog.lower(p_device_verifier_hex),'hex')
      and c.revoked_at is null for share;
  if not found then return jsonb_build_object('status','auth_required'); end if;
  if p_boot_id is null or p_live_sequence is null or p_live_sequence < 0
     or jsonb_typeof(v_latest_sample) not in ('object','null')
     or p_backlog_samples is null or jsonb_typeof(p_backlog_samples) <> 'array'
     or jsonb_array_length(p_backlog_samples) >
       (case when v_latest_sample = 'null'::jsonb then 100 else 99 end)
     or jsonb_array_length(p_backlog_samples) +
       (case when v_latest_sample = 'null'::jsonb then 0 else 1 end) > 100 then
    raise exception using errcode='22023', message='invalid telemetry batch';
  end if;
  select * into strict v_state from public.device_state s where s.device_id=p_device_id for update;
  perform 1 from public.devices d where d.device_id=p_device_id and d.protocol_major=2 for update;
  if not found then raise exception using errcode='22023', message='unknown device'; end if;

  v_rows := p_backlog_samples;
  if v_latest_sample <> 'null'::jsonb then
    v_rows := v_rows || jsonb_build_array(v_latest_sample || jsonb_build_object('boot_id',p_boot_id,'live_sequence',p_live_sequence));
  end if;
  for v_sample in select value from jsonb_array_elements(v_rows) loop
    if jsonb_typeof(v_sample) <> 'object'
       or not (v_sample ?& array['boot_id','sequence','measured_at','time_quality','do_mg_l','do_quality','feed_remaining_g','feed_percent','feed_quality','calibration_revision'])
       or (v_sample - array['boot_id','sequence','live_sequence','measured_at','time_quality','do_mg_l','do_quality','feed_remaining_g','feed_percent','feed_quality','calibration_revision']::text[]) <> '{}'::jsonb then
      raise exception using errcode='22023', message='invalid telemetry sample keys';
    end if;
    v_boot := (v_sample->>'boot_id')::uuid;
    v_sequence := (v_sample->>'sequence')::bigint;
    v_identity := v_boot::text || ':' || v_sequence::text;
    if v_sequence < 0 or v_identity = any(v_seen) then
      raise exception using errcode='22023', message='duplicate or invalid telemetry identity';
    end if;
    v_seen := array_append(v_seen,v_identity);
    v_is_live := v_latest_sample <> 'null'::jsonb
      and v_boot=p_boot_id and v_sequence=p_live_sequence;
    if v_is_live and v_sample->>'live_sequence' is distinct from p_live_sequence::text then
      raise exception using errcode='22023', message='live sequence mismatch';
    end if;
    if not v_is_live and v_sample ? 'live_sequence' then
      raise exception using errcode='22023', message='historical sample cannot be live';
    end if;
    v_time_quality := v_sample->>'time_quality';
    if v_time_quality not in ('synced','rtc','uncertain','invalid')
       or (v_time_quality='invalid' and v_sample->'measured_at' <> 'null'::jsonb)
       or (v_time_quality<>'invalid' and jsonb_typeof(v_sample->'measured_at') <> 'string') then
      raise exception using errcode='22023', message='invalid telemetry time quality';
    end if;
    v_measured_at := case when v_sample->'measured_at' = 'null'::jsonb then null else (v_sample->>'measured_at')::timestamptz end;
    v_do_quality := v_sample->>'do_quality';
    v_feed_quality := v_sample->>'feed_quality';
    v_do := case when v_sample->'do_mg_l'='null'::jsonb then null else (v_sample->>'do_mg_l')::numeric end;
    v_remaining := case when v_sample->'feed_remaining_g'='null'::jsonb then null else (v_sample->>'feed_remaining_g')::numeric end;
    v_percent := case when v_sample->'feed_percent'='null'::jsonb then null else (v_sample->>'feed_percent')::numeric end;
    v_calibration := case when v_sample->'calibration_revision'='null'::jsonb then null else (v_sample->>'calibration_revision')::integer end;
    if v_do_quality not in ('valid','unavailable','uncalibrated','error')
       or v_feed_quality not in ('valid','unavailable','uncalibrated','error')
       or (v_do_quality='valid') <> (v_do is not null)
       or (v_feed_quality='valid') <> (v_remaining is not null and v_percent is not null and v_calibration is not null and v_calibration>0)
       or (v_feed_quality<>'valid' and (v_remaining is not null or v_percent is not null or v_calibration is not null))
       or v_do < 0 or v_remaining < 0 or v_percent not between 0 and 100 then
      raise exception using errcode='22023', message='invalid telemetry values';
    end if;
    select * into v_existing from public.device_telemetry t
      where t.device_id=p_device_id and t.boot_id=v_boot and t.sample_sequence=v_sequence;
    if found then
      if v_existing.measured_at is distinct from v_measured_at
         or v_existing.time_quality is distinct from v_time_quality
         or v_existing.do_mg_l is distinct from v_do
         or v_existing.do_quality is distinct from v_do_quality
         or v_existing.feed_remaining_g is distinct from v_remaining
         or v_existing.feed_percent is distinct from v_percent
         or v_existing.feed_quality is distinct from v_feed_quality
         or v_existing.calibration_revision is distinct from v_calibration then
        raise exception using errcode='23505', message='immutable telemetry identity conflict';
      end if;
    else
      insert into public.device_telemetry(device_id,boot_id,sample_sequence,measured_at,time_quality,
        do_mg_l,do_quality,feed_remaining_g,feed_percent,feed_quality,calibration_revision,received_at)
      values(p_device_id,v_boot,v_sequence,v_measured_at,v_time_quality,v_do,v_do_quality,
        v_remaining,v_percent,v_feed_quality,v_calibration,v_now);
    end if;
    v_ack := v_ack || jsonb_build_array(jsonb_build_object('boot_id',v_boot,'sequence',v_sequence));
    if v_is_live and p_live_sequence > v_state.live_sequence then
      v_quality := case when v_do_quality='valid' or v_feed_quality='valid' then 'valid'
        when v_do_quality='error' or v_feed_quality='error' then 'error'
        when v_do_quality='uncalibrated' or v_feed_quality='uncalibrated' then 'uncalibrated' else 'unavailable' end;
      v_freshness := case when v_measured_at is not null and v_time_quality in ('synced','rtc')
        and v_measured_at <= v_now and v_measured_at >= v_now - interval '30 seconds'
        and v_quality='valid' then 'fresh' else 'stale' end;
      update public.device_state set
        live_sequence=p_live_sequence,
        latest_telemetry_boot_id=v_boot,
        latest_telemetry_sequence=v_sequence,
        last_sample_at=case when v_time_quality in ('synced','rtc') then v_measured_at else null end,
        sample_freshness=case when v_time_quality in ('synced','rtc') and v_measured_at is not null then v_freshness else 'unknown' end,
        sample_quality=v_quality,
        updated_at=v_now
        where device_id=p_device_id;
      v_state.live_sequence := p_live_sequence;
    end if;
  end loop;
  update public.device_state set last_authenticated_contact_at=v_now,
    contact_freshness='fresh', updated_at=v_now where device_id=p_device_id;
  if p_live_sequence > v_state.live_sequence then
    update public.device_state set live_sequence=p_live_sequence,updated_at=v_now where device_id=p_device_id;
  end if;
  return jsonb_build_object('status','ok','server_time',v_now,'acknowledged_samples',v_ack);
end;
$$;
revoke all on function public.art27_sync_telemetry(uuid,text,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.art27_sync_telemetry(uuid,text,uuid,bigint,jsonb,jsonb) to service_role;
