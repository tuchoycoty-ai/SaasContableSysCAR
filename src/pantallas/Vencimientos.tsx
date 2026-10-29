import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { VencimientoCalendario, EscalaMonotributo } from '../lib/types'
import { OBLIGACION_LABEL } from '../lib/types'
import { fechaCorta, mensajeDb, pesos } from '../lib/utiles'

// Calendario y escala son globales (iguales para todos los estudios): leen todos, edita solo el holding.
export default function Vencimientos({ esHolding }: { esHolding: boolean }) {
  const [cal, setCal] = useState<VencimientoCalendario[]>([])
  const [esc, setEsc] = useState<EscalaMonotributo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [obl, setObl] = useState('iva_ddjj')
  const [per, setPer] = useState('')
  const [term, setTerm] = useState('0')
  const [fecha, setFecha] = useState('')
  const [fuente, setFuente] = useState('')

  const cargar = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('vencimientos_calendario').select('*').order('periodo', { ascending: false }).order('obligacion_codigo').order('terminacion').limit(300),
      supabase.from('monotributo_escalas').select('*').order('vigente_desde', { ascending: false }).order('categoria'),
    ])
    if (a.error || b.error) setError('No se pudo cargar el calendario.')
    else { setCal((a.data ?? []) as VencimientoCalendario[]); setEsc((b.data ?? []) as EscalaMonotributo[]) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  async function verificar(tabla: 'vencimientos_calendario' | 'monotributo_escalas', id: string, v: boolean) {
    const { error } = await supabase.from(tabla).update({ verificado: v }).eq('id', id)
    if (error) setError(mensajeDb(error, 'No se pudo actualizar.'))
    await cargar()
  }

  async function agregar(e: FormEvent) {
    e.preventDefault(); setError(null)
    const { error } = await supabase.from('vencimientos_calendario').upsert(
      { obligacion_codigo: obl, periodo: per, terminacion: Number(term), fecha, fuente: fuente.trim() || null, verificado: true },
      { onConflict: 'obligacion_codigo,periodo,terminacion' })
    if (error) setError(mensajeDb(error, 'No se pudo guardar el vencimiento.'))
    await cargar()
  }

  const sinVerificar = cal.filter((c) => !c.verificado).length + esc.filter((c) => !c.verificado).length
  const Estado = ({ v }: { v: boolean }) => <span className={`badge ${v ? 'vigente' : 'pendiente'}`}>{v ? 'Verificado' : 'Sin verificar'}</span>

  return (
    <section>
      <h2>Vencimientos y escala de monotributo</h2>
      <p className="suave">Datos comunes a todos los estudios. Los carga y confirma el holding; los alertas de vencimientos se calculan a partir de acá.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {sinVerificar > 0 && <p className="aviso">Hay {sinVerificar} datos sin verificar contra ARCA. Confirmalos antes de confiar en los avisos.</p>}

      {esHolding && (
        <form onSubmit={agregar}>
          <h3>Cargar / corregir un vencimiento</h3>
          <div className="fila cuatro">
            <label>Obligación
              <select value={obl} onChange={(e) => setObl(e.target.value)}>
                {Object.entries(OBLIGACION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Período (AAAA-MM)<input type="month" value={per} required onChange={(e) => setPer(e.target.value)} /></label>
            <label>Terminación CUIT (0-9)<input type="number" min={0} max={9} value={term} onChange={(e) => setTerm(e.target.value)} /></label>
            <label>Fecha<input type="date" value={fecha} required onChange={(e) => setFecha(e.target.value)} /></label>
          </div>
          <div className="fila dos">
            <label>Fuente<input value={fuente} placeholder="Ej: RG ARCA / calendario oficial" onChange={(e) => setFuente(e.target.value)} /></label>
            <button type="submit">Guardar (queda verificado)</button>
          </div>
        </form>
      )}

      <h3>Calendario</h3>
      <div className="tabla-scroll">
        <table>
          <thead><tr><th>Obligación</th><th>Período</th><th>Terminación</th><th>Fecha</th><th>Fuente</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {cal.map((c) => (
              <tr key={c.id}>
                <td>{OBLIGACION_LABEL[c.obligacion_codigo] ?? c.obligacion_codigo}</td><td>{c.periodo}</td><td>{c.terminacion}</td>
                <td>{fechaCorta(c.fecha)}</td><td className="suave">{c.fuente ?? '—'}</td><td><Estado v={c.verificado} /></td>
                <td>{esHolding && <button className="secundario" onClick={() => verificar('vencimientos_calendario', c.id, !c.verificado)}>{c.verificado ? 'Quitar verificación' : 'Marcar verificado'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Escala de monotributo</h3>
      <div className="tabla-scroll">
        <table>
          <thead><tr><th>Categoría</th><th>Vigente desde</th><th>Ingresos máx. (12 m)</th><th>Cuota servicios</th><th>Cuota bienes</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {esc.map((c) => (
              <tr key={c.id}>
                <td>{c.categoria}</td><td>{fechaCorta(c.vigente_desde)}</td><td>{pesos(c.ingresos_max)}</td>
                <td>{pesos(c.cuota_servicios)}</td><td>{pesos(c.cuota_bienes)}</td><td><Estado v={c.verificado} /></td>
                <td>{esHolding && <button className="secundario" onClick={() => verificar('monotributo_escalas', c.id, !c.verificado)}>{c.verificado ? 'Quitar verificación' : 'Marcar verificado'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
