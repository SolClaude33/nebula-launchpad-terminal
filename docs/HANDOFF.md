# Traspaso: estado de Nébula (2026-11-06)

Documento para retomar el trabajo en otra sesión. Contexto general en `AGENTS.md` y en la spec `REQUERIMIENTOS.md`. El historial detallado está en la nota de Obsidian `Projects/Nebula launchpad terminal.md`.

## Hecho (F0 + bloques 1 a 6 de F1), todo en commits locales, sin push

- **Bóveda y API local**
  - Fastify en `127.0.0.1:4318` con SQLite.
  - Protección local: Host y Origin exactos, token de sesión y CSP con nonce.
  - Cifrado: Argon2id → KEK que envuelve una DEK, y AES-256-GCM con AAD por fila.
  - Desbloqueo: retardo creciente persistente, bloqueo automático y reconfirmación de un solo uso.
  - Copia y restauración: restaurar exige la contraseña actual y guarda antes una copia de la bóveda anterior.
- **Wallets y funders:** crear, importar, carpetas, roles, exportar, archivar y borrar, con saldos reales del RPC.
- **Cadena**
  - Adaptador de Pump.fun sobre el SDK oficial: solo maneja claves públicas; la firma la hace la bóveda con libsodium.
  - Mock con fallos inyectables.
  - Sender idempotente: registra cada envío antes de emitirlo, tiene estado `pending` y concilia al arrancar.
  - RPC con failover y reintentos ante errores transitorios.
- **Movimientos de fondos** (`operations.ts`):
  - Vista previa → plan guardado → ejecución idempotente, con pausa al bloquear y botón Reanudar.
  - Tipos: transferir, retirar (con reconfirmación y libreta de direcciones), dispersar (monto fijo o por wallet), recolectar con MAX y depositar con QR.
- **Lanzamiento real** (`launches.ts` + asistente `/launch/new`):
  - Máquina de estados: PREPARED → CREATING → CREATED → BUYING → DONE, más PAUSED. Un lanzamiento por draftId.
  - Create + dev buy en una sola transacción, usando la tabla de direcciones propia (`chain/alt.ts`).
  - Compras Quick de los holders, en orden.
  - IPFS local en el perfil `test`. **Mainnet está bloqueado hasta verificar Pinata.**
- **Live Workspace real (bloque 5)**
  - Adaptador: `tokenInfo` (curva, `migrating` o PumpSwap; market cap, progreso de graduación por reservas, fee del pad), `parseEvents` por discriminador de Anchor (trades de la curva y del AMM solo del pool canónico, graduación y migración), compra y venta en PumpSwap tras graduar y `tradeAccountsRent` (cuenta de token, cuenta de volumen de 137 bytes, WSOL temporal y ampliación del pool tras migrar).
  - Indexer (`live.ts`): un vigilante por mint con WebSocket de logs y sondeo de firmas cada 2 s; trades en SQLite con cursor; siempre indexa las firmas propias de la tabla `tx`. La web sondea la API cada segundo (nunca el RPC). Trade confirmado → visible en ≤ 2 s (test).
  - Holders: `getTokenLargestAccounts` en RPCs reales (top 20) y `getProgramAccounts` en Surfpool; las wallets propias se leen siempre; curva y pool etiquetados. Posición con coste base medio de los trades propios.
  - Órdenes (`trading.ts`): ticket e Instant Trade con id de cliente, `trade:<orden>:<wallet>`, paralelo (6 a la vez) o escalonado (800 ms fijos), resultado por wallet con motivo, `pending` → pausa (nunca FAILED), pausa al bloquear y reanudación desde el aviso. El MAX en PumpSwap se mide simulando una compra mínima (justo tras migrar el SDK envuelve el `maxQuote`).
  - Comisiones (`rewards.ts` + `/rewards`): escaneo por wallet (la bóveda es por creador), vista previa con el neto simulado (fee de red + cuentas que crea el reclamo), reclamo y verificación en cadena (recibido = reclamable − coste; bóveda en 0).
  - Asistente: el resultado del lanzamiento enlaza a `/t/<mint>`. `/t` permite abrir cualquier coin de Pump.fun o uno lanzado con Nébula. `lib/sim.ts` eliminado.
- **Automatizaciones (bloque 6, REQ-AUTO-001…010):**
  - Motor `apps/server/src/automations.ts` sobre la tabla `task` (migración 6: `mint`, `state` JSON, `task_run` y `trade_order_item.attempts`). Rutas en `routes/automations.ts`; esquemas y `dcaPlan` en `packages/shared/src/automations.ts`.
  - Cada ejecución es una orden hija de `trading.ts` con id `auto-<tarea>-<generación>-<n>` (keys `trade:auto-…:<wallet>`). Se apunta en `task.state` ANTES de crearla; tras un cierre se reanuda la misma. Las hijas no entran en la lista `paused` ni se reanudan desde `/trade/:id/resume` (409).
  - DCA: compra (SOL) o venta (tokens, recortada al saldo) fija o en «rango» = rampa fija mín→máx; fin por monto, duración o lo primero. Límite: objetivos de market cap USD (indexer + Pyth), compras descendentes y ventas ascendentes, cada uno una vez y en orden; validez opcional → TIMEOUT.
  - Comunes: rango de market cap, wallets, retardo de inicio, slippage (5 % por defecto también en ventas), «parar tras N errores», paralelo/escalonado. Dev excluida salvo `includeDev` («incl. dev» en la tarjeta).
  - Ciclo de vida: iniciar, pausar, reanudar (sin backlog: una ejecución y se reprograma), editar solo en IDLE/PAUSED (los objetivos ya ejecutados no cambian), parar (lo no enviado queda omitido), ejecutar de nuevo (generación nueva = keys nuevas), duplicar y borrar (no en RUNNING ni PAUSED).
  - Errores: un `pending` pausa la tarea; un error ANTES de enviar (RPC) se reintenta a los 5 s y cuenta como error seguido; una ejecución sin ninguna wallet dentro también cuenta. Esperar (retardo, fuera de rango, sin precio, migración) no cuenta.
  - Editar en pausa con una ejecución a medias no cambia sus wallets (409); si la tarea acaba (FAILED, etc.) con una orden a medias, lo no enviado queda omitido.
  - Borrar está permitido en IDLE y en los estados finales (la spec dice «solo si está parada»): **decisión pendiente de confirmar con Nicol**.
  - Bloqueo y reinicio: `pauseRunningTasks` pasa lo RUNNING a PAUSED con `kind: "automatización"`; el diálogo de pausa lo reanuda con `/automations/:id/resume`.
  - Web: `/automations` (lista, filtros, formulario con plan y validación compartida, registro por intento con «Cargar anteriores») y la tarjeta de posición del Live con las tareas activas del token.
- **Tests:** `pnpm test` pasa 86 herméticos (15 nuevos en `test/automations.test.ts`). Con Surfpool, `pnpm test:chain` pasa 96 (9 solo-mock omitidos), incluida la graduación con migración y operaciones en PumpSwap y las automatizaciones (E2E-02, E2E-13, E2E-14 y límites que se disparan al mover el market cap).
- **Verificado en el navegador contra Surfpool (bloque 6):** DCA de compra con «incl. dev» creado desde el formulario → registro con firmas → pausar, editar el monto en pausa y reanudar → bloquear → diálogo «automatización» → Reanudar → Surfpool se atascó pidiendo cuentas a mainnet y el envío quedó `pending`: la tarea pasó a PAUSED (no FAILED) → Reanudar → la 2.ª ejecución entró con el monto nuevo y «1 reintento», sin duplicar. Reinicio de la API (tsx watch) → la tarea aparece PAUSED y pide confirmación (E2E-14). Límite de venta: objetivos desordenados rechazados en el formulario; 4 K → 5 K USD esperando y, tras subir el market cap, los dos objetivos ejecutados en orden. Tarjeta de posición con la tarea activa y sus controles a 1024 px.
- **Verificado en el navegador contra Surfpool (bloque 5):** asistente → lanzamiento 3/3 → «Abrir en Live»; ticket 4/4; Instant Trade 4/4; graduación → aviso → migración de prueba → venta del 50 % en PumpSwap (2/4 entraron, 2 fallaron por slippage: resultado real); reclamo con neto 0,41943 SOL y bóveda en 0; 1024 px usable. Los atajos Espacio+tecla no se volvieron a probar con órdenes reales.

## Siguiente

- **REQ-LIVE-005** (enviar tokens y quemar con confirmación por símbolo).
- **Dashboard y P&L** (REQ-DASH) a partir de `live_trade` y `tx`.
- REQ-REW-003 («financiar fees de reclamo») y reclamo de la cashback de volumen: fuera de este bloque.
- Automatizaciones pendientes del Should: ladder y trailing stop (REQ-AUTO-003/004) y presets (REQ-AUTO-009).
- Surfpool: a ratos falla al traer cuentas de mainnet («Failed to fetch accounts from remote», bloqueos de ~30 s). Un envío queda `pending` y la orden o la tarea se pausan (comportamiento correcto). Puede tumbar un test en cadena suelto; repetir la suite. El presupuesto de JS inicial (§8.6) no se ha medido en este bloque.
- Conocidos: con muchas tareas activas, cada una mantiene vivo el vigilante de su mint (sondeo de firmas cada 2 s). `snapshot()` espera a `tokenInfo` (TTL de 1 s) en la propia petición; con un RPC remoto conviene refrescarlo en el tick del vigilante para cumplir p95 ≤ 50 ms (§7.3). Los marcadores del gráfico se amontonan con muchas órdenes propias seguidas.

## Pendiente fuera del bloque 5

- IPFS de mainnet (Pinata, leyendo su documentación actual) y elección del RPC de mainnet (Q-05).
- Lanzamiento programado, Launch Guard, Jito y clonar metadatos (ahora marcados «próximamente»).
- Playwright y axe, y copias diarias automáticas.

## Cómo trabajar

- Arrancar: `pnpm dev`. Validador: `pnpm surfpool`. Pruebas en cadena: `pnpm test:chain`.
- Para verificar en el navegador sin tocar `~/.nebula`, añade temporalmente al `.claude/launch.json` de la carpeta padre una configuración con `NEBULA_DATA_DIR` apuntando a una carpeta temporal, y quítala al terminar.
- Surfpool es un fork perezoso: las cuentas que no existen se piden a mainnet y pueden tardar (timeouts). El pool reintenta un timeout una vez y el lector recuerda que `getTokenLargestAccounts` no existe ahí.
- Al terminar, para Surfpool y los servidores (en Windows los procesos hijos sobreviven: comprueba los puertos 4317, 4318 y 8899).
- Exclusiones de la spec (§2.3 y `AGENTS.md`): nada que haga pasar actividad coordinada por orgánica.
- No hacer push ni desplegar sin que Nicol lo pida.
