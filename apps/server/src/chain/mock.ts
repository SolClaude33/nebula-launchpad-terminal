// TEST-ENV-002: adaptador mock con el mismo contrato que el real y fallos inyectables.
// Curva de constante producto con los parámetros iniciales de Pump.fun (30 SOL / 1.073 M tokens virtuales).
// Al completarse la curva, la migración crea un pool de constante producto con las reservas reales (PumpSwap).
// Cada envío confirmado queda como una "transacción" con eventos codificados en sus logs, para que
// el indexer en vivo funcione igual que contra el RPC (firmas, transacciones y suscripción a logs).
import type { DB } from "../db";
import type { ChainEnv, ChainEvent, ChainReader, CurveQuote, LaunchQuote, LaunchpadAdapter, MessageSigner, PreparedTx, RawTx, SendErrorCode, SendResult, TokenInfo, TransferBuilder, TxSender } from "./types";
import { RENT_EXEMPT_MIN_DEFAULT, transferCuLimit, txFee } from "./fees";
import { chunkTransfers } from "./transfers";
import { JITO_OFF, tipAccountFor, tipFor, type JitoConfig } from "./jito";

const INIT = { vSol: 30_000_000_000n, vTok: 1_073_000_000_000_000n, realTok: 793_100_000_000_000n, supply: 1_000_000_000_000_000n };
const FEE_BPS = 100n; // total; de ello CREATOR_BPS va a la bóveda del creador
const CREATOR_BPS = 30n;
const TX_FEE = 5_000n;
export const MOCK_ATA_RENT = 2_039_280n;
const MINT_RENT = 21_800_000n;
const MIGRATION_FEE = 15_000_000n;
export const MOCK_SOL_USD = 150;
const LOG_PREFIX = "Program data: mock:";

type Curve = { vSol: bigint; vTok: bigint; realSol: bigint; realTok: bigint; complete: boolean; creator: string; creatorVault: bigint; name: string; symbol: string; mayhem: boolean };
type Pool = { base: bigint; quote: bigint };
type Op =
  | { op: "create"; mint: string; creator: string; devBuy: bigint; tokens: bigint; maxSol: bigint; name: string; symbol: string; uri?: string; mayhem: boolean }
  | { op: "buy"; mint: string; user: string; tokens: bigint; maxSol: bigint }
  | { op: "sell"; mint: string; user: string; tokens: bigint; minSol: bigint }
  | { op: "claim"; creator: string }
  | { op: "close"; owner: string; dest: string; mints: string[] }
  | { op: "migrate"; mint: string; payer: string }
  | { op: "transfer"; from: string; items: { to: string; lamports: bigint }[] }
  | { op: "token-transfer"; mint: string; from: string; to: string; tokens: bigint }
  | { op: "burn"; mint: string; owner: string; tokens: bigint };

/** Evento tal y como lo emite el mock (se serializa en los logs de la transacción). */
type MockEvent = ChainEvent extends infer E ? (E extends ChainEvent ? Omit<E, "index"> : never) : never;

const bpsOf = (v: bigint, bps: bigint) => (v * bps) / 10_000n;
const withSlip = (v: bigint, pct: number, up: boolean) => (up ? v + (v * BigInt(Math.floor(pct * 10))) / 1000n : v - (v * BigInt(Math.floor(pct * 10))) / 1000n);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const unjson = (s: string) => JSON.parse(s, (_k, x) => (typeof x === "string" && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
const mcOf = (quote: bigint, token: bigint) => (token > 0n ? (quote * INIT.supply) / token : 0n);
export const mockCurveAccount = (mint: string) => `curve-${mint}`;
export const mockPoolAccount = (mint: string) => `pool-${mint}`;
export const mockTokenAccount = (mint: string, owner: string) => `ata-${mint.slice(0, 8)}-${owner}`;

export class MockLedger {
  sol = new Map<string, bigint>();
  tokens = new Map<string, Map<string, bigint>>();
  curves = new Map<string, Curve>();
  pools = new Map<string, Pool>();
  /** URI de metadatos de cada token creado */
  uris = new Map<string, string>();
  /** tokens quemados por mint (la supply baja) */
  burned = new Map<string, bigint>();
  /** fallos a devolver en los próximos envíos, en orden */
  failures: SendErrorCode[] = [];
  /** movimiento de precio (en %) aplicado justo antes de ejecutar el siguiente envío */
  priceShockPct = 0;
  /** retardo artificial por envío (para pausar operaciones a mitad en los tests) */
  sendDelayMs = 0;
  sent = new Map<string, SendResult>();
  seq = 0;
  /** transacciones confirmadas, de la más antigua a la más nueva */
  txs: (RawTx & { mentions: Set<string> })[] = [];
  listeners = new Map<string, Set<(tx: RawTx) => void>>();
  private events: MockEvent[] = [];

  balance(a: string) {
    return this.sol.get(a) ?? 0n;
  }
  tokenOf(mint: string, owner: string) {
    return this.tokens.get(mint)?.get(owner) ?? 0n;
  }
  private addTokens(mint: string, owner: string, d: bigint) {
    const m = this.tokens.get(mint) ?? new Map();
    m.set(owner, (m.get(owner) ?? 0n) + d);
    this.tokens.set(mint, m);
  }

  static buyOut(c: Pick<Curve, "vSol" | "vTok" | "realTok">, lamports: bigint) {
    const net = lamports - bpsOf(lamports, FEE_BPS);
    const k = c.vSol * c.vTok;
    let out = c.vTok - k / (c.vSol + net);
    if (out > c.realTok) out = c.realTok;
    return out;
  }
  static costFor(c: Pick<Curve, "vSol" | "vTok">, tokens: bigint) {
    const k = c.vSol * c.vTok;
    const net = k / (c.vTok - tokens) - c.vSol + 1n;
    return (net * 10_000n) / (10_000n - FEE_BPS) + 1n;
  }
  static sellOut(c: Pick<Curve, "vSol" | "vTok">, tokens: bigint) {
    const k = c.vSol * c.vTok;
    const gross = c.vSol - k / (c.vTok + tokens);
    return gross - bpsOf(gross, FEE_BPS);
  }

  discardEvents() {
    this.events = [];
  }

  /** Tras un envío confirmado: lo registra como transacción y avisa a los suscriptores de logs. */
  record(signature: string, payer: string, extra: { fee?: bigint; pre?: Map<string, bigint> } = {}): RawTx {
    const events = this.events.splice(0);
    const mentions = new Set<string>([payer, ...events.flatMap((e) => [e.mint, ...(e.kind === "trade" ? [e.user] : [])])]);
    const deltas: Record<string, bigint> = {};
    if (extra.pre) for (const a of new Set([...extra.pre.keys(), ...this.sol.keys()])) {
      const d = this.balance(a) - (extra.pre.get(a) ?? 0n);
      if (d !== 0n) deltas[a] = d;
    }
    const tx = { signature, slot: this.txs.length + 1, blockTime: Math.floor(Date.now() / 1000), err: null, logs: events.map((e) => LOG_PREFIX + json(e)), mentions, fee: extra.fee, deltas: extra.pre ? deltas : undefined };
    this.txs.push(tx);
    for (const m of mentions) for (const cb of this.listeners.get(m) ?? []) cb(tx);
    return tx;
  }

  apply(o: Op, TX_FEE: bigint): { ok: true; fee: bigint } | { ok: false; code: SendErrorCode; message: string } {
    if (this.priceShockPct) {
      for (const c of this.curves.values()) c.vSol = c.vSol + (c.vSol * BigInt(Math.round(this.priceShockPct * 100))) / 10_000n;
      for (const p of this.pools.values()) p.quote = p.quote + (p.quote * BigInt(Math.round(this.priceShockPct * 100))) / 10_000n;
      this.priceShockPct = 0;
    }
    this.events = [];
    const fail = (code: SendErrorCode, message: string) => ({ ok: false as const, code, message });
    const now = Date.now();
    if (o.op === "transfer") {
      // Misma regla que Solana: cada cuenta acaba en 0 o en ≥ mínimo exento de rent
      const total = o.items.reduce((a, i) => a + i.lamports, 0n);
      const left = this.balance(o.from) - total - TX_FEE;
      if (left < 0n) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para el monto y la fee de red");
      if (left > 0n && left < RENT_EXEMPT_MIN_DEFAULT) return fail("RENT", "El origen quedaría con menos del mínimo exento de rent");
      for (const i of o.items) {
        const after = this.balance(i.to) + i.lamports;
        if (after > 0n && after < RENT_EXEMPT_MIN_DEFAULT) return fail("RENT", "Un destino quedaría por debajo del mínimo exento de rent");
      }
      this.sol.set(o.from, left);
      for (const i of o.items) this.sol.set(i.to, this.balance(i.to) + i.lamports);
      return { ok: true, fee: TX_FEE };
    }
    if (o.op === "create") {
      if (this.curves.has(o.mint)) return fail("SIMULATION_FAILED", "El mint ya existe");
      const curve: Curve = { vSol: INIT.vSol, vTok: INIT.vTok, realSol: 0n, realTok: INIT.realTok, complete: false, creator: o.creator, creatorVault: 0n, name: o.name, symbol: o.symbol, mayhem: o.mayhem };
      const cost = o.devBuy > 0n ? MockLedger.costFor(curve, o.tokens) : 0n;
      if (cost > o.maxSol) return fail("SLIPPAGE", "slippage: Too much SOL required to buy the given amount of tokens.");
      const need = cost + MINT_RENT + MOCK_ATA_RENT + TX_FEE;
      if (this.balance(o.creator) < need) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para crear el token");
      this.curves.set(o.mint, curve);
      if (o.uri) this.uris.set(o.mint, o.uri);
      if (o.devBuy > 0n) this.fill(o.mint, curve, o.creator, o.tokens, cost, now);
      this.sol.set(o.creator, this.balance(o.creator) - MINT_RENT - MOCK_ATA_RENT - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    if (o.op === "token-transfer" || o.op === "burn") {
      const owner = o.op === "burn" ? o.owner : o.from;
      if (!this.curves.has(o.mint)) return fail("SIMULATION_FAILED", "El mint no existe");
      if (o.tokens <= 0n) return fail("SIMULATION_FAILED", "Cantidad inválida");
      if (this.tokenOf(o.mint, owner) < o.tokens) return fail("SIMULATION_FAILED", "No hay tokens suficientes");
      const rent = o.op === "token-transfer" && this.tokenOf(o.mint, o.to) === 0n ? MOCK_ATA_RENT : 0n;
      if (this.balance(owner) < TX_FEE + rent) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red y la cuenta de destino");
      this.addTokens(o.mint, owner, -o.tokens);
      if (o.op === "token-transfer") this.addTokens(o.mint, o.to, o.tokens);
      else this.burned.set(o.mint, (this.burned.get(o.mint) ?? 0n) + o.tokens);
      this.sol.set(owner, this.balance(owner) - TX_FEE - rent);
      return { ok: true, fee: TX_FEE };
    }
    if (o.op === "close") {
      // REQ-WAL-010: en el mock una cuenta de token existe si hay entrada (mint, owner), aunque esté a 0
      for (const m of o.mints) if (!this.tokens.get(m)?.has(o.owner) || this.tokenOf(m, o.owner) !== 0n) return fail("SIMULATION_FAILED", "La cuenta no existe o no está vacía");
      if (this.balance(o.dest) < TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red");
      for (const m of o.mints) this.tokens.get(m)!.delete(o.owner);
      this.sol.set(o.dest, this.balance(o.dest) - TX_FEE + MOCK_ATA_RENT * BigInt(o.mints.length));
      return { ok: true, fee: TX_FEE };
    }
    if (o.op === "claim") {
      let total = 0n;
      for (const c of this.curves.values()) if (c.creator === o.creator) (total += c.creatorVault), (c.creatorVault = 0n);
      if (total === 0n) return fail("SIMULATION_FAILED", "No hay comisiones que reclamar");
      // como en la cadena: la fee se cobra antes de ejecutar, con el saldo previo
      if (this.balance(o.creator) < TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red");
      this.sol.set(o.creator, this.balance(o.creator) + total - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    const c = this.curves.get(o.mint);
    if (!c) return fail("SIMULATION_FAILED", "La curva no existe");
    if (o.op === "migrate") {
      if (!c.complete) return fail("SIMULATION_FAILED", "La curva aún no está completa");
      if (this.pools.has(o.mint)) return fail("SIMULATION_FAILED", "El pool ya existe");
      if (this.balance(o.payer) < TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red");
      // Al pool van los tokens que quedan en la curva y el SOL real menos la fee de migración
      const sold = [...(this.tokens.get(o.mint)?.values() ?? [])].reduce((a, b) => a + b, 0n);
      this.pools.set(o.mint, { base: INIT.supply - sold, quote: c.realSol - MIGRATION_FEE });
      this.sol.set(o.payer, this.balance(o.payer) - TX_FEE);
      this.events.push({ kind: "migrate", mint: o.mint, pool: mockPoolAccount(o.mint), ts: now });
      return { ok: true, fee: TX_FEE };
    }
    const pool = this.pools.get(o.mint);
    if (c.complete && !pool) return fail("MIGRATING", "La curva está completa y la migración a PumpSwap aún no ha ocurrido");
    // En PumpSwap la "curva" son las reservas reales del pool
    const venue = pool ? { vSol: pool.quote, vTok: pool.base } : c;
    if (o.op === "buy") {
      const cost = MockLedger.costFor(venue, o.tokens);
      if (cost > o.maxSol) return fail("SLIPPAGE", "slippage: Too much SOL required to buy the given amount of tokens.");
      const rent = this.tokenOf(o.mint, o.user) === 0n ? MOCK_ATA_RENT : 0n;
      if (this.balance(o.user) < cost + rent + TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente: monto + fees + rent");
      if (pool) {
        const net = cost - bpsOf(cost, FEE_BPS);
        pool.quote += net;
        pool.base -= o.tokens;
        c.creatorVault += bpsOf(cost, CREATOR_BPS);
        this.addTokens(o.mint, o.user, o.tokens);
        this.sol.set(o.user, this.balance(o.user) - cost);
        this.events.push({ kind: "trade", venue: "pumpswap", mint: o.mint, side: "buy", lamports: cost, feeLamports: bpsOf(cost, FEE_BPS), tokens: o.tokens, user: o.user, ts: now, marketCapLamports: mcOf(pool.quote, pool.base) });
      } else this.fill(o.mint, c, o.user, o.tokens, cost, now);
      this.sol.set(o.user, this.balance(o.user) - rent - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    // sell
    if (this.tokenOf(o.mint, o.user) < o.tokens) return fail("SIMULATION_FAILED", "No hay tokens suficientes para vender");
    const out = MockLedger.sellOut(venue, o.tokens);
    if (out < o.minSol) return fail("SLIPPAGE", "slippage: Too little SOL received to sell the given amount of tokens.");
    if (this.balance(o.user) < TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red");
    const gross = out + bpsOf(out, FEE_BPS);
    if (pool) {
      pool.quote -= gross;
      pool.base += o.tokens;
    } else {
      c.vSol -= gross;
      c.vTok += o.tokens;
      c.realSol -= gross;
      c.realTok += o.tokens;
    }
    c.creatorVault += bpsOf(gross, CREATOR_BPS);
    this.addTokens(o.mint, o.user, -o.tokens);
    this.sol.set(o.user, this.balance(o.user) + out - TX_FEE);
    const mc = pool ? mcOf(pool.quote, pool.base) : mcOf(c.vSol, c.vTok);
    this.events.push({ kind: "trade", venue: pool ? "pumpswap" : "curve", mint: o.mint, side: "sell", lamports: out, feeLamports: bpsOf(out, FEE_BPS), tokens: o.tokens, user: o.user, ts: now, marketCapLamports: mc });
    return { ok: true, fee: TX_FEE };
  }

  private fill(mint: string, c: Curve, user: string, tokens: bigint, cost: bigint, now: number) {
    const net = cost - bpsOf(cost, FEE_BPS);
    c.vSol += net;
    c.vTok -= tokens;
    c.realSol += net;
    c.realTok -= tokens;
    c.creatorVault += bpsOf(cost, CREATOR_BPS);
    this.addTokens(mint, user, tokens);
    this.sol.set(user, this.balance(user) - cost);
    this.events.push({ kind: "trade", venue: "curve", mint, side: "buy", lamports: cost, feeLamports: bpsOf(cost, FEE_BPS), tokens, user, ts: now, marketCapLamports: mcOf(c.vSol, c.vTok) });
    if (c.realTok === 0n) {
      c.complete = true;
      this.events.push({ kind: "complete", mint, ts: now });
    }
  }
}

function quoteOf(c: Curve, pool: Pool | undefined, side: "buy" | "sell", amount: bigint, slippagePct: number): CurveQuote {
  const v = pool ? { vSol: pool.quote, vTok: pool.base, realTok: pool.base } : c;
  const before = mcOf(v.vSol, v.vTok);
  let out: bigint, limit: bigint, after: { vSol: bigint; vTok: bigint; realTok: bigint };
  if (side === "buy") {
    out = MockLedger.buyOut(v, amount);
    // Igual que el SDK: máximo de SOL = monto enviado × (1 + slippage %)
    limit = withSlip(amount, slippagePct, true);
    after = { vSol: v.vSol + (amount - bpsOf(amount, FEE_BPS)), vTok: v.vTok - out, realTok: v.realTok - out };
  } else {
    out = MockLedger.sellOut(v, amount);
    limit = withSlip(out, slippagePct, false);
    after = { vSol: v.vSol - out, vTok: v.vTok + amount, realTok: v.realTok + amount };
  }
  const mc = mcOf(after.vSol, after.vTok);
  return {
    side,
    venue: pool ? "pumpswap" : "curve",
    amountIn: amount,
    amountOut: out,
    limit,
    slippagePct,
    priceImpactPct: Number(((mc - before) * 10_000n) / before) / 100,
    marketCapLamports: mc,
    graduationPct: pool ? 100 : Number(((INIT.realTok - after.realTok) * 10_000n) / INIT.realTok) / 100,
    complete: pool ? true : after.realTok === 0n,
  };
}

const migratingError = () => Object.assign(new Error("La curva está completa y la migración a PumpSwap aún no ha ocurrido. Espera a que exista el pool."), { code: "MIGRATING" });

export function createMockEnv(sign: MessageSigner, ledger = new MockLedger(), priority: () => number = () => 0, db?: () => DB, jito: () => JitoConfig = () => JITO_OFF): ChainEnv & { ledger: MockLedger } {
  const feeOf = (tx: PreparedTx) => txFee(tx.signers.length, tx.cuLimit ?? 400_000, priority());
  const fresh = (): Curve => ({ vSol: INIT.vSol, vTok: INIT.vTok, realSol: 0n, realTok: INIT.realTok, complete: false, creator: "", creatorVault: 0n, name: "", symbol: "", mayhem: false });
  const curve = (mint: string) => {
    const c = ledger.curves.get(mint);
    if (!c) throw Object.assign(new Error("Este token no es de Pump.fun: no tiene bonding curve."), { statusCode: 404 });
    return c;
  };
  const tradable = (mint: string) => {
    const c = curve(mint);
    const pool = ledger.pools.get(mint);
    if (c.complete && !pool) throw migratingError();
    return { c, pool };
  };
  const vTokEnd = INIT.vTok - INIT.realTok;
  const gradMc = (((INIT.vSol * INIT.vTok) / vTokEnd) * INIT.supply) / vTokEnd;

  const adapter: LaunchpadAdapter = {
    capabilities: () => ({ id: "mock", name: "Pump.fun (mock)", chain: "solana", modes: ["classic", "mayhem"], quotes: ["SOL"], bundleInSameTx: true, customMint: true, tokenDecimals: 6, graduatesTo: "PumpSwap" }),
    quoteCreate: async ({ devBuyLamports, slippagePct }) => quoteOf(fresh(), undefined, "buy", devBuyLamports, slippagePct),
    quote: async ({ mint, side, amount, slippagePct }) => {
      const { c, pool } = tradable(mint);
      return quoteOf(c, pool, side, amount, slippagePct);
    },
    quoteLaunch: async ({ devBuyLamports, buys }): Promise<LaunchQuote> => {
      const c = fresh();
      const step = (l: bigint) => {
        if (l <= 0n) return 0n;
        const out = MockLedger.buyOut(c, l);
        const net = l - bpsOf(l, FEE_BPS);
        c.vSol += net;
        c.vTok -= out;
        c.realTok -= out;
        return out;
      };
      const devTokens = step(devBuyLamports);
      const buyTokens = buys.map(step);
      return { devTokens, buyTokens, supply: INIT.supply, marketCapLamports: mcOf(c.vSol, c.vTok), graduationPct: Number(((INIT.realTok - c.realTok) * 10_000n) / INIT.realTok) / 100, padFeeBps: Number(FEE_BPS) };
    },
    buildCreateTx: async (p) => {
      const q = quoteOf(fresh(), undefined, "buy", p.devBuyLamports, p.slippagePct);
      return { kind: "create", payer: p.creator, signers: [p.creator, p.mint], mint: p.mint, quote: q, payload: { op: "create", mint: p.mint, creator: p.creator, devBuy: p.devBuyLamports, tokens: q.amountOut, maxSol: q.limit, name: p.name, symbol: p.symbol, uri: p.uri, mayhem: p.mayhem } satisfies Op };
    },
    buildBuyTx: async (p) => {
      const { c, pool } = tradable(p.mint);
      const q = quoteOf(c, pool, "buy", p.lamports, p.slippagePct);
      return { kind: "buy", payer: p.user, signers: [p.user], mint: p.mint, quote: q, payload: { op: "buy", mint: p.mint, user: p.user, tokens: q.amountOut, maxSol: q.limit } satisfies Op };
    },
    buildSellTx: async (p) => {
      const { c, pool } = tradable(p.mint);
      const q = quoteOf(c, pool, "sell", p.tokens, p.slippagePct);
      return { kind: "sell", payer: p.user, signers: [p.user], mint: p.mint, quote: q, payload: { op: "sell", mint: p.mint, user: p.user, tokens: p.tokens, minSol: q.limit } satisfies Op };
    },
    claimableFees: async (creators) => {
      const out = new Map<string, bigint>();
      for (const cr of creators) out.set(cr, [...ledger.curves.values()].filter((c) => c.creator === cr).reduce((a, c) => a + c.creatorVault, 0n));
      return out;
    },
    buildTokenTransferTx: async ({ mint, from, to, tokens }) => {
      curve(mint);
      const rentLamports = ledger.tokenOf(mint, to) === 0n ? MOCK_ATA_RENT : 0n;
      return { kind: "token-transfer", payer: from, signers: [from], mint, cuLimit: 60_000, payload: { op: "token-transfer", mint, from, to, tokens } satisfies Op, rentLamports };
    },
    buildBurnTx: async ({ mint, owner, tokens }) => {
      curve(mint);
      return { kind: "burn", payer: owner, signers: [owner], mint, cuLimit: 30_000, payload: { op: "burn", mint, owner, tokens } satisfies Op };
    },
    buildClaimTx: async ({ creator }) => ({ kind: "claim", payer: creator, signers: [creator], payload: { op: "claim", creator } satisfies Op }),
    claimRent: async () => ({ upfront: 0n, kept: 0n }),
    buildCloseAccountsTx: async ({ owner, dest, accounts }) => ({ kind: "close-accounts", payer: dest, signers: dest === owner ? [owner] : [dest, owner], cuLimit: 5_000 + 6_000 * accounts.length, payload: { op: "close", owner, dest, mints: accounts.map((a) => a.mint) } satisfies Op }),
    tokenInfo: async (mint): Promise<TokenInfo> => {
      const c = curve(mint);
      const pool = ledger.pools.get(mint);
      const venue = pool ? "pumpswap" : c.complete ? "migrating" : "curve";
      const [q, t] = pool ? [pool.quote, pool.base] : [c.vSol, c.vTok];
      return {
        mint,
        venue,
        tokenProgram: "mock-token-2022",
        decimals: 6,
        supply: INIT.supply - (ledger.burned.get(mint) ?? 0n),
        creator: c.creator,
        mayhem: c.mayhem,
        priceLamports: venue === "migrating" ? 0 : (Number(q) / Number(t)) * 1e6,
        marketCapLamports: venue === "migrating" ? gradMc : mcOf(q, t),
        graduationPct: c.complete ? 100 : Number(((INIT.realTok - c.realTok) * 10_000n) / INIT.realTok) / 100,
        graduationMcLamports: gradMc,
        reserves: { quote: q, token: t },
        systemOwners: [{ owner: mockCurveAccount(mint), label: "Bonding curve" }, ...(pool ? [{ owner: mockPoolAccount(mint), label: "Pool de PumpSwap" }] : [])],
        curveAccount: mockCurveAccount(mint),
        pool: pool ? mockPoolAccount(mint) : null,
        padFeeBps: venue === "migrating" ? 0 : Number(FEE_BPS),
        metadata: { name: c.name, symbol: c.symbol, uri: "" },
      };
    },
    parseEvents: (tx, ctx) => {
      if (tx.err) return [];
      const out: ChainEvent[] = [];
      tx.logs.forEach((l) => {
        if (!l.startsWith(LOG_PREFIX)) return;
        const e = unjson(l.slice(LOG_PREFIX.length)) as MockEvent;
        if (ctx?.mint && e.mint !== ctx.mint) return;
        out.push({ ...e, index: out.length } as ChainEvent);
      });
      return out;
    },
    tradeAccountsRent: async ({ mint, user, side }) => (side === "buy" && ledger.tokenOf(mint, user) === 0n ? MOCK_ATA_RENT : 0n),
    buildMigrateTx: async ({ mint, payer }) => ({ kind: "migrate", payer, signers: [payer], mint, cuLimit: 600_000, payload: { op: "migrate", mint, payer } satisfies Op }),
  };

  const sender: TxSender = {
    send: async (tx: PreparedTx, { idempotencyKey, simulateOnly, watch }) => {
      if (ledger.sendDelayMs) await new Promise((r) => setTimeout(r, ledger.sendDelayMs));
      const prev = ledger.sent.get(idempotencyKey);
      if (prev && prev.status === "confirmed") return { ...prev, reused: true };
      // Firmar con la bóveda igual que el sender real (falla si alguna clave no está)
      const msg = new TextEncoder().encode(`${idempotencyKey}:${json(tx.payload)}`);
      for (const s of tx.signers) sign(s, msg);
      let f = ledger.failures.shift();
      if (f === "BLOCKHASH_EXPIRED") f = ledger.failures.shift(); // el sender re-firma con un blockhash nuevo y reintenta
      if (f === "RPC_DOWN") return { status: "pending", message: "Fallo inyectado: RPC caído (no se envió nada)" };
      if (f) return { status: "failed", code: f, message: `Fallo inyectado: ${f}` };
      // Jito (F2 · bloque 5): la propina va en la misma «tx» que la operación: o entran las dos o ninguna
      const tip = tipFor(tx.kind, jito());
      const snap = () => structuredClone({ sol: ledger.sol, tokens: ledger.tokens, curves: ledger.curves, pools: ledger.pools, burned: ledger.burned });
      const applyWithTip = (): ReturnType<MockLedger["apply"]> => {
        const before = tip > 0n ? snap() : null;
        const r = ledger.apply(tx.payload as Op, feeOf(tx));
        if (!r.ok || tip === 0n) return r;
        if (ledger.balance(tx.payer) < tip) {
          Object.assign(ledger, before);
          ledger.discardEvents();
          return { ok: false, code: "INSUFFICIENT_FUNDS", message: "Saldo insuficiente para el monto, las fees y la propina de Jito." };
        }
        const to = tipAccountFor(idempotencyKey).toBase58();
        ledger.sol.set(tx.payer, ledger.balance(tx.payer) - tip);
        ledger.sol.set(to, ledger.balance(to) + tip);
        return r;
      };
      if (simulateOnly) {
        const snapshot = snap();
        const r = applyWithTip();
        const post = watch ? ledger.balance(watch) : undefined;
        Object.assign(ledger, snapshot);
        ledger.discardEvents(); // una simulación no emite nada
        return r.ok ? { status: "simulated", tipLamports: tip, ...(post !== undefined ? { postLamports: post } : {}) } : { status: "failed", code: r.code, message: r.message };
      }
      const pre = new Map(ledger.sol);
      const r = applyWithTip();
      const res: SendResult = r.ok ? { status: "confirmed", signature: `mock${++ledger.seq}`, feeLamports: r.fee, tipLamports: tip } : { status: "failed", code: r.code, message: r.message };
      if (res.status === "confirmed") {
        ledger.record(res.signature, tx.payer, { fee: r.ok ? r.fee : undefined, pre });
        // Igual que el sender real: cada envío propio confirmado queda en la tabla tx (P&L, conciliación)
        const now = Date.now();
        db?.()
          .prepare(
            `INSERT INTO tx(idempotency_key, kind, signature, status, fee_lamports, tip_lamports, payer, mint, created_at, updated_at) VALUES(?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?)
             ON CONFLICT(idempotency_key) DO UPDATE SET signature = excluded.signature, status = 'CONFIRMED', fee_lamports = excluded.fee_lamports, tip_lamports = excluded.tip_lamports, updated_at = excluded.updated_at`,
          )
          .run(idempotencyKey, tx.kind, res.signature, Number(res.feeLamports ?? 0n), Number(tip), tx.payer, tx.mint ?? null, now, now);
      }
      ledger.sent.set(idempotencyKey, res);
      return res;
    },
  };

  const holdersOf = (mint: string) => {
    curve(mint);
    const own = [...(ledger.tokens.get(mint) ?? new Map<string, bigint>())].map(([owner, amount]) => ({ owner, amount })).filter((h) => h.amount > 0n);
    const held = own.reduce((a, h) => a + h.amount, 0n);
    const pool = ledger.pools.get(mint);
    const sys = pool ? [{ owner: mockPoolAccount(mint), amount: pool.base }] : [{ owner: mockCurveAccount(mint), amount: INIT.supply - held }];
    return [...own, ...sys].filter((h) => h.amount > 0n);
  };

  const reader: ChainReader = {
    balances: async (addrs) => new Map(addrs.map((a) => [a, ledger.balance(a)])),
    tokenBalance: async (mint, owner) => ledger.tokenOf(mint, owner),
    emptyTokenAccounts: async (owner) =>
      [...ledger.tokens]
        .filter(([, m]) => m.has(owner) && m.get(owner) === 0n)
        .map(([mint]) => ({ address: mockTokenAccount(mint, owner), mint, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: MOCK_ATA_RENT })),
    tokenBalances: async (mint, owners) => new Map(owners.map((o) => [o, ledger.tokenOf(mint, o)])),
    holders: async (mint) => ({ complete: true, items: holdersOf(mint) }),
    accountExists: async (a) => ledger.curves.has(a) || ledger.balance(a) > 0n,
    tokenMetadata: async (mint) => {
      const c = ledger.curves.get(mint);
      return c ? { name: c.name, symbol: c.symbol, uri: ledger.uris.get(mint) ?? "" } : null;
    },
    airdrop: async (a, l) => void ledger.sol.set(a, ledger.balance(a) + l),
    signatures: async (address, { until, before, limit }) => {
      const list = ledger.txs.filter((t) => t.mentions.has(address)).reverse();
      let start = 0;
      if (before) start = list.findIndex((t) => t.signature === before) + 1;
      const out = [];
      for (const t of list.slice(start)) {
        if (t.signature === until || out.length >= limit) break;
        out.push({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null });
      }
      return out;
    },
    transactions: async (sigs) => sigs.map((s) => ledger.txs.find((t) => t.signature === s)).filter((t): t is NonNullable<typeof t> => !!t),
    onLogs: (address, cb) => {
      const set = ledger.listeners.get(address) ?? new Set();
      set.add(cb);
      ledger.listeners.set(address, set);
      return () => void set.delete(cb);
    },
    solUsd: async () => ({ usd: MOCK_SOL_USD, publishedAt: Date.now() }),
    tokenAccountRent: async () => MOCK_ATA_RENT,
  };
  const transfers: TransferBuilder = {
    build: async (from, items) =>
      chunkTransfers(from, items).map((chunk) => ({ kind: "transfer", payer: from, signers: [from], cuLimit: transferCuLimit(chunk.length), payload: { op: "transfer", from, items: chunk } satisfies Op })),
    feeOf,
    rentExemptMin: async () => RENT_EXEMPT_MIN_DEFAULT,
  };
  const launchAlt = {
    status: async () => ({ ready: true, address: null, keys: 0, rentLamports: 0n }),
    ensure: async () => ({ address: "mock", created: false }),
    // el mock no necesita tabla de direcciones: no hay nada que cerrar
    closing: async () => ({ current: null, closing: null }),
    deactivate: async (): Promise<SendResult> => ({ status: "failed", code: "SIMULATION_FAILED", message: "El mock no usa tabla de direcciones." }),
    close: async (): Promise<SendResult> => ({ status: "failed", code: "SIMULATION_FAILED", message: "El mock no usa tabla de direcciones." }),
  };
  return { adapter, sender, reader, ledger, transfers, launchAlt };
}
