import { PublicKey } from "@solana/web3.js";
import { ExtensionType, getAccountLen, getAccountTypeOfMintType, getAssociatedTokenAddressSync, getExtensionTypes, getMint, getTokenMetadata } from "@solana/spl-token";

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
import { b58decode } from "../base58";
import type { RawTx } from "./types";
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

/** Feed SOL/USD del oráculo Pyth (cuenta patrocinada del push oracle en mainnet; Surfpool la trae del fork). */
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

export function decodePythPrice(d: Buffer) {
  // PriceUpdateV2: discriminador(8) · write_authority(32) · verification_level(1 o 2) · price_message
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1);
  const price = d.readBigInt64LE(off + 32);
  const expo = d.readInt32LE(off + 32 + 16);
  const publishTime = Number(d.readBigInt64LE(off + 32 + 20));
  return { usd: Number(price) * 10 ** expo, publishedAt: publishTime * 1000 };
}

function rpcReader(pool: RpcPool, profile: Profile): ChainReader {
  const programs = new Map<string, { program: PublicKey; rent: bigint | null }>();
  const programOf = async (mint: string) => {
    let p = programs.get(mint);
    if (!p) {
      const info = await pool.run((c) => c.getAccountInfo(new PublicKey(mint), "confirmed"));
      if (!info) throw Object.assign(new Error("El mint no existe en la cadena."), { statusCode: 404 });
      p = { program: info.owner, rent: null };
      programs.set(mint, p);
    }
    return p;
  };
  const ataOf = (mint: string, owner: string, program: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, program);
  let price: { at: number; v: { usd: number; publishedAt: number } | null } | null = null;
  /** ¿el RPC soporta getTokenLargestAccounts? (Surfpool no: se recuerda para no reintentarlo cada vez) */
  let largestSupported: boolean | null = null;
  // En mainnet el precio debe ser reciente; el fork de pruebas lo congela al traer la cuenta
  const maxAgeMs = profile === "test" ? 7 * 24 * 3600_000 : 5 * 60_000;
  return {
    tokenBalances: async (mint, owners) => {
      const { program } = await programOf(mint);
      const out = new Map<string, bigint>();
      for (let i = 0; i < owners.length; i += 100) {
        const chunk = owners.slice(i, i + 100);
        const infos = await pool.run((c) => c.getMultipleAccountsInfo(chunk.map((o) => ataOf(mint, o, program)), "confirmed"));
        chunk.forEach((o, j) => out.set(o, infos[j] && infos[j]!.data.length >= 72 ? infos[j]!.data.readBigUInt64LE(64) : 0n));
      }
      return out;
    },
    holders: async (mint) => {
      const { program } = await programOf(mint);
      const m = new PublicKey(mint);
      // getTokenLargestAccounts (top 20) en RPCs reales; si no está, getProgramAccounts filtrando por mint
      // Una sola llamada directa (sin los reintentos de errores transitorios del pool)
      const largest = largestSupported === false ? null : await pool.current().getTokenLargestAccounts(m, "confirmed").catch(() => null);
      // Solo en pruebas se recuerda que no existe (Surfpool); en mainnet un fallo puntual no cambia de método
      if (largestSupported === null && profile === "test") largestSupported = !!largest;
      if (largest) {
        const accs = largest.value.filter((a) => a.amount !== "0");
        const infos = await pool.run((c) => c.getMultipleAccountsInfo(accs.map((a) => a.address), "confirmed"));
        return { complete: false, items: accs.map((a, i) => ({ owner: infos[i] ? new PublicKey(infos[i]!.data.subarray(32, 64)).toBase58() : a.address.toBase58(), amount: BigInt(a.amount) })) };
      }
      const all = await pool.run((c) => c.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint } }] }));
      const items = all.map((a) => ({ owner: new PublicKey(a.account.data.subarray(32, 64)).toBase58(), amount: a.account.data.readBigUInt64LE(64) })).filter((h) => h.amount > 0n);
      return { complete: true, items };
    },
    signatures: async (address, { until, before, limit }) => {
      const r = await pool.run((c) => c.getSignaturesForAddress(new PublicKey(address), { until, before, limit }, "confirmed"));
      return r.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err }));
    },
    transactions: async (sigs) => {
      if (sigs.length === 0) return [];
      // Lotes de 10 como máximo: un lote JSON-RPC cuenta como N peticiones para el proveedor (REVIEW-F1 P1-4)
      const txs: Awaited<ReturnType<import("@solana/web3.js").Connection["getTransactions"]>> = [];
      for (let i = 0; i < sigs.length; i += 10) {
        const part = sigs.slice(i, i + 10);
        txs.push(...(await pool.run((c) => c.getTransactions(part, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), { cost: part.length })));
      }
      const out: RawTx[] = [];
      txs.forEach((t, i) => {
        if (!t?.meta) return;
        const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
        const inner = (t.meta.innerInstructions ?? []).flatMap((ii) => ii.instructions.map((ix) => ({ program: keys.get(ix.programIdIndex)?.toBase58() ?? "", data: b58decode(ix.data) ?? new Uint8Array() })));
        // Variación de SOL por cuenta: lo que de verdad salió o entró de cada wallet (fees y rent incluidos)
        const deltas: Record<string, bigint> = {};
        t.meta.preBalances.forEach((pre, j) => {
          const d = BigInt(t.meta!.postBalances[j] ?? pre) - BigInt(pre);
          const k = keys.get(j)?.toBase58();
          if (k && d !== 0n) deltas[k] = (deltas[k] ?? 0n) + d;
        });
        out.push({ signature: sigs[i], slot: t.slot, blockTime: t.blockTime ?? null, err: t.meta.err, logs: t.meta.logMessages ?? [], inner, fee: BigInt(t.meta.fee), deltas });
      });
      return out;
    },
    // Suscripción a logs que mencionan la dirección; se rehace sola si el pool cambia de RPC (failover)
    onLogs: (address, cb) => {
      let conn = pool.current();
      let id: number | null = null;
      const sub = () => {
        try {
          id = conn.onLogs(new PublicKey(address), (l, ctx) => cb({ signature: l.signature, slot: ctx.slot, blockTime: null, err: l.err, logs: l.logs }), "confirmed");
        } catch {
          id = null;
        }
      };
      const unsub = () => {
        if (id !== null) void conn.removeOnLogsListener(id).catch(() => {});
        id = null;
      };
      sub();
      const t = setInterval(() => {
        if (pool.current() !== conn) {
          unsub();
          conn = pool.current();
          sub();
        }
      }, 2000);
      t.unref?.();
      return () => {
        clearInterval(t);
        unsub();
      };
    },
    solUsd: async () => {
      if (price && Date.now() - price.at < 30_000) return price.v;
      const info = await pool.run((c) => c.getAccountInfo(PYTH_SOL_USD, "confirmed")).catch(() => null);
      let v: { usd: number; publishedAt: number } | null = null;
      try {
        if (info) v = decodePythPrice(info.data);
      } catch {}
      if (v && (!(v.usd > 0) || Date.now() - v.publishedAt > maxAgeMs)) v = null;
      price = { at: Date.now(), v };
      return v;
    },
    tokenAccountRent: async (mint) => {
      const p = await programOf(mint);
      if (p.rent === null) {
        let len = 165;
        if (p.program.equals(TOKEN_2022_PROGRAM_ID)) {
          const m = await pool.run((c) => getMint(c, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID));
          const types = [...new Set([...getExtensionTypes(m.tlvData).map(getAccountTypeOfMintType), ExtensionType.ImmutableOwner])];
          len = getAccountLen(types);
        }
        p.rent = BigInt(await pool.run((c) => c.getMinimumBalanceForRentExemption(len)));
      }
      return p.rent;
    },
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
    // El programa de token se lee del propietario del mint: los coins antiguos son SPL Token
    tokenBalance: async (mint, owner) => {
      const { program } = await programOf(mint);
      const r = await pool.run((c) => c.getTokenAccountBalance(ataOf(mint, owner, program), "confirmed")).catch(() => null);
      return r ? BigInt(r.value.amount) : 0n;
    },
    accountExists: async (address) => !!(await pool.run((c) => c.getAccountInfo(new PublicKey(address), "confirmed"))),
    tokenMetadata: async (mint) => {
      const m = new PublicKey(mint);
      const info = await pool.run((c) => c.getAccountInfo(m, "confirmed"));
      if (!info) return null;
      // Pump.fun actual: Token-2022 con la extensión de metadatos
      if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        const md = await pool.run((c) => getTokenMetadata(c, m, "confirmed", TOKEN_2022_PROGRAM_ID)).catch(() => null);
        if (md) return { name: md.name, symbol: md.symbol, uri: md.uri };
      }
      // Tokens SPL antiguos: cuenta de metadatos de Metaplex (key · update authority · mint · name · symbol · uri)
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), m.toBuffer()], METAPLEX);
      const acc = await pool.run((c) => c.getAccountInfo(pda, "confirmed"));
      if (!acc) return null;
      const d = acc.data;
      let o = 1 + 32 + 32;
      const str = () => {
        const n = d.readUInt32LE(o);
        o += 4;
        const s = d.subarray(o, o + n).toString("utf8").replace(/\0/g, "").trim();
        o += n;
        return s;
      };
      try {
        return { name: str(), symbol: str(), uri: str() };
      } catch {
        return null;
      }
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

export function createChain(opts: { profile: Profile; mode: "rpc" | "mock"; endpoints: Endpoint[]; db: () => DB; sign: MessageSigner; priorityMicroLamports: () => number; limits?: import("./rpc").RpcLimits }): Chain {
  if (opts.mode === "mock") {
    const env = createMockEnv(opts.sign, undefined, opts.priorityMicroLamports, opts.db);
    return { ...env, kind: "mock", status: () => ({ healthy: true, host: "mock", latencyMs: 0, usingBackup: false, endpoints: 1 }), stop: () => {}, reconcile: async () => 0 };
  }
  assertProfileRpc(opts.profile, opts.endpoints);
  const pool = new RpcPool(opts.endpoints, undefined, opts.limits);
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
      // La tabla guardada sirve si contiene todas las claves que hacen falta ahora (aunque cambie la huella).
      // Un error del RPC al leerla no significa que falte: se propaga en vez de pedir crear otra (y pagar otro rent).
      alt = null;
      if (saved) {
        let lastErr: unknown = null;
        for (let i = 0; i < 3 && !alt; i++) {
          try {
            alt = await loadAlt(saved.address, want);
            lastErr = null;
            if (!alt) break;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 400 * (i + 1)));
          }
        }
        if (lastErr) throw Object.assign(new Error(`No se pudo leer la tabla de direcciones de Nébula (RPC): ${(lastErr as Error).message}`), { statusCode: 503 });
        if (alt && saved.fp !== fp) kvSet(opts.db(), `launchAlt:${opts.profile}`, JSON.stringify({ address: saved.address, fp }));
      }
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
      // Un resultado pendiente (confirmación lenta) no es un fallo: se comprueba si la tabla ya existe
      if (res.status === "failed") throw Object.assign(new Error(`No se pudo crear la tabla de direcciones: ${res.message}`), { statusCode: 409 });
      // La tabla se puede usar a partir del slot siguiente a la extensión
      const created = await pool.run((c) => c.getSlot("confirmed"));
      for (let i = 0; i < 75; i++) {
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
