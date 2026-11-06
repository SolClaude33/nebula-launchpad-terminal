"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, KeyRound, TriangleAlert } from "lucide-react";
import { MIN_PASSWORD, type VaultStatus } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { useVault } from "@/lib/vault";
import { strength, STRENGTH_LABEL, VaultFrame, Wordmark } from "@/components/vault-frame";

const BAR = ["var(--sell)", "var(--sell)", "var(--warn)", "var(--buy)", "var(--buy)"];

/** WebSocket del RPC: en un validador local (Surfpool, solana-test-validator) va en el puerto siguiente; en un proveedor, misma URL con ws(s). */
function wsFor(http: string) {
  try {
    const u = new URL(http);
    if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.port) u.port = String(Number(u.port) + 1);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString().replace(/\/$/, "");
  } catch {
    return http.replace(/^http/, "ws");
  }
}

/** REQ-VAULT-001 + REQ-SET-001: primer arranque. Contraseña maestra irrecuperable, RPC y clave de IPFS. */
export function SetupScreen() {
  const router = useRouter();
  const refresh = useVault((s) => s.refresh);
  const setStatus = useVault((s) => s.set);
  const apiError = useVault((s) => s.error);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [ack, setAck] = useState(false);
  const [rpc, setRpc] = useState("");
  const [ipfs, setIpfs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    refresh().then((s) => {
      if (s?.initialized) router.replace(s.unlocked ? "/" : "/unlock");
    });
  }, [refresh, router]);

  const score = strength(pw);
  const tooShort = pw.length > 0 && pw.length < MIN_PASSWORD;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const rpcInvalid = rpc !== "" && !/^https?:\/\/\S+$/.test(rpc);
  const reasons = [
    pw.length < MIN_PASSWORD && `Mínimo ${MIN_PASSWORD} caracteres`,
    pw !== pw2 && "Las contraseñas no coinciden",
    !ack && "Marca «Entiendo»",
    rpcInvalid && "La URL del RPC no es válida",
  ].filter(Boolean) as string[];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reasons.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await api<VaultStatus>("/vault/setup", { method: "POST", body: { password: pw, ack: true } });
      if (rpc || ipfs) await api("/settings", { method: "PUT", body: { ...(rpc ? { rpcPrimaryHttp: rpc, rpcPrimaryWs: wsFor(rpc) } : {}), ...(ipfs ? { ipfsKey: ipfs } : {}) } });
      setPw("");
      setPw2("");
      setIpfs("");
      setStatus(s);
      setDone(true);
      setTimeout(() => router.push("/"), 650);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <VaultFrame warp={done} leaving={done}>
      <p className="telemetry rise mb-5 flex items-center gap-2" style={{ animationDelay: "60ms" }}>
        <KeyRound className="size-3" aria-hidden /> Primer arranque · crea tu bóveda
      </p>
      <Wordmark sub="Una contraseña maestra cifra todas tus claves en este equipo." />

      <form onSubmit={submit} className="rise reticle glass mt-8 w-full space-y-4 rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]" style={{ animationDelay: "260ms" }}>
        <div>
          <label htmlFor="pw" className="mb-1.5 block text-[13px] font-medium">
            Contraseña maestra
          </label>
          <div className="relative">
            <input id="pw" type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={tooShort} aria-describedby="pw-meter" className="field num h-11 pr-11" />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"} className="btn-ghost absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-md">
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <div id="pw-meter" className="mt-2" aria-live="polite">
            <div className="flex gap-1" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-1 flex-1 rounded-full transition-colors duration-200" style={{ background: pw && i < Math.max(1, score) ? BAR[score] : "var(--surface-3)" }} />
              ))}
            </div>
            <p className="mt-1.5 flex justify-between text-[12px]">
              <span className={tooShort ? "text-sell" : "text-faint"}>{tooShort ? `Faltan ${MIN_PASSWORD - pw.length} caracteres` : `Mínimo ${MIN_PASSWORD} caracteres · mejor una frase larga`}</span>
              {pw && <span style={{ color: BAR[score] }}>{STRENGTH_LABEL[score]}</span>}
            </p>
          </div>
        </div>
        <div>
          <label htmlFor="pw2" className="mb-1.5 block text-[13px] font-medium">
            Repite la contraseña
          </label>
          <input id="pw2" type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} className="field num h-11" />
          {mismatch && <p className="mt-1.5 text-[12px] text-sell">No coincide.</p>}
        </div>

        <details className="rounded-[var(--radius-sm)] border border-line bg-surface-1/60 p-3 text-[13px]">
          <summary className="cursor-pointer font-medium">RPC y clave de IPFS <span className="font-normal text-faint">opcional, se puede cambiar en Ajustes</span></summary>
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="rpc" className="mb-1.5 block text-[12.5px] text-muted">
                RPC principal (HTTP)
              </label>
              <input id="rpc" value={rpc} onChange={(e) => setRpc(e.target.value.trim())} placeholder="http://127.0.0.1:8899 (validador local)" aria-invalid={rpcInvalid} className="field num h-9" />
            </div>
            <div>
              <label htmlFor="ipfs" className="mb-1.5 block text-[12.5px] text-muted">
                Clave de IPFS (Pinata)
              </label>
              <input id="ipfs" type="password" autoComplete="off" value={ipfs} onChange={(e) => setIpfs(e.target.value)} className="field num h-9" />
              <p className="mt-1 text-[11.5px] text-faint">Se guarda cifrada dentro de la bóveda, nunca en .env.</p>
            </div>
          </div>
        </details>

        <label className={`flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border p-3 text-[12.5px] leading-relaxed ${ack ? "border-line bg-surface-1/60" : "border-warn/35 bg-[var(--warn-soft)]"}`}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--warn)]" />
          <span>
            <TriangleAlert className="mr-1 inline size-3.5 -translate-y-px text-warn" aria-hidden />
            <strong>Entiendo</strong> que la contraseña <strong>no se puede recuperar</strong>. Si la olvido, pierdo el acceso a las claves. La guardaré en un gestor de contraseñas y haré copias de la bóveda.
          </span>
        </label>

        <p aria-live="polite" className="min-h-4 text-[12.5px] text-sell">
          {error || (apiError && !busy ? apiError.message : "")}
        </p>
        <button type="submit" disabled={reasons.length > 0 || busy} aria-describedby="setup-why" className="cta cta-fill flex h-12 w-full items-center justify-center gap-2 text-[14px] font-semibold">
          {busy ? "Derivando la clave…" : "Crear bóveda"}
          {!busy && <ArrowRight className="size-4" aria-hidden />}
        </button>
        <p id="setup-why" className="text-center text-[11.5px] text-faint">
          {reasons.length ? reasons.join(" · ") : "Argon2id (64 MiB, 3 iteraciones) + AES-256-GCM"}
        </p>
      </form>
    </VaultFrame>
  );
}
