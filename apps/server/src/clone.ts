// REQ-LAUNCH-005: clonar los metadatos de un token existente. Solo rellena el formulario del asistente:
// todo se puede editar y nada se lanza. La imagen se vuelve a subir al almacén propio (local en pruebas,
// Pinata en mainnet) para que el borrador quede con la subida hecha.
// Descargar una URI elegida por terceros es arriesgado: solo https, solo hosts públicos (se comprueba la IP
// resuelta en cada salto de redirección), tiempo y tamaño limitados, y tipos de imagen admitidos.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { DB } from "./db";
import type { ChainManager } from "./chain-manager";
import { LOCAL_URI_PREFIX, type MetadataStore } from "./ipfs";

const JSON_MAX = 64 * 1024;
const IMAGE_MAX = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Pasarelas de respaldo para contenido IPFS. ipfs.io, dweb.link, w3s.link y nftstorage.link responden 429 casi
 * siempre a peticiones automáticas (medido el 2026-11-07); estas sirvieron el JSON y la imagen de tokens reales.
 * pump.mypinata.cloud es la pasarela de Pump.fun y la más rápida para sus tokens.
 */
export const IPFS_FALLBACK_GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://4everland.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

/** URLs a probar en orden: la original y, si es contenido IPFS, el mismo CID por la pasarela de Ajustes y las de respaldo. */
export function ipfsCandidates(uri: string, gateway: string, fallbacks: string[] = IPFS_FALLBACK_GATEWAYS) {
  const url = uri.startsWith("ipfs://") ? `${gateway}${uri.slice(7).replace(/^ipfs\//, "")}` : uri;
  const cid = /\/ipfs\/([A-Za-z0-9]{32,100}(?:\/[^?#]*)?)/.exec(url)?.[1];
  return [url, ...(cid ? [gateway, ...fallbacks].map((g) => `${g}${cid}`) : [])].filter((v, i, a) => a.indexOf(v) === i);
}

export class CloneError extends Error {
  statusCode = 422;
}

/** IPv4/IPv6 privadas, de loopback, link-local o reservadas: nunca se descargan. */
export function isPrivateIp(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublicHttps(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CloneError("La URI de metadatos no es una URL válida.");
  }
  if (u.protocol !== "https:") throw new CloneError("Solo se descargan metadatos por https.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.length === 0) throw new CloneError(`No se pudo resolver ${host}.`);
  if (ips.some(isPrivateIp)) throw new CloneError("La URI apunta a una dirección privada o local: no se descarga.");
  return u;
}

/** GET con límite de tamaño y tiempo; sigue hasta 3 redirecciones comprobando cada destino. */
export async function safeFetch(url: string, maxBytes: number, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Buffer; contentType: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicHttps(current);
    const res = await fetchImpl(u, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json, image/*" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok) throw new CloneError(`La descarga respondió ${res.status}.`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) throw new CloneError("El archivo es demasiado grande.");
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new CloneError("El archivo es demasiado grande.");
        }
        parts.push(value);
      }
    return { bytes: Buffer.concat(parts), contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
  }
  throw new CloneError("Demasiadas redirecciones.");
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const link = (v: unknown, hosts?: string[]) => {
  const s = clip(v, 200);
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return "";
    return u.toString();
  } catch {
    return "";
  }
};
/** Detecta el tipo de imagen por su firma (no por la cabecera, que la pone un tercero). */
function sniff(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export type CloneResult = {
  mint: string;
  source: "nebula" | "chain";
  name: string;
  symbol: string;
  description: string;
  links: { x: string; telegram: string; web: string };
  image: { cid: string; uri: string; contentType: string; size: number; preview: string | null } | null;
  warnings: string[];
};

export class Cloner {
  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private store: MetadataStore,
    private gateway: () => string,
    private fetchImpl: typeof fetch = fetch,
    private fallbacks: string[] = IPFS_FALLBACK_GATEWAYS,
  ) {}

  private async resolve(uri: string, maxBytes: number) {
    if (uri.startsWith(LOCAL_URI_PREFIX)) {
      const got = this.store.get?.(uri.slice(LOCAL_URI_PREFIX.length));
      if (!got) throw new CloneError("La URI local no existe en este almacén.");
      return { bytes: got.bytes, contentType: got.contentType };
    }
    // Si es contenido de IPFS y la pasarela falla (p. ej. 429 de ipfs.io), el mismo CID se pide por otras
    let last: unknown;
    for (const c of ipfsCandidates(uri, this.gateway(), this.fallbacks)) {
      try {
        return await safeFetch(c, maxBytes, this.fetchImpl);
      } catch (e) {
        last = e;
        if (e instanceof CloneError && /privada|https|grande/.test(e.message)) throw e; // no es un fallo de la pasarela
      }
    }
    throw last;
  }

  async clone(mint: string): Promise<CloneResult> {
    const warnings: string[] = [];
    const own = this.db().prepare("SELECT config FROM launch WHERE mint = ? LIMIT 1").get(mint) as { config: string } | undefined;
    let base: { name: string; symbol: string; uri: string } | null = null;
    if (own) {
      const c = JSON.parse(own.config) as { name: string; symbol: string; uri: string };
      base = { name: c.name, symbol: c.symbol, uri: c.uri };
    } else base = await this.chain.get().reader.tokenMetadata(mint);
    if (!base) throw new CloneError("Ese token no tiene metadatos en cadena.");

    let meta: Record<string, unknown> = {};
    if (base.uri) {
      try {
        const j = await this.resolve(base.uri, JSON_MAX);
        meta = JSON.parse(j.bytes.toString("utf8")) as Record<string, unknown>;
      } catch (e) {
        warnings.push(`No se pudo leer el JSON de metadatos: ${(e as Error).message}`);
      }
    } else warnings.push("El token no tiene URI de metadatos.");

    let image: CloneResult["image"] = null;
    const img = clip(meta.image, 400);
    if (img) {
      try {
        const got = await this.resolve(img, IMAGE_MAX);
        const type = sniff(got.bytes);
        if (!type || !IMAGE_TYPES.includes(type)) throw new CloneError("La imagen no es PNG, JPG, GIF ni WebP.");
        const up = await this.store.putMedia(got.bytes, type);
        image = { cid: up.cid, uri: up.uri, contentType: type, size: got.bytes.length, preview: got.bytes.length <= 1_500_000 ? `data:${type};base64,${got.bytes.toString("base64")}` : null };
      } catch (e) {
        warnings.push(`Imagen: ${(e as Error).message} Súbela a mano en el paso 1.`);
      }
    }

    const symbol = clip(meta.symbol ?? base.symbol, 32).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    return {
      mint,
      source: own ? "nebula" : "chain",
      name: clip(meta.name ?? base.name, 32) || base.name.slice(0, 32),
      symbol,
      description: clip(meta.description, 500),
      links: { x: link(meta.twitter, ["x.com", "twitter.com"]), telegram: link(meta.telegram, ["t.me", "telegram.me"]), web: link(meta.website) },
      image,
      warnings,
    };
  }
}
