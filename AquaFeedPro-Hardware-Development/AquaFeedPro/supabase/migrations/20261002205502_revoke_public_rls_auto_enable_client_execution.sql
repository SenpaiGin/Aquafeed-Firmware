-- Keep the preexisting automatic RLS SECURITY DEFINER function callable by
-- its owner while removing client execution privileges when it is installed.

do $$
declare
  function_owner name;
  security_definer boolean;
begin
  if to_regprocedure('public.rls_auto_enable()') is null then
    return;
  end if;

  execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';

  select owner_role.rolname, routine.prosecdef
    into function_owner, security_definer
  from pg_proc routine
  join pg_roles owner_role on owner_role.oid = routine.proowner
  where routine.oid = to_regprocedure('public.rls_auto_enable()');

  if has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception 'client roles must not execute public.rls_auto_enable()';
  end if;
  if not security_definer
     or not has_function_privilege(function_owner, 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception 'automatic RLS function must remain SECURITY DEFINER and executable by its owner';
  end if;
end $$;
