import { z } from "zod";

export const PROFILES = ["test", "mainnet"] as const;
export type Profile = (typeof PROFILES)[number];

export const API_PORT = 4318;
export const WEB_PORT = 4317;
export const ALLOWED_HOSTS = [`127.0.0.1:${WEB_PORT}`, `localhost:${WEB_PORT}`, `127.0.0.1:${API_PORT}`, `localhost:${API_PORT}`];
export const ALLOWED_ORIGINS = [`http://127.0.0.1:${WEB_PORT}`, `http://localhost:${WEB_PORT}`];
export const SESSION_HEADER = "x-nebula-session";
export const STEP_UP_HEADER = "x-nebula-stepup";

export const MIN_PASSWORD = 12;

// ── Bóveda ─────────────────────────────────────────
export const VaultStatus = z.object({
  profile: z.enum(PROFILES),
  initialized: z.boolean(),
  unlocked: z.boolean(),
  autoLockMin: z.number(),
  lockInSec: z.number().nullable(),
  retryInSec: z.number(),
  paused: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string() })),
});
export type VaultStatus = z.infer<typeof VaultStatus>;

export const SetupBody = z.object({ password: z.string().min(MIN_PASSWORD).max(256), ack: z.literal(true) });
export const PasswordBody = z.object({ password: z.string().min(1).max(256) });
export const StepUpActions = ["export-keys", "withdraw", "delete-wallet", "change-password", "restore"] as const;
export type StepUpAction = (typeof StepUpActions)[number];
export const ConfirmBody = z.object({ password: z.string().min(1).max(256), action: z.enum(StepUpActions) });
export const ChangePasswordBody = z.object({ newPassword: z.string().min(MIN_PASSWORD).max(256) });

// ── Wallets ───────────────────────────────────────
export const ROLE_RE = /^[a-z0-9_]{1,32}$/;
export const Role = z.string().regex(ROLE_RE, "Rol: minúsculas, dígitos y _, hasta 32 caracteres");
export const BUILTIN_ROLES = ["dev", "holder", "trading"] as const;

export const WalletDto = z.object({
  id: z.string(),
  label: z.string(),
  address: z.string(),
  kind: z.enum(["wallet", "funder"]),
  role: z.string().nullable(),
  archived: z.boolean(),
  isDefaultFunder: z.boolean(),
  folderIds: z.array(z.string()),
  createdAt: z.number(),
});
export type WalletDto = z.infer<typeof WalletDto>;

export const FolderDto = z.object({ id: z.string(), name: z.string(), createdAt: z.number() });
export type FolderDto = z.infer<typeof FolderDto>;

export const CreateWalletsBody = z.object({
  count: z.number().int().min(1).max(100),
  role: Role.nullable().optional(),
  folderId: z.string().nullable().optional(),
  labelPrefix: z.string().max(24).optional(),
  kind: z.enum(["wallet", "funder"]).default("wallet"),
});
export const ImportWalletsBody = z.object({
  text: z.string().max(200_000),
  role: Role.nullable().optional(),
  folderId: z.string().nullable().optional(),
  kind: z.enum(["wallet", "funder"]).default("wallet"),
});
export const ImportRow = z.object({ line: z.number(), status: z.enum(["imported", "duplicate", "invalid"]), address: z.string().optional(), reason: z.string().optional() });
export type ImportRow = z.infer<typeof ImportRow>;

export const PatchWalletsBody = z.object({
  ids: z.array(z.string()).min(1).max(1000),
  role: Role.nullable().optional(),
  archived: z.boolean().optional(),
  label: z.string().trim().min(1).max(40).optional(),
});
export const ExportBody = z.object({ ids: z.array(z.string()).min(1).max(1000) });
export const FolderBody = z.object({ name: z.string().trim().min(1).max(40) });
export const FolderMembersBody = z.object({ walletIds: z.array(z.string()).min(1).max(1000), op: z.enum(["add", "remove"]) });

// ── Ajustes (REQ-SET-001/002) ─────────────────────
export const SettingsDto = z.object({
  rpcPrimaryHttp: z.string(),
  rpcPrimaryWs: z.string(),
  rpcBackupHttp: z.string(),
  rpcBackupWs: z.string(),
  jitoEndpoint: z.string(),
  jitoTipSol: z.number().min(0).max(1),
  slippageBuyPct: z.number().min(0.1).max(50),
  slippageSellPct: z.number().min(0.1).max(50),
  priorityFeeSol: z.number().min(0).max(0.1),
  autoLockMin: z.number().int().min(0).max(240),
  keyboardLayout: z.enum(["qwerty", "azerty", "qwertz"]),
  theme: z.enum(["dark", "light"]),
  /** Pasarela pública con la que se forman las URI de metadatos (Pinata solo sube). */
  ipfsGateway: z.string().max(200),
  /** Límites del proveedor de RPC (0 = sin límite). Helius Free: 10 peticiones/s y 1 envío/s. */
  rpcMaxRps: z.number().int().min(0).max(1000),
  rpcSendPerSec: z.number().min(0).max(100),
  /** Secretos: el GET solo devuelve si están configurados, nunca el valor. */
  ipfsKeySet: z.boolean(),
  rpcKeySet: z.boolean(),
  rpcBackupKeySet: z.boolean(),
});
export type SettingsDto = z.infer<typeof SettingsDto>;
const rpcUrl = (ws: boolean) =>
  z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || (ws ? /^wss?:\/\/\S+$/ : /^https?:\/\/\S+$/).test(v), ws ? "URL ws:// o wss:// completa" : "URL http:// o https:// completa");
export const PutSettingsBody = SettingsDto.omit({ ipfsKeySet: true, rpcKeySet: true, rpcBackupKeySet: true })
  .partial()
  .extend({
    rpcPrimaryHttp: rpcUrl(false).optional(),
    rpcPrimaryWs: rpcUrl(true).optional(),
    rpcBackupHttp: rpcUrl(false).optional(),
    rpcBackupWs: rpcUrl(true).optional(),
    ipfsGateway: z
      .string()
      .trim()
      .max(200)
      .refine((v) => /^https:\/\/[^\s]+\/$/.test(v), "Pasarela: URL https:// que acabe en / (p. ej. https://ipfs.io/ipfs/)")
      .optional(),
    ipfsKey: z.string().max(2000).optional(),
    rpcKey: z.string().max(500).optional(),
    rpcBackupKey: z.string().max(500).optional(),
  });

/** Marcador de la clave del RPC dentro de la URL: la clave real vive cifrada en la bóveda. */
export const RPC_KEY_PLACEHOLDER = "{key}";

export const ActivityDto = z.object({ id: z.number(), at: z.number(), kind: z.string(), detail: z.string() });
export type ActivityDto = z.infer<typeof ActivityDto>;
export * from "./automations";
