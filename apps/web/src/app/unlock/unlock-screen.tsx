"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, HardDrive, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import { Starfield } from "@/components/starfield";
import { DEMO_ROUTE, LOCAL_ORIGIN } from "@/lib/demo";

type Phase = "idle" | "deriving" | "error" | "done";

const DELAYS = [0, 2, 4, 8, 16, 30]; // segundos de espera tras cada fallo

export function UnlockScreen() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fails, setFails] = useState(0);
  const [wait, setWait] = useState(0);
  const [caps, setCaps] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    router.prefetch(DEMO_ROUTE);
    inputRef.current?.focus();
  }, [router]);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const locked = wait > 0;
  const canSubmit = password.length > 0 && !locked && phase !== "deriving" && phase !== "done";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setPhase("deriving");
    // Simula la derivación Argon2id (64 MB · 3 iteraciones) en el backend local.
    setTimeout(() => {
      if (password.trim().toLowerCase() === "incorrecta" || password.length < 12) {
        const n = fails + 1;
        setFails(n);
        setWait(DELAYS[Math.min(n, DELAYS.length - 1)]);
        setPhase("error");
        setPassword("");
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      setPhase("done");
      setTimeout(() => router.push(DEMO_ROUTE), 650);
    }, 900);
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-bg">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 520px at 50% 40%, color-mix(in oklab, var(--accent-a) 14%, transparent), transparent 70%), radial-gradient(700px 400px at 70% 80%, color-mix(in oklab, var(--accent-b) 8%, transparent), transparent 70%)",
        }}
      />
      <Starfield className="absolute inset-0 h-full w-full" warp={phase === "done"} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 40%, rgba(3,4,8,.75) 100%)" }} />

      {/* Barra superior */}
      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <div className="telemetry flex items-center gap-3">
          <span className="inline-block size-1.5 rounded-full bg-accent-b shadow-[0_0_10px_var(--accent-b)]" />
          Nébula · v0.1 · prototipo F0
        </div>
        <div className="flex items-center gap-2">
          <span className="chip border-warn/30 bg-[var(--warn-soft)] text-warn">
            <TriangleAlert className="size-3" aria-hidden /> Perfil de pruebas
          </span>
          <span className="chip num">
            <HardDrive className="size-3" aria-hidden /> {LOCAL_ORIGIN}
          </span>
        </div>
      </header>

      <section
        className={`relative z-10 mx-auto flex min-h-[calc(100dvh-160px)] max-w-[480px] flex-col items-center justify-center px-6 transition-[opacity,transform,filter] duration-500 ${
          phase === "done" ? "scale-[1.04] opacity-0 blur-sm" : ""
        }`}
      >
        <p className="telemetry rise mb-5 flex items-center gap-2" style={{ animationDelay: "60ms" }}>
          <Lock className="size-3" aria-hidden /> Bóveda cifrada · AES-256-GCM
        </p>
        <h1
          className="rise font-display text-[88px] leading-[0.9] tracking-[-0.02em] italic"
          style={{
            animationDelay: "120ms",
            background: "linear-gradient(180deg, var(--text) 30%, color-mix(in oklab, var(--accent) 70%, var(--text)) 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Nébula
        </h1>
        <p className="rise mt-4 text-center text-[15px] text-muted" style={{ animationDelay: "180ms" }}>
          Tu terminal de lanzamientos. Local, privada y solo tuya.
        </p>

        <form
          onSubmit={submit}
          className="rise reticle glass mt-10 w-full rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]"
          style={{ animationDelay: "260ms" }}
        >
          <label htmlFor="master" className="mb-2 flex items-center justify-between text-[13px] font-medium">
            Contraseña maestra
            <span className="telemetry">{fails > 0 ? `intentos fallidos · ${fails}` : "requerida"}</span>
          </label>
          <div className={`relative ${phase === "error" ? "animate-[shake_380ms_var(--ease)]" : ""}`} key={fails}>
            <input
              ref={inputRef}
              id="master"
              name="master"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              spellCheck={false}
              value={password}
              disabled={locked || phase === "deriving" || phase === "done"}
              aria-invalid={phase === "error"}
              aria-describedby="unlock-status"
              onChange={(e) => {
                setPassword(e.target.value);
                if (phase === "error") setPhase("idle");
              }}
              onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
              placeholder="••••••••••••"
              className="field num h-12 pr-11 text-base tracking-wide"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
              className="btn-ghost absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-fg"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          <div id="unlock-status" aria-live="polite" className="mt-2 min-h-5 text-[12.5px]">
            {phase === "error" && (
              <span className="text-sell">
                Contraseña incorrecta.{locked ? ` Próximo intento en ${wait} s.` : " Puedes intentarlo de nuevo."}
              </span>
            )}
            {phase !== "error" && locked && <span className="text-muted">Próximo intento en {wait} s.</span>}
            {phase === "deriving" && <span className="text-muted">Derivando clave con Argon2id…</span>}
            {phase === "done" && <span className="text-buy">Bóveda abierta. Cargando el workspace…</span>}
            {phase === "idle" && !locked && caps && <span className="text-warn">Bloq Mayús está activado.</span>}
          </div>

          <div className="mt-2 h-px w-full overflow-hidden rounded bg-line">
            <div
              className="h-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-[900ms] ease-[var(--ease)]"
              style={{ width: phase === "deriving" ? "82%" : phase === "done" ? "100%" : "0%" }}
            />
          </div>

          <button type="submit" disabled={!canSubmit} className="cta cta-fill mt-5 flex h-12 w-full items-center justify-center gap-2 text-[14px] font-semibold">
            {phase === "deriving" ? "Desbloqueando…" : "Desbloquear"}
            {phase !== "deriving" && <ArrowRight className="size-4" aria-hidden />}
          </button>

          <div className="mt-4 flex items-center justify-between text-[12.5px]">
            <button type="button" className="text-muted underline-offset-4 hover:text-fg hover:underline">
              Restaurar copia de seguridad
            </button>
            <span className="flex items-center gap-1.5 text-faint">
              <span className="kbd">↵</span> para entrar
            </span>
          </div>
        </form>

        <p className="rise mt-6 max-w-sm text-center text-[12.5px] leading-relaxed text-faint" style={{ animationDelay: "340ms" }}>
          Prototipo: cualquier contraseña de 12 caracteres o más abre la bóveda. Escribe <span className="num text-muted">incorrecta</span> para ver el retardo creciente.
        </p>
      </section>

      <footer className="relative z-10 flex items-center justify-between px-8 pb-6 text-[12px] text-faint">
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-3.5 text-buy" aria-hidden /> Las claves nunca salen de este equipo · bloqueo automático a los 15 min
        </span>
        <span className="num">vault · 3f9a…c21e · 24 wallets</span>
      </footer>
    </main>
  );
}
