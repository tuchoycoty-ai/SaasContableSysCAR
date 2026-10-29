export type Estudio = {
  id: string
  nombre: string
  cuit: string | null
  estado: 'activo' | 'suspendido'
  creado_en: string
}

export type Rol = { id: string; tenant_id: string; nombre: string; es_admin: boolean }

export type Permiso = { code: string; descripcion: string }

export type Miembro = { user_id: string; role_id: string; creado_en: string }

export type Perfil = { id: string; email: string | null; nombre: string | null }

export type Regimen = 'monotributo' | 'responsable_inscripto' | 'exento' | 'no_inscripto'

export type Cliente = {
  id: string
  tenant_id: string
  cuit: string
  razon_social: string
  regimen: Regimen | null
  categoria_monotributo: string | null
  activo: boolean
  notas: string | null
}

export type EstadoAutorizacion = 'pendiente' | 'vigente' | 'vencida' | 'revocada'

export type Autorizacion = {
  id: string
  tenant_id: string
  client_id: string
  estado: EstadoAutorizacion
  vigente_desde: string | null
  vigente_hasta: string | null
  observaciones: string | null
}

export type RegistroAuditoria = {
  id: number
  tenant_id: string | null
  actor_id: string | null
  accion: string
  objeto: string | null
  resultado: string
  detalle: Record<string, unknown>
  creado_en: string
}

export const REGIMEN_LABEL: Record<Regimen, string> = {
  monotributo: 'Monotributo',
  responsable_inscripto: 'Responsable inscripto',
  exento: 'Exento',
  no_inscripto: 'No inscripto',
}

export const CATEGORIAS_MONOTRIBUTO = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']

export type EstadoDato = 'confirmado' | 'importado' | 'pendiente_validacion'

export type LoteImportacion = {
  id: string
  tenant_id: string
  client_id: string
  tipo: 'comprobantes_emitidos' | 'comprobantes_recibidos' | 'pagos'
  archivo_nombre: string
  estado: 'importado' | 'validado' | 'anulado'
  filas_total: number
  filas_importadas: number
  filas_duplicadas: number
  filas_rechazadas: number
  filas_pendientes: number
  informe: { fila: number; tipo: 'rechazo' | 'duplicado'; motivo: string }[]
  creado_por: string
  creado_en: string
  validado_por: string | null
  validado_en: string | null
  anulado_por: string | null
  anulado_en: string | null
  motivo_anulacion: string | null
}

export type ClienteBasico = { id: string; cuit: string; razon_social: string }

export type OperacionTarea = {
  codigo: string
  modulo: string
  nombre: string
  descripcion: string
  disponible: boolean
  nota: string | null
}

export type EstadoEjecucion =
  | 'programada' | 'pendiente' | 'ejecutando' | 'completada' | 'completada_parcialmente' | 'fallida' | 'cancelada'

export type Tarea = {
  id: string
  tenant_id: string
  client_id: string
  operacion: string
  nombre: string
  frecuencia: 'manual' | 'una_vez' | 'diaria' | 'semanal' | 'mensual'
  dia: number | null
  hora: string
  modo: 'automatica' | 'manual' | 'ambas'
  periodo_regla: 'mes_anterior' | 'mes_actual'
  reintentos_max: number
  reintento_intervalo_min: number
  parametros: Record<string, unknown>
  activa: boolean
  proxima_ejecucion: string | null
  ultima_ejecucion: string | null
}

export type Ejecucion = {
  id: string
  task_id: string
  client_id: string
  estado: EstadoEjecucion
  disparador: 'manual' | 'automatico'
  iniciado_por: string | null
  origen_run_id: string | null
  periodo: string | null
  programada_para: string
  intento: number
  intentos_max: number
  proximo_intento: string | null
  iniciado_en: string | null
  finalizado_en: string | null
  resultado: Record<string, unknown> | null
  error: string | null
  creado_en: string
}

export type EventoEjecucion = { id: number; nivel: 'info' | 'aviso' | 'error'; mensaje: string; creado_en: string }

export type ItemAgenda = {
  id: string
  client_id: string
  tipo: 'vencimiento' | 'recordatorio' | 'control' | 'recategorizacion' | 'otro'
  titulo: string
  detalle: string | null
  fecha_limite: string | null
  prioridad: 'baja' | 'media' | 'alta'
  estado: 'pendiente' | 'hecho' | 'descartado'
  origen: 'manual' | 'tarea'
  creado_en: string
}

export const ESTADO_EJECUCION_LABEL: Record<EstadoEjecucion, string> = {
  programada: 'Programada',
  pendiente: 'Pendiente',
  ejecutando: 'Ejecutando',
  completada: 'Completada',
  completada_parcialmente: 'Completada parcialmente',
  fallida: 'Fallida',
  cancelada: 'Cancelada',
}
