import assert from 'node:assert/strict'
import { normalizar, importeParaCampo, importeVisible, validarPlan, campoParaEtiqueta, etiquetaItem } from '../lib/vep.js'
let n = 0
const prueba = (t, f) => { f(); n++; console.log('  ok', t) }

prueba('normalizar y formatos de importe', () => {
  assert.equal(normalizar('  Ganancias   Personas Físicas – Anticipo '), 'ganancias personas fisicas – anticipo')
  assert.equal(importeParaCampo(125000), '125000'); assert.equal(importeParaCampo(1250.5), '1250,50'); assert.equal(importeParaCampo('0.1'), '0,10')
  assert.equal(importeVisible(125000), '125.000,00'); assert.equal(importeVisible(1234567.8), '1.234.567,80'); assert.equal(importeVisible(999.99), '999,99')
})
const base = { cuit: '27-25138924-7', cliente: 'OROZCO JULIETA', tipo: 'ganancias_anticipo', grupo: 'Ganancias', tipoPago: 'Ganancias Personas Fisicas - Anticipo', anio: 2026, cuota: 6, importe: 125000 }
prueba('plan válido', () => {
  const r = validarPlan({ formato: 'syscar-vep', version: 1, items: [base] })
  assert.equal(r.ok, true); assert.equal(r.items[0].cuit, '27251389247'); assert.equal(r.items[0].mes, null)
})
prueba('plan inválido: formato, importe, cuota, CUIT, vacío', () => {
  assert.equal(validarPlan({ items: [] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [{ ...base, importe: 0 }] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [{ ...base, cuota: null }] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [{ ...base, cuit: '123' }] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [{ ...base, tipo: 'raro' }] }).ok, false)
  assert.equal(validarPlan({ formato: 'syscar-vep', version: 1, items: [{ ...base, mes: 13 }] }).ok, false)
})
prueba('campos de «Datos del pago» según la etiqueta', () => {
  const x = { anio: 2026, mes: 11, cuota: 6 }
  assert.deepEqual(campoParaEtiqueta('ESTABLECIMIENTO', x), { clase: 'lista', valor: '0' })
  assert.deepEqual(campoParaEtiqueta('PERIODO FISCAL Año', x), { clase: 'lista', valor: '2026' })
  assert.deepEqual(campoParaEtiqueta('ANTICIPO/CUOTA', x), { clase: 'lista', valor: '6' })
  assert.deepEqual(campoParaEtiqueta('PERIODO FISCAL Mes', x), { clase: 'lista', valor: '11' })
  assert.equal(campoParaEtiqueta('ALGO RARO', x), null)
  assert.equal(campoParaEtiqueta('ANTICIPO/CUOTA', { anio: 2026, mes: null, cuota: null }), null)
})
prueba('etiqueta del item', () => {
  assert.equal(etiquetaItem({ tipoPago: 'X', anio: 2026, cuota: 6, mes: null }), 'X · 2026 · cuota 6')
  assert.equal(etiquetaItem({ tipoPago: 'X', anio: 2026, mes: 3, cuota: null }), 'X · 2026-03')
})
console.log(`${n} grupos OK`)
