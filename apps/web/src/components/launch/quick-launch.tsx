"use client";

// REQ-LAUNCH-018 · «Quick Launch»: abre el asistente con un borrador nuevo y un preset ya aplicado.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bookmark, ChevronDown, Loader2 } from "lucide-react";
import { listPresets, type Preset } from "@/lib/presets";

export function QuickLaunch() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Preset[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listPresets("launch").then((r) => alive && setItems(r), () => alive && setItems([]));
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="btn flex h-10 shrink-0 items-center gap-2 px-3.5 text-[13px]">
        <Bookmark className="size-4" aria-hidden /> Desde preset <ChevronDown className="size-3.5 text-muted" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Quick Launch desde un preset" className="glass absolute top-12 right-0 z-50 w-[260px] rounded-[var(--radius-md)] p-2 shadow-[var(--shadow-float)]">
          {items === null && (
            <p className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Cargando…
            </p>
          )}
          {items?.length === 0 && <p className="px-2 py-2 text-[12px] text-faint">Aún no hay presets. Guárdalos desde el asistente con «Presets».</p>}
          {items?.map((p) => (
            <Link key={p.id} role="menuitem" href={`/launch/new?new=1&preset=${encodeURIComponent(p.id)}`} className="block truncate rounded-[6px] px-2 py-1.5 text-[12.5px] hover:bg-surface-2">
              {p.name} <span className="text-[11px] text-faint">{String(p.data.launchMode ?? "")}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
