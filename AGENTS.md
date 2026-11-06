# Repository Guidelines

Nébula es una herramienta **privada, local y de un solo operador** para lanzar y operar tokens de Pump.fun. La especificación está en `REQUERIMIENTOS.md` (`REQ-*`, `E2E-*`). F1 está en curso. Ya son reales la API, la bóveda, las wallets, los movimientos de fondos, el lanzamiento desde el asistente, el Live Workspace (curva, trades, holders, órdenes, PumpSwap) y las comisiones de creador, verificados en el perfil `test` con Surfpool.

## Estructura
- `apps/server`: Fastify en `127.0.0.1:4318` con SQLite (`better-sqlite3`, migraciones en `src/db.ts`). `src/signer.ts` es el único módulo con la bóveda abierta: Argon2id → KEK que envuelve una DEK, y AES-256-GCM con AAD por fila. Firma los bytes del mensaje, así que las claves nunca entran en web3.js.
- `apps/server/src/chain`: el contrato del adaptador (`types.ts`), `pumpfun.ts` (SDK oficial, curva y PumpSwap; web3.js v1 en lugar de `@solana/kit` porque el SDK lo exige), `events.ts` (`parseEvents` por discriminador), `mock.ts`, `sender.ts` (registra cada envío en la tabla `tx` antes de emitirlo; `simulateOnly` + `watch` da el saldo posterior) y `rpc.ts` (failover).
- `apps/server/src/live.ts` (indexer por mint: WS de logs + sondeo de firmas, SQLite con cursor), `trading.ts` (órdenes multi-wallet, `trade:<orden>:<wallet>`) y `rewards.ts` (vista previa simulada, reclamo y verificación en cadena).
- `apps/web`: Next.js 16 con Tailwind v4.
  - `/api/*` se reescribe hacia la API.
  - `src/proxy.ts` valida el Host.
  - El token de sesión va en `<meta>` y se envía en la cabecera `x-nebula-session`.
  - El Live Workspace lee `lib/live.ts` (sondea la API local; nunca el RPC) y opera con `lib/trade.ts`. El asistente guarda el borrador en `lib/draft.ts`.
- `apps/server/src/launches.ts` y `operations.ts`: máquinas de estados del servidor, con idempotency keys y pausa al bloquear. La creación con dev buy necesita la tabla de direcciones propia (`chain/alt.ts`). En mainnet, IPFS queda bloqueado hasta verificar Pinata (`ipfs.ts`).
- `packages/shared`: esquemas zod. Las rutas de datos están en `./node` (`~/.nebula/<perfil>`, con `NEBULA_PROFILE` y `NEBULA_DATA_DIR`).
- `apps/web/AGENTS.md`: gestionado por Next.js; no se edita.

## Comandos (verificados)
- `pnpm install` en la raíz (`better-sqlite3` usa sus binarios precompilados).
- `pnpm dev` arranca la API y la web en `http://127.0.0.1:4317`.
- `pnpm test` (hermético, con el mock), `pnpm test:chain` (contrato contra Surfpool), `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Perfil `test`: `pnpm surfpool:install` (Surfpool 1.6.1 en `.tools/`, SHA-256 verificado) y luego `pnpm surfpool` (fork perezoso de mainnet en `127.0.0.1:8899`/`8900`, airdrop local).

## Diseño "Observatorio" (cerrado en F0)
- **Estilo:** calmado y premium, nunca un casino.
- **Recursos visuales:** telemetría en mono, retículas (`.reticle`), la graduación como una órbita, e Instrument Serif solo en la marca y los títulos grandes.
- **Tokens:** en `apps/web/src/app/globals.css`, con un tema claro de los mismos nombres. Valores: `--bg #07080C`, acento `#7C5CFF → #22D3EE`, `--buy #22C55E`, `--sell #F43F5E`, `--warn #F59E0B`.
- **Fuentes:** Geist y Geist Mono (`.num`, cifras tabulares).
- **Movimiento y CSS:** 120–220 ms, con `prefers-reduced-motion`. Las clases propias van en `@layer components`, y `backdrop-filter` no acepta `var()`.
- **Pantallas:** solo escritorio, usable desde 1024 px.

## Seguridad y límites
- **Superficie local:** solo loopback, con Host y Origin exactos, token de sesión y CSP con nonce (`src/proxy.ts`). En el perfil `test` el RPC tiene que ser local, y el airdrop solo existe ahí.
- **Secretos:** los de ajustes van cifrados en la bóveda, nunca en `.env`. Los logs pasan por la redacción de pino, y hay un test que lo comprueba.
- **Acciones sensibles:** exportar, borrar, cambiar la contraseña, restaurar y retirar exigen reconfirmar la contraseña en el servidor. Toda comprobación de contraseña comparte el retardo creciente.
- **Datos locales:** fuera del repositorio (`.gitignore`).
- **Dependencias:** a versión exacta. Las nuevas cerca de las claves se revisan a mano, como `@pump-fun/pump-sdk`.
- **Órdenes:** el envío `pending` deja la wallet pendiente y la orden en pausa, nunca FAILED. «Escalonado» usa un retardo fijo, sin aleatoriedad. La migración manual a PumpSwap (`/dev/migrate`) solo existe en el perfil `test`.
- **Exclusiones:** no se implementa nada que haga pasar actividad coordinada por orgánica, como volumen o wash trading, MEV de bloque 0, evasión de bubble maps, wallets envejecidas, financiación vía mixer o saltos por CEX, o el «Nuke» del Sniper Guard (§2.3 de la spec).
- **Publicación:** nada de push, remoto ni despliegue hasta que Nicol lo pida.
