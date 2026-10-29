// Lectura de la respuesta del padron de ARCA (ws_sr_constancia_inscripcion) y clasificacion de la
// condicion frente al IVA. Sin dependencias externas.

// ---------- XML minimo: devuelve objetos anidados; las etiquetas repetidas pasan a lista ----------
export type Nodo = { [k: string]: Nodo | Nodo[] | string }

function desescapar(t: string): string {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&')
}

export function leerXml(xml: string): Nodo {
  const raiz: Nodo = {}
  const pila: Nodo[] = [raiz]
  const nombres: string[] = []
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      pila.pop()
      nombres.pop()
    } else if (m[2] !== undefined) {
      const nombre = m[2].replace(/^.*:/, '') // se ignora el prefijo del espacio de nombres
      const nodo: Nodo = {}
      const padre = pila[pila.length - 1]
      const previo = padre[nombre]
      if (previo === undefined) padre[nombre] = nodo
      else if (Array.isArray(previo)) previo.push(nodo)
      else padre[nombre] = [previo as Nodo, nodo]
      if (m[4] !== '/') { pila.push(nodo); nombres.push(nombre) }
    } else if (m[5] !== undefined && m[5].trim()) {
      const actual = pila[pila.length - 1]
      actual['#text'] = ((actual['#text'] as string) ?? '') + desescapar(m[5].trim())
    }
  }
  return raiz
}

export const lista = (v: Nodo | Nodo[] | string | undefined): Nodo[] => (v === undefined || typeof v === 'string' ? [] : Array.isArray(v) ? v : [v])
export const texto = (v: Nodo | Nodo[] | string | undefined): string => {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return texto(v[0])
  return (v['#text'] as string) ?? ''
}
// Busca el primer nodo con ese nombre en cualquier nivel
export function buscar(n: Nodo, nombre: string): Nodo | undefined {
  for (const [k, v] of Object.entries(n)) {
    if (k === nombre) return Array.isArray(v) ? (v[0] as Nodo) : (v as Nodo)
    if (typeof v === 'object') {
      for (const hijo of lista(v as Nodo | Nodo[])) {
        const r = buscar(hijo, nombre)
        if (r) return r
      }
    }
  }
  return undefined
}

// ---------- Condicion frente al IVA ----------
export type Regimen = 'monotributo' | 'responsable_inscripto' | 'exento' | 'no_inscripto'
export type Clasificacion = { regimen: Regimen | null; motivo: string }

export function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Clasifica UN texto de condicion. Se evalua primero lo mas especifico: "IVA EXENTO" jamas puede
// caer en "IVA". Lo que no se reconoce devuelve regimen null (queda para revision, no se asume nada).
export function clasificarTextoIva(textoOriginal: string): Clasificacion {
  const t = normalizar(textoOriginal)
  if (!t) return { regimen: null, motivo: 'Sin dato de condición frente al IVA' }
  if (/\bEXENT[OA]\b/.test(t)) return { regimen: 'exento', motivo: 'IVA exento' }
  if (/\bMONOTRIBUT/.test(t) || /\bRESPONSABLE MONOTRIBUTO\b/.test(t)) return { regimen: 'monotributo', motivo: 'Monotributo' }
  if (/\bNO ALCANZAD[OA]\b/.test(t)) return { regimen: null, motivo: 'IVA no alcanzado: revisar' }
  if (/\bNO INSCRIPT[OA]\b/.test(t) || /\bNO RESPONSABLE\b/.test(t) || /\bCONSUMIDOR FINAL\b/.test(t)) return { regimen: 'no_inscripto', motivo: 'No inscripto' }
  if (/\bRESPONSABLE INSCRIPT[OA]\b/.test(t) || /^(IVA|IVA INSCRIPT[OA]|INSCRIPT[OA])$/.test(t)) return { regimen: 'responsable_inscripto', motivo: 'Responsable inscripto' }
  return { regimen: null, motivo: `Condición no reconocida («${textoOriginal.trim()}»): revisar` }
}

export type Impuesto = { id: string; descripcion: string; estado: string }
export type Persona = {
  cuit: string
  tipo_persona: string
  razon_social: string
  estado_clave: string
  domicilio: { direccion: string; localidad: string; cp: string; provincia: string } | null
  regimen: Regimen | null
  categoria_monotributo: string | null
  impuestos: Impuesto[]
  advertencias: string[]
}

export type Resultado = { encontrado: false; error: string } | { encontrado: true; persona: Persona }

// Interpreta la respuesta SOAP de getPersona_v2
export function interpretarPersona(xml: string): Resultado {
  const raiz = leerXml(xml)
  const ret = buscar(raiz, 'personaReturn')
  const errConst = ret ? buscar(ret, 'errorConstancia') : buscar(raiz, 'errorConstancia')
  if (errConst) {
    const msgs = lista(errConst.error).map(texto).filter(Boolean)
    return { encontrado: false, error: msgs.join(' ') || 'ARCA no devolvió datos para ese CUIT.' }
  }
  const dg = ret ? buscar(ret, 'datosGenerales') : undefined
  if (!ret || !dg) return { encontrado: false, error: 'ARCA no devolvió datos para ese CUIT.' }

  const advertencias: string[] = []
  const apellido = texto(dg.apellido)
  const nombre = texto(dg.nombre)
  const razon = texto(dg.razonSocial) || [apellido, nombre].filter(Boolean).join(' ')
  const dom = dg.domicilioFiscal as Nodo | undefined
  const rg = buscar(ret, 'datosRegimenGeneral')
  const mono = buscar(ret, 'datosMonotributo')

  const impuestos: Impuesto[] = []
  for (const bloque of [rg, mono]) {
    if (!bloque) continue
    for (const i of lista(bloque.impuesto)) impuestos.push({ id: texto(i.idImpuesto), descripcion: texto(i.descripcionImpuesto), estado: texto(i.estadoImpuesto) })
  }
  const activos = impuestos.filter((i) => i.estado === '' || i.estado === 'AC')

  // 1) Monotributo activo
  let regimen: Regimen | null = null
  let categoria: string | null = null
  const catNodo = mono ? (mono.categoriaMonotributo as Nodo | undefined) : undefined
  const esMono = Boolean(mono) && (activos.some((i) => clasificarTextoIva(i.descripcion).regimen === 'monotributo') || Boolean(catNodo))
  if (esMono) {
    regimen = 'monotributo'
    // ARCA puede informar la categoria como letra en el id o al inicio de la descripcion («B - Locaciones...»);
    // si el id es un numero, se ignora y se usa la descripcion.
    const candidatos = [texto(catNodo?.idCategoria), texto(catNodo?.descripcionCategoria), ...activos.map((i) => i.descripcion)]
    let letra = ''
    for (const c of candidatos) {
      const n = normalizar(c)
      const m = /^([A-K])$/.exec(n) ?? /^([A-K]) /.exec(n) ?? /\bCATEGORIA ([A-K])\b/.exec(n)
      if (m) { letra = m[1]; break }
    }
    categoria = letra || null
    if (!categoria) advertencias.push('Es monotributista pero ARCA no informó una categoría reconocible (id «' + texto(catNodo?.idCategoria) + '», descripción «' + texto(catNodo?.descripcionCategoria) + '»): cargala a mano.')
  } else {
    // 2) Regimen general: se clasifica el texto de cada impuesto activo que sea de IVA
    const deIva = activos.filter((i) => /\bIVA\b/.test(normalizar(i.descripcion)))
    const resultados = deIva.map((i) => clasificarTextoIva(i.descripcion))
    const distintos = new Set(resultados.map((r) => r.regimen ?? 'revisar'))
    if (deIva.length === 0) {
      regimen = 'no_inscripto'
      advertencias.push('ARCA no informa IVA ni monotributo activos para este CUIT: se cargó como «No inscripto». Verificalo.')
    } else if (distintos.size > 1 || distintos.has('revisar')) {
      regimen = null
      advertencias.push('La condición frente al IVA no es clara (' + deIva.map((i) => i.descripcion).join(', ') + '): elegila a mano.')
    } else {
      regimen = resultados[0].regimen
    }
  }
  if (texto(dg.estadoClave) && texto(dg.estadoClave) !== 'ACTIVO') advertencias.push(`La clave fiscal figura como «${texto(dg.estadoClave)}».`)

  return {
    encontrado: true,
    persona: {
      cuit: texto(dg.idPersona), tipo_persona: texto(dg.tipoPersona), razon_social: razon, estado_clave: texto(dg.estadoClave),
      domicilio: dom ? { direccion: texto(dom.direccion), localidad: texto(dom.localidad), cp: texto(dom.codPostal), provincia: texto(dom.descripcionProvincia) } : null,
      regimen, categoria_monotributo: categoria, impuestos, advertencias,
    },
  }
}
