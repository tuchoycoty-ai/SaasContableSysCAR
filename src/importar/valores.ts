// Conversion de celdas (texto, numero o fecha de Excel) a valores limpios.
// Formatos argentinos: 1.234,56 · 31/12/2026 · "1 - Factura A".

export function normalizar(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function textoCelda(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  return String(v).trim()
}

export function parseNumero(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).trim()
  if (s === '') return null
  let negativo = false
  if (/^\(.*\)$/.test(s)) {
    negativo = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[\s$]|ARS|USD|PES/gi, '')
  if (s.startsWith('-')) {
    negativo = !negativo
    s = s.slice(1)
  } else if (s.endsWith('-')) {
    negativo = !negativo
    s = s.slice(0, -1)
  }
  if (!/^[0-9.,]+$/.test(s) || s === '') return null
  const ultimaComa = s.lastIndexOf(',')
  const ultimoPunto = s.lastIndexOf('.')
  let limpio: string
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    // el ultimo separador es el decimal
    if (ultimaComa > ultimoPunto) limpio = s.replace(/\./g, '').replace(',', '.')
    else limpio = s.replace(/,/g, '')
  } else if (ultimaComa >= 0) {
    if ((s.match(/,/g) ?? []).length > 1) return null
    limpio = s.replace(',', '.')
  } else if (ultimoPunto >= 0) {
    // "1.234" o "1.234.567" => miles (convencion argentina); "12.5" => decimal
    limpio = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s
    if ((limpio.match(/\./g) ?? []).length > 1) return null
  } else limpio = s
  const n = Number(limpio)
  if (!Number.isFinite(n)) return null
  return negativo ? -n : n
}

export function parseEntero(v: unknown): number | null {
  const n = parseNumero(v)
  return n !== null && Number.isInteger(n) ? n : null
}

const TIPOS_POR_NOMBRE: Record<string, number> = {
  facturaa: 1, notadedebitoa: 2, notadecreditoa: 3, reciboa: 4,
  facturab: 6, notadedebitob: 7, notadecreditob: 8, reciboc: 15,
  facturac: 11, notadedebitoc: 12, notadecreditoc: 13,
  facturam: 51, notadedebitom: 52, notadecreditom: 53,
  facturae: 19, notadedebitoe: 20, notadecreditoe: 21,
  facturadecreditoelectronicamipymesfcea: 201,
}

// "1 - Factura A" -> 1 · "001" -> 1 · "Factura A" -> 1
export function parseTipoComprobante(v: unknown): number | null {
  const s = textoCelda(v)
  if (s === '') return null
  const m = s.match(/^\s*0*(\d{1,3})\b/)
  if (m) return Number(m[1])
  return TIPOS_POR_NOMBRE[normalizar(s)] ?? null
}

function fechaValida(a: number, m: number, d: number): string | null {
  if (a < 1900 || a > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const f = new Date(Date.UTC(a, m - 1, d))
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null
  return `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// Devuelve AAAA-MM-DD o null
export function parseFecha(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    // Segun la libreria, la fecha puede venir a medianoche UTC o a medianoche local.
    const utcExacto = v.getUTCHours() === 0 && v.getUTCMinutes() === 0
    return utcExacto
      ? fechaValida(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
      : fechaValida(v.getFullYear(), v.getMonth() + 1, v.getDate())
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      const f = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000)
      return fechaValida(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate())
    }
    v = String(v)
  }
  const s = String(v).trim().split(/[ T]/)[0]
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return fechaValida(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/)
  if (m) {
    let a = Number(m[3])
    if (m[3].length === 2) a += 2000
    return fechaValida(a, Number(m[2]), Number(m[1]))
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return fechaValida(Number(m[1]), Number(m[2]), Number(m[3]))
  return null
}

export function parseDocumento(v: unknown): string | null {
  const s = typeof v === 'number' ? String(Math.trunc(v)) : textoCelda(v)
  const d = s.replace(/\D/g, '')
  return d === '' ? null : d.slice(0, 11)
}
