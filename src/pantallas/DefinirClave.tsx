import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

// Se muestra cuando la persona llega desde un enlace de invitacion o de acceso.
export default function DefinirClave({ onListo }: { onListo: () => void }) {
  const [clave, setClave] = useState('')
  const [repetida, setRepetida] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function guardar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (clave.length < 10) return setError('La contraseña debe tener al menos 10 caracteres.')
    if (clave !== repetida) return setError('Las contraseñas no coinciden.')
    setEnviando(true)
    const { error } = await supabase.auth.updateUser({ password: clave })
    setEnviando(false)
    if (error) return setError('No se pudo guardar la contraseña. Probá con otra más larga o pedí un enlace nuevo.')
    window.history.replaceState(null, '', window.location.pathname)
    onListo()
  }

  return (
    <main className="tarjeta angosta">
      <h1>Definí tu contraseña</h1>
      <p className="suave">La vas a usar cada vez que ingreses a SysCAR.</p>
      <form onSubmit={guardar}>
        <label>
          Contraseña nueva
          <input type="password" value={clave} onChange={(e) => setClave(e.target.value)} required minLength={10} autoComplete="new-password" />
        </label>
        <label>
          Repetila
          <input type="password" value={repetida} onChange={(e) => setRepetida(e.target.value)} required autoComplete="new-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar y entrar'}</button>
      </form>
    </main>
  )
}
