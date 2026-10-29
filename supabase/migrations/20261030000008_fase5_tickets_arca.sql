-- Tickets de acceso (token/sign) de ARCA. Duran ~12 horas y ARCA no permite pedir otro mientras
-- hay uno vigente para el mismo certificado y servicio, por eso se guardan y reutilizan.
-- Solo la Edge Function (service_role) accede: sin permisos para anon ni authenticated.
create table public.arca_tickets (
  certificado_id uuid not null references public.arca_certificados(id) on delete cascade,
  servicio text not null check (servicio ~ '^[a-z0-9_]{2,60}$'),
  token text not null,
  sign text not null,
  expira timestamptz not null,
  creado_en timestamptz not null default now(),
  primary key (certificado_id, servicio)
);
alter table public.arca_tickets enable row level security;
revoke all on public.arca_tickets from anon, authenticated;

-- El certificado publico (.crt) no es secreto; se guarda para poder firmar el login.
alter table public.arca_certificados add column crt_pem text;
