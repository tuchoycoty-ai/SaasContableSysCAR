-- Pruebas de la Fase 3: importaciones, duplicados, aislamiento, validacion y anulacion.
-- Siempre termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..." => todo correcto   |   "FALLO n: ..." => fallo la comprobacion n
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  uh uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  uo uuid := gen_random_uuid(); uc uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rc uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  h1 text := repeat('a', 64); h2 text := repeat('b', 64); h3 text := repeat('c', 64); h4 text := repeat('d', 64);
  filas jsonb; r jsonb; lote uuid; n int; t numeric; i numeric; ex int[]; s text; ok text := '';
begin
  insert into auth.users (id, email, aud, role) values
    (uh,'h@t.local','authenticated','authenticated'), (ua,'a@t.local','authenticated','authenticated'),
    (ub,'b@t.local','authenticated','authenticated'), (uo,'o@t.local','authenticated','authenticated'),
    (uc,'c@t.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values
    (ra,ta,'Administrador',true),(ro,ta,'Asistente',false),(rc,ta,'Contador',false),(rb,tb,'Administrador',true);
  insert into public.role_permissions(role_id,permission_code) values
    (rc,'clientes.editar'),(rc,'importaciones.gestionar');
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uo,ro),(ta,uc,rc),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social) values
    (ca,ta,'20111111112','Cliente A1'),(ca2,ta,'20333333334','Cliente A2'),(cb,tb,'20555555556','Cliente B1');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uo,ca),(ta,uc,ca);

  filas := '[
   {"fila":2,"fecha":"2026-09-10","tipo_cbte":1,"punto_venta":1,"numero":1,"doc":"30500010912","contraparte":"Cli SA","moneda":"PES","neto_gravado":1000,"iva":210,"total":1210},
   {"fila":3,"fecha":"2026-09-12","tipo_cbte":3,"punto_venta":1,"numero":2,"doc":"30500010912","contraparte":"Cli SA","moneda":"PES","neto_gravado":100,"iva":21,"total":121},
   {"fila":4,"fecha":"2026-10-01","tipo_cbte":1,"punto_venta":1,"numero":3,"doc":"30500010912","contraparte":"Cli SA","moneda":"PES","neto_gravado":500,"iva":105,"total":700},
   {"fila":5,"fecha":"2026-10-02","tipo_cbte":1,"punto_venta":0,"numero":4,"doc":"30500010912","moneda":"PES","neto_gravado":1,"iva":0,"total":1}
  ]'::jsonb;

  -- ===== 1. Asistente sin permiso =====
  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'x.csv', h1, filas);
    raise exception 'FALLO 1: un usuario sin permiso importo';
  exception when insufficient_privilege then ok := ok || '1 ';
  end;
  reset role;

  -- ===== 2. Contador importa =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  r := public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'emitidos.csv', h1, filas,
        '[{"fila":9,"motivo":"Fecha ilegible"}]'::jsonb);
  lote := (r->>'lote_id')::uuid;
  if (r->>'importadas')::int <> 3 or (r->>'rechazadas')::int <> 2 or (r->>'pendientes')::int <> 1 then
    raise exception 'FALLO 2: resultado inesperado %', r;
  end if;
  ok := ok || '2 ';

  -- 3. Nota de credito en negativo
  select total into t from public.comprobantes where client_id = ca and tipo_cbte = 3;
  if t <> -121 then raise exception 'FALLO 3: la nota de credito quedo con total %', t; end if;
  -- 3b. Estados
  select count(*) into n from public.comprobantes where estado_dato = 'pendiente_validacion' and advertencia is not null;
  if n <> 1 then raise exception 'FALLO 3b: filas pendientes % (esperaba 1)', n; end if;
  ok := ok || '3 ';

  -- 4. Mismo archivo otra vez
  begin
    perform public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'emitidos.csv', h1, filas);
    raise exception 'FALLO 4: se importo dos veces el mismo archivo';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '4 ';
  end;

  -- 5. Otro archivo con las mismas filas: todo duplicado, no guarda nada
  begin
    perform public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'otra.csv', h2, filas);
    raise exception 'FALLO 5: acepto un archivo completamente duplicado';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '5 ';
  end;
  select count(*) into n from public.import_batches where client_id = ca;
  if n <> 1 then raise exception 'FALLO 5b: quedaron % lotes (esperaba 1)', n; end if;

  -- 6. filas_existentes
  ex := public.filas_existentes(ta, ca, 'comprobantes_emitidos',
    '[{"fila":2,"tipo_cbte":1,"punto_venta":1,"numero":1},{"fila":7,"tipo_cbte":1,"punto_venta":1,"numero":99}]'::jsonb);
  if ex <> array[2] then raise exception 'FALLO 6: filas_existentes devolvio %', ex; end if;
  ok := ok || '6 ';

  -- 7. Cliente no asignado
  begin
    perform public.confirmar_importacion(ta, ca2, 'comprobantes_emitidos', 'z.csv', h3, filas);
    raise exception 'FALLO 7: importo para un cliente no asignado';
  exception when insufficient_privilege then ok := ok || '7 ';
  end;

  -- 8. Escritura directa prohibida
  begin
    insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,total)
      values (ta,ca,lote,'emitido','2026-09-01',1,1,500,1);
    raise exception 'FALLO 8: insert directo permitido';
  exception when insufficient_privilege then ok := ok || '8 ';
  end;
  begin
    update public.comprobantes set total = 1 where client_id = ca;
    raise exception 'FALLO 9: update directo permitido';
  exception when insufficient_privilege then ok := ok || '9 ';
  end;
  begin
    delete from public.comprobantes where client_id = ca;
    raise exception 'FALLO 10: delete directo permitido';
  exception when insufficient_privilege then ok := ok || '10 ';
  end;

  -- 11. Resumen mensual
  select sum(total), sum(iva) into t, i from public.resumen_mensual(ta, ca, date '2026-01-01', date '2026-12-31') where rubro = 'emitido';
  if t <> 1789 or i <> 294 then raise exception 'FALLO 11: resumen total=% iva=% (esperaba 1789 / 294)', t, i; end if;
  select count(*) into n from public.resumen_mensual(ta, ca, date '2026-09-01', date '2026-09-30') where rubro = 'emitido';
  if n <> 1 then raise exception 'FALLO 11b: septiembre deberia tener 1 grupo y tiene %', n; end if;
  ok := ok || '11 ';

  -- 12. Pagos: duplicado dentro del mismo archivo y importe invalido
  r := public.confirmar_importacion(ta, ca, 'pagos', 'pagos.csv', h4,
    '[{"fila":2,"fecha":"2026-09-20","concepto":"IVA 08/2026","impuesto":"IVA","importe":5000,"referencia":"R1"},
      {"fila":3,"fecha":"2026-09-20","concepto":"IVA 08/2026","impuesto":"IVA","importe":5000,"referencia":"R1"},
      {"fila":4,"fecha":"2026-09-21","concepto":"Autonomos","importe":0}]'::jsonb);
  if (r->>'importadas')::int <> 1 or (r->>'duplicadas')::int <> 1 or (r->>'rechazadas')::int <> 1 then
    raise exception 'FALLO 12: pagos %', r;
  end if;
  ok := ok || '12 ';
  reset role;

  -- 13. Auditoria del lote: existe y no copia el informe completo
  select count(*) into n from public.audit_log where tenant_id = ta and objeto = 'import_batches' and accion = 'INSERT';
  if n < 2 then raise exception 'FALLO 13: la creacion de lotes no quedo auditada'; end if;
  select count(*) into n from public.audit_log where objeto = 'import_batches' and detalle->'fila' ? 'informe';
  if n <> 0 then raise exception 'FALLO 13b: la auditoria copia el informe'; end if;
  ok := ok || '13 ';

  -- ===== Estudio B y holding: aislamiento =====
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.comprobantes; if n <> 0 then raise exception 'FALLO 14: B ve % comprobantes de A', n; end if;
  select count(*) into n from public.pagos; if n <> 0 then raise exception 'FALLO 15: B ve pagos de A'; end if;
  select count(*) into n from public.import_batches; if n <> 0 then raise exception 'FALLO 16: B ve lotes de A'; end if;
  begin
    perform public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'b.csv', h3, filas);
    raise exception 'FALLO 17: B importo en un cliente de A';
  exception when insufficient_privilege then ok := ok || '17 ';
  end;
  begin
    perform public.confirmar_importacion(tb, ca, 'comprobantes_emitidos', 'b.csv', h3, filas);
    raise exception 'FALLO 18: B importo con un cliente de A bajo su estudio';
  exception when insufficient_privilege then ok := ok || '18 ';
  end;
  begin
    perform public.anular_lote(lote, 'intento de anular ajeno');
    raise exception 'FALLO 19: B anulo un lote de A';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '19 ';
  end;
  select count(*) into n from public.resumen_mensual(ta, ca, date '2026-01-01', date '2026-12-31');
  if n <> 0 then raise exception 'FALLO 20: B lee el resumen de A'; end if;
  ok := ok || '14-16,20 ';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.comprobantes; if n <> 0 then raise exception 'FALLO 21: el holding lee comprobantes'; end if;
  select count(*) into n from public.pagos; if n <> 0 then raise exception 'FALLO 22: el holding lee pagos'; end if;
  ok := ok || '21-22 ';
  reset role;

  -- ===== Anonimo =====
  set local role anon;
  begin
    perform count(*) from public.comprobantes;
    raise exception 'FALLO 23: anonimo lee comprobantes';
  exception when insufficient_privilege then ok := ok || '23 ';
  end;
  reset role;

  -- ===== Validar y anular =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  perform public.validar_lote(lote);
  select count(*) into n from public.comprobantes where batch_id = lote and estado_dato <> 'confirmado';
  if n <> 0 then raise exception 'FALLO 24: quedaron % filas sin confirmar', n; end if;
  if (select estado from public.import_batches where id = lote) <> 'validado' then raise exception 'FALLO 24b: lote no validado'; end if;
  begin
    perform public.validar_lote(lote);
    raise exception 'FALLO 25: se valido dos veces';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '24-25 ';
  end;
  begin
    perform public.anular_lote(lote, 'quiero anular siendo contador');
    raise exception 'FALLO 26: un contador anulo un lote';
  exception when insufficient_privilege then ok := ok || '26 ';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.anular_lote(lote, 'x');
    raise exception 'FALLO 27: anulo sin motivo';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    ok := ok || '27 ';
  end;
  perform public.anular_lote(lote, 'Archivo cargado en el cliente equivocado');
  select count(*) into n from public.comprobantes where client_id = ca; if n <> 0 then raise exception 'FALLO 28: quedaron comprobantes del lote anulado'; end if;
  if (select estado from public.import_batches where id = lote) <> 'anulado' then raise exception 'FALLO 28b: lote no anulado'; end if;
  reset role;
  select count(*) into n from public.audit_log where tenant_id = ta and accion = 'ANULAR_LOTE' and actor_id = ua;
  if n <> 1 then raise exception 'FALLO 29: la anulacion no quedo auditada'; end if;
  ok := ok || '28-29 ';

  -- 30. Reprocesar: despues de anular, el mismo archivo se puede volver a importar
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  r := public.confirmar_importacion(ta, ca, 'comprobantes_emitidos', 'emitidos.csv', h1, filas);
  if (r->>'importadas')::int <> 3 then raise exception 'FALLO 30: el reprocesamiento importo %', r; end if;
  ok := ok || '30 ';
  reset role;

  -- 31. Estudio suspendido pierde el acceso
  update public.tenants set estado = 'suspendido' where id = ta;
  set local role authenticated;
  begin
    perform public.confirmar_importacion(ta, ca, 'comprobantes_recibidos', 'rec.csv', h3,
      '[{"fila":2,"fecha":"2026-09-10","tipo_cbte":1,"punto_venta":5,"numero":1,"doc":"30500010912","total":10}]'::jsonb);
    raise exception 'FALLO 31: un estudio suspendido importo';
  exception when insufficient_privilege then ok := ok || '31 ';
  end;
  select count(*) into n from public.comprobantes; if n <> 0 then raise exception 'FALLO 32: estudio suspendido lee comprobantes'; end if;
  ok := ok || '32 ';
  reset role;

  raise exception 'PRUEBAS_OK: %', ok;
end $$;
