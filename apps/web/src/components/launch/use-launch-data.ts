"use client";

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { WalletDto } from "@nebula/shared";
import { api } from "@/lib/api";
import { useChain } from "@/lib/chain";

const useWallets = create<{ wallets: WalletDto[] | null; set: (w: WalletDto[]) => void }>((set) => ({ wallets: null, set: (wallets) => set({ wallets }) }));

/** Wallets reales de la bóveda y sus saldos leídos del RPC, compartidos por los pasos del asistente. */
export function useLaunchData() {
  const wallets = useWallets((s) => s.wallets);
  const setWallets = useWallets((s) => s.set);
  const balances = useChain((s) => s.balances);
  const refreshBalances = useChain((s) => s.refreshBalances);
  const refresh = useCallback(async () => {
    try {
      setWallets((await api<{ wallets: WalletDto[] }>("/wallets")).wallets);
      await refreshBalances();
    } catch {}
  }, [setWallets, refreshBalances]);
  useEffect(() => {
    if (wallets === null) void refresh();
  }, [wallets, refresh]);
  const byId = useMemo(() => new Map((wallets ?? []).map((w) => [w.id, w])), [wallets]);
  const addressOf = useCallback((id: string) => byId.get(id)?.address, [byId]);
  return { wallets: wallets ?? [], loaded: wallets !== null, byId, addressOf, balances, refresh };
}
