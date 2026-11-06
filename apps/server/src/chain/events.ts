// REQ-CORE-001 · parseEvents: trades de la curva y de PumpSwap, graduación y migración.
// Se identifica cada evento por su discriminador de Anchor (sha256("event:<Nombre>")[0..8]) antes de
// decodificarlo: probar decodificadores a ciegas puede "acertar" con el evento equivocado.
import { createHash } from "node:crypto";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurveMarketCap, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { poolMarketCap } from "@pump-fun/pump-sdk/swap";
import type { ChainEvent, RawTx } from "./types";

export const eventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const DISC = {
  trade: eventDisc("TradeEvent"),
  complete: eventDisc("CompleteEvent"),
  migrate: eventDisc("CompletePumpAmmMigrationEvent"),
  ammBuy: eventDisc("BuyEvent"),
  ammSell: eventDisc("SellEvent"),
};
/** Etiqueta de los eventos emitidos por self-CPI (`emit_cpi!`) en las instrucciones internas. */
const EMIT_CPI_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58()]);
const DEFAULT_SUPPLY = 1_000_000_000_000_000n;

const big = (v: BN) => BigInt(v.toString());
const pk = (v: PublicKey) => v.toBase58();

/** Payloads de evento de una tx: de los logs, o de las instrucciones internas si los logs se truncaron. */
export function eventPayloads(tx: RawTx): Buffer[] {
  const truncated = tx.logs.some((l) => l.startsWith("Log truncated"));
  if (truncated && tx.inner) {
    return tx.inner
      .filter((i) => PROGRAMS.has(i.program))
      .map((i) => Buffer.from(i.data))
      .filter((d) => d.length > 16 && d.subarray(0, 8).equals(EMIT_CPI_TAG))
      .map((d) => d.subarray(8));
  }
  return tx.logs.filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice(14), "base64"));
}

export function parsePumpEvents(tx: RawTx, ctx: { mint?: string; supply?: bigint; mayhem?: boolean } = {}): ChainEvent[] {
  if (tx.err) return []; // una tx fallida puede tener logs de eventos emitidos antes del fallo
  const out: ChainEvent[] = [];
  const pool = ctx.mint ? canonicalPumpPoolPda(new PublicKey(ctx.mint)).toBase58() : null;
  const supply = new BN((ctx.supply ?? DEFAULT_SUPPLY).toString());
  let index = 0;
  for (const raw of eventPayloads(tx)) {
    if (raw.length < 8) continue;
    const disc = raw.subarray(0, 8);
    const body = raw.subarray(8);
    const i = index++;
    try {
      if (disc.equals(DISC.trade)) {
        const e = PUMP_SDK.decodeTradeEventBc(body);
        const mint = pk(e.mint);
        if (ctx.mint && mint !== ctx.mint) continue;
        const fees = big(e.fee) + big(e.creatorFee);
        const sol = big(e.solAmount);
        out.push({
          kind: "trade",
          index: i,
          venue: "curve",
          mint,
          side: e.isBuy ? "buy" : "sell",
          lamports: e.isBuy ? sol + fees : sol - fees,
          feeLamports: fees,
          tokens: big(e.tokenAmount),
          user: pk(e.user),
          ts: Number(e.timestamp.toString()) * 1000,
          // el evento informa las reservas DESPUÉS del trade
          marketCapLamports: big(bondingCurveMarketCap({ mintSupply: supply, virtualQuoteReserves: e.virtualSolReserves, virtualTokenReserves: e.virtualTokenReserves })),
        });
      } else if (disc.equals(DISC.complete)) {
        const e = PUMP_SDK.decodeCompleteEventBc(body);
        if (ctx.mint && pk(e.mint) !== ctx.mint) continue;
        out.push({ kind: "complete", index: i, mint: pk(e.mint), ts: Number(e.timestamp.toString()) * 1000 });
      } else if (disc.equals(DISC.migrate)) {
        // El SDK no trae decodificador: user, mint, mintAmount, solAmount, poolMigrationFee, bondingCurve, timestamp, pool
        const mint = new PublicKey(body.subarray(32, 64)).toBase58();
        if (ctx.mint && mint !== ctx.mint) continue;
        out.push({ kind: "migrate", index: i, mint, pool: new PublicKey(body.subarray(128, 160)).toBase58(), ts: Number(body.readBigInt64LE(120)) * 1000 });
      } else if (disc.equals(DISC.ammBuy) || disc.equals(DISC.ammSell)) {
        // Los eventos del AMM traen el pool, no el mint: solo se acepta el pool canónico del token
        if (!ctx.mint || !pool) continue;
        const buy = disc.equals(DISC.ammBuy);
        const e = buy ? PUMP_SDK.decodeBuyEventAmm(body) : PUMP_SDK.decodeSellEventAmm(body);
        if (pk(e.pool) !== pool) continue;
        const tokens = buy ? big((e as ReturnType<typeof PUMP_SDK.decodeBuyEventAmm>).baseAmountOut) : big((e as ReturnType<typeof PUMP_SDK.decodeSellEventAmm>).baseAmountIn);
        const lamports = buy ? big((e as ReturnType<typeof PUMP_SDK.decodeBuyEventAmm>).userQuoteAmountIn) : big((e as ReturnType<typeof PUMP_SDK.decodeSellEventAmm>).userQuoteAmountOut);
        // Las reservas del evento son las de ANTES del swap: se aplica el trade para el market cap posterior
        const base = big(e.poolBaseTokenReserves);
        const quote = big(e.poolQuoteTokenReserves);
        const net = buy ? big((e as ReturnType<typeof PUMP_SDK.decodeBuyEventAmm>).quoteAmountIn) : big((e as ReturnType<typeof PUMP_SDK.decodeSellEventAmm>).quoteAmountOut);
        const after = buy ? { b: base - tokens, q: quote + net } : { b: base + tokens, q: quote - net };
        const padFee = big(e.lpFee) + big(e.protocolFee) + big(e.coinCreatorFee);
        out.push({
          kind: "trade",
          index: i,
          venue: "pumpswap",
          mint: ctx.mint,
          side: buy ? "buy" : "sell",
          lamports,
          feeLamports: padFee,
          tokens,
          user: pk(e.user),
          ts: Number(e.timestamp.toString()) * 1000,
          marketCapLamports: after.b > 0n ? big(poolMarketCap({ baseMintSupply: supply, baseReserve: new BN(after.b.toString()), quoteReserve: new BN(after.q.toString()), isMayhemMode: ctx.mayhem })) : 0n,
        });
      }
    } catch {
      // un evento con una versión de layout desconocida no rompe el resto de la tx
    }
  }
  return out;
}
