create function public.rt01_device_work_token(p_device_id uuid) returns text
language sql
security definer
set search_path = ''
as $$
  select coalesce((
    select max(created_at) from public.feed_sequences
    where device_id = p_device_id and source = 'manual'
  )::text, '-')
  || '|' ||
  coalesce((
    select desired_revision from public.devices where device_id = p_device_id
  )::text, '-');
$$;
revoke all on function public.rt01_device_work_token(uuid) from public, anon, authenticated;
grant execute on function public.rt01_device_work_token(uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feed_sequences') then
      alter publication supabase_realtime add table public.feed_sequences;
    end if;
    if not exists (select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feed_steps') then
      alter publication supabase_realtime add table public.feed_steps;
    end if;
  end if;
end $$;
