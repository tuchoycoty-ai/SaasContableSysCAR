import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Ejecucion, Estudio, EventoEjecucion, OperacionTarea, Tarea } from '../lib/types'
import { ESTADO_EJECUCION_LABEL } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { fechaHora, mensajeDb } from '../lib/utiles'

const FRECUENCIAS = [
  { id: 'manual', nombre: 'Solo manual' },
  { id: 'diaria', nombre: 'Todos los días' },
  { id: 'semanal', nombre: 'Una vez por semana' },
  { id: 'mensual', nombre: 'Una vez por mes' },
  { id: 'una_vez', nombre: 'Una sola vez' },
]
const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

function claseEstado(e: Ejecucion['estado']): string {
  if (e === 'completada') return 'vigente'
  if (e === 'fallida') return 'vencida'
  if (e === 'cancelada') return ''
  return 'pendiente'
}

export default function Tareas({ estudio, permisos }: { estudio: Estudio; permisos: string[] }) {
  const puede = permisos.includes('admin') || permisos.includes('tareas.gestionar')
  const { clientes } = useClientes(estudio.id)
  const [operaciones, setOperaciones] = useState<OperacionTarea[]>([])
  const [tareas, setTareas] = useState<Tarea[]>([])
  const [ejecuciones, setEjecuciones] = useState<Ejecucion[]>([])
  const [eventos, setEventos] = useState<Record<string, EventoEjecucion[]>>({})
  const [abierta, setAbierta] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  const [filtroTarea, setFiltroTarea] = useState('')

  // Formulario de alta
  const [clienteId, setClienteId] = useState('')
  const [operacion, setOperacion] = useState('importaciones.control_carga')
  const [nombre, setNombre] = useState('')
  const [frecuencia, setFrecuencia] = useState('mensual')
  const [dia, setDia] = useState(5)
  const [hora, setHora] = useState('09:00')
  const [modo, setModo] = useState('ambas')
  const [regla, setRegla] = useState('mes_anterior')
  const [reintentos, setReintentos] = useState(2)
  const [intervalo, setIntervalo] = useState(15)
  const [titulo, setTitulo] = useState('')
  const [diaLimite, setDiaLimite] = useState(18)
  const [mesOffset, setMesOffset] = useState(1)

  const cargar = useCallback(async () => {
    const [o, t, r] = await Promise.all([
      supabase.from('task_operations').select('*').order('modulo').order('nombre'),
      supabase.from('task_definitions').select('*').eq('tenant_id', estudio.id).order('creado_en', { ascending: false }),
      supabase.from('task_runs').select('*').eq('tenant_id', estudio.id).order('creado_en', { ascending: false }).limit(100),
    ])
    if (o.error || t.error || r.error) {
      setError('No se pudieron cargar las tareas.')
      return
    }
    setOperaciones((o.data ?? []) as OperacionTarea[])
    setTareas((t.data ?? []) as Tarea[])
    setEjecuciones((r.data ?? []) as Ejecucion[])
  }, [estudio.id])

  useEffect(() => {
    cargar()
    const id = window.setInterval(cargar, 30000)
    return () => window.clearInterval(id)
  }, [cargar])

  useEffect(() => {
    if (!clienteId && clientes.length > 0) setClienteId(clientes[0].id)
  }, [clientes, clienteId])

  const op = operaciones.find((o) => o.codigo === operacion)
  const nombreTarea = (id: string) => tareas.find((t) => t.id === id)?.nombre ?? '(tarea)'
  const nombreCliente = (id: string) => clientes.find((c) => c.id === id)?.razon_social ?? ''

  async function accion(f: () => PromiseLike<{ error: { code?: string; message?: string } | null }>, falla: string) {
    setError(null)
    setTrabajando(true)
    const { error } = await f()
    setTrabajando(false)
    if (error) setError(mensajeDb(error, falla))
    await cargar()
  }

  async function crear(e: FormEvent) {
    e.preventDefault()
    if (!op?.disponible || !clienteId) return
    const parametros = operacion === 'vencimientos.recordatorio' ? { titulo: titulo.trim(), dia_limite: diaLimite, mes_offset: mesOffset } : {}
    await accion(
      () =>
        supabase.rpc('crear_tarea', {
          p_tenant: estudio.id, p_client: clienteId, p_operacion: operacion,
          p_nombre: nombre.trim() || op.nombre, p_frecuencia: frecuencia,
          p_dia: frecuencia === 'mensual' || frecuencia === 'semanal' ? dia : null,
          p_hora: hora, p_modo: frecuencia === 'manual' ? 'manual' : modo, p_periodo_regla: regla,
          p_reintentos: reintentos, p_intervalo: intervalo, p_parametros: parametros,
        }),
      'No se pudo crear la tarea.',
    )
    setNombre('')
  }

  async function verEventos(id: string) {
    if (abierta === id) {
      setAbierta(null)
      return
    }
    setAbierta(id)
    const { data } = await supabase.from('task_run_events').select('id, nivel, mensaje, creado_en').eq('run_id', id).order('creado_en')
    setEventos((x) => ({ ...x, [id]: (data ?? []) as EventoEjecucion[] }))
  }

  const lista = ejecuciones.filter((r) => !filtroTarea || r.task_id === filtroTarea)

  return (
    <section>
      <h2>Tareas</h2>
      <p className="suave">
        Las tareas automáticas las ejecuta el servidor (cada minuto revisa cuáles están vencidas); no hace falta tener la página abierta.
        Cada ejecución queda en el historial con sus intentos y errores, y nunca se borra.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {puede && (
        <form onSubmit={crear}>
          <h3>Nueva tarea</h3>
          <div className="fila tres">
            <label>
              Cliente
              <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social}</option>)}
              </select>
            </label>
            <label>
              Operación
              <select value={operacion} onChange={(e) => setOperacion(e.target.value)}>
                {operaciones.map((o) => (
                  <option key={o.codigo} value={o.codigo}>{o.nombre}{o.disponible ? '' : ' — pendiente de integración'}</option>
                ))}
              </select>
            </label>
            <label>
              Nombre (opcional)
              <input value={nombre} maxLength={120} onChange={(e) => setNombre(e.target.value)} />
            </label>
          </div>
          {op && <p className="suave">{op.descripcion}{op.nota ? ` ${op.nota}` : ''}</p>}
          {op && !op.disponible && (
            <p className="aviso">Esta operación está <strong>pendiente de integración</strong> y todavía no se puede programar. Mientras tanto, cargá los datos desde Importar.</p>
          )}
          {operacion === 'vencimientos.recordatorio' && (
            <div className="fila tres">
              <label>
                Título del vencimiento
                <input value={titulo} maxLength={120} required onChange={(e) => setTitulo(e.target.value)} placeholder="Ej.: Vencimiento IVA" />
              </label>
              <label>
                Día límite del mes
                <input type="number" min={1} max={31} value={diaLimite} onChange={(e) => setDiaLimite(Number(e.target.value))} />
              </label>
              <label>
                Meses después del período
                <input type="number" min={0} max={12} value={mesOffset} onChange={(e) => setMesOffset(Number(e.target.value))} />
              </label>
            </div>
          )}
          <div className="fila cuatro">
            <label>
              Frecuencia
              <select value={frecuencia} onChange={(e) => setFrecuencia(e.target.value)}>
                {FRECUENCIAS.map((f) => <option key={f.id} value={f.id}>{f.nombre}</option>)}
              </select>
            </label>
            {(frecuencia === 'mensual' || frecuencia === 'semanal') && (
              <label>
                {frecuencia === 'mensual' ? 'Día del mes' : 'Día de la semana'}
                {frecuencia === 'mensual' ? (
                  <input type="number" min={1} max={31} value={dia} onChange={(e) => setDia(Number(e.target.value))} />
                ) : (
                  <select value={dia >= 1 && dia <= 7 ? dia : 1} onChange={(e) => setDia(Number(e.target.value))}>
                    {DIAS_SEMANA.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                  </select>
                )}
              </label>
            )}
            {frecuencia !== 'manual' && (
              <label>
                Hora (Argentina)
                <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
              </label>
            )}
            {frecuencia !== 'manual' && (
              <label>
                Ejecución
                <select value={modo} onChange={(e) => setModo(e.target.value)}>
                  <option value="ambas">Automática y manual</option>
                  <option value="automatica">Solo automática</option>
                </select>
              </label>
            )}
          </div>
          <div className="fila cuatro">
            <label>
              Período que analiza
              <select value={regla} onChange={(e) => setRegla(e.target.value)}>
                <option value="mes_anterior">Mes anterior</option>
                <option value="mes_actual">Mes en curso</option>
              </select>
            </label>
            <label>
              Reintentos si falla
              <input type="number" min={0} max={5} value={reintentos} onChange={(e) => setReintentos(Number(e.target.value))} />
            </label>
            <label>
              Minutos entre reintentos
              <input type="number" min={1} max={1440} value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} />
            </label>
          </div>
          <button type="submit" disabled={trabajando || !op?.disponible || !clienteId}>Crear tarea</button>
        </form>
      )}
      {!puede && <p className="aviso">Podés ver las tareas de tus clientes, pero crear o ejecutar requiere el permiso «Gestionar tareas».</p>}

      <h3>Tareas configuradas</h3>
      {tareas.length === 0 ? (
        <p className="suave">Todavía no hay tareas.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Tarea</th><th>Cliente</th><th>Frecuencia</th><th>Próxima</th><th>Última</th><th>Acciones</th></tr>
            </thead>
            <tbody>
              {tareas.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.nombre} {!t.activa && <span className="badge">En pausa</span>}
                    <br /><span className="suave">{operaciones.find((o) => o.codigo === t.operacion)?.nombre ?? t.operacion}</span>
                  </td>
                  <td>{nombreCliente(t.client_id)}</td>
                  <td>
                    {FRECUENCIAS.find((f) => f.id === t.frecuencia)?.nombre}
                    {t.frecuencia !== 'manual' && ` · ${t.hora.slice(0, 5)}`}
                    <br /><span className="suave">{t.modo === 'ambas' ? 'automática y manual' : t.modo}</span>
                  </td>
                  <td>{t.activa && t.proxima_ejecucion && t.modo !== 'manual' ? fechaHora(t.proxima_ejecucion) : '—'}</td>
                  <td>{t.ultima_ejecucion ? fechaHora(t.ultima_ejecucion) : '—'}</td>
                  <td>
                    {puede && (
                      <>
                        <button className="secundario" disabled={trabajando || t.modo === 'automatica'} title={t.modo === 'automatica' ? 'Esta tarea es solo automática' : ''}
                          onClick={() => accion(() => supabase.rpc('lanzar_tarea', { p_task: t.id }), 'No se pudo ejecutar la tarea.')}>
                          Ejecutar ahora
                        </button>{' '}
                        {t.frecuencia !== 'manual' && (
                          <button className="secundario" disabled={trabajando}
                            onClick={() => accion(() => supabase.rpc('pausar_tarea', { p_task: t.id, p_activa: !t.activa }), 'No se pudo cambiar el estado.')}>
                            {t.activa ? 'Pausar' : 'Reanudar'}
                          </button>
                        )}{' '}
                      </>
                    )}
                    <button className="secundario" onClick={() => setFiltroTarea(filtroTarea === t.id ? '' : t.id)}>
                      {filtroTarea === t.id ? 'Ver todas' : 'Ver historial'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Historial de ejecuciones{filtroTarea ? ` · ${nombreTarea(filtroTarea)}` : ''}</h3>
      {lista.length === 0 ? (
        <p className="suave">Sin ejecuciones todavía.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Fecha</th><th>Tarea</th><th>Período</th><th>Origen</th><th>Estado</th><th>Intentos</th><th></th></tr>
            </thead>
            <tbody>
              {lista.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>{fechaHora(r.creado_en)}</td>
                    <td>{nombreTarea(r.task_id)}</td>
                    <td>{r.periodo ?? '—'}</td>
                    <td>{r.disparador === 'manual' ? 'Manual' : 'Automática'}{r.origen_run_id ? ' (relanzada)' : ''}</td>
                    <td>
                      <span className={`badge ${claseEstado(r.estado)}`}>{ESTADO_EJECUCION_LABEL[r.estado]}</span>
                      {r.estado === 'pendiente' && r.proximo_intento && <><br /><span className="suave">reintento {fechaHora(r.proximo_intento)}</span></>}
                    </td>
                    <td>{r.intento} de {r.intentos_max}</td>
                    <td>
                      <button className="secundario" onClick={() => verEventos(r.id)}>{abierta === r.id ? 'Ocultar' : 'Detalle'}</button>{' '}
                      {puede && (r.estado === 'fallida' || r.estado === 'completada_parcialmente' || r.estado === 'cancelada') && (
                        <button className="secundario" disabled={trabajando}
                          onClick={() => accion(() => supabase.rpc('relanzar_ejecucion', { p_run: r.id }), 'No se pudo relanzar.')}>Relanzar</button>
                      )}{' '}
                      {puede && (r.estado === 'pendiente' || r.estado === 'programada') && (
                        <button className="secundario" disabled={trabajando}
                          onClick={() => accion(() => supabase.rpc('cancelar_ejecucion', { p_run: r.id }), 'No se pudo cancelar.')}>Cancelar</button>
                      )}
                    </td>
                  </tr>
                  {abierta === r.id && (
                    <tr>
                      <td colSpan={7}>
                        {r.error && <p className="error">Último error: {r.error}</p>}
                        {r.resultado && typeof r.resultado.mensaje === 'string' && <p><strong>Resultado:</strong> {r.resultado.mensaje}</p>}
                        <ul>
                          {(eventos[r.id] ?? []).map((ev) => (
                            <li key={ev.id}><span className="suave">{fechaHora(ev.creado_en)}</span> · {ev.nivel === 'error' ? '⚠ ' : ''}{ev.mensaje}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
