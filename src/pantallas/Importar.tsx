import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Estudio, LoteImportacion, Perfil } from '../lib/types'
import { useClientes } from '../lib/useClientes'
import { descargarCsv, fechaHora, formatoCuit, hoyLocal, mensajeDb, pesos } from '../lib/utiles'
import { camposDe, detectarColumnas, encontrarEncabezado, plantillaCsv, TIPO_LABEL, type TipoImportacion } from '../importar/columnas'
import { leerArchivo, type Leido } from '../importar/leer'
import { MAX_FILAS, validarFilas } from '../importar/validar'
import { normalizar } from '../importar/valores'

type Props = { estudio: Estudio; permisos: string[] }

type Existentes = { cargando: boolean; filas: Set<number>; error: boolean }

const TIPOS = Object.keys(TIPO_LABEL) as TipoImportacion[]

export default function Importar({ estudio, permisos }: Props) {
  const puedeImportar = permisos.includes('importaciones.gestionar')
  const esAdmin = permisos.includes('admin')
  const { clientes, cargando: cargandoClientes } = useClientes(estudio.id)
  const [clienteId, setClienteId] = useState('')
  const [tipo, setTipo] = useState<TipoImportacion>('comprobantes_emitidos')
  const [leido, setLeido] = useState<Leido | null>(null)
  const [filaEnc, setFilaEnc] = useState(0)
  const [mapa, setMapa] = useState<Record<string, number>>({})
  const [existentes, setExistentes] = useState<Existentes>({ cargando: false, filas: new Set(), error: false })
  const [leyendo, setLeyendo] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exito, setExito] = useState<string | null>(null)
  const [versionHistorial, setVersionHistorial] = useState(0)

  useEffect(() => {
    if (!clienteId && clientes.length > 0) setClienteId(clientes[0].id)
  }, [clientes, clienteId])

  function reiniciar() {
    setLeido(null)
    setMapa({})
    setExistentes({ cargando: false, filas: new Set(), error: false })
  }

  async function alElegirArchivo(archivo: File | undefined) {
    setError(null)
    setExito(null)
    reiniciar()
    if (!archivo) return
    setLeyendo(true)
    try {
      const l = await leerArchivo(archivo)
      if (l.filas.length < 2) throw new Error('El archivo no tiene datos.')
      const enc = encontrarEncabezado(l.filas, tipo)
      const fila = Math.max(enc, 0)
      setLeido(l)
      setFilaEnc(fila)
      setMapa(detectarColumnas(l.filas[fila], tipo))
      if (enc < 0) setError('No pude reconocer los encabezados. Indicá a mano qué columna es cada dato.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer el archivo.')
    }
    setLeyendo(false)
  }

  const campos = camposDe(tipo)
  const faltantes = campos.filter((c) => c.obligatorio && (mapa[c.id] ?? -1) < 0)

  const resultado = useMemo(() => {
    if (!leido || faltantes.length > 0) return null
    const alicuotas = leido.filas[filaEnc]
      .map((h, i) => (normalizar(h).startsWith('impnetogravadoiva') ? i : -1))
      .filter((i) => i >= 0)
    return validarFilas(tipo, leido.filas.slice(filaEnc + 1), mapa, filaEnc + 2, hoyLocal(), alicuotas)
  }, [leido, mapa, tipo, filaEnc, faltantes.length])

  // Consulta a la base cuales filas ya existen (misma regla de duplicados que usa al guardar).
  useEffect(() => {
    if (!resultado || !clienteId || resultado.validas.length === 0 || resultado.validas.length > MAX_FILAS) return
    let cancelado = false
    setExistentes((e) => ({ ...e, cargando: true, error: false }))
    const claves = resultado.validas.map((f) =>
      tipo === 'pagos'
        ? { fila: f.fila, fecha: f.fecha, importe: f.importe, concepto: f.concepto, referencia: f.referencia }
        : { fila: f.fila, tipo_cbte: f.tipo_cbte, punto_venta: f.punto_venta, numero: f.numero, doc: f.doc },
    )
    supabase
      .rpc('filas_existentes', { p_tenant: estudio.id, p_client: clienteId, p_tipo: tipo, p_filas: claves })
      .then(({ data, error }) => {
        if (cancelado) return
        if (error) setExistentes({ cargando: false, filas: new Set(), error: true })
        else setExistentes({ cargando: false, filas: new Set((data ?? []) as number[]), error: false })
      })
    return () => {
      cancelado = true
    }
  }, [resultado, clienteId, tipo, estudio.id])

  const repetidas = new Set(resultado?.duplicadasEnArchivo ?? [])
  const yaExisten = existentes.filas
  const nuevas = resultado ? resultado.validas.filter((f) => !yaExisten.has(f.fila) && !repetidas.has(f.fila)) : []
  const excede = resultado ? resultado.validas.length + resultado.rechazos.length > MAX_FILAS : false

  async function confirmar() {
    if (!resultado || !leido || !clienteId) return
    setError(null)
    setEnviando(true)
    const { data, error } = await supabase.rpc('confirmar_importacion', {
      p_tenant: estudio.id,
      p_client: clienteId,
      p_tipo: tipo,
      p_archivo: leido.nombre,
      p_hash: leido.hash,
      p_filas: resultado.validas,
      p_rechazos: resultado.rechazos,
    })
    setEnviando(false)
    if (error) return setError(mensajeDb(error, 'No se pudo guardar la importación. No se guardó nada.'))
    const r = data as { importadas: number; duplicadas: number; rechazadas: number; pendientes: number }
    setExito(
      `Importación guardada: ${r.importadas} filas nuevas` +
        (r.duplicadas ? `, ${r.duplicadas} duplicadas omitidas` : '') +
        (r.rechazadas ? `, ${r.rechazadas} rechazadas` : '') +
        (r.pendientes ? `. ${r.pendientes} quedaron pendientes de validación` : '') +
        '.',
    )
    reiniciar()
    setVersionHistorial((v) => v + 1)
  }

  function descargarRechazos() {
    if (!resultado) return
    descargarCsv('filas-rechazadas.csv', [
      ['Fila', 'Motivo'],
      ...resultado.rechazos.map((r) => [r.fila, r.motivo]),
      ...resultado.duplicadasEnArchivo.map((f) => [f, 'Repetida dentro del mismo archivo']),
      ...[...yaExisten].map((f) => [f, 'Ya existe en la base']),
    ])
  }

  const cliente = clientes.find((c) => c.id === clienteId)
  const vista = resultado?.validas.slice(0, 15) ?? []

  return (
    <section>
      <h2>Importar comprobantes y pagos</h2>
      <p className="suave">
        Subí el Excel (.xlsx) o CSV que descargás de ARCA (Mis Comprobantes) o de tu sistema. Primero ves una vista previa: nada se guarda
        hasta que confirmás. Los datos importados quedan como <strong>“importado”</strong> hasta que se validan.
      </p>

      {cargandoClientes ? (
        <p className="suave">Cargando…</p>
      ) : clientes.length === 0 ? (
        <p className="suave">No hay clientes disponibles. Cargá o asigná un cliente primero.</p>
      ) : (
        <>
          <div className="fila tres">
            <label>
              Cliente
              <select value={clienteId} onChange={(e) => { setClienteId(e.target.value); reiniciar() }}>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>{c.razon_social} · {formatoCuit(c.cuit)}</option>
                ))}
              </select>
            </label>
            <label>
              Qué vas a importar
              <select value={tipo} onChange={(e) => { setTipo(e.target.value as TipoImportacion); reiniciar() }}>
                {TIPOS.map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
              </select>
            </label>
            <label>
              Archivo (.xlsx o .csv)
              <input
                key={versionHistorial}
                type="file"
                accept=".xlsx,.csv,.txt"
                disabled={!puedeImportar || leyendo}
                onChange={(e) => alElegirArchivo(e.target.files?.[0])}
              />
            </label>
          </div>
          {!puedeImportar && <p className="aviso">Tu rol no puede importar archivos. Podés ver el historial más abajo.</p>}
          <p>
            <button className="secundario" onClick={() => descargarCsv(`plantilla-${tipo}.csv`, plantillaCsv(tipo).trim().split('\r\n').map((l) => l.split(';')))}>
              Descargar plantilla de ejemplo
            </button>
          </p>
        </>
      )}

      {leyendo && <p className="suave">Leyendo archivo…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {exito && <p className="ok" role="status">{exito}</p>}

      {leido && (
        <div className="ficha">
          <h3>1. Revisá las columnas</h3>
          <p className="suave">Archivo: {leido.nombre} · {leido.filas.length - filaEnc - 1} filas de datos. Si alguna columna no se reconoció, elegila a mano.</p>
          <div className="fila tres">
            {campos.map((c) => (
              <label key={c.id}>
                {c.etiqueta}{c.obligatorio ? ' *' : ''}
                <select
                  value={mapa[c.id] ?? -1}
                  onChange={(e) => setMapa({ ...mapa, [c.id]: Number(e.target.value) })}
                >
                  <option value={-1}>{c.obligatorio ? '— elegir —' : '— no viene —'}</option>
                  {leido.filas[filaEnc].map((h, i) => (
                    <option key={i} value={i}>{String(h ?? '') || `Columna ${i + 1}`}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {faltantes.length > 0 && (
            <p className="error">Falta indicar: {faltantes.map((f) => f.etiqueta).join(', ')}.</p>
          )}

          {resultado && (
            <>
              <h3>2. Vista previa</h3>
              <ul className="resumen">
                <li><strong>{nuevas.length}</strong> filas nuevas para importar</li>
                <li><strong>{yaExisten.size}</strong> ya existen en la base (se omiten){existentes.cargando ? ' · verificando…' : ''}</li>
                <li><strong>{repetidas.size}</strong> repetidas dentro del archivo (se omiten)</li>
                <li><strong>{resultado.rechazos.length}</strong> rechazadas por errores</li>
              </ul>
              {existentes.error && (
                <p className="aviso">No pude comprobar duplicados contra la base. Igual la base los descarta al guardar.</p>
              )}
              {excede && <p className="error">El archivo tiene más de {MAX_FILAS} filas. Dividilo por períodos.</p>}

              {vista.length > 0 && (
                <div className="tabla-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Fila</th>
                        {tipo === 'pagos'
                          ? <><th>Fecha</th><th>Concepto</th><th>Importe</th><th>Estado</th></>
                          : <><th>Fecha</th><th>Comprobante</th><th>Contraparte</th><th>Total</th><th>Estado</th></>}
                      </tr>
                    </thead>
                    <tbody>
                      {vista.map((f) => {
                        const estado = yaExisten.has(f.fila) ? 'Ya existe' : repetidas.has(f.fila) ? 'Repetida' : 'Nueva'
                        return (
                          <tr key={f.fila}>
                            <td>{f.fila}</td>
                            <td className="nowrap">{String(f.fecha)}</td>
                            {tipo === 'pagos' ? (
                              <><td>{f.concepto}</td><td className="num">{pesos(Number(f.importe))}</td></>
                            ) : (
                              <>
                                <td className="nowrap">Tipo {f.tipo_cbte} · {String(f.punto_venta).padStart(5, '0')}-{String(f.numero).padStart(8, '0')}</td>
                                <td>{f.contraparte ?? f.doc ?? '—'}</td>
                                <td className="num">{pesos(Number(f.total))}</td>
                              </>
                            )}
                            <td><span className={`badge ${estado === 'Nueva' ? 'vigente' : 'pendiente'}`}>{estado}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {resultado.validas.length > vista.length && (
                    <p className="suave">Mostrando las primeras {vista.length} de {resultado.validas.length} filas.</p>
                  )}
                </div>
              )}

              {resultado.rechazos.length > 0 && (
                <details open>
                  <summary>Filas rechazadas ({resultado.rechazos.length})</summary>
                  <ul>
                    {resultado.rechazos.slice(0, 30).map((r) => (
                      <li key={r.fila}>Fila {r.fila}: {r.motivo}</li>
                    ))}
                  </ul>
                  {resultado.rechazos.length > 30 && <p className="suave">Hay más: descargá el informe completo.</p>}
                </details>
              )}
              <p className="acciones">
                {(resultado.rechazos.length > 0 || yaExisten.size > 0 || repetidas.size > 0) && (
                  <button className="secundario" onClick={descargarRechazos}>Descargar informe de filas omitidas</button>
                )}
              </p>

              <h3>3. Confirmar</h3>
              <p className="suave">
                Se guardarán en <strong>{cliente?.razon_social}</strong> como datos <em>importados</em> (no validados). Las filas rechazadas no se guardan.
              </p>
              <p className="acciones">
                <button
                  onClick={confirmar}
                  disabled={enviando || existentes.cargando || nuevas.length === 0 || excede || !puedeImportar}
                >
                  {enviando ? 'Guardando…' : `Confirmar importación de ${nuevas.length} filas`}
                </button>
                <button className="secundario" onClick={() => { reiniciar(); setVersionHistorial((v) => v + 1) }}>Cancelar</button>
              </p>
            </>
          )}
        </div>
      )}

      {clienteId && (
        <Historial
          key={`${clienteId}-${versionHistorial}`}
          estudio={estudio}
          clienteId={clienteId}
          puedeValidar={puedeImportar}
          esAdmin={esAdmin}
        />
      )}
    </section>
  )
}

function Historial({ estudio, clienteId, puedeValidar, esAdmin }: { estudio: Estudio; clienteId: string; puedeValidar: boolean; esAdmin: boolean }) {
  const [lotes, setLotes] = useState<LoteImportacion[]>([])
  const [personas, setPersonas] = useState<Record<string, string>>({})
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [anulando, setAnulando] = useState<string | null>(null)
  const [motivo, setMotivo] = useState('')

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('import_batches')
      .select('*')
      .eq('tenant_id', estudio.id)
      .eq('client_id', clienteId)
      .order('creado_en', { ascending: false })
      .limit(50)
    if (error) {
      setError('No se pudo cargar el historial.')
      setCargando(false)
      return
    }
    const ls = (data ?? []) as LoteImportacion[]
    setLotes(ls)
    const ids = [...new Set(ls.flatMap((l) => [l.creado_por, l.validado_por, l.anulado_por]).filter((x): x is string => !!x))]
    if (ids.length > 0) {
      const p = await supabase.from('profiles').select('id, email, nombre').in('id', ids)
      const m: Record<string, string> = {}
      for (const x of (p.data ?? []) as Perfil[]) m[x.id] = x.nombre || x.email || 'Usuario'
      setPersonas(m)
    }
    setCargando(false)
  }, [estudio.id, clienteId])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function validar(l: LoteImportacion) {
    const aviso = l.filas_pendientes > 0 ? ` ${l.filas_pendientes} filas tienen advertencias: revisalas antes.` : ''
    if (!window.confirm(`¿Marcar como validado el lote "${l.archivo_nombre}"? Sus datos pasan a "confirmado".${aviso}`)) return
    setError(null)
    const { error } = await supabase.rpc('validar_lote', { p_lote: l.id })
    if (error) return setError(mensajeDb(error, 'No se pudo validar el lote.'))
    cargar()
  }

  async function anular(l: LoteImportacion) {
    setError(null)
    const { error } = await supabase.rpc('anular_lote', { p_lote: l.id, p_motivo: motivo })
    if (error) return setError(mensajeDb(error, 'No se pudo anular el lote.'))
    setAnulando(null)
    setMotivo('')
    cargar()
  }

  return (
    <>
      <h2>Historial de importaciones</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {cargando ? (
        <p className="suave">Cargando…</p>
      ) : lotes.length === 0 ? (
        <p className="suave">Este cliente todavía no tiene importaciones.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Fecha</th><th>Archivo</th><th>Tipo</th><th>Responsable</th><th>Filas</th><th>Estado</th><th></th></tr>
            </thead>
            <tbody>
              {lotes.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{fechaHora(l.creado_en)}</td>
                  <td>{l.archivo_nombre}</td>
                  <td>{TIPO_LABEL[l.tipo]}</td>
                  <td>{personas[l.creado_por] ?? '—'}</td>
                  <td>
                    {l.filas_importadas} ok
                    {l.filas_duplicadas ? ` · ${l.filas_duplicadas} dup.` : ''}
                    {l.filas_rechazadas ? ` · ${l.filas_rechazadas} rech.` : ''}
                    {l.filas_pendientes ? ` · ${l.filas_pendientes} a revisar` : ''}
                  </td>
                  <td>
                    <span className={`badge ${l.estado === 'validado' ? 'vigente' : l.estado === 'anulado' ? 'revocada' : 'pendiente'}`}>
                      {l.estado === 'validado' ? 'Validado' : l.estado === 'anulado' ? 'Anulado' : 'Importado (sin validar)'}
                    </span>
                  </td>
                  <td>
                    <div className="acciones">
                      <button className="secundario" onClick={() => setAbierto(abierto === l.id ? null : l.id)}>Detalle</button>
                      {l.estado === 'importado' && puedeValidar && <button className="secundario" onClick={() => validar(l)}>Validar</button>}
                      {l.estado !== 'anulado' && esAdmin && <button className="secundario peligro" onClick={() => setAnulando(l.id)}>Anular</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lotes.filter((l) => l.id === abierto).map((l) => (
        <div className="rol" key={l.id}>
          <h3>Detalle de “{l.archivo_nombre}”</h3>
          <p className="suave">
            Total de filas del archivo: {l.filas_total}.
            {l.validado_en && ` Validado por ${personas[l.validado_por ?? ''] ?? '—'} el ${fechaHora(l.validado_en)}.`}
            {l.anulado_en && ` Anulado por ${personas[l.anulado_por ?? ''] ?? '—'} el ${fechaHora(l.anulado_en)}. Motivo: ${l.motivo_anulacion}`}
          </p>
          {l.informe.length === 0 ? (
            <p className="suave">No hubo filas rechazadas ni duplicadas.</p>
          ) : (
            <>
              <ul>
                {l.informe.slice(0, 20).map((x, i) => (
                  <li key={i}>Fila {x.fila} · {x.tipo === 'duplicado' ? 'Duplicada' : 'Rechazada'}: {x.motivo}</li>
                ))}
              </ul>
              <button className="secundario" onClick={() => descargarCsv(`informe-${l.archivo_nombre}.csv`, [['Fila', 'Tipo', 'Motivo'], ...l.informe.map((x) => [x.fila, x.tipo, x.motivo])])}>
                Descargar informe
              </button>
            </>
          )}
        </div>
      ))}

      {lotes.filter((l) => l.id === anulando).map((l) => (
        <div className="aviso" key={l.id}>
          <strong>Anular “{l.archivo_nombre}”.</strong> Se borran los {l.filas_importadas} registros de este lote y queda constancia en la auditoría.
          Después podés volver a importar el archivo corregido.
          <label>
            Motivo (obligatorio)
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} />
          </label>
          <div className="acciones">
            <button className="peligro secundario" disabled={motivo.trim().length < 5} onClick={() => anular(l)}>Confirmar anulación</button>
            <button className="secundario" onClick={() => { setAnulando(null); setMotivo('') }}>Cancelar</button>
          </div>
        </div>
      ))}
    </>
  )
}
