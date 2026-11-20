// Orquestador: recorre la cola (cliente -> tipo -> período) en UNA pestaña de «Mis Comprobantes».
// El estado vive en chrome.storage (clave «job»); si Chrome apaga este proceso, el trabajo queda en pausa y se retoma con «Continuar».
import { leerPersonas, leerPersonaActiva, prepararBusqueda, buscarYEsperar, clickExcel } from './paginas.js'
import { construirCola, nombreArchivo } from './lib/fechas.js'
import { pasoVep } from './paginasVep.js'
import { validarPlan, importeParaCampo, importeVisible, campoParaEtiqueta, etiquetaItem } from './lib/vep.js'

const BASE = 'https://fes.afip.gob.ar/mcmp/jsp/'
const ERRORES_SEGUIDOS_MAX = 3

class SesionPerdida extends Error {}

let corriendo = false
let latido = null
let esperaDescarga = null // { archivo, id, resolver, rechazar }

const leerJob = async () => (await chrome.storage.local.get('job')).job || null
const guardarJob = (job) => chrome.storage.local.set({ job })
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
const pausaCorta = () => dormir(1500 + Math.random() * 2000)

// Si este proceso arranca y quedó un trabajo «corriendo», fue interrumpido: queda en pausa.
;(async () => {
  const j = await leerJob()
  if (j && j.estado === 'corriendo') {
    j.estado = 'pausado'
    j.mensaje = 'Se interrumpió (Chrome reinició la extensión). Tocá «Continuar».'
    await guardarJob(j)
  }
})()

function esperarCarga(tabId, ms = 45000) {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(f); rechazar(new Error('La página de ARCA tardó demasiado en cargar.')) }, ms)
    function f(id, info) {
      if (id === tabId && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(f); resolver() }
    }
    chrome.tabs.onUpdated.addListener(f)
  })
}

async function irA(tabId, url) {
  const carga = esperarCarga(tabId)
  await chrome.tabs.update(tabId, { url })
  await carga
  const tab = await chrome.tabs.get(tabId)
  // Si ARCA nos manda a otra página (p. ej. el login), la extensión no puede leer esa dirección: se toma como sesión perdida.
  if (!tab.url || !tab.url.startsWith(BASE)) throw new SesionPerdida('ARCA te sacó de «Mis Comprobantes» (sesión vencida u otra página).')
}

async function ejecutar(tabId, func, args = [], world = 'ISOLATED') {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world, func, args })
  return r ? r.result : undefined
}

// Mientras se espera una descarga, se le pone el nombre/carpeta definitivos al archivo que arma la página.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const origen = `${item.url || ''} ${item.finalUrl || ''} ${item.referrer || ''}`
  if (esperaDescarga && esperaDescarga.id == null && /fes\.afip\.gob\.ar/.test(origen)) {
    esperaDescarga.id = item.id
    suggest({ filename: esperaDescarga.archivo, conflictAction: 'overwrite' })
  }
})
chrome.downloads.onChanged.addListener((d) => {
  if (!esperaDescarga || d.id !== esperaDescarga.id || !d.state) return
  if (d.state.current === 'complete') esperaDescarga.resolver()
  else if (d.state.current === 'interrupted') esperaDescarga.rechazar(new Error('La descarga se interrumpió.'))
})

function esperarDescarga(archivo, ms = 60000) {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(() => {
      esperaDescarga = null
      rechazar(new Error('No empezó la descarga. Si Chrome muestra «Guardar como», desactivá «Preguntar dónde guardar cada archivo» en Configuración → Descargas.'))
    }, ms)
    esperaDescarga = {
      archivo, id: null,
      resolver: () => { clearTimeout(t); esperaDescarga = null; resolver() },
      rechazar: (e) => { clearTimeout(t); esperaDescarga = null; rechazar(e) },
    }
  })
}

async function hacerTarea(job, t) {
  const tabId = job.tabId
  // 1. Que la persona activa sea la correcta
  let activa = null
  const tab = await chrome.tabs.get(tabId)
  if (tab.url && tab.url.startsWith(BASE)) activa = await ejecutar(tabId, leerPersonaActiva)
  if (activa !== t.cuit) {
    await irA(tabId, `${BASE}setearContribuyente.do?idContribuyente=${encodeURIComponent(t.personaId)}`)
    activa = await ejecutar(tabId, leerPersonaActiva)
    if (activa !== t.cuit) throw new Error(`ARCA no cambió a ${t.persona}. Volvé a «Leer mis clientes».`)
  }
  // 2. Pantalla de consulta y fechas
  await irA(tabId, `${BASE}${t.tipo === 'Emitidos' ? 'comprobantesEmitidos.do' : 'comprobantesRecibidos.do'}`)
  await pausaCorta()
  const prep = await ejecutar(tabId, prepararBusqueda, [t.desde, t.hasta], 'MAIN')
  if (!prep || !prep.ok) throw new Error((prep && prep.motivo) || 'No pude cargar las fechas.')
  // 3. Buscar
  const res = await ejecutar(tabId, buscarYEsperar, [90000], 'MAIN')
  if (!res) throw new Error('ARCA no respondió.')
  if (res.estado === 'vacio') return { estado: 'sin_comprobantes', detalle: 'Sin comprobantes en el período.' }
  if (res.estado !== 'listo') throw new Error(res.msg || 'ARCA no devolvió resultados.')
  // 4. Descargar el Excel
  const archivo = nombreArchivo(t.tipo, t.cuit, t.etiqueta)
  const espera = esperarDescarga(archivo)
  espera.catch(() => {})
  if (!(await ejecutar(tabId, clickExcel))) { esperaDescarga = null; throw new Error('No encuentro el botón Excel.') }
  await espera
  return { estado: 'ok', detalle: `${res.n} comprobantes → Descargas/${archivo}` }
}

function badge(job) {
  const texto = job && job.estado === 'corriendo' ? `${job.i}/${job.cola.length}` : ''
  chrome.action.setBadgeText({ text: texto })
}

async function correr() {
  if (corriendo) return
  corriendo = true
  latido = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)
  let seguidos = 0
  try {
    for (;;) {
      let job = await leerJob()
      if (!job || job.estado !== 'corriendo') break
      badge(job)
      if (job.i >= job.cola.length) {
        job.estado = 'terminado'
        job.mensaje = 'Listo. Los archivos están en Descargas/SysCAR.'
        await guardarJob(job)
        break
      }
      const t = job.cola[job.i]
      let r
      try {
        r = await hacerTarea(job, t)
        seguidos = 0
      } catch (e) {
        if (e instanceof SesionPerdida) {
          job = (await leerJob()) || job
          job.estado = 'pausado'
          job.mensaje = `${e.message} Iniciá sesión de nuevo, abrí «Mis Comprobantes» y tocá «Continuar».`
          await guardarJob(job)
          break
        }
        r = { estado: 'error', detalle: e.message }
        seguidos++
      }
      job = await leerJob()
      if (!job || job.estado !== 'corriendo') break // el usuario detuvo el trabajo
      job.resultados.push({ ...t, ...r })
      job.i++
      if (seguidos >= ERRORES_SEGUIDOS_MAX) {
        job.estado = 'pausado'
        job.mensaje = `Hubo ${seguidos} errores seguidos; paré para no insistir con ARCA. Revisá el detalle y tocá «Continuar».`
      }
      await guardarJob(job)
      if (job.estado !== 'corriendo') break
      await pausaCorta()
    }
  } finally {
    corriendo = false
    clearInterval(latido)
    badge(await leerJob())
  }
}

async function pestañaDeArca() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.url || !tab.url.startsWith('https://fes.afip.gob.ar/mcmp/')) {
    throw new Error('Abrí «Mis Comprobantes» desde el portal de ARCA (con tu sesión iniciada) y dejá esa pestaña al frente.')
  }
  return tab.id
}

const acciones = {
  async leerPersonas() {
    const tabId = await pestañaDeArca()
    await irA(tabId, `${BASE}seleccionIngreso.do?s`)
    const r = await ejecutar(tabId, leerPersonas)
    if (!r || r.personas.length === 0) throw new Error('No encontré personas para representar. ¿Iniciaste sesión en «Mis Comprobantes»?')
    const datos = { usuario: r.usuario, personas: r.personas, leidoEn: new Date().toISOString() }
    await chrome.storage.local.set({ personas: datos })
    return datos
  },
  async iniciar({ personas, tipos, rangos }) {
    if (corriendo) throw new Error('Ya hay una descarga en curso.')
    if (!personas.length || !tipos.length || !rangos.length) throw new Error('Falta elegir clientes, tipos o período.')
    const tabId = await pestañaDeArca()
    const cola = construirCola(personas, tipos, rangos)
    await guardarJob({ estado: 'corriendo', tabId, cola, i: 0, resultados: [], mensaje: 'Descargando… no uses esta pestaña mientras tanto.', inicio: new Date().toISOString() })
    correr()
    return true
  },
  async continuar() {
    const job = await leerJob()
    if (!job || job.estado !== 'pausado') throw new Error('No hay nada para continuar.')
    job.tabId = await pestañaDeArca()
    job.estado = 'corriendo'
    job.mensaje = 'Descargando… no uses esta pestaña mientras tanto.'
    await guardarJob(job)
    correr()
    return true
  },
  async detener() {
    const job = await leerJob()
    if (job && job.estado === 'corriendo') {
      job.estado = 'detenido'
      job.mensaje = 'Detenido por vos.'
      await guardarJob(job)
    }
    return true
  },
  async limpiar() {
    await chrome.storage.local.remove('job')
    chrome.action.setBadgeText({ text: '' })
    return true
  },
}

// ---------- VEP recurrentes: se cargan en «VEPs a enviar» y se frena ahí (nunca se elige medio de pago) ----------
const SETI = 'https://seti.afip.gob.ar/setiweb/'
let corriendoVep = false
let latidoVep = null
const leerJobVep = async () => (await chrome.storage.local.get('jobVep')).jobVep || null
const guardarJobVep = (jobVep) => chrome.storage.local.set({ jobVep })

;(async () => {
  const j = await leerJobVep()
  if (j && j.estado === 'corriendo') {
    j.estado = 'pausado'
    j.mensaje = 'Se interrumpió (Chrome reinició la extensión). Tocá «Continuar».'
    await guardarJobVep(j)
  }
})()

async function pasoEn(tabId, paso, args = {}) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: pasoVep, args: [paso, args] })
  const res = r ? r.result : null
  if (!res) throw new Error('ARCA no respondió.')
  if (res.sesion) throw new SesionPerdida(res.motivo)
  if (!res.ok) { const e = new Error(res.motivo || 'Falló un paso.'); e.disponibles = res.disponibles; throw e }
  return res
}

async function cargarUnVep(tabId, x) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab.url || !tab.url.startsWith(SETI)) throw new SesionPerdida('La pestaña ya no está en «Presentación de DDJJ y Pagos».')
  const visible = importeVisible(x.importe)
  await pasoEn(tabId, 'irAGestion')
  const { filas } = await pasoEn(tabId, 'filas')
  if (filas.some((f) => f.cuit === x.cuit && f.importe.replace(/ /g, ' ').includes(visible) && f.desc.toLowerCase().includes(x.tipoPago.toLowerCase().split(' - ').pop().slice(0, 6)))) {
    return { estado: 'ya_cargado', detalle: 'Ya estaba en «VEPs a enviar».' }
  }
  await pasoEn(tabId, 'abrirNuevo')
  await pasoEn(tabId, 'elegirTipo', { cuit: x.cuit, grupo: x.grupo, tipoPago: x.tipoPago })
  const { listas } = await pasoEn(tabId, 'etiquetas')
  const campos = []
  for (const etiqueta of listas) {
    const c = campoParaEtiqueta(etiqueta, x)
    if (!c) throw new Error(`ARCA pide un dato que no sé completar: «${etiqueta}». Cargalo a mano o avisame.`)
    campos.push({ etiqueta, valor: c.valor })
  }
  await pasoEn(tabId, 'datosPago', { campos, importe: importeParaCampo(x.importe) })
  await pasoEn(tabId, 'revisar', { importeVisible: visible, cuit: x.cuit })
  await pasoEn(tabId, 'verFila', { importeVisible: visible, cuit: x.cuit })
  return { estado: 'ok', detalle: `Cargado en «VEPs a enviar»: $ ${visible}` }
}

async function correrVep() {
  if (corriendoVep) return
  corriendoVep = true
  latidoVep = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)
  let seguidos = 0
  try {
    for (;;) {
      let job = await leerJobVep()
      if (!job || job.estado !== 'corriendo') break
      chrome.action.setBadgeText({ text: `${job.i}/${job.cola.length}` })
      if (job.i >= job.cola.length) {
        const ok = job.resultados.filter((r) => r.estado === 'ok' || r.estado === 'ya_cargado').length
        job.estado = 'terminado'
        job.mensaje = ok
          ? `Listo: ${ok} VEP en «VEPs a enviar». Revisalos en ARCA y tocá «Seleccioná medio de pago» (eso lo hacés vos).`
          : 'Terminó sin cargar ningún VEP. Mirá el detalle.'
        await guardarJobVep(job)
        break
      }
      const x = job.cola[job.i]
      let r
      try {
        r = await cargarUnVep(job.tabId, x)
        seguidos = 0
      } catch (e) {
        if (e instanceof SesionPerdida) {
          job = (await leerJobVep()) || job
          job.estado = 'pausado'
          job.mensaje = `${e.message} Iniciá sesión, abrí «Presentación de DDJJ y Pagos» y tocá «Continuar». (Ojo: «VEPs a enviar» se vacía si la sesión se pierde; los ya cargados se revisan al continuar.)`
          await guardarJobVep(job)
          break
        }
        r = { estado: 'error', detalle: e.message + (e.disponibles && e.disponibles.length ? ` Opciones que ofrece ARCA: ${e.disponibles.slice(0, 12).join(' / ')}` : '') }
        seguidos++
      }
      job = await leerJobVep()
      if (!job || job.estado !== 'corriendo') break
      job.resultados.push({ id: x.id, cliente: x.cliente, etiqueta: etiquetaItem(x), ...r })
      job.i++
      if (seguidos >= ERRORES_SEGUIDOS_MAX) {
        job.estado = 'pausado'
        job.mensaje = `Hubo ${seguidos} errores seguidos; paré para no insistir con ARCA. Revisá el detalle y tocá «Continuar».`
      }
      await guardarJobVep(job)
      if (job.estado !== 'corriendo') break
      await pausaCorta()
    }
  } finally {
    corriendoVep = false
    clearInterval(latidoVep)
    chrome.action.setBadgeText({ text: '' })
  }
}

async function pestañaDeSeti() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab || !tab.url || !tab.url.startsWith(SETI)) {
    throw new Error('Abrí «Presentación de DDJJ y Pagos» desde el portal de ARCA (con tu sesión iniciada) y dejá esa pestaña al frente.')
  }
  return tab.id
}

Object.assign(acciones, {
  async cargarPlan({ plan }) {
    const v = validarPlan(plan)
    if (!v.ok) throw new Error(v.error)
    await chrome.storage.local.set({ planVep: { items: v.items, cargadoEn: new Date().toISOString() } })
    return v.items
  },
  async iniciarVep({ ids }) {
    if (corriendoVep) throw new Error('Ya hay una carga de VEP en curso.')
    const { planVep } = await chrome.storage.local.get('planVep')
    const cola = ((planVep && planVep.items) || []).filter((x) => ids.includes(x.id))
    if (!cola.length) throw new Error('Tildá al menos un VEP.')
    const tabId = await pestañaDeSeti()
    await guardarJobVep({ estado: 'corriendo', tabId, cola, i: 0, resultados: [], mensaje: 'Cargando VEP en ARCA… no uses esa pestaña mientras tanto.', inicio: new Date().toISOString() })
    correrVep()
    return true
  },
  async continuarVep() {
    const job = await leerJobVep()
    if (!job || job.estado !== 'pausado') throw new Error('No hay nada para continuar.')
    job.tabId = await pestañaDeSeti()
    job.estado = 'corriendo'
    job.mensaje = 'Cargando VEP en ARCA… no uses esa pestaña mientras tanto.'
    await guardarJobVep(job)
    correrVep()
    return true
  },
  async detenerVep() {
    const job = await leerJobVep()
    if (job && job.estado === 'corriendo') { job.estado = 'detenido'; job.mensaje = 'Detenido por vos.'; await guardarJobVep(job) }
    return true
  },
  async limpiarVep() {
    await chrome.storage.local.remove('jobVep')
    chrome.action.setBadgeText({ text: '' })
    return true
  },
})

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  const f = acciones[msg && msg.accion]
  if (!f) return false
  f(msg).then((datos) => responder({ ok: true, datos }), (e) => responder({ ok: false, error: e.message }))
  return true
})
