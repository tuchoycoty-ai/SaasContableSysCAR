import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { fechaCorta, formatoCuit, hoyLocal, mensajeDb, pesos } from '../lib/utiles'
import {
  ESTADO_VEP, GRUPO_ARCA, TIPOS_PAGO_CONOCIDOS, TIPO_VEP, USA_CUOTA, USA_MES, armarPlan, periodoTexto, urgenciaDe,
  type EstadoVep, type TipoVep, type Urgencia, type VepProgramado,
} from '../lib/vepAgenda'

const CAMPOS = 'id, client_id, tipo, grupo, tipo_pago, anio, mes, cuota, importe, vence, estado, nro_vep, pagado_en, notas'
const URGENCIA: Record<Urgencia, { texto: string; clase: string }> = {
  vencido: { texto: 'Vencido', clase: 'vencida' }, esta_semana: { texto: 'Vence esta semana', clase: 'pendiente' }, proximo: { texto: 'Próximo', clase: '' },
  sin_fecha: { texto: 'Sin fecha', clase: '' }, resuelto: { texto: '', clase: '' },
}
const claseEstado = (e: EstadoVep) => (e === 'pagado' ? 'vigente' : e === 'pendiente' ? 'pendiente' : '')

export default function AgendaVep({ estudio, permisos }: { estudio: Estudio; permisos: string[] }) {
  const puede = permisos.includes('admin') || permisos.includes('obligaciones.gestionar')
  const { clientes } = useClientes(estudio.id)
  const [filas, setFilas] = useState<VepProgramado[]>([])
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [filtroEstado, setFiltroEstado] = useState<'abiertos' | EstadoVep | 'todos'>('abiertos')
  const [filtroCliente, setFiltroCliente] = useState('')
  const [editImporte, setEditImporte] = useState<Record<string, string>>({})

  // Alta
  const hoy = hoyLocal()
  const [cli, setCli] = useState('')
  const [tipo, setTipo] = useState<TipoVep>('ganancias_anticipo')
  const [tipoPago, setTipoPago] = useState(TIPOS_PAGO_CONOCIDOS.ganancias_anticipo[0])
  const [grupo, setGrupo] = useState(GRUPO_ARCA.ganancias_anticipo)
  const [anio, setAnio] = useState(String(new Date().getFullYear()))
  const [mes, setMes] = useState(String(new Date().getMonth() + 1))
  const [cuota, setCuota] = useState('1')
  const [meses, setMeses] = useState('1')
  const [importe, setImporte] = useState('')
  const [vence, setVence] = useState('')

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from('veps_programados').select(CAMPOS).eq('tenant_id', estudio.id).order('vence', { ascending: true, nullsFirst: false }).limit(1000)
    if (error) { setError('No se pudo cargar la agenda de VEP.'); return }
    setFilas(((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, importe: r.importe == null ? null : Number(r.importe) }) as unknown as VepProgramado))
  }, [estudio.id])

  const conciliar = useCallback(async () => {
    if (!puede) return 0
    const { data } = await supabase.rpc('conciliar_veps', { p_tenant: estudio.id, p_client: null })
    return Number(data ?? 0)
  }, [estudio.id, puede])

  useEffect(() => { conciliar().then(cargar) }, [conciliar, cargar])

  const porCliente = useMemo(() => new Map(clientes.map((c) => [c.id, c])), [clientes])
  const visibles = filas.filter((v) => {
    if (filtroCliente && v.client_id !== filtroCliente) return false
    if (filtroEstado === 'todos') return true
    if (filtroEstado === 'abiertos') return v.estado !== 'pagado' && v.estado !== 'anulado'
    return v.estado === filtroEstado
  })
  const conteo = {
    vencidos: filas.filter((v) => urgenciaDe(v, hoy) === 'vencido').length,
    semana: filas.filter((v) => urgenciaDe(v, hoy) === 'esta_semana').length,
    sinImporte: filas.filter((v) => v.estado === 'pendiente').length,
    listos: filas.filter((v) => v.estado === 'listo').length,
  }

  function cambiarTipo(t: TipoVep) {
    setTipo(t); setGrupo(GRUPO_ARCA[t]); setTipoPago(TIPOS_PAGO_CONOCIDOS[t][0] ?? '')
  }

  async function programar(e: FormEvent) {
    e.preventDefault(); setError(null); setInfo(null)
    if (!cli) { setError('Elegí el cliente.'); return }
    if (!grupo.trim() || !tipoPago.trim()) { setError('Completá el grupo y el tipo de pago tal como aparecen en ARCA.'); return }
    const imp = importe.trim() === '' ? null : Number(importe.replace(/\./g, '').replace(',', '.'))
    if (imp != null && !(imp > 0)) { setError('El importe no es válido.'); return }
    const n = USA_MES(tipo) ? Math.max(1, Math.min(12, Number(meses) || 1)) : 1
    const { data: u } = await supabase.auth.getUser()
    const filasNuevas = Array.from({ length: n }, (_, i) => {
      const base = (Number(anio) * 12) + (Number(mes) - 1) + i
      return {
        tenant_id: estudio.id, client_id: cli, tipo, grupo: grupo.trim(), tipo_pago: tipoPago.trim(),
        anio: USA_MES(tipo) ? Math.floor(base / 12) : Number(anio), mes: USA_MES(tipo) ? (base % 12) + 1 : null, cuota: USA_CUOTA(tipo) ? Number(cuota) : null,
        importe: imp, vence: n === 1 ? (vence || null) : null, estado: imp != null ? 'listo' : 'pendiente', creado_por: u.user?.id,
      }
    })
    const { error } = await supabase.from('veps_programados').insert(filasNuevas)
    if (error) setError(error.code === '23505' ? 'Alguno de esos VEP ya estaba programado para ese cliente y período.' : mensajeDb(error, 'No se pudo programar el VEP.'))
    else { setInfo(`Se programaron ${n} VEP.`); setImporte('') }
    await cargar()
  }

  async function actualizar(id: string, cambios: Record<string, unknown>, ok?: string) {
    setError(null); setInfo(null)
    const { error } = await supabase.from('veps_programados').update(cambios).eq('id', id)
    if (error) setError(mensajeDb(error, 'No se pudo actualizar.'))
    else if (ok) setInfo(ok)
    await cargar()
  }

  async function guardarImporte(v: VepProgramado) {
    const t = (editImporte[v.id] ?? '').trim()
    const imp = Number(t.replace(/\./g, '').replace(',', '.'))
    if (!(imp > 0)) { setError('Escribí un importe válido.'); return }
    await actualizar(v.id, { importe: imp, estado: v.estado === 'pendiente' ? 'listo' : v.estado }, 'Importe guardado.')
    setEditImporte((x) => { const c = { ...x }; delete c[v.id]; return c })
  }

  async function eliminar(v: VepProgramado) {
    if (!window.confirm('¿Eliminar este VEP de la agenda? Si ya lo cargaste en ARCA, no se borra de ahí.')) return
    const { error } = await supabase.from('veps_programados').delete().eq('id', v.id)
    if (error) setError(mensajeDb(error, 'Solo el administrador puede eliminar. Podés usar «Anular».'))
    await cargar()
  }

  async function revisarPagos() {
    setError(null); setInfo(null)
    const { data, error } = await supabase.rpc('conciliar_veps', { p_tenant: estudio.id, p_client: null })
    if (error) setError(mensajeDb(error, 'No se pudo revisar los pagos.'))
    else setInfo(Number(data) > 0 ? `Se marcaron ${data as number} VEP como pagados.` : 'No hay comprobantes de pago nuevos que coincidan. Importá los PDF desde «Carpetas ARCA».')
    await cargar()
  }

  function descargarPlan() {
    const conDatos = filas.map((v) => { const c = porCliente.get(v.client_id); return { ...v, cuit: c?.cuit ?? '', cliente: c?.razon_social ?? '' } }).filter((v) => v.cuit)
    const plan = armarPlan(conDatos)
    if (!plan.items.length) { setError('No hay VEP «listos para cargar». Cargá los importes primero.'); return }
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `plan-vep-${hoy}.json`; a.click()
    URL.revokeObjectURL(a.href)
    setInfo(`Plan con ${plan.items.length} VEP descargado. Abrí la extensión → solapa VEP y cargalo.`)
  }

  return (
    <section>
      <h2>Agenda de VEP</h2>
      <p className="suave">VEP que se repiten (anticipos de Ganancias, autónomos, monotributo). Los programás acá, la extensión los carga en ARCA hasta «VEPs a enviar», quien paga elige el medio de pago, y cuando importás el comprobante de pago el VEP pasa solo a «Pagado».</p>
      {error && <p className="error" role="alert">{error}</p>}
      {info && <p className="aviso" role="status">{info}</p>}

      <div className="fila cuatro">
        <div className="tarjeta-mini"><b>{conteo.vencidos}</b><br /><span className="suave">vencidos sin pagar</span></div>
        <div className="tarjeta-mini"><b>{conteo.semana}</b><br /><span className="suave">vencen esta semana</span></div>
        <div className="tarjeta-mini"><b>{conteo.sinImporte}</b><br /><span className="suave">faltan importe</span></div>
        <div className="tarjeta-mini"><b>{conteo.listos}</b><br /><span className="suave">listos para cargar</span></div>
      </div>

      {puede && (
        <form onSubmit={programar}>
          <h3>Programar VEP</h3>
          <div className="fila tres">
            <label>Cliente
              <select value={cli} onChange={(e) => setCli(e.target.value)}>
                <option value="">Elegí…</option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>)}
              </select>
            </label>
            <label>Qué es
              <select value={tipo} onChange={(e) => cambiarTipo(e.target.value as TipoVep)}>
                {(Object.keys(TIPO_VEP) as TipoVep[]).map((t) => <option key={t} value={t}>{TIPO_VEP[t]}</option>)}
              </select>
            </label>
            <label>Grupo en ARCA
              <input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder="Ganancias, Autonomo, Monotributo…" />
            </label>
          </div>
          <div className="fila tres">
            <label>Tipo de pago en ARCA (texto exacto)
              <input list="tipos-pago" value={tipoPago} onChange={(e) => setTipoPago(e.target.value)} />
              <datalist id="tipos-pago">{TIPOS_PAGO_CONOCIDOS[tipo].map((t) => <option key={t} value={t} />)}</datalist>
            </label>
            <label>Año
              <input type="number" min="2000" max="2100" value={anio} onChange={(e) => setAnio(e.target.value)} />
            </label>
            {USA_CUOTA(tipo) && <label>Anticipo / cuota nº
              <input type="number" min="1" max="99" value={cuota} onChange={(e) => setCuota(e.target.value)} />
            </label>}
            {USA_MES(tipo) && <label>Desde el mes
              <input type="number" min="1" max="12" value={mes} onChange={(e) => setMes(e.target.value)} />
            </label>}
          </div>
          <div className="fila tres">
            {USA_MES(tipo) && <label>Repetir por (meses)
              <input type="number" min="1" max="12" value={meses} onChange={(e) => setMeses(e.target.value)} />
            </label>}
            <label>Importe (si ya lo sabés)
              <input inputMode="decimal" value={importe} onChange={(e) => setImporte(e.target.value)} placeholder="Ej.: 125000 o 125.000,50" />
            </label>
            <label>Vence
              <input type="date" value={vence} onChange={(e) => setVence(e.target.value)} disabled={USA_MES(tipo) && Number(meses) > 1} />
            </label>
          </div>
          <p className="suave">El tipo de pago tiene que ser igual al desplegable de ARCA (por ejemplo «Ganancias Personas Fisicas - Anticipo»). Si no sabés el importe, queda «Falta el importe» y lo cargás después. Nunca se inventa ni se calcula un importe.</p>
          <button type="submit">Programar</button>
        </form>
      )}

      <div className="fila tres">
        <label>Cliente
          <select value={filtroCliente} onChange={(e) => setFiltroCliente(e.target.value)}>
            <option value="">Todos</option>
            {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social}</option>)}
          </select>
        </label>
        <label>Mostrar
          <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as typeof filtroEstado)}>
            <option value="abiertos">Pendientes (sin pagar)</option>
            <option value="todos">Todos</option>
            {(Object.keys(ESTADO_VEP) as EstadoVep[]).map((s) => <option key={s} value={s}>{ESTADO_VEP[s]}</option>)}
          </select>
        </label>
        <div>
          <button type="button" onClick={descargarPlan} disabled={!puede}>Descargar plan para la extensión</button>{' '}
          <button type="button" className="secundario" onClick={revisarPagos} disabled={!puede}>Revisar pagos importados</button>
        </div>
      </div>

      <div className="tabla-scroll">
        <table>
          <thead><tr><th>Vence</th><th>Cliente</th><th>VEP</th><th>Período</th><th>Importe</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>
            {visibles.length === 0 && <tr><td colSpan={7} className="suave">No hay VEP para mostrar.</td></tr>}
            {visibles.map((v) => {
              const c = porCliente.get(v.client_id)
              const u = urgenciaDe(v, hoy)
              return (
                <tr key={v.id}>
                  <td>{fechaCorta(v.vence)}{URGENCIA[u].texto && <><br /><span className={`badge ${URGENCIA[u].clase}`}>{URGENCIA[u].texto}</span></>}</td>
                  <td>{c?.razon_social ?? '—'}<br /><span className="suave">{c ? formatoCuit(c.cuit) : ''}</span></td>
                  <td>{v.tipo_pago}{v.nro_vep && <><br /><span className="suave">VEP {v.nro_vep}</span></>}</td>
                  <td>{periodoTexto(v)}</td>
                  <td>
                    {v.importe != null && !(v.id in editImporte) ? pesos(v.importe) : (
                      puede && v.estado !== 'pagado' ? (
                        <span>
                          <input style={{ width: '9em' }} inputMode="decimal" value={editImporte[v.id] ?? ''} onChange={(e) => setEditImporte({ ...editImporte, [v.id]: e.target.value })} placeholder="Importe" />{' '}
                          <button type="button" onClick={() => guardarImporte(v)}>Guardar</button>
                        </span>
                      ) : '—'
                    )}
                  </td>
                  <td><span className={`badge ${claseEstado(v.estado)}`}>{ESTADO_VEP[v.estado]}</span>{v.pagado_en && <><br /><span className="suave">Pagado el {fechaCorta(v.pagado_en)}</span></>}</td>
                  <td>
                    {puede && v.estado !== 'pagado' && v.estado !== 'anulado' && (
                      <>
                        {v.importe != null && !(v.id in editImporte) && <button type="button" className="secundario" onClick={() => setEditImporte({ ...editImporte, [v.id]: String(v.importe).replace('.', ',') })}>Cambiar importe</button>}{' '}
                        {v.estado === 'listo' && <button type="button" className="secundario" onClick={() => actualizar(v.id, { estado: 'cargado' }, 'Marcado como cargado en ARCA.')}>Ya lo cargué</button>}{' '}
                        {(v.estado === 'cargado' || v.estado === 'listo') && <button type="button" className="secundario" onClick={() => actualizar(v.id, { estado: 'emitido' }, 'Marcado como emitido.')}>Ya lo emití</button>}{' '}
                        {v.estado === 'emitido' || v.estado === 'cargado' ? <button type="button" className="secundario" onClick={() => actualizar(v.id, { estado: 'listo' })}>Volver a «listo»</button> : null}{' '}
                        <button type="button" className="secundario" onClick={() => actualizar(v.id, { estado: 'anulado' }, 'VEP anulado.')}>Anular</button>
                      </>
                    )}
                    {puede && v.estado === 'anulado' && <button type="button" className="secundario" onClick={() => eliminar(v)}>Eliminar</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
