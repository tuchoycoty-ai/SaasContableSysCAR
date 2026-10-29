# SysCAR · Plataforma contable e impositiva multiempresa

SaaS multi-tenant para estudios contables de Argentina. Frontend React + TypeScript (Vite);
datos y autenticación en Supabase, siempre mediante el SDK oficial (`@supabase/supabase-js`).

## Estado

### Fase 1 (hecha): base y aislamiento
- Esquema PostgreSQL con estudios, usuarios, roles, membresías, clientes por CUIT, autorizaciones,
  acceso de usuarios a clientes y auditoría (`supabase/migrations`).
- Aislamiento entre estudios con Row Level Security, probado con `supabase/tests/aislamiento.sql`
  (30 comprobaciones).

### Fase 2 (hecha): holding, estudios, usuarios, roles y clientes
- **Holding:** alta, suspensión y reactivación de estudios. Cada estudio nace con los roles
  Administrador, Contador y Asistente (`crear_estudio`).
- **Usuarios:** invitación por enlace (sin email), cambio de rol, baja y nuevo enlace de acceso. Se hace
  en la Edge Function `invitar-usuario`, el único lugar que usa la clave `service_role`.
- **Roles y permisos:** permisos por rol, aplicados por la base. Hoy existe `clientes.editar`; los demás se
  agregan junto con cada módulo.
- **Clientes:** CUIT validado (módulo 11) en la base, ficha fiscal (régimen y categoría de monotributo),
  búsqueda por CUIT, autorizaciones con vigencia, y asignación de clientes a usuarios.
- **Auditoría:** registro automático (por triggers) visible para el holding y los administradores.
- Pruebas: `supabase/tests/aislamiento.sql` (30) y `supabase/tests/fase2.sql` (28).

### Fase 3 (hecha): importaciones y tablero
- **Importar** CSV o XLSX (comprobantes emitidos, recibidos y pagos de impuestos). El archivo se lee en el navegador;
  se detectan las columnas del export de ARCA "Mis Comprobantes" (y se pueden corregir a mano), se muestra una vista previa
  con filas nuevas, ya existentes, repetidas y rechazadas (con motivo y descarga del informe) y recién ahí se confirma.
- **Duplicados:** mismo cliente + sentido + tipo + punto de venta + número (en recibidos, también el emisor). En pagos:
  fecha + importe + concepto + referencia. El mismo archivo no se puede importar dos veces mientras su lote esté vigente.
- **Estados del dato:** `importado`, `pendiente_validacion` (la base detecta advertencias: total que no cierra, CUIT inválido,
  moneda extranjera) y `confirmado` (un usuario con permiso valida el lote). Las notas de crédito se guardan restando.
- **Historial** con responsable, fecha y resultado de cada lote. **Anular** un lote es una operación explícita
  (solo administrador, con motivo) que queda en la auditoría; después se puede reprocesar el archivo corregido.
- **Tablero** por cliente y período: facturado, compras, IVA débito/crédito, posición de IVA **estimada** (no es una liquidación),
  pagos, cantidad de comprobantes y evolución mensual, separando confirmado / importado / pendiente de validación.
  VEP, DDJJ, alertas, tareas e indicadores financieros figuran como "todavía no disponible": no hay números de relleno.
- Seguridad: `import_batches`, `comprobantes` y `pagos` no admiten escritura directa; todo pasa por funciones de la base que
  validan permiso (`importaciones.gestionar`), cliente asignado y datos. El holding no lee estos datos.
- Pruebas: `supabase/tests/fase3.sql` (32 comprobaciones) y `npm run test:importar` (lectura y validación).
- Límites: 5000 filas y 5 MB por archivo. Importes en moneda extranjera quedan pendientes de validación.

### Reglas que garantiza la base
- Un estudio nunca ve ni escribe datos de otro.
- Un estudio suspendido pierde el acceso al instante.
- Un estudio no puede quedarse sin administrador; un rol con usuarios no se puede borrar.
- Un mismo CUIT en dos estudios son dos fichas separadas, cada una con sus autorizaciones.
- El holding administra estudios y audita, pero **no** lee datos fiscales de clientes.
- La auditoría solo se escribe por triggers; nadie puede modificarla ni borrarla.

### Pendiente
Reportes, análisis financiero, pruebas de seguridad y puesta en producción (Fase 7).
No hay datos de demostración ni conexión simulada con ARCA.

## Configuración necesaria en Supabase (panel)
- **Authentication → URL Configuration:** poner como *Site URL* la dirección de la app en Vercel y agregarla en
  *Redirect URLs*. Sin esto, los enlaces de invitación no vuelven a la app.
- **Authentication → Sign In / Providers:** desactivar *Allow new users to sign up* (las altas son por invitación).

## Seguridad
- La clave `service_role` nunca va en el frontend ni en este repositorio.
- Los enlaces de invitación dan acceso a una cuenta: se entregan solo a quien invita y son de un solo uso.
- Un administrador de estudio no puede generar enlaces para personas que también pertenecen a otros estudios.

## Desarrollo local
```
cp .env.example .env.local
npm install
npm run dev
```

## Variables de entorno (Vercel)
`VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` (ver `.env.example`).

## Fase 4 — Motor de tareas, agenda, reintentos y auditoría

**Qué hace realmente**
- **Tareas** (pestaña *Tareas*): se elige cliente, operación, frecuencia (manual, una vez, diaria, semanal, mensual), día y hora (zona Argentina), ejecución automática/manual/ambas, período que analiza (mes anterior o en curso), cantidad de reintentos y minutos entre reintentos.
- **Ejecución automática en el servidor**: un trabajo de `pg_cron` (`syscar-motor-tareas`) corre cada minuto y ejecuta lo vencido. No depende de tener la página abierta.
- **Operaciones disponibles hoy**: control de carga mensual (¿hay comprobantes emitidos y recibidos del período?), recordatorio de vencimiento (carga un aviso en la agenda con el día que configurás) y control de IVA (débito − crédito estimado y alerta si no hay pago de IVA importado).
- **Pendientes de integración** (se muestran así y no se pueden programar): importar comprobantes desde ARCA (Fase 5) (la revisión de recategorización ya está disponible desde la Fase 6).
- **Historial** de cada ejecución con estado, intentos, quién la lanzó, errores y eventos. Nunca se borra. Se puede **relanzar** (queda vinculada a la original) y **cancelar**.
- **Estados**: programada (la tarea con su próxima ejecución), pendiente, ejecutando, completada, completada parcialmente, fallida, cancelada. Una tarea es «completada» solo si el resultado se pudo validar; si faltan datos o hay datos sin confirmar queda «completada parcialmente».
- **Reintentos**: un error transitorio reintenta tras el intervalo configurado hasta agotar los intentos; un error de configuración falla de inmediato.
- **Interrupciones**: si una ejecución queda colgada (reserva de 10 min vencida) se reanuda o, sin intentos, se marca fallida. No se pierde historial.
- **Duplicados**: índices únicos impiden dos ejecuciones activas de la misma tarea y repetir el mismo horario. Tras una caída larga del planificador se ejecuta solo el horario más reciente; los anteriores quedan registrados como omitidos.
- **Agenda** (pestaña *Agenda*): avisos con fecha, prioridad y estado; los vencidos se resaltan; los generados por tareas no se pueden borrar ni editar, los manuales sí.
- El **Tablero** muestra tareas completadas/parciales/fallidas de los últimos 30 días y avisos pendientes.

**Tablas nuevas**: `task_operations` (catálogo), `task_definitions` (configuración), `task_runs` (ejecuciones), `task_run_events` (detalle), `agenda_items` (agenda). Todas con RLS por estudio y por cliente asignado; las escrituras pasan por funciones (`crear_tarea`, `lanzar_tarea`, `relanzar_ejecucion`, `cancelar_ejecucion`, `pausar_tarea`) que verifican el permiso `tareas.gestionar`. Estudios suspendidos no ejecutan tareas. Todo queda en auditoría.

**Pruebas**: `supabase/tests/fase4.sql` (84 comprobaciones: calendario, reintentos con fallo simulado, interrupción, duplicados, recuperación, aislamiento entre estudios, holding, anónimo, permisos y auditoría). Corre en una transacción que siempre se deshace.

**Límites conocidos (honestidad)**
- Todavía no se puede *editar* una tarea existente (solo pausar/reanudar); hay que crear otra.
- Los vencimientos se configuran por tarea; el sistema no trae un calendario fiscal cargado.
- La recategorización necesita los topes oficiales de monotributo (Fase 6).
- Las operaciones son atómicas: si una falla a mitad de camino, sus escrituras parciales se revierten y se reintenta.

## Fase 5 — Integración con ARCA (certificados por estudio + padrón)

- Pestaña **Certificados ARCA** (administrador del estudio y holding): subir un par `.crt` + `.key` existente, o **generar clave y pedido CSR** para un estudio nuevo y luego subir el `.crt` que entrega ARCA.
- La **clave privada se guarda cifrada** (AES-GCM) en `arca_secretos`, que ni el navegador ni los usuarios pueden leer. Solo la Edge Function `arca-certificados` la maneja. No se puede descargar nunca.
- El secreto de cifrado (`ARCA_CIFRADO_SECRETO`, mínimo 32 caracteres) se carga **solo** como secreto de Edge Functions en Supabase. No está en el repositorio. Si se pierde, hay que volver a cargar los certificados.
- El sistema **verifica que el .crt corresponda a la clave** (módulo y exponente) y que no esté vencido; si no coinciden, no guarda nada. Avisa 30 días antes del vencimiento.
- Un certificado vigente por estudio y ambiente (homologación / producción). Todo queda en auditoría.
- Probado: generación de CSR validada con OpenSSL, lectura de certificados, pares correctos/cruzados, claves PKCS#1 y PKCS#8, claves con contraseña rechazadas, cifrado (`supabase/functions/arca-certificados/cripto.ts`).
- **Login real con ARCA (WSAA)**: botón «Probar conexión con ARCA» por certificado y servicio. El sistema arma y firma el pedido (CMS/PKCS#7, verificado contra OpenSSL), lo envía al WSAA de ARCA (producción u homologación según el certificado) y guarda el ticket (`arca_tickets`, solo accesible desde el servidor) para reutilizarlo ~12 h. Si otra aplicación ya tiene un ticket vigente con el mismo certificado, ARCA lo indica y se informa.\n- Todavía no se consume ningún servicio de negocio (comprobantes, padrón): siguiente paso.

### Consulta de CUIT en el padrón de ARCA (Fase 5)

- En **Clientes → Agregar cliente**, el botón «Completar con datos de ARCA» consulta el CUIT en el servicio `ws_sr_constancia_inscripcion` usando el certificado activo del estudio (acción `consultar_cuit` de la Edge Function `arca-certificados`). Puede usarla el administrador, el holding o quien tenga el permiso `clientes.editar`.
- Completa razón social, régimen y categoría de monotributo, y muestra domicilio fiscal e impuestos activos. Siempre se revisa antes de guardar.
- **IVA vs. IVA EXENTO:** `padron.ts` clasifica el texto de la condición evaluando primero «exento», de modo que «IVA EXENTO» nunca se toma como inscripto. Si el texto es ambiguo o no se reconoce, el régimen queda vacío con una advertencia (no se asume nada).
- Cada consulta queda en auditoría (`ARCA_PADRON`). Se reutiliza el ticket de ARCA guardado (tabla `arca_tickets`).

### Cierre de la Fase 5 — qué está realmente implementado

**Archivos:** migraciones `20261030000006` a `...0008` (tablas de certificados, claves cifradas y tickets); Edge Function `arca-certificados` (`index.ts`, `cripto.ts`, `padron.ts`); pantalla `CertificadosArca.tsx`; botón de consulta en `Clientes.tsx`; pruebas `supabase/tests/fase5.sql`.

**Tablas:** `arca_certificados` (datos públicos del certificado, visibles solo para administradores del estudio y el holding), `arca_secretos` (clave privada cifrada; sin acceso desde el navegador) y `arca_tickets` (tickets de acceso de ARCA; sin acceso desde el navegador).

**Real y verificado contra ARCA (producción):** carga/generación de certificados por estudio, login WSAA firmado, y consulta de CUIT en el padrón (`ws_sr_constancia_inscripcion`) con razón social, domicilio, régimen y categoría de monotributo; se probó con exento, monotributo, y no inscripto.

**No implementado todavía:** importación automática de comprobantes desde ARCA (la tarea `arca.importar_comprobantes` sigue «pendiente de integración»; ARCA no ofrece un servicio público equivalente a «Mis Comprobantes») y facturación. Nada se simula.

**Pruebas:** `fase5.sql` (15 comprobaciones: aislamiento entre estudios, permisos por rol, claves y tickets inaccesibles desde el navegador, restricciones, auditoría) y las unitarias de `padron.ts` (38 comprobaciones, incluido «IVA EXENTO»).


## Fase 6 — Obligaciones, vencimientos, alertas y recategorización

### Cierre de la Fase 6 — qué está realmente implementado

**Archivos:** migraciones `20261030000009_fase6_obligaciones.sql` y `...0010_fase6_ajuste_recategorizacion.sql`; pruebas `supabase/tests/fase6.sql`; pantallas `Obligaciones.tsx`, `Recategorizacion.tsx` y `Vencimientos.tsx` (más cambios en `Panel.tsx` y `types.ts`).

**Tablas:**
- `obligacion_tipos`: catálogo (IVA DDJJ, cuota de monotributo, F.931).
- `vencimientos_calendario`: fecha por obligación, período y terminación de CUIT. Es global; solo la edita el holding. Cada fila indica fuente y si fue verificada.
- `monotributo_escalas`: topes y cuotas por categoría y vigencia (global, solo el holding la edita).
- `obligaciones_cliente`: por cliente y período, estado (pendiente / presentada / pagada / no corresponde), monto, datos del VEP (número, monto, vencimiento) y fechas. Aislada por estudio con RLS, con auditoría. Permiso nuevo: `obligaciones.gestionar`.

**Real:** generación de obligaciones por régimen del cliente; seguimiento manual de DDJJ y VEP; alertas en la Agenda (vencimientos próximos y vencidos) mediante el motor de tareas (`vencimientos.control_obligaciones`); cálculo de recategorización de monotributo con los comprobantes emitidos de los últimos 12 meses (`recategorizacion.revision`).

**No hace (y no se simula):** no presenta DDJJ ni genera VEP en ARCA, porque ARCA no tiene un servicio público para eso. Solo registrás lo que hiciste. La recategorización evalúa únicamente el tope de ingresos (no superficie, energía, alquileres ni precio unitario).

**A verificar por el holding:** el calendario de noviembre 2026 y la escala de monotributo vigente desde 2026-08-01 se cargaron desde sitios de terceros y quedan «Sin verificar» hasta que se confirmen contra ARCA en la pantalla Vencimientos.

**Pruebas:** `fase6.sql` (47 comprobaciones) y la regresión completa de `fase4.sql` (84 comprobaciones) pasaron.
