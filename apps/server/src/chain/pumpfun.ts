// Adaptador real de Pump.fun (REQ-CORE-001) sobre el SDK oficial. Solo maneja claves PÚBLICAS:
// construye instrucciones; la firma la hace el sender con la bóveda.
import BN from "bn.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  newBondingCurve,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import type { CurveQuote, LaunchpadAdapter, PreparedTx } from "./types";
import type { RpcPool } from "./rpc";

const bn = (v: bigint) => new BN(v.toString());
const big = (v: BN) => BigInt(v.toString());
/** Igual que el SDK: el límite se calcula con el slippage en porcentaje (REQ-LAUNCH-012: se envía el valor configurado). */
export const slipUp = (v: bigint, pct: number) => v + (v * BigInt(Math.floor(pct * 10))) / 1000n;
export const slipDown = (v: bigint, pct: number) => v - (v * BigInt(Math.floor(pct * 10))) / 1000n;

export type PumpPayload = { instructions: import("@solana/web3.js").TransactionInstruction[] };

export function createPumpFunAdapter(pool: RpcPool, getLaunchAlt: () => import("@solana/web3.js").AddressLookupTableAccount | null = () => null): LaunchpadAdapter {
  const sdks = new WeakMap<Connection, OnlinePumpSdk>();
  const online = () => {
    const c = pool.current();
    let s = sdks.get(c);
    if (!s) sdks.set(c, (s = new OnlinePumpSdk(c)));
    return s;
  };
  let cachedGlobal: { at: number; global: Global; feeConfig: Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>> | null } | null = null;
  const globals = async () => {
    if (cachedGlobal && Date.now() - cachedGlobal.at < 30_000) return cachedGlobal;
    const [global, feeConfig] = await pool.run(async () => Promise.all([online().fetchGlobal(), online().fetchFeeConfig().catch(() => null)]));
    return (cachedGlobal = { at: Date.now(), global, feeConfig });
  };
  /** Programa de token del mint: los coins v2 son Token-2022, pero se lee del propietario de la cuenta. */
  const tokenProgramOf = async (mint: PublicKey) => {
    const info = await pool.run((c) => c.getAccountInfo(mint));
    if (!info) throw new Error("El mint no existe en la cadena");
    return info.owner;
  };

  const describe = (global: Global, before: BondingCurve, after: { vQuote: bigint; vTok: bigint; realTok: bigint }, side: "buy" | "sell", amountIn: bigint, amountOut: bigint, limit: bigint, slippagePct: number): CurveQuote => {
    const mc = (vQuote: bigint, vTok: bigint) => big(bondingCurveMarketCap({ mintSupply: before.tokenTotalSupply, virtualQuoteReserves: bn(vQuote), virtualTokenReserves: bn(vTok) }));
    const m0 = mc(big(before.virtualQuoteReserves), big(before.virtualTokenReserves));
    const m1 = mc(after.vQuote, after.vTok);
    const initReal = big(global.initialRealTokenReserves);
    return {
      side,
      amountIn,
      amountOut,
      limit,
      slippagePct,
      priceImpactPct: m0 > 0n ? Number(((m1 - m0) * 10_000n) / m0) / 100 : 0,
      marketCapLamports: m1,
      graduationPct: initReal > 0n ? Math.min(100, Number(((initReal - after.realTok) * 10_000n) / initReal) / 100) : 0,
      complete: after.realTok <= 0n,
    };
  };

  const buyQuote = (global: Global, feeConfig: Awaited<ReturnType<typeof globals>>["feeConfig"], curve: BondingCurve | null, lamports: bigint, slippagePct: number) => {
    const c = curve ?? newBondingCurve(global);
    const tokens = big(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: curve ? curve.tokenTotalSupply : null, bondingCurve: curve, amount: bn(lamports), quoteMint: NATIVE_MINT }));
    // Aproximación para el impacto mostrado; los tokens exactos los da el SDK con el FeeConfig real
    const feeBps = BigInt(global.feeBasisPoints.toString());
    const net = lamports - (lamports * feeBps) / 10_000n;
    return describe(global, c, { vQuote: big(c.virtualQuoteReserves) + net, vTok: big(c.virtualTokenReserves) - tokens, realTok: big(c.realTokenReserves) - tokens }, "buy", lamports, tokens, slipUp(lamports, slippagePct), slippagePct);
  };

  return {
    capabilities: () => ({ id: "pumpfun", name: "Pump.fun", chain: "solana", modes: ["classic", "mayhem"], quotes: ["SOL"], bundleInSameTx: true, customMint: true, tokenDecimals: 6, graduatesTo: "PumpSwap" }),

    quoteCreate: async ({ devBuyLamports, slippagePct }) => {
      const { global, feeConfig } = await globals();
      return buyQuote(global, feeConfig, null, devBuyLamports, slippagePct);
    },

    quote: async ({ mint, side, amount, slippagePct }) => {
      const { global, feeConfig } = await globals();
      const m = new PublicKey(mint);
      // Cotizar solo necesita la curva, no el estado de ninguna wallet
      const c = await pool.run(() => online().fetchBondingCurve(m));
      if (side === "buy") return buyQuote(global, feeConfig, c, amount, slippagePct);
      const out = big(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: c.tokenTotalSupply, bondingCurve: c, amount: bn(amount) }));
      return describe(global, c, { vQuote: big(c.virtualQuoteReserves) - out, vTok: big(c.virtualTokenReserves) + amount, realTok: big(c.realTokenReserves) + amount }, "sell", amount, out, slipDown(out, slippagePct), slippagePct);
    },

    quoteLaunch: async ({ devBuyLamports, buys }) => {
      const { global, feeConfig } = await globals();
      const c = newBondingCurve(global);
      const feeBps = BigInt(global.feeBasisPoints.toString());
      const step = (l: bigint, first: boolean) => {
        if (l <= 0n) return 0n;
        const tokens = big(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: first ? null : c.tokenTotalSupply, bondingCurve: first ? null : c, amount: bn(l), quoteMint: NATIVE_MINT }));
        const net = l - (l * feeBps) / 10_000n;
        c.virtualQuoteReserves = bn(big(c.virtualQuoteReserves) + net);
        c.virtualTokenReserves = bn(big(c.virtualTokenReserves) - tokens);
        c.realTokenReserves = bn(big(c.realTokenReserves) - tokens);
        c.realQuoteReserves = bn(big(c.realQuoteReserves) + net);
        return tokens;
      };
      const devTokens = step(devBuyLamports, true);
      const buyTokens = buys.map((b, i) => step(b, devBuyLamports <= 0n && i === 0));
      const mc = big(bondingCurveMarketCap({ mintSupply: c.tokenTotalSupply, virtualQuoteReserves: c.virtualQuoteReserves, virtualTokenReserves: c.virtualTokenReserves }));
      const initReal = big(global.initialRealTokenReserves);
      return { devTokens, buyTokens, supply: big(c.tokenTotalSupply), marketCapLamports: mc, graduationPct: Number(((initReal - big(c.realTokenReserves)) * 10_000n) / initReal) / 100, padFeeBps: Number(feeBps) };
    },

    // REQ-LAUNCH-008: create_v2 + dev buy en una sola transacción (todo o nada)
    buildCreateTx: async (p) => {
      const { global, feeConfig } = await globals();
      const q = buyQuote(global, feeConfig, null, p.devBuyLamports, p.slippagePct);
      const base = { mint: new PublicKey(p.mint), name: p.name, symbol: p.symbol, uri: p.uri, creator: new PublicKey(p.creator), user: new PublicKey(p.creator), mayhemMode: p.mayhem, ...(p.holderReward ? { holderReward: true } : {}) };
      const instructions =
        p.devBuyLamports > 0n
          ? await PUMP_SDK.createV2AndBuyInstructions({ global, ...base, amount: bn(q.amountOut), solAmount: bn(p.devBuyLamports) })
          : [await PUMP_SDK.createV2Instruction(base)];
      const alt = getLaunchAlt();
      return { kind: "create", payer: p.creator, signers: [p.creator, p.mint], mint: p.mint, quote: q, payload: { instructions } satisfies PumpPayload, ...(alt ? { lookupTables: [alt] } : {}) };
    },

    buildBuyTx: async ({ mint, user, lamports, slippagePct }) => {
      const { global, feeConfig } = await globals();
      const m = new PublicKey(mint);
      const u = new PublicKey(user);
      const tp = await tokenProgramOf(m);
      const st = await pool.run(() => online().fetchBuyState(m, u, tp));
      if (st.bondingCurve.complete) throw Object.assign(new Error("La curva está completa; el token se opera en PumpSwap."), { code: "CURVE_COMPLETE" });
      const q = buyQuote(global, feeConfig, st.bondingCurve, lamports, slippagePct);
      const instructions = await PUMP_SDK.buyInstructions({ global, ...st, mint: m, user: u, amount: bn(q.amountOut), solAmount: bn(lamports), slippage: slippagePct, tokenProgram: tp });
      return { kind: "buy", payer: user, signers: [user], mint, quote: q, payload: { instructions } satisfies PumpPayload };
    },

    buildSellTx: async ({ mint, user, tokens, slippagePct }) => {
      const { global, feeConfig } = await globals();
      const m = new PublicKey(mint);
      const u = new PublicKey(user);
      const tp = await tokenProgramOf(m);
      const st = await pool.run(() => online().fetchSellState(m, u, tp));
      const c = st.bondingCurve;
      if (c.complete) throw Object.assign(new Error("La curva está completa; el token se opera en PumpSwap."), { code: "CURVE_COMPLETE" });
      const out = big(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: c.tokenTotalSupply, bondingCurve: c, amount: bn(tokens) }));
      const q = describe(global, c, { vQuote: big(c.virtualQuoteReserves) - out, vTok: big(c.virtualTokenReserves) + tokens, realTok: big(c.realTokenReserves) + tokens }, "sell", tokens, out, slipDown(out, slippagePct), slippagePct);
      const instructions = await PUMP_SDK.sellInstructions({ global, ...st, mint: m, user: u, amount: bn(tokens), solAmount: bn(out), slippage: slippagePct, tokenProgram: tp, mayhemMode: c.isMayhemMode });
      return { kind: "sell", payer: user, signers: [user], mint, quote: q, payload: { instructions } satisfies PumpPayload };
    },

    claimableFees: async (creators) => {
      const out = new Map<string, bigint>();
      for (const c of creators) out.set(c, big(await pool.run(() => online().getCreatorVaultBalanceBothPrograms(new PublicKey(c)))));
      return out;
    },

    buildClaimTx: async ({ creator }) => {
      const instructions = await pool.run(() => online().collectCoinCreatorFeeInstructions(new PublicKey(creator)));
      return { kind: "claim", payer: creator, signers: [creator], payload: { instructions } satisfies PumpPayload } satisfies PreparedTx;
    },
  };
}

export { TOKEN_2022_PROGRAM_ID };
