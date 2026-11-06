"use client";

import { CheckCircle2, FlaskConical, Loader2, XCircle } from "lucide-react";
import { estimates, num, useDraft } from "@/lib/draft";
import { fingerprint, useLaunchRun } from "@/lib/launch-run";
import { fmtSol } from "@/lib/format";
import { SectionTitle } from "./ui";

export function StepReview({ goto }: { goto: (step: number) => void }) {
  const d = useDraft((s) => s.draft);
  const dry = useLaunchRun((s) => s.dry);
  const runDry = useLaunchRun((s) => s.runDry);
  const est = estimates(d);
  const stale = dry.status !== "idle" && dry.status !== "running" && dry.fingerprint !== fingerprint(d);

  const groups: { title: string; step: number; items: [string, string][] }[] = [
    {
      title: "Token",
      step: 1,
      items: [
        ["Nombre", d.name || "—"],
        ["Símbolo", d.symbol ? `$${d.symbol}` : "—"],
        ["Metadatos", d.ipfs.status === "done" ? "En IPFS" : "Pendiente"],
        ["Enlaces", [d.links.x && "X", d.links.telegram && "Telegram", d.links.web && "Web"].filter(Boolean).join(" · ") || "Ninguno"],
      ],
    },
    {
      title: "Configuración",
      step: 2,
      items: [
        ["Pad", `Pump.fun · ${d.mode === "classic" ? "Classic" : "Mayhem"}`],
        ["Comisiones", d.feeMode === "creator" ? "Creator Fees" : "Holder Rewards"],
        ["Dev buy", fmtSol(num(d.devBuy) || 0)],
        ["Modo", d.launchMode === "quick" ? `Quick · ${d.plan.length} wallets` : "Manual"],
        ["Slippage", `${d.slippage} %`],
        ["Cuándo", d.schedule === "now" ? "Al confirmar" : d.launchAt ? new Date(d.launchAt).toLocaleString("es-ES") : "—"],
        ["Launch Guard", d.guard.enabled ? `> ${d.guard.thresholdSol} SOL externos · ${d.guard.timeoutSec} s` : "Desactivado"],
      ],
    },
    {
      title: "Financiación",
      step: 3,
      items: [
        ["Compras holders", fmtSol(est.holdersSol)],
        ["Transacciones", String(est.txs)],
      ],
    },
  ];

  return (
    <div className="rise">
      <SectionTitle index="Paso 4 de 4 · Revisar y lanzar" title="Última comprobación" body="Simula cada transacción contra el RPC antes de enviar nada. Un fallo bloquea el lanzamiento." />

      <div className="grid grid-cols-3 gap-3">
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
            Vista previa · dry-run
          </h3>
          <span className="text-[12px] text-faint">simulateTransaction por cada transacción</span>
          <button onClick={() => runDry(d)} disabled={dry.status === "running"} className="btn ml-auto h-8">
            {dry.status === "running" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {dry.status === "idle" ? "Simular" : dry.status === "running" ? "Simulando…" : "Volver a simular"}
          </button>
        </div>
        <div aria-live="polite">
          {dry.status === "idle" && <p className="px-4 py-8 text-center text-[13px] text-muted">Aún no has simulado este lanzamiento.</p>}
          {stale && <p className="border-b border-warn/25 bg-[var(--warn-soft)] px-4 py-2 text-[12.5px] text-warn">Has cambiado el borrador después de simular. Vuelve a simular.</p>}
          <ul>
            {dry.rows.map((r, i) => (
              <li key={i} className="row-in flex items-center gap-3 border-b border-line/50 px-4 py-2.5 text-[12.5px] last:border-0">
                {r.ok ? <CheckCircle2 className="size-4 text-buy" aria-hidden /> : <XCircle className="size-4 text-sell" aria-hidden />}
                <span className="sr-only">{r.ok ? "entraría" : "fallaría"}</span>
                <span className="flex-1">{r.label}</span>
                {r.reason && (
                  <span className="text-sell">
                    {r.reason}{" "}
                    <button onClick={() => goto(3)} className="ml-1 text-accent-b underline-offset-2 hover:underline">
                      Corregir
                    </button>
                  </span>
                )}
                <span className="num text-faint">{r.units.toLocaleString("es-ES")} CU</span>
              </li>
            ))}
          </ul>
          {dry.status === "ok" && !stale && <p className="bg-[var(--buy-soft)] px-4 py-2 text-[12.5px] text-buy">Todo entraría. Ya puedes lanzar.</p>}
          {dry.status === "fail" && !stale && <p className="bg-[var(--sell-soft)] px-4 py-2 text-[12.5px] text-sell">Hay transacciones que fallarían. El lanzamiento queda bloqueado.</p>}
        </div>
      </section>
    </div>
  );
}
