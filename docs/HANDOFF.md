# Traspaso: estado de Nébula (2026-11-06)

Documento para retomar el trabajo en otra sesión. Contexto general en `AGENTS.md` y en la spec `REQUERIMIENTOS.md`. El historial detallado está en la nota de Obsidian `Projects/Nebula launchpad terminal.md`.

## Hecho (F0 + bloques 1 a 4 de F1), todo en commits locales, sin push

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
- **Tests:** `pnpm test` pasa 60 tests herméticos. Con Surfpool, `pnpm test:chain` pasa 52.

## Siguiente: bloque 5, Live Workspace con datos reales

Hoy `/t/[address]` es una demo (`lib/sim.ts`). Hay que conectarlo a un token real:
1. Leer la curva real: market cap, progreso de graduación y reservas, vía `adapter.quote` o `fetchBondingCurve`.
2. Trades en vivo: implementar `parseEvents` (REQ-CORE-001) o suscribirse a los logs del programa por el WebSocket del RPC.
3. Holders (marcando las wallets propias) y posición agregada.
4. Ticket e Instant Trade contra el sender real (`buildBuyTx` y `buildSellTx`), con resultado por wallet.
5. PumpSwap cuando el token se gradúa (ahora devuelve `CURVE_COMPLETE`).
6. Comisiones de creador: pantalla `/rewards` con `claimableFees` y `buildClaimTx` enviado en cadena (nunca probado).
7. Enlazar el resultado del lanzamiento con `/t/<mint>` solo cuando Live sea real.

## Pendiente fuera del bloque 5

- IPFS de mainnet (Pinata, leyendo su documentación actual) y elección del RPC de mainnet (Q-05).
- Lanzamiento programado, Launch Guard, Jito y clonar metadatos (ahora marcados «próximamente»).
- Playwright y axe, y copias diarias automáticas.

## Cómo trabajar

- Arrancar: `pnpm dev`. Validador: `pnpm surfpool`. Pruebas en cadena: `pnpm test:chain`.
- Para verificar en el navegador sin tocar `~/.nebula`, añade temporalmente al `.claude/launch.json` de la carpeta padre una configuración con `NEBULA_DATA_DIR` apuntando a una carpeta temporal, y quítala al terminar.
- Al terminar, para Surfpool y los servidores (en Windows los procesos hijos sobreviven: comprueba los puertos 4317, 4318 y 8899).
- Exclusiones de la spec (§2.3 y `AGENTS.md`): nada que haga pasar actividad coordinada por orgánica.
- No hacer push ni desplegar sin que Nicol lo pida.
