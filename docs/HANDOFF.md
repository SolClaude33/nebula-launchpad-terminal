# Traspaso: estado de Nébula (2026-11-07)

Documento para retomar el trabajo en otra sesión. El contexto general está en `AGENTS.md` y en la spec `REQUERIMIENTOS.md`. El historial detallado está en la nota de Obsidian `Projects/Nebula launchpad terminal.md`.

## Estado: F1 completa en el perfil `test`: los 24 E2E en verde. Falta la prueba de humo en mainnet (la hace Nicol con Helius). Jito pasa a F2.

Todo está en commits locales, sin push.
- **F0:** aprobado.
- **F1, bloques 1 a 6** (anteriores): bóveda, wallets, fondos, lanzamiento real, Live Workspace con PumpSwap, comisiones y automatizaciones.
- **F1, bloques de cierre:** de `975767f` a `b7df4c7`, más la suite E2E (`ea16a88`), las decisiones de Nicol (`c29c054`) y los arreglos del cierre (`bfd177d`, `547a9b6`, `4a9ccb9`). Se detallan abajo.

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
9. **Jito:** **queda para F2** (decisión de Nicol del 2026-11-06). En Ajustes aparece como «próximamente · F2»; no se envía ninguna propina. El P&L ya tiene la línea de propinas Jito (a 0).
10. **Copias diarias** (`b7df4c7`, §7.3)
    - Usa `db.backup()` al arrancar y después cada hora si la última copia tiene más de 24 h. Conserva 7.
    - En Ajustes se pueden listar y descargar.
11. **Suite E2E en el navegador** (`ea16a88` y arreglos del 2026-11-07; tabla completa en `docs/E2E.md`)
    - `pnpm test:e2e` usa Playwright 1.64.1 con el Edge del sistema y `@axe-core/playwright` 4.14.0.
      - El lanzador `scripts/e2e.mjs` prepara los datos temporales y Surfpool, y es el dueño del proceso de la API.
      - Expone un control local en `127.0.0.1:4390` para «cerrar y abrir la app». Lanzada desde un worker de Playwright, en Windows la API moría a los pocos segundos.
    - **Resultado (2026-11-07):** los 12 tests de interfaz en verde, entre ellos E2E-24, con axe sin violaciones serias ni críticas a 1024 y 1440 px y sin scroll horizontal.
    - `pnpm test:chain` completo: 109 en verde y 11 omitidos (solo corren con mock).
    - `pnpm test`: 109/109.
    - **Arreglos del cierre:**
      - `bfd177d` · el test de E2E-09 usa texto exacto.
      - `547a9b6` · accesibilidad: `<dl>` válidos, tabla ARIA en `/wallets`, nombre del campo de archivo, panel de trades enfocable y contraste de la tarjeta de Jito.
      - `4a9ccb9` · **fallo real**: la huella de la tabla de direcciones cambiaba entre arranques (la cuenta de comisiones aleatoria del SDK se colaba en la lista) y la tabla parecía no existir tras reiniciar. Ahora se intersectan 6 muestras, la tabla guardada vale si contiene las claves y un error del RPC no se trata como «tabla inexistente».
    - **Presupuesto de JS (§8.6):** el máximo es 216,8 KB comprimidos en `/launch/new`, frente a 300 KB; todas las rutas están dentro.
    - Antes ya se había hecho:
      - `--text-faint` pasó a `#8088a0` (oscuro) y `#5c637b` (claro).
      - El setup deriva el WS de un RPC local en el puerto siguiente.

### Arreglos de la revisión previa a mainnet (`docs/REVIEW-F1.md`, 2026-11-07)

Un commit y un test que reproduce el fallo por punto:
- `67b6222` · **P1-3** · el Launch Guard falla cerrado: si no puede leer los trades tras un reintento, omite las compras restantes («sin datos de la cadena»).
- `92d16f2` · **P1-1** · un programado nunca queda «disparado» e invisible. FIRED solo se marca justo antes de ejecutar, un error deja FAILED con el motivo, y al arrancar `recoverInterrupted()` pasa a FAILED las filas que quedaron a medias.
- `c0c749e` · **P1-2** · ventana de gracia de 2 min. Si llega más tarde (equipo dormido, app cerrada), queda PAUSED con el motivo y solo se lanza al confirmar.
- `8d21c9f` · **P2-6** · enviar y quemar reservan el id antes de cualquier `await`.
- `8abdde2` · **P1-4** · el RPC limita las peticiones y los envíos por segundo (`rpcMaxRps` y `rpcSendPerSec`; 0 = sin límite).
  - En Ajustes, el botón «Usar el preset Helius Free (8 y 1)» aplica los límites del plan Free.
  - Un 429 al enviar reenvía la misma transacción firmada.
  - `getTransactions` va en lotes de 10 como máximo.
- `5d33838` · **P2-7** · fuera de `test`, holders nunca recurre a `getProgramAccounts` (la lista queda incompleta y se reintenta).
- `084a3d0` · **P1-5** · al cambiar la contraseña se borran las copias locales (`auto-*`, `pre-restore-*`) y se hace una nueva. El aviso recuerda borrar las exportadas fuera.
- `333435b` · **P2-8** · la clave del RPC también se separa si va en el subdominio, en un segmento corto o en un parámetro con otro nombre. El host del estado pasa por `scrub`, y Ajustes avisa si una URL remota queda sin `{key}`.

P3, también el 2026-11-07:
- `26aaf16` · **P3-9** · un destino PDA se rechaza antes de gastar la reconfirmación.
- `134c50e` · **P3-11** · la clave de «Probar» de Pinata, aún sin guardar, también se redacta.
- `6de8cd1` · **P3-12** · el diagnóstico redacta además semillas de 32 bytes (arrays y base58), claves de API con nombre y URLs con la clave en cualquier sitio. Las direcciones que la app conoce se conservan enteras y las ajenas se acortan a `abcd…wxyz`.
- `0e6ab42` · **P3-14** · `stdout` y `stderr` del proceso pasan por `scrub` (`installOutputScrub` en `main.ts`).
- Siguen abiertos el P3-10 (decimales fijos a 6; falla de forma segura) y el P3-13 (pasarela IPFS dedicada).
- `0bf526c` · **`pnpm dev`** · en Windows, `tsx watch` bajo `pnpm -r --parallel` no llegaba a arrancar la API. Se reproduce desde la terminal, no era cosa del navegador integrado. Ahora `scripts/dev.mjs` lanza cada app con su propio `pnpm --filter <app> dev` y la API escucha en ~2 s.

**Checks tras los arreglos (2026-11-07):** `pnpm typecheck` y `pnpm lint` limpios; `pnpm test` 118/118 (121/121 tras los P3); `pnpm test:chain` 111 en verde y 13 omitidos (solo corren con mock); E2E afectados (`01-first-run`, `03-launch`, con E2E-09 programado tras reinicio): 6/6 en verde.

### Primer lanzamiento real en mainnet y lo que salió de él (2026-11-07)

Nicol lanzó $BOB (mint `BD2sP62o5227iMQVdAnxVdQA99onA4DSTZJh82prqTac`, modo Pro con 2 SNIPE). Creación, dev buy y las 2 compras entraron. La SNIPE 2 tardó ~52 s y el lanzamiento se pausó hasta reanudar a mano.

- **Causa:** la red descartó el primer envío y no se reenviaba. Al caducar el blockhash, `classify()` no reconoció «block height exceeded» (un `Error` se serializaba como `{}`), así que quedó «pendiente» y pausó.
- **Arreglos (cada uno con su test):**
  - `91961e7` · **sender**: la caducidad se reconoce; se reenvían los mismos bytes firmados cada 2 s con cupo sobrante (`TokenBucket.tryTake` / `RpcPool.tryRun`); si caduca dos veces, falla en vez de pausar.
  - `e93ab50` · **modo Pro**: la espera cuenta desde el envío anterior y las confirmaciones corren a la vez. La vista da `sentAt`, `sentAfterMs` y `confirmedAfterMs`, y la UI muestra «enviada · esperando confirmación · N s». `/chain/status` expone `sendPerSec` y el paso 3 avisa si una espera es menor de lo que permite el RPC.
  - `ca0e1ee` · **«Lanzar» abre el Live** (`/t/<mint>?launch=<id>`). Muestra «Creando $SYM…» mientras el mint no existe y después una tira con el progreso. La ejecución sigue en el asistente, nunca al cargar una URL.
  - `3c0460f` · **panel «Mis wallets»** del Live: compra y venta 25/50/100 % por wallet o para las marcadas. El alcance «Marcadas» se usa en el ticket y el Instant Trade.
- **Checks:**
  - `pnpm test`: 134/134.
  - `pnpm test:chain`: 7/8 a la primera; `automations` falló por la activación de la tabla en Surfpool y al repetirlo pasa (24 + 3 omitidos).
  - E2E: 12/12 a la primera.
  - Revisión visual en Surfpool: lanzamiento Pro con esperas de 0/1500/1500 ms, que salieron en T+357, T+1.884 y T+3.387 ms; venta del 25 % desde el panel; «Creando $SYM…».

## Próximo paso

1. **Nicol:** ejecutar la prueba de humo en mainnet con `docs/SMOKE-MAINNET.md` (Helius Free + Pinata) y devolver las firmas y los costes mostrados. Claude los verificará en solo lectura.
   En el paso 2 de la checklist, pulsa «Usar el preset Helius Free (8 y 1)» antes de guardar el RPC.
2. Con la prueba de humo superada se cumple el criterio de salida de F1 (§12) y se puede pasar a F2: Jito, más pads, ladder/trailing y presets.

## Decisiones pendientes de Nicol

- ~~Jito~~ y ~~Q-05~~: **resueltas el 2026-11-06**. Jito queda para F2, y el RPC de mainnet es **Helius** (la checklist está adaptada al plan Free y sus límites).
- **Borrar automatizaciones en estados finales:** la spec dice «solo si está parada». Hoy se permite también en IDLE y en los estados finales.
- **Q-01** (nombre) y **Q-06** (USDC): no bloquean.

## Conocido / límites

- **IPFS público:**
  - Clonar un token ajeno depende de las pasarelas públicas. ipfs.io, dweb.link, w3s.link y nftstorage.link devuelven 429 a peticiones automáticas. Desde el 2026-11-07 (`5999411`) se prueban de respaldo pump.mypinata.cloud, ipfs.filebase.io, 4everland.io y gateway.pinata.cloud; con 4 tokens reales, JSON e imagen llegaron en ~1 s.
  - Desde el 2026-11-07 (`d26df99`) las transacciones se piden con `maxSupportedTransactionVersion: 1`: en mainnet muchas de Pump.fun ya son v1 y, pidiendo hasta v0, el RPC las rechazaba y el Live/P&L perdían el lote entero.
  - Los tokens antiguos que migraron a Raydium (antes de PumpSwap) aparecen como «migrating» en el Live, porque no tienen pool canónico.
- **`pnpm dev` en Windows:** resuelto en `0bf526c` (ver arriba). Si alguna vez vuelve a colgarse, las dos apps se pueden arrancar por separado con `pnpm --filter server dev` y `pnpm --filter web dev`.
- **Arranque de producción comprobado (2026-11-07):** `pnpm build` y `pnpm start` con `NEBULA_PROFILE=mainnet` y `NEBULA_DATA_DIR` temporal. La API escucha en 4318 y la web en 4317, y `/setup` carga con la CSP con nonce y sin errores de consola. El aviso `bigint: Failed to load bindings` es inocuo.
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
- **Al terminar:** para Surfpool y los servidores. En Windows comprueba que quedan libres los puertos 4317, 4318, 4390, 8899 y 8900.
- **Exclusiones (§2.3):** nada que haga pasar actividad coordinada por orgánica.
- **Publicación:** sin push ni despliegue hasta que Nicol lo pida.
