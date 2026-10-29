import { normalizar } from './valores'

export type TipoImportacion = 'comprobantes_emitidos' | 'comprobantes_recibidos' | 'pagos'

export const TIPO_LABEL: Record<TipoImportacion, string> = {
  comprobantes_emitidos: 'Comprobantes emitidos (ventas)',
  comprobantes_recibidos: 'Comprobantes recibidos (compras)',
  pagos: 'Pagos de impuestos',
}

export type Campo = {
  id: string
  etiqueta: string
  obligatorio: boolean
  alias: string[] // ya normalizados (sin tildes, minusculas, sin simbolos)
}

const COMUNES: Campo[] = [
  { id: 'fecha', etiqueta: 'Fecha de emisión', obligatorio: true, alias: ['fechadeemision', 'fechaemision', 'fecha'] },
  { id: 'tipo_cbte', etiqueta: 'Tipo de comprobante', obligatorio: true, alias: ['tipodecomprobante', 'tipocomprobante', 'tipocbte', 'tipo'] },
  { id: 'punto_venta', etiqueta: 'Punto de venta', obligatorio: true, alias: ['puntodeventa', 'puntoventa', 'ptovta', 'pv'] },
  { id: 'numero', etiqueta: 'Número', obligatorio: true, alias: ['numerodesde', 'numerocomprobante', 'numero', 'nrocomprobante', 'nrodesde', 'nro'] },
  { id: 'doc', etiqueta: 'CUIT / documento de la contraparte', obligatorio: false, alias: ['nrodocreceptor', 'nrodocemisor', 'nrodocumento', 'nrodoc', 'cuitcontraparte', 'cuit', 'documento'] },
  { id: 'contraparte', etiqueta: 'Denominación de la contraparte', obligatorio: false, alias: ['denominacionreceptor', 'denominacionemisor', 'denominacion', 'razonsocial', 'contraparte'] },
  { id: 'moneda', etiqueta: 'Moneda', obligatorio: false, alias: ['moneda'] },
  { id: 'tipo_cambio', etiqueta: 'Tipo de cambio', obligatorio: false, alias: ['tipocambio', 'tipodecambio'] },
  { id: 'neto_gravado', etiqueta: 'Neto gravado', obligatorio: false, alias: ['impnetogravadototal', 'impnetogravado', 'netogravado'] },
  { id: 'neto_no_gravado', etiqueta: 'Neto no gravado', obligatorio: false, alias: ['impnetonogravado', 'netonogravado'] },
  { id: 'exento', etiqueta: 'Operaciones exentas', obligatorio: false, alias: ['impopexentas', 'impoperacionesexentas', 'exento', 'exentas'] },
  { id: 'otros_tributos', etiqueta: 'Otros tributos', obligatorio: false, alias: ['otrostributos', 'impotrostributos'] },
  { id: 'iva', etiqueta: 'IVA', obligatorio: false, alias: ['totaliva', 'iva'] },
  { id: 'total', etiqueta: 'Importe total', obligatorio: true, alias: ['imptotal', 'importetotal', 'total'] },
]

const PAGOS: Campo[] = [
  { id: 'fecha', etiqueta: 'Fecha de pago', obligatorio: true, alias: ['fechadepago', 'fechapago', 'fecha'] },
  { id: 'concepto', etiqueta: 'Concepto', obligatorio: true, alias: ['concepto', 'descripcion', 'detalle'] },
  { id: 'importe', etiqueta: 'Importe', obligatorio: true, alias: ['importe', 'monto', 'importepagado'] },
  { id: 'impuesto', etiqueta: 'Impuesto', obligatorio: false, alias: ['impuesto', 'tributo'] },
  { id: 'medio', etiqueta: 'Medio de pago', obligatorio: false, alias: ['mediodepago', 'medio'] },
  { id: 'referencia', etiqueta: 'Referencia (VEP, comprobante)', obligatorio: false, alias: ['referencia', 'nrovep', 'vep', 'nrooperacion', 'comprobante'] },
]

export function camposDe(tipo: TipoImportacion): Campo[] {
  return tipo === 'pagos' ? PAGOS : COMUNES
}

// Busca la fila de encabezados: la primera (entre las 30 primeras) que reconoce al menos 3 campos.
export function encontrarEncabezado(filas: unknown[][], tipo: TipoImportacion): number {
  const campos = camposDe(tipo)
  let mejor = -1
  let mejorPuntaje = 0
  for (let i = 0; i < Math.min(filas.length, 30); i++) {
    const norm = filas[i].map(normalizar)
    const puntaje = campos.filter((c) => c.alias.some((a) => norm.includes(a))).length
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje
      mejor = i
    }
  }
  return mejorPuntaje >= 3 ? mejor : -1
}

// campo -> indice de columna (o -1 si no se encontro). Gana el alias de mayor prioridad.
export function detectarColumnas(encabezado: unknown[], tipo: TipoImportacion): Record<string, number> {
  const norm = encabezado.map(normalizar)
  const mapa: Record<string, number> = {}
  for (const c of camposDe(tipo)) {
    let idx = -1
    for (const a of c.alias) {
      idx = norm.indexOf(a)
      if (idx >= 0) break
    }
    mapa[c.id] = idx
  }
  return mapa
}

export function plantillaCsv(tipo: TipoImportacion): string {
  if (tipo === 'pagos') {
    return 'Fecha de pago;Concepto;Impuesto;Importe;Medio de pago;Referencia\r\n31/10/2026;IVA 09/2026;IVA;15000,50;VEP;123456\r\n'
  }
  return [
    'Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Nro. Doc. Receptor;Denominación Receptor;Moneda;Imp. Neto Gravado;Imp. Neto No Gravado;Imp. Op. Exentas;Otros Tributos;IVA;Imp. Total',
    '10/09/2026;1;1;1;30500010912;Cliente SA;PES;1000,00;0,00;0,00;0,00;210,00;1210,00',
    '',
  ].join('\r\n')
}
