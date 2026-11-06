"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Lock } from "lucide-react";
import type { VaultStatus } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { useVault } from "@/lib/vault";
import { VaultFrame, Wordmark } from "@/components/vault-frame";
import { RestoreDialog } from "./restore-dialog";

type Phase = "idle" | "deriving" | "error" | "done";

export function UnlockScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next")?.startsWith("/") && !params.get("next")?.startsWith("//") ? params.get("next")! : "/wallets";
  const refresh = useVault((s) => s.refresh);
  const setStatus = useVault((s) => s.set);
  const apiError = useVault((s) => s.error);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [wait, setWait] = useState(0);
  const [caps, setCaps] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refresh().then((s) => {
      if (!s) return;
      if (!s.initialized) router.replace("/setup");
      else if (s.unlocked) router.replace(next);
      else if (s.retryInSec > 0) setWait(s.retryInSec);
    });
    router.prefetch(next);
  }, [refresh, router, next]);

  useEffect(() => {
    if (wait <= 0) {
      inputRef.current?.focus();
      return;
    }
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const locked = wait > 0;
  const canSubmit = password.length > 0 && !locked && phase !== "deriving" && phase !== "done";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setPhase("deriving");
    try {
      const s = await api<VaultStatus>("/vault/unlock", { method: "POST", body: { password } });
      setPassword("");
      setStatus(s);
      setPhase("done");
      setTimeout(() => router.push(next), 650);
    } catch (err) {
      const e = err as ApiError;
      setPhase("error");
      setPassword("");
      setMessage(e.code === "BAD_PASSWORD" ? "Contraseña incorrecta." : e.code === "RETRY_LATER" ? "Demasiados intentos." : e.message);
      setWait(e.retryInSec ?? 0);
    }
  }

  return (
    <VaultFrame warp={phase === "done"} leaving={phase === "done"}>
      <p className="telemetry rise mb-5 flex items-center gap-2" style={{ animationDelay: "60ms" }}>
        <Lock className="size-3" aria-hidden /> Bóveda cifrada · AES-256-GCM · Argon2id
      </p>
      <Wordmark sub="Tu terminal de lanzamientos. Local, privada y solo tuya." />

      <form onSubmit={submit} className="rise reticle glass mt-10 w-full rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]" style={{ animationDelay: "260ms" }}>
        <label htmlFor="master" className="mb-2 flex items-center justify-between text-[13px] font-medium">
          Contraseña maestra
          <span className="telemetry">requerida</span>
        </label>
        <div className={`relative ${phase === "error" ? "animate-[shake_380ms_var(--ease)]" : ""}`} key={message + wait}>
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
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"} className="btn-ghost absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-fg">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        <div id="unlock-status" aria-live="polite" className="mt-2 min-h-5 text-[12.5px]">
          {phase === "error" && (
            <span className="text-sell">
              {message}
              {locked ? ` Próximo intento en ${wait} s.` : " Puedes intentarlo de nuevo."}
            </span>
          )}
          {phase !== "error" && locked && <span className="text-muted">Próximo intento en {wait} s.</span>}
          {phase === "deriving" && <span className="text-muted">Derivando la clave con Argon2id…</span>}
          {phase === "done" && <span className="text-buy">Bóveda abierta.</span>}
          {phase === "idle" && !locked && caps && <span className="text-warn">Bloq Mayús está activado.</span>}
          {phase === "idle" && !locked && !caps && apiError && <span className="text-warn">{apiError.message}</span>}
        </div>

        <div className="mt-2 h-px w-full overflow-hidden rounded bg-line">
          <div className="h-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-[900ms] ease-[var(--ease)]" style={{ width: phase === "deriving" ? "82%" : phase === "done" ? "100%" : "0%" }} />
        </div>

        <button type="submit" disabled={!canSubmit} className="cta cta-fill mt-5 flex h-12 w-full items-center justify-center gap-2 text-[14px] font-semibold">
          {phase === "deriving" ? "Desbloqueando…" : "Desbloquear"}
          {phase !== "deriving" && <ArrowRight className="size-4" aria-hidden />}
        </button>

        <div className="mt-4 flex items-center justify-between text-[12.5px]">
          <button type="button" onClick={() => setRestoring(true)} className="text-muted underline-offset-4 hover:text-fg hover:underline">
            Restaurar copia de seguridad
          </button>
          <span className="flex items-center gap-1.5 text-faint">
            <span className="kbd">↵</span> para entrar
          </span>
        </div>
      </form>

      <p className="rise mt-6 max-w-sm text-center text-[12.5px] leading-relaxed text-faint" style={{ animationDelay: "340ms" }}>
        Cada intento fallido alarga la espera, también si reinicias la app.
      </p>
      {restoring && <RestoreDialog onClose={() => setRestoring(false)} onDone={() => router.push(next)} />}
    </VaultFrame>
  );
}
