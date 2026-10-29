import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configurado, enlaceVencido, llegoPorEnlace, supabase } from './lib/supabase'
import Ingreso from './pantallas/Ingreso'
import DefinirClave from './pantallas/DefinirClave'
import Panel from './Panel'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [cargando, setCargando] = useState(true)
  const [definiendoClave, setDefiniendoClave] = useState(llegoPorEnlace)

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

  if (!configurado) {
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
  if (cargando) return <p className="centro">Cargando…</p>
  if (!session) {
    return (
      <Ingreso
        aviso={enlaceVencido ? 'El enlace venció o ya se usó. Pedile uno nuevo a quien te invitó.' : null}
      />
    )
  }
  if (definiendoClave) return <DefinirClave onListo={() => setDefiniendoClave(false)} />
  return <Panel session={session} />
}
