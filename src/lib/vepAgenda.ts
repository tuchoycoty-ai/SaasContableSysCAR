// Agenda de VEP recurrentes: tipos, estados y armado del plan que lee la extensión.
export type TipoVep = 'ganancias_anticipo' | 'autonomo' | 'monotributo' | 'otro'
export type EstadoVep = 'pendiente' | 'listo' | 'cargado' | 'emitido' | 'pagado' | 'anulado'

export type VepProgramado = {
  id: string; client_id: string; tipo: TipoVep; grupo: string; tipo_pago: string; anio: number; mes: number | null; cuota: number | null
  importe: number | null; vence: string | null; estado: EstadoVep; nro_vep: string | null; pagado_en: string | null; notas: string | null
}

export const ESTADO_VEP: Record<EstadoVep, string> = {
  pendiente: 'Falta el importe', listo: 'Listo para cargar en ARCA', cargado: 'Cargado en ARCA', emitido: 'Emitido (falta pagar)', pagado: 'Pagado', anulado: 'Anulado',
}
export const TIPO_VEP: Record<TipoVep, string> = {
  ganancias_anticipo: 'Anticipo de Ganancias', autonomo: 'Autónomos', monotributo: 'Monotributo', otro: 'Otro',
}
// El «grupo» es el texto del primer desplegable de ARCA. El «tipo de pago» tiene que ser EXACTAMENTE el texto del segundo.
export const GRUPO_ARCA: Record<TipoVep, string> = { ganancias_anticipo: 'Ganancias', autonomo: 'Autonomo', monotributo: 'Monotributo', otro: '' }
// Tipos de pago verificados con pantallas reales de ARCA. Los que no figuran se escriben a mano (se copian de ARCA).
export const TIPOS_PAGO_CONOCIDOS: Record<TipoVep, string[]> = {
  ganancias_anticipo: ['Ganancias Personas Fisicas - Anticipo', 'Ganancias Sociedades - Anticipo'],
  autonomo: [],
  monotributo: ['Monotributo - Pago Mensual - Pers Fis - Nacional', 'Monotributo - Pago Ajustes'],
  otro: [],
}
export const USA_CUOTA = (t: TipoVep) => t === 'ganancias_anticipo'
export const USA_MES = (t: TipoVep) => t === 'autonomo' || t === 'monotributo'

export type Urgencia = 'vencido' | 'esta_semana' | 'proximo' | 'sin_fecha' | 'resuelto'
export function urgenciaDe(v: Pick<VepProgramado, 'estado' | 'vence'>, hoy: string): Urgencia {
  if (v.estado === 'pagado' || v.estado === 'anulado') return 'resuelto'
  if (!v.vence) return 'sin_fecha'
  if (v.vence < hoy) return 'vencido'
  const dias = Math.round((Date.parse(`${v.vence}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000)
  return dias <= 7 ? 'esta_semana' : 'proximo'
}

// Plan que se baja de SysCAR y se carga en la extensión (solo los VEP «listos», con importe).
export function armarPlan(items: (VepProgramado & { cuit: string; cliente: string })[]) {
  return {
    formato: 'syscar-vep', version: 1, generado: new Date().toISOString(),
    items: items.filter((v) => v.estado === 'listo' && v.importe != null).map((v) => ({
      id: v.id, cuit: v.cuit, cliente: v.cliente, tipo: v.tipo, grupo: v.grupo, tipoPago: v.tipo_pago,
      anio: v.anio, mes: v.mes, cuota: v.cuota, importe: v.importe, vence: v.vence,
    })),
  }
}

export function periodoTexto(v: Pick<VepProgramado, 'anio' | 'mes' | 'cuota'>): string {
  if (v.cuota != null) return `${v.anio} · anticipo ${v.cuota}`
  if (v.mes != null) return `${v.anio}-${String(v.mes).padStart(2, '0')}`
  return String(v.anio)
}
