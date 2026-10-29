import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, ItemAgenda } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { fechaCorta, hoyLocal, mensajeDb } from '../lib/utiles'

const TIPOS: Record<ItemAgenda['tipo'], string> = {
  vencimiento: 'Vencimiento', recordatorio: 'Recordatorio', control: 'Control', recategorizacion: 'Recategorización', otro: 'Otro',
}

export default function Agenda({ estudio, permisos, yo }: { estudio: Estudio; permisos: string[]; yo: string }) {
  const puede = permisos.includes('admin') || permisos.includes('tareas.gestionar')
  const { clientes } = useClientes(estudio.id)
  const [items, setItems] = useState<ItemAgenda[]>([])
  const [verResueltos, setVerResueltos] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titulo, setTitulo] = useState('')
  const [clienteId, setClienteId] = useState('')
  const [fecha, setFecha] = useState('')
  const [prioridad, setPrioridad] = useState('media')
  const [tipo, setTipo] = useState('recordatorio')

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('agenda_items').select('*').eq('tenant_id', estudio.id)
      .order('fecha_limite', { ascending: true, nullsFirst: false }).limit(300)
    if (error) setError('No se pudo cargar la agenda.')
    else setItems((data ?? []) as ItemAgenda[])
  }, [estudio.id])

  useEffect(() => { cargar() }, [cargar])
  useEffect(() => {
    if (!clienteId && clientes.length > 0) setClienteId(clientes[0].id)
  }, [clientes, clienteId])

  const hoy = hoyLocal()
  const nombreCliente = (id: string) => clientes.find((c) => c.id === id)?.razon_social ?? ''

  async function agregar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.from('agenda_items').insert({
      tenant_id: estudio.id, client_id: clienteId, tipo, titulo: titulo.trim(),
      fecha_limite: fecha || null, prioridad, creado_por: yo,
    })
    if (error) setError(mensajeDb(error, 'No se pudo agregar el aviso.'))
    else { setTitulo(''); setFecha('') }
    await cargar()
  }

  async function marcar(id: string, estado: 'hecho' | 'descartado' | 'pendiente') {
    setError(null)
    const { error } = await supabase.from('agenda_items').update({ estado }).eq('id', id)
    if (error) setError(mensajeDb(error, 'No se pudo actualizar.'))
    await cargar()
  }

  async function borrar(id: string) {
    const { error } = await supabase.from('agenda_items').delete().eq('id', id)
    if (error) setError(mensajeDb(error, 'No se pudo borrar.'))
    await cargar()
  }

  const visibles = items.filter((i) => verResueltos || i.estado === 'pendiente')
  const vencidos = items.filter((i) => i.estado === 'pendiente' && i.fecha_limite && i.fecha_limite < hoy).length

  return (
    <section>
      <h2>Agenda</h2>
      <p className="suave">Vencimientos, recordatorios y controles. Los que genera una tarea muestran su origen; los demás los cargás vos.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {vencidos > 0 && <p className="aviso">{vencidos} {vencidos === 1 ? 'aviso vencido' : 'avisos vencidos'} sin resolver.</p>}

      {puede && (
        <form onSubmit={agregar}>
          <div className="fila cuatro">
            <label>Título<input value={titulo} maxLength={200} required onChange={(e) => setTitulo(e.target.value)} /></label>
            <label>
              Cliente
              <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.razon_social}</option>)}
              </select>
            </label>
            <label>Fecha límite<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></label>
            <label>
              Tipo
              <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
                <option value="recordatorio">Recordatorio</option>
                <option value="vencimiento">Vencimiento</option>
                <option value="control">Control</option>
                <option value="otro">Otro</option>
              </select>
            </label>
          </div>
          <div className="fila dos">
            <label>
              Prioridad
              <select value={prioridad} onChange={(e) => setPrioridad(e.target.value)}>
                <option value="baja">Baja</option><option value="media">Media</option><option value="alta">Alta</option>
              </select>
            </label>
            <button type="submit" disabled={!clienteId || !titulo.trim()}>Agregar</button>
          </div>
        </form>
      )}

      <label>
        <input type="checkbox" checked={verResueltos} onChange={(e) => setVerResueltos(e.target.checked)} /> Mostrar también resueltos
      </label>
      {visibles.length === 0 ? (
        <p className="suave">No hay avisos pendientes.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Fecha límite</th><th>Aviso</th><th>Cliente</th><th>Tipo</th><th>Prioridad</th><th>Origen</th><th></th></tr></thead>
            <tbody>
              {visibles.map((i) => {
                const vencido = i.estado === 'pendiente' && i.fecha_limite !== null && i.fecha_limite < hoy
                return (
                  <tr key={i.id}>
                    <td>{fechaCorta(i.fecha_limite)} {vencido && <span className="badge vencida">Vencido</span>}</td>
                    <td>
                      <strong>{i.titulo}</strong>
                      {i.detalle && <><br /><span className="suave">{i.detalle}</span></>}
                      {i.estado !== 'pendiente' && <><br /><span className="badge">{i.estado === 'hecho' ? 'Hecho' : 'Descartado'}</span></>}
                    </td>
                    <td>{nombreCliente(i.client_id)}</td>
                    <td>{TIPOS[i.tipo]}</td>
                    <td><span className={`badge ${i.prioridad === 'alta' ? 'vencida' : i.prioridad === 'media' ? 'pendiente' : ''}`}>{i.prioridad}</span></td>
                    <td>{i.origen === 'tarea' ? 'Tarea automática' : 'Manual'}</td>
                    <td>
                      {puede && i.estado === 'pendiente' && (
                        <>
                          <button className="secundario" onClick={() => marcar(i.id, 'hecho')}>Hecho</button>{' '}
                          <button className="secundario" onClick={() => marcar(i.id, 'descartado')}>Descartar</button>{' '}
                        </>
                      )}
                      {puede && i.estado !== 'pendiente' && <button className="secundario" onClick={() => marcar(i.id, 'pendiente')}>Reabrir</button>}{' '}
                      {puede && i.origen === 'manual' && <button className="secundario" onClick={() => borrar(i.id)}>Borrar</button>}
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
