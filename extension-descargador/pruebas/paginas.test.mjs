// Prueba las funciones de página contra HTML de ejemplo con la misma estructura que «Mis Comprobantes» (datos inventados).
// Requiere Playwright con Chromium: node pruebas/paginas.test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { leerPersonas, leerPersonaActiva, prepararBusqueda, buscarYEsperar, clickExcel } from '../paginas.js'
const { chromium } = createRequire(import.meta.url)('playwright')

const CAB = (extra = '') => `<div id="usernav"><span><strong class="text-primary">PEPE ADMIN</strong> [20-11111111-2]</span>${extra}</div>`
const SELECCION = `${CAB()}<form><input type="hidden" id="idcontribuyente">
  <a class="panel" href="#" onclick="document.getElementById('idcontribuyente').value='1';document.seleccionaEmpresaForm.submit();return false;"><h2>PEPE ADMIN</h2><p>20-11111111-2</p></a>
  <h6>REPRESENTAR A:</h6>
  <a class="panel" href="#" onclick="document.getElementById('idcontribuyente').value='0';document.seleccionaEmpresaForm.submit();return false;"><h3>EMPRESA UNO S.A. <small>30-50001091-2</small></h3></a>
  <a class="panel" href="#" onclick="document.getElementById('idcontribuyente').value='1';document.seleccionaEmpresaForm.submit();return false;"><h3>PEPE ADMIN <small>20-11111111-2</small></h3></a>
  <a class="panel" href="#" onclick="document.getElementById('idcontribuyente').value='2';document.seleccionaEmpresaForm.submit();return false;"><h3>OTRA EMPRESA SRL <small>30-70000001-6</small></h3></a></form>`
const MENU = CAB('<span><small>Representando a:</small> <strong class="text-success">EMPRESA UNO S.A.</strong> [30-50001091-2]</span>')
const RESULTADOS = (n) => `${MENU}<input id="fechaEmision"><button id="buscarComprobantes" type="button">Buscar</button>
  <div><button class="buttons-excel" onclick="window.__excel=1">Excel</button><div id="tablaDataTables_info">Mostrando registros 1 al 5 de un total de ${n}</div></div>`
const SIN_TABLA = `${MENU}<input id="fechaEmision"><button id="buscarComprobantes" type="button">Buscar</button>`
const AVISO = `${MENU}<input id="fechaEmision"><button id="buscarComprobantes" type="button">Buscar</button><div class="alert">No se encontraron comprobantes para los filtros indicados.</div>`

const b = await chromium.launch()
const pg = await b.newPage()
const run = (fn, ...args) => pg.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`)
let n = 0
const prueba = async (t, f) => { await f(); n++; console.log('  ok', t) }

await prueba('lee personas sin repetir y detecta al administrador', async () => {
  await pg.setContent(SELECCION)
  const r = await run(leerPersonas)
  assert.equal(r.usuario, '20111111112')
  assert.deepEqual(r.personas.map((p) => [p.id, p.cuit]), [['1', '20111111112'], ['0', '30500010912'], ['2', '30700000016']])
  assert.equal(r.personas[1].nombre, 'EMPRESA UNO S.A.')
})
await prueba('persona activa: la representada, o el propio usuario', async () => {
  await pg.setContent(MENU); assert.equal(await run(leerPersonaActiva), '30500010912')
  await pg.setContent(SELECCION); assert.equal(await run(leerPersonaActiva), '20111111112')
})
await prueba('carga las fechas y verifica', async () => {
  await pg.setContent(SIN_TABLA)
  const r = await run(prepararBusqueda, '01/10/2026', '31/10/2026')
  assert.ok(r.ok); assert.equal(r.valor, '01/10/2026 - 31/10/2026')
})
await prueba('busca y detecta resultados / vacío / sin respuesta', async () => {
  await pg.setContent(RESULTADOS(54)); assert.deepEqual(await run(buscarYEsperar, 3000), { estado: 'listo', n: 54 })
  await pg.setContent(RESULTADOS('1.250')); assert.equal((await run(buscarYEsperar, 3000)).n, 1250)
  await pg.setContent(RESULTADOS(0)); assert.equal((await run(buscarYEsperar, 3000)).estado, 'vacio')
  await pg.setContent(AVISO); assert.equal((await run(buscarYEsperar, 3000)).estado, 'vacio')
  await pg.setContent(SIN_TABLA); assert.equal((await run(buscarYEsperar, 2200)).estado, 'tiempo')
})
await prueba('clic en Excel', async () => {
  await pg.setContent(RESULTADOS(3)); assert.equal(await run(clickExcel), true)
  assert.equal(await pg.evaluate(() => window.__excel), 1)
  await pg.setContent(SIN_TABLA); assert.equal(await run(clickExcel), false)
})
await b.close()
console.log(`\n${n} grupos de pruebas OK`)
