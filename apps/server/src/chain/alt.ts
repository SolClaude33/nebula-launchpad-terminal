// Address Lookup Table de Nébula para create_v2 + dev buy: con una URI de IPFS normal la transacción
// supera los 1.232 bytes. Las cuentas FIJAS del programa (las que no dependen del mint ni del creador)
// van en una tabla propia; cada una ocupa 1 byte en vez de 32. Se crea una sola vez, de forma explícita.
import { createHash } from "node:crypto";
import { AddressLookupTableProgram, Keypair, PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import type { LaunchpadAdapter } from "./types";

/**
 * Claves no firmantes comunes a varios lanzamientos con mint y creador distintos = cuentas fijas.
 * El SDK elige al azar una cuenta de comisiones entre varias: con solo dos muestras podía coincidir y
 * colarse en la lista, y la huella cambiaba de un arranque a otro (la tabla parecía no existir).
 */
export async function staticLaunchKeys(adapter: LaunchpadAdapter, samples = 6) {
  const sample = async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const tx = await adapter.buildCreateTx({ name: "X", symbol: "X", uri: "x", creator, mint, devBuyLamports: 10_000_000n, slippagePct: 1, mayhem: false });
    const ixs = (tx.payload as { instructions: TransactionInstruction[] }).instructions;
    const keys = new Set<string>();
    for (const ix of ixs) {
      keys.add(ix.programId.toBase58());
      for (const k of ix.keys) if (!k.isSigner) keys.add(k.pubkey.toBase58());
    }
    return keys;
  };
  let common = await sample();
  for (let i = 1; i < samples; i++) {
    const next = await sample();
    common = new Set([...common].filter((k) => next.has(k)));
  }
  return [...common].sort();
}

export const keysFingerprint = (keys: string[]) => createHash("sha256").update(keys.join(",")).digest("hex").slice(0, 16);

export function altCreateInstructions(authority: string, recentSlot: number, keys: string[]) {
  const auth = new PublicKey(authority);
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: auth, payer: auth, recentSlot });
  // una extensión admite ~30 claves por transacción; las cuentas fijas de Pump.fun caben de sobra
  const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: auth, payer: auth, addresses: keys.map((k) => new PublicKey(k)) });
  return { address: address.toBase58(), instructions: [create, extend] };
}

export type AltState = { address: string; fingerprint: string; keys: number; account: AddressLookupTableAccount };
