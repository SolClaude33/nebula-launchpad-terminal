"use client";

// /settings (REQ-SET-001/002, §8.2): conexión, IPFS, trading, seguridad, copia de seguridad y diagnóstico.
// Los secretos (claves de RPC y de Pinata) se escriben aquí y se guardan cifrados en la bóveda: el servidor
// nunca los devuelve, solo dice si están configurados. Una URL de RPC pegada con su clave se parte sola.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Lock, Moon, Plug, Save, ShieldCheck, Sun, TriangleAlert, XCircle } from "lucide-react";
import { JITO_DEFAULT_ENDPOINT, JITO_MIN_TIP_SOL, MIN_PASSWORD, RPC_KEY_PLACEHOLDER, RPC_PRESETS, type SettingsDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { useChain } from "@/lib/chain";
import { useTheme } from "@/lib/theme";
import { useVault } from "@/lib/vault";
import { toast } from "@/lib/toast";
import { StepUpDialog } from "@/components/wallets/dialogs";
import { BackupsPanel } from "./backups-panel";
import { AltPanel } from "./alt-panel";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";

type Patch = Partial<Omit<SettingsDto, "ipfsKeySet" | "rpcKeySet" | "rpcBackupKeySet">> & { ipfsKey?: string; rpcKey?: string; rpcBackupKey?: string };

const numOf = (s: string) => Number(String(s).replace(",", "."));

export function SettingsView() {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profile = useVault((v) => v.status?.profile);

  const load = useCallback(() => {
    api<SettingsDto>("/settings").then(
      (r) => (setS(r), setError(null)),
      (e) => setError((e as ApiError).message),
    );
  }, []);
  useEffect(load, [load]);

  const save = useCallback(async (patch: Patch, what: string) => {
    try {
      const r = await api<SettingsDto>("/settings", { method: "PUT", body: patch });
      setS(r);
      toast({ tone: "buy", title: `${what} guardado`, body: "Queda registrado en la actividad local." });
      return true;
    } catch (e) {
      toast({ tone: "error", title: `No se pudo guardar: ${what}`, body: (e as ApiError).message });
      return false;
    }
  }, []);

  return (
    <div className="mx-auto max-w-[980px] p-6 pb-20">
      <p className="telemetry">Sistema</p>
      <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Ajustes</h1>
      <p className="mt-1 max-w-[640px] text-[13px] text-muted">
        Todo se guarda en este equipo. Las claves de RPC y de Pinata van cifradas dentro de la bóveda (nunca en <span className="num">.env</span> ni en texto plano) y no vuelven a mostrarse.
        {profile === "test" && " Perfil de pruebas: el RPC tiene que ser local y los metadatos se guardan en el almacén local."}
      </p>

      {error && <p className="mt-4 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}
      {!s ? (
        <div className="mt-6 space-y-4">
          <div className="skeleton h-56" aria-busy="true" />
          <div className="skeleton h-40" aria-busy="true" />
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          <RpcSection s={s} save={save} />
          <IpfsSection s={s} save={save} profile={profile} />
          <TradingSection s={s} save={save} />
          <JitoSection s={s} save={save} profile={profile} />
          <SecuritySection s={s} save={save} />
          <AltPanel />
          <BackupsPanel />
          <PasswordSection />
          <DiagnosticsSection />
        </div>
      )}
    </div>
  );
}

function Section({ id, title, kicker, children, aside }: { id: string; title: string; kicker: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-t`} className="panel reticle p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="telemetry">{kicker}</p>
          <h2 id={`${id}-t`} className="mt-0.5 text-[16px] font-semibold">
            {title}
          </h2>
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium">
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-[11.5px] text-sell">{error}</p> : hint ? <p className="mt-1 text-[11.5px] text-faint">{hint}</p> : null}
    </div>
  );
}

function SaveBtn({ busy, disabled, onClick, label = "Guardar" }: { busy: boolean; disabled?: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} disabled={busy || disabled} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[12.5px] font-semibold disabled:opacity-50">
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
      {label}
    </button>
  );
}

/** Campo de secreto: nunca muestra el valor guardado; vacío = no cambia. */
function SecretInput({ id, label, set, value, onChange, onClear, hint }: { id: string; label: string; set: boolean; value: string; onChange: (v: string) => void; onClear?: () => void; hint?: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input id={id} type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder={set ? "•••••••• (guardada; escribe para sustituirla)" : "Sin configurar"} className="field num h-9 pr-10 text-[12.5px]" />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Ocultar" : "Mostrar"} className="btn-ghost absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md">
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        {set && (
          <span className="chip h-7 shrink-0 border-buy/30 text-buy">
            <Lock className="size-3" aria-hidden /> cifrada
          </span>
        )}
        {set && onClear && (
          <button type="button" onClick={onClear} className="btn btn-ghost h-8 px-2 text-[12px]">
            Quitar
          </button>
        )}
      </div>
    </Field>
  );
}

const httpOk = (v: string) => v === "" || /^https?:\/\/\S+$/.test(v);
const wsOk = (v: string) => v === "" || /^wss?:\/\/\S+$/.test(v);

function RpcSection({ s, save }: { s: SettingsDto; save: (p: Patch, what: string) => Promise<boolean> }) {
  const st = useChain((c) => c.status);
  const [f, setF] = useState({ ph: s.rpcPrimaryHttp, pw: s.rpcPrimaryWs, bh: s.rpcBackupHttp, bw: s.rpcBackupWs, key: "", bkey: "", rps: String(s.rpcMaxRps), send: String(s.rpcSendPerSec).replace(".", ",") });
  const [busy, setBusy] = useState(false);
  const rps = Number(f.rps);
  const sendPs = Number(f.send.replace(",", "."));
  const errs = {
    ph: !f.ph ? "Obligatorio" : !httpOk(f.ph) ? "URL http(s):// completa" : null,
    pw: !wsOk(f.pw) ? "URL ws(s):// completa" : null,
    bh: !httpOk(f.bh) ? "URL http(s):// completa" : null,
    bw: !wsOk(f.bw) ? "URL ws(s):// completa" : null,
    rps: Number.isInteger(rps) && rps >= 0 && rps <= 1000 ? null : "Entero de 0 a 1.000",
    send: Number.isFinite(sendPs) && sendPs >= 0 && sendPs <= 100 ? null : "De 0 a 100",
  };
  const bad = Object.values(errs).some(Boolean);
  const dirty = f.ph !== s.rpcPrimaryHttp || f.pw !== s.rpcPrimaryWs || f.bh !== s.rpcBackupHttp || f.bw !== s.rpcBackupWs || f.key !== "" || f.bkey !== "" || rps !== s.rpcMaxRps || sendPs !== s.rpcSendPerSec;
  const submit = async () => {
    setBusy(true);
    const ok = await save({ rpcPrimaryHttp: f.ph, rpcPrimaryWs: f.pw, rpcBackupHttp: f.bh, rpcBackupWs: f.bw, rpcMaxRps: rps, rpcSendPerSec: sendPs, ...(f.key ? { rpcKey: f.key } : {}), ...(f.bkey ? { rpcBackupKey: f.bkey } : {}) }, "RPC");
    setBusy(false);
    if (ok) setF((x) => ({ ...x, key: "", bkey: "" }));
  };
  // tras guardar, el servidor puede haber partido la URL ({key}): se reflejan los valores guardados
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza el formulario con lo guardado
    setF((x) => ({ ...x, ph: s.rpcPrimaryHttp, pw: s.rpcPrimaryWs, bh: s.rpcBackupHttp, bw: s.rpcBackupWs }));
  }, [s.rpcPrimaryHttp, s.rpcPrimaryWs, s.rpcBackupHttp, s.rpcBackupWs]);
  const needsKey = (u: string) => u.includes(RPC_KEY_PLACEHOLDER);
  // REVIEW-F1 P2-8: una URL remota guardada sin {key} puede llevar la clave en un sitio que no se detecta
  const unsplit = [s.rpcPrimaryHttp, s.rpcPrimaryWs, s.rpcBackupHttp, s.rpcBackupWs].filter((u) => {
    try {
      return !!u && !u.includes(RPC_KEY_PLACEHOLDER) && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return (
    <Section
      id="rpc"
      kicker="Conexión"
      title="RPC de Solana"
      aside={
        st && (
          <span className={`chip num h-7 ${st.mode === "off" ? "border-warn/30 text-warn" : st.healthy ? "border-buy/30 text-buy" : "border-sell/30 text-sell"}`} title={st.error ?? st.host ?? ""}>
            <Plug className="size-3" aria-hidden />
            {st.mode === "off" ? "Desconectado" : st.healthy ? `${st.host ?? ""} · ${st.latencyMs ?? "—"} ms${st.usingBackup ? " · respaldo" : ""}` : "Caído"}
          </span>
        )
      }
    >
      {st?.mode === "off" && st.error && (
        <p className="mb-4 flex items-start gap-2 rounded-[var(--radius-sm)] border border-warn/30 bg-[var(--warn-soft,transparent)] p-2.5 text-[12.5px] text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {st.error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <Field id="rpc-ph" label="Principal · HTTP" error={errs.ph}>
          <input id="rpc-ph" value={f.ph} onChange={(e) => setF({ ...f, ph: e.target.value.trim() })} spellCheck={false} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.ph} />
        </Field>
        <Field id="rpc-pw" label="Principal · WebSocket" error={errs.pw} hint="Vacío: se sondea sin WebSocket (más latencia en el Live).">
          <input id="rpc-pw" value={f.pw} onChange={(e) => setF({ ...f, pw: e.target.value.trim() })} spellCheck={false} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.pw} />
        </Field>
        <Field id="rpc-bh" label="Respaldo · HTTP (opcional)" error={errs.bh} hint="Si el principal cae, se cambia en ≤ 3 s.">
          <input id="rpc-bh" value={f.bh} onChange={(e) => setF({ ...f, bh: e.target.value.trim() })} spellCheck={false} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.bh} />
        </Field>
        <Field id="rpc-bw" label="Respaldo · WebSocket (opcional)" error={errs.bw}>
          <input id="rpc-bw" value={f.bw} onChange={(e) => setF({ ...f, bw: e.target.value.trim() })} spellCheck={false} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.bw} />
        </Field>
        <SecretInput
          id="rpc-key"
          label="Clave del RPC principal"
          set={s.rpcKeySet}
          value={f.key}
          onChange={(v) => setF({ ...f, key: v })}
          onClear={() => save({ rpcKey: "" }, "Clave del RPC")}
          hint={needsKey(f.ph) ? <>La URL usa <span className="num">{RPC_KEY_PLACEHOLDER}</span>: aquí va la clave.</> : <>Puedes pegar la URL completa del proveedor: la clave se separa sola y la URL queda con <span className="num">{RPC_KEY_PLACEHOLDER}</span>.</>}
        />
        <SecretInput id="rpc-bkey" label="Clave del RPC de respaldo" set={s.rpcBackupKeySet} value={f.bkey} onChange={(v) => setF({ ...f, bkey: v })} onClear={() => save({ rpcBackupKey: "" }, "Clave del RPC de respaldo")} />
        <Field id="rpc-rps" label="Límite de peticiones por segundo" error={errs.rps} hint="0 = sin límite. Evita los 429 de los planes gratuitos.">
          <input id="rpc-rps" inputMode="numeric" value={f.rps} onChange={(e) => setF({ ...f, rps: e.target.value.trim() })} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.rps} />
        </Field>
        <Field
          id="rpc-send"
          label="Envíos de transacciones por segundo"
          error={errs.send}
          hint={
            <>
              0 = sin límite. Las órdenes multi-wallet se espacian solas.{" "}
              {Object.values(RPC_PRESETS).map((p, i) => (
                <span key={p.label}>
                  {i > 0 && " · "}
                  <button type="button" onClick={() => setF({ ...f, rps: String(p.rpcMaxRps), send: String(p.rpcSendPerSec) })} className="text-accent-b underline-offset-2 hover:underline">
                    Usar el preset {p.label} ({p.rpcMaxRps} y {p.rpcSendPerSec})
                  </button>
                </span>
              ))}
            </>
          }
        >
          <input id="rpc-send" inputMode="decimal" value={f.send} onChange={(e) => setF({ ...f, send: e.target.value.trim() })} className="field num h-9 text-[12.5px]" aria-invalid={!!errs.send} />
        </Field>
      </div>
      {unsplit.length > 0 && (
        <p role="note" className="mt-3 rounded-[var(--radius-sm)] border border-warn/30 bg-[var(--warn-soft)] p-2.5 text-[12px] text-warn">
          {unsplit.length === 1 ? "Una URL remota no lleva" : `${unsplit.length} URL remotas no llevan`} <span className="num">{RPC_KEY_PLACEHOLDER}</span>. Si tu proveedor puso la clave dentro de la URL y Nébula no la detectó, sustitúyela por <span className="num">{RPC_KEY_PLACEHOLDER}</span> y pega la clave en su campo: si no, queda en claro en la base y en las copias. Una URL pública sin clave (p. ej. api.mainnet-beta.solana.com) está bien así.
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-faint">Al guardar se reconecta y se reinician los vigilantes del Live. Con la bóveda bloqueada, un RPC con clave queda desconectado.</p>
        <SaveBtn busy={busy} disabled={!dirty || bad} onClick={submit} />
      </div>
    </Section>
  );
}

function IpfsSection({ s, save, profile }: { s: SettingsDto; save: (p: Patch, what: string) => Promise<boolean>; profile?: string }) {
  const [key, setKey] = useState("");
  const [gw, setGw] = useState(s.ipfsGateway);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const gwErr = /^https:\/\/\S+\/$/.test(gw) ? null : "URL https:// que acabe en /";
  const run = async () => {
    setBusy("test");
    try {
      setTest(await api<{ ok: boolean; message: string }>("/settings/ipfs/test", { method: "POST", body: key ? { key } : {} }));
    } catch (e) {
      setTest({ ok: false, message: (e as ApiError).message });
    }
    setBusy(null);
  };
  return (
    <Section id="ipfs" kicker="Metadatos" title="IPFS · Pinata">
      <p className="mb-3.5 text-[12.5px] text-muted">
        Pump.fun exige una URI de metadatos. En mainnet, la imagen y el JSON se suben a Pinata como <strong className="font-medium text-fg">públicos</strong> y la URI se forma con la pasarela. La clave es un JWT con permiso de subida de archivos.
        {profile === "test" && " En el perfil de pruebas no se usa: los metadatos van al almacén local."}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <SecretInput id="ipfs-key" label="JWT de Pinata" set={s.ipfsKeySet} value={key} onChange={(v) => (setKey(v), setTest(null))} onClear={() => save({ ipfsKey: "" }, "Clave de Pinata")} />
        <Field id="ipfs-gw" label="Pasarela pública" error={gwErr} hint="La URI que va en cadena: pasarela + CID (≤ 200 caracteres).">
          <input id="ipfs-gw" value={gw} onChange={(e) => setGw(e.target.value.trim())} spellCheck={false} className="field num h-9 text-[12.5px]" aria-invalid={!!gwErr} />
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p aria-live="polite" className={`flex items-center gap-1.5 text-[12px] ${test ? (test.ok ? "text-buy" : "text-sell") : "text-faint"}`}>
          {test ? (test.ok ? <CheckCircle2 className="size-3.5" aria-hidden /> : <XCircle className="size-3.5" aria-hidden />) : null}
          {test?.message ?? "«Probar» comprueba la clave contra Pinata sin subir nada."}
        </p>
        <div className="flex gap-2">
          <button onClick={run} disabled={busy !== null || (!key && !s.ipfsKeySet && profile !== "test")} className="btn h-9 px-3 text-[12.5px]">
            {busy === "test" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />} Probar
          </button>
          <SaveBtn
            busy={busy === "save"}
            disabled={(!key && gw === s.ipfsGateway) || !!gwErr}
            onClick={async () => {
              setBusy("save");
              if (await save({ ...(key ? { ipfsKey: key } : {}), ...(gw !== s.ipfsGateway ? { ipfsGateway: gw } : {}) }, "IPFS")) setKey("");
              setBusy(null);
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function TradingSection({ s, save }: { s: SettingsDto; save: (p: Patch, what: string) => Promise<boolean> }) {
  const [f, setF] = useState({ buy: String(s.slippageBuyPct).replace(".", ","), sell: String(s.slippageSellPct).replace(".", ","), prio: String(s.priorityFeeSol).replace(".", ",") });
  const [busy, setBusy] = useState(false);
  const v = { buy: numOf(f.buy), sell: numOf(f.sell), prio: numOf(f.prio) };
  const errs = {
    buy: !(v.buy >= 0.1 && v.buy <= 50) ? "Entre 0,1 % y 50 %" : null,
    sell: !(v.sell >= 0.1 && v.sell <= 50) ? "Entre 0,1 % y 50 %" : null,
    prio: !(v.prio >= 0 && v.prio <= 0.1) ? "Entre 0 y 0,1 SOL" : null,
  };
  const dirty = v.buy !== s.slippageBuyPct || v.sell !== s.slippageSellPct || v.prio !== s.priorityFeeSol;
  return (
    <Section id="trading" kicker="Órdenes" title="Slippage y priority fee por defecto">
      <div className="grid grid-cols-3 gap-4">
        <Field id="slip-buy" label="Slippage de compra (%)" error={errs.buy} hint="El valor que se envía; nunca un 100 % en silencio.">
          <input id="slip-buy" inputMode="decimal" value={f.buy} onChange={(e) => setF({ ...f, buy: e.target.value })} className="field num h-9" aria-invalid={!!errs.buy} />
        </Field>
        <Field id="slip-sell" label="Slippage de venta (%)" error={errs.sell} hint="Las ventas siempre llevan protección de precio.">
          <input id="slip-sell" inputMode="decimal" value={f.sell} onChange={(e) => setF({ ...f, sell: e.target.value })} className="field num h-9" aria-invalid={!!errs.sell} />
        </Field>
        <Field id="prio" label="Priority fee (SOL por transacción)" error={errs.prio} hint="Se reparte por unidad de cómputo (límite de 400.000 CU).">
          <input id="prio" inputMode="decimal" value={f.prio} onChange={(e) => setF({ ...f, prio: e.target.value })} className="field num h-9" aria-invalid={!!errs.prio} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <SaveBtn
          busy={busy}
          disabled={!dirty || Object.values(errs).some(Boolean)}
          onClick={async () => {
            setBusy(true);
            await save({ slippageBuyPct: v.buy, slippageSellPct: v.sell, priorityFeeSol: v.prio }, "Trading");
            setBusy(false);
          }}
        />
      </div>
    </Section>
  );
}

/**
 * REQ-SET-001 · F2 bloque 5: Jito como vía de envío opcional. Cada compra, venta y creación lleva una propina dentro de
 * la MISMA transacción y los mismos bytes salen por el RPC y por el Block Engine. Sin bundles (§2.3).
 */
function JitoSection({ s, save, profile }: { s: SettingsDto; save: (p: Patch, what: string) => Promise<boolean>; profile?: string }) {
  const [f, setF] = useState({ on: s.jitoEnabled, ep: s.jitoEndpoint || JITO_DEFAULT_ENDPOINT, tip: String(s.jitoTipSol).replace(".", ",") });
  const [busy, setBusy] = useState(false);
  const tip = numOf(f.tip);
  const errs = {
    ep: f.on && !/^https:\/\/[^\s/]+(\/\S*)?$/.test(f.ep) ? "URL https:// del Block Engine" : null,
    tip: !(tip >= (f.on ? JITO_MIN_TIP_SOL : 0) && tip <= 1) ? `Entre ${JITO_MIN_TIP_SOL.toLocaleString("es-ES", { maximumFractionDigits: 9 })} SOL (mínimo de Jito) y 1 SOL` : null,
  };
  const dirty = f.on !== s.jitoEnabled || f.ep !== (s.jitoEndpoint || JITO_DEFAULT_ENDPOINT) || tip !== s.jitoTipSol;
  const high = f.on && tip > 0.01;
  return (
    <Section
      id="jito"
      kicker="Envíos"
      title="Jito · vía de envío y propina"
      aside={<span className={`chip h-6 text-[11px] ${s.jitoEnabled ? "border-buy/25 text-buy" : ""}`}>{s.jitoEnabled ? (profile === "test" ? "activo · simulado" : "activo") : "desactivado"}</span>}
    >
      <p className="mb-3.5 max-w-[680px] text-[12.5px] text-muted">
        Con Jito, cada compra, venta y creación lleva una propina dentro de la misma transacción (si la operación falla, no se paga) y la transacción sale a la vez por el RPC y por el Block Engine de Jito. Ayuda a que entre antes en los slots de validadores con Jito. Como también sale por el RPC, la protección frente a sándwiches es parcial. Nunca se agrupan compras propias con la creación en un bundle.
      </p>
      <label htmlFor="jito-on" className="mb-3.5 flex w-fit cursor-pointer items-center gap-2.5 text-[12.5px] font-medium">
        <input id="jito-on" type="checkbox" checked={f.on} onChange={(e) => setF({ ...f, on: e.target.checked })} className="size-4 accent-[var(--accent-a)]" />
        Enviar por Jito
      </label>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <Field id="jito-ep" label="Block Engine" error={errs.ep} hint="El global reparte por región. También sirven los regionales (amsterdam., frankfurt., ny., tokyo.…).">
          <input id="jito-ep" value={f.ep} onChange={(e) => setF({ ...f, ep: e.target.value.trim() })} spellCheck={false} disabled={!f.on} className="field num h-9 text-[12.5px] disabled:opacity-60" aria-invalid={!!errs.ep} />
        </Field>
        <Field id="jito-tip" label="Propina (SOL por transacción)" error={errs.tip} hint={high ? "Más de 0,01 SOL por transacción: revisa que sea lo que quieres." : "Se suma en cada vista previa, en el dry-run y en el P&L."}>
          <input id="jito-tip" inputMode="decimal" value={f.tip} onChange={(e) => setF({ ...f, tip: e.target.value })} disabled={!f.on} className="field num h-9 disabled:opacity-60" aria-invalid={!!errs.tip} />
        </Field>
      </div>
      {f.on && profile === "test" && (
        <p role="note" className="mt-3 rounded-[var(--radius-sm)] border border-warn/30 bg-[var(--warn-soft)] p-2.5 text-[12px] text-warn">
          Perfil de pruebas: Jito no existe en Surfpool. La propina va en la transacción (así se ven el tamaño, los costes y el P&L reales), pero el envío al Block Engine se simula: no sale nada hacia Jito.
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-faint">Se aplica desde el siguiente envío. Un lanzamiento ya simulado pide repetir el dry-run si cambia la propina.</p>
        <SaveBtn
          busy={busy}
          disabled={!dirty || Object.values(errs).some(Boolean)}
          onClick={async () => {
            setBusy(true);
            await save({ jitoEnabled: f.on, jitoEndpoint: f.ep, jitoTipSol: tip }, "Jito");
            await useChain.getState().refreshStatus();
            setBusy(false);
          }}
        />
      </div>
    </Section>
  );
}

function SecuritySection({ s, save }: { s: SettingsDto; save: (p: Patch, what: string) => Promise<boolean> }) {
  const [min, setMin] = useState(String(s.autoLockMin));
  const [layout, setLayout] = useState(s.keyboardLayout);
  const theme = useTheme((t) => t.theme);
  const setTheme = useTheme((t) => t.set);
  const refreshVault = useVault((v) => v.refresh);
  const [busy, setBusy] = useState(false);
  const m = Number(min);
  const err = Number.isInteger(m) && m >= 0 && m <= 240 ? null : "Entero entre 0 y 240";
  const dirty = m !== s.autoLockMin || layout !== s.keyboardLayout;
  return (
    <Section id="security" kicker="Bóveda y teclado" title="Seguridad y apariencia">
      <div className="grid grid-cols-3 gap-4">
        <Field id="autolock" label="Bloqueo automático (minutos)" error={err} hint="0 = nunca. Con minutos: aviso 60 s antes y, al bloquear, lo que está en marcha queda en pausa.">
          <input id="autolock" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} className="field num h-9" aria-invalid={!!err} />
        </Field>
        <Field id="layout" label="Distribución del teclado" hint="Atajos Espacio+tecla del Instant Trade.">
          <select id="layout" value={layout} onChange={(e) => setLayout(e.target.value as SettingsDto["keyboardLayout"])} className="field h-9">
            <option value="qwerty">QWERTY</option>
            <option value="azerty">AZERTY</option>
            <option value="qwertz">QWERTZ</option>
          </select>
        </Field>
        <div>
          <p id="theme-l" className="mb-1.5 text-[12.5px] font-medium">
            Tema
          </p>
          <div role="radiogroup" aria-labelledby="theme-l" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
            {(
              [
                ["dark", "Oscuro", Moon],
                ["light", "Claro", Sun],
              ] as const
            ).map(([k, l, Icon]) => (
              <button key={k} role="radio" aria-checked={theme === k} onClick={() => setTheme(k)} className={`flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${theme === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                <Icon className="size-3.5" aria-hidden /> {l}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] text-faint">Se aplica al momento.</p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <SaveBtn
          busy={busy}
          disabled={!dirty || !!err}
          onClick={async () => {
            setBusy(true);
            if (await save({ autoLockMin: m, keyboardLayout: layout }, "Seguridad")) void refreshVault();
            setBusy(false);
          }}
        />
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [ask, setAsk] = useState(false);
  const err = pw && pw.length < MIN_PASSWORD ? `Mínimo ${MIN_PASSWORD} caracteres` : pw2 && pw !== pw2 ? "No coinciden" : null;
  return (
    <Section id="password" kicker="Bóveda" title="Cambiar la contraseña maestra">
      <p className="mb-3.5 text-[12.5px] text-muted">Vuelve a cifrar toda la bóveda. Si se interrumpe, la anterior sigue intacta. No se puede recuperar: guárdala en un gestor de contraseñas. Las copias locales se rehacen con la nueva; las que exportaste fuera siguen abriéndose con la anterior.</p>
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-4">
        <Field id="npw" label="Nueva contraseña">
          <input id="npw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="field num h-9" />
        </Field>
        <Field id="npw2" label="Repítela">
          <input id="npw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="field num h-9" aria-invalid={!!err} />
        </Field>
        <button onClick={() => setAsk(true)} disabled={!pw || pw !== pw2 || pw.length < MIN_PASSWORD} className="btn h-9 px-4 text-[12.5px]">
          <KeyRound className="size-3.5" aria-hidden /> Cambiar
        </button>
      </div>
      <p className="mt-1 min-h-4 text-[11.5px] text-sell">{err}</p>
      {ask && (
        <StepUpDialog
          action="change-password"
          title="Cambiar la contraseña maestra"
          body="Confirma la contraseña actual. Después, la nueva será la única que abra la bóveda y sus copias futuras."
          onClose={() => setAsk(false)}
          onToken={async (t) => {
            try {
              const r = await api<{ ok: true; backupsRemoved: number }>("/vault/change-password", { method: "POST", body: { newPassword: pw }, stepUp: t });
              setPw("");
              setPw2("");
              setAsk(false);
              toast({ tone: "buy", title: "Contraseña cambiada", body: `${r.backupsRemoved} copias locales con la contraseña anterior borradas y una copia nueva hecha. Las copias que exportaste fuera de este equipo siguen abriéndose con la contraseña antigua: bórralas.` });
            } catch (e) {
              setAsk(false);
              toast({ tone: "error", title: "No se pudo cambiar", body: (e as ApiError).message });
            }
          }}
        />
      )}
    </Section>
  );
}

function DiagnosticsSection() {
  return (
    <Section id="diag" kicker="Logs" title="Actividad y diagnóstico">
      <div className="flex items-center justify-between gap-4">
        <p className="max-w-[560px] text-[12.5px] text-muted">El registro de actividad guarda exportaciones, retiros, lanzamientos y cambios de ajustes. «Exportar diagnóstico» junta el estado de la app, la actividad y los logs técnicos en un archivo con los secretos redactados.</p>
        <div className="flex shrink-0 gap-2">
          <Link href="/activity" className="btn h-9 px-3 text-[12.5px]">
            <ScrollText className="size-3.5" aria-hidden /> Ver actividad
          </Link>
          <DiagnosticsButton />
        </div>
      </div>
    </Section>
  );
}
