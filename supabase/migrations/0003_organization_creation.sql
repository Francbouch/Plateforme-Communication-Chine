begin;
create function public.create_organization(n text) returns uuid language plpgsql security definer set search_path='' as $$declare o uuid;begin
 if not public.active_user() or coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'MFA required' using errcode='42501';end if;
 if length(trim(n)) not between 1 and 160 then raise exception 'Invalid organization';end if;
 insert into public.organizations(name) values(trim(n)) returning id into o;
 insert into public.organization_memberships(organization_id,user_id,role) values(o,auth.uid(),'owner');
 perform public.record_event(o,'organization.created',o);
 return o;
end$$;
revoke execute on function public.create_organization(text) from public,anon;
grant execute on function public.create_organization(text) to authenticated;
commit;
