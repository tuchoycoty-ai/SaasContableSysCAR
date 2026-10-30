-- Pruebas de la Fase 7 (reportes): aislamiento, permisos por cliente, notas de credito, limites. Todo en una transaccion
-- que termina en error a proposito (PRUEBAS_OK) para no dejar datos. Esperado: PRUEBAS_OK: 1-12 13-14 15-18 19 20
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uo uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  lote uuid := gen_random_uuid(); lote2 uuid := gen_random_uuid();
  n int; x numeric; s text; ok text := '';
begin
  insert into auth.users (id, email, aud, role) values (ua,'a@t.local','authenticated','authenticated'),(ub,'b@t.local','authenticated','authenticated'),(uo,'o@t.local','authenticated','authenticated');
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values (ra,ta,'Administrador',true),(ro,ta,'Asistente',false),(rb,tb,'Administrador',true);
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uo,ro),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social) values (ca,ta,'20111111112','Cliente A1'),(ca2,ta,'20333333334','Cliente A2'),(cb,tb,'20555555556','Cliente B1');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uo,ca);
  insert into public.import_batches(id,tenant_id,client_id,tipo,archivo_nombre,archivo_hash,estado,creado_por) values
    (lote,ta,ca,'comprobantes_emitidos','t.csv',repeat('a',64),'importado',ua),
    (lote2,ta,ca2,'comprobantes_emitidos','t2.csv',repeat('b',64),'importado',ua);
  insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,doc_contraparte,contraparte,neto_gravado,iva,total,nota_credito,estado_dato) values
    (ta,ca,lote,'emitido','2026-09-02',1,1,1,'30500010912','Cliente Grande',1000,210,1210,false,'confirmado'),
    (ta,ca,lote,'emitido','2026-09-03',1,1,2,'30500010912','Cliente Grande',500,105,605,false,'importado'),
    (ta,ca,lote,'emitido','2026-09-04',1,1,3,'20111111112','Cliente Chico',100,21,121,false,'confirmado'),
    (ta,ca,lote,'emitido','2026-09-05',3,1,4,'30500010912','Cliente Grande',-200,-42,-242,true,'confirmado'),
    (ta,ca,lote,'recibido','2026-09-06',1,5,9,'30700000001','Proveedor',400,84,484,false,'confirmado'),
    (ta,ca,lote,'emitido','2026-08-31',1,1,5,'30500010912','Fuera de rango',9999,0,9999,false,'confirmado'),
    (ta,ca2,lote2,'emitido','2026-09-02',1,1,1,'30500010912','X',7777,0,7777,false,'confirmado');
  insert into public.import_batches(id,tenant_id,client_id,tipo,archivo_nombre,archivo_hash,estado,creado_por) values (gen_random_uuid(),tb,cb,'comprobantes_emitidos','t3.csv',repeat('c',64),'importado',ub);
  insert into public.comprobantes(tenant_id,client_id,batch_id,sentido,fecha,tipo_cbte,punto_venta,numero,neto_gravado,iva,total,estado_dato)
    select tb,cb,id,'emitido','2026-09-02',1,1,1,5555,0,5555,'confirmado' from public.import_batches where tenant_id=tb;

  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 5);
  if n <> 2 then raise exception 'FALLO 1: esperaba 2 contrapartes y hay %', n; end if;
  select neto into x from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 5) order by neto desc limit 1;
  if x <> 1300 then raise exception 'FALLO 2: mayor cliente neto % (esperaba 1500-200=1300)', x; end if;
  select nombre into s from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 1);
  if s <> 'Cliente Grande' then raise exception 'FALLO 3: limite/orden %', s; end if;
  select count(*) into n from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'recibido', 5);
  if n <> 1 then raise exception 'FALLO 4: recibidos %', n; end if;
  select count(*) into n from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'otra', 5);
  if n <> 0 then raise exception 'FALLO 5: sentido invalido'; end if;
  select count(*) into n from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 100000);
  if n > 50 then raise exception 'FALLO 6: limite sin tope'; end if;
  select emitidos_neto into x from public.resumen_cartera(ta, '2026-09-01', '2026-09-30') where client_id = ca;
  if x <> 1400 then raise exception 'FALLO 7: emitidos neto % (esperaba 1400)', x; end if;
  select recibidos_neto into x from public.resumen_cartera(ta, '2026-09-01', '2026-09-30') where client_id = ca;
  if x <> 400 then raise exception 'FALLO 8: recibidos neto %', x; end if;
  select iva_debito - iva_credito into x from public.resumen_cartera(ta, '2026-09-01', '2026-09-30') where client_id = ca;
  if x <> 210 + 105 + 21 - 42 - 84 then raise exception 'FALLO 9: posicion iva %', x; end if;
  select sin_confirmar into n from public.resumen_cartera(ta, '2026-09-01', '2026-09-30') where client_id = ca;
  if n <> 1 then raise exception 'FALLO 10: sin confirmar %', n; end if;
  select count(*) into n from public.resumen_cartera(ta, '2026-09-01', '2026-09-30');
  if n <> 2 then raise exception 'FALLO 11: el admin debe ver 2 clientes y ve %', n; end if;
  select cantidad into n from public.resumen_cartera(ta, '2026-10-01', '2026-10-31') where client_id = ca;
  if n <> 0 then raise exception 'FALLO 12: cliente sin movimientos debe aparecer en cero'; end if;
  ok := ok || '1-12 ';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.resumen_cartera(ta, '2026-09-01', '2026-09-30');
  if n <> 1 then raise exception 'FALLO 13: el asistente solo ve su cliente asignado y ve %', n; end if;
  select count(*) into n from public.top_contrapartes(ta, ca2, '2026-09-01', '2026-09-30', 'emitido', 5);
  if n <> 0 then raise exception 'FALLO 14: el asistente ve contrapartes de un cliente no asignado'; end if;
  ok := ok || '13-14 ';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.resumen_cartera(ta, '2026-09-01', '2026-09-30');
  if n <> 0 then raise exception 'FALLO 15: B ve la cartera de A'; end if;
  select count(*) into n from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 5);
  if n <> 0 then raise exception 'FALLO 16: B ve contrapartes de A'; end if;
  select count(*) into n from public.top_contrapartes(tb, ca, '2026-09-01', '2026-09-30', 'emitido', 5);
  if n <> 0 then raise exception 'FALLO 17: B pide un cliente de A con su propio estudio'; end if;
  select emitidos_neto into x from public.resumen_cartera(tb, '2026-09-01', '2026-09-30');
  if x <> 5555 then raise exception 'FALLO 18: B no ve lo propio (%)', x; end if;
  ok := ok || '15-18 ';
  reset role;

  set local role anon;
  begin
    perform * from public.resumen_cartera(ta, '2026-09-01', '2026-09-30');
    raise exception 'FALLO 19: anonimo ejecuta resumen_cartera';
  exception when insufficient_privilege then ok := ok || '19 ';
  end;
  begin
    perform * from public.top_contrapartes(ta, ca, '2026-09-01', '2026-09-30', 'emitido', 5);
    raise exception 'FALLO 20: anonimo ejecuta top_contrapartes';
  exception when insufficient_privilege then ok := ok || '20 ';
  end;
  reset role;
  raise exception 'PRUEBAS_OK: %', ok;
end $$;
