"use client";

// REQ-LAUNCH-018: menú de presets del asistente (cargar, guardar la configuración actual, borrar).
import { useEffect, useRef, useState } from "react";
import { Bookmark, Loader2, Trash2 } from "lucide-react";
import { useDraft } from "@/lib/draft";
import { applyLaunchPreset, deletePreset, launchPresetFrom, listPresets, savePreset, type Preset } from "@/lib/presets";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useLaunchData } from "./use-launch-data";

export function PresetMenu() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const { wallets } = useLaunchData();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Preset[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    listPresets("launch").then((r) => alive && setItems(r), () => alive && setItems([]));
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const load = (p: Preset) => {
    const active = new Set(wallets.filter((w) => !w.archived).map((w) => w.id));
    const { patch, dropped, devMissing } = applyLaunchPreset(d, p.data, active);
    set(patch);
    setOpen(false);
    toast({ tone: dropped || devMissing ? "warn" : "info", title: `Preset «${p.name}» cargado`, body: [dropped ? `${dropped} wallet${dropped === 1 ? "" : "s"} del plan ya no existe${dropped === 1 ? "" : "n"}` : "", devMissing ? "la wallet dev del preset ya no existe" : "", "revisa lo resaltado antes de lanzar"].filter(Boolean).join(" · ") });
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const same = items?.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      await savePreset("launch", name.trim(), launchPresetFrom(d), same?.id);
      toast({ tone: "info", title: same ? "Preset actualizado" : "Preset guardado", body: `«${name.trim()}»: configuración, wallets y plan (sin nombre, imagen ni confirmación de comisiones).` });
      setName("");
      setItems(await listPresets("launch"));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo guardar el preset", body: (e as ApiError).message });
    }
    setBusy(false);
  };

  const remove = async (p: Preset) => {
    await deletePreset(p.id).catch(() => {});
    setItems((list) => list?.filter((x) => x.id !== p.id) ?? null);
  };

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" className="btn h-9 gap-2 px-3 text-[12.5px]">
        <Bookmark className="size-3.5" aria-hidden /> Presets
      </button>
      {open && (
        <div role="dialog" aria-label="Presets de lanzamiento" className="glass absolute top-11 right-0 z-50 w-[320px] rounded-[var(--radius-md)] p-3 shadow-[var(--shadow-float)]">
          <p className="telemetry">Cargar</p>
          <ul className="scroll-thin mt-1.5 max-h-56 space-y-1 overflow-y-auto">
            {items === null && (
              <li className="flex items-center gap-2 px-1 py-2 text-[12px] text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Cargando…
              </li>
            )}
            {items?.length === 0 && <li className="px-1 py-2 text-[12px] text-faint">Aún no hay presets.</li>}
            {items?.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <button onClick={() => load(p)} className="flex-1 truncate rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-surface-2">
                  {p.name}
                  <span className="ml-1.5 text-[11px] text-faint">{String(p.data.launchMode ?? "")}</span>
                </button>
                <button onClick={() => remove(p)} aria-label={`Borrar el preset ${p.name}`} className="btn-ghost grid size-7 place-items-center rounded">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="mt-3 border-t border-line pt-3"
          >
            <label htmlFor="preset-name" className="telemetry">
              Guardar la configuración actual
            </label>
            <div className="mt-1.5 flex gap-1.5">
              <input id="preset-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Nombre del preset" className="field h-8 text-[12.5px]" />
              <button type="submit" disabled={!name.trim() || busy} className="btn h-8 px-3 text-[12px]">
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : "Guardar"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-faint">Guarda modo, wallets, montos, esperas y Launch Guard. No guarda nombre, imagen, enlaces ni la confirmación de comisiones.</p>
          </form>
        </div>
      )}
    </div>
  );
}
