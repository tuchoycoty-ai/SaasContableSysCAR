-- Pruebas de la Fase 2: permisos por rol, ultimo administrador, validacion de CUIT,
-- autorizaciones y alta de estudios. Siempre termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..." => todo correcto   |   "FALLO n: ..." => fallo la comprobacion n
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  uh uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  uo uuid := gen_random_uuid(); uc uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rc uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid();
  v_nuevo uuid; n int; p text[]; ok text := '';
begin
  -- Preparacion (como administrador de la base)
  insert into auth.users (id, email, aud, role) values
    (uh,'h@t.local','authenticated','authenticated'), (ua,'a@t.local','authenticated','authenticated'),
    (ub,'b@t.local','authenticated','authenticated'), (uo,'o@t.local','authenticated','authenticated'),
    (uc,'c@t.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values
    (ra,ta,'Administrador',true),(ro,ta,'Asistente',false),(rc,ta,'Contador',false),(rb,tb,'Administrador',true);
  insert into public.role_permissions(role_id,permission_code) values (rc,'clientes.editar');
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uo,ro),(ta,uc,rc),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social) values
    (ca,ta,'20111111112','Cliente A1'),(ca2,ta,'20333333334','Cliente A2');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uo,ca),(ta,uc,ca);

  -- ===== Holding: alta de estudios =====
  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  v_nuevo := public.crear_estudio('Estudio nuevo', '30500010912');
  select count(*) into n from public.roles where tenant_id = v_nuevo;
  if n <> 3 then raise exception 'FALLO 1: el estudio nuevo tiene % roles (esperaba 3)', n; end if;
  select count(*) into n from public.roles where tenant_id = v_nuevo and es_admin;
  if n <> 1 then raise exception 'FALLO 2: el estudio nuevo no tiene exactamente un rol administrador'; end if;
  select count(*) into n from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where r.tenant_id = v_nuevo and r.nombre = 'Contador';
  if n <> 1 then raise exception 'FALLO 3: el rol Contador no recibio su permiso'; end if;
  begin
    perform public.crear_estudio('Estudio con CUIT malo', '20999999990');
    raise exception 'FALLO 4: se creo un estudio con CUIT invalido';
  exception when check_violation then ok := ok || '4 ';
  end;
  begin
    perform public.crear_estudio('   ', null);
    raise exception 'FALLO 5: se creo un estudio sin nombre';
  exception when check_violation then ok := ok || '5 ';
  end;
  select count(*) into n from public.client_authorizations;
  if n <> 0 then raise exception 'FALLO 6: holding lee autorizaciones de clientes'; end if;
  reset role;

  -- ===== Admin del Estudio A =====
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.crear_estudio('Estudio falso', null);
    raise exception 'FALLO 7: un admin de estudio creo un estudio';
  exception when insufficient_privilege then ok := ok || '7 ';
  end;
  begin
    insert into public.clients(tenant_id,cuit,razon_social) values (ta,'20999999990','CUIT invalido');
    raise exception 'FALLO 8: se guardo un cliente con CUIT invalido';
  exception when check_violation then ok := ok || '8 ';
  end;
  begin
    insert into public.clients(tenant_id,cuit,razon_social,regimen,categoria_monotributo)
      values (ta,'20555555556','Categoria sin monotributo','exento','C');
    raise exception 'FALLO 9: categoria de monotributo en un cliente exento';
  exception when check_violation then ok := ok || '9 ';
  end;
  insert into public.clients(tenant_id,cuit,razon_social,regimen,categoria_monotributo)
    values (ta,'20555555556','Cliente valido','monotributo','C');
  begin
    delete from public.memberships where tenant_id = ta and user_id = ua;
    raise exception 'FALLO 10: se pudo quitar al ultimo administrador';
  exception when raise_exception then ok := ok || '10 ';
  end;
  begin
    update public.roles set es_admin = false where id = ra;
    raise exception 'FALLO 11: se pudo sacar el permiso de administrador al unico admin';
  exception when raise_exception then ok := ok || '11 ';
  end;
  begin
    delete from public.roles where id = ro;
    raise exception 'FALLO 12: se borro un rol que tiene miembros';
  exception when foreign_key_violation then ok := ok || '12 ';
  end;
  p := public.mis_permisos(ta);
  if not ('admin' = any(p) and 'clientes.editar' = any(p)) then raise exception 'FALLO 13: permisos de admin: %', p; end if;
  p := public.mis_permisos(tb);
  if cardinality(p) <> 0 then raise exception 'FALLO 14: A tiene permisos en el estudio B: %', p; end if;
  reset role;

  -- Con un segundo administrador, el primero si puede salir
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,uh,ra);
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  delete from public.memberships where tenant_id = ta and user_id = ua;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO 15: no se pudo quitar un admin habiendo otro'; end if;
  reset role;

  -- ===== Contador (rol con permiso clientes.editar), asignado a un solo cliente =====
  perform set_config('request.jwt.claims', json_build_object('sub',uc,'role','authenticated')::text, true);
  set local role authenticated;
  update public.clients set razon_social = 'Editado por contador' where id = ca;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO 16: el contador no pudo editar su cliente asignado'; end if;
  update public.clients set razon_social = 'Intento' where id = ca2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 17: el contador edito un cliente no asignado'; end if;
  insert into public.client_authorizations(tenant_id,client_id,estado,vigente_desde,vigente_hasta)
    values (ta,ca,'vigente','2026-01-01','2026-12-31');
  begin
    insert into public.client_authorizations(tenant_id,client_id,estado) values (ta,ca,'vigente');
    raise exception 'FALLO 18: dos autorizaciones vigentes para el mismo cliente';
  exception when unique_violation then ok := ok || '18 ';
  end;
  begin
    insert into public.client_authorizations(tenant_id,client_id,estado) values (ta,ca2,'pendiente');
    raise exception 'FALLO 19: el contador cargo una autorizacion de un cliente no asignado';
  exception when insufficient_privilege then ok := ok || '19 ';
  end;
  begin
    insert into public.client_authorizations(tenant_id,client_id,estado,vigente_desde,vigente_hasta)
      values (ta,ca,'revocada','2026-06-01','2026-01-01');
    raise exception 'FALLO 20: se acepto una autorizacion con fechas al reves';
  exception when check_violation then ok := ok || '20 ';
  end;
  begin
    delete from public.client_authorizations;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FALLO 21: el contador borro autorizaciones'; end if;
  end;
  begin
    insert into public.memberships(tenant_id,user_id,role_id) values (ta,uc,ra);
    raise exception 'FALLO 22: el contador se asigno el rol de administrador';
  exception when insufficient_privilege then ok := ok || '22 ';
  end;
  p := public.mis_permisos(ta);
  if p <> array['clientes.editar'] then raise exception 'FALLO 23: permisos del contador: %', p; end if;
  reset role;

  -- ===== Asistente (sin permiso de edicion), asignado a un cliente =====
  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  update public.clients set razon_social = 'Intento asistente' where id = ca;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 24: el asistente edito un cliente'; end if;
  select count(*) into n from public.client_authorizations where client_id = ca;
  if n <> 1 then raise exception 'FALLO 25: el asistente no ve la autorizacion de su cliente (ve %)', n; end if;
  begin
    insert into public.client_authorizations(tenant_id,client_id,estado) values (ta,ca,'pendiente');
    raise exception 'FALLO 26: el asistente cargo una autorizacion';
  exception when insufficient_privilege then ok := ok || '26 ';
  end;
  p := public.mis_permisos(ta);
  if cardinality(p) <> 0 then raise exception 'FALLO 27: permisos del asistente: %', p; end if;
  reset role;

  -- ===== Admin del Estudio B no ve nada de A =====
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.client_authorizations;
  if n <> 0 then raise exception 'FALLO 28: B ve autorizaciones de A'; end if;
  reset role;

  raise exception 'PRUEBAS_OK: 28 comprobaciones superadas (control de excepciones: %)', ok;
end $$;
