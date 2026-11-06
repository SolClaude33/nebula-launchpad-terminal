# Escenarios E2E de F1 (§11) · trazabilidad y estado

Cada escenario se ejecuta en el perfil `test`. Hay tres sitios donde viven:

- **API · mock**: `pnpm test` (Vitest, hermético, con el adaptador mock).
- **API · Surfpool**: `pnpm test:chain` (el mismo test contra un fork local de mainnet).
- **UI**: `pnpm test:e2e` (Playwright en Edge del sistema, contra la app real; los que necesitan cadena usan Surfpool).

Estado: ✅ verde · ⏳ pendiente · ❌ falla (con el motivo).

| ID | Escenario | Dónde | Estado |
|---|---|---|---|
| E2E-01 | Primer arranque | API: `vault.test.ts` (base sin legibles) · UI: pendiente | ⏳ |
| E2E-02 | Desbloqueo y bloqueo automático | API: `vault.test.ts`, `automations.test.ts` | ⏳ |
| E2E-03 | Crear y organizar wallets | API: `wallets.test.ts` · UI: pendiente | ⏳ |
| E2E-04 | Funder y dispersión | API · mock + Surfpool: `operations.test.ts` | ⏳ |
| E2E-05 | Lanzamiento Quick | API · mock + Surfpool: `launch.test.ts` | ⏳ |
| E2E-06 | IPFS fallido bloquea el lanzamiento | UI: pendiente | ⏳ |
| E2E-07 | Doble clic en «Lanzar» | API · mock + Surfpool: `launch.test.ts` | ⏳ |
| E2E-08 | Borrador y reanudación | API: `drafts.test.ts` (reinicio con la misma carpeta de datos) · UI: pendiente (bloque 11) | ⏳ |
| E2E-09 | Lanzamiento programado tras un reinicio | pendiente (bloque 6) | ⏳ |
| E2E-10 | Launch Guard | pendiente (bloque 7) | ⏳ |
| E2E-11 | Instant Trade con atajos | UI: pendiente | ⏳ |
| E2E-12 | Operar tras la graduación | API · Surfpool: `live.test.ts` | ⏳ |
| E2E-13 | DCA y límite | API · mock + Surfpool: `automations.test.ts` | ⏳ |
| E2E-14 | Tarea activa y reinicio | API: `automations.test.ts`, `vault.test.ts` | ⏳ |
| E2E-15 | Slippage respetado | API · mock + Surfpool: `contract.test.ts` | ⏳ |
| E2E-16 | Comisiones de creador | API · mock + Surfpool: `live.test.ts` | ⏳ |
| E2E-17 | Exportar clave | API: `security.test.ts` (falta el registro de actividad) | ⏳ |
| E2E-18 | Borrar wallet con saldo | API · mock + Surfpool: `operations.test.ts` | ⏳ |
| E2E-19 | Retiro a dirección nueva | API · mock + Surfpool: `operations.test.ts` | ⏳ |
| E2E-20 | Failover de RPC | API: `rpc.test.ts` | ⏳ |
| E2E-21 | Protección del backend local | API: `security.test.ts` · UI: pendiente (otra pestaña) | ⏳ |
| E2E-22 | Copia y restauración | API: `vault.test.ts` | ⏳ |
| E2E-23 | Dashboard | API · mock + Surfpool: `dashboard.test.ts` (Δ SOL de las transacciones = variación de saldos; fee real = vista previa; P&L = ventas − compras − fees) | ⏳ |
| E2E-24 | Accesibilidad (axe a 1024 y 1440) | UI: pendiente (bloque 11) | ⏳ |
| — | Prueba de humo en mainnet | Manual, la ejecuta Nicol: `docs/SMOKE-MAINNET.md` | ⏳ |
