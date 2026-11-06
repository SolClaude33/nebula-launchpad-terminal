# Repository Guidelines

Nébula es una herramienta **privada, local y de un solo operador** para lanzar y operar tokens de Pump.fun. La especificación está en `REQUERIMIENTOS.md` (`REQ-*`, `E2E-*`). F1 está en curso. La API, la bóveda y las wallets ya son reales; el Live Workspace y el asistente siguen siendo una demo con datos simulados.

## Estructura
- `apps/server`: Fastify en `127.0.0.1:4318` con SQLite (`better-sqlite3`, migraciones en `src/db.ts`). `src/signer.ts` es el único módulo con la bóveda abierta: Argon2id → KEK que envuelve una DEK, y AES-256-GCM con AAD por fila.
- `apps/web`: Next.js 16 con Tailwind v4.
  - `/api/*` se reescribe hacia la API.
  - `src/proxy.ts` valida el Host.
  - El token de sesión va en `<meta>` y se envía en la cabecera `x-nebula-session`.
  - Las pantallas demo usan `lib/sim.ts` y `lib/draft.ts`.
- `packages/shared`: esquemas zod. Las rutas de datos están en `./node` (`~/.nebula/<perfil>`, con `NEBULA_PROFILE` y `NEBULA_DATA_DIR`).
- `apps/web/AGENTS.md`: gestionado por Next.js; no se edita.

## Comandos (verificados)
- `pnpm install` en la raíz (`better-sqlite3` usa sus binarios precompilados).
- `pnpm dev` arranca la API y la web en `http://127.0.0.1:4317`.
- `pnpm test` (Vitest de la API), `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Perfil `test`: `pnpm surfpool:install` (Surfpool 1.6.1 en `.tools/`, SHA-256 verificado) y luego `pnpm surfpool` (fork perezoso de mainnet en `127.0.0.1:8899`/`8900`, airdrop local).

## Diseño "Observatorio" (cerrado en F0)
- **Estilo:** calmado y premium, nunca un casino.
- **Recursos visuales:** telemetría en mono, retículas (`.reticle`), la graduación como una órbita, e Instrument Serif solo en la marca y los títulos grandes.
- **Tokens:** en `apps/web/src/app/globals.css`, con un tema claro de los mismos nombres. Valores: `--bg #07080C`, acento `#7C5CFF → #22D3EE`, `--buy #22C55E`, `--sell #F43F5E`, `--warn #F59E0B`.
- **Fuentes:** Geist y Geist Mono (`.num`, cifras tabulares).
- **Movimiento y CSS:** 120–220 ms, con `prefers-reduced-motion`. Las clases propias van en `@layer components`, y `backdrop-filter` no acepta `var()`.
- **Pantallas:** solo escritorio, usable desde 1024 px.

## Seguridad y límites
- **Superficie local:** solo loopback, con Host y Origin exactos y token de sesión.
- **Secretos:** los de ajustes van cifrados en la bóveda, nunca en `.env`. Los logs pasan por la redacción de pino, y hay un test que lo comprueba.
- **Acciones sensibles:** exportar, borrar, cambiar la contraseña, restaurar y retirar exigen reconfirmar la contraseña en el servidor. Toda comprobación de contraseña comparte el retardo creciente.
- **Datos locales:** fuera del repositorio (`.gitignore`).
- **Dependencias:** a versión exacta. Las nuevas cerca de las claves se revisan a mano, como `@pump-fun/pump-sdk`.
- **Exclusiones:** no se implementa nada que haga pasar actividad coordinada por orgánica, como volumen o wash trading, MEV de bloque 0, evasión de bubble maps, wallets envejecidas, financiación vía mixer o saltos por CEX, o el «Nuke» del Sniper Guard (§2.3 de la spec).
- **Publicación:** nada de push, remoto ni despliegue hasta que Nicol lo pida.
