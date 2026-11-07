import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    deps: { optimizer: { ssr: { include: ["@coral-xyz/anchor", "@pump-fun/agent-payments-sdk", "@pump-fun/pump-sdk"] } } },
  },
  ssr: { noExternal: [/@coral-xyz\/anchor/, /@pump-fun\//] },
});
