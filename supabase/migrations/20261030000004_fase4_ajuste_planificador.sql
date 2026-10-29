-- Fase 4 (ajuste): el planificador no ejecuta tareas de estudios suspendidos y, tras una caida larga,
-- ejecuta solo el horario mas reciente (los anteriores quedan registrados como omitidos).

create or replace function private.tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record; t public.task_definitions; v_next timestamptz; v_sig timestamptz; v_n int; v_id uuid; v_periodo text;
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
             and exists (select 1 from public.tenants te where te.id = task_definitions.tenant_id and te.estado = 'activo')
           order by proxima_ejecucion for update skip locked loop
    v_next := t.proxima_ejecucion;
    v_n := 0;
    while v_next is not null and v_next <= now() and v_n < 12 loop
      v_periodo := private.periodo_de(t.periodo_regla, v_next, t.zona);
      v_id := null;
      v_sig := private.siguiente_ejecucion(t.frecuencia, t.dia, t.hora, t.zona, v_next);
      if v_sig is not null and v_sig <= now() and v_n < 11 then
        -- Hay un horario posterior ya vencido (el planificador estuvo detenido): se ejecuta solo el mas reciente
        insert into public.task_runs (tenant_id, task_id, client_id, estado, disparador, periodo, programada_para, intentos_max, finalizado_en, error)
        values (t.tenant_id, t.id, t.client_id, 'cancelada', 'automatico', v_periodo, v_next, t.reintentos_max + 1, now(),
                'Omitida: el planificador estuvo detenido y hay un horario más reciente')
        on conflict do nothing returning id into v_id;
        if v_id is not null then
          perform private.log_evento(v_id, 'aviso', 'Horario omitido por interrupción del planificador');
        end if;
        v_next := v_sig;
        v_n := v_n + 1;
        continue;
      end if;
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
             and exists (select 1 from public.tenants te where te.id = task_runs.tenant_id and te.estado = 'activo')
           order by programada_para limit 20 for update skip locked loop
    perform private.ejecutar_run(r.id);
    v_proc := v_proc + 1;
  end loop;

  return jsonb_build_object('recuperadas', v_rec, 'programadas', v_prog, 'procesadas', v_proc);
end $$;
