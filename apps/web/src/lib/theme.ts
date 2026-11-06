"use client";

// Tema (REQ-SET-001): se aplica al instante desde localStorage (sin parpadeo) y se guarda también en Ajustes.
import { create } from "zustand";
import { api } from "@/lib/api";

export type Theme = "dark" | "light";

export const useTheme = create<{ theme: Theme; set: (t: Theme, persist?: boolean) => void }>((set) => ({
  theme: "dark",
  set: (t, persist = true) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("nebula.theme", t);
    } catch {}
    set({ theme: t });
    if (persist) api("/settings", { method: "PUT", body: { theme: t } }).catch(() => {});
  },
}));

export function storedTheme(): Theme {
  try {
    return localStorage.getItem("nebula.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
