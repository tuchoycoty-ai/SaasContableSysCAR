// Edge Function: invitar-usuario
// Es el UNICO lugar donde se usa la clave service_role (la inyecta Supabase en el servidor;
// nunca viaja al navegador). Antes de hacer nada verifica quien llama y si tiene permiso.
//
// POST { accion: 'invitar', tenant_id, email, role_id }
//   -> agrega a la persona al estudio. Si todavia no tiene cuenta, devuelve un enlace de
//      invitacion para que defina su contrasena (no se envia mail: lo comparte quien invita).
// POST { accion: 'enlace', tenant_id, user_id }
//   -> genera un nuevo enlace de acceso para un miembro que perdio el suyo. Solo funciona si
//      esa persona pertenece UNICAMENTE a este estudio (evita tomar cuentas de otros estudios).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json({ error: 'El servidor no está configurado.' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Necesitás iniciar sesión.' }, 401)

  // 1) Quien llama (se valida el token contra el servicio de autenticacion)
  const porUsuario = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: sesion, error: errSesion } = await porUsuario.auth.getUser()
  if (errSesion || !sesion.user) return json({ error: 'La sesión no es válida.' }, 401)
  const yo = sesion.user.id

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Pedido inválido.' }, 400)
  }
  const accion = String(body.accion ?? '')
  const tenantId = String(body.tenant_id ?? '')
  if (!UUID.test(tenantId)) return json({ error: 'Estudio inválido.' }, 400)

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })

  try {
    // 2) El estudio debe estar activo y quien llama debe ser holding o administrador de ese estudio
    const { data: estudio } = await admin.from('tenants').select('id, estado').eq('id', tenantId).maybeSingle()
    if (!estudio) return json({ error: 'No se encontró el estudio.' }, 404)
    if (estudio.estado !== 'activo') return json({ error: 'El estudio está suspendido.' }, 403)

    const { data: esHolding } = await admin.from('platform_admins').select('user_id').eq('user_id', yo).maybeSingle()
    let autorizado = Boolean(esHolding)
    if (!autorizado) {
      const { data: miMembresia } = await admin
        .from('memberships').select('role_id').eq('tenant_id', tenantId).eq('user_id', yo).maybeSingle()
      if (miMembresia) {
        const { data: miRol } = await admin
          .from('roles').select('es_admin').eq('tenant_id', tenantId).eq('id', miMembresia.role_id).maybeSingle()
        autorizado = Boolean(miRol?.es_admin)
      }
    }
    if (!autorizado) return json({ error: 'No tenés permiso para administrar usuarios de este estudio.' }, 403)

    const origen = req.headers.get('Origin')
    const redirectTo = origen && /^https:\/\/|^http:\/\/localhost/.test(origen) ? origen : undefined

    // 3a) Invitar
    if (accion === 'invitar') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const roleId = String(body.role_id ?? '')
      if (!EMAIL.test(email) || email.length > 254) return json({ error: 'El email no es válido.' }, 400)
      if (!UUID.test(roleId)) return json({ error: 'Rol inválido.' }, 400)

      const { data: rol } = await admin
        .from('roles').select('id').eq('id', roleId).eq('tenant_id', tenantId).maybeSingle()
      if (!rol) return json({ error: 'Ese rol no pertenece al estudio.' }, 400)

      const { data: existente } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()

      if (existente) {
        const { error } = await admin
          .from('memberships').insert({ tenant_id: tenantId, user_id: existente.id, role_id: roleId })
        if (error) {
          return json({ error: error.code === '23505' ? 'Esa persona ya pertenece al estudio.' : 'No se pudo agregar a la persona.' }, 409)
        }
        await admin.from('audit_log').insert({
          tenant_id: tenantId, actor_id: yo, accion: 'INVITAR', objeto: 'memberships',
          resultado: 'ok', detalle: { email, role_id: roleId, cuenta_existente: true },
        })
        return json({ ok: true, existente: true })
      }

      const { data: link, error: errLink } = await admin.auth.admin.generateLink({
        type: 'invite', email, options: { redirectTo },
      })
      if (errLink || !link?.user || !link.properties?.action_link) {
        console.error('generateLink invite', errLink?.message)
        return json({ error: 'No se pudo generar la invitación.' }, 500)
      }
      const { error: errMiembro } = await admin
        .from('memberships').insert({ tenant_id: tenantId, user_id: link.user.id, role_id: roleId })
      if (errMiembro) {
        await admin.auth.admin.deleteUser(link.user.id) // no dejar cuentas huerfanas
        console.error('membership', errMiembro.message)
        return json({ error: 'No se pudo agregar a la persona al estudio.' }, 500)
      }
      await admin.from('audit_log').insert({
        tenant_id: tenantId, actor_id: yo, accion: 'INVITAR', objeto: 'memberships',
        resultado: 'ok', detalle: { email, role_id: roleId, cuenta_existente: false },
      })
      return json({ ok: true, existente: false, enlace: link.properties.action_link })
    }

    // 3b) Nuevo enlace de acceso para un miembro
    if (accion === 'enlace') {
      const userId = String(body.user_id ?? '')
      if (!UUID.test(userId)) return json({ error: 'Usuario inválido.' }, 400)

      const { data: esMiembro } = await admin
        .from('memberships').select('user_id').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle()
      if (!esMiembro) return json({ error: 'Esa persona no pertenece al estudio.' }, 404)

      const { count: enOtros } = await admin
        .from('memberships').select('user_id', { count: 'exact', head: true })
        .eq('user_id', userId).neq('tenant_id', tenantId)
      const { data: esAdminPlataforma } = await admin
        .from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle()
      if ((enOtros ?? 0) > 0 || esAdminPlataforma) {
        return json({ error: 'Esa persona tiene acceso a otros estudios. Tiene que usar “Olvidé mi contraseña” desde su propio email.' }, 403)
      }

      const { data: perfil } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle()
      const { data: cuenta } = await admin.auth.admin.getUserById(userId)
      if (!perfil?.email || !cuenta?.user) return json({ error: 'No se encontró la cuenta.' }, 404)

      const { data: link, error: errLink } = await admin.auth.admin.generateLink({
        type: cuenta.user.email_confirmed_at ? 'recovery' : 'invite',
        email: perfil.email,
        options: { redirectTo },
      })
      if (errLink || !link?.properties?.action_link) {
        console.error('generateLink enlace', errLink?.message)
        return json({ error: 'No se pudo generar el enlace.' }, 500)
      }
      await admin.from('audit_log').insert({
        tenant_id: tenantId, actor_id: yo, accion: 'ENLACE_ACCESO', objeto: 'memberships',
        resultado: 'ok', detalle: { user_id: userId },
      })
      return json({ ok: true, enlace: link.properties.action_link })
    }

    return json({ error: 'Acción desconocida.' }, 400)
  } catch (e) {
    console.error('invitar-usuario', e instanceof Error ? e.message : e)
    return json({ error: 'Ocurrió un error inesperado.' }, 500)
  }
})
