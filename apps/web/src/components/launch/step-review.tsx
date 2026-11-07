"use client";

import { CheckCircle2, CircleDashed, FlaskConical, Loader2, Table2, XCircle } from "lucide-react";
import { buysAfterCreate, delayTimeline, fmtMs, planAmounts, toLamports, useDraft } from "@/lib/draft";
import { fingerprint, useLaunchRun } from "@/lib/launch-run";
import { fmtLamports } from "@/lib/chain";
import { SectionTitle } from "./ui";
import { useLaunchData } from "./use-launch-data";

export function StepReview({ goto }: { goto: (step: number) => void }) {
  const d = useDraft((s) => s.draft);
  const { byId } = useLaunchData();
  const view = useLaunchRun((s) => s.view);
  const fp = useLaunchRun((s) => s.fp);
  const busy = useLaunchRun((s) => s.busy);
  const error = useLaunchRun((s) => s.error);
  const runDry = useLaunchRun((s) => s.runDry);
  const createAlt = useLaunchRun((s) => s.createAlt);
  const pf = view?.preflight ?? null;
  const launched = view && view.status !== "PREPARED" && view.status !== "FAILED";
  const stale = !!pf && fp !== fingerprint(d) && !launched;
  const holdersTotal = planAmounts(d).reduce((a, l) => a + l, 0n);

  const groups: { title: string; step: number; items: [string, string][] }[] = [
    {
      title: "Token",
      step: 1,
      items: [
        ["Nombre", d.name || "—"],
        ["Símbolo", d.symbol ? `$${d.symbol}` : "—"],
        ["Imagen", d.upload.status === "done" ? "Subida" : "Pendiente"],
        ["Enlaces", [d.links.x && "X", d.links.telegram && "Telegram", d.links.web && "Web"].filter(Boolean).join(" · ") || "Ninguno"],
      ],
    },
    {
      title: "Configuración",
      step: 2,
      items: [
        ["Pad", `Pump.fun · ${d.mode === "classic" ? "Classic" : "Mayhem"}`],
        ["Comisiones", d.feeMode === "creator" ? "Creator Fees" : "Holder Rewards"],
        ["Wallet dev", byId.get(d.devWalletId)?.label ?? "—"],
        ["Dev buy", fmtLamports(toLamports(d.devBuy), 3)],
        ["Modo", d.launchMode === "quick" ? `Quick · ${d.plan.length} wallets` : d.launchMode === "pro" ? `Pro · ${d.plan.length} wallets · esperas ${fmtMs(delayTimeline(d).at(-1) ?? 0)}` : "Manual"],
        ["Slippage", `${d.slippage} %`],
      ],
    },
    {
      title: "Financiación",
      step: 3,
      items: [
        ["Compras holders", fmtLamports(holdersTotal, 3)],
        ["Transacciones", String(1 + (buysAfterCreate(d) ? d.plan.length : 0))],
      ],
    },
  ];

  return (
    <div className="rise">
      <SectionTitle index="Paso 4 de 4 · Revisar y lanzar" title="Última comprobación" body="La creación con el dev buy se simula contra el RPC; las compras de holders se comprueban contra su saldo (aún no hay curva que simular). Un fallo bloquea el lanzamiento." />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title} className="panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="telemetry">{g.title}</p>
              <button onClick={() => goto(g.step)} className="text-[12px] text-accent-b hover:underline">
                Editar
              </button>
            </div>
            <dl className="space-y-1.5 text-[12.5px]">
              {g.items.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num truncate text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <section aria-labelledby="dry-title" className="panel reticle mt-5 overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <FlaskConical className="size-4 text-accent-b" aria-hidden />
          <h3 id="dry-title" className="text-[13.5px] font-medium">
            Dry-run
          </h3>
          <span className="text-[12px] text-faint">nada se firma para enviar</span>
          <button onClick={() => runDry(d)} disabled={busy !== null || !!launched} className="btn ml-auto h-8">
            {busy === "dry" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {!pf ? "Simular" : busy === "dry" ? "Simulando…" : "Volver a simular"}
          </button>
        </div>
        <div aria-live="polite">
          {error && <p className="border-b border-sell/25 bg-[var(--sell-soft)] px-4 py-2 text-[12.5px] text-sell">{error}</p>}
          {!pf && !error && <p className="px-4 py-8 text-center text-[13px] text-muted">Aún no has simulado este lanzamiento.</p>}
          {stale && <p className="border-b border-warn/25 bg-[var(--warn-soft)] px-4 py-2 text-[12.5px] text-warn">Has cambiado el borrador después de simular. Vuelve a simular.</p>}
          <ul>
            {pf?.checks.map((c, i) => (
              <li key={i} className="row-in flex flex-wrap items-center gap-3 border-b border-line/50 px-4 py-2.5 text-[12.5px] last:border-0">
                {c.ok ? <CheckCircle2 className="size-4 text-buy" aria-hidden /> : c.kind === "setup" ? <CircleDashed className="size-4 text-warn" aria-hidden /> : <XCircle className="size-4 text-sell" aria-hidden />}
                <span className="sr-only">{c.ok ? "correcto" : "pendiente"}</span>
                <span className="flex-1">{c.label}</span>
                <span className="chip h-5 px-1.5 text-[10.5px]">{c.kind === "simulated" ? "simulada" : c.kind === "checked" ? "comprobada" : "preparación"}</span>
                {c.units ? <span className="num text-faint">{c.units.toLocaleString("es-ES")} CU</span> : null}
                {c.note && <span className="basis-full pl-7 text-faint">{c.note}</span>}
                {c.reason && (
                  <span className={`basis-full pl-7 ${c.kind === "setup" ? "text-warn" : "text-sell"}`}>
                    {c.reason}{" "}
                    {c.action === "create-alt" ? (
                      <button onClick={() => createAlt(d.devWalletId, d)} disabled={busy !== null} className="btn ml-2 h-7 px-2.5 text-[12px]">
                        {busy === "alt" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
                        Crear la tabla ahora
                      </button>
                    ) : c.kind === "checked" ? (
                      <button onClick={() => goto(3)} className="ml-1 text-accent-b underline-offset-2 hover:underline">
                        Corregir
                      </button>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {pf?.ok && !stale && !launched && <p className="bg-[var(--buy-soft)] px-4 py-2 text-[12.5px] text-buy">Todo en verde. Ya puedes lanzar.</p>}
          {pf && !pf.ok && !stale && <p className="bg-[var(--sell-soft)] px-4 py-2 text-[12.5px] text-sell">Hay comprobaciones pendientes. El lanzamiento queda bloqueado.</p>}
        </div>
      </section>
    </div>
  );
}
