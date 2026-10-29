-- FASE 2: holding, estudios, usuarios, roles, clientes y autorizaciones.

-- ---------- Validacion de CUIT (modulo 11) ----------
create function private.cuit_valido(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  pesos int[] := array[5,4,3,2,7,6,5,4,3,2];
  suma int := 0;
  dv int;
  i int;
begin
  if p is null or p !~ '^[0-9]{11}$' then return false; end if;
  for i in 1..10 loop
    suma := suma + substr(p, i, 1)::int * pesos[i];
  end loop;
  dv := 11 - (suma % 11);
  if dv = 11 then dv := 0; end if;
  if dv = 10 then return false; end if;
  return dv = substr(p, 11, 1)::int;
end $$;

-- ---------- Permisos efectivos ----------
create function private.has_permission(p_tenant uuid, p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_tenant_admin(p_tenant) or exists (
    select 1 from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.estado = 'activo'
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.tenant_id = p_tenant and m.user_id = (select auth.uid())
      and rp.permission_code = p_code)
$$;

-- Control de acceso a funciones internas
revoke all on function private.cuit_valido(text), private.has_permission(uuid, text) from public, anon;
grant execute on function private.cuit_valido(text), private.has_permission(uuid, text) to authenticated;

-- ---------- Catalogo de permisos (solo los que ya se aplican) ----------
insert into public.permissions (code, descripcion) values
  ('clientes.editar', 'Modificar la ficha y las autorizaciones de los clientes asignados');

-- ---------- Estudios ----------
alter table public.tenants
  add constraint tenants_nombre_no_vacio check (length(trim(nombre)) > 0),
  add constraint tenants_cuit_valido check (cuit is null or private.cuit_valido(cuit));

-- ---------- Clientes ----------
alter table public.clients
  add column regimen text check (regimen in ('monotributo','responsable_inscripto','exento','no_inscripto')),
  add column categoria_monotributo text check (categoria_monotributo ~ '^[A-K]$'),
  add column activo boolean not null default true,
  add column notas text,
  add constraint clients_cuit_valido check (private.cuit_valido(cuit)),
  add constraint clients_razon_no_vacia check (length(trim(razon_social)) > 0),
  add constraint clients_categoria_solo_monotributo
    check (categoria_monotributo is null or regimen = 'monotributo');

-- Autorizaciones: una sola vigente por cliente y fechas coherentes
alter table public.client_authorizations
  add column observaciones text,
  add column registrado_por uuid default auth.uid(),
  add column creado_en timestamptz not null default now(),
  add constraint client_auth_fechas check (vigente_hasta is null or vigente_desde is null or vigente_hasta >= vigente_desde);
create unique index client_auth_una_vigente on public.client_authorizations (tenant_id, client_id) where estado = 'vigente';

-- ---------- Un rol con miembros no se puede borrar en cascada ----------
alter table public.memberships drop constraint memberships_tenant_id_role_id_fkey;
alter table public.memberships add constraint memberships_tenant_id_role_id_fkey
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id) on delete restrict;

-- ---------- Nunca dejar un estudio sin administrador ----------
create function private.keep_one_admin_memberships() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tenants where id = old.tenant_id)
     and exists (select 1 from public.roles r where r.tenant_id = old.tenant_id and r.id = old.role_id and r.es_admin)
     and not exists (select 1 from public.memberships m
                     join public.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
                     where m.tenant_id = old.tenant_id and r.es_admin) then
    raise exception 'El estudio no puede quedar sin administrador' using errcode = 'P0001';
  end if;
  return null;
end $$;

create function private.keep_one_admin_roles() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.es_admin and not new.es_admin
     and not exists (select 1 from public.memberships m
                     join public.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
                     where m.tenant_id = new.tenant_id and r.es_admin)
     and exists (select 1 from public.memberships where tenant_id = new.tenant_id and role_id = new.id) then
    raise exception 'El estudio no puede quedar sin administrador' using errcode = 'P0001';
  end if;
  return null;
end $$;

revoke all on function private.keep_one_admin_memberships(), private.keep_one_admin_roles() from public, anon, authenticated;

create trigger memberships_keep_admin after delete or update on public.memberships
  for each row execute function private.keep_one_admin_memberships();
create trigger roles_keep_admin after update on public.roles
  for each row execute function private.keep_one_admin_roles();

-- ---------- Politicas de clientes y autorizaciones ----------
drop policy clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using (private.can_see_client(tenant_id, id) and private.has_permission(tenant_id, 'clientes.editar'))
  with check (private.can_see_client(tenant_id, id) and private.has_permission(tenant_id, 'clientes.editar'));

drop policy client_auth_all on public.client_authorizations;
create policy client_auth_select on public.client_authorizations for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy client_auth_insert on public.client_authorizations for insert to authenticated
  with check (private.can_see_client(tenant_id, client_id) and private.has_permission(tenant_id, 'clientes.editar'));
create policy client_auth_update on public.client_authorizations for update to authenticated
  using (private.can_see_client(tenant_id, client_id) and private.has_permission(tenant_id, 'clientes.editar'))
  with check (private.can_see_client(tenant_id, client_id) and private.has_permission(tenant_id, 'clientes.editar'));
create policy client_auth_delete on public.client_authorizations for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

-- ---------- Funciones que usa la app (se ejecutan con los permisos de quien las llama) ----------
create function public.crear_estudio(p_nombre text, p_cuit text default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_tenant uuid;
  v_contador uuid;
begin
  if not private.is_holding() then
    raise exception 'Solo el holding puede crear estudios' using errcode = '42501';
  end if;
  insert into public.tenants (nombre, cuit)
    values (trim(p_nombre), nullif(trim(coalesce(p_cuit, '')), ''))
    returning id into v_tenant;
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Administrador', true);
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Contador', false)
    returning id into v_contador;
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Asistente', false);
  insert into public.role_permissions (role_id, permission_code) values (v_contador, 'clientes.editar');
  return v_tenant;
end $$;

create function public.mis_permisos(p_tenant uuid) returns text[]
language sql stable security invoker set search_path = '' as $$
  select coalesce(
    case when exists (
        select 1 from public.memberships m
        join public.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
        where m.tenant_id = p_tenant and m.user_id = (select auth.uid()) and r.es_admin)
      then array['admin']::text[] || coalesce((select array_agg(code) from public.permissions), '{}')
      else (select array_agg(rp.permission_code) from public.memberships m
            join public.role_permissions rp on rp.role_id = m.role_id
            where m.tenant_id = p_tenant and m.user_id = (select auth.uid()))
    end, '{}')
$$;

revoke all on function public.crear_estudio(text, text), public.mis_permisos(uuid) from public, anon;
grant execute on function public.crear_estudio(text, text), public.mis_permisos(uuid) to authenticated;
