-- DDJJ y VEP con detalle: conceptos, intereses, periodos, transaccion, banco, vencimiento; y las DDJJ presentadas en su propia tabla.
alter table public.pagos
  add column tipo_pago text check (tipo_pago is null or char_length(tipo_pago) <= 200),
  add column descripcion_reducida text check (descripcion_reducida is null or char_length(descripcion_reducida) <= 100),
  add column concepto_arca text check (concepto_arca is null or char_length(concepto_arca) <= 120),
  add column subconcepto_arca text check (subconcepto_arca is null or char_length(subconcepto_arca) <= 120),
  add column periodo_arca text check (periodo_arca is null or char_length(periodo_arca) <= 20),
  add column cuota text check (cuota is null or char_length(cuota) <= 20),
  add column naturaleza text check (naturaleza is null or naturaleza in ('capital', 'intereses', 'multa', 'honorarios')),
  add column intereses numeric(16,2) not null default 0 check (intereses >= 0),
  add column detalle jsonb check (detalle is null or jsonb_typeof(detalle) = 'array'),
  add column nro_transaccion text check (nro_transaccion is null or char_length(nro_transaccion) <= 40),
  add column hora_pago text check (hora_pago is null or char_length(hora_pago) <= 20),
  add column entidad_pago text check (entidad_pago is null or char_length(entidad_pago) <= 120),
  add column banco text check (banco is null or char_length(banco) <= 120),
  add column vence date,
  add column dj_nro text check (dj_nro is null or char_length(dj_nro) <= 40),
  add column vep_consolidado text check (vep_consolidado is null or char_length(vep_consolidado) <= 40),
  add column es_consolidado boolean not null default false;
create index pagos_consolidado on public.pagos (client_id, vep_consolidado) where vep_consolidado is not null;

create or replace function private.texto_json(p_fila jsonb, p_clave text, p_max int) returns text
language sql immutable set search_path = '' as $$ select left(nullif(trim(coalesce(p_fila->>p_clave, '')), ''), p_max) $$;
create or replace function private.importe_json(p_fila jsonb, p_clave text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v numeric := coalesce(nullif(p_fila->>p_clave, '')::numeric, 0);
begin
  if v < 0 or v >= 1e13 then raise exception 'Importe fuera de rango' using errcode = 'P0001'; end if;
  return v;
end $$;
revoke execute on function private.texto_json(jsonb, text, int), private.importe_json(jsonb, text) from public, anon;
grant execute on function private.texto_json(jsonb, text, int), private.importe_json(jsonb, text) to authenticated;

-- Declaraciones juradas presentadas (acuses de recibo)
create table public.presentaciones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  formulario text not null check (formulario ~ '^[0-9]{3,4}$'),
  version text check (version is null or char_length(version) <= 20),
  nombre text not null check (char_length(nombre) <= 200),
  impuesto text check (impuesto is null or char_length(impuesto) <= 200),
  concepto text check (concepto is null or char_length(concepto) <= 200),
  subconcepto text check (subconcepto is null or char_length(subconcepto) <= 200),
  periodo text check (periodo is null or periodo ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$'),
  fecha date not null,
  hora text check (hora is null or char_length(hora) <= 20),
  nro_transaccion text not null check (nro_transaccion ~ '^[0-9]{1,20}$'),
  nro_verificador text check (nro_verificador is null or char_length(nro_verificador) <= 20),
  registros int check (registros is null or registros >= 0),
  presentada_por text check (presentada_por is null or char_length(presentada_por) <= 20),
  codigo_barras text check (codigo_barras is null or char_length(codigo_barras) <= 60),
  archivo_nombre text check (archivo_nombre is null or char_length(archivo_nombre) <= 200),
  creado_por uuid default auth.uid(),
  creado_en timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  unique (client_id, nro_transaccion)
);
create index presentaciones_cliente on public.presentaciones (tenant_id, client_id, fecha);
alter table public.presentaciones enable row level security;
revoke all on public.presentaciones from anon, authenticated, public;
grant select on public.presentaciones to authenticated;
create policy presentaciones_ver on public.presentaciones for select to authenticated
  using (private.can_see_client(tenant_id, client_id));

create or replace function private.registrar_presentacion(p_tenant uuid, p_client uuid, p_d jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not (private.has_permission(p_tenant, 'importaciones.gestionar') and private.can_see_client(p_tenant, p_client)) then
    raise exception 'No tenés permiso para importar datos de este cliente' using errcode = '42501';
  end if;
  insert into public.presentaciones (tenant_id, client_id, formulario, version, nombre, impuesto, concepto, subconcepto, periodo, fecha, hora,
    nro_transaccion, nro_verificador, registros, presentada_por, codigo_barras, archivo_nombre)
  values (p_tenant, p_client, p_d->>'formulario', private.texto_json(p_d, 'version', 20), coalesce(private.texto_json(p_d, 'nombre', 200), 'DJ'),
    private.texto_json(p_d, 'impuesto', 200), private.texto_json(p_d, 'concepto', 200), private.texto_json(p_d, 'subconcepto', 200),
    private.texto_json(p_d, 'periodo', 20), (p_d->>'fecha')::date, private.texto_json(p_d, 'hora', 20), p_d->>'nro_transaccion',
    private.texto_json(p_d, 'nro_verificador', 20), nullif(p_d->>'registros', '')::int, private.texto_json(p_d, 'presentada_por', 20),
    private.texto_json(p_d, 'codigo_barras', 60), private.texto_json(p_d, 'archivo_nombre', 200))
  on conflict (client_id, nro_transaccion) do update set
    version = excluded.version, nombre = excluded.nombre, impuesto = excluded.impuesto, concepto = excluded.concepto,
    subconcepto = excluded.subconcepto, periodo = excluded.periodo, hora = excluded.hora, nro_verificador = excluded.nro_verificador,
    registros = excluded.registros, presentada_por = excluded.presentada_por, codigo_barras = excluded.codigo_barras
  returning id into v_id;
  return v_id;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  raise exception 'Los datos de la presentación no tienen un formato válido' using errcode = 'P0001';
end $$;
create or replace function public.registrar_presentacion(p_tenant uuid, p_client uuid, p_datos jsonb) returns uuid
language sql set search_path = '' as $$ select private.registrar_presentacion(p_tenant, p_client, p_datos) $$;

-- Completa el detalle de un pago ya importado antes de esta mejora (mismo VEP): solo agrega datos, no cambia importes ni fechas.
create or replace function private.completar_pago(p_tenant uuid, p_client uuid, p_f jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if (select auth.uid()) is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not (private.has_permission(p_tenant, 'importaciones.gestionar') and private.can_see_client(p_tenant, p_client)) then
    raise exception 'No tenés permiso para importar datos de este cliente' using errcode = '42501';
  end if;
  update public.pagos p set
    tipo_pago = private.texto_json(p_f, 'tipo_pago', 200), descripcion_reducida = private.texto_json(p_f, 'descripcion_reducida', 100),
    concepto_arca = private.texto_json(p_f, 'concepto_arca', 120), subconcepto_arca = private.texto_json(p_f, 'subconcepto_arca', 120),
    periodo_arca = private.texto_json(p_f, 'periodo_arca', 20), cuota = private.texto_json(p_f, 'cuota', 20),
    naturaleza = case when p_f->>'naturaleza' in ('capital', 'intereses', 'multa', 'honorarios') then p_f->>'naturaleza' else null end,
    intereses = private.importe_json(p_f, 'intereses'),
    detalle = case when jsonb_typeof(p_f->'detalle') = 'array' and jsonb_array_length(p_f->'detalle') <= 30 then p_f->'detalle' else null end,
    nro_transaccion = private.texto_json(p_f, 'nro_transaccion', 40), hora_pago = private.texto_json(p_f, 'hora_pago', 20),
    entidad_pago = private.texto_json(p_f, 'entidad_pago', 120), banco = private.texto_json(p_f, 'banco', 120),
    vence = nullif(p_f->>'vence', '')::date, dj_nro = private.texto_json(p_f, 'dj_nro', 40),
    vep_consolidado = private.texto_json(p_f, 'vep_consolidado', 40), es_consolidado = coalesce((p_f->>'es_consolidado')::boolean, false)
  where p.tenant_id = p_tenant and p.client_id = p_client and p.fecha = (p_f->>'fecha')::date and p.importe = (p_f->>'importe')::numeric
    and coalesce(p.referencia, '') = coalesce(p_f->>'referencia', '');
  get diagnostics v_n = row_count;
  return v_n;
end $$;
create or replace function public.completar_pago(p_tenant uuid, p_client uuid, p_fila jsonb) returns int
language sql set search_path = '' as $$ select private.completar_pago(p_tenant, p_client, p_fila) $$;

revoke execute on function private.registrar_presentacion(uuid, uuid, jsonb), private.completar_pago(uuid, uuid, jsonb) from public, anon;
grant execute on function private.registrar_presentacion(uuid, uuid, jsonb), private.completar_pago(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.registrar_presentacion(uuid, uuid, jsonb), public.completar_pago(uuid, uuid, jsonb) from public, anon;
grant execute on function public.registrar_presentacion(uuid, uuid, jsonb), public.completar_pago(uuid, uuid, jsonb) to authenticated;

-- Totales de pagos: un VEP consolidado y sus subVEP son el mismo dinero; se cuentan los subVEP (que traen el detalle).
create or replace function public.resumen_mensual(p_tenant uuid, p_client uuid, p_desde date, p_hasta date)
returns table (mes date, rubro text, estado_dato text, cantidad bigint, neto numeric, iva numeric, total numeric)
language sql stable set search_path = '' as $$
  select date_trunc('month', c.fecha)::date, c.sentido, c.estado_dato, count(*),
         sum(c.neto_gravado + c.neto_no_gravado + c.exento), sum(c.iva), sum(c.total)
  from public.comprobantes c
  where c.tenant_id = p_tenant and c.client_id = p_client and c.fecha between p_desde and p_hasta
  group by 1, 2, 3
  union all
  select date_trunc('month', p.fecha)::date, 'pago', p.estado_dato, count(*), sum(p.importe), 0::numeric, sum(p.importe)
  from public.pagos p
  where p.tenant_id = p_tenant and p.client_id = p_client and p.fecha between p_desde and p_hasta
    and not (p.es_consolidado and exists (select 1 from public.pagos s where s.client_id = p.client_id and s.vep_consolidado = p.referencia))
  group by 1, 2, 3
$$;

create or replace function private.confirmar_importacion(
  p_tenant uuid, p_client uuid, p_tipo text, p_archivo text, p_hash text,
  p_filas jsonb, p_rechazos jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_lote uuid;
  v_f jsonb;
  v_ok int := 0; v_dup int := 0; v_rech int := 0; v_pend int := 0;
  v_informe jsonb := '[]'::jsonb;
  v_n int := 0;
  v_fila int;
  v_new uuid;
  v_fecha date;
  v_tipo int; v_pv int; v_num bigint;
  v_nc boolean; v_sg int;
  v_ng numeric; v_nn numeric; v_ex numeric; v_iva numeric; v_ot numeric; v_tot numeric;
  v_doc text; v_nombre text; v_moneda text; v_tc numeric;
  v_estado text; v_adv text;
  v_n0 numeric; v_n25 numeric; v_i25 numeric; v_n5 numeric; v_i5 numeric; v_n105 numeric; v_i105 numeric; v_n21 numeric; v_i21 numeric; v_n27 numeric; v_i27 numeric;
  v_imp numeric; v_conc text; v_ref text;
  c record;
begin
  if v_uid is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not (private.has_permission(p_tenant, 'importaciones.gestionar') and private.can_see_client(p_tenant, p_client)) then
    raise exception 'No tenés permiso para importar datos de este cliente' using errcode = '42501';
  end if;
  if p_tipo not in ('comprobantes_emitidos', 'comprobantes_recibidos', 'pagos') then
    raise exception 'Tipo de importación inválido' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_filas) <> 'array' or jsonb_typeof(p_rechazos) <> 'array' then
    raise exception 'Formato de datos inválido' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) + jsonb_array_length(p_rechazos) > 5000 then
    raise exception 'Archivo demasiado grande (máximo 5000 filas por importación)' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) = 0 then
    raise exception 'No hay filas válidas para importar' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.import_batches b
             where b.tenant_id = p_tenant and b.client_id = p_client and b.tipo = p_tipo
               and b.archivo_hash = p_hash and b.estado <> 'anulado') then
    raise exception 'Este mismo archivo ya fue importado para este cliente. Si querés reprocesarlo, un administrador debe anular el lote anterior.'
      using errcode = 'P0001';
  end if;

  insert into public.import_batches (tenant_id, client_id, tipo, archivo_nombre, archivo_hash, creado_por)
  values (p_tenant, p_client, p_tipo, left(p_archivo, 200), p_hash, v_uid)
  returning id into v_lote;

  -- Rechazos detectados en el navegador (se conservan con su motivo)
  for c in select * from jsonb_array_elements(p_rechazos) as e(x) loop
    v_rech := v_rech + 1;
    if v_n < 300 then
      v_informe := v_informe || jsonb_build_object('fila', c.x->'fila', 'tipo', 'rechazo', 'motivo', left(coalesce(c.x->>'motivo', 'Fila inválida'), 200));
      v_n := v_n + 1;
    end if;
  end loop;

  for v_f in select * from jsonb_array_elements(p_filas) loop
    v_fila := coalesce((v_f->>'fila')::int, 0);
    v_new := null; v_estado := 'importado'; v_adv := null;
    begin
      v_fecha := (v_f->>'fecha')::date;
      if v_fecha < date '2000-01-01' or v_fecha > current_date + 365 then
        raise exception 'Fecha fuera de rango' using errcode = 'P0001';
      end if;

      if p_tipo = 'pagos' then
        v_imp := (v_f->>'importe')::numeric;
        v_conc := nullif(trim(coalesce(v_f->>'concepto', '')), '');
        v_ref := nullif(trim(coalesce(v_f->>'referencia', '')), '');
        if v_imp is null or v_imp <= 0 or v_imp >= 1e13 then
          raise exception 'Importe inválido (debe ser mayor a cero)' using errcode = 'P0001';
        end if;
        if v_conc is null then raise exception 'Falta el concepto' using errcode = 'P0001'; end if;
        insert into public.pagos (tenant_id, client_id, batch_id, fecha, concepto, impuesto, medio, referencia, importe, estado_dato, advertencia,
          tipo_pago, descripcion_reducida, concepto_arca, subconcepto_arca, periodo_arca, cuota, naturaleza, intereses, detalle,
          nro_transaccion, hora_pago, entidad_pago, banco, vence, dj_nro, vep_consolidado, es_consolidado)
        values (p_tenant, p_client, v_lote, v_fecha, left(v_conc, 200),
                left(nullif(trim(coalesce(v_f->>'impuesto', '')), ''), 100),
                left(nullif(trim(coalesce(v_f->>'medio', '')), ''), 100),
                left(v_ref, 100), v_imp, 'importado', null,
                private.texto_json(v_f, 'tipo_pago', 200), private.texto_json(v_f, 'descripcion_reducida', 100),
                private.texto_json(v_f, 'concepto_arca', 120), private.texto_json(v_f, 'subconcepto_arca', 120),
                private.texto_json(v_f, 'periodo_arca', 20), private.texto_json(v_f, 'cuota', 20),
                case when v_f->>'naturaleza' in ('capital', 'intereses', 'multa', 'honorarios') then v_f->>'naturaleza' else null end,
                private.importe_json(v_f, 'intereses'),
                case when jsonb_typeof(v_f->'detalle') = 'array' and jsonb_array_length(v_f->'detalle') <= 30 then v_f->'detalle' else null end,
                private.texto_json(v_f, 'nro_transaccion', 40), private.texto_json(v_f, 'hora_pago', 20),
                private.texto_json(v_f, 'entidad_pago', 120), private.texto_json(v_f, 'banco', 120),
                nullif(v_f->>'vence', '')::date, private.texto_json(v_f, 'dj_nro', 40), private.texto_json(v_f, 'vep_consolidado', 40),
                coalesce((v_f->>'es_consolidado')::boolean, false))
        on conflict do nothing
        returning id into v_new;
      else
        v_tipo := (v_f->>'tipo_cbte')::int;
        v_pv := (v_f->>'punto_venta')::int;
        v_num := (v_f->>'numero')::bigint;
        if v_tipo is null or v_tipo < 1 or v_tipo > 999 then raise exception 'Tipo de comprobante inválido' using errcode = 'P0001'; end if;
        if v_pv is null or v_pv < 1 or v_pv > 99999 then raise exception 'Punto de venta inválido' using errcode = 'P0001'; end if;
        if v_num is null or v_num < 1 then raise exception 'Número de comprobante inválido' using errcode = 'P0001'; end if;
        v_nc := private.es_nota_credito(v_tipo);
        v_sg := case when v_nc then -1 else 1 end;
        v_ng := abs(coalesce((v_f->>'neto_gravado')::numeric, 0)) * v_sg;
        v_nn := abs(coalesce((v_f->>'neto_no_gravado')::numeric, 0)) * v_sg;
        v_ex := abs(coalesce((v_f->>'exento')::numeric, 0)) * v_sg;
        v_iva := abs(coalesce((v_f->>'iva')::numeric, 0)) * v_sg;
        v_ot := abs(coalesce((v_f->>'otros_tributos')::numeric, 0)) * v_sg;
        v_tot := abs((v_f->>'total')::numeric) * v_sg;
        v_n0 := private.importe_firmado(v_f, 'neto_0', v_sg);
        v_n25 := private.importe_firmado(v_f, 'neto_2_5', v_sg); v_i25 := private.importe_firmado(v_f, 'iva_2_5', v_sg);
        v_n5 := private.importe_firmado(v_f, 'neto_5', v_sg); v_i5 := private.importe_firmado(v_f, 'iva_5', v_sg);
        v_n105 := private.importe_firmado(v_f, 'neto_10_5', v_sg); v_i105 := private.importe_firmado(v_f, 'iva_10_5', v_sg);
        v_n21 := private.importe_firmado(v_f, 'neto_21', v_sg); v_i21 := private.importe_firmado(v_f, 'iva_21', v_sg);
        v_n27 := private.importe_firmado(v_f, 'neto_27', v_sg); v_i27 := private.importe_firmado(v_f, 'iva_27', v_sg);
        if abs(v_ng) >= 1e13 or abs(v_nn) >= 1e13 or abs(v_ex) >= 1e13 or abs(v_iva) >= 1e13 or abs(v_ot) >= 1e13 or abs(v_tot) >= 1e13 then
          raise exception 'Importe fuera de rango' using errcode = 'P0001';
        end if;
        v_doc := nullif(regexp_replace(coalesce(v_f->>'doc', ''), '\D', '', 'g'), '');
        v_nombre := left(nullif(trim(coalesce(v_f->>'contraparte', '')), ''), 200);
        v_moneda := upper(left(coalesce(nullif(trim(v_f->>'moneda'), ''), 'PES'), 5));
        v_tc := nullif(v_f->>'tipo_cambio', '')::numeric;

        if abs(v_tot - (v_ng + v_nn + v_ex + v_iva + v_ot)) > 1.00 then
          v_estado := 'pendiente_validacion';
          v_adv := 'El total no coincide con la suma de netos, IVA y otros tributos';
        elsif v_doc is not null and length(v_doc) = 11 and not private.cuit_valido(v_doc) then
          v_estado := 'pendiente_validacion';
          v_adv := 'El CUIT de la contraparte no es válido';
        elsif (v_n0 + v_n25 + v_n5 + v_n105 + v_n21 + v_n27 <> 0 or v_i25 + v_i5 + v_i105 + v_i21 + v_i27 <> 0)
              and (abs((v_n0 + v_n25 + v_n5 + v_n105 + v_n21 + v_n27) - v_ng) > 1.00
                   or abs((v_i25 + v_i5 + v_i105 + v_i21 + v_i27) - v_iva) > 1.00) then
          v_estado := 'pendiente_validacion';
          v_adv := 'El desglose por alícuota no coincide con el neto gravado o el IVA total';
        elsif v_moneda <> 'PES' then
          v_estado := 'pendiente_validacion';
          v_adv := 'Moneda extranjera: verificá que los importes estén en pesos';
        end if;

        insert into public.comprobantes (tenant_id, client_id, batch_id, sentido, fecha, tipo_cbte, punto_venta, numero,
          doc_contraparte, contraparte, moneda, tipo_cambio, neto_gravado, neto_no_gravado, exento, iva, otros_tributos,
          total, nota_credito, estado_dato, advertencia,
          neto_0, neto_2_5, iva_2_5, neto_5, iva_5, neto_10_5, iva_10_5, neto_21, iva_21, neto_27, iva_27)
        values (p_tenant, p_client, v_lote,
          case when p_tipo = 'comprobantes_emitidos' then 'emitido' else 'recibido' end,
          v_fecha, v_tipo, v_pv, v_num, v_doc, v_nombre, v_moneda, v_tc,
          v_ng, v_nn, v_ex, v_iva, v_ot, v_tot, v_nc, v_estado, v_adv,
          v_n0, v_n25, v_i25, v_n5, v_i5, v_n105, v_i105, v_n21, v_i21, v_n27, v_i27)
        on conflict do nothing
        returning id into v_new;
      end if;

      if v_new is null then
        v_dup := v_dup + 1;
        if v_n < 300 then
          v_informe := v_informe || jsonb_build_object('fila', v_fila, 'tipo', 'duplicado', 'motivo', 'Ya existe en la base (duplicado)');
          v_n := v_n + 1;
        end if;
      else
        v_ok := v_ok + 1;
        if v_estado = 'pendiente_validacion' then v_pend := v_pend + 1; end if;
      end if;
    exception when others then
      v_rech := v_rech + 1;
      if v_n < 300 then
        v_informe := v_informe || jsonb_build_object('fila', v_fila, 'tipo', 'rechazo',
          'motivo', case when sqlstate = 'P0001' then sqlerrm else 'Dato con formato inválido' end);
        v_n := v_n + 1;
      end if;
    end;
  end loop;

  if v_ok = 0 then
    -- Nada que guardar: se deshace todo, incluido el lote
    raise exception 'Ninguna fila se pudo importar (% duplicadas, % rechazadas). No se guardó nada.', v_dup, v_rech
      using errcode = 'P0001';
  end if;

  update public.import_batches
     set filas_total = jsonb_array_length(p_filas) + jsonb_array_length(p_rechazos),
         filas_importadas = v_ok, filas_duplicadas = v_dup, filas_rechazadas = v_rech,
         filas_pendientes = v_pend, informe = v_informe
   where id = v_lote;

  return jsonb_build_object('lote_id', v_lote, 'importadas', v_ok, 'duplicadas', v_dup,
                            'rechazadas', v_rech, 'pendientes', v_pend);
end $$;
