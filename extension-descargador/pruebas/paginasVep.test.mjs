// Prueba los pasos de VEP contra HTML con la misma estructura que «Presentación de DDJJ y Pagos» (listas desplegables simuladas).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pasoVep } from '../paginasVep.js'
const { chromium } = createRequire(import.meta.url)('playwright')

const lista = (id, etiqueta, opciones, sel) => `<div class="e-form-group"><label class="form-label">${etiqueta}</label><div class="multiselect"><div class="multiselect-wrapper" onclick="this.parentNode.querySelector('.multiselect-dropdown').classList.remove('is-hidden')">
<input class="multiselect-search" id="${id}"><div class="multiselect-single-label">${sel ?? ''}</div></div>
<div class="multiselect-dropdown is-hidden"><ul>${opciones.map(([v, t]) => `<li class="multiselect-option" id="${id}-multiselect-option-${v}" aria-selected="false" aria-label="${t}" onclick="[...this.parentNode.children].forEach(x=>x.setAttribute('aria-selected','false'));this.setAttribute('aria-selected','true');this.closest('.multiselect').querySelector('.multiselect-single-label').textContent='${t}'"><span>${t}</span></li>`).join('')}</ul></div></div></div>`
const FORM = `<div id="ingresofields">${lista('inp0', 'ESTABLECIMIENTO', [[0, '0 - Sujeto pasivo titular del impuesto'], [1, '1 - Sucesion indivisa']])}
${lista('inp1', 'PERIODO FISCAL Año', [[2025, '2025'], [2026, '2026']])}${lista('inp2', 'ANTICIPO/CUOTA', [[5, '5'], [6, '6']])}
<div class="e-form-group"><label class="form-label">GANANCIAS PERSONAS FISICAS (11)</label><input class="e-input" id="inp3" type="text"></div>
<button onclick="document.body.insertAdjacentHTML('beforeend','<div id=GeneracionVep></div>')">Siguiente</button></div>`
const TIPO = `${lista('selectCuit', 'CUIT', [['27251389247', '27251389247 - OROZCO']])}${lista('selectOrganismo', 'Org', [['2', 'ARCA']], 'ARCA')}${lista('selectGrupoTipoPago', 'Grupo', [['2', 'Ganancias'], ['4', 'Autonomo']])}${lista('selectTipoPago', 'Tipo', [['19', 'Ganancias Personas Fisicas - Anticipo']])}
<button onclick="document.body.insertAdjacentHTML('beforeend','<div id=ingresofields></div>')">Siguiente</button>`
const GRILLA = (fila) => `<div id="iniciados"><div class="ag-center-cols-container">${fila ? `<div class="ag-row"><div col-id="contribuyenteCUIT">27-25138924-7</div><div col-id="pagoDesc">Ganancias Personas Fisicas - Anticipo</div><div col-id="importe">$&nbsp;125.000,00</div></div>` : ''}</div></div><button id="iniciarVep"></button>`

const b = await chromium.launch()
const pg = await b.newPage()
const run = async (html, paso, a = {}) => { await pg.setContent(html); return pg.evaluate(`(${pasoVep.toString()})(${JSON.stringify(paso)}, ${JSON.stringify(a)})`) }
let n = 0
const prueba = async (t, f) => { await f(); n++; console.log('  ok', t) }

await prueba('etiquetas de las listas', async () => {
  assert.deepEqual((await run(FORM, 'etiquetas')).listas, ['ESTABLECIMIENTO', 'PERIODO FISCAL Año', 'ANTICIPO/CUOTA'])
})
await prueba('Datos del pago: elige listas, escribe el importe y pasa a la revisión', async () => {
  const campos = [{ etiqueta: 'ESTABLECIMIENTO', valor: '0' }, { etiqueta: 'PERIODO FISCAL Año', valor: '2026' }, { etiqueta: 'ANTICIPO/CUOTA', valor: '6' }]
  const r = await run(FORM, 'datosPago', { campos, importe: '125000' })
  assert.equal(r.ok, true, r.motivo)
  assert.deepEqual(r.vistos, ['ESTABLECIMIENTO=0', 'PERIODO FISCAL Año=2026', 'ANTICIPO/CUOTA=6', 'GANANCIAS PERSONAS FISICAS (11)=125000'])
  assert.equal(await pg.inputValue('#inp3'), '125000')
  assert.equal(await pg.textContent('#inp2 ~ .multiselect-single-label'), '6')
})
await prueba('Datos del pago: un campo desconocido frena la carga', async () => {
  const r = await run(FORM, 'datosPago', { campos: [{ etiqueta: 'ESTABLECIMIENTO', valor: '0' }], importe: '1' })
  assert.equal(r.ok, false); assert.match(r.motivo, /no sé completar/)
})
await prueba('elegir tipo: CUIT, organismo, grupo y tipo de pago', async () => {
  const r = await run(TIPO, 'elegirTipo', { cuit: '27251389247', grupo: 'Ganancias', tipoPago: 'Ganancias Personas Físicas - Anticipo' })
  assert.equal(r.ok, true, r.motivo)
  assert.equal(await pg.locator('#ingresofields').count(), 1)
})
await prueba('elegir tipo: CUIT que no representa o tipo inexistente → error con opciones', async () => {
  let r = await run(TIPO, 'elegirTipo', { cuit: '20111111112', grupo: 'Ganancias', tipoPago: 'x' })
  assert.equal(r.ok, false); assert.match(r.motivo, /no figura/)
  r = await run(TIPO, 'elegirTipo', { cuit: '27251389247', grupo: 'Ganancias', tipoPago: 'Monotributo - Pago Ajustes' })
  assert.equal(r.ok, false); assert.deepEqual(r.disponibles, ['Ganancias Personas Fisicas - Anticipo'])
})
await prueba('filas de «VEPs a enviar»', async () => {
  assert.deepEqual((await run(GRILLA(true), 'filas')).filas, [{ cuit: '27251389247', desc: 'Ganancias Personas Fisicas - Anticipo', importe: '$ 125.000,00' }])
  assert.deepEqual((await run(GRILLA(false), 'filas')).filas, [])
})
await prueba('verFila encuentra el VEP agregado', async () => {
  assert.equal((await run(GRILLA(true), 'verFila', { cuit: '27251389247', importeVisible: '125.000,00' })).ok, true)
})
await b.close()
console.log(`${n} grupos OK`)
