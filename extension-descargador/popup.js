import { mesAnterior, mesATexto, textoAMes, rangosDe } from './lib/fechas.js'
import { importeVisible, etiquetaItem } from './lib/vep.js'

const $ = (id) => document.getElementById(id)
const enviar = (accion, extra = {}) => new Promise((res) => chrome.runtime.sendMessage({ accion, ...extra }, (r) => res(r || { ok: false, error: 'La extensión no respondió.' })))
let datos = null // { usuario, personas }
let ajustes = { elegidos: null, modo: 'anterior', desde: '', hasta: '', porMes: true, emitidos: true, recibidos: true }

const guardarAjustes = () => chrome.storage.local.set({ ajustes })
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtCuit = (c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`

function dibujarClientes() {
  const lista = $('lista')
  $('vacio').classList.toggle('oculto', !!(datos && datos.personas.length))
  if (!datos) { lista.innerHTML = ''; return }
  if (!ajustes.elegidos) ajustes.elegidos = datos.personas.filter((p) => p.cuit !== datos.usuario).map((p) => p.id) // por defecto: todos menos el administrador
  lista.innerHTML = datos.personas.map((p) => {
    const yo = p.cuit === datos.usuario
    return `<label><input type="checkbox" data-id="${esc(p.id)}" ${ajustes.elegidos.includes(p.id) ? 'checked' : ''}> ${esc(p.nombre)} <small>${fmtCuit(p.cuit)}${yo ? ' · administrador (vos)' : ''}</small></label>`
  }).join('')
  lista.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => {
    ajustes.elegidos = [...lista.querySelectorAll('input:checked')].map((x) => x.dataset.id)
    guardarAjustes()
  }))
}

function dibujarPeriodo() {
  const elegir = ajustes.modo === 'elegir'
  document.querySelectorAll('input[name=modo]').forEach((r) => { r.checked = r.value === ajustes.modo })
  $('meses').classList.toggle('oculto', !elegir)
  $('porMesFila').classList.toggle('oculto', !elegir)
  $('desde').value = ajustes.desde; $('hasta').value = ajustes.hasta; $('porMes').checked = ajustes.porMes
  $('tEmitidos').checked = ajustes.emitidos; $('tRecibidos').checked = ajustes.recibidos
}

function dibujarJob(job) {
  const corriendo = !!job && job.estado === 'corriendo'
  $('iniciar').classList.toggle('oculto', corriendo || (!!job && job.estado === 'pausado'))
  $('continuar').classList.toggle('oculto', !(job && job.estado === 'pausado'))
  $('detener').classList.toggle('oculto', !corriendo)
  $('limpiar').classList.toggle('oculto', !job || corriendo)
  $('leer').disabled = corriendo
  if (!job) { $('mensaje').textContent = ''; $('resultados').innerHTML = ''; return }
  const prog = `${Math.min(job.i, job.cola.length)} de ${job.cola.length}`
  $('mensaje').textContent = `${job.mensaje || ''} (${prog})`
  const nombre = { ok: 'Descargado', sin_comprobantes: 'Sin comprobantes', omitido: 'Omitido', error: 'Error' }
  const clase = { ok: 'ok', sin_comprobantes: 'vacio', omitido: 'vacio', error: 'error' }
  $('resultados').innerHTML = `<table>${job.resultados.map((r) =>
    `<tr><td>${esc(r.persona)}<br><small>${r.tipo} · ${esc(r.etiqueta)}</small></td><td class="${clase[r.estado] || ''}">${nombre[r.estado] || r.estado}<br><small>${esc(r.detalle || '')}</small></td></tr>`).join('')}</table>`
}

function tomarFormulario() {
  ajustes.modo = document.querySelector('input[name=modo]:checked').value
  ajustes.desde = $('desde').value; ajustes.hasta = $('hasta').value; ajustes.porMes = $('porMes').checked
  ajustes.emitidos = $('tEmitidos').checked; ajustes.recibidos = $('tRecibidos').checked
  guardarAjustes()
}

$('leer').addEventListener('click', async () => {
  $('leer').disabled = true; $('mensaje').textContent = 'Leyendo tus clientes…'
  const r = await enviar('leerPersonas')
  $('leer').disabled = false
  if (!r.ok) { $('mensaje').textContent = r.error; return }
  datos = r.datos; ajustes.elegidos = null; dibujarClientes(); $('mensaje').textContent = `Encontré ${datos.personas.length} personas.`
})
document.querySelectorAll('input[name=modo], #desde, #hasta, #porMes, #tEmitidos, #tRecibidos').forEach((e) => e.addEventListener('change', () => { tomarFormulario(); dibujarPeriodo() }))

$('iniciar').addEventListener('click', async () => {
  tomarFormulario()
  if (!datos) { $('mensaje').textContent = 'Primero leé tus clientes.'; return }
  const personas = datos.personas.filter((p) => (ajustes.elegidos || []).includes(p.id))
  const tipos = [ajustes.emitidos && 'Emitidos', ajustes.recibidos && 'Recibidos'].filter(Boolean)
  const m = mesAnterior()
  const rg = ajustes.modo === 'anterior'
    ? rangosDe({ desde: m, hasta: m, unoPorMes: true })
    : rangosDe({ desde: textoAMes(ajustes.desde), hasta: textoAMes(ajustes.hasta), unoPorMes: ajustes.porMes })
  if (rg.error) { $('mensaje').textContent = rg.error; return }
  if (!personas.length) { $('mensaje').textContent = 'Tildá al menos un cliente.'; return }
  if (!tipos.length) { $('mensaje').textContent = 'Tildá Emitidos y/o Recibidos.'; return }
  const r = await enviar('iniciar', { personas, tipos, rangos: rg.rangos })
  if (!r.ok) $('mensaje').textContent = r.error
})
$('continuar').addEventListener('click', async () => { const r = await enviar('continuar'); if (!r.ok) $('mensaje').textContent = r.error })
$('detener').addEventListener('click', () => enviar('detener'))
$('limpiar').addEventListener('click', () => enviar('limpiar'))

chrome.storage.onChanged.addListener((c) => { if (c.job) dibujarJob(c.job.newValue || null) })
;(async () => {
  const g = await chrome.storage.local.get(['personas', 'ajustes', 'job'])
  datos = g.personas || null
  if (g.ajustes) ajustes = { ...ajustes, ...g.ajustes }
  const m = mesATexto(mesAnterior())
  if (!ajustes.desde) ajustes.desde = m
  if (!ajustes.hasta) ajustes.hasta = m
  dibujarClientes(); dibujarPeriodo(); dibujarJob(g.job || null)
})()

// ---------- Solapa VEP ----------
let plan = null // { items, cargadoEn }
let elegidosVep = null
function solapa(cual) {
  $('panelCompr').classList.toggle('oculto', cual !== 'compr'); $('panelVep').classList.toggle('oculto', cual !== 'vep')
  $('sCompr').classList.toggle('activa', cual === 'compr'); $('sVep').classList.toggle('activa', cual === 'vep')
  chrome.storage.local.set({ solapa: cual })
}
$('sCompr').addEventListener('click', () => solapa('compr'))
$('sVep').addEventListener('click', () => solapa('vep'))

function dibujarPlan() {
  const lista = $('listaVep')
  if (!plan || !plan.items.length) { lista.innerHTML = ''; return }
  if (!elegidosVep) elegidosVep = plan.items.map((x) => x.id)
  $('infoPlan').textContent = `${plan.items.length} VEP en el plan (cargado ${new Date(plan.cargadoEn).toLocaleString('es-AR')}).`
  lista.innerHTML = plan.items.map((x) =>
    `<label><input type="checkbox" data-id="${esc(x.id)}" ${elegidosVep.includes(x.id) ? 'checked' : ''}> ${esc(x.cliente)} <small>${fmtCuit(x.cuit)}<br>${esc(etiquetaItem(x))} · $ ${importeVisible(x.importe)}</small></label>`).join('')
  lista.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { elegidosVep = [...lista.querySelectorAll('input:checked')].map((v) => v.dataset.id) }))
}

function dibujarJobVep(job) {
  const corriendo = !!job && job.estado === 'corriendo'
  $('iniciarVep').classList.toggle('oculto', corriendo || (!!job && job.estado === 'pausado'))
  $('continuarVep').classList.toggle('oculto', !(job && job.estado === 'pausado'))
  $('detenerVep').classList.toggle('oculto', !corriendo)
  $('limpiarVep').classList.toggle('oculto', !job || corriendo)
  if (!job) { $('mensajeVep').textContent = ''; $('resultadosVep').innerHTML = ''; return }
  $('mensajeVep').textContent = `${job.mensaje || ''} (${Math.min(job.i, job.cola.length)} de ${job.cola.length})`
  const nombre = { ok: 'Cargado', ya_cargado: 'Ya estaba', error: 'Error' }
  const clase = { ok: 'ok', ya_cargado: 'vacio', error: 'error' }
  $('resultadosVep').innerHTML = `<table>${job.resultados.map((r) =>
    `<tr><td>${esc(r.cliente)}<br><small>${esc(r.etiqueta)}</small></td><td class="${clase[r.estado] || ''}">${nombre[r.estado] || r.estado}<br><small>${esc(r.detalle || '')}</small></td></tr>`).join('')}</table>`
}

$('archivoPlan').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0]
  if (!f) return
  let json
  try { json = JSON.parse(await f.text()) } catch { $('infoPlan').textContent = 'No pude leer el archivo.'; return }
  const r = await enviar('cargarPlan', { plan: json })
  if (!r.ok) { $('infoPlan').textContent = r.error; return }
  plan = { items: r.datos, cargadoEn: new Date().toISOString() }; elegidosVep = null; dibujarPlan()
})
$('iniciarVep').addEventListener('click', async () => {
  const r = await enviar('iniciarVep', { ids: elegidosVep || [] })
  if (!r.ok) $('mensajeVep').textContent = r.error
})
$('continuarVep').addEventListener('click', async () => { const r = await enviar('continuarVep'); if (!r.ok) $('mensajeVep').textContent = r.error })
$('detenerVep').addEventListener('click', () => enviar('detenerVep'))
$('limpiarVep').addEventListener('click', () => enviar('limpiarVep'))
chrome.storage.onChanged.addListener((c) => { if (c.jobVep) dibujarJobVep(c.jobVep.newValue || null) })
;(async () => {
  const g = await chrome.storage.local.get(['planVep', 'jobVep', 'solapa'])
  plan = g.planVep || null
  dibujarPlan(); dibujarJobVep(g.jobVep || null)
  if (g.solapa === 'vep') solapa('vep')
})()
