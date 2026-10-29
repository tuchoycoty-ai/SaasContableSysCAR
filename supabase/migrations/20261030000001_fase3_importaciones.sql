-- Fase 3: importaciones (comprobantes y pagos) y resumen para el tablero.
-- Reglas:
--  * Nadie escribe directo en estas tablas: todo pasa por funciones que validan permiso, cliente y datos.
--  * Cada fila lleva su estado: importado | pendiente_validacion | confirmado.
--  * Un lote solo se puede anular con una operacion explicita (admin + motivo) que queda auditada.

-- ---------- Permiso nuevo ----------
insert into public.permissions (code, descripcion)
values ('importaciones.gestionar', 'Importar archivos de comprobantes y pagos, y validar los lotes importados')
on conflict (code) do nothing;

-- Los roles "Contador" que ya existen reciben el permiso
insert into public.role_permissions (role_id, permission_code)
select r.id, 'importaciones.gestionar' from public.roles r
where r.nombre = 'Contador' and not r.es_admin
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
    values (v_contador, 'clientes.editar'), (v_contador, 'importaciones.gestionar');
  return v_tenant;
end $$;

-- ---------- Tablas ----------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  client_id uuid not null,
  tipo text not null check (tipo in ('comprobantes_emitidos', 'comprobantes_recibidos', 'pagos')),
  archivo_nombre text not null check (char_length(archivo_nombre) between 1 and 200),
  archivo_hash text not null check (archivo_hash ~ '^[0-9a-f]{64}$'),
  estado text not null default 'importado' check (estado in ('importado', 'validado', 'anulado')),
  filas_total int not null default 0,
  filas_importadas int not null default 0,
  filas_duplicadas int not null default 0,
  filas_rechazadas int not null default 0,
  filas_pendientes int not null default 0,
  informe jsonb not null default '[]'::jsonb,   -- primeras filas rechazadas/duplicadas con su motivo
  creado_por uuid not null references auth.users(id) on delete restrict,
  creado_en timestamptz not null default now(),
  validado_por uuid references auth.users(id) on delete restrict,
  validado_en timestamptz,
  anulado_por uuid references auth.users(id) on delete restrict,
  anulado_en timestamptz,
  motivo_anulacion text,
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict
);
-- El mismo archivo no se puede importar dos veces mientras su lote siga vigente
create unique index import_batches_archivo_vigente
  on public.import_batches (tenant_id, client_id, tipo, archivo_hash) where estado <> 'anulado';
create index import_batches_cliente on public.import_batches (tenant_id, client_id, creado_en desc);
create index import_batches_creado_por on public.import_batches (creado_por);
create index import_batches_validado_por on public.import_batches (validado_por) where validado_por is not null;
create index import_batches_anulado_por on public.import_batches (anulado_por) where anulado_por is not null;

create table public.comprobantes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  batch_id uuid not null,
  sentido text not null check (sentido in ('emitido', 'recibido')),
  fecha date not null,
  tipo_cbte int not null check (tipo_cbte between 1 and 999),
  punto_venta int not null check (punto_venta between 1 and 99999),
  numero bigint not null check (numero >= 1),
  doc_contraparte text check (doc_contraparte is null or doc_contraparte ~ '^[0-9]{1,11}$'),
  contraparte text check (contraparte is null or char_length(contraparte) <= 200),
  moneda text not null default 'PES' check (char_length(moneda) between 1 and 5),
  tipo_cambio numeric(16,6),
  neto_gravado numeric(16,2) not null default 0,
  neto_no_gravado numeric(16,2) not null default 0,
  exento numeric(16,2) not null default 0,
  iva numeric(16,2) not null default 0,
  otros_tributos numeric(16,2) not null default 0,
  total numeric(16,2) not null,
  nota_credito boolean not null default false,
  estado_dato text not null default 'importado' check (estado_dato in ('importado', 'pendiente_validacion', 'confirmado')),
  advertencia text,
  creado_en timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  foreign key (tenant_id, batch_id) references public.import_batches (tenant_id, id) on delete restrict
);
-- Detector de duplicados: mismo cliente, sentido, tipo, punto de venta y numero
-- (en recibidos tambien el emisor, porque cada emisor numera por su cuenta).
create unique index comprobantes_unico on public.comprobantes
  (client_id, sentido, tipo_cbte, punto_venta, numero,
   (case when sentido = 'recibido' then coalesce(doc_contraparte, '') else '' end));
create index comprobantes_periodo on public.comprobantes (tenant_id, client_id, fecha);
create index comprobantes_lote on public.comprobantes (tenant_id, batch_id);

create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  batch_id uuid not null,
  fecha date not null,
  concepto text not null check (char_length(concepto) between 1 and 200),
  impuesto text check (impuesto is null or char_length(impuesto) <= 100),
  medio text check (medio is null or char_length(medio) <= 100),
  referencia text check (referencia is null or char_length(referencia) <= 100),
  importe numeric(16,2) not null check (importe > 0),
  estado_dato text not null default 'importado' check (estado_dato in ('importado', 'pendiente_validacion', 'confirmado')),
  advertencia text,
  creado_en timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.clients (tenant_id, id) on delete restrict,
  foreign key (tenant_id, batch_id) references public.import_batches (tenant_id, id) on delete restrict
);
create unique index pagos_unico on public.pagos
  (client_id, fecha, importe, lower(concepto), coalesce(referencia, ''));
create index pagos_periodo on public.pagos (tenant_id, client_id, fecha);
create index pagos_lote on public.pagos (tenant_id, batch_id);

-- ---------- RLS: solo lectura directa; escribir solo por funciones ----------
alter table public.import_batches enable row level security;
alter table public.comprobantes enable row level security;
alter table public.pagos enable row level security;

revoke all on public.import_batches, public.comprobantes, public.pagos from anon, authenticated, public;
grant select on public.import_batches, public.comprobantes, public.pagos to authenticated;

create policy lotes_ver on public.import_batches for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy comprobantes_ver on public.comprobantes for select to authenticated
  using (private.can_see_client(tenant_id, client_id));
create policy pagos_ver on public.pagos for select to authenticated
  using (private.can_see_client(tenant_id, client_id));

-- ---------- Auditoria liviana de lotes (no copia el informe completo) ----------
create or replace function private.audit_lote() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  v := to_jsonb(new) - 'informe';
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (new.tenant_id, (select auth.uid()), tg_op, 'import_batches', 'ok', jsonb_build_object('fila', v));
  return null;
end $$;
revoke execute on function private.audit_lote() from public, anon;

create trigger audit_import_batches after insert or update on public.import_batches
  for each row execute function private.audit_lote();

-- ---------- Utilidades ----------
create or replace function private.es_nota_credito(p_tipo int) returns boolean
language sql immutable set search_path = '' as $$
  select p_tipo in (3, 8, 13, 21, 43, 53, 110, 112, 113, 114, 119, 203, 208, 213)
$$;

-- ---------- Duplicados: que filas del archivo ya existen en la base ----------
create or replace function public.filas_existentes(p_tenant uuid, p_client uuid, p_tipo text, p_filas jsonb)
returns int[] language plpgsql stable set search_path = '' as $$
declare r int[];
begin
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) > 5000 then
    raise exception 'Archivo demasiado grande (máximo 5000 filas por importación)' using errcode = 'P0001';
  end if;
  if p_tipo in ('comprobantes_emitidos', 'comprobantes_recibidos') then
    select coalesce(array_agg(f.fila), '{}') into r
    from jsonb_to_recordset(p_filas) as f(fila int, tipo_cbte int, punto_venta int, numero bigint, doc text)
    where exists (
      select 1 from public.comprobantes c
      where c.tenant_id = p_tenant and c.client_id = p_client
        and c.sentido = case when p_tipo = 'comprobantes_emitidos' then 'emitido' else 'recibido' end
        and c.tipo_cbte = f.tipo_cbte and c.punto_venta = f.punto_venta and c.numero = f.numero
        and (p_tipo = 'comprobantes_emitidos' or coalesce(c.doc_contraparte, '') = coalesce(f.doc, '')));
  elsif p_tipo = 'pagos' then
    select coalesce(array_agg(f.fila), '{}') into r
    from jsonb_to_recordset(p_filas) as f(fila int, fecha date, importe numeric, concepto text, referencia text)
    where exists (
      select 1 from public.pagos p
      where p.tenant_id = p_tenant and p.client_id = p_client and p.fecha = f.fecha
        and p.importe = f.importe and lower(p.concepto) = lower(f.concepto)
        and coalesce(p.referencia, '') = coalesce(f.referencia, ''));
  else
    raise exception 'Tipo de importación inválido' using errcode = 'P0001';
  end if;
  return r;
end $$;

-- ---------- Confirmar importacion (atomica) ----------
create or replace function private.confirmar_importacion(
  p_tenant uuid, p_client uuid, p_tipo text, p_archivo text, p_hash text,
  p_filas jsonb, p_rechazos jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_lote uuid;
  v_f jsonb;
  v_ok int := 0; v_dup int := 0; v_rech int := 0; v_pend int := 0;
  v_informe jsonb := '[]'::jsonb;
  v_n int := 0;
  v_fila int;
  v_new uuid;
  v_fecha date;
  v_tipo int; v_pv int; v_num bigint;
  v_nc boolean; v_sg int;
  v_ng numeric; v_nn numeric; v_ex numeric; v_iva numeric; v_ot numeric; v_tot numeric;
  v_doc text; v_nombre text; v_moneda text; v_tc numeric;
  v_estado text; v_adv text;
  v_imp numeric; v_conc text; v_ref text;
  c record;
begin
  if v_uid is null then raise exception 'Sesión no válida' using errcode = '42501'; end if;
  if not (private.has_permission(p_tenant, 'importaciones.gestionar') and private.can_see_client(p_tenant, p_client)) then
    raise exception 'No tenés permiso para importar datos de este cliente' using errcode = '42501';
  end if;
  if p_tipo not in ('comprobantes_emitidos', 'comprobantes_recibidos', 'pagos') then
    raise exception 'Tipo de importación inválido' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_filas) <> 'array' or jsonb_typeof(p_rechazos) <> 'array' then
    raise exception 'Formato de datos inválido' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) + jsonb_array_length(p_rechazos) > 5000 then
    raise exception 'Archivo demasiado grande (máximo 5000 filas por importación)' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) = 0 then
    raise exception 'No hay filas válidas para importar' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.import_batches b
             where b.tenant_id = p_tenant and b.client_id = p_client and b.tipo = p_tipo
               and b.archivo_hash = p_hash and b.estado <> 'anulado') then
    raise exception 'Este mismo archivo ya fue importado para este cliente. Si querés reprocesarlo, un administrador debe anular el lote anterior.'
      using errcode = 'P0001';
  end if;

  insert into public.import_batches (tenant_id, client_id, tipo, archivo_nombre, archivo_hash, creado_por)
  values (p_tenant, p_client, p_tipo, left(p_archivo, 200), p_hash, v_uid)
  returning id into v_lote;

  -- Rechazos detectados en el navegador (se conservan con su motivo)
  for c in select * from jsonb_array_elements(p_rechazos) as e(x) loop
    v_rech := v_rech + 1;
    if v_n < 300 then
      v_informe := v_informe || jsonb_build_object('fila', c.x->'fila', 'tipo', 'rechazo', 'motivo', left(coalesce(c.x->>'motivo', 'Fila inválida'), 200));
      v_n := v_n + 1;
    end if;
  end loop;

  for v_f in select * from jsonb_array_elements(p_filas) loop
    v_fila := coalesce((v_f->>'fila')::int, 0);
    v_new := null; v_estado := 'importado'; v_adv := null;
    begin
      v_fecha := (v_f->>'fecha')::date;
      if v_fecha < date '2000-01-01' or v_fecha > current_date + 365 then
        raise exception 'Fecha fuera de rango' using errcode = 'P0001';
      end if;

      if p_tipo = 'pagos' then
        v_imp := (v_f->>'importe')::numeric;
        v_conc := nullif(trim(coalesce(v_f->>'concepto', '')), '');
        v_ref := nullif(trim(coalesce(v_f->>'referencia', '')), '');
        if v_imp is null or v_imp <= 0 or v_imp >= 1e13 then
          raise exception 'Importe inválido (debe ser mayor a cero)' using errcode = 'P0001';
        end if;
        if v_conc is null then raise exception 'Falta el concepto' using errcode = 'P0001'; end if;
        insert into public.pagos (tenant_id, client_id, batch_id, fecha, concepto, impuesto, medio, referencia, importe, estado_dato, advertencia)
        values (p_tenant, p_client, v_lote, v_fecha, left(v_conc, 200),
                left(nullif(trim(coalesce(v_f->>'impuesto', '')), ''), 100),
                left(nullif(trim(coalesce(v_f->>'medio', '')), ''), 100),
                left(v_ref, 100), v_imp, 'importado', null)
        on conflict do nothing
        returning id into v_new;
      else
        v_tipo := (v_f->>'tipo_cbte')::int;
        v_pv := (v_f->>'punto_venta')::int;
        v_num := (v_f->>'numero')::bigint;
        if v_tipo is null or v_tipo < 1 or v_tipo > 999 then raise exception 'Tipo de comprobante inválido' using errcode = 'P0001'; end if;
        if v_pv is null or v_pv < 1 or v_pv > 99999 then raise exception 'Punto de venta inválido' using errcode = 'P0001'; end if;
        if v_num is null or v_num < 1 then raise exception 'Número de comprobante inválido' using errcode = 'P0001'; end if;
        v_nc := private.es_nota_credito(v_tipo);
        v_sg := case when v_nc then -1 else 1 end;
        v_ng := abs(coalesce((v_f->>'neto_gravado')::numeric, 0)) * v_sg;
        v_nn := abs(coalesce((v_f->>'neto_no_gravado')::numeric, 0)) * v_sg;
        v_ex := abs(coalesce((v_f->>'exento')::numeric, 0)) * v_sg;
        v_iva := abs(coalesce((v_f->>'iva')::numeric, 0)) * v_sg;
        v_ot := abs(coalesce((v_f->>'otros_tributos')::numeric, 0)) * v_sg;
        v_tot := abs((v_f->>'total')::numeric) * v_sg;
        if abs(v_ng) >= 1e13 or abs(v_nn) >= 1e13 or abs(v_ex) >= 1e13 or abs(v_iva) >= 1e13 or abs(v_ot) >= 1e13 or abs(v_tot) >= 1e13 then
          raise exception 'Importe fuera de rango' using errcode = 'P0001';
        end if;
        v_doc := nullif(regexp_replace(coalesce(v_f->>'doc', ''), '\D', '', 'g'), '');
        v_nombre := left(nullif(trim(coalesce(v_f->>'contraparte', '')), ''), 200);
        v_moneda := upper(left(coalesce(nullif(trim(v_f->>'moneda'), ''), 'PES'), 5));
        v_tc := nullif(v_f->>'tipo_cambio', '')::numeric;

        if abs(v_tot - (v_ng + v_nn + v_ex + v_iva + v_ot)) > 1.00 then
          v_estado := 'pendiente_validacion';
          v_adv := 'El total no coincide con la suma de netos, IVA y otros tributos';
        elsif v_doc is not null and length(v_doc) = 11 and not private.cuit_valido(v_doc) then
          v_estado := 'pendiente_validacion';
          v_adv := 'El CUIT de la contraparte no es válido';
        elsif v_moneda <> 'PES' then
          v_estado := 'pendiente_validacion';
          v_adv := 'Moneda extranjera: verificá que los importes estén en pesos';
        end if;

        insert into public.comprobantes (tenant_id, client_id, batch_id, sentido, fecha, tipo_cbte, punto_venta, numero,
          doc_contraparte, contraparte, moneda, tipo_cambio, neto_gravado, neto_no_gravado, exento, iva, otros_tributos,
          total, nota_credito, estado_dato, advertencia)
        values (p_tenant, p_client, v_lote,
          case when p_tipo = 'comprobantes_emitidos' then 'emitido' else 'recibido' end,
          v_fecha, v_tipo, v_pv, v_num, v_doc, v_nombre, v_moneda, v_tc,
          v_ng, v_nn, v_ex, v_iva, v_ot, v_tot, v_nc, v_estado, v_adv)
        on conflict do nothing
        returning id into v_new;
      end if;

      if v_new is null then
        v_dup := v_dup + 1;
        if v_n < 300 then
          v_informe := v_informe || jsonb_build_object('fila', v_fila, 'tipo', 'duplicado', 'motivo', 'Ya existe en la base (duplicado)');
          v_n := v_n + 1;
        end if;
      else
        v_ok := v_ok + 1;
        if v_estado = 'pendiente_validacion' then v_pend := v_pend + 1; end if;
      end if;
    exception when others then
      v_rech := v_rech + 1;
      if v_n < 300 then
        v_informe := v_informe || jsonb_build_object('fila', v_fila, 'tipo', 'rechazo',
          'motivo', case when sqlstate = 'P0001' then sqlerrm else 'Dato con formato inválido' end);
        v_n := v_n + 1;
      end if;
    end;
  end loop;

  if v_ok = 0 then
    -- Nada que guardar: se deshace todo, incluido el lote
    raise exception 'Ninguna fila se pudo importar (% duplicadas, % rechazadas). No se guardó nada.', v_dup, v_rech
      using errcode = 'P0001';
  end if;

  update public.import_batches
     set filas_total = jsonb_array_length(p_filas) + jsonb_array_length(p_rechazos),
         filas_importadas = v_ok, filas_duplicadas = v_dup, filas_rechazadas = v_rech,
         filas_pendientes = v_pend, informe = v_informe
   where id = v_lote;

  return jsonb_build_object('lote_id', v_lote, 'importadas', v_ok, 'duplicadas', v_dup,
                            'rechazadas', v_rech, 'pendientes', v_pend);
end $$;

create or replace function public.confirmar_importacion(
  p_tenant uuid, p_client uuid, p_tipo text, p_archivo text, p_hash text, p_filas jsonb, p_rechazos jsonb default '[]'::jsonb)
returns jsonb language sql set search_path = '' as $$
  select private.confirmar_importacion(p_tenant, p_client, p_tipo, p_archivo, p_hash, p_filas, p_rechazos)
$$;

-- ---------- Validar lote: pasa las filas a "confirmado" ----------
create or replace function private.validar_lote(p_lote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.import_batches%rowtype;
begin
  select * into b from public.import_batches where id = p_lote;
  if not found or not private.can_see_client(b.tenant_id, b.client_id) then
    raise exception 'Lote no encontrado' using errcode = 'P0001';
  end if;
  if not private.has_permission(b.tenant_id, 'importaciones.gestionar') then
    raise exception 'No tenés permiso para validar importaciones' using errcode = '42501';
  end if;
  if b.estado <> 'importado' then
    raise exception 'Solo se pueden validar lotes en estado importado' using errcode = 'P0001';
  end if;
  update public.comprobantes set estado_dato = 'confirmado' where tenant_id = b.tenant_id and batch_id = b.id;
  update public.pagos set estado_dato = 'confirmado' where tenant_id = b.tenant_id and batch_id = b.id;
  update public.import_batches set estado = 'validado', validado_por = (select auth.uid()), validado_en = now()
   where id = b.id;
end $$;

create or replace function public.validar_lote(p_lote uuid) returns void
language sql set search_path = '' as $$ select private.validar_lote(p_lote) $$;

-- ---------- Anular lote: operacion explicita, solo admin, con motivo ----------
create or replace function private.anular_lote(p_lote uuid, p_motivo text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.import_batches%rowtype; v_c int; v_p int;
begin
  select * into b from public.import_batches where id = p_lote;
  if not found or not private.can_see_client(b.tenant_id, b.client_id) then
    raise exception 'Lote no encontrado' using errcode = 'P0001';
  end if;
  if not private.is_tenant_admin(b.tenant_id) then
    raise exception 'Solo un administrador del estudio puede anular un lote' using errcode = '42501';
  end if;
  if b.estado = 'anulado' then
    raise exception 'El lote ya estaba anulado' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_motivo, ''))) < 5 then
    raise exception 'Indicá el motivo de la anulación (mínimo 5 caracteres)' using errcode = 'P0001';
  end if;
  delete from public.comprobantes where tenant_id = b.tenant_id and batch_id = b.id;
  get diagnostics v_c = row_count;
  delete from public.pagos where tenant_id = b.tenant_id and batch_id = b.id;
  get diagnostics v_p = row_count;
  update public.import_batches
     set estado = 'anulado', anulado_por = (select auth.uid()), anulado_en = now(), motivo_anulacion = trim(p_motivo)
   where id = b.id;
  insert into public.audit_log (tenant_id, actor_id, accion, objeto, resultado, detalle)
  values (b.tenant_id, (select auth.uid()), 'ANULAR_LOTE', 'import_batches', 'ok',
          jsonb_build_object('lote', b.id, 'estado_previo', b.estado, 'comprobantes_borrados', v_c,
                             'pagos_borrados', v_p, 'motivo', trim(p_motivo)));
end $$;

create or replace function public.anular_lote(p_lote uuid, p_motivo text) returns void
language sql set search_path = '' as $$ select private.anular_lote(p_lote, p_motivo) $$;

-- ---------- Resumen mensual para el tablero (respeta RLS: invoker) ----------
create or replace function public.resumen_mensual(p_tenant uuid, p_client uuid, p_desde date, p_hasta date)
returns table (mes date, rubro text, estado_dato text, cantidad bigint, neto numeric, iva numeric, total numeric)
language sql stable set search_path = '' as $$
  select date_trunc('month', c.fecha)::date, c.sentido, c.estado_dato, count(*),
         sum(c.neto_gravado + c.neto_no_gravado + c.exento), sum(c.iva), sum(c.total)
  from public.comprobantes c
  where c.tenant_id = p_tenant and c.client_id = p_client and c.fecha between p_desde and p_hasta
  group by 1, 2, 3
  union all
  select date_trunc('month', p.fecha)::date, 'pago', p.estado_dato, count(*), sum(p.importe), 0::numeric, sum(p.importe)
  from public.pagos p
  where p.tenant_id = p_tenant and p.client_id = p_client and p.fecha between p_desde and p_hasta
  group by 1, 2, 3
$$;

-- ---------- Permisos de ejecucion ----------
revoke execute on function private.es_nota_credito(int), private.confirmar_importacion(uuid, uuid, text, text, text, jsonb, jsonb),
  private.validar_lote(uuid), private.anular_lote(uuid, text) from public, anon;
grant execute on function private.es_nota_credito(int), private.confirmar_importacion(uuid, uuid, text, text, text, jsonb, jsonb),
  private.validar_lote(uuid), private.anular_lote(uuid, text) to authenticated;
revoke execute on function public.filas_existentes(uuid, uuid, text, jsonb),
  public.confirmar_importacion(uuid, uuid, text, text, text, jsonb, jsonb),
  public.validar_lote(uuid), public.anular_lote(uuid, text),
  public.resumen_mensual(uuid, uuid, date, date) from public, anon;
grant execute on function public.filas_existentes(uuid, uuid, text, jsonb),
  public.confirmar_importacion(uuid, uuid, text, text, text, jsonb, jsonb),
  public.validar_lote(uuid), public.anular_lote(uuid, text),
  public.resumen_mensual(uuid, uuid, date, date) to authenticated;
