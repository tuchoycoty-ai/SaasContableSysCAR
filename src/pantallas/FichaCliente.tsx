import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import {
  CATEGORIAS_MONOTRIBUTO,
  REGIMEN_LABEL,
  type Autorizacion,
  type Cliente,
  type Estudio,
  type Miembro,
  type Perfil,
  type Regimen,
  type Rol,
} from '../lib/types'
import { ESTADO_LABEL, estadoEfectivo, fechaCorta, formatoCuit, mensajeDb } from '../lib/utiles'

type Props = {
  cliente: Cliente
  auts: Autorizacion[]
  estudio: Estudio
  esAdmin: boolean
  puedeEditar: boolean
  onCambio: () => void
  onCerrar: () => void
}

export default function FichaCliente({ cliente, auts, estudio, esAdmin, puedeEditar, onCambio, onCerrar }: Props) {
  const [razon, setRazon] = useState(cliente.razon_social)
  const [regimen, setRegimen] = useState<Regimen | ''>(cliente.regimen ?? '')
  const [categoria, setCategoria] = useState(cliente.categoria_monotributo ?? '')
  const [notas, setNotas] = useState(cliente.notas ?? '')
  const [activo, setActivo] = useState(cliente.activo)
  const [mensaje, setMensaje] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [estadoNuevo, setEstadoNuevo] = useState<'pendiente' | 'vigente'>('vigente')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [obs, setObs] = useState('')

  async function guardar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMensaje(null)
    const { data, error } = await supabase
      .from('clients')
      .update({
        razon_social: razon.trim(),
        regimen: regimen || null,
        categoria_monotributo: regimen === 'monotributo' && categoria ? categoria : null,
        notas: notas.trim() || null,
        activo,
      })
      .eq('id', cliente.id)
      .select('id')
    if (error) return setError(mensajeDb(error, 'No se pudieron guardar los cambios.'))
    if (!data || data.length === 0) return setError('No tenés permiso para modificar este cliente.')
    setMensaje('Cambios guardados.')
    onCambio()
  }

  async function agregarAutorizacion(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMensaje(null)
    const { error } = await supabase.from('client_authorizations').insert({
      tenant_id: estudio.id,
      client_id: cliente.id,
      estado: estadoNuevo,
      vigente_desde: desde || null,
      vigente_hasta: hasta || null,
      observaciones: obs.trim() || null,
    })
    if (error) {
      return setError(
        error.code === '23505'
          ? 'Ya hay una autorización vigente para este cliente. Revocala primero.'
          : error.code === '23514'
            ? 'La fecha de fin no puede ser anterior a la de inicio.'
            : mensajeDb(error, 'No se pudo registrar la autorización.'),
      )
    }
    setDesde('')
    setHasta('')
    setObs('')
    onCambio()
  }

  async function revocar(a: Autorizacion) {
    if (!window.confirm('¿Revocar esta autorización?')) return
    setError(null)
    const { data, error } = await supabase
      .from('client_authorizations')
      .update({ estado: 'revocada' })
      .eq('id', a.id)
      .select('id')
    if (error || !data || data.length === 0) return setError('No se pudo revocar la autorización.')
    onCambio()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar a ${cliente.razon_social}? Se borran también sus autorizaciones. Queda registrado en la auditoría.`)) return
    setError(null)
    const { data, error } = await supabase.from('clients').delete().eq('id', cliente.id).select('id')
    if (error || !data || data.length === 0) return setError('No se pudo borrar el cliente.')
    onCerrar()
    onCambio()
  }

  return (
    <div className="ficha" role="region" aria-label={`Ficha de ${cliente.razon_social}`}>
      <div className="rol-cabecera">
        <h2>{cliente.razon_social} · {formatoCuit(cliente.cuit)}</h2>
        <button className="secundario" onClick={onCerrar}>Cerrar</button>
      </div>

      <h3>Datos fiscales</h3>
      <form onSubmit={guardar} className="fila cuatro">
        <label>
          Razón social
          <input value={razon} onChange={(e) => setRazon(e.target.value)} disabled={!puedeEditar} required maxLength={160} />
        </label>
        <label>
          Régimen
          <select value={regimen} onChange={(e) => setRegimen(e.target.value as Regimen | '')} disabled={!puedeEditar}>
            <option value="">Sin definir</option>
            {(Object.keys(REGIMEN_LABEL) as Regimen[]).map((r) => (
              <option key={r} value={r}>{REGIMEN_LABEL[r]}</option>
            ))}
          </select>
        </label>
        <label>
          Categoría
          <select value={categoria} onChange={(e) => setCategoria(e.target.value)} disabled={!puedeEditar || regimen !== 'monotributo'}>
            <option value="">—</option>
            {CATEGORIAS_MONOTRIBUTO.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="casilla">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} disabled={!puedeEditar} />
          <span>Cliente activo</span>
        </label>
        <label className="ancho-total">
          Notas
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} disabled={!puedeEditar} rows={2} maxLength={1000} />
        </label>
        {puedeEditar ? <button>Guardar cambios</button> : <p className="suave">Tu rol no permite modificar clientes.</p>}
      </form>

      <h3>Autorizaciones</h3>
      <p className="suave">Constancia de que el cliente autorizó al estudio a operar en su nombre.</p>
      {auts.length === 0 ? (
        <p className="suave">Este cliente no tiene autorizaciones registradas.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Estado</th><th>Desde</th><th>Hasta</th><th>Observaciones</th><th></th></tr>
            </thead>
            <tbody>
              {auts.map((a) => {
                const ef = estadoEfectivo(a)
                return (
                  <tr key={a.id}>
                    <td><span className={`badge ${ef}`}>{ESTADO_LABEL[ef]}</span></td>
                    <td>{fechaCorta(a.vigente_desde)}</td>
                    <td>{fechaCorta(a.vigente_hasta)}</td>
                    <td>{a.observaciones ?? '—'}</td>
                    <td>
                      {puedeEditar && (ef === 'vigente' || ef === 'pendiente') && (
                        <button className="secundario peligro" onClick={() => revocar(a)}>Revocar</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {puedeEditar && (
        <form onSubmit={agregarAutorizacion} className="fila cuatro">
          <label>
            Estado
            <select value={estadoNuevo} onChange={(e) => setEstadoNuevo(e.target.value as 'pendiente' | 'vigente')}>
              <option value="vigente">Vigente</option>
              <option value="pendiente">Pendiente</option>
            </select>
          </label>
          <label>
            Desde
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </label>
          <label>
            Observaciones
            <input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={300} />
          </label>
          <button>Registrar autorización</button>
        </form>
      )}

      {esAdmin && <Asignaciones estudio={estudio} cliente={cliente} />}

      {mensaje && <p className="ok" role="status">{mensaje}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {esAdmin && (
        <p>
          <button className="secundario peligro" onClick={borrar}>Borrar cliente</button>
        </p>
      )}
    </div>
  )
}

// Que usuarios (no administradores) pueden ver este cliente.
function Asignaciones({ estudio, cliente }: { estudio: Estudio; cliente: Cliente }) {
  const [miembros, setMiembros] = useState<Miembro[]>([])
  const [roles, setRoles] = useState<Rol[]>([])
  const [perfiles, setPerfiles] = useState<Record<string, Perfil>>({})
  const [asignados, setAsignados] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    const [m, r, a] = await Promise.all([
      supabase.from('memberships').select('user_id, role_id, creado_en').eq('tenant_id', estudio.id),
      supabase.from('roles').select('id, tenant_id, nombre, es_admin').eq('tenant_id', estudio.id),
      supabase.from('user_client_access').select('user_id').eq('tenant_id', estudio.id).eq('client_id', cliente.id),
    ])
    if (m.error || r.error || a.error) return setError('No se pudieron cargar las asignaciones.')
    const lista = (m.data ?? []) as Miembro[]
    setMiembros(lista)
    setRoles((r.data ?? []) as Rol[])
    setAsignados(new Set(((a.data ?? []) as { user_id: string }[]).map((x) => x.user_id)))
    const ids = lista.map((x) => x.user_id)
    if (ids.length === 0) return
    const p = await supabase.from('profiles').select('id, email, nombre').in('id', ids)
    const mapa: Record<string, Perfil> = {}
    for (const fila of (p.data ?? []) as Perfil[]) mapa[fila.id] = fila
    setPerfiles(mapa)
  }, [estudio.id, cliente.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function alternar(userId: string, asignar: boolean) {
    setError(null)
    const { error } = asignar
      ? await supabase.from('user_client_access').insert({ tenant_id: estudio.id, user_id: userId, client_id: cliente.id })
      : await supabase
          .from('user_client_access')
          .delete()
          .eq('tenant_id', estudio.id)
          .eq('user_id', userId)
          .eq('client_id', cliente.id)
    if (error) setError(mensajeDb(error, 'No se pudo cambiar la asignación.'))
    cargar()
  }

  const operativos = miembros.filter((m) => !roles.find((r) => r.id === m.role_id)?.es_admin)

  return (
    <>
      <h3>Quién puede ver este cliente</h3>
      <p className="suave">Los administradores ven todos los clientes. Acá elegís qué usuarios pueden ver éste.</p>
      {operativos.length === 0 ? (
        <p className="suave">No hay usuarios con rol distinto de administrador en este estudio.</p>
      ) : (
        operativos.map((m) => (
          <label key={m.user_id} className="casilla">
            <input type="checkbox" checked={asignados.has(m.user_id)} onChange={(e) => alternar(m.user_id, e.target.checked)} />
            <span>
              {perfiles[m.user_id]?.email ?? m.user_id.slice(0, 8)} ·{' '}
              <span className="suave">{roles.find((r) => r.id === m.role_id)?.nombre}</span>
            </span>
          </label>
        ))
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  )
}
