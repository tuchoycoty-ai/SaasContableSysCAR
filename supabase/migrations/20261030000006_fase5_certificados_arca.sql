-- Fase 5 · Certificados ARCA por estudio.
-- arca_certificados: datos NO secretos (visibles para el administrador del estudio y el holding).
-- arca_secretos: la clave privada CIFRADA. Nadie del navegador puede leerla: sin permisos para
--   anon ni authenticated; solo la funcion segura "arca-certificados" (service_role) la toca.
create table public.arca_certificados (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ambiente text not null check (ambiente in ('homologacion', 'produccion')),
  alias text not null check (char_length(alias) between 1 and 60),
  cuit text not null check (cuit ~ '^[0-9]{11}$' and private.cuit_valido(cuit)),
  estado text not null check (estado in ('csr_generado', 'activo', 'revocado')),
  origen text not null check (origen in ('generado_aqui', 'subido')),
  csr_pem text,
  sujeto text,
  valido_desde timestamptz,
  valido_hasta timestamptz,
  huella_sha256 text,
  creado_por uuid references auth.users(id) on delete set null,
  creado_en timestamptz not null default now(),
  activado_en timestamptz,
  constraint activo_requiere_datos check (estado <> 'activo' or (valido_hasta is not null and huella_sha256 is not null))
);
-- Un solo certificado vigente (o pendiente) por estudio y ambiente
create unique index arca_cert_uno_por_ambiente on public.arca_certificados (tenant_id, ambiente)
  where estado in ('csr_generado', 'activo');
create index arca_cert_tenant on public.arca_certificados (tenant_id);
create index arca_cert_creado_por on public.arca_certificados (creado_por);

create table public.arca_secretos (
  certificado_id uuid primary key references public.arca_certificados(id) on delete cascade,
  clave_cifrada text not null,
  creado_en timestamptz not null default now()
);

alter table public.arca_certificados enable row level security;
alter table public.arca_secretos enable row level security;  -- sin politicas: nadie la lee con el SDK

revoke all on public.arca_certificados, public.arca_secretos from anon, authenticated;
grant select on public.arca_certificados to authenticated;

create policy arca_cert_select on public.arca_certificados for select to authenticated
  using (private.is_holding() or private.is_tenant_admin(tenant_id));

create trigger arca_certificados_audit after insert or update or delete on public.arca_certificados
  for each row execute function private.audit_trigger();
