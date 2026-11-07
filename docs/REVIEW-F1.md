# Revisión de código previa a mainnet (F1)

- **Fecha:** 2026-11-07.
- **Alcance:** `git diff 99a2d0a..HEAD` (bloques 1–11; 24 archivos del servidor, más web y E2E).
- **Modo:** la revisión se hizo en solo lectura. **Los 5 P1 y los 3 P2 están resueltos el 2026-11-07**, con un commit y un test por arreglo (marcados ✅ abajo). De los P3 se resolvieron el mismo día el 9, el 11, el 12 y el 14; el 10 (decimales) se resolvió después y el 13 (pasarela IPFS) se deja como ajuste, sin código.
- **Foco:** fallos que puedan perder dinero o filtrar secretos con SOL real, en el contexto de la prueba de humo con **Helius Free**:
  - 10 peticiones/s;
  - `sendTransaction` a 1/s;
  - `getProgramAccounts` a 5/s y 10 créditos.

Prioridad:
- **P1:** arreglar antes de la prueba de humo.
- **P2:** arreglar antes de usarla con montos reales.
- **P3:** mejora o aviso.

Las líneas son las de `HEAD` (`c29c054`).

---

## P1 · antes de la prueba de humo

### ✅ 1. Un lanzamiento programado puede quedarse «disparado» para siempre e invisible

> **Resuelto en `92d16f2`** (2026-11-07), con un test que reproduce el fallo. La fila sigue WAITING durante el dry-run y pasa a FIRED solo justo antes de `execute`. Un error deja FAILED con el motivo, un bloqueo deja PAUSED y al arrancar `recoverInterrupted()` pasa a FAILED los huérfanos.
- **Dónde:** `apps/server/src/launches.ts:349-376` (`fire`) y `:340-345` (`tickSchedule`).
- **Escenario:**
  1. `fire()` marca `schedule_state = 'FIRED'` (línea ~355) **antes** de rehacer el dry-run.
  2. Si `preflight` lanza `LOCKED` porque la bóveda se bloqueó justo en ese momento, se llama a `pauseScheduled("due-locked")`. Esa función solo busca filas `WAITING`, así que no encuentra nada.
  3. Si `execute(id)` lanza un error (RPC caído, huella del dry-run distinta, error 409), no hay `try`: el error sube al `setInterval` y solo se registra en el log.
  4. Si el proceso muere entre `FIRED` y `execute`, ocurre lo mismo.
  5. En los tres casos la fila queda `status = PREPARED` + `schedule_state = FIRED`. No sale en Borradores (`drafts.ts` excluye `FIRED`), ni en `/launches` (`listAll` solo muestra `WAITING/PAUSED/FAILED`), ni vuelve a dispararse.
- **Impacto:** no se pierde SOL. Pero el operador cree que su lanzamiento está programado o hecho y no ocurre nada, sin aviso.
- **Arreglo propuesto:**
  - Marcar `FIRED` solo justo antes de `execute`.
  - Envolver `execute` en `try/catch` y, si falla, llamar a `failSchedule`.
  - En el caso `LOCKED`, pasar la fila explícitamente a `PAUSED` y añadirla a la lista de pausas.
  - Al arrancar, convertir `PREPARED + FIRED` en `FAILED`, con el motivo «interrumpido».
  - Test: bloquear entre el disparo y el dry-run, y que `execute` lance un error.

### ✅ 2. Un lanzamiento programado se dispara aunque llegue horas tarde

> **Resuelto en `c0c749e`** (2026-11-07), con un test que reproduce el fallo. Ventana de gracia de 2 min: con más retraso queda PAUSED con el motivo y solo se lanza al confirmar.
- **Dónde:** `apps/server/src/launches.ts:340-345`.
- **Escenario:**
  1. Bóveda abierta y equipo suspendido, o RPC caído durante horas.
  2. Al volver, `tickSchedule` lanza cualquier `WAITING` con `scheduled_at <= now`, sin límite de retraso.
  3. Al despertar el equipo, el tick del programador y el bloqueo automático compiten. Si el tick va primero, el lanzamiento sale horas tarde sin confirmación.
- **Impacto:** se gasta SOL real (dev buy, compras Quick) en un mercado distinto del previsto.
- **Arreglo propuesto:**
  - Ventana de gracia de unos 2 min. Pasada esa ventana, el programado pasa a `PAUSED` con el motivo «llegó tarde» y espera confirmación.
  - Test con reloj inyectable: `scheduled_at + 10 min` debe acabar en `PAUSED`.

### ✅ 3. El Launch Guard deja pasar las compras si no puede leer la cadena

> **Resuelto en `67b6222`** (2026-11-07), con un test que reproduce el fallo. Reintenta una vez y, si vuelve a fallar, omite las compras restantes con el motivo «sin datos de la cadena».
- **Dónde:** `apps/server/src/launches.ts:433`. `this.externalBuys(...).catch(() => 0n)`.
- **Escenario:**
  1. Con Helius Free, `Live.tradesNow` → `sync` (firmas y transacciones en lotes) recibe un 429 o un timeout.
  2. El error se convierte en «0 compras externas», así que se ejecuta la compra planificada.
- **Impacto:** es justo lo que el guard debía evitar: comprar encima de los snipers con SOL real.
- **Arreglo propuesto:** que falle cerrado.
  - Reintentar una vez con espera.
  - Si vuelve a fallar, marcar las compras restantes como `SKIPPED` con el motivo «Launch Guard sin datos de la cadena», o pausar el lanzamiento con el motivo y pedir confirmación.
  - Nunca asumir 0.
  - Test con el mock: `tradesNow` lanza un error → ninguna compra más.

### ✅ 4. Los límites de Helius Free provocan pausas en cadena (429)

> **Resuelto en `8abdde2`** (2026-11-07), con un test que reproduce el fallo. Cubo de fichas configurable (`rpcMaxRps`, `rpcSendPerSec`) y preset «Helius Free» (8 y 1) en Ajustes. Un 429 al enviar reenvía la misma transacción firmada. Lotes de `getTransactions` de 10 como máximo.
- **Dónde:**
  - `apps/server/src/trading.ts:16`: `PARALLEL = 6` envíos a la vez.
  - `apps/server/src/chain/rpc.ts`: `withRetry`, 3 reintentos de 400, 800 y 1.200 ms ante 429.
  - `apps/server/src/chain/sender.ts`: `broadcast` y la rama `catch` después de emitir.
  - `apps/server/src/chain/index.ts:96-98`: `getTransactions` en lotes de 50.
  - `apps/server/src/live.ts`: lotes de 50 y relleno inicial de hasta 1.000 firmas.
  - `apps/server/src/pnl.ts`: lotes de 50.
- **Escenario:**
  1. Una orden en paralelo o un DCA con 3–6 wallets emite 3–6 `sendTransaction` en el mismo segundo, cuando Helius Free admite 1/s.
  2. Tras unos 2,4 s de reintentos, el error llega a la rama posterior al envío. `statusOf` responde `unknown`, así que el envío queda **pendiente** y la orden o la automatización pasa a **PAUSED**, con confirmación manual.
  3. Además, `getTransactions` con 50 firmas es una petición en lote de 50. Probablemente cuenta como 50 peticiones y supera las 10/s, de modo que el indexer y el P&L fallan en bucle en tokens con actividad.
- **Impacto:**
  - No hay doble envío: el estado `pending` es seguro.
  - Sí hay mucha fricción, y DCA o límites parados sin que nadie lo vea.
  - El Launch Guard queda ciego (ver el punto 3).
- **Arreglo propuesto:**
  - Un limitador de peticiones en `RpcPool` (por ejemplo, 8 peticiones/s y `sendTransaction` a 1/s, configurable en Ajustes con un preset «Helius Free»).
  - Lotes de 10 como máximo.
  - Si el envío recibe un 429, se sabe que no se emitió: reintentar el **mismo** mensaje firmado más tarde, sin pasar a pendiente.
  - Modo **Escalonado** por defecto en mainnet.
  - Hasta tenerlo: en la checklist, escalonado y una sola wallet, como ya pone `docs/SMOKE-MAINNET.md`.

### ✅ 5. Las copias automáticas siguen abriéndose con la contraseña anterior

> **Resuelto en `084a3d0`** (2026-11-07), con un test que reproduce el fallo. Al cambiar la contraseña se borran las copias `auto-*` y `pre-restore-*` y se hace una nueva. Ajustes avisa de las copias exportadas fuera.
- **Dónde:**
  - `apps/server/src/backups.ts` (`backups/auto-*.nebula-vault`, se conservan 7);
  - `routes/vault.ts` (`/change-password`);
  - las copias `pre-restore-*.sqlite`, que no se rotan.
- **Escenario:**
  1. Nicol cambia la contraseña maestra porque sospecha que se filtró.
  2. Las 7 copias diarias y las `pre-restore` de la carpeta de datos siguen cifradas con la antigua.
- **Impacto:** quien tenga la contraseña antigua y acceso al disco recupera todas las claves privadas.
- **Arreglo propuesto:**
  - Tras cambiar la contraseña, borrar las copias automáticas y `pre-restore` (con aviso y reconfirmación) y hacer una copia nueva con la DEK reenvuelta.
  - Mientras tanto, documentar el riesgo en Ajustes y en la checklist.

---

## P2 · antes de usar montos reales

### ✅ 6. Dos peticiones iguales de enviar o quemar pueden ejecutarse a la vez

> **Resuelto en `8d21c9f`** (2026-11-07), con un test que reproduce el fallo. El id se reserva antes de cualquier `await` y se libera en `finally`.
- **Dónde:** `apps/server/src/token-ops.ts:94` frente a `running.add` (línea ~104).
- **Escenario:**
  1. La comprobación `running.has(id)` va al principio.
  2. El `add` va después de dos `await` (`symbolOf`, `plan`), así que dos peticiones simultáneas con el mismo `id` pasan las dos.
  3. Si construyen con blockhash distintos, el sender emite dos transacciones distintas con la misma idempotency key. El registro previo usa `ON CONFLICT DO UPDATE`.
- **Impacto:** un doble envío o una doble quema de tokens. Es poco probable desde la interfaz, porque el botón se deshabilita, pero es posible por la API.
- **Arreglo propuesto:** hacer `running.add` en la misma línea de la comprobación y quitarlo en `finally`.

### ✅ 7. Ante cualquier fallo, la lista de holders recurre a `getProgramAccounts` en mainnet

> **Resuelto en `5d33838`** (2026-11-07), con un test que reproduce el fallo. Fuera de `test`, la lista queda incompleta y se reintenta; nunca `getProgramAccounts`.
- **Dónde:** `apps/server/src/chain/index.ts:76-91`.
- **Escenario:**
  1. Si `getTokenLargestAccounts` falla una vez (por ejemplo, un 429), se llama a `getProgramAccounts` sobre todo el programa de token, filtrando por el mint.
  2. En Helius cuesta 10 créditos, el límite es 5/s y la respuesta es enorme en tokens con muchos holders.
  3. Se repite cada 10 s mientras el Live está abierto.
- **Impacto:** consume créditos, provoca más 429 en cadena y deja el Live lento.
- **Arreglo propuesto:** en mainnet, nunca recurrir a `getProgramAccounts`. Usar la última lista o solo las wallets propias, y reintentar en el siguiente tick.

### ✅ 8. Una URL de RPC con la clave en un subdominio o en un segmento corto no se separa

> **Resuelto en `333435b`** (2026-11-07), con un test que reproduce el fallo. También se separan el subdominio, los segmentos cortos con dígitos y los parámetros con otro nombre. El host del estado pasa por `scrub` y Ajustes avisa si una URL remota queda sin `{key}`.
- **Dónde:** `apps/server/src/settings.ts:47-75` (`splitRpcKey`).
- **Escenario:** la clave va en un subdominio, en un segmento de ruta de menos de 20 caracteres o en un parámetro con otro nombre.
- **Impacto:** la clave queda **en claro** en `kv.settings`, en `GET /settings`, en las copias y en el diagnóstico. La redacción del diagnóstico solo cubre parámetros de consulta conocidos.
- **Para Helius no aplica:** su clave va en `?api-key=`, que sí se separa y está cubierto por un test.
- **Arreglo propuesto:** si la URL no lleva `{key}` y el host no es loopback, avisar en la interfaz («¿lleva la URL tu clave? usa `{key}`»), o cifrar siempre las URL completas.

---

## P3 · mejoras y avisos

### ✅ 9. La reconfirmación se gasta aunque el envío se rechace

> **Resuelto en `26aaf16`** (2026-11-07), con un test que reproduce el fallo. El destino PDA se rechaza antes de gastar la reconfirmación; el mismo token sirve para el envío correcto.
`apps/server/src/token-ops.ts:102-103`. El token de reconfirmación se consume antes de rechazar un destino PDA. No hay riesgo de fondos: solo obliga a reconfirmar otra vez. Conviene mover la comprobación de PDA antes de consumirlo.

### ✅ 10. Los decimales del token van fijos a 6

> **Resuelto** (2026-11-07). Programa y decimales se leen del mint (offset 44) y se cachean; test en Surfpool con un mint de 9 decimales (enviar y quemar).
`apps/server/src/chain/pumpfun.ts:377,386`. `transferChecked` y `burnChecked` usan siempre 6 decimales. Con un token de otro launchpad (otros decimales), la instrucción falla de forma segura: no se envía nada mal. Conviene leer los decimales del mint.

### ✅ 11. La clave de «Probar» de Pinata no pasa por la redacción

> **Resuelto en `134c50e`** (2026-11-07), con un test que reproduce el fallo. `testAuth` registra la clave con `remember` antes de usarla, así que ni la respuesta ni los logs la repiten.
`apps/server/src/ipfs.ts`, `testAuth(override)`. Una clave escrita para «Probar», todavía sin guardar, no se registra en `remember`. Si Pinata devolviera algo con ella, no se redactaría. Es poco probable. Conviene llamar a `remember(override)`.

### ✅ 12. El diagnóstico solo redacta claves de 64 bytes

> **Resuelto en `6de8cd1`** (2026-11-07), con un test que reproduce el fallo. Redacta también los arrays de 32 números, las claves de API con nombre (también con comillas escapadas) y las URLs con la clave en un parámetro con otro nombre, un segmento o el subdominio. Las cadenas base58 de 32 bytes se acortan a `abcd…wxyz`, salvo las direcciones que la app conoce (wallets, mints, libreta, traders del Live, programas), que quedan enteras.
`apps/server/src/diagnostics.ts`. Redacta las claves de 64 bytes (base58 y arrays), pero no las semillas de 32 bytes, que no se distinguen de una dirección. Hoy nunca se registran semillas, así que no hay fuga conocida.

### 13. La pasarela ipfs.io limita las peticiones

> **Se deja como está, sin código** (2026-11-07). La pasarela ya es un ajuste. El 429 era para peticiones automáticas desde esta IP; Pump.fun y los exploradores leen el metadata por su cuenta ($BOB se vio bien). Cambiar el valor por defecto tiene dos costes: la URI queda en cadena para siempre y una pasarela dedicada (`<sub>.mypinata.cloud/ipfs/`) es más larga, lo que resta bytes a la creación con dev buy (922–988 de 1.232) y puede dejar la propina de Jito fuera de la tx. Si Nicol la quiere, basta con cambiarla en Ajustes.
`apps/server/src/settings.ts` (`ipfsGateway` por defecto). El 2026-11-06, ipfs.io devolvía 429 desde esta IP, y la URI en cadena no se puede cambiar. Coincide con el formato de los tokens de Pump.fun, pero conviene valorar una pasarela dedicada de Pinata (`<sub>.mypinata.cloud/ipfs/`), que sirve sin límite lo que fija la propia cuenta.

### ✅ 14. Las salidas por `stderr` no pasan por `scrub`

> **Resuelto en `0e6ab42`** (2026-11-07), con un test que reproduce el fallo. `installOutputScrub()` envuelve `stdout` y `stderr` al arrancar (`main.ts`). El test lo comprueba con la salida real de un proceso hijo.
Lo que las librerías imprimen por `console.error` (por ejemplo, errores de WebSocket de web3.js) no pasa por la redacción. No llega a `nebula.log` ni al diagnóstico, pero sí a la terminal. Revisado: los mensajes de web3.js no incluyen la URL.

---

## Revisado sin incidencias

- **Clave de Helius:**
  - La URL HTTP y la de WS con `?api-key=` se separan, quedan con `{key}` y la clave va a la bóveda.
  - Una clave distinta en HTTP y WS da 400.
  - `GET /settings` y `chain/status` solo muestran el host.
  - Al bloquear, el RPC con clave se desconecta.
  - `scrub` redacta los logs por valor.
  - Hay tests de todo esto.
- **Pinata:**
  - `network=public` y CID validado.
  - Los errores no repiten el JWT (`pinataError` + `scrub`).
  - Sin clave, el aviso explica dónde ponerla.
- **Lanzamientos:**
  - Un reinicio no pausa los programados, el bloqueo sí, y la cancelación se comprueba en el servidor (T−10 s), salvo lo de los puntos 1 y 2.
  - El dry-run se rehace a la hora.
- **Launch Guard:** comprueba antes de cada compra, incluida la primera, no cuenta la lista blanca y nunca vende (salvo el punto 3).
- **Enviar y quemar:**
  - Enviar fuera de la bóveda exige reconfirmar.
  - Quemar comprueba el símbolo en el servidor.
  - Idempotency key por wallet; repetir no duplica (salvo la concurrencia del punto 6).
- **Copias:** la descarga solo acepta nombres de copias existentes (sin recorrer rutas) y se rotan a 7.
- **Diagnóstico:** exige la bóveda abierta y redacta el token de sesión, los JWT, las credenciales en URL, las claves de 64 bytes y los secretos de Ajustes por valor (test con claves escritas en el log a propósito).

## Orden sugerido de arreglos

Un commit por arreglo, cuando termine la sesión de tests:

1. P1-3: Launch Guard que falle cerrado.
2. P1-1: estado del lanzamiento programado.
3. P1-2: ventana de gracia.
4. P2-6: carrera en enviar y quemar.
5. P1-4: limitador de peticiones, preset Helius Free y 429 en el envío.
6. P2-7: sin `getProgramAccounts` en mainnet.
7. P1-5: copias tras cambiar la contraseña.
8. P2-8 y los P3.

Cada uno necesita su test hermético. Los puntos 4 y 7 se pueden comprobar con un RPC simulado que devuelva 429.
