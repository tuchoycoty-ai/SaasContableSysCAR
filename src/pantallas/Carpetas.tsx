import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { fechaCorta, formatoCuit, mensajeDb, pesos, soloDigitos } from '../lib/utiles'
import type { TipoImportacion } from '../importar/columnas'
import { prepararComprobantes, prepararPdf, type Preparado } from '../importar/preparar'
import { aplicarPdf } from '../importar/aplicar'

// Carpetas de trabajo: el usuario elige una carpeta por acción y SysCAR revisa cada tanto si hay archivos nuevos.
// Usa la API de carpetas de Chrome/Edge: el permiso lo da el usuario y solo vale mientras la app está abierta.
type Slot = 'emitidos' | 'recibidos' | 'ddjj_vep'
const SLOTS: { id: Slot; titulo: string; ayuda: string; ext: string[] }[] = [
  { id: 'emitidos', titulo: 'Comprobantes emitidos', ayuda: 'CSV o Excel de «Mis Comprobantes» (emitidos).', ext: ['csv', 'xlsx'] },
  { id: 'recibidos', titulo: 'Comprobantes recibidos', ayuda: 'CSV o Excel de «Mis Comprobantes» (recibidos).', ext: ['csv', 'xlsx'] },
  { id: 'ddjj_vep', titulo: 'DDJJ y VEP', ayuda: 'PDF de acuses de DJ y comprobantes de pago de VEP.', ext: ['pdf'] },
]

type Dir = { entries(): AsyncIterable<[string, Entrada]>; name: string; queryPermission(o: { mode: 'read' }): Promise<string>; requestPermission(o: { mode: 'read' }): Promise<string> }
type Entrada = { kind: 'file' | 'directory'; getFile(): Promise<File> }
type Win = { showDirectoryPicker?: (o: { mode: 'read' }) => Promise<Dir> }

// ---- IndexedDB: guarda la carpeta elegida (el navegador no permite guardarla de otra forma) ----
function abrirDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('syscar-carpetas', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('carpetas')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function guardarDir(clave: string, h: Dir) {
  const db = await abrirDb()
  await new Promise<void>((res, rej) => { const t = db.transaction('carpetas', 'readwrite'); t.objectStore('carpetas').put(h, clave); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
}
async function leerDir(clave: string): Promise<Dir | null> {
  try {
    const db = await abrirDb()
    return await new Promise((res) => { const q = db.transaction('carpetas').objectStore('carpetas').get(clave); q.onsuccess = () => res((q.result as Dir) ?? null); q.onerror = () => res(null) })
  } catch { return null }
}

type Item = {
  clave: string
  slot: Slot
  nombre: string
  estado: 'listo' | 'error' | 'hecho'
  mensaje: string
  clienteId: string | null
  preparado?: Preparado
}

export default function Carpetas({ estudio, permisos, yo }: { estudio: Estudio; permisos: string[]; yo: string }) {
  const puede = permisos.includes('admin') || permisos.includes('importaciones.gestionar')
  const { clientes } = useClientes(estudio.id)
  const soportado = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  const [dirs, setDirs] = useState<Partial<Record<Slot, Dir>>>({})
  const [sinPermiso, setSinPermiso] = useState<Slot[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [error, setError] = useState<string | null>(null)
  const [buscando, setBuscando] = useState(false)
  const [ultima, setUltima] = useState<Date | null>(null)
  const vistos = useRef<Map<string, Item>>(new Map())
  const claveProc = `syscar:procesados:${estudio.id}`

  const procesados = useCallback((): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem(claveProc) ?? '[]') as string[]) } catch { return new Set() }
  }, [claveProc])
  const marcar = useCallback((hash: string) => {
    try { const s = procesados(); s.add(hash); localStorage.setItem(claveProc, JSON.stringify([...s].slice(-2000))) } catch { /* sin almacenamiento: se avisa por duplicado en la base */ }
  }, [claveProc, procesados])

  const clientePorCuit = useCallback((cuit: string) => clientes.find((c) => soloDigitos(c.cuit) === cuit) ?? null, [clientes])

  const buscar = useCallback(async (actuales: Partial<Record<Slot, Dir>>) => {
    setBuscando(true)
    const lista: Item[] = []
    const faltan: Slot[] = []
    const ya = procesados()
    for (const s of SLOTS) {
      const d = actuales[s.id]
      if (!d) continue
      if ((await d.queryPermission({ mode: 'read' })) !== 'granted') { faltan.push(s.id); continue }
      for await (const [nombre, ent] of d.entries()) {
        if (ent.kind !== 'file' || !s.ext.includes(nombre.toLowerCase().split('.').pop() ?? '')) continue
        const archivo = await ent.getFile()
        const clave = `${s.id}|${nombre}|${archivo.size}|${archivo.lastModified}`
        const previo = vistos.current.get(clave)
        if (previo) { if (previo.preparado && ya.has(previo.preparado.hash)) continue; if (previo.estado !== 'hecho') lista.push(previo); continue }
        let it: Item
        try {
          if (s.id === 'ddjj_vep') {
            const p = await prepararPdf(archivo)
            const cli = clientePorCuit(p.doc.cuit)
            it = { clave, slot: s.id, nombre, estado: cli ? 'listo' : 'error', clienteId: cli?.id ?? null, preparado: p,
              mensaje: cli ? '' : `El CUIT ${formatoCuit(p.doc.cuit)} no coincide con ningún cliente que puedas ver.` }
          } else {
            const tipo: TipoImportacion = s.id === 'emitidos' ? 'comprobantes_emitidos' : 'comprobantes_recibidos'
            const p = await prepararComprobantes(archivo, tipo)
            const cli = (nombre.match(/(?<!\d)\d{11}(?!\d)/g) ?? []).map(clientePorCuit).find((c) => c !== null) ?? null
            it = { clave, slot: s.id, nombre, estado: cli ? 'listo' : 'error', clienteId: cli?.id ?? null, preparado: p,
              mensaje: cli ? '' : 'No encontré el CUIT de un cliente en el nombre del archivo. Importalo a mano desde «Importar».' }
          }
          if (it.preparado && ya.has(it.preparado.hash)) continue
        } catch (e) {
          it = { clave, slot: s.id, nombre, estado: 'error', clienteId: null, mensaje: e instanceof Error ? e.message : 'No se pudo leer.' }
        }
        vistos.current.set(clave, it)
        lista.push(it)
      }
    }
    setSinPermiso(faltan)
    setItems(lista)
    setUltima(new Date())
    setBuscando(false)
  }, [clientePorCuit, procesados])

  // Al abrir: recupera las carpetas guardadas y busca. Despues revisa cada 60 s mientras la pantalla esta abierta.
  useEffect(() => {
    if (!soportado || clientes.length === 0) return
    let vivo = true
    let reloj: number | undefined
    ;(async () => {
      const nuevo: Partial<Record<Slot, Dir>> = {}
      for (const s of SLOTS) { const d = await leerDir(`${estudio.id}:${s.id}`); if (d) nuevo[s.id] = d }
      if (!vivo) return
      setDirs(nuevo)
      await buscar(nuevo)
      reloj = window.setInterval(() => { buscar(nuevo).catch(() => undefined) }, 60000)
    })().catch(() => setError('No se pudieron recuperar las carpetas guardadas.'))
    return () => { vivo = false; if (reloj) window.clearInterval(reloj) }
  }, [soportado, estudio.id, clientes.length, buscar])

  async function elegir(slot: Slot) {
    setError(null)
    try {
      const d = await (window as unknown as Win).showDirectoryPicker!({ mode: 'read' })
      await guardarDir(`${estudio.id}:${slot}`, d)
      const nuevo = { ...dirs, [slot]: d }
      setDirs(nuevo)
      await buscar(nuevo)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError('No se pudo abrir la carpeta.')
    }
  }
  async function reactivar() {
    for (const s of sinPermiso) await dirs[s]?.requestPermission({ mode: 'read' })
    await buscar(dirs)
  }

  async function confirmar(it: Item) {
    if (!it.preparado || !it.clienteId) return
    setError(null)
    try {
      let msg: string
      const p = it.preparado
      if (p.kind === 'pdf') msg = await aplicarPdf(estudio.id, it.clienteId, yo, p)
      else {
        const { data, error } = await supabase.rpc('confirmar_importacion', {
          p_tenant: estudio.id, p_client: it.clienteId, p_tipo: p.tipo, p_archivo: p.nombre, p_hash: p.hash,
          p_filas: p.resultado.validas, p_rechazos: p.resultado.rechazos,
        })
        if (error) throw new Error(mensajeDb(error, 'No se pudo guardar la importación. No se guardó nada.'))
        const r = data as { importadas: number; duplicadas: number; rechazadas: number; pendientes: number }
        msg = `${r.importadas} filas nuevas, ${r.duplicadas} duplicadas omitidas, ${r.rechazadas} rechazadas, ${r.pendientes} pendientes de validación`
      }
      marcar(p.hash)
      vistos.current.set(it.clave, { ...it, estado: 'hecho', mensaje: msg })
      setItems((l) => l.map((x) => (x.clave === it.clave ? { ...x, estado: 'hecho', mensaje: msg } : x)))
    } catch (e) {
      setError(`${it.nombre}: ${e instanceof Error ? e.message : 'falló.'}`)
    }
  }
  async function confirmarTodos() { for (const it of items.filter((i) => i.estado === 'listo')) await confirmar(it) }
  function ignorar(it: Item) { if (it.preparado) marcar(it.preparado.hash); vistos.current.delete(it.clave); setItems((l) => l.filter((x) => x.clave !== it.clave)) }

  const nombreCli = (id: string | null) => clientes.find((c) => c.id === id)?.razon_social ?? '—'
  const resumen = (it: Item): string => {
    const p = it.preparado
    if (!p) return it.mensaje
    if (p.kind === 'comprobantes') return `${p.resultado.validas.length} filas válidas, ${p.resultado.rechazos.length} con errores${p.resultado.duplicadasEnArchivo.length ? `, ${p.resultado.duplicadasEnArchivo.length} repetidas` : ''}`
    const d = p.doc
    return d.tipo === 'vep'
      ? `VEP ${d.nroVep} · ${d.tipoPago} · ${pesos(d.importe)} · pagado ${fechaCorta(d.fechaPago)}`
      : `Acuse F.${d.formulario} ${d.nombre}${d.periodo ? ` · período ${d.periodo}` : ''} · presentado ${fechaCorta(d.fechaPresentacion)}`
  }

  return (
    <section>
      <h2>Carpetas de ARCA</h2>
      <p className="suave">
        Elegí una carpeta por acción y guardá ahí lo que bajás de ARCA. SysCAR revisa las carpetas cada minuto <strong>mientras esta pantalla esté abierta</strong> y te muestra lo nuevo para que lo confirmes.
        Los archivos se leen en tu navegador y no se suben: solo se guardan los datos que confirmes.
      </p>
      {!soportado && <p className="error" role="alert">Tu navegador no permite elegir carpetas. Usá Chrome o Edge de escritorio, o importá a mano desde «Importar».</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {soportado && (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Acción</th><th>Carpeta</th><th></th></tr></thead>
            <tbody>
              {SLOTS.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.titulo}</strong><br /><span className="suave">{s.ayuda}</span></td>
                  <td>{dirs[s.id] ? dirs[s.id]!.name : <span className="suave">Sin elegir</span>}</td>
                  <td><button className="secundario" onClick={() => elegir(s.id)}>{dirs[s.id] ? 'Cambiar' : 'Elegir carpeta'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sinPermiso.length > 0 && <p className="aviso">El navegador pide que vuelvas a autorizar el acceso a {sinPermiso.length === 1 ? 'una carpeta' : 'las carpetas'}. <button onClick={reactivar}>Autorizar</button></p>}
      {soportado && (
        <p className="suave">
          <button className="secundario" onClick={() => buscar(dirs)} disabled={buscando}>{buscando ? 'Buscando…' : 'Buscar ahora'}</button>{' '}
          {ultima && `Última revisión: ${ultima.toLocaleTimeString('es-AR')}`}
        </p>
      )}

      {items.length === 0 ? (
        <p className="suave">No hay archivos nuevos para revisar.</p>
      ) : (
        <>
          {puede && items.some((i) => i.estado === 'listo') && <button onClick={confirmarTodos}>Confirmar todos los listos</button>}
          <div className="tabla-scroll">
            <table>
              <thead><tr><th>Archivo</th><th>Qué es</th><th>Cliente</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.clave}>
                    <td>{it.nombre}</td>
                    <td>{resumen(it)}{it.preparado?.kind === 'pdf' && it.preparado.plan.avisos.map((a, i) => <div key={i} className="suave">{a}</div>)}</td>
                    <td>{nombreCli(it.clienteId)}</td>
                    <td>{it.estado === 'hecho' ? <span className="badge vigente">Hecho: {it.mensaje}</span> : it.estado === 'error' ? <span className="badge vencida">{it.mensaje}</span> : <span className="badge pendiente">Para confirmar</span>}</td>
                    <td>
                      {puede && it.estado === 'listo' && <button onClick={() => confirmar(it)}>Confirmar</button>}{' '}
                      {it.estado !== 'hecho' && <button className="secundario" onClick={() => ignorar(it)}>Ignorar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
