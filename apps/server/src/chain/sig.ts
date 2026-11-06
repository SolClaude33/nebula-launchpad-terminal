import type { VersionedTransaction } from "@solana/web3.js";
import { b58encode } from "../base58";

/** La primera firma (la del pagador) es el id de la transacción. */
export const firstSignature = (tx: VersionedTransaction) => b58encode(tx.signatures[0]);
