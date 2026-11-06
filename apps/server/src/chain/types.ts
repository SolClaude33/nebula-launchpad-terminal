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

export type CurveQuote = {
  side: Side;
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
  kind: "create" | "buy" | "sell" | "claim" | "transfer";
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

export type SendErrorCode = "SLIPPAGE" | "INSUFFICIENT_FUNDS" | "RENT" | "BLOCKHASH_EXPIRED" | "RPC_DOWN" | "BUNDLE_REJECTED" | "CURVE_COMPLETE" | "SIMULATION_FAILED" | "UNKNOWN";

export type SendResult =
  | { status: "confirmed"; signature: string; unitsConsumed?: number; feeLamports?: bigint; reused?: boolean }
  | { status: "simulated"; unitsConsumed?: number; logs?: string[] }
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
  buildBuyTx(p: { mint: string; user: string; lamports: bigint; slippagePct: number }): Promise<PreparedTx>;
  buildSellTx(p: { mint: string; user: string; tokens: bigint; slippagePct: number }): Promise<PreparedTx>;
  claimableFees(creators: string[]): Promise<Map<string, bigint>>;
  buildClaimTx(p: { creator: string }): Promise<PreparedTx>;
}

/** Firma los bytes de un mensaje con la clave de `address`. Lo implementa `signer` (la bóveda). */
export type MessageSigner = (address: string, message: Uint8Array) => Uint8Array;

export interface TxSender {
  send(tx: PreparedTx, opts: { idempotencyKey: string; simulateOnly?: boolean }): Promise<SendResult>;
}

export interface ChainReader {
  balances(addresses: string[]): Promise<Map<string, bigint>>;
  tokenBalance(mint: string, owner: string): Promise<bigint>;
  accountExists(address: string): Promise<boolean>;
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
};

export type ChainEnv = { adapter: LaunchpadAdapter; sender: TxSender; reader: ChainReader; transfers: TransferBuilder; launchAlt: LaunchAltManager };

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const solToLamports = (sol: number) => BigInt(Math.round(sol * 1e9));
