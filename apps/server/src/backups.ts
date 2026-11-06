// §7.3: copia automática diaria de la base SQLite (que contiene la bóveda cifrada) en la carpeta de datos,
// conservando las últimas 7. Se hace con la API de copia de better-sqlite3 (segura con WAL), no copiando el
// archivo. No necesita la bóveda abierta: las claves ya van cifradas dentro de la base.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db";
import { logActivity } from "./db";

export const KEEP = 7;
const DAY = 86_400_000;
const NAME = /^auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.nebula-vault$/;

export type BackupFile = { name: string; at: number; bytes: number };

export class Backups {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupFile | null> | null = null;

  constructor(
    private db: () => DB,
    private dataDir: string,
    private clock: () => number = Date.now,
    private log: (m: string) => void = () => {},
  ) {}

  get dir() {
    return join(this.dataDir, "backups");
  }

  list(): BackupFile[] {
    mkdirSync(this.dir, { recursive: true });
    return readdirSync(this.dir)
      .filter((f) => NAME.test(f))
      .map((name) => {
        const m = NAME.exec(name)!;
        return { name, at: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), bytes: statSync(join(this.dir, name)).size };
      })
      .sort((a, b) => b.at - a.at);
  }

  /** Ruta de una copia por su nombre exacto (nunca una ruta arbitraria). */
  pathOf(name: string) {
    if (!NAME.test(name) || !this.list().some((b) => b.name === name)) throw Object.assign(new Error("Copia no encontrada"), { statusCode: 404 });
    return join(this.dir, name);
  }

  /** Hace la copia si la última tiene más de 24 h (o si se fuerza) y deja solo las 7 más recientes. */
  run(force = false): Promise<BackupFile | null> {
    this.running ??= this.doRun(force).finally(() => (this.running = null));
    return this.running;
  }

  private async doRun(force: boolean) {
    const now = this.clock();
    const last = this.list()[0];
    if (!force && last && now - last.at < DAY) return null;
    const d = new Date(now);
    const p = (n: number) => String(n).padStart(2, "0");
    const name = `auto-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.nebula-vault`;
    mkdirSync(this.dir, { recursive: true });
    await this.db().backup(join(this.dir, name));
    for (const old of this.list().slice(KEEP)) rmSync(join(this.dir, old.name), { force: true });
    const made = this.list().find((b) => b.name === name) ?? null;
    logActivity(this.db(), "vault.backup.auto", `Copia automática ${name} (${made ? Math.round(made.bytes / 1024) : 0} KB); se conservan las últimas ${KEEP}`);
    this.log(`Copia automática ${name}`);
    return made;
  }

  /** Comprueba al arrancar y cada hora (el proceso puede pasar días abierto). */
  start(intervalMs = 3600_000) {
    void this.run().catch((e) => this.log(`Copia automática fallida: ${(e as Error).message}`));
    this.timer ??= setInterval(() => void this.run().catch((e) => this.log(`Copia automática fallida: ${(e as Error).message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
