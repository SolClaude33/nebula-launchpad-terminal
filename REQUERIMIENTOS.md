# Requerimientos: herramienta local para lanzar y operar tokens

| Campo | Valor |
|---|---|
| Nombre de trabajo | **Nébula** (provisional) |
| Versión del documento | 0.2, borrador para revisión e2e |
| Fecha | 2026-11-06 |
| Estado | Planificación. No hay código. |
| Tipo | **Herramienta privada, de un solo operador, que corre entera en local.** Sin registro, sin cuentas y sin servidor remoto propio. |
| MVP | **Solo Pump.fun en Solana** |
| Referencia principal | Proxima (docs.proxima.tools) |
|

### Cambios respecto a la v0.1
- Se eliminan registro, login, sesiones, multiusuario, colaboración, referidos, cashback, comisiones de plataforma, niveles, suscripción, perfil, API pública y página de estado.
- El acceso pasa a ser una **bóveda local cifrada con contraseña maestra** (sección 6.1).
- Se sustituye la arquitectura de servidor (Postgres, Redis, KMS en la nube) por una de proceso local con SQLite (sección 5).
- El MVP queda limitado a **Pump.fun**. Los demás launchpads y cadenas pasan a fases posteriores.

## Cómo leer este documento

- Cada requerimiento lleva un ID (`REQ-<MÓDULO>-NNN`), una prioridad y unos criterios de aceptación que se pueden probar.
- Las prioridades siguen MoSCoW: **M** = Must (obligatorio en el MVP), **S** = Should, **C** = Could, **W** = Won't (fuera de esta versión).
- `ref:` indica de qué producto de referencia sale la idea. `nuevo` significa que ninguna referencia lo documenta y lo exige este diseño.
- La sección 11 contiene los escenarios E2E (`E2E-NN`), y cada uno indica qué REQ cubre. La sección 14 recoge lo que las fuentes no aclaran. Este documento no inventa parámetros que no estén documentados.

---

## 1. Visión y objetivos

Nébula es una aplicación de escritorio para uso propio que corre en `localhost`. Permite hacer todo el ciclo de un token de Pump.fun desde un solo lugar: crear el token, gestionar muchas wallets propias, financiarlas, operar el token en vivo, automatizar la gestión de la posición, reclamar las comisiones de creador y medir resultados. El frontend tiene que ser muy cuidado: más bonito, más rápido y más claro que las herramientas de referencia.

**Objetivos medibles**
1. Desde arrancar la app (`pnpm start`) hasta tener un token lanzado con wallets financiadas pasan 5 minutos o menos (medido en E2E-01 a E2E-04).
2. El tiempo desde pulsar "Lanzar" hasta que el token está on-chain es de 3 s o menos (p95) con un RPC sano.
3. El Instant Trade envía una orden en 300 ms o menos (p95) desde la tecla hasta el envío al RPC.
4. La interfaz carga en 1,5 s o menos en arranque en frío local, con INP de 200 ms o menos.
5. Ninguna clave privada se guarda en claro en disco ni llega nunca al navegador (sección 7.1).

---

## 2. Alcance

### 2.1 Dentro del alcance (MVP)
- Bóveda local cifrada con contraseña maestra, bloqueo automático y copia de seguridad.
- Gestión de wallets: crear, importar, exportar, carpetas, roles, archivar y borrar.
- Funder (wallet de financiación), dispersión simple, recolección y retiro.
- Asistente de lanzamiento en Pump.fun: metadatos, clonar o importar un token, borradores con autoguardado, presets, lanzamiento programado y dev buy.
- Compras multi-wallet desde las wallets propias en modo **Quick** o **Manual**.
- Live Workspace: gráfico, operaciones, holders, panel de Instant Trade con atajos de teclado, enviar y quemar tokens.
- Automatizaciones de la posición propia: DCA y órdenes límite (ladder y trailing stop como Should).
- Reclamo de comisiones de creador de Pump.fun.
- Compras y ventas con las wallets en el token
- Dashboard y P&L locales.
- Ajustes: RPC propio, clave de IPFS, slippage, priority fee y Jito.

### 2.2 Fuera de alcance por ser una herramienta privada
Registro y login, cuentas y multiusuario, colaboración y permisos, referidos y cashback, comisiones de plataforma, niveles y suscripción, perfil y avatar, API pública, página de estado, emails transaccionales, i18n (la interfaz va solo en español, con textos centralizados por si se traduce más adelante), y acceso desde otros dispositivos o desde Internet.

### 2.3 Fuera de alcance (decisión de producto)
Las referencias incluyen funciones cuyo propósito es que actividad coordinada o interna parezca orgánica a otros traders. Nébula **no** las implementa, porque eso equivale a herramientas de wash trading y de supply oculto. Son:


> Lo que sí se conserva del Sniper Guard es la variante "Complete Early", que solo detiene las compras planificadas restantes (REQ-LAUNCH-014).

---

## 3. Usuario

Hay un único **operador**, el dueño de la máquina. No existen cuentas, roles ni permisos. La única barrera de acceso es la contraseña maestra de la bóveda (REQ-VAULT).

---

## 4. Cadenas y launchpads

### 4.1 Matriz por fases
Todos los launchpads se integran mediante un **adaptador** común (REQ-CORE-001), aunque el MVP solo tenga uno. Así, añadir pads más adelante no obliga a tocar la interfaz.

| Fase | Cadena | Launchpads | Monedas de cotización | Destino tras graduar |
|---|---|---|---|---|
| **MVP** | Solana | **Pump.fun** | SOL (USDC como Should si el adaptador lo soporta) | PumpSwap |
| F2 | Solana | Raydium LaunchLab, LetsBonk, Meteora DBC, Bags | SOL, USD1, USDC | Raydium o Meteora |
| F3 | BNB Smart Chain | Four.meme, flap.sh | BNB, USDT, USDC | PancakeSwap |
| F4 | Robinhood Chain, Base | pons, Clanker, Uniswap V2/V3/V4 | ETH, USDG, USDC | Uniswap |

ref: Proxima/Networks & Launchpads, Vortex/Chains & Launchpads.

### 4.2 Pump.fun en el MVP
- **Opciones del pad** (ref: Vortex): modo Classic o Mayhem (Mayhem exige cotización en SOL o USDC), y destino de las comisiones Creator Fees o Holder Rewards (**irreversible**).
- **Graduación:** se muestra el market cap de graduación y la barra de progreso de la bonding curve. Tras migrar, las operaciones van contra PumpSwap.
- **Pares personalizados** (cotizar contra una acción tokenizada u otra moneda de Pump.fun): **W** en el MVP, ver Q-06.

### 4.3 Contrato del adaptador de launchpad (REQ-CORE-001, M)
Cada adaptador implementa estas funciones:
- `capabilities()`: modos soportados, monedas de cotización, opciones propias del pad, si admite bundle en la misma transacción y si admite una dirección de mint personalizada.
- `buildCreateTx(metadata, devBuy, options)`
- `buildBuyTx` y `buildSellTx(wallet, amount, slippage)`, que funcionan tanto en la bonding curve como después de migrar a PumpSwap.
- `quote(amount, side)`: precio, impacto, market cap estimado y umbral de graduación.
- `claimableFees(wallets)` y `buildClaimTx`
- `parseEvents(tx)`: trades, migración y graduación.

**Criterio de aceptación:** el adaptador de Pump.fun pasa una suite de contrato contra el validador local con los programas clonados, contra un mock y, cada cierto tiempo, contra mainnet con montos mínimos (sección 10).

---

## 5. Arquitectura local

### 5.1 Principios
- Se arranca con un solo comando (`pnpm start`), sin Docker obligatorio ni servicios externos propios.
- El servidor escucha **solo en `127.0.0.1`**. Nunca en `0.0.0.0`.
- Los únicos servicios externos son los imprescindibles: el RPC de Solana, Jito para bundles y IPFS para los metadatos. Las claves de esos servicios las pone el operador en Ajustes.
- No hay telemetría ni analítica de terceros.

### 5.2 Stack
| Capa | Elección | Motivo |
|---|---|---|
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind v4, Radix/shadcn, Motion, TanStack Query, Zustand | Es el stack que Nicol ya usa. |
| Gráficos | TradingView Lightweight Charts y Recharts o visx para analítica | Rendimiento con datos en vivo. |
| Backend local | Proceso Node (Fastify) en el mismo monorepo, con REST y WebSocket en `127.0.0.1` y validación con zod | Tipos compartidos con el frontend. Las claves nunca pasan al navegador. |
| Base de datos | **SQLite** (better-sqlite3 con Drizzle), en modo WAL | Un solo archivo, sin servidor, fácil de respaldar. |
| Colas y tareas | Scheduler propio dentro del proceso, con su estado persistido en SQLite | Los lanzamientos programados y las automatizaciones sobreviven a un reinicio. No hace falta Redis. |
| **Bóveda** | Archivo cifrado con AES-256-GCM. La clave se deriva de la contraseña maestra con Argon2id (libsodium) | Las claves están cifradas en disco y solo se descifran en la memoria del backend. |
| Solana | @solana/kit, SDK o IDL de Pump.fun y PumpSwap, Jito bundles para create más dev buy | Baja latencia y atomicidad. |
| Datos en vivo | WebSocket del RPC (Helius o Triton recomendados) y, opcionalmente, Yellowstone gRPC | Trades y saldos en tiempo real. |
| IPFS | Pinata (o la subida de metadatos que exponga Pump.fun) | Pump.fun exige una URI de metadatos. |
| Logs | Archivos rotados en local (pino), con redacción de secretos | Para diagnosticar sin servicios externos. |
| Empaquetado | `pnpm start` levanta todo y abre `http://127.0.0.1:<puerto>` en el navegador predeterminado. No hay app de escritorio (Tauri o Electron queda en Won't). | Decidido en Q-02. |

### 5.3 Módulos del backend
`api` (REST y WS) → `orchestrator` (máquina de estados de lanzamientos y tareas, scheduler) → `signer` (único módulo con acceso a la bóveda desbloqueada) → `tx-sender` (envío, reintentos, bundles Jito) ↔ `indexer` (eventos on-chain y precios) → `notifier` (WS hacia la interfaz y Telegram opcional).

---

## 6. Requerimientos funcionales

### 6.1 VAULT: bóveda y acceso local
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-VAULT-001 | M | El primer arranque pide crear una contraseña maestra (12 caracteres como mínimo, con un medidor de fortaleza) y avisa de que **no se puede recuperar** | Sin contraseña no se crea ninguna wallet. El aviso exige una casilla de "Entiendo". | nuevo |
| REQ-VAULT-002 | M | Cada arranque pide la contraseña en la pantalla `/unlock` para desbloquear la bóveda | Una contraseña errónea no descifra nada y hay un retardo creciente entre intentos. | nuevo |
| REQ-VAULT-003 | M | Bloqueo automático tras N minutos de inactividad (15 por defecto, configurable) y bloqueo manual con un botón o atajo | Al bloquearse, las claves se borran de la memoria y **todas las tareas `RUNNING` y los lanzamientos programados pasan a `PAUSED`**. Al desbloquear, la app lista lo que se pausó y pide confirmación para reanudar cada cosa (igual que REQ-AUTO-008). Un aviso visible antes del bloqueo (60 s) permite posponerlo. | nuevo |
| REQ-VAULT-004 | M | **Reconfirmar la contraseña** antes de exportar claves, retirar fondos fuera de las wallets propias, borrar wallets con saldo o cambiar la contraseña | Sin reconfirmación, el backend rechaza la acción aunque se llame directamente a la API. | nuevo |
| REQ-VAULT-005 | M | Copia de seguridad de la bóveda: exportar el archivo cifrado y restaurarlo | La restauración en otra máquina funciona con la misma contraseña. El archivo es inútil sin ella. | nuevo |
| REQ-VAULT-006 | S | Cambiar la contraseña maestra (vuelve a cifrar toda la bóveda) | Si se interrumpe a la mitad, la bóveda anterior sigue intacta (escritura atómica). | nuevo |

### 6.2 WAL: wallets
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-WAL-001 | M | Crear de 1 a 100 wallets por operación | Las wallets aparecen en la tabla con saldo "conectando…" hasta la primera lectura. | Proxima/Create Wallets |
| REQ-WAL-002 | M | Importar claves privadas en bloque (pegar o subir un archivo) | Las claves duplicadas se detectan. Una clave inválida se marca por fila sin abortar el lote. | Vortex, Block X |
| REQ-WAL-003 | M | Carpetas: crear, renombrar y mover wallets en lote | Una wallet puede estar en varias carpetas. | Proxima/Folders |
| REQ-WAL-004 | M | Roles: Dev, Holder, Trading y roles personalizados (minúsculas, dígitos y `_`, hasta 32 caracteres) | Un rol asignado a mano nunca cambia solo. | Vortex |
| REQ-WAL-005 | M | Tabla de wallets con búsqueda, filtros (rol, carpeta), ocultar vacías, orden, selección múltiple y acción "copiar direcciones" | 1.000 wallets se renderizan con virtualización a 60 fps. | Vortex |
| REQ-WAL-006 | M | Exportar una clave o una selección (requiere REQ-VAULT-004) | La clave se revela en un modal con temporizador o se descarga en un archivo cifrado. El evento queda en el registro de actividad local. | Proxima, Vortex, Block X |
| REQ-WAL-007 | M | Archivar, restaurar y borrar. No se puede borrar una wallet usada por una tarea activa. | Borrar una wallet con saldo exige reconfirmar la contraseña y ofrece "Recolectar antes de borrar". | Vortex, Block X |
| REQ-WAL-008 | M | Acciones: Depositar (QR), Transferir (1 a 1), Dispersar (1 a N, monto fijo o por wallet) y Recolectar (N a 1) | Cada acción muestra una vista previa con las fees de red antes de confirmar. Una vez lanzada, la acción sigue corriendo aunque se cierre el modal. | Proxima, Vortex, Block X |
| REQ-WAL-009 | S | Actividad por wallet: antigüedad, número de trades, tokens, entradas y salidas, P&L realizado | Coincide con la cadena con un desfase de 1 % o menos. | Vortex |
| REQ-WAL-010 | S | Recuperar rent: cerrar las cuentas de token vacías y devolver el SOL a la wallet elegida | — | Proxima/Recover Residual Funds |

### 6.3 FUND: funder
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-FUND-001 | M | Una o varias wallets funder, una de ellas predeterminada | Siempre hay un funder predeterminado. | Proxima/Manage Funders |
| REQ-FUND-002 | M | Depósito con dirección y QR, y detección del ingreso en tiempo real | El saldo se actualiza en 5 s o menos tras la confirmación. | Proxima |
| REQ-FUND-003 | M | Retiro a una dirección externa con historial | Requiere REQ-VAULT-004. Libreta de direcciones guardadas, y aviso destacado si el destino es una dirección nueva. | Proxima + nuevo |
| REQ-FUND-004 | M | Borrar solo funders que no sean predeterminados. Si tienen saldo, se ofrece "Retirar antes de borrar". | — | Proxima |

### 6.4 LAUNCH: asistente de lanzamiento (Pump.fun)
Tiene 4 pasos (ref: Vortex Create Project y Proxima Create Launch): **1. Token**, **2. Configuración**, **3. Financiación**, **4. Revisar y lanzar**.

| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-LAUNCH-002 | M | Metadatos: nombre, símbolo, descripción, imagen (JPG, PNG, GIF o WebP de 2 MB como máximo, con recorte) o vídeo (MP4 o WebM de 10 MB como máximo), y enlaces a X, Telegram y web (URL completa) | La validación es en línea. La subida a IPFS muestra su progreso. | Proxima |
| REQ-LAUNCH-003 | M | **No se puede lanzar** si la subida a IPFS no ha terminado o ha fallado | El botón queda deshabilitado con el motivo. Si la subida falla, se ofrece volver a subir. | Proxima/Funding |
| REQ-LAUNCH-004 | M | Autoguardado de borradores con estado visible: Sin guardar, Guardando…, Guardado, Error | Cerrar el asistente con Esc o con × nunca pierde datos. El borrador se retoma desde Lanzamientos > Borradores. | Vortex |
| REQ-LAUNCH-005 | M | Clonar un token (copiar metadatos de una dirección) o importar un token existente para operarlo | Clonar solo rellena el formulario y todo se puede editar. | Proxima, Vortex, Block X |
| REQ-LAUNCH-006 | S | Dirección de mint personalizada (vanity), importando su clave o generándola en local | La clave del mint va directamente a la bóveda. | Proxima/Advanced |
| REQ-LAUNCH-007 | M | Opciones de Pump.fun: Classic o Mayhem, y Creator Fees o Holder Rewards (irreversible) | Las opciones irreversibles llevan un aviso explícito y una casilla de confirmación. | Vortex |
| REQ-LAUNCH-008 | M | Dev buy incluido en la transacción de creación (bundle atómico con Jito) | Si el bundle falla, no se crea el token (todo o nada). | Proxima, Block X |
| REQ-LAUNCH-009 | M | Modo **Quick**: compras de wallets holder propias justo después del dev buy, con monto fijo o rango por wallet | Las wallets se pueden reordenar con drag & drop. Se muestra la supply total que queda en wallets propias. | Proxima/Launch Modes |
| REQ-LAUNCH-010 | M | Modo **Manual**: solo el dev buy, y el resto se opera desde el Live Workspace | — | Proxima |
| REQ-LAUNCH-011 | M | Resumen de estimaciones: market cap estimado (y umbral de graduación), supply esperada del dev y de los holders, coste total (compras, fees de red, propina Jito, fees de Pump.fun y colchón) y pérdida máxima estimada | Cada cifra lleva un tooltip con la fórmula. | Proxima/Launch Settings |
| REQ-LAUNCH-012 | M | **Slippage real**: el valor configurado es el que se envía. Por defecto es el 15 % en compras. | Nunca se envía un 100 % en silencio. Proxima sí lo hace, y aquí se corrige a propósito. | nuevo (corrige Proxima) |
| REQ-LAUNCH-013 | M | Financiación desde el funder: distribuir a las wallets del plan | Se valida que cada wallet tiene saldo suficiente antes de habilitar "Lanzar". | Proxima/Funding |
| REQ-LAUNCH-014 | S | **Launch Guard**: si las compras externas acumuladas superan un umbral, se detienen las compras planificadas restantes ("Complete Early"). No vende nada. | Lista blanca de direcciones. Termina cuando se completa el plan o al pasar un tiempo (mínimo 1 s). | Proxima/Sniper Guard (sin Nuke) |
| REQ-LAUNCH-015 | M | Lanzamiento programado (`Launch at`) | El job persiste en SQLite y se ejecuta aunque se reinicie la app antes de la hora, siempre que la bóveda esté desbloqueada. Si llega la hora con la bóveda bloqueada, no se lanza y queda `PAUSED` hasta que se confirme. Se puede cancelar hasta T−10 s. | Vortex |
| REQ-LAUNCH-016 | M | **Protección contra doble lanzamiento**: idempotency key por borrador | Pulsar "Lanzar" dos veces o tener la red lenta nunca produce dos tokens. Se muestra el estado "Confirmación pendiente". | Vortex |
| REQ-LAUNCH-017 | M | **Vista previa / dry-run** antes de lanzar: simula cada transacción (`simulateTransaction`) e indica por wallet si va a entrar o a fallar | Un fallo en la simulación bloquea el lanzamiento y explica la causa. | Vortex/Preview + nuevo |
| REQ-LAUNCH-018 | S | Presets: guardar y reutilizar la configuración de un lanzamiento, y "Quick Launch" desde un preset | Al cargar un preset se resaltan los campos que hay que revisar. | Proxima, Block X |
| REQ-LAUNCH-019 | C | "Post to X" al lanzar | Publica solo si el lanzamiento se confirma. | Block X |
| REQ-LAUNCH-020 | S | Archivar lanzamientos | — | Proxima |

> REQ-LAUNCH-001 (elegir red y launchpad) se activa en F2. En el MVP, el asistente fija Solana y Pump.fun, pero el selector ya existe con el resto de opciones marcadas como "próximamente".

### 6.5 LIVE: Live Workspace
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-LIVE-001 | M | Página por token con gráfico de velas en vivo, market cap, barra de progreso hacia la graduación, trades en vivo, holders (marcando cuáles son wallets propias) y posición agregada | Los trades llegan con un desfase de 2 s o menos respecto a la cadena. | Proxima, Vortex |
| REQ-LIVE-002 | M | Comprar y vender desde una, varias o todas las wallets, en paralelo o escalonado, tanto en la curva como en PumpSwap tras migrar | Un resultado por wallet (entró, falló, omitida) con su motivo. | Proxima/Buy & Sell |
| REQ-LIVE-003 | M | **Instant Trade** flotante: elegir carpeta o wallets, montos rápidos de compra y venta, P&L en vivo, posición arrastrable (guardada en local) y opacidad o blur configurables | Se puede mover sin salir del viewport. | Proxima/Instant Trade |
| REQ-LIVE-004 | S | Atajos de teclado: mantener Espacio arma las teclas, con distribución QWERTY, AZERTY o QWERTZ | Sin Espacio pulsado, ninguna tecla dispara una orden. | Proxima |
| REQ-LIVE-005 | M | Enviar tokens y quemar supply | Quemar exige escribir el símbolo para confirmar. | Proxima |
| REQ-LIVE-006 | S | Tracker: lista de seguimiento de tokens | — | Proxima/Tracker |
| REQ-LIVE-007 | C | Descubrimiento de Pump.fun: tokens nuevos, a punto de graduar y migrados | — | Block X |

### 6.6 AUTO: automatizaciones de la posición propia
Siguen el modelo de tareas de Vortex: estados `IDLE`, `RUNNING`, `PAUSED`, `COMPLETED`, `STOPPED`, `FAILED` y `TIMEOUT`. Las tareas solo se ejecutan mientras la app está abierta y la bóveda desbloqueada.

| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-AUTO-001 | M | **DCA**: compra o vende un monto fijo o aleatorio (mínimo y máximo) cada intervalo (máximo 24 h) | Respeta las condiciones de fin por monto, por duración o la que llegue antes. | Proxima/Auto Buy |
| REQ-AUTO-002 | M | **Órdenes límite** por market cap en USD: compras con objetivos descendentes y ventas con objetivos ascendentes | Una validación impide objetivos desordenados. | Proxima |
| REQ-AUTO-003 | S | **Ladder** de venta por tramos (porcentaje de la posición a cada market cap) | — | Vortex |
| REQ-AUTO-004 | S | **Trailing stop** (porcentaje desde el máximo) | — | Vortex |
| REQ-AUTO-005 | M | Opciones comunes: rango de market cap, wallets, retardo de inicio, slippage máximo (por defecto 5 % también en ventas) y "parar tras N errores seguidos" | La venta nunca queda sin protección de precio por defecto (Proxima sí lo permite). | Proxima + nuevo |
| REQ-AUTO-006 | M | Ciclo de vida: Iniciar, Pausar, Reanudar, Editar (en caliente si está pausada), Parar, Ejecutar de nuevo, Duplicar y Borrar (solo si está parada) | Parar o pausar nunca vende nada. | Vortex |
| REQ-AUTO-007 | M | Registro por tarea: ejecuciones (hora, wallet, lado, monto, firma, estado), resultados y reintentos agrupados por intento | Paginación con "Cargar anteriores". | Vortex |
| REQ-AUTO-008 | M | Al reiniciar la app, las tareas que estaban `RUNNING` pasan a `PAUSED` y piden confirmación para reanudar | Nunca se reanuda sola una tarea que mueve fondos. | nuevo |
| REQ-AUTO-009 | S | Presets de tareas | — | Vortex |
| REQ-AUTO-010 | M | La wallet dev queda excluida por defecto y hay que activarla de forma explícita | La tarjeta muestra "incl. dev" cuando la incluye. | Vortex |

### 6.7 REW: comisiones de creador
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-REW-001 | M | Escanear las wallets propias en busca de comisiones de creador reclamables en Pump.fun y PumpSwap | Lista por token y por wallet con el monto en SOL y en USD. | Block X/Fees |
| REQ-REW-002 | M | Reclamar uno o todos, con **pantalla de confirmación** (Proxima no la tiene) | Muestra el neto después de las fees de red. | Proxima, Block X |
| REQ-REW-003 | S | "Financiar fees de reclamo": recargar gas a las wallets que no tienen suficiente | — | Block X |

### 6.8 DASH: dashboard y P&L
| ID | P | Requerimiento | Criterios de aceptación | ref |
|---|---|---|---|---|
| REQ-DASH-001 | M | Rendimiento por período (24 H, 7 D, 30 D, 1 A, Todo), en USD o SOL. Gráficos de rendimiento total, P&L diario y win rate. | El P&L descuenta las fees de red, la propina Jito y las fees de Pump.fun. | Proxima, Vortex |
| REQ-DASH-002 | M | Saldo total (funder más wallets), mejores lanzamientos, lanzamientos recientes y P&L medio por lanzamiento | — | Proxima |
| REQ-DASH-003 | S | Calendario de P&L (mes o año) | — | Proxima |
| REQ-DASH-004 | C | Tarjeta de P&L exportable a PNG | Se genera en local. | Proxima, Block X |
| REQ-DASH-005 | M | Estado vacío que guía a crear la primera wallet y el primer lanzamiento | — | Proxima |

### 6.9 COST: costes visibles
No hay comisión de plataforma, pero sí costes de red y del pad que el operador tiene que ver.

| ID | P | Requerimiento | Criterios de aceptación |
|---|---|---|---|
| REQ-COST-001 | M | Cada vista previa desglosa la fee de red, la priority fee, la propina Jito, la fee de Pump.fun y el rent | **El coste mostrado al revisar coincide con el real** (diferencia de 1 % o menos más la priority fee). Si cambia de forma significativa, hay que volver a confirmar. |
| REQ-COST-002 | M | Los botones MAX y de porcentaje reservan lo necesario para fees y rent | Una venta o compra al máximo nunca falla por falta de SOL para fees. |

### 6.10 Otros
| ID | P | Requerimiento | ref |
|---|---|---|---|
| REQ-SET-001 | M | Ajustes: RPC principal y de respaldo (HTTP y WS), endpoint y propina de Jito, clave de IPFS, slippage y priority fee por defecto, minutos para el bloqueo automático, distribución del teclado y tema (oscuro por defecto, claro opcional) | Proxima, Block X |
| REQ-SET-002 | M | Los secretos de Ajustes (claves de RPC y de IPFS) se guardan dentro de la bóveda, nunca en `.env` ni en texto plano | nuevo |
| REQ-NOTIF-001 | M | Notificaciones dentro de la app (toasts y centro de notificaciones): lanzamiento confirmado, tarea terminada o fallida, comisiones reclamables | nuevo |
| REQ-NOTIF-002 | C | Notificaciones a un bot de Telegram propio (solo avisos, sin operar) | nuevo |
| REQ-LOG-001 | M | Registro de actividad local (exportaciones, retiros, lanzamientos, cambios de ajustes) y logs técnicos con un botón "Exportar diagnóstico" que redacta los secretos | nuevo |
| REQ-CMDK-001 | S | Paleta de comandos (Ctrl+K) para buscar tokens, wallets y acciones | Block X |

---

## 7. Requerimientos no funcionales

### 7.1 Seguridad local (crítico)
Aunque la herramienta sea privada, guarda claves con dinero real. Todo lo de esta sección es obligatorio (M).

| ID | Requerimiento |
|---|---|
| NFR-SEC-001 | Las claves se cifran con AES-256-GCM y la clave de cifrado se deriva de la contraseña maestra con Argon2id (parámetros mínimos: 64 MB y 3 iteraciones). La contraseña nunca se guarda. |
| NFR-SEC-002 | Las claves descifradas solo existen en la memoria del módulo `signer`. Nunca se envían al navegador, salvo en el flujo de exportación (REQ-WAL-006). |
| NFR-SEC-003 | El backend escucha solo en `127.0.0.1`, exige un token de sesión aleatorio generado al arrancar (para que otras webs abiertas en el navegador no puedan llamarlo) y valida `Origin` y `Host` contra DNS rebinding. |
| NFR-SEC-004 | Ninguna clave, contraseña ni secreto de Ajustes aparece en logs, mensajes de error ni archivos de diagnóstico. Un test automático lo comprueba. |
| NFR-SEC-005 | CSP estricta en la interfaz y sin scripts de terceros en tiempo de ejecución. |
| NFR-SEC-006 | Dependencias fijadas con lockfile, `pnpm audit` en cada cambio y revisión manual de cualquier dependencia nueva que toque claves o firmas (riesgo de cadena de suministro). |
| NFR-SEC-007 | La carpeta de datos (`~/.nebula` o equivalente en Windows) queda fuera del repositorio y en `.gitignore`. |

### 7.2 Fiabilidad de transacciones
| ID | Requerimiento |
|---|---|
| NFR-TX-001 | Cada acción que mueve fondos lleva un idempotency key. Un reintento nunca duplica el efecto. |
| NFR-TX-002 | RPC con failover (principal y respaldo configurables) y health checks. Si el principal cae, se cambia en 3 s o menos. |
| NFR-TX-003 | Priority fee dinámico (percentil configurable) y propina Jito en los bundles. Reintentos con backoff y blockhash nuevo. |
| NFR-TX-004 | Máquina de estados persistida en SQLite para lanzamientos y tareas. Sobrevive a un cierre inesperado sin perder ni duplicar pasos. |
| NFR-TX-005 | Conciliación al arrancar: se compara el estado local con la cadena y se marcan las discrepancias (por ejemplo, una transacción enviada antes de un cierre). |

### 7.3 Rendimiento y datos
- Lecturas de la API local p95 de 50 ms o menos. Datos en vivo con un desfase de 2 s o menos respecto a la cadena.
- Copia automática diaria de la base SQLite y de la bóveda cifrada en la carpeta de datos, conservando las últimas 7.

---

## 8. Frontend y diseño ("mega bonito")

### 8.1 Dirección visual
- **Concepto:** un "observatorio" o terminal espacial. Fondo casi negro con un ligero tinte azul, superficies de vidrio esmerilado, acentos de luz de neón con moderación y datos muy legibles. Debe sentirse premium y calmado, no como un casino.
- **Paleta (tokens):**
  - `--bg` #07080C, `--surface-1` #0E1017, `--surface-2` #151823, `--border` rgba(255,255,255,.06)
  - `--text` #E8EAF2, `--text-muted` #8A90A6
  - `--accent` violeta-cian (degradado #7C5CFF → #22D3EE), `--buy` #22C55E, `--sell` #F43F5E, `--warn` #F59E0B
  - Tema claro definido con los mismos tokens desde el principio.
- **Tipografía:** Inter Variable o Geist para la interfaz, y JetBrains Mono o Geist Mono con cifras tabulares para números y direcciones.
- **Detalles de marca:** un campo de estrellas sutil en la pantalla de desbloqueo y en los estados vacíos (WebGL ligero, que se desactiva con `prefers-reduced-motion`), bordes con un gradiente animado en los CTA principales y un glow suave al pasar el cursor por las tarjetas.
- **Validación:** antes de construir hay que ejecutar la fase de dirección de diseño (skill `web-design-direction`): tokens, pantalla de desbloqueo, Live Workspace y asistente.

### 8.2 Mapa de pantallas
| Ruta | Contenido |
|---|---|
| `/setup` | Primer arranque: crear la contraseña maestra y configurar el RPC y la clave de IPFS |
| `/unlock` | Desbloquear la bóveda |
| `/` | Dashboard |
| `/launch/new` | Asistente de 4 pasos con resumen lateral fijo |
| `/launches`, `/launches/drafts` | Lanzamientos y borradores |
| `/t/[address]` | Live Workspace |
| `/wallets` | Wallets (3 columnas: carpetas, tabla y acciones) |
| `/funder` | Funder |
| `/automations` | Todas las tareas |
| `/rewards` | Comisiones de creador |
| `/tracker` | Seguimiento |
| `/settings` | Ajustes, copia de seguridad y diagnóstico |

### 8.3 Inventario de componentes
- **Layout:** sidebar plegable, topbar con estado del RPC (latencia y salud), candado de bloqueo y Ctrl+K, y paneles redimensionables en el Live Workspace (guardados en local).
- **Datos:** tabla virtualizada (TanStack Table y Virtual), celdas de dirección con copiar y enlace a Solscan, cifras animadas (count-up al cambiar, con flash verde o rojo), sparklines y chips de estado de tarea con su color.
- **Trading:** panel de Instant Trade flotante, ticket de compra y venta, gráfico de velas con marcadores de las operaciones propias y barra de progreso hacia la graduación.
- **Asistente:** stepper con validación por paso, panel de resumen y coste fijo, y una lista de lo que falta para poder lanzar con botones "Corregir".
- **Feedback:** toasts con enlace a la transacción, modal de confirmación con el desglose de costes, skeletons (nunca spinners a pantalla completa) y estados vacíos ilustrados.

### 8.4 Movimiento
- Duraciones de 120–220 ms en la interfaz y 300–500 ms en transiciones de página. Easing `cubic-bezier(.2,.8,.2,1)`.
- Las animaciones tienen que explicar algo (un trade entrando, un estado que cambia). Nunca bloquean una acción de trading.
- `prefers-reduced-motion` desactiva las estrellas, el count-up y el parallax.

### 8.5 Pantallas y accesibilidad
- Solo escritorio: se diseña para 1280–1920 px y se mantiene usable desde 1024 px. No hay versión móvil.
- Contraste de 4,5:1 o más, foco visible, navegación completa con teclado y nada que dependa solo del color (compra y venta llevan también icono y texto).

### 8.6 Presupuesto de rendimiento
- JS inicial de 300 KB gzip o menos (carga diferida del gráfico y de WebGL).
- Arranque en frío de la interfaz en 1,5 s o menos e INP de 200 ms o menos con 1.000 wallets cargadas.

---

## 9. Modelo de datos (SQLite)
`VaultMeta(kdfParams, salt, version)`, `Settings`, `Wallet(role, archived, encryptedKey)`, `Folder`, `WalletFolder`, `Funder`, `Launch(status, mode, options, idempotencyKey)`, `LaunchDraft`, `LaunchWallet(order, amount)`, `Token`, `Task(type, status, config, attempt)`, `TaskExecution(txSig, side, amount, status, reason)`, `Transaction(hash, kind, feeNetwork, tipJito, feePad)`, `Claim`, `AddressBook`, `ActivityLog`, `Notification`, `Preset`.

---

## 10. Entorno de pruebas y estrategia E2E
Ninguna referencia tiene modo de pruebas (Vortex lo admite de forma explícita). Nébula debe tenerlo desde el primer día.

| ID | Requerimiento |
|---|---|
| TEST-ENV-001 | **Perfiles:** `test` (validador local con `solana-test-validator` o Surfpool, clonando de mainnet los programas de Pump.fun y PumpSwap) y `mainnet`. Cada perfil tiene su propia carpeta de datos y su propia bóveda. |
| TEST-ENV-002 | **Adaptador mock** de Pump.fun con el mismo contrato que REQ-CORE-001 y escenarios de fallo inyectables (RPC caído, slippage excedido, bundle rechazado, blockhash caducado). |
| TEST-ENV-003 | **Dry-run** disponible en toda acción que mueve fondos (REQ-LAUNCH-017), también en `mainnet`. |
| TEST-ENV-004 | Seeds: wallets financiadas en local y tokens en distintas fases (recién creado, cerca de graduar, migrado a PumpSwap). |
| TEST-ENV-005 | **Herramientas:** Playwright para E2E de interfaz y API, Vitest para unidades, una suite de contrato del adaptador y axe dentro de Playwright. |
| TEST-ENV-006 | Un comando `pnpm test:e2e` levanta el validador, aplica los seeds y ejecuta toda la suite. Opcional: GitHub Actions si el repositorio lo tiene. |
| TEST-ENV-007 | Prueba de humo en `mainnet` con montos mínimos (por ejemplo 0,01 SOL) antes de cada versión, siguiendo una checklist manual. |
| TEST-ENV-008 | Banner visible "PERFIL DE PRUEBAS" en `test`. Las bóvedas de `test` y `mainnet` nunca se mezclan. |

---

## 11. Escenarios E2E (trazabilidad)
Cada escenario se ejecuta contra el perfil `test`. Cuenta como superado cuando todos sus pasos y afirmaciones pasan.

| ID | Escenario | Pasos clave y afirmaciones | Cubre |
|---|---|---|---|
| E2E-01 | Primer arranque | Abrir la app, llegar a `/setup`, crear la contraseña maestra y configurar el RPC. Comprobar que existe la bóveda cifrada en disco y no contiene nada legible. | VAULT-001, SET-001, SET-002, NFR-SEC-001 |
| E2E-02 | Desbloqueo y bloqueo automático | Reiniciar, desbloquear con la contraseña correcta y fallar con una incorrecta. Con un DCA en `RUNNING`, esperar el tiempo de bloqueo: aparece el aviso de 60 s, vuelve a `/unlock`, la API rechaza acciones y el DCA queda `PAUSED`. Al desbloquear, se lista el DCA y solo se reanuda tras confirmarlo. | VAULT-002, VAULT-003, AUTO-008 |
| E2E-03 | Crear y organizar wallets | Crear 10 wallets, meterlas en una carpeta, asignar el rol Holder, filtrar y copiar direcciones. | WAL-001, WAL-003, WAL-004, WAL-005 |
| E2E-04 | Funder y dispersión | Financiar el funder (airdrop local), dispersar 0,1 SOL a 10 wallets y comprobar los saldos y el desglose de fees. | FUND-001, FUND-002, WAL-008, COST-001 |
| E2E-05 | Lanzamiento Quick en Pump.fun | Metadatos con imagen, IPFS correcto, opciones del pad, dev buy y 5 holders, dry-run en verde, lanzar. El token existe, el dev buy está en el mismo bundle y las 5 compras han entrado. | LAUNCH-002, 003, 007, 008, 009, 011, 013, 017 |
| E2E-06 | IPFS fallido bloquea el lanzamiento | Forzar un fallo de subida. El botón está deshabilitado y volver a subir lo habilita. | LAUNCH-003 |
| E2E-07 | Doble clic en "Lanzar" | Dos clics rápidos con la red lenta producen un solo token y el estado "Confirmación pendiente". | LAUNCH-016, NFR-TX-001 |
| E2E-08 | Borrador y reanudación | Rellenar a medias, cerrar con Esc, reiniciar la app y reanudar desde Borradores sin perder datos. | LAUNCH-004 |
| E2E-09 | Lanzamiento programado tras un reinicio | Programarlo a T+2 min, cerrar y abrir la app, desbloquear y comprobar que se ejecuta a su hora. Cancelar otro programado. | LAUNCH-015, NFR-TX-004 |
| E2E-10 | Launch Guard | Simular compras externas por encima del umbral. Las compras restantes se detienen y no se vende nada. | LAUNCH-014 |
| E2E-11 | Instant Trade con atajos | Abrir el panel, elegir una carpeta, mantener Espacio y pulsar la tecla de compra. Se compra con el monto rápido y el P&L se actualiza. Sin Espacio no pasa nada. | LIVE-002, LIVE-003, LIVE-004 |
| E2E-12 | Operar tras la graduación | Llevar un token del seed hasta la migración. Comprar y vender contra PumpSwap desde el mismo panel. | LIVE-001, LIVE-002, CORE-001 |
| E2E-13 | DCA y límite | Crear un DCA de venta cada 1 min y una orden límite a cierto market cap. Pausar, editar, reanudar y parar sin que se venda nada. Registro correcto. | AUTO-001, 002, 005, 006, 007 |
| E2E-14 | Tarea activa y reinicio | Con un DCA en `RUNNING`, matar el proceso y volver a abrir. La tarea aparece `PAUSED` y no se reanuda sola. | AUTO-008, NFR-TX-004, NFR-TX-005 |
| E2E-15 | Slippage respetado | Configurar un 2 % y mover el precio un 5 % antes de enviar. La transacción falla con el motivo "slippage" y no se envía con un 100 %. | LAUNCH-012, AUTO-005 |
| E2E-16 | Comisiones de creador | Generar comisiones en local, escanear, reclamar todas con la pantalla de confirmación y comprobar el neto mostrado frente al recibido. | REW-001, REW-002, COST-001 |
| E2E-17 | Exportar clave | Exportar una wallet. Se pide reconfirmar la contraseña, el evento queda en el registro de actividad y la clave no aparece en ningún log (escaneo). | WAL-006, VAULT-004, NFR-SEC-004 |
| E2E-18 | Borrar wallet con saldo | Intentarlo. Se ofrece "Recolectar antes de borrar". Recolectar y borrar. | WAL-007, WAL-008 |
| E2E-19 | Retiro a dirección nueva | Retirar desde el funder a una dirección que no está en la libreta. Aparece el aviso destacado y se pide la contraseña. | FUND-003, VAULT-004 |
| E2E-20 | Failover de RPC | Tumbar el RPC principal durante una compra. Entra por el de respaldo en 3 s o menos. | NFR-TX-002 |
| E2E-21 | Protección del backend local | Desde otra pestaña con otro origen, llamar a la API local. Se rechaza por el token de sesión y la validación de `Origin`. Comprobar que el puerto no responde desde la IP de la red local. | NFR-SEC-003 |
| E2E-22 | Copia y restauración | Exportar la bóveda, borrar la carpeta de datos y restaurar con la contraseña. Las wallets y los saldos vuelven. | VAULT-005 |
| E2E-23 | Dashboard | Después de E2E-05 y E2E-13, el P&L cuadra con las transacciones (fees incluidas). | DASH-001, DASH-002 |
| E2E-24 | Accesibilidad | axe sin violaciones serias en las rutas principales, a 1024 y 1440 px, sin scroll horizontal. | 8.5 |

---

## 12. Fases (roadmap)
| Fase | Contenido | Criterio de salida |
|---|---|---|
| F0, diseño | Dirección visual, prototipo de la pantalla de desbloqueo, del Live Workspace y del asistente, y especificación del adaptador y de la bóveda | Nicol aprueba el diseño. |
| **F1, MVP Pump.fun** | VAULT, WAL, FUND, LAUNCH (Quick y Manual), LIVE con Instant Trade, AUTO (DCA y límite), REW, COST, DASH básico, ajustes y logs | Los 24 escenarios E2E en verde en el perfil `test`, y la prueba de humo en mainnet superada. |
| F2 | Más pads de Solana (LaunchLab, Bonk, Meteora, Bags), ladder y trailing stop, presets, tracker, descubrimiento, bot de Telegram para avisos | Suite de contrato en verde para cada pad nuevo. |
| F3 | BSC (Four.meme, flap.sh), con gestor de nonce para EVM | E2E de nonce en un fork con anvil. |
| F4 | Robinhood Chain, Base, liquidez en Uniswap y bloqueos con Streamflow | — |

---

## 13. Riesgos
| Riesgo | Mitigación |
|---|---|
| Olvidar la contraseña maestra (las claves se pierden) | Aviso en el primer arranque, copia de la bóveda y recomendación de guardar la contraseña en un gestor de contraseñas |
| Malware en el PC que robe la bóveda o lea la memoria | Cifrado fuerte, bloqueo automático, no dejar la bóveda desbloqueada sin uso, y mantener en las wallets calientes solo lo necesario |
| Otra web abierta en el navegador ataca la API local | NFR-SEC-003 |
| Cambios en los programas de Pump.fun o PumpSwap | Adaptador versionado, suite de contrato contra programas clonados y prueba de humo en mainnet antes de cada versión |
| Congestión o caída del RPC | NFR-TX-002 y NFR-TX-003 |
| Dependencia de terceros (IPFS, Jito) | Estados de fallo visibles y proveedor alternativo configurable |

---

## 14. Preguntas abiertas
| ID | Pregunta |
|---|---|
| Q-01 | Nombre definitivo y marca (Nébula es provisional). |
| ~~Q-02~~ | **Resuelta (2026-11-06):** se usa en el navegador con `pnpm start`. Sin app de escritorio. |
| Q-03 | ¿Se usa en un solo PC o hace falta poder llevar la bóveda entre varios equipos (más allá de copia y restauración)? |
| ~~Q-04~~ | **Resuelta (2026-11-06):** al bloquearse la bóveda, las automatizaciones y los lanzamientos programados se pausan (REQ-VAULT-003). |
| Q-05 | ¿Qué proveedor de RPC se va a usar (Helius, Triton, QuickNode)? Afecta a la latencia y al indexado en vivo. |
| Q-06 | ¿Hacen falta en el MVP la cotización en USDC o los pares personalizados de Pump.fun, o basta con SOL? |
| Q-07 | ¿Importar wallets ya existentes en el MVP o solo crearlas? |


---

