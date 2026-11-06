"use client";

import { useRef, useState } from "react";
import { CloudUpload, Copy, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { fieldErrors, useDraft } from "@/lib/draft";
import { Field, SectionTitle } from "./ui";

const IMG_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const VID_TYPES = ["video/mp4", "video/webm"];

export function StepToken() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const fe = fieldErrors(d);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [cloneAddr, setCloneAddr] = useState("");
  const [cloning, setCloning] = useState(false);

  function upload(fail: boolean) {
    set({ ipfs: { status: "uploading", progress: 0 } });
    let p = 0;
    const id = setInterval(() => {
      p += 9 + Math.random() * 14;
      if (fail && p > 62) {
        clearInterval(id);
        set({ ipfs: { status: "error", progress: 62, error: "El nodo de IPFS no respondió (timeout 15 s)." }, failNextUpload: false });
        return;
      }
      if (p >= 100) {
        clearInterval(id);
        set({ ipfs: { status: "done", progress: 100, cid: "bafkreih5t7nebula3demo2cid4metadata6json7qx" } });
        return;
      }
      set({ ipfs: { status: "uploading", progress: p } });
    }, 160);
  }

  function onFile(f: File | undefined) {
    setFileError(null);
    if (!f) return;
    const isImg = IMG_TYPES.includes(f.type);
    const isVid = VID_TYPES.includes(f.type);
    if (!isImg && !isVid) return setFileError("Formato no admitido. Usa JPG, PNG, GIF, WebP, MP4 o WebM.");
    if (isImg && f.size > 2 * 1024 * 1024) return setFileError("La imagen supera 2 MB.");
    if (isVid && f.size > 10 * 1024 * 1024) return setFileError("El vídeo supera 10 MB.");
    const finish = (url: string) => {
      set({ image: { name: f.name, size: f.size, type: f.type, url } });
      upload(useDraft.getState().draft.failNextUpload);
    };
    if (isImg) {
      const r = new FileReader();
      r.onload = () => finish(String(r.result));
      r.readAsDataURL(f);
    } else finish(URL.createObjectURL(f));
  }

  function clone() {
    if (cloneAddr.trim().length < 32) return;
    setCloning(true);
    setTimeout(() => {
      set({ name: "Kepler", symbol: "KEPLER", description: "Un gato que mide órbitas. Clonado como punto de partida: revisa y edita todo.", links: { x: "https://x.com/kepler_demo", telegram: "", web: "" } });
      setCloning(false);
    }, 700);
  }

  const ipfs = d.ipfs;

  return (
    <div className="rise">
      <SectionTitle index="Paso 1 de 4 · Token" title="Identidad del token" body="Nombre, símbolo, imagen y enlaces. Todo se sube a IPFS antes de poder lanzar." />

      <div className="panel mb-6 flex items-center gap-3 p-3">
        <Copy className="ml-1 size-4 shrink-0 text-faint" aria-hidden />
        <label htmlFor="clone" className="sr-only">
          Clonar metadatos desde una dirección
        </label>
        <input id="clone" value={cloneAddr} onChange={(e) => setCloneAddr(e.target.value)} placeholder="Clonar metadatos desde una dirección de mint…" className="num min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint" />
        <button onClick={clone} disabled={cloneAddr.trim().length < 32 || cloning} className="btn h-8">
          {cloning && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {cloning ? "Leyendo…" : "Clonar"}
        </button>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-6">
        {/* Media */}
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Imagen o vídeo</p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              onFile(e.dataTransfer.files[0]);
            }}
            className={`relative aspect-square overflow-hidden rounded-[var(--radius-lg)] border border-dashed transition-colors ${drag ? "border-accent-b bg-accent-b/5" : "border-line-strong bg-surface-1"}`}
          >
            {d.image ? (
              d.image.type.startsWith("video") ? (
                <video src={d.image.url} className="size-full object-cover" muted loop autoPlay playsInline />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.image.url} alt={`Vista previa de ${d.image.name}`} className="size-full object-cover" />
              )
            ) : (
              <button onClick={() => fileRef.current?.click()} className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-muted transition-colors hover:text-fg">
                <ImagePlus className="size-7" aria-hidden />
                <span className="text-[13px]">Arrastra o elige un archivo</span>
                <span className="text-[11.5px] text-faint">JPG, PNG, GIF, WebP ≤ 2 MB · MP4, WebM ≤ 10 MB · recorte 1:1</span>
              </button>
            )}
            {d.image && ipfs.status === "uploading" && (
              <div className="absolute inset-x-0 bottom-0 bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] p-3 backdrop-blur">
                <div className="flex justify-between text-[11.5px]">
                  <span>Subiendo a IPFS…</span>
                  <span className="num">{Math.round(ipfs.progress)} %</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-150" style={{ width: `${ipfs.progress}%` }} />
                </div>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept={[...IMG_TYPES, ...VID_TYPES].join(",")} className="sr-only" id="image" onChange={(e) => onFile(e.target.files?.[0])} />
          <div aria-live="polite" className="mt-2 space-y-2 text-[12px]">
            {fileError && <p className="text-sell">{fileError}</p>}
            {ipfs.status === "done" && (
              <p className="flex items-center gap-1.5 text-buy">
                <CloudUpload className="size-3.5" aria-hidden /> En IPFS · <span className="num text-muted">{ipfs.cid?.slice(0, 14)}…</span>
              </p>
            )}
            {ipfs.status === "error" && <p className="text-sell">{ipfs.error}</p>}
            {d.image && (
              <div className="flex gap-1.5">
                {ipfs.status === "error" && (
                  <button onClick={() => upload(false)} className="btn h-8 flex-1">
                    <RotateCcw className="size-3.5" aria-hidden /> Volver a subir
                  </button>
                )}
                <button onClick={() => fileRef.current?.click()} className="btn h-8 flex-1">
                  Cambiar
                </button>
                <button onClick={() => set({ image: undefined, ipfs: { status: "idle", progress: 0 } })} className="btn h-8 px-2.5" aria-label="Quitar archivo">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-faint">
              <input type="checkbox" checked={d.failNextUpload} onChange={(e) => set({ failNextUpload: e.target.checked })} className="size-3.5 accent-[var(--accent-a)]" />
              Simular fallo de IPFS (prueba)
            </label>
          </div>
        </div>

        {/* Texto */}
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <Field id="name" label="Nombre" error={fe.name} hint={`${d.name.length}/32`}>
              <input id="name" value={d.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={!!fe.name} aria-describedby="name-msg" placeholder="Kepler" className="field h-10" />
            </Field>
            <Field id="symbol" label="Símbolo" error={fe.symbol} hint="A–Z y 0–9">
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint">$</span>
                <input id="symbol" value={d.symbol} onChange={(e) => set({ symbol: e.target.value.toUpperCase().replace(/\s/g, "") })} aria-invalid={!!fe.symbol} aria-describedby="symbol-msg" placeholder="KEPLER" className="field num h-10 pl-6 uppercase" />
              </div>
            </Field>
          </div>
          <Field id="description" label="Descripción" optional error={fe.description} hint={`${d.description.length}/500`}>
            <textarea id="description" rows={4} value={d.description} onChange={(e) => set({ description: e.target.value })} aria-invalid={!!fe.description} aria-describedby="description-msg" placeholder="Qué es y por qué existe, en dos frases." className="field resize-none leading-relaxed" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field id="x" label="X" optional error={fe.x}>
              <input id="x" value={d.links.x} onChange={(e) => set({ links: { ...d.links, x: e.target.value.trim() } })} aria-invalid={!!fe.x} aria-describedby="x-msg" placeholder="https://x.com/…" className="field h-10" />
            </Field>
            <Field id="telegram" label="Telegram" optional error={fe.telegram}>
              <input id="telegram" value={d.links.telegram} onChange={(e) => set({ links: { ...d.links, telegram: e.target.value.trim() } })} aria-invalid={!!fe.telegram} aria-describedby="telegram-msg" placeholder="https://t.me/…" className="field h-10" />
            </Field>
            <Field id="web" label="Web" optional error={fe.web}>
              <input id="web" value={d.links.web} onChange={(e) => set({ links: { ...d.links, web: e.target.value.trim() } })} aria-invalid={!!fe.web} aria-describedby="web-msg" placeholder="https://…" className="field h-10" />
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}
