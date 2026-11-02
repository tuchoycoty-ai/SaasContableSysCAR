import assert from 'node:assert/strict'
import { mesAnterior, rangosDe, nombreArchivo, construirCola, textoAMes } from '../lib/fechas.js'
let n = 0
const prueba = (t, f) => { f(); n++; console.log('  ok', t) }

prueba('mes anterior (incluye enero)', () => {
  assert.deepEqual(mesAnterior(new Date(2026, 10, 2)), { a: 2026, m: 10 })
  assert.deepEqual(mesAnterior(new Date(2027, 0, 15)), { a: 2026, m: 12 })
})
const hoy = new Date(2026, 10, 2) // 2/11/2026
prueba('un mes: 1 al último día', () => {
  const m = { a: 2026, m: 10 }
  assert.deepEqual(rangosDe({ desde: m, hasta: m, unoPorMes: true, hoy }).rangos, [{ desde: '01/10/2026', hasta: '31/10/2026', etiqueta: '2026-10' }])
  const f = { a: 2028, m: 2 }
  assert.equal(rangosDe({ desde: f, hasta: f, unoPorMes: true, hoy: new Date(2029, 0, 5) }).rangos[0].hasta, '29/02/2028') // bisiesto
})
prueba('varios meses: uno por mes o un solo rango', () => {
  const a = { a: 2026, m: 8 }, b = { a: 2026, m: 10 }
  const x = rangosDe({ desde: a, hasta: b, unoPorMes: true, hoy }).rangos
  assert.deepEqual(x.map((r) => r.etiqueta), ['2026-08', '2026-09', '2026-10'])
  assert.deepEqual(x.map((r) => r.hasta), ['31/08/2026', '30/09/2026', '31/10/2026'])
  const y = rangosDe({ desde: a, hasta: b, unoPorMes: false, hoy }).rangos
  assert.deepEqual(y, [{ desde: '01/08/2026', hasta: '31/10/2026', etiqueta: '2026-08_2026-10' }])
})
prueba('cruza de año', () => {
  const r = rangosDe({ desde: { a: 2025, m: 11 }, hasta: { a: 2026, m: 2 }, unoPorMes: true, hoy }).rangos
  assert.deepEqual(r.map((x) => x.etiqueta), ['2025-11', '2025-12', '2026-01', '2026-02'])
})
prueba('el mes en curso se recorta a ayer y los meses futuros se descartan', () => {
  const r = rangosDe({ desde: { a: 2026, m: 10 }, hasta: { a: 2026, m: 12 }, unoPorMes: true, hoy }).rangos
  assert.deepEqual(r.map((x) => [x.etiqueta, x.hasta]), [['2026-10', '31/10/2026'], ['2026-11', '01/11/2026']])
  assert.ok(rangosDe({ desde: { a: 2026, m: 11 }, hasta: { a: 2026, m: 11 }, unoPorMes: true, hoy: new Date(2026, 10, 1) }).error) // 1/11: no hay datos de noviembre todavía
})
prueba('validaciones: orden, 12 meses, 365 días', () => {
  assert.ok(rangosDe({ desde: { a: 2026, m: 10 }, hasta: { a: 2026, m: 8 }, unoPorMes: true, hoy }).error)
  assert.ok(rangosDe({ desde: { a: 2025, m: 1 }, hasta: { a: 2026, m: 1 }, unoPorMes: true, hoy }).error) // 13 meses
  assert.ok(rangosDe({ desde: { a: 2023, m: 1 }, hasta: { a: 2023, m: 12 }, unoPorMes: false, hoy: new Date(2026, 0, 1) }).rangos) // 365 días justos
  assert.ok(rangosDe({ desde: { a: 2024, m: 1 }, hasta: { a: 2024, m: 12 }, unoPorMes: false, hoy: new Date(2026, 0, 1) }).error) // 2024 bisiesto = 366
  assert.ok(rangosDe({ desde: null, hasta: null, unoPorMes: true, hoy }).error)
  assert.equal(textoAMes('2026-13'), null)
})
prueba('nombre de archivo con el CUIT de 11 dígitos y sin otros números largos', () => {
  const f = nombreArchivo('Recibidos', '30717200116', '2026-10')
  assert.equal(f, 'SysCAR/Recibidos/Mis_Comprobantes_Recibidos_-_CUIT_30717200116_2026-10.xlsx')
  assert.deepEqual(f.match(/\d{11}/g), ['30717200116'])
  assert.throws(() => nombreArchivo('Emitidos', '123', 'x'))
})
prueba('cola: cliente -> tipo -> período', () => {
  const c = construirCola([{ id: '0', nombre: 'A', cuit: '30717200116' }, { id: '2', nombre: 'B', cuit: '30500010912' }], ['Emitidos', 'Recibidos'], [{ desde: 'd', hasta: 'h', etiqueta: 'e' }])
  assert.deepEqual(c.map((t) => `${t.persona}-${t.tipo}`), ['A-Emitidos', 'A-Recibidos', 'B-Emitidos', 'B-Recibidos'])
})
console.log(`\n${n} grupos de pruebas OK`)
