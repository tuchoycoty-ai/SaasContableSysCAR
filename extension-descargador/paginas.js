// Funciones que se ejecutan DENTRO de las páginas de «Mis Comprobantes» (cada una es autónoma: no usa nada de afuera).
// Solo leen y hacen los mismos clics que haría una persona. No tocan claves ni cookies.

// Pantalla «Elegí una persona para ingresar»: devuelve el CUIT del usuario y las personas que puede representar.
export function leerPersonas() {
  const dig = (s) => String(s).replace(/\D/g, '')
  const cab = document.querySelector('#usernav')
  const cuits = [...((cab && cab.textContent) || '').matchAll(/\[(\d{2}-\d{8}-\d)\]/g)].map((m) => dig(m[1]))
  const vistas = new Map()
  for (const a of document.querySelectorAll('a[onclick*="idcontribuyente"]')) {
    const m = (a.getAttribute('onclick') || '').match(/value\s*=\s*'(\d+)'/)
    if (!m) continue
    const texto = (a.textContent || '').replace(/\s+/g, ' ').trim()
    const c = texto.match(/(\d{2}-\d{8}-\d)/)
    if (!c) continue
    if (!vistas.has(m[1])) vistas.set(m[1], { id: m[1], nombre: texto.replace(c[1], '').trim(), cuit: dig(c[1]) })
  }
  return { usuario: cuits[0] || null, personas: [...vistas.values()] }
}

// CUIT de la persona con la que se está trabajando (la representada, o el propio usuario si no representa a nadie).
export function leerPersonaActiva() {
  const cab = document.querySelector('#usernav')
  const cuits = [...((cab && cab.textContent) || '').matchAll(/\[(\d{2}-\d{8}-\d)\]/g)].map((m) => m[1].replace(/\D/g, ''))
  return cuits.length ? cuits[cuits.length - 1] : null
}

// Carga el rango de fechas en el calendario de ARCA y verifica que haya quedado cargado.
export function prepararBusqueda(desde, hasta) {
  const quiero = `${desde} - ${hasta}`
  const inp = document.getElementById('fechaEmision')
  if (!inp) return { ok: false, motivo: 'No encuentro el campo de fecha (ARCA puede haber cambiado la página).' }
  const jq = window.jQuery
  const dpDe = () => { try { return jq ? jq(inp).data('daterangepicker') : null } catch (e) { return null } }
  try {
    const dp = dpDe()
    if (dp) {
      dp.setStartDate(desde)
      dp.setEndDate(hasta)
      if (typeof dp.clickApply === 'function') dp.clickApply()
      else if (typeof dp.updateElement === 'function') dp.updateElement()
    }
  } catch (e) { /* se prueba el plan B */ }
  if (inp.value.trim() !== quiero) {
    const poner = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    poner.call(inp, quiero)
    for (const t of ['input', 'change', 'keyup', 'blur']) inp.dispatchEvent(new Event(t, { bubbles: true }))
    try { const dp = dpDe(); if (dp) { dp.setStartDate(desde); dp.setEndDate(hasta) } } catch (e) { /* nada */ }
  }
  const dp = dpDe()
  const internoOk = !dp || (dp.startDate && dp.endDate && dp.startDate.format('DD/MM/YYYY') === desde && dp.endDate.format('DD/MM/YYYY') === hasta)
  const ok = inp.value.trim() === quiero && !!internoOk
  return { ok, valor: inp.value, motivo: ok ? null : `El calendario quedó con «${inp.value}» en vez de «${quiero}».` }
}

// Toca «Buscar» y espera el resultado: { estado: 'listo' | 'vacio' | 'error' | 'tiempo', n, msg }
export async function buscarYEsperar(timeoutMs) {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
  const boton = document.getElementById('buscarComprobantes')
  if (!boton) return { estado: 'error', msg: 'No encuentro el botón Buscar.' }
  boton.click()
  const fin = Date.now() + timeoutMs
  await espera(1500)
  while (Date.now() < fin) {
    const info = document.getElementById('tablaDataTables_info')
    const excel = document.querySelector('button.buttons-excel')
    const m = info && info.textContent.match(/de un total de\s+([\d.]+)/)
    if (m && visible(excel)) {
      const n = Number(m[1].replace(/\./g, ''))
      return { estado: n > 0 ? 'listo' : 'vacio', n }
    }
    const msg = [...document.querySelectorAll('.modal.in .modal-body, .bootstrap-dialog-message, .alert')]
      .filter(visible).map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')
    if (msg) {
      if (/no se encontr|sin resultado|no hay|no existen|0 registros/i.test(msg)) return { estado: 'vacio', n: 0, msg }
      if (/error|inconveniente|no pudo|nuevamente|sesi[oó]n/i.test(msg)) return { estado: 'error', msg }
    }
    await espera(500)
  }
  return { estado: 'tiempo', msg: 'La búsqueda no respondió a tiempo.' }
}

// Toca el botón «Excel» de la tabla de resultados.
export function clickExcel() {
  const b = document.querySelector('button.buttons-excel')
  if (!b) return false
  b.click()
  return true
}
