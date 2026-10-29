// Lector de CSV propio (sin dependencias): detecta el separador, respeta comillas
// y celdas con saltos de linea, y quita el BOM que agrega Excel.
export function detectarSeparador(texto: string): string {
  const primeras = texto.split(/\r?\n/).slice(0, 5).join('\n')
  const candidatos = [';', ',', '\t', '|']
  let mejor = ';'
  let max = -1
  for (const c of candidatos) {
    const n = primeras.split(c).length - 1
    if (n > max) {
      max = n
      mejor = c
    }
  }
  return mejor
}

export function leerCsv(textoOriginal: string): unknown[][] {
  const texto = textoOriginal.replace(/^﻿/, '')
  const sep = detectarSeparador(texto)
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ''
  let entreComillas = false
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]
    if (entreComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          celda += '"'
          i++
        } else entreComillas = false
      } else celda += ch
    } else if (ch === '"') {
      entreComillas = true
    } else if (ch === sep) {
      fila.push(celda)
      celda = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ''
    } else celda += ch
  }
  if (celda !== '' || fila.length > 0) {
    fila.push(celda)
    filas.push(fila)
  }
  return filas.filter((f) => f.some((c) => c.trim() !== ''))
}
