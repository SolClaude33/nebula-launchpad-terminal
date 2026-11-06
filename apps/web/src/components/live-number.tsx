"use client";

import { useEffect, useRef, useState } from "react";

/** Cifra que hace count-up al cambiar y destella en verde o rojo según la dirección. */
export function LiveNumber({ value, format, className = "" }: { value: number; format: (v: number) => string; className?: string }) {
  const [shown, setShown] = useState(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const [k, setK] = useState(0);
  const prev = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to) return;
    setDir(to > from ? "up" : "down");
    setK((x) => x + 1);
    prev.current = to;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(to);
      return;
    }
    const start = performance.now();
    const dur = 380;
    cancelAnimationFrame(raf.current);
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(from + (to - from) * e);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return (
    <span key={k} className={`num ${dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : ""} ${className}`}>
      {format(shown)}
    </span>
  );
}
