// Metadatos del token (Pump.fun exige una URI). Interfaz de proveedor:
// - perfil `test`: almacén local direccionado por hash (nada en Surfpool lee la URI);
// - mainnet: un proveedor real (Pinata) que aún NO está verificado contra su documentación actual,
//   así que los lanzamientos en mainnet quedan bloqueados con un mensaje claro.
import { createHash } from "node:crypto";
import type { Profile } from "@nebula/shared";
import type { DB } from "./db";

export type Stored = { cid: string; uri: string };

export interface MetadataStore {
  readonly kind: "local" | "pinata";
  putMedia(bytes: Buffer, contentType: string): Promise<Stored>;
  putJson(obj: unknown): Promise<Stored>;
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
  get(cid: string) {
    const r = this.db().prepare("SELECT content_type, bytes FROM ipfs_local WHERE cid = ?").get(cid) as { content_type: string; bytes: Buffer } | undefined;
    return r ? { contentType: r.content_type, bytes: r.bytes } : null;
  }
}

export class MainnetIpfsUnavailable extends Error {}

export function metadataStoreFor(profile: Profile, db: () => DB): MetadataStore {
  if (profile === "test") return new LocalStore(db);
  return {
    kind: "pinata",
    putMedia: async () => {
      throw new MainnetIpfsUnavailable("La subida a IPFS para mainnet (Pinata) aún no está verificada; los lanzamientos en mainnet están bloqueados.");
    },
    putJson: async () => {
      throw new MainnetIpfsUnavailable("La subida a IPFS para mainnet (Pinata) aún no está verificada; los lanzamientos en mainnet están bloqueados.");
    },
  };
}

/** Nunca se acepta una URI local fuera del perfil de pruebas. */
export function assertUriForProfile(profile: Profile, uri: string) {
  if (profile !== "test" && uri.startsWith(LOCAL_URI_PREFIX)) throw Object.assign(new Error("Una URI local no es válida en mainnet."), { statusCode: 400 });
  if (uri.length > 200) throw Object.assign(new Error("La URI de metadatos es demasiado larga."), { statusCode: 400 });
}
