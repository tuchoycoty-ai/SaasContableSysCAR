// Pruebas de la logica de importacion (sin navegador ni base de datos).
// Se corren con: npm run test:importar
import assert from 'node:assert/strict'
import { leerCsv } from '../src/importar/csv'
import { parseFecha, parseNumero, parseTipoComprobante, parseDocumento, normalizar } from '../src/importar/valores'
import { detectarColumnas, encontrarEncabezado } from '../src/importar/columnas'
import { validarFilas } from '../src/importar/validar'

let n = 0
function prueba(nombre: string, f: () => void) {
  f()
  n++
  console.log('  ok', nombre)
}

prueba('numeros argentinos', () => {
  assert.equal(parseNumero('1.234,56'), 1234.56)
  assert.equal(parseNumero('1234,56'), 1234.56)
  assert.equal(parseNumero('1,234.56'), 1234.56)
  assert.equal(parseNumero('$ 1.234.567,89'), 1234567.89)
  assert.equal(parseNumero('-100,5'), -100.5)
  assert.equal(parseNumero('(100,00)'), -100)
  assert.equal(parseNumero('1.234'), 1234)
  assert.equal(parseNumero('12.5'), 12.5)
  assert.equal(parseNumero(42), 42)
  assert.equal(parseNumero(''), null)
  assert.equal(parseNumero('abc'), null)
  assert.equal(parseNumero('1,2,3'), null)
})

prueba('fechas', () => {
  assert.equal(parseFecha('31/12/2026'), '2026-12-31')
  assert.equal(parseFecha('1/2/26'), '2026-02-01')
  assert.equal(parseFecha('2026-09-10'), '2026-09-10')
  assert.equal(parseFecha('20260910'), '2026-09-10')
  assert.equal(parseFecha('10/09/2026 14:30:00'), '2026-09-10')
  assert.equal(parseFecha('31/02/2026'), null)
  assert.equal(parseFecha('32/01/2026'), null)
  assert.equal(parseFecha('hola'), null)
  assert.equal(parseFecha(46275), '2026-09-10') // numero de serie de Excel
  assert.equal(parseFecha(new Date(Date.UTC(2026, 8, 10))), '2026-09-10')
})

prueba('tipo de comprobante y documento', () => {
  assert.equal(parseTipoComprobante('1 - Factura A'), 1)
  assert.equal(parseTipoComprobante('011'), 11)
  assert.equal(parseTipoComprobante('Nota de Crédito B'), 8)
  assert.equal(parseTipoComprobante('algo raro'), null)
  assert.equal(parseDocumento('30-50001091-2'), '30500010912')
  assert.equal(parseDocumento(20111111112), '20111111112')
  assert.equal(parseDocumento(''), null)
  assert.equal(normalizar('Imp. Neto Gravado'), 'impnetogravado')
  assert.equal(normalizar('Número Desde'), 'numerodesde')
})

prueba('lector CSV: separador, comillas, BOM', () => {
  const t = '﻿a;b;c\r\n1;"x;y";3\r\n"con ""comillas""";2;\r\n\r\n'
  const f = leerCsv(t)
  assert.deepEqual(f, [['a', 'b', 'c'], ['1', 'x;y', '3'], ['con "comillas"', '2', '']])
  assert.deepEqual(leerCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(leerCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']])
})

const ENC = [
  'Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización',
  'Tipo Doc. Receptor', 'Nro. Doc. Receptor', 'Denominación Receptor', 'Tipo Cambio', 'Moneda',
  'Imp. Neto Gravado', 'Imp. Neto No Gravado', 'Imp. Op. Exentas', 'Otros Tributos', 'IVA', 'Imp. Total',
]

prueba('detecta columnas del export de ARCA y el encabezado con filas previas', () => {
  const filas: unknown[][] = [['Mis Comprobantes - Emitidos'], [], ENC, ['10/09/2026']]
  assert.equal(encontrarEncabezado(filas, 'comprobantes_emitidos'), 2)
  const m = detectarColumnas(ENC, 'comprobantes_emitidos')
  assert.equal(m.fecha, 0)
  assert.equal(m.tipo_cbte, 1)
  assert.equal(m.punto_venta, 2)
  assert.equal(m.numero, 3)
  assert.equal(m.doc, 7)
  assert.equal(m.contraparte, 8)
  assert.equal(m.moneda, 10)
  assert.equal(m.neto_gravado, 11)
  assert.equal(m.iva, 15)
  assert.equal(m.total, 16)
  assert.equal(encontrarEncabezado([['hola', 'mundo']], 'pagos'), -1)
})

prueba('valida comprobantes: buenas, rechazadas y duplicadas en el archivo', () => {
  const m = detectarColumnas(ENC, 'comprobantes_emitidos')
  const f = (fecha: string, tipo: string, pv: string, nro: string, total: string, neto = '100,00', iva = '21,00'): unknown[] =>
    [fecha, tipo, pv, nro, nro, '123', '80', '30500010912', 'Cliente SA', '1', 'PES', neto, '0', '0', '0', iva, total]
  const datos = [
    f('10/09/2026', '1 - Factura A', '1', '1', '121,00'),
    f('11/09/2026', '1 - Factura A', '1', '1', '121,00'), // duplicada
    f('31/02/2026', '1', '1', '2', '121'), // fecha mala
    f('12/09/2026', '1', '0', '3', '121'), // pv invalido
    f('13/09/2026', '1', '1', '4', 'mucho'), // importe malo
    f('14/09/2026', 'zzz', '1', '5', '121'), // tipo malo
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], // vacia: se ignora
    f('15/09/2026', '3', '1', '6', '1.000,50', '826,45', '174,05'),
  ]
  const r = validarFilas('comprobantes_emitidos', datos, m, 2, '2026-10-29')
  assert.equal(r.validas.length, 3)
  assert.deepEqual(r.rechazos.map((x) => x.fila), [4, 5, 6, 7])
  assert.deepEqual(r.duplicadasEnArchivo, [3])
  assert.equal(r.validas[2].total, 1000.5)
  assert.equal(r.validas[2].tipo_cbte, 3)
  assert.equal(r.validas[0].doc, '30500010912')
})

prueba('valida pagos', () => {
  const enc = ['Fecha de pago', 'Concepto', 'Impuesto', 'Importe', 'Medio de pago', 'Referencia']
  const m = detectarColumnas(enc, 'pagos')
  const r = validarFilas('pagos', [
    ['31/10/2026', 'IVA 09/2026', 'IVA', '15.000,50', 'VEP', '123'],
    ['31/10/2026', 'IVA 09/2026', 'IVA', '15000,50', 'VEP', '123'], // duplicada
    ['01/11/2026', 'Autónomos', '', '0', '', ''], // importe cero
    ['01/11/2026', '', '', '10', '', ''], // sin concepto
    ['2031-01-01', 'Futuro', '', '10', '', ''], // fecha muy lejana
  ], m, 2, '2026-10-29')
  assert.equal(r.validas.length, 2)
  assert.equal(r.validas[0].importe, 15000.5)
  assert.deepEqual(r.duplicadasEnArchivo, [3])
  assert.equal(r.rechazos.length, 3)
})

prueba('en recibidos el emisor distingue comprobantes con el mismo numero', () => {
  const m = detectarColumnas(ENC, 'comprobantes_recibidos')
  const mk = (doc: string): unknown[] => ['10/09/2026', '1', '1', '1', '1', '', '80', doc, 'X', '1', 'PES', '100', '0', '0', '0', '21', '121']
  const r = validarFilas('comprobantes_recibidos', [mk('30500010912'), mk('20111111112')], m, 2, '2026-10-29')
  assert.equal(r.duplicadasEnArchivo.length, 0)
  const e = validarFilas('comprobantes_emitidos', [mk('30500010912'), mk('20111111112')], m, 2, '2026-10-29')
  assert.equal(e.duplicadasEnArchivo.length, 1)
})

prueba('recibidos reales: factura C sin desglose y neto solo en la columna IVA 0%', () => {
  const enc = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización',
    'Tipo Doc. Emisor', 'Nro. Doc. Emisor', 'Denominación Emisor', 'Tipo Cambio', 'Moneda',
    'Imp. Neto Gravado IVA 0%', 'IVA 2,5%', 'Imp. Neto Gravado IVA 2,5%', 'IVA 5%', 'Imp. Neto Gravado IVA 5%', 'IVA 10,5%',
    'Imp. Neto Gravado IVA 10,5%', 'IVA 21%', 'Imp. Neto Gravado IVA 21%', 'IVA 27%', 'Imp. Neto Gravado IVA 27%',
    'Imp. Neto Gravado Total', 'Imp. Neto No Gravado', 'Imp. Op. Exentas', 'Otros Tributos', 'Total IVA', 'Imp. Total']
  const m = detectarColumnas(enc, 'comprobantes_recibidos')
  assert.equal(m.doc, 7)
  assert.equal(m.contraparte, 8)
  assert.equal(m.neto_gravado, 22)
  assert.equal(m.iva, 26)
  assert.equal(m.total, 27)
  const alic = enc.map((h, i) => (normalizar(h).startsWith('impnetogravadoiva') ? i : -1)).filter((i) => i >= 0)
  const vacia = (): string[] => enc.map(() => '')
  const c = vacia(); Object.assign(c, { 0: '1/9/2026', 1: '11', 2: '2', 3: '365', 7: '20202350640', 8: 'DEPETRIS', 22: '0', 23: '0', 24: '0', 25: '0', 26: '0', 27: '142000' })
  const d = vacia(); Object.assign(d, { 0: '3/9/2026', 1: '2', 2: '71', 3: '388033', 7: '30547000001', 11: '16500', 22: '', 23: '0', 24: '0', 25: '0', 26: '0', 27: '16500' })
  const a = vacia(); Object.assign(a, { 0: '2/9/2026', 1: '1', 2: '5541', 3: '6019', 7: '30507000001', 18: '4364,88', 19: '20785,12', 22: '20785,12', 23: '0', 24: '0', 25: '935,33', 26: '4364,88', 27: '26085,33' })
  const r = validarFilas('comprobantes_recibidos', [c, d, a], m, 2, '2026-10-29', alic)
  assert.equal(r.rechazos.length, 0)
  assert.equal(r.validas[0].neto_no_gravado, 142000) // factura C: todo el total es costo sin IVA
  assert.equal(r.validas[1].neto_gravado, 16500) // neto tomado de la columna IVA 0%
  assert.equal(r.validas[2].neto_no_gravado, 0) // factura A normal: no se toca
  assert.equal(r.validas[2].iva, 4364.88)
})

console.log(`\n${n} grupos de pruebas OK`)
