import type { Autorizacion, EstadoAutorizacion } from './types'

export function soloDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

// Mismo calculo (modulo 11) que la base de datos: la base es la que manda,
// esto solo evita ir al servidor con un CUIT mal tipeado.
export function cuitValido(v: string): boolean {
  const d = soloDigitos(v)
  if (d.length !== 11) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let suma = 0
  for (let i = 0; i < 10; i++) suma += Number(d[i]) * pesos[i]
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) return false
  return dv === Number(d[10])
}

export function formatoCuit(v: string): string {
  const d = soloDigitos(v)
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : v
}

// Fecha de hoy en hora local, formato AAAA-MM-DD
export function hoyLocal(): string {
  return new Date().toLocaleDateString('sv-SE')
}

export function fechaCorta(iso: string | null): string {
  if (!iso) return '—'
  const [a, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${a}`
}

export function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

// Una autorizacion "vigente" con fecha de fin pasada se muestra como vencida.
export function estadoEfectivo(a: Autorizacion): EstadoAutorizacion {
  if (a.estado === 'vigente' && a.vigente_hasta && a.vigente_hasta < hoyLocal()) return 'vencida'
  return a.estado
}

export function estadoDelCliente(auts: Autorizacion[]): EstadoAutorizacion | 'sin_autorizacion' {
  if (auts.length === 0) return 'sin_autorizacion'
  const estados = auts.map(estadoEfectivo)
  for (const e of ['vigente', 'pendiente', 'vencida', 'revocada'] as const) {
    if (estados.includes(e)) return e
  }
  return 'sin_autorizacion'
}

export const ESTADO_LABEL: Record<EstadoAutorizacion | 'sin_autorizacion', string> = {
  vigente: 'Vigente',
  pendiente: 'Pendiente',
  vencida: 'Vencida',
  revocada: 'Revocada',
  sin_autorizacion: 'Sin autorización',
}

export function mensajeDb(error: { code?: string; message?: string }, porDefecto: string): string {
  switch (error.code) {
    case '23505':
      return 'Ya existe un registro con esos datos.'
    case '23514':
      return 'Hay un dato inválido. Revisá el CUIT y los demás campos.'
    case '42501':
      return 'No tenés permiso para hacer esto.'
    case 'P0001':
      return error.message ?? porDefecto
    default:
      return porDefecto
  }
}

// Las funciones de servidor devuelven { error: "texto" } con el motivo.
export async function mensajeDeFuncion(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const cuerpo = (await ctx.json()) as { error?: unknown }
      if (typeof cuerpo.error === 'string') return cuerpo.error
    } catch {
      /* se usa el mensaje general */
    }
  }
  return 'No se pudo completar la operación.'
}
