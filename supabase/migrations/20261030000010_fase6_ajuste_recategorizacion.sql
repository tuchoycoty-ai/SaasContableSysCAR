-- Fase 6 (ajuste): los avisos de recategorizacion usan el tipo de agenda 'recategorizacion' (ya existente) en vez de 'control'.
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
    v_creado := private.agenda_crear_si_falta(r, 'recategorizacion',
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


revoke execute on function private.h_recategorizacion(public.task_runs, public.task_definitions) from public, anon, authenticated;
