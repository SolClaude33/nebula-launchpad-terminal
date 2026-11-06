"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  ChevronsLeft,
  Coins,
  Landmark,
  LayoutDashboard,
  Layers,
  Radar,
  Rocket,
  ScrollText,
  Settings,
  Wallet,
} from "lucide-react";
import { fmtLamports, useChain } from "@/lib/chain";
import { api } from "@/lib/api";
import { useVault } from "@/lib/vault";
import type { WalletDto } from "@nebula/shared";

type Item = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; ready?: boolean; match?: string };

const NAV: { group: string; items: Item[] }[] = [
  {
    group: "Operar",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard, ready: true },
      { label: "Lanzar token", href: "/launch/new", icon: Rocket, ready: true, match: "/launch/" },
      { label: "Lanzamientos", href: "/launches", icon: Layers, ready: true, match: "/launches" },
      { label: "Live", href: "/t", icon: Activity, ready: true, match: "/t" },
    ],
  },
  {
    group: "Fondos",
    items: [
      { label: "Wallets", href: "/wallets", icon: Wallet, ready: true },
      { label: "Funder", href: "/funder", icon: Landmark, ready: true },
      { label: "Comisiones", href: "/rewards", icon: Coins, ready: true },
    ],
  },
  {
    group: "Sistema",
    items: [
      { label: "Automatizaciones", href: "/automations", icon: Bot, ready: true },
      { label: "Actividad", href: "/activity", icon: ScrollText, ready: true },
      { label: "Tracker", href: "/tracker", icon: Radar },
      { label: "Ajustes", href: "/settings", icon: Settings, ready: true },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Preferencia guardada; sin preferencia, plegada por debajo de 1280 px
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("nebula.sidebar");
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia local leída tras montar para no romper la hidratación
    setCollapsed(stored ? stored === "1" : window.innerWidth < 1280);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", collapsed ? "68px" : "232px");
  }, [collapsed]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("nebula.sidebar", c ? "0" : "1");
      } catch {}
      return !c;
    });
  };

  return (
    <aside
      aria-label="Navegación principal"
      className="fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-[color-mix(in_oklab,var(--surface-1)_88%,transparent)] backdrop-blur-xl transition-[width] duration-200 ease-[var(--ease)]"
      style={{ width: "var(--sidebar-w)" }}
    >
      <div className="flex h-14 items-center gap-2.5 px-4">
        <span aria-hidden className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent-a to-accent-b shadow-[0_0_18px_var(--glow)]">
          <span className="size-2 rounded-full bg-white/90 shadow-[0_0_8px_white]" />
          <span className="absolute inset-[5px] rounded-full border border-white/40" />
        </span>
        {!collapsed && <span className="font-display text-[22px] leading-none italic">Nébula</span>}
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2.5 pt-2">
        {NAV.map((g) => (
          <div key={g.group} className="mb-4">
            {!collapsed && <p className="telemetry px-2.5 pb-1.5">{g.group}</p>}
            <ul className="space-y-0.5">
              {g.items.map((it) => {
                const active = it.match ? pathname.startsWith(it.match) : pathname === it.href;
                const Icon = it.icon;
                const inner = (
                  <>
                    {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-gradient-to-b from-accent-a to-accent-b" />}
                    <Icon className={`size-4 shrink-0 ${active ? "text-accent-b" : ""}`} />
                    {!collapsed && <span className="flex-1 truncate">{it.label}</span>}
                    {!collapsed && !it.ready && <span className="telemetry text-[9.5px] text-faint/70">pronto</span>}
                  </>
                );
                const cls = `relative flex h-9 items-center gap-3 rounded-[var(--radius-sm)] px-2.5 text-[13.5px] transition-colors duration-150 ${
                  active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
                } ${collapsed ? "justify-center" : ""}`;
                return (
                  <li key={it.label}>
                    {it.ready ? (
                      <Link href={it.href} className={cls} aria-current={active ? "page" : undefined} title={collapsed ? it.label : undefined}>
                        {inner}
                      </Link>
                    ) : (
                      <span className={`${cls} cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted`} aria-disabled="true" title={`${it.label} · llega en un bloque posterior`}>
                        {inner}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line p-2.5">
        {!collapsed && (
          <FunderCard />
        )}
        <button onClick={toggle} className="btn-ghost flex h-9 w-full items-center gap-3 rounded-[var(--radius-sm)] px-2.5 text-[13px]" aria-label={collapsed ? "Expandir barra lateral" : "Plegar barra lateral"}>
          <ChevronsLeft className={`size-4 transition-transform duration-200 ${collapsed ? "rotate-180" : ""} ${collapsed ? "mx-auto" : ""}`} />
          {!collapsed && "Plegar"}
        </button>
      </div>
    </aside>
  );
}

function FunderCard() {
  const unlocked = useVault((s) => s.status?.unlocked);
  const balances = useChain((s) => s.balances);
  const [funder, setFunder] = useState<WalletDto | null>(null);
  useEffect(() => {
    if (!unlocked) return;
    let alive = true;
    const load = () => api<{ wallets: WalletDto[] }>("/wallets").then((r) => alive && setFunder(r.wallets.find((w) => w.isDefaultFunder) ?? null)).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [unlocked]);
  return (
    <Link href="/funder" className="mb-2 block rounded-[var(--radius-md)] border border-line bg-surface-2/60 p-3 transition-colors hover:border-line-strong">
      <p className="telemetry">Funder · predeterminado</p>
      {funder ? (
        <>
          <p className="num mt-1 text-[17px]">{fmtLamports(balances[funder.address], 3)}</p>
          <p className="num text-[11.5px] text-faint">{funder.address.slice(0, 4)}…{funder.address.slice(-4)}</p>
        </>
      ) : (
        <p className="mt-1 text-[12.5px] text-muted">Aún no hay funder</p>
      )}
    </Link>
  );
}
