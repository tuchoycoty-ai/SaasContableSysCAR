import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, ObligacionCliente, EstadoObligacion } from '../lib/types'
import { OBLIGACION_LABEL } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { fechaCorta, hoyLocal, mensajeDb, pesos } from '../lib/utiles'

const ESTADOS: Record<EstadoObligacion, string> = { pendiente: 'Pendiente', presentada: 'Presentada', pagada: 'Pagada', no_corresponde: 'No corresponde' }

function periodoAnterior(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

type Edicion = { estado: EstadoObligacion; monto: string; vep_numero: string; vep_monto: string; vep_vence: string; notas: string }

export default function Obligaciones({ estudio, permisos }: { estudio: Estudio; permisos: string[] }) {
  const puede = permisos.includes('admin') || permisos.includes('obligaciones.gestionar')
  const { clientes } = useClientes(estudio.id)
  const [periodo, setPeriodo] = useState(periodoAnterior())
  const [filas, setFilas] = useState<ObligacionCliente[]>([])
  const [venc, setVenc] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [editando, setEditando] = useState<string | null>(null)
  const [form, setForm] = useState<Edicion | null>(null)

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from('obligaciones_cliente').select('*').eq('tenant_id', estudio.id).eq('periodo', periodo).order('obligacion_codigo')
    if (error) { setError('No se pudieron cargar las obligaciones.'); return }
    const lista = (data ?? []) as ObligacionCliente[]
    setFilas(lista)
    // Fecha de vencimiento segun el calendario (null si el holding todavia no la cargo)
    const mapa: Record<string, string | null> = {}
    await Promise.all(lista.map(async (o) => {
      const cli = clientes.find((c) => c.id === o.client_id)
      if (!cli) return
      const { data: f } = await supabase.rpc('vencimiento_de', { p_obligacion: o.obligacion_codigo, p_periodo: o.periodo, p_cuit: cli.cuit })
      mapa[o.id] = (f as string | null) ?? null
    }))
    setVenc(mapa)
  }, [estudio.id, periodo, clientes])

  useEffect(() => { cargar() }, [cargar])

  async function generar() {
    setError(null); setInfo(null)
    const { data, error } = await supabase.rpc('generar_obligaciones', { p_tenant: estudio.id, p_periodo: periodo })
    if (error) setError(mensajeDb(error, 'No se pudieron generar las obligaciones.'))
    else setInfo(`Se generaron ${data as number} obligaciones nuevas para ${periodo}.`)
    await cargar()
  }

  function editar(o: ObligacionCliente) {
    setEditando(o.id)
    setForm({ estado: o.estado, monto: o.monto?.toString() ?? '', vep_numero: o.vep_numero ?? '', vep_monto: o.vep_monto?.toString() ?? '', vep_vence: o.vep_vence ?? '', notas: o.notas ?? '' })
  }

  async function guardar(o: ObligacionCliente) {
    if (!form) return
    setError(null)
    const hoy = hoyLocal()
    const cambios = {
      estado: form.estado,
      monto: form.monto === '' ? null : Number(form.monto),
      vep_numero: form.vep_numero.trim() || null,
      vep_monto: form.vep_monto === '' ? null : Number(form.vep_monto),
      vep_vence: form.vep_vence || null,
      notas: form.notas.trim() || null,
      presentada_en: form.estado === 'presentada' || form.estado === 'pagada' ? (o.presentada_en ?? hoy) : null,
      pagada_en: form.estado === 'pagada' ? (o.pagada_en ?? hoy) : null,
    }
    const { error } = await supabase.from('obligaciones_cliente').update(cambios).eq('id', o.id)
    if (error) setError(mensajeDb(error, 'No se pudo guardar.'))
    else { setEditando(null); setForm(null) }
    await cargar()
  }

  const nombre = (id: string) => clientes.find((c) => c.id === id)?.razon_social ?? ''
  const hoy = hoyLocal()

  return (
    <section>
      <h2>Obligaciones</h2>
      <p className="suave">
        Seguimiento de DDJJ y pagos por cliente. SysCAR <strong>no presenta ni genera VEP en ARCA</strong> (no existe un servicio público para eso):
        acá registrás lo que hiciste en ARCA —estado, número de VEP, monto y fechas— y el sistema te avisa los vencimientos.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {info && <p className="aviso">{info}</p>}
      <div className="fila dos">
        <label>Período (AAAA-MM)<input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} /></label>
        {puede && <button onClick={generar} disabled={!/^\d{4}-\d{2}$/.test(periodo)}>Generar obligaciones del período</button>}
      </div>
      {filas.length === 0 ? (
        <p className="suave">No hay obligaciones cargadas para {periodo}. {puede ? 'Usá «Generar» para crearlas según el régimen de cada cliente.' : ''}</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Cliente</th><th>Obligación</th><th>Vence</th><th>Estado</th><th>VEP</th><th>Monto</th><th></th></tr></thead>
            <tbody>
              {filas.map((o) => {
                const f = venc[o.id] ?? null
                const vencida = o.estado === 'pendiente' && f !== null && f < hoy
                return (
                  <tr key={o.id}>
                    <td>{nombre(o.client_id)}</td>
                    <td>{OBLIGACION_LABEL[o.obligacion_codigo] ?? o.obligacion_codigo}</td>
                    <td>{f ? fechaCorta(f) : <span className="suave">Sin fecha en el calendario</span>} {vencida && <span className="badge vencida">Vencida</span>}</td>
                    <td>
                      {editando === o.id && form ? (
                        <select value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value as EstadoObligacion })}>
                          {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      ) : <span className="badge">{ESTADOS[o.estado]}</span>}
                    </td>
                    <td>
                      {editando === o.id && form ? (
                        <>
                          <input placeholder="N° VEP" value={form.vep_numero} onChange={(e) => setForm({ ...form, vep_numero: e.target.value })} />
                          <input type="number" placeholder="Monto VEP" value={form.vep_monto} onChange={(e) => setForm({ ...form, vep_monto: e.target.value })} />
                          <input type="date" value={form.vep_vence} onChange={(e) => setForm({ ...form, vep_vence: e.target.value })} />
                        </>
                      ) : o.vep_numero ? <>{o.vep_numero}<br /><span className="suave">{pesos(o.vep_monto)} · vence {fechaCorta(o.vep_vence)}</span></> : <span className="suave">—</span>}
                    </td>
                    <td>
                      {editando === o.id && form
                        ? <input type="number" placeholder="Monto" value={form.monto} onChange={(e) => setForm({ ...form, monto: e.target.value })} />
                        : pesos(o.monto)}
                    </td>
                    <td>
                      {puede && editando === o.id ? (
                        <>
                          <button onClick={() => guardar(o)}>Guardar</button>{' '}
                          <button className="secundario" onClick={() => { setEditando(null); setForm(null) }}>Cancelar</button>
                        </>
                      ) : puede && <button className="secundario" onClick={() => editar(o)}>Registrar</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
