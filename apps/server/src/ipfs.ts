// Metadatos del token (Pump.fun exige una URI). Interfaz de proveedor:
// - perfil `test`: almacén local direccionado por hash (nada en Surfpool lee la URI);
// - mainnet: Pinata (API v3, documentación consultada el 2026-11-06):
//   POST https://uploads.pinata.cloud/v3/files · Authorization: Bearer <JWT> · multipart `file` + `network=public`
//   → { data: { cid, … } }. Autenticación: GET https://api.pinata.cloud/data/testAuthentication.
//   Pinata solo sube: la URI que va en cadena se forma con la pasarela pública de Ajustes (https://ipfs.io/ipfs/ por defecto).
import { createHash } from "node:crypto";
import type { Profile } from "@nebula/shared";
import type { DB } from "./db";
import type { Vault } from "./signer";
import { readSecret, remember, scrub, storedSettings } from "./settings";

export type Stored = { cid: string; uri: string };

export interface MetadataStore {
  readonly kind: "local" | "pinata";
  putMedia(bytes: Buffer, contentType: string): Promise<Stored>;
  putJson(obj: unknown): Promise<Stored>;
  /** URI pública de un medio ya subido (la que va dentro del JSON de metadatos). */
  mediaUri(cid: string): string;
  get?(cid: string): { contentType: string; bytes: Buffer } | null;
}

export const LOCAL_URI_PREFIX = "nebula-local://ipfs/";

export class LocalStore implements MetadataStore {
  readonly kind = "local" as const;
  constructor(private db: () => DB) {}
  private put(bytes: Buffer, contentType: string): Stored {
    const cid = `local-${createHash("sha256").update(bytes).digest("hex").slice(0, 46)}`;
    this.db().prepare("INSERT OR IGNORE INTO ipfs_local(cid, content_type, bytes, created_at) VALUES(?, ?, ?, ?)").run(cid, contentType, bytes, Date.now());
    return { cid, uri: `${LOCAL_URI_PREFIX}${cid}` };
  }
  async putMedia(bytes: Buffer, contentType: string) {
    return this.put(bytes, contentType);
  }
  async putJson(obj: unknown) {
    return this.put(Buffer.from(JSON.stringify(obj)), "application/json");
  }
  mediaUri(cid: string) {
    if (!this.get(cid)) throw Object.assign(new Error("La imagen no está subida. Vuelve a subirla en el paso 1."), { statusCode: 400 });
    return `${LOCAL_URI_PREFIX}${cid}`;
  }
  get(cid: string) {
    const r = this.db().prepare("SELECT content_type, bytes FROM ipfs_local WHERE cid = ?").get(cid) as { content_type: string; bytes: Buffer } | undefined;
    return r ? { contentType: r.content_type, bytes: r.bytes } : null;
  }
}

export class MainnetIpfsUnavailable extends Error {}

export type PinataEndpoints = { upload: string; auth: string };
export const PINATA: PinataEndpoints = { upload: "https://uploads.pinata.cloud/v3/files", auth: "https://api.pinata.cloud/data/testAuthentication" };

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "application/json": "json" };

/** Mensaje útil sin eco de la petición (la cabecera lleva el JWT) ni del cuerpo completo. */
async function pinataError(res: Response) {
  let detail = "";
  try {
    const t = (await res.text()).slice(0, 300);
    const j = JSON.parse(t) as { error?: { reason?: string; details?: string } | string; message?: string };
    detail = typeof j.error === "string" ? j.error : (j.error?.details ?? j.error?.reason ?? j.message ?? "");
  } catch {}
  const hint = res.status === 401 || res.status === 403 ? "La clave de Pinata no es válida o no tiene permiso de subida (files: write)." : res.status === 429 ? "Pinata limita las peticiones; espera un minuto." : `Pinata respondió ${res.status}.`;
  return new MainnetIpfsUnavailable(scrub(`${hint}${detail ? ` ${detail}` : ""}`.trim()));
}

export class PinataStore implements MetadataStore {
  readonly kind = "pinata" as const;
  constructor(
    private key: () => string | null,
    private gateway: () => string,
    private endpoints: PinataEndpoints = PINATA,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private jwt() {
    const k = this.key();
    if (!k) throw new MainnetIpfsUnavailable("Falta la clave de Pinata (JWT). Añádela en Ajustes → IPFS; se guarda cifrada en la bóveda.");
    return k;
  }

  private async upload(bytes: Buffer, contentType: string, name: string): Promise<Stored> {
    const jwt = this.jwt();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    form.append("network", "public"); // por defecto Pinata sube en privado: Pump.fun necesita IPFS público
    form.append("name", name);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoints.upload, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new MainnetIpfsUnavailable(scrub(`No se pudo contactar con Pinata: ${(e as Error).message}`));
    }
    if (!res.ok) throw await pinataError(res);
    const body = (await res.json().catch(() => null)) as { data?: { cid?: string } } | null;
    const cid = body?.data?.cid;
    if (!cid || !CID_RE.test(cid)) throw new MainnetIpfsUnavailable("Pinata no devolvió un CID válido.");
    return { cid, uri: `${this.gateway()}${cid}` };
  }

  async putMedia(bytes: Buffer, contentType: string) {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    return this.upload(bytes, contentType, `nebula-${hash}.${EXT[contentType] ?? "bin"}`);
  }

  async putJson(obj: unknown) {
    const bytes = Buffer.from(JSON.stringify(obj));
    return this.upload(bytes, "application/json", `nebula-meta-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.json`);
  }

  mediaUri(cid: string) {
    if (!CID_RE.test(cid)) throw Object.assign(new Error("El CID de la imagen no es válido. Vuelve a subirla en el paso 1."), { statusCode: 400 });
    return `${this.gateway()}${cid}`;
  }

  async testAuth(override?: string): Promise<{ ok: boolean; message: string }> {
    const jwt = override ?? this.key();
    if (!jwt) return { ok: false, message: "No hay clave de Pinata guardada." };
    // una clave escrita para probar, aún sin guardar, también se redacta en todo lo que salga (REVIEW-F1 P3-11)
    remember(jwt);
    try {
      const res = await this.fetchImpl(this.endpoints.auth, { headers: { authorization: `Bearer ${jwt}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { ok: true, message: "Pinata acepta la clave." };
      return { ok: false, message: (await pinataError(res)).message };
    } catch (e) {
      return { ok: false, message: scrub(`No se pudo contactar con Pinata: ${(e as Error).message}`) };
    }
  }
}

export function metadataStoreFor(profile: Profile, db: () => DB, vault: Vault, opts: { pinata?: PinataEndpoints; fetch?: typeof fetch } = {}): MetadataStore {
  if (profile === "test" && !opts.pinata) return new LocalStore(db);
  return new PinataStore(
    () => readSecret(db(), vault, "ipfsKey"),
    () => storedSettings(db()).ipfsGateway,
    opts.pinata ?? PINATA,
    opts.fetch ?? fetch,
  );
}

export async function testIpfsKey(ctx: { launches: { store: MetadataStore } }, key?: string) {
  const s = ctx.launches.store;
  if (s.kind === "local") return { ok: true, message: "Perfil de pruebas: los metadatos se guardan en el almacén local (no se usa Pinata)." };
  return (s as PinataStore).testAuth(key);
}

/** Nunca se acepta una URI local fuera del perfil de pruebas. */
export function assertUriForProfile(profile: Profile, uri: string) {
  if (profile !== "test" && uri.startsWith(LOCAL_URI_PREFIX)) throw Object.assign(new Error("Una URI local no es válida en mainnet."), { statusCode: 400 });
  if (uri.length > 200) throw Object.assign(new Error("La URI de metadatos es demasiado larga."), { statusCode: 400 });
}
