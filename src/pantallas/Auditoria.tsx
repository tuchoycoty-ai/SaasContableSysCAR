import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, Perfil, RegistroAuditoria } from '../lib/types'
import { fechaHora } from '../lib/utiles'

const ACCION: Record<string, string> = {
  INSERT: 'Alta',
  UPDATE: 'Modificación',
  DELETE: 'Baja',
  INVITAR: 'Invitación',
  ENLACE_ACCESO: 'Enlace de acceso',
}

const OBJETO: Record<string, string> = {
  tenants: 'Estudio',
  roles: 'Rol',
  memberships: 'Usuario del estudio',
  clients: 'Cliente',
  client_authorizations: 'Autorización',
  user_client_access: 'Asignación de cliente',
}

export default function Auditoria({ estudio }: { estudio: Estudio }) {
  const [filas, setFilas] = useState<RegistroAuditoria[]>([])
  const [actores, setActores] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelado = false
    ;(async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('id, tenant_id, actor_id, accion, objeto, resultado, detalle, creado_en')
        .eq('tenant_id', estudio.id)
        .order('creado_en', { ascending: false })
        .limit(100)
      if (cancelado) return
      if (error) return setError('No se pudo cargar la auditoría.')
      const lista = (data ?? []) as RegistroAuditoria[]
      setFilas(lista)
      const ids = Array.from(new Set(lista.map((f) => f.actor_id).filter((x): x is string => Boolean(x))))
      if (ids.length === 0) return
      const p = await supabase.from('profiles').select('id, email, nombre').in('id', ids)
      if (cancelado) return
      const mapa: Record<string, string> = {}
      for (const fila of (p.data ?? []) as Perfil[]) mapa[fila.id] = fila.email ?? fila.id.slice(0, 8)
      setActores(mapa)
    })()
    return () => {
      cancelado = true
    }
  }, [estudio.id])

  return (
    <section>
      <h2>Auditoría de {estudio.nombre}</h2>
      <p className="suave">
        Últimos 100 movimientos. Se registran solos y nadie puede modificarlos ni borrarlos.
      </p>
      {filas.length === 0 ? (
        <p className="suave">Todavía no hay movimientos.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Fecha</th><th>Quién</th><th>Qué hizo</th><th>Sobre</th></tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.id}>
                  <td>{fechaHora(f.creado_en)}</td>
                  <td>{f.actor_id ? (actores[f.actor_id] ?? f.actor_id.slice(0, 8)) : 'Sistema'}</td>
                  <td>{ACCION[f.accion] ?? f.accion}</td>
                  <td>{OBJETO[f.objeto ?? ''] ?? f.objeto ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
