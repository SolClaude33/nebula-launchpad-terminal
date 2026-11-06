# Repository Guidelines

Nébula: herramienta **privada, local y de un solo operador** para lanzar y operar tokens de Pump.fun. La especificación completa está en `REQUERIMIENTOS.md` (IDs `REQ-*`, escenarios `E2E-*`). Estado: **F1 en curso**. Ya son reales la API local, la bóveda y las wallets. El Live Workspace y el asistente siguen con datos simulados (marcados «demo») hasta conectar el adaptador de Pump.fun.

## Estructura
- `apps/server`: Fastify 5 en `127.0.0.1:4318` (tsx), SQLite (`better-sqlite3`, WAL; SQL propio con migraciones en `src/db.ts`).
  - `src/signer.ts` es el **único** módulo con la bóveda abierta. Usa Argon2id (libsodium) → KEK que envuelve una DEK; AES-256-GCM con AAD por fila.
  - `routes/`: `vault`, `wallets` (incluye carpetas y funders) y `settings` (incluye actividad). `tasks.ts` pasa lo RUNNING a PAUSED al bloquear o reiniciar.
- `apps/web`: Next.js 16 (App Router, Turbopack), Tailwind v4 y Zustand.
  - `/api/*` se reescribe hacia la API. `src/proxy.ts` rechaza cualquier Host que no sea `127.0.0.1:4317` o `localhost:4317`.
  - El layout raíz inyecta el token de sesión en `<meta name="nebula-session">`. `lib/api.ts` lo envía en la cabecera `x-nebula-session`, nunca en la URL.
  - Rutas reales: `/setup`, `/unlock`, `/wallets` y `/funder`. Rutas demo: `/t/[address]` y `/launch/new` (`lib/sim.ts` y `lib/draft.ts`).
- `packages/shared`: esquemas zod y constantes. `./node` contiene las rutas de datos (`~/.nebula/<perfil>`; `NEBULA_PROFILE` = `test` o `mainnet`; `NEBULA_DATA_DIR` para tests).
- `apps/web/AGENTS.md` contiene el bloque gestionado por Next.js; no editarlo a mano.

## Comandos (verificados)
- `pnpm install` en la raíz. `better-sqlite3` usa sus binarios precompilados (está en `ignoredBuiltDependencies`).
- `pnpm dev`: API (4318) + web (`http://127.0.0.1:4317`). Nunca `0.0.0.0`.
- `pnpm test` (17 tests de Vitest de la API), `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## Diseño: dirección "Observatorio" (cerrada en F0)
Instrumentación espacial calmada y premium, no un casino. Micro-etiquetas de telemetría en mono, retículas en las esquinas de los paneles clave (`.reticle`), la graduación como una órbita (`graduation-orbit.tsx`) y el serif Instrument Serif solo para la marca y los títulos grandes. Evitar: neones por todas partes, gradientes chillones o spinners a pantalla completa (usar skeletons).
- Tokens en `apps/web/src/app/globals.css` (`:root`, con un tema claro definido con los mismos nombres): `--bg #07080C`, `--surface-1/2/3`, `--border`, `--text #E8EAF2`, `--text-muted #8A90A6`, `--accent-a #7C5CFF` → `--accent-b #22D3EE`, `--buy #22C55E`, `--sell #F43F5E`, `--warn #F59E0B`.
- Fuentes: Geist (interfaz), Geist Mono con cifras tabulares (`.num`) e Instrument Serif (`font-display`).
- Movimiento: 120–220 ms en la interfaz y 420 ms en páginas, con easing `cubic-bezier(.2,.8,.2,1)`. Se respeta `prefers-reduced-motion`.
- Las clases propias van en `@layer components` para que las utilidades de Tailwind las puedan sobrescribir. `backdrop-filter` no admite `var()` (el compilador lo descarta).
- Solo escritorio: se diseña para 1280–1920 px y tiene que ser usable desde 1024.

## Seguridad y límites
- Datos locales (`.nebula/`, `*.vault`, `*.sqlite`) en `.gitignore` (NFR-SEC-007). Los secretos de ajustes van cifrados en la bóveda, nunca en `.env`. Los logs pasan por la redacción de pino (`REDACT_PATHS` en `app.ts`), y hay un test que lo comprueba.
- Las acciones sensibles (exportar, borrar, cambiar contraseña, restaurar con la bóveda abierta y, en el futuro, retirar) exigen un token de reconfirmación de un solo uso, comprobado en el servidor.
- Dependencias fijadas a versión exacta. Revisar a mano cualquier dependencia nueva que toque claves o firmas (NFR-SEC-006). `@pump-fun/pump-sdk` arrastra web3.js v1 y anchor: hay que auditarlo antes de acercarlo a `signer`.
- No implementar funciones que hagan pasar actividad coordinada por orgánica (bots de volumen o wash trading, capas MEV de bloque 0, evasión de bubble maps o detección, marketplace de wallets envejecidas, financiación vía mixer o saltos por CEX, Sniper Guard "Nuke"). Ver §2.3 de la spec.
- Sin push, sin remoto y sin despliegue hasta que Nicol lo pida.
