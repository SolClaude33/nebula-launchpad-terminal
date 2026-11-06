"use client";

import { create } from "zustand";

export type ToastTone = "buy" | "sell" | "info" | "warn" | "error";
export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  lines?: { label: string; status: "ok" | "failed" | "skipped"; detail?: string }[];
  href?: string;
};

type ToastState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
};

let n = 0;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++n;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.lines ? 7000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = (t: Omit<Toast, "id">) => useToasts.getState().push(t);
