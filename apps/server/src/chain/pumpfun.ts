// Adaptador real de Pump.fun (REQ-CORE-001) sobre el SDK oficial. Solo maneja claves PÚBLICAS:
// construye instrucciones; la firma la hace el sender con la bóveda.
// Tras graduar, compra y venta van contra el pool canónico de PumpSwap (REQ-LIVE-002, E2E-12).
import BN from "bn.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createTransferCheckedInstruction, getAccountLen, getAccountTypeOfMintType, getAssociatedTokenAddressSync, getExtensionTypes, getTokenMetadata, unpackMint } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  canonicalPumpPoolPda,
  computeFeesBps,
  userVolumeAccumulatorPda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  newBondingCurve,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, POOL_ACCOUNT_NEW_SIZE, PUMP_AMM_SDK, coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda, userVolumeAccumulatorPda as ammVolumeAccumulatorPda, buyQuoteInput as ammBuyQuote, computeFeesBps as ammFeesBps, poolMarketCap, sellBaseInput as ammSellQuote, type SwapSolanaState } from "@pump-fun/pump-sdk/swap";
import type { CurveQuote, LaunchpadAdapter, PreparedTx, TokenInfo } from "./types";
import type { RpcPool } from "./rpc";
import { parsePumpEvents } from "./events";

const bn = (v: bigint) => new BN(v.toString());
const big = (v: BN) => BigInt(v.toString());
/** Igual que el SDK: el límite se calcula con el slippage en porcentaje (REQ-LAUNCH-012: se envía el valor configurado). */
export const slipUp = (v: bigint, pct: number) => v + (v * BigInt(Math.floor(pct * 10))) / 1000n;
export const slipDown = (v: bigint, pct: number) => v - (v * BigInt(Math.floor(pct * 10))) / 1000n;

export type PumpPayload = { instructions: import("@solana/web3.js").TransactionInstruction[] };

/** Tamaño de la cuenta de volumen por usuario (medido en cadena: 137 bytes, ≈ 0,0018444 SOL de rent). */
const USER_VOLUME_ACCUMULATOR_LEN = 137;
const MIGRATING = () => Object.assign(new Error("La curva está completa y la migración a PumpSwap aún no ha ocurrido. Espera a que exista el pool."), { code: "MIGRATING" });

export function createPumpFunAdapter(pool: RpcPool, getLaunchAlt: () => import("@solana/web3.js").AddressLookupTableAccount | null = () => null): LaunchpadAdapter {
  const sdks = new WeakMap<Connection, OnlinePumpSdk>();
  const online = () => {
    const c = pool.current();
    let s = sdks.get(c);
    if (!s) sdks.set(c, (s = new OnlinePumpSdk(c)));
    return s;
  };
  const amms = new WeakMap<Connection, OnlinePumpAmmSdk>();
  const amm = () => {
    const c = pool.current();
    let s = amms.get(c);
    if (!s) amms.set(c, (s = new OnlinePumpAmmSdk(c)));
    return s;
  };
  const metaCache = new Map<string, TokenInfo["metadata"]>();
  const rents = new Map<number, bigint>();
  const rentFor = async (len: number) => {
    let r = rents.get(len);
    if (r === undefined) rents.set(len, (r = BigInt(await pool.run((c) => c.getMinimumBalanceForRentExemption(len)))));
    return r;
  };
  const ataLens = new Map<string, number>();
  /** cuentas de volumen que ya existen (no se cierran al operar) */
  const existing = new Set<string>();
  /** Tamaño de la cuenta de token: Token-2022 añade las extensiones de cuenta que exige el mint, más ImmutableOwner. */
  const ataLenOf = async (m: PublicKey) => {
    let len = ataLens.get(m.toBase58());
    if (len === undefined) {
      const info = await pool.run((c) => c.getAccountInfo(m, "confirmed"));
      if (!info) throw new Error("El mint no existe en la cadena");
      if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        const mint = unpackMint(m, info, TOKEN_2022_PROGRAM_ID);
        len = getAccountLen([...new Set([...getExtensionTypes(mint.tlvData).map(getAccountTypeOfMintType), ExtensionType.ImmutableOwner])]);
      } else len = 165;
      ataLens.set(m.toBase58(), len);
    }
    return len;
  };
  let cachedGlobal: { at: number; global: Global; feeConfig: Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>> | null } | null = null;
  const globals = async () => {
    if (cachedGlobal && Date.now() - cachedGlobal.at < 30_000) return cachedGlobal;
    const [global, feeConfig] = await pool.run(async () => Promise.all([online().fetchGlobal(), online().fetchFeeConfig().catch(() => null)]));
    return (cachedGlobal = { at: Date.now(), global, feeConfig });
  };
  /** Programa de token del mint: los coins v2 son Token-2022, pero se lee del propietario de la cuenta. */
  const tokenProgramOf = async (mint: PublicKey) => (await mintMetaOf(mint)).program;
  /** P3-10 (REVIEW-F1): programa y decimales leídos del mint (offset 44 en Token y Token-2022); no cambian */
  const mintMetas = new Map<string, { program: PublicKey; decimals: number }>();
  const mintMetaOf = async (mint: PublicKey) => {
    let meta = mintMetas.get(mint.toBase58());
    if (!meta) {
      const info = await pool.run((c) => c.getAccountInfo(mint));
      if (!info) throw new Error("El mint no existe en la cadena");
      if (info.data.length < 45) throw new Error("La cuenta no es un mint de token");
      mintMetas.set(mint.toBase58(), (meta = { program: info.owner, decimals: info.data[44] }));
    }
    return meta;
  };

  const describe = (global: Global, before: BondingCurve, after: { vQuote: bigint; vTok: bigint; realTok: bigint }, side: "buy" | "sell", amountIn: bigint, amountOut: bigint, limit: bigint, slippagePct: number): CurveQuote => {
    const mc = (vQuote: bigint, vTok: bigint) => big(bondingCurveMarketCap({ mintSupply: before.tokenTotalSupply, virtualQuoteReserves: bn(vQuote), virtualTokenReserves: bn(vTok) }));
    const m0 = mc(big(before.virtualQuoteReserves), big(before.virtualTokenReserves));
    const m1 = mc(after.vQuote, after.vTok);
    const initReal = big(global.initialRealTokenReserves);
    return {
      side,
      venue: "curve",
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

  /** Estado del pool canónico de PumpSwap; null si la migración aún no lo ha creado. */
  const poolState = async (m: PublicKey, u: PublicKey): Promise<SwapSolanaState | null> => {
    const key = canonicalPumpPoolPda(m);
    const info = await pool.run((c) => c.getAccountInfo(key));
    if (!info) return null;
    return pool.run(() => amm().swapSolanaState(key, u));
  };

  /** Cotización en PumpSwap con las mismas funciones puras que usa el SDK al construir la instrucción. */
  const ammQuote = (st: SwapSolanaState, side: "buy" | "sell", amount: bigint, slippagePct: number): CurveQuote => {
    const p = st.pool;
    const common = {
      slippage: slippagePct,
      baseReserve: st.poolBaseAmount,
      quoteReserve: st.poolQuoteAmount,
      virtualQuoteReserves: p.virtualQuoteReserves,
      globalConfig: st.globalConfig,
      baseMintAccount: st.baseMintAccount,
      baseMint: st.baseMint,
      coinCreator: p.coinCreator,
      creator: p.creator,
      feeConfig: st.feeConfig,
      quoteMint: p.quoteMint,
      isMayhemMode: p.isMayhemMode,
      creatorFeeBps: p.creatorFeeBps,
      quoteTransferFee: st.quoteTransferFee,
    };
    const supply = new BN(st.baseMintAccount.supply.toString());
    const mc = (b: bigint, q: bigint) => (b > 0n ? big(poolMarketCap({ baseMintSupply: supply, baseReserve: bn(b), quoteReserve: bn(q), isMayhemMode: p.isMayhemMode })) : 0n);
    const b0 = big(st.poolBaseAmount);
    const q0 = big(st.poolQuoteAmount);
    const m0 = mc(b0, q0);
    let out: bigint, limit: bigint, m1: bigint;
    if (side === "buy") {
      const r = ammBuyQuote({ ...common, quote: bn(amount) });
      out = big(r.base);
      limit = big(r.maxQuote);
      m1 = mc(b0 - out, q0 + big(r.internalQuoteWithoutFees));
    } else {
      const r = ammSellQuote({ ...common, base: bn(amount), feeBucketsTotal: p.protocolFees.add(p.creatorFees) });
      out = big(r.uiQuote);
      limit = big(r.minQuote);
      m1 = mc(b0 + amount, q0 - out);
    }
    return { side, venue: "pumpswap", amountIn: amount, amountOut: out, limit, slippagePct, priceImpactPct: m0 > 0n ? Number(((m1 - m0) * 10_000n) / m0) / 100 : 0, marketCapLamports: m1, graduationPct: 100, complete: true };
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
      // Cotizar solo necesita la curva (o el pool), no el estado de ninguna wallet
      const c = await pool.run(() => online().fetchBondingCurve(m));
      if (c.complete) {
        const st = await poolState(m, m);
        if (!st) throw MIGRATING();
        return ammQuote(st, side, amount, slippagePct);
      }
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
      if (st.bondingCurve.complete) {
        const ps = await poolState(m, u);
        if (!ps) throw MIGRATING();
        const q = ammQuote(ps, "buy", lamports, slippagePct);
        const instructions = await PUMP_AMM_SDK.buyQuoteInput(ps, bn(lamports), slippagePct);
        return { kind: "buy", payer: user, signers: [user], mint, quote: q, payload: { instructions } satisfies PumpPayload };
      }
      const q = buyQuote(global, feeConfig, st.bondingCurve, lamports, slippagePct);
      const instructions = await PUMP_SDK.buyInstructions({ global, ...st, mint: m, user: u, amount: bn(q.amountOut), solAmount: bn(lamports), slippage: slippagePct, tokenProgram: tp });
      return { kind: "buy", payer: user, signers: [user], mint, quote: q, payload: { instructions } satisfies PumpPayload };
    },

    buildSellTx: async ({ mint, user, tokens, slippagePct }) => {
      const { global, feeConfig } = await globals();
      const m = new PublicKey(mint);
      const u = new PublicKey(user);
      const tp = await tokenProgramOf(m);
      const curve = await pool.run(() => online().fetchBondingCurve(m));
      if (curve.complete) {
        const ps = await poolState(m, u);
        if (!ps) throw MIGRATING();
        const q = ammQuote(ps, "sell", tokens, slippagePct);
        const instructions = await PUMP_AMM_SDK.sellBaseInput(ps, bn(tokens), slippagePct);
        return { kind: "sell", payer: user, signers: [user], mint, quote: q, payload: { instructions } satisfies PumpPayload };
      }
      const st = await pool.run(() => online().fetchSellState(m, u, tp));
      const c = st.bondingCurve;
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

    // REQ-REW-003: la tx de reclamo (SDK `collectCoinCreatorFee`) crea, pagando el creador, las cuentas WSOL que
    // falten: la del vault de PumpSwap (de una PDA: su rent se queda allí, es coste) y la del creador (se cierra
    // en la misma tx y el rent vuelve). Las dos hay que adelantarlas. Comprobado en Surfpool el 2026-11-07.
    claimRent: async (creator) => {
      const owner = new PublicKey(creator);
      const vaultAta = coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(owner), NATIVE_MINT, TOKEN_PROGRAM_ID);
      const ownAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
      const [vault, own] = await pool.run((c) => c.getMultipleAccountsInfo([vaultAta, ownAta], "confirmed"));
      const rent = await rentFor(165);
      const kept = vault ? 0n : rent;
      return { upfront: kept + (own ? 0n : rent), kept };
    },

    tokenInfo: async (mint) => {
      const { global, feeConfig } = await globals();
      const m = new PublicKey(mint);
      const [mintInfo, curveInfo] = await pool.run((c) => c.getMultipleAccountsInfo([m, bondingCurvePda(m)], "confirmed"));
      if (!mintInfo) throw Object.assign(new Error("El mint no existe en la cadena."), { statusCode: 404 });
      if (!curveInfo) throw Object.assign(new Error("Este token no es de Pump.fun: no tiene bonding curve."), { statusCode: 404 });
      const c = PUMP_SDK.decodeBondingCurve(curveInfo);
      const tp = mintInfo.owner;
      const supply = mintInfo.data.readBigUInt64LE(36);
      const decimals = mintInfo.data[44];
      if (!metaCache.has(mint)) {
        // Solo metadatos en cadena (extensión de Token-2022). Nunca se descarga la URI ni la imagen.
        const md = tp.equals(TOKEN_2022_PROGRAM_ID) ? await pool.run((cn) => getTokenMetadata(cn, m, "confirmed", TOKEN_2022_PROGRAM_ID)).catch(() => null) : null;
        metaCache.set(mint, md ? { name: md.name, symbol: md.symbol, uri: md.uri } : null);
      }
      // Market cap al completarse la curva, con las reservas iniciales del programa
      const vt0 = big(global.initialVirtualTokenReserves);
      const vs0 = big(global.initialVirtualSolReserves);
      const initReal = big(global.initialRealTokenReserves);
      const vtEnd = vt0 - initReal;
      const gradMc = vtEnd > 0n ? (((vs0 * vt0) / vtEnd) * supply) / vtEnd : 0n;
      const curveAccount = bondingCurvePda(m).toBase58();
      const base = { mint, tokenProgram: tp.toBase58(), decimals, supply, creator: c.creator.toBase58(), mayhem: c.isMayhemMode, curveAccount, graduationMcLamports: gradMc, metadata: metaCache.get(mint) ?? null };
      const unit = 10 ** decimals;
      if (!c.complete) {
        const fees = computeFeesBps({ global, feeConfig, mintSupply: c.tokenTotalSupply, virtualQuoteReserves: c.virtualQuoteReserves, virtualTokenReserves: c.virtualTokenReserves, quoteMint: c.quoteMint, creatorFeeBps: c.creatorFeeBps });
        return {
          ...base,
          venue: "curve",
          priceLamports: (Number(big(c.virtualQuoteReserves)) / Number(big(c.virtualTokenReserves))) * unit,
          marketCapLamports: big(bondingCurveMarketCap({ mintSupply: c.tokenTotalSupply, virtualQuoteReserves: c.virtualQuoteReserves, virtualTokenReserves: c.virtualTokenReserves })),
          graduationPct: initReal > 0n ? Math.min(100, Number(((initReal - big(c.realTokenReserves)) * 10_000n) / initReal) / 100) : 0,
          reserves: { quote: big(c.virtualQuoteReserves), token: big(c.virtualTokenReserves) },
          systemOwners: [{ owner: curveAccount, label: "Bonding curve" }],
          pool: null,
          padFeeBps: Number(fees.protocolFeeBps.add(fees.creatorFeeBps).toString()),
        } satisfies TokenInfo;
      }
      const st = await poolState(m, m);
      if (!st) {
        return { ...base, venue: "migrating", priceLamports: 0, marketCapLamports: gradMc, graduationPct: 100, reserves: { quote: big(c.realQuoteReserves), token: 0n }, systemOwners: [{ owner: curveAccount, label: "Bonding curve" }], pool: null, padFeeBps: 0 } satisfies TokenInfo;
      }
      const p = st.pool;
      const b = big(st.poolBaseAmount);
      const q = big(st.poolQuoteAmount);
      const fees = ammFeesBps({ globalConfig: st.globalConfig, feeConfig: st.feeConfig, creator: p.creator, baseMintSupply: new BN(supply.toString()), baseMint: m, baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, quoteMint: p.quoteMint, isMayhemMode: p.isMayhemMode, creatorFeeBps: p.creatorFeeBps });
      return {
        ...base,
        venue: "pumpswap",
        priceLamports: b > 0n ? (Number(q) / Number(b)) * unit : 0,
        marketCapLamports: b > 0n ? big(poolMarketCap({ baseMintSupply: new BN(supply.toString()), baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, isMayhemMode: p.isMayhemMode })) : 0n,
        graduationPct: 100,
        reserves: { quote: q, token: b },
        systemOwners: [
          { owner: curveAccount, label: "Bonding curve" },
          { owner: st.poolKey.toBase58(), label: "Pool de PumpSwap" },
        ],
        pool: st.poolKey.toBase58(),
        padFeeBps: Number(fees.lpFeeBps.add(fees.protocolFeeBps).add(fees.creatorFeeBps).toString()),
      } satisfies TokenInfo;
    },

    parseEvents: (tx, ctx) => parsePumpEvents(tx, ctx),

    tradeAccountsRent: async ({ mint, user, side }) => {
      const m = new PublicKey(mint);
      const u = new PublicKey(user);
      const tp = await tokenProgramOf(m);
      const c = await pool.run(() => online().fetchBondingCurve(m));
      const ata = getAssociatedTokenAddressSync(m, u, true, tp);
      const uva = c.complete ? ammVolumeAccumulatorPda(u) : userVolumeAccumulatorPda(u);
      // la cuenta de token se comprueba siempre (se puede cerrar); la de volumen, una vez creada, se recuerda
      const keys = existing.has(uva.toBase58()) ? [ata] : [ata, uva];
      const infos = await pool.run((cn) => cn.getMultipleAccountsInfo(keys, "confirmed"));
      if (infos[1]) existing.add(uva.toBase58());
      const a = !!infos[0];
      const v = existing.has(uva.toBase58());
      let rent = 0n;
      if (side === "buy" && !a) rent += await rentFor(await ataLenOf(m));
      if (!v) rent += await rentFor(USER_VOLUME_ACCUMULATOR_LEN);
      if (c.complete) {
        // PumpSwap: la compra abre una cuenta WSOL y la cierra en la misma tx; su rent debe estar disponible
        if (side === "buy") rent += await rentFor(165);
        // El primero que opera tras la migración amplía la cuenta del pool (extendAccount) y paga la diferencia
        const pi = await pool.run((cn) => cn.getAccountInfo(canonicalPumpPoolPda(m), "confirmed"));
        if (pi && pi.data.length < POOL_ACCOUNT_NEW_SIZE) {
          const need = await rentFor(POOL_ACCOUNT_NEW_SIZE);
          if (need > BigInt(pi.lamports)) rent += need - BigInt(pi.lamports);
        }
      }
      return rent;
    },

    // REQ-LIVE-005: transferencia con decimales comprobados; la cuenta de destino se crea idempotente
    buildTokenTransferTx: async ({ mint, from, to, tokens }) => {
      const m = new PublicKey(mint);
      const { program: tp, decimals } = await mintMetaOf(m);
      const f = new PublicKey(from);
      const t = new PublicKey(to);
      const src = getAssociatedTokenAddressSync(m, f, true, tp);
      const dst = getAssociatedTokenAddressSync(m, t, true, tp);
      const exists = !!(await pool.run((c) => c.getAccountInfo(dst, "confirmed")));
      const rentLamports = exists ? 0n : await rentFor(await ataLenOf(m));
      const instructions = [
        ...(exists ? [] : [createAssociatedTokenAccountIdempotentInstruction(f, dst, t, m, tp)]),
        createTransferCheckedInstruction(src, m, dst, f, tokens, decimals, [], tp),
      ];
      return { kind: "token-transfer", payer: from, signers: [from], mint, cuLimit: 60_000, payload: { instructions } satisfies PumpPayload, rentLamports };
    },

    buildBurnTx: async ({ mint, owner, tokens }) => {
      const m = new PublicKey(mint);
      const { program: tp, decimals } = await mintMetaOf(m);
      const o = new PublicKey(owner);
      const ix = createBurnCheckedInstruction(getAssociatedTokenAddressSync(m, o, true, tp), m, o, tokens, decimals, [], tp);
      return { kind: "burn", payer: owner, signers: [owner], mint, cuLimit: 30_000, payload: { instructions: [ix] } satisfies PumpPayload };
    },

    // Sin permisos en el programa. En mainnet la ejecuta Pump.fun; Nébula solo la expone en el perfil de pruebas.
    buildMigrateTx: async ({ mint, payer }) => {
      const { global } = await globals();
      const m = new PublicKey(mint);
      const tp = await tokenProgramOf(m);
      const ix = await PUMP_SDK.migrateV2Instruction({ withdrawAuthority: global.withdrawAuthority, mint: m, user: new PublicKey(payer), baseTokenProgram: tp, quoteTokenProgram: TOKEN_PROGRAM_ID });
      return { kind: "migrate", payer, signers: [payer], mint, cuLimit: 600_000, payload: { instructions: [ix] } satisfies PumpPayload };
    },
  };
}

export { TOKEN_2022_PROGRAM_ID };
