// Una sola función de fees para la vista previa, el MAX, el mock y el sender real (REQ-COST-001/002).
// Fee de Solana = 5.000 lamports por firma + priority fee sobre el límite de CU *solicitado*.
export const LAMPORTS_PER_SIGNATURE = 5_000n;

export function txFee(signatures: number, computeUnitLimit: number, microLamportsPerCu: number) {
  const priority = (BigInt(computeUnitLimit) * BigInt(Math.max(0, Math.floor(microLamportsPerCu))) + 999_999n) / 1_000_000n;
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + priority;
}

/** Límite de CU para una transacción de transferencias: compute budget + ~150 CU por transferencia, con margen. */
export const transferCuLimit = (n: number) => 1_000 + 300 * n;

/**
 * Mínimo exento de rent para una cuenta de sistema sin datos. Una cuenta debe acabar en 0 o en ≥ este valor:
 * un destino vacío que recibe menos, o un origen que queda con polvo, hacen fallar la transacción entera.
 * En el RPC real se lee con getMinimumBalanceForRentExemption(0); este es el valor de mainnet.
 */
export const RENT_EXEMPT_MIN_DEFAULT = 890_880n;
