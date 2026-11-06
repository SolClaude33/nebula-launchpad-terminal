// REQ-DASH-001/002: dashboard y P&L locales.
// - `indexOwn()` lee de la cadena cada envío propio confirmado (tabla `tx`): la fee real (meta.fee) y la
//   variación de SOL de las wallets propias (post − pre). Si el envío es de un token, sus trades se
//   indexan con el decodificador del Live aunque nunca se haya abierto su Live Workspace.
// - `summary()` calcula el P&L con coste medio sobre la posición conjunta de las wallets propias:
//   realizado (ventas − coste base de lo vendido) − fees de red − propinas Jito + comisiones reclamadas.
//   Las fees de Pump.fun y PumpSwap ya van dentro de cada compra y venta. El rent de las cuentas que
//   crean las compras y la creación del token se informa aparte (rent = flujo de trades − fee − Δ SOL).
//   La posición abierta se valora al precio actual y no entra en el P&L del período.
import type { DB } from "./db";
import type { ChainManager } from "./chain-manager";
import type { Live } from "./live";
import type { Vault } from "./signer";
import type { TokenInfo } from "./chain/types";
import { Drafts } from "./drafts";

export type Period = "24h" | "7d" | "30d" | "1y" | "all";
const PERIOD_MS: Record<Period, number> = { "24h": 24 * 3600_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "1y": 365 * 86_400_000, all: Infinity };
const HOUR = 3600_000;
const DAY = 86_400_000;

type TxRow = { signature: string; kind: string; mint: string | null; fee: number; own_delta: number | null; at: number };
type TradeRow = { mint: string; signature: string; side: "buy" | "sell"; lamports: string; tokens: string; fee: string; ts: number };

export class Pnl {
  private indexing: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private prices = new Map<string, { at: number; v: TokenInfo | null; p: Promise<TokenInfo | null> | null }>();
  private bal: { at: number; key: string; v: Map<string, bigint> } | null = null;

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private live: Live,
    private vault: Vault,
    private log: (m: string) => void,
    private clock: () => number = Date.now,
  ) {}

  start(intervalMs = 20_000) {
    this.timer ??= setInterval(() => {
      if (this.vault.isUnlocked()) void this.indexOwn().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ownAddresses() {
    return new Set((this.db().prepare("SELECT address FROM wallet").all() as { address: string }[]).map((r) => r.address));
  }

  pending() {
    return (this.db().prepare("SELECT COUNT(*) AS n FROM tx WHERE status = 'CONFIRMED' AND signature IS NOT NULL AND indexed_at IS NULL").get() as { n: number }).n;
  }

  /** Lee de la cadena los envíos propios confirmados que aún no tienen fee real ni Δ SOL. Devuelve los que quedan. */
  indexOwn(max = 500): Promise<number> {
    this.indexing ??= this.doIndex(max).finally(() => (this.indexing = null));
    return this.indexing;
  }

  private async doIndex(max: number) {
    const db = this.db();
    const rows = db.prepare("SELECT idempotency_key AS k, signature, mint FROM tx WHERE status = 'CONFIRMED' AND signature IS NOT NULL AND indexed_at IS NULL ORDER BY created_at LIMIT ?").all(max) as { k: string; signature: string; mint: string | null }[];
    if (rows.length === 0) return 0;
    const chain = this.chain.get();
    const own = this.ownAddresses();
    const upd = db.prepare("UPDATE tx SET chain_fee = ?, own_delta = ?, block_time = ?, indexed_at = ? WHERE idempotency_key = ?");
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const txs = await chain.reader.transactions(chunk.map((r) => r.signature));
      const bySig = new Map(txs.map((t) => [t.signature, t]));
      for (const r of chunk) {
        const t = bySig.get(r.signature);
        if (!t || t.fee === undefined || !t.deltas) continue; // aún no visible: se reintenta en la próxima pasada
        let delta = 0n;
        for (const [a, d] of Object.entries(t.deltas)) if (own.has(a)) delta += d;
        upd.run(Number(t.fee), Number(delta), t.blockTime, this.clock(), r.k);
        if (r.mint) this.live.ingest(r.mint, [t]);
      }
    }
    return this.pending();
  }

  private price(mint: string): Promise<TokenInfo | null> {
    const c = this.prices.get(mint) ?? { at: 0, v: null, p: null };
    this.prices.set(mint, c);
    const load = () =>
      (c.p ??= this.chain
        .get()
        .adapter.tokenInfo(mint)
        .then(
          (v) => ((c.v = v), (c.at = Date.now()), (c.p = null), v),
          () => ((c.p = null), c.v),
        ));
    if (c.at === 0) return load();
    if (Date.now() - c.at > 30_000) void load();
    return Promise.resolve(c.v);
  }

  private async balances() {
    const addrs = (this.db().prepare("SELECT address FROM wallet WHERE archived = 0").all() as { address: string }[]).map((r) => r.address);
    const key = addrs.join(",");
    if (!this.bal || this.bal.key !== key || Date.now() - this.bal.at > 5_000) {
      const v = await this.chain.get().reader.balances(addrs);
      this.bal = { at: Date.now(), key, v };
    }
    return this.bal.v;
  }

  /** Tras una orden o un movimiento propio: la siguiente lectura pide saldos y precios nuevos. */
  invalidate() {
    this.bal = null;
    this.prices.clear();
  }

  /** `tzOffsetMin`: Date.getTimezoneOffset() del navegador, para que los días empiecen a medianoche local. */
  async summary(period: Period, tzOffsetMin = 0) {
    // Hasta 5 s esperando a indexar lo propio; si tarda más, se informa como pendiente
    await Promise.race([this.indexOwn().catch(() => 0), new Promise((r) => setTimeout(r, 5000))]);
    const db = this.db();
    const now = this.clock();
    const start = period === "all" ? 0 : now - PERIOD_MS[period];
    const bucketMs = period === "24h" ? HOUR : DAY;
    const local = -tzOffsetMin * 60_000;
    const floorB = (ts: number) => Math.floor((ts + local) / bucketMs) * bucketMs - local;
    const own = this.ownAddresses();
    const ownList = [...own];

    const trades: TradeRow[] = ownList.length
      ? (db.prepare(`SELECT mint, signature, side, lamports, tokens, fee, ts FROM live_trade WHERE user IN (${ownList.map(() => "?").join(",")}) ORDER BY ts, seq`).all(...ownList) as TradeRow[])
      : [];
    const txs = db.prepare("SELECT signature, kind, mint, COALESCE(chain_fee, fee_lamports, 0) AS fee, own_delta, COALESCE(block_time * 1000, created_at) AS at FROM tx WHERE status = 'CONFIRMED' AND signature IS NOT NULL").all() as TxRow[];

    const buckets = new Map<number, number>();
    const addB = (ts: number, v: number) => {
      if (ts < start) return;
      const b = floorB(ts);
      buckets.set(b, (buckets.get(b) ?? 0) + v);
    };

    // Posición conjunta por token con coste medio
    type Pos = { cost: number; tok: number; realizedAll: number; realizedP: number; buysAll: number; feesAll: number; feesP: number; soldInP: boolean };
    const pos = new Map<string, Pos>();
    const P = (m: string) => pos.get(m) ?? (pos.set(m, { cost: 0, tok: 0, realizedAll: 0, realizedP: 0, buysAll: 0, feesAll: 0, feesP: 0, soldInP: false }), pos.get(m)!);
    const tradeNet = new Map<string, number>(); // por firma: ventas − compras propias (para el rent)
    let buys = 0;
    let sells = 0;
    let padFees = 0;
    let nTrades = 0;
    for (const t of trades) {
      const p = P(t.mint);
      const l = Number(t.lamports);
      const k = Number(t.tokens);
      const inP = t.ts >= start;
      tradeNet.set(t.signature, (tradeNet.get(t.signature) ?? 0) + (t.side === "sell" ? l : -l));
      if (t.side === "buy") {
        p.cost += l;
        p.tok += k;
        p.buysAll += l;
        if (inP) buys += l;
      } else {
        const part = p.tok > 0 ? p.cost * Math.min(1, k / p.tok) : 0;
        const r = l - part;
        p.cost -= part;
        p.tok = Math.max(0, p.tok - k);
        p.realizedAll += r;
        if (inP) {
          sells += l;
          p.realizedP += r;
          p.soldInP = true;
          addB(t.ts, r);
        }
      }
      if (inP) {
        padFees += Number(t.fee);
        nTrades++;
      }
    }

    let networkFees = 0;
    let claims = 0;
    let rent = 0;
    for (const x of txs) {
      const inP = x.at >= start;
      if (x.mint) {
        const p = P(x.mint);
        p.feesAll += x.fee;
        if (inP) p.feesP += x.fee;
      }
      if (!inP) continue;
      networkFees += x.fee;
      addB(x.at, -x.fee);
      if (x.kind === "claim" && x.own_delta !== null) {
        const gross = x.own_delta + x.fee;
        claims += gross;
        addB(x.at, gross);
      } else if (x.mint && x.own_delta !== null && ["create", "buy", "sell"].includes(x.kind)) {
        rent += (tradeNet.get(x.signature) ?? 0) - x.fee - x.own_delta;
      }
    }

    // Posición abierta al precio actual (no entra en el P&L del período)
    let unrealized = 0;
    const open = [...pos].filter(([, p]) => p.tok > 0);
    const infos = await Promise.all(open.map(([m]) => this.price(m).catch(() => null)));
    const unrealByMint = new Map<string, number>();
    open.forEach(([m, p], i) => {
      const info = infos[i];
      if (!info) return;
      const unit = 10 ** info.decimals;
      const price = info.priceLamports || (Number(info.marketCapLamports) / Number(info.supply)) * unit;
      const u = (p.tok / unit) * price - p.cost;
      unrealByMint.set(m, u);
      unrealized += u;
    });

    const realized = [...pos.values()].reduce((a, p) => a + p.realizedP, 0);
    const jito = 0; // REQ-DASH-001: las propinas Jito se sumarán cuando los envíos las lleven
    const pnl = realized - networkFees - jito + claims;

    // Serie: intervalos sin huecos desde el inicio del período (o el primer movimiento en «Todo»)
    const firstTs = Math.min(...trades.map((t) => t.ts), ...txs.map((t) => t.at), now);
    const from = floorB(Math.max(start, period === "all" ? firstTs : start));
    const series: { t: number; pnlLamports: number; cumLamports: number }[] = [];
    const step = Math.max(bucketMs, Math.ceil((now - from) / bucketMs / 400) * bucketMs);
    let cum = 0;
    for (let b = from; b <= now; b += step) {
      let v = 0;
      for (let x = b; x < b + step; x += bucketMs) v += buckets.get(x) ?? 0;
      cum += v;
      series.push({ t: b, pnlLamports: Math.round(v), cumLamports: Math.round(cum) });
    }

    const sold = [...pos.values()].filter((p) => p.soldInP);
    const wins = sold.filter((p) => p.realizedP - p.feesP > 0).length;

    const launchRows = db.prepare("SELECT id, status, mint, config, created_at FROM launch WHERE status IN ('DONE','BUYING','CREATED','PAUSED') ORDER BY created_at DESC").all() as { id: string; status: string; mint: string; config: string; created_at: number }[];
    const launches = launchRows.map((r) => {
      const c = JSON.parse(r.config) as { name: string; symbol: string };
      const p = pos.get(r.mint);
      const u = unrealByMint.get(r.mint) ?? 0;
      return { id: r.id, mint: r.mint, name: c.name, symbol: c.symbol, status: r.status, createdAt: r.created_at, pnlLamports: Math.round((p?.realizedAll ?? 0) + u - (p?.feesAll ?? 0)), realizedLamports: Math.round(p?.realizedAll ?? 0), unrealizedLamports: Math.round(u), feesLamports: p?.feesAll ?? 0, investedLamports: Math.round(p?.buysAll ?? 0) };
    });

    const wallets = db.prepare("SELECT address, kind FROM wallet WHERE archived = 0").all() as { address: string; kind: string }[];
    let funderL = 0n;
    let walletsL = 0n;
    try {
      const b = await this.balances();
      for (const w of wallets) (w.kind === "funder" ? (funderL += b.get(w.address) ?? 0n) : (walletsL += b.get(w.address) ?? 0n));
    } catch {}
    const solUsd = await this.chain
      .get()
      .reader.solUsd()
      .catch(() => null);
    const drafts = new Drafts(this.db).count();

    return {
      period,
      solUsd,
      balances: { totalLamports: (funderL + walletsL).toString(), funderLamports: funderL.toString(), walletsLamports: walletsL.toString(), wallets: wallets.filter((w) => w.kind === "wallet").length },
      totals: { pnlLamports: Math.round(pnl), realizedLamports: Math.round(realized), unrealizedLamports: Math.round(unrealized), buysLamports: buys, sellsLamports: sells, padFeesLamports: padFees, networkFeesLamports: networkFees, jitoLamports: jito, rentLamports: Math.round(rent), claimsLamports: claims, trades: nTrades },
      winRate: { wins, total: sold.length },
      avgPerLaunchLamports: launches.length ? Math.round(launches.reduce((a, l) => a + l.pnlLamports, 0) / launches.length) : null,
      series,
      bucket: bucketMs === HOUR ? ("hour" as const) : ("day" as const),
      launches,
      counts: { wallets: wallets.filter((w) => w.kind === "wallet").length, funders: wallets.filter((w) => w.kind === "funder").length, launches: launches.length, drafts },
      indexing: { pending: this.pending() },
      at: now,
    };
  }
}
