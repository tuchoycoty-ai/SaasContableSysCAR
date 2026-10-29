import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, EstadoDato } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { formatoCuit, hoyLocal, pesos } from '../lib/utiles'

type Fila = {
  mes: string
  rubro: 'emitido' | 'recibido' | 'pago'
  estado_dato: EstadoDato
  cantidad: number
  neto: number
  iva: number
  total: number
}

const ESTADOS: { id: EstadoDato; etiqueta: string }[] = [
  { id: 'confirmado', etiqueta: 'Confirmado' },
  { id: 'importado', etiqueta: 'Importado' },
  { id: 'pendiente_validacion', etiqueta: 'Pendiente de validación' },
]

function mesActual(): string {
  return hoyLocal().slice(0, 7)
}
function mesesAtras(n: number): string {
  const [a, m] = mesActual().split('-').map(Number)
  const d = new Date(a, m - 1 - n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function ultimoDia(mes: string): string {
  const [a, m] = mes.split('-').map(Number)
  return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`
}
function etiquetaMes(iso: string): string {
  const [a, m] = iso.split('-')
  return `${m}/${a.slice(2)}`
}

export default function Tablero({ estudio }: { estudio: Estudio }) {
  const { clientes, cargando: cargandoClientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('')
  const [desde, setDesde] = useState(mesesAtras(11))
  const [hasta, setHasta] = useState(mesActual())
  const [filas, setFilas] = useState<Fila[]>([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!clienteId && clientes.length > 0) setClienteId(clientes[0].id)
  }, [clientes, clienteId])

  useEffect(() => {
    if (!clienteId || !desde || !hasta || desde > hasta) return
    let cancelado = false
    setCargando(true)
    setError(null)
    supabase
      .rpc('resumen_mensual', { p_tenant: estudio.id, p_client: clienteId, p_desde: `${desde}-01`, p_hasta: ultimoDia(hasta) })
      .then(({ data, error }) => {
        if (cancelado) return
        if (error) setError('No se pudo calcular el resumen.')
        else
          setFilas(
            ((data ?? []) as Fila[]).map((f) => ({
              ...f, cantidad: Number(f.cantidad), neto: Number(f.neto), iva: Number(f.iva), total: Number(f.total),
            })),
          )
        setCargando(false)
      })
    return () => {
      cancelado = true
    }
  }, [estudio.id, clienteId, desde, hasta])

  const suma = (rubro: Fila['rubro'], campo: 'neto' | 'iva' | 'total' | 'cantidad', estado?: EstadoDato) =>
    filas.filter((f) => f.rubro === rubro && (!estado || f.estado_dato === estado)).reduce((s, f) => s + f[campo], 0)

  const debito = suma('emitido', 'iva')
  const credito = suma('recibido', 'iva')
  const posicion = debito - credito

  const meses = useMemo(() => {
    const set = new Set(filas.filter((f) => f.rubro !== 'pago').map((f) => f.mes))
    return [...set].sort()
  }, [filas])
  const serie = meses.map((m) => ({
    mes: m,
    ingresos: filas.filter((f) => f.mes === m && f.rubro === 'emitido').reduce((s, f) => s + f.neto, 0),
    egresos: filas.filter((f) => f.mes === m && f.rubro === 'recibido').reduce((s, f) => s + f.neto, 0),
  }))
  const maximo = Math.max(1, ...serie.flatMap((s) => [Math.abs(s.ingresos), Math.abs(s.egresos)]))

  const cliente = clientes.find((c) => c.id === clienteId)
  const hayDatos = filas.length > 0
  const pendientes = filas.filter((f) => f.estado_dato === 'pendiente_validacion').reduce((s, f) => s + f.cantidad, 0)
  const sinValidar = filas.filter((f) => f.estado_dato !== 'confirmado').reduce((s, f) => s + f.cantidad, 0)

  const lineas: { nombre: string; rubro: Fila['rubro']; campo: 'neto' | 'iva' | 'total' }[] = [
    { nombre: 'Facturado (neto, comprobantes emitidos)', rubro: 'emitido', campo: 'neto' },
    { nombre: 'Compras y gastos (neto, comprobantes recibidos)', rubro: 'recibido', campo: 'neto' },
    { nombre: 'IVA débito fiscal (ventas)', rubro: 'emitido', campo: 'iva' },
    { nombre: 'IVA crédito fiscal (compras)', rubro: 'recibido', campo: 'iva' },
    { nombre: 'Impuestos pagados (pagos importados)', rubro: 'pago', campo: 'total' },
  ]

  return (
    <section>
      <h2>Tablero</h2>
      {cargandoClientes ? (
        <p className="suave">Cargando…</p>
      ) : clientes.length === 0 ? (
        <p className="suave">No hay clientes disponibles para mostrar.</p>
      ) : (
        <div className="fila tres">
          <label>
            Cliente
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>
              ))}
            </select>
          </label>
          <label>
            Desde
            <input type="month" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
          </label>
          <label>
            Hasta
            <input type="month" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {cargando && <p className="suave">Calculando…</p>}

      {clienteId && !cargando && !error && !hayDatos && (
        <p className="aviso">
          {cliente?.razon_social} no tiene datos importados en este período. Cargalos desde la sección <strong>Importar</strong>; el tablero
          solo muestra lo que está guardado.
        </p>
      )}

      {hayDatos && (
        <>
          <p className="suave">
            Los importes provienen de archivos importados. Se muestran separados según su estado:
            <strong> confirmado</strong> (lote validado por una persona), <strong>importado</strong> (cargado, sin validar) y
            <strong> pendiente de validación</strong> (el sistema detectó una advertencia). Las notas de crédito restan.
          </p>
          {sinValidar > 0 && (
            <p className="aviso">
              {sinValidar} registros todavía no están confirmados{pendientes > 0 ? `, ${pendientes} con advertencias` : ''}. Validalos desde Importar → Historial.
            </p>
          )}

          <div className="tarjetas">
            <div className="indicador">
              <span className="suave">Posición de IVA <span className="badge pendiente">Estimada</span></span>
              <strong className={posicion > 0 ? '' : 'ok'}>{pesos(posicion)}</strong>
              <span className="suave">{posicion > 0 ? 'a pagar (débito − crédito)' : 'a favor (débito − crédito)'}. No es una liquidación: no considera saldos anteriores, percepciones ni retenciones.</span>
            </div>
            <div className="indicador">
              <span className="suave">Comprobantes emitidos</span>
              <strong>{suma('emitido', 'cantidad')}</strong>
            </div>
            <div className="indicador">
              <span className="suave">Comprobantes recibidos</span>
              <strong>{suma('recibido', 'cantidad')}</strong>
            </div>
            <div className="indicador">
              <span className="suave">Pagos registrados</span>
              <strong>{suma('pago', 'cantidad')}</strong>
            </div>
          </div>

          <h3>Importes por estado</h3>
          <div className="tabla-scroll">
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  {ESTADOS.map((e) => <th key={e.id} className="num">{e.etiqueta}</th>)}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {lineas.map((l) => (
                  <tr key={l.nombre}>
                    <td>{l.nombre}</td>
                    {ESTADOS.map((e) => <td key={e.id} className="num">{pesos(suma(l.rubro, l.campo, e.id))}</td>)}
                    <td className="num"><strong>{pesos(suma(l.rubro, l.campo))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Evolución mensual (neto)</h3>
          {serie.length === 0 ? (
            <p className="suave">No hay comprobantes en el período.</p>
          ) : (
            <>
              <div className="grafico" role="img" aria-label="Gráfico de barras: ingresos y egresos netos por mes. Los mismos datos están en la tabla de abajo.">
                {serie.map((s) => (
                  <div className="mes" key={s.mes}>
                    <div className="barras">
                      <div className="barra-ingreso" style={{ height: `${(Math.abs(s.ingresos) / maximo) * 100}%` }} title={`Ingresos ${pesos(s.ingresos)}`} />
                      <div className="barra-egreso" style={{ height: `${(Math.abs(s.egresos) / maximo) * 100}%` }} title={`Egresos ${pesos(s.egresos)}`} />
                    </div>
                    <span className="suave">{etiquetaMes(s.mes)}</span>
                  </div>
                ))}
              </div>
              <p className="leyenda"><span className="punto ingreso" /> Ingresos (emitidos) <span className="punto egreso" /> Egresos (recibidos)</p>
              <details>
                <summary>Ver datos del gráfico</summary>
                <div className="tabla-scroll">
                  <table>
                    <thead><tr><th>Mes</th><th className="num">Ingresos</th><th className="num">Egresos</th><th className="num">Diferencia</th></tr></thead>
                    <tbody>
                      {serie.map((s) => (
                        <tr key={s.mes}>
                          <td>{etiquetaMes(s.mes)}</td>
                          <td className="num">{pesos(s.ingresos)}</td>
                          <td className="num">{pesos(s.egresos)}</td>
                          <td className="num">{pesos(s.ingresos - s.egresos)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </>
      )}

      <h3>Todavía no disponible</h3>
      <p className="suave">
        VEP pagados y pendientes, declaraciones juradas, alertas fiscales, tareas e indicadores financieros con previsiones se habilitan en
        las próximas fases. No se muestran números de relleno: cuando existan datos reales, aparecen acá.
      </p>
    </section>
  )
}
