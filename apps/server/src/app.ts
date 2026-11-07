import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { ZodError } from "zod";
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, SESSION_HEADER, STEP_UP_HEADER, type Profile } from "@nebula/shared";
import { openDb, type DB } from "./db";
import { Vault, VaultError, sodiumReady } from "./signer";
import { pauseRunningTasks } from "./tasks";
import { vaultRoutes } from "./routes/vault";
import { walletRoutes } from "./routes/wallets";
import { settingsRoutes } from "./routes/settings";
import { chainRoutes } from "./routes/chain";
import { ChainManager } from "./chain-manager";
import { isNetworkError } from "./chain/rpc";
import { Operations } from "./operations";
import { operationRoutes } from "./routes/operations";
import { Launches } from "./launches";
import { launchRoutes } from "./routes/launches";
import { metadataStoreFor, type PinataEndpoints } from "./ipfs";
import { scrub } from "./settings";
import { Live } from "./live";
import { Trading } from "./trading";
import { Rewards } from "./rewards";
import { Reclaim } from "./reclaim";
import { Vanity } from "./vanity";
import { liveRoutes } from "./routes/live";
import { Automations } from "./automations";
import { automationRoutes } from "./routes/automations";
import { Pnl } from "./pnl";
import { Drafts } from "./drafts";
import { Presets } from "./presets";
import { Tracker } from "./tracker";
import { TokenOps } from "./token-ops";
import { tokenRoutes } from "./routes/tokens";
import { presetRoutes } from "./routes/presets";
import { trackerRoutes } from "./routes/tracker";
import { Cloner } from "./clone";
import { Backups } from "./backups";
import { storedSettings } from "./settings";
import { dashboardRoutes } from "./routes/dashboard";

export type Ctx = {
  profile: Profile;
  dataDir: string;
  token: string;
  vault: Vault;
  db: () => DB;
  reopenDb: () => DB;
  closeDb: () => void;
  chain: ChainManager;
  ops: Operations;
  launches: Launches;
  live: Live;
  trading: Trading;
  rewards: Rewards;
  reclaim: Reclaim;
  vanity: Vanity;
  automations: Automations;
  pnl: Pnl;
  drafts: Drafts;
  presets: Presets;
  tracker: Tracker;
  tokenOps: TokenOps;
  cloner: Cloner;
  backups: Backups;
};

/** Rutas de log que nunca deben escribirse (NFR-SEC-004). */
export const REDACT_PATHS = [
  `req.headers["${SESSION_HEADER}"]`,
  `req.headers["${STEP_UP_HEADER}"]`,
  "req.headers.cookie",
  "password",
  "newPassword",
  "*.password",
  "*.newPassword",
  "secretKey",
  "*.secretKey",
  "secret",
  "*.secret",
  "keys",
  "*.keys",
  "ipfsKey",
  "rpcKey",
  "*.ipfsKey",
  "*.rpcKey",
  "body",
  "*.body",
];

export function createLogger(dataDir: string, toStdout = true) {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  // NFR-SEC-004: además de la redacción por ruta, todo lo escrito pasa por `scrub` (secretos por valor)
  const file = pino.destination({ dest: join(dir, "nebula.log"), sync: true, mkdir: true });
  const streams: pino.StreamEntry[] = [{ stream: { write: (m: string) => file.write(scrub(m)) } }];
  if (toStdout) streams.push({ stream: { write: (m: string) => process.stdout.write(scrub(m)) } });
  return pino({ level: "info", redact: { paths: REDACT_PATHS, censor: "[redactado]" } }, pino.multistream(streams));
}

export async function buildApp(opts: { profile: Profile; dataDir: string; token?: string; logToStdout?: boolean; chainMode?: "rpc" | "mock"; clock?: () => number; ipfs?: { pinata: PinataEndpoints; fetch?: typeof fetch } }) {
  await sodiumReady();
  let db: DB | null = openDb(opts.dataDir);
  const getDb = () => {
    if (!db) throw new Error("Base de datos cerrada");
    return db;
  };
  const vault = new Vault(getDb);
  let chainManager: ChainManager | null = null;
  let tracker: Tracker | null = null;
  let operations: Operations | null = null;
  let launches: Launches | null = null;
  let live: Live | null = null;
  let trading: Trading | null = null;
  let rewards: Rewards | null = null;
  let reclaim: Reclaim | null = null;
  let vanity: Vanity | null = null;
  let automations: Automations | null = null;
  let pnl: Pnl | null = null;
  let tokenOps: TokenOps | null = null;
  let cloner: Cloner | null = null;
  const ctx: Ctx = {
    profile: opts.profile,
    dataDir: opts.dataDir,
    token: opts.token ?? randomBytes(32).toString("hex"),
    vault,
    db: getDb,
    reopenDb: () => (db = openDb(opts.dataDir)),
    get chain() {
      return chainManager!;
    },
    get ops() {
      return operations!;
    },
    get launches() {
      return launches!;
    },
    get live() {
      return live!;
    },
    get trading() {
      return trading!;
    },
    get rewards() {
      return rewards!;
    },
    get reclaim() {
      return reclaim!;
    },
    get vanity() {
      return vanity!;
    },
    get automations() {
      return automations!;
    },
    get pnl() {
      return pnl!;
    },
    drafts: new Drafts(getDb),
    presets: new Presets(getDb),
    get tracker() {
      return (tracker ??= new Tracker(getDb, chainManager!));
    },
    get tokenOps() {
      return tokenOps!;
    },
    get cloner() {
      return cloner!;
    },
    backups: new Backups(getDb, opts.dataDir, opts.clock ?? Date.now),
    closeDb: () => {
      db?.close();
      db = null;
    },
  };

  // REQ-AUTO-008 / REQ-VAULT-003: al arrancar y al bloquear, lo que estaba RUNNING pasa a PAUSED.
  pauseRunningTasks(getDb(), "restart");
  vault.onLock(() => pauseRunningTasks(getDb(), "lock"));

  const logger = createLogger(opts.dataDir, opts.logToStdout ?? true);
  chainManager = new ChainManager({ profile: opts.profile, mode: opts.chainMode ?? "rpc", db: getDb, vault, log: (m) => logger.info(m) });
  chainManager.reload();
  // La clave del RPC solo se descifra con la bóveda abierta: se reconecta al abrirla y, si la usa, se suelta al bloquear
  vault.onUnlock(() => {
    if (chainManager!.usesKey() || chainManager!.state().mode === "off") {
      live?.stopAll();
      chainManager!.reload();
    }
  });
  vault.onLock(() => {
    if (chainManager!.usesKey()) {
      live?.stopAll();
      chainManager!.reload();
    }
  });
  operations = new Operations(getDb, chainManager, vault, (m) => logger.info(m));
  // Una operación que estaba en marcha cuando se cerró el proceso queda en pausa (REQ-AUTO-008)
  operations.pauseAllRunning();
  vault.onLock(() => operations?.pauseAllRunning());
  const priority = () => {
    const s = JSON.parse((getDb().prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string } | undefined)?.value ?? "{}") as { priorityFeeSol?: number };
    return Math.max(1, Math.round(((s.priorityFeeSol ?? 0.0001) * 1e9 * 1e6) / 400_000));
  };
  launches = new Launches(getDb, chainManager, vault, metadataStoreFor(opts.profile, getDb, vault, opts.ipfs), opts.profile, priority, (m) => logger.info(m), opts.clock ?? Date.now);
  launches.pauseAllRunning();
  launches.recoverInterrupted();
  vault.onLock(() => launches?.pauseAllRunning());
  // REQ-LAUNCH-015 / REQ-VAULT-003: un reinicio NO pausa los programados (se lanzan a su hora si la bóveda
  // está abierta); bloquear sí, y llegar la hora con la bóveda bloqueada también
  vault.onLock((reason) => reason !== "shutdown" && launches?.pauseScheduled("lock"));
  if (!opts.clock) launches.startScheduler();
  live = new Live(getDb, chainManager, (m) => logger.info(m));
  launches.attachTrades((mint) => live!.tradesNow(mint));
  trading = new Trading(getDb, chainManager, vault, live, priority, (m) => logger.info(m));
  trading.pauseAllRunning();
  vault.onLock(() => trading?.pauseAllRunning());
  rewards = new Rewards(getDb, chainManager, vault, priority, (m) => logger.info(m));
  rewards.pauseAllRunning();
  vault.onLock(() => rewards?.pauseAllRunning());
  reclaim = new Reclaim(getDb, chainManager, vault, (m) => logger.info(m));
  reclaim.pauseAllRunning();
  vault.onLock(() => reclaim?.pauseAllRunning());
  vanity = new Vanity(getDb, vault, chainManager, (m) => logger.info(m));
  vault.onLock(() => vanity?.cancelAll());
  // REQ-AUTO: el motor solo trabaja con la bóveda abierta; al bloquear, pauseRunningTasks deja lo RUNNING en PAUSED
  automations = new Automations(getDb, vault, trading, live, opts.clock ?? Date.now, (m) => logger.info(m));
  automations.start();
  pnl = new Pnl(getDb, chainManager, live, vault, (m) => logger.info(m), opts.clock ?? Date.now);
  pnl.start();
  tokenOps = new TokenOps(getDb, chainManager, vault, live, (m) => logger.info(m));
  cloner = new Cloner(getDb, chainManager, launches.store, () => storedSettings(getDb()).ipfsGateway, opts.ipfs?.fetch ?? fetch);
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  // ── NFR-SEC-003: Host exacto (anti DNS rebinding), Origin exacto y token de sesión ─────
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host ?? "";
    if (!ALLOWED_HOSTS.includes(host)) return reply.code(403).send({ code: "BAD_HOST", message: "Host no permitido" });
    const origin = req.headers.origin;
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (origin !== undefined && !ALLOWED_ORIGINS.includes(origin)) return reply.code(403).send({ code: "BAD_ORIGIN", message: "Origen no permitido" });
    if (mutating && origin === undefined) return reply.code(403).send({ code: "BAD_ORIGIN", message: "Falta Origin" });
    const sent = req.headers[SESSION_HEADER];
    const a = Buffer.from(typeof sent === "string" ? sent : "");
    const b = Buffer.from(ctx.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ code: "BAD_SESSION", message: "Token de sesión inválido" });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof VaultError) {
      const status = { NOT_INITIALIZED: 409, ALREADY_INITIALIZED: 409, LOCKED: 423, BAD_PASSWORD: 400, RETRY_LATER: 429, BAD_STEP_UP: 403, NO_KEY: 409 }[err.code];
      return reply.code(status).send({ code: err.code, message: err.message, retryInSec: err.retryInSec });
    }
    if (err instanceof ZodError) return reply.code(400).send({ code: "VALIDATION", message: err.issues.map((i) => i.message).join(" · ") });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ code: "BAD_REQUEST", message: scrub(e.message ?? "") });
    if (isNetworkError(err)) {
      // Sin RPC alcanzable (p. ej. mainnet con el RPC local por defecto): mensaje accionable en vez de «Error interno».
      req.log.warn({ err: { message: scrub(e.message ?? "") } }, "RPC inalcanzable");
      return reply.code(503).send({ code: "RPC_UNREACHABLE", message: "No hay conexión con el RPC. Revisa la URL y la clave del RPC principal en Ajustes." });
    }
    req.log.error({ err: { message: scrub(e.message ?? "") } }, "error no controlado");
    return reply.code(500).send({ code: "INTERNAL", message: "Error interno. Revisa los logs locales." });
  });

  await app.register(vaultRoutes(ctx), { prefix: "/api/vault" });
  await app.register(walletRoutes(ctx), { prefix: "/api" });
  await app.register(settingsRoutes(ctx), { prefix: "/api" });
  await app.register(chainRoutes(ctx), { prefix: "/api" });
  await app.register(operationRoutes(ctx), { prefix: "/api" });
  await app.register(launchRoutes(ctx), { prefix: "/api" });
  await app.register(liveRoutes(ctx), { prefix: "/api" });
  await app.register(automationRoutes(ctx), { prefix: "/api" });
  await app.register(dashboardRoutes(ctx), { prefix: "/api" });
  await app.register(tokenRoutes(ctx), { prefix: "/api" });
  await app.register(presetRoutes(ctx), { prefix: "/api" });
  await app.register(trackerRoutes(ctx), { prefix: "/api" });

  app.addHook("onClose", async () => {
    vault.stop();
    automations?.stop();
    pnl?.stop();
    launches?.stopScheduler();
    live?.stopAll();
    chainManager?.stop();
    ctx.closeDb();
  });

  return { app, ctx };
}
