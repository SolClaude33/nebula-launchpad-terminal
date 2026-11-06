"use client";

import { SESSION_HEADER, STEP_UP_HEADER } from "@nebula/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryInSec = 0,
  ) {
    super(message);
  }
}

const token = () => (typeof document === "undefined" ? "" : (document.querySelector('meta[name="nebula-session"]')?.getAttribute("content") ?? ""));

export const apiAvailable = () => token().length > 0;

type Opts = { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; stepUp?: string; raw?: boolean };

/** Cliente de la API local. El token va en una cabecera propia (nunca en la URL). */
export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { [SESSION_HEADER]: token() };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.stepUp) headers[STEP_UP_HEADER] = opts.stepUp;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: "no-store" });
  } catch {
    throw new ApiError(0, "OFFLINE", "No hay conexión con la API local.");
  }
  if (opts.raw && res.ok) return (await res.blob()) as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 500 && !data.code) throw new ApiError(503, "OFFLINE", "La API local no responde. ¿Está corriendo `pnpm dev`?");
    // La API se reinició y generó un token nuevo: recarga una vez para recibirlo en el HTML.
    if (data.code === "BAD_SESSION") recoverSession();
    throw new ApiError(res.status, data.code ?? "ERROR", data.message ?? `Error ${res.status}`, data.retryInSec ?? 0);
  }
  return data as T;
}

function recoverSession() {
  try {
    const last = Number(sessionStorage.getItem("nebula.sessionReload") ?? 0);
    if (Date.now() - last < 15_000) return; // evita bucles si la API sigue caída
    sessionStorage.setItem("nebula.sessionReload", String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}

/** Reconfirmación de contraseña (REQ-VAULT-004): devuelve un token de un solo uso para una acción. */
export async function confirmAction(password: string, action: string) {
  const r = await api<{ token: string }>("/vault/confirm", { method: "POST", body: { password, action } });
  return r.token;
}
