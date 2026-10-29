import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import type { Estudio } from './lib/types'
import Clientes from './pantallas/Clientes'
import Usuarios from './pantallas/Usuarios'
import Roles from './pantallas/Roles'
import Auditoria from './pantallas/Auditoria'
import Estudios from './pantallas/Estudios'

type Vista = 'clientes' | 'usuarios' | 'roles' | 'auditoria' | 'estudios'

export default function Panel({ session }: { session: Session }) {
  const yo = session.user.id
  const [esHolding, setEsHolding] = useState(false)
  const [estudios, setEstudios] = useState<Estudio[]>([])
  const [estudioId, setEstudioId] = useState('')
  const [permisos, setPermisos] = useState<string[]>([])
  const [soyMiembro, setSoyMiembro] = useState(false)
  const [vista, setVista] = useState<Vista>('clientes')
  const [listo, setListo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Todo se lee por el SDK; la base (RLS) decide que filas se devuelven.
  const cargarEstudios = useCallback(async (seleccionar?: string) => {
    const { data, error } = await supabase
      .from('tenants')
      .select('id, nombre, cuit, estado, creado_en')
      .order('nombre')
    if (error) {
      setError('No se pudieron cargar los estudios.')
      return
    }
    const lista = (data ?? []) as Estudio[]
    setEstudios(lista)
    setEstudioId((actual) => seleccionar ?? (lista.some((e) => e.id === actual) ? actual : (lista[0]?.id ?? '')))
  }, [])

  useEffect(() => {
    supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', yo)
      .maybeSingle()
      .then(({ data }) => setEsHolding(Boolean(data)))
    cargarEstudios().then(() => setListo(true))
  }, [yo, cargarEstudios])

  useEffect(() => {
    if (!estudioId) {
      setPermisos([])
      setSoyMiembro(false)
      return
    }
    let cancelado = false
    Promise.all([
      supabase.rpc('mis_permisos', { p_tenant: estudioId }),
      supabase.from('memberships').select('role_id').eq('tenant_id', estudioId).eq('user_id', yo).maybeSingle(),
    ]).then(([p, m]) => {
      if (cancelado) return
      setPermisos((p.data ?? []) as string[])
      setSoyMiembro(Boolean(m.data))
    })
    return () => {
      cancelado = true
    }
  }, [estudioId, yo])

  const estudio = estudios.find((e) => e.id === estudioId) ?? null
  const esAdmin = permisos.includes('admin')
  const gestiona = esAdmin || esHolding

  const solapas: { id: Vista; nombre: string }[] = []
  if (estudio && soyMiembro) solapas.push({ id: 'clientes', nombre: 'Clientes' })
  if (estudio && gestiona) {
    solapas.push({ id: 'usuarios', nombre: 'Usuarios' })
    solapas.push({ id: 'roles', nombre: 'Roles' })
    solapas.push({ id: 'auditoria', nombre: 'Auditoría' })
  }
  if (esHolding) solapas.push({ id: 'estudios', nombre: 'Holding' })
  const actual: Vista | null = solapas.some((s) => s.id === vista) ? vista : (solapas[0]?.id ?? null)

  return (
    <main className="tarjeta ancha">
      <header className="barra">
        <h1>SysCAR</h1>
        {esHolding && <span className="badge vigente">Superadministrador del holding</span>}
        <span className="suave">{session.user.email}</span>
        <button className="secundario" onClick={() => supabase.auth.signOut()}>Salir</button>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {estudios.length > 0 && (
        <label>
          Estudio
          <select value={estudioId} onChange={(e) => setEstudioId(e.target.value)}>
            {estudios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
                {s.estado === 'suspendido' ? ' (suspendido)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {estudio?.estado === 'suspendido' && (
        <p className="aviso">Este estudio está suspendido: sus usuarios no pueden ingresar hasta que se reactive.</p>
      )}

      {listo && solapas.length === 0 && (
        <p>Tu usuario todavía no pertenece a ningún estudio. Pedile al administrador que te agregue.</p>
      )}

      {solapas.length > 0 && (
        <nav className="solapas" aria-label="Secciones">
          {solapas.map((s) => (
            <button
              key={s.id}
              className="solapa"
              aria-current={s.id === actual ? 'page' : undefined}
              onClick={() => setVista(s.id)}
            >
              {s.nombre}
            </button>
          ))}
        </nav>
      )}

      {actual === 'clientes' && estudio && <Clientes key={estudio.id} estudio={estudio} permisos={permisos} />}
      {actual === 'usuarios' && estudio && <Usuarios key={estudio.id} estudio={estudio} yo={yo} />}
      {actual === 'roles' && estudio && <Roles key={estudio.id} estudio={estudio} />}
      {actual === 'auditoria' && estudio && <Auditoria key={estudio.id} estudio={estudio} />}
      {actual === 'estudios' && (
        <Estudios
          estudios={estudios}
          onCambio={() => cargarEstudios()}
          onCreado={(id) => {
            cargarEstudios(id).then(() => setVista('usuarios'))
          }}
        />
      )}
    </main>
  )
}
