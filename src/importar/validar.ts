import { camposDe, type TipoImportacion } from './columnas'
import { parseDocumento, parseEntero, parseFecha, parseNumero, parseTipoComprobante, textoCelda } from './valores'

export type FilaLista = Record<string, string | number | null> & { fila: number }
export type Rechazo = { fila: number; motivo: string }
export type Resultado = {
  validas: FilaLista[]
  rechazos: Rechazo[]
  duplicadasEnArchivo: number[] // numeros de fila repetidos dentro del mismo archivo
}

export const MAX_FILAS = 5000

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
        const bruto = celda(r, id)
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

    const clave = claveFila(tipo, o)
    if (vistas.has(clave)) duplicadasEnArchivo.push(fila)
    vistas.add(clave)
    validas.push(o)
  })
  return { validas, rechazos, duplicadasEnArchivo }
}
