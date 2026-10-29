import { createClient } from '@supabase/supabase-js'

// La clave "publishable" es publica por diseno: la seguridad real la dan las
// politicas RLS de la base. NUNCA poner aqui la clave service_role.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configurado = Boolean(url && key)

// Se lee ANTES de crear el cliente, porque el SDK limpia el fragmento de la URL al procesarlo.
const fragmento = typeof window !== 'undefined' ? window.location.hash : ''
export const llegoPorEnlace = /type=(invite|recovery)/.test(fragmento)
export const enlaceVencido = /error_code=otp_expired|error=access_denied/.test(fragmento)

export const supabase = createClient(url ?? 'http://localhost', key ?? 'sin-configurar')
