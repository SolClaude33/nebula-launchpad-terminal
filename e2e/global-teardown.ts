import { stopApi } from "./harness";

export default async function globalTeardown() {
  await stopApi().catch(() => {});
}
