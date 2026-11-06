// Spike desechable: create_v2 + dev buy, compra desde otra wallet y venta, contra Surfpool (127.0.0.1).
// Las claves se generan con libsodium y nunca entran en web3.js: firmamos los bytes del mensaje.
import sodium from "libsodium-wrappers-sumo";
import BN from "bn.js";
import { ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { NATIVE_MINT } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, bondingCurveMarketCap } from "@pump-fun/pump-sdk";

const RPC = "http://127.0.0.1:8899";
if (!/^http:\/\/127\.0\.0\.1:/.test(RPC)) throw new Error("El spike solo corre contra loopback");

await sodium.ready;
const conn = new Connection(RPC, "confirmed");
const online = new OnlinePumpSdk(conn);
type Kp = { pk: PublicKey; sk: Uint8Array };
const kp = (): Kp => {
  const k = sodium.crypto_sign_keypair();
  return { pk: new PublicKey(k.publicKey), sk: k.privateKey };
};

async function send(ixs: TransactionInstruction[], payer: Kp, extra: Kp[] = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.pk,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const bytes = tx.message.serialize();
  for (const s of [payer, ...extra]) tx.addSignature(s.pk, sodium.crypto_sign_detached(bytes, s.sk));
  const sim = await conn.simulateTransaction(tx, { sigVerify: true });
  if (sim.value.err) {
    console.log("SIM ERR", JSON.stringify(sim.value.err), sim.value.logs?.slice(-12));
    throw new Error("simulación fallida");
  }
  let sig = "";
  for (let i = 0; ; i++) {
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      break;
    } catch (e) {
      // Surfpool trae cuentas de mainnet bajo demanda; el RPC público a veces corta la petición
      if (i < 5 && String((e as Error).message).includes("Failed to fetch accounts from remote")) {
        console.log("  reintento por fallo remoto", i + 1);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`tx falló: ${JSON.stringify(conf.value.err)}`);
  return { sig, units: sim.value.unitsConsumed };
}

const creator = kp();
const mint = kp();
const buyer = kp();
for (const w of [creator, buyer]) {
  const s = await conn.requestAirdrop(w.pk, 5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(s, "confirmed");
}
console.log("airdrop ok", (await conn.getBalance(creator.pk)) / LAMPORTS_PER_SOL);

const global = await online.fetchGlobal();
const feeConfig = await online.fetchFeeConfig().catch(() => null);
console.log("global: feeBps", global.feeBasisPoints.toString(), "initialVirtualSol", global.initialVirtualSolReserves.toString());

// 1) create_v2 + dev buy (0,5 SOL) en una transacción
const devSol = new BN(0.5 * LAMPORTS_PER_SOL);
const devTokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: devSol, quoteMint: NATIVE_MINT });
const createIxs = await PUMP_SDK.createV2AndBuyInstructions({
  global,
  mint: mint.pk,
  name: "Kepler Test",
  symbol: "KTEST",
  uri: "https://example.invalid/metadata.json",
  creator: creator.pk,
  user: creator.pk,
  amount: devTokens,
  solAmount: devSol,
  mayhemMode: false,
});
const c = await send(createIxs, creator, [mint]);
console.log("create+devbuy ok", c.sig.slice(0, 12), "CU", c.units, "devTokens", devTokens.toString());

// 2) compra desde otra wallet (0,2 SOL, slippage 15 %)
const buyState = await online.fetchBuyState(mint.pk, buyer.pk, TOKEN_2022_PROGRAM_ID);
const buySol = new BN(0.2 * LAMPORTS_PER_SOL);
const buyTokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: buyState.bondingCurve.tokenTotalSupply, bondingCurve: buyState.bondingCurve, amount: buySol, quoteMint: NATIVE_MINT });
const buyIxs = await PUMP_SDK.buyInstructions({ global, ...buyState, mint: mint.pk, user: buyer.pk, amount: buyTokens, solAmount: buySol, slippage: 15, tokenProgram: TOKEN_2022_PROGRAM_ID });
const b = await send(buyIxs, buyer);
const ata = getAssociatedTokenAddressSync(mint.pk, buyer.pk, true, TOKEN_2022_PROGRAM_ID);
const bal = await conn.getTokenAccountBalance(ata);
console.log("buy ok", b.sig.slice(0, 12), "tokens", bal.value.amount, "esperado", buyTokens.toString());

// 3) venta de la mitad
const sellState = await online.fetchSellState(mint.pk, buyer.pk, TOKEN_2022_PROGRAM_ID);
const sellAmount = new BN(bal.value.amount).divn(2);
const sellSol = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: sellState.bondingCurve.tokenTotalSupply, bondingCurve: sellState.bondingCurve, amount: sellAmount });
const sellIxs = await PUMP_SDK.sellInstructions({ global, ...sellState, mint: mint.pk, user: buyer.pk, amount: sellAmount, solAmount: sellSol, slippage: 5, tokenProgram: TOKEN_2022_PROGRAM_ID, mayhemMode: false });
const s = await send(sellIxs, buyer);
console.log("sell ok", s.sig.slice(0, 12), "SOL esperado", sellSol.toNumber() / LAMPORTS_PER_SOL);

const curve = (await online.fetchSellState(mint.pk, buyer.pk, TOKEN_2022_PROGRAM_ID)).bondingCurve;
const mc = bondingCurveMarketCap({ mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves });
console.log("market cap (lamports)", mc.toString(), "realQuote", curve.realQuoteReserves.toString(), "complete", curve.complete);
