\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,email_confirmed_at) values
('00000000-0000-4000-8000-000000000001','owner@example.test',now()),
('00000000-0000-4000-8000-000000000002','a@example.test',now()),
('00000000-0000-4000-8000-000000000003','b@example.test',now()),
('00000000-0000-4000-8000-000000000004','invite@example.test',now());
insert into public.organizations(id,name) values('10000000-0000-4000-8000-000000000001','Org A'),('10000000-0000-4000-8000-000000000002','Org B');
insert into public.organization_memberships(organization_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner'),
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','supplier_engineer'),
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','supplier_engineer');
insert into public.projects(id,organization_id,code,name) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A','A project'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','B','B project'),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','C','Other org');
insert into public.suppliers(id,organization_id,name,country,language) values
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Supplier A','China','zh-CN'),
('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Supplier B','China','zh-CN');
insert into public.supplier_notes values('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','SECRET');
insert into public.project_suppliers values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002');
insert into public.supplier_memberships(organization_id,supplier_id,user_id) values
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003');
insert into public.project_memberships(organization_id,project_id,user_id,role,supplier_id) values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','supplier_engineer','30000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','supplier_engineer','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000002","email":"a@example.test","aal":"aal1"}',true);
do $$begin
 if (select count(*) from public.projects)<>1 then raise exception 'Supplier project isolation failed';end if;
 if exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000002') then raise exception 'IDOR';end if;
 if (select count(*) from public.suppliers)<>1 then raise exception 'Supplier isolation failed';end if;
 if exists(select 1 from public.supplier_notes) then raise exception 'Notes leak';end if;
 if exists(select 1 from public.outbox) then raise exception 'Outbox leak';end if;
 begin perform public.save_project('10000000-0000-4000-8000-000000000001',null,'HACK','Hack','','active');raise exception 'Supplier write accepted';exception when insufficient_privilege then null;end;
 begin insert into public.project_memberships(organization_id,project_id,user_id,role) values('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',auth.uid(),'project_admin');raise exception 'Direct write accepted';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test","aal":"aal1"}',true);
do $$begin if public.is_owner('10000000-0000-4000-8000-000000000001') then raise exception 'MFA bypass';end if;end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test"}',true);
do $$begin begin perform public.save_project('10000000-0000-4000-8000-000000000001',null,'BYPASS','Bypass','','active');raise exception 'Missing AAL bypass';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test","aal":"aal2"}',true);
select public.save_project('10000000-0000-4000-8000-000000000001',null,'NEW','New project','','active');
select public.create_invitation('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','invite@example.test','supplier_engineer',repeat('a',64),7);
do $$begin if (select count(*) from public.projects)<>3 then raise exception 'Owner project visibility failed';end if;
 begin perform public.save_project('10000000-0000-4000-8000-000000000002',null,'X','Other org','','active');raise exception 'Cross tenant write accepted';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","email":"b@example.test","aal":"aal1"}',true);
do $$begin begin perform public.accept_invitation(repeat('a',64));raise exception 'Wrong email accepted';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000004","email":"invite@example.test","aal":"aal1"}',true);
select public.accept_invitation(repeat('a',64));
do $$begin if (select count(*) from public.projects)<>1 then raise exception 'Invitation grant failed';end if;
 begin perform public.accept_invitation(repeat('a',64));raise exception 'Replay accepted';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test","aal":"aal2"}',true);
select public.set_organization_member('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','supplier_engineer',false);
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000004","email":"invite@example.test","aal":"aal1"}',true);
do $$begin if exists(select 1 from public.projects) then raise exception 'Revoked organization access';end if;end$$;
reset role;
update public.organization_memberships set active=true where user_id='00000000-0000-4000-8000-000000000004';
update public.supplier_memberships set active=false where user_id='00000000-0000-4000-8000-000000000004';
set local role authenticated;
do $$begin if exists(select 1 from public.projects) then raise exception 'Revoked supplier still has access';end if;end$$;
reset role;
update public.invitations set accepted_at=null,revoked_at=now();
set local role authenticated;
do $$begin begin perform public.accept_invitation(repeat('a',64));raise exception 'Revoked invitation accepted';exception when insufficient_privilege then null;end;end$$;
reset role;
update public.invitations set revoked_at=null,expires_at=now()-interval '1 day';
set local role authenticated;
do $$begin begin perform public.accept_invitation(repeat('a',64));raise exception 'Expired invitation accepted';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test","aal":"aal2"}',true);
do $$declare o uuid; s uuid;begin
 o:=public.create_organization('New organization');
 if not public.is_owner(o) then raise exception 'Organization owner not created';end if;
 s:=public.save_supplier('10000000-0000-4000-8000-000000000001',null,'New supplier','China','zh-CN','contact','Internal note','active');
 perform public.link_supplier('20000000-0000-4000-8000-000000000001',s);
 if not exists(select 1 from public.supplier_notes where supplier_id=s and internal_notes='Internal note') then raise exception 'Supplier notes missing';end if;
 perform public.set_project_member('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','supplier_manager',false);
 if exists(select 1 from public.project_memberships where user_id='00000000-0000-4000-8000-000000000002' and active) then raise exception 'Project revocation failed';end if;
 perform public.update_preferences('Owner','en','America/Toronto');
 if not exists(select 1 from public.profiles where id=auth.uid() and language='en') then raise exception 'Preferences not saved';end if;
 if not exists(select 1 from public.audit_events where action='organization.created') then raise exception 'Audit missing';end if;
end$$;
rollback;
\echo 'PASS: supplier/tenant isolation, IDOR, MFA, write denial, project creation, invitation acceptance/email/replay/revocation/expiry and membership revocation'
