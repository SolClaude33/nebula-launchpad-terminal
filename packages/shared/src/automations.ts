// REQ-AUTO-001…010: automatizaciones de la posición propia (DCA y órdenes límite por market cap en USD).
// Esquemas y el plan del DCA compartidos por la API y la interfaz, para que la vista previa sea exacta.
//
// §2.3 de la spec: nada de aleatoriedad que disfrace actividad coordinada. El «rango» de un DCA es una
// rampa DETERMINISTA del mínimo al máximo en pasos iguales, el mismo monto para todas las wallets de una
// ejecución y un intervalo fijo sin variaciones.
import { z } from "zod";

export const AUTO_STATUSES = ["IDLE", "RUNNING", "PAUSED", "COMPLETED", "STOPPED", "FAILED", "TIMEOUT"] as const;
export type AutoStatus = (typeof AUTO_STATUSES)[number];
/** estados en los que la tarea ya no hace nada: se puede ejecutar de nuevo o borrar */
export const AUTO_FINAL: AutoStatus[] = ["COMPLETED", "STOPPED", "FAILED", "TIMEOUT"];

export const AUTO_MIN_INTERVAL_SEC = 10;
export const AUTO_MAX_INTERVAL_SEC = 24 * 3600;
export const AUTO_MAX_DURATION_SEC = 30 * 24 * 3600;
export const AUTO_DEFAULT_SLIPPAGE = 5;
export const AUTO_DEFAULT_MAX_ERRORS = 3;

const Units = z.string().regex(/^\d+$/, "Monto no válido");
const Usd = z.number().positive("El market cap tiene que ser mayor que 0").max(1e13);

const common = {
  mint: z.string().min(32).max(64),
  walletIds: z.array(z.string()).min(1, "Elige al menos una wallet").max(100),
  /** REQ-AUTO-010: la wallet dev queda fuera salvo que se active de forma explícita */
  includeDev: z.boolean().default(false),
  /** REQ-AUTO-005: solo se ejecuta con el market cap (USD) dentro del rango */
  mcMinUsd: Usd.nullable().default(null),
  mcMaxUsd: Usd.nullable().default(null),
  startDelaySec: z.number().int().min(0).max(AUTO_MAX_INTERVAL_SEC).default(0),
  /** por defecto 5 % también en ventas: una venta nunca sale sin protección de precio */
  slippagePct: z.number().min(0.1).max(50).default(AUTO_DEFAULT_SLIPPAGE),
  maxErrors: z.number().int().min(1).max(50).default(AUTO_DEFAULT_MAX_ERRORS),
  mode: z.enum(["parallel", "staggered"]).default("parallel"),
};

export const DcaConfig = z.object({
  type: z.literal("dca"),
  side: z.enum(["buy", "sell"]),
  /** por wallet y ejecución: lamports (compra) o unidades base del token (venta) */
  amount: z.discriminatedUnion("kind", [z.object({ kind: z.literal("fixed"), each: Units }), z.object({ kind: z.literal("range"), min: Units, max: Units })]),
  intervalSec: z.number().int().min(AUTO_MIN_INTERVAL_SEC, `Intervalo mínimo: ${AUTO_MIN_INTERVAL_SEC} s`).max(AUTO_MAX_INTERVAL_SEC, "El intervalo máximo es 24 h"),
  /** fin por monto total (sumando todas las wallets), por duración o lo primero que llegue */
  end: z.object({ kind: z.enum(["amount", "duration", "first"]), totalAmount: Units.nullable().default(null), durationSec: z.number().int().min(60).max(AUTO_MAX_DURATION_SEC).nullable().default(null) }),
  ...common,
});
export type DcaConfig = z.infer<typeof DcaConfig>;

export const LimitTarget = z.object({
  mcUsd: Usd,
  /** compra: lamports por wallet */
  lamportsEach: Units.nullable().default(null),
  /** venta: porcentaje de la posición de cada wallet al dispararse */
  pct: z.number().min(1).max(100).nullable().default(null),
});
export type LimitTarget = z.infer<typeof LimitTarget>;

export const LimitConfig = z.object({
  type: z.literal("limit"),
  side: z.enum(["buy", "sell"]),
  targets: z.array(LimitTarget).min(1, "Añade al menos un objetivo").max(10),
  /** validez: si pasa sin completar los objetivos, la tarea acaba en TIMEOUT */
  expirySec: z.number().int().min(60).max(AUTO_MAX_DURATION_SEC).nullable().default(null),
  ...common,
});
export type LimitConfig = z.infer<typeof LimitConfig>;

/** Errores de coherencia que zod no expresa por campo (orden de objetivos, rangos, fin). */
export function automationIssues(c: DcaConfig | LimitConfig): string[] {
  const out: string[] = [];
  if (c.mcMinUsd != null && c.mcMaxUsd != null && c.mcMinUsd >= c.mcMaxUsd) out.push("El market cap mínimo tiene que ser menor que el máximo.");
  if (c.type === "dca") {
    if (c.amount.kind === "fixed" && BigInt(c.amount.each) <= 0n) out.push("El monto por ejecución tiene que ser mayor que 0.");
    if (c.amount.kind === "range") {
      if (BigInt(c.amount.min) <= 0n) out.push("El mínimo del rango tiene que ser mayor que 0.");
      if (BigInt(c.amount.min) > BigInt(c.amount.max)) out.push("El mínimo del rango no puede superar al máximo.");
    }
    const needAmount = c.end.kind !== "duration";
    const needDuration = c.end.kind !== "amount";
    if (needAmount && !(c.end.totalAmount && BigInt(c.end.totalAmount) > 0n)) out.push("Indica el monto total en el que termina.");
    if (needDuration && !c.end.durationSec) out.push("Indica la duración.");
  } else {
    // REQ-AUTO-002: compras con objetivos descendentes y ventas con objetivos ascendentes
    for (let i = 1; i < c.targets.length; i++) {
      const a = c.targets[i - 1].mcUsd;
      const b = c.targets[i].mcUsd;
      if (c.side === "buy" && !(b < a)) out.push(`Los objetivos de compra van de mayor a menor market cap: el ${i + 1}.º (${b}) debe ser menor que el ${i}.º (${a}).`);
      if (c.side === "sell" && !(b > a)) out.push(`Los objetivos de venta van de menor a mayor market cap: el ${i + 1}.º (${b}) debe ser mayor que el ${i}.º (${a}).`);
    }
    c.targets.forEach((t, i) => {
      if (c.side === "buy" && !(t.lamportsEach && BigInt(t.lamportsEach) > 0n)) out.push(`Objetivo ${i + 1}: indica el SOL por wallet.`);
      if (c.side === "sell" && !t.pct) out.push(`Objetivo ${i + 1}: indica el porcentaje a vender.`);
    });
  }
  return out;
}

export const AutomationConfig = z.discriminatedUnion("type", [DcaConfig, LimitConfig]).superRefine((c, ctx) => {
  for (const m of automationIssues(c)) ctx.addIssue({ code: "custom", message: m });
});
export type AutomationConfig = z.infer<typeof AutomationConfig>;

export const CreateAutomationBody = z.object({ id: z.string().uuid(), label: z.string().trim().max(60).optional(), config: AutomationConfig, start: z.boolean().default(false) });

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Plan del DCA: ejecuciones previstas y monto por wallet de la ejecución `k` (0, 1, 2…).
 * Rango = rampa lineal del mínimo al máximo en las ejecuciones previstas (sin aleatoriedad).
 * Con fin por monto, la última ejecución se recorta a lo que falta (lo hace el motor con `remaining`).
 */
export function dcaPlan(c: DcaConfig, wallets: number) {
  const n = BigInt(Math.max(1, wallets));
  const min = BigInt(c.amount.kind === "fixed" ? c.amount.each : c.amount.min);
  const max = BigInt(c.amount.kind === "fixed" ? c.amount.each : c.amount.max);
  const byDuration = c.end.kind !== "amount" && c.end.durationSec ? Math.ceil(c.end.durationSec / c.intervalSec) : null;
  // ejecuciones que hacen falta para llegar al total (todas las wallets) con la rampa: N·(min+max)/2 ≥ total/n
  const perWallet = c.end.kind !== "duration" && c.end.totalAmount ? BigInt(c.end.totalAmount) / n : null;
  const byAmount = perWallet !== null ? Number(ceilDiv(perWallet * 2n, min + max)) : null;
  const executions = byDuration !== null && byAmount !== null ? Math.min(byDuration, byAmount) : (byDuration ?? byAmount);
  const steps = Math.max(1, executions ?? 1);
  const amountAt = (k: number) => (steps === 1 || min === max ? min : min + ((max - min) * BigInt(Math.min(k, steps - 1))) / BigInt(steps - 1));
  return { executions, amountAt, perWalletTotal: perWallet };
}

export type AutomationExecution = {
  seq: number;
  generation: number;
  orderId: string;
  at: number;
  mcUsd: number | null;
  target: number | null;
  items: { walletId: string; label: string | null; side: "buy" | "sell"; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; amount: string | null; result: string | null; signature: string | null; reason: string | null; retries: number }[];
};
