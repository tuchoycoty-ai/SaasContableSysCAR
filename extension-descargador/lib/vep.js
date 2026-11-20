// Funciones puras para la carga de VEP (se prueban sin navegador).

// Minúsculas, sin tildes y con espacios simples: para comparar textos de ARCA sin depender de cómo estén escritos.
export const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

// Importe como se escribe en el campo de ARCA: «125000» o «125000,5» (coma decimal, sin separador de miles).
export function importeParaCampo(n) {
  const v = Math.round(Number(n) * 100) / 100
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')
}

// Importe como lo muestra ARCA en la revisión: «125.000,00».
export function importeVisible(n) {
  const [ent, dec] = (Math.round(Number(n) * 100) / 100).toFixed(2).split('.')
  return `${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

const TIPOS = ['ganancias_anticipo', 'autonomo', 'monotributo', 'otro']

// Valida el plan que baja de SysCAR. Devuelve { ok:true, items } o { ok:false, error }.
export function validarPlan(plan) {
  if (!plan || plan.formato !== 'syscar-vep' || plan.version !== 1 || !Array.isArray(plan.items)) {
    return { ok: false, error: 'Este archivo no es un plan de VEP de SysCAR. Bajalo de SysCAR → Agenda VEP.' }
  }
  if (plan.items.length === 0) return { ok: false, error: 'El plan no tiene ningún VEP.' }
  if (plan.items.length > 200) return { ok: false, error: 'El plan tiene demasiados VEP (máximo 200).' }
  const items = []
  for (const [i, x] of plan.items.entries()) {
    const donde = `VEP ${i + 1}`
    const cuit = String(x.cuit ?? '').replace(/\D/g, '')
    if (cuit.length !== 11) return { ok: false, error: `${donde}: el CUIT no es válido.` }
    if (!TIPOS.includes(x.tipo)) return { ok: false, error: `${donde}: tipo desconocido.` }
    if (!x.grupo || !x.tipoPago) return { ok: false, error: `${donde}: falta el grupo o el tipo de pago de ARCA.` }
    const importe = Number(x.importe)
    if (!(importe > 0) || importe >= 1e12) return { ok: false, error: `${donde}: el importe no es válido.` }
    const anio = Number(x.anio)
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return { ok: false, error: `${donde}: el año no es válido.` }
    const mes = x.mes == null ? null : Number(x.mes)
    if (mes != null && !(Number.isInteger(mes) && mes >= 1 && mes <= 12)) return { ok: false, error: `${donde}: el mes no es válido.` }
    const cuota = x.cuota == null ? null : Number(x.cuota)
    if (cuota != null && !(Number.isInteger(cuota) && cuota >= 1 && cuota <= 99)) return { ok: false, error: `${donde}: la cuota no es válida.` }
    if (x.tipo === 'ganancias_anticipo' && cuota == null) return { ok: false, error: `${donde}: el anticipo necesita número de cuota.` }
    items.push({
      id: String(x.id ?? i), cuit, cliente: String(x.cliente ?? cuit).slice(0, 120), tipo: x.tipo,
      grupo: String(x.grupo).slice(0, 80), tipoPago: String(x.tipoPago).slice(0, 200), anio, mes, cuota, importe, vence: x.vence ?? null,
    })
  }
  return { ok: true, items }
}

export function etiquetaItem(x) {
  const per = x.cuota != null ? `${x.anio} · cuota ${x.cuota}` : x.mes != null ? `${x.anio}-${String(x.mes).padStart(2, '0')}` : String(x.anio)
  return `${x.tipoPago} · ${per}`
}

// Qué valor va en cada campo de «Datos del pago», según la etiqueta que muestra ARCA.
// Devuelve { clase, valor } o null si la etiqueta no se reconoce (en ese caso la carga se detiene: no se adivina).
export function campoParaEtiqueta(etiqueta, x) {
  const e = normalizar(etiqueta)
  if (/establecimiento/.test(e)) return { clase: 'lista', valor: '0' }
  if (/(periodo|per\.?).*(mes)|^mes\b/.test(e) && x.mes != null) return { clase: 'lista', valor: String(x.mes) }
  if (/periodo.*(ano|año)|^ano\b/.test(e)) return { clase: 'lista', valor: String(x.anio) }
  if (/anticipo|cuota/.test(e) && x.cuota != null) return { clase: 'lista', valor: String(x.cuota) }
  return null
}
