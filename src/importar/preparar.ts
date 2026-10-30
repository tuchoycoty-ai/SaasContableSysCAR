// Prepara un archivo de ARCA para importarlo: CSV/XLSX de comprobantes o PDF de VEP / acuse de DJ.
import { detectarColumnas, encontrarEncabezado, camposDe, type TipoImportacion } from './columnas'
import { huella, leerArchivo } from './leer'
import { interpretarPdf, lineasDeItems, planDe, type AcuseDj, type Plan, type Vep } from './pdf'
import { validarFilas, type Resultado } from './validar'
import { normalizar } from './valores'
import { hoyLocal } from '../lib/utiles'

export type CsvPreparado = { kind: 'comprobantes'; tipo: TipoImportacion; nombre: string; hash: string; resultado: Resultado }
export type PdfPreparado = { kind: 'pdf'; nombre: string; hash: string; doc: Vep | AcuseDj; plan: Plan }
export type Preparado = CsvPreparado | PdfPreparado

export async function prepararComprobantes(archivo: File, tipo: TipoImportacion): Promise<CsvPreparado> {
  const l = await leerArchivo(archivo)
  const enc = encontrarEncabezado(l.filas, tipo)
  if (enc < 0) throw new Error('No reconocí los encabezados del archivo. Importalo a mano desde la solapa Importar.')
  const mapa = detectarColumnas(l.filas[enc], tipo)
  const faltan = camposDe(tipo).filter((c) => c.obligatorio && (mapa[c.id] ?? -1) < 0)
  if (faltan.length > 0) throw new Error(`Faltan columnas: ${faltan.map((c) => c.etiqueta).join(', ')}.`)
  const alicuotas = l.filas[enc].map((h, i) => (normalizar(h).startsWith('impnetogravadoiva') ? i : -1)).filter((i) => i >= 0)
  const resultado = validarFilas(tipo, l.filas.slice(enc + 1), mapa, enc + 2, hoyLocal(), alicuotas)
  return { kind: 'comprobantes', tipo, nombre: l.nombre, hash: l.hash, resultado }
}

export async function prepararPdf(archivo: File): Promise<PdfPreparado> {
  if (archivo.size > 2 * 1024 * 1024) throw new Error('El PDF es demasiado grande para ser un comprobante de ARCA.')
  const buffer = await archivo.arrayBuffer()
  const hash = await huella(buffer)
  const pdfjs = await import('pdfjs-dist')
  const trabajador = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = trabajador
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  if (pdf.numPages > 5) throw new Error('El PDF tiene demasiadas páginas para ser un comprobante de ARCA.')
  let items: { str: string; transform: number[] }[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const c = await (await pdf.getPage(p)).getTextContent()
    items = items.concat((c.items as { str?: string; transform?: number[] }[]).filter((i) => typeof i.str === 'string' && Array.isArray(i.transform)) as { str: string; transform: number[] }[])
  }
  const lectura = interpretarPdf(lineasDeItems(items))
  if (!lectura.ok) throw new Error(lectura.error)
  return { kind: 'pdf', nombre: archivo.name, hash, doc: lectura.doc, plan: planDe(lectura.doc) }
}
