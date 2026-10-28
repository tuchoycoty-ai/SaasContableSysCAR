# SysCAR · Plataforma contable e impositiva multiempresa

SaaS multi-tenant para estudios contables de Argentina. Frontend React + TypeScript (Vite);
datos y autenticación en Supabase, siempre mediante el SDK oficial (`@supabase/supabase-js`).

## Estado (Fase 1)
Implementado de verdad:
- Esquema PostgreSQL con estudios, usuarios, roles, membresías, clientes por CUIT, autorizaciones,
  acceso de usuarios operativos a clientes y auditoría (`supabase/migrations`).
- Aislamiento entre estudios con Row Level Security. Probado con `supabase/tests/aislamiento.sql`
  (30 comprobaciones: estudio A vs B, operativo, holding, estudio suspendido, anónimo).
- Pantalla de ingreso, selector de estudio y lista/alta de clientes, todo vía SDK.

Pendiente: alta de estudios y usuarios (Fase 2), importaciones y dashboard (Fase 3), tareas (Fase 4),
integración ARCA (Fase 5). No hay datos de demostración ni conexión simulada con ARCA.

## Decisiones de seguridad
- La clave `service_role` nunca va en el frontend ni en este repositorio.
- El holding administra estudios y audita, pero **no** lee datos fiscales de clientes.
- La auditoría solo se escribe por triggers; ningún usuario puede modificarla ni borrarla.
- Un estudio suspendido pierde el acceso de inmediato.
- Recomendado: desactivar el registro público en Supabase (Authentication → Sign In / Providers),
  porque las altas se harán por invitación.

## Desarrollo local
```
cp .env.example .env.local
npm install
npm run dev
```

## Variables de entorno (Vercel)
`VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` (ver `.env.example`).
