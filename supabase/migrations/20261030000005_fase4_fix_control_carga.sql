-- Corrección detectada por las pruebas: al armar la lista de comprobantes faltantes,
-- `text[] || 'texto'` se interpretaba como un arreglo mal formado. Se usa array_append.
create or replace function private.h_control_carga(r public.task_runs, t public.task_definitions)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ini date := (r.periodo || '-01')::date;
  v_fin date := (v_ini + interval '1 month - 1 day')::date;
  v_hoy date := (now() at time zone t.zona)::date;
  ne int; nr int; faltan text[] := '{}'; f text; v_creados int := 0;
begin
  select count(*) filter (where sentido = 'emitido'), count(*) filter (where sentido = 'recibido') into ne, nr
    from public.comprobantes where tenant_id = r.tenant_id and client_id = r.client_id and fecha between v_ini and v_fin;
  if ne = 0 then faltan := array_append(faltan, 'emitidos'); end if;
  if nr = 0 then faltan := array_append(faltan, 'recibidos'); end if;
  foreach f in array faltan loop
    if private.agenda_crear_si_falta(r, 'recordatorio', 'Importar comprobantes ' || f || ' de ' || r.periodo,
         'No hay comprobantes ' || f || ' importados con fecha en ' || r.periodo || '. Cargá el archivo desde Importar.', v_hoy, 'alta') then
      v_creados := v_creados + 1;
    end if;
  end loop;
  return jsonb_build_object(
    'estado', case when cardinality(faltan) = 0 then 'completada' else 'completada_parcialmente' end,
    'mensaje', case when cardinality(faltan) = 0 then 'Hay comprobantes emitidos y recibidos del período ' || r.periodo
                    else 'Faltan comprobantes ' || array_to_string(faltan, ' y ') || ' del período ' || r.periodo end,
    'datos', jsonb_build_object('periodo', r.periodo, 'emitidos', ne, 'recibidos', nr, 'faltan', to_jsonb(faltan), 'recordatorios_creados', v_creados));
end $$;
