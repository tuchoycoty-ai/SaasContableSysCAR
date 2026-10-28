-- Ajustes de rendimiento sugeridos por los avisos de Supabase.
-- 1) Indice para la FK compuesta (tenant_id, role_id) de memberships.
-- 2) Separar las politicas "for all" en insert/update/delete para que no se
--    superpongan con las de select (mismo efecto de seguridad).

create index on public.memberships (tenant_id, role_id);

drop policy clients_write on public.clients;
create policy clients_insert on public.clients for insert to authenticated
  with check (private.is_tenant_admin(tenant_id));
create policy clients_update on public.clients for update to authenticated
  using (private.is_tenant_admin(tenant_id)) with check (private.is_tenant_admin(tenant_id));
create policy clients_delete on public.clients for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

drop policy memberships_write on public.memberships;
create policy memberships_insert on public.memberships for insert to authenticated
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));
create policy memberships_update on public.memberships for update to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id))
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));
create policy memberships_delete on public.memberships for delete to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id));

drop policy permissions_write on public.permissions;
create policy permissions_insert on public.permissions for insert to authenticated
  with check (private.is_holding());
create policy permissions_update on public.permissions for update to authenticated
  using (private.is_holding()) with check (private.is_holding());
create policy permissions_delete on public.permissions for delete to authenticated
  using (private.is_holding());

drop policy roles_write on public.roles;
create policy roles_insert on public.roles for insert to authenticated
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));
create policy roles_update on public.roles for update to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id))
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));
create policy roles_delete on public.roles for delete to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id));

drop policy role_permissions_write on public.role_permissions;
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))));
create policy role_permissions_update on public.role_permissions for update to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))))
  with check (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))));
create policy role_permissions_delete on public.role_permissions for delete to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))));

drop policy uca_write on public.user_client_access;
create policy uca_insert on public.user_client_access for insert to authenticated
  with check (private.is_tenant_admin(tenant_id));
create policy uca_update on public.user_client_access for update to authenticated
  using (private.is_tenant_admin(tenant_id)) with check (private.is_tenant_admin(tenant_id));
create policy uca_delete on public.user_client_access for delete to authenticated
  using (private.is_tenant_admin(tenant_id));
