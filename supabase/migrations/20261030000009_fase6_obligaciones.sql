-- Fase 6: obligaciones por cliente (DDJJ y VEP en seguimiento), calendario de vencimientos por terminacion de CUIT,
-- escala de monotributo y calculo de recategorizacion.
-- IMPORTANTE: ARCA no ofrece un servicio publico para generar VEP ni presentar DDJJ. Aca se REGISTRA y se hace SEGUIMIENTO
-- de lo que el estudio hace en ARCA; nada se simula.

-- ---------- Permiso nuevo ----------
insert into public.permissions (code, descripcion) values
  ('obligaciones.gestionar', 'Registrar y actualizar el estado de las obligaciones (DDJJ y VEP) de los clientes asignados')
on conflict (code) do nothing;

-- ---------- Auditoria para tablas globales (sin estudio) ----------
create or replace function private.audit_global_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row jsonb;
begin
  v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (null, (select auth.uid()), tg_op, tg_table_name, 'ok', jsonb_build_object('fila', v_row));
  return null;
end $$;
revoke execute on function private.audit_global_trigger() from public, anon, authenticated;

-- ---------- Catalogo de obligaciones ----------
create table public.obligacion_tipos (
  codigo text primary key check (codigo ~ '^[a-z0-9_]{2,40}$'),
  nombre text not null check (char_length(nombre) between 3 and 120),
  aplica_a text[] not null default '{}',          -- regimenes a los que se genera sola; vacio = solo se carga a mano
  descripcion text,
  check (aplica_a <@ array['monotributo','responsable_inscripto','exento','no_inscripto']::text[])
);
insert into public.obligacion_tipos (codigo, nombre, aplica_a, descripcion) values
  ('iva_ddjj',          'IVA: declaración jurada y pago (F.2002)', '{responsable_inscripto}', 'Declaración jurada mensual del IVA y su pago.'),
  ('monotributo_cuota', 'Monotributo: cuota mensual',              '{monotributo}',           'Pago mensual del monotributo.'),
  ('f931',              'Cargas sociales (F.931)',                 '{}',                       'Solo para clientes con empleados; se carga a mano.');

-- ---------- Calendario de vencimientos (por obligacion, periodo y ultimo digito del CUIT) ----------
create table public.vencimientos_calendario (
  id uuid primary key default gen_random_uuid(),
  obligacion_codigo text not null references public.obligacion_tipos(codigo) on update cascade on delete restrict,
  periodo text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- periodo fiscal al que corresponde la obligacion
  terminacion smallint not null check (terminacion between 0 and 9),     -- ultimo digito del CUIT
  fecha date not null,                                                    -- fecha de vencimiento
  fuente text not null check (char_length(fuente) between 3 and 300),
  verificado boolean not null default false,
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  unique (obligacion_codigo, periodo, terminacion)
);

-- ---------- Escala de monotributo ----------
create table public.monotributo_escalas (
  id uuid primary key default gen_random_uuid(),
  categoria text not null check (categoria ~ '^[A-K]$'),
  vigente_desde date not null,
  ingresos_max numeric(16,2) not null check (ingresos_max > 0),
  cuota_servicios numeric(14,2) not null check (cuota_servicios >= 0),
  cuota_bienes numeric(14,2) not null check (cuota_bienes >= 0),
  fuente text not null check (char_length(fuente) between 3 and 300),
  verificado boolean not null default false,
  creado_en timestamptz not null default now(),
  unique (categoria, vigente_desde)
);

-- ---------- Obligaciones por cliente: seguimiento de DDJJ y VEP ----------
create table public.obligaciones_cliente (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  obligacion_codigo text not null references public.obligacion_tipos(codigo) on update cascade on delete restrict,
  periodo text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'presentada', 'pagada', 'no_corresponde')),
  monto numeric(14,2) check (monto is null or monto >= 0),               -- monto a pagar segun la DDJJ
  vep_numero text check (vep_numero is null or char_length(vep_numero) between 1 and 40),
  vep_monto numeric(14,2) check (vep_monto is null or vep_monto >= 0),
  vep_vence date,
  presentada_en date,
  pagada_en date,
  notas text check (notas is null or char_length(notas) <= 1000),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_por uuid,
  actualizado_en timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.clients(tenant_id, id) on delete cascade,
  unique (client_id, obligacion_codigo, periodo),
  check (estado <> 'pagada' or pagada_en is not null),
  check (estado not in ('presentada', 'pagada') or presentada_en is not null or estado = 'pagada')
);
create index obligaciones_cliente_tenant_periodo on public.obligaciones_cliente (tenant_id, periodo, estado);

create or replace function private.obligaciones_sello() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.actualizado_en := now();
  new.actualizado_por := (select auth.uid());
  return new;
end $$;
revoke execute on function private.obligaciones_sello() from public, anon, authenticated;
create trigger obligaciones_sello before update on public.obligaciones_cliente
  for each row execute function private.obligaciones_sello();

create trigger audit_obligaciones_cliente after insert or update or delete on public.obligaciones_cliente
  for each row execute function private.audit_trigger();
create trigger audit_obligacion_tipos after insert or update or delete on public.obligacion_tipos
  for each row execute function private.audit_global_trigger();
create trigger audit_vencimientos_calendario after insert or update or delete on public.vencimientos_calendario
  for each row execute function private.audit_global_trigger();
create trigger audit_monotributo_escalas after insert or update or delete on public.monotributo_escalas
  for each row execute function private.audit_global_trigger();

-- ---------- RLS ----------
alter table public.obligacion_tipos enable row level security;
alter table public.vencimientos_calendario enable row level security;
alter table public.monotributo_escalas enable row level security;
alter table public.obligaciones_cliente enable row level security;

-- Catalogos globales: los ve cualquier usuario con sesion; los modifica solo el holding.
create policy obl_tipos_ver on public.obligacion_tipos for select to authenticated using (true);
create policy obl_tipos_mod on public.obligacion_tipos for all to authenticated using (private.is_holding()) with check (private.is_holding());
create policy venc_ver on public.vencimientos_calendario for select to authenticated using (true);
create policy venc_mod on public.vencimientos_calendario for all to authenticated using (private.is_holding()) with check (private.is_holding());
create policy escalas_ver on public.monotributo_escalas for select to authenticated using (true);
create policy escalas_mod on public.monotributo_escalas for all to authenticated using (private.is_holding()) with check (private.is_holding());

create policy oblig_ver on public.obligaciones_cliente for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy oblig_crear on public.obligaciones_cliente for insert to authenticated
  with check (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id)
              and creado_por = (select auth.uid()));
create policy oblig_editar on public.obligaciones_cliente for update to authenticated
  using (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id))
  with check (private.has_permission(tenant_id, 'obligaciones.gestionar') and private.can_see_client(tenant_id, client_id));
create policy oblig_borrar on public.obligaciones_cliente for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

-- ---------- Grants ----------
revoke all on public.obligacion_tipos, public.vencimientos_calendario, public.monotributo_escalas, public.obligaciones_cliente from anon, authenticated;
grant select, insert, update, delete on public.obligacion_tipos, public.vencimientos_calendario, public.monotributo_escalas to authenticated;
grant select, insert, delete on public.obligaciones_cliente to authenticated;
grant update (estado, monto, vep_numero, vep_monto, vep_vence, presentada_en, pagada_en, notas) on public.obligaciones_cliente to authenticated;
grant all on public.obligacion_tipos, public.vencimientos_calendario, public.monotributo_escalas, public.obligaciones_cliente to service_role;

-- ---------- Datos reales iniciales (NO verificados: el holding debe confirmarlos con el calendario oficial de ARCA) ----------
-- Calendario de noviembre de 2026 segun yo-facturo.com. IVA y F.931 corresponden al periodo anterior (octubre); la cuota de monotributo, a noviembre.
insert into public.vencimientos_calendario (obligacion_codigo, periodo, terminacion, fecha, fuente, verificado)
select 'iva_ddjj', '2026-10', d, date '2026-11-18' + (d / 2), 'yo-facturo.com/vencimientos/noviembre-2026 (consultado el 29/10/2026); confirmar con ARCA', false
  from generate_series(0, 9) d
union all
select 'monotributo_cuota', '2026-11', d, date '2026-11-20', 'yo-facturo.com/vencimientos/noviembre-2026 (consultado el 29/10/2026); confirmar con ARCA', false
  from generate_series(0, 9) d
union all
select 'f931', '2026-10', d, date '2026-11-11' + (d / 2), 'yo-facturo.com/vencimientos/noviembre-2026 (consultado el 29/10/2026); confirmar con ARCA', false
  from generate_series(0, 9) d;

-- Topes y cuotas de monotributo vigentes desde agosto de 2026 segun calcularsueldo.com.ar (consultado el 29/10/2026).
insert into public.monotributo_escalas (categoria, vigente_desde, ingresos_max, cuota_servicios, cuota_bienes, fuente, verificado) values
  ('A', '2026-08-01',  12009410.00,   49527.18,  49527.18, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('B', '2026-08-01',  17595182.00,   56379.00,  56379.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('C', '2026-08-01',  24670494.00,   66020.00,  64539.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('D', '2026-08-01',  30628651.00,   84614.00,  82564.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('E', '2026-08-01',  36028231.00,  119811.00, 108267.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('F', '2026-08-01',  45151659.00,  150784.00, 129930.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('G', '2026-08-01',  53995798.00,  230612.00, 158815.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('H', '2026-08-01',  81924660.00,  522706.00, 317895.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('I', '2026-08-01',  91699761.00,  963747.00, 474994.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('J', '2026-08-01', 105012519.00, 1167299.00, 580793.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false),
  ('K', '2026-08-01', 126610830.00, 1614446.02, 702103.00, 'calcularsueldo.com.ar, escalas desde agosto 2026; confirmar con ARCA', false);

-- ---------- Funciones ----------
-- Fecha de vencimiento de una obligacion para un CUIT (null si el calendario no la tiene cargada)
create or replace function public.vencimiento_de(p_obligacion text, p_periodo text, p_cuit text) returns date
language sql stable set search_path = '' as $$
  select v.fecha from public.vencimientos_calendario v
   where v.obligacion_codigo = p_obligacion and v.periodo = p_periodo and v.terminacion = right(p_cuit, 1)::smallint
$$;

-- Crea las obligaciones que faltan para un cliente y periodo segun su regimen (idempotente)
create or replace function private.generar_obligaciones(p_tenant uuid, p_client uuid, p_periodo text, p_uid uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_reg text; v_n int;
begin
  select regimen into v_reg from public.clients where id = p_client and tenant_id = p_tenant;
  if v_reg is null then return 0; end if;
  insert into public.obligaciones_cliente (tenant_id, client_id, obligacion_codigo, periodo, creado_por)
  select p_tenant, p_client, t.codigo, p_periodo, p_uid
    from public.obligacion_tipos t where v_reg = any (t.aplica_a)
  on conflict (client_id, obligacion_codigo, periodo) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function private.generar_obligaciones_estudio(p_tenant uuid, p_periodo text) returns int
language plpgsql security definer set search_path = '' as $$
declare c record; v_n int := 0; v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.has_permission(p_tenant, 'obligaciones.gestionar') then
    raise exception 'No tenés permiso para generar obligaciones en este estudio' using errcode = '42501';
  end if;
  if p_periodo !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Período inválido' using errcode = 'P0001'; end if;
  for c in select id from public.clients where tenant_id = p_tenant and activo and private.can_see_client(p_tenant, id) loop
    v_n := v_n + private.generar_obligaciones(p_tenant, c.id, p_periodo, v_uid);
  end loop;
  return v_n;
end $$;

-- Recategorizacion: ingresos de los ultimos 12 meses completos contra los topes vigentes
create or replace function private.recategorizacion_calcular(p_tenant uuid, p_client uuid, p_hasta date default current_date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.clients; v_ini date; v_fin date; v_fact numeric; n int; sinconf int; v_sin_meses text[] := '{}'; m date;
  v_act public.monotributo_escalas; v_sug text; v_adv text[] := '{}'; v_vig date; v_noverif boolean; v_uso numeric;
  v_sug_row public.monotributo_escalas;
begin
  select * into c from public.clients where id = p_client and tenant_id = p_tenant;
  if not found then raise exception 'Cliente no encontrado' using errcode = 'SC001'; end if;
  if c.regimen is distinct from 'monotributo' or c.categoria_monotributo is null then
    return jsonb_build_object('aplica', false, 'motivo', 'El cliente no es monotributista o no tiene categoría cargada');
  end if;
  v_fin := (date_trunc('month', p_hasta::timestamp))::date - 1;      -- ultimo dia del mes anterior
  v_ini := (date_trunc('month', p_hasta::timestamp) - interval '12 months')::date;

  select coalesce(sum((case when nota_credito then -1 else 1 end) * total *
           (case when upper(moneda) in ('ARS', 'PES', '$') then 1 else coalesce(nullif(tipo_cambio, 0), 1) end)), 0),
         count(*), count(*) filter (where estado_dato <> 'confirmado')
    into v_fact, n, sinconf
    from public.comprobantes
   where tenant_id = p_tenant and client_id = p_client and sentido = 'emitido' and fecha between v_ini and v_fin;

  for m in select generate_series(v_ini, v_fin, interval '1 month')::date loop
    if not exists (select 1 from public.comprobantes where tenant_id = p_tenant and client_id = p_client and sentido = 'emitido'
                      and fecha >= m and fecha < (m + interval '1 month')::date) then
      v_sin_meses := array_append(v_sin_meses, to_char(m, 'YYYY-MM'));
    end if;
  end loop;

  select max(vigente_desde) into v_vig from public.monotributo_escalas where vigente_desde <= p_hasta;
  if v_vig is null then
    return jsonb_build_object('aplica', true, 'calculable', false, 'motivo', 'No hay una escala de monotributo cargada vigente a la fecha');
  end if;
  select * into v_act from public.monotributo_escalas where categoria = c.categoria_monotributo and vigente_desde = v_vig;
  select * into v_sug_row from public.monotributo_escalas where vigente_desde = v_vig and ingresos_max >= v_fact order by categoria limit 1;
  v_sug := v_sug_row.categoria;
  select bool_or(not verificado) into v_noverif from public.monotributo_escalas where vigente_desde = v_vig;
  v_uso := case when v_act.ingresos_max > 0 then round(v_fact / v_act.ingresos_max * 100, 1) end;

  if n = 0 then v_adv := array_append(v_adv, 'No hay comprobantes emitidos importados en los últimos 12 meses: el cálculo no es confiable.'); end if;
  if cardinality(v_sin_meses) > 0 and n > 0 then
    v_adv := array_append(v_adv, 'Meses sin comprobantes emitidos: ' || array_to_string(v_sin_meses, ', ') || '. Verificá que estén importados.');
  end if;
  if sinconf > 0 then v_adv := array_append(v_adv, sinconf || ' de ' || n || ' comprobantes no están confirmados.'); end if;
  if v_sug is null then v_adv := array_append(v_adv, 'Los ingresos superan el tope de la categoría K: corresponde evaluar la salida del monotributo.'); end if;
  if v_noverif then v_adv := array_append(v_adv, 'La escala de topes cargada todavía no fue verificada con ARCA.'); end if;
  v_adv := array_append(v_adv, 'Solo se evalúa el tope de ingresos; no se controlan superficie, energía eléctrica, alquileres ni precio unitario.');

  return jsonb_build_object('aplica', true, 'calculable', n > 0,
    'desde', v_ini, 'hasta', v_fin, 'comprobantes', n, 'sin_confirmar', sinconf, 'meses_sin_comprobantes', to_jsonb(v_sin_meses),
    'ingresos_12m', v_fact, 'categoria_actual', c.categoria_monotributo, 'tope_actual', v_act.ingresos_max, 'uso_porcentaje', v_uso,
    'categoria_sugerida', v_sug, 'excede_k', v_sug is null, 'escala_vigente_desde', v_vig, 'escala_verificada', not coalesce(v_noverif, false),
    'advertencias', to_jsonb(v_adv));
end $$;

create or replace function private.recategorizacion_cliente(p_tenant uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.can_see_client(p_tenant, p_client) then
    raise exception 'Cliente no encontrado' using errcode = 'P0001';
  end if;
  return private.recategorizacion_calcular(p_tenant, p_client, current_date);
end $$;

-- ---------- Operaciones del motor de tareas ----------
create or replace function private.h_control_obligaciones(r public.task_runs, t public.task_definitions)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hoy date := (now() at time zone t.zona)::date;
  v_aviso int; o record; v_cuit text; v_f date; v_creadas int; v_alertas int := 0; v_sinfecha text[] := '{}';
  v_pend int := 0; v_tit text;
begin
  begin v_aviso := coalesce((t.parametros->>'dias_aviso')::int, 5);
  exception when others then raise exception 'Configuración inválida: dias_aviso debe ser un número' using errcode = 'SC001'; end;
  if v_aviso not between 0 and 60 then raise exception 'Configuración inválida: dias_aviso entre 0 y 60' using errcode = 'SC001'; end if;
  select cuit into v_cuit from public.clients where id = r.client_id and tenant_id = r.tenant_id;
  v_creadas := private.generar_obligaciones(r.tenant_id, r.client_id, r.periodo, t.creado_por);
  for o in select ob.*, ty.nombre from public.obligaciones_cliente ob join public.obligacion_tipos ty on ty.codigo = ob.obligacion_codigo
            where ob.tenant_id = r.tenant_id and ob.client_id = r.client_id and ob.periodo = r.periodo and ob.estado = 'pendiente' loop
    v_pend := v_pend + 1;
    v_f := public.vencimiento_de(o.obligacion_codigo, o.periodo, v_cuit);
    if v_f is null then
      v_sinfecha := array_append(v_sinfecha, o.nombre);
    else
      v_tit := o.nombre || ' ' || o.periodo;
      if v_f < v_hoy then
        if private.agenda_crear_si_falta(r, 'vencimiento', 'VENCIDA: ' || v_tit,
             'Venció el ' || to_char(v_f, 'DD/MM/YYYY') || ' y figura pendiente. Si ya se resolvió, actualizá su estado en Obligaciones.', v_hoy, 'alta') then
          v_alertas := v_alertas + 1; end if;
      elsif v_f - v_hoy <= v_aviso then
        if private.agenda_crear_si_falta(r, 'vencimiento', v_tit || ': vence el ' || to_char(v_f, 'DD/MM'),
             'Vence el ' || to_char(v_f, 'DD/MM/YYYY') || ' y figura pendiente.', v_f, 'alta') then
          v_alertas := v_alertas + 1; end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'estado', case when cardinality(v_sinfecha) > 0 then 'completada_parcialmente' else 'completada' end,
    'mensaje', case when cardinality(v_sinfecha) > 0
                    then 'Falta la fecha de vencimiento en el calendario para: ' || array_to_string(v_sinfecha, ', ')
                    else 'Obligaciones del período ' || r.periodo || ' revisadas (' || v_pend || ' pendientes)' end,
    'datos', jsonb_build_object('periodo', r.periodo, 'obligaciones_creadas', v_creadas, 'pendientes', v_pend,
                                'alertas_creadas', v_alertas, 'sin_fecha_en_calendario', to_jsonb(v_sinfecha)));
end $$;

create or replace function private.h_recategorizacion(r public.task_runs, t public.task_definitions)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hoy date := (now() at time zone t.zona)::date; v jsonb; v_creado boolean := false; v_umbral numeric; v_estado text; v_msg text;
begin
  begin v_umbral := coalesce((t.parametros->>'umbral_porcentaje')::numeric, 90);
  exception when others then raise exception 'Configuración inválida: umbral_porcentaje debe ser un número' using errcode = 'SC001'; end;
  if v_umbral not between 1 and 100 then raise exception 'Configuración inválida: umbral_porcentaje entre 1 y 100' using errcode = 'SC001'; end if;
  v := private.recategorizacion_calcular(r.tenant_id, r.client_id, v_hoy);
  if not (v->>'aplica')::boolean then
    return jsonb_build_object('estado', 'completada_parcialmente', 'mensaje', v->>'motivo', 'datos', v);
  end if;
  if (v->'calculable') is null or not (v->>'calculable')::boolean then
    return jsonb_build_object('estado', 'completada_parcialmente', 'mensaje', coalesce(v->>'motivo', 'No hay comprobantes emitidos para calcular'), 'datos', v);
  end if;
  if (v->>'uso_porcentaje')::numeric >= v_umbral or (v->>'categoria_sugerida') is distinct from (v->>'categoria_actual') then
    v_creado := private.agenda_crear_si_falta(r, 'control',
      'Recategorización ' || to_char(v_hoy, 'YYYY-MM') || ': ingresos al ' || (v->>'uso_porcentaje') || '% del tope',
      'Ingresos de 12 meses: $' || round((v->>'ingresos_12m')::numeric, 2) || ' · categoría actual ' || (v->>'categoria_actual') ||
      ' (tope $' || round((v->>'tope_actual')::numeric, 2) || ') · categoría sugerida ' || coalesce(v->>'categoria_sugerida', 'excede la K') ||
      '. Es una estimación: revisá los datos antes de recategorizar en ARCA.', v_hoy, 'alta');
  end if;
  v_estado := case when jsonb_array_length(coalesce(v->'meses_sin_comprobantes', '[]'::jsonb)) > 0 or (v->>'sin_confirmar')::int > 0 or not (v->>'escala_verificada')::boolean
                   then 'completada_parcialmente' else 'completada' end;
  v_msg := 'Ingresos 12 meses al ' || (v->>'uso_porcentaje') || '% del tope de la categoría ' || (v->>'categoria_actual') ||
           case when v_estado = 'completada_parcialmente' then ' (con advertencias: revisar el detalle)' else '' end;
  return jsonb_build_object('estado', v_estado, 'mensaje', v_msg, 'datos', v || jsonb_build_object('alerta_creada', v_creado));
end $$;

-- Se agregan las dos operaciones al despachador del motor
create or replace function private.ejecutar_run(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.task_runs; t public.task_definitions; v_res jsonb; v_estado text; v_msg text;
begin
  select * into r from public.task_runs where id = p_run for update;
  if not found or r.estado <> 'pendiente' then return; end if;
  select * into t from public.task_definitions where id = r.task_id;

  update public.task_runs
     set estado = 'ejecutando', intento = intento + 1, iniciado_en = coalesce(iniciado_en, now()),
         lease_hasta = now() + interval '10 minutes', proximo_intento = null
   where id = p_run returning * into r;
  perform private.log_evento(p_run, 'info', 'Intento ' || r.intento || ' de ' || r.intentos_max || ' iniciado');

  begin
    v_res := case t.operacion
      when 'importaciones.control_carga' then private.h_control_carga(r, t)
      when 'vencimientos.recordatorio' then private.h_recordatorio(r, t)
      when 'impuestos.control_iva' then private.h_control_iva(r, t)
      when 'vencimientos.control_obligaciones' then private.h_control_obligaciones(r, t)
      when 'recategorizacion.revision' then private.h_recategorizacion(r, t)
      else null end;
    if v_res is null then
      raise exception 'La operación % todavía no está disponible', t.operacion using errcode = 'SC001';
    end if;
    v_estado := v_res->>'estado';
    if v_estado not in ('completada', 'completada_parcialmente') then
      raise exception 'El resultado de la operación no se pudo validar' using errcode = 'SC001';
    end if;
    update public.task_runs
       set estado = v_estado, finalizado_en = now(), lease_hasta = null, error = null,
           resultado = coalesce(v_res->'datos', '{}'::jsonb) || jsonb_build_object('mensaje', v_res->>'mensaje')
     where id = p_run;
    perform private.log_evento(p_run, case when v_estado = 'completada' then 'info' else 'aviso' end, v_res->>'mensaje', coalesce(v_res->'datos', '{}'::jsonb));
    update public.task_definitions set ultima_ejecucion = now() where id = t.id;
  exception when others then
    v_msg := sqlerrm;
    if sqlstate <> 'SC001' and r.intento < r.intentos_max then
      update public.task_runs
         set estado = 'pendiente', lease_hasta = null, error = v_msg,
             proximo_intento = now() + make_interval(mins => t.reintento_intervalo_min)
       where id = p_run;
      perform private.log_evento(p_run, 'aviso', 'Falló el intento ' || r.intento || ': ' || v_msg || '. Se reintenta en ' || t.reintento_intervalo_min || ' min');
    else
      update public.task_runs
         set estado = 'fallida', finalizado_en = now(), lease_hasta = null, error = v_msg
       where id = p_run;
      perform private.log_evento(p_run, 'error', 'Falló definitivamente: ' || v_msg);
      update public.task_definitions set ultima_ejecucion = now() where id = t.id;
    end if;
  end;
end $$;

insert into public.task_operations (codigo, modulo, nombre, descripcion, disponible, nota) values
  ('vencimientos.control_obligaciones', 'Vencimientos', 'Control de obligaciones y vencimientos',
   'Genera las obligaciones del período según el régimen del cliente y avisa en la agenda las que vencen pronto o ya vencieron sin resolverse.', true, null)
on conflict (codigo) do nothing;
update public.task_operations set disponible = true, nota = null,
  descripcion = 'Compara los ingresos emitidos de los últimos 12 meses con los topes de monotributo y avisa si se acerca al tope o conviene recategorizar.'
 where codigo = 'recategorizacion.revision';

-- ---------- Funciones expuestas por la API ----------
create or replace function public.generar_obligaciones(p_tenant uuid, p_periodo text) returns int
language sql set search_path = '' as $$ select private.generar_obligaciones_estudio(p_tenant, p_periodo) $$;
create or replace function public.calcular_recategorizacion(p_tenant uuid, p_client uuid) returns jsonb
language sql stable set search_path = '' as $$ select private.recategorizacion_cliente(p_tenant, p_client) $$;

revoke execute on function
  private.generar_obligaciones(uuid, uuid, text, uuid), private.recategorizacion_calcular(uuid, uuid, date),
  private.h_control_obligaciones(public.task_runs, public.task_definitions), private.h_recategorizacion(public.task_runs, public.task_definitions),
  private.ejecutar_run(uuid), private.generar_obligaciones_estudio(uuid, text), private.recategorizacion_cliente(uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.generar_obligaciones_estudio(uuid, text), private.recategorizacion_cliente(uuid, uuid) to authenticated;
revoke execute on function public.generar_obligaciones(uuid, text), public.calcular_recategorizacion(uuid, uuid), public.vencimiento_de(text, text, text) from public, anon;
grant execute on function public.generar_obligaciones(uuid, text), public.calcular_recategorizacion(uuid, uuid), public.vencimiento_de(text, text, text) to authenticated;
