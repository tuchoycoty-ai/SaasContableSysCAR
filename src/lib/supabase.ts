import { createClient } from '@supabase/supabase-js'

// La clave "publishable" es publica por diseno: la seguridad real la dan las
// politicas RLS de la base. NUNCA poner aqui la clave service_role.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const configurado = Boolean(url && key)

export const supabase = createClient(url ?? 'http://localhost', key ?? 'sin-configurar')
