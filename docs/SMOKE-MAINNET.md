# Prueba de humo en mainnet (TEST-ENV-007)

Checklist manual con montos mínimos. **La ejecuta Nicol**: Claude no envía transacciones de mainnet. Al terminar, Nicol devuelve los datos de la sección «Qué devolver» y Claude los verifica solo en lectura.

Criterio de salida de F1 (§12): la prueba de humo tiene que pasar. Hay que hacer cuatro operaciones: lanzar con un dev buy mínimo, comprar, vender y reclamar.

## 0. Antes de empezar

- **RPC de mainnet: Helius** (decisión Q-05 del 2026-11-06; documentación consultada ese mismo día).
  - Crea una cuenta en `https://dashboard.helius.dev/signup` y copia tu clave en `https://dashboard.helius.dev/api-keys`.
  - **La clave nunca va por el chat, ni a notas ni a `.env`.** Se pega solo en Ajustes de Nébula.
  - URL HTTP: `https://mainnet.helius-rpc.com/?api-key=TU_CLAVE`.
  - URL WebSocket: `wss://mainnet.helius-rpc.com/?api-key=TU_CLAVE`.
  - Nébula separa la clave sola: las URL quedan con `?api-key={key}` y la clave se guarda cifrada en la bóveda. La clave solo la usa la API local (Node); nunca llega al navegador.
  - **El plan Free basta para esta prueba**, con estos límites:
    - 10 peticiones/s de RPC.
    - `sendTransaction` a 1/s.
    - `getProgramAccounts` a 5/s.
    - 5 conexiones WebSocket.
    - 1 M de créditos al mes.
  - Si una orden multi-wallet choca con el límite (HTTP 429), Nébula reintenta. Aun así, usa el modo **Escalonado** cuando operes con varias wallets en Free.
  - Helius corta un WebSocket inactivo a los 10 minutos. Si se cae, el Live sigue sondeando firmas cada 2 s.
  - **Respaldo (opcional):** el RPC público `https://api.mainnet-beta.solana.com`, con WS `wss://api.mainnet-beta.solana.com`. Está muy limitado, pero vale para el failover.
  - Helius también ofrece «Sender» para enviar transacciones, pero exige una propina por transacción. Nébula **no lo usa** en F1: Jito y las propinas quedan para F2.
- **Pinata.**
  - Crea una clave (JWT) con permiso de subida de archivos (`files: write`).
  - Los metadatos se suben como **públicos**. La URI se forma con la pasarela de Ajustes (por defecto `https://ipfs.io/ipfs/`).
- **Presupuesto.** Lleva unos **0,15 SOL** al funder. Se reparten así (valores orientativos; el resumen y el dry-run dan las cifras exactas):

  | Concepto | SOL |
  |---|---|
  | Tabla de direcciones de Nébula (rent, una sola vez, la paga la wallet dev) | ≈ 0,0044 |
  | Creación del token: cuentas del mint y de la curva, fees y priority fee | ≈ 0,02–0,03 |
  | Dev buy mínimo | 0,01 |
  | Compra de prueba | 0,005 |
  | Fees de red y cuentas de token | ≈ 0,005 |
  | Colchón para fees, comisiones de Pump.fun y slippage | resto |

- **Comisiones de creador.** Con este volumen tan pequeño, lo reclamable puede ser menor que la fee del reclamo. La vista previa enseña el **neto**: si sale negativo, no se reclama y se anota.
- No uses wallets con fondos importantes. Crea wallets nuevas en la bóveda de mainnet.

## 1. Arranque en el perfil mainnet

- [ ] En la raíz del repo: `pnpm mainnet`. Construye la web y arranca la API y la web con `NEBULA_PROFILE=mainnet`. Los datos van a `~/.nebula/mainnet`, separados de los de pruebas.
- [ ] Abre `http://127.0.0.1:4317`. Aparece `/setup` (bóveda nueva) y **no** sale el banner «PERFIL DE PRUEBAS».
- [ ] Crea la contraseña maestra (12 caracteres o más) y guárdala en tu gestor de contraseñas.

## 2. Ajustes (`/settings`)

- [ ] **RPC principal (Helius).**
  - En «Principal · HTTP» pega `https://mainnet.helius-rpc.com/?api-key=…` y en «Principal · WebSocket» pega `wss://mainnet.helius-rpc.com/?api-key=…`, con tu clave en ambas. Guarda.
  - Tras guardar, las URL muestran `?api-key={key}` y la clave aparece como «cifrada».
  - El chip de arriba muestra `mainnet.helius-rpc.com` y la latencia en verde.
  - Si el chip dice «Falta la clave del RPC principal», pégala en el campo «Clave del RPC principal».
- [ ] Opcional: respaldo con el RPC público (HTTP y WS de arriba). Sin clave.
- [ ] **Jito** aparece como «próximamente · F2». No hay nada que configurar.
- [ ] **IPFS.** Pega el JWT de Pinata y pulsa **Probar** («Pinata acepta la clave»). Después, Guardar.
- [ ] Revisa el slippage (15 % en compra, 5 % en venta) y la priority fee (0,0001 SOL por defecto).
- [ ] Opcional: **Bloquear** y desbloquear. Con la bóveda bloqueada, el RPC con clave se desconecta; al desbloquear, vuelve.

## 3. Fondos (`/wallets`, `/funder`)

- [ ] Crea un funder y 2 wallets: una con rol **dev** y otra con rol **holder**.
- [ ] Deposita unos 0,15 SOL en el funder con su dirección o QR desde tu wallet externa. El saldo se actualiza en 5 s o menos.
- [ ] Desde el funder, transfiere 0,08 SOL a la wallet dev y 0,02 SOL a la holder.
  - La vista previa desglosa la fee de red.
  - **Anota la fee mostrada.**

## 4. Lanzamiento Manual con dev buy mínimo (`/launch/new`)

- [ ] **Paso 1.** Nombre, símbolo, descripción e imagen (PNG pequeña). La subida a Pinata termina sin errores.
- [ ] **Paso 2.**
  - Wallet dev, modo **Classic** y **Creator Fees**.
  - Marca la casilla del aviso irreversible.
  - Dev buy de **0,01 SOL** y slippage del 15 %.
  - Modo de lanzamiento **Manual**.
- [ ] **Paso 4.** Dry-run.
  - La primera vez pide crear la **tabla de direcciones**. Créala y anota su coste.
  - Vuelve a hacer el dry-run: tiene que salir **en verde**.
- [ ] **Lanzar.** Se ve «Confirmación pendiente» y después **DONE**.
- [ ] **Anota** el mint y la firma de creación.
- [ ] Abre el token en pump.fun desde otro navegador. Tienen que coincidir el nombre, el símbolo y la imagen (la imagen puede tardar unos minutos en propagarse por IPFS).

## 5. Comprar (Live Workspace, `/t/<mint>`)

- [ ] Ticket: **comprar 0,005 SOL** desde la wallet holder.
  - La vista previa desglosa la fee de red, la priority fee, la fee de Pump.fun y el rent de la cuenta de token.
  - **Anota el coste total mostrado.**
- [ ] El resultado por wallet dice «entró». El trade aparece en la lista en 2 s o menos.
- [ ] La posición se actualiza con el coste base.

## 6. Vender

- [ ] Vende el **100 %** de la holder con la vista previa (slippage del 5 %). Resultado «entró».
- [ ] Opcional: vende también el dev buy desde la wallet dev.

## 7. Reclamar comisiones (`/rewards`)

- [ ] **Escanear.** La wallet dev aparece con lo reclamable y el neto.
- [ ] Si el **neto es positivo**: reclama.
  - En la confirmación se ve el neto.
  - En el resultado, «recibido» tiene que ser igual a lo reclamable menos el coste, y la bóveda tiene que quedar en 0.
- [ ] Si el neto es negativo: **no reclames**.
  - Anota lo reclamable y el coste que muestra la vista previa.
  - Esto también cuenta: es la protección de REQ-REW-002.

## 8. Cierre

- [ ] Recolecta el SOL que quede en las wallets con MAX hacia el funder y retíralo a tu wallet externa. El retiro pide la contraseña y avisa si la dirección es nueva.
- [ ] En Ajustes, usa **Exportar diagnóstico**. Antes de enviarlo, ábrelo y comprueba que no lleva claves.
- [ ] En el Dashboard (`/`), el P&L del lanzamiento cuadra con lo que gastaste y recibiste, fees incluidas.

## Qué devolver a Claude

Solo datos públicos. **Nunca** las claves de RPC o Pinata, la contraseña ni el archivo de la bóveda.

1. El mint y las firmas: tabla de direcciones, creación, compra, venta(s), reclamo (si lo hubo), transferencias y retiro.
2. Los costes que mostró cada vista previa: transferencia, compra, venta y reclamo.
3. El archivo de diagnóstico (opcional).
4. Cualquier error o texto raro que aparezca, con una captura.

## Qué verifica Claude (solo lectura)

- **Cada firma.** Con `getTransaction` en un RPC público, que esté confirmada y sin error, el programa que la ejecutó (Pump.fun o PumpSwap) y la fee real.
- **REQ-COST-001.** Que el coste real coincida con el mostrado, con una diferencia de 1 % o menos más la priority fee.
- **Creación.** Que create y dev buy van en **la misma transacción** y que la URI de metadatos es `https://…/ipfs/<cid>` y responde con el JSON correcto (con la imagen pública).
- **Reclamo.** Que lo recibido es lo reclamable menos el coste, y que la bóveda del creador queda vacía.
- **Diagnóstico.** Que no lleva secretos (escaneo).

El resultado se anota en `docs/E2E.md` (fila «Prueba de humo en mainnet») y en la nota del proyecto.
