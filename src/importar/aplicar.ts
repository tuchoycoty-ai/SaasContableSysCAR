// Guarda en la base lo que dice un PDF ya leido. Todo pasa por el SDK y por las reglas (RLS) del estudio.
import { supabase } from '../lib/supabase'
import { mensajeDb } from '../lib/utiles'
import type { PdfPreparado } from './preparar'

export async function aplicarPdf(estudioId: string, clienteId: string, yo: string, p: PdfPreparado): Promise<string> {
  const partes: string[] = []
  if (p.plan.pago) {
    const { error } = await supabase.rpc('confirmar_importacion', {
      p_tenant: estudioId, p_client: clienteId, p_tipo: 'pagos', p_archivo: p.nombre, p_hash: p.hash,
      p_filas: [{ fila: 1, ...p.plan.pago }], p_rechazos: [],
    })
    if (error) throw new Error(mensajeDb(error, 'No se pudo registrar el pago.'))
    partes.push('pago registrado')
  }
  const o = p.plan.obligacion
  if (o) {
    const { data: ex, error: e1 } = await supabase.from('obligaciones_cliente').select('id, estado, presentada_en')
      .eq('client_id', clienteId).eq('obligacion_codigo', o.codigo).eq('periodo', o.periodo).maybeSingle()
    if (e1) throw new Error(mensajeDb(e1, 'No se pudo consultar la obligación.'))
    if (ex && ex.estado === 'pagada' && o.estado === 'presentada') {
      partes.push('la obligación ya figuraba como pagada (no se modificó)')
    } else {
      const campos = o.estado === 'pagada'
        ? { estado: 'pagada', pagada_en: o.fecha, vep_numero: o.vepNumero ?? null, vep_monto: o.monto ?? null, monto: o.monto ?? null, notas: o.nota }
        : { estado: 'presentada', presentada_en: o.fecha, notas: o.nota }
      const r = ex
        ? await supabase.from('obligaciones_cliente').update(campos).eq('id', ex.id)
        : await supabase.from('obligaciones_cliente').insert({ tenant_id: estudioId, client_id: clienteId, obligacion_codigo: o.codigo, periodo: o.periodo, creado_por: yo, ...campos })
      if (r.error) throw new Error(mensajeDb(r.error, 'No se pudo actualizar la obligación (¿tenés el permiso «obligaciones.gestionar»?).'))
      partes.push(`obligación ${o.codigo} ${o.periodo}: ${o.estado}`)
    }
  }
  return partes.length ? partes.join(' · ') : 'sin cambios'
}
