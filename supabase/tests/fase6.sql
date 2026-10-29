-- Pruebas de la Fase 6: obligaciones (DDJJ/VEP), calendario de vencimientos, recategorizacion de monotributo y operaciones del motor.
-- Siempre termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..." => todo correcto   |   "FALLO n: ..." => fallo la comprobacion n
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  uh uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  uc uuid := gen_random_uuid(); uo uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); rc uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  cm uuid := gen_random_uuid(); cr uuid := gen_random_uuid(); ce uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  lote uuid := gen_random_uuid(); mes0 date := date_trunc('month', current_date)::date;
  hoy_mes text := to_char(date_trunc('month', current_date), 'YYYY-MM');
  i int; n int; s text; x numeric; j jsonb; ob uuid; t1 uuid; t2 uuid; t3 uuid; t4 uuid; run uuid; f date; ok text := '';
begin
  insert into auth.users (id, email, aud, role) values
    (uh,'h@t.local','authenticated','authenticated'), (ua,'a@t.local','authenticated','authenticated'),
    (ub,'b@t.local','authenticated','authenticated'), (uc,'c@t.local','authenticated','authenticated'),
    (uo,'o@t.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values
    (ra,ta,'Administrador',true),(rc,ta,'Contador',false),(ro,ta,'Asistente',false),(rb,tb,'Administrador',true);
  insert into public.role_permissions(role_id,permission_code) values
    (rc,'obligaciones.gestionar'),(rc,'tareas.gestionar'),(rc,'clientes.editar');
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uc,rc),(ta,uo,ro),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social,regimen,categoria_monotributo) values
    (cm,ta,'20111111112','Monotributista A','monotributo','B'),
    (cr,ta,'20333333334','Resp. Inscripto A','responsable_inscripto',null),
    (ce,ta,'20555555556','Exento A','exento',null),
    (cb,tb,'27251389247','Cliente B','monotributo','C');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uc,cm),(ta,uc,cr),(ta,uo,ce);

  -- ===== 1. Catalogos y calendario =====
  if (select count(*) from public.obligacion_tipos) < 3 then raise exception 'FALLO 1: faltan tipos de obligacion'; end if;
  if (select count(*) from public.monotributo_escalas where vigente_desde = '2026-08-01') <> 11 then raise exception 'FALLO 2: la escala de monotributo no tiene las 11 categorias'; end if;
  for i in 0..9 loop
    insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente)
    values ('iva_ddjj', '2099-01', i, date '2099-02-18' + (i / 2), 'prueba');
  end loop;
  if public.vencimiento_de('iva_ddjj', '2099-01', '20000000007') <> date '2099-02-21' then raise exception 'FALLO 3: vencimiento por terminacion 7'; end if;
  if public.vencimiento_de('iva_ddjj', '2099-01', '20000000010') <> date '2099-02-18' then raise exception 'FALLO 4: vencimiento por terminacion 0'; end if;
  if public.vencimiento_de('iva_ddjj', '2098-01', '20000000007') is not null then raise exception 'FALLO 5: debe ser nulo si el calendario no lo tiene'; end if;
  begin
    insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente) values ('iva_ddjj', '2099-01', 3, date '2099-02-01', 'dup');
    raise exception 'FALLO 6: se permitio un vencimiento duplicado';
  exception when unique_violation then null; end;
  begin
    insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente) values ('iva_ddjj', '2099-03', 10, date '2099-02-01', 'x');
    raise exception 'FALLO 7: se acepto una terminacion invalida';
  exception when check_violation then null; end;
  ok := ok || '1-7 ';

  -- ===== 2. Catalogos: solo el holding escribe =====
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  if (select count(*) from public.vencimientos_calendario where periodo = '2099-01') <> 10 then raise exception 'FALLO 8: un admin de estudio no ve el calendario'; end if;
  begin
    insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente) values ('iva_ddjj', '2099-05', 1, date '2099-06-01', 'x');
    raise exception 'FALLO 9: un admin de estudio pudo cargar un vencimiento global';
  exception when insufficient_privilege then null; end;
  update public.monotributo_escalas set ingresos_max = 1 where categoria = 'A';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 10: un admin de estudio pudo modificar la escala de monotributo'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente) values ('iva_ddjj', '2099-05', 1, date '2099-06-01', 'holding');
  reset role;
  set local role anon;
  begin perform 1 from public.vencimientos_calendario limit 1; raise exception 'FALLO 11: anon ve el calendario';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.obligaciones_cliente limit 1; raise exception 'FALLO 12: anon ve obligaciones';
  exception when insufficient_privilege then null; end;
  reset role;
  ok := ok || '8-12 ';

  -- ===== 3. Generacion de obligaciones segun regimen y permisos =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  n := public.generar_obligaciones(ta, '2099-01');
  if n <> 2 then raise exception 'FALLO 13: esperaba 2 obligaciones (monotributo + IVA) y se crearon %', n; end if;
  if (select count(*) from public.obligaciones_cliente where client_id = cm and obligacion_codigo = 'monotributo_cuota') <> 1
     or (select count(*) from public.obligaciones_cliente where client_id = cr and obligacion_codigo = 'iva_ddjj') <> 1
    then raise exception 'FALLO 14: obligaciones mal asignadas por regimen'; end if;
  if public.generar_obligaciones(ta, '2099-01') <> 0 then raise exception 'FALLO 15: generar no es idempotente'; end if;
  if (select count(*) from public.obligaciones_cliente) <> 2 then raise exception 'FALLO 16: el contador ve obligaciones de clientes no asignados'; end if;
  ok := ok || '13-16 ';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  begin perform public.generar_obligaciones(ta, '2099-02'); raise exception 'FALLO 17: un usuario sin permiso genero obligaciones';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.obligaciones_cliente) <> 0 then raise exception 'FALLO 18: el asistente ve obligaciones de clientes no asignados'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  if (select count(*) from public.obligaciones_cliente) <> 0 then raise exception 'FALLO 19: el estudio B ve obligaciones del A'; end if;
  begin perform public.generar_obligaciones(ta, '2099-02'); raise exception 'FALLO 20: el estudio B genero obligaciones en el A';
  exception when insufficient_privilege then null; end;
  reset role;
  ok := ok || '17-20 ';

  -- ===== 4. Seguimiento de DDJJ y VEP =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  select id into ob from public.obligaciones_cliente where client_id = cr and periodo = '2099-01';
  begin
    update public.obligaciones_cliente set estado = 'pagada' where id = ob;
    raise exception 'FALLO 21: se marco pagada sin fecha de pago';
  exception when check_violation then null; end;
  update public.obligaciones_cliente set estado = 'presentada', presentada_en = date '2099-02-10', monto = 12345.60,
         vep_numero = '123456789', vep_monto = 12345.60, vep_vence = date '2099-02-20' where id = ob;
  update public.obligaciones_cliente set estado = 'pagada', pagada_en = date '2099-02-15' where id = ob;
  if (select estado from public.obligaciones_cliente where id = ob) <> 'pagada' then raise exception 'FALLO 22: no se actualizo el estado'; end if;
  if (select actualizado_por from public.obligaciones_cliente where id = ob) <> uc then raise exception 'FALLO 23: no registro quien actualizo'; end if;
  begin
    update public.obligaciones_cliente set tenant_id = tb where id = ob;
    raise exception 'FALLO 24: se pudo cambiar el estudio de una obligacion';
  exception when insufficient_privilege then null; end;
  insert into public.obligaciones_cliente(tenant_id, client_id, obligacion_codigo, periodo, creado_por) values (ta, cr, 'f931', '2099-01', uc);
  begin
    insert into public.obligaciones_cliente(tenant_id, client_id, obligacion_codigo, periodo, creado_por) values (ta, ce, 'f931', '2099-01', uc);
    raise exception 'FALLO 25: cargo una obligacion de un cliente no asignado';
  exception when insufficient_privilege then null; end;
  delete from public.obligaciones_cliente where id = ob;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 26: un contador (no admin) pudo borrar una obligacion'; end if;
  reset role;
  ok := ok || '21-26 ';

  -- ===== 5. Recategorizacion de monotributo =====
  insert into public.import_batches(id,tenant_id,client_id,tipo,archivo_nombre,archivo_hash,estado,creado_por)
    values (lote, ta, cm, 'comprobantes_emitidos', 't.csv', repeat('f', 64), 'importado', ua);
  for i in 1..12 loop
    insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,neto_gravado,iva,total,estado_dato)
    values (ta, cm, lote, 'emitido', (mes0 - make_interval(months => i))::date + 5, 11, 1, i, 1500000, 0, 1500000, 'confirmado');
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  j := public.calcular_recategorizacion(ta, cm);
  if (j->>'ingresos_12m')::numeric <> 18000000 then raise exception 'FALLO 27: ingresos 12m = %', j->>'ingresos_12m'; end if;
  if j->>'categoria_sugerida' <> 'C' or (j->>'uso_porcentaje')::numeric <> 102.3 then raise exception 'FALLO 28: sugerida % uso %', j->>'categoria_sugerida', j->>'uso_porcentaje'; end if;
  if jsonb_array_length(j->'meses_sin_comprobantes') <> 0 then raise exception 'FALLO 29: no deberia faltar ningun mes'; end if;
  if (j->>'escala_verificada')::boolean then raise exception 'FALLO 30: la escala sembrada figura como verificada'; end if;
  reset role;

  insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,neto_gravado,iva,total,nota_credito,estado_dato)
    values (ta, cm, lote, 'emitido', (mes0 - interval '1 month')::date + 10, 13, 1, 100, 500000, 0, 500000, true, 'importado');
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  j := public.calcular_recategorizacion(ta, cm);
  if (j->>'ingresos_12m')::numeric <> 17500000 or j->>'categoria_sugerida' <> 'B' then raise exception 'FALLO 31: la nota de credito no resto (%, %)', j->>'ingresos_12m', j->>'categoria_sugerida'; end if;
  if (j->>'sin_confirmar')::int <> 1 then raise exception 'FALLO 32: no cuenta los comprobantes sin confirmar'; end if;
  j := public.calcular_recategorizacion(ta, cr);
  if (j->>'aplica')::boolean then raise exception 'FALLO 33: un responsable inscripto no deberia recategorizar'; end if;
  begin perform public.calcular_recategorizacion(ta, ce); raise exception 'FALLO 34: calculo para un cliente no asignado';
  exception when raise_exception then if sqlerrm like 'FALLO%' then raise; end if; end;
  reset role;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
    set local role authenticated;
    perform public.calcular_recategorizacion(ta, cm);
    raise exception 'FALLO 35: el estudio B calculo sobre un cliente del A';
  exception when raise_exception then if sqlerrm like 'FALLO%' then raise; end if; end;
  reset role;
  ok := ok || '27-35 ';

  -- ===== 6. Operaciones del motor =====
  -- calendario propio del mes actual: IVA del RI vencido hace 2 dias; cuota del monotributista vence en 3 dias
  insert into public.vencimientos_calendario(obligacion_codigo, periodo, terminacion, fecha, fuente) values
    ('iva_ddjj', hoy_mes, 4, current_date - 2, 'prueba'), ('monotributo_cuota', hoy_mes, 2, current_date + 3, 'prueba')
  on conflict (obligacion_codigo, periodo, terminacion) do update set fecha = excluded.fecha;
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  t1 := public.crear_tarea(ta, cr, 'vencimientos.control_obligaciones', 'Control IVA', 'manual', null, '09:00', 'manual', 'mes_actual', 1, 5, '{"dias_aviso": 5}'::jsonb);
  t2 := public.crear_tarea(ta, cm, 'vencimientos.control_obligaciones', 'Control monotributo', 'manual', null, '09:00', 'manual', 'mes_actual', 1, 5, '{"dias_aviso": 5}'::jsonb);
  run := public.lanzar_tarea(t1);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada' then raise exception 'FALLO 36: control del RI quedo %', s; end if;
  if (select count(*) from public.agenda_items where client_id = cr and tipo = 'vencimiento' and titulo like 'VENCIDA:%' and estado = 'pendiente') <> 1
    then raise exception 'FALLO 37: no aviso la obligacion vencida'; end if;
  run := public.lanzar_tarea(t2);
  if (select count(*) from public.agenda_items where client_id = cm and tipo = 'vencimiento' and titulo like '%vence el%' and estado = 'pendiente') <> 1
    then raise exception 'FALLO 38: no aviso el vencimiento proximo'; end if;
  run := public.lanzar_tarea(t1);
  if (select count(*) from public.agenda_items where client_id = cr and tipo = 'vencimiento') <> 1 then raise exception 'FALLO 39: se duplico el aviso'; end if;
  -- si el usuario resuelve la obligacion, deja de avisar
  update public.obligaciones_cliente set estado = 'presentada', presentada_en = current_date where client_id = cm and periodo = hoy_mes;
  update public.agenda_items set estado = 'hecho' where client_id = cm and tipo = 'vencimiento';
  run := public.lanzar_tarea(t2);
  if (select count(*) from public.agenda_items where client_id = cm and tipo = 'vencimiento' and estado = 'pendiente') <> 0 then raise exception 'FALLO 40: sigue avisando una obligacion ya resuelta'; end if;
  -- periodo sin fecha en el calendario => parcial y lo dice
  t3 := public.crear_tarea(ta, cm, 'vencimientos.control_obligaciones', 'Control sin calendario', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5,
                           '{"dias_aviso": 5}'::jsonb);
  reset role;
  delete from public.vencimientos_calendario where periodo = to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM') and obligacion_codigo = 'monotributo_cuota';
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  run := public.lanzar_tarea(t3);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada_parcialmente' then raise exception 'FALLO 41: sin calendario esperaba parcial y fue %', s; end if;
  -- configuracion invalida: error permanente, sin reintentos
  t4 := public.crear_tarea(ta, cr, 'vencimientos.control_obligaciones', 'Mal configurada', 'manual', null, '09:00', 'manual', 'mes_actual', 3, 5, '{"dias_aviso": "abc"}'::jsonb);
  run := public.lanzar_tarea(t4);
  select estado, intento into s, n from public.task_runs where id = run;
  if s <> 'fallida' or n <> 1 then raise exception 'FALLO 42: configuracion invalida deberia fallar sin reintentos (% , %)', s, n; end if;
  ok := ok || '36-42 ';

  -- recategorizacion como tarea
  t1 := public.crear_tarea(ta, cm, 'recategorizacion.revision', 'Revision recategorizacion', 'manual', null, '09:00', 'manual', 'mes_anterior', 1, 5);
  run := public.lanzar_tarea(t1);
  select estado into s from public.task_runs where id = run;
  if s <> 'completada_parcialmente' then raise exception 'FALLO 43: la revision con escala no verificada deberia ser parcial, fue %', s; end if;
  if (select count(*) from public.agenda_items where client_id = cm and tipo = 'recategorizacion' and titulo like 'Recategorización%' and estado = 'pendiente') <> 1
    then raise exception 'FALLO 44: no aviso que los ingresos superan el 90 por ciento'; end if;
  run := public.lanzar_tarea(t1);
  if (select count(*) from public.agenda_items where client_id = cm and tipo = 'recategorizacion' and titulo like 'Recategorización%') <> 1 then raise exception 'FALLO 45: aviso duplicado'; end if;
  reset role;
  ok := ok || '43-45 ';

  -- ===== 7. Auditoria =====
  if not exists (select 1 from public.audit_log where tenant_id = ta and objeto = 'obligaciones_cliente') then raise exception 'FALLO 46: sin auditoria de obligaciones'; end if;
  if not exists (select 1 from public.audit_log where tenant_id is null and objeto = 'vencimientos_calendario' and actor_id = uh) then raise exception 'FALLO 47: sin auditoria del calendario global'; end if;
  ok := ok || '46-47';

  raise exception 'PRUEBAS_OK: %', ok;
end $$;
