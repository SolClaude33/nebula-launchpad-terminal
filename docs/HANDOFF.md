# Traspaso: estado de Nébula (2026-11-07)

Documento para retomar el trabajo en otra sesión. El contexto general está en `AGENTS.md` y en la spec `REQUERIMIENTOS.md`. El historial detallado está en la nota de Obsidian `Projects/Nebula launchpad terminal.md`.

## Estado: F1 y F2 cerradas (2026-11-07). F2 en `docs/F2.md`: ladder y trailing, presets, tracker y Ctrl+K, Helius Developer y Jito; Telegram, descubrimiento y otros launchpads descartados por Nicol.

F1: los 24 E2E en verde en el perfil `test` y prueba de humo en mainnet con $BOB (lanzamiento Pro, compras y reclamo verificados en cadena; no hubo venta desde Nébula). Jito pasa a F2. Nicol piensa contratar Helius Developer (5 envíos/s y conexiones con stake).

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
9. **Jito:** **queda para F2** (decisión de Nicol del 2026-11-06). Hecho en el bloque 5 de F2 (ver abajo).
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

### F2 · bloque 5: envío con Helius Developer y Jito (2026-11-07, `7434361`)

- **Preset Helius Developer (40 y 5)** junto al de Free, en Ajustes → RPC (`RPC_PRESETS` en `@nebula/shared`). Límites oficiales comprobados en helius.dev/docs/billing/rate-limits el 2026-11-07: Developer 50 req/s y 5 sendTransaction/s (Free 10 y 1). Con 5 envíos/s, el aviso del paso 3 dice 200 ms.
- **Jito opcional** (Ajustes → «Enviar por Jito», Block Engine y propina; mínimo 1.000 lamports, 0,001 SOL por defecto; desactivado por defecto):
  - `chain/jito.ts`: compra, venta y creación llevan una transferencia a una de las 8 cuentas oficiales de propina, **al final de la misma tx** (si falla, no se paga). La cuenta sale de un hash de la idempotency key (sin azar) y siempre va como clave estática, nunca desde la tabla de direcciones (lo exige Jito).
  - `sender.ts`: `tx.tip_lamports` (migración 12) se registra antes de emitir; los MISMOS bytes firmados salen por el RPC y por `sendTransaction` del Block Engine (base64), con limitador propio de 1/s y los reenvíos solo con cupo sobrante. Un fallo de Jito (p. ej. 429) no cambia el resultado: el RPC manda.
  - **Creación:** medido el 2026-11-07 fuera de línea con el estado real de Pump.fun y la tabla de Nébula: create_v2 + dev buy ocupa 922 bytes con una URI de ipfs.io (67 caracteres) y 988 con una de Pinata (93) y nombre de 32 y símbolo de 10; la propina suma ~80 (1.002 y 1.068). En Surfpool se probó con la URI local del perfil `test`. Con una pasarela propia cerca de los 200 caracteres o un nombre con muchos caracteres multibyte puede no caber: entonces esa tx sale **sin propina y solo por el RPC**: la creación inicializa la curva, así que nadie puede operar antes que el dev buy y sin Jito solo se pierde latencia. Nunca se parte del dev buy, ni hay bundles ni tx de propina aparte. El dry-run lo dice en la línea de la creación.
  - **Costes:** la propina aparece en el ticket (fila «Propina Jito» y total), el Instant Trade, el panel «Mis wallets», el resumen y el dry-run del lanzamiento, y en las comprobaciones de saldo y el MAX. El P&L la resta aparte (`jitoLamports`) y ya no la cuenta como rent.
  - La huella del dry-run incluye la propina: cambiarla obliga a volver a simular. Un programado cuya propina cambió falla con el motivo en vez de lanzarse.
  - **Perfil `test` y mock:** la propina va en la tx (tamaño, costes y P&L reales), pero el envío al Block Engine se simula; Ajustes lo avisa.
- **Tamaño en compras y ventas:** web3.js lanza si el mensaje pasa de 1.232 bytes; el sender lo trata como «no cabe» y la tx sale sin propina (test con una compra de 1 firma a ~1.225 bytes).
- **Checks reales:** `pnpm typecheck` y `pnpm lint` limpios; `pnpm test` 151/151 (12 nuevos en `jito.test.ts`: propina en la tx, cuenta fuera de la tabla, fetch simulado del Block Engine, 429, simulado en `test`, creación al límite, ajustes, preset; y el recorrido lanzamiento → compra → venta → P&L); `pnpm test:chain` 9/9 archivos a la primera (129 + 13 omitidos), con `jito.test.ts` también contra Surfpool; `pnpm test:e2e` 12/12; `pnpm build` limpio y presupuesto de JS 224,6 KB de 300; Ajustes revisado a ojo en una instancia `test` con datos temporales (presets, tarjeta activa «simulado», aviso y validación de la propina; consola limpia).
- **Queda:**
  - Probar Jito en mainnet con SOL real (lo hace Nicol): activar Jito, una compra pequeña y comprobar en el explorador la transferencia a la cuenta de propina y que el P&L la muestra.
  - Jito sale también por el RPC, así que la protección frente a sándwiches es parcial. «Solo Jito» (`bundleOnly=true`) queda como decisión abierta en `docs/F2.md`.
  - Sin UUID de Jito, el Block Engine admite 1 envío/s por IP: en órdenes de varias wallets, las que no tengan turno salen solo por el RPC (con su propina igual).

### Pendientes de F1/F2: financiar fees de reclamo (REQ-REW-003, 2026-11-07)

- **Qué hace:** en `/rewards`, si alguna wallet con comisiones no tiene SOL para el reclamo, aparece «Recargar desde <funder> la fee…» (apagado por defecto). Con él, la vista previa (`POST /rewards/preview` con `fund: true`) calcula para cada una la recarga justa: fee del reclamo + rent que adelanta (`claimRent`) y, si está vacía, hasta el mínimo exento. La tx del SDK crea, pagando el creador, las cuentas WSOL que falten: la del vault de PumpSwap (de una PDA; su rent se queda allí y es coste, «cuentas nuevas») y la del creador (se cierra en la misma tx y el rent vuelve). El funder predeterminado tiene que acabar en 0 o por encima del mínimo exento; si no, esas wallets se omiten con el motivo.
- **Ejecución:** recarga con su propia idempotency key (`claim-fund:<reclamo>:<n>`) y, solo con ella confirmada, el reclamo. Lo recibido se mide después de la recarga. Si al ejecutar la wallet ya tiene saldo, no se recarga. Un `pending` pausa; un fallo determinista marca esa wallet FAILED. `execute` vuelve a comprobar el saldo del funder (409 `PREVIEW_CHANGED`).
- **Neto:** sin saldo no se puede simular, así que el de esas wallets es una estimación (≈ en la confirmación): reclamable − fee de red − rent que no vuelve − fee de la recarga. Comprobado al lamport en Surfpool en los dos casos: token solo en curva (vault sin cuenta WSOL: recarga 0,00418 SOL, recibido 8.226.091 = previsto) y token migrado (`live.test.ts`). El monto recargado no es un coste (se queda en la wallet) y se muestra aparte.
- **Migración 14:** `claim.funder_id`, `claim_item.topup`, `topup_fee` y `topup_signature`. Comprobada sobre una copia de la base de mainnet.
- **Mock:** el reclamo exige ya la fee con el saldo previo (como la cadena).
- **Decisiones de Nicol (2026-11-07):** borrar automatizaciones sigue permitido sin iniciar, paradas o en estado final (spec ajustada); «solo Jito» no, de momento.
- **Checks:** `pnpm typecheck` y `pnpm lint` limpios; `pnpm test` 152/152; `live.test.ts` contra Surfpool 22 + 1 omitido (REQ-REW-003 incluido); `pnpm test:chain` completo 131 + 13 omitidos con un fallo suelto de REQ-AUTO-006 que pasa al repetirlo (Surfpool, sin relación); `pnpm test:e2e` 12/12; `pnpm build` y presupuesto de JS 224,6 KB de 300; `/rewards` revisado a ojo en una instancia `test` con datos temporales (aviso, confirmación con la recarga y resultado verificado).

### Restos «Should» de F1 cerrados (2026-11-07)

- **P3-10** (`10cf085`): enviar y quemar leen programa y decimales del mint (offset 44). Test en Surfpool con un mint de 9 decimales. **P3-13**: se deja como ajuste (ver `docs/REVIEW-F1.md`).
- **REQ-DASH-003** (`b59bed9`): calendario de P&L en el dashboard (mes por días, año por meses, hora local). `summary()` y `calendar()` comparten `core()`; el test comprueba que el mes suma lo mismo que «Todo». Arreglado en la revisión a ojo: al cambiar a «Año» se pintaba la respuesta del mes con nombres de mes (excepción); ahora la rejilla sigue a los datos.
- **REQ-WAL-010** (`a5147cf`): /wallets → «Recuperar rent». Cierra cuentas con saldo exactamente 0 (Token y Token-2022), máx. 16 por tx (medido ≤ 1.232 bytes), paga el destino y firma la dueña (una wallet a 0 SOL también cierra). Vista previa simulada; lo recibido coincide al lamport (Surfpool y a ojo: 0,00206133 SOL de una cuenta Token-2022). Omite wallets con algo en curso o en pausa. Migración 15 (`reclaim`). En el P&L, el rent recuperado descuenta del rent en cuentas. Surfpool: la primera simulación con una firmante sin cuenta tarda ~16 s (fork perezoso); el test hace un calentamiento.
- **Cerrar la tabla de direcciones** (`c6cf704`): Ajustes → «Tabla de direcciones». Desactivar (bloqueado con lanzamientos en curso, en pausa o programados) y cerrar tras ~512 slots, con el rent a una wallet propia. Test en Surfpool con espera real (~130 s): `surfnet_timeTravel` no rellena SlotHashes.
- **REQ-LAUNCH-006** (`354fdde`): mint vanity en el paso 2 del asistente. Hilos aparte (hasta 8, ~100.000 claves/s medidas; «pump» en 63 s), cancelable; o importar la clave. La clave va a la bóveda y se liga al borrador; el dry-run la usa mientras la creación no se haya enviado. Arreglado en la revisión a ojo: FOUND se informaba antes de ligar el mint y la UI dejaba de sondear sin mostrarlo.
- **REQ-WAL-009**: /wallets → panel «Actividad» al elegir una wallet (trades, tokens, compras, ventas, P&L realizado por coste medio propio, fees, Jito, rent, entradas y salidas). Solo datos locales. Test: cuadra con el Δ SOL real de cada holder (mock y Surfpool).
- **Migraciones 14 y 15** comprobadas sobre una copia de la base de mainnet.

## Próximo paso

F1 y F2 cerradas, también sus restos «Should». Quedan las pruebas en mainnet de Nicol: Jito, reclamo con recarga, recuperar rent y, si deja de lanzar, cerrar la tabla de direcciones.

## Decisiones pendientes de Nicol

- ~~Jito~~ y ~~Q-05~~: **resueltas el 2026-11-06**. Jito queda para F2, y el RPC de mainnet es **Helius** (la checklist está adaptada al plan Free y sus límites).
- ~~Borrar automatizaciones en estados finales~~ y ~~«solo Jito»~~: **resueltas el 2026-11-07** (se mantiene lo actual; sin «solo Jito» de momento).
- **Q-01** (nombre) y **Q-06** (USDC): no bloquean.

## Conocido / límites

- **IPFS público:**
  - Clonar un token ajeno depende de las pasarelas públicas. ipfs.io, dweb.link, w3s.link y nftstorage.link devuelven 429 a peticiones automáticas. Desde el 2026-11-07 (`5999411`) se prueban de respaldo pump.mypinata.cloud, ipfs.filebase.io, 4everland.io y gateway.pinata.cloud; con 4 tokens reales, JSON e imagen llegaron en ~1 s.
  - Desde el 2026-11-07 (`d26df99`) las transacciones se piden con `maxSupportedTransactionVersion: 1`: en mainnet muchas de Pump.fun ya son v1 y, pidiendo hasta v0, el RPC las rechazaba y el Live/P&L perdían el lote entero.
  - Los tokens antiguos que migraron a Raydium (antes de PumpSwap) aparecen como «migrating» en el Live, porque no tienen pool canónico.
- **`pnpm dev` en Windows:** resuelto en `0bf526c` (ver arriba). Si alguna vez vuelve a colgarse, las dos apps se pueden arrancar por separado con `pnpm --filter server dev` y `pnpm --filter web dev`.
- **Arranque de producción comprobado (2026-11-07):** `pnpm build` y `pnpm start` con `NEBULA_PROFILE=mainnet` y `NEBULA_DATA_DIR` temporal. La API escucha en 4318 y la web en 4317, y `/setup` carga con la CSP con nonce y sin errores de consola. El aviso `bigint: Failed to load bindings` es inocuo.
- **Surfpool** a veces falla al traer cuentas de mainnet. Un envío queda pendiente y la orden o la tarea se pausa, que es el comportamiento correcto. Puede tumbar algún test de cadena suelto; en ese caso se repite.
- **Pendientes del Should:** ver «Restos «Should» de F1» en `docs/F2.md`.

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
