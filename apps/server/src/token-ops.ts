// REQ-LIVE-005: enviar tokens y quemar supply desde las wallets propias.
// - Vista previa por wallet con la cantidad, la fee de red y el rent de la cuenta de destino si no existe.
// - Enviar a una dirección que no es una wallet propia saca fondos de la bóveda: exige reconfirmar la
//   contraseña (REQ-VAULT-004, acción «withdraw») y avisa si la dirección es nueva o es un PDA.
// - Quemar exige escribir el símbolo, comprobado también en el servidor.
// - Cada envío lleva su idempotency key (`tsend:<id>:<wallet>`, `burn:<id>:<wallet>`): repetir la petición
//   nunca duplica el efecto. Un envío `pending` se informa como pendiente, nunca como fallido.
import { z } from "zod";
import type { DB } from "./db";
import { logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import type { Live } from "./live";
import { isOnCurve, isValidAddress } from "./chain/transfers";

const Amount = { pct: z.number().gt(0).max(100).optional(), tokensEach: z.string().regex(/^\d+$/).optional() };
const Base = z.object({ id: z.string().uuid(), mint: z.string().refine(isValidAddress, "Token no válido"), walletIds: z.array(z.string()).min(1).max(50), ...Amount });
export const SendInput = Base.extend({ to: z.string().trim().refine(isValidAddress, "Dirección de destino no válida") }).refine((v) => (v.pct === undefined) !== (v.tokensEach === undefined), "Indica un porcentaje o una cantidad");
export const BurnInput = Base.extend({ confirmSymbol: z.string().max(20).default("") }).refine((v) => (v.pct === undefined) !== (v.tokensEach === undefined), "Indica un porcentaje o una cantidad");
export type SendInput = z.infer<typeof SendInput>;
export type BurnInput = z.infer<typeof BurnInput>;

type W = { id: string; label: string; address: string };
type Item = { walletId: string; label: string; address: string; balance: string; amount: string; feeLamports: string; rentLamports: string; status: "READY" | "SKIPPED" | "OK" | "FAILED" | "PENDING"; reason: string | null; signature: string | null };

const norm = (s: string) => s.trim().replace(/^\$/, "").toUpperCase();

export class TokenOps {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    private live: Live,
    private log: (m: string) => void,
  ) {}

  private wallets(ids: string[]): W[] {
    const rows = this.db().prepare(`SELECT id, label, address FROM wallet WHERE archived = 0 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as W[];
    if (rows.length !== new Set(ids).size) throw Object.assign(new Error("Alguna wallet no existe o está archivada."), { statusCode: 400 });
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  /** Símbolo con el que se confirma la quema: el del lanzamiento propio o el de los metadatos en cadena. */
  async symbolOf(mint: string) {
    const launch = this.db().prepare("SELECT config FROM launch WHERE mint = ? LIMIT 1").get(mint) as { config: string } | undefined;
    if (launch) return (JSON.parse(launch.config) as { symbol: string }).symbol;
    const info = await this.chain.get().adapter.tokenInfo(mint);
    return info.metadata?.symbol?.trim() || null;
  }

  private destination(to: string) {
    const own = this.db().prepare("SELECT id, label FROM wallet WHERE address = ? AND archived = 0").get(to) as { id: string; label: string } | undefined;
    const known = !!this.db().prepare("SELECT 1 FROM address_book WHERE address = ?").get(to);
    return { address: to, own: own ?? null, newAddress: !own && !known, offCurve: !isOnCurve(to) };
  }

  private async plan(kind: "send" | "burn", input: SendInput | BurnInput) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const chain = this.chain.get();
    const ws = this.wallets(input.walletIds);
    const to = kind === "send" ? (input as SendInput).to : null;
    if (to && ws.some((w) => w.address === to)) throw Object.assign(new Error("El destino no puede ser una de las wallets de origen."), { statusCode: 400 });
    const [balances, sol] = await Promise.all([chain.reader.tokenBalances(input.mint, ws.map((w) => w.address)), chain.reader.balances(ws.map((w) => w.address))]);
    const items: Item[] = [];
    for (const w of ws) {
      const bal = balances.get(w.address) ?? 0n;
      const amount = input.pct !== undefined ? (input.pct >= 100 ? bal : (bal * BigInt(Math.round(input.pct * 100))) / 10_000n) : BigInt(input.tokensEach!) > bal ? bal : BigInt(input.tokensEach!);
      const base = { walletId: w.id, label: w.label, address: w.address, balance: bal.toString(), amount: amount.toString(), signature: null };
      if (amount <= 0n) {
        items.push({ ...base, feeLamports: "0", rentLamports: "0", status: "SKIPPED", reason: "Sin tokens" });
        continue;
      }
      const tx = kind === "send" ? await chain.adapter.buildTokenTransferTx({ mint: input.mint, from: w.address, to: to!, tokens: amount }) : await chain.adapter.buildBurnTx({ mint: input.mint, owner: w.address, tokens: amount });
      const fee = chain.transfers.feeOf(tx);
      const rent = "rentLamports" in tx ? (tx as { rentLamports: bigint }).rentLamports : 0n;
      const need = fee + rent;
      const have = sol.get(w.address) ?? 0n;
      items.push(have < need ? { ...base, feeLamports: fee.toString(), rentLamports: rent.toString(), status: "SKIPPED", reason: `Falta SOL para la fee${rent ? " y la cuenta de destino" : ""}: tiene ${(Number(have) / 1e9).toFixed(6)} y necesita ${(Number(need) / 1e9).toFixed(6)}` } : { ...base, feeLamports: fee.toString(), rentLamports: rent.toString(), status: "READY", reason: null });
    }
    return { items, to: to ? this.destination(to) : null };
  }

  async preview(kind: "send" | "burn", input: SendInput | BurnInput) {
    const { items, to } = await this.plan(kind, input);
    const sum = (k: "amount" | "feeLamports" | "rentLamports") => items.filter((i) => i.status === "READY").reduce((a, i) => a + BigInt(i[k]), 0n).toString();
    const symbol = await this.symbolOf(input.mint).catch(() => null);
    return { kind, mint: input.mint, symbol, to, needsStepUp: kind === "send" && !to?.own, items, totals: { tokens: sum("amount"), feeLamports: sum("feeLamports"), rentLamports: sum("rentLamports") } };
  }

  async execute(kind: "send" | "burn", input: SendInput | BurnInput, stepUp?: string) {
    // REVIEW-F1 P2-6: se reserva el id ANTES de cualquier await; si no, dos peticiones simultáneas con el
    // mismo id pasaban la comprobación y podían emitir dos transacciones con blockhash distintos
    if (this.running.has(input.id)) throw Object.assign(new Error("Esta operación ya está en marcha."), { statusCode: 409 });
    this.running.add(input.id);
    try {
      return await this.run(kind, input, stepUp);
    } finally {
      this.running.delete(input.id);
    }
  }

  private async run(kind: "send" | "burn", input: SendInput | BurnInput, stepUp?: string) {
    const symbol = await this.symbolOf(input.mint).catch(() => null);
    if (kind === "burn") {
      const want = symbol ? norm(symbol) : "QUEMAR";
      if (norm((input as BurnInput).confirmSymbol) !== want) throw Object.assign(new Error(symbol ? `Escribe el símbolo ($${symbol}) para confirmar la quema.` : "Escribe QUEMAR para confirmar la quema."), { statusCode: 400 });
    }
    const pre = await this.plan(kind, input);
    // Sacar tokens de la bóveda (destino que no es una wallet propia) exige reconfirmar la contraseña
    // el rechazo del PDA va antes de gastar la reconfirmación (REVIEW-F1 P3-9)
    if (kind === "send" && pre.to?.offCurve) throw Object.assign(new Error("El destino es una dirección de programa (PDA): los tokens quedarían bloqueados."), { statusCode: 400 });
    if (kind === "send" && !pre.to?.own) this.vault.consumeStepUp(stepUp, "withdraw");
    const chain = this.chain.get();
    {
      for (const it of pre.items) {
        if (it.status !== "READY") continue;
        const tx = kind === "send" ? await chain.adapter.buildTokenTransferTx({ mint: input.mint, from: it.address, to: (input as SendInput).to, tokens: BigInt(it.amount) }) : await chain.adapter.buildBurnTx({ mint: input.mint, owner: it.address, tokens: BigInt(it.amount) });
        let res;
        try {
          res = await chain.sender.send(tx, { idempotencyKey: `${kind === "send" ? "tsend" : "burn"}:${input.id}:${it.walletId}` });
        } catch (e) {
          if (e instanceof VaultError) {
            it.status = "PENDING";
            it.reason = "La bóveda se bloqueó antes de firmar; no se envió.";
            continue;
          }
          throw e;
        }
        if (res.status === "confirmed") (it.status = "OK"), (it.signature = res.signature);
        else if (res.status === "pending") (it.status = "PENDING"), (it.reason = res.message), (it.signature = res.signature ?? null);
        else if (res.status === "failed") (it.status = "FAILED"), (it.reason = res.message);
      }
    }
    const ok = pre.items.filter((i) => i.status === "OK");
    const total = ok.reduce((a, i) => a + BigInt(i.amount), 0n);
    const ui = (Number(total) / 1e6).toLocaleString("es-ES");
    if (kind === "send") {
      const d = pre.to!;
      if (!d.own && ok.length) this.db().prepare("INSERT OR IGNORE INTO address_book(address, label, created_at) VALUES(?, ?, ?)").run(d.address, `Externa ${d.address.slice(0, 4)}…${d.address.slice(-4)}`, Date.now());
      logActivity(this.db(), "tokens.send", `Enviados ${ui} ${symbol ? `$${symbol}` : "tokens"} desde ${ok.length} wallets a ${d.own ? d.own.label : d.address} · mint ${input.mint}`);
    } else logActivity(this.db(), "tokens.burn", `Quemados ${ui} ${symbol ? `$${symbol}` : "tokens"} desde ${ok.length} wallets · mint ${input.mint}`);
    void this.live.refresh(input.mint);
    return { kind, mint: input.mint, symbol, to: pre.to, items: pre.items, totals: { tokens: total.toString() } };
  }
}
