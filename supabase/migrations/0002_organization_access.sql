begin;
create function public.set_organization_member(o uuid,u uuid,r public.member_role,a boolean) returns void language plpgsql security definer set search_path='' as $$begin
 if not public.is_owner(o) or u=auth.uid() then raise exception 'Forbidden' using errcode='42501';end if;
 if not exists(select 1 from public.organization_memberships where organization_id=o and user_id=u) then raise exception 'Not found';end if;
 update public.organization_memberships set role=r,active=a where organization_id=o and user_id=u;
 perform public.record_event(o,'organization.membership.changed',u);
end$$;
revoke execute on function public.set_organization_member(uuid,uuid,public.member_role,boolean) from public,anon;
grant execute on function public.set_organization_member(uuid,uuid,public.member_role,boolean) to authenticated;
commit;
