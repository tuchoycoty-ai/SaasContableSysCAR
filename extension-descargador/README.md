# SysCAR · Descargador de Mis Comprobantes (extensión de Chrome/Edge)

Baja en Excel los comprobantes **emitidos** y **recibidos** de todos tus clientes desde «Mis Comprobantes» de ARCA,
haciendo los mismos clics que harías vos, con **tu sesión ya iniciada**.

## Qué NO hace (a propósito)
- No guarda ni lee tu Clave Fiscal: el ingreso lo hacés vos como siempre.
- No sube nada a ningún servidor: solo deja archivos en tu carpeta Descargas. SysCAR los lee desde «Carpetas ARCA».
- No presenta nada ni genera pagos en ARCA: solo consulta y descarga.
- Solo funciona en `https://fes.afip.gob.ar/mcmp/*`.

## Instalar (una sola vez)
1. Bajá esta carpeta (`extension-descargador`) a tu computadora y **descomprimila**.
2. En Chrome entrá a `chrome://extensions` (en Edge: `edge://extensions`).
3. Activá **Modo de desarrollador** (arriba a la derecha).
4. Tocá **Cargar descomprimida** y elegí la carpeta `extension-descargador`.
5. Fijá la extensión con el ícono del rompecabezas para tenerla a mano.
6. **Importante:** en Chrome → Configuración → Descargas, desactivá **«Preguntar dónde guardar cada archivo antes de descargarlo»**. Si no, aparece «Guardar como» en cada archivo y la descarga automática se traba.

## Usar
1. Entrá a ARCA con tu Clave Fiscal → **Mis Comprobantes**. Dejá esa pestaña al frente.
2. Abrí la extensión → **Leer mis clientes de ARCA**.
3. Tildá los clientes. Por defecto vienen tildados todos los que representás; **tu propio CUIT (administrador) viene destildado**: tildalo si necesitás bajar el tuyo.
4. Elegí el período: **Mes anterior** (por defecto) o **Elegir meses** (hasta 12; podés bajar un archivo por mes o uno solo para todo el rango).
5. Elegí Emitidos y/o Recibidos → **Descargar**. No uses esa pestaña mientras trabaja.
6. Al final ves un resumen por cliente: descargado, sin comprobantes o error.

Los archivos quedan en `Descargas/SysCAR/Emitidos` y `Descargas/SysCAR/Recibidos`, con el CUIT en el nombre
(`Mis_Comprobantes_Emitidos_-_CUIT_30717200116_2026-10.xlsx`). En SysCAR → **Carpetas ARCA** elegí esas dos carpetas.
Si querés cargar al administrador como cliente en SysCAR, creá un cliente con su CUIT y sus archivos entrarán igual.

## Si algo falla
- «Sesión vencida»: iniciá sesión otra vez, abrí Mis Comprobantes y tocá **Continuar** (sigue desde donde quedó).
- Tres errores seguidos: la extensión se pausa sola para no insistirle a ARCA. Mirá el detalle y tocá **Continuar**.
- Si ARCA cambia su página, puede dejar de encontrar un botón: avisá y se ajusta (`paginas.js`).

## Para el equipo técnico
- `manifest.json` (MV3) · `background.js` (cola cliente → tipo → período; estado en `chrome.storage`) · `paginas.js` (funciones que corren dentro de la página) · `lib/fechas.js` (fechas y nombres, puro) · `popup.*` (interfaz).
- Pruebas: `node pruebas/fechas.test.mjs` y `node pruebas/paginas.test.mjs` (esta usa Playwright con HTML de ejemplo).
- Verificado contra las páginas reales de ARCA: selección de persona, menú, consulta y resultados de **Emitidos**. **Pendiente de verificar con la página real:** resultados de Recibidos (se asume igual a Emitidos) y la descarga automática con «Preguntar dónde guardar» desactivado.
