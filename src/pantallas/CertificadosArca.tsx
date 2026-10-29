import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { CertificadoArca, Estudio } from '../lib/types'
import { cuitValido, fechaCorta, formatoCuit, mensajeDeFuncion, soloDigitos } from '../lib/utiles'

const AMBIENTE = { homologacion: 'Homologación (pruebas)', produccion: 'Producción' } as const
const MAX_BYTES = 20000

function bajar(nombre: string, contenido: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'application/x-pem-file' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  a.click()
  URL.revokeObjectURL(url)
}

async function leerArchivo(f: File | null): Promise<string> {
  if (!f) throw new Error('Falta elegir un archivo.')
  if (f.size > MAX_BYTES) throw new Error(`El archivo ${f.name} es demasiado grande para ser un certificado o una clave.`)
  return f.text()
}

function diasPara(iso: string | null): number | null {
  return iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400000) : null
}

export default function CertificadosArca({ estudio }: { estudio: Estudio }) {
  const [lista, setLista] = useState<CertificadoArca[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)

  // Ya tengo el par
  const [ambPar, setAmbPar] = useState('produccion')
  const [aliasPar, setAliasPar] = useState('')
  const [crt, setCrt] = useState<File | null>(null)
  const [key, setKey] = useState<File | null>(null)

  // Generar CSR
  const [ambCsr, setAmbCsr] = useState('homologacion')
  const [cuitCsr, setCuitCsr] = useState(estudio.cuit ?? '')
  const [orgCsr, setOrgCsr] = useState(estudio.nombre)
  const [aliasCsr, setAliasCsr] = useState('syscar')

  // Subir .crt de un pedido
  const [crtPedido, setCrtPedido] = useState<Record<string, File | null>>({})

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('arca_certificados').select('*').eq('tenant_id', estudio.id).order('creado_en', { ascending: false })
    if (error) setError('No se pudieron cargar los certificados.')
    else setLista((data ?? []) as CertificadoArca[])
  }, [estudio.id])
  useEffect(() => { cargar() }, [cargar])

  async function llamar(cuerpo: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setError(null)
    setOk(null)
    setTrabajando(true)
    const { data, error } = await supabase.functions.invoke('arca-certificados', { body: { tenant_id: estudio.id, ...cuerpo } })
    setTrabajando(false)
    if (error) {
      setError(await mensajeDeFuncion(error))
      return null
    }
    await cargar()
    return data as Record<string, unknown>
  }

  async function subirPar(e: FormEvent) {
    e.preventDefault()
    const formulario = e.target as HTMLFormElement // se guarda antes del await (React lo anula despues)
    try {
      const r = await llamar({ accion: 'subir_par', ambiente: ambPar, alias: aliasPar.trim() || 'certificado', crt: await leerArchivo(crt), key: await leerArchivo(key) })
      if (r) { setOk('Certificado y clave guardados. La clave quedó cifrada en el servidor y no se puede volver a descargar.'); setCrt(null); setKey(null); formulario.reset() }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function generar(e: FormEvent) {
    e.preventDefault()
    if (!cuitValido(cuitCsr)) { setError('El CUIT no es válido.'); return }
    const r = await llamar({ accion: 'generar_csr', ambiente: ambCsr, cuit: soloDigitos(cuitCsr), organizacion: orgCsr, alias: aliasCsr })
    if (r && typeof r.csr === 'string') {
      bajar(`syscar-${ambCsr}-${soloDigitos(cuitCsr)}.csr`, r.csr)
      setOk('Se generó el pedido (.csr) y se descargó. Llevalo a ARCA para obtener el certificado y después subí el .crt acá.')
    }
  }

  async function subirCrt(id: string) {
    try {
      const r = await llamar({ accion: 'subir_crt', certificado_id: id, crt: await leerArchivo(crtPedido[id] ?? null) })
      if (r) setOk('Certificado verificado y activado.')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function revocar(c: CertificadoArca) {
    if (!window.confirm(`¿Revocar el certificado «${c.alias}» (${AMBIENTE[c.ambiente]})? Se borra la clave guardada y no se puede deshacer.`)) return
    const r = await llamar({ accion: 'revocar', certificado_id: c.id })
    if (r) setOk('Certificado revocado.')
  }

  const vigentes = lista.filter((c) => c.estado !== 'revocado')
  const revocados = lista.filter((c) => c.estado === 'revocado')

  return (
    <section>
      <h2>Certificados ARCA</h2>
      <p className="suave">
        Cada estudio usa su propio certificado digital para hablar con ARCA. La <strong>clave privada se guarda cifrada en el servidor</strong> y nunca
        vuelve al navegador: no se puede ver ni descargar. Solo la usa el sistema al conectarse con ARCA.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}

      <h3>Certificados del estudio</h3>
      {vigentes.length === 0 ? (
        <p className="suave">Todavía no hay certificados. Cargá uno existente o generá un pedido nuevo.</p>
      ) : (
        <div className="tabla-scroll">
          <table>
            <thead><tr><th>Ambiente</th><th>Alias</th><th>CUIT</th><th>Estado</th><th>Vence</th><th>Acciones</th></tr></thead>
            <tbody>
              {vigentes.map((c) => {
                const dias = diasPara(c.valido_hasta)
                const vencido = dias !== null && dias < 0
                return (
                  <tr key={c.id}>
                    <td>{AMBIENTE[c.ambiente]}</td>
                    <td>{c.alias}<br /><span className="suave">{c.origen === 'subido' ? 'subido' : 'generado acá'}</span></td>
                    <td>{formatoCuit(c.cuit)}</td>
                    <td>
                      {c.estado === 'activo' && !vencido && <span className="badge vigente">Activo</span>}
                      {c.estado === 'activo' && vencido && <span className="badge vencida">Vencido</span>}
                      {c.estado === 'csr_generado' && <span className="badge pendiente">Esperando el .crt de ARCA</span>}
                    </td>
                    <td>
                      {c.valido_hasta ? fechaCorta(c.valido_hasta) : '—'}
                      {dias !== null && dias >= 0 && dias <= 30 && <><br /><span className="badge pendiente">vence en {dias} días</span></>}
                    </td>
                    <td>
                      {c.estado === 'csr_generado' && c.csr_pem && (
                        <>
                          <button type="button" className="secundario" onClick={() => bajar(`syscar-${c.ambiente}-${c.cuit}.csr`, c.csr_pem ?? '')}>Descargar .csr</button>{' '}
                          <input type="file" accept=".crt,.pem,.cer" aria-label="Archivo .crt de ARCA" onChange={(e) => setCrtPedido((x) => ({ ...x, [c.id]: e.target.files?.[0] ?? null }))} />{' '}
                          <button type="button" disabled={trabajando || !crtPedido[c.id]} onClick={() => subirCrt(c.id)}>Subir .crt</button>{' '}
                        </>
                      )}
                      <button type="button" className="secundario" disabled={trabajando} onClick={() => revocar(c)}>Revocar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>Ya tengo el certificado (.crt) y la clave (.key)</h3>
      <form onSubmit={subirPar}>
        <p className="suave">Tienen que ser el par que se creó junto. El sistema lo verifica y, si no coinciden, no guarda nada. La clave no puede tener contraseña.</p>
        <div className="fila tres">
          <label>
            Ambiente
            <select value={ambPar} onChange={(e) => setAmbPar(e.target.value)}>
              <option value="produccion">{AMBIENTE.produccion}</option>
              <option value="homologacion">{AMBIENTE.homologacion}</option>
            </select>
          </label>
          <label>Alias (opcional)<input value={aliasPar} maxLength={60} onChange={(e) => setAliasPar(e.target.value)} /></label>
          <span />
        </div>
        <div className="fila dos">
          <label>Certificado (.crt)<input type="file" accept=".crt,.pem,.cer" required onChange={(e) => setCrt(e.target.files?.[0] ?? null)} /></label>
          <label>Clave privada (.key)<input type="file" accept=".key,.pem" required onChange={(e) => setKey(e.target.files?.[0] ?? null)} /></label>
          <span />
        </div>
        <button type="submit" disabled={trabajando || !crt || !key}>Verificar y guardar</button>
      </form>

      <h3>Generar clave y pedido de certificado (CSR)</h3>
      <form onSubmit={generar}>
        <p className="suave">Para un estudio nuevo. El sistema crea la clave (queda cifrada, no se descarga) y te da el archivo .csr para pedir el certificado en ARCA.</p>
        <div className="fila cuatro">
          <label>
            Ambiente
            <select value={ambCsr} onChange={(e) => setAmbCsr(e.target.value)}>
              <option value="homologacion">{AMBIENTE.homologacion}</option>
              <option value="produccion">{AMBIENTE.produccion}</option>
            </select>
          </label>
          <label>CUIT de quien pide el certificado<input value={cuitCsr} inputMode="numeric" onChange={(e) => setCuitCsr(e.target.value)} required /></label>
          <label>Nombre o razón social<input value={orgCsr} maxLength={64} onChange={(e) => setOrgCsr(e.target.value)} required /></label>
          <label>Alias (sin espacios)<input value={aliasCsr} maxLength={40} onChange={(e) => setAliasCsr(e.target.value)} required /></label>
        </div>
        <button type="submit" disabled={trabajando}>Generar clave y pedido (.csr)</button>
      </form>

      {revocados.length > 0 && (
        <details>
          <summary>Certificados revocados ({revocados.length})</summary>
          <ul>{revocados.map((c) => <li key={c.id}>{c.alias} · {AMBIENTE[c.ambiente]} · {formatoCuit(c.cuit)}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
