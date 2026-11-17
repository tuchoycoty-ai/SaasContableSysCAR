import { ALICUOTAS, camposDe, type TipoImportacion } from './columnas'
import { parseDocumento, parseEntero, parseFecha, parseNumero, parseTipoComprobante, textoCelda } from './valores'

export type FilaLista = Record<string, string | number | null> & { fila: number }
export type Rechazo = { fila: number; motivo: string }
export type Resultado = {
  validas: FilaLista[]
  rechazos: Rechazo[]
  duplicadasEnArchivo: number[] // numeros de fila repetidos dentro del mismo archivo
}

export const MAX_FILAS = 5000

// Facturas, notas de debito/credito y recibos "C" (y FCE C): no discriminan IVA, todo el importe es costo sin credito fiscal.
const TIPOS_SIN_IVA = new Set([11, 12, 13, 15, 211, 212, 213])

const IMPORTES = ['neto_gravado', 'neto_no_gravado', 'exento', 'otros_tributos', 'iva', 'total'] as const

export function claveFila(tipo: TipoImportacion, f: FilaLista): string {
  if (tipo === 'pagos') {
    return [f.fecha, f.importe, String(f.concepto ?? '').toLowerCase(), f.referencia ?? ''].join('|')
  }
  const doc = tipo === 'comprobantes_recibidos' ? (f.doc ?? '') : ''
  return [f.tipo_cbte, f.punto_venta, f.numero, doc].join('|')
}

// filas: todas las filas de datos (despues del encabezado). primeraFila = numero de fila de la primera.
export function validarFilas(
  tipo: TipoImportacion,
  filas: unknown[][],
  mapa: Record<string, number>,
  primeraFila: number,
  hoy: string,
  alicuotas: number[] = [], // columnas "Imp. Neto Gravado IVA x%": se usan si "Neto Gravado Total" viene vacio
  porAlicuota: Record<string, number> = {}, // neto_21, iva_21, ... -> columna (desglose para el libro de IVA)
): Resultado {
  const campos = camposDe(tipo)
  const validas: FilaLista[] = []
  const rechazos: Rechazo[] = []
  const duplicadasEnArchivo: number[] = []
  const vistas = new Set<string>()
  const limiteFecha = `${Number(hoy.slice(0, 4)) + 1}${hoy.slice(4)}`

  const celda = (r: unknown[], id: string): unknown => (mapa[id] >= 0 ? r[mapa[id]] : undefined)

  filas.forEach((r, i) => {
    const fila = primeraFila + i
    if (r.every((c) => textoCelda(c) === '')) return
    const o: FilaLista = { fila }
    const faltan: string[] = []
    for (const c of campos) {
      if (c.obligatorio && textoCelda(celda(r, c.id)) === '') faltan.push(c.etiqueta)
    }
    if (faltan.length > 0) return void rechazos.push({ fila, motivo: `Falta: ${faltan.join(', ')}` })

    const fecha = parseFecha(celda(r, 'fecha'))
    if (!fecha) return void rechazos.push({ fila, motivo: 'La fecha no se entiende (usá dd/mm/aaaa)' })
    if (fecha < '2000-01-01' || fecha > limiteFecha) return void rechazos.push({ fila, motivo: 'Fecha fuera de rango' })
    o.fecha = fecha

    if (tipo === 'pagos') {
      const importe = parseNumero(celda(r, 'importe'))
      if (importe === null || importe <= 0) return void rechazos.push({ fila, motivo: 'El importe debe ser un número mayor a cero' })
      o.importe = Math.round(importe * 100) / 100
      o.concepto = textoCelda(celda(r, 'concepto')).slice(0, 200)
      for (const id of ['impuesto', 'medio', 'referencia']) {
        const t = textoCelda(celda(r, id))
        o[id] = t === '' ? null : t.slice(0, 100)
      }
    } else {
      const tc = parseTipoComprobante(celda(r, 'tipo_cbte'))
      if (tc === null || tc < 1 || tc > 999) return void rechazos.push({ fila, motivo: 'El tipo de comprobante no se reconoce' })
      const pv = parseEntero(celda(r, 'punto_venta'))
      if (pv === null || pv < 1 || pv > 99999) return void rechazos.push({ fila, motivo: 'Punto de venta inválido' })
      const nro = parseEntero(celda(r, 'numero'))
      if (nro === null || nro < 1) return void rechazos.push({ fila, motivo: 'Número de comprobante inválido' })
      o.tipo_cbte = tc
      o.punto_venta = pv
      o.numero = nro
      o.doc = parseDocumento(celda(r, 'doc'))
      const nom = textoCelda(celda(r, 'contraparte'))
      o.contraparte = nom === '' ? null : nom.slice(0, 200)
      const mon = textoCelda(celda(r, 'moneda'))
      o.moneda = mon === '' ? 'PES' : mon.toUpperCase().slice(0, 5)
      const cambio = parseNumero(celda(r, 'tipo_cambio'))
      o.tipo_cambio = cambio
      for (const id of IMPORTES) {
        let bruto = celda(r, id)
        if (id === 'neto_gravado' && textoCelda(bruto) === '' && alicuotas.length > 0) {
          const partes = alicuotas.map((i) => parseNumero(r[i])).filter((x): x is number => x !== null)
          if (partes.length > 0) bruto = partes.reduce((a, b) => a + b, 0)
        }
        if (textoCelda(bruto) === '') {
          if (id === 'total') return void rechazos.push({ fila, motivo: 'Falta el importe total' })
          o[id] = 0
          continue
        }
        const n = parseNumero(bruto)
        if (n === null) return void rechazos.push({ fila, motivo: `El importe "${textoCelda(bruto)}" no es un número válido` })
        o[id] = Math.round(n * 100) / 100
      }
    }

    if (tipo !== 'pagos') {
      const claves = ['neto_0', ...ALICUOTAS.flatMap((a) => [`neto_${a}`, `iva_${a}`])]
      for (const k of claves) {
        const n = k in porAlicuota ? parseNumero(r[porAlicuota[k]]) : null
        o[k] = n === null ? 0 : Math.round(n * 100) / 100
      }
      // Sin columnas por alicuota (planilla propia): si el IVA coincide con una sola alicuota, se deduce.
      if (Object.keys(porAlicuota).length === 0 && Math.abs(Number(o.neto_gravado)) >= 10) {
        const ng = Number(o.neto_gravado), iva = Number(o.iva)
        const ok = [21, 10.5, 27, 5, 2.5, 0].find((t) => Math.abs(iva - Math.round(ng * t) / 100) <= 0.05)
        if (ok !== undefined) {
          const id = String(ok).replace('.', '_')
          o[`neto_${id}`] = ng
          if (ok !== 0) o[`iva_${id}`] = iva
        }
      }
    }

    if (tipo !== 'pagos' && TIPOS_SIN_IVA.has(Number(o.tipo_cbte))) {
      const desglose = ['neto_gravado', 'neto_no_gravado', 'exento', 'otros_tributos', 'iva'].reduce((a, id) => a + Math.abs(Number(o[id])), 0)
      if (desglose === 0 && Number(o.total) !== 0) o.neto_no_gravado = o.total
    }

    const clave = claveFila(tipo, o)
    if (vistas.has(clave)) duplicadasEnArchivo.push(fila)
    vistas.add(clave)
    validas.push(o)
  })
  return { validas, rechazos, duplicadasEnArchivo }
}
