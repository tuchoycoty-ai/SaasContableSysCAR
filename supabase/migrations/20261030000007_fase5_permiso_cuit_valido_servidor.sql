-- La tabla arca_certificados valida el CUIT con private.cuit_valido, y la Edge Function
-- escribe con service_role (solo del lado del servidor), que no tenia permiso para usarla.
grant usage on schema private to service_role;
grant execute on function private.cuit_valido(text) to service_role;
