-- Pruebas de la Fase 5: certificados ARCA, claves y tickets (aislamiento entre estudios, permisos, restricciones).
-- Siempre termina con una excepcion para deshacer todo:
--   "PRUEBAS_OK: ..." => todo correcto   |   "FALLO n: ..." => fallo la comprobacion n
do $$
declare
  ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  uh uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uo uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); ro uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
  ka uuid := gen_random_uuid(); kb uuid := gen_random_uuid(); ka2 uuid := gen_random_uuid();
  n int; ok text := '';
begin
  insert into auth.users (id, email, aud, role) values
    (uh,'h@t.local','authenticated','authenticated'), (ua,'a@t.local','authenticated','authenticated'),
    (ub,'b@t.local','authenticated','authenticated'), (uo,'o@t.local','authenticated','authenticated');
  insert into public.platform_admins(user_id) values (uh);
  insert into public.tenants(id,nombre) values (ta,'Estudio A'),(tb,'Estudio B');
  insert into public.roles(id,tenant_id,nombre,es_admin) values (ra,ta,'Administrador',true),(ro,ta,'Asistente',false),(rb,tb,'Administrador',true);
  insert into public.memberships(tenant_id,user_id,role_id) values (ta,ua,ra),(ta,uo,ro),(tb,ub,rb);

  -- El servidor carga certificados, claves y tickets
  insert into public.arca_certificados(id,tenant_id,ambiente,alias,cuit,estado,origen,crt_pem,valido_hasta,huella_sha256) values
    (ka,ta,'produccion','syscar','20111111112','activo','subido','x',now()+interval '1 year','aa'),
    (kb,tb,'produccion','syscar','20333333334','activo','subido','x',now()+interval '1 year','bb');
  insert into public.arca_secretos(certificado_id,clave_cifrada) values (ka,'v1:AAAA'),(kb,'v1:BBBB');
  insert into public.arca_tickets(certificado_id,servicio,token,sign,expira) values (ka,'wsfe','t','s',now()+interval '1 hour');

  -- 1-3. Restricciones
  begin
    insert into public.arca_certificados(tenant_id,ambiente,alias,cuit,estado,origen,valido_hasta,huella_sha256) values (ta,'produccion','otro','20111111112','activo','subido',now()+interval '1 year','cc');
    raise exception 'FALLO 1: se permitio un segundo certificado vigente en el mismo ambiente';
  exception when unique_violation then null; end;
  begin
    insert into public.arca_certificados(tenant_id,ambiente,alias,cuit,estado,origen) values (ta,'homologacion','x','20111111111','csr_generado','generado_aqui');
    raise exception 'FALLO 2: se acepto un CUIT invalido';
  exception when check_violation then null; end;
  update public.arca_certificados set estado = 'revocado' where id = ka;
  insert into public.arca_certificados(id,tenant_id,ambiente,alias,cuit,estado,origen) values (ka2,ta,'produccion','nuevo','20111111112','csr_generado','generado_aqui');
  select count(*) into n from public.arca_certificados where tenant_id = ta and estado <> 'revocado';
  if n <> 1 then raise exception 'FALLO 3: tras revocar, debe poder haber un nuevo pedido (hay %)', n; end if;
  begin
    update public.arca_certificados set estado = 'activo' where id = ka2;
    raise exception 'FALLO 3b: se activo un certificado sin fecha de vencimiento ni huella';
  exception when check_violation then null; end;
  update public.arca_certificados set estado = 'activo', crt_pem = 'x', valido_hasta = now()+interval '1 year', huella_sha256 = 'dd' where id = ka2;
  ok := ok || '1-3 ';

  -- 4. Administrador del estudio A: ve solo lo suyo
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.arca_certificados;
  if n <> 2 then raise exception 'FALLO 4: el admin de A deberia ver 2 filas de A (revocada + activa), ve %', n; end if;
  if exists (select 1 from public.arca_certificados where tenant_id = tb) then raise exception 'FALLO 5: el admin de A ve certificados de B'; end if;
  ok := ok || '4-5 ';

  -- 6. Nadie desde el navegador puede leer claves ni tickets, ni escribir certificados
  begin
    perform 1 from public.arca_secretos limit 1;
    raise exception 'FALLO 6: el admin pudo leer arca_secretos';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.arca_tickets limit 1;
    raise exception 'FALLO 7: el admin pudo leer arca_tickets';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.arca_certificados(tenant_id,ambiente,alias,cuit,estado,origen) values (ta,'homologacion','x','20111111112','csr_generado','generado_aqui');
    raise exception 'FALLO 8: el admin pudo insertar un certificado desde el navegador';
  exception when insufficient_privilege or others then
    if sqlerrm like 'FALLO%' then raise; end if;
  end;
  begin
    update public.arca_certificados set estado = 'activo' where tenant_id = ta;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'FALLO 9: el admin pudo modificar certificados desde el navegador'; end if;
  exception when insufficient_privilege then null; end;
  ok := ok || '6-9 ';
  reset role;

  -- 10. Usuario del estudio A sin rol admin: no ve nada
  perform set_config('request.jwt.claims', json_build_object('sub',uo,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.arca_certificados;
  if n <> 0 then raise exception 'FALLO 10: un usuario sin rol admin ve % certificados', n; end if;
  reset role;

  -- 11. Admin de B: solo B
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.arca_certificados;
  if n <> 1 or not exists (select 1 from public.arca_certificados where id = kb) then raise exception 'FALLO 11: el admin de B no ve solo lo suyo (%)', n; end if;
  reset role;

  -- 12. Holding: ve los certificados de todos (no las claves)
  perform set_config('request.jwt.claims', json_build_object('sub',uh,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.arca_certificados where tenant_id in (ta, tb);
  if n <> 3 then raise exception 'FALLO 12: el holding deberia ver 3 filas, ve %', n; end if;
  begin
    perform 1 from public.arca_secretos limit 1;
    raise exception 'FALLO 13: el holding pudo leer arca_secretos';
  exception when insufficient_privilege then null; end;
  reset role;
  ok := ok || '10-13 ';

  -- 14. Anonimo: nada
  set local role anon;
  begin
    perform 1 from public.arca_certificados limit 1;
    raise exception 'FALLO 14: anon pudo consultar arca_certificados';
  exception when insufficient_privilege then null; end;
  reset role;
  ok := ok || '14 ';

  -- 15. Auditoria: los cambios de certificados quedaron registrados
  select count(*) into n from public.audit_log where objeto ilike '%arca_certificados%' and tenant_id = ta;
  if n = 0 then raise exception 'FALLO 15: no hay auditoria de arca_certificados'; end if;
  ok := ok || '15';

  raise exception 'PRUEBAS_OK: %', ok;
end $$;
