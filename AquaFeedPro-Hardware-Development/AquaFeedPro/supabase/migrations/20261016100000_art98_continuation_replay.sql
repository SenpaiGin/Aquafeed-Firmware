-- ART-98 B4: a re-sent manual batch must be acknowledged as a duplicate before its
-- continuation evidence is checked again. Otherwise a lockout or an uncertain clock
-- that arrived after the original delivery refuses the replay forever.
create function pg_temp.art98_patch(p_function regprocedure, p_pairs text[])
returns void
language plpgsql
as $$
declare
  v_source text;
  v_definition text;
  i integer;
begin
  select p.prosrc, pg_catalog.pg_get_functiondef(p.oid) into v_source, v_definition
    from pg_catalog.pg_proc p where p.oid = p_function;
  -- Some live bodies were created with CRLF line endings; compare on LF.
  v_source := replace(v_source, E'\r\n', E'\n');
  v_definition := replace(v_definition, E'\r\n', E'\n');
  for i in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
    if length(v_source) - length(replace(v_source, p_pairs[i], '')) <> length(p_pairs[i])
       or length(v_definition) - length(replace(v_definition, p_pairs[i], '')) <> length(p_pairs[i]) then
      raise exception 'ART-98 patch % does not match % exactly once', (i + 1) / 2, p_function;
    end if;
    v_source := replace(v_source, p_pairs[i], p_pairs[i + 1]);
    v_definition := replace(v_definition, p_pairs[i], p_pairs[i + 1]);
  end loop;
  execute v_definition;
end
$$;

select pg_temp.art98_patch('public.art31_sync_manual_feed(uuid,text,integer,jsonb,text,uuid,text,integer)'::regprocedure, array[
$o$    v_evidence := nullif(v_event->'continuation_evidence', 'null'::jsonb);
    if v_evidence is not null and not private.art98_valid_continuation(
         p_device_id, v_sequence.sequence_id, v_event, p_clock_quality, p_clock_uncertainty_ms) then
      raise exception using errcode = '22023', message = 'continuation evidence is invalid';
    end if;

    select * into v_saved$o$,
$n$    select * into v_saved$n$,
$o$        raise exception using errcode = '23505', message = 'event identity reused with different content';
      end if;
      continue;
    end if;
$o$, $n$        raise exception using errcode = '23505', message = 'event identity reused with different content';
      end if;
      continue;
    end if;
    -- Only a new event's evidence is checked; an identical replay was acknowledged above.
    v_evidence := nullif(v_event->'continuation_evidence', 'null'::jsonb);
    if v_evidence is not null and not private.art98_valid_continuation(
         p_device_id, v_sequence.sequence_id, v_event, p_clock_quality, p_clock_uncertainty_ms) then
      raise exception using errcode = '22023', message = 'continuation evidence is invalid';
    end if;
$n$
]);

drop function pg_temp.art98_patch(regprocedure, text[]);

revoke all on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.art31_sync_manual_feed(uuid, text, integer, jsonb, text, uuid, text, integer) to service_role;
