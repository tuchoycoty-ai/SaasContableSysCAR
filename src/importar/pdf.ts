// Lectura de los comprobantes en PDF que baja ARCA: «Comprobante de Pago» de un VEP y «Acuse de recibo de DJ».
// Funciones puras sobre el texto del PDF (se prueban sin navegador). Lo que no se reconoce NO se adivina:
// se devuelve un error y el archivo queda para revisar.
import { parseNumero } from './valores'
import { cuitValido } from '../lib/utiles'

export type ItemTexto = { str: string; transform: number[] }

// Une los fragmentos de texto en renglones (mismo alto, de izquierda a derecha).
export function lineasDeItems(items: ItemTexto[]): string[] {
  const filas: { y: number; partes: { x: number; s: string }[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const x = it.transform[4]
    const y = it.transform[5]
    let f = filas.find((r) => Math.abs(r.y - y) <= 2)
    if (!f) {
      f = { y, partes: [] }
      filas.push(f)
    }
    f.partes.push({ x, s: it.str })
  }
  filas.sort((a, b) => b.y - a.y)
  return filas.map((f) => f.partes.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join(' ').trim()).filter(Boolean)
}

export type Vep = {
  tipo: 'vep'
  cuit: string
  nroVep: string
  consolidado: boolean
  tipoPago: string
  descripcion: string | null // «Descripción reducida», p. ej. SIJPDJ09/26
  periodo: string | null // AAAA-MM
  importe: number
  fechaPago: string // AAAA-MM-DD
  medio: string | null
  nroTransaccion: string | null
}
export type AcuseDj = {
  tipo: 'dj'
  cuit: string
  formulario: string // «931», «2083»…
  nombre: string
  periodo: string | null
  fechaPresentacion: string
  nroTransaccion: string
}
export type LecturaPdf = { ok: true; doc: Vep | AcuseDj } | { ok: false; error: string }

function valor(lineas: string[], etiqueta: string): string | null {
  const e = etiqueta.toLowerCase()
  for (const l of lineas) {
    if (l.toLowerCase().startsWith(e)) {
      const v = l.slice(etiqueta.length).trim()
      return v === '' ? null : v
    }
  }
  return null
}

const fechaIso = (t: string | null): string | null => {
  const m = t?.match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
const periodoIso = (t: string | null): string | null => (t && /^\d{4}-(0[1-9]|1[0-2])$/.test(t.trim()) ? t.trim() : null)

export function interpretarPdf(lineas: string[]): LecturaPdf {
  const txt = lineas.join('\n')
  const esDj = /Acuse de recibo de DJ/i.test(txt)
  const esVep = !esDj && /Comprobante de Pago/i.test(txt) && /Nro\. VEP/i.test(txt)
  if (!esDj && !esVep) return { ok: false, error: 'No parece un comprobante de pago de VEP ni un acuse de DJ de ARCA.' }

  const cuit = (valor(lineas, 'CUIT:') ?? '').replace(/\D/g, '')
  if (cuit.length !== 11 || !cuitValido(cuit)) return { ok: false, error: 'No pude leer un CUIT válido del documento.' }

  if (esDj) {
    const form = valor(lineas, 'Formulario:')
    const fm = form?.match(/^(\d{3,4})\b\s*(?:v\d+)?\s*-?\s*(.*)$/i)
    const fecha = fechaIso(valor(lineas, 'Fecha de Presentación:'))
    const trx = valor(lineas, 'Nro. de Transacción:')?.replace(/\D/g, '') ?? ''
    if (!fm || !fecha || !trx) return { ok: false, error: 'Al acuse le faltan datos (formulario, fecha de presentación o transacción).' }
    return { ok: true, doc: { tipo: 'dj', cuit, formulario: fm[1], nombre: fm[2].trim(), periodo: periodoIso(valor(lineas, 'Período:')), fechaPresentacion: fecha, nroTransaccion: trx } }
  }

  const consolidado = valor(lineas, 'Nro. VEP Consolidado:') !== null
  const nro = (valor(lineas, 'Nro. VEP Consolidado:') ?? valor(lineas, 'Nro. VEP:') ?? '').replace(/\D/g, '')
  const pagado = lineas.find((l) => /^IMPORTE PAGADO/i.test(l))
  if (!pagado) return { ok: false, error: 'El VEP no muestra un importe pagado: solo se leen comprobantes de pagos efectuados.' }
  const importe = parseNumero(pagado.replace(/^IMPORTE PAGADO/i, ''))
  const fecha = fechaIso(valor(lineas, 'Fecha de Pago:'))
  if (!nro || importe === null || importe <= 0 || !fecha) return { ok: false, error: 'Al comprobante le faltan datos (número de VEP, importe o fecha de pago).' }
  return {
    ok: true,
    doc: {
      tipo: 'vep', cuit, nroVep: nro, consolidado, tipoPago: valor(lineas, 'Tipo de Pago:') ?? 'VEP', descripcion: valor(lineas, 'Descripción Reducida:'),
      periodo: periodoIso(valor(lineas, 'Período:')), importe: Math.round(importe * 100) / 100, fechaPago: fecha,
      medio: valor(lineas, 'Medio de Pago:'), nroTransaccion: valor(lineas, 'Nro. de Transacción:')?.replace(/\D/g, '') ?? null,
    },
  }
}

// ---------- Que se hace con cada documento ----------
export type Plan = {
  pago: { fecha: string; concepto: string; impuesto: string; medio: string | null; referencia: string; importe: number } | null
  obligacion: { codigo: string; periodo: string; estado: 'presentada' | 'pagada'; fecha: string; vepNumero?: string; monto?: number; nota: string } | null
  avisos: string[]
}

// Solo se asocian a una obligacion los casos VERIFICADOS con comprobantes reales: F.931 (DJ) y VEP de SICOSS (SIJPDJ).
// Todo lo demas se registra igual como pago, pero sin tocar obligaciones.
export function planDe(doc: Vep | AcuseDj): Plan {
  if (doc.tipo === 'vep') {
    const pago = {
      fecha: doc.fechaPago,
      concepto: `${doc.tipoPago}${doc.descripcion ? ` (${doc.descripcion})` : ''}`.slice(0, 200),
      impuesto: doc.tipoPago.slice(0, 100),
      medio: doc.medio,
      referencia: doc.nroVep,
      importe: doc.importe,
    }
    if (/^SIJPDJ/i.test(doc.descripcion ?? '') && doc.periodo) {
      return {
        pago,
        obligacion: { codigo: 'f931', periodo: doc.periodo, estado: 'pagada', fecha: doc.fechaPago, vepNumero: doc.nroVep, monto: doc.importe, nota: `Pago SICOSS, VEP ${doc.nroVep}` },
        avisos: [],
      }
    }
    return { pago, obligacion: null, avisos: ['Se registra como pago; este tipo de VEP todavía no se asocia a una obligación del cliente.'] }
  }
  if (doc.formulario === '931' && doc.periodo) {
    return { pago: null, obligacion: { codigo: 'f931', periodo: doc.periodo, estado: 'presentada', fecha: doc.fechaPresentacion, nota: `DJ F.931 transacción ${doc.nroTransaccion}` }, avisos: [] }
  }
  return {
    pago: null,
    obligacion: null,
    avisos: [`Formulario ${doc.formulario} (${doc.nombre}) reconocido, pero no se asocia a ninguna obligación. No se guarda nada.`],
  }
}
