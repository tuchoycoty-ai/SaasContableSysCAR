import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configurado, supabase } from './lib/supabase'

type Estudio = { id: string; nombre: string; cuit: string | null; estado: string }
type Cliente = { id: string; cuit: string; razon_social: string; creado_en: string }

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    if (!configurado) {
      setCargando(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setCargando(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_evento, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!configurado) return <Aviso />
  if (cargando) return <p className="centro">Cargando…</p>
  return session ? <Panel session={session} /> : <Ingreso />
}

function Aviso() {
  return (
    <main className="tarjeta">
      <h1>Falta configurar la conexión</h1>
      <p>
        Definí <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> en las
        variables de entorno (Vercel o un archivo <code>.env.local</code>).
      </p>
    </main>
  )
}

function Ingreso() {
  const [email, setEmail] = useState('')
  const [clave, setClave] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function entrar(e: FormEvent) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password: clave })
    if (error) setError('Email o contraseña incorrectos.')
    setEnviando(false)
  }

  return (
    <main className="tarjeta angosta">
      <h1>SysCAR</h1>
      <p className="suave">Gestión contable e impositiva</p>
      <form onSubmit={entrar}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Contraseña
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={enviando}>{enviando ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </main>
  )
}

function Panel({ session }: { session: Session }) {
  const [estudios, setEstudios] = useState<Estudio[]>([])
  const [estudioId, setEstudioId] = useState<string>('')
  const [clientes, setClientes] = useState<Cliente[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cuit, setCuit] = useState('')
  const [razon, setRazon] = useState('')

  // Todas las lecturas pasan por el SDK; la base (RLS) decide que filas se devuelven.
  useEffect(() => {
    supabase
      .from('tenants')
      .select('id, nombre, cuit, estado')
      .order('nombre')
      .then(({ data, error }) => {
        if (error) return setError('No se pudieron cargar los estudios.')
        setEstudios(data ?? [])
        if (data && data.length > 0) setEstudioId((actual) => actual || data[0].id)
      })
  }, [])

  const cargarClientes = useCallback(async () => {
    if (!estudioId) return setClientes([])
    const { data, error } = await supabase
      .from('clients')
      .select('id, cuit, razon_social, creado_en')
      .eq('tenant_id', estudioId)
      .order('razon_social')
    if (error) setError('No se pudieron cargar los clientes.')
    else setClientes(data ?? [])
  }, [estudioId])

  useEffect(() => {
    cargarClientes()
  }, [cargarClientes])

  async function agregar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const limpio = cuit.replace(/\D/g, '')
    if (limpio.length !== 11) return setError('El CUIT debe tener 11 dígitos.')
    const { error } = await supabase
      .from('clients')
      .insert({ tenant_id: estudioId, cuit: limpio, razon_social: razon.trim() })
    if (error) {
      setError(
        error.code === '23505'
          ? 'Ese CUIT ya está cargado en este estudio.'
          : 'No se pudo guardar. Puede que no tengas permiso para crear clientes.',
      )
      return
    }
    setCuit('')
    setRazon('')
    cargarClientes()
  }

  return (
    <main className="tarjeta ancha">
      <header className="barra">
        <h1>SysCAR</h1>
        <span className="suave">{session.user.email}</span>
        <button className="secundario" onClick={() => supabase.auth.signOut()}>Salir</button>
      </header>

      {estudios.length === 0 ? (
        <p>Tu usuario todavía no pertenece a ningún estudio. Pedile al administrador que te agregue.</p>
      ) : (
        <>
          <label>
            Estudio
            <select value={estudioId} onChange={(e) => setEstudioId(e.target.value)}>
              {estudios.map((s) => (
                <option key={s.id} value={s.id}>{s.nombre}</option>
              ))}
            </select>
          </label>

          <h2>Clientes</h2>
          {clientes.length === 0 ? (
            <p className="suave">No hay clientes para mostrar.</p>
          ) : (
            <table>
              <thead><tr><th>CUIT</th><th>Razón social</th></tr></thead>
              <tbody>
                {clientes.map((c) => (
                  <tr key={c.id}><td>{c.cuit}</td><td>{c.razon_social}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Agregar cliente</h2>
          <form onSubmit={agregar} className="fila">
            <label>CUIT<input value={cuit} onChange={(e) => setCuit(e.target.value)} inputMode="numeric" placeholder="20-12345678-9" required /></label>
            <label>Razón social<input value={razon} onChange={(e) => setRazon(e.target.value)} required /></label>
            <button>Guardar</button>
          </form>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  )
}
