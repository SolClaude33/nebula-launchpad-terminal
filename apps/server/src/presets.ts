// REQ-LAUNCH-018 / REQ-AUTO-009: presets reutilizables del asistente de lanzamiento y de las automatizaciones.
// Se guardan en SQLite (perfil actual). Un preset NUNCA lleva la identidad del token (nombre, símbolo, imagen,
// enlaces) ni la confirmación irreversible de comisiones: eso se revisa en cada lanzamiento. Uno de tarea no
// lleva el mint, para usarlo con cualquier token.
import { z } from "zod";
import { logActivity, type DB } from "./db";

export const PresetKind = z.enum(["launch", "task"]);
export type PresetKind = z.infer<typeof PresetKind>;
export const PresetId = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const MAX_BYTES = 64 * 1024;

/** Campos del borrador que nunca entran en un preset de lanzamiento. */
const LAUNCH_STRIP = ["draftId", "name", "symbol", "description", "image", "upload", "links", "feeAck", "review"];
/** Campos de una tarea que nunca entran en un preset de tarea. */
const TASK_STRIP = ["mint"];

export const SavePresetBody = z.object({
  kind: PresetKind,
  name: z.string().trim().min(1, "Ponle un nombre al preset").max(40, "Máximo 40 caracteres"),
  data: z.record(z.string(), z.unknown()),
});

export type PresetRow = { id: string; kind: PresetKind; name: string; data: Record<string, unknown>; createdAt: number; updatedAt: number };

export function sanitizePreset(kind: PresetKind, data: Record<string, unknown>) {
  const strip = kind === "launch" ? LAUNCH_STRIP : TASK_STRIP;
  return Object.fromEntries(Object.entries(data).filter(([k]) => !strip.includes(k)));
}

export class Presets {
  constructor(private db: () => DB) {}

  list(kind: PresetKind): PresetRow[] {
    const rows = this.db().prepare("SELECT id, kind, name, data, created_at, updated_at FROM preset WHERE kind = ? ORDER BY name COLLATE NOCASE").all(kind) as { id: string; kind: PresetKind; name: string; data: string; created_at: number; updated_at: number }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, data: JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** Crea o actualiza (mismo id). El nombre es único por tipo. */
  save(id: string, input: unknown): PresetRow {
    PresetId.parse(id);
    const body = SavePresetBody.parse(input);
    const data = sanitizePreset(body.kind, body.data);
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_BYTES) throw Object.assign(new Error("El preset es demasiado grande."), { statusCode: 413 });
    const db = this.db();
    const clash = db.prepare("SELECT id FROM preset WHERE kind = ? AND name = ? COLLATE NOCASE AND id != ?").get(body.kind, body.name, id);
    if (clash) throw Object.assign(new Error(`Ya hay un preset llamado «${body.name}».`), { statusCode: 409 });
    const prev = db.prepare("SELECT kind FROM preset WHERE id = ?").get(id) as { kind: string } | undefined;
    if (prev && prev.kind !== body.kind) throw Object.assign(new Error("Ese preset es de otro tipo."), { statusCode: 409 });
    const now = Date.now();
    db.prepare(
      `INSERT INTO preset(id, kind, name, data, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
    ).run(id, body.kind, body.name, json, now, now);
    logActivity(db, "preset.save", `Preset de ${body.kind === "launch" ? "lanzamiento" : "tarea"} «${body.name}» ${prev ? "actualizado" : "guardado"}`);
    return this.list(body.kind).find((p) => p.id === id)!;
  }

  remove(id: string) {
    const db = this.db();
    const r = db.prepare("SELECT kind, name FROM preset WHERE id = ?").get(PresetId.parse(id)) as { kind: string; name: string } | undefined;
    if (!r) throw Object.assign(new Error("Preset no encontrado"), { statusCode: 404 });
    db.prepare("DELETE FROM preset WHERE id = ?").run(id);
    logActivity(db, "preset.delete", `Preset «${r.name}» borrado`);
    return { ok: true };
  }
}
