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
Motor de tareas (Fase 4), integración ARCA (Fase 5), VEP y
declaraciones juradas (Fase 6), reportes y puesta en producción (Fase 7).
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
