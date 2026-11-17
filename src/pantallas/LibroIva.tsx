import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { descargarCsv, formatoCuit, hoyLocal, pesos } from '../lib/utiles'

type Fila = {
  id: string; fecha: string; tipo_cbte: number; punto_venta: number; numero: number; doc_contraparte: string | null; contraparte: string | null
  neto_gravado: number; neto_no_gravado: number; exento: number; iva: number; otros_tributos: number; total: number
  neto_0: number; neto_2_5: number; iva_2_5: number; neto_5: number; iva_5: number; neto_10_5: number; iva_10_5: number
  neto_21: number; iva_21: number; neto_27: number; iva_27: number
  estado_dato: string; advertencia: string | null; moneda: string
}
type Sentido = 'emitido' | 'recibido'

const CAMPOS = 'id, fecha, tipo_cbte, punto_venta, numero, doc_contraparte, contraparte, neto_gravado, neto_no_gravado, exento, iva, otros_tributos, total, neto_0, neto_2_5, iva_2_5, neto_5, iva_5, neto_10_5, iva_10_5, neto_21, iva_21, neto_27, iva_27, estado_dato, advertencia, moneda'
const ALICUOTAS = [
  { k: '21', etiqueta: '21%' }, { k: '10_5', etiqueta: '10,5%' }, { k: '27', etiqueta: '27%' }, { k: '5', etiqueta: '5%' }, { k: '2_5', etiqueta: '2,5%' },
] as const
const TIPOS: Record<number, string> = {
  1: 'FA A', 2: 'ND A', 3: 'NC A', 4: 'Recibo A', 6: 'FA B', 7: 'ND B', 8: 'NC B', 9: 'Recibo B', 11: 'FA C', 12: 'ND C', 13: 'NC C', 15: 'Recibo C',
  19: 'FA E', 20: 'ND E', 21: 'NC E', 51: 'FA M', 52: 'ND M', 53: 'NC M', 201: 'FCE A', 202: 'ND FCE A', 203: 'NC FCE A', 206: 'FCE B', 207: 'ND FCE B', 208: 'NC FCE B',
  211: 'FCE C', 212: 'ND FCE C', 213: 'NC FCE C',
}
const nombreTipo = (t: number) => TIPOS[t] ?? `Tipo ${t}`
const comprobante = (f: Fila) => `${nombreTipo(f.tipo_cbte)} ${String(f.punto_venta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}`
const fechaAr = (iso: string) => iso.split('-').reverse().join('/')
const redondear = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => Number(v ?? 0)
const cero = (n: number) => Math.abs(n) < 0.005
const mesActual = () => hoyLocal().slice(0, 7)
function mesAnterior(): string {
  const [a, m] = mesActual().split('-').map(Number)
  const d = new Date(a, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const ultimoDia = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` }

// Lo gravado que el archivo no discriminó por alícuota (queda solo en el total de neto gravado).
const sinDiscriminar = (f: Fila) => redondear(f.neto_gravado - (f.neto_0 + f.neto_2_5 + f.neto_5 + f.neto_10_5 + f.neto_21 + f.neto_27))

type Col = { id: string; titulo: string; grupo?: string; valor: (f: Fila) => number }

export default function LibroIva({ estudio }: { estudio: Estudio }) {
  const { clientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('')
  const [sentido, setSentido] = useState<Sentido>('emitido')
  const [desde, setDesde] = useState(mesAnterior())
  const [hasta, setHasta] = useState(mesAnterior())
  const [todas, setTodas] = useState(false)
  const [filas, setFilas] = useState<Fila[]>([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!clienteId || !desde || !hasta || desde > hasta) { setFilas([]); return }
    let cancelado = false
    setCargando(true); setError(null)
    ;(async () => {
      const todos: Fila[] = []
      for (let desdeFila = 0; desdeFila < 20000; desdeFila += 1000) {
        const { data, error: e } = await supabase.from('comprobantes').select(CAMPOS)
          .eq('tenant_id', estudio.id).eq('client_id', clienteId).eq('sentido', sentido)
          .gte('fecha', `${desde}-01`).lte('fecha', ultimoDia(hasta))
          .order('fecha').order('tipo_cbte').order('punto_venta').order('numero')
          .range(desdeFila, desdeFila + 999)
        if (cancelado) return
        if (e) { setError('No se pudo cargar el libro.'); setCargando(false); return }
        const lote = (data ?? []) as Record<string, unknown>[]
        for (const r of lote) {
          const f = { ...r } as unknown as Fila
          for (const k of Object.keys(f) as (keyof Fila)[]) if (k.startsWith('neto_') || k.startsWith('iva') || ['exento', 'otros_tributos', 'total'].includes(k)) (f as unknown as Record<string, number>)[k] = num(r[k])
          todos.push(f)
        }
        if (lote.length < 1000) break
      }
      if (!cancelado) { setFilas(todos); setCargando(false) }
    })()
    return () => { cancelado = true }
  }, [estudio.id, clienteId, sentido, desde, hasta])

  // Columnas: una por alícuota que tenga datos (la de 21% siempre), después lo no gravado, exento y los totales.
  const cols = useMemo<Col[]>(() => {
    const hay = (f: (x: Fila) => number) => filas.some((x) => !cero(f(x)))
    const c: Col[] = []
    for (const a of ALICUOTAS) {
      const neto = (x: Fila) => (x as unknown as Record<string, number>)[`neto_${a.k}`]
      const iva = (x: Fila) => (x as unknown as Record<string, number>)[`iva_${a.k}`]
      if (todas || a.k === '21' || hay(neto) || hay(iva)) {
        c.push({ id: `neto_${a.k}`, titulo: 'Neto', grupo: a.etiqueta, valor: neto }, { id: `iva_${a.k}`, titulo: 'IVA', grupo: a.etiqueta, valor: iva })
      }
    }
    if (todas || hay((x) => x.neto_0)) c.push({ id: 'neto_0', titulo: 'Neto', grupo: '0%', valor: (x) => x.neto_0 })
    if (hay(sinDiscriminar)) c.push({ id: 'sin', titulo: 'Gravado sin discriminar', valor: sinDiscriminar })
    c.push(
      { id: 'no_gravado', titulo: 'No gravado', valor: (x) => x.neto_no_gravado },
      { id: 'exento', titulo: 'Exento', valor: (x) => x.exento },
      { id: 'otros', titulo: 'Otros tributos', valor: (x) => x.otros_tributos },
      { id: 'iva_total', titulo: 'IVA total', valor: (x) => x.iva },
      { id: 'total', titulo: 'Total', valor: (x) => x.total },
    )
    return c
  }, [filas, todas])

  const totales = useMemo(() => cols.map((c) => redondear(filas.reduce((a, f) => a + c.valor(f), 0))), [cols, filas])
  const suma = (id: string) => totales[cols.findIndex((c) => c.id === id)] ?? 0
  const resumen = useMemo(() => {
    const r = ALICUOTAS.map((a) => ({ etiqueta: a.etiqueta, neto: suma(`neto_${a.k}`), iva: suma(`iva_${a.k}`) }))
    return r.filter((x) => !cero(x.neto) || !cero(x.iva))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totales, cols])
  const pendientes = filas.filter((f) => f.estado_dato === 'pendiente_validacion').length
  const hayHuerfanos = cols.some((c) => c.id === 'sin')
  const cliente = clientes.find((c) => c.id === clienteId)
  const esVentas = sentido === 'emitido'
  const titulo = esVentas ? 'Libro IVA Ventas' : 'Libro IVA Compras'

  function exportar() {
    const coma = (n: number) => n.toFixed(2).replace('.', ',')
    const enc = ['Fecha', 'Comprobante', 'CUIT', esVentas ? 'Cliente' : 'Proveedor', ...cols.map((c) => (c.grupo ? `${c.titulo} ${c.grupo}` : c.titulo))]
    descargarCsv(`${esVentas ? 'iva-ventas' : 'iva-compras'}-${cliente?.razon_social ?? 'cliente'}-${desde}${desde === hasta ? '' : `-a-${hasta}`}.csv`, [
      [`${titulo} · ${cliente?.razon_social ?? ''} · CUIT ${cliente ? formatoCuit(cliente.cuit) : ''} · ${desde}${desde === hasta ? '' : ` a ${hasta}`}`],
      enc,
      ...filas.map((f) => [fechaAr(f.fecha), comprobante(f), f.doc_contraparte ?? '', f.contraparte ?? '', ...cols.map((c) => coma(c.valor(f)))]),
      ['', '', '', 'TOTALES', ...totales.map(coma)],
    ])
  }

  // Encabezado de dos filas: las alícuotas se agrupan («IVA 21%» sobre Neto / IVA); el resto ocupa las dos filas.
  const cabecera = cols.reduce<{ nombre: string; n: number; titulo: string }[]>((a, c) => {
    const g = c.grupo ? `IVA ${c.grupo}` : ''
    if (g && a.length > 0 && a[a.length - 1].nombre === g) a[a.length - 1].n++
    else a.push({ nombre: g, n: 1, titulo: c.titulo })
    return a
  }, [])

  return (
    <section>
      <h2>Libro de IVA</h2>
      <div className="fila tres">
        <label>Cliente
          <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
            <option value="">Elegí un cliente…</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>)}
          </select>
        </label>
        <label>Desde<input type="month" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="month" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} /></label>
      </div>
      <p>
        <button className={esVentas ? '' : 'secundario'} onClick={() => setSentido('emitido')}>IVA Ventas (emitidos)</button>{' '}
        <button className={esVentas ? 'secundario' : ''} onClick={() => setSentido('recibido')}>IVA Compras (recibidos)</button>
      </p>
      <p className="suave">
        Muestra cada comprobante importado con su neto e IVA separado por alícuota, más no gravado, exento y otros tributos. Las notas de crédito restan.
        Es un detalle de apoyo para armar el libro y la declaración: no reemplaza el «Libro IVA Digital» de ARCA ni incluye percepciones o retenciones.
      </p>
      {!clienteId && <p className="aviso">Elegí un cliente para ver su libro.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {cargando && <p className="suave">Cargando…</p>}

      {clienteId && !cargando && !error && (
        filas.length === 0 ? <p className="aviso">No hay comprobantes {esVentas ? 'emitidos' : 'recibidos'} importados de {cliente?.razon_social} en ese período.</p> : (
          <>
            <p className="suave">
              <button className="secundario" onClick={exportar}>Descargar para Excel (CSV)</button>{' '}
              <button className="secundario" onClick={() => window.print()}>Imprimir / guardar PDF</button>{' '}
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} style={{ width: 'auto' }} /> Mostrar todas las alícuotas
              </label>
            </p>
            {pendientes > 0 && <p className="aviso">{pendientes} comprobante{pendientes === 1 ? '' : 's'} con datos a revisar (marcados con ⚠). Pasá el mouse sobre el aviso para ver el motivo.</p>}
            {hayHuerfanos && <p className="aviso">Algunos comprobantes no traen el desglose por alícuota: su neto gravado aparece en «Gravado sin discriminar». Se resuelve volviendo a importar el archivo de ARCA (anulando antes el lote anterior).</p>}

            <h3>{titulo} · {cliente?.razon_social}</h3>
            <div className="tabla-scroll">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>Fecha</th><th rowSpan={2}>Comprobante</th><th rowSpan={2}>CUIT</th><th rowSpan={2}>{esVentas ? 'Cliente' : 'Proveedor'}</th>
                    {cabecera.map((g, i) => g.nombre
                      ? <th key={i} colSpan={g.n} style={{ textAlign: 'center' }}>{g.nombre}</th>
                      : <th key={i} rowSpan={2} style={{ textAlign: 'right' }}>{g.titulo}</th>)}
                  </tr>
                  <tr>{cols.filter((c) => c.grupo).map((c) => <th key={c.id}>{c.titulo}</th>)}</tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.id}>
                      <td>{fechaAr(f.fecha)}</td>
                      <td>{comprobante(f)}{f.estado_dato === 'pendiente_validacion' && <span title={f.advertencia ?? ''}> ⚠</span>}</td>
                      <td>{f.doc_contraparte ? formatoCuit(f.doc_contraparte) : '—'}</td>
                      <td>{f.contraparte ?? '—'}</td>
                      {cols.map((c) => <td key={c.id} style={{ textAlign: 'right' }}>{cero(c.valor(f)) ? <span className="suave">–</span> : pesos(c.valor(f))}</td>)}
                    </tr>
                  ))}
                  <tr>
                    <th colSpan={4}>Totales ({filas.length} comprobantes)</th>
                    {totales.map((t, i) => <th key={cols[i].id} style={{ textAlign: 'right' }}>{pesos(t)}</th>)}
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>Resumen por alícuota</h3>
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Alícuota</th><th>Neto gravado</th><th>{esVentas ? 'Débito fiscal' : 'Crédito fiscal'}</th></tr></thead>
                <tbody>
                  {resumen.map((r) => <tr key={r.etiqueta}><td>{r.etiqueta}</td><td>{pesos(r.neto)}</td><td>{pesos(r.iva)}</td></tr>)}
                  {resumen.length === 0 && <tr><td colSpan={3} className="suave">Sin operaciones gravadas discriminadas.</td></tr>}
                  <tr><td>No gravado</td><td>{pesos(suma('no_gravado'))}</td><td></td></tr>
                  <tr><td>Exento</td><td>{pesos(suma('exento'))}</td><td></td></tr>
                  <tr><td>Otros tributos</td><td>{pesos(suma('otros'))}</td><td></td></tr>
                  <tr><th>Total {esVentas ? 'débito fiscal' : 'crédito fiscal'}</th><th></th><th>{pesos(suma('iva_total'))}</th></tr>
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </section>
  )
}
