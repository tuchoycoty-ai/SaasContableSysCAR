import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, Permiso, Rol } from '../lib/types'
import { mensajeDb } from '../lib/utiles'

export default function Roles({ estudio }: { estudio: Estudio }) {
  const [roles, setRoles] = useState<Rol[]>([])
  const [catalogo, setCatalogo] = useState<Permiso[]>([])
  const [asignados, setAsignados] = useState<Set<string>>(new Set()) // "rolId|permiso"
  const [nombre, setNombre] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    const [r, p, rp] = await Promise.all([
      supabase.from('roles').select('id, tenant_id, nombre, es_admin').eq('tenant_id', estudio.id).order('nombre'),
      supabase.from('permissions').select('code, descripcion').order('code'),
      supabase.from('role_permissions').select('role_id, permission_code'),
    ])
    if (r.error || p.error || rp.error) return setError('No se pudieron cargar los roles.')
    const lista = (r.data ?? []) as Rol[]
    const ids = new Set(lista.map((x) => x.id))
    setRoles(lista)
    setCatalogo((p.data ?? []) as Permiso[])
    const conjunto = new Set<string>()
    for (const fila of (rp.data ?? []) as { role_id: string; permission_code: string }[]) {
      if (ids.has(fila.role_id)) conjunto.add(`${fila.role_id}|${fila.permission_code}`)
    }
    setAsignados(conjunto)
  }, [estudio.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function crear(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.from('roles').insert({ tenant_id: estudio.id, nombre: nombre.trim(), es_admin: false })
    if (error) {
      return setError(error.code === '23505' ? 'Ya hay un rol con ese nombre.' : mensajeDb(error, 'No se pudo crear el rol.'))
    }
    setNombre('')
    cargar()
  }

  async function alternar(rol: Rol, permiso: string, activo: boolean) {
    setError(null)
    const consulta = activo
      ? supabase.from('role_permissions').insert({ role_id: rol.id, permission_code: permiso })
      : supabase.from('role_permissions').delete().eq('role_id', rol.id).eq('permission_code', permiso)
    const { error } = await consulta
    if (error) setError(mensajeDb(error, 'No se pudo cambiar el permiso.'))
    cargar()
  }

  async function borrar(rol: Rol) {
    if (!window.confirm(`¿Borrar el rol "${rol.nombre}"?`)) return
    setError(null)
    const { error } = await supabase.from('roles').delete().eq('id', rol.id)
    if (error) {
      return setError(
        error.code === '23503'
          ? 'No se puede borrar: hay usuarios con ese rol. Cambiales el rol primero.'
          : mensajeDb(error, 'No se pudo borrar el rol.'),
      )
    }
    cargar()
  }

  return (
    <section>
      <h2>Roles de {estudio.nombre}</h2>
      <p className="suave">
        El administrador tiene todos los permisos. Los demás roles reciben solo los que tildes acá.
        Por ahora existe un permiso; se suman a medida que se incorporan módulos.
      </p>
      {roles.map((r) => (
        <div key={r.id} className="rol">
          <div className="rol-cabecera">
            <strong>{r.nombre}</strong>
            {r.es_admin ? (
              <span className="badge vigente">Todos los permisos</span>
            ) : (
              <button className="secundario peligro" onClick={() => borrar(r)}>Borrar rol</button>
            )}
          </div>
          {!r.es_admin &&
            catalogo.map((p) => (
              <label key={p.code} className="casilla">
                <input
                  type="checkbox"
                  checked={asignados.has(`${r.id}|${p.code}`)}
                  onChange={(e) => alternar(r, p.code, e.target.checked)}
                />
                <span>{p.descripcion}</span>
              </label>
            ))}
        </div>
      ))}

      <h2>Crear rol</h2>
      <form onSubmit={crear} className="fila dos">
        <label>
          Nombre del rol
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={60} />
        </label>
        <button>Crear rol</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
