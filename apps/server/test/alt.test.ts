// La lista de cuentas fijas de la tabla de direcciones no puede depender de una elección aleatoria del SDK.
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { staticLaunchKeys } from "../src/chain/alt";
import type { LaunchpadAdapter } from "../src/chain/types";

const FIXED = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
const FEE_RECIPIENTS = Array.from({ length: 2 }, () => Keypair.generate().publicKey);

function fakeAdapter(): LaunchpadAdapter {
  let n = 0;
  return {
    buildCreateTx: async ({ creator, mint }: { creator: string; mint: string }) => {
      // las dos primeras muestras coinciden en la cuenta de comisiones (el caso que rompía la huella)
      const fee = FEE_RECIPIENTS[n < 2 ? 0 : n % 2];
      n++;
      const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(creator), toPubkey: fee, lamports: 1 });
      ix.keys.push(...FIXED.map((k) => ({ pubkey: k, isSigner: false, isWritable: false })), { pubkey: new PublicKey(mint), isSigner: true, isWritable: true });
      return { kind: "create", payer: creator, signers: [creator, mint], payload: { instructions: [ix] } };
    },
  } as unknown as LaunchpadAdapter;
}

describe("Tabla de direcciones · cuentas fijas", () => {
  it("una cuenta de comisiones elegida al azar no entra en la lista: la huella es estable entre arranques", async () => {
    const want = [...FIXED.map((k) => k.toBase58()), SystemProgram.programId.toBase58()].sort();
    expect(await staticLaunchKeys(fakeAdapter())).toEqual(want);
    // con solo dos muestras (el código anterior) se colaba la cuenta de comisiones
    expect(await staticLaunchKeys(fakeAdapter(), 2)).toContain(FEE_RECIPIENTS[0].toBase58());
  });
});
