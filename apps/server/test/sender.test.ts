// NFR-TX-001 / REQ-LAUNCH-016: un timeout de confirmación tras emitir nunca debe llevar a emitir dos veces.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db";
import { SolanaSender } from "../src/chain/sender";
import type { RpcPool } from "../src/chain/rpc";
import type { PreparedTx } from "../src/chain/types";
import { b58encode } from "../src/base58";
import { tmpDir } from "./helpers";

function stub(opts: { status: "confirmed" | "unknown"; height: number }) {
  const calls = { sent: 0 };
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: b58encode(randomBytes(32)), lastValidBlockHeight: 1000 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 1000 } }),
    sendRawTransaction: async () => {
      calls.sent++;
      return "sig";
    },
    confirmTransaction: async () => {
      throw new Error("Transaction was not confirmed in 30.00 seconds");
    },
    getSignatureStatuses: async () => ({ value: [opts.status === "confirmed" ? { confirmationStatus: "confirmed", err: null } : null] }),
    getBlockHeight: async () => opts.height,
  };
  const pool = { run: <T>(fn: (c: never) => Promise<T>) => fn(conn as never) } as unknown as RpcPool;
  return { pool, calls };
}

const payer = b58encode(randomBytes(32));
const tx: PreparedTx = { kind: "buy", payer, signers: [payer], payload: { instructions: [] } };
const sign = () => new Uint8Array(64);

describe("tx-sender · timeout de confirmación tras emitir", () => {
  it("si la cadena dice que aterrizó, se marca CONFIRMED y el reintento no vuelve a emitir", async () => {
    const db = openDb(tmpDir());
    const { pool, calls } = stub({ status: "confirmed", height: 500 });
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1 });
    expect((await s.send(tx, { idempotencyKey: "k1" })).status).toBe("confirmed");
    expect(await s.send(tx, { idempotencyKey: "k1" })).toMatchObject({ status: "confirmed", reused: true });
    expect(calls.sent).toBe(1);
    db.close();
  });

  it("si no se sabe, queda pendiente (SENT) y el reintento no re-emite mientras el blockhash sigue vivo", async () => {
    const db = openDb(tmpDir());
    const { pool, calls } = stub({ status: "unknown", height: 500 });
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1 });
    const a = await s.send(tx, { idempotencyKey: "k2" });
    expect(a).toMatchObject({ status: "failed", code: "UNKNOWN" });
    expect((db.prepare("SELECT status FROM tx WHERE idempotency_key = 'k2'").get() as { status: string }).status).toBe("SENT");
    const b = await s.send(tx, { idempotencyKey: "k2" });
    expect(b).toMatchObject({ status: "failed", code: "UNKNOWN" });
    expect(calls.sent).toBe(1);
    db.close();
  });
});
