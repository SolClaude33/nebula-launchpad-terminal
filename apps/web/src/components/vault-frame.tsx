"use client";

import { useEffect } from "react";
import { HardDrive, ShieldCheck, TriangleAlert } from "lucide-react";
import { Starfield } from "@/components/starfield";
import { useVault } from "@/lib/vault";

/** Marco de las pantallas de bóveda (/setup, /unlock): siempre en oscuro, con campo de estrellas. */
export function VaultFrame({ children, warp = false, leaving = false }: { children: React.ReactNode; warp?: boolean; leaving?: boolean }) {
  const profile = useVault((s) => s.status?.profile);
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);
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
      <Starfield className="absolute inset-0 h-full w-full" warp={warp} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 40%, rgba(3,4,8,.75) 100%)" }} />

      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <div className="telemetry flex items-center gap-3">
          <span className="inline-block size-1.5 rounded-full bg-accent-b shadow-[0_0_10px_var(--accent-b)]" />
          Nébula · v0.2
        </div>
        <div className="flex items-center gap-2">
          {profile === "mainnet" ? (
            <span className="chip border-sell/30 text-sell">Perfil mainnet · fondos reales</span>
          ) : (
            <span className="chip border-warn/30 bg-[var(--warn-soft)] text-warn">
              <TriangleAlert className="size-3" aria-hidden /> Perfil de pruebas
            </span>
          )}
          <span className="chip num">
            <HardDrive className="size-3" aria-hidden /> 127.0.0.1
          </span>
        </div>
      </header>

      <section className={`relative z-10 mx-auto flex min-h-[calc(100dvh-160px)] max-w-[480px] flex-col items-center justify-center px-6 transition-[opacity,transform,filter] duration-500 ${leaving ? "scale-[1.04] opacity-0 blur-sm" : ""}`}>
        {children}
      </section>

      <footer className="relative z-10 flex items-center justify-between px-8 pb-6 text-[12px] text-faint">
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-3.5 text-buy" aria-hidden /> Las claves nunca salen de este equipo
        </span>
        <span className="num">~/.nebula/{profile ?? "…"}</span>
      </footer>
    </main>
  );
}

export function Wordmark({ sub }: { sub: string }) {
  return (
    <>
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
        {sub}
      </p>
    </>
  );
}

/** Estimación de fortaleza sencilla y local: longitud, variedad y patrones obvios. 0–4. */
export function strength(pw: string) {
  if (!pw) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let score = pw.length >= 20 ? 3 : pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0;
  if (classes >= 3) score++;
  if (/(.)\1{3,}/.test(pw) || /^(?:1234|qwer|abcd|pass|contra)/i.test(pw)) score = Math.max(0, score - 2);
  return Math.min(4, score);
}
export const STRENGTH_LABEL = ["Muy débil", "Débil", "Aceptable", "Fuerte", "Muy fuerte"];
