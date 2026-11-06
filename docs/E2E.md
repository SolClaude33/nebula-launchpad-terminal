# Escenarios E2E de F1 (§11): trazabilidad y estado

Cada escenario se ejecuta en el perfil `test` y vive en uno o varios de estos sitios:

| Sitio | Comando | Qué ejecuta |
|---|---|---|
| **API · mock** | `pnpm test` | Vitest hermético con el adaptador mock |
| **API · Surfpool** | `pnpm test:chain` | El mismo test contra un fork local de mainnet |
| **UI** | `pnpm test:e2e` | Playwright en el Edge del sistema contra la app real y Surfpool. El lanzador (`scripts/e2e.mjs`) gestiona los datos temporales, Surfpool y la API. |

Estado: ✅ verde · ⚠️ corregido sin volver a ejecutar · ⏳ pendiente.

## Última ejecución (2026-11-06)

**API · mock** (`pnpm test`): **108/108 ✅**, tras el último cambio.

**API · Surfpool:** cada archivo nuevo se ejecutó contra Surfpool al cerrar su bloque, y todos pasaron:

| Archivo | Resultado |
|---|---|
| `dashboard.test.ts` | 4 |
| `tokens.test.ts` | 6 |
| `guard.test.ts` | 4 (+2 que solo corren con mock) |
| `launch.test.ts` | 16 (+2 que solo corren con mock) |

La suite completa `pnpm test:chain` pasó por última vez en el bloque 1 (95 ✅ y 9 que solo corren con mock). **Hay que repetirla entera** con los bloques 2–10.

**UI:** se ejecutó `pnpm test:e2e` y se paró a mitad porque Nicol pidió cerrar la jornada. Resultado de esa pasada:

| ID | Resultado en la pasada |
|---|---|
| E2E-01, E2E-02, E2E-21, E2E-03, E2E-17, E2E-06, E2E-08, E2E-11, E2E-23 | ✅ |
| E2E-09 | ❌ Fallo del propio test: hacía clic en un radio `sr-only`. Ya corregido (`check({ force: true })`), pendiente de volver a ejecutar. |
| E2E-24 | No llegó a correr. Una pasada anterior salió en verde, pero **no vale**: la API estaba caída y axe analizó la pantalla de error. |

El texto tenue ya se subió a ≥ 4,5:1 (`--text-faint`).

## Trazabilidad

| ID | Escenario | Dónde | Estado |
|---|---|---|---|
| E2E-01 | Primer arranque | API: `vault.test.ts` · UI: `01-first-run` (/setup, RPC local con WS en 8900, ni la contraseña ni la clave legibles en disco) | ✅ |
| E2E-02 | Desbloqueo y bloqueo automático | API: `vault.test.ts`, `automations.test.ts` (DCA PAUSED al bloquear) · UI: `01-first-run` (bloqueo, contraseña errónea con espera, la API devuelve 423) | ✅ |
| E2E-03 | Crear y organizar wallets | API: `wallets.test.ts` · UI: `02-wallets` (10 wallets en una carpeta, rol holder, filtro y portapapeles) | ✅ |
| E2E-04 | Funder y dispersión | API · mock + Surfpool: `operations.test.ts` | ✅ (bloque 3) |
| E2E-05 | Lanzamiento Quick | API · mock + Surfpool: `launch.test.ts` (create + dev buy en 1 tx, compras) | ✅ |
| E2E-06 | IPFS fallido bloquea el lanzamiento | UI: `03-launch` (subida fallida → «Lanzar» deshabilitado con el motivo; volver a subir lo habilita) | ✅ |
| E2E-07 | Doble clic en «Lanzar» | API · mock + Surfpool: `launch.test.ts` | ✅ |
| E2E-08 | Borrador y reanudación | API: `drafts.test.ts` · UI: `03-launch` (Esc, reinicio de la API, retomar desde Borradores) | ✅ |
| E2E-09 | Lanzamiento programado tras un reinicio | API · mock: `schedule.test.ts` ✅ · a mano en el navegador contra Surfpool ✅ · UI: `03-launch` | ⚠️ |
| E2E-10 | Launch Guard | API · mock + Surfpool: `guard.test.ts` (comprador externo fuera de la bóveda; compras restantes SKIPPED; ninguna venta) | ✅ |
| E2E-11 | Instant Trade con atajos | UI: `04-live` (sin Espacio no compra; Espacio + Q compra 0,05 SOL por wallet de la carpeta contra Surfpool; la posición sube) | ✅ |
| E2E-12 | Operar tras la graduación | API · Surfpool: `live.test.ts` | ✅ (bloque 5) |
| E2E-13 | DCA y límite | API · mock + Surfpool: `automations.test.ts` | ✅ (bloque 6) |
| E2E-14 | Tarea activa y reinicio | API: `automations.test.ts`, `vault.test.ts` | ✅ |
| E2E-15 | Slippage respetado | API · mock + Surfpool: `contract.test.ts` | ✅ |
| E2E-16 | Comisiones de creador | API · mock + Surfpool: `live.test.ts` | ✅ (bloque 5) |
| E2E-17 | Exportar clave | API: `security.test.ts` · UI: `02-wallets` (reconfirmación, actividad, logs sin la clave) | ✅ |
| E2E-18 | Borrar wallet con saldo | API · mock + Surfpool: `operations.test.ts` | ✅ (bloque 3) |
| E2E-19 | Retiro a dirección nueva | API · mock + Surfpool: `operations.test.ts` | ✅ (bloque 3) |
| E2E-20 | Failover de RPC | API: `rpc.test.ts` (≤ 3 s) | ✅ |
| E2E-21 | Protección del backend local | API: `security.test.ts` · UI: `01-first-run` (página de otro origen intenta bloquear y leer: rechazado; sin token 401; Host ajeno 403) | ✅ |
| E2E-22 | Copia y restauración | API: `vault.test.ts`, `backups.test.ts` (también una copia automática) | ✅ |
| E2E-23 | Dashboard | API · mock + Surfpool: `dashboard.test.ts` · UI: `04-live` | ✅ |
| E2E-24 | Accesibilidad (axe a 1024 y 1440) | UI: `05-a11y` | ⏳ |
| — | Prueba de humo en mainnet | Manual, la ejecuta Nicol: `docs/SMOKE-MAINNET.md` | ⏳ |
| — | Presupuesto de JS (§8.6) | `pnpm build && node scripts/js-budget.mjs` (escrito, sin ejecutar) | ⏳ |

## Para retomar

1. Antes de empezar, comprueba que 4317, 4318, 4390, 8899 y 8900 están libres.
2. Ejecuta `pnpm test:e2e`. Tarda unos 10 min: E2E-09 espera a la hora programada. Si axe marca algo en E2E-24, corrígelo.
3. Ejecuta `pnpm test:chain` completo, con Surfpool.
4. Ejecuta `pnpm build && node scripts/js-budget.mjs`.
5. Pasa a ✅ las filas de esta tabla.
