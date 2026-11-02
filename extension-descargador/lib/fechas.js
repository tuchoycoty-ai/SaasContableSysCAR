// Funciones puras de fechas y nombres de archivo (se prueban sin navegador).
export const pad = (n) => String(n).padStart(2, '0')
export const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
export const ultimoDia = (a, m) => new Date(a, m, 0).getDate() // m = 1..12

// Mes anterior al de «hoy»: { a: año, m: 1..12 }
export function mesAnterior(hoy = new Date()) {
  const m0 = hoy.getMonth() // 0..11 => numero del mes anterior (1..12), salvo enero
  return m0 === 0 ? { a: hoy.getFullYear() - 1, m: 12 } : { a: hoy.getFullYear(), m: m0 }
}

export const mesATexto = (x) => `${x.a}-${pad(x.m)}` // {a:2026,m:10} -> "2026-10"
export function textoAMes(t) {
  const r = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(t || ''))
  return r ? { a: Number(r[1]), m: Number(r[2]) } : null
}
const indice = (x) => x.a * 12 + (x.m - 1)

// Rangos de fechas a consultar. ARCA permite como maximo 365 dias por consulta y los datos llegan hasta ayer.
// opciones: { desde:{a,m}, hasta:{a,m}, unoPorMes:boolean, hoy:Date }
export function rangosDe({ desde, hasta, unoPorMes, hoy = new Date() }) {
  if (!desde || !hasta) return { error: 'Elegí el mes desde y el mes hasta.' }
  if (indice(desde) > indice(hasta)) return { error: 'El mes «desde» no puede ser posterior al mes «hasta».' }
  if (indice(hasta) - indice(desde) + 1 > 12) return { error: 'Elegí como máximo 12 meses por vez.' }
  const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1)
  const tramos = []
  const primero = (x) => new Date(x.a, x.m - 1, 1)
  const ultimo = (x) => new Date(x.a, x.m - 1, ultimoDia(x.a, x.m))
  const recorte = (ini, fin) => (fin > ayer ? { ini, fin: ayer } : { ini, fin })
  if (unoPorMes) {
    for (let i = indice(desde); i <= indice(hasta); i++) {
      const x = { a: Math.floor(i / 12), m: (i % 12) + 1 }
      tramos.push({ ...recorte(primero(x), ultimo(x)), etiqueta: mesATexto(x) })
    }
  } else {
    const etiqueta = indice(desde) === indice(hasta) ? mesATexto(desde) : `${mesATexto(desde)}_${mesATexto(hasta)}`
    tramos.push({ ...recorte(primero(desde), ultimo(hasta)), etiqueta })
  }
  const validos = tramos.filter((t) => t.fin >= t.ini)
  if (validos.length === 0) return { error: 'Ese período todavía no tiene datos disponibles (ARCA publica hasta ayer).' }
  for (const t of validos) {
    if ((t.fin - t.ini) / 86400000 + 1 > 365) return { error: 'ARCA permite consultar como máximo 365 días por vez. Acortá el período.' }
  }
  return { rangos: validos.map((t) => ({ desde: fmt(t.ini), hasta: fmt(t.fin), etiqueta: t.etiqueta })) }
}

// Ruta (relativa a «Descargas») con el CUIT dentro del nombre: SysCAR lo reconoce por esos 11 digitos.
export function nombreArchivo(tipo, cuit, etiqueta) {
  const c = String(cuit).replace(/\D/g, '')
  if (c.length !== 11) throw new Error('CUIT inválido para el nombre del archivo')
  return `SysCAR/${tipo}/Mis_Comprobantes_${tipo}_-_CUIT_${c}_${etiqueta}.xlsx`
}

// Orden: cliente -> tipo -> periodo (se cambia de cliente la menor cantidad de veces).
export function construirCola(personas, tipos, rangos) {
  const cola = []
  for (const p of personas) for (const tipo of tipos) for (const r of rangos) {
    cola.push({ personaId: p.id, persona: p.nombre, cuit: p.cuit, tipo, desde: r.desde, hasta: r.hasta, etiqueta: r.etiqueta })
  }
  return cola
}
