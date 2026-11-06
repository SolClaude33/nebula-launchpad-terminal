"use client";

import { useVault } from "@/lib/vault";

/** TEST-ENV-008: banner visible en el perfil de pruebas. */
export function ProfileBanner() {
  const profile = useVault((s) => s.status?.profile);
  if (profile === "mainnet") return null;
  return (
    <div className="telemetry flex h-6 items-center justify-center gap-2 border-b border-warn/20 bg-[var(--warn-soft)] text-[10px] text-warn">
      Perfil de pruebas · bóveda y datos locales separados de mainnet
    </div>
  );
}
