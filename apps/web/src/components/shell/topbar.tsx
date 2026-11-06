"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Lock, Moon, Search, Sun, TriangleAlert } from "lucide-react";
import { SOL_USD } from "@/lib/sim";
import { toast } from "@/lib/toast";

const AUTOLOCK_SEC = 15 * 60;

function titleFor(path: string) {
  if (path.startsWith("/t/")) return ["Live", "Workspace"];
  if (path.startsWith("/launch")) return ["Lanzar", "Nuevo lanzamiento"];
  return ["Nébula", ""];
}

export function Topbar() {
  const router = useRouter();
  const pathname = usePathname();
  const [latency, setLatency] = useState(38);
  const [left, setLeft] = useState(AUTOLOCK_SEC);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const lastActivity = useRef(0);

  const lock = useCallback(() => {
    toast({ tone: "info", title: "Bóveda bloqueada", body: "Las claves se han borrado de la memoria. Las tareas en curso quedan en pausa." });
    router.push("/unlock");
  }, [router]);

  // Latencia simulada del RPC principal
  useEffect(() => {
    const id = setInterval(() => setLatency(Math.round(30 + Math.random() * 22)), 2500);
    return () => clearInterval(id);
  }, []);

  // Bloqueo automático por inactividad (REQ-VAULT-003)
  useEffect(() => {
    lastActivity.current = Date.now();
    const bump = () => (lastActivity.current = Date.now());
    const evs = ["pointerdown", "keydown", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const id = setInterval(() => {
      const remaining = AUTOLOCK_SEC - Math.floor((Date.now() - lastActivity.current) / 1000);
      setLeft(remaining);
      if (remaining <= 0) lock();
    }, 1000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(id);
    };
  }, [lock]);

  // Ctrl+Shift+L bloquea
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        lock();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toast({ tone: "info", title: "Paleta de comandos", body: "Llega en F1 (REQ-CMDK-001)." });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lock]);

  // Lee el tema guardado al montar y lo aplica. Solo se escribe al cambiarlo con el botón,
  // para que un montaje (o el doble montaje de Strict Mode) nunca pise la preferencia.
  useEffect(() => {
    let t: string | null = null;
    try {
      t = localStorage.getItem("nebula.theme");
    } catch {}
    const next = t === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia local leída tras montar para no romper la hidratación
    setTheme(next);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("nebula.theme", next);
    } catch {}
  };

  const [section, page] = titleFor(pathname);
  const mm = String(Math.max(0, Math.floor(left / 60))).padStart(2, "0");
  const ss = String(Math.max(0, left % 60)).padStart(2, "0");
  const warn = left <= 60;

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
          <span className="chip num" title="RPC principal · salud y latencia">
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-buy opacity-40" />
              <span className="relative size-2 rounded-full bg-buy" />
            </span>
            RPC {latency} ms
          </span>
          <span className="chip num" title="Precio de SOL (oráculo simulado)">
            SOL ${SOL_USD.toLocaleString("es-ES", { minimumFractionDigits: 2 })}
          </span>
          <button
            onClick={toggleTheme}
            className="btn btn-ghost size-9 p-0"
            aria-label={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={lock} className="btn h-9 gap-2 pr-2.5 pl-3" title="Bloquear ahora (Ctrl+Shift+L)">
            <Lock className="size-3.5" aria-hidden />
            <span className={`num text-[12px] ${warn ? "text-warn" : "text-muted"}`}>
              {mm}:{ss}
            </span>
            <span className="sr-only">para el bloqueo automático. Bloquear ahora.</span>
          </button>
        </div>
      </header>

      {warn && left > 0 && (
        <div role="alert" className="rise fixed top-16 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-[var(--radius-md)] border border-warn/30 bg-[color-mix(in_oklab,var(--surface-1)_92%,transparent)] px-4 py-2.5 text-[13px] shadow-[var(--shadow-float)] backdrop-blur-xl">
          <TriangleAlert className="size-4 text-warn" aria-hidden />
          La bóveda se bloquea en <span className="num text-warn">{left} s</span> por inactividad.
          <button className="btn h-8 px-3" onClick={() => (lastActivity.current = Date.now())}>
            Posponer
          </button>
        </div>
      )}
    </>
  );
}
