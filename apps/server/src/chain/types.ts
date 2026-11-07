// REQ-CORE-001: contrato común de los adaptadores de launchpad. Montos en unidades base (bigint):
// lamports para SOL y unidades mínimas del token (6 decimales en Pump.fun). Claves en base58.

export type Side = "buy" | "sell";

export type Capabilities = {
  id: string;
  name: string;
  chain: "solana";
  modes: ("classic" | "mayhem")[];
  quotes: "SOL"[];
  /** dev buy en la misma transacción que la creación (todo o nada) */
  bundleInSameTx: boolean;
  customMint: boolean;
  tokenDecimals: number;
  graduatesTo: string;
};

/** Dónde se opera el token: en la curva, completo a la espera de la migración, o en PumpSwap. */
export type Venue = "curve" | "migrating" | "pumpswap";

export type CurveQuote = {
  side: Side;
  venue?: Venue;
  /** lo que entra: lamports (compra) o tokens (venta) */
  amountIn: bigint;
  /** lo que sale según la curva: tokens (compra) o lamports (venta) */
  amountOut: bigint;
  /** límite que se envía al programa: máximo de SOL a gastar (compra) o mínimo a recibir (venta) */
  limit: bigint;
  slippagePct: number;
  priceImpactPct: number;
  /** market cap tras la operación, en lamports */
  marketCapLamports: bigint;
  /** progreso hacia la graduación (0–100), a partir de las reservas reales de la curva */
  graduationPct: number;
  complete: boolean;
};

export type LaunchQuote = {
  devTokens: bigint;
  buyTokens: bigint[];
  supply: bigint;
  marketCapLamports: bigint;
  graduationPct: number;
  /** fee del pad en puntos básicos, tal y como la informa el programa */
  padFeeBps: number;
};

/** Transacción preparada por el adaptador. `payload` es opaco: solo lo entiende el sender del mismo backend. */
export type PreparedTx = {
  kind: "create" | "buy" | "sell" | "claim" | "transfer" | "migrate" | "token-transfer" | "burn" | "close-accounts";
  /** límite de CU solicitado; la priority fee se cobra sobre él */
  cuLimit?: number;
  /** tablas de direcciones para compilar el mensaje v0 (solo el backend real) */
  lookupTables?: import("@solana/web3.js").AddressLookupTableAccount[];
  payer: string;
  signers: string[];
  payload: unknown;
  quote?: CurveQuote;
  mint?: string;
};

/** Estado leído de la cadena para el Live Workspace (REQ-LIVE-001). */
export type TokenInfo = {
  mint: string;
  venue: Venue;
  tokenProgram: string;
  decimals: number;
  supply: bigint;
  creator: string;
  mayhem: boolean;
  /** lamports por token entero (10^decimals unidades) */
  priceLamports: number;
  marketCapLamports: bigint;
  graduationPct: number;
  /** market cap aproximado al completarse la curva (reservas iniciales del programa) */
  graduationMcLamports: bigint;
  /** reservas del lugar donde se opera (curva: virtuales; PumpSwap: las del pool) */
  reserves: { quote: bigint; token: bigint };
  /** cuentas de token que no son holders reales (la curva y el vault del pool) */
  systemOwners: { owner: string; label: string }[];
  curveAccount: string;
  pool: string | null;
  /** fee total del pad en puntos básicos para el siguiente trade (protocolo + creador [+ LP]) */
  padFeeBps: number;
  metadata: { name: string; symbol: string; uri: string } | null;
};

/** Transacción tal y como la devuelve el RPC, para `parseEvents`. */
export type RawTx = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
  inner?: { program: string; data: Uint8Array }[];
  /** fee real de la transacción (meta.fee) y variación de SOL por cuenta (post − pre), si se leyó completa */
  fee?: bigint;
  deltas?: Record<string, bigint>;
};

export type TradeEvent = {
  kind: "trade";
  index: number;
  venue: "curve" | "pumpswap";
  mint: string;
  side: Side;
  /** SOL del trader con todas las fees del pad: gastado (compra) o recibido neto (venta) */
  lamports: bigint;
  tokens: bigint;
  user: string;
  ts: number;
  /** market cap después del trade, con las reservas que informa el evento */
  marketCapLamports: bigint;
  /** fees del pad incluidas en `lamports` (Pump.fun: fee + creador; PumpSwap: LP + protocolo + creador) */
  feeLamports?: bigint;
};
export type ChainEvent = TradeEvent | { kind: "complete"; index: number; mint: string; ts: number } | { kind: "migrate"; index: number; mint: string; pool: string; ts: number };

export type SendErrorCode = "MIGRATING" | "SLIPPAGE" | "INSUFFICIENT_FUNDS" | "RENT" | "BLOCKHASH_EXPIRED" | "RPC_DOWN" | "BUNDLE_REJECTED" | "CURVE_COMPLETE" | "SIMULATION_FAILED" | "UNKNOWN";

export type SendResult =
  /** `tipLamports`: propina de Jito que lleva la tx (0 si Jito está apagado o si no cabía en la creación) */
  | { status: "confirmed"; signature: string; unitsConsumed?: number; feeLamports?: bigint; reused?: boolean; tipLamports?: bigint }
  /** `postLamports`: saldo de `watch` tras la simulación (para mostrar el neto exacto) */
  | { status: "simulated"; unitsConsumed?: number; logs?: string[]; postLamports?: bigint; tipLamports?: bigint }
  /** no se sabe si aterrizó (o no se pudo ni enviar por un RPC caído): reintentar con la misma key es seguro */
  | { status: "pending"; signature?: string; message: string }
  | { status: "failed"; signature?: string; code: SendErrorCode; message: string };

export interface LaunchpadAdapter {
  capabilities(): Capabilities;
  /** cotización para una curva que aún no existe (dev buy) */
  quoteCreate(p: { devBuyLamports: bigint; slippagePct: number }): Promise<CurveQuote>;
  quote(p: { mint: string; side: Side; amount: bigint; slippagePct: number }): Promise<CurveQuote>;
  /** dev buy y compras de holders en orden sobre una curva nueva (estimación del resumen, REQ-LAUNCH-011) */
  quoteLaunch(p: { devBuyLamports: bigint; buys: bigint[] }): Promise<LaunchQuote>;
  buildCreateTx(p: { name: string; symbol: string; uri: string; creator: string; mint: string; devBuyLamports: bigint; slippagePct: number; mayhem: boolean; holderReward?: boolean }): Promise<PreparedTx>;
  /**
   * Compras del bundle de lanzamiento, cotizadas sobre la curva que dejaría el dev buy (y las compras anteriores
   * del propio bundle). No lee la curva de la cadena: todavía no existe. El snipe no usa esto.
   */
  buildLaunchBundleBuys(p: { mint: string; creator: string; devBuyLamports: bigint; slippagePct: number; mayhem: boolean; holderReward: boolean; buys: { user: string; lamports: bigint }[] }): Promise<PreparedTx[]>;
  buildBuyTx(p: { mint: string; user: string; lamports: bigint; slippagePct: number }): Promise<PreparedTx>;
  buildSellTx(p: { mint: string; user: string; tokens: bigint; slippagePct: number }): Promise<PreparedTx>;
  /**
   * REQ-LIVE-005: enviar tokens a otra dirección (crea su cuenta de token si no existe, pagada por `from`).
   * `rentLamports` es el rent de esa cuenta nueva (0 si ya existía), para la vista previa.
   */
  buildTokenTransferTx(p: { mint: string; from: string; to: string; tokens: bigint }): Promise<PreparedTx & { rentLamports: bigint }>;
  /** REQ-LIVE-005: quemar tokens propios (reduce la supply). */
  buildBurnTx(p: { mint: string; owner: string; tokens: bigint }): Promise<PreparedTx>;
  claimableFees(creators: string[]): Promise<Map<string, bigint>>;
  buildClaimTx(p: { creator: string }): Promise<PreparedTx>;
  /** rent de las cuentas que crea el reclamo: `upfront` = lo que la wallet necesita además de la fee de red;
   *  `kept` = la parte que no vuelve (coste) */
  claimRent(creator: string): Promise<{ upfront: bigint; kept: bigint }>;
  /** REQ-WAL-010: cierra cuentas de token VACÍAS de `owner`; el rent va a `dest`, que paga la fee (firma también `owner`) */
  buildCloseAccountsTx(p: { owner: string; dest: string; accounts: EmptyTokenAccount[] }): Promise<PreparedTx>;
  /** curva, PumpSwap o en migración; market cap, progreso y reservas reales */
  tokenInfo(mint: string): Promise<TokenInfo>;
  /** trades, graduación y migración de una transacción ya confirmada (las fallidas no emiten nada) */
  parseEvents(tx: RawTx, ctx?: { mint?: string; supply?: bigint; mayhem?: boolean }): ChainEvent[];
  /**
   * Rent de las cuentas que creará o ampliará la operación de `user`: cuenta de token, cuenta de volumen
   * del programa, la WSOL temporal de PumpSwap y la ampliación del pool que paga el primero que opera tras
   * migrar. El MAX y la comprobación previa lo reservan para que la orden nunca falle (REQ-COST-002).
   */
  tradeAccountsRent(p: { mint: string; user: string; side: "buy" | "sell" }): Promise<bigint>;
  /** migración a PumpSwap sin permisos; solo se expone en el perfil de pruebas */
  buildMigrateTx(p: { mint: string; payer: string }): Promise<PreparedTx>;
}

/** Firma los bytes de un mensaje con la clave de `address`. Lo implementa `signer` (la bóveda). */
export type MessageSigner = (address: string, message: Uint8Array) => Uint8Array;

/**
 * Resultado de un bundle. `simulated` significa que el libro local lo aplicó atómico y NO se llamó al Block Engine:
 * `bundleId` es null. Un `bundleId` sin firmas confirmadas no es un aterrizaje.
 */
export type BundleSendResult =
  | { status: "confirmed"; signatures: string[]; bundleId: string | null; simulated: boolean; tipLamports: bigint; reused?: boolean }
  | { status: "pending"; signatures: string[]; bundleId: string | null; message: string }
  | { status: "partial"; signatures: string[]; ok: boolean[]; bundleId: string | null; simulated: boolean; message: string }
  | { status: "failed"; code: SendErrorCode; message: string; signatures?: string[] };

export interface TxSender {
  send(tx: PreparedTx, opts: { idempotencyKey: string; simulateOnly?: boolean; watch?: string; /** fuerza la propina (0n = sin propina); si no se pasa, la decide Jito */ tipLamports?: bigint }): Promise<SendResult>;
  sendBundle(items: { tx: PreparedTx; idempotencyKey: string }[], opts: { bundleKey: string }): Promise<BundleSendResult>;
}

export type EmptyTokenAccount = { address: string; mint: string; program: string; lamports: bigint };

export interface ChainReader {
  balances(addresses: string[]): Promise<Map<string, bigint>>;
  tokenBalance(mint: string, owner: string): Promise<bigint>;
  accountExists(address: string): Promise<boolean>;
  /** REQ-LAUNCH-005: metadatos en cadena del token (extensión de Token-2022 o cuenta de Metaplex) */
  tokenMetadata(mint: string): Promise<{ name: string; symbol: string; uri: string } | null>;
  /** saldo del token de varias wallets (ATA del programa de token del mint) */
  tokenBalances(mint: string, owners: string[]): Promise<Map<string, bigint>>;
  /** holders del token: propietario y cantidad; `complete` = la lista incluye a todos */
  holders(mint: string): Promise<{ items: { owner: string; amount: bigint }[]; complete: boolean }>;
  /** firmas que mencionan `address`, de la más nueva a la más antigua */
  signatures(address: string, opts: { until?: string; before?: string; limit: number }): Promise<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>;
  transactions(signatures: string[]): Promise<RawTx[]>;
  /** logs en vivo por el WebSocket del RPC; devuelve la función para cancelar */
  onLogs?(address: string, cb: (tx: RawTx) => void): () => void;
  /** precio SOL/USD (oráculo); null si no hay o está caducado */
  solUsd(): Promise<{ usd: number; publishedAt: number } | null>;
  /** rent de una cuenta de token nueva del mint (lo que cuesta la primera compra) */
  tokenAccountRent(mint: string): Promise<bigint>;
  /** REQ-WAL-010: cuentas de token de `owner` con saldo exactamente 0 (Token y Token-2022) */
  emptyTokenAccounts(owner: string): Promise<EmptyTokenAccount[]>;
  /** solo en el perfil de pruebas */
  airdrop?(address: string, lamports: bigint): Promise<void>;
}

export type TransferBuilder = {
  /** transferencias de SOL desde `from`, troceadas en tx que caben en 1.232 bytes */
  build(from: string, items: { to: string; lamports: bigint }[]): Promise<PreparedTx[]>;
  /** fee exacta de una tx preparada (misma fórmula en vista previa y envío) */
  feeOf(tx: PreparedTx): bigint;
  rentExemptMin(): Promise<bigint>;
};

export type LaunchAltManager = {
  /** ¿está lista la tabla de direcciones para crear tokens? (no envía nada) */
  status(): Promise<{ ready: boolean; address: string | null; keys: number; rentLamports: bigint }>;
  /** la crea si falta; la paga `payer` (una sola vez por perfil y versión del programa) */
  ensure(payer: string): Promise<{ address: string; created: boolean }>;
  /** Cierre en dos pasos para recuperar su rent: desactivar y, ~512 slots después, cerrar. `null` si no hay */
  closing(): Promise<AltCloseInfo>;
  /** desactiva la tabla actual (la firma su autoridad); la siguiente creación de token creará otra */
  deactivate(): Promise<SendResult>;
  /** cierra la tabla desactivada y manda su rent a `recipient` (paga la fee la autoridad) */
  close(recipient: string): Promise<SendResult>;
};

export type AltCloseInfo = {
  /** tabla en uso (activa) */
  current: { address: string; authority: string | null; lamports: bigint } | null;
  /** tabla desactivada pendiente de cerrar; `slotsLeft` = 0 cuando ya se puede cerrar */
  closing: { address: string; authority: string | null; lamports: bigint; deactivationSlot: number; slotsLeft: number } | null;
};

export type ChainEnv = { adapter: LaunchpadAdapter; sender: TxSender; reader: ChainReader; transfers: TransferBuilder; launchAlt: LaunchAltManager };

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const solToLamports = (sol: number) => BigInt(Math.round(sol * 1e9));
