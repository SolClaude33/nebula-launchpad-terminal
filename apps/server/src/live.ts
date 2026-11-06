// indexer (§5.3) del Live Workspace (REQ-LIVE-001): un vigilante por mint mientras la interfaz lo mira.
// - WebSocket de logs del RPC para la latencia (≤ 2 s) y sondeo de firmas cada 2 s como red de seguridad.
// - Todo se guarda en SQLite; el navegador solo lee la API local con un cursor (nunca toca el RPC).
// - El coste base propio sale de los trades indexados de las wallets propias, incluidas sus firmas
//   de la tabla `tx`, así que no depende de cuánto historial público se haya rellenado.
import type { DB } from "./db";
import type { ChainManager } from "./chain-manager";
import type { Chain } from "./chain";
import type { ChainEvent, RawTx, TokenInfo } from "./chain/types";

const POLL_MS = 2000;
const IDLE_MS = 60_000;
const BACKFILL_MAX = 1000;
const INFO_TTL_MS = 1000;
const HOLDERS_TTL_MS = 10_000;
const SOL_USD_TTL_MS = 15_000;
const POSITION_TTL_MS = 2000;
const HOLDERS_VIEW_TTL_MS = 3000;

/**
 * Valor cacheado con «stale-while-revalidate» (§7.3, p95 ≤ 50 ms con un RPC remoto): las lecturas que la
 * interfaz sondea cada segundo nunca esperan al RPC si ya hay un valor; el refresco va en segundo plano
 * (y `tokenInfo` además en el tick del vigilante). Solo la primera lectura, o tras una orden propia, espera.
 */
type Swr<T> = { at: number; v: T | undefined; p: Promise<T> | null; g: number };
const swr = <T>(): Swr<T> => ({ at: 0, v: undefined, p: null, g: 0 });
/** Descarta el valor y cualquier carga en vuelo (sus datos serían anteriores a una orden propia). */
const invalidate = (c: Swr<unknown>) => {
  c.v = undefined;
  c.at = 0;
  c.p = null;
  c.g++;
};

async function cached<T>(c: Swr<T>, ttl: number, load: () => Promise<T>): Promise<T> {
  const refresh = () => {
    const g = c.g;
    return (c.p ??= load().then(
      (v) => {
        if (c.g === g) (c.v = v), (c.at = Date.now()), (c.p = null);
        return v;
      },
      (e) => {
        if (c.g === g) c.p = null;
        throw e;
      },
    ));
  };
  if (c.v === undefined) return refresh();
  if (Date.now() - c.at >= ttl) refresh().catch(() => {});
  return c.v;
}

type Watcher = {
  chain: Chain;
  lastAccess: number;
  unsub: (() => void) | null;
  timer: NodeJS.Timeout;
  busy: boolean;
  info: Swr<TokenInfo>;
  solUsd: Swr<{ usd: number; publishedAt: number } | null>;
  holders: { at: number; v: Awaited<ReturnType<Chain["reader"]["holders"]>> } | null;
  holdersView: Swr<unknown>;
  position: Swr<unknown>;
  error: string | null;
};

export type TradeRow = { seq: number; signature: string; venue: "curve" | "pumpswap"; side: "buy" | "sell"; lamports: string; tokens: string; user: string; ts: number; mc: string };

const ser = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export class Live {
  private watchers = new Map<string, Watcher>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private log: (m: string) => void,
  ) {}

  private wallets() {
    return this.db().prepare("SELECT id, label, address, role, kind FROM wallet WHERE archived = 0").all() as { id: string; label: string; address: string; role: string | null; kind: string }[];
  }

  /** Arranca (o mantiene vivo) el vigilante del mint. Si la cadena se recreó, lo rehace. */
  private watch(mint: string) {
    const chain = this.chain.get();
    let w = this.watchers.get(mint);
    if (w && w.chain !== chain) {
      this.stop(mint);
      w = undefined;
    }
    if (!w) {
      const timer = setInterval(() => void this.tick(mint), POLL_MS);
      timer.unref?.();
      w = { chain, lastAccess: Date.now(), unsub: null, timer, busy: false, info: swr(), solUsd: swr(), holders: null, holdersView: swr(), position: swr(), error: null };
      this.watchers.set(mint, w);
      const ww = w;
      if (chain.reader.onLogs) {
        ww.unsub = chain.reader.onLogs(mint, (tx) => {
          // Logs truncados: se pide la transacción completa para leer los eventos de las instrucciones internas
          if (tx.logs.some((l) => l.startsWith("Log truncated"))) void chain.reader.transactions([tx.signature]).then((t) => this.ingest(mint, t), () => {});
          else this.ingest(mint, [tx]);
        });
      }
      void this.tick(mint);
    }
    w.lastAccess = Date.now();
    return w;
  }

  stop(mint: string) {
    const w = this.watchers.get(mint);
    if (!w) return;
    clearInterval(w.timer);
    w.unsub?.();
    this.watchers.delete(mint);
  }

  stopAll() {
    for (const m of [...this.watchers.keys()]) this.stop(m);
  }

  private async tick(mint: string) {
    const w = this.watchers.get(mint);
    if (!w || w.busy) return;
    if (Date.now() - w.lastAccess > IDLE_MS) return this.stop(mint);
    w.busy = true;
    try {
      // el estado del token se refresca aquí, fuera de las peticiones de la interfaz
      if (Date.now() - w.info.at >= INFO_TTL_MS) await this.info(mint, w).catch(() => {});
      await this.sync(mint, w.chain);
      w.error = null;
    } catch (e) {
      w.error = (e as Error).message;
    } finally {
      w.busy = false;
    }
  }

  /** Firmas nuevas del mint (y, la primera vez, el historial hasta BACKFILL_MAX) más las propias de la tabla tx. */
  private async sync(mint: string, chain: Chain) {
    const db = this.db();
    const st = db.prepare("SELECT newest, backfilled FROM live_mint WHERE mint = ?").get(mint) as { newest: string | null; backfilled: number } | undefined;
    const seen = db.prepare("SELECT 1 FROM live_sig WHERE mint = ? AND signature = ?");
    const fresh: string[] = [];
    let newest: string | null = null;
    let before: string | undefined;
    const limit = st?.backfilled ? 100 : BACKFILL_MAX;
    for (let total = 0; total < limit; ) {
      const page = await chain.reader.signatures(mint, { until: st?.newest ?? undefined, before, limit: Math.min(100, limit - total) });
      if (page.length === 0) break;
      newest ??= page[0].signature;
      for (const s of page) if (!s.err && !seen.get(mint, s.signature)) fresh.push(s.signature);
      total += page.length;
      before = page[page.length - 1].signature;
      if (page.length < 100) break;
    }
    // Las firmas propias confirmadas (ticket, Instant Trade, lanzamientos) siempre se indexan
    const own = db.prepare("SELECT signature FROM tx WHERE mint = ? AND status = 'CONFIRMED' AND signature IS NOT NULL").all(mint) as { signature: string }[];
    for (const o of own) if (!seen.get(mint, o.signature) && !fresh.includes(o.signature)) fresh.push(o.signature);
    // de la más antigua a la más nueva, para que el orden de inserción siga el de la cadena
    fresh.reverse();
    for (let i = 0; i < fresh.length; i += 50) this.ingest(mint, await chain.reader.transactions(fresh.slice(i, i + 50)));
    db.prepare(
      `INSERT INTO live_mint(mint, newest, backfilled, updated_at) VALUES(?, ?, 1, ?)
       ON CONFLICT(mint) DO UPDATE SET newest = COALESCE(excluded.newest, live_mint.newest), backfilled = 1, updated_at = excluded.updated_at`,
    ).run(mint, newest, Date.now());
  }

  /** Decodifica e inserta (idempotente: una firma se procesa una sola vez por mint). */
  ingest(mint: string, txs: RawTx[]) {
    const w = this.watchers.get(mint);
    const chain = w?.chain ?? this.chain.get();
    const info = w?.info.v;
    const db = this.db();
    const mark = db.prepare("INSERT OR IGNORE INTO live_sig(mint, signature) VALUES(?, ?)");
    const ins = db.prepare("INSERT OR IGNORE INTO live_trade(mint, signature, idx, venue, side, lamports, tokens, user, ts, slot, mc, fee) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let changed = false;
    db.transaction(() => {
      for (const tx of txs) {
        if (!mark.run(mint, tx.signature).changes) continue;
        const events: ChainEvent[] = chain.adapter.parseEvents(tx, { mint, supply: info?.supply, mayhem: info?.mayhem });
        for (const e of events) {
          if (e.kind === "trade") ins.run(mint, tx.signature, e.index, e.venue, e.side, e.lamports.toString(), e.tokens.toString(), e.user, e.ts || (tx.blockTime ?? 0) * 1000, tx.slot, e.marketCapLamports.toString(), (e.feeLamports ?? 0n).toString());
          else if (e.kind === "complete") db.prepare("UPDATE live_mint SET completed_at = ? WHERE mint = ?").run(e.ts, mint);
          else if (e.kind === "migrate") db.prepare("UPDATE live_mint SET migrated_pool = ? WHERE mint = ?").run(e.pool, mint);
          changed = true;
        }
      }
    })();
    // Un trade cambia reservas, venue y holders: se refrescan en segundo plano (la lectura no espera)
    if (changed && w) {
      w.info.at = 0;
      w.holders = null;
      w.holdersView.at = 0;
      void this.info(mint, w).catch(() => {});
    }
  }

  private info(mint: string, w: Watcher) {
    return cached(w.info, INFO_TTL_MS, () => w.chain.adapter.tokenInfo(mint));
  }

  private solUsd(w: Watcher) {
    return cached(w.solUsd, SOL_USD_TTL_MS, () => w.chain.reader.solUsd().catch(() => null));
  }

  /** Estado del token y trades nuevos desde el cursor `after` (seq). */
  async snapshot(mint: string, after = 0) {
    const w = this.watch(mint);
    const info = await this.info(mint, w);
    const db = this.db();
    // primera carga: los últimos 2.000 trades; después, solo lo nuevo
    const rows = (
      after > 0
        ? db.prepare("SELECT seq, signature, venue, side, lamports, tokens, user, ts, mc FROM live_trade WHERE mint = ? AND seq > ? ORDER BY seq LIMIT 500").all(mint, after)
        : db.prepare("SELECT * FROM (SELECT seq, signature, venue, side, lamports, tokens, user, ts, mc FROM live_trade WHERE mint = ? ORDER BY seq DESC LIMIT 2000) ORDER BY seq").all(mint)
    ) as TradeRow[];
    const stats = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(lamports AS INTEGER)), 0) AS vol, MIN(ts) AS first FROM live_trade WHERE mint = ?").get(mint) as { n: number; vol: number; first: number | null };
    const own = new Map(this.wallets().map((x) => [x.address, x]));
    const launch = db.prepare("SELECT config, created_at FROM launch WHERE mint = ? LIMIT 1").get(mint) as { config: string; created_at: number } | undefined;
    const cfg = launch ? (JSON.parse(launch.config) as { name: string; symbol: string; mayhem: boolean; feeMode: string; links?: { x: string; telegram: string; web: string } }) : null;
    const solUsd = await this.solUsd(w);
    return ser({
      info,
      // nombre: el del lanzamiento propio; si no, la extensión de metadatos en cadena
      token: { name: cfg?.name ?? info.metadata?.name ?? null, symbol: cfg?.symbol ?? info.metadata?.symbol ?? null, own: !!cfg, feeMode: cfg?.feeMode ?? null, links: cfg?.links ?? null, createdAt: launch?.created_at ?? stats.first },
      trades: rows.map((r) => ({ ...r, own: own.get(r.user) ? { id: own.get(r.user)!.id, label: own.get(r.user)!.label } : null })),
      cursor: rows.length ? rows[rows.length - 1].seq : after,
      stats: { trades: stats.n, volumeLamports: String(stats.vol) },
      solUsd,
      live: { ws: !!w.unsub, error: w.error },
      at: Date.now(),
    });
  }

  /** REQ-LIVE-001: holders marcando las wallets propias y las cuentas del sistema (curva, pool). */
  async holders(mint: string) {
    const w = this.watch(mint);
    return cached(w.holdersView, HOLDERS_VIEW_TTL_MS, () => this.loadHolders(mint, w));
  }

  private async loadHolders(mint: string, w: Watcher) {
    const info = await this.info(mint, w);
    if (!w.holders || Date.now() - w.holders.at > HOLDERS_TTL_MS) w.holders = { at: Date.now(), v: await w.chain.reader.holders(mint) };
    const wallets = this.wallets();
    const own = new Map(wallets.map((x) => [x.address, x]));
    const sys = new Map(info.systemOwners.map((s) => [s.owner, s.label]));
    const list = new Map(w.holders.v.items.map((h) => [h.owner, h.amount]));
    // Las propias se leen siempre, aunque el RPC solo devuelva el top 20
    const mine = await w.chain.reader.tokenBalances(mint, wallets.map((x) => x.address));
    for (const [a, amt] of mine) if (amt > 0n) list.set(a, amt);
    const items = [...list]
      .filter(([, a]) => a > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .map(([owner, amount]) => {
        const o = own.get(owner);
        return { owner, amount, system: sys.get(owner) ?? null, own: o ? { id: o.id, label: o.label, role: o.role } : null };
      });
    return ser({ supply: info.supply, complete: w.holders.v.complete, count: items.filter((i) => !i.system).length, items: items.slice(0, 100) });
  }

  /** Posición agregada y por wallet: saldo, tokens, coste base medio y P&L con el precio actual. */
  async position(mint: string) {
    const w = this.watch(mint);
    return cached(w.position, POSITION_TTL_MS, () => this.loadPosition(mint, w));
  }

  private async loadPosition(mint: string, w: Watcher) {
    const info = await this.info(mint, w);
    const wallets = this.wallets().filter((x) => x.kind === "wallet");
    const addrs = wallets.map((x) => x.address);
    const [tokens, sol] = await Promise.all([w.chain.reader.tokenBalances(mint, addrs), w.chain.reader.balances(addrs)]);
    const unit = 10 ** info.decimals;
    // en migración no hay precio de mercado: se usa el market cap de graduación
    const price = info.priceLamports || (Number(info.marketCapLamports) / Number(info.supply)) * unit;
    const rows = this.db().prepare("SELECT user, side, lamports, tokens FROM live_trade WHERE mint = ? ORDER BY seq").all(mint) as { user: string; side: string; lamports: string; tokens: string }[];
    const basis = new Map<string, { cost: number; tok: number; realized: number }>();
    for (const r of rows) {
      const b = basis.get(r.user) ?? { cost: 0, tok: 0, realized: 0 };
      const l = Number(r.lamports);
      const t = Number(r.tokens);
      if (r.side === "buy") (b.cost += l), (b.tok += t);
      else if (b.tok > 0) {
        const part = b.cost * Math.min(1, t / b.tok);
        b.realized += l - part;
        b.cost -= part;
        b.tok = Math.max(0, b.tok - t);
      }
      basis.set(r.user, b);
    }
    const items = wallets.map((x) => {
      const t = tokens.get(x.address) ?? 0n;
      const b = basis.get(x.address);
      const value = (Number(t) / unit) * price;
      // si hay tokens que no pasaron por trades indexados (p. ej. recibidos), el coste base es parcial
      const cost = b && b.tok > 0 ? b.cost * Math.min(1, Number(t) / b.tok) : 0;
      return { walletId: x.id, label: x.label, address: x.address, role: x.role, lamports: (sol.get(x.address) ?? 0n).toString(), tokens: t.toString(), costLamports: Math.round(cost), valueLamports: Math.round(value), realizedLamports: Math.round(b?.realized ?? 0) };
    });
    const sum = (k: "costLamports" | "valueLamports" | "realizedLamports") => items.reduce((a, i) => a + i[k], 0);
    const held = items.reduce((a, i) => a + BigInt(i.tokens), 0n);
    return ser({ supply: info.supply, decimals: info.decimals, priceLamports: price, items, total: { tokens: held, costLamports: sum("costLamports"), valueLamports: sum("valueLamports"), realizedLamports: sum("realizedLamports"), lamports: items.reduce((a, i) => a + BigInt(i.lamports), 0n) } });
  }

  /**
   * REQ-AUTO-002/005: market cap en USD para las automatizaciones, con el `tokenInfo` del vigilante (TTL 1 s)
   * y el precio SOL/USD de Pyth. Mantiene vivo el vigilante del mint mientras haya una tarea activa.
   * `mcUsd` es null si el oráculo no tiene un precio vigente: entonces no se dispara nada.
   */
  async market(mint: string) {
    const w = this.watch(mint);
    const info = await this.info(mint, w);
    const solUsd = await this.solUsd(w);
    const mcUsd = solUsd ? (Number(info.marketCapLamports) / 1e9) * solUsd.usd : null;
    return { info, solUsd, mcUsd };
  }

  /** Tras una orden propia: indexa ya sus firmas sin esperar al siguiente sondeo. */
  async refresh(mint: string) {
    const w = this.watchers.get(mint);
    if (!w) return;
    // orden propia: la siguiente lectura espera al dato nuevo (saldos, reservas)
    for (const c of [w.info, w.holdersView, w.position] as Swr<unknown>[]) invalidate(c);
    w.holders = null;
    await this.tick(mint);
  }
}
