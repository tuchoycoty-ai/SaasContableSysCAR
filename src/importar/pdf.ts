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
  subDe: string | null // si es un subVEP: número del VEP Consolidado al que pertenece
  hora: string | null // hh:mm:ss del pago
  concepto: string | null // «191 ANTICIPOS», «19 OBLIGACION MENSUAL/ANUAL»…
  subconcepto: string | null // «94 INTERESES PUNITORIOS», «191 ANTICIPOS»…
  periodoTxt: string | null // período tal como figura: «2026-09» o «2026» (anual)
  cuota: string | null // anticipo / cuota
  naturaleza: Naturaleza
  intereses: number // parte del importe que son intereses
  detalle: ItemVep[] // desglose por impuesto o concepto
  entidad: string | null
  banco: string | null
  vence: string | null // solo algunos VEP lo informan (p. ej. honorarios)
  generadoDesde: string | null // nro. de la DJ de la que sale el VEP
}
export type Naturaleza = 'capital' | 'intereses' | 'multa' | 'honorarios'
export type ItemVep = { nombre: string; codigo: string | null; importe: number }
export type AcuseDj = {
  tipo: 'dj'
  cuit: string
  formulario: string // «931», «2083»…
  nombre: string
  version: string | null
  impuesto: string | null
  concepto: string | null
  subconcepto: string | null
  periodo: string | null
  periodoTxt: string | null
  fechaPresentacion: string
  hora: string | null
  nroTransaccion: string
  verificador: string | null
  registros: number | null
  presentadaPor: string | null
  codigoBarras: string | null
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

// Como «valor», pero une los renglones siguientes cuando ARCA parte un dato largo en dos líneas
// («Tipo de Pago: Honorarios … -» / «Repres. del Fisco»). Se corta en el primer renglón con «:» o con un importe.
function valorLargo(lineas: string[], etiqueta: string): string | null {
  const e = etiqueta.toLowerCase()
  const i = lineas.findIndex((l) => l.toLowerCase().startsWith(e))
  if (i < 0) return null
  let v = lineas[i].slice(etiqueta.length).trim()
  for (let j = i + 1; j < lineas.length && j <= i + 2; j++) {
    const l = lineas[j]
    if (l.includes(':') || /\$\s?[\d.,]+/.test(l) || /^\(\d+\)$/.test(l) || l.length > 45) break
    v = `${v} ${l}`.trim()
  }
  return v === '' ? null : v
}
const horaDe = (t: string | null): string | null => t?.match(/Hora:\s*(\d{2}:\d{2}:\d{2})/)?.[1] ?? null
const dinero = (t: string): number | null => parseNumero(t)

// Renglones «NOMBRE (código)   $importe» del VEP; el código a veces cae en el renglón de abajo («(352)» o «FISCO (49)»).
function detalleDe(lineas: string[]): ItemVep[] {
  const fin = lineas.findIndex((l) => /^Datos del comprobante de Pago/i.test(l))
  const zona = fin >= 0 ? lineas.slice(0, fin) : lineas
  const items: ItemVep[] = []
  for (let i = 0; i < zona.length; i++) {
    const m = zona[i].match(/^(.*?)\s+\$\s?(\d[\d.]*,\d{2})$/)
    if (!m || /:/.test(m[1])) continue
    let nombre = m[1].trim()
    let codigo: string | null = null
    const conCodigo = nombre.match(/^(.*?)\s*\((\d+)\)$/)
    if (conCodigo) { nombre = conCodigo[1].trim(); codigo = conCodigo[2] }
    else {
      const sig = zona[i + 1]?.match(/^(.*?)\s*\((\d+)\)$/)
      if (sig && !/\$/.test(zona[i + 1])) { nombre = `${nombre} ${sig[1]}`.trim(); codigo = sig[2] }
    }
    const importe = dinero(m[2])
    if (importe !== null) items.push({ nombre, codigo, importe: Math.round(importe * 100) / 100 })
  }
  return items
}

// Qué es lo que se pagó: capital, intereses (resarcitorios o punitorios), multa u honorarios. Lo dudoso queda como capital.
export function naturalezaDe(concepto: string | null, subconcepto: string | null, tipoPago: string, detalle: ItemVep[]): Naturaleza {
  const base = `${subconcepto ?? ''} ${concepto ?? ''}`
  if (/honorario/i.test(tipoPago)) return 'honorarios'
  if (/interes/i.test(base)) return 'intereses'
  if (/multa/i.test(base)) return 'multa'
  if (detalle.length > 0 && detalle.every((d) => /interes/i.test(d.nombre))) return 'intereses'
  if (detalle.length > 0 && detalle.every((d) => /multa/i.test(d.nombre))) return 'multa'
  return 'capital'
}

const fechaIso = (t: string | null): string | null => {
  const m = t?.match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
const periodoIso = (t: string | null): string | null => (t && /^\d{4}-(0[1-9]|1[0-2])$/.test(t.trim()) ? t.trim() : null)

export function interpretarPdf(lineas: string[]): LecturaPdf {
  const txt = lineas.join('\n')
  const esDj = /Acuse de recibo de DJ/i.test(txt)
  const esVep = !esDj && /Comprobante de Pago/i.test(txt) && /Nro\. (sub)?VEP/i.test(txt)
  if (!esDj && !esVep) return { ok: false, error: 'No parece un comprobante de pago de VEP ni un acuse de DJ de ARCA.' }

  const cuit = (valor(lineas, 'CUIT:') ?? '').replace(/\D/g, '')
  if (cuit.length !== 11 || !cuitValido(cuit)) return { ok: false, error: 'No pude leer un CUIT válido del documento.' }

  if (esDj) {
    const form = valorLargo(lineas, 'Formulario:')
    const fm = form?.match(/^(\d{3,4})\b\s*(?:(v\d+))?\s*-?\s*(.*)$/i)
    const fecha = fechaIso(valor(lineas, 'Fecha de Presentación:'))
    const trx = valor(lineas, 'Nro. de Transacción:')?.replace(/\D/g, '') ?? ''
    if (!fm || !fecha || !trx) return { ok: false, error: 'Al acuse le faltan datos (formulario, fecha de presentación o transacción).' }
    const iBarras = lineas.findIndex((l) => /^C[oó]digo de barras/i.test(l))
    const barras = iBarras >= 0 ? (lineas[iBarras + 1]?.match(/^\d{10,60}$/)?.[0] ?? null) : null
    const regs = valor(lineas, 'Cantidad de registros:')?.replace(/\D/g, '')
    return {
      ok: true,
      doc: {
        tipo: 'dj', cuit, formulario: fm[1], version: fm[2] ?? null, nombre: fm[3].trim(), impuesto: valorLargo(lineas, 'Impuesto:'),
        concepto: valorLargo(lineas, 'Concepto:'), subconcepto: valorLargo(lineas, 'Subconcepto:'),
        periodo: periodoIso(valor(lineas, 'Período:')), periodoTxt: valor(lineas, 'Período:'),
        fechaPresentacion: fecha, hora: horaDe(valor(lineas, 'Fecha de Presentación:')), nroTransaccion: trx,
        verificador: valor(lineas, 'Nro. verificador:')?.replace(/\D/g, '') || null, registros: regs ? Number(regs) : null,
        presentadaPor: valor(lineas, 'Presentada por el Usuario:')?.replace(/\D/g, '') || null, codigoBarras: barras,
      },
    }
  }

  const consolidado = valor(lineas, 'Nro. VEP Consolidado:') !== null
  const nro = (valor(lineas, 'Nro. VEP Consolidado:') ?? valor(lineas, 'Nro. VEP:') ?? valor(lineas, 'Nro. subVEP:') ?? '').replace(/\D/g, '')
  const pagado = lineas.find((l) => /^IMPORTE PAGADO/i.test(l))
  if (!pagado) return { ok: false, error: 'El VEP no muestra un importe pagado: solo se leen comprobantes de pagos efectuados.' }
  const importe = parseNumero(pagado.replace(/^IMPORTE PAGADO/i, ''))
  const fecha = fechaIso(valor(lineas, 'Fecha de Pago:'))
  if (!nro || importe === null || importe <= 0 || !fecha) return { ok: false, error: 'Al comprobante le faltan datos (número de VEP, importe o fecha de pago).' }
  const importeOk = Math.round(importe * 100) / 100
  const tipoPago = valorLargo(lineas, 'Tipo de Pago:') ?? 'VEP'
  const concepto = valor(lineas, 'Concepto:')
  const subconcepto = valor(lineas, 'Subconcepto:')
  const detalle = detalleDe(lineas)
  const naturaleza = naturalezaDe(concepto, subconcepto, tipoPago, detalle)
  // Intereses incluidos: todo el pago si es de intereses; en honorarios, el campo «INTERESES»; si no, los renglones de intereses del desglose.
  let intereses = 0
  if (naturaleza === 'intereses') intereses = importeOk
  else if (naturaleza === 'honorarios') intereses = Math.min(importeOk, Math.max(0, Number(valor(lineas, 'INTERESES:') ?? 0) || 0))
  else intereses = Math.min(importeOk, Math.round(detalle.filter((d) => /interes/i.test(d.nombre)).reduce((a, d) => a + d.importe, 0) * 100) / 100)
  const cuotaTxt = valor(lineas, 'ANTICIPO/CUOTA:') ?? valor(lineas, 'CUOTA NRO.:')
  const generado = txt.match(/Generado desde la presentaci[oó]n de DJ\s+(\d+)/i)?.[1] ?? null
  return {
    ok: true,
    doc: {
      tipo: 'vep', cuit, nroVep: nro, consolidado, tipoPago, descripcion: valor(lineas, 'Descripción Reducida:'),
      periodo: periodoIso(valor(lineas, 'Período:')), importe: importeOk, fechaPago: fecha,
      subDe: valor(lineas, 'Corresponde al VEP Consolidado:')?.replace(/\D/g, '') || null,
      medio: valorLargo(lineas, 'Medio de Pago:'), nroTransaccion: valor(lineas, 'Nro. de Transacción:')?.replace(/\D/g, '') ?? null,
      hora: horaDe(valor(lineas, 'Fecha de Pago:')), concepto, subconcepto, periodoTxt: valor(lineas, 'Período:') ?? valor(lineas, 'PERIODO DE LA BOLETA:'),
      cuota: cuotaTxt && cuotaTxt !== '0' ? cuotaTxt : null, naturaleza, intereses, detalle,
      entidad: valor(lineas, 'Entidad de Pago:'), banco: valorLargo(lineas, 'Debito en cuenta del Banco:'),
      vence: fechaIso(valor(lineas, 'FECHA VTO. HONORARIO:')), generadoDesde: generado,
    },
  }
}

// ---------- Que se hace con cada documento ----------
export type PagoPlan = {
  fecha: string; concepto: string; impuesto: string; medio: string | null; referencia: string; importe: number
  // detalle (opcional: los PDF leídos antes de esta mejora no lo tienen)
  tipo_pago?: string; descripcion_reducida?: string | null; concepto_arca?: string | null; subconcepto_arca?: string | null; periodo_arca?: string | null
  cuota?: string | null; naturaleza?: Naturaleza; intereses?: number; detalle?: ItemVep[]; nro_transaccion?: string | null; hora_pago?: string | null
  entidad_pago?: string | null; banco?: string | null; vence?: string | null; dj_nro?: string | null; vep_consolidado?: string | null; es_consolidado?: boolean
}
export type PresentacionPlan = {
  formulario: string; version: string | null; nombre: string; impuesto: string | null; concepto: string | null; subconcepto: string | null
  periodo: string | null; fecha: string; hora: string | null; nro_transaccion: string; nro_verificador: string | null
  registros: number | null; presentada_por: string | null; codigo_barras: string | null
}
export type Plan = {
  pago: PagoPlan | null
  presentacion?: PresentacionPlan | null
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
      tipo_pago: doc.tipoPago, descripcion_reducida: doc.descripcion, concepto_arca: doc.concepto, subconcepto_arca: doc.subconcepto,
      periodo_arca: doc.periodoTxt, cuota: doc.cuota, naturaleza: doc.naturaleza, intereses: doc.intereses, detalle: doc.detalle,
      nro_transaccion: doc.nroTransaccion, hora_pago: doc.hora, entidad_pago: doc.entidad, banco: doc.banco, vence: doc.vence,
      dj_nro: doc.generadoDesde, vep_consolidado: doc.subDe, es_consolidado: doc.consolidado,
    }
    if (/^SIJPDJ/i.test(doc.descripcion ?? '') && doc.periodo) {
      return {
        pago,
        obligacion: { codigo: 'f931', periodo: doc.periodo, estado: 'pagada', fecha: doc.fechaPago, vepNumero: doc.nroVep, monto: doc.importe, nota: `Pago SICOSS, VEP ${doc.nroVep}` },
        avisos: [],
      }
    }
    return { pago, obligacion: null, avisos: ['Se registra como pago; este tipo de VEP todavía no se asocia a una obligación del cliente.', ...(doc.subDe ? [`Es un subVEP del VEP Consolidado ${doc.subDe}: si también cargás ese consolidado, el pago se contaría dos veces.`] : [])] }
  }
  const presentacion: PresentacionPlan = {
    formulario: doc.formulario, version: doc.version, nombre: doc.nombre, impuesto: doc.impuesto, concepto: doc.concepto, subconcepto: doc.subconcepto,
    periodo: doc.periodoTxt && /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(doc.periodoTxt.trim()) ? doc.periodoTxt.trim() : null, fecha: doc.fechaPresentacion, hora: doc.hora,
    nro_transaccion: doc.nroTransaccion, nro_verificador: doc.verificador, registros: doc.registros, presentada_por: doc.presentadaPor, codigo_barras: doc.codigoBarras,
  }
  if (doc.formulario === '931' && doc.periodo) {
    return { pago: null, obligacion: { codigo: 'f931', periodo: doc.periodo, estado: 'presentada', fecha: doc.fechaPresentacion, nota: `DJ F.931 transacción ${doc.nroTransaccion}` }, presentacion, avisos: [] }
  }
  if (doc.formulario === '2002' && doc.periodo) {
    return { pago: null, obligacion: { codigo: 'iva_ddjj', periodo: doc.periodo, estado: 'presentada', fecha: doc.fechaPresentacion, nota: `DJ IVA F.2002 transacción ${doc.nroTransaccion}` }, presentacion, avisos: [] }
  }
  return {
    pago: null,
    obligacion: null,
    presentacion,
    avisos: [`Formulario ${doc.formulario} (${doc.nombre}) reconocido: se registra como presentada, pero no se asocia a ninguna obligación del cliente.`],
  }
}
