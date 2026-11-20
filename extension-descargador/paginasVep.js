// Funciones que se ejecutan DENTRO de «Presentación de DDJJ y Pagos» (seti.afip.gob.ar). Cada una es autónoma: no usa nada de afuera.
// Hacen los mismos clics y escrituras que una persona, y se DETIENEN en «VEPs a enviar»: nunca eligen medio de pago, por lo que ARCA no emite nada.

// Un solo punto de entrada para que los ayudantes (esperar, leer, elegir en listas) estén definidos una vez.
export async function pasoVep(paso, a) {
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const limpio = (s) => String(s ?? '').replace(/[\s ]+/g, ' ').trim()
  async function esperar(fn, ms = 15000, cada = 250) {
    const fin = Date.now() + ms
    for (;;) {
      let r = null
      try { r = fn() } catch (e) { r = null }
      if (r) return r
      if (Date.now() > fin) return null
      await dormir(cada)
    }
  }
  const boton = (texto) => [...document.querySelectorAll('button')].find((b) => visible(b) && !b.disabled && limpio(b.textContent) === texto)
  const clic = (el) => {
    el.scrollIntoView({ block: 'center' })
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  }
  const hayLogin = () => /clave fiscal|ingres[aá] con tu cuit|iniciar sesi[oó]n/i.test(document.title + ' ' + (document.querySelector('h1,h2')?.textContent || '')) && !document.getElementById('navbar')
  // Mensajes de error que ARCA muestra en ventanas o avisos
  const mensajeError = () => [...document.querySelectorAll('.modal.show .modal-body, .alert-danger, .invalid-feedback, [role=alert]')]
    .filter(visible).map((e) => limpio(e.textContent)).filter(Boolean).join(' | ')

  // Lista desplegable de ARCA (multiselect): abre, elige la opción cuyo texto coincide y verifica lo que quedó mostrado.
  async function elegirEnLista(idInput, quiero, { porValor = false } = {}) {
    const input = await esperar(() => document.getElementById(idInput), 12000)
    if (!input) return { ok: false, motivo: `No encuentro la lista «${idInput}».` }
    const caja = input.closest('.multiselect')
    const mostrado = () => limpio(caja.querySelector('.multiselect-single-label')?.textContent)
    const opciones = () => [...caja.querySelectorAll('li.multiselect-option')].filter((li) => !/null$/.test(li.id))
    const textoDe = (li) => limpio(li.getAttribute('aria-label') || li.textContent)
    const coincide = (li) => (porValor || /^\d+$/.test(String(quiero)) ? li.id.endsWith(`-option-${quiero}`) : false) || (!porValor && norm(textoDe(li)) === norm(quiero))
    for (let intento = 0; intento < 3; intento++) {
      const yaEsta = opciones().find(coincide)
      if (!yaEsta || !visible(yaEsta)) {
        clic(caja.querySelector('.multiselect-wrapper') || caja)
        input.focus()
        await esperar(() => opciones().length && visible(opciones()[0]), 4000)
      }
      const op = await esperar(() => opciones().find(coincide), 6000)
      if (!op) return { ok: false, motivo: `ARCA no ofrece «${quiero}» en «${idInput}».`, disponibles: opciones().map(textoDe) }
      if (op.getAttribute('aria-selected') === 'true' && mostrado()) return { ok: true }
      clic(op)
      await dormir(400)
      if (op.getAttribute('aria-selected') === 'true' || norm(mostrado()).includes(norm(porValor ? textoDe(op) : quiero))) return { ok: true }
    }
    return { ok: false, motivo: `No pude elegir «${quiero}» en «${idInput}».` }
  }

  if (paso === 'irAGestion') {
    if (hayLogin()) return { ok: false, sesion: true, motivo: 'ARCA pide iniciar sesión.' }
    if (!/#\/pago\/nuevo-vep\/?$/.test(location.hash)) location.hash = '#/pago/nuevo-vep'
    const ok = await esperar(() => document.getElementById('iniciarVep'), 20000)
    return ok ? { ok: true } : { ok: false, motivo: 'No se abrió «Gestión de VEP». ¿Estás en «Presentación de DDJJ y Pagos» con la sesión iniciada?' }
  }

  // Filas que ya están en «VEPs a enviar» (para no cargar dos veces el mismo VEP).
  if (paso === 'filas') {
    const tab = document.getElementById('iniciados-tab-button')
    if (tab && tab.getAttribute('aria-selected') !== 'true') clic(tab)
    await dormir(600)
    const filas = [...document.querySelectorAll('#iniciados .ag-center-cols-container .ag-row')].map((r) => ({
      cuit: limpio(r.querySelector('[col-id=contribuyenteCUIT]')?.textContent).replace(/\D/g, ''),
      desc: limpio(r.querySelector('[col-id=pagoDesc]')?.textContent),
      importe: limpio(r.querySelector('[col-id=importe]')?.textContent),
    }))
    return { ok: true, filas }
  }

  if (paso === 'abrirNuevo') {
    const menu = document.getElementById('iniciarVep')
    if (!menu) return { ok: false, motivo: 'No encuentro el botón «Generar VEP».' }
    clic(menu)
    const item = await esperar(() => document.querySelector('#linkNuevoVep a'), 5000)
    if (!item) return { ok: false, motivo: 'No encuentro «Nuevo VEP» en el menú.' }
    clic(item)
    const ok = await esperar(() => document.getElementById('selectCuit'), 15000)
    return ok ? { ok: true } : { ok: false, motivo: 'No se abrió el formulario de Nuevo VEP.' }
  }

  if (paso === 'elegirTipo') {
    let r = await elegirEnLista('selectCuit', a.cuit, { porValor: true })
    if (!r.ok) return { ...r, motivo: `El CUIT ${a.cuit} no figura entre los que podés representar en ARCA. ${r.motivo}` }
    // Organismo: ARCA (opción 2)
    const org = document.getElementById('selectOrganismo')
    const orgCaja = org && org.closest('.multiselect')
    if (!orgCaja || !/arca|afip/i.test(orgCaja.querySelector('.multiselect-single-label')?.textContent || '')) {
      r = await elegirEnLista('selectOrganismo', '2', { porValor: true })
      if (!r.ok) return r
    }
    r = await elegirEnLista('selectGrupoTipoPago', a.grupo)
    if (!r.ok) return r
    await dormir(700)
    r = await elegirEnLista('selectTipoPago', a.tipoPago)
    if (!r.ok) return r
    const sig = await esperar(() => boton('Siguiente'), 5000)
    if (!sig) return { ok: false, motivo: 'No encuentro el botón «Siguiente».' }
    clic(sig)
    const ok = await esperar(() => document.getElementById('ingresofields'), 15000)
    if (!ok) return { ok: false, motivo: mensajeError() || 'ARCA no pasó a «Datos del pago».' }
    return { ok: true }
  }

  // Etiquetas de las listas de «Datos del pago» (la extensión decide el valor de cada una).
  if (paso === 'etiquetas') {
    const form = await esperar(() => document.getElementById('ingresofields'), 15000)
    if (!form) return { ok: false, motivo: 'No encuentro «Datos del pago».' }
    await dormir(500)
    return { ok: true, listas: [...form.querySelectorAll('.e-form-group')].filter((g) => g.querySelector('input.multiselect-search')).map((g) => limpio(g.querySelector('label.form-label')?.textContent)) }
  }

  // Pantalla «Datos del pago»: se completa cada campo según su etiqueta; si aparece uno que no conocemos, se frena.
  if (paso === 'datosPago') {
    const form = await esperar(() => document.getElementById('ingresofields'), 15000)
    if (!form) return { ok: false, motivo: 'No encuentro «Datos del pago».' }
    await dormir(500)
    const grupos = [...form.querySelectorAll('.e-form-group')]
    const vistos = []
    let importeCargado = false
    for (const g of grupos) {
      const etiqueta = limpio(g.querySelector('label.form-label')?.textContent)
      const lista = g.querySelector('input.multiselect-search')
      const texto = g.querySelector('input.e-input')
      if (lista) {
        const f = a.campos.find((c) => norm(c.etiqueta) === norm(etiqueta))
        if (!f) return { ok: false, motivo: `ARCA pide un dato que no sé completar: «${etiqueta}». Cargalo a mano o avisame.`, vistos: grupos.map((x) => limpio(x.querySelector('label.form-label')?.textContent)) }
        const r = await elegirEnLista(lista.id, f.valor)
        if (!r.ok) return r
        vistos.push(`${etiqueta}=${f.valor}`)
      } else if (texto) {
        if (importeCargado) return { ok: false, motivo: `ARCA pide más de un importe («${etiqueta}»). No lo cargo para no equivocarme.` }
        const poner = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        texto.focus()
        poner.call(texto, a.importe)
        for (const t of ['input', 'change']) texto.dispatchEvent(new Event(t, { bubbles: true }))
        texto.dispatchEvent(new Event('blur', { bubbles: true }))
        await dormir(300)
        if (texto.value.replace(/\s/g, '') !== a.importe) return { ok: false, motivo: `El importe quedó «${texto.value}» en vez de «${a.importe}».` }
        importeCargado = true
        vistos.push(`${etiqueta}=${a.importe}`)
      }
    }
    if (!importeCargado) return { ok: false, motivo: 'No encontré el campo del importe.' }
    const sig = boton('Siguiente')
    if (!sig) return { ok: false, motivo: 'No encuentro el botón «Siguiente».' }
    clic(sig)
    const rev = await esperar(() => document.getElementById('GeneracionVep'), 15000)
    if (!rev) return { ok: false, motivo: mensajeError() || 'ARCA no pasó a la revisión del pago.' }
    return { ok: true, vistos }
  }

  // Revisión: el IMPORTE TOTAL tiene que ser exactamente el pedido; recién ahí se agrega a «VEPs a enviar».
  if (paso === 'revisar') {
    const rev = await esperar(() => document.getElementById('GeneracionVep'), 10000)
    if (!rev) return { ok: false, motivo: 'No encuentro la pantalla de revisión.' }
    const total = [...rev.querySelectorAll('li.bg-primary')].map((e) => limpio(e.textContent)).join(' ')
    const cuitMostrado = (limpio(rev.textContent).match(/CUIT\s*(\d{11})/) || [])[1] || ''
    if (!total.includes(a.importeVisible)) return { ok: false, motivo: `El total que muestra ARCA («${total}») no coincide con $ ${a.importeVisible}. No lo agrego.` }
    if (cuitMostrado && cuitMostrado !== a.cuit) return { ok: false, motivo: `ARCA muestra el CUIT ${cuitMostrado} y esperaba ${a.cuit}. No lo agrego.` }
    const sig = document.getElementById('botonSiguiente')
    if (!sig) return { ok: false, motivo: 'No encuentro el botón «Siguiente» de la revisión.' }
    clic(sig)
    return { ok: true }
  }

  // Tras agregar, vuelve la lista: tiene que aparecer la fila (mismo CUIT e importe).
  if (paso === 'verFila') {
    const fila = await esperar(() => [...document.querySelectorAll('.ag-center-cols-container .ag-row')].find((r) => {
      const c = limpio(r.querySelector('[col-id=contribuyenteCUIT]')?.textContent).replace(/\D/g, '')
      return c === a.cuit && limpio(r.textContent).replace(/ /g, ' ').includes(a.importeVisible)
    }), 20000)
    return fila ? { ok: true } : { ok: false, motivo: mensajeError() || 'No vi el VEP en «VEPs a enviar» después de agregarlo.' }
  }

  return { ok: false, motivo: `Paso desconocido: ${paso}` }
}
