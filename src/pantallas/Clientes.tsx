import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import {
  CATEGORIAS_MONOTRIBUTO,
  REGIMEN_LABEL,
  type Autorizacion,
  type Cliente,
  type Estudio,
  type Regimen,
} from '../lib/types'
import { cuitValido, ESTADO_LABEL, estadoDelCliente, formatoCuit, mensajeDb, soloDigitos } from '../lib/utiles'
import FichaCliente from './FichaCliente'

type Props = { estudio: Estudio; permisos: string[] }

export default function Clientes({ estudio, permisos }: Props) {
  const esAdmin = permisos.includes('admin')
  const puedeEditar = permisos.includes('clientes.editar')
  const [clientes, setClientes] = useState<Cliente[]>([])
  const [auts, setAuts] = useState<Autorizacion[]>([])
  const [filtro, setFiltro] = useState('')
  const [abierto, setAbierto] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [cuit, setCuit] = useState('')
  const [razon, setRazon] = useState('')
  const [regimen, setRegimen] = useState<Regimen | ''>('')
  const [categoria, setCategoria] = useState('')

  const cargar = useCallback(async () => {
    const [c, a] = await Promise.all([
      supabase
        .from('clients')
        .select('id, tenant_id, cuit, razon_social, regimen, categoria_monotributo, activo, notas')
        .eq('tenant_id', estudio.id)
        .order('razon_social'),
      supabase
        .from('client_authorizations')
        .select('id, tenant_id, client_id, estado, vigente_desde, vigente_hasta, observaciones')
        .eq('tenant_id', estudio.id),
    ])
    if (c.error || a.error) setError('No se pudieron cargar los clientes.')
    else {
      setClientes((c.data ?? []) as Cliente[])
      setAuts((a.data ?? []) as Autorizacion[])
    }
    setCargando(false)
  }, [estudio.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function agregar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const limpio = soloDigitos(cuit)
    if (!cuitValido(limpio)) return setError('El CUIT no es válido. Revisá los 11 dígitos.')
    const { error } = await supabase.from('clients').insert({
      tenant_id: estudio.id,
      cuit: limpio,
      razon_social: razon.trim(),
      regimen: regimen || null,
      categoria_monotributo: regimen === 'monotributo' && categoria ? categoria : null,
    })
    if (error) {
      return setError(
        error.code === '23505' ? 'Ese CUIT ya está cargado en este estudio.' : mensajeDb(error, 'No se pudo guardar el cliente.'),
      )
    }
    setCuit('')
    setRazon('')
    setRegimen('')
    setCategoria('')
    cargar()
  }

  const texto = filtro.trim().toLowerCase()
  const digitos = soloDigitos(filtro)
  const visibles = clientes.filter(
    (c) => !texto || (digitos && c.cuit.includes(digitos)) || c.razon_social.toLowerCase().includes(texto),
  )
  const seleccionado = clientes.find((c) => c.id === abierto) ?? null

  return (
    <section>
      <h2>Clientes de {estudio.nombre}</h2>

      {cargando ? (
        <p className="suave">Cargando…</p>
      ) : clientes.length === 0 ? (
        <p className="suave">
          {esAdmin
            ? 'Todavía no hay clientes. Cargá el primero abajo.'
            : 'No tenés clientes asignados todavía. Pedile al administrador que te asigne.'}
        </p>
      ) : (
        <>
          <label>
            Buscar por CUIT o razón social
            <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Ej.: 20-11111111-2 o Pérez" />
          </label>
          <div className="tabla-scroll">
            <table>
              <thead>
                <tr><th>CUIT</th><th>Razón social</th><th>Régimen</th><th>Autorización</th><th></th></tr>
              </thead>
              <tbody>
                {visibles.map((c) => {
                  const estado = estadoDelCliente(auts.filter((a) => a.client_id === c.id))
                  return (
                    <tr key={c.id}>
                      <td className="nowrap">{formatoCuit(c.cuit)}</td>
                      <td>{c.razon_social}{c.activo ? '' : ' (inactivo)'}</td>
                      <td>
                        {c.regimen ? REGIMEN_LABEL[c.regimen] : '—'}
                        {c.categoria_monotributo ? ` · cat. ${c.categoria_monotributo}` : ''}
                      </td>
                      <td><span className={`badge ${estado}`}>{ESTADO_LABEL[estado]}</span></td>
                      <td><button className="secundario" onClick={() => setAbierto(c.id)}>Abrir</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {visibles.length === 0 && <p className="suave">Ningún cliente coincide con la búsqueda.</p>}
        </>
      )}

      {seleccionado && (
        <FichaCliente
          key={seleccionado.id}
          cliente={seleccionado}
          auts={auts.filter((a) => a.client_id === seleccionado.id)}
          estudio={estudio}
          esAdmin={esAdmin}
          puedeEditar={puedeEditar}
          onCambio={cargar}
          onCerrar={() => setAbierto(null)}
        />
      )}

      {esAdmin && (
        <>
          <h2>Agregar cliente</h2>
          <form onSubmit={agregar} className="fila cuatro">
            <label>
              CUIT
              <input value={cuit} onChange={(e) => setCuit(e.target.value)} inputMode="numeric" placeholder="20-12345678-9" required />
            </label>
            <label>
              Razón social
              <input value={razon} onChange={(e) => setRazon(e.target.value)} required maxLength={160} />
            </label>
            <label>
              Régimen
              <select value={regimen} onChange={(e) => setRegimen(e.target.value as Regimen | '')}>
                <option value="">Sin definir</option>
                {(Object.keys(REGIMEN_LABEL) as Regimen[]).map((r) => (
                  <option key={r} value={r}>{REGIMEN_LABEL[r]}</option>
                ))}
              </select>
            </label>
            <label>
              Categoría
              <select value={categoria} onChange={(e) => setCategoria(e.target.value)} disabled={regimen !== 'monotributo'}>
                <option value="">—</option>
                {CATEGORIAS_MONOTRIBUTO.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <button>Guardar cliente</button>
          </form>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
