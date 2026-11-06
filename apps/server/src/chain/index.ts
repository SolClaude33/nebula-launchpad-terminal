import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Profile } from "@nebula/shared";
import type { DB } from "../db";
import { createMockEnv, MockLedger } from "./mock";
import { createPumpFunAdapter, TOKEN_2022_PROGRAM_ID } from "./pumpfun";
import { isLoopback, RpcPool, type Endpoint, type RpcStatus } from "./rpc";
import { SolanaSender } from "./sender";
import type { ChainEnv, ChainReader, MessageSigner, TransferBuilder } from "./types";
import { transferCuLimit } from "./fees";
import { chunkTransfers, transferInstructions } from "./transfers";

export type Chain = ChainEnv & { status: () => RpcStatus; stop: () => void; reconcile: () => Promise<number>; kind: "rpc" | "mock"; ledger?: MockLedger };

export class ChainConfigError extends Error {}

/**
 * Perfil `test`: el RPC tiene que ser local (Surfpool o validador). Un fork de mainnet se parece
 * a mainnet, así que la protección es por host, no por genesis hash.
 */
export function assertProfileRpc(profile: Profile, endpoints: Endpoint[]) {
  if (profile === "test") {
    const bad = endpoints.find((e) => !isLoopback(e.http) || (e.ws && !isLoopback(e.ws)));
    if (bad) throw new ChainConfigError(`En el perfil de pruebas el RPC debe ser local (127.0.0.1). Revisa Ajustes: ${new URL(bad.http).host}`);
  }
}

function rpcReader(pool: RpcPool, profile: Profile): ChainReader {
  return {
    // Saldos en lotes de 100 con getMultipleAccountsInfo (no un getBalance por wallet)
    balances: async (addrs) => {
      const out = new Map<string, bigint>();
      for (let i = 0; i < addrs.length; i += 100) {
        const chunk = addrs.slice(i, i + 100);
        const infos = await pool.run((c) => c.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), "confirmed"));
        chunk.forEach((a, j) => out.set(a, BigInt(infos[j]?.lamports ?? 0)));
      }
      return out;
    },
    tokenBalance: async (mint, owner) => {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID);
      const r = await pool.run((c) => c.getTokenAccountBalance(ata, "confirmed")).catch(() => null);
      return r ? BigInt(r.value.amount) : 0n;
    },
    airdrop:
      profile === "test"
        ? async (address, lamports) => {
            const sig = await pool.run((c) => c.requestAirdrop(new PublicKey(address), Number(lamports)));
            await pool.run((c) => c.confirmTransaction(sig, "confirmed"));
          }
        : undefined,
  };
}

export function createChain(opts: { profile: Profile; mode: "rpc" | "mock"; endpoints: Endpoint[]; db: () => DB; sign: MessageSigner; priorityMicroLamports: () => number }): Chain {
  if (opts.mode === "mock") {
    const env = createMockEnv(opts.sign, undefined, opts.priorityMicroLamports);
    return { ...env, kind: "mock", status: () => ({ healthy: true, host: "mock", latencyMs: 0, usingBackup: false, endpoints: 1 }), stop: () => {}, reconcile: async () => 0 };
  }
  assertProfileRpc(opts.profile, opts.endpoints);
  const pool = new RpcPool(opts.endpoints);
  pool.start();
  const sender = new SolanaSender(pool, opts.db, opts.sign, { computeUnitLimit: 400_000, priorityMicroLamports: opts.priorityMicroLamports });
  let rentMin: bigint | null = null;
  const transfers: TransferBuilder = {
    build: async (from, items) =>
      chunkTransfers(from, items).map((chunk) => ({ kind: "transfer", payer: from, signers: [from], cuLimit: transferCuLimit(chunk.length), payload: { instructions: transferInstructions(from, chunk) } })),
    feeOf: (tx) => sender.feeOf(tx),
    rentExemptMin: async () => (rentMin ??= BigInt(await pool.run((c) => c.getMinimumBalanceForRentExemption(0)))),
  };
  return {
    transfers,
    kind: "rpc",
    adapter: createPumpFunAdapter(pool),
    sender,
    reader: rpcReader(pool, opts.profile),
    status: () => pool.status(),
    stop: () => pool.stop(),
    reconcile: () => sender.reconcile(),
  };
}
