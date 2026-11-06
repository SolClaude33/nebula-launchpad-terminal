import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";

export type PausedItem = { id: string; kind: string; label: string };

/** Nunca se reanuda sola una tarea que mueve fondos: todo lo RUNNING pasa a PAUSED y queda listado. */
export function pauseRunningTasks(db: DB, reason: "lock" | "restart") {
  const rows = db.prepare("SELECT id, type, label FROM task WHERE status = 'RUNNING'").all() as { id: string; type: string; label: string }[];
  if (rows.length === 0) return [];
  db.prepare("UPDATE task SET status = 'PAUSED', updated_at = ? WHERE status = 'RUNNING'").run(Date.now());
  const prev = pausedList(db);
  // las tareas de la tabla task son automatizaciones (DCA, límite): se reanudan con /automations/:id/resume
  const items = [...prev.filter((p) => !rows.some((r) => r.id === p.id)), ...rows.map((r) => ({ id: r.id, kind: "automatización", label: r.label }))];
  kvSet(db, "paused", JSON.stringify(items));
  logActivity(db, "tasks.paused", `${rows.length} tareas en pausa (${reason === "lock" ? "bloqueo" : "reinicio"})`);
  return rows;
}

export function pausedList(db: DB): PausedItem[] {
  try {
    return JSON.parse(kvGet(db, "paused") ?? "[]");
  } catch {
    return [];
  }
}

export function clearPaused(db: DB, ids?: string[]) {
  const left = ids ? pausedList(db).filter((p) => !ids.includes(p.id)) : [];
  kvSet(db, "paused", JSON.stringify(left));
}
