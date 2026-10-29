import { useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, Recategorizacion as Resultado } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { mensajeDb, pesos } from '../lib/utiles'

export default function Recategorizacion({ estudio }: { estudio: Estudio }) {
  const { clientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('')
  const [res, setRes] = useState<Resultado | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  async function calcular() {
    setError(null); setRes(null); setCargando(true)
    const { data, error } = await supabase.rpc('calcular_recategorizacion', { p_tenant: estudio.id, p_client: clienteId })
    setCargando(false)
    if (error) setError(mensajeDb(error, 'No se pudo calcular.'))
    else setRes(data as Resultado)
  }

  return (
    <section>
      <h2>Recategorización de monotributo</h2>
      <p className="suave">
        Estima el uso del tope con los comprobantes emitidos de los últimos 12 meses completos (las notas de crédito restan).
        <strong> Solo evalúa el tope de ingresos</strong>: no contempla superficie, energía, alquileres ni precio unitario máximo. La decisión final es tuya.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="fila dos">
        <label>
          Cliente
          <select value={clienteId} onChange={(e) => { setClienteId(e.target.value); setRes(null) }}>
            <option value="">Elegí un cliente…</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social}</option>)}
          </select>
        </label>
        <button onClick={calcular} disabled={!clienteId || cargando}>{cargando ? 'Calculando…' : 'Calcular'}</button>
      </div>
      {res && (
        <div>
          <table>
            <tbody>
              <tr><th>Ingresos últimos 12 meses</th><td>{pesos(res.ingresos_12m)}</td></tr>
              <tr><th>Categoría actual</th><td>{res.categoria_actual ?? '—'}</td></tr>
              <tr><th>Tope de la categoría</th><td>{pesos(res.tope_actual)}</td></tr>
              <tr><th>Uso del tope</th><td>{res.uso_porcentaje !== null ? `${res.uso_porcentaje}%` : '—'}</td></tr>
              <tr><th>Categoría sugerida (por ingresos)</th><td>{res.excede_k ? 'Excede la categoría K' : (res.categoria_sugerida ?? '—')}</td></tr>
            </tbody>
          </table>
          {!res.escala_verificada && <p className="aviso">La escala de montos usada todavía no fue verificada contra ARCA por el holding.</p>}
          {(res.sin_confirmar ?? 0) > 0 && <p className="aviso">{res.sin_confirmar} comprobantes sin confirmar entran en el cálculo.</p>}
          {(res.meses_sin_comprobantes ?? []).length > 0 && <p className="aviso">Meses sin comprobantes: {res.meses_sin_comprobantes!.join(', ')}.</p>}
          {(res.advertencias ?? []).map((a, i) => <p key={i} className="aviso">{a}</p>)}
        </div>
      )}
    </section>
  )
}
