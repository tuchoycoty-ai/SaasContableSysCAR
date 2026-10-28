-- Pruebas de aislamiento multi-tenant (Fase 1).
-- Crea usuarios y estudios de prueba, simula sesiones de Supabase Auth y verifica
-- que cada rol vea y escriba solo lo que le corresponde.
-- SIEMPRE termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..."  => todo correcto
--   "FALLO n: ..."     => la comprobacion n fallo
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  uo uuid := gen_random_uuid(); uh uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); rb uuid := gen_random_uuid(); ro uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  n int; ok text := '';
begin
  insert into auth.users (id, email, aud, role) values
    (ua,'a@test.local','authenticated','authenticated'),
    (ub,'b@test.local','authenticated','authenticated'),
    (uo,'o@test.local','authenticated','authenticated'),
    (uh,'h@test.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values
    (ra,ta,'admin',true),(ro,ta,'operativo',false),(rb,tb,'admin',true);
  insert into public.memberships(tenant_id,user_id,role_id) values
    (ta,ua,ra),(ta,uo,ro),(tb,ub,rb);
  insert into public.clients(id,tenant_id,cuit,razon_social) values
    (ca,ta,'20111111112','Cliente A1'),(ca2,ta,'20333333334','Cliente A2'),
    (cb,tb,'20111111112','Cliente B1');
  insert into public.user_client_access(tenant_id,user_id,client_id) values (ta,uo,ca);

  -- Admin del Estudio A
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients;
  if n <> 2 then raise exception 'FALLO 1: A ve % clientes (esperaba 2)', n; end if;
  select count(*) into n from public.clients where tenant_id = tb;
  if n <> 0 then raise exception 'FALLO 2: A ve clientes de B'; end if;
  select count(*) into n from public.tenants;
  if n <> 1 then raise exception 'FALLO 3: A ve % estudios', n; end if;
  begin
    insert into public.clients(tenant_id,cuit,razon_social) values (tb,'20999999990','Intruso');
    raise exception 'FALLO 4: A escribio un cliente en B';
  exception when insufficient_privilege then ok := ok || '4 ';
  end;
  update public.clients set razon_social='hack' where id = cb;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 5: A modifico un cliente de B'; end if;
  delete from public.clients where id = cb;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO 6: A borro un cliente de B'; end if;
  begin
    insert into public.memberships(tenant_id,user_id,role_id) values (tb,ua,rb);
    raise exception 'FALLO 7: A se agrego como miembro de B';
  exception when insufficient_privilege then ok := ok || '7 ';
  end;
  begin
    insert into public.memberships(tenant_id,user_id,role_id) values (ta,uh,rb);
    raise exception 'FALLO 8: A uso un rol de otro estudio';
  exception when foreign_key_violation then ok := ok || '8 ';
  end;
  begin
    insert into public.tenants(nombre) values ('Estudio falso');
    raise exception 'FALLO 9: A creo un estudio';
  exception when insufficient_privilege then ok := ok || '9 ';
  end;
  begin
    insert into public.platform_admins(user_id) values (ua);
    raise exception 'FALLO 10: A se hizo superadmin';
  exception when insufficient_privilege then ok := ok || '10 ';
  end;
  begin
    update public.profiles set email='x@x' where id = ua;
    raise exception 'FALLO 11: A cambio su email de perfil';
  exception when insufficient_privilege then ok := ok || '11 ';
  end;
  begin
    insert into public.audit_log(tenant_id,accion,resultado) values (ta,'x','ok');
    raise exception 'FALLO 12: A escribio en la auditoria';
  exception when insufficient_privilege then ok := ok || '12 ';
  end;
  begin
    delete from public.audit_log;
    raise exception 'FALLO 13: A borro auditoria';
  exception when insufficient_privilege then ok := ok || '13 ';
  end;
  select count(*) into n from public.audit_log where tenant_id = tb;
  if n <> 0 then raise exception 'FALLO 14: A ve auditoria de B'; end if;
  select count(*) into n from public.audit_log where tenant_id = ta;
  if n = 0 then raise exception 'FALLO 15: la auditoria de A no registro nada'; end if;
  reset role;

  -- Usuario operativo del Estudio A
  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FALLO 16: operativo ve % clientes (esperaba 1)', n; end if;
  select count(*) into n from public.clients where id = ca2;
  if n <> 0 then raise exception 'FALLO 17: operativo ve un cliente no asignado'; end if;
  begin
    insert into public.clients(tenant_id,cuit,razon_social) values (ta,'20555555556','No permitido');
    raise exception 'FALLO 18: operativo creo un cliente';
  exception when insufficient_privilege then ok := ok || '18 ';
  end;
  select count(*) into n from public.memberships;
  if n <> 1 then raise exception 'FALLO 19: operativo ve % membresias', n; end if;
  select count(*) into n from public.audit_log;
  if n <> 0 then raise exception 'FALLO 20: operativo ve auditoria'; end if;
  reset role;

  -- Admin del Estudio B
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients;
  if n <> 1 then raise exception 'FALLO 21: B ve % clientes (esperaba 1)', n; end if;
  select count(*) into n from public.clients where tenant_id = ta;
  if n <> 0 then raise exception 'FALLO 22: B ve clientes de A'; end if;
  select count(*) into n from public.profiles where id in (ua, uo);
  if n <> 0 then raise exception 'FALLO 23: B ve usuarios de A'; end if;
  reset role;

  -- Superadmin del holding
  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.tenants where id in (ta,tb);
  if n <> 2 then raise exception 'FALLO 24: holding ve % estudios', n; end if;
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'FALLO 25: holding lee datos fiscales de clientes'; end if;
  select count(*) into n from public.audit_log;
  if n = 0 then raise exception 'FALLO 26: holding no ve la auditoria'; end if;
  update public.tenants set estado='suspendido' where id = ta;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO 27: holding no pudo suspender'; end if;
  reset role;

  -- Estudio suspendido: A pierde acceso
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.clients;
  if n <> 0 then raise exception 'FALLO 28: estudio suspendido sigue viendo clientes'; end if;
  reset role;

  -- Anonimo (sin sesion)
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    perform 1 from public.clients;
    raise exception 'FALLO 29: anonimo pudo leer clientes';
  exception when insufficient_privilege then ok := ok || '29 ';
  end;
  begin
    perform 1 from public.tenants;
    raise exception 'FALLO 30: anonimo pudo leer estudios';
  exception when insufficient_privilege then ok := ok || '30 ';
  end;
  reset role;

  raise exception 'PRUEBAS_OK: 30 comprobaciones superadas (control de excepciones: %)', ok;
end $$;
