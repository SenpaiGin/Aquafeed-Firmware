\set ON_ERROR_STOP on
-- Run after the ART-102 migration on an isolated development database. Synthetic
-- auth UUIDs rely on deferred FKs; nothing is committed.
begin;
set constraints all deferred;

insert into public.devices (device_id,model,firmware_version,protocol_major,is_simulated,capabilities_revision,capabilities)
select d.id,model,firmware_version,protocol_major,is_simulated,capabilities_revision,capabilities
from public.devices, (values
  ('a1020000-0000-4000-8000-000000000001'::uuid), ('a1020000-0000-4000-8000-000000000002'::uuid),
  ('a1020000-0000-4000-8000-000000000003'::uuid), ('a1020000-0000-4000-8000-000000000004'::uuid)
) as d(id)
where device_id='11111111-1111-4111-8111-111111111111';
insert into public.device_state(device_id) values
  ('a1020000-0000-4000-8000-000000000001'), ('a1020000-0000-4000-8000-000000000002'),
  ('a1020000-0000-4000-8000-000000000003'), ('a1020000-0000-4000-8000-000000000004');

-- 01 agreed alias (modulo whitespace) + one location, 02 conflicting alias,
-- 03 revoked-only label, 04 no labels. Legacy per-phone values stay on device_access.
insert into public.device_access(device_id,installation_id,status,alias,location,revoked_at) values
  ('a1020000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','North pond','Shed',null),
  ('a1020000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active','North pond ',null,null),
  ('a1020000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','One',null,null),
  ('a1020000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active','Two',null,null),
  ('a1020000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','revoked','Old',null,now()),
  ('a1020000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',null,null,null);

-- Same statement as the migration's backfill, run against the rows above.
with labels as (
  select d.device_id,
         count(distinct nullif(btrim(a.alias), '')) as alias_count,
         min(nullif(btrim(a.alias), '')) as alias_value,
         count(distinct nullif(btrim(a.location), '')) as location_count,
         min(nullif(btrim(a.location), '')) as location_value
    from public.devices d
    left join public.device_access a on a.device_id = d.device_id and a.status = 'active'
   where d.device_id::text like 'a1020000-%'
   group by d.device_id
)
update public.devices d
   set alias = case when l.alias_count = 1 then l.alias_value end,
       location = case when l.location_count = 1 then l.location_value end,
       metadata_conflict = l.alias_count > 1 or l.location_count > 1
  from labels l
 where l.device_id = d.device_id;

do $$
begin
  if not exists (select 1 from public.devices where device_id='a1020000-0000-4000-8000-000000000001'
      and alias='North pond' and location='Shed' and not metadata_conflict and metadata_revision=1) then
    raise exception 'agreed/single legacy labels were not copied';
  end if;
  if not exists (select 1 from public.devices where device_id='a1020000-0000-4000-8000-000000000002'
      and alias is null and metadata_conflict) then
    raise exception 'conflicting legacy aliases were silently resolved';
  end if;
  if (select count(*) from public.device_access where device_id='a1020000-0000-4000-8000-000000000002'
      and alias in ('One','Two')) <> 2 then
    raise exception 'conflicting originals were not preserved';
  end if;
  if not exists (select 1 from public.devices where device_id='a1020000-0000-4000-8000-000000000003'
      and alias is null and not metadata_conflict)
    or not exists (select 1 from public.devices where device_id='a1020000-0000-4000-8000-000000000004'
      and alias is null and location is null and not metadata_conflict) then
    raise exception 'revoked-only or empty legacy labels produced a shared value or a conflict';
  end if;
end $$;

set local role service_role;
do $$
declare
  v jsonb;
begin
  -- An authorized phone chooses the shared value; that clears the conflict flag.
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ' Chosen ', ' Pond 3 ', 1);
  if v->>'status' <> 'updated' or v->>'alias' <> 'Chosen' or v->>'location' <> 'Pond 3'
    or (v->>'metadata_revision')::bigint <> 2 or (v->>'metadata_conflict')::boolean then
    raise exception 'explicit choice was not stored trimmed with a new revision';
  end if;
  -- The second phone loaded revision 1: one success, one conflict, nothing overwritten.
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Late', null, 1);
  if v->>'status' <> 'conflict' or not exists (select 1 from public.devices
    where device_id='a1020000-0000-4000-8000-000000000002' and alias='Chosen' and metadata_revision=2) then
    raise exception 'same-revision second edit overwrote the first';
  end if;
  -- Revoked, unpaired and other-device installations cannot edit.
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000003',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Revoked', null, 1);
  if v->>'status' <> 'not_active' then raise exception 'revoked installation edited shared labels'; end if;
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000001',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Stranger', null, 1);
  if v->>'status' <> 'not_active' then raise exception 'unpaired installation edited shared labels'; end if;
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000004',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Other device', null, 1);
  if v->>'status' <> 'not_active' then raise exception 'membership of another feeder allowed an edit'; end if;
  -- Clear and validation: blank clears, over-length or missing revision change nothing.
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '   ', null, 2);
  if v->>'status' <> 'updated' or v->>'alias' is not null or v->>'location' is not null then
    raise exception 'blank values did not clear the shared labels';
  end if;
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat(U&'\+01F41F', 101), null, 3);
  if v->>'status' <> 'invalid' then raise exception '101 code points were accepted'; end if;
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat(U&'\+01F41F', 100), repeat('y', 160), 3);
  if v->>'status' <> 'updated' then raise exception 'maximum-length Unicode labels were rejected'; end if;
  v := public.art102_update_device_metadata('a1020000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', null, null);
  if v->>'status' <> 'invalid' then raise exception 'a write without a revision was accepted'; end if;
  -- Feeders stay isolated and legacy per-phone values are untouched.
  if not exists (select 1 from public.devices where device_id='a1020000-0000-4000-8000-000000000001'
      and alias='North pond' and metadata_revision=1)
    or not exists (select 1 from public.device_access where device_id='a1020000-0000-4000-8000-000000000002'
      and installation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and alias='Two') then
    raise exception 'an edit leaked into another feeder or rewrote a legacy original';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon','public.art102_update_device_metadata(uuid,uuid,text,text,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.art102_update_device_metadata(uuid,uuid,text,text,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.art102_update_device_metadata(uuid,uuid,text,text,bigint)','EXECUTE') then
    raise exception 'metadata update must be service-role only';
  end if;
  if to_regprocedure('public.art38_update_device_alias(uuid,uuid,text,text,boolean,boolean)') is not null then
    raise exception 'per-installation label writer still exists';
  end if;
  if exists (select 1 from pg_publication where pubname='supabase_realtime') and not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='devices') then
    raise exception 'devices is not published to Realtime';
  end if;
end $$;
rollback;
