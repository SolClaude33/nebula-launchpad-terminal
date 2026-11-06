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
import { altCreateInstructions, keysFingerprint, staticLaunchKeys } from "./alt";
import { kvGet, kvSet } from "../db";
import type { AddressLookupTableAccount } from "@solana/web3.js";

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
    accountExists: async (address) => !!(await pool.run((c) => c.getAccountInfo(new PublicKey(address), "confirmed"))),
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
  let alt: AddressLookupTableAccount | null = null;
  let staticKeys: string[] | null = null;
  const adapter = createPumpFunAdapter(pool, () => alt);
  const keys = async () => (staticKeys ??= await staticLaunchKeys(adapter));
  const loadAlt = async (address: string, want: string[]) => {
    const r = await pool.run((c) => c.getAddressLookupTable(new PublicKey(address)));
    const acc = r.value;
    if (!acc) return null;
    const have = new Set(acc.state.addresses.map((a) => a.toBase58()));
    return want.every((k) => have.has(k)) ? acc : null;
  };
  const launchAlt = {
    status: async () => {
      const want = await keys();
      const fp = keysFingerprint(want);
      const saved = JSON.parse(kvGet(opts.db(), `launchAlt:${opts.profile}`) ?? "null") as { address: string; fp: string } | null;
      if (saved && saved.fp === fp) alt = await loadAlt(saved.address, want).catch(() => null);
      else alt = null;
      const rentLamports = BigInt(await pool.run((c) => c.getMinimumBalanceForRentExemption(56 + 32 * want.length)));
      return { ready: !!alt, address: alt ? alt.key.toBase58() : null, keys: want.length, rentLamports };
    },
    ensure: async (payer: string) => {
      const st = await launchAlt.status();
      if (st.ready && st.address) return { address: st.address, created: false };
      const want = await keys();
      const slot = await pool.run((c) => c.getSlot("finalized"));
      const { address, instructions } = altCreateInstructions(payer, slot, want);
      const res = await sender.send({ kind: "transfer", payer, signers: [payer], cuLimit: 50_000, payload: { instructions } }, { idempotencyKey: `alt:${keysFingerprint(want)}:${slot}` });
      if (res.status !== "confirmed") throw Object.assign(new Error(`No se pudo crear la tabla de direcciones: ${"message" in res ? res.message : res.status}`), { statusCode: 409 });
      // La tabla se puede usar a partir del slot siguiente a la extensión
      const created = await pool.run((c) => c.getSlot("confirmed"));
      for (let i = 0; i < 40; i++) {
        const acc = await loadAlt(address, want).catch(() => null);
        const now = await pool.run((c) => c.getSlot("confirmed"));
        if (acc && now > created) {
          alt = acc;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!alt) throw Object.assign(new Error("La tabla de direcciones no se activó a tiempo; vuelve a intentarlo."), { statusCode: 409 });
      kvSet(opts.db(), `launchAlt:${opts.profile}`, JSON.stringify({ address, fp: keysFingerprint(want) }));
      return { address, created: true };
    },
  };
  const transfers: TransferBuilder = {
    build: async (from, items) =>
      chunkTransfers(from, items).map((chunk) => ({ kind: "transfer", payer: from, signers: [from], cuLimit: transferCuLimit(chunk.length), payload: { instructions: transferInstructions(from, chunk) } })),
    feeOf: (tx) => sender.feeOf(tx),
    rentExemptMin: async () => (rentMin ??= BigInt(await pool.run((c) => c.getMinimumBalanceForRentExemption(0)))),
  };
  return {
    transfers,
    launchAlt,
    kind: "rpc",
    adapter,
    sender,
    reader: rpcReader(pool, opts.profile),
    status: () => pool.status(),
    stop: () => pool.stop(),
    reconcile: () => sender.reconcile(),
  };
}
