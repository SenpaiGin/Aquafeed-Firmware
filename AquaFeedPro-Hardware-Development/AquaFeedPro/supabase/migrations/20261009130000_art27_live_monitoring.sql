-- ART-27: authenticated telemetry and protected monitoring reads.
-- Retention deletion stays disabled pending owner policy.
alter table public.device_state
  add column live_sequence bigint not null default -1 check (live_sequence >= -1),
  add column latest_telemetry_boot_id uuid,
  add column latest_telemetry_sequence bigint,
  add constraint device_state_latest_telemetry_fkey
    foreign key (device_id, latest_telemetry_boot_id, latest_telemetry_sequence)
    references public.device_telemetry(device_id, boot_id, sample_sequence),
  add constraint device_state_latest_telemetry_pair_check
    check ((latest_telemetry_boot_id is null) = (latest_telemetry_sequence is null));

create index device_telemetry_measured_at_idx
  on public.device_telemetry(device_id, measured_at desc)
  where measured_at is not null;

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
     or p_latest_sample is null
     or jsonb_typeof(p_latest_sample) not in ('object','null')
     or p_backlog_samples is null or jsonb_typeof(p_backlog_samples) <> 'array'
     or jsonb_array_length(p_backlog_samples) >
       (case when p_latest_sample = 'null'::jsonb then 100 else 99 end)
     or jsonb_array_length(p_backlog_samples) +
       (case when p_latest_sample = 'null'::jsonb then 0 else 1 end) > 100 then
    raise exception using errcode='22023', message='invalid telemetry batch';
  end if;
  select * into strict v_state from public.device_state s where s.device_id=p_device_id for update;
  perform 1 from public.devices d where d.device_id=p_device_id and d.protocol_major=2 for update;
  if not found then raise exception using errcode='22023', message='unknown device'; end if;

  v_rows := p_backlog_samples;
  if p_latest_sample is not null and p_latest_sample <> 'null'::jsonb then
    v_rows := v_rows || jsonb_build_array(p_latest_sample || jsonb_build_object('boot_id',p_boot_id,'live_sequence',p_live_sequence));
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
    v_is_live := p_latest_sample is not null and p_latest_sample <> 'null'::jsonb
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

create or replace function public.art27_monitoring_snapshot(
  p_device_id uuid, p_installation_id uuid, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_state public.device_state%rowtype;
  v_sample public.device_telemetry%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_contact_age integer;
  v_sample_age integer;
  v_ingestion_age integer;
  v_do_quality text;
  v_feed_quality text;
  v_do numeric;
  v_remaining numeric;
  v_percent numeric;
  v_do_freshness text;
  v_feed_freshness text;
begin
  perform 1 from public.device_access a where a.device_id=p_device_id and a.installation_id=p_installation_id and a.status='active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  select * into v_device from public.devices d where d.device_id=p_device_id;
  select * into v_state from public.device_state s where s.device_id=p_device_id;
  if v_device.device_id is null or v_state.device_id is null then return jsonb_build_object('status','not_found'); end if;
  if v_state.last_authenticated_contact_at is not null then v_contact_age:=greatest(0,floor(extract(epoch from v_now-v_state.last_authenticated_contact_at))::integer); end if;
  if v_state.latest_telemetry_boot_id is not null then
    select * into v_sample from public.device_telemetry t where t.device_id=p_device_id and t.boot_id=v_state.latest_telemetry_boot_id and t.sample_sequence=v_state.latest_telemetry_sequence;
    v_ingestion_age:=greatest(0,floor(extract(epoch from v_now-v_sample.received_at))::integer);
    if v_sample.measured_at is not null and v_sample.time_quality in ('synced','rtc') and v_sample.measured_at<=v_now then
      v_sample_age:=greatest(0,floor(extract(epoch from v_now-v_sample.measured_at))::integer);
    end if;
    v_do_quality:=case when coalesce((v_device.capabilities->>'do_monitoring')::boolean,false) then v_sample.do_quality else 'unavailable' end;
    v_feed_quality:=case when coalesce((v_device.capabilities->>'feed_remaining_monitoring')::boolean,false) then v_sample.feed_quality else 'unavailable' end;
    if v_sample.time_quality not in ('synced','rtc') or v_sample.measured_at is null or v_sample.measured_at>v_now then
      v_do_quality:=case when v_do_quality='valid' then 'unavailable' else v_do_quality end;
      v_feed_quality:=case when v_feed_quality='valid' then 'unavailable' else v_feed_quality end;
    end if;
    v_do:=case when v_do_quality='valid' then v_sample.do_mg_l else null end;
    v_remaining:=case when v_feed_quality='valid' then v_sample.feed_remaining_g else null end;
    v_percent:=case when v_feed_quality='valid' then v_sample.feed_percent else null end;
    v_do_freshness:=case when v_do_quality<>'valid' then 'unknown' when v_sample_age<=30 then 'fresh' else 'stale' end;
    v_feed_freshness:=case when v_feed_quality<>'valid' then 'unknown' when v_sample_age<=30 then 'fresh' else 'stale' end;
  end if;
  return jsonb_build_object('status','ok','request_id',p_request_id,'device_id',p_device_id,'server_time',v_now,
    'profile',jsonb_build_object('firmware_version',v_device.firmware_version,'protocol_major',v_device.protocol_major,
      'capabilities_revision',v_device.capabilities_revision,'capabilities',v_device.capabilities,'is_simulated',v_device.is_simulated),
    'contact',jsonb_build_object('authenticated_at',v_state.last_authenticated_contact_at,'age_seconds',v_contact_age,
      'freshness',case when v_contact_age is null then 'unknown' when v_contact_age<=45 then 'fresh' else 'stale' end),
    'configuration',jsonb_build_object('desired_revision',v_device.desired_revision,'applied_revision',v_device.applied_revision,
      'pending_revision',case when v_device.last_attempt_status='pending' then v_device.last_attempt_revision else null end,
      'last_attempt_status',v_device.last_attempt_status,'error_code',v_device.configuration_error_code),
    'latest_sample',case when v_state.latest_telemetry_boot_id is null then null else jsonb_build_object(
      'boot_id',v_sample.boot_id,'sequence',v_sample.sample_sequence,'live_sequence',v_sample.sample_sequence,
      'measured_at',v_sample.measured_at,'time_quality',v_sample.time_quality,'do_mg_l',v_do,'do_quality',v_do_quality,
      'feed_remaining_g',v_remaining,'feed_percent',v_percent,'feed_quality',v_feed_quality,
      'calibration_revision',case when v_feed_quality='valid' then v_sample.calibration_revision else null end,
      'received_at',v_sample.received_at,'sample_age_seconds',v_sample_age,'ingestion_age_seconds',v_ingestion_age,
      'do_freshness',v_do_freshness,'feed_freshness',v_feed_freshness) end,
    'display_policy',jsonb_build_object('kind','planning_display_policy','device_offline_after_seconds',45,
      'metric_outdated_after_seconds',30,'foreground_refresh_after_seconds',15));
end;
$$;
revoke all on function public.art27_monitoring_snapshot(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.art27_monitoring_snapshot(uuid,uuid,uuid) to service_role;

create or replace function public.art27_do_graph(
  p_device_id uuid, p_installation_id uuid, p_request_id uuid, p_window text, p_count integer
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_start timestamptz;
  v_duration interval;
  v_device public.devices%rowtype;
  v_rows integer;
  v_valid integer;
  v_invalid_time integer;
  v_gaps integer;
  v_samples jsonb;
begin
  perform 1 from public.device_access a where a.device_id=p_device_id and a.installation_id=p_installation_id and a.status='active' for share;
  if not found then return jsonb_build_object('status','not_active'); end if;
  if p_window not in ('1h','6h','24h') or p_count not between 1 and 100 then return jsonb_build_object('status','invalid'); end if;
  v_duration:=case p_window when '1h' then interval '1 hour' when '6h' then interval '6 hours' else interval '24 hours' end;
  v_start:=v_now-v_duration;
  select * into v_device from public.devices d where d.device_id=p_device_id;
  if v_device.device_id is null then return jsonb_build_object('status','not_found'); end if;
  select count(*) into v_rows from public.device_telemetry t where t.device_id=p_device_id and t.measured_at>=v_start and t.measured_at<v_now and t.time_quality in ('synced','rtc');
  select count(*) into v_valid from public.device_telemetry t where t.device_id=p_device_id and t.measured_at>=v_start and t.measured_at<v_now and t.time_quality in ('synced','rtc') and t.do_quality='valid' and coalesce((v_device.capabilities->>'do_monitoring')::boolean,false);
  select count(*) into v_invalid_time from public.device_telemetry t where t.device_id=p_device_id and t.received_at>=v_start and t.received_at<v_now and (t.time_quality not in ('synced','rtc') or t.measured_at is null or t.measured_at>v_now);
  with bins as (
    select g as n, v_start+(v_duration*g/p_count::double precision) as bucket_start,
      v_start+(v_duration*(g+1)/p_count::double precision) as bucket_end
    from generate_series(0,p_count-1) g
  ), chosen as (
    select b.*, t.measured_at,t.received_at,t.do_mg_l,t.do_quality,t.time_quality,c.sample_count
    from bins b
    cross join lateral (
      select count(*)::integer as sample_count from public.device_telemetry x
      where x.device_id=p_device_id and x.time_quality in ('synced','rtc')
        and x.measured_at>=b.bucket_start and x.measured_at<b.bucket_end
    ) c
    left join lateral (
      select x.* from public.device_telemetry x where x.device_id=p_device_id
        and x.time_quality in ('synced','rtc') and x.measured_at>=b.bucket_start and x.measured_at<b.bucket_end
      order by x.measured_at desc,x.received_at desc limit 1
    ) t on true
  ), mapped as (
    select n,bucket_start,bucket_end,measured_at,received_at,
      case when not coalesce((v_device.capabilities->>'do_monitoring')::boolean,false) then null else do_mg_l end as do_mg_l,
      case when not coalesce((v_device.capabilities->>'do_monitoring')::boolean,false) then 'unavailable' else do_quality end as do_quality,
      sample_count,
      case
      when not coalesce((v_device.capabilities->>'do_monitoring')::boolean,false) then 'unsupported'
      when measured_at is null then 'no_sample'
      when time_quality not in ('synced','rtc') then 'untrusted_time'
      when do_quality='uncalibrated' then 'uncalibrated'
      when do_quality='error' then 'error'
      when do_quality<>'valid' then 'unavailable'
      else null end as gap_reason
    from chosen
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket_start',bucket_start,'bucket_end',bucket_end,
    'measured_at',measured_at,'received_at',received_at,
    'do_mg_l',case when gap_reason is null then do_mg_l else null end,
    'do_quality',case when measured_at is null then null else do_quality end,
    'gap_reason',gap_reason,'sample_count',coalesce(sample_count,0)) order by n),'[]'::jsonb),
    count(*) filter(where gap_reason is not null)
    into v_samples,v_gaps from mapped;
  return jsonb_build_object('status','ok','request_id',p_request_id,'device_id',p_device_id,'server_time',v_now,
    'window',p_window,'window_start',v_start,'window_end',v_now,'requested_count',p_count,'returned_count',p_count,
    'sample_count',v_rows,'valid_sample_count',v_valid,'invalid_time_sample_count',v_invalid_time,'gap_count',v_gaps,
    'samples',v_samples,'display_policy',jsonb_build_object('kind','planning_display_policy','device_offline_after_seconds',45,
      'metric_outdated_after_seconds',30,'foreground_refresh_after_seconds',15));
end;
$$;
revoke all on function public.art27_do_graph(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.art27_do_graph(uuid,uuid,uuid,text,integer) to service_role;

do $$
begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_telemetry') then
      alter publication supabase_realtime add table public.device_telemetry;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_state') then
      alter publication supabase_realtime add table public.device_state;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_events') then
      alter publication supabase_realtime add table public.device_events;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_config_revisions') then
      alter publication supabase_realtime add table public.device_config_revisions;
    end if;
  end if;
end;
$$;
