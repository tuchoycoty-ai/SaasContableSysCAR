// Edge Function: arca-certificados
// Maneja los certificados digitales de ARCA de cada estudio. La clave privada se guarda CIFRADA
// (AES-GCM) con el secreto ARCA_CIFRADO_SECRETO, que existe solo como secreto de esta funcion.
// La clave privada nunca vuelve al navegador. Solo el administrador del estudio o el holding
// pueden usarla.
//
// POST { accion: 'generar_csr', tenant_id, ambiente, cuit, organizacion, alias }
//   -> crea clave + pedido de certificado (CSR), guarda la clave cifrada y devuelve el CSR.
// POST { accion: 'subir_crt', tenant_id, certificado_id, crt }
//   -> para un CSR generado aqui: sube el .crt que entrego ARCA y verifica que corresponda.
// POST { accion: 'subir_par', tenant_id, ambiente, alias, crt, key }
//   -> para un par .crt/.key que ya existia: verifica que se correspondan y los guarda.
// POST { accion: 'probar_conexion', tenant_id, certificado_id, servicio }
//   -> pide un ticket de acceso (login WSAA) a ARCA con el certificado guardado. Es una conexion real.
// POST { accion: 'revocar', tenant_id, certificado_id }
//   -> marca el certificado como revocado y borra la clave guardada.
import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  claveAPkcs8, claveCorrespondeACertificado, cifrar, descifrar, firmarCms, generarClaveYCsr, leerCertificado,
} from './cripto.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXTO = 20000
const SERVICIOS = ['wsfe', 'ws_sr_constancia_inscripcion', 'ws_sr_padron_a13', 'wscdc']

function cuitValido(c: string): boolean {
  if (!/^\d{11}$/.test(c)) return false
  const p = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let s = 0
  for (let i = 0; i < 10; i++) s += Number(c[i]) * p[i]
  let dv = 11 - (s % 11)
  if (dv === 11) dv = 0
  return dv !== 10 && dv === Number(c[10])
}
const texto = (v: unknown) => (typeof v === 'string' ? v : '')

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const secreto = Deno.env.get('ARCA_CIFRADO_SECRETO') ?? ''
  if (!url || !anon || !service) return json({ error: 'El servidor no está configurado.' }, 500)
  if (secreto.length < 32) {
    return json({ error: 'Falta configurar el secreto de cifrado (ARCA_CIFRADO_SECRETO) en Supabase. Sin eso no se guardan claves.' }, 503)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Necesitás iniciar sesión.' }, 401)
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
  const accion = texto(body.accion)
  const tenantId = texto(body.tenant_id)
  if (!UUID.test(tenantId)) return json({ error: 'Estudio inválido.' }, 400)

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  const auditar = (acc: string, detalle: Record<string, unknown>, resultado = 'ok') =>
    admin.from('audit_log').insert({ tenant_id: tenantId, actor_id: yo, accion: acc, objeto: 'arca_certificados', resultado, detalle })

  try {
    const { data: estudio } = await admin.from('tenants').select('id, estado, nombre').eq('id', tenantId).maybeSingle()
    if (!estudio) return json({ error: 'No se encontró el estudio.' }, 404)
    if (estudio.estado !== 'activo') return json({ error: 'El estudio está suspendido.' }, 403)

    const { data: esHolding } = await admin.from('platform_admins').select('user_id').eq('user_id', yo).maybeSingle()
    let autorizado = Boolean(esHolding)
    if (!autorizado) {
      const { data: m } = await admin.from('memberships').select('role_id').eq('tenant_id', tenantId).eq('user_id', yo).maybeSingle()
      if (m) {
        const { data: rol } = await admin.from('roles').select('es_admin').eq('tenant_id', tenantId).eq('id', m.role_id).maybeSingle()
        autorizado = Boolean(rol?.es_admin)
      }
    }
    if (!autorizado) return json({ error: 'No tenés permiso para administrar los certificados de este estudio.' }, 403)

    const ambiente = texto(body.ambiente)
    const ambienteOk = ambiente === 'homologacion' || ambiente === 'produccion'

    // ---------- Generar clave + CSR ----------
    if (accion === 'generar_csr') {
      const cuit = texto(body.cuit).replace(/\D/g, '')
      const organizacion = texto(body.organizacion).trim()
      const alias = texto(body.alias).trim()
      if (!ambienteOk) return json({ error: 'Elegí el ambiente (homologación o producción).' }, 400)
      if (!cuitValido(cuit)) return json({ error: 'El CUIT no es válido.' }, 400)
      if (!organizacion || !alias) return json({ error: 'Completá el nombre y el alias.' }, 400)

      const { csrPem, pkcs8 } = await generarClaveYCsr({ cuit, organizacion, alias })
      const id = crypto.randomUUID()
      const { error: e1 } = await admin.from('arca_certificados').insert({
        id, tenant_id: tenantId, ambiente, alias: alias.slice(0, 60), cuit, estado: 'csr_generado',
        origen: 'generado_aqui', csr_pem: csrPem, creado_por: yo,
      })
      if (e1) {
        return json({ error: e1.code === '23505' ? 'Ya hay un certificado o pedido vigente para ese ambiente. Revocalo primero.' : 'No se pudo guardar el pedido.' }, 409)
      }
      const { error: e2 } = await admin.from('arca_secretos').insert({ certificado_id: id, clave_cifrada: await cifrar(secreto, pkcs8, id) })
      if (e2) {
        await admin.from('arca_certificados').delete().eq('id', id)
        return json({ error: 'No se pudo guardar la clave de forma segura.' }, 500)
      }
      await auditar('ARCA_CSR_GENERADO', { certificado_id: id, ambiente, cuit })
      return json({ ok: true, certificado_id: id, csr: csrPem })
    }

    // ---------- Subir .crt de un CSR generado aca ----------
    if (accion === 'subir_crt') {
      const certId = texto(body.certificado_id)
      const crt = texto(body.crt)
      if (!UUID.test(certId)) return json({ error: 'Certificado inválido.' }, 400)
      if (!crt || crt.length > MAX_TEXTO) return json({ error: 'Subí el archivo .crt.' }, 400)
      const { data: fila } = await admin.from('arca_certificados').select('*').eq('id', certId).eq('tenant_id', tenantId).maybeSingle()
      if (!fila || fila.estado !== 'csr_generado') return json({ error: 'No hay un pedido pendiente para ese certificado.' }, 404)
      const { data: sec } = await admin.from('arca_secretos').select('clave_cifrada').eq('certificado_id', certId).maybeSingle()
      if (!sec) return json({ error: 'No se encontró la clave de ese pedido.' }, 404)

      let datos
      try {
        datos = await leerCertificado(crt)
      } catch (e) {
        return json({ error: (e as Error).message }, 400)
      }
      if (datos.validoHasta.getTime() < Date.now()) return json({ error: 'El certificado ya está vencido.' }, 400)
      let pkcs8: Uint8Array
      try {
        pkcs8 = await descifrar(secreto, sec.clave_cifrada, certId)
      } catch {
        return json({ error: 'No se pudo leer la clave guardada (¿cambió el secreto de cifrado?).' }, 500)
      }
      if (!(await claveCorrespondeACertificado(pkcs8, datos.spki))) {
        await auditar('ARCA_CERT_RECHAZADO', { certificado_id: certId, motivo: 'no corresponde a la clave' }, 'error')
        return json({ error: 'Ese certificado NO corresponde a la clave generada para este pedido. Verificá que sea el que ARCA emitió a partir de este CSR.' }, 400)
      }
      const { error } = await admin.from('arca_certificados').update({
        estado: 'activo', sujeto: Object.entries(datos.sujeto).map(([k, v]) => `${k}=${v}`).join(', '),
        valido_desde: datos.validoDesde.toISOString(), valido_hasta: datos.validoHasta.toISOString(),
        huella_sha256: datos.huella, activado_en: new Date().toISOString(), crt_pem: crt,
      }).eq('id', certId)
      if (error) return json({ error: 'No se pudo activar el certificado.' }, 500)
      await auditar('ARCA_CERT_ACTIVADO', { certificado_id: certId, huella: datos.huella, vence: datos.validoHasta.toISOString() })
      return json({ ok: true, valido_hasta: datos.validoHasta.toISOString() })
    }

    // ---------- Subir un par .crt / .key que ya existia ----------
    if (accion === 'subir_par') {
      const crt = texto(body.crt)
      const key = texto(body.key)
      const alias = texto(body.alias).trim() || 'certificado-importado'
      if (!ambienteOk) return json({ error: 'Elegí el ambiente (homologación o producción).' }, 400)
      if (!crt || !key || crt.length > MAX_TEXTO || key.length > MAX_TEXTO) return json({ error: 'Subí el .crt y el .key.' }, 400)

      let datos
      let pkcs8: Uint8Array
      try {
        datos = await leerCertificado(crt)
        pkcs8 = claveAPkcs8(key)
      } catch (e) {
        return json({ error: (e as Error).message }, 400)
      }
      if (datos.validoHasta.getTime() < Date.now()) return json({ error: 'El certificado ya está vencido.' }, 400)
      if (!datos.cuit || !cuitValido(datos.cuit)) return json({ error: 'No se pudo leer un CUIT válido en el certificado.' }, 400)
      if (!(await claveCorrespondeACertificado(pkcs8, datos.spki))) {
        await auditar('ARCA_CERT_RECHAZADO', { motivo: 'clave y certificado no se corresponden' }, 'error')
        return json({ error: 'El .key y el .crt NO son un par: no se hicieron juntos. No se guardó nada.' }, 400)
      }
      const id = crypto.randomUUID()
      const { error: e1 } = await admin.from('arca_certificados').insert({
        id, tenant_id: tenantId, ambiente, alias: alias.slice(0, 60), cuit: datos.cuit, estado: 'activo', origen: 'subido',
        sujeto: Object.entries(datos.sujeto).map(([k, v]) => `${k}=${v}`).join(', '),
        valido_desde: datos.validoDesde.toISOString(), valido_hasta: datos.validoHasta.toISOString(),
        huella_sha256: datos.huella, creado_por: yo, activado_en: new Date().toISOString(), crt_pem: crt,
      })
      if (e1) {
        return json({ error: e1.code === '23505' ? 'Ya hay un certificado o pedido vigente para ese ambiente. Revocalo primero.' : 'No se pudo guardar el certificado.' }, 409)
      }
      const { error: e2 } = await admin.from('arca_secretos').insert({ certificado_id: id, clave_cifrada: await cifrar(secreto, pkcs8, id) })
      if (e2) {
        await admin.from('arca_certificados').delete().eq('id', id)
        return json({ error: 'No se pudo guardar la clave de forma segura.' }, 500)
      }
      await auditar('ARCA_CERT_SUBIDO', { certificado_id: id, ambiente, cuit: datos.cuit, huella: datos.huella, vence: datos.validoHasta.toISOString() })
      return json({ ok: true, certificado_id: id, cuit: datos.cuit, valido_hasta: datos.validoHasta.toISOString() })
    }

    // ---------- Revocar ----------
    // ---------- Probar la conexion real con ARCA (login WSAA) ----------
    if (accion === 'probar_conexion') {
      const certId = texto(body.certificado_id)
      const servicio = texto(body.servicio)
      if (!UUID.test(certId)) return json({ error: 'Certificado inválido.' }, 400)
      if (!SERVICIOS.includes(servicio)) return json({ error: 'Servicio no permitido.' }, 400)
      const { data: fila } = await admin.from('arca_certificados').select('*').eq('id', certId).eq('tenant_id', tenantId).maybeSingle()
      if (!fila || fila.estado !== 'activo') return json({ error: 'No hay un certificado activo para probar.' }, 404)
      if (fila.valido_hasta && new Date(fila.valido_hasta).getTime() < Date.now()) return json({ error: 'El certificado está vencido.' }, 400)

      // Si ya hay un ticket vigente se reutiliza (ARCA no permite pedir otro mientras dure)
      const { data: previo } = await admin.from('arca_tickets').select('expira').eq('certificado_id', certId).eq('servicio', servicio).maybeSingle()
      if (previo && new Date(previo.expira).getTime() > Date.now() + 5 * 60000) {
        return json({ ok: true, reutilizado: true, servicio, expira: previo.expira })
      }

      const { data: sec } = await admin.from('arca_secretos').select('clave_cifrada').eq('certificado_id', certId).maybeSingle()
      if (!sec) return json({ error: 'No se encontró la clave del certificado.' }, 404)
      let pkcs8: Uint8Array
      try {
        pkcs8 = await descifrar(secreto, sec.clave_cifrada, certId)
      } catch {
        return json({ error: 'No se pudo leer la clave guardada (¿cambió el secreto de cifrado?).' }, 500)
      }
      if (!fila.crt_pem) return json({ error: 'Falta el contenido del certificado. Revocá este certificado y volvé a cargarlo.' }, 409)
      const cert = await leerCertificado(fila.crt_pem)

      const ahora = new Date()
      const ar = (d: Date) => new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 19) + '-03:00'
      const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>` +
        `<generationTime>${ar(new Date(ahora.getTime() - 600000))}</generationTime><expirationTime>${ar(new Date(ahora.getTime() + 600000))}</expirationTime></header>` +
        `<service>${servicio}</service></loginTicketRequest>`
      const cms = await firmarCms(pkcs8, cert, new TextEncoder().encode(tra), ahora)
      const sobre = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`
      const destino = fila.ambiente === 'produccion' ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms' : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'

      let respuesta: string
      try {
        const r = await fetch(destino, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' }, body: sobre, signal: AbortSignal.timeout(25000) })
        respuesta = await r.text()
      } catch {
        await auditar('ARCA_LOGIN', { certificado_id: certId, servicio, ambiente: fila.ambiente, motivo: 'sin conexión con ARCA' }, 'error')
        return json({ error: 'No se pudo conectar con ARCA. Probá de nuevo en unos minutos.' }, 502)
      }
      const falla = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(respuesta)
      if (falla) {
        const msg = falla[1].replace(/&[a-z]+;/g, ' ').trim().slice(0, 300)
        await auditar('ARCA_LOGIN', { certificado_id: certId, servicio, ambiente: fila.ambiente, respuesta: msg }, 'error')
        if (/alreadyAuthenticated/i.test(msg)) {
          return json({ ok: true, ya_autenticado: true, servicio, aviso: 'ARCA ya tiene un ticket vigente para este certificado y servicio (por ejemplo, de otra aplicación que usa el mismo certificado). El certificado es válido; el sistema podrá pedir su propio ticket cuando ese venza.' })
        }
        if (/not.*authorized|no.*autorizaci|notAuthorized/i.test(msg)) {
          return json({ error: 'El certificado es válido pero NO está autorizado para el servicio «' + servicio + '». Hay que asociarlo en ARCA («Administrador de Relaciones de Clave Fiscal»). Respuesta de ARCA: ' + msg }, 403)
        }
        return json({ error: 'ARCA rechazó el login: ' + msg }, 502)
      }
      const ret = /<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/.exec(respuesta)
      const xml = ret ? ret[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : ''
      const token = /<token>([\s\S]*?)<\/token>/.exec(xml)?.[1]
      const sign = /<sign>([\s\S]*?)<\/sign>/.exec(xml)?.[1]
      const expira = /<expirationTime>([\s\S]*?)<\/expirationTime>/.exec(xml)?.[1]
      if (!token || !sign || !expira || isNaN(new Date(expira).getTime())) {
        await auditar('ARCA_LOGIN', { certificado_id: certId, servicio, motivo: 'respuesta sin ticket' }, 'error')
        return json({ error: 'ARCA respondió pero sin un ticket válido. No se guardó nada.' }, 502)
      }
      await admin.from('arca_tickets').upsert({ certificado_id: certId, servicio, token, sign, expira: new Date(expira).toISOString() })
      await auditar('ARCA_LOGIN', { certificado_id: certId, servicio, ambiente: fila.ambiente, expira: new Date(expira).toISOString() })
      return json({ ok: true, servicio, expira: new Date(expira).toISOString() })
    }

    if (accion === 'revocar') {
      const certId = texto(body.certificado_id)
      if (!UUID.test(certId)) return json({ error: 'Certificado inválido.' }, 400)
      const { data: fila } = await admin.from('arca_certificados').select('id, estado').eq('id', certId).eq('tenant_id', tenantId).maybeSingle()
      if (!fila || fila.estado === 'revocado') return json({ error: 'No se encontró un certificado vigente.' }, 404)
      await admin.from('arca_secretos').delete().eq('certificado_id', certId)
      await admin.from('arca_tickets').delete().eq('certificado_id', certId)
      await admin.from('arca_certificados').update({ estado: 'revocado' }).eq('id', certId)
      await auditar('ARCA_CERT_REVOCADO', { certificado_id: certId })
      return json({ ok: true })
    }

    return json({ error: 'Acción desconocida.' }, 400)
  } catch (e) {
    console.error('arca-certificados', (e as Error).message) // nunca se registra material de claves
    return json({ error: 'Ocurrió un error inesperado.' }, 500)
  }
})
