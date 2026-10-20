-- ART-38 D2 pairing and installation access. Review this migration before
-- applying it; it does not touch production or any feeder hardware.

alter table private.pairing_challenges
  add column request_id uuid,
  add column attempt_count smallint not null default 0
    check (attempt_count between 0 and 5);
create unique index pairing_challenges_request_id_key
  on private.pairing_challenges (request_id)
  where request_id is not null;
create index pairing_challenges_expiry_idx
  on private.pairing_challenges (expires_at);

create table private.api_rate_windows (
  endpoint text not null check (endpoint in ('pair', 'device_write', 'pairing_window')),
  subject text not null,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (endpoint, subject)
);
alter table private.api_rate_windows enable row level security;
revoke all on private.api_rate_windows from public, anon, authenticated;
grant all on private.api_rate_windows to service_role;

-- Public-schema RPCs are invoker functions. Their execute grant is restricted
-- to service_role, which already has server-only access to the private schema.
create or replace function public.art38_take_rate_limit(
  p_endpoint text,
  p_subject text
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_limit integer;
  v_window_seconds integer;
  v_count integer;
  v_now timestamptz := now();
begin
  if p_endpoint = 'pair' then
    v_limit := 10;
    v_window_seconds := 600;
  elsif p_endpoint = 'device_write' then
    v_limit := 60;
    v_window_seconds := 60;
  elsif p_endpoint = 'pairing_window' then
    v_limit := 5;
    v_window_seconds := 300;
  else
    return false;
  end if;
  if p_subject is null or length(p_subject) not between 1 and 80 then
    return false;
  end if;

  insert into private.api_rate_windows as current_window
    (endpoint, subject, window_started_at, request_count)
  values (p_endpoint, p_subject, v_now, 1)
  on conflict (endpoint, subject) do update set
    window_started_at = case
      when current_window.window_started_at <= v_now - make_interval(secs => v_window_seconds)
        then v_now
      else current_window.window_started_at
    end,
    request_count = case
      when current_window.window_started_at <= v_now - make_interval(secs => v_window_seconds)
        then 1
      else current_window.request_count + 1
    end
  returning request_count into v_count;

  return v_count <= v_limit;
end;
$$;

create or replace function public.art38_authenticate_device(
  p_verifier_hex text
) returns uuid
language sql
stable
set search_path = ''
as $$
  select c.device_id
  from private.device_credentials c
  where p_verifier_hex ~ '^[0-9a-fA-F]{64}$'
    and c.credential_verifier = decode(lower(p_verifier_hex), 'hex')
    and c.revoked_at is null
  limit 1
$$;

create or replace function public.art38_create_pairing_challenge(
  p_device_id uuid,
  p_challenge_id uuid,
  p_request_id uuid,
  p_verifier_hex text,
  p_device_verifier_hex text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
  v_credential_device_id uuid;
begin
  if p_device_id is null or p_challenge_id is null or p_request_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_verifier_hex is null or p_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_device_verifier_hex is null or p_device_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'not_active');
  end if;
  -- Hold this row lock through challenge creation. A concurrent credential
  -- rotation then either follows and consumes the new challenge, or wins first
  -- and makes this stale credential fail closed.
  select c.device_id into v_credential_device_id
  from private.device_credentials c
  where c.device_id = p_device_id
    and c.credential_verifier = decode(lower(p_device_verifier_hex), 'hex')
    and c.revoked_at is null
  for update;
  if not found or v_credential_device_id <> p_device_id then
    return jsonb_build_object('status', 'not_active');
  end if;

  delete from private.pairing_challenges
  where created_at < now() - interval '1 day';

  v_expires_at := now() + interval '5 minutes';
  insert into private.pairing_challenges
    (challenge_id, device_id, verifier, expires_at, request_id)
  values (
    p_challenge_id,
    p_device_id,
    decode(lower(p_verifier_hex), 'hex'),
    v_expires_at,
    p_request_id
  )
  on conflict (request_id) where (request_id is not null) do nothing
  returning expires_at into v_expires_at;
  if not found then
    return jsonb_build_object('status', 'request_reused');
  end if;
  return jsonb_build_object('status', 'created', 'expires_at', v_expires_at);
end;
$$;

create or replace function public.art38_redeem_pairing_challenge(
  p_device_id uuid,
  p_challenge_id uuid,
  p_installation_id uuid,
  p_verifier_hex text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_challenge private.pairing_challenges%rowtype;
  v_device public.devices%rowtype;
  v_access public.device_access%rowtype;
  v_attempt_count smallint;
  v_credential_device_id uuid;
begin
  if p_device_id is null or p_challenge_id is null or p_installation_id is null
    or p_verifier_hex is null or p_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Match create/rotation lock ordering so a stale challenge cannot race a
  -- credential revocation into granting installation access.
  select c.device_id into v_credential_device_id
  from private.device_credentials c
  where c.device_id = p_device_id
    and c.revoked_at is null
  for update;
  if not found or v_credential_device_id <> p_device_id then
    return jsonb_build_object('status', 'not_active');
  end if;

  select * into v_challenge
  from private.pairing_challenges c
  where c.challenge_id = p_challenge_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_challenge.consumed_at is not null then
    return jsonb_build_object('status', 'consumed');
  end if;
  if v_challenge.expires_at <= now() then
    update private.pairing_challenges
      set consumed_at = now()
      where challenge_id = p_challenge_id;
    return jsonb_build_object('status', 'expired');
  end if;
  if v_challenge.attempt_count >= 5 then
    update private.pairing_challenges
      set consumed_at = coalesce(consumed_at, now())
      where challenge_id = p_challenge_id;
    return jsonb_build_object('status', 'attempts_exceeded');
  end if;

  if v_challenge.device_id <> p_device_id
    or v_challenge.verifier <> decode(lower(p_verifier_hex), 'hex') then
    v_attempt_count := v_challenge.attempt_count + 1;
    update private.pairing_challenges
      set attempt_count = v_attempt_count,
          consumed_at = case when v_attempt_count >= 5 then now() else null end
      where challenge_id = p_challenge_id;
    insert into private.security_audit_events (device_id, installation_id, event_type)
      values (v_challenge.device_id, p_installation_id, 'pair_rejected');
    return jsonb_build_object(
      'status', case when v_attempt_count >= 5 then 'attempts_exceeded' else 'invalid' end
    );
  end if;

  select * into v_device from public.devices d where d.device_id = p_device_id;
  if not found then
    update private.pairing_challenges
      set consumed_at = now()
      where challenge_id = p_challenge_id;
    return jsonb_build_object('status', 'not_found');
  end if;

  if exists (
    select 1 from public.device_access a
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
  ) then
    update private.pairing_challenges
      set consumed_at = now()
      where challenge_id = p_challenge_id;
    return jsonb_build_object('status', 'already_paired');
  end if;

  insert into public.device_access
    (device_id, installation_id, status, alias, location, granted_at, revoked_at)
  values (p_device_id, p_installation_id, 'active', null, null, now(), null)
  on conflict (device_id, installation_id) do update set
    status = 'active',
    granted_at = now(), revoked_at = null;
  select * into v_access
  from public.device_access a
  where a.device_id = p_device_id
    and a.installation_id = p_installation_id
    and a.status = 'active';

  update private.pairing_challenges
    set consumed_at = now()
    where challenge_id = p_challenge_id;
  insert into private.security_audit_events (device_id, installation_id, event_type)
    values (p_device_id, p_installation_id, 'pair_granted');

  return jsonb_build_object(
    'status', 'paired',
    'device', jsonb_build_object(
      'device_id', v_device.device_id,
      'model', v_device.model,
      'firmware_version', v_device.firmware_version,
      'protocol_major', v_device.protocol_major,
      'is_simulated', v_device.is_simulated,
      'capabilities_revision', v_device.capabilities_revision,
      'capabilities', v_device.capabilities
    ),
    'access', jsonb_build_object(
      'device_id', v_access.device_id,
      'alias', v_access.alias,
      'location', v_access.location,
      'granted_at', v_access.granted_at
    )
  );
end;
$$;

create or replace function public.art38_update_device_alias(
  p_device_id uuid,
  p_installation_id uuid,
  p_alias text,
  p_location text,
  p_update_alias boolean,
  p_update_location boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_access public.device_access%rowtype;
begin
  if p_update_alias is not true and p_update_location is not true then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_update_alias is true and p_alias is not null and char_length(p_alias) > 100 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_update_location is true and p_location is not null and char_length(p_location) > 160 then
    return jsonb_build_object('status', 'invalid');
  end if;
  update public.device_access a
    set alias = case when p_update_alias then nullif(btrim(p_alias), '') else a.alias end,
        location = case when p_update_location then nullif(btrim(p_location), '') else a.location end
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
  returning * into v_access;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  insert into private.security_audit_events (device_id, installation_id, event_type)
    values (p_device_id, p_installation_id, 'device_label_updated');
  return jsonb_build_object(
    'status', 'updated',
    'device_id', v_access.device_id,
    'alias', v_access.alias,
    'location', v_access.location,
    'granted_at', v_access.granted_at
  );
end;
$$;

create or replace function public.art38_revoke_device_access(
  p_device_id uuid,
  p_installation_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_access public.device_access%rowtype;
begin
  update public.device_access a
    set status = 'revoked', revoked_at = now()
    where a.device_id = p_device_id
      and a.installation_id = p_installation_id
      and a.status = 'active'
  returning * into v_access;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  insert into private.security_audit_events (device_id, installation_id, event_type)
    values (p_device_id, p_installation_id, 'access_revoked');
  return jsonb_build_object('status', 'revoked', 'revoked_at', v_access.revoked_at);
end;
$$;

create or replace function public.art38_provision_simulated_device(
  p_device_id uuid,
  p_credential_verifier_hex text,
  p_allow_rotation boolean default false
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_capabilities jsonb := '{
    "do_monitoring": true,
    "feed_remaining_monitoring": true,
    "max_schedules": 8,
    "local_schedule_execution": true,
    "max_clock_uncertainty_ms": null,
    "scheduler_wake_grace_ms": 30000,
    "maximum_settling_ms": null,
    "nozzles": {
      "1": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 100, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null},
      "2": {"enabled": true, "dose_modes": ["grams"], "fixed_portion_ids": [], "min_dose_g": 5, "max_dose_g": 100, "dose_step_g": 1, "measured_dispensed_g": true, "max_actuation_ms": 15000, "minimum_cooldown_ms": null}
    }
  }'::jsonb;
  v_existing_verifier bytea;
  v_existing_revoked_at timestamptz;
  v_credential_exists boolean := false;
begin
  if p_device_id is null or p_device_id not in (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid
    ) then
    return jsonb_build_object('status', 'fixture_device_id_required');
  end if;
  if p_credential_verifier_hex is null or p_credential_verifier_hex !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_device_id::text, 0)
  );
  -- Lock credentials before touching device or membership rows, matching the
  -- pairing paths. The per-device lock also serializes first provisioning,
  -- where no credential row exists yet. A same-credential retry is a no-op.
  select c.credential_verifier, c.revoked_at
    into v_existing_verifier, v_existing_revoked_at
    from private.device_credentials c
    where c.device_id = p_device_id
    for update;
  v_credential_exists := found;
  if exists (
    select 1 from public.devices d where d.device_id = p_device_id and not d.is_simulated
  ) then
    return jsonb_build_object('status', 'not_simulated');
  end if;
  if v_credential_exists
    and v_existing_revoked_at is null
    and v_existing_verifier = decode(lower(p_credential_verifier_hex), 'hex')
    and exists (select 1 from public.devices d where d.device_id = p_device_id and d.is_simulated) then
    return jsonb_build_object('status', 'already_provisioned', 'device_id', p_device_id, 'simulated', true);
  end if;
  if v_credential_exists and p_allow_rotation is not true then
    return jsonb_build_object('status', 'credential_conflict');
  end if;
  if not v_credential_exists and exists (
    select 1 from public.devices d where d.device_id = p_device_id
  ) then
    return jsonb_build_object('status', 'credential_conflict');
  end if;

  insert into public.devices
    (device_id, model, firmware_version, protocol_major, is_simulated,
     capabilities_revision, capabilities)
  values (p_device_id, 'AquaFeed controlled simulator', 'sim-2.0.0', 2, true, 1, v_capabilities)
  on conflict (device_id) do update set
    model = excluded.model,
    firmware_version = excluded.firmware_version,
    protocol_major = 2,
    is_simulated = true,
    capabilities_revision = 1,
    capabilities = v_capabilities;

  insert into public.device_state
    (device_id, contact_freshness, sample_freshness, sample_quality, safety_lockout)
  values (p_device_id, 'unknown', 'unknown', 'unavailable', false)
  on conflict (device_id) do nothing;

  insert into private.device_credentials (device_id, credential_verifier, created_at, revoked_at)
  values (p_device_id, decode(lower(p_credential_verifier_hex), 'hex'), now(), null)
  on conflict (device_id) do update set
    credential_verifier = excluded.credential_verifier,
    created_at = now(), revoked_at = null;
  update public.device_access
    set status = 'revoked', revoked_at = now()
    where device_id = p_device_id and status = 'active';
  update private.pairing_challenges
    set consumed_at = coalesce(consumed_at, now())
    where device_id = p_device_id and consumed_at is null;
  return jsonb_build_object('status', 'provisioned', 'device_id', p_device_id, 'simulated', true);
end;
$$;

revoke all on function public.art38_take_rate_limit(text, text) from public, anon, authenticated;
revoke all on function public.art38_authenticate_device(text) from public, anon, authenticated;
revoke all on function public.art38_create_pairing_challenge(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.art38_redeem_pairing_challenge(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.art38_update_device_alias(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.art38_revoke_device_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.art38_provision_simulated_device(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.art38_take_rate_limit(text, text) to service_role;
grant execute on function public.art38_authenticate_device(text) to service_role;
grant execute on function public.art38_create_pairing_challenge(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.art38_redeem_pairing_challenge(uuid, uuid, uuid, text) to service_role;
grant execute on function public.art38_update_device_alias(uuid, uuid, text, text, boolean, boolean) to service_role;
grant execute on function public.art38_revoke_device_access(uuid, uuid) to service_role;
grant execute on function public.art38_provision_simulated_device(uuid, text, boolean) to service_role;

comment on table private.api_rate_windows is
  'Server-only bounded fixed-window counters for D2 pairing and device-access endpoints.';
comment on function public.art38_redeem_pairing_challenge(uuid, uuid, uuid, text) is
  'Atomically verifies and consumes one protocol-major-2 pairing challenge before granting installation access.';
comment on function public.art38_provision_simulated_device(uuid, text, boolean) is
  'Creates only the two fixed D2 simulator fixtures by default; explicit service-only rotation revokes their prior app memberships.';
