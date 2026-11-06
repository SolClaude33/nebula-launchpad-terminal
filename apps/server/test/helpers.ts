import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app";

export const PW = "correct horse battery staple";
export const ORIGIN = "http://127.0.0.1:4317";
export const HOST = "127.0.0.1:4318";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "nebula-test-"));

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function makeApp(dataDir = tmpDir()) {
  const { app, ctx } = await buildApp({ profile: "test", dataDir, token: "t".repeat(64), logToStdout: false });
  const call = async (method: Method, url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        host: HOST,
        origin: ORIGIN,
        "x-nebula-session": ctx.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = undefined;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, raw: res.rawPayload };
  };
  const stepUp = async (action: string, password = PW) => (await call("POST", "/api/vault/confirm", { password, action })).json.token as string;
  return { app, ctx, call, stepUp, dataDir };
}
