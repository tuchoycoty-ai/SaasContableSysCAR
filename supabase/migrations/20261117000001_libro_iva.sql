-- Libro de IVA: desglose del neto gravado y del IVA por alícuota en cada comprobante.
-- Las columnas vienen de los archivos de ARCA («Mis Comprobantes»). En los comprobantes ya cargados
-- (que solo tenían el total) se completa solo lo que se puede deducir sin dudas: un comprobante de una única alícuota.
alter table public.comprobantes
  add column neto_0 numeric(16,2) not null default 0,
  add column neto_2_5 numeric(16,2) not null default 0,
  add column iva_2_5 numeric(16,2) not null default 0,
  add column neto_5 numeric(16,2) not null default 0,
  add column iva_5 numeric(16,2) not null default 0,
  add column neto_10_5 numeric(16,2) not null default 0,
  add column iva_10_5 numeric(16,2) not null default 0,
  add column neto_21 numeric(16,2) not null default 0,
  add column iva_21 numeric(16,2) not null default 0,
  add column neto_27 numeric(16,2) not null default 0,
  add column iva_27 numeric(16,2) not null default 0;

create or replace function private.importe_firmado(p_fila jsonb, p_clave text, p_signo int)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  v := abs(coalesce(nullif(p_fila->>p_clave, '')::numeric, 0));
  if v >= 1e13 then raise exception 'Importe fuera de rango' using errcode = 'P0001'; end if;
  return v * p_signo;
end $$;
revoke execute on function private.importe_firmado(jsonb, text, int) from public, anon;
grant execute on function private.importe_firmado(jsonb, text, int) to authenticated;

-- Completa los comprobantes anteriores cuando el IVA coincide (±0,05) con una sola alícuota.
update public.comprobantes c set
  neto_21 = case when t.r = 21 then c.neto_gravado else 0 end, iva_21 = case when t.r = 21 then c.iva else 0 end,
  neto_10_5 = case when t.r = 10.5 then c.neto_gravado else 0 end, iva_10_5 = case when t.r = 10.5 then c.iva else 0 end,
  neto_27 = case when t.r = 27 then c.neto_gravado else 0 end, iva_27 = case when t.r = 27 then c.iva else 0 end,
  neto_5 = case when t.r = 5 then c.neto_gravado else 0 end, iva_5 = case when t.r = 5 then c.iva else 0 end,
  neto_2_5 = case when t.r = 2.5 then c.neto_gravado else 0 end, iva_2_5 = case when t.r = 2.5 then c.iva else 0 end,
  neto_0 = case when t.r = 0 then c.neto_gravado else 0 end
from (
  select distinct on (c2.id) c2.id, r.r from public.comprobantes c2
  join (values (21::numeric), (10.5), (27), (5), (2.5), (0)) as r(r)
    on abs(c2.iva - round(c2.neto_gravado * r.r / 100, 2)) <= 0.05
  where abs(c2.neto_gravado) >= 10
  order by c2.id, abs(c2.iva - round(c2.neto_gravado * r.r / 100, 2))
) t
where t.id = c.id and (c.neto_gravado <> 0 or c.iva <> 0);

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
        insert into public.pagos (tenant_id, client_id, batch_id, fecha, concepto, impuesto, medio, referencia, importe, estado_dato, advertencia)
        values (p_tenant, p_client, v_lote, v_fecha, left(v_conc, 200),
                left(nullif(trim(coalesce(v_f->>'impuesto', '')), ''), 100),
                left(nullif(trim(coalesce(v_f->>'medio', '')), ''), 100),
                left(v_ref, 100), v_imp, 'importado', null)
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
