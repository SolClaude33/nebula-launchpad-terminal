"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { Zap } from "lucide-react";
import { useSim } from "@/lib/sim";
import { TokenHeader } from "@/components/live/token-header";
import { ActivityTabs } from "@/components/live/activity-tabs";
import { TradeTicket } from "@/components/live/trade-ticket";
import { PositionCard } from "@/components/live/position-card";
import { InstantTrade } from "@/components/live/instant-trade";

const PriceChart = dynamic(() => import("@/components/live/price-chart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <div className="skeleton m-4 h-[calc(100%-2rem)]" />,
});

const SPLIT_KEY = "nebula.live.split";

export function Workspace() {
  const { address } = useParams<{ address: string }>();
  const init = useSim((s) => s.init);
  const tick = useSim((s) => s.tick);
  const ready = useSim((s) => s.ready);
  const [split, setSplit] = useState(0.56);
  const [showInstant, setShowInstant] = useState(true);
  const col = useRef<HTMLDivElement>(null);

  useEffect(() => {
    init();
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      tick();
      t = setTimeout(loop, 600 + Math.random() * 1500);
    };
    t = setTimeout(loop, 800);
    return () => clearTimeout(t);
  }, [init, tick]);

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia local leída tras montar para no romper la hidratación
      if (v > 0.25 && v < 0.8) setSplit(v);
    } catch {}
  }, []);

  const startResize = (e: React.PointerEvent) => {
    const el = col.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let last = split;
    const move = (ev: PointerEvent) => {
      last = Math.max(0.3, Math.min(0.75, (ev.clientY - rect.top) / rect.height));
      setSplit(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(SPLIT_KEY, String(last));
      } catch {}
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const onSplitKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSplit((s) => {
        const v = Math.max(0.3, Math.min(0.75, s + (e.key === "ArrowUp" ? -0.03 : 0.03)));
        try {
          localStorage.setItem(SPLIT_KEY, String(v));
        } catch {}
        return v;
      });
    }
  };

  if (!ready) return <WorkspaceSkeleton />;

  return (
    <div className="flex h-[calc(100dvh-80px)] min-h-[640px] flex-col gap-3 p-3">
      <TokenHeader mint={address} />

      <div className="flex min-h-0 flex-1 gap-3">
        <div ref={col} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section aria-label="Gráfico" className="panel overflow-hidden" style={{ height: `calc(${split * 100}% - 6px)` }}>
            <PriceChart />
          </section>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Redimensionar gráfico y actividad"
            aria-valuenow={Math.round(split * 100)}
            aria-valuemin={30}
            aria-valuemax={75}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onSplitKey}
            className="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center"
          >
            <span className="h-1 w-10 rounded-full bg-line-strong transition-colors group-hover:bg-accent-b/60 group-focus-visible:bg-accent-b" />
          </div>
          <section aria-label="Actividad" className="panel min-h-0 flex-1 overflow-hidden">
            <ActivityTabs />
          </section>
        </div>

        <aside aria-label="Operar" className="scroll-thin flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto pr-0.5 xl:w-[340px]">
          <TradeTicket />
          <PositionCard />
          <button onClick={() => setShowInstant((s) => !s)} aria-pressed={showInstant} className="btn h-10 justify-between px-3.5">
            <span className="flex items-center gap-2">
              <Zap className="size-4 text-accent" aria-hidden /> Instant Trade flotante
            </span>
            <span className="text-[12px] text-muted">{showInstant ? "Visible" : "Oculto"}</span>
          </button>
        </aside>
      </div>

      {showInstant && <InstantTrade />}
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="flex h-[calc(100dvh-80px)] flex-col gap-3 p-3" aria-busy="true" aria-label="Cargando workspace">
      <div className="skeleton h-[112px]" />
      <div className="flex flex-1 gap-3">
        <div className="flex flex-1 flex-col gap-3">
          <div className="skeleton flex-[1.3]" />
          <div className="skeleton flex-1" />
        </div>
        <div className="flex w-[340px] flex-col gap-3">
          <div className="skeleton h-[520px]" />
          <div className="skeleton flex-1" />
        </div>
      </div>
    </div>
  );
}
