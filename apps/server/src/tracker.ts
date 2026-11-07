// REQ-LIVE-006: lista de seguimiento de tokens. Cada token se lee con `tokenInfo` (estado de la curva o del
// pool) y el precio SOL/USD de Pyth, con caché de 20 s y como mucho 3 lecturas a la vez: NO se arranca el
// indexer del Live por cada token, para no gastar el cupo del RPC (Helius Free: 8 peticiones/s).
import type { DB } from "./db";
import { logActivity } from "./db";
import type { ChainManager } from "./chain-manager";

export const TRACKER_MAX = 50;
const TTL_MS = 20_000;
const CONCURRENCY = 3;

export type TrackedRow = {
  mint: string;
  addedAt: number;
  name: string | null;
  symbol: string | null;
  own: boolean;
  venue: string | null;
  marketCapLamports: string | null;
  mcUsd: number | null;
  graduationPct: number | null;
  updatedAt: number | null;
  error: string | null;
};

type Entry = { at: number; venue: string; marketCapLamports: string; graduationPct: number; name: string | null; symbol: string | null; error: null } | { at: number; error: string };

export class Tracker {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
  ) {}

  private rows() {
    return this.db().prepare("SELECT t.mint, t.added_at, l.config FROM tracked t LEFT JOIN launch l ON l.mint = t.mint ORDER BY t.added_at DESC").all() as { mint: string; added_at: number; config: string | null }[];
  }

  /** Lista ligera (sin cadena): para la paleta de comandos y saber si un token está seguido. */
  lite() {
    return this.rows().map((r) => {
      const own = r.config ? (JSON.parse(r.config) as { name?: string; symbol?: string }) : null;
      const c = this.cache.get(r.mint);
      const meta = c && c.error === null ? c : null;
      return { mint: r.mint, addedAt: r.added_at, name: own?.name ?? meta?.name ?? null, symbol: own?.symbol ?? meta?.symbol ?? null, own: !!own };
    });
  }

  private load(mint: string) {
    const running = this.inflight.get(mint);
    if (running) return running;
    const p = (async () => {
      try {
        const info = await this.chain.get().adapter.tokenInfo(mint);
        this.cache.set(mint, { at: Date.now(), venue: info.venue, marketCapLamports: info.marketCapLamports.toString(), graduationPct: info.graduationPct, name: info.metadata?.name ?? null, symbol: info.metadata?.symbol ?? null, error: null });
      } catch (e) {
        this.cache.set(mint, { at: Date.now(), error: (e as Error).message.slice(0, 160) });
      } finally {
        this.inflight.delete(mint);
      }
    })();
    this.inflight.set(mint, p);
    return p;
  }

  /** Lista con el estado de cada token. Lo que no está en caché se espera; lo caducado se refresca en segundo plano. */
  async list(): Promise<TrackedRow[]> {
    const rows = this.lite();
    const now = Date.now();
    const missing = rows.filter((r) => !this.cache.has(r.mint)).map((r) => r.mint);
    const stale = rows.filter((r) => {
      const c = this.cache.get(r.mint);
      return c && now - c.at > TTL_MS;
    }).map((r) => r.mint);
    // los que faltan se esperan (de 3 en 3); los caducados se refrescan sin bloquear la respuesta
    for (let i = 0; i < missing.length; i += CONCURRENCY) await Promise.all(missing.slice(i, i + CONCURRENCY).map((m) => this.load(m)));
    void (async () => {
      for (let i = 0; i < stale.length; i += CONCURRENCY) await Promise.all(stale.slice(i, i + CONCURRENCY).map((m) => this.load(m)));
    })();
    const solUsd = await this.chain.get().reader.solUsd().catch(() => null);
    return this.lite().map((r) => {
      const c = this.cache.get(r.mint);
      if (!c || c.error !== null) return { ...r, venue: null, marketCapLamports: null, mcUsd: null, graduationPct: null, updatedAt: c?.at ?? null, error: c?.error ?? null };
      return { ...r, venue: c.venue, marketCapLamports: c.marketCapLamports, mcUsd: solUsd ? (Number(c.marketCapLamports) / 1e9) * solUsd.usd : null, graduationPct: c.graduationPct, updatedAt: c.at, error: null };
    });
  }

  /** Añade un token: tiene que existir y ser de Pump.fun (se comprueba leyéndolo). */
  async add(mint: string) {
    const db = this.db();
    if (db.prepare("SELECT 1 FROM tracked WHERE mint = ?").get(mint)) return { added: false };
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tracked").get() as { n: number }).n;
    if (n >= TRACKER_MAX) throw Object.assign(new Error(`El tracker admite como mucho ${TRACKER_MAX} tokens.`), { statusCode: 409 });
    this.cache.delete(mint);
    await this.load(mint);
    const c = this.cache.get(mint);
    if (c?.error) throw Object.assign(new Error(c.error), { statusCode: 404 });
    db.prepare("INSERT INTO tracked(mint, added_at) VALUES(?, ?)").run(mint, Date.now());
    logActivity(db, "tracker.add", `Token añadido al tracker · ${mint}`);
    return { added: true };
  }

  remove(mint: string) {
    const db = this.db();
    const r = db.prepare("DELETE FROM tracked WHERE mint = ?").run(mint);
    this.cache.delete(mint);
    if (r.changes) logActivity(db, "tracker.remove", `Token quitado del tracker · ${mint}`);
    return { removed: r.changes > 0 };
  }
}
