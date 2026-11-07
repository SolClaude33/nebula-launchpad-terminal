"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, RotateCcw, TriangleAlert, X } from "lucide-react";
import { issues, useDraft } from "@/lib/draft";
import { applyLaunchPreset, listPresets, REVIEW_LABEL } from "@/lib/presets";
import { toast } from "@/lib/toast";
import { useJitoTip } from "@/lib/chain";
import { PresetMenu } from "./preset-menu";
import { useLaunchRun } from "@/lib/launch-run";
import { useLaunchData } from "./use-launch-data";
import { StepToken } from "./step-token";
import { StepConfig } from "./step-config";
import { StepFunding } from "./step-funding";
import { StepReview } from "./step-review";
import { LaunchSummary } from "./summary";

const STEPS = ["Token", "Configuración", "Financiación", "Revisar y lanzar"];

export function LaunchWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const draftParam = params.get("draft");
  const fresh = params.get("new") === "1";
  // «Quick Launch» (REQ-LAUNCH-018): borrador nuevo con un preset aplicado
  const presetParam = params.get("preset");
  const hydrate = useDraft((s) => s.hydrate);
  const hydrated = useDraft((s) => s.hydrated);
  const reset = useDraft((s) => s.reset);
  const d = useDraft((s) => s.draft);
  const resetRun = useLaunchRun((s) => s.reset);
  const loadRun = useLaunchRun((s) => s.load);
  const { balances, addressOf, wallets, loaded } = useLaunchData();
  const jitoTip = useJitoTip();
  const set = useDraft((s) => s.set);
  const [step, setStep] = useState(1);

  useEffect(() => {
    void hydrate(draftParam, fresh);
    resetRun();
  }, [hydrate, resetRun, draftParam, fresh]);

  // Quick Launch: aplica el preset una sola vez y deja la URL apuntando al borrador (recargar no lo reaplica)
  useEffect(() => {
    if (!hydrated || !presetParam || !loaded) return;
    let alive = true;
    listPresets("launch").then(
      async (items) => {
        if (!alive) return;
        const p = items.find((x) => x.id === presetParam);
        if (p) {
          const { patch } = applyLaunchPreset(useDraft.getState().draft, p.data, new Set(wallets.filter((w) => !w.archived).map((w) => w.id)));
          set(patch);
          toast({ tone: "info", title: `Quick Launch · «${p.name}»`, body: "Pon el nombre, el símbolo y la imagen, y revisa lo resaltado." });
        }
        // Guardar YA: al cambiar la URL el asistente relee el borrador del servidor
        await useDraft.getState().flush();
        if (alive) router.replace(`/launch/new?draft=${encodeURIComponent(useDraft.getState().draft.draftId)}`);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [hydrated, presetParam, loaded, wallets, set, router]);

  // Si este borrador ya se lanzó (o está en curso), se muestra su estado real
  useEffect(() => {
    if (hydrated) void loadRun(d.draftId);
  }, [hydrated, d.draftId, loadRun]);

  // Esc cierra sin perder nada: el borrador ya está autoguardado (REQ-LAUNCH-004)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) router.push("/launches/drafts");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const goto = (s: number, field?: string) => {
    setStep(s);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (field)
      setTimeout(() => {
        const el = document.getElementById(field);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        (el?.matches("input,textarea,select,button") ? el : el?.querySelector<HTMLElement>("input,textarea,select,button"))?.focus({ preventScroll: true });
      }, 60);
  };

  const all = issues(d, { balances, addressOf, tipLamports: jitoTip });
  const stepIssues = (s: number) => all.filter((i) => i.step === s).length;

  if (!hydrated) return <div className="skeleton m-6 h-[70vh]" aria-busy="true" />;

  return (
    <div className="mx-auto grid max-w-[1320px] grid-cols-[minmax(0,1fr)_300px] gap-5 px-5 pt-5 pb-16 xl:grid-cols-[minmax(0,1fr)_370px]">
      <div className="min-w-0">
        <div className="mb-7 flex items-center gap-3">
          <nav aria-label="Pasos del lanzamiento" className="flex-1">
            <ol className="flex items-center gap-2">
              {STEPS.map((label, i) => {
                const n = i + 1;
                const current = n === step;
                const done = n < step && stepIssues(n) === 0;
                return (
                  <li key={label} className="flex flex-1 items-center gap-2">
                    <button
                      onClick={() => goto(n)}
                      aria-current={current ? "step" : undefined}
                      className={`group flex min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)] py-1 pr-2 text-left text-[13px] transition-colors ${current ? "text-fg" : "text-muted hover:text-fg"}`}
                    >
                      <span
                        className={`num grid size-7 shrink-0 place-items-center rounded-full border text-[12px] transition-all ${
                          current
                            ? "border-transparent bg-gradient-to-br from-accent-a to-accent-b text-white shadow-[0_0_0_4px_var(--glow)]"
                            : done
                              ? "border-buy/40 bg-[var(--buy-soft)] text-buy"
                              : "border-line-strong bg-surface-1"
                        }`}
                      >
                        {done ? <Check className="size-3.5" aria-hidden /> : n}
                      </span>
                      <span className="truncate">{label}</span>
                      {n < 4 && stepIssues(n) > 0 && n < step && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label="con pendientes" />}
                    </button>
                    {n < 4 && <span aria-hidden className={`h-px flex-1 ${n < step ? "bg-gradient-to-r from-accent-a/60 to-accent-b/60" : "bg-line-strong"}`} />}
                  </li>
                );
              })}
            </ol>
          </nav>
          <PresetMenu />
          <button onClick={() => router.push("/launches/drafts")} className="btn btn-ghost size-9 p-0" aria-label="Cerrar asistente (el borrador se conserva)" title="Cerrar · Esc">
            <X className="size-4" />
          </button>
        </div>

        {d.review?.length > 0 && (
          <div role="status" className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-sm)] border border-warn/30 bg-[var(--warn-soft)] px-3 py-2 text-[12.5px] text-warn">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span>Preset cargado. Revisa antes de lanzar:</span>
            {d.review.map((r, i) => (
              <button key={r} onClick={() => goto(REVIEW_LABEL[r].step, r)} className="underline-offset-2 hover:underline">
                {REVIEW_LABEL[r].label}
                {i < d.review.length - 1 ? "," : ""}
              </button>
            ))}
          </div>
        )}
        <div key={step}>
          {step === 1 && <StepToken />}
          {step === 2 && <StepConfig />}
          {step === 3 && <StepFunding />}
          {step === 4 && <StepReview goto={goto} />}
        </div>

        <div className="mt-10 flex items-center justify-between border-t border-line pt-5">
          <button onClick={() => goto(step - 1)} disabled={step === 1} className="btn h-10 px-4">
            <ArrowLeft className="size-4" aria-hidden /> Anterior
          </button>
          <button
            onClick={() => {
              if (confirm("¿Descartar este borrador y empezar uno nuevo? Un lanzamiento ya hecho no se ve afectado.")) {
                void reset().then(() => {
                  resetRun();
                  setStep(1);
                  if (draftParam) router.replace("/launch/new?new=1");
                });
              }
            }}
            className="btn btn-ghost h-10 text-[12.5px]"
          >
            <RotateCcw className="size-3.5" aria-hidden /> Descartar borrador
          </button>
          {step < 4 ? (
            <button onClick={() => goto(step + 1)} className="cta h-10 px-5 text-[13px] font-medium">
              <span className="flex items-center gap-2">
                Siguiente: {STEPS[step]} <ArrowRight className="size-4" aria-hidden />
              </span>
            </button>
          ) : (
            <span className="w-[120px]" />
          )}
        </div>
      </div>

      <LaunchSummary goto={goto} />
    </div>
  );
}
