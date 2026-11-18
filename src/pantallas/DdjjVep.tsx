import { useEffect, useMemo, useState } from 'react'
import type { Estudio } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { descargarCsv, fechaCorta, formatoCuit, hoyLocal, pesos } from '../lib/utiles'
import {
  cargarPagos, cargarPresentaciones, claveVenc, enTermino, NATURALEZA_LABEL, nombreFormulario, obligacionDeFormulario, obligacionDePago, paraTotales,
  periodoPago, queSePago, totalesPagos, vencimientos, type PagoArca, type Presentacion,
} from '../lib/ddjjVep'

const mesActual = () => hoyLocal().slice(0, 7)
function mesesAtras(n: number): string {
  const [a, m] = mesActual().split('-').map(Number)
  const d = new Date(a, m - 1 - n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const ultimoDia = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` }
const coma = (n: number) => n.toFixed(2).replace('.', ',')

export default function DdjjVep({ estudio }: { estudio: Estudio }) {
  const { clientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('')
  const [desde, setDesde] = useState(mesesAtras(5))
  const [hasta, setHasta] = useState(mesActual())
  const [pagos, setPagos] = useState<PagoArca[]>([])
  const [djs, setDjs] = useState<Presentacion[]>([])
  const [venc, setVenc] = useState<Record<string, string | null>>({})
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soloIntereses, setSoloIntereses] = useState(false)

  const cliente = (id: string) => clientes.find((c) => c.id === id)

  useEffect(() => {
    if (!desde || !hasta || desde > hasta) return
    let cancelado = false
    setCargando(true); setError(null)
    Promise.all([
      cargarPagos(estudio.id, clienteId, `${desde}-01`, ultimoDia(hasta)),
      cargarPresentaciones(estudio.id, clienteId, `${desde}-01`, ultimoDia(hasta)),
    ]).then(async ([p, d]) => {
      if (cancelado) return
      const claves: { obligacion: string; periodo: string; cuit: string }[] = []
      for (const x of d) { const o = obligacionDeFormulario(x.formulario); const c = clientes.find((k) => k.id === x.client_id); if (o && x.periodo && c) claves.push({ obligacion: o, periodo: x.periodo, cuit: c.cuit }) }
      for (const x of p) { const o = obligacionDePago(x); const c = clientes.find((k) => k.id === x.client_id); if (o && c) claves.push({ obligacion: o.codigo, periodo: o.periodo, cuit: c.cuit }) }
      const v = await vencimientos(claves)
      if (cancelado) return
      setPagos(p); setDjs(d); setVenc(v); setCargando(false)
    }).catch((e: unknown) => { if (!cancelado) { setError(e instanceof Error ? e.message : 'No se pudo cargar.'); setCargando(false) } })
    return () => { cancelado = true }
  }, [estudio.id, clienteId, desde, hasta, clientes])

  const vencDj = (d: Presentacion): string | null => {
    const o = obligacionDeFormulario(d.formulario); const c = cliente(d.client_id)
    return o && d.periodo && c ? venc[claveVenc(o, d.periodo, c.cuit)] ?? null : null
  }
  const vencPago = (p: PagoArca): string | null => {
    if (p.vence) return p.vence
    const o = obligacionDePago(p); const c = cliente(p.client_id)
    return o && c ? venc[claveVenc(o.codigo, o.periodo, c.cuit)] ?? null : null
  }
  // VEP que corresponde a una DJ: el que dice «generado desde la presentación» o, para el F.931, el SICOSS del mismo período.
  const pagoDeDj = (d: Presentacion): PagoArca | null =>
    pagos.find((p) => p.client_id === d.client_id && !p.es_consolidado && (p.dj_nro === d.nro_transaccion || (d.formulario === '931' && obligacionDePago(p)?.periodo === d.periodo))) ?? null

  const visibles = useMemo(() => (soloIntereses ? pagos.filter((p) => p.intereses > 0 || p.naturaleza === 'multa') : pagos), [pagos, soloIntereses])
  const t = totalesPagos(pagos)
  const hijos = new Set(pagos.filter((p) => p.vep_consolidado).map((p) => `${p.client_id}|${p.vep_consolidado}`))
  const esDuplicado = (p: PagoArca) => !!(p.es_consolidado && p.referencia && hijos.has(`${p.client_id}|${p.referencia}`))
  const nombreCli = (id: string) => cliente(id)?.razon_social ?? '—'

  function exportarPagos() {
    descargarCsv(`vep-pagados-${desde}-a-${hasta}.csv`, [
      ['Fecha de pago', 'Hora', 'Cliente', 'CUIT', 'Tipo de pago', 'Concepto', 'Subconcepto', 'Período', 'Cuota', 'Qué se pagó', 'Naturaleza', 'Intereses incluidos', 'Importe pagado', 'Vencimiento', 'En término', 'N° VEP', 'VEP consolidado', 'N° transacción', 'Medio de pago', 'Banco', 'Se cuenta en totales'],
      ...pagos.map((p) => {
        const v = vencPago(p); const et = v ? enTermino(p.fecha, v) : null
        return [fechaCorta(p.fecha), p.hora_pago ?? '', nombreCli(p.client_id), formatoCuit(cliente(p.client_id)?.cuit ?? ''), p.tipo_pago ?? p.concepto, p.concepto_arca ?? '', p.subconcepto_arca ?? '', p.periodo_arca ?? '', p.cuota ?? '',
          queSePago(p).detalle, p.naturaleza ? NATURALEZA_LABEL[p.naturaleza] : '', coma(p.intereses), coma(p.importe), v ? fechaCorta(v) : '', et?.texto ?? '', p.referencia ?? '', p.vep_consolidado ?? '', p.nro_transaccion ?? '', p.medio ?? '', p.banco ?? '', esDuplicado(p) ? 'No (ya incluido en sus subVEP)' : 'Sí']
      }),
    ])
  }
  function exportarDjs() {
    descargarCsv(`ddjj-presentadas-${desde}-a-${hasta}.csv`, [
      ['Fecha de presentación', 'Hora', 'Cliente', 'CUIT', 'Formulario', 'Impuesto', 'Concepto', 'Período', 'Vencimiento', 'En término', 'Registros', 'N° transacción', 'Presentada por', 'VEP pagado', 'Fecha de pago', 'Importe pagado'],
      ...djs.map((d) => {
        const v = vencDj(d); const et = v ? enTermino(d.fecha, v) : null; const p = pagoDeDj(d)
        return [fechaCorta(d.fecha), d.hora ?? '', nombreCli(d.client_id), formatoCuit(cliente(d.client_id)?.cuit ?? ''), nombreFormulario(d), d.impuesto ?? '', d.concepto ?? '', d.periodo ?? '', v ? fechaCorta(v) : '', et?.texto ?? '',
          d.registros ?? '', d.nro_transaccion, d.presentada_por ?? '', p?.referencia ?? '', p ? fechaCorta(p.fecha) : '', p ? coma(p.importe) : '']
      }),
    ])
  }

  return (
    <section>
      <h2>DDJJ presentadas y VEP pagados</h2>
      <div className="fila tres">
        <label>Cliente
          <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
            <option value="">Todos los clientes</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>)}
          </select>
        </label>
        <label>Desde<input type="month" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="month" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} /></label>
      </div>
      <p className="suave">
        Sale de los PDF que guardás en «Carpetas ARCA» (acuses de DJ y comprobantes de pago de VEP). Muestra qué se pagó, si incluye intereses, cuándo se pagó y cuándo vencía.
        El vencimiento se toma del calendario del holding o del propio VEP cuando lo informa; si no está cargado, queda en blanco.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {cargando && <p className="suave">Cargando…</p>}

      {!cargando && !error && (
        <>
          <div className="tarjetas">
            <div className="indicador"><span className="suave">Total pagado</span><strong>{pesos(t.total)}</strong><span className="suave">{t.cantidad} pago{t.cantidad === 1 ? '' : 's'} (VEP)</span></div>
            <div className="indicador"><span className="suave">De los cuales intereses</span><strong>{pesos(t.intereses)}</strong><span className="suave">{t.total > 0 ? `${((t.intereses / t.total) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })}% del total` : '—'}</span></div>
            <div className="indicador"><span className="suave">Capital e impuestos</span><strong>{pesos(t.capital)}</strong>{t.multas > 0 && <span className="suave">Multas {pesos(t.multas)}</span>}</div>
            <div className="indicador"><span className="suave">DDJJ presentadas</span><strong>{djs.length}</strong></div>
          </div>
          {t.sinDetalle > 0 && <p className="aviso">{t.sinDetalle} pago{t.sinDetalle === 1 ? '' : 's'} se cargaron antes de que se guardara el detalle (intereses, período, banco…). Para completarlos, en «Carpetas ARCA» tocá «Volver a leer los PDF ya procesados» y confirmá de nuevo: no se duplica nada.</p>}

          <h3>Declaraciones juradas presentadas</h3>
          <p className="suave"><button className="secundario" onClick={exportarDjs} disabled={djs.length === 0}>Descargar CSV</button></p>
          {djs.length === 0 ? <p className="suave">No hay acuses de DJ cargados en este período. Guardá los PDF «Acuse de recibo de DJ» en la carpeta «DDJJ y VEP» de «Carpetas ARCA».</p> : (
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Presentada</th><th>Cliente</th><th>Formulario</th><th>Período</th><th>Vencimiento</th><th>Registros</th><th>Transacción</th><th>Pago asociado</th></tr></thead>
                <tbody>
                  {djs.map((d) => {
                    const v = vencDj(d); const et = v ? enTermino(d.fecha, v) : null; const p = pagoDeDj(d)
                    return (
                      <tr key={d.id}>
                        <td>{fechaCorta(d.fecha)}<br /><span className="suave">{d.hora ?? ''}</span></td>
                        <td>{nombreCli(d.client_id)}</td>
                        <td>{nombreFormulario(d)}<br /><span className="suave">{[d.impuesto, d.concepto].filter(Boolean).join(' · ')}</span></td>
                        <td>{d.periodo ?? '—'}</td>
                        <td>{v ? <>{fechaCorta(v)} {et && <span className={`badge ${et.tarde ? 'vencida' : 'vigente'}`}>{et.texto}</span>}</> : <span className="suave">—</span>}</td>
                        <td>{d.registros ?? '—'}</td>
                        <td>{d.nro_transaccion}<br /><span className="suave">{d.presentada_por ? `por ${d.presentada_por}` : ''}</span></td>
                        <td>{p ? <>VEP {p.referencia}<br /><span className="suave">{fechaCorta(p.fecha)} · {pesos(p.importe)}</span></> : (d.formulario === '931' || d.formulario === '2002') ? <span className="badge pendiente">Sin VEP cargado</span> : <span className="suave">No corresponde</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3>VEP pagados</h3>
          <p className="suave">
            <button className="secundario" onClick={exportarPagos} disabled={pagos.length === 0}>Descargar CSV</button>{' '}
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={soloIntereses} onChange={(e) => setSoloIntereses(e.target.checked)} style={{ width: 'auto' }} /> Solo pagos con intereses o multas
            </label>
          </p>
          {visibles.length === 0 ? <p className="suave">No hay pagos para mostrar en este período.</p> : (
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Pagado</th><th>Cliente</th><th>Qué se pagó</th><th>Período</th><th>Intereses</th><th>Importe</th><th>Vencía</th><th>Medio</th><th>VEP</th></tr></thead>
                <tbody>
                  {visibles.map((p) => {
                    const q = queSePago(p); const v = vencPago(p); const et = v ? enTermino(p.fecha, v) : null
                    return (
                      <tr key={p.id} style={esDuplicado(p) ? { opacity: 0.6 } : undefined}>
                        <td>{fechaCorta(p.fecha)}<br /><span className="suave">{p.hora_pago ?? ''}</span></td>
                        <td>{nombreCli(p.client_id)}</td>
                        <td>
                          <strong>{q.titulo}</strong><br /><span className="suave">{q.detalle}</span>
                          {p.subconcepto_arca && p.naturaleza !== 'capital' && <><br /><span className="suave">{p.subconcepto_arca}</span></>}
                          {(p.detalle?.length ?? 0) > 1 && (
                            <details><summary className="suave">Ver desglose ({p.detalle!.length})</summary>
                              <ul>{p.detalle!.map((d, i) => <li key={i}>{d.nombre}{d.codigo ? ` (${d.codigo})` : ''}: {pesos(d.importe)}</li>)}</ul>
                            </details>
                          )}
                          {esDuplicado(p) && <><br /><span className="badge">Consolidado: ya incluido en sus subVEP</span></>}
                        </td>
                        <td>{periodoPago(p)}</td>
                        <td>{p.intereses > 0 ? <span className="badge pendiente">{pesos(p.intereses)}</span> : p.tipo_pago === null ? <span className="suave">?</span> : <span className="suave">No incluye</span>}</td>
                        <td>{pesos(p.importe)}</td>
                        <td>{v ? <>{fechaCorta(v)}<br />{et && <span className={`badge ${et.tarde ? 'vencida' : 'vigente'}`}>{et.texto}</span>}</> : <span className="suave">—</span>}</td>
                        <td>{p.medio ?? '—'}<br /><span className="suave">{[p.entidad_pago, p.banco].filter(Boolean).join(' · ')}</span></td>
                        <td>{p.referencia ?? '—'}<br /><span className="suave">{p.vep_consolidado ? `sub de ${p.vep_consolidado}` : p.es_consolidado ? 'consolidado' : ''}{p.nro_transaccion ? ` · op. ${p.nro_transaccion}` : ''}</span></td>
                      </tr>
                    )
                  })}
                  <tr><th colSpan={4}>Total (sin duplicar consolidados)</th><th>{pesos(totalesPagos(visibles).intereses)}</th><th>{pesos(paraTotales(visibles).reduce((a, p) => a + p.importe, 0))}</th><td colSpan={3}></td></tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
