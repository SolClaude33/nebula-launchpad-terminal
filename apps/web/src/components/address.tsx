"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { shortAddr } from "@/lib/format";

export function Address({ value, kind = "account", head = 4, tail = 4, className = "" }: { value: string; kind?: "account" | "tx" | "token"; head?: number; tail?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const path = kind === "tx" ? "tx" : kind === "token" ? "token" : "account";
  return (
    <span className={`group/addr inline-flex items-center gap-1 ${className}`}>
      <span className="num">{shortAddr(value, head, tail)}</span>
      <button onClick={copy} aria-label={copied ? "Copiado" : "Copiar dirección"} className="grid size-5 place-items-center rounded text-faint opacity-60 transition-opacity group-hover/addr:opacity-100 hover:text-fg focus-visible:opacity-100">
        {copied ? <Check className="size-3 text-buy" /> : <Copy className="size-3" />}
      </button>
      <a href={`https://solscan.io/${path}/${value}`} target="_blank" rel="noreferrer" aria-label="Abrir en Solscan" className="grid size-5 place-items-center rounded text-faint opacity-60 transition-opacity group-hover/addr:opacity-100 hover:text-fg focus-visible:opacity-100">
        <ExternalLink className="size-3" />
      </a>
    </span>
  );
}
