import { portOpen, startApi } from "./harness";

export default async function globalSetup() {
  if (!(await portOpen(8899))) throw new Error("Surfpool no responde en 127.0.0.1:8899. Usa `pnpm test:e2e` (lo arranca) o `pnpm surfpool`.");
  await startApi();
}
