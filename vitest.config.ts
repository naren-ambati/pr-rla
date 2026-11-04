import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Package self-references (as a third-party plugin would write them) resolve to the sources in tests.
    alias: {
      "pr-rla/provider": src("sdk/provider.ts"),
      "pr-rla/ledger": src("sdk/ledger.ts"),
      "pr-rla/testing": src("testing/index.ts"),
      "pr-rla/api/read": src("api/read/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Refuses every socket except loopback mocks, so the suite provably makes no network call.
    setupFiles: ["test/setup/network-deny.ts"],
    testTimeout: 60_000,
  },
});
