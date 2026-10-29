import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

export default function Ingreso({ aviso }: { aviso: string | null }) {
  const [email, setEmail] = useState('')
  const [clave, setClave] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function entrar(e: FormEvent) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: clave })
    if (error) setError('Email o contraseña incorrectos.')
    setEnviando(false)
  }

  return (
    <main className="tarjeta angosta">
      <h1>SysCAR</h1>
      <p className="suave">Gestión contable e impositiva</p>
      {aviso && <p className="aviso" role="alert">{aviso}</p>}
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
