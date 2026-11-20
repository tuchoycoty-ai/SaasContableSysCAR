-- Agenda de VEP recurrentes (anticipos de Ganancias, autónomos, monotributo): se programan por cliente, se cargan en ARCA con la extensión
-- (hasta «VEPs a enviar») y se marcan pagados solos cuando se importa el comprobante de pago.
create table public.veps_programados (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  tipo text not null check (tipo in ('ganancias_anticipo', 'autonomo', 'monotributo', 'otro')),
  grupo text not null check (char_length(grupo) between 1 and 80),           -- grupo de ARCA: «Ganancias», «Autónomo», «Monotributo»
  tipo_pago text not null check (char_length(tipo_pago) between 1 and 200),  -- texto EXACTO del desplegable «Tipo de Pago» de ARCA
  anio int not null check (anio between 2000 and 2100),
  mes int check (mes is null or mes between 1 and 12),
  cuota int check (cuota is null or cuota between 1 and 99),
  importe numeric(16,2) check (importe is null or (importe > 0 and importe < 1e13)),
  vence date,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'listo', 'cargado', 'emitido', 'pagado', 'anulado')),
  nro_vep text check (nro_vep is null or char_length(nro_vep) between 1 and 40),
  pago_id uuid references public.pagos (id) on delete set null,
  pagado_en date,
  notas text check (notas is null or char_length(notas) <= 1000),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_por uuid,
  actualizado_en timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete cascade,
  check (estado not in ('listo', 'cargado', 'emitido', 'pagado') or importe is not null),
  check (estado <> 'pagado' or pagado_en is not null)
);
-- Un mismo VEP (cliente, tipo de pago, período y cuota) no se programa dos veces mientras no esté anulado.
create unique index veps_programados_unico on public.veps_programados (client_id, tipo_pago, anio, coalesce(mes, 0), coalesce(cuota, 0)) where estado <> 'anulado';
create index veps_programados_agenda on public.veps_programados (tenant_id, estado, vence);

create or replace function private.veps_programados_sello() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.actualizado_en := now();
  new.actualizado_por := (select auth.uid());
  return new;
end $$;
revoke execute on function private.veps_programados_sello() from public, anon, authenticated;
create trigger veps_programados_sello before update on public.veps_programados
  for each row execute function private.veps_programados_sello();
create trigger audit_veps_programados after insert or update or delete on public.veps_programados
  for each row execute function private.audit_trigger();

alter table public.veps_programados enable row level security;
revoke all on public.veps_programados from anon, authenticated, public;
grant select, insert, delete on public.veps_programados to authenticated;
grant update (tipo_pago, grupo, anio, mes, cuota, importe, vence, estado, nro_vep, notas) on public.veps_programados to authenticated;
grant all on public.veps_programados to service_role;

create policy vepp_ver on public.veps_programados for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy vepp_crear on public.veps_programados for insert to authenticated
  with check (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id)
              and creado_por = (select auth.uid()) and estado in ('pendiente', 'listo'));
create policy vepp_editar on public.veps_programados for update to authenticated
  using (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id))
  with check (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id));
create policy vepp_borrar on public.veps_programados for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

-- Marca como pagados los VEP programados cuyo comprobante de pago ya se importó.
-- Coincide por número de VEP (si se conoce) o por cliente + período + cuota + tipo de impuesto. Solo mira el capital (no los subVEP de intereses).
create or replace function private.conciliar_veps(p_tenant uuid, p_client uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; v_r record; v_pago record;
begin
  if (select auth.uid()) is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not private.has_permission(p_tenant, 'obligaciones.gestionar') then
    raise exception 'No tenés permiso para actualizar VEP' using errcode = '42501';
  end if;
  for v_r in
    select * from public.veps_programados
    where tenant_id = p_tenant and (p_client is null or client_id = p_client) and estado in ('listo', 'cargado', 'emitido')
      and private.can_see_client(tenant_id, client_id)
  loop
    select p.id, p.fecha, p.referencia into v_pago
    from public.pagos p
    where p.tenant_id = v_r.tenant_id and p.client_id = v_r.client_id and not p.es_consolidado
      and coalesce(p.naturaleza, 'capital') = 'capital'
      and (
        (v_r.nro_vep is not null and p.referencia = v_r.nro_vep)
        or (
          case v_r.tipo
            when 'ganancias_anticipo' then
              p.periodo_arca = v_r.anio::text and p.cuota = v_r.cuota::text
              and (coalesce(p.concepto_arca, '') ~ '^191' or coalesce(p.tipo_pago, '') || ' ' || coalesce(p.descripcion_reducida, '') ~* 'ganancias')
            when 'autonomo' then
              p.periodo_arca = to_char(make_date(v_r.anio, coalesce(v_r.mes, 1), 1), 'YYYY-MM')
              and coalesce(p.tipo_pago, '') || ' ' || coalesce(p.descripcion_reducida, '') || ' ' || coalesce(p.impuesto, '') || ' ' || p.concepto ~* 'aut[oó]nom'
            when 'monotributo' then
              p.periodo_arca = to_char(make_date(v_r.anio, coalesce(v_r.mes, 1), 1), 'YYYY-MM')
              and coalesce(p.tipo_pago, '') || ' ' || coalesce(p.descripcion_reducida, '') || ' ' || coalesce(p.impuesto, '') || ' ' || p.concepto ~* 'monotribut'
            else false
          end
        )
      )
    order by p.fecha desc limit 1;
    if found then
      update public.veps_programados
      set estado = 'pagado', pago_id = v_pago.id, pagado_en = v_pago.fecha, nro_vep = coalesce(nro_vep, v_pago.referencia)
      where id = v_r.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
-- El trigger de sello pisa actualizado_*; pago_id y pagado_en solo los cambia esta función (no figuran en el grant de update de la tabla).

create or replace function public.conciliar_veps(p_tenant uuid, p_client uuid default null) returns int
language sql set search_path = '' as $$ select private.conciliar_veps(p_tenant, p_client) $$;

revoke execute on function private.conciliar_veps(uuid, uuid) from public, anon;
grant execute on function private.conciliar_veps(uuid, uuid) to authenticated;
revoke execute on function public.conciliar_veps(uuid, uuid) from public, anon;
grant execute on function public.conciliar_veps(uuid, uuid) to authenticated;
