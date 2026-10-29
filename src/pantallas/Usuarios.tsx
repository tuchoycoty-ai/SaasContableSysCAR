import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, Miembro, Perfil, Rol } from '../lib/types'
import { fechaCorta, mensajeDb, mensajeDeFuncion } from '../lib/utiles'

type Props = { estudio: Estudio; yo: string }

export default function Usuarios({ estudio, yo }: Props) {
  const [roles, setRoles] = useState<Rol[]>([])
  const [miembros, setMiembros] = useState<Miembro[]>([])
  const [perfiles, setPerfiles] = useState<Record<string, Perfil>>({})
  const [email, setEmail] = useState('')
  const [rolId, setRolId] = useState('')
  const [enlace, setEnlace] = useState<{ para: string; url: string } | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [mensaje, setMensaje] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  const cargar = useCallback(async () => {
    const [r, m] = await Promise.all([
      supabase.from('roles').select('id, tenant_id, nombre, es_admin').eq('tenant_id', estudio.id).order('nombre'),
      supabase.from('memberships').select('user_id, role_id, creado_en').eq('tenant_id', estudio.id).order('creado_en'),
    ])
    if (r.error || m.error) return setError('No se pudieron cargar los usuarios.')
    const listaRoles = (r.data ?? []) as Rol[]
    const listaMiembros = (m.data ?? []) as Miembro[]
    setRoles(listaRoles)
    setMiembros(listaMiembros)
    setRolId((actual) => actual || (listaRoles.find((x) => !x.es_admin)?.id ?? listaRoles[0]?.id ?? ''))
    const ids = listaMiembros.map((x) => x.user_id)
    if (ids.length === 0) return setPerfiles({})
    const p = await supabase.from('profiles').select('id, email, nombre').in('id', ids)
    const mapa: Record<string, Perfil> = {}
    for (const fila of (p.data ?? []) as Perfil[]) mapa[fila.id] = fila
    setPerfiles(mapa)
  }, [estudio.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function invitar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMensaje(null)
    setEnlace(null)
    setEnviando(true)
    const { data, error } = await supabase.functions.invoke('invitar-usuario', {
      body: { accion: 'invitar', tenant_id: estudio.id, email: email.trim(), role_id: rolId },
    })
    setEnviando(false)
    if (error) return setError(await mensajeDeFuncion(error))
    if (data?.enlace) {
      setEnlace({ para: email.trim().toLowerCase(), url: String(data.enlace) })
      setCopiado(false)
    } else if (data?.existente) {
      setMensaje('Esa persona ya tenía cuenta y quedó agregada al estudio. Ingresa con su contraseña de siempre.')
    }
    setEmail('')
    cargar()
  }

  async function nuevoEnlace(m: Miembro) {
    setError(null)
    setMensaje(null)
    const { data, error } = await supabase.functions.invoke('invitar-usuario', {
      body: { accion: 'enlace', tenant_id: estudio.id, user_id: m.user_id },
    })
    if (error) return setError(await mensajeDeFuncion(error))
    setEnlace({ para: perfiles[m.user_id]?.email ?? 'la persona', url: String(data.enlace) })
    setCopiado(false)
  }

  async function cambiarRol(m: Miembro, nuevoRol: string) {
    setError(null)
    setMensaje(null)
    const { data, error } = await supabase
      .from('memberships')
      .update({ role_id: nuevoRol })
      .eq('tenant_id', estudio.id)
      .eq('user_id', m.user_id)
      .select('user_id')
    if (error) setError(mensajeDb(error, 'No se pudo cambiar el rol.'))
    else if (!data || data.length === 0) setError('No tenés permiso para cambiar este rol.')
    cargar()
  }

  async function quitar(m: Miembro) {
    const quien = perfiles[m.user_id]?.email ?? 'esta persona'
    if (!window.confirm(`¿Quitar a ${quien} del estudio? Va a perder el acceso a sus clientes.`)) return
    setError(null)
    setMensaje(null)
    const { error } = await supabase.from('memberships').delete().eq('tenant_id', estudio.id).eq('user_id', m.user_id)
    if (error) setError(mensajeDb(error, 'No se pudo quitar a la persona.'))
    cargar()
  }

  async function copiar() {
    if (!enlace) return
    try {
      await navigator.clipboard.writeText(enlace.url)
      setCopiado(true)
    } catch {
      setError('No se pudo copiar. Seleccioná el enlace y copialo a mano.')
    }
  }

  return (
    <section>
      <h2>Usuarios de {estudio.nombre}</h2>
      {miembros.length === 0 ? (
        <p className="suave">Este estudio todavía no tiene usuarios. Invitá al primer administrador abajo.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Email</th><th>Rol</th><th>Desde</th><th></th></tr>
            </thead>
            <tbody>
              {miembros.map((m) => (
                <tr key={m.user_id}>
                  <td>{perfiles[m.user_id]?.email ?? '—'}{m.user_id === yo ? ' (vos)' : ''}</td>
                  <td>
                    <select
                      aria-label={`Rol de ${perfiles[m.user_id]?.email ?? 'usuario'}`}
                      value={m.role_id}
                      onChange={(e) => cambiarRol(m, e.target.value)}
                    >
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>{r.nombre}</option>
                      ))}
                    </select>
                  </td>
                  <td>{fechaCorta(m.creado_en)}</td>
                  <td className="acciones">
                    <button className="secundario" onClick={() => nuevoEnlace(m)}>Nuevo enlace de acceso</button>
                    <button className="secundario peligro" onClick={() => quitar(m)}>Quitar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Invitar a una persona</h2>
      <p className="suave">
        No se envía ningún email: te damos un enlace para que se lo pases (por WhatsApp, por ejemplo).
        Con ese enlace la persona define su contraseña.
      </p>
      <form onSubmit={invitar} className="fila dos">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </label>
        <label>
          Rol
          <select value={rolId} onChange={(e) => setRolId(e.target.value)} required>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.nombre}</option>
            ))}
          </select>
        </label>
        <button disabled={enviando || !rolId}>{enviando ? 'Invitando…' : 'Invitar'}</button>
      </form>

      {enlace && (
        <div className="aviso" role="status">
          <p><strong>Enlace para {enlace.para}</strong>. Pasáselo solo a esa persona: permite entrar a su cuenta y es de un solo uso.</p>
          <input readOnly value={enlace.url} onFocus={(e) => e.currentTarget.select()} aria-label="Enlace de acceso" />
          <button type="button" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar enlace'}</button>
        </div>
      )}
      {mensaje && <p className="ok" role="status">{mensaje}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
