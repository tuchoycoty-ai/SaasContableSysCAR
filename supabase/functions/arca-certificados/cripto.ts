// Utilidades de certificados para ARCA, SIN dependencias externas (solo WebCrypto).
// Genera clave + pedido de certificado (CSR), lee certificados X.509, verifica que un
// certificado corresponda a una clave privada y cifra/descifra la clave para guardarla.
// Nunca se escribe ni se registra material de claves.

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------- Base64 / PEM ----------
export function aBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
export function deBase64(t: string): Uint8Array {
  const s = atob(t.replace(/\s+/g, ''))
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}
export function derAPem(der: Uint8Array, etiqueta: string): string {
  const b64 = aBase64(der).replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${etiqueta}-----\n${b64}\n-----END ${etiqueta}-----\n`
}
// Devuelve la etiqueta y los bytes del primer bloque PEM del texto.
export function pemADer(texto: string): { etiqueta: string; der: Uint8Array } {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(texto)
  if (!m) throw new Error('El archivo no tiene formato PEM.')
  return { etiqueta: m[1], der: deBase64(m[2]) }
}

// ---------- DER minimo ----------
type Tlv = { tag: number; ini0: number; ini: number; fin: number }
function leer(b: Uint8Array, o: number): Tlv {
  if (o + 2 > b.length) throw new Error('Estructura DER inválida.')
  const tag = b[o]
  let l = b[o + 1]
  let p = o + 2
  if (l & 0x80) {
    const n = l & 0x7f
    if (n < 1 || n > 4) throw new Error('Estructura DER inválida.')
    l = 0
    for (let i = 0; i < n; i++) l = l * 256 + b[p++]
  }
  if (p + l > b.length) throw new Error('Estructura DER inválida.')
  return { tag, ini0: o, ini: p, fin: p + l }
}
function hijos(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = []
  let o = t.ini
  while (o < t.fin) {
    const x = leer(b, o)
    out.push(x)
    o = x.fin
  }
  return out
}
function largo(n: number): number[] {
  if (n < 128) return [n]
  const bytes: number[] = []
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256) }
  return [0x80 | bytes.length, ...bytes]
}
function tlv(tag: number, ...partes: Uint8Array[]): Uint8Array {
  const n = partes.reduce((s, p) => s + p.length, 0)
  const cab = [tag, ...largo(n)]
  const out = new Uint8Array(cab.length + n)
  out.set(cab)
  let o = cab.length
  for (const p of partes) { out.set(p, o); o += p.length }
  return out
}
function oid(texto: string): Uint8Array {
  const n = texto.split('.').map(Number)
  const bytes: number[] = [n[0] * 40 + n[1]]
  for (const x of n.slice(2)) {
    const grupo = [x & 0x7f]
    let v = x >>> 7
    while (v > 0) { grupo.unshift((v & 0x7f) | 0x80); v >>>= 7 }
    bytes.push(...grupo)
  }
  return tlv(0x06, new Uint8Array(bytes))
}
function oidTexto(b: Uint8Array, t: Tlv): string {
  const c = b.subarray(t.ini, t.fin)
  const partes = [Math.floor(c[0] / 40), c[0] % 40]
  let v = 0
  for (let i = 1; i < c.length; i++) {
    v = v * 128 + (c[i] & 0x7f)
    if (!(c[i] & 0x80)) { partes.push(v); v = 0 }
  }
  return partes.join('.')
}

const OID_NOMBRE: Record<string, string> = {
  '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber',
  '2.5.4.7': 'L', '2.5.4.8': 'ST',
}

function nombreATexto(b: Uint8Array, t: Tlv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const set of hijos(b, t)) {
    for (const par of hijos(b, set)) {
      const [o, v] = hijos(b, par)
      const clave = OID_NOMBRE[oidTexto(b, o)]
      if (clave) out[clave] = dec.decode(b.subarray(v.ini, v.fin))
    }
  }
  return out
}
function fecha(b: Uint8Array, t: Tlv): Date {
  const s = dec.decode(b.subarray(t.ini, t.fin))
  const largoAnio = t.tag === 0x17 ? 2 : 4
  let a = Number(s.slice(0, largoAnio))
  if (t.tag === 0x17) a += a >= 50 ? 1900 : 2000
  const r = s.slice(largoAnio)
  return new Date(Date.UTC(a, Number(r.slice(0, 2)) - 1, Number(r.slice(2, 4)), Number(r.slice(4, 6)), Number(r.slice(6, 8)), Number(r.slice(8, 10) || '0')))
}

// ---------- Certificado X.509 ----------
export type DatosCertificado = {
  sujeto: Record<string, string>
  emisor: Record<string, string>
  validoDesde: Date
  validoHasta: Date
  spki: Uint8Array
  huella: string
  cuit: string | null
}

export async function leerCertificado(textoPem: string): Promise<DatosCertificado> {
  const { etiqueta, der } = pemADer(textoPem)
  if (etiqueta !== 'CERTIFICATE') throw new Error('El archivo no es un certificado (.crt) en formato PEM.')
  const raiz = leer(der, 0)
  const [tbs] = hijos(der, raiz)
  const campos = hijos(der, tbs)
  const i = campos[0].tag === 0xa0 ? 1 : 0
  const emisor = nombreATexto(der, campos[i + 2])
  const [desde, hasta] = hijos(der, campos[i + 3])
  const sujeto = nombreATexto(der, campos[i + 4])
  const spkiTlv = campos[i + 5]
  const huella = [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))].map((x) => x.toString(16).padStart(2, '0')).join('')
  const m = /(\d{11})/.exec(sujeto.serialNumber ?? '')
  return {
    sujeto, emisor, validoDesde: fecha(der, desde), validoHasta: fecha(der, hasta),
    spki: der.slice(spkiTlv.ini0, spkiTlv.fin), huella, cuit: m ? m[1] : null,
  }
}

// ---------- Clave privada ----------
// Acepta PKCS#8 ("PRIVATE KEY") y PKCS#1 ("RSA PRIVATE KEY"). Las claves con contrasena se rechazan.
export function claveAPkcs8(textoPem: string): Uint8Array {
  if (/ENCRYPTED/.test(textoPem)) throw new Error('La clave tiene contraseña. Quitásela antes de subirla (openssl rsa -in clave.key -out clave-sin-clave.key).')
  const { etiqueta, der } = pemADer(textoPem)
  if (etiqueta === 'PRIVATE KEY') return der
  if (etiqueta === 'RSA PRIVATE KEY') {
    const algoritmo = tlv(0x30, oid('1.2.840.113549.1.1.1'), new Uint8Array([0x05, 0x00]))
    return tlv(0x30, new Uint8Array([0x02, 0x01, 0x00]), algoritmo, tlv(0x04, der))
  }
  throw new Error('El archivo no es una clave privada RSA en formato PEM.')
}

async function importarPrivada(pkcs8: Uint8Array): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign'])
  } catch {
    throw new Error('No se pudo leer la clave privada (debe ser RSA).')
  }
}

// ¿El certificado corresponde a esta clave? Se comparan modulo y exponente publicos.
export async function claveCorrespondeACertificado(pkcs8: Uint8Array, spki: Uint8Array): Promise<boolean> {
  const priv = await crypto.subtle.exportKey('jwk', await importarPrivada(pkcs8))
  const pub = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']))
  return priv.n === pub.n && priv.e === pub.e
}

// ---------- Generar clave y CSR ----------
const ASCII = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .,&'()_-]/g, '').trim()

function atributo(oidTxt: string, valor: string, tag: number): Uint8Array {
  return tlv(0x31, tlv(0x30, oid(oidTxt), tlv(tag, enc.encode(valor))))
}

export async function generarClaveYCsr(p: { cuit: string; organizacion: string; alias: string }): Promise<{ pkcs8: Uint8Array; csrPem: string }> {
  if (!/^\d{11}$/.test(p.cuit)) throw new Error('CUIT inválido.')
  const org = ASCII(p.organizacion).slice(0, 64)
  const alias = ASCII(p.alias).replace(/\s+/g, '').slice(0, 40) // ARCA no admite espacios en el alias
  if (!org || !alias) throw new Error('El nombre y el alias deben tener letras o números.')
  const par = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', par.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', par.privateKey))
  const sujeto = tlv(0x30,
    atributo('2.5.4.6', 'AR', 0x13), atributo('2.5.4.10', org, 0x0c),
    atributo('2.5.4.3', alias, 0x0c), atributo('2.5.4.5', `CUIT ${p.cuit}`, 0x13))
  const info = tlv(0x30, new Uint8Array([0x02, 0x01, 0x00]), sujeto, spki, new Uint8Array([0xa0, 0x00]))
  const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privateKey, info))
  const csr = tlv(0x30, info, tlv(0x30, oid('1.2.840.113549.1.1.11'), new Uint8Array([0x05, 0x00])),
    tlv(0x03, new Uint8Array([0x00]), firma))
  return { pkcs8, csrPem: derAPem(csr, 'CERTIFICATE REQUEST') }
}

// ---------- Cifrado para guardar la clave ----------
// El secreto maestro vive solo en los secretos de la Edge Function (nunca en la base ni en el repositorio).
async function claveMaestra(secreto: string): Promise<CryptoKey> {
  if (!secreto || secreto.length < 32) throw new Error('El secreto de cifrado no está configurado o es demasiado corto.')
  const base = await crypto.subtle.importKey('raw', enc.encode(secreto), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('syscar-arca-v1'), info: enc.encode('clave-privada') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function cifrar(secreto: string, pkcs8: Uint8Array, contexto: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(contexto) }, await claveMaestra(secreto), pkcs8))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return 'v1:' + aBase64(out)
}
export async function descifrar(secreto: string, texto: string, contexto: string): Promise<Uint8Array> {
  if (!texto.startsWith('v1:')) throw new Error('Formato de clave desconocido.')
  const b = deBase64(texto.slice(3))
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(contexto) }, await claveMaestra(secreto), b.slice(12)))
}
