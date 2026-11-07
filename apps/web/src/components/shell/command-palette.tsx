"use client";

// REQ-CMDK-001: paleta de comandos (Ctrl+K). Busca páginas y acciones, tokens (tracker y lanzamientos propios)
// y wallets. Pegar un mint ofrece abrirlo en Live o seguirlo. Teclado: ↑ ↓ para moverse, Enter, Esc.
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useRouter } from "next/navigation";
import { Activity, Bookmark, Bot, Coins, Copy, LayoutDashboard, Landmark, Lock, Moon, Radar, Rocket, ScrollText, Search, Settings, Star, Wallet } from "lucide-react";
import type { WalletDto } from "@nebula/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useVault } from "@/lib/vault";
import { useTheme } from "@/lib/theme";
import { trackToken, useTracked } from "@/lib/tracker";

export const useCommandPalette = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

type Item = { id: string; group: "Ir a" | "Tokens" | "Wallets"; label: string; hint?: string; keywords?: string; icon: React.ComponentType<{ className?: string }>; run: () => void | Promise<void> };

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open);
  // Se monta solo al abrir: empieza vacía cada vez y el campo tiene el foco desde el primer fotograma
  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const setOpen = useCommandPalette((s) => s.setOpen);
  const router = useRouter();
  const lock = useVault((s) => s.lock);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  const tracked = useTracked((s) => s.items);
  const refreshTracked = useTracked((s) => s.refresh);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [wallets, setWallets] = useState<WalletDto[]>([]);
  const [launches, setLaunches] = useState<{ mint: string; symbol: string; name: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Datos al abrir (lecturas locales, sin cadena)
  useEffect(() => {
    void refreshTracked();
    api<{ wallets: WalletDto[] }>("/wallets").then((r) => setWallets(r.wallets.filter((w) => !w.archived)), () => {});
    api<{ items: { mint: string; symbol: string; name: string }[] }>("/launches").then((r) => setLaunches(r.items.filter((x) => x.mint)), () => {});
  }, [refreshTracked]);

  const close = () => setOpen(false);
  const go = (href: string) => () => {
    close();
    router.push(href);
  };

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = [
      { id: "p-dash", group: "Ir a", label: "Dashboard", icon: LayoutDashboard, run: go("/") },
      { id: "p-new", group: "Ir a", label: "Lanzar token", keywords: "nuevo lanzamiento asistente", icon: Rocket, run: go("/launch/new?new=1") },
      { id: "p-launches", group: "Ir a", label: "Lanzamientos", icon: Rocket, run: go("/launches") },
      { id: "p-drafts", group: "Ir a", label: "Borradores", icon: Bookmark, run: go("/launches/drafts") },
      { id: "p-live", group: "Ir a", label: "Live", keywords: "trading grafico", icon: Activity, run: go("/t") },
      { id: "p-wallets", group: "Ir a", label: "Wallets", icon: Wallet, run: go("/wallets") },
      { id: "p-funder", group: "Ir a", label: "Funder", icon: Landmark, run: go("/funder") },
      { id: "p-rewards", group: "Ir a", label: "Comisiones", keywords: "rewards reclamar fees", icon: Coins, run: go("/rewards") },
      { id: "p-auto", group: "Ir a", label: "Automatizaciones", keywords: "dca limite trailing ladder", icon: Bot, run: go("/automations") },
      { id: "p-activity", group: "Ir a", label: "Actividad", keywords: "registro logs", icon: ScrollText, run: go("/activity") },
      { id: "p-tracker", group: "Ir a", label: "Tracker", keywords: "seguimiento watchlist", icon: Radar, run: go("/tracker") },
      { id: "p-settings", group: "Ir a", label: "Ajustes", keywords: "rpc helius pinata slippage", icon: Settings, run: go("/settings") },
      {
        id: "a-lock",
        group: "Ir a",
        label: "Bloquear la bóveda",
        hint: "Ctrl+Shift+L",
        icon: Lock,
        run: async () => {
          close();
          await lock().catch(() => {});
          router.push("/unlock");
        },
      },
      { id: "a-theme", group: "Ir a", label: theme === "dark" ? "Tema claro" : "Tema oscuro", keywords: "tema apariencia", icon: Moon, run: () => (close(), setTheme(theme === "dark" ? "light" : "dark")) },
    ];
    const seen = new Set<string>();
    const tokens: Item[] = [];
    for (const t of [...(tracked ?? []).map((x) => ({ mint: x.mint, symbol: x.symbol, name: x.name, tracked: true })), ...launches.map((l) => ({ mint: l.mint, symbol: l.symbol, name: l.name, tracked: false }))]) {
      if (seen.has(t.mint)) continue;
      seen.add(t.mint);
      tokens.push({ id: `t-${t.mint}`, group: "Tokens", label: `${t.symbol ? `$${t.symbol}` : t.mint.slice(0, 6)} ${t.name ?? ""}`.trim(), hint: t.tracked ? "seguido" : "lanzado con Nébula", keywords: t.mint, icon: t.tracked ? Star : Rocket, run: go(`/t/${t.mint}`) });
    }
    const ws: Item[] = wallets.map((w) => ({
      id: `w-${w.id}`,
      group: "Wallets",
      label: w.label,
      hint: `${w.kind === "funder" ? "funder" : (w.role ?? "wallet")} · copiar dirección`,
      keywords: `${w.address} ${w.role ?? ""}`,
      icon: w.kind === "funder" ? Landmark : Copy,
      run: async () => {
        close();
        try {
          await navigator.clipboard.writeText(w.address);
          toast({ tone: "info", title: `Dirección de ${w.label} copiada`, body: w.address });
        } catch {
          toast({ tone: "warn", title: "No se pudo copiar", body: w.address });
        }
      },
    }));
    return [...pages, ...tokens, ...ws];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go/close son estables en la práctica (router y setOpen)
  }, [tracked, launches, wallets, theme]);

  const query = q.trim();
  const results = useMemo(() => {
    const n = norm(query);
    const out: Item[] = [];
    if (MINT_RE.test(query)) {
      out.push({ id: "m-open", group: "Tokens", label: `Abrir ${query.slice(0, 6)}…${query.slice(-4)} en Live`, icon: Activity, run: go(`/t/${query}`) });
      if (!tracked?.some((t) => t.mint === query)) out.push({ id: "m-track", group: "Tokens", label: `Seguir ${query.slice(0, 6)}…${query.slice(-4)} en el tracker`, icon: Star, run: async () => (close(), void (await trackToken(query))) });
    }
    const groups: Item["group"][] = ["Ir a", "Tokens", "Wallets"];
    for (const g of groups) {
      const hits = items.filter((it) => it.group === g && (!n || norm(`${it.label} ${it.keywords ?? ""} ${it.hint ?? ""}`).includes(n)));
      out.push(...hits.slice(0, n ? 8 : g === "Ir a" ? 14 : 5));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go/close estables
  }, [items, query, tracked]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- al cambiar la búsqueda, se vuelve al primero
    setActive(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void results[active]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  let lastGroup = "";
  return (
    <div role="dialog" aria-modal="true" aria-label="Paleta de comandos" className="fixed inset-0 z-[96] flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="glass rise w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[var(--radius-lg)] shadow-[var(--shadow-float)]">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-muted" aria-hidden />
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
            aria-label="Buscar tokens, wallets o acciones"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Busca o pega un mint…"
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
          />
          <span className="kbd">Esc</span>
        </div>
        <ul ref={list} id="cmdk-list" role="listbox" aria-label="Resultados" className="scroll-thin max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[12.5px] text-faint">Sin resultados.</li>}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <li key={it.id} role="presentation">
                {header && <p className="telemetry px-2.5 pt-2 pb-1">{header}</p>}
                <div
                  id={`cmdk-${it.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => void it.run()}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[13px] ${i === active ? "bg-surface-3 text-fg" : "text-muted"}`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 text-[11px] text-faint">{it.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
