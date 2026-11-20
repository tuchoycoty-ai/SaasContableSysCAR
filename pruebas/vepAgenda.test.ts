import assert from 'node:assert/strict'
import { armarPlan, periodoTexto, urgenciaDe, type VepProgramado } from '../src/lib/vepAgenda'

const base: VepProgramado = { id: '1', client_id: 'c', tipo: 'ganancias_anticipo', grupo: 'Ganancias', tipo_pago: 'Ganancias Personas Fisicas - Anticipo', anio: 2026, mes: null, cuota: 6, importe: 125000, vence: '2026-11-25', estado: 'listo', nro_vep: null, pagado_en: null, notas: null }
let n = 0
const prueba = (t: string, f: () => void) => { f(); n++; console.log('  ok', t) }

prueba('urgencia según vencimiento y estado', () => {
  assert.equal(urgenciaDe(base, '2026-11-26'), 'vencido')
  assert.equal(urgenciaDe(base, '2026-11-20'), 'esta_semana')
  assert.equal(urgenciaDe(base, '2026-11-01'), 'proximo')
  assert.equal(urgenciaDe({ ...base, vence: null }, '2026-11-01'), 'sin_fecha')
  assert.equal(urgenciaDe({ ...base, estado: 'pagado' }, '2027-01-01'), 'resuelto')
})
prueba('plan para la extensión: solo «listos» con importe', () => {
  const p = armarPlan([
    { ...base, cuit: '27251389247', cliente: 'OROZCO JULIETA' },
    { ...base, id: '2', estado: 'pendiente', importe: null, cuit: '27251389247', cliente: 'X' },
    { ...base, id: '3', estado: 'pagado', cuit: '27251389247', cliente: 'Y' },
  ])
  assert.equal(p.formato, 'syscar-vep'); assert.equal(p.items.length, 1)
  assert.deepEqual([p.items[0].tipoPago, p.items[0].cuota, p.items[0].importe], ['Ganancias Personas Fisicas - Anticipo', 6, 125000])
})
prueba('texto del período', () => {
  assert.equal(periodoTexto(base), '2026 · anticipo 6')
  assert.equal(periodoTexto({ anio: 2026, mes: 3, cuota: null }), '2026-03')
})
console.log(`${n} grupos OK`)
