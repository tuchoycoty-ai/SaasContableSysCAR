-- FASE 1: base multi-tenant con aislamiento por RLS (Supabase Auth)
-- Identidad: auth.uid(). Las funciones auxiliares viven en el esquema "private",
-- que NO esta expuesto por la API, y se ejecutan como SECURITY DEFINER.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------- Tablas ----------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  cuit text check (cuit is null or cuit ~ '^[0-9]{11}$'),
  estado text not null default 'activo' check (estado in ('activo','suspendido')),
  logo_url text,
  creado_en timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nombre text,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

-- Superadministradores del holding. Sin permisos de escritura desde la API.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  creado_en timestamptz not null default now()
);

create table public.permissions (
  code text primary key,
  descripcion text not null
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  nombre text not null,
  es_admin boolean not null default false,
  unique (tenant_id, id),
  unique (tenant_id, nombre)
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code),
  primary key (role_id, permission_code)
);

-- El rol debe pertenecer al mismo estudio (FK compuesta).
create table public.memberships (
  tenant_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null,
  creado_en timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, role_id) references public.roles(tenant_id, id) on delete cascade
);

-- Un mismo CUIT en dos estudios son DOS filas separadas.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cuit text not null check (cuit ~ '^[0-9]{11}$'),
  razon_social text not null,
  ficha_fiscal jsonb not null default '{}',
  creado_en timestamptz not null default now(),
  unique (tenant_id, cuit),
  unique (tenant_id, id)
);

create table public.client_authorizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  estado text not null check (estado in ('pendiente','vigente','vencida','revocada')),
  vigente_desde date,
  vigente_hasta date,
  foreign key (tenant_id, client_id) references public.clients(tenant_id, id) on delete cascade
);

-- Que clientes puede ver cada usuario operativo (debe ser miembro del estudio).
create table public.user_client_access (
  tenant_id uuid not null,
  user_id uuid not null,
  client_id uuid not null,
  primary key (tenant_id, user_id, client_id),
  foreign key (tenant_id, client_id) references public.clients(tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references public.memberships(tenant_id, user_id) on delete cascade
);

-- Auditoria: sin FK a tenants para conservar historial. Se escribe solo por triggers.
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  actor_id uuid,
  accion text not null,
  objeto text,
  resultado text not null,
  detalle jsonb not null default '{}',
  creado_en timestamptz not null default now()
);

create index on public.memberships (user_id);
create index on public.user_client_access (user_id);
create index on public.user_client_access (tenant_id, client_id);
create index on public.client_authorizations (tenant_id, client_id);
create index on public.role_permissions (permission_code);
create index on public.audit_log (tenant_id, creado_en desc);

-- ---------- Funciones auxiliares (solo estudios ACTIVOS cuentan) ----------
create function private.is_holding() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = (select auth.uid()))
$$;

create function private.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.estado = 'activo'
    where m.tenant_id = p_tenant and m.user_id = (select auth.uid()))
$$;

create function private.is_tenant_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.estado = 'activo'
    join public.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
    where m.tenant_id = p_tenant and m.user_id = (select auth.uid()) and r.es_admin)
$$;

create function private.can_see_client(p_tenant uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_tenant_admin(p_tenant) or (
    private.is_member(p_tenant) and exists (
      select 1 from public.user_client_access a
      where a.tenant_id = p_tenant and a.client_id = p_client
        and a.user_id = (select auth.uid())))
$$;

create function private.shares_tenant(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m1
    join public.memberships m2 on m2.tenant_id = m1.tenant_id
    where m1.user_id = (select auth.uid()) and m2.user_id = p_user)
$$;

-- ---------- Triggers ----------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Auditoria automatica (no guarda la ficha fiscal, por ser dato personal).
create function private.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row jsonb; v_tenant uuid;
begin
  v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_tenant := case when tg_table_name = 'tenants' then (v_row->>'id')::uuid
                   else (v_row->>'tenant_id')::uuid end;
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (v_tenant, (select auth.uid()), tg_op, tg_table_name, 'ok',
          jsonb_build_object('fila', v_row - 'ficha_fiscal'));
  return null;
end $$;

create trigger audit_tenants after insert or update or delete on public.tenants
  for each row execute function private.audit_trigger();
create trigger audit_roles after insert or update or delete on public.roles
  for each row execute function private.audit_trigger();
create trigger audit_memberships after insert or update or delete on public.memberships
  for each row execute function private.audit_trigger();
create trigger audit_clients after insert or update or delete on public.clients
  for each row execute function private.audit_trigger();
create trigger audit_client_auth after insert or update or delete on public.client_authorizations
  for each row execute function private.audit_trigger();
create trigger audit_user_client_access after insert or update or delete on public.user_client_access
  for each row execute function private.audit_trigger();

-- ---------- Permisos de funciones ----------
revoke all on all functions in schema private from public, anon;
grant execute on function private.is_holding(), private.is_member(uuid),
  private.is_tenant_admin(uuid), private.can_see_client(uuid, uuid),
  private.shares_tenant(uuid) to authenticated;

-- ---------- Permisos de tablas (minimo necesario; anon no accede a nada) ----------
revoke all on public.tenants, public.profiles, public.platform_admins, public.permissions,
  public.roles, public.role_permissions, public.memberships, public.clients,
  public.client_authorizations, public.user_client_access, public.audit_log
  from anon, authenticated;

grant select, insert, update, delete on public.tenants, public.permissions, public.roles,
  public.role_permissions, public.memberships, public.clients,
  public.client_authorizations, public.user_client_access to authenticated;
grant select on public.audit_log, public.platform_admins, public.profiles to authenticated;
grant update (nombre) on public.profiles to authenticated;

-- ---------- RLS ----------
alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.platform_admins enable row level security;
alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.memberships enable row level security;
alter table public.clients enable row level security;
alter table public.client_authorizations enable row level security;
alter table public.user_client_access enable row level security;
alter table public.audit_log enable row level security;

create policy tenants_select on public.tenants for select to authenticated
  using (private.is_holding() or private.is_member(id));
create policy tenants_insert on public.tenants for insert to authenticated
  with check (private.is_holding());
create policy tenants_update on public.tenants for update to authenticated
  using (private.is_holding()) with check (private.is_holding());
create policy tenants_delete on public.tenants for delete to authenticated
  using (private.is_holding());

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_holding() or private.shares_tenant(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy platform_admins_select on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy permissions_select on public.permissions for select to authenticated
  using (true);
create policy permissions_write on public.permissions for all to authenticated
  using (private.is_holding()) with check (private.is_holding());

create policy roles_select on public.roles for select to authenticated
  using (private.is_holding() or private.is_member(tenant_id));
create policy roles_write on public.roles for all to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id))
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_member(r.tenant_id))));
create policy role_permissions_write on public.role_permissions for all to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))))
  with check (exists (select 1 from public.roles r where r.id = role_id
         and (private.is_holding() or private.is_tenant_admin(r.tenant_id))));

create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.is_holding() or private.is_tenant_admin(tenant_id));
create policy memberships_write on public.memberships for all to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id))
  with check (private.is_holding() or private.is_tenant_admin(tenant_id));

-- El holding NO lee datos fiscales de clientes: solo administra estudios y audita.
create policy clients_select on public.clients for select to authenticated
  using (private.can_see_client(tenant_id, id));
create policy clients_write on public.clients for all to authenticated
  using (private.is_tenant_admin(tenant_id)) with check (private.is_tenant_admin(tenant_id));

create policy client_auth_all on public.client_authorizations for all to authenticated
  using (private.is_tenant_admin(tenant_id)) with check (private.is_tenant_admin(tenant_id));

create policy uca_select on public.user_client_access for select to authenticated
  using (user_id = (select auth.uid()) or private.is_tenant_admin(tenant_id));
create policy uca_write on public.user_client_access for all to authenticated
  using (private.is_tenant_admin(tenant_id)) with check (private.is_tenant_admin(tenant_id));

create policy audit_select on public.audit_log for select to authenticated
  using (private.is_holding() or (tenant_id is not null and private.is_tenant_admin(tenant_id)));
