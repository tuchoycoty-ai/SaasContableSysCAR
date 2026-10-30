-- El rol «Contador» de los estudios nuevos tambien recibe el permiso de obligaciones (Fase 6).
-- Los estudios que ya existen no se tocan: su administrador lo puede tildar desde Roles.
create or replace function public.crear_estudio(p_nombre text, p_cuit text default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_tenant uuid;
  v_contador uuid;
begin
  if not private.is_holding() then
    raise exception 'Solo el holding puede crear estudios' using errcode = '42501';
  end if;
  insert into public.tenants (nombre, cuit)
    values (trim(p_nombre), nullif(trim(coalesce(p_cuit, '')), ''))
    returning id into v_tenant;
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Administrador', true);
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Contador', false)
    returning id into v_contador;
  insert into public.roles (tenant_id, nombre, es_admin) values (v_tenant, 'Asistente', false);
  insert into public.role_permissions (role_id, permission_code)
    values (v_contador, 'clientes.editar'), (v_contador, 'importaciones.gestionar'), (v_contador, 'tareas.gestionar'), (v_contador, 'obligaciones.gestionar');
  return v_tenant;
end $$;
