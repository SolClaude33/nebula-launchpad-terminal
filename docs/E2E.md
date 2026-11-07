# Escenarios E2E de F1 (§11): trazabilidad y estado

Cada escenario se ejecuta en el perfil `test` y vive en uno o varios de estos sitios:

| Sitio | Comando | Qué ejecuta |
|---|---|---|
| **API · mock** | `pnpm test` | Vitest hermético con el adaptador mock |
| **API · Surfpool** | `pnpm test:chain` | El mismo test contra un fork local de mainnet |
| **UI** | `pnpm test:e2e` | Playwright en el Edge del sistema contra la app real y Surfpool. El lanzador (`scripts/e2e.mjs`) gestiona los datos temporales, Surfpool y la API (control en 4390). |

Estado: ✅ verde · ⏳ pendiente (solo la prueba de humo en mainnet, que ejecuta Nicol).

## Última ejecución (2026-11-07)

| Suite | Resultado |
|---|---|
| `pnpm test` (API · mock) | **109/109 ✅** (incluye el test nuevo `alt.test.ts`) |
| `pnpm test:chain` (completa, contra Surfpool) | **109 ✅ y 11 omitidos** (solo corren con mock), en 8 archivos, a la primera |
| `pnpm test:e2e` (completa) | **11/12 ✅**. Falló E2E-09 (ver abajo) |
| `pnpm test:e2e`, solo `01-first-run` y `03-launch` tras el arreglo | **6/6 ✅**, incluido E2E-09 |
| axe (E2E-24) | **Sin violaciones serias ni críticas a 1024 ni a 1440 px**, sin scroll horizontal en ninguna ruta, tras el commit `547a9b6` |

Así quedan en verde los 12 tests de la interfaz. Lo que se arregló por el camino, con un commit local para cada cosa:

1. **`bfd177d` · E2E-09 (fallo del test).** «Reloj Programado» también contiene «Programado» y el localizador encontraba tres elementos. Ahora el chip de estado se busca con texto exacto.
2. **`547a9b6` · E2E-24 (accesibilidad).** Arreglos de lo que marcó axe a 1024 px:
   - `<dl>` con elementos que no son dt/dd en el ticket del Live, el coste del asistente y el desglose del Dashboard;
   - en `/wallets`, la tabla tenía roles ARIA incompletos;
   - el campo de archivo del asistente no tenía nombre accesible;
   - el panel de trades no se podía enfocar con el teclado;
   - la tarjeta de Jito tenía la opacidad bajada, y con ella el contraste.
3. **`4a9ccb9` · Fallo real del producto, detectado por E2E-09.**
   - Tras reiniciar la app, la tabla de direcciones de lanzamiento podía aparecer como «falta crearla». Si se aceptaba, se pagaba otro rent.
   - Causa: las cuentas fijas de create_v2 se calculaban intersectando solo dos creaciones de ejemplo, y la cuenta de comisiones que el SDK elige al azar a veces coincidía en ambas. La huella cambiaba entonces de un arranque a otro.
   - Arreglo: ahora se intersectan 6 muestras, la tabla guardada vale si contiene todas las claves necesarias, y un error del RPC se informa como error (no como «tabla inexistente»).

### Presupuesto de JS (§8.6)

Medido con `pnpm build && node scripts/js-budget.mjs`: build de producción y Edge, contando el JavaScript transferido comprimido en la carga inicial. Límite: **300 KB**.

| Ruta | Scripts | JS inicial (KB comprimidos) |
|---|---|---|
| /unlock | 8 | 173,7 |
| /setup | 8 | 172,9 |
| / | 9 | 185,7 |
| /wallets | 10 | 202,9 |
| /launch/new | 11 | **216,8** (el máximo) |
| /launches | 9 | 183,2 |
| /t/[mint] | 11 | 206,4 |
| /automations | 9 | 190,7 |
| /rewards | 9 | 183,4 |
| /settings | 9 | 188,7 |
| /activity | 9 | 181,5 |

**✅ Todas las rutas están dentro del presupuesto.** La medición se hace sin la API arrancada: cuenta los bundles de cada ruta, no los datos.

## Trazabilidad

| ID | Escenario | Dónde | Estado |
|---|---|---|---|
| E2E-01 | Primer arranque | API: `vault.test.ts` · UI: `01-first-run` (/setup, RPC local con WS en 8900, ni la contraseña ni la clave legibles en disco) | ✅ |
| E2E-02 | Desbloqueo y bloqueo automático | API: `vault.test.ts`, `automations.test.ts` (DCA PAUSED al bloquear) · UI: `01-first-run` (bloqueo, contraseña errónea con espera, la API devuelve 423) | ✅ |
| E2E-03 | Crear y organizar wallets | API: `wallets.test.ts` · UI: `02-wallets` (10 wallets en una carpeta, rol holder, filtro y portapapeles) | ✅ |
| E2E-04 | Funder y dispersión | API · mock + Surfpool: `operations.test.ts` | ✅ |
| E2E-05 | Lanzamiento Quick | API · mock + Surfpool: `launch.test.ts` (create + dev buy en 1 tx, compras) | ✅ |
| E2E-06 | IPFS fallido bloquea el lanzamiento | UI: `03-launch` (subida fallida → «Lanzar» deshabilitado con el motivo; volver a subir lo habilita) | ✅ |
| E2E-07 | Doble clic en «Lanzar» | API · mock + Surfpool: `launch.test.ts` | ✅ |
| E2E-08 | Borrador y reanudación | API: `drafts.test.ts` · UI: `03-launch` (Esc, reinicio de la API, retomar desde Borradores) | ✅ |
| E2E-09 | Lanzamiento programado tras un reinicio | API · mock: `schedule.test.ts` · UI: `03-launch` (programado desde el asistente → reinicio de la API → desbloqueo → se lanza a su hora; otro se cancela) | ✅ |
| E2E-10 | Launch Guard | API · mock + Surfpool: `guard.test.ts` (comprador externo fuera de la bóveda; compras restantes SKIPPED; ninguna venta) | ✅ |
| E2E-11 | Instant Trade con atajos | UI: `04-live` (sin Espacio no compra; Espacio + Q compra 0,05 SOL por wallet de la carpeta contra Surfpool; la posición sube) | ✅ |
| E2E-12 | Operar tras la graduación | API · Surfpool: `live.test.ts` | ✅ |
| E2E-13 | DCA y límite | API · mock + Surfpool: `automations.test.ts` | ✅ |
| E2E-14 | Tarea activa y reinicio | API: `automations.test.ts`, `vault.test.ts` | ✅ |
| E2E-15 | Slippage respetado | API · mock + Surfpool: `contract.test.ts` | ✅ |
| E2E-16 | Comisiones de creador | API · mock + Surfpool: `live.test.ts` | ✅ |
| E2E-17 | Exportar clave | API: `security.test.ts` · UI: `02-wallets` (reconfirmación, actividad, logs sin la clave) | ✅ |
| E2E-18 | Borrar wallet con saldo | API · mock + Surfpool: `operations.test.ts` | ✅ |
| E2E-19 | Retiro a dirección nueva | API · mock + Surfpool: `operations.test.ts` | ✅ |
| E2E-20 | Failover de RPC | API: `rpc.test.ts` (≤ 3 s) | ✅ |
| E2E-21 | Protección del backend local | API: `security.test.ts` · UI: `01-first-run` (página de otro origen intenta bloquear y leer: rechazado; sin token 401; Host ajeno 403) | ✅ |
| E2E-22 | Copia y restauración | API: `vault.test.ts`, `backups.test.ts` (también una copia automática) | ✅ |
| E2E-23 | Dashboard | API · mock + Surfpool: `dashboard.test.ts` · UI: `04-live` | ✅ |
| E2E-24 | Accesibilidad (axe a 1024 y 1440) | UI: `05-a11y`, 11 rutas + /unlock | ✅ |
| — | Prueba de humo en mainnet (Helius) | Manual, la ejecuta Nicol: `docs/SMOKE-MAINNET.md` | ⏳ |
| — | Presupuesto de JS (§8.6) | `scripts/js-budget.mjs`: máximo 216,8 KB de 300 | ✅ |

**Criterio de salida de F1 (§12):** los 24 escenarios E2E están en verde en el perfil `test`. Falta solo la prueba de humo en mainnet, que ejecuta Nicol.

## Cómo repetirlo

- Comprueba antes que 4317, 4318, 4390, 8899 y 8900 están libres.
- `pnpm test:e2e` tarda unos 8 min, porque E2E-09 espera a la hora programada y axe recorre 12 páginas en cada tamaño.
- `pnpm test:chain` necesita `pnpm surfpool` corriendo y tarda unos 15 min.
- El presupuesto se mide con `pnpm build && node scripts/js-budget.mjs`.
