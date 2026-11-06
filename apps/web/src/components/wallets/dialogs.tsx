"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { ApiError, confirmAction } from "@/lib/api";

export function Modal({ title, children, onClose, labelId, width = 440 }: { title: React.ReactNode; children: React.ReactNode; onClose: () => void; labelId: string; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={labelId} className="fixed inset-0 z-[95] grid place-items-center bg-black/55 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass rise max-h-[86vh] overflow-y-auto rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]" style={{ width }}>
        <h3 id={labelId} className="text-[16px] font-semibold">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

/** REQ-VAULT-004: pide la contraseña y devuelve un token de un solo uso para la acción. */
export function StepUpDialog({ action, title, body, danger, onToken, onClose }: { action: string; title: string; body: string; danger?: boolean; onToken: (t: string) => Promise<void> | void; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setError("");
    try {
      const token = await confirmAction(pw, action);
      setPw("");
      await onToken(token);
    } catch (err) {
      setError((err as ApiError).code === "BAD_PASSWORD" ? "Contraseña incorrecta." : (err as ApiError).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={<span className="flex items-center gap-2">{danger ? <ShieldAlert className="size-4 text-sell" aria-hidden /> : <KeyRound className="size-4 text-accent" aria-hidden />}{title}</span>} labelId="stepup-title" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="mt-1 text-[13px] text-muted">{body}</p>
        <label htmlFor="stepup-pw" className="mt-4 mb-1.5 block text-[13px] font-medium">
          Reconfirma la contraseña maestra
        </label>
        <div className="relative">
          <input id="stepup-pw" autoFocus type={show ? "text" : "password"} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!error} className="field num h-10 pr-10" />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Ocultar" : "Mostrar"} className="btn-ghost absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-md">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <p aria-live="polite" className="mt-2 min-h-5 text-[12.5px] text-sell">
          {error}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn h-9">
            Cancelar
          </button>
          <button type="submit" disabled={!pw || busy} className={`h-9 rounded-[var(--radius-md)] px-4 text-[13px] font-semibold disabled:opacity-50 ${danger ? "bg-sell text-white hover:brightness-110" : "cta cta-fill"}`}>
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            Confirmar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** REQ-WAL-006: las claves se muestran con temporizador y se olvidan al cerrar. */
export function RevealDialog({ keys, onClose }: { keys: { label: string; address: string; secretKey: string }[]; onClose: () => void }) {
  const [left, setLeft] = useState(45);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (left <= 0) return onClose();
    const id = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(id);
  }, [left, onClose]);
  const copy = async (k: string, id: string) => {
    try {
      await navigator.clipboard.writeText(k);
      setCopied(id);
      setTimeout(() => setCopied(null), 1200);
    } catch {}
  };
  return (
    <Modal title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-warn" aria-hidden /> Claves privadas</span>} labelId="reveal-title" onClose={onClose} width={620}>
      <p className="mt-1 text-[13px] text-muted">
        Quien tenga estas claves controla los fondos. Se ocultan en <span className="num text-warn">{left} s</span>. La exportación ha quedado en el registro de actividad.
      </p>
      <div className="mt-3 flex justify-end">
        <button onClick={() => setVisible((v) => !v)} className="btn h-8">
          {visible ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          {visible ? "Ocultar" : "Mostrar claves"}
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {keys.map((k) => (
          <li key={k.address} className="rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-3">
            <div className="flex items-center justify-between text-[12.5px]">
              <span className="font-medium">{k.label}</span>
              <span className="num text-faint">{k.address.slice(0, 6)}…{k.address.slice(-6)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className={`num min-w-0 flex-1 rounded bg-bg/60 px-2 py-1.5 text-[11.5px] break-all ${visible ? "" : "blur-sm select-none"}`}>{k.secretKey}</code>
              <button onClick={() => copy(k.secretKey, k.address)} className="btn h-8 px-2.5" aria-label={`Copiar clave de ${k.label}`}>
                {copied === k.address ? <Check className="size-3.5 text-buy" /> : <Copy className="size-3.5" />}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <button onClick={onClose} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
          Cerrar y olvidar
        </button>
      </div>
    </Modal>
  );
}
