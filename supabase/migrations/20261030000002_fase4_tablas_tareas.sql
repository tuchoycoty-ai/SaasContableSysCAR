-- Fase 4 (parte 1): tareas, ejecuciones, historial de eventos y agenda.
-- Reglas:
--  * Las tareas y sus ejecuciones solo se modifican por funciones (motor y acciones del usuario), nunca por escritura directa.
--  * El historial (ejecuciones y eventos) no se borra: no hay politicas ni permisos de DELETE.
--  * Solo existen operaciones marcadas "disponible"; las que dependen de fases futuras figuran como pendientes.

insert into public.permissions (code, descripcion)
values ('tareas.gestionar', 'Crear, pausar, ejecutar y relanzar tareas, y gestionar la agenda de vencimientos')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, 'tareas.gestionar' from public.roles r where r.nombre = 'Contador' and not r.es_admin
on conflict do nothing;

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
    values (v_contador, 'clientes.editar'), (v_contador, 'importaciones.gestionar'), (v_contador, 'tareas.gestionar');
  return v_tenant;
end $$;

-- ---------- Catalogo de operaciones ----------
create table public.task_operations (
  codigo text primary key,
  modulo text not null,
  nombre text not null,
  descripcion text not null,
  disponible boolean not null,
  nota text
);
insert into public.task_operations (codigo, modulo, nombre, descripcion, disponible, nota) values
  ('importaciones.control_carga', 'Importaciones', 'Controlar la carga mensual de comprobantes',
   'Verifica que haya comprobantes emitidos y recibidos importados del período. Si falta alguno, deja un recordatorio en la agenda.', true, null),
  ('vencimientos.recordatorio', 'Vencimientos', 'Recordatorio de vencimiento',
   'Crea en la agenda un vencimiento con el día que configures (por ejemplo IVA, día 18 del mes siguiente).', true, null),
  ('impuestos.control_iva', 'Impuestos', 'Control de IVA del período',
   'Calcula el IVA estimado del período con los comprobantes importados y lo compara con los pagos de IVA registrados.', true, null),
  ('arca.importar_comprobantes', 'ARCA', 'Importar comprobantes desde ARCA',
   'Descarga automática de comprobantes emitidos y recibidos.', false, 'Pendiente de integración con ARCA (Fase 5). Mientras tanto se importan archivos a mano.'),
  ('recategorizacion.revision', 'Recategorización', 'Revisión mensual de recategorización',
   'Análisis de ingresos acumulados contra los topes de cada categoría de monotributo.', false, 'Pendiente (Fase 6): requiere cargar los topes vigentes.');

-- ---------- Tareas ----------
create table public.task_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  client_id uuid not null,
  operacion text not null references public.task_operations(codigo),
  nombre text not null check (char_length(trim(nombre)) between 1 and 120),
  frecuencia text not null check (frecuencia in ('manual', 'una_vez', 'diaria', 'semanal', 'mensual')),
  dia int check (dia between 1 and 31),
  hora time not null default '09:00',
  zona text not null default 'America/Argentina/Buenos_Aires',
  modo text not null default 'ambas' check (modo in ('automatica', 'manual', 'ambas')),
  periodo_regla text not null default 'mes_anterior' check (periodo_regla in ('mes_anterior', 'mes_actual')),
  reintentos_max int not null default 3 check (reintentos_max between 0 and 10),
  reintento_intervalo_min int not null default 15 check (reintento_intervalo_min between 1 and 1440),
  parametros jsonb not null default '{}'::jsonb check (jsonb_typeof(parametros) = 'object'),
  activa boolean not null default true,
  proxima_ejecucion timestamptz,
  ultima_ejecucion timestamptz,
  creado_por uuid not null references auth.users(id) on delete restrict,
  creado_en timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  check (frecuencia not in ('semanal', 'mensual') or dia is not null),
  check (frecuencia <> 'semanal' or dia between 1 and 7),
  check ((frecuencia = 'manual') = (modo = 'manual'))
);
create index task_definitions_cliente on public.task_definitions (tenant_id, client_id);
create index task_definitions_proxima on public.task_definitions (proxima_ejecucion) where activa and proxima_ejecucion is not null;
create index task_definitions_operacion on public.task_definitions (operacion);
create index task_definitions_creado_por on public.task_definitions (creado_por);

-- ---------- Ejecuciones ----------
create table public.task_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  task_id uuid not null,
  client_id uuid not null,
  estado text not null default 'pendiente'
    check (estado in ('programada', 'pendiente', 'ejecutando', 'completada', 'completada_parcialmente', 'fallida', 'cancelada')),
  disparador text not null check (disparador in ('automatico', 'manual')),
  iniciado_por uuid references auth.users(id) on delete restrict,
  origen_run_id uuid,
  periodo text check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  programada_para timestamptz not null default now(),
  intento int not null default 0,
  intentos_max int not null check (intentos_max between 1 and 11),
  proximo_intento timestamptz,
  iniciado_en timestamptz,
  finalizado_en timestamptz,
  lease_hasta timestamptz,
  resultado jsonb not null default '{}'::jsonb,
  error text,
  creado_en timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, task_id) references public.task_definitions (tenant_id, id) on delete restrict,
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  foreign key (tenant_id, origen_run_id) references public.task_runs (tenant_id, id) on delete restrict
);
-- Una tarea nunca tiene dos ejecuciones activas a la vez, y un horario programado no se ejecuta dos veces.
create unique index task_runs_una_activa on public.task_runs (task_id) where estado in ('pendiente', 'ejecutando');
create unique index task_runs_horario on public.task_runs (task_id, programada_para) where disparador = 'automatico';
create index task_runs_cliente on public.task_runs (tenant_id, client_id, creado_en desc);
create index task_runs_tarea on public.task_runs (tenant_id, task_id, creado_en desc);
create index task_runs_cola on public.task_runs (estado, proximo_intento) where estado in ('pendiente', 'ejecutando');
create index task_runs_iniciado_por on public.task_runs (iniciado_por) where iniciado_por is not null;
create index task_runs_origen on public.task_runs (tenant_id, origen_run_id) where origen_run_id is not null;

create table public.task_run_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  client_id uuid not null,
  run_id uuid not null,
  nivel text not null check (nivel in ('info', 'aviso', 'error')),
  mensaje text not null,
  detalle jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  foreign key (tenant_id, run_id) references public.task_runs (tenant_id, id) on delete restrict
);
create index task_run_events_run on public.task_run_events (tenant_id, run_id, id);

-- ---------- Agenda ----------
create table public.agenda_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  client_id uuid,
  tipo text not null check (tipo in ('vencimiento', 'recordatorio', 'control', 'recategorizacion', 'otro')),
  titulo text not null check (char_length(trim(titulo)) between 1 and 200),
  detalle text check (detalle is null or char_length(detalle) <= 1000),
  fecha_limite date not null,
  prioridad text not null default 'media' check (prioridad in ('baja', 'media', 'alta')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'hecho', 'descartado')),
  responsable uuid references auth.users(id) on delete set null,
  origen text not null default 'manual' check (origen in ('manual', 'tarea')),
  run_id uuid,
  creado_por uuid references auth.users(id) on delete set null,
  creado_en timestamptz not null default now(),
  resuelto_por uuid references auth.users(id) on delete set null,
  resuelto_en timestamptz,
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  foreign key (tenant_id, run_id) references public.task_runs (tenant_id, id) on delete restrict
);
create unique index agenda_items_sin_duplicar on public.agenda_items (tenant_id, client_id, tipo, titulo, fecha_limite) where origen = 'tarea';
create index agenda_items_fecha on public.agenda_items (tenant_id, estado, fecha_limite);
create index agenda_items_cliente on public.agenda_items (tenant_id, client_id) where client_id is not null;
create index agenda_items_run on public.agenda_items (tenant_id, run_id) where run_id is not null;
create index agenda_items_responsable on public.agenda_items (responsable) where responsable is not null;
create index agenda_items_creado_por on public.agenda_items (creado_por) where creado_por is not null;
create index agenda_items_resuelto_por on public.agenda_items (resuelto_por) where resuelto_por is not null;

-- Al resolver un item queda quien y cuando
create or replace function private.agenda_resolver() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.estado <> old.estado then
    if new.estado = 'pendiente' then
      new.resuelto_por := null; new.resuelto_en := null;
    else
      new.resuelto_por := (select auth.uid()); new.resuelto_en := now();
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.agenda_resolver() from public, anon;
create trigger agenda_resolver before update on public.agenda_items
  for each row execute function private.agenda_resolver();

-- ---------- RLS ----------
alter table public.task_operations enable row level security;
alter table public.task_definitions enable row level security;
alter table public.task_runs enable row level security;
alter table public.task_run_events enable row level security;
alter table public.agenda_items enable row level security;

revoke all on public.task_operations, public.task_definitions, public.task_runs, public.task_run_events, public.agenda_items
  from anon, authenticated, public;
grant select on public.task_operations, public.task_definitions, public.task_runs, public.task_run_events to authenticated;
grant select, insert, delete on public.agenda_items to authenticated;
grant update (estado, prioridad, detalle, responsable) on public.agenda_items to authenticated;

create policy operaciones_ver on public.task_operations for select to authenticated using (true);
create policy tareas_ver on public.task_definitions for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy ejecuciones_ver on public.task_runs for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy eventos_ver on public.task_run_events for select to authenticated
  using (private.can_see_client(tenant_id, client_id));

create policy agenda_ver on public.agenda_items for select to authenticated
  using ((client_id is null and private.is_member(tenant_id))
      or (client_id is not null and private.can_see_client(tenant_id, client_id)));
create policy agenda_crear on public.agenda_items for insert to authenticated
  with check (origen = 'manual' and run_id is null and estado = 'pendiente'
      and creado_por = (select auth.uid())
      and private.has_permission(tenant_id, 'tareas.gestionar')
      and (client_id is null or private.can_see_client(tenant_id, client_id)));
create policy agenda_editar on public.agenda_items for update to authenticated
  using (private.has_permission(tenant_id, 'tareas.gestionar')
      and ((client_id is null and private.is_member(tenant_id)) or (client_id is not null and private.can_see_client(tenant_id, client_id))))
  with check (private.has_permission(tenant_id, 'tareas.gestionar'));
create policy agenda_borrar on public.agenda_items for delete to authenticated
  using (origen = 'manual' and private.has_permission(tenant_id, 'tareas.gestionar')
      and ((client_id is null and private.is_member(tenant_id)) or (client_id is not null and private.can_see_client(tenant_id, client_id))));

-- Auditoria de cambios en tareas y agenda
create trigger audit_task_definitions after insert or update or delete on public.task_definitions
  for each row execute function private.audit_trigger();
create trigger audit_agenda_items after insert or update or delete on public.agenda_items
  for each row execute function private.audit_trigger();
