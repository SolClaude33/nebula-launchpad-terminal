// Troceado de transferencias de SOL en transacciones que caben en 1.232 bytes, midiendo el mensaje compilado.
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { transferCuLimit } from "./fees";

export type TransferItem = { to: string; lamports: bigint };
const MAX_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

export function transferInstructions(from: string, items: TransferItem[]) {
  const f = new PublicKey(from);
  return items.map((i) => SystemProgram.transfer({ fromPubkey: f, toPubkey: new PublicKey(i.to), lamports: i.lamports }));
}

/** Tamaño serializado (con firmas) de una tx con estas transferencias y el compute budget que añade el sender. */
export function transferTxSize(from: string, items: TransferItem[]) {
  const msg = new TransactionMessage({
    payerKey: new PublicKey(from),
    recentBlockhash: DUMMY_BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: transferCuLimit(items.length) }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...transferInstructions(from, items)],
  }).compileToV0Message();
  return new VersionedTransaction(msg).serialize().length;
}

/** Agrupa las transferencias de un mismo origen en el menor número de transacciones válidas. */
export function chunkTransfers(from: string, items: TransferItem[]): TransferItem[][] {
  const chunks: TransferItem[][] = [];
  let cur: TransferItem[] = [];
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length > 0 && transferTxSize(from, next) > MAX_TX_BYTES) {
      chunks.push(cur);
      cur = [it];
    } else cur = next;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export const isValidAddress = (a: string) => {
  try {
    return new PublicKey(a).toBytes().length === 32;
  } catch {
    return false;
  }
};

/** Una dirección fuera de la curva es un PDA: enviar SOL ahí casi siempre es un error. */
export const isOnCurve = (a: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(a).toBytes());
  } catch {
    return false;
  }
};
