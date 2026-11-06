# Repository Guidelines

Nébula: herramienta **privada, local y de un solo operador** para lanzar y operar tokens de Pump.fun. La especificación completa está en `REQUERIMIENTOS.md` (IDs `REQ-*`, escenarios `E2E-*`). Estado: **F0 (prototipo de diseño) con datos simulados**; no hay RPC, bóveda, firmas ni backend todavía.

## Estructura
- `apps/web`: Next.js 16 (App Router, Turbopack), Tailwind v4, Zustand, lightweight-charts, lucide-react.
  - `src/app/unlock`: desbloqueo de la bóveda (campo de estrellas WebGL en `components/starfield.tsx`).
  - `src/app/(app)`: shell (sidebar, topbar, banner de perfil de pruebas). Rutas: `/t/[address]` (Live Workspace) y `/launch/new` (asistente de 4 pasos).
  - `src/lib/sim.ts`: motor simulado (trades, velas, holders, wallets propias). `lib/draft.ts`: borrador, validación y estimaciones. Ambos se sustituyen por la API local en F1.
- `apps/web/AGENTS.md` contiene el bloque gestionado por Next.js; no editarlo a mano.
- F1 añadirá `apps/server` (Fastify en 127.0.0.1, SQLite, signer) y `packages/*`.

## Comandos (verificados)
- `pnpm install` en la raíz.
- `pnpm dev`: servidor en `http://127.0.0.1:4317` (nunca `0.0.0.0`).
- `pnpm lint`, `pnpm typecheck`, `pnpm build`.

## Diseño: dirección "Observatorio" (cerrada en F0)
Instrumentación espacial calmada y premium, no un casino. Micro-etiquetas de telemetría en mono, retículas en las esquinas de los paneles clave (`.reticle`), la graduación como una órbita (`graduation-orbit.tsx`) y el serif Instrument Serif solo para la marca y los títulos grandes. Evitar: neones por todas partes, gradientes chillones o spinners a pantalla completa (usar skeletons).
- Tokens en `apps/web/src/app/globals.css` (`:root`, con un tema claro definido con los mismos nombres): `--bg #07080C`, `--surface-1/2/3`, `--border`, `--text #E8EAF2`, `--text-muted #8A90A6`, `--accent-a #7C5CFF` → `--accent-b #22D3EE`, `--buy #22C55E`, `--sell #F43F5E`, `--warn #F59E0B`.
- Fuentes: Geist (interfaz), Geist Mono con cifras tabulares (`.num`) e Instrument Serif (`font-display`).
- Movimiento: 120–220 ms en la interfaz y 420 ms en páginas, con easing `cubic-bezier(.2,.8,.2,1)`. Se respeta `prefers-reduced-motion`.
- Las clases propias van en `@layer components` para que las utilidades de Tailwind las puedan sobrescribir. `backdrop-filter` no admite `var()` (el compilador lo descarta).
- Solo escritorio: se diseña para 1280–1920 px y tiene que ser usable desde 1024.

## Seguridad y límites
- Datos locales (`.nebula/`, `*.vault`, `*.sqlite`) en `.gitignore` (NFR-SEC-007). Nunca guardar secretos en `.env` ni en logs.
- No implementar funciones que hagan pasar actividad coordinada por orgánica (bots de volumen o wash trading, capas MEV de bloque 0, evasión de bubble maps o detección, marketplace de wallets envejecidas, financiación vía mixer o saltos por CEX, Sniper Guard "Nuke"). Ver §2.3 de la spec.
- Sin push, sin remoto y sin despliegue hasta que Nicol lo pida.
