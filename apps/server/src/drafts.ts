// REQ-LAUNCH-004: borradores del asistente guardados en SQLite. El contenido es el estado del formulario
// (lo valida el asistente y, al lanzar, LaunchConfig); aquí solo se limita el tamaño y se indexa nombre y símbolo.
import { z } from "zod";
import type { DB } from "./db";

export const DraftId = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const MAX_BYTES = 3 * 1024 * 1024; // la vista previa de una imagen de 2 MB en base64 cabe

export type DraftRow = { id: string; name: string; symbol: string; updatedAt: number; createdAt: number; launch: { status: string; mint: string } | null; image: string | null; mode: string | null };

const UNLAUNCHED = "(l.id IS NULL OR l.status IN ('PREPARED','FAILED'))";

export class Drafts {
  constructor(private db: () => DB) {}

  /** Borradores aún sin lanzar (sin lanzamiento, o con un dry-run preparado o fallido). */
  list(): DraftRow[] {
    const rows = this.db()
      .prepare(
        `SELECT d.id, d.name, d.symbol, d.data, d.created_at, d.updated_at, l.status AS lstatus, l.mint AS lmint
         FROM launch_draft d LEFT JOIN launch l ON l.id = d.id
         WHERE d.archived = 0 AND ${UNLAUNCHED}
         ORDER BY d.updated_at DESC`,
      )
      .all() as { id: string; name: string; symbol: string; data: string; created_at: number; updated_at: number; lstatus: string | null; lmint: string | null }[];
    return rows.map((r) => {
      let image: string | null = null;
      let mode: string | null = null;
      try {
        const d = JSON.parse(r.data) as { image?: { url?: string; type?: string }; launchMode?: string };
        image = d.image?.url && d.image.type?.startsWith("image/") && d.image.url.length < 400_000 ? d.image.url : null;
        mode = d.launchMode ?? null;
      } catch {}
      return { id: r.id, name: r.name, symbol: r.symbol, createdAt: r.created_at, updatedAt: r.updated_at, launch: r.lstatus ? { status: r.lstatus, mint: r.lmint! } : null, image, mode };
    });
  }

  count() {
    return (this.db().prepare(`SELECT COUNT(*) AS n FROM launch_draft d LEFT JOIN launch l ON l.id = d.id WHERE d.archived = 0 AND ${UNLAUNCHED}`).get() as { n: number }).n;
  }

  get(id: string) {
    const r = this.db().prepare("SELECT data, updated_at FROM launch_draft WHERE id = ?").get(DraftId.parse(id)) as { data: string; updated_at: number } | undefined;
    if (!r) throw Object.assign(new Error("Borrador no encontrado"), { statusCode: 404 });
    return { id, data: JSON.parse(r.data) as Record<string, unknown>, updatedAt: r.updated_at };
  }

  save(id: string, data: Record<string, unknown>) {
    DraftId.parse(id);
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_BYTES) throw Object.assign(new Error("El borrador es demasiado grande (la vista previa de la imagen no cabe)."), { statusCode: 413 });
    const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
    const now = Date.now();
    this.db()
      .prepare(
        `INSERT INTO launch_draft(id, data, name, symbol, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, name = excluded.name, symbol = excluded.symbol, archived = 0, updated_at = excluded.updated_at`,
      )
      .run(id, json, str(data.name, 64), str(data.symbol, 16), now, now);
    return { id, updatedAt: now };
  }

  /** Descartar: se borra el borrador (un lanzamiento ya hecho no se toca: su configuración vive en `launch`). */
  remove(id: string) {
    this.db().prepare("DELETE FROM launch_draft WHERE id = ?").run(DraftId.parse(id));
    return { ok: true };
  }

  /** El último borrador sin lanzar, para que «Lanzar token» retome lo que se dejó a medias. */
  latest() {
    return this.list()[0] ?? null;
  }
}
