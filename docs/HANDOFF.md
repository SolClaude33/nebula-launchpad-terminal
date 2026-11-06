# Traspaso: estado de Nébula (2026-11-06)

Documento para retomar el trabajo en otra sesión. El contexto general está en `AGENTS.md` y en la spec `REQUERIMIENTOS.md`. El historial detallado está en la nota de Obsidian `Projects/Nebula launchpad terminal.md`.

## Estado: F1 casi completa (falta cerrar la suite E2E de interfaz, Jito y la prueba de humo en mainnet)

Todo está en commits locales, sin push.
- **F0:** aprobado.
- **F1, bloques 1 a 6** (anteriores): bóveda, wallets, fondos, lanzamiento real, Live Workspace con PumpSwap, comisiones y automatizaciones.
- **F1, bloques de cierre:** de `975767f` a `b7df4c7`, más el commit de trabajo de la suite E2E. Se detallan abajo.

### Bloques de cierre de F1

1. **Lo mínimo para mainnet** (`975767f`)
   - `/settings` (REQ-SET-001/002):
     - RPC principal y de respaldo, HTTP y WS.
     - Clave de Pinata y pasarela.
     - Slippage y priority fee.
     - Bloqueo automático, teclado y tema.
     - Copia de seguridad y cambio de contraseña.
   - **Claves del RPC:** si se pega la URL completa del proveedor, la clave se separa sola. La URL queda con `{key}` y la clave va cifrada en la bóveda (`settings.ts: splitRpcKey`).
     - La clave solo se descifra con la bóveda abierta: al bloquear se desconecta el RPC y al desbloquear se reconecta.
     - `scrub()` redacta por valor todos los secretos conocidos en los logs y en los errores.
   - **Pinata (API v3, documentación leída el 2026-11-06):** `POST https://uploads.pinata.cloud/v3/files` con Bearer JWT, multipart `file` + `network=public`, y el CID en `data.cid`.
     - La URI se forma como pasarela + CID; por defecto `https://ipfs.io/ipfs/`, el mismo formato que usan los tokens reales de Pump.fun.
     - «Probar» llama a `GET https://api.pinata.cloud/data/testAuthentication`.
     - Ya no existe el bloqueo `MainnetIpfsUnavailable`. Sin clave, el aviso explica dónde ponerla.
     - Verificado contra un stub que sigue la API documentada. **Falta probarlo con una clave real**: lo hará Nicol en la prueba de humo.
   - **Live:** `tokenInfo` se refresca en el tick del vigilante, y las lecturas que la web sondea usan stale-while-revalidate. Con 200 ms de latencia simulada en el RPC, el p95 es ≤ 50 ms (test).
   - **Perfil mainnet arrancado en solo lectura con el RPC público:** setup, RPC sano, el airdrop da 404 y sin clave de Pinata aparece un mensaje claro.
   - `pnpm mainnet` y la checklist `docs/SMOKE-MAINNET.md`.
2. **Dashboard y P&L** (`74347c0`, REQ-DASH-001/002/005, E2E-23)
   - Cada envío propio confirmado se lee de la cadena: fee real y Δ SOL de las wallets propias (migración 7).
   - El P&L usa coste medio: realizado − fees de red − Jito + comisiones.
     - Las fees de Pump.fun ya van dentro de cada trade.
     - El rent se muestra aparte.
     - La posición abierta se valora al precio actual.
   - Gráficos en SVG propio cargados en diferido, y estado vacío guiado.
   - Test en Surfpool:
     - La suma de los Δ SOL es igual a la variación real de los saldos.
     - La fee real coincide con la de la vista previa.
     - P&L = ventas − compras − fees.
3. **Lanzamientos y borradores** (`ff6747d`, E2E-08)
   - Los borradores se guardan en SQLite (migración 8) con autoguardado contra la API. El de `localStorage` se migra una vez.
   - `/launches` permite reanudar, abrir en Live y archivar. `/launches/drafts` lista los borradores.
4. **Actividad y diagnóstico** (`0954f25`, REQ-LOG-001)
   - `/activity` con filtros.
   - `GET /diagnostics` redacta por valor y por patrón: base58 de 64 bytes (salvo las firmas propias), arrays de 64 bytes, JWT, credenciales en URL y cabeceras `Authorization`.
5. **Enviar y quemar** (`a9bbdab`, REQ-LIVE-005)
   - `buildTokenTransferTx` y `buildBurnTx` (Token-2022).
   - Enviar fuera de la bóveda pide reconfirmación y una PDA se rechaza.
   - Quemar exige escribir el símbolo, comprobado en el servidor.
   - Probado en mock y en Surfpool.
6. **Lanzamiento programado** (`a915a2a`, REQ-LAUNCH-015, E2E-09)
   - Migración 9: `scheduled_at` y `schedule_state`.
   - Un reinicio no lo pausa. Bloquear sí lo pausa, y también que llegue la hora con la bóveda bloqueada.
   - A su hora se vuelve a hacer el dry-run y solo se lanza si sale en verde.
   - Se puede cancelar hasta T−10 s, comprobado en el servidor.
   - Cerrar el proceso bloquea con el motivo `shutdown`, que no pausa los programados.
7. **Launch Guard** (`7e8405e`, REQ-LAUNCH-014, E2E-10)
   - Configura umbral, ventana (≥ 1 s) y lista blanca.
   - Antes de cada compra Quick lee los trades en ese momento (`Live.tradesNow`). Si se supera el umbral, las compras restantes pasan a SKIPPED. Nunca vende.
   - Probado en Surfpool con un comprador externo que firma fuera de la bóveda.
8. **Clonar metadatos** (`6722c53`, REQ-LAUNCH-005)
   - `ChainReader.tokenMetadata` lee la extensión de Token-2022 o, si no la hay, Metaplex.
   - `clone.ts` solo descarga por https y comprueba que la IP sea pública en cada redirección. Límites: 64 KB para el JSON y 2 MB para la imagen, cuyo tipo se detecta por su firma. Si una pasarela falla, prueba otras.
   - La imagen se vuelve a subir al almacén propio.
9. **Jito:** pendiente de la decisión de Nicol (ver «Decisiones pendientes»).
10. **Copias diarias** (`b7df4c7`, §7.3)
    - Usa `db.backup()` al arrancar y después cada hora si la última copia tiene más de 24 h. Conserva 7.
    - En Ajustes se pueden listar y descargar.
11. **Suite E2E en el navegador: en curso** (commit de trabajo; ver `docs/E2E.md`)
    - `pnpm test:e2e` usa Playwright 1.64.1 con el Edge del sistema y `@axe-core/playwright` 4.14.0.
      - El lanzador `scripts/e2e.mjs` prepara los datos temporales y Surfpool, y es el dueño del proceso de la API.
      - Expone un control local en `127.0.0.1:4390` para «cerrar y abrir la app». Lanzada desde un worker de Playwright, en Windows la API moría a los pocos segundos.
    - **Última pasada, interrumpida al cerrar la jornada:**
      - En verde: E2E-01, 02, 03, 06, 08, 11, 17, 21 y 23.
      - E2E-09 falló por el test (clic en un radio `sr-only`); ya está corregido pero sin volver a ejecutar.
      - E2E-24 (axe) no llegó a correr con la API viva.
    - Para cumplir AA, `--text-faint` pasó a `#8088a0` (oscuro) y `#5c637b` (claro).
    - El setup ahora deriva bien el WS local (puerto + 1).
    - `scripts/js-budget.mjs` está escrito y sin ejecutar.

## Próximo paso (mañana)

1. Ejecutar `pnpm test:e2e` completo y corregir lo que marque axe en E2E-24.
2. Ejecutar `pnpm test:chain` completo (la última vez fue en el bloque 1; después solo se ejecutaron contra Surfpool los archivos de cada bloque).
3. Ejecutar `pnpm build && node scripts/js-budget.mjs` (≤ 300 KB).
4. Actualizar `docs/E2E.md` y la nota del proyecto.
5. Jito, según lo que decida Nicol.

## Decisiones pendientes de Nicol

- **Jito (bloque 9):** ¿entra en F1? Se le preguntó a la sesión principal. Hoy, en Ajustes, el endpoint y la propina existen como campos, pero no se usan en los envíos. El P&L ya tiene la línea de propinas Jito (a 0).
- **Q-05, proveedor de RPC:** la checklist funciona con cualquiera.
- **Borrar automatizaciones en estados finales:** la spec dice «solo si está parada». Hoy se permite también en IDLE y en los estados finales.
- **Q-01** (nombre) y **Q-06** (USDC): no bloquean.

## Conocido / límites

- **IPFS público:**
  - Clonar un token ajeno depende de las pasarelas públicas. El 2026-11-06, ipfs.io y dweb.link devolvían 429 a esta IP; se rellenan nombre y símbolo desde la cadena y se avisa.
  - Los tokens antiguos que migraron a Raydium (antes de PumpSwap) aparecen como «migrating» en el Live, porque no tienen pool canónico.
- **Preview del navegador integrado:** `pnpm dev` (con `tsx watch`) se colgaba al arrancar la API y no llegaba a escuchar en el 4318. Desde Bash arranca bien. Para verificar se usaron dos configuraciones temporales (API con `--filter server start` y web con `--filter web dev`).
- **Surfpool** a veces falla al traer cuentas de mainnet. Un envío queda pendiente y la orden o la tarea se pausa, que es el comportamiento correcto. Puede tumbar algún test de cadena suelto; en ese caso se repite.
- **Pendientes del Should:** ladder, trailing stop y presets (REQ-AUTO-003/004/009); «financiar fees de reclamo» (REQ-REW-003); tracker; paleta Ctrl+K.

## Cómo trabajar

- **Arrancar:** `pnpm dev`. Validador: `pnpm surfpool`.
- **Pruebas:**
  - `pnpm test` (hermético).
  - `pnpm test:chain` (contra Surfpool).
  - `pnpm test:e2e` (interfaz; deja libres 4317 y 4318 y arranca Surfpool si hace falta).
  - `node scripts/js-budget.mjs` tras `pnpm build`.
- **Mainnet:** `pnpm mainnet` (construye y arranca con `NEBULA_PROFILE=mainnet`). La checklist está en `docs/SMOKE-MAINNET.md`.
- **Verificar en el navegador sin tocar `~/.nebula`:** añade temporalmente al `.claude/launch.json` de la carpeta padre una configuración con `NEBULA_DATA_DIR` apuntando a una carpeta temporal, y quítala al terminar.
- **Al terminar:** para Surfpool y los servidores. En Windows comprueba que quedan libres los puertos 4317, 4318, 8899 y 8900.
- **Exclusiones (§2.3):** nada que haga pasar actividad coordinada por orgánica.
- **Publicación:** sin push ni despliegue hasta que Nicol lo pida.
