import { useMemo, useState } from 'react'

type Seccion = { id: string; titulo: string; quien: string; resumen: string; pasos: string[]; notas?: string[] }

// Manual de usuario. Describe lo que la aplicación hace de verdad hoy; lo que todavía no existe se indica como tal.
const SECCIONES: Seccion[] = [
  {
    id: 'inicio', titulo: 'Primeros pasos: ingresar y definir tu contraseña', quien: 'Todos',
    resumen: 'Cómo entrar a SysCAR por primera vez y en los ingresos siguientes.',
    pasos: [
      'El administrador de tu estudio te invita desde la solapa Usuarios y te pasa un enlace de acceso (es personal y de un solo uso).',
      'Abrí el enlace. La primera vez te pide que definas tu contraseña: escribila dos veces y tocá «Guardar y entrar».',
      'Para los ingresos siguientes entrá a la dirección de SysCAR, escribí tu correo y tu contraseña y tocá «Ingresar».',
      'Si tenés varios estudios, elegí el que querés usar en el selector «Estudio» de la parte de arriba. Todo lo que ves cambia según el estudio elegido.',
      'Para salir, usá el botón «Salir» (arriba a la derecha).',
    ],
    notas: ['Si perdiste el enlace o no podés entrar, pedile al administrador de tu estudio un «Nuevo enlace de acceso» (solapa Usuarios).', 'Cada persona ve solo las solapas que su rol le permite: si falta alguna, es normal.'],
  },
  {
    id: 'tablero', titulo: 'Tablero', quien: 'Miembros del estudio',
    resumen: 'Resumen de un cliente en un rango de meses: facturado, compras, IVA, pagos y avisos.',
    pasos: [
      'Elegí el cliente y el rango «Desde / Hasta» (por defecto, los últimos 12 meses).',
      'Revisá las tarjetas: posición de IVA estimada (débito menos crédito), cantidad de comprobantes emitidos, recibidos y pagos registrados.',
      'En «Importes por estado» ves los montos separados en confirmado, importado y pendiente de validación.',
      'En «Evolución mensual» ves las barras de ingresos y egresos por mes.',
      'En «Tareas y avisos» ves cuántas ejecuciones hubo en los últimos 30 días y cuántos avisos pendientes o vencidos tiene el cliente.',
    ],
    notas: ['El tablero solo muestra lo que está importado. Si aparece vacío, cargá los datos desde Importar o Carpetas ARCA.', 'La posición de IVA es una estimación: no considera saldos anteriores, percepciones ni retenciones.', 'Las notas de crédito restan.'],
  },
  {
    id: 'clientes', titulo: 'Clientes', quien: 'Miembros (editar: administrador o permiso «Modificar clientes»)',
    resumen: 'Alta, búsqueda y ficha de los clientes del estudio.',
    pasos: [
      'Buscá por CUIT o razón social con el cuadro de búsqueda. Tocá «Abrir» para ver la ficha.',
      'Para agregar un cliente, completá el formulario «Agregar cliente»: escribí el CUIT (con o sin guiones).',
      'Tocá «Completar con datos de ARCA»: el sistema consulta la constancia de inscripción y completa razón social, régimen y categoría de monotributo. Mostrará además domicilio, impuestos y advertencias.',
      'Revisá lo que completó. Si ARCA no informa la categoría de un monotributista, elegila a mano (el campo Categoría solo se habilita si el régimen es monotributo).',
      'Tocá «Guardar cliente».',
      'En la ficha podés cambiar los datos fiscales, marcar el cliente como activo o no, registrar la autorización del cliente (vigente, pendiente o revocada, con fechas y observaciones) y elegir qué usuarios pueden ver este cliente.',
    ],
    notas: [
      'La consulta a ARCA requiere un certificado activo del estudio (ver «Certificados ARCA»).',
      'Los administradores ven todos los clientes; el resto de los usuarios ve solo los que tiene asignados.',
      'Borrar un cliente borra todo lo que depende de él. Hacelo solo si es necesario.',
      'Régimen: monotributo, responsable inscripto, exento o no inscripto. «Exento» e «IVA» no son lo mismo: el sistema los distingue.',
    ],
  },
  {
    id: 'importar', titulo: 'Importar comprobantes y pagos', quien: 'Permiso «Importar archivos» o administrador',
    resumen: 'Carga a mano de un archivo CSV o Excel con vista previa y confirmación.',
    pasos: [
      'En ARCA («Mis Comprobantes») descargá el archivo de emitidos o recibidos en CSV o Excel.',
      'En SysCAR, entrá a Importar, elegí el cliente y el tipo (comprobantes emitidos, recibidos o pagos de impuestos).',
      'Elegí el archivo. El sistema lo lee en tu navegador (no se sube) y reconoce las columnas. Si alguna no se reconoce, indicala a mano en el paso 1.',
      'Revisá la vista previa (paso 2): filas nuevas, repetidas dentro del archivo, repetidas contra lo ya cargado y rechazadas por errores.',
      'Si hay filas omitidas, tocá «Descargar informe de filas omitidas» para ver el motivo de cada una.',
      'En el paso 3 tocá «Confirmar». Los datos quedan guardados como «importados».',
      'En el «Historial de importaciones» podés abrir el «Detalle» de cada lote, «Validar» (lo confirma una persona) o «Anular» (con un motivo) si te equivocaste de cliente o de archivo.',
    ],
    notas: [
      'Las notas de crédito se guardan en negativo. Una factura C sin desglose de IVA se toma como importe sin IVA.',
      'Si el total no coincide con la suma de netos, IVA y otros tributos, el comprobante queda «pendiente de validación» con una advertencia.',
      'Un mismo archivo no se puede importar dos veces. Si anulás un lote, el archivo se puede volver a importar.',
      'Máximo 5 MB y 5000 filas por archivo: si es más grande, dividilo por períodos.',
      'Podés bajar una plantilla de ejemplo desde la misma pantalla.',
    ],
  },
  {
    id: 'carpetas', titulo: 'Carpetas ARCA', quien: 'Permiso «Importar archivos» o administrador',
    resumen: 'Dejás los archivos de ARCA en carpetas de tu computadora y SysCAR los detecta.',
    pasos: [
      'Usá Chrome o Edge en una computadora de escritorio (otros navegadores no permiten elegir carpetas).',
      'Creá en tu computadora una carpeta para cada acción: emitidos, recibidos y DDJJ/VEP.',
      'En Carpetas ARCA tocá «Elegir carpeta» en cada acción y dale permiso al navegador. Solo hace falta una vez por carpeta.',
      'Guardá ahí los archivos que bajás de ARCA: CSV o Excel de comprobantes en las dos primeras, y PDF de VEP pagados y acuses de DDJJ en la tercera.',
      'Con esta pantalla abierta, SysCAR revisa las carpetas cada minuto («Buscar ahora» fuerza la revisión). Los archivos nuevos aparecen en la lista.',
      'Revisá cada fila: qué es, a qué cliente corresponde y su estado. Tocá «Confirmar» (o «Confirmar todos los listos»). Con «Ignorar» lo descartás.',
    ],
    notas: [
      'El cliente se identifica por el CUIT que figura en el nombre del archivo de ARCA (CSV) o dentro del PDF. Si no coincide con ninguno de tus clientes, queda marcado para revisar.',
      'PDF de VEP pagado: se registra el pago. Si es un VEP de SICOSS, además deja pagada la obligación F.931 de ese período.',
      'PDF de acuse de DDJJ: F.931 y F.2002 (IVA) dejan la obligación como «presentada». Otros formularios se reconocen pero no se guarda nada.',
      'Funciona solo con la pantalla abierta. Si el navegador pide «Autorizar» de nuevo la carpeta, tocá ese botón.',
      'Los archivos no se suben: se leen en tu navegador y solo se guardan los datos que confirmás.',
    ],
  },
  {
    id: 'tareas', titulo: 'Tareas', quien: 'Ver: miembros. Crear y ejecutar: permiso «Gestionar tareas» o administrador',
    resumen: 'Controles automáticos o manuales que generan avisos en la Agenda.',
    pasos: [
      'En «Nueva tarea» elegí el cliente y la operación. Las operaciones marcadas «pendiente de integración» todavía no se pueden programar.',
      'Elegí la frecuencia (manual, diaria, semanal, mensual o una vez), el día y la hora, el modo («Automática y manual» o «Solo automática») y el período que analiza («Mes anterior» o «Mes en curso»).',
      'Si corresponde, ajustá los reintentos y el intervalo entre reintentos. Tocá «Crear tarea».',
      'En «Tareas configuradas» ves la próxima y la última ejecución. Podés ejecutarla ahora, pausarla o reanudarla.',
      'En el «Historial de ejecuciones» tocá «Detalle» para ver paso a paso qué hizo. Si falló, podés «Relanzar»; si está esperando un reintento, podés «Cancelar».',
    ],
    notas: [
      'Operaciones disponibles: control de carga de comprobantes, control de IVA, recordatorio de vencimiento, control de obligaciones (vencimientos próximos y vencidos) y revisión de recategorización.',
      'Las tareas automáticas se ejecutan solas en el horario indicado, aunque no tengas la aplicación abierta.',
      'Si hay una falla temporal, el sistema reintenta. Si la configuración es inválida, falla sin reintentar y te lo explica en el detalle.',
      'Una ejecución completada «parcialmente» significa que faltaron datos (por ejemplo, no había comprobantes de un tipo).',
    ],
  },
  {
    id: 'agenda', titulo: 'Agenda', quien: 'Ver: miembros. Cargar y resolver: permiso «Gestionar tareas» o administrador',
    resumen: 'Vencimientos, recordatorios y controles pendientes de tus clientes.',
    pasos: [
      'Para agregar un aviso: escribí el título, elegí el cliente, la fecha límite, el tipo (recordatorio, vencimiento, control u otro) y la prioridad. Tocá «Agregar».',
      'Cada aviso muestra su fecha, cliente, tipo, prioridad y origen («Manual» o «Tarea automática»). Los vencidos aparecen marcados.',
      'Tocá «Hecho» cuando lo resolviste, «Descartar» si no corresponde, o «Reabrir» para volver a dejarlo pendiente.',
      'Con «Mostrar también resueltos» ves los ya cerrados.',
      'Podés borrar los avisos manuales. Los que generó una tarea no se borran (se resuelven).',
    ],
  },
  {
    id: 'obligaciones', titulo: 'Obligaciones (DDJJ y VEP)', quien: 'Ver: miembros. Registrar: permiso «Gestionar obligaciones» o administrador',
    resumen: 'Seguimiento mes a mes de las presentaciones y pagos de cada cliente.',
    pasos: [
      'Elegí el período (mes).',
      'Tocá «Generar obligaciones del período»: se crean las que corresponden según el régimen de cada cliente (IVA para responsables inscriptos, cuota para monotributistas). El F.931 se registra a mano o desde un PDF en Carpetas ARCA.',
      'En cada fila ves el vencimiento según el calendario, el estado y los datos del VEP.',
      'Tocá «Registrar» para actualizar: estado (pendiente, presentada, pagada, no corresponde), monto, número de VEP, monto y vencimiento del VEP. Guardá con «Guardar».',
    ],
    notas: [
      'SysCAR NO presenta DDJJ ni genera VEP en ARCA: no existe un servicio público para eso. Acá registrás lo que hiciste en ARCA, o lo cargás leyendo los PDF.',
      'Si la fila dice «Sin fecha en el calendario», el holding todavía no cargó ese vencimiento.',
    ],
  },
  {
    id: 'recategorizacion', titulo: 'Recategorización de monotributo', quien: 'Miembros',
    resumen: 'Estima cuánto del tope de su categoría usó un monotributista.',
    pasos: [
      'Elegí un cliente monotributista y tocá «Calcular».',
      'Se suman los comprobantes emitidos de los últimos 12 meses completos (las notas de crédito restan).',
      'Leé el resultado: ingresos, categoría actual, tope, porcentaje de uso y categoría sugerida por ingresos.',
      'Revisá las advertencias (meses sin comprobantes, comprobantes sin confirmar, escala sin verificar).',
    ],
    notas: ['Solo evalúa el tope de ingresos. No contempla superficie, energía, alquileres ni precio máximo unitario. La decisión final es del profesional.', 'Depende de que los comprobantes estén importados y de la escala vigente cargada por el holding.'],
  },
  {
    id: 'reportes', titulo: 'Reportes y análisis financiero', quien: 'Miembros',
    resumen: 'Análisis por cliente o de toda la cartera, descargable e imprimible.',
    pasos: [
      'Elegí el alcance («Toda la cartera» o un cliente) y el rango de meses.',
      'Cartera: tabla con facturado, compras, resultado, posición de IVA, cantidad de comprobantes, sin confirmar y obligaciones pendientes de cada cliente.',
      'Un cliente: indicadores (ventas, compras, resultado y margen, impuestos pagados y carga sobre ventas), evolución mensual con variación, y principales clientes y proveedores con su porcentaje.',
      'Tocá «Descargar CSV» para llevarlo a Excel o «Imprimir / guardar PDF» para el informe.',
    ],
    notas: ['Son estimaciones sobre los comprobantes importados: el «resultado» (ventas menos compras) no es un balance, y la posición de IVA no es una liquidación.', 'Se avisa si un cliente o proveedor concentra más de la mitad del total.'],
  },
  {
    id: 'usuarios', titulo: 'Usuarios', quien: 'Administrador del estudio (y holding)',
    resumen: 'Invitar personas, asignarles un rol y darles acceso.',
    pasos: [
      'En «Invitar a una persona» escribí el correo, elegí el rol y tocá «Invitar».',
      'Se muestra un enlace de acceso: tocá «Copiar enlace» y pasáselo solo a esa persona (es personal y de un solo uso).',
      'Si alguien lo perdió, tocá «Nuevo enlace de acceso» en su fila. Para sacar a alguien del estudio, «Quitar».',
      'Para que un usuario que no es administrador vea ciertos clientes, asignalos desde la ficha del cliente («Quién puede ver este cliente»).',
    ],
    notas: ['No se puede quitar al último administrador de un estudio.'],
  },
  {
    id: 'roles', titulo: 'Roles y permisos', quien: 'Administrador del estudio (y holding)',
    resumen: 'Definí qué puede hacer cada tipo de usuario.',
    pasos: [
      'En «Crear rol» escribí un nombre y tocá «Crear rol».',
      'Tildá los permisos que tendrá el rol: Modificar clientes, Importar archivos, Gestionar tareas y agenda, Gestionar obligaciones. «Todos los permisos» corresponde al administrador.',
      'Para cambiar un rol, tildá o destildá sus permisos. Un rol con usuarios no se puede borrar.',
    ],
    notas: ['Rol «Contador» por defecto: modificar clientes, importar, tareas y (en estudios nuevos) obligaciones. «Asistente»: solo consulta.', 'Los usuarios que no son administradores solo ven los clientes que se les asignan.'],
  },
  {
    id: 'certificados', titulo: 'Certificados ARCA', quien: 'Administrador del estudio (y holding)',
    resumen: 'Conexión segura del estudio con los servicios de ARCA.',
    pasos: [
      'Opción A, ya tenés el certificado: en «Ya tengo el certificado (.crt) y la clave (.key)» cargá ambos archivos (deben ser el par que se creó junto; la clave sin contraseña) y tocá «Verificar y guardar».',
      'Opción B, estudio nuevo: en «Generar clave y pedido de certificado (CSR)» completá el CUIT, el nombre y un alias y tocá «Generar clave y pedido». Descargá el .csr.',
      'En ARCA, con clave fiscal, pedí el certificado con ese .csr y autorizá el servicio «Constancia de inscripción» (y los que uses).',
      'Volvé a SysCAR, en la fila del pedido tocá «Subir .crt» y elegí el archivo que te dio ARCA. Pasa a «Activo».',
      'Tocá «Probar conexión con ARCA» eligiendo el servicio para comprobar que funciona.',
      'Si el certificado se compromete o vence, tocá «Revocar» y creá uno nuevo.',
    ],
    notas: ['La clave privada se guarda cifrada en el servidor y nunca llega a tu navegador, ni siquiera para el holding.', 'Se avisa cuando el certificado está por vencer.'],
  },
  {
    id: 'auditoria', titulo: 'Auditoría', quien: 'Administrador del estudio (y holding)',
    resumen: 'Registro de quién hizo qué y cuándo.',
    pasos: ['Entrá a Auditoría para ver los movimientos del estudio en orden cronológico: quién, qué hizo, sobre qué y el resultado.', 'Usalo para aclarar dudas («¿quién anuló este lote?»).'],
    notas: ['Nadie puede modificar ni borrar la auditoría: se escribe sola.'],
  },
  {
    id: 'vencimientos', titulo: 'Vencimientos y escala de monotributo', quien: 'Todos ven; solo el holding edita',
    resumen: 'Calendario de vencimientos y escala de topes y cuotas de monotributo.',
    pasos: [
      'Consultá las fechas por obligación, período y terminación de CUIT, y la escala de categorías A a K.',
      'Cada dato indica su fuente y si está «Verificado» o «Sin verificar».',
      'Holding: para cargar o corregir un vencimiento completá el formulario y tocá «Guardar». Para confirmar un dato usá «Marcar verificado» en su fila.',
    ],
    notas: ['«Sin verificar» es una etiqueta informativa, no un botón. Significa que el dato se cargó de una fuente externa y falta contrastarlo con ARCA.', 'Los avisos de vencimientos y la recategorización usan estos datos: confirmalos antes de confiar en ellos.'],
  },
  {
    id: 'holding', titulo: 'Holding (superadministrador)', quien: 'Solo el holding',
    resumen: 'Alta y administración de estudios.',
    pasos: ['En «Crear estudio» escribí el nombre y el CUIT (opcional) y tocá «Crear estudio». Se crean los roles Administrador, Contador y Asistente.', 'Invitá al primer administrador desde Usuarios.', 'Un estudio se puede suspender y reactivar: mientras está suspendido, nadie de ese estudio puede ingresar ni se ejecutan sus tareas.'],
    notas: ['El holding administra estudios, pero no lee los datos fiscales de los clientes.'],
  },
]

const ESTADOS: [string, string][] = [
  ['Confirmado', 'Un lote de comprobantes que una persona revisó y validó.'],
  ['Importado', 'Cargado desde un archivo, todavía sin validar.'],
  ['Pendiente de validación', 'El sistema detectó una advertencia (total que no cierra, CUIT inválido, moneda extranjera).'],
  ['Presentada / Pagada', 'Estados de una obligación: la DDJJ ya se presentó, o ya se pagó el VEP.'],
  ['Completada parcialmente', 'Una tarea que terminó pero con datos faltantes.'],
  ['Sin verificar', 'Dato del calendario o la escala cargado de una fuente externa, a confirmar con ARCA.'],
]

const PROBLEMAS: [string, string][] = [
  ['No veo una solapa', 'Cada solapa depende de tu rol. Pedile al administrador del estudio que revise tus permisos en Roles.'],
  ['No me deja importar un archivo', 'Revisá que tengas el permiso «Importar archivos», que el archivo sea CSV o Excel de hasta 5 MB y que el cliente sea uno de los que tenés asignados.'],
  ['«No coincide con ningún cliente» en Carpetas ARCA', 'Cargá primero el cliente con ese CUIT, o pedí que te lo asignen.'],
  ['El tablero está vacío', 'Solo muestra datos importados en el rango de fechas elegido. Ampliá el rango o importá los comprobantes.'],
  ['La consulta de CUIT a ARCA falla', 'Verificá que el estudio tenga un certificado «Activo» y probá «Probar conexión con ARCA» en Certificados ARCA.'],
  ['Una tarea falló', 'Abrí su «Detalle» en el historial: explica el motivo. Corregí la causa y tocá «Relanzar».'],
  ['Los avisos de vencimientos no aparecen', 'Pueden faltar fechas en el calendario (solapa Vencimientos) o no haber obligaciones generadas para el período.'],
]

const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export default function Ayuda() {
  const [q, setQ] = useState('')
  const [abierta, setAbierta] = useState<string | null>(null)
  const filtradas = useMemo(() => {
    const t = norm(q.trim())
    if (!t) return SECCIONES
    return SECCIONES.filter((s) => norm([s.titulo, s.quien, s.resumen, ...s.pasos, ...(s.notas ?? [])].join(' ')).includes(t))
  }, [q])
  const buscando = q.trim() !== ''

  return (
    <section>
      <h2>Ayuda y manual de usuario</h2>
      <p className="suave">Guía paso a paso de cada solapa de SysCAR. Si una solapa no aparece en tu menú, tu rol no la incluye.</p>
      <label>
        Buscar en el manual
        <input type="search" value={q} placeholder="Ej.: importar, VEP, contraseña, certificado…" onChange={(e) => setQ(e.target.value)} />
      </label>
      <p className="aviso">
        Importante: SysCAR registra y organiza la información, pero <strong>no presenta declaraciones juradas ni genera VEP en ARCA</strong>. Esas acciones se hacen en el sitio de ARCA;
        después las registrás acá (a mano o dejando el PDF en la carpeta correspondiente).
      </p>

      {filtradas.length === 0 && <p className="suave">No encontré nada para «{q}». Probá con otra palabra.</p>}
      {!buscando && (
        <nav aria-label="Índice del manual">
          <strong>Índice:</strong>{' '}
          {SECCIONES.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ' · '}
              <a href={`#ayuda-${s.id}`} onClick={() => setAbierta(s.id)}>{s.titulo.split(':')[0]}</a>
            </span>
          ))}
        </nav>
      )}

      {filtradas.map((s) => (
        <details key={s.id} id={`ayuda-${s.id}`} open={buscando || abierta === s.id} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setAbierta(s.id); else if (abierta === s.id) setAbierta(null) }}>
          <summary><strong>{s.titulo}</strong> <span className="suave">· {s.quien}</span></summary>
          <p>{s.resumen}</p>
          <ol>{s.pasos.map((p, i) => <li key={i}>{p}</li>)}</ol>
          {s.notas && (
            <>
              <strong>Tené en cuenta</strong>
              <ul>{s.notas.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </>
          )}
        </details>
      ))}

      {!buscando && (
        <>
          <h3>Glosario de estados</h3>
          <div className="tabla-scroll">
            <table><tbody>{ESTADOS.map(([a, b]) => <tr key={a}><th>{a}</th><td>{b}</td></tr>)}</tbody></table>
          </div>
          <h3>Problemas frecuentes</h3>
          <div className="tabla-scroll">
            <table><tbody>{PROBLEMAS.map(([a, b]) => <tr key={a}><th>{a}</th><td>{b}</td></tr>)}</tbody></table>
          </div>
          <h3>Soporte</h3>
          <p>
            Si algo no funciona como se describe acá, primero fijate en «Problemas frecuentes». Si sigue igual, avisale al administrador de tu estudio e incluí:
            qué solapa estabas usando, qué hiciste, qué esperabas que pasara, el mensaje de error textual (si lo hubo) y la fecha y hora. La solapa Auditoría y el Detalle de
            las tareas e importaciones ayudan a reconstruir lo que pasó.
          </p>
          <p className="suave">Nunca compartas contraseñas, enlaces de acceso ni claves privadas de ARCA, ni siquiera con quien te da soporte.</p>
        </>
      )}
    </section>
  )
}
