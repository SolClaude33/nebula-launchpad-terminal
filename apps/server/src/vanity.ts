// REQ-LAUNCH-006: dirección de mint personalizada (vanity), generándola en local o importando su clave.
// - La búsqueda corre en worker_threads (vanity-worker.mjs) y se puede cancelar: el hilo principal sigue libre.
// - La clave encontrada o importada va directa a la bóveda (tabla mint_key) y se liga al borrador
//   (kv `vanityMint:<borrador>`). El dry-run la usa mientras el lanzamiento no se haya enviado nunca.
// - Nunca se reutiliza un mint gastado: se rechaza uno que ya exista en cadena o que use otro lanzamiento.
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { parseSecret, VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";

export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Longitud total máxima (prefijo + sufijo): 5 caracteres ≈ 656 M intentos, ~1 h con 8 hilos. */
export const MAX_PATTERN = 5;
export const workerCount = () => Math.max(1, Math.min(8, availableParallelism() - 2));

/** Intentos esperados: por cada carácter, 58 / variantes válidas (1, o 2 sin distinguir mayúsculas). */
export function expectedAttempts(prefix: string, suffix: string, ci: boolean) {
  let n = 1;
  for (const c of prefix + suffix) {
    const variants = ci ? new Set([c.toLowerCase(), c.toUpperCase()].filter((v) => B58.includes(v))).size : B58.includes(c) ? 1 : 0;
    n *= 58 / Math.max(variants, 1);
  }
  return Math.round(n);
}

export function patternIssue(prefix: string, suffix: string, ci: boolean) {
  const all = prefix + suffix;
  if (!all) return "Indica un prefijo o un sufijo.";
  if (all.length > MAX_PATTERN) return `Como máximo ${MAX_PATTERN} caracteres entre prefijo y sufijo (cada uno más multiplica por ~58 el tiempo).`;
  for (const c of all) {
    const ok = ci ? B58.includes(c.toLowerCase()) || B58.includes(c.toUpperCase()) : B58.includes(c);
    if (!ok) return `«${c}» no existe en base58 (no se usan 0, O, I ni l).`;
  }
  // El primer carácter de una dirección de 32 bytes casi nunca es «1» (exigiría un byte inicial 0)
  if (prefix.startsWith("1")) return "Un prefijo que empieza por «1» es prácticamente imposible.";
  return null;
}

type Job = { draftId: string; prefix: string; suffix: string; ci: boolean; status: "RUNNING" | "FOUND" | "CANCELLED" | "FAILED"; attempts: number; expected: number; startedAt: number; endedAt: number | null; address: string | null; error: string | null; workers: Worker[] };

export class Vanity {
  private jobs = new Map<string, Job>();

  constructor(
    private db: () => DB,
    private vault: Vault,
    private chain: ChainManager,
    private log: (m: string) => void,
  ) {}

  private locked() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
  }

  /** Borrador que ya se lanzó (o se está lanzando): su mint no se puede cambiar. */
  private launchedDraft(draftId: string) {
    const r = this.db().prepare("SELECT status FROM launch WHERE id = ?").get(draftId) as { status: string } | undefined;
    const sent = this.db().prepare("SELECT 1 FROM tx WHERE idempotency_key = ?").get(`launch:${draftId}:create`);
    return !!sent || (!!r && r.status !== "PREPARED" && r.status !== "FAILED");
  }

  bound(draftId: string) {
    return (JSON.parse(kvGet(this.db(), `vanityMint:${draftId}`) ?? "null") as { address: string } | null)?.address ?? null;
  }

  status(draftId: string) {
    const j = this.jobs.get(draftId);
    const elapsed = j ? ((j.endedAt ?? Date.now()) - j.startedAt) / 1000 : 0;
    return {
      bound: this.bound(draftId),
      job: j ? { prefix: j.prefix, suffix: j.suffix, ci: j.ci, status: j.status, attempts: j.attempts, expected: j.expected, ratePerSec: elapsed > 0 ? Math.round(j.attempts / elapsed) : 0, elapsedSec: Math.round(elapsed), address: j.address, error: j.error } : null,
      workers: workerCount(),
    };
  }

  private assertEditable(draftId: string) {
    if (this.launchedDraft(draftId)) throw Object.assign(new Error("Este lanzamiento ya se envió: su mint no se puede cambiar."), { statusCode: 409 });
  }

  /** Comprueba que el mint no esté gastado ni en uso y lo liga al borrador (la clave ya está en la bóveda). */
  private async bind(draftId: string, address: string) {
    const other = this.db().prepare("SELECT id FROM launch WHERE mint = ? AND id != ?").get(address, draftId);
    if (other) throw Object.assign(new Error("Ese mint ya lo usa otro lanzamiento."), { statusCode: 409 });
    if (await this.chain.get().reader.accountExists(address)) throw Object.assign(new Error("Ese mint ya existe en la cadena: no se puede volver a crear."), { statusCode: 409 });
    kvSet(this.db(), `vanityMint:${draftId}`, JSON.stringify({ address }));
  }

  start(draftId: string, p: { prefix: string; suffix: string; ci: boolean }) {
    this.locked();
    this.assertEditable(draftId);
    const issue = patternIssue(p.prefix, p.suffix, p.ci);
    if (issue) throw Object.assign(new Error(issue), { statusCode: 400 });
    if (this.jobs.get(draftId)?.status === "RUNNING") throw Object.assign(new Error("Ya hay una búsqueda en marcha para este borrador."), { statusCode: 409 });
    const job: Job = { draftId, ...p, status: "RUNNING", attempts: 0, expected: expectedAttempts(p.prefix, p.suffix, p.ci), startedAt: Date.now(), endedAt: null, address: null, error: null, workers: [] };
    this.jobs.set(draftId, job);
    const stop = (status: Job["status"], error: string | null = null) => {
      if (job.status !== "RUNNING") return;
      job.status = status;
      job.error = error;
      job.endedAt = Date.now();
      for (const w of job.workers) void w.terminate();
    };
    let finishing = false;
    for (let i = 0; i < workerCount(); i++) {
      const w = new Worker(new URL("./vanity-worker.mjs", import.meta.url), { workerData: p });
      job.workers.push(w);
      w.on("message", (m: { attempts: number; found?: { seed: string; pub: string } }) => {
        if (finishing) return;
        job.attempts += m.attempts;
        if (!m.found || job.status !== "RUNNING") return;
        // Se paran los hilos ya, pero el estado sigue RUNNING hasta que el mint está sellado y ligado: así quien
        // sondea nunca ve FOUND sin dirección
        finishing = true;
        for (const x of job.workers) void x.terminate();
        const sk = Buffer.concat([Buffer.from(m.found.seed, "hex"), Buffer.from(m.found.pub, "hex")]);
        void (async () => {
          try {
            const address = await this.vault.importMintKey(sk);
            await this.bind(draftId, address);
            job.address = address;
            stop("FOUND");
            logActivity(this.db(), "launch.vanity", `Mint vanity encontrado tras ${job.attempts.toLocaleString("es-ES")} intentos: ${address}`);
          } catch (e) {
            stop("FAILED", (e as Error).message);
          } finally {
            sk.fill(0);
          }
        })();
      });
      w.on("error", (e) => {
        if (finishing) return;
        this.log(`Vanity: un hilo falló: ${e.message}`);
        stop("FAILED", e.message);
      });
    }
    return this.status(draftId);
  }

  cancel(draftId: string) {
    const j = this.jobs.get(draftId);
    if (j && j.status === "RUNNING") {
      j.status = "CANCELLED";
      j.endedAt = Date.now();
      for (const w of j.workers) void w.terminate();
    }
    return this.status(draftId);
  }

  /** Al bloquear la bóveda o cerrar: se paran todas las búsquedas. */
  cancelAll() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  async importKey(draftId: string, secret: string) {
    this.locked();
    this.assertEditable(draftId);
    const parsed = await parseSecret(secret);
    if ("error" in parsed) throw Object.assign(new Error(`Clave no válida: ${parsed.error}`), { statusCode: 400 });
    const used = this.db().prepare("SELECT 1 FROM wallet WHERE address = ?").get(parsed.address);
    if (used) {
      parsed.sk.fill(0);
      throw Object.assign(new Error("Esa clave es de una wallet de la bóveda, no de un mint."), { statusCode: 400 });
    }
    if (await this.chain.get().reader.accountExists(parsed.address)) {
      parsed.sk.fill(0);
      throw Object.assign(new Error("Ese mint ya existe en la cadena: no se puede volver a crear."), { statusCode: 409 });
    }
    const address = await this.vault.importMintKey(parsed.sk);
    await this.bind(draftId, address);
    logActivity(this.db(), "launch.vanity", `Mint importado para el borrador: ${address}`);
    return this.status(draftId);
  }

  /** Vuelve a un mint aleatorio (la clave vanity se queda en la bóveda, sin usar). */
  unbind(draftId: string) {
    this.assertEditable(draftId);
    kvSet(this.db(), `vanityMint:${draftId}`, "null");
    return this.status(draftId);
  }
}
