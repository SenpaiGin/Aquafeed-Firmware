-- ART-7 D1 protocol 2 data foundation. Coordinator review and isolated
-- development verification are required before applying this migration.
-- Simulator values below are examples, not hardware limits.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table public.devices (
  device_id uuid primary key,
  model text not null,
  firmware_version text not null,
  protocol_major smallint not null check (protocol_major = 2),
  is_simulated boolean not null,
  capabilities_revision integer not null check (capabilities_revision > 0),
  capabilities jsonb not null check (
    jsonb_typeof(capabilities->'nozzles') = 'object'
    and capabilities->'nozzles' ? '1' and capabilities->'nozzles' ? '2'
  ),
  desired_revision bigint,
  applied_revision bigint,
  created_at timestamptz not null default now(),
  check (applied_revision is null or desired_revision is null or applied_revision <= desired_revision)
);

create table public.device_access (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  installation_id uuid not null references auth.users(id) on delete cascade deferrable initially deferred,
  status text not null check (status in ('active', 'revoked')),
  alias text,
  location text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (device_id, installation_id),
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);

create table public.device_config_revisions (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  revision bigint not null check (revision > 0),
  requested_snapshot jsonb not null,
  state text not null check (state in ('requested', 'applied', 'rejected')),
  requested_at timestamptz not null default now(),
  applied_at timestamptz,
  primary key (device_id, revision),
  check ((state = 'applied') = (applied_at is not null))
);
alter table public.devices
  add constraint devices_desired_revision_fkey foreign key (device_id, desired_revision)
    references public.device_config_revisions(device_id, revision),
  add constraint devices_applied_revision_fkey foreign key (device_id, applied_revision)
    references public.device_config_revisions(device_id, revision);

create table public.device_schedule_identities (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  schedule_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (device_id, schedule_id)
);
create table public.device_schedule_tombstones (
  device_id uuid not null,
  schedule_id uuid not null,
  retired_at timestamptz not null default now(),
  primary key (device_id, schedule_id),
  foreign key (device_id, schedule_id)
    references public.device_schedule_identities(device_id, schedule_id)
);
create table public.device_config_schedules (
  device_id uuid not null,
  revision bigint not null,
  schedule_id uuid not null,
  nozzle_number smallint not null check (nozzle_number in (1, 2)),
  requested_dose jsonb not null check (jsonb_typeof(requested_dose) = 'object'),
  timezone text not null,
  enabled boolean not null,
  primary key (device_id, revision, schedule_id),
  unique (device_id, revision, schedule_id, nozzle_number),
  foreign key (device_id, revision)
    references public.device_config_revisions(device_id, revision),
  foreign key (device_id, schedule_id)
    references public.device_schedule_identities(device_id, schedule_id)
);
create table public.device_config_schedule_slots (
  device_id uuid not null,
  revision bigint not null,
  schedule_id uuid not null,
  nozzle_number smallint not null check (nozzle_number in (1, 2)),
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  local_time time not null,
  primary key (device_id, revision, schedule_id, iso_weekday),
  foreign key (device_id, revision, schedule_id, nozzle_number)
    references public.device_config_schedules(device_id, revision, schedule_id, nozzle_number),
  unique (device_id, revision, nozzle_number, iso_weekday, local_time)
);

create function private.reject_retired_schedule_id() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if exists (
    select 1 from public.device_schedule_tombstones
    where device_id = new.device_id and schedule_id = new.schedule_id
  ) then
    raise exception using errcode = '23514', message = 'retired schedule identity cannot be reused';
  end if;
  return new;
end
$$;
revoke all on function private.reject_retired_schedule_id() from public, anon, authenticated;
grant execute on function private.reject_retired_schedule_id() to service_role;
create trigger reject_retired_schedule_reuse before insert on public.device_config_schedules
  for each row execute function private.reject_retired_schedule_id();

-- Immutable samples carry shared container inventory once per device.
create table public.device_telemetry (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  boot_id uuid not null,
  sample_sequence bigint not null check (sample_sequence >= 0),
  measured_at timestamptz,
  time_quality text not null check (time_quality in ('synced', 'rtc', 'uncertain', 'invalid')),
  do_mg_l numeric,
  do_quality text not null check (do_quality in ('valid', 'unavailable', 'uncalibrated', 'error')),
  feed_remaining_g numeric,
  feed_percent numeric,
  feed_quality text not null check (feed_quality in ('valid', 'unavailable', 'uncalibrated', 'error')),
  calibration_revision integer,
  received_at timestamptz not null default now(),
  primary key (device_id, boot_id, sample_sequence),
  check (do_mg_l is null or
    (do_mg_l >= 0 and do_mg_l not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))),
  check (feed_remaining_g is null or
    (feed_remaining_g >= 0 and feed_remaining_g not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))),
  check (feed_percent is null or
    (feed_percent between 0 and 100 and feed_percent not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))),
  check ((do_quality = 'valid' and do_mg_l is not null) or (do_quality <> 'valid' and do_mg_l is null)),
  check ((feed_quality = 'valid' and feed_remaining_g is not null and feed_percent is not null
            and calibration_revision is not null and calibration_revision > 0)
      or (feed_quality <> 'valid' and feed_remaining_g is null and feed_percent is null and calibration_revision is null))
);

create table public.feed_sequences (
  device_id uuid not null references public.devices(device_id) on delete cascade,
  sequence_id uuid not null,
  source text not null check (source in ('manual', 'scheduled')),
  installation_id uuid references auth.users(id) on delete restrict deferrable initially deferred,
  idempotency_key uuid,
  request_id uuid,
  target_count smallint not null check (target_count in (1, 2)),
  capabilities_revision integer not null check (capabilities_revision > 0),
  due_at timestamptz,
  admitted_at timestamptz,
  start_before timestamptz,
  scheduler_wake_grace_ms integer check (scheduler_wake_grace_ms is null or scheduler_wake_grace_ms >= 0),
  maximum_settling_ms integer check (maximum_settling_ms is null or maximum_settling_ms > 0),
  status text not null check (status in
    ('queued', 'accepted', 'running', 'completed', 'partial', 'failed', 'rejected', 'expired', 'unknown')),
  status_sequence bigint not null default 1 check (status_sequence > 0),
  unresolved boolean not null default true,
  safety_lockout boolean not null default false,
  lockout_resolved_at timestamptz,
  lockout_resolution_source text check (lockout_resolution_source is null or lockout_resolution_source = 'device_maintenance'),
  created_at timestamptz not null default now(),
  primary key (device_id, sequence_id),
  check ((source = 'manual' and installation_id is not null and idempotency_key is not null)
      or (source = 'scheduled' and installation_id is null and idempotency_key is null)),
  check (status not in ('queued', 'accepted', 'running') or unresolved),
  check (not safety_lockout or (status in ('partial', 'unknown') and unresolved and lockout_resolved_at is null)),
  check ((lockout_resolved_at is null) = (lockout_resolution_source is null)),
  check (lockout_resolved_at is null or (not safety_lockout and not unresolved))
);
create unique index feed_sequences_manual_idempotency
  on public.feed_sequences(device_id, installation_id, idempotency_key) where source = 'manual';
create unique index one_unresolved_manual_sequence
  on public.feed_sequences(device_id) where source = 'manual' and unresolved;

-- Ordered target rows preserve the semantic payload and are the FK parent for
-- both step results and events. Step 2 can only follow target 1 on nozzle 1.
create table public.feed_sequence_targets (
  device_id uuid not null,
  sequence_id uuid not null,
  step_index smallint not null check (step_index in (1, 2)),
  nozzle_number smallint not null check (nozzle_number in (1, 2)),
  requested_dose jsonb not null check (jsonb_typeof(requested_dose) = 'object'),
  first_step_index smallint not null,
  first_nozzle_number smallint not null check (first_nozzle_number in (1, 2)),
  primary key (device_id, sequence_id, step_index),
  unique (device_id, sequence_id, nozzle_number),
  unique (device_id, sequence_id, step_index, nozzle_number),
  unique (device_id, sequence_id, step_index, nozzle_number, requested_dose),
  foreign key (device_id, sequence_id)
    references public.feed_sequences(device_id, sequence_id) on delete cascade,
  constraint feed_sequence_target_anchor_fkey
  foreign key (device_id, sequence_id, first_step_index, first_nozzle_number)
    references public.feed_sequence_targets(device_id, sequence_id, step_index, nozzle_number)
    deferrable initially deferred,
  check ((step_index = 1 and first_step_index = 1 and first_nozzle_number = nozzle_number)
      or (step_index = 2 and nozzle_number = 2 and first_step_index = 1 and first_nozzle_number = 1))
);

create table public.feed_steps (
  device_id uuid not null,
  sequence_id uuid not null,
  step_index smallint not null check (step_index in (1, 2)),
  nozzle_number smallint not null check (nozzle_number in (1, 2)),
  requested_dose jsonb not null check (jsonb_typeof(requested_dose) = 'object'),
  status text not null check (status in
    ('not_started', 'queued', 'accepted', 'running', 'completed', 'failed', 'rejected', 'expired', 'unknown')),
  estimated_dispensed_g numeric,
  measured_dispensed_g numeric,
  measurement_quality text not null check (measurement_quality in ('valid', 'unavailable', 'uncalibrated', 'error')),
  baseline_ready_at timestamptz,
  start_before timestamptz,
  started_at timestamptz,
  stopped_at timestamptz,
  primary key (device_id, sequence_id, step_index),
  unique (device_id, sequence_id, step_index, nozzle_number, requested_dose),
  foreign key (device_id, sequence_id, step_index, nozzle_number, requested_dose)
    references public.feed_sequence_targets(device_id, sequence_id, step_index, nozzle_number, requested_dose),
  check (estimated_dispensed_g is null or
    (estimated_dispensed_g >= 0 and estimated_dispensed_g not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))),
  check (measured_dispensed_g is null or
    (measured_dispensed_g >= 0 and measured_dispensed_g not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))),
  check ((measurement_quality = 'valid' and measured_dispensed_g is not null)
      or (measurement_quality <> 'valid' and measured_dispensed_g is null)),
  check (status <> 'unknown' or measured_dispensed_g is null)
);

create table public.device_state (
  device_id uuid primary key references public.devices(device_id) on delete cascade,
  last_authenticated_contact_at timestamptz,
  contact_freshness text not null default 'unknown' check (contact_freshness in ('fresh', 'stale', 'unknown')),
  last_sample_at timestamptz,
  sample_freshness text not null default 'unknown' check (sample_freshness in ('fresh', 'stale', 'unknown')),
  sample_quality text not null default 'unavailable' check (sample_quality in ('valid', 'unavailable', 'uncalibrated', 'error')),
  safety_lockout boolean not null default false,
  lockout_sequence_id uuid,
  updated_at timestamptz not null default now(),
  foreign key (device_id, lockout_sequence_id) references public.feed_sequences(device_id, sequence_id),
  check ((contact_freshness = 'unknown') = (last_authenticated_contact_at is null)),
  check ((sample_freshness = 'unknown') = (last_sample_at is null)),
  check ((safety_lockout) = (lockout_sequence_id is not null))
);

create table public.scheduled_occurrences (
  device_id uuid not null,
  schedule_id uuid not null,
  occurrence_local_date date not null,
  sequence_id uuid not null,
  outcome text not null check (outcome in ('admitted', 'skipped', 'completed', 'partial', 'failed', 'unknown')),
  created_at timestamptz not null default now(),
  primary key (device_id, schedule_id, occurrence_local_date),
  foreign key (device_id, schedule_id)
    references public.device_schedule_identities(device_id, schedule_id),
  foreign key (device_id, sequence_id) references public.feed_sequences(device_id, sequence_id)
);

create table public.device_events (
  device_id uuid not null,
  sequence_id uuid not null,
  event_sequence bigint not null check (event_sequence > 0),
  step_index smallint not null,
  nozzle_number smallint not null,
  requested_dose jsonb not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (device_id, sequence_id, event_sequence),
  foreign key (device_id, sequence_id) references public.feed_sequences(device_id, sequence_id),
  foreign key (device_id, sequence_id, step_index, nozzle_number, requested_dose)
    references public.feed_steps(device_id, sequence_id, step_index, nozzle_number, requested_dose)
);

create table public.device_execution_reservations (
  device_id uuid not null,
  sequence_id uuid not null,
  phase text not null check (phase in ('active', 'settling', 'released')),
  acquired_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (device_id, sequence_id),
  foreign key (device_id, sequence_id) references public.feed_sequences(device_id, sequence_id),
  check ((phase = 'released') = (released_at is not null))
);
create unique index one_active_device_sequence on public.device_execution_reservations(device_id)
  where phase in ('active', 'settling');

create function private.assert_sequence_integrity() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  did uuid;
  sid uuid;
  seq public.feed_sequences%rowtype;
  n_targets integer;
  n_steps integer;
  has_unknown boolean;
  state public.device_state%rowtype;
  second_step public.feed_steps%rowtype;
begin
  if tg_table_name = 'device_state' then
    did := new.device_id;
    -- Constraint triggers are deferred: validate the final row, not an earlier NEW image.
    select * into state from public.device_state where device_id = did;
    if not found then return null; end if;
    if state.safety_lockout then
      select * into seq from public.feed_sequences
        where device_id = did and sequence_id = state.lockout_sequence_id;
      if not found or not seq.safety_lockout then
        raise exception using errcode = '23514', message = 'device lockout must reference a locked feed sequence';
      end if;
    elsif exists (select 1 from public.feed_sequences where device_id = did and safety_lockout) then
      raise exception using errcode = '23514', message = 'device lockout cannot clear before device maintenance';
    end if;
    return null;
  else
    did := new.device_id;
    sid := new.sequence_id;
  end if;
  select * into seq from public.feed_sequences where device_id = did and sequence_id = sid;
  if not found then return null; end if;
  select count(*) into n_targets from public.feed_sequence_targets where device_id = did and sequence_id = sid;
  if n_targets <> seq.target_count then
    raise exception using errcode = '23514', message = 'sequence target count must match ordered target rows';
  end if;
  select count(*) into n_steps from public.feed_steps where device_id = did and sequence_id = sid;
  if n_steps <> seq.target_count then
    raise exception using errcode = '23514', message = 'sequence must persist one outcome row per target';
  end if;
  select * into second_step from public.feed_steps
    where device_id = did and sequence_id = sid and step_index = 2;
  if found and second_step.status in ('running', 'completed', 'failed', 'unknown') then
    if not exists (select 1 from public.feed_steps
      where device_id = did and sequence_id = sid and step_index = 1 and status = 'completed') then
      raise exception using errcode = '23514', message = 'nozzle 2 cannot start before nozzle 1 completes';
    end if;
    if second_step.baseline_ready_at is null or second_step.start_before is null
       or seq.scheduler_wake_grace_ms is null
       or second_step.start_before <> second_step.baseline_ready_at + seq.scheduler_wake_grace_ms * interval '1 millisecond' then
      raise exception using errcode = '23514', message = 'nozzle 2 deadline must start at its settled baseline';
    end if;
  end if;
  select exists(select 1 from public.feed_steps where device_id = did and sequence_id = sid and status = 'unknown')
    into has_unknown;
  if seq.status = 'completed' and exists (select 1 from public.feed_steps
      where device_id = did and sequence_id = sid and status <> 'completed') then
    raise exception using errcode = '23514', message = 'completed sequence requires every target to complete';
  end if;
  if seq.status = 'unknown' and not has_unknown then
    raise exception using errcode = '23514', message = 'unknown sequence requires an unknown nozzle result';
  end if;
  if seq.status = 'partial' and not exists (
    select 1 from public.feed_steps first join public.feed_steps second
      on second.device_id = first.device_id and second.sequence_id = first.sequence_id
    where first.device_id = did and first.sequence_id = sid and first.step_index = 1
      and first.nozzle_number = 1 and first.status = 'completed'
      and second.step_index = 2 and second.nozzle_number = 2
      and second.status in ('failed', 'unknown', 'not_started')
  ) then
    raise exception using errcode = '23514', message = 'partial sequence requires nozzle 1 complete and nozzle 2 stopped';
  end if;
  if has_unknown and not seq.safety_lockout and seq.lockout_resolved_at is null then
    raise exception using errcode = '23514', message = 'unknown nozzle result requires safety lockout until device maintenance';
  end if;
  if has_unknown and seq.safety_lockout and not seq.unresolved then
    raise exception using errcode = '23514', message = 'unknown nozzle result remains unresolved while locked out';
  end if;
  if seq.safety_lockout then
    select * into state from public.device_state where device_id = did;
    if not found or not state.safety_lockout or state.lockout_sequence_id <> sid then
      raise exception using errcode = '23514', message = 'device state must retain the sequence safety lockout';
    end if;
  end if;
  return null;
end
$$;
revoke all on function private.assert_sequence_integrity() from public, anon, authenticated;
grant execute on function private.assert_sequence_integrity() to service_role;
create constraint trigger feed_sequence_integrity
  after insert or update on public.feed_sequences
  deferrable initially deferred for each row execute function private.assert_sequence_integrity();
create constraint trigger feed_step_integrity
  after insert or update on public.feed_steps
  deferrable initially deferred for each row execute function private.assert_sequence_integrity();
create constraint trigger feed_target_integrity
  after insert or update on public.feed_sequence_targets
  deferrable initially deferred for each row execute function private.assert_sequence_integrity();
create constraint trigger device_state_integrity
  after insert or update on public.device_state
  deferrable initially deferred for each row execute function private.assert_sequence_integrity();

create table private.device_credentials (
  device_id uuid primary key references public.devices(device_id) on delete cascade,
  credential_verifier bytea not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table private.pairing_challenges (
  challenge_id uuid primary key,
  device_id uuid not null references public.devices(device_id) on delete cascade,
  verifier bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create table private.security_audit_events (
  audit_id bigint generated always as identity primary key,
  device_id uuid references public.devices(device_id) on delete set null,
  installation_id uuid,
  event_type text not null,
  created_at timestamptz not null default now()
);

alter table public.devices enable row level security;
alter table public.device_access enable row level security;
alter table public.device_config_revisions enable row level security;
alter table public.device_schedule_identities enable row level security;
alter table public.device_schedule_tombstones enable row level security;
alter table public.device_config_schedules enable row level security;
alter table public.device_config_schedule_slots enable row level security;
alter table public.device_telemetry enable row level security;
alter table public.feed_sequences enable row level security;
alter table public.feed_sequence_targets enable row level security;
alter table public.feed_steps enable row level security;
alter table public.device_state enable row level security;
alter table public.scheduled_occurrences enable row level security;
alter table public.device_events enable row level security;
alter table public.device_execution_reservations enable row level security;
alter table private.device_credentials enable row level security;
alter table private.pairing_challenges enable row level security;
alter table private.security_audit_events enable row level security;

create policy installation_reads_own_active_memberships on public.device_access
  for select to authenticated using (installation_id = (select auth.uid()) and status = 'active');
do $$
declare t text;
begin
  foreach t in array array[
    'devices', 'device_config_revisions', 'device_schedule_identities', 'device_schedule_tombstones',
    'device_config_schedules', 'device_config_schedule_slots', 'device_telemetry', 'feed_sequences',
    'feed_sequence_targets', 'feed_steps', 'device_state', 'scheduled_occurrences', 'device_events',
    'device_execution_reservations'
  ] loop
    execute format(
      'create policy active_installations_read on public.%I for select to authenticated using (exists (select 1 from public.device_access a where a.device_id = %I.device_id and a.installation_id = (select auth.uid()) and a.status = ''active''))',
      t, t
    );
  end loop;
end $$;

revoke all on public.devices, public.device_access, public.device_config_revisions, public.device_schedule_identities,
  public.device_schedule_tombstones, public.device_config_schedules, public.device_config_schedule_slots,
  public.device_telemetry, public.feed_sequences, public.feed_sequence_targets, public.feed_steps,
  public.device_state, public.scheduled_occurrences, public.device_events, public.device_execution_reservations
  from public, anon, authenticated;
grant select on public.devices, public.device_access, public.device_config_revisions, public.device_schedule_identities,
  public.device_schedule_tombstones, public.device_config_schedules, public.device_config_schedule_slots,
  public.device_telemetry, public.feed_sequences, public.feed_sequence_targets, public.feed_steps,
  public.device_state, public.scheduled_occurrences, public.device_events, public.device_execution_reservations
  to authenticated;
grant all on public.devices, public.device_access, public.device_config_revisions, public.device_schedule_identities,
  public.device_schedule_tombstones, public.device_config_schedules, public.device_config_schedule_slots,
  public.device_telemetry, public.feed_sequences, public.feed_sequence_targets, public.feed_steps,
  public.device_state, public.scheduled_occurrences, public.device_events, public.device_execution_reservations
  to service_role;
revoke all on public.device_config_revisions, public.device_schedule_identities,
  public.device_schedule_tombstones, public.device_config_schedules, public.device_config_schedule_slots,
  public.feed_sequence_targets from service_role;
grant select, insert on public.device_config_revisions, public.device_schedule_identities,
  public.device_schedule_tombstones, public.device_config_schedules, public.device_config_schedule_slots,
  public.feed_sequence_targets to service_role;
grant update (state, applied_at) on public.device_config_revisions to service_role;
revoke all on public.device_telemetry, public.feed_sequences, public.feed_sequence_targets, public.feed_steps,
  public.scheduled_occurrences, public.device_events, public.device_execution_reservations from service_role;
grant select, insert on public.device_telemetry, public.feed_sequence_targets, public.device_events to service_role;
grant select, insert on public.feed_sequences, public.feed_steps,
  public.scheduled_occurrences, public.device_execution_reservations to service_role;
grant update (status, status_sequence, unresolved, safety_lockout, lockout_resolved_at, lockout_resolution_source)
  on public.feed_sequences to service_role;
grant update (status, estimated_dispensed_g, measured_dispensed_g, measurement_quality,
  baseline_ready_at, start_before, started_at, stopped_at) on public.feed_steps to service_role;
grant update (outcome) on public.scheduled_occurrences to service_role;
grant update (phase, released_at) on public.device_execution_reservations to service_role;
revoke all on public.device_state from service_role;
grant select, insert on public.device_state to service_role;
grant update (last_authenticated_contact_at, contact_freshness, last_sample_at, sample_freshness,
  sample_quality, safety_lockout, lockout_sequence_id, updated_at) on public.device_state to service_role;
revoke all on all tables in schema private from public, anon, authenticated;
grant all on all tables in schema private to service_role;
revoke all on all sequences in schema private from public, anon, authenticated;
grant all on all sequences in schema private to service_role;

do $$
begin
  if exists (select 1 from pg_publication_tables where schemaname = 'private') then
    raise exception 'private tables must not be published to Realtime';
  end if;
end $$;

-- Seed only after all ALTER/GRANT/PUBLICATION DDL is complete: device_state
-- fires an initially deferred integrity trigger on insert.
insert into public.devices (device_id, model, firmware_version, protocol_major, is_simulated, capabilities_revision, capabilities)
values ('11111111-1111-4111-8111-111111111111', 'simulator', 'sim-0.1.0', 2, true, 1,
'{"do_monitoring":true,"feed_remaining_monitoring":true,"max_schedules":8,"local_schedule_execution":true,"max_clock_uncertainty_ms":null,"scheduler_wake_grace_ms":30000,"maximum_settling_ms":null,"nozzles":{"1":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null},"2":{"enabled":true,"dose_modes":["grams"],"fixed_portion_ids":[],"min_dose_g":5,"max_dose_g":100,"dose_step_g":1,"measured_dispensed_g":true,"max_actuation_ms":15000,"minimum_cooldown_ms":null}}}'::jsonb);
insert into public.device_state (device_id, contact_freshness, sample_freshness, sample_quality, safety_lockout)
values ('11111111-1111-4111-8111-111111111111', 'unknown', 'unknown', 'unavailable', false);
