import { useEffect, useState } from 'react'
import type { Estudio } from '../lib/types'
import { fechaCorta, pesos } from '../lib/utiles'
import {
  cargarPagos, cargarPresentaciones, claveVenc, enTermino, nombreFormulario, obligacionDeFormulario, obligacionDePago, periodoPago, queSePago, totalesPagos,
  vencimientos, type PagoArca, type Presentacion,
} from '../lib/ddjjVep'

const ultimoDia = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}` }

// Resumen para el Tablero: qué se pagó (con intereses), cuándo, y qué DDJJ se presentaron, del cliente elegido.
export default function ResumenDdjjVep({ estudio, clienteId, cuit, desde, hasta }: { estudio: Estudio; clienteId: string; cuit: string; desde: string; hasta: string }) {
  const [pagos, setPagos] = useState<PagoArca[]>([])
  const [djs, setDjs] = useState<Presentacion[]>([])
  const [venc, setVenc] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!clienteId || !desde || !hasta || desde > hasta) return
    let cancelado = false
    setError(null)
    Promise.all([cargarPagos(estudio.id, clienteId, `${desde}-01`, ultimoDia(hasta)), cargarPresentaciones(estudio.id, clienteId, `${desde}-01`, ultimoDia(hasta))])
      .then(async ([p, d]) => {
        const claves: { obligacion: string; periodo: string; cuit: string }[] = []
        for (const x of d) { const o = obligacionDeFormulario(x.formulario); if (o && x.periodo) claves.push({ obligacion: o, periodo: x.periodo, cuit }) }
        for (const x of p) { const o = obligacionDePago(x); if (o) claves.push({ obligacion: o.codigo, periodo: o.periodo, cuit }) }
        const v = await vencimientos(claves)
        if (!cancelado) { setPagos(p); setDjs(d); setVenc(v) }
      })
      .catch((e: unknown) => { if (!cancelado) setError(e instanceof Error ? e.message : 'No se pudo cargar.') })
    return () => { cancelado = true }
  }, [estudio.id, clienteId, cuit, desde, hasta])

  const t = totalesPagos(pagos)
  const vencPago = (p: PagoArca) => { if (p.vence) return p.vence; const o = obligacionDePago(p); return o ? venc[claveVenc(o.codigo, o.periodo, cuit)] ?? null : null }
  const vencDj = (d: Presentacion) => { const o = obligacionDeFormulario(d.formulario); return o && d.periodo ? venc[claveVenc(o, d.periodo, cuit)] ?? null : null }
  const ultimo = pagos[0]

  return (
    <>
      <h3>VEP pagados y DDJJ presentadas</h3>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="tarjetas">
        <div className="indicador"><span className="suave">Pagado en VEP</span><strong>{pesos(t.total)}</strong><span className="suave">{t.cantidad} pago{t.cantidad === 1 ? '' : 's'}</span></div>
        <div className="indicador"><span className="suave">Incluye intereses</span><strong>{pesos(t.intereses)}</strong>{t.multas > 0 && <span className="suave">y multas por {pesos(t.multas)}</span>}</div>
        <div className="indicador"><span className="suave">Último pago</span><strong>{ultimo ? pesos(ultimo.importe) : '—'}</strong><span className="suave">{ultimo ? `${fechaCorta(ultimo.fecha)} · ${queSePago(ultimo).titulo}` : 'sin pagos cargados'}</span></div>
        <div className="indicador"><span className="suave">DDJJ presentadas</span><strong>{djs.length}</strong><span className="suave">{djs[0] ? `última ${fechaCorta(djs[0].fecha)}` : 'sin acuses cargados'}</span></div>
      </div>
      {t.sinDetalle > 0 && <p className="aviso">{t.sinDetalle} pago{t.sinDetalle === 1 ? '' : 's'} sin detalle de intereses: se completan con «Volver a leer los PDF ya procesados» en «Carpetas ARCA».</p>}

      {pagos.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Pagado</th><th>Qué se pagó</th><th>Período</th><th>Intereses</th><th>Importe</th><th>Vencía</th></tr></thead>
            <tbody>
              {pagos.slice(0, 8).map((p) => {
                const q = queSePago(p); const v = vencPago(p); const et = v ? enTermino(p.fecha, v) : null
                return (
                  <tr key={p.id}>
                    <td>{fechaCorta(p.fecha)}</td>
                    <td><strong>{q.titulo}</strong><br /><span className="suave">{q.detalle}</span></td>
                    <td>{periodoPago(p)}</td>
                    <td>{p.intereses > 0 ? <span className="badge pendiente">{pesos(p.intereses)}</span> : <span className="suave">No incluye</span>}</td>
                    <td>{pesos(p.importe)}</td>
                    <td>{v ? <>{fechaCorta(v)} {et && <span className={`badge ${et.tarde ? 'vencida' : 'vigente'}`}>{et.texto}</span>}</> : <span className="suave">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {djs.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Presentada</th><th>Declaración jurada</th><th>Período</th><th>Vencía</th></tr></thead>
            <tbody>
              {djs.slice(0, 8).map((d) => {
                const v = vencDj(d); const et = v ? enTermino(d.fecha, v) : null
                return (
                  <tr key={d.id}>
                    <td>{fechaCorta(d.fecha)}</td><td>{nombreFormulario(d)}</td><td>{d.periodo ?? '—'}</td>
                    <td>{v ? <>{fechaCorta(v)} {et && <span className={`badge ${et.tarde ? 'vencida' : 'vigente'}`}>{et.texto}</span>}</> : <span className="suave">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="suave">Detalle completo, filtros y descarga en la solapa «DDJJ y VEP».</p>
    </>
  )
}
