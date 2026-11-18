// Lectura y descripción de los VEP pagados y las DDJJ presentadas (datos que salen de los PDF de ARCA).
import { supabase } from './supabase'

export type ItemDetalle = { nombre: string; codigo: string | null; importe: number }
export type PagoArca = {
  id: string; client_id: string; fecha: string; hora_pago: string | null; concepto: string; impuesto: string | null; medio: string | null; referencia: string | null
  importe: number; estado_dato: string
  tipo_pago: string | null; descripcion_reducida: string | null; concepto_arca: string | null; subconcepto_arca: string | null; periodo_arca: string | null
  cuota: string | null; naturaleza: 'capital' | 'intereses' | 'multa' | 'honorarios' | null; intereses: number; detalle: ItemDetalle[] | null
  nro_transaccion: string | null; entidad_pago: string | null; banco: string | null; vence: string | null; dj_nro: string | null
  vep_consolidado: string | null; es_consolidado: boolean
}
export type Presentacion = {
  id: string; client_id: string; formulario: string; version: string | null; nombre: string; impuesto: string | null; concepto: string | null; subconcepto: string | null
  periodo: string | null; fecha: string; hora: string | null; nro_transaccion: string; nro_verificador: string | null; registros: number | null
  presentada_por: string | null; codigo_barras: string | null
}

const CAMPOS_PAGO = 'id, client_id, fecha, hora_pago, concepto, impuesto, medio, referencia, importe, estado_dato, tipo_pago, descripcion_reducida, concepto_arca, subconcepto_arca, periodo_arca, cuota, naturaleza, intereses, detalle, nro_transaccion, entidad_pago, banco, vence, dj_nro, vep_consolidado, es_consolidado'
const CAMPOS_DJ = 'id, client_id, formulario, version, nombre, impuesto, concepto, subconcepto, periodo, fecha, hora, nro_transaccion, nro_verificador, registros, presentada_por, codigo_barras'

export async function cargarPagos(tenant: string, cliente: string, desde: string, hasta: string): Promise<PagoArca[]> {
  let q = supabase.from('pagos').select(CAMPOS_PAGO).eq('tenant_id', tenant).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }).order('hora_pago', { ascending: false }).limit(2000)
  if (cliente) q = q.eq('client_id', cliente)
  const { data, error } = await q
  if (error) throw new Error('No se pudieron cargar los pagos.')
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, importe: Number(r.importe), intereses: Number(r.intereses ?? 0) }) as unknown as PagoArca)
}

export async function cargarPresentaciones(tenant: string, cliente: string, desde: string, hasta: string): Promise<Presentacion[]> {
  let q = supabase.from('presentaciones').select(CAMPOS_DJ).eq('tenant_id', tenant).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }).order('hora', { ascending: false }).limit(2000)
  if (cliente) q = q.eq('client_id', cliente)
  const { data, error } = await q
  if (error) throw new Error('No se pudieron cargar las declaraciones juradas.')
  return (data ?? []) as unknown as Presentacion[]
}

// Un VEP consolidado y sus subVEP son el mismo dinero: en los totales se cuentan los subVEP (que traen el detalle).
export function paraTotales(pagos: PagoArca[]): PagoArca[] {
  const hijos = new Set(pagos.filter((p) => p.vep_consolidado).map((p) => `${p.client_id}|${p.vep_consolidado}`))
  return pagos.filter((p) => !(p.es_consolidado && p.referencia && hijos.has(`${p.client_id}|${p.referencia}`)))
}

export const NATURALEZA_LABEL: Record<string, string> = { capital: 'Capital', intereses: 'Intereses', multa: 'Multa', honorarios: 'Honorarios' }

export function totalesPagos(pagos: PagoArca[]) {
  const ps = paraTotales(pagos)
  const total = ps.reduce((a, p) => a + p.importe, 0)
  const intereses = ps.reduce((a, p) => a + p.intereses, 0)
  const multas = ps.filter((p) => p.naturaleza === 'multa').reduce((a, p) => a + p.importe, 0)
  return { total, intereses, multas, capital: total - intereses - multas, cantidad: ps.length, sinDetalle: ps.filter((p) => p.tipo_pago === null).length }
}

const limpiar = (t: string | null) => (t ?? '').replace(/^\d+\s*-?\s*/, '').trim()

// «Anticipo 3 · Intereses punitorios · Ganancias Sociedades»: lo que se pagó, en palabras.
export function queSePago(p: PagoArca): { titulo: string; detalle: string } {
  if (p.tipo_pago === null) return { titulo: p.concepto, detalle: 'Sin detalle: leé de nuevo el PDF en «Carpetas ARCA»' }
  const impuestos = (p.detalle ?? []).map((d) => d.nombre).join(', ')
  const partes = [
    p.cuota && /anticipo/i.test(p.concepto_arca ?? '') ? `Anticipo ${p.cuota}` : p.cuota ? `Cuota ${p.cuota}` : null,
    p.naturaleza === 'intereses' ? limpiar(p.subconcepto_arca) || 'Intereses' : p.naturaleza === 'multa' ? limpiar(p.subconcepto_arca) || 'Multa' : null,
    impuestos || null,
  ].filter(Boolean)
  return { titulo: p.tipo_pago, detalle: partes.join(' · ') || limpiar(p.concepto_arca) }
}

export function periodoPago(p: PagoArca): string {
  if (!p.periodo_arca) return '—'
  return p.cuota && !p.periodo_arca.includes('-') ? `${p.periodo_arca} · cuota ${p.cuota}` : p.periodo_arca
}

const FORMULARIOS: Record<string, string> = {
  '931': 'Declaración jurada de cargas sociales (SUSS)', '2002': 'Declaración jurada de IVA', '2083': 'Libro de IVA Digital (créditos y débitos)',
}
export const nombreFormulario = (d: Presentacion) => `F.${d.formulario}${d.version ? ` ${d.version}` : ''} · ${FORMULARIOS[d.formulario] ?? d.nombre}`

// Obligación del calendario que corresponde a cada formulario / VEP (solo los casos verificados con comprobantes reales).
export const obligacionDeFormulario = (f: string): string | null => (f === '931' ? 'f931' : f === '2002' ? 'iva_ddjj' : null)
export const obligacionDePago = (p: PagoArca): { codigo: string; periodo: string } | null =>
  /^SIJPDJ/i.test(p.descripcion_reducida ?? '') && p.periodo_arca && /^\d{4}-\d{2}$/.test(p.periodo_arca) ? { codigo: 'f931', periodo: p.periodo_arca } : null

export function diasDeDiferencia(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000)
}
// «En término» / «3 días tarde» según el vencimiento.
export function enTermino(hecho: string, vence: string | null): { texto: string; tarde: boolean } | null {
  if (!vence) return null
  const d = diasDeDiferencia(vence, hecho)
  return d <= 0 ? { texto: 'En término', tarde: false } : { texto: `${d} día${d === 1 ? '' : 's'} tarde`, tarde: true }
}

// Vencimiento según el calendario del holding (null si todavía no lo cargaron). Se consulta una vez por obligación-período-CUIT.
export async function vencimientos(claves: { obligacion: string; periodo: string; cuit: string }[]): Promise<Record<string, string | null>> {
  const mapa: Record<string, string | null> = {}
  const unicas = [...new Map(claves.map((c) => [`${c.obligacion}|${c.periodo}|${c.cuit}`, c])).values()]
  await Promise.all(unicas.map(async (c) => {
    const { data } = await supabase.rpc('vencimiento_de', { p_obligacion: c.obligacion, p_periodo: c.periodo, p_cuit: c.cuit })
    mapa[`${c.obligacion}|${c.periodo}|${c.cuit}`] = (data as string | null) ?? null
  }))
  return mapa
}
export const claveVenc = (obligacion: string, periodo: string, cuit: string) => `${obligacion}|${periodo}|${cuit}`
