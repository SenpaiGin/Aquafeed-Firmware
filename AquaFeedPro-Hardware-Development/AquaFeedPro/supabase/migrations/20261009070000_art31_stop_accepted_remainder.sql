-- Allow a terminal first nozzle to stop an accepted second nozzle that never started.
do $$
declare
  v_source text;
  v_definition text;
  v_config text[];
  v_security_definer boolean;
  v_old constant text := $old$        where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = 2
          and status = 'queued';$old$;
  v_new constant text := $new$        where device_id = p_device_id and sequence_id = v_sequence.sequence_id and step_index = 2
          and status in ('queued', 'accepted');$new$;
begin
  select p.prosrc, p.proconfig, p.prosecdef, pg_catalog.pg_get_functiondef(p.oid)
    into v_source, v_config, v_security_definer, v_definition
    from pg_catalog.pg_proc p
    where p.oid = 'public.art31_sync_manual_feed(uuid,text,integer,jsonb,text,uuid,text,integer)'::regprocedure;

  if not found or not coalesce(v_security_definer, false)
     or not exists (
       select 1 from pg_catalog.pg_options_to_table(v_config) setting
       where setting.option_name = 'search_path' and setting.option_value = '""'
     ) then
    raise exception 'ART-31 sync function is missing or its security-definer search path changed';
  end if;

  if length(v_source) - length(replace(v_source, v_old, '')) <> length(v_old)
     or length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'ART-31 sync function does not contain exactly one expected stop predicate';
  end if;

  execute replace(v_definition, v_old, v_new);
end $$;

revoke all on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer)
  to service_role;
