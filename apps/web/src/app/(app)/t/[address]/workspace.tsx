"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Orbit, TriangleAlert, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { useChain } from "@/lib/chain";
import { refreshLive, useLive, useLiveFeed } from "@/lib/live";
import { toast } from "@/lib/toast";
import { TokenHeader } from "@/components/live/token-header";
import { ActivityTabs } from "@/components/live/activity-tabs";
import { TradeTicket } from "@/components/live/trade-ticket";
import { PositionCard } from "@/components/live/position-card";
import { InstantTrade } from "@/components/live/instant-trade";
import { LaunchPending, LaunchStrip, useLaunchWatch } from "@/components/live/launch-strip";

const PriceChart = dynamic(() => import("@/components/live/price-chart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <div className="skeleton m-4 h-[calc(100%-2rem)]" />,
});

const SPLIT_KEY = "nebula.live.split";

export function Workspace() {
  const { address } = useParams<{ address: string }>();
  useLiveFeed(address);
  const ready = useLive((s) => !!s.info && s.mint === address);
  const error = useLive((s) => s.error);
  const venue = useLive((s) => s.info?.venue);
  // Lanzamiento recién aprobado desde el asistente (?launch=<id>): solo se muestra, nunca se ejecuta desde aquí
  const launchId = useSearchParams().get("launch");
  const { view: launchView, refresh: refreshLaunch } = useLaunchWatch(launchId);
  const launchHere = !!launchId && (!launchView || launchView.mint === address);
  const [launchClosed, setLaunchClosed] = useState(false);
  const [split, setSplit] = useState(0.56);
  const [showInstant, setShowInstant] = useState(true);
  const col = useRef<HTMLDivElement>(null);

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

  // El token aún no existe (se está creando): «Creando $SYM…» en lugar del error
  if (!ready && launchHere && (!error || error.status === 404)) return <LaunchPending view={launchView} refresh={refreshLaunch} />;
  if (!ready && error) return <WorkspaceError status={error.status} message={error.message} />;
  if (!ready) return <WorkspaceSkeleton />;

  return (
    <div className="flex h-[calc(100dvh-80px)] min-h-[640px] flex-col gap-3 p-3">
      {launchHere && launchView && !launchClosed && <LaunchStrip view={launchView} refresh={refreshLaunch} onClose={() => setLaunchClosed(true)} />}
      {venue === "migrating" && <MigratingNotice mint={address} />}
      {error && <p role="status" className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-warn/25 bg-[var(--warn-soft)] px-3 py-1.5 text-[12px] text-warn"><TriangleAlert className="size-3.5" aria-hidden /> Sin datos nuevos: {error.message} Se reintenta cada segundo.</p>}
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

/** Curva completa sin pool: en mainnet la migración la hace Pump.fun; en pruebas se puede lanzar a mano. */
function MigratingNotice({ mint }: { mint: string }) {
  const profile = useChain((s) => s.status?.profile);
  const wallets = useLive((s) => s.wallets);
  const [busy, setBusy] = useState(false);
  const migrate = async () => {
    const payer = wallets[0];
    if (!payer) return;
    setBusy(true);
    try {
      await api("/dev/migrate", { method: "POST", body: { mint, payerWalletId: payer.id } });
      toast({ tone: "info", title: "Migrado a PumpSwap (perfil de pruebas)", body: `Pagado por ${payer.label}.` });
      await refreshLive();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo migrar", body: (e as Error).message });
    }
    setBusy(false);
  };
  return (
    <div role="status" className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-accent-b/25 bg-[color-mix(in_oklab,var(--accent-b)_8%,transparent)] px-3 py-2 text-[12.5px]">
      <Orbit className="size-4 shrink-0 text-accent-b" aria-hidden />
      <span className="flex-1">
        <strong className="font-semibold">Curva completa.</strong> El token se está graduando: las órdenes se bloquean hasta que exista el pool de PumpSwap{profile === "mainnet" ? ", que crea Pump.fun." : "."}
      </span>
      {profile === "test" && (
        <button onClick={migrate} disabled={busy || wallets.length === 0} className="btn h-8 px-3 text-[12px]" title="Solo en el perfil de pruebas: en mainnet la migración la hace Pump.fun">
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Migrar ahora (pruebas)
        </button>
      )}
    </div>
  );
}

function WorkspaceError({ status, message }: { status: number; message: string }) {
  return (
    <div className="grid h-[calc(100dvh-80px)] place-items-center p-6">
      <div className="panel reticle max-w-[460px] p-6 text-center">
        <TriangleAlert className="mx-auto size-6 text-warn" aria-hidden />
        <h1 className="mt-3 text-[16px] font-semibold">{status === 404 ? "No se puede abrir este token" : "Sin conexión con la cadena"}</h1>
        <p className="mt-1.5 text-[13px] text-muted">{message}</p>
        <Link href="/t" className="btn mt-5 inline-flex h-9 px-4 text-[13px]">
          <ArrowLeft className="size-4" aria-hidden /> Elegir otro token
        </Link>
      </div>
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
