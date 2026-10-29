import { leerCsv } from './csv'

export const MAX_BYTES = 5 * 1024 * 1024

export async function huella(buffer: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type Leido = { filas: unknown[][]; hash: string; nombre: string }

// Lee un CSV o un XLSX del navegador. El archivo nunca sale del equipo: solo se envian las filas
// validadas cuando el usuario confirma.
export async function leerArchivo(archivo: File): Promise<Leido> {
  if (archivo.size > MAX_BYTES) throw new Error('El archivo supera los 5 MB. Dividilo por períodos.')
  const nombre = archivo.name
  const buffer = await archivo.arrayBuffer()
  const hash = await huella(buffer)
  const ext = nombre.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv' || ext === 'txt') {
    let texto = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    // Los CSV de Windows suelen venir en latin1: si hay caracteres de reemplazo, se relee asi.
    if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(buffer)
    return { filas: leerCsv(texto), hash, nombre }
  }
  if (ext === 'xlsx') {
    const { default: leerXlsx } = await import('read-excel-file')
    const filas = (await leerXlsx(new Blob([buffer]))) as unknown[][]
    return { filas: filas.filter((f) => f.some((c) => c !== null && String(c).trim() !== '')), hash, nombre }
  }
  throw new Error('Formato no soportado. Subí un archivo .csv o .xlsx (si tenés .xls, guardalo como .xlsx).')
}
