"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Lock, Moon, Search, Sun, TriangleAlert } from "lucide-react";
import { useLive } from "@/lib/live";
import { toast } from "@/lib/toast";
import { forceHeartbeat, useVault } from "@/lib/vault";
import { useChain, useChainStatusPolling } from "@/lib/chain";
import { storedTheme, useTheme } from "@/lib/theme";

function titleFor(path: string) {
  if (path.startsWith("/t/")) return ["Live", "Workspace"];
  if (path === "/t") return ["Live", "Abrir token"];
  if (path.startsWith("/launch/")) return ["Lanzar", "Nuevo lanzamiento"];
  if (path.startsWith("/wallets")) return ["Fondos", "Wallets"];
  if (path.startsWith("/funder")) return ["Fondos", "Funder"];
  if (path.startsWith("/rewards")) return ["Fondos", "Comisiones"];
  if (path.startsWith("/settings")) return ["Sistema", "Ajustes"];
  if (path.startsWith("/activity")) return ["Sistema", "Actividad"];
  if (path.startsWith("/automations")) return ["Sistema", "Automatizaciones"];
  if (path.startsWith("/launches/drafts")) return ["Operar", "Borradores"];
  if (path.startsWith("/launches")) return ["Operar", "Lanzamientos"];
  if (path === "/") return ["Operar", "Dashboard"];
  return ["Nébula", ""];
}

export function Topbar() {
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  const status = useVault((s) => s.status);
  const readAt = useVault((s) => s.readAt);
  const vaultLock = useVault((s) => s.lock);
  const [now, setNow] = useState(() => Date.now());

  const lock = useCallback(async () => {
    try {
      await vaultLock();
      toast({ tone: "info", title: "Bóveda bloqueada", body: "Las claves se han borrado de la memoria. Las tareas en curso quedan en pausa." });
    } catch {}
    router.push("/unlock");
  }, [router, vaultLock]);

  // Cuenta atrás local entre lecturas del estado; el bloqueo real lo decide el servidor (REQ-VAULT-003)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = status?.lockInSec != null ? Math.max(0, status.lockInSec - Math.floor((now - readAt) / 1000)) : 0;

  // Ctrl+Shift+L bloquea
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toast({ tone: "info", title: "Paleta de comandos", body: "Llega más adelante (REQ-CMDK-001)." });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lock]);

  // Lee el tema guardado al montar y lo aplica (sin escribir: un montaje nunca pisa la preferencia).
  useEffect(() => {
    setTheme(storedTheme(), false);
  }, [setTheme]);

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  const [section, page] = titleFor(pathname);
  const live = pathname.startsWith("/t/");
  const mm = String(Math.max(0, Math.floor(left / 60))).padStart(2, "0");
  const ss = String(Math.max(0, left % 60)).padStart(2, "0");
  // Sin bloqueo automático (0 = nunca) no hay cuenta atrás: el botón solo bloquea a mano.
  const autoLock = status?.lockInSec != null;
  const warn = autoLock && left <= 60;

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-[color-mix(in_oklab,var(--bg)_78%,transparent)] px-5 backdrop-blur-xl">
        <div className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
          <span className="text-muted">{section}</span>
          {page && <span className="text-faint">/</span>}
          <span className="truncate font-medium">{page}</span>
        </div>

        <button
          onClick={() => toast({ tone: "info", title: "Paleta de comandos", body: "Llega en F1 (REQ-CMDK-001)." })}
          className="mx-auto flex h-9 w-full max-w-[420px] items-center gap-2.5 rounded-[var(--radius-sm)] border border-line bg-surface-1/70 px-3 text-[13px] text-faint transition-colors hover:border-line-strong hover:text-muted"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Buscar tokens, wallets o acciones</span>
          <span className="kbd">Ctrl</span>
          <span className="kbd">K</span>
        </button>

        <div className="flex items-center gap-2">
          <RpcChip />
          {live && <SolPriceChip />}
          <button
            onClick={toggleTheme}
            className="btn btn-ghost size-9 p-0"
            aria-label={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={lock} className="btn h-9 gap-2 pr-2.5 pl-3" title="Bloquear ahora (Ctrl+Shift+L)">
            <Lock className="size-3.5" aria-hidden />
            {autoLock ? (
              <>
                <span className={`num text-[12px] ${warn ? "text-warn" : "text-muted"}`}>
                  {mm}:{ss}
                </span>
                <span className="sr-only">para el bloqueo automático. Bloquear ahora.</span>
              </>
            ) : (
              <span className="text-[12px] text-muted">
                Bloquear<span className="sr-only"> ahora</span>
              </span>
            )}
          </button>
        </div>
      </header>

      {autoLock && warn && left > 0 && (
        <div role="alert" className="rise fixed top-16 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-[var(--radius-md)] border border-warn/30 bg-[color-mix(in_oklab,var(--surface-1)_92%,transparent)] px-4 py-2.5 text-[13px] shadow-[var(--shadow-float)] backdrop-blur-xl">
          <TriangleAlert className="size-4 text-warn" aria-hidden />
          La bóveda se bloquea en <span className="num text-warn">{left} s</span> por inactividad.
          <button className="btn h-8 px-3" onClick={forceHeartbeat}>
            Posponer
          </button>
        </div>
      )}
    </>
  );
}

function RpcChip() {
  useChainStatusPolling();
  const st = useChain((s) => s.status);
  if (!st) return <span className="chip"><span className="size-2 rounded-full bg-faint" aria-hidden />RPC…</span>;
  if (st.mode === "off")
    return (
      <span className="chip border-warn/30 text-warn" title={st.error ?? "Sin RPC"}>
        <span className="size-2 rounded-full bg-warn" aria-hidden />
        RPC sin configurar
      </span>
    );
  return (
    <span className={`chip num ${st.healthy ? "" : "border-sell/30 text-sell"}`} title={`${st.host ?? ""}${st.usingBackup ? " · respaldo" : ""}${st.mode === "mock" ? " · simulado" : ""}`}>
      <span className="relative flex size-2" aria-hidden>
        {st.healthy && <span className="absolute inset-0 animate-ping rounded-full bg-buy opacity-40" />}
        <span className={`relative size-2 rounded-full ${st.healthy ? "bg-buy" : "bg-sell"}`} />
      </span>
      {st.healthy ? `RPC ${st.latencyMs ?? "—"} ms` : "RPC caído"}
      {st.usingBackup && <span className="text-warn">· respaldo</span>}
    </span>
  );
}

/** Precio SOL/USD del oráculo (Pyth) que usa el Live Workspace; sin precio, todo se muestra en SOL. */
function SolPriceChip() {
  const p = useLive((s) => s.solUsd);
  if (!p) return null;
  return (
    <span className="chip num" title={`Pyth SOL/USD · publicado ${new Date(p.publishedAt).toLocaleString("es-ES")}`}>
      SOL ${p.usd.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
