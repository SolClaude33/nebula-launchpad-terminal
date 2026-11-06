// TEST-ENV-002: adaptador mock con el mismo contrato que el real y fallos inyectables.
// Curva de constante producto con los parámetros iniciales de Pump.fun (30 SOL / 1.073 M tokens virtuales).
import type { ChainEnv, ChainReader, CurveQuote, LaunchQuote, LaunchpadAdapter, MessageSigner, PreparedTx, SendErrorCode, SendResult, TransferBuilder, TxSender } from "./types";
import { RENT_EXEMPT_MIN_DEFAULT, transferCuLimit, txFee } from "./fees";
import { chunkTransfers } from "./transfers";

const INIT = { vSol: 30_000_000_000n, vTok: 1_073_000_000_000_000n, realTok: 793_100_000_000_000n, supply: 1_000_000_000_000_000n };
const FEE_BPS = 100n; // total; de ello CREATOR_BPS va a la bóveda del creador
const CREATOR_BPS = 30n;
const TX_FEE = 5_000n;
const ATA_RENT = 2_039_280n;
const MINT_RENT = 21_800_000n;

type Curve = { vSol: bigint; vTok: bigint; realSol: bigint; realTok: bigint; complete: boolean; creator: string; creatorVault: bigint };
type Op =
  | { op: "create"; mint: string; creator: string; devBuy: bigint; tokens: bigint; maxSol: bigint }
  | { op: "buy"; mint: string; user: string; tokens: bigint; maxSol: bigint }
  | { op: "sell"; mint: string; user: string; tokens: bigint; minSol: bigint }
  | { op: "claim"; creator: string }
  | { op: "transfer"; from: string; items: { to: string; lamports: bigint }[] };

const bpsOf = (v: bigint, bps: bigint) => (v * bps) / 10_000n;
const withSlip = (v: bigint, pct: number, up: boolean) => (up ? v + (v * BigInt(Math.floor(pct * 10))) / 1000n : v - (v * BigInt(Math.floor(pct * 10))) / 1000n);

export class MockLedger {
  sol = new Map<string, bigint>();
  tokens = new Map<string, Map<string, bigint>>();
  curves = new Map<string, Curve>();
  /** fallos a devolver en los próximos envíos, en orden */
  failures: SendErrorCode[] = [];
  /** movimiento de precio (en %) aplicado justo antes de ejecutar el siguiente envío */
  priceShockPct = 0;
  /** retardo artificial por envío (para pausar operaciones a mitad en los tests) */
  sendDelayMs = 0;
  sent = new Map<string, SendResult>();
  seq = 0;

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

  apply(o: Op, TX_FEE: bigint): { ok: true; fee: bigint } | { ok: false; code: SendErrorCode; message: string } {
    if (this.priceShockPct) {
      for (const c of this.curves.values()) c.vSol = c.vSol + (c.vSol * BigInt(Math.round(this.priceShockPct * 100))) / 10_000n;
      this.priceShockPct = 0;
    }
    const fail = (code: SendErrorCode, message: string) => ({ ok: false as const, code, message });
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
      const curve: Curve = { vSol: INIT.vSol, vTok: INIT.vTok, realSol: 0n, realTok: INIT.realTok, complete: false, creator: o.creator, creatorVault: 0n };
      const cost = o.devBuy > 0n ? MockLedger.costFor(curve, o.tokens) : 0n;
      if (cost > o.maxSol) return fail("SLIPPAGE", "slippage: Too much SOL required to buy the given amount of tokens.");
      const need = cost + MINT_RENT + ATA_RENT + TX_FEE;
      if (this.balance(o.creator) < need) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para crear el token");
      this.curves.set(o.mint, curve);
      if (o.devBuy > 0n) this.fill(o.mint, curve, o.creator, o.tokens, cost);
      this.sol.set(o.creator, this.balance(o.creator) - MINT_RENT - ATA_RENT - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    if (o.op === "claim") {
      let total = 0n;
      for (const c of this.curves.values()) if (c.creator === o.creator) (total += c.creatorVault), (c.creatorVault = 0n);
      if (total === 0n) return fail("SIMULATION_FAILED", "No hay comisiones que reclamar");
      this.sol.set(o.creator, this.balance(o.creator) + total - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    const c = this.curves.get(o.mint);
    if (!c) return fail("SIMULATION_FAILED", "La curva no existe");
    if (c.complete) return fail("CURVE_COMPLETE", "La curva está completa; se opera en PumpSwap");
    if (o.op === "buy") {
      const cost = MockLedger.costFor(c, o.tokens);
      if (cost > o.maxSol) return fail("SLIPPAGE", "slippage: Too much SOL required to buy the given amount of tokens.");
      const rent = this.tokenOf(o.mint, o.user) === 0n ? ATA_RENT : 0n;
      if (this.balance(o.user) < cost + rent + TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente: monto + fees + rent");
      this.fill(o.mint, c, o.user, o.tokens, cost);
      this.sol.set(o.user, this.balance(o.user) - rent - TX_FEE);
      return { ok: true, fee: TX_FEE };
    }
    // sell
    if (this.tokenOf(o.mint, o.user) < o.tokens) return fail("SIMULATION_FAILED", "No hay tokens suficientes para vender");
    const out = MockLedger.sellOut(c, o.tokens);
    if (out < o.minSol) return fail("SLIPPAGE", "slippage: Too little SOL received to sell the given amount of tokens.");
    if (this.balance(o.user) < TX_FEE) return fail("INSUFFICIENT_FUNDS", "Saldo insuficiente para la fee de red");
    const gross = out + bpsOf(out, FEE_BPS);
    c.vSol -= gross;
    c.vTok += o.tokens;
    c.realSol -= gross;
    c.realTok += o.tokens;
    c.creatorVault += bpsOf(gross, CREATOR_BPS);
    this.addTokens(o.mint, o.user, -o.tokens);
    this.sol.set(o.user, this.balance(o.user) + out - TX_FEE);
    return { ok: true, fee: TX_FEE };
  }

  private fill(mint: string, c: Curve, user: string, tokens: bigint, cost: bigint) {
    const net = cost - bpsOf(cost, FEE_BPS);
    c.vSol += net;
    c.vTok -= tokens;
    c.realSol += net;
    c.realTok -= tokens;
    c.creatorVault += bpsOf(cost, CREATOR_BPS);
    if (c.realTok === 0n) c.complete = true;
    this.addTokens(mint, user, tokens);
    this.sol.set(user, this.balance(user) - cost);
  }
}

function quoteOf(c: Curve, side: "buy" | "sell", amount: bigint, slippagePct: number): CurveQuote {
  const before = (c.vSol * INIT.supply) / c.vTok;
  let out: bigint, limit: bigint, after: Curve;
  if (side === "buy") {
    out = MockLedger.buyOut(c, amount);
    // Igual que el SDK: máximo de SOL = monto enviado × (1 + slippage %)
    limit = withSlip(amount, slippagePct, true);
    after = { ...c, vSol: c.vSol + (amount - bpsOf(amount, FEE_BPS)), vTok: c.vTok - out, realTok: c.realTok - out };
  } else {
    out = MockLedger.sellOut(c, amount);
    limit = withSlip(out, slippagePct, false);
    after = { ...c, vSol: c.vSol - out, vTok: c.vTok + amount, realTok: c.realTok + amount };
  }
  const mc = (after.vSol * INIT.supply) / after.vTok;
  return {
    side,
    amountIn: amount,
    amountOut: out,
    limit,
    slippagePct,
    priceImpactPct: Number(((mc - before) * 10_000n) / before) / 100,
    marketCapLamports: mc,
    graduationPct: Number(((INIT.realTok - after.realTok) * 10_000n) / INIT.realTok) / 100,
    complete: after.realTok === 0n,
  };
}

export function createMockEnv(sign: MessageSigner, ledger = new MockLedger(), priority: () => number = () => 0): ChainEnv & { ledger: MockLedger } {
  const feeOf = (tx: PreparedTx) => txFee(tx.signers.length, tx.cuLimit ?? 400_000, priority());
  const fresh = (): Curve => ({ vSol: INIT.vSol, vTok: INIT.vTok, realSol: 0n, realTok: INIT.realTok, complete: false, creator: "", creatorVault: 0n });
  const curve = (mint: string) => {
    const c = ledger.curves.get(mint);
    if (!c) throw new Error("La curva no existe");
    return c;
  };
  const adapter: LaunchpadAdapter = {
    capabilities: () => ({ id: "mock", name: "Pump.fun (mock)", chain: "solana", modes: ["classic", "mayhem"], quotes: ["SOL"], bundleInSameTx: true, customMint: true, tokenDecimals: 6, graduatesTo: "PumpSwap" }),
    quoteCreate: async ({ devBuyLamports, slippagePct }) => quoteOf(fresh(), "buy", devBuyLamports, slippagePct),
    quote: async ({ mint, side, amount, slippagePct }) => quoteOf(curve(mint), side, amount, slippagePct),
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
      return { devTokens, buyTokens, supply: INIT.supply, marketCapLamports: (c.vSol * INIT.supply) / c.vTok, graduationPct: Number(((INIT.realTok - c.realTok) * 10_000n) / INIT.realTok) / 100, padFeeBps: Number(FEE_BPS) };
    },
    buildCreateTx: async (p) => {
      const q = quoteOf(fresh(), "buy", p.devBuyLamports, p.slippagePct);
      return { kind: "create", payer: p.creator, signers: [p.creator, p.mint], mint: p.mint, quote: q, payload: { op: "create", mint: p.mint, creator: p.creator, devBuy: p.devBuyLamports, tokens: q.amountOut, maxSol: q.limit } satisfies Op };
    },
    buildBuyTx: async (p) => {
      const q = quoteOf(curve(p.mint), "buy", p.lamports, p.slippagePct);
      return { kind: "buy", payer: p.user, signers: [p.user], mint: p.mint, quote: q, payload: { op: "buy", mint: p.mint, user: p.user, tokens: q.amountOut, maxSol: q.limit } satisfies Op };
    },
    buildSellTx: async (p) => {
      const q = quoteOf(curve(p.mint), "sell", p.tokens, p.slippagePct);
      return { kind: "sell", payer: p.user, signers: [p.user], mint: p.mint, quote: q, payload: { op: "sell", mint: p.mint, user: p.user, tokens: p.tokens, minSol: q.limit } satisfies Op };
    },
    claimableFees: async (creators) => {
      const out = new Map<string, bigint>();
      for (const cr of creators) out.set(cr, [...ledger.curves.values()].filter((c) => c.creator === cr).reduce((a, c) => a + c.creatorVault, 0n));
      return out;
    },
    buildClaimTx: async ({ creator }) => ({ kind: "claim", payer: creator, signers: [creator], payload: { op: "claim", creator } satisfies Op }),
  };

  const sender: TxSender = {
    send: async (tx: PreparedTx, { idempotencyKey, simulateOnly }) => {
      if (ledger.sendDelayMs) await new Promise((r) => setTimeout(r, ledger.sendDelayMs));
      const prev = ledger.sent.get(idempotencyKey);
      if (prev && prev.status === "confirmed") return { ...prev, reused: true };
      // Firmar con la bóveda igual que el sender real (falla si alguna clave no está)
      const msg = new TextEncoder().encode(`${idempotencyKey}:${JSON.stringify(tx.payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      for (const s of tx.signers) sign(s, msg);
      let f = ledger.failures.shift();
      if (f === "BLOCKHASH_EXPIRED") f = ledger.failures.shift(); // el sender re-firma con un blockhash nuevo y reintenta
      if (f === "RPC_DOWN") return { status: "pending", message: "Fallo inyectado: RPC caído (no se envió nada)" };
      if (f) return { status: "failed", code: f, message: `Fallo inyectado: ${f}` };
      if (simulateOnly) {
        const snapshot = structuredClone({ sol: ledger.sol, tokens: ledger.tokens, curves: ledger.curves });
        const r = ledger.apply(tx.payload as Op, feeOf(tx));
        ledger.sol = snapshot.sol;
        ledger.tokens = snapshot.tokens;
        ledger.curves = snapshot.curves;
        return r.ok ? { status: "simulated" } : { status: "failed", code: r.code, message: r.message };
      }
      const r = ledger.apply(tx.payload as Op, feeOf(tx));
      const res: SendResult = r.ok ? { status: "confirmed", signature: `mock${++ledger.seq}`, feeLamports: r.fee } : { status: "failed", code: r.code, message: r.message };
      ledger.sent.set(idempotencyKey, res);
      return res;
    },
  };

  const reader: ChainReader = {
    balances: async (addrs) => new Map(addrs.map((a) => [a, ledger.balance(a)])),
    tokenBalance: async (mint, owner) => ledger.tokenOf(mint, owner),
    accountExists: async (a) => ledger.curves.has(a) || ledger.balance(a) > 0n,
    airdrop: async (a, l) => void ledger.sol.set(a, ledger.balance(a) + l),
  };
  const transfers: TransferBuilder = {
    build: async (from, items) =>
      chunkTransfers(from, items).map((chunk) => ({ kind: "transfer", payer: from, signers: [from], cuLimit: transferCuLimit(chunk.length), payload: { op: "transfer", from, items: chunk } satisfies Op })),
    feeOf,
    rentExemptMin: async () => RENT_EXEMPT_MIN_DEFAULT,
  };
  const launchAlt = { status: async () => ({ ready: true, address: null, keys: 0, rentLamports: 0n }), ensure: async () => ({ address: "mock", created: false }) };
  return { adapter, sender, reader, ledger, transfers, launchAlt };
}
