-- Pruebas de la Fase 4: motor de tareas, reintentos, interrupciones, duplicados, agenda y aislamiento.
-- Siempre termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..." => todo correcto   |   "FALLO n: ..." => fallo la comprobacion n
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  uh uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  uo uuid := gen_random_uuid(); uc uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rc uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  lote uuid := gen_random_uuid();
  per text := to_char(date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') - interval '1 month', 'YYYY-MM');
  d1 date;
  t1 uuid; t2 uuid; t3 uuid; t5 uuid; t6 uuid; t7 uuid; t8 uuid;
  run uuid; run2 uuid; n int; n0 int; s text; x numeric; f date; ok text := '';
begin
  d1 := (per || '-10')::date;
  insert into auth.users (id, email, aud, role) values
    (uh,'h@t.local','authenticated','authenticated'), (ua,'a@t.local','authenticated','authenticated'),
    (ub,'b@t.local','authenticated','authenticated'), (uo,'o@t.local','authenticated','authenticated'),
    (uc,'c@t.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values
    (ra,ta,'Administrador',true),(ro,ta,'Asistente',false),(rc,ta,'Contador',false),(rb,tb,'Administrador',true);
  insert into public.role_permissions(role_id,permission_code) values
    (rc,'clientes.editar'),(rc,'importaciones.gestionar'),(rc,'tareas.gestionar');
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uo,ro),(ta,uc,rc),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social) values
    (ca,ta,'20111111112','Cliente A1'),(ca2,ta,'20333333334','Cliente A2'),(cb,tb,'20555555556','Cliente B1');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uo,ca),(ta,uc,ca);

  -- ===== 0. Planificador y calendario =====
  select count(*) into n from cron.job where jobname = 'syscar-motor-tareas' and schedule = '* * * * *';
  if n <> 1 then raise exception 'FALLO 1: no esta programado el ciclo del motor en pg_cron'; end if;
  if private.siguiente_ejecucion('mensual', 31, '09:00', 'America/Argentina/Buenos_Aires', timestamptz '2027-02-01 12:00+00') <> timestamptz '2027-02-28 12:00+00'
    then raise exception 'FALLO 2: mensual dia 31 en febrero'; end if;
  if private.siguiente_ejecucion('mensual', 5, '09:00', 'America/Argentina/Buenos_Aires', timestamptz '2027-03-06 12:00+00') <> timestamptz '2027-04-05 12:00+00'
    then raise exception 'FALLO 3: mensual dia 5'; end if;
  if private.siguiente_ejecucion('diaria', null, '09:00', 'America/Argentina/Buenos_Aires', timestamptz '2027-03-10 13:00+00') <> timestamptz '2027-03-11 12:00+00'
    then raise exception 'FALLO 4: diaria'; end if;
  if private.siguiente_ejecucion('semanal', 1, '09:00', 'America/Argentina/Buenos_Aires', timestamptz '2027-03-10 13:00+00') <> timestamptz '2027-03-15 12:00+00'
    then raise exception 'FALLO 5: semanal (lunes)'; end if;
  if private.siguiente_ejecucion('una_vez', null, '09:00', 'America/Argentina/Buenos_Aires', now()) is not null
    then raise exception 'FALLO 6: una_vez deberia ser nulo'; end if;
  ok := ok || '1-6 ';

  -- ===== Contador: alta de tareas y validaciones =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  t1 := public.crear_tarea(ta, ca, 'importaciones.control_carga', 'Control mensual de carga', 'mensual', 5, '09:00', 'ambas', 'mes_anterior', 2, 15);
  if not (select proxima_ejecucion > now() from public.task_definitions where id = t1) then
    raise exception 'FALLO 7: la tarea mensual no tiene proxima ejecucion futura'; end if;
  ok := ok || '7 ';

  begin
    perform public.crear_tarea(ta, ca, 'arca.importar_comprobantes', 'ARCA', 'mensual', 5, '09:00', 'ambas', 'mes_anterior', 2, 15);
    raise exception 'FALLO 8: se creo una tarea de una operacion no disponible';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    if sqlerrm not like '%todavía no está disponible%' then raise exception 'FALLO 8b: mensaje inesperado %', sqlerrm; end if;
    ok := ok || '8 ';
  end;
  begin
    perform public.crear_tarea(ta, ca, 'vencimientos.recordatorio', 'Sin titulo', 'manual', null, '09:00', 'manual', 'mes_anterior', 0, 5, '{"dia_limite":18}'::jsonb);
    raise exception 'FALLO 9: recordatorio sin titulo';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '9 ';
  end;
  begin
    perform public.crear_tarea(ta, ca, 'importaciones.control_carga', 'Incoherente', 'manual', null, '09:00', 'ambas', 'mes_anterior', 1, 5);
    raise exception 'FALLO 10: frecuencia manual con modo ambas';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '10 ';
  end;
  begin
    perform public.crear_tarea(ta, ca2, 'importaciones.control_carga', 'Cliente no asignado', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5);
    raise exception 'FALLO 11: creo tarea para un cliente no asignado';
  exception when insufficient_privilege then ok := ok || '11 ';
  end;

  -- ===== Ejecucion manual: sin datos => parcial + recordatorios (sin repetirse) =====
  run := public.lanzar_tarea(t1);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada_parcialmente' then raise exception 'FALLO 12: sin comprobantes la tarea quedo %', s; end if;
  select count(*) into n from public.agenda_items where client_id = ca and tipo = 'recordatorio' and estado = 'pendiente' and origen = 'tarea';
  if n <> 2 then raise exception 'FALLO 13: esperaba 2 recordatorios y hay %', n; end if;
  if (select iniciado_por from public.task_runs where id = run) <> uc then raise exception 'FALLO 14: no registro quien la inicio'; end if;
  run2 := public.lanzar_tarea(t1);
  select count(*) into n from public.agenda_items where client_id = ca and tipo = 'recordatorio' and estado = 'pendiente';
  if n <> 2 then raise exception 'FALLO 15: se duplicaron los recordatorios (%)', n; end if;
  ok := ok || '12-15 ';
  reset role;

  -- ===== Con comprobantes importados =====
  insert into public.import_batches(id,tenant_id,client_id,tipo,archivo_nombre,archivo_hash,estado,creado_por)
    values (lote, ta, ca, 'comprobantes_emitidos', 't.csv', repeat('e', 64), 'importado', uc);
  insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,neto_gravado,iva,total,estado_dato) values
    (ta, ca, lote, 'emitido', d1, 1, 1, 1, 1000, 210, 1210, 'importado'),
    (ta, ca, lote, 'recibido', d1, 1, 1, 1, 100, 21, 121, 'importado');

  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  run := public.lanzar_tarea(t1);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada' then raise exception 'FALLO 16: con comprobantes de ambos tipos esperaba completada y fue %', s; end if;

  t2 := public.crear_tarea(ta, ca, 'impuestos.control_iva', 'Control de IVA', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5);
  run := public.lanzar_tarea(t2);
  select estado, (resultado->>'posicion_estimada')::numeric into s, x from public.task_runs where id = run;
  if s <> 'completada_parcialmente' then raise exception 'FALLO 17: con datos sin confirmar esperaba parcial y fue %', s; end if;
  if x <> 189 then raise exception 'FALLO 18: posicion estimada % (esperaba 189)', x; end if;
  select count(*) into n from public.agenda_items where client_id = ca and tipo = 'control' and estado = 'pendiente';
  if n <> 1 then raise exception 'FALLO 19: alerta de IVA sin pago: hay % (esperaba 1)', n; end if;
  reset role;

  update public.comprobantes set estado_dato = 'confirmado' where client_id = ca;
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  run := public.lanzar_tarea(t2);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada' then raise exception 'FALLO 20: con todo confirmado esperaba completada y fue %', s; end if;
  select count(*) into n from public.agenda_items where client_id = ca and tipo = 'control';
  if n <> 1 then raise exception 'FALLO 21: se duplico la alerta de IVA (%)', n; end if;
  ok := ok || '16-21 ';

  -- ===== Recordatorio de vencimiento =====
  t3 := public.crear_tarea(ta, ca, 'vencimientos.recordatorio', 'Vencimiento IVA', 'manual', null, '09:00', 'manual', 'mes_anterior', 0, 5,
         '{"titulo":"Vencimiento IVA","dia_limite":18,"mes_offset":1}'::jsonb);
  run := public.lanzar_tarea(t3);
  select fecha_limite into f from public.agenda_items where client_id = ca and tipo = 'vencimiento';
  if f is distinct from (((per || '-01')::date + interval '1 month')::date + 17) then
    raise exception 'FALLO 22: fecha del vencimiento % (esperaba el 18 del mes siguiente a %)', f, per; end if;
  ok := ok || '22 ';
  reset role;

  -- ===== Error de configuracion: falla sin reintentos =====
  update public.task_definitions set parametros = '{}'::jsonb where id = t3;
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  run := public.lanzar_tarea(t3);
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'fallida' or n <> 1 then raise exception 'FALLO 23: config invalida => estado %, intento % (esperaba fallida en 1)', s, n; end if;
  ok := ok || '23 ';
  reset role;

  -- ===== Reintentos: falla simulada en la base =====
  create function public.test_falla() returns trigger language plpgsql as $f$ begin raise exception 'Fallo simulado de prueba'; end $f$;
  create trigger test_falla before insert on public.agenda_items for each row execute function public.test_falla();

  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  t5 := public.crear_tarea(ta, ca2, 'importaciones.control_carga', 'Falla simulada', 'manual', null, '09:00', 'manual', 'mes_anterior', 2, 10);
  run := public.lanzar_tarea(t5);
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'pendiente' or n <> 1 then raise exception 'FALLO 24: tras el primer fallo esperaba pendiente/intento 1 y fue %/%', s, n; end if;
  if not (select proximo_intento > now() from public.task_runs where id = run) then raise exception 'FALLO 25: no programo el reintento'; end if;
  begin
    perform public.lanzar_tarea(t5);
    raise exception 'FALLO 26: permitio una segunda ejecucion con una pendiente';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '24-26 ';
  end;
  reset role;

  update public.task_runs set proximo_intento = now() - interval '1 minute' where id = run;
  perform private.tick();
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'pendiente' or n <> 2 then raise exception 'FALLO 27: segundo intento => %/%', s, n; end if;
  update public.task_runs set proximo_intento = now() - interval '1 minute' where id = run;
  perform private.tick();
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'fallida' or n <> 3 then raise exception 'FALLO 28: agotados los intentos => %/% (esperaba fallida/3)', s, n; end if;
  if (select error from public.task_runs where id = run) not like '%Fallo simulado%' then raise exception 'FALLO 29: no conservo el error'; end if;
  select count(*) into n from public.task_run_events where run_id = run and nivel = 'error';
  if n < 1 then raise exception 'FALLO 30: no quedo el evento de error'; end if;
  select count(*) into n from public.task_run_events where run_id = run;
  if n < 6 then raise exception 'FALLO 31: historial de eventos incompleto (%)', n; end if;
  ok := ok || '27-31 ';

  -- Relanzar desde la interfaz (ya sin la falla)
  drop trigger test_falla on public.agenda_items;
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  run2 := public.relanzar_ejecucion(run);
  select estado into s from public.task_runs where id = run2;
  if s <> 'completada_parcialmente' then raise exception 'FALLO 32: relanzada quedo %', s; end if;
  if (select origen_run_id from public.task_runs where id = run2) <> run then raise exception 'FALLO 33: no vincula con la ejecucion original'; end if;
  if (select estado from public.task_runs where id = run) <> 'fallida' then raise exception 'FALLO 34: se altero el historial original'; end if;
  begin
    perform public.relanzar_ejecucion((select id from public.task_runs where estado = 'completada' and tenant_id = ta limit 1));
    raise exception 'FALLO 35: relanzo una ejecucion completada';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '32-35 ';
  end;
  reset role;

  -- ===== Cancelar =====
  create trigger test_falla before insert on public.agenda_items for each row execute function public.test_falla();
  update public.agenda_items set estado = 'hecho' where client_id = ca2;   -- para que el control vuelva a intentar crear el aviso
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  run := public.lanzar_tarea(t5);
  if (select estado from public.task_runs where id = run) <> 'pendiente' then raise exception 'FALLO 36: esperaba pendiente (reintento)'; end if;
  perform public.cancelar_ejecucion(run);
  if (select estado from public.task_runs where id = run) <> 'cancelada' then raise exception 'FALLO 37: no se cancelo'; end if;
  begin
    perform public.cancelar_ejecucion(run);
    raise exception 'FALLO 38: cancelo dos veces';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '36-38 ';
  end;
  reset role;
  drop trigger test_falla on public.agenda_items;

  -- ===== Interrupcion: reserva vencida =====
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  t6 := public.crear_tarea(ta, ca2, 'importaciones.control_carga', 'Interrupcion', 'manual', null, '09:00', 'manual', 'mes_anterior', 2, 10);
  reset role;
  insert into public.task_runs(tenant_id,task_id,client_id,estado,disparador,periodo,programada_para,intentos_max,intento,iniciado_en,lease_hasta)
    values (ta, t6, ca2, 'ejecutando', 'manual', per, now(), 3, 1, now() - interval '20 minutes', now() - interval '10 minutes')
    returning id into run;
  perform private.tick();
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'completada_parcialmente' or n <> 2 then raise exception 'FALLO 39: tras la interrupcion => %/% (esperaba reanudar y completar en el intento 2)', s, n; end if;
  select count(*) into n from public.task_run_events where run_id = run and mensaje ilike '%interrumpida%';
  if n < 1 then raise exception 'FALLO 40: la interrupcion no quedo en el historial'; end if;
  insert into public.task_runs(tenant_id,task_id,client_id,estado,disparador,periodo,programada_para,intentos_max,intento,iniciado_en,lease_hasta)
    values (ta, t6, ca2, 'ejecutando', 'manual', per, now(), 3, 3, now() - interval '20 minutes', now() - interval '10 minutes')
    returning id into run2;
  perform private.tick();
  select estado into s from public.task_runs where id = run2;
  if s <> 'fallida' then raise exception 'FALLO 41: interrumpida sin reintentos quedo %', s; end if;
  ok := ok || '39-41 ';

  -- ===== Planificacion automatica y duplicados =====
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  t7 := public.crear_tarea(ta, ca2, 'importaciones.control_carga', 'Automatica', 'mensual', 5, '09:00', 'automatica', 'mes_anterior', 1, 5);
  reset role;
  update public.task_definitions set proxima_ejecucion = now() - interval '1 hour' where id = t7;
  perform private.tick();
  select count(*) into n from public.task_runs where task_id = t7 and disparador = 'automatico';
  if n <> 1 then raise exception 'FALLO 42: esperaba 1 ejecucion automatica y hay %', n; end if;
  if (select estado from public.task_runs where task_id = t7) not in ('completada', 'completada_parcialmente') then raise exception 'FALLO 43: no proceso la ejecucion programada'; end if;
  if not (select proxima_ejecucion > now() from public.task_definitions where id = t7) then raise exception 'FALLO 44: no avanzo la proxima ejecucion'; end if;
  perform private.tick();
  select count(*) into n from public.task_runs where task_id = t7;
  if n <> 1 then raise exception 'FALLO 45: un segundo ciclo duplico la ejecucion (%)', n; end if;
  update public.task_definitions set proxima_ejecucion = (select programada_para from public.task_runs where task_id = t7) where id = t7;
  perform private.tick();
  select count(*) into n from public.task_runs where task_id = t7;
  if n <> 1 then raise exception 'FALLO 46: el mismo horario se ejecuto dos veces (%)', n; end if;
  ok := ok || '42-46 ';

  -- Caida larga del planificador: solo se ejecuta el horario mas reciente
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  t8 := public.crear_tarea(ta, ca2, 'importaciones.control_carga', 'Recuperacion', 'mensual', 5, '09:00', 'automatica', 'mes_anterior', 1, 5);
  reset role;
  update public.task_definitions set proxima_ejecucion = now() - interval '75 days' where id = t8;
  select count(*) into n0 from public.audit_log where objeto = 'task_definitions' and accion = 'UPDATE';
  perform private.tick();
  select count(*) into n from public.task_runs where task_id = t8 and estado <> 'cancelada';
  if n <> 1 then raise exception 'FALLO 47: tras la caida esperaba 1 ejecucion real y hay %', n; end if;
  select count(*) into n from public.task_runs where task_id = t8 and estado = 'cancelada' and error like 'Omitida: el planificador%';
  if n < 1 then raise exception 'FALLO 48: los horarios viejos no quedaron registrados como omitidos'; end if;
  if (select programada_para from public.task_runs where task_id = t8 and estado <> 'cancelada') <> (select max(programada_para) from public.task_runs where task_id = t8)
    then raise exception 'FALLO 49: no ejecuto el horario mas reciente'; end if;
  select count(*) into n from public.audit_log where objeto = 'task_definitions' and accion = 'UPDATE';
  if n <> n0 then raise exception 'FALLO 50: el ciclo del motor ensucia la auditoria (% nuevos)', n - n0; end if;
  ok := ok || '47-50 ';

  -- ===== Pausa y estudio suspendido =====
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  perform public.pausar_tarea(t7, false);
  reset role;
  update public.task_definitions set proxima_ejecucion = now() - interval '1 hour' where id = t7;
  delete from public.task_runs where false;
  select count(*) into n0 from public.task_runs where task_id = t7;
  perform private.tick();
  select count(*) into n from public.task_runs where task_id = t7;
  if n <> n0 then raise exception 'FALLO 51: una tarea pausada se programo'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  perform public.pausar_tarea(t7, true);
  if not (select proxima_ejecucion > now() from public.task_definitions where id = t7) then raise exception 'FALLO 52: al reanudar no recalculo la proxima ejecucion'; end if;
  reset role;
  ok := ok || '51-52 ';

  update public.task_definitions set proxima_ejecucion = now() - interval '1 hour' where id = t7;
  update public.tenants set estado = 'suspendido' where id = ta;
  select count(*) into n0 from public.task_runs where tenant_id = ta;
  perform private.tick();
  select count(*) into n from public.task_runs where tenant_id = ta;
  if n <> n0 then raise exception 'FALLO 53: se ejecutaron tareas de un estudio suspendido'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.lanzar_tarea(t7);
    raise exception 'FALLO 54: un estudio suspendido lanzo una tarea';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '53-54 ';
  end;
  reset role;
  update public.tenants set estado = 'activo' where id = ta;

  -- ===== Agenda y permisos =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  insert into public.agenda_items(tenant_id, client_id, tipo, titulo, fecha_limite, creado_por)
    values (ta, ca, 'otro', 'Reunión con el cliente', current_date + 3, uc);
  select count(*) into n from public.agenda_items where client_id = ca2;
  if n <> 0 then raise exception 'FALLO 55: el contador ve agenda de un cliente no asignado'; end if;
  update public.agenda_items set estado = 'hecho' where titulo = 'Reunión con el cliente';
  if (select resuelto_por from public.agenda_items where titulo = 'Reunión con el cliente') is distinct from uc then raise exception 'FALLO 56: no registro quien resolvio'; end if;
  begin
    update public.agenda_items set titulo = 'Cambiado' where titulo = 'Reunión con el cliente';
    raise exception 'FALLO 57: permitio cambiar el titulo';
  exception when insufficient_privilege then ok := ok || '55-57 ';
  end;
  begin
    insert into public.agenda_items(tenant_id, client_id, tipo, titulo, fecha_limite, creado_por, origen)
      values (ta, ca, 'otro', 'Falso de tarea', current_date, uc, 'tarea');
    raise exception 'FALLO 58: creo un item con origen tarea';
  exception when insufficient_privilege then ok := ok || '58 ';
  end;
  delete from public.agenda_items where client_id = ca and origen = 'tarea';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 59: borro items generados por tareas'; end if;
  delete from public.agenda_items where titulo = 'Reunión con el cliente';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO 60: no pudo borrar su item manual'; end if;
  begin
    insert into public.task_runs(tenant_id,task_id,client_id,disparador,intentos_max) values (ta, t1, ca, 'manual', 1);
    raise exception 'FALLO 61: escritura directa en ejecuciones';
  exception when insufficient_privilege then ok := ok || '59-61 ';
  end;
  begin
    update public.task_definitions set activa = false where id = t1;
    raise exception 'FALLO 62: escritura directa en tareas';
  exception when insufficient_privilege then ok := ok || '62 ';
  end;
  begin
    delete from public.task_runs;
    raise exception 'FALLO 63: borrado del historial';
  exception when insufficient_privilege then ok := ok || '63 ';
  end;
  begin
    delete from public.task_run_events;
    raise exception 'FALLO 64: borrado de eventos';
  exception when insufficient_privilege then ok := ok || '64 ';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.agenda_items(tenant_id, client_id, tipo, titulo, fecha_limite, creado_por)
      values (ta, ca, 'otro', 'Asistente no puede', current_date, uo);
    raise exception 'FALLO 65: asistente sin permiso creo agenda';
  exception when insufficient_privilege then ok := ok || '65 ';
  end;
  begin
    perform public.crear_tarea(ta, ca, 'importaciones.control_carga', 'No', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5);
    raise exception 'FALLO 66: asistente sin permiso creo una tarea';
  exception when insufficient_privilege then ok := ok || '66 ';
  end;
  begin
    perform public.lanzar_tarea(t1);
    raise exception 'FALLO 67: asistente sin permiso lanzo una tarea';
  exception when insufficient_privilege then ok := ok || '67 ';
  end;
  select count(*) into n from public.task_runs where client_id = ca; if n = 0 then raise exception 'FALLO 68: el asistente no ve el historial de su cliente'; end if;
  select count(*) into n from public.task_runs where client_id = ca2; if n <> 0 then raise exception 'FALLO 69: el asistente ve ejecuciones de un cliente no asignado'; end if;
  reset role;

  -- ===== Otro estudio, holding y anonimo =====
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.task_definitions; if n <> 0 then raise exception 'FALLO 70: B ve tareas de A'; end if;
  select count(*) into n from public.task_runs; if n <> 0 then raise exception 'FALLO 71: B ve ejecuciones de A'; end if;
  select count(*) into n from public.task_run_events; if n <> 0 then raise exception 'FALLO 72: B ve eventos de A'; end if;
  select count(*) into n from public.agenda_items; if n <> 0 then raise exception 'FALLO 73: B ve agenda de A'; end if;
  begin
    perform public.lanzar_tarea(t1);
    raise exception 'FALLO 74: B lanzo una tarea de A';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '74 ';
  end;
  begin
    perform public.crear_tarea(tb, ca, 'importaciones.control_carga', 'Cruzada', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5);
    raise exception 'FALLO 75: B creo una tarea sobre un cliente de A';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '75 ';
  end;
  ok := ok || '70-73 ';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.task_runs; if n <> 0 then raise exception 'FALLO 77: el holding lee ejecuciones'; end if;
  select count(*) into n from public.agenda_items; if n <> 0 then raise exception 'FALLO 78: el holding lee la agenda'; end if;
  select count(*) into n from public.task_operations; if n < 5 then raise exception 'FALLO 79: el catalogo de operaciones no es legible'; end if;
  reset role;
  set local role anon;
  begin
    perform count(*) from public.task_runs;
    raise exception 'FALLO 80: anonimo lee ejecuciones';
  exception when insufficient_privilege then ok := ok || '77-80 ';
  end;
  reset role;

  -- ===== Auditoria =====
  select count(*) into n from public.audit_log where tenant_id = ta and objeto = 'task_definitions' and accion = 'INSERT';
  if n < 5 then raise exception 'FALLO 81: la creacion de tareas no quedo auditada (%)', n; end if;
  select count(*) into n from public.audit_log where tenant_id = ta and accion = 'LANZAR_TAREA' and actor_id = uc;
  if n < 3 then raise exception 'FALLO 82: los lanzamientos manuales no quedaron auditados (%)', n; end if;
  select count(*) into n from public.audit_log where tenant_id = ta and accion = 'RELANZAR_EJECUCION' and actor_id = ua;
  if n <> 1 then raise exception 'FALLO 83: el relanzamiento no quedo auditado'; end if;
  select count(*) into n from public.audit_log where tenant_id = ta and accion = 'CANCELAR_EJECUCION' and actor_id = ua;
  if n <> 1 then raise exception 'FALLO 84: la cancelacion no quedo auditada'; end if;
  ok := ok || '81-84 ';

  raise exception 'PRUEBAS_OK: %', ok;
end $$;
