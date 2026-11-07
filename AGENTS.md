# Repository Guidelines

Nébula es una herramienta **privada, local y de un solo operador** para lanzar y operar tokens de Pump.fun. La especificación está en `REQUERIMIENTOS.md` (`REQ-*`, `E2E-*`). F1 cerrada el 2026-11-07 (24 E2E en verde y prueba de humo en mainnet con $BOB, `docs/E2E.md`). F2 cerrada el mismo día (`docs/F2.md`): ladder y trailing, presets, tracker y Ctrl+K, Helius Developer y Jito. Solo Pump.fun; sin Telegram ni descubrimiento (decisiones de Nicol). El estado detallado está en `docs/HANDOFF.md` y la trazabilidad E2E en `docs/E2E.md`.

## Estructura
- `apps/server`: Fastify en `127.0.0.1:4318` con SQLite (`better-sqlite3`, migraciones en `src/db.ts`). `src/signer.ts` es el único módulo con la bóveda abierta: Argon2id → KEK que envuelve una DEK, y AES-256-GCM con AAD por fila. Firma los bytes del mensaje, así que las claves nunca entran en web3.js.
- `apps/server/src/chain`: el contrato del adaptador (`types.ts`), `pumpfun.ts` (SDK oficial, curva y PumpSwap; web3.js v1 en lugar de `@solana/kit` porque el SDK lo exige), `events.ts` (`parseEvents` por discriminador), `mock.ts`, `sender.ts` (registra cada envío en la tabla `tx` antes de emitirlo; `simulateOnly` + `watch` da el saldo posterior), `jito.ts` (propina opcional dentro de la misma tx de compra, venta y creación, y envío también por el Block Engine; simulado en `test`) y `rpc.ts` (failover).
- `apps/server/src/live.ts` (indexer por mint: WS de logs + sondeo de firmas, SQLite con cursor), `trading.ts` (órdenes multi-wallet, `trade:<orden>:<wallet>`), `rewards.ts` (vista previa simulada, reclamo y verificación en cadena) y `automations.ts` (motor de DCA y límites sobre la tabla `task`; cada ejecución es una orden hija `auto-<tarea>-<generación>-<n>` de `trading.ts`; reloj inyectable con `buildApp({ clock })`).
- `apps/web`: Next.js 16 con Tailwind v4.
  - `/api/*` se reescribe hacia la API.
  - `src/proxy.ts` valida el Host.
  - El token de sesión va en `<meta>` y se envía en la cabecera `x-nebula-session`.
  - El Live Workspace lee `lib/live.ts` (sondea la API local; nunca el RPC) y opera con `lib/trade.ts`. El asistente guarda el borrador en la API (`lib/draft.ts` → `/drafts`).
- `apps/server/src/launches.ts` y `operations.ts`: máquinas de estados del servidor, con idempotency keys y pausa al bloquear. La creación con dev buy necesita la tabla de direcciones propia (`chain/alt.ts`). `launches.ts` incluye el lanzamiento programado y el Launch Guard.
- Otros módulos del servidor:
  - `ipfs.ts`: almacén local en `test`, Pinata v3 en mainnet.
  - `settings.ts`: secretos, `{key}` en las URL del RPC y `scrub`.
  - `pnl.ts`: fee real y Δ SOL de cada envío propio; P&L.
  - `drafts.ts`, `token-ops.ts` (enviar y quemar), `clone.ts` (descargas acotadas), `diagnostics.ts` y `backups.ts`.
- `packages/shared`: esquemas zod (`automations.ts`: `AutomationConfig`, validación del orden de objetivos y `dcaPlan`, compartidos con la web). Las rutas de datos están en `./node` (`~/.nebula/<perfil>`, con `NEBULA_PROFILE` y `NEBULA_DATA_DIR`).
- `apps/web/AGENTS.md`: gestionado por Next.js; no se edita.

## Comandos (verificados)
- `pnpm install` en la raíz (`better-sqlite3` usa sus binarios precompilados).
- `pnpm dev` arranca la API y la web en `http://127.0.0.1:4317`.
- `pnpm test` (hermético, con el mock), `pnpm test:chain` (contrato contra Surfpool), `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- `pnpm test:e2e`: Playwright con el Edge del sistema y axe. Necesita libres 4317, 4318 y 4390, y arranca Surfpool si no está. La API la gestiona `scripts/e2e.mjs` (control en 4390).
- `node scripts/js-budget.mjs`: presupuesto de JS, tras `pnpm build`.
- `pnpm mainnet`: perfil mainnet.
- Perfil `test`: `pnpm surfpool:install` (Surfpool 1.6.1 en `.tools/`, SHA-256 verificado) y luego `pnpm surfpool` (fork perezoso de mainnet en `127.0.0.1:8899`/`8900`, airdrop local).

## Diseño "Observatorio" (cerrado en F0)
- **Estilo:** calmado y premium, nunca un casino.
- **Recursos visuales:** telemetría en mono, retículas (`.reticle`) y la graduación como una órbita. La marca y los títulos grandes (`.font-display`) usan Geist en seminegrita, sin cursiva: Nicol pidió quitar la serif cursiva por legibilidad (2026-11-07).
- **Tokens:** en `apps/web/src/app/globals.css`, con un tema claro de los mismos nombres. Valores: `--bg #07080C`, acento `#7C5CFF → #22D3EE`, `--buy #22C55E`, `--sell #F43F5E`, `--warn #F59E0B`.
- **Fuentes:** Geist y Geist Mono (`.num`, cifras tabulares).
- **Movimiento y CSS:** 120–220 ms, con `prefers-reduced-motion`. Las clases propias van en `@layer components`, y `backdrop-filter` no acepta `var()`.
- **Pantallas:** solo escritorio, usable desde 1024 px.

## Seguridad y límites
- **Superficie local:** solo loopback, con Host y Origin exactos, token de sesión y CSP con nonce (`src/proxy.ts`). En el perfil `test` el RPC tiene que ser local, y el airdrop solo existe ahí.
- **Secretos:** los de ajustes van cifrados en la bóveda, nunca en `.env`. Una URL de RPC con credencial se guarda con `{key}` y la clave va a la bóveda. Los logs pasan por la redacción de pino y por `scrub` (por valor). El diagnóstico redacta también por patrón. Hay tests que lo comprueban.
- **Bloqueo automático:** desactivado por defecto (`autoLockMin` = 0, nunca), a petición de Nicol (2026-11-07). Se puede activar en Ajustes con 1–240 minutos. «Bloquear» a mano (Ctrl+Shift+L) sigue igual.
- **Acciones sensibles:** exportar, borrar, cambiar la contraseña, restaurar y retirar exigen reconfirmar la contraseña en el servidor. Toda comprobación de contraseña comparte el retardo creciente.
- **Datos locales:** fuera del repositorio (`.gitignore`).
- **Dependencias:** a versión exacta. Las nuevas cerca de las claves se revisan a mano, como `@pump-fun/pump-sdk`.
- **Órdenes:** el envío `pending` deja la wallet pendiente y la orden en pausa, nunca FAILED. «Escalonado» usa un retardo fijo, sin aleatoriedad. La migración manual a PumpSwap (`/dev/migrate`) solo existe en el perfil `test`.
- **Automatizaciones:** el «rango» del DCA es una rampa fija del mínimo al máximo, el mismo monto para todas las wallets y un intervalo fijo (nada aleatorio). Pausar o parar nunca vende. Sin backlog al reanudar. La wallet dev solo entra con `includeDev`. Un `pending` pausa la tarea; un error antes de enviar se reintenta y cuenta para «N errores seguidos». Al bloquear o reiniciar, lo RUNNING pasa a PAUSED y solo se reanuda con confirmación.
- **Lanzamientos:**
  - Un programado persiste y se lanza tras un reinicio si la bóveda está abierta. Bloquear lo pausa.
  - A su hora se rehace el dry-run.
  - Se puede cancelar hasta T−10 s.
  - El Launch Guard solo omite compras propias: nunca vende.
  - Modos: Quick (compras seguidas tras crear), **Pro** (igual, con una espera fija de 0–10.000 ms (10 s) por wallet (`delayMs`), contada desde que SALE la compra anterior (la primera, desde la creación confirmada); las confirmaciones corren a la vez y no frenan la siguiente; sin aleatoriedad; pausar o bloquear corta la espera y al reanudar empieza de cero) y Manual (solo dev). La vista de cada compra da `sentAfterMs` (envío real desde la creación).
- **Descargas de terceros (clonar):** solo https y solo IP pública, con límites de tamaño.
- **Jito:** solo como vía de envío (propina en la misma tx, cuenta de propina fuera de la tabla de direcciones, elegida sin azar). Nada de bundles ni de tx de propina aparte. Si la propina no cabe en la creación (1.232 bytes), esa tx sale sin propina por el RPC; nunca se parte del dev buy.
- **Exclusiones:** no se implementa nada que haga pasar actividad coordinada por orgánica, como volumen o wash trading, MEV de bloque 0, evasión de bubble maps, wallets envejecidas, financiación vía mixer o saltos por CEX, o el «Nuke» del Sniper Guard (§2.3 de la spec).
- **Publicación:** nada de push, remoto ni despliegue hasta que Nicol lo pida.
