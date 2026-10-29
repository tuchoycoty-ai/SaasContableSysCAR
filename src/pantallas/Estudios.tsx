import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio } from '../lib/types'
import { cuitValido, fechaCorta, formatoCuit, mensajeDb, soloDigitos } from '../lib/utiles'

type Props = {
  estudios: Estudio[]
  onCambio: () => void
  onCreado: (id: string) => void
}

// Solo el holding ve esta pantalla (y la base tambien lo exige).
export default function Estudios({ estudios, onCambio, onCreado }: Props) {
  const [nombre, setNombre] = useState('')
  const [cuit, setCuit] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function crear(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const limpio = soloDigitos(cuit)
    if (limpio && !cuitValido(limpio)) return setError('El CUIT no es válido. Revisá los dígitos.')
    setEnviando(true)
    const { data, error } = await supabase.rpc('crear_estudio', {
      p_nombre: nombre.trim(),
      p_cuit: limpio || null,
    })
    setEnviando(false)
    if (error) return setError(mensajeDb(error, 'No se pudo crear el estudio.'))
    setNombre('')
    setCuit('')
    onCreado(String(data))
  }

  async function cambiarEstado(s: Estudio) {
    const nuevo = s.estado === 'activo' ? 'suspendido' : 'activo'
    const pregunta =
      nuevo === 'suspendido'
        ? `¿Suspender "${s.nombre}"? Sus usuarios no van a poder ingresar hasta que lo reactives.`
        : `¿Reactivar "${s.nombre}"?`
    if (!window.confirm(pregunta)) return
    setError(null)
    const { data, error } = await supabase.from('tenants').update({ estado: nuevo }).eq('id', s.id).select('id')
    if (error || !data || data.length === 0) return setError('No se pudo cambiar el estado del estudio.')
    onCambio()
  }

  return (
    <section>
      <h2>Estudios registrados</h2>
      {estudios.length === 0 ? (
        <p className="suave">Todavía no hay estudios. Creá el primero abajo.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Nombre</th><th>CUIT</th><th>Estado</th><th>Alta</th><th></th></tr>
            </thead>
            <tbody>
              {estudios.map((s) => (
                <tr key={s.id}>
                  <td>{s.nombre}</td>
                  <td>{s.cuit ? formatoCuit(s.cuit) : '—'}</td>
                  <td><span className={`badge ${s.estado}`}>{s.estado === 'activo' ? 'Activo' : 'Suspendido'}</span></td>
                  <td>{fechaCorta(s.creado_en)}</td>
                  <td>
                    <button className="secundario" onClick={() => cambiarEstado(s)}>
                      {s.estado === 'activo' ? 'Suspender' : 'Reactivar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Crear estudio</h2>
      <p className="suave">
        Se crea con tres roles base (Administrador, Contador y Asistente). Después invitás a su administrador desde Usuarios.
      </p>
      <form onSubmit={crear} className="fila dos">
        <label>
          Nombre del estudio
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={120} />
        </label>
        <label>
          CUIT (opcional)
          <input value={cuit} onChange={(e) => setCuit(e.target.value)} inputMode="numeric" placeholder="30-12345678-9" />
        </label>
        <button disabled={enviando}>{enviando ? 'Creando…' : 'Crear estudio'}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
