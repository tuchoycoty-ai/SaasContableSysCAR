-- Fase 4 (parte 2): motor de tareas.
--  * private.tick() corre cada minuto (pg_cron): recupera ejecuciones interrumpidas, programa las que vencieron
--    y procesa la cola. Cada ejecucion es atomica: si falla, se deshacen sus escrituras y queda el error.
--  * Un resultado solo es "completada" si la operacion lo valida; con datos incompletos queda "completada_parcialmente".
--  * Errores de configuracion (codigo SC001) no se reintentan; los demas si, segun lo configurado en la tarea.

create extension if not exists pg_cron;

-- El motor actualiza proxima/ultima ejecucion en cada ciclo: eso no se audita; los cambios de configuracion si.
drop trigger audit_task_definitions on public.task_definitions;
create trigger audit_task_definitions after insert or delete or
  update of activa, nombre, frecuencia, dia, hora, modo, periodo_regla, reintentos_max, reintento_intervalo_min, parametros
  on public.task_definitions for each row execute function private.audit_trigger();

-- ---------- Utilidades de calendario ----------
create or replace function private.siguiente_ejecucion(p_frec text, p_dia int, p_hora time, p_zona text, p_desde timestamptz)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp := p_desde at time zone p_zona;
  v_d date := v_local::date;
  v_c timestamp; v_mes date; v_ult int; i int;
begin
  if p_frec = 'diaria' then
    v_c := v_d + p_hora;
    if v_c <= v_local then v_c := v_c + interval '1 day'; end if;
    return v_c at time zone p_zona;
  elsif p_frec = 'semanal' then
    for i in 0..7 loop
      v_c := (v_d + i) + p_hora;
      if extract(isodow from v_c)::int = p_dia and v_c > v_local then return v_c at time zone p_zona; end if;
    end loop;
  elsif p_frec = 'mensual' then
    for i in 0..2 loop
      v_mes := (date_trunc('month', v_d::timestamp) + make_interval(months => i))::date;
      v_ult := extract(day from (v_mes + interval '1 month - 1 day'))::int;
      v_c := (v_mes + (least(p_dia, v_ult) - 1)) + p_hora;
      if v_c > v_local then return v_c at time zone p_zona; end if;
    end loop;
  end if;
  return null;
end $$;

create or replace function private.periodo_de(p_regla text, p_desde timestamptz, p_zona text)
returns text language sql stable set search_path = '' as $$
  select to_char(case when p_regla = 'mes_anterior'
                      then date_trunc('month', p_desde at time zone p_zona) - interval '1 month'
                      else date_trunc('month', p_desde at time zone p_zona) end, 'YYYY-MM')
$$;

create or replace function private.log_evento(p_run uuid, p_nivel text, p_mensaje text, p_detalle jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.task_run_events (tenant_id, client_id, run_id, nivel, mensaje, detalle)
  select tenant_id, client_id, id, p_nivel, p_mensaje, p_detalle from public.task_runs where id = p_run
$$;

-- Crea un item de agenda salvo que ya haya uno pendiente igual (evita repetir el mismo aviso cada vez)
create or replace function private.agenda_crear_si_falta(
  r public.task_runs, p_tipo text, p_titulo text, p_detalle text, p_fecha date, p_prioridad text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if exists (select 1 from public.agenda_items a
             where a.tenant_id = r.tenant_id and a.client_id = r.client_id and a.tipo = p_tipo
               and a.titulo = p_titulo and a.estado = 'pendiente') then
    return false;
  end if;
  insert into public.agenda_items (tenant_id, client_id, tipo, titulo, detalle, fecha_limite, prioridad, origen, run_id)
  values (r.tenant_id, r.client_id, p_tipo, p_titulo, p_detalle, p_fecha, p_prioridad, 'tarea', r.id)
  on conflict do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

-- ---------- Operaciones ----------
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
  if ne = 0 then faltan := faltan || 'emitidos'; end if;
  if nr = 0 then faltan := faltan || 'recibidos'; end if;
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

create or replace function private.h_recordatorio(r public.task_runs, t public.task_definitions)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tit text := nullif(trim(coalesce(t.parametros->>'titulo', '')), '');
  v_dia int; v_off int; v_pri text := coalesce(t.parametros->>'prioridad', 'media');
  v_base date; v_ult int; v_fecha date; v_creado boolean;
begin
  begin
    v_dia := (t.parametros->>'dia_limite')::int;
    v_off := coalesce((t.parametros->>'mes_offset')::int, 1);
  exception when others then
    raise exception 'Configuración inválida: dia_limite y mes_offset deben ser números' using errcode = 'SC001';
  end;
  if v_tit is null or v_dia is null or v_dia not between 1 and 31 or v_off not between 0 and 12 or v_pri not in ('baja', 'media', 'alta') then
    raise exception 'Configuración inválida del recordatorio (título, día límite entre 1 y 31, meses de desfase entre 0 y 12)' using errcode = 'SC001';
  end if;
  v_base := (date_trunc('month', (r.periodo || '-01')::timestamp) + make_interval(months => v_off))::date;
  v_ult := extract(day from (v_base + interval '1 month - 1 day'))::int;
  v_fecha := v_base + (least(v_dia, v_ult) - 1);
  v_creado := private.agenda_crear_si_falta(r, 'vencimiento', v_tit || ' ' || r.periodo,
    'Vencimiento configurado en la tarea "' || t.nombre || '".', v_fecha, v_pri);
  return jsonb_build_object('estado', 'completada',
    'mensaje', case when v_creado then 'Vencimiento cargado en la agenda para el ' || to_char(v_fecha, 'DD/MM/YYYY')
                    else 'El vencimiento ya estaba en la agenda' end,
    'datos', jsonb_build_object('periodo', r.periodo, 'fecha_limite', v_fecha, 'creado', v_creado));
end $$;

create or replace function private.h_control_iva(r public.task_runs, t public.task_definitions)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ini date := (r.periodo || '-01')::date;
  v_fin date := (v_ini + interval '1 month - 1 day')::date;
  v_hoy date := (now() at time zone t.zona)::date;
  deb numeric; cre numeric; n int; sinval int; pend int; pag numeric; npag int; pos numeric;
  v_estado text; v_msg text; v_alerta boolean := false;
begin
  select coalesce(sum(iva) filter (where sentido = 'emitido'), 0), coalesce(sum(iva) filter (where sentido = 'recibido'), 0),
         count(*), count(*) filter (where estado_dato <> 'confirmado'), count(*) filter (where estado_dato = 'pendiente_validacion')
    into deb, cre, n, sinval, pend
    from public.comprobantes where tenant_id = r.tenant_id and client_id = r.client_id and fecha between v_ini and v_fin;
  select coalesce(sum(importe), 0), count(*) into pag, npag
    from public.pagos where tenant_id = r.tenant_id and client_id = r.client_id and fecha > v_fin
      and (impuesto ilike 'iva%' or concepto ilike 'iva%');
  pos := deb - cre;
  if n = 0 then
    v_estado := 'completada_parcialmente';
    v_msg := 'No hay comprobantes importados del período ' || r.periodo || ': no se puede estimar el IVA';
  elsif sinval > 0 then
    v_estado := 'completada_parcialmente';
    v_msg := sinval || ' de ' || n || ' comprobantes todavía no están confirmados: el cálculo es provisorio';
  else
    v_estado := 'completada';
    v_msg := 'IVA estimado del período ' || r.periodo || ' calculado con comprobantes confirmados';
  end if;
  if n > 0 and pos > 0 and pag = 0 then
    v_alerta := private.agenda_crear_si_falta(r, 'control', 'IVA ' || r.periodo || ': posición estimada a pagar sin pago registrado',
      'Posición estimada: $' || round(pos, 2) || ' (débito $' || round(deb, 2) || ', crédito $' || round(cre, 2) ||
      '). No hay pagos de IVA importados posteriores al período. Es una estimación, no una liquidación.', v_hoy, 'alta');
  end if;
  return jsonb_build_object('estado', v_estado, 'mensaje', v_msg,
    'datos', jsonb_build_object('periodo', r.periodo, 'iva_debito', deb, 'iva_credito', cre, 'posicion_estimada', pos,
      'comprobantes', n, 'sin_confirmar', sinval, 'con_advertencia', pend,
      'pagos_iva_posteriores', pag, 'cantidad_pagos', npag, 'alerta_creada', v_alerta,
      'criterio_pagos', 'Pagos importados con fecha posterior al período cuyo impuesto o concepto empieza con "IVA"'));
end $$;

-- ---------- Ejecutar una ejecucion ----------
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

-- ---------- Ciclo del planificador ----------
create or replace function private.tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record; t public.task_definitions; v_next timestamptz; v_n int; v_id uuid; v_periodo text;
  v_rec int := 0; v_prog int := 0; v_proc int := 0;
begin
  -- 1. Ejecuciones interrumpidas (se vencio la reserva): se reanudan o se marcan como fallidas, sin borrar nada
  for r in select * from public.task_runs
           where estado = 'ejecutando' and lease_hasta is not null and lease_hasta < now()
           order by creado_en for update skip locked loop
    if r.intento < r.intentos_max then
      update public.task_runs set estado = 'pendiente', proximo_intento = now(), lease_hasta = null,
             error = 'Interrumpida: venció la reserva de ejecución' where id = r.id;
      perform private.log_evento(r.id, 'aviso', 'Ejecución interrumpida; se reanuda en este ciclo');
    else
      update public.task_runs set estado = 'fallida', finalizado_en = now(), lease_hasta = null,
             error = 'Interrumpida y sin reintentos disponibles' where id = r.id;
      perform private.log_evento(r.id, 'error', 'Interrumpida y sin reintentos disponibles');
    end if;
    v_rec := v_rec + 1;
  end loop;

  -- 2. Tareas automaticas vencidas: se crea una ejecucion por cada horario pendiente (maximo 12 si hubo una caida larga)
  for t in select * from public.task_definitions
           where activa and modo in ('automatica', 'ambas') and proxima_ejecucion is not null and proxima_ejecucion <= now()
           order by proxima_ejecucion for update skip locked loop
    v_next := t.proxima_ejecucion;
    v_n := 0;
    while v_next is not null and v_next <= now() and v_n < 12 loop
      v_periodo := private.periodo_de(t.periodo_regla, v_next, t.zona);
      v_id := null;
      insert into public.task_runs (tenant_id, task_id, client_id, estado, disparador, periodo, programada_para, intentos_max)
      values (t.tenant_id, t.id, t.client_id, 'pendiente', 'automatico', v_periodo, v_next, t.reintentos_max + 1)
      on conflict do nothing returning id into v_id;
      if v_id is null then
        insert into public.task_runs (tenant_id, task_id, client_id, estado, disparador, periodo, programada_para, intentos_max, finalizado_en, error)
        values (t.tenant_id, t.id, t.client_id, 'cancelada', 'automatico', v_periodo, v_next, t.reintentos_max + 1, now(),
                'Omitida: ya había una ejecución en curso o pendiente de esta tarea')
        on conflict do nothing returning id into v_id;
        if v_id is not null then
          perform private.log_evento(v_id, 'aviso', 'Horario omitido para no duplicar la ejecución en curso');
        end if;
      else
        perform private.log_evento(v_id, 'info', 'Programada automáticamente para el período ' || v_periodo);
      end if;
      v_next := private.siguiente_ejecucion(t.frecuencia, t.dia, t.hora, t.zona, v_next);
      v_n := v_n + 1;
    end loop;
    if v_next is not null and v_next <= now() then
      v_next := private.siguiente_ejecucion(t.frecuencia, t.dia, t.hora, t.zona, now());
    end if;
    update public.task_definitions set proxima_ejecucion = v_next where id = t.id;
    v_prog := v_prog + 1;
  end loop;

  -- 3. Cola de ejecuciones pendientes
  for r in select id from public.task_runs
           where estado = 'pendiente' and (proximo_intento is null or proximo_intento <= now())
           order by programada_para limit 20 for update skip locked loop
    perform private.ejecutar_run(r.id);
    v_proc := v_proc + 1;
  end loop;

  return jsonb_build_object('recuperadas', v_rec, 'programadas', v_prog, 'procesadas', v_proc);
end $$;

-- ---------- Acciones del usuario ----------
create or replace function private.crear_tarea(
  p_tenant uuid, p_client uuid, p_operacion text, p_nombre text, p_frecuencia text, p_dia int, p_hora time,
  p_modo text, p_periodo_regla text, p_reintentos int, p_intervalo int, p_parametros jsonb, p_primera timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  op public.task_operations; v_prox timestamptz; v_id uuid; v_dia int;
  v_zona text := 'America/Argentina/Buenos_Aires';
begin
  if v_uid is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not (private.has_permission(p_tenant, 'tareas.gestionar') and private.can_see_client(p_tenant, p_client)
          and exists (select 1 from public.clients c where c.id = p_client and c.tenant_id = p_tenant)) then
    raise exception 'No tenés permiso para crear tareas para este cliente' using errcode = '42501';
  end if;
  select * into op from public.task_operations where codigo = p_operacion;
  if not found then raise exception 'Operación desconocida' using errcode = 'P0001'; end if;
  if not op.disponible then
    raise exception 'Esta operación todavía no está disponible. %', coalesce(op.nota, '') using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_parametros, '{}'::jsonb)) <> 'object' then
    raise exception 'Parámetros inválidos' using errcode = 'P0001';
  end if;
  if p_operacion = 'vencimientos.recordatorio' then
    begin v_dia := (p_parametros->>'dia_limite')::int; exception when others then v_dia := null; end;
    if nullif(trim(coalesce(p_parametros->>'titulo', '')), '') is null or v_dia is null or v_dia not between 1 and 31 then
      raise exception 'Indicá el título del vencimiento y el día límite (1 a 31)' using errcode = 'P0001';
    end if;
  end if;
  if p_modo = 'manual' then
    v_prox := null;
  elsif p_frecuencia = 'una_vez' then
    if p_primera is null or p_primera <= now() then
      raise exception 'Indicá una fecha y hora futuras para la ejecución' using errcode = 'P0001';
    end if;
    v_prox := p_primera;
  else
    v_prox := private.siguiente_ejecucion(p_frecuencia, p_dia, p_hora, v_zona, now());
  end if;
  insert into public.task_definitions (tenant_id, client_id, operacion, nombre, frecuencia, dia, hora, zona, modo, periodo_regla,
                                       reintentos_max, reintento_intervalo_min, parametros, proxima_ejecucion, creado_por)
  values (p_tenant, p_client, p_operacion, trim(p_nombre), p_frecuencia, p_dia, p_hora, v_zona, p_modo, p_periodo_regla,
          p_reintentos, p_intervalo, coalesce(p_parametros, '{}'::jsonb), v_prox, v_uid)
  returning id into v_id;
  return v_id;
exception when check_violation then
  raise exception 'Revisá la configuración de la tarea (nombre, frecuencia, día, modo y reintentos)' using errcode = 'P0001';
end $$;

create or replace function private.lanzar_tarea(p_task uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t public.task_definitions; v_run uuid; v_uid uuid := (select auth.uid());
begin
  select * into t from public.task_definitions where id = p_task;
  if not found or not private.can_see_client(t.tenant_id, t.client_id) then
    raise exception 'Tarea no encontrada' using errcode = 'P0001';
  end if;
  if not private.has_permission(t.tenant_id, 'tareas.gestionar') then
    raise exception 'No tenés permiso para ejecutar tareas' using errcode = '42501';
  end if;
  if t.modo = 'automatica' then raise exception 'Esta tarea es solo automática' using errcode = 'P0001'; end if;
  if not t.activa then raise exception 'La tarea está pausada' using errcode = 'P0001'; end if;
  begin
    insert into public.task_runs (tenant_id, task_id, client_id, estado, disparador, iniciado_por, periodo, programada_para, intentos_max)
    values (t.tenant_id, t.id, t.client_id, 'pendiente', 'manual', v_uid, private.periodo_de(t.periodo_regla, now(), t.zona), now(), t.reintentos_max + 1)
    returning id into v_run;
  exception when unique_violation then
    raise exception 'Ya hay una ejecución en curso o pendiente de esta tarea. Esperá a que termine o cancelala.' using errcode = 'P0001';
  end;
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (t.tenant_id, v_uid, 'LANZAR_TAREA', 'task_runs', 'ok', jsonb_build_object('tarea', t.id, 'ejecucion', v_run, 'operacion', t.operacion));
  perform private.log_evento(v_run, 'info', 'Lanzada manualmente');
  perform private.ejecutar_run(v_run);
  return v_run;
end $$;

create or replace function private.relanzar_ejecucion(p_run uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.task_runs; t public.task_definitions; v_new uuid; v_uid uuid := (select auth.uid());
begin
  select * into r from public.task_runs where id = p_run;
  if not found or not private.can_see_client(r.tenant_id, r.client_id) then
    raise exception 'Ejecución no encontrada' using errcode = 'P0001';
  end if;
  if not private.has_permission(r.tenant_id, 'tareas.gestionar') then
    raise exception 'No tenés permiso para relanzar tareas' using errcode = '42501';
  end if;
  if r.estado not in ('fallida', 'completada_parcialmente', 'cancelada') then
    raise exception 'Solo se pueden relanzar ejecuciones fallidas, parciales o canceladas' using errcode = 'P0001';
  end if;
  select * into t from public.task_definitions where id = r.task_id;
  if not t.activa then raise exception 'La tarea está pausada' using errcode = 'P0001'; end if;
  begin
    insert into public.task_runs (tenant_id, task_id, client_id, estado, disparador, iniciado_por, origen_run_id, periodo, programada_para, intentos_max)
    values (r.tenant_id, r.task_id, r.client_id, 'pendiente', 'manual', v_uid, r.id, r.periodo, now(), t.reintentos_max + 1)
    returning id into v_new;
  exception when unique_violation then
    raise exception 'Ya hay una ejecución en curso o pendiente de esta tarea. Esperá a que termine o cancelala.' using errcode = 'P0001';
  end;
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (r.tenant_id, v_uid, 'RELANZAR_EJECUCION', 'task_runs', 'ok', jsonb_build_object('tarea', r.task_id, 'origen', r.id, 'ejecucion', v_new));
  perform private.log_evento(v_new, 'info', 'Relanzada manualmente a partir de la ejecución ' || r.id);
  perform private.ejecutar_run(v_new);
  return v_new;
end $$;

create or replace function private.cancelar_ejecucion(p_run uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.task_runs; v_uid uuid := (select auth.uid());
begin
  select * into r from public.task_runs where id = p_run;
  if not found or not private.can_see_client(r.tenant_id, r.client_id) then
    raise exception 'Ejecución no encontrada' using errcode = 'P0001';
  end if;
  if not private.has_permission(r.tenant_id, 'tareas.gestionar') then
    raise exception 'No tenés permiso para cancelar ejecuciones' using errcode = '42501';
  end if;
  if r.estado not in ('pendiente', 'ejecutando') then
    raise exception 'Solo se pueden cancelar ejecuciones pendientes o en curso' using errcode = 'P0001';
  end if;
  update public.task_runs set estado = 'cancelada', finalizado_en = now(), lease_hasta = null, proximo_intento = null,
         error = 'Cancelada manualmente' where id = p_run;
  perform private.log_evento(p_run, 'aviso', 'Cancelada manualmente');
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (r.tenant_id, v_uid, 'CANCELAR_EJECUCION', 'task_runs', 'ok', jsonb_build_object('tarea', r.task_id, 'ejecucion', r.id, 'estado_previo', r.estado));
end $$;

create or replace function private.pausar_tarea(p_task uuid, p_activa boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.task_definitions;
begin
  select * into t from public.task_definitions where id = p_task;
  if not found or not private.can_see_client(t.tenant_id, t.client_id) then
    raise exception 'Tarea no encontrada' using errcode = 'P0001';
  end if;
  if not private.has_permission(t.tenant_id, 'tareas.gestionar') then
    raise exception 'No tenés permiso para modificar tareas' using errcode = '42501';
  end if;
  update public.task_definitions
     set activa = p_activa,
         proxima_ejecucion = case
           when not p_activa then proxima_ejecucion
           when modo = 'manual' then null
           when frecuencia = 'una_vez' then case when proxima_ejecucion > now() then proxima_ejecucion else null end
           else private.siguiente_ejecucion(frecuencia, dia, hora, zona, now()) end
   where id = p_task;
end $$;

-- ---------- Funciones expuestas por la API (con los permisos de quien llama) ----------
create or replace function public.crear_tarea(
  p_tenant uuid, p_client uuid, p_operacion text, p_nombre text, p_frecuencia text, p_dia int, p_hora time,
  p_modo text, p_periodo_regla text, p_reintentos int, p_intervalo int, p_parametros jsonb default '{}'::jsonb,
  p_primera timestamptz default null)
returns uuid language sql set search_path = '' as $$
  select private.crear_tarea(p_tenant, p_client, p_operacion, p_nombre, p_frecuencia, p_dia, p_hora, p_modo,
                             p_periodo_regla, p_reintentos, p_intervalo, p_parametros, p_primera)
$$;
create or replace function public.lanzar_tarea(p_task uuid) returns uuid
language sql set search_path = '' as $$ select private.lanzar_tarea(p_task) $$;
create or replace function public.relanzar_ejecucion(p_run uuid) returns uuid
language sql set search_path = '' as $$ select private.relanzar_ejecucion(p_run) $$;
create or replace function public.cancelar_ejecucion(p_run uuid) returns void
language sql set search_path = '' as $$ select private.cancelar_ejecucion(p_run) $$;
create or replace function public.pausar_tarea(p_task uuid, p_activa boolean) returns void
language sql set search_path = '' as $$ select private.pausar_tarea(p_task, p_activa) $$;

-- ---------- Permisos de ejecucion ----------
revoke execute on function
  private.siguiente_ejecucion(text, int, time, text, timestamptz), private.periodo_de(text, timestamptz, text),
  private.log_evento(uuid, text, text, jsonb), private.agenda_crear_si_falta(public.task_runs, text, text, text, date, text),
  private.h_control_carga(public.task_runs, public.task_definitions), private.h_recordatorio(public.task_runs, public.task_definitions),
  private.h_control_iva(public.task_runs, public.task_definitions), private.ejecutar_run(uuid), private.tick(),
  private.crear_tarea(uuid, uuid, text, text, text, int, time, text, text, int, int, jsonb, timestamptz),
  private.lanzar_tarea(uuid), private.relanzar_ejecucion(uuid), private.cancelar_ejecucion(uuid), private.pausar_tarea(uuid, boolean)
  from public, anon, authenticated;
grant execute on function
  private.crear_tarea(uuid, uuid, text, text, text, int, time, text, text, int, int, jsonb, timestamptz),
  private.lanzar_tarea(uuid), private.relanzar_ejecucion(uuid), private.cancelar_ejecucion(uuid), private.pausar_tarea(uuid, boolean)
  to authenticated;
revoke execute on function
  public.crear_tarea(uuid, uuid, text, text, text, int, time, text, text, int, int, jsonb, timestamptz),
  public.lanzar_tarea(uuid), public.relanzar_ejecucion(uuid), public.cancelar_ejecucion(uuid), public.pausar_tarea(uuid, boolean)
  from public, anon;
grant execute on function
  public.crear_tarea(uuid, uuid, text, text, text, int, time, text, text, int, int, jsonb, timestamptz),
  public.lanzar_tarea(uuid), public.relanzar_ejecucion(uuid), public.cancelar_ejecucion(uuid), public.pausar_tarea(uuid, boolean)
  to authenticated;

-- ---------- Planificador: una vez por minuto ----------
select cron.schedule('syscar-motor-tareas', '* * * * *', 'select private.tick()');
