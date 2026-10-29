import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { ClienteBasico } from './types'

// Clientes que el usuario puede ver en el estudio (la base filtra por permisos).
export function useClientes(estudioId: string) {
  const [clientes, setClientes] = useState<ClienteBasico[]>([])
  const [cargando, setCargando] = useState(true)
  useEffect(() => {
    let cancelado = false
    supabase
      .from('clients')
      .select('id, cuit, razon_social')
      .eq('tenant_id', estudioId)
      .eq('activo', true)
      .order('razon_social')
      .then(({ data }) => {
        if (cancelado) return
        setClientes((data ?? []) as ClienteBasico[])
        setCargando(false)
      })
    return () => {
      cancelado = true
    }
  }, [estudioId])
  return { clientes, cargando }
}
