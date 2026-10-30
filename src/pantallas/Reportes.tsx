import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { descargarCsv, formatoCuit, hoyLocal, pesos } from '../lib/utiles'

type FilaMes = { mes: string; rubro: 'emitido' | 'recibido' | 'pago'; estado_dato: string; cantidad: number; neto: number; iva: number; total: number }
type Cartera = { client_id: string; razon_social: string; cuit: string; regimen: string; emitidos_neto: number; recibidos_neto: number; iva_debito: number; iva_credito: number; cantidad: number; sin_confirmar: number }
type Top = { doc: string; nombre: string | null; cantidad: number; neto: number; total: number }

const mesActual = () => hoyLocal().slice(0, 7)
function mesesAtras(n: number): string {
  const [a, m] = mesActual().split('-').map(Number)
  const d = new Date(a, m - 1 - n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const ultimoDia = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` }
const num = (v: unknown) => Number(v ?? 0)
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v.toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`)

export default function Reportes({ estudio }: { estudio: Estudio }) {
  const { clientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('') // '' = toda la cartera
  const [desde, setDesde] = useState(mesesAtras(11))
  const [hasta, setHasta] = useState(mesActual())
  const [cartera, setCartera] = useState<Cartera[]>([])
  const [pendientes, setPendientes] = useState<Record<string, number>>({})
  const [meses, setMeses] = useState<FilaMes[]>([])
  const [topV, setTopV] = useState<Top[]>([])
  const [topC, setTopC] = useState<Top[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  useEffect(() => {
    if (!desde || !hasta || desde > hasta) return
    let cancelado = false
    setCargando(true); setError(null)
    const d = `${desde}-01`, h = ultimoDia(hasta)
    const consulta = clienteId === ''
      ? Promise.all([
          supabase.rpc('resumen_cartera', { p_tenant: estudio.id, p_desde: d, p_hasta: h }),
          supabase.from('obligaciones_cliente').select('client_id').eq('tenant_id', estudio.id).eq('estado', 'pendiente'),
        ]).then(([a, b]) => {
          if (cancelado) return
          if (a.error) return setError('No se pudo calcular el reporte.')
          setCartera(((a.data ?? []) as Cartera[]).map((f) => ({ ...f, emitidos_neto: num(f.emitidos_neto), recibidos_neto: num(f.recibidos_neto), iva_debito: num(f.iva_debito), iva_credito: num(f.iva_credito), cantidad: num(f.cantidad), sin_confirmar: num(f.sin_confirmar) })))
          const m: Record<string, number> = {}
          for (const o of (b.data ?? []) as { client_id: string }[]) m[o.client_id] = (m[o.client_id] ?? 0) + 1
          setPendientes(m)
        })
      : Promise.all([
          supabase.rpc('resumen_mensual', { p_tenant: estudio.id, p_client: clienteId, p_desde: d, p_hasta: h }),
          supabase.rpc('top_contrapartes', { p_tenant: estudio.id, p_client: clienteId, p_desde: d, p_hasta: h, p_sentido: 'emitido', p_limite: 5 }),
          supabase.rpc('top_contrapartes', { p_tenant: estudio.id, p_client: clienteId, p_desde: d, p_hasta: h, p_sentido: 'recibido', p_limite: 5 }),
        ]).then(([a, v, c]) => {
          if (cancelado) return
          if (a.error || v.error || c.error) return setError('No se pudo calcular el reporte.')
          setMeses(((a.data ?? []) as FilaMes[]).map((f) => ({ ...f, cantidad: num(f.cantidad), neto: num(f.neto), iva: num(f.iva), total: num(f.total) })))
          const t = (x: unknown) => ((x ?? []) as Top[]).map((f) => ({ ...f, cantidad: num(f.cantidad), neto: num(f.neto), total: num(f.total) }))
          setTopV(t(v.data)); setTopC(t(c.data))
        })
    consulta.finally(() => { if (!cancelado) setCargando(false) })
    return () => { cancelado = true }
  }, [estudio.id, clienteId, desde, hasta])

  // ---- Serie mensual del cliente ----
  const serie = useMemo(() => {
    const claves = [...new Set(meses.map((f) => f.mes.slice(0, 7)))].sort()
    const s = (mes: string, rubro: FilaMes['rubro'], campo: 'neto' | 'iva' | 'total') => meses.filter((f) => f.mes.slice(0, 7) === mes && f.rubro === rubro).reduce((a, f) => a + f[campo], 0)
    return claves.map((mes, i, arr) => {
      const ventas = s(mes, 'emitido', 'neto'), compras = s(mes, 'recibido', 'neto')
      const previo = i > 0 ? s(arr[i - 1], 'emitido', 'neto') : null
      const pagos = s(mes, 'pago', 'total')
      return {
        mes, ventas, compras, resultado: ventas - compras,
        margen: ventas > 0 ? ((ventas - compras) / ventas) * 100 : null,
        variacion: previo !== null && previo > 0 ? ((ventas - previo) / previo) * 100 : null,
        iva: s(mes, 'emitido', 'iva') - s(mes, 'recibido', 'iva'), pagos,
        carga: ventas > 0 ? (pagos / ventas) * 100 : null,
      }
    })
  }, [meses])

  const tot = (k: 'ventas' | 'compras' | 'pagos' | 'iva') => serie.reduce((a, f) => a + f[k], 0)
  const mejor = serie.length ? serie.reduce((a, b) => (b.ventas > a.ventas ? b : a)) : null
  const peor = serie.length ? serie.reduce((a, b) => (b.ventas < a.ventas ? b : a)) : null
  const sinConfirmar = meses.filter((f) => f.rubro !== 'pago' && f.estado_dato !== 'confirmado').reduce((a, f) => a + f.cantidad, 0)
  const cliente = clientes.find((c) => c.id === clienteId)
  const totalTopV = Math.max(tot('ventas'), 1)
  const totalTopC = Math.max(tot('compras'), 1)

  function exportar() {
    if (clienteId === '') {
      descargarCsv(`cartera-${desde}-a-${hasta}.csv`, [
        ['Cliente', 'CUIT', 'Régimen', 'Facturado neto', 'Compras neto', 'Resultado', 'IVA débito', 'IVA crédito', 'Posición IVA', 'Comprobantes', 'Sin confirmar'],
        ...cartera.map((c) => [c.razon_social, c.cuit, c.regimen, c.emitidos_neto, c.recibidos_neto, c.emitidos_neto - c.recibidos_neto, c.iva_debito, c.iva_credito, c.iva_debito - c.iva_credito, c.cantidad, c.sin_confirmar]),
      ])
    } else {
      descargarCsv(`analisis-${cliente?.razon_social ?? 'cliente'}-${desde}-a-${hasta}.csv`, [
        ['Mes', 'Ventas netas', 'Compras netas', 'Resultado', 'Margen %', 'Variación ventas %', 'Posición IVA', 'Impuestos pagados', 'Carga tributaria %'],
        ...serie.map((f) => [f.mes, f.ventas, f.compras, f.resultado, f.margen ?? '', f.variacion ?? '', f.iva, f.pagos, f.carga ?? '']),
      ])
    }
  }

  const totC = (k: keyof Cartera) => cartera.reduce((a, c) => a + Number(c[k]), 0)

  return (
    <section>
      <h2>Reportes y análisis financiero</h2>
      <div className="fila tres">
        <label>Alcance
          <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
            <option value="">Toda la cartera</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>)}
          </select>
        </label>
        <label>Desde<input type="month" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="month" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} /></label>
      </div>
      <p className="suave">
        <button className="secundario" onClick={exportar}>Descargar CSV</button>{' '}
        <button className="secundario" onClick={() => window.print()}>Imprimir / guardar PDF</button>
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {cargando && <p className="suave">Calculando…</p>}
      <p className="suave">
        Estimaciones sobre los comprobantes importados (las notas de crédito restan). «Resultado» = ventas netas − compras netas: no es un balance ni
        incluye sueldos, amortizaciones ni gastos sin comprobante. La posición de IVA no considera saldos anteriores, percepciones ni retenciones.
      </p>

      {clienteId === '' && !cargando && (
        cartera.length === 0 ? <p className="suave">No hay clientes para mostrar.</p> : (
          <>
            {totC('sin_confirmar') > 0 && <p className="aviso">{totC('sin_confirmar')} comprobantes de la cartera todavía no están confirmados.</p>}
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Cliente</th><th>Régimen</th><th>Facturado (neto)</th><th>Compras (neto)</th><th>Resultado</th><th>Posición IVA</th><th>Comprob.</th><th>Sin confirmar</th><th>Obligaciones pendientes</th></tr></thead>
                <tbody>
                  {cartera.map((c) => (
                    <tr key={c.client_id}>
                      <td>{c.razon_social}<br /><span className="suave">{formatoCuit(c.cuit)}</span></td><td>{c.regimen.replace('_', ' ')}</td>
                      <td>{pesos(c.emitidos_neto)}</td><td>{pesos(c.recibidos_neto)}</td><td>{pesos(c.emitidos_neto - c.recibidos_neto)}</td>
                      <td>{c.regimen === 'responsable_inscripto' ? pesos(c.iva_debito - c.iva_credito) : <span className="suave">—</span>}</td>
                      <td>{c.cantidad}</td><td>{c.sin_confirmar > 0 ? <span className="badge pendiente">{c.sin_confirmar}</span> : 0}</td><td>{pendientes[c.client_id] ?? 0}</td>
                    </tr>
                  ))}
                  <tr>
                    <th>Total</th><td></td><th>{pesos(totC('emitidos_neto'))}</th><th>{pesos(totC('recibidos_neto'))}</th><th>{pesos(totC('emitidos_neto') - totC('recibidos_neto'))}</th><td></td><th>{totC('cantidad')}</th><td></td><td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {clienteId !== '' && !cargando && (
        serie.length === 0 ? <p className="aviso">{cliente?.razon_social} no tiene comprobantes importados en este período.</p> : (
          <>
            {sinConfirmar > 0 && <p className="aviso">{sinConfirmar} comprobantes del período todavía no están confirmados.</p>}
            <div className="tarjetas">
              <div className="indicador"><span className="suave">Ventas netas</span><strong>{pesos(tot('ventas'))}</strong><span className="suave">Promedio mensual {pesos(tot('ventas') / serie.length)}</span></div>
              <div className="indicador"><span className="suave">Compras netas</span><strong>{pesos(tot('compras'))}</strong></div>
              <div className="indicador"><span className="suave">Resultado estimado</span><strong>{pesos(tot('ventas') - tot('compras'))}</strong><span className="suave">Margen {pct(tot('ventas') > 0 ? ((tot('ventas') - tot('compras')) / tot('ventas')) * 100 : null)}</span></div>
              <div className="indicador"><span className="suave">Impuestos pagados</span><strong>{pesos(tot('pagos'))}</strong><span className="suave">Carga {pct(tot('ventas') > 0 ? (tot('pagos') / tot('ventas')) * 100 : null)} de las ventas</span></div>
            </div>
            {mejor && peor && serie.length > 1 && <p className="suave">Mejor mes de ventas: {mejor.mes} ({pesos(mejor.ventas)}). Menor: {peor.mes} ({pesos(peor.ventas)}).</p>}
            <h3>Evolución mensual</h3>
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Mes</th><th>Ventas</th><th>Var.</th><th>Compras</th><th>Resultado</th><th>Margen</th><th>Posición IVA</th><th>Impuestos pagados</th><th>Carga</th></tr></thead>
                <tbody>
                  {serie.map((f) => (
                    <tr key={f.mes}><td>{f.mes}</td><td>{pesos(f.ventas)}</td><td>{pct(f.variacion)}</td><td>{pesos(f.compras)}</td><td>{pesos(f.resultado)}</td><td>{pct(f.margen)}</td><td>{pesos(f.iva)}</td><td>{pesos(f.pagos)}</td><td>{pct(f.carga)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {[{ t: 'Principales clientes (por ventas)', d: topV, base: totalTopV }, { t: 'Principales proveedores (por compras)', d: topC, base: totalTopC }].map((b) => (
              <div key={b.t}>
                <h3>{b.t}</h3>
                {b.d.length === 0 ? <p className="suave">Sin datos.</p> : (
                  <div className="tabla-scroll">
                    <table>
                      <thead><tr><th>CUIT</th><th>Nombre</th><th>Comprob.</th><th>Neto</th><th>% del total</th></tr></thead>
                      <tbody>{b.d.map((x) => <tr key={x.doc}><td>{x.doc ? formatoCuit(x.doc) : '—'}</td><td>{x.nombre ?? '—'}</td><td>{x.cantidad}</td><td>{pesos(x.neto)}</td><td>{pct((x.neto / b.base) * 100)}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
                {b.d[0] && b.d[0].neto / b.base > 0.5 && <p className="aviso">Alta concentración: {b.d[0].nombre ?? b.d[0].doc} representa más de la mitad del total.</p>}
              </div>
            ))}
          </>
        )
      )}
    </section>
  )
}
