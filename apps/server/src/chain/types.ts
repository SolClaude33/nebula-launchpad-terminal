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

/** Transacción preparada por el adaptador. `payload` es opaco: solo lo entiende el sender del mismo backend. */
export type PreparedTx = {
  kind: "create" | "buy" | "sell" | "claim";
  payer: string;
  signers: string[];
  payload: unknown;
  quote?: CurveQuote;
  mint?: string;
};

export type SendErrorCode = "SLIPPAGE" | "INSUFFICIENT_FUNDS" | "BLOCKHASH_EXPIRED" | "RPC_DOWN" | "BUNDLE_REJECTED" | "CURVE_COMPLETE" | "SIMULATION_FAILED" | "UNKNOWN";

export type SendResult =
  | { status: "confirmed"; signature: string; unitsConsumed?: number; feeLamports?: bigint; reused?: boolean }
  | { status: "simulated"; unitsConsumed?: number; logs?: string[] }
  | { status: "failed"; signature?: string; code: SendErrorCode; message: string };

export interface LaunchpadAdapter {
  capabilities(): Capabilities;
  /** cotización para una curva que aún no existe (dev buy) */
  quoteCreate(p: { devBuyLamports: bigint; slippagePct: number }): Promise<CurveQuote>;
  quote(p: { mint: string; side: Side; amount: bigint; slippagePct: number }): Promise<CurveQuote>;
  buildCreateTx(p: { name: string; symbol: string; uri: string; creator: string; mint: string; devBuyLamports: bigint; slippagePct: number; mayhem: boolean }): Promise<PreparedTx>;
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
  /** solo en el perfil de pruebas */
  airdrop?(address: string, lamports: bigint): Promise<void>;
}

export type ChainEnv = { adapter: LaunchpadAdapter; sender: TxSender; reader: ChainReader };

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const solToLamports = (sol: number) => BigInt(Math.round(sol * 1e9));
