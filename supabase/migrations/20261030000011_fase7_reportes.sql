-- Fase 7 · Reportes: mayores contrapartes y resumen de cartera.
-- Son funciones de LECTURA que corren con los permisos de quien consulta (security invoker):
-- las reglas de acceso (RLS) de comprobantes y clientes siguen decidiendo que filas se ven.

create or replace function public.top_contrapartes(p_tenant uuid, p_client uuid, p_desde date, p_hasta date, p_sentido text, p_limite int default 5)
returns table (doc text, nombre text, cantidad bigint, neto numeric, total numeric)
language sql stable set search_path = '' as $$
  select coalesce(c.doc_contraparte, ''), max(c.contraparte), count(*),
         sum(c.neto_gravado + c.neto_no_gravado + c.exento), sum(c.total)
  from public.comprobantes c
  where c.tenant_id = p_tenant and c.client_id = p_client and c.fecha between p_desde and p_hasta and c.sentido = p_sentido
  group by coalesce(c.doc_contraparte, '')
  order by sum(c.neto_gravado + c.neto_no_gravado + c.exento) desc
  limit least(greatest(coalesce(p_limite, 5), 1), 50)
$$;

create or replace function public.resumen_cartera(p_tenant uuid, p_desde date, p_hasta date)
returns table (client_id uuid, razon_social text, cuit text, regimen text, emitidos_neto numeric, recibidos_neto numeric,
               iva_debito numeric, iva_credito numeric, cantidad bigint, sin_confirmar bigint)
language sql stable set search_path = '' as $$
  select cl.id, cl.razon_social, cl.cuit, cl.regimen,
         coalesce(sum(c.neto_gravado + c.neto_no_gravado + c.exento) filter (where c.sentido = 'emitido'), 0),
         coalesce(sum(c.neto_gravado + c.neto_no_gravado + c.exento) filter (where c.sentido = 'recibido'), 0),
         coalesce(sum(c.iva) filter (where c.sentido = 'emitido'), 0),
         coalesce(sum(c.iva) filter (where c.sentido = 'recibido'), 0),
         count(c.id),
         count(c.id) filter (where c.estado_dato <> 'confirmado')
  from public.clients cl
  left join public.comprobantes c on c.tenant_id = cl.tenant_id and c.client_id = cl.id and c.fecha between p_desde and p_hasta
  where cl.tenant_id = p_tenant and cl.activo
  group by cl.id, cl.razon_social, cl.cuit, cl.regimen
  order by cl.razon_social
$$;

revoke execute on function public.top_contrapartes(uuid, uuid, date, date, text, int), public.resumen_cartera(uuid, date, date) from public, anon;
grant execute on function public.top_contrapartes(uuid, uuid, date, date, text, int), public.resumen_cartera(uuid, date, date) to authenticated;
