// Pruebas del lector de PDF de ARCA con textos de ejemplo (datos ficticios, misma estructura que los reales).
import assert from 'node:assert/strict'
import { interpretarPdf, planDe, lineasDeItems } from '../src/importar/pdf'

let n = 0
function prueba(nombre: string, f: () => void) { f(); n++; console.log('  ok', nombre) }

const VEP_SICOSS = ['VEP', 'Comprobante de Pago', 'Datos del VEP:', 'Nro. VEP: 1683911565', 'Organismo Recaudador: ARCA', 'Tipo de Pago: Empleadores SICOSS - Saldo DJ',
  'Descripción Reducida: SIJPDJ07/26', 'CUIT: 20-11111111-2', 'Concepto: 19 OBLIGACION MENSUAL/ANUAL', 'Período: 2026-07', 'CONTRIBUCIONES OBRA SOCIAL $1.676.401,01', '(352)',
  'Datos del comprobante de Pago:', 'Medio de Pago: HomeBanking-EFECTIVO', 'Nro. de Transacción: 2249845270', 'Fecha de Pago: 2026-09-22 Hora: 12:41:18', 'IMPORTE PAGADO $1.676.401,01']
const DJ931 = ['Presentación de DJ por Internet', 'Acuse de recibo de DJ', 'Organismo Recaudador: ARCA', 'Formulario: 931 v4700 - EMPLEADOR DJ', 'MENSUAL-SUSS', 'CUIT: 20-11111111-2',
  'Período: 2026-04', 'Fecha de Presentación: 2026-05-12 Hora: 08:48:35', 'Nro. de Transacción: 1169546955']

prueba('VEP de SICOSS: datos y plan', () => {
  const r = interpretarPdf(VEP_SICOSS)
  assert.ok(r.ok && r.doc.tipo === 'vep')
  if (!r.ok || r.doc.tipo !== 'vep') return
  assert.equal(r.doc.cuit, '20111111112'); assert.equal(r.doc.nroVep, '1683911565'); assert.equal(r.doc.importe, 1676401.01)
  assert.equal(r.doc.fechaPago, '2026-09-22'); assert.equal(r.doc.periodo, '2026-07'); assert.equal(r.doc.consolidado, false)
  const p = planDe(r.doc)
  assert.equal(p.pago?.referencia, '1683911565')
  assert.deepEqual([p.obligacion?.codigo, p.obligacion?.periodo, p.obligacion?.estado], ['f931', '2026-07', 'pagada'])
})
prueba('VEP consolidado y honorarios: solo pago, sin obligacion', () => {
  const r = interpretarPdf(['VEP', 'Comprobante de Pago', 'Nro. VEP Consolidado: 1688515935', 'Tipo de Pago: Vep Consolidado ARCA', 'CUIT: 20-11111111-2', 'Medio de Pago: x', 'Fecha de Pago: 2026-10-05 Hora: 11:50:16', 'IMPORTE PAGADO $1.999.857,06'])
  assert.ok(r.ok && r.doc.tipo === 'vep' && r.doc.consolidado)
  if (r.ok) { const p = planDe(r.doc); assert.equal(p.obligacion, null); assert.equal(p.pago?.importe, 1999857.06); assert.equal(p.avisos.length, 1) }
})
prueba('DJ F.931: presentada; F.2083: no se asocia', () => {
  const r = interpretarPdf(DJ931)
  assert.ok(r.ok && r.doc.tipo === 'dj')
  if (r.ok) { const p = planDe(r.doc); assert.deepEqual([p.obligacion?.codigo, p.obligacion?.estado, p.obligacion?.fecha], ['f931', 'presentada', '2026-05-12']); assert.equal(p.pago, null) }
  const l = interpretarPdf(DJ931.map((x) => x.replace('931 v4700 - EMPLEADOR DJ', '2083 v300 - CREDITOS Y DEBITOS')))
  assert.ok(l.ok)
  if (l.ok) { const p = planDe(l.doc); assert.equal(p.obligacion, null); assert.equal(p.pago, null); assert.equal(p.avisos.length, 1) }
})
prueba('rechaza lo que no entiende', () => {
  assert.equal(interpretarPdf(['Hola mundo']).ok, false)
  assert.equal(interpretarPdf(VEP_SICOSS.map((x) => x.replace('20-11111111-2', '20-11111111-9'))).ok, false) // CUIT invalido
  assert.equal(interpretarPdf(VEP_SICOSS.filter((x) => !x.startsWith('IMPORTE'))).ok, false) // sin pago
  assert.equal(interpretarPdf(DJ931.filter((x) => !x.startsWith('Fecha de Pres'))).ok, false)
})
prueba('arma renglones por altura y orden horizontal', () => {
  const it = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y] })
  assert.deepEqual(lineasDeItems([it('1690146345', 150, 733), it('Nro. VEP:', 109, 733), it(' ', 145, 733), it('ARCA', 150, 718), it('Organismo Recaudador:', 57, 718)]),
    ['Nro. VEP: 1690146345', 'Organismo Recaudador: ARCA'])
})
console.log(`\n${n} grupos de pruebas OK`)
