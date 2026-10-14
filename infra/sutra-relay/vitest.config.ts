import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The Workers runtime module only exists inside workerd; tests drive RelayHub through fakes.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
