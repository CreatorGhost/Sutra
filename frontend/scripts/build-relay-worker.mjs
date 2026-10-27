// Bundle the relay Worker (infra/sutra-relay) into one file the app ships, so "Reach from anywhere"
// can deploy it to the user's own Cloudflare account without the repo (electron/pairing/relayWorker.ts).
// Runs before `electron-vite dev` and in `build:desktop`; writes out/relay-worker/worker.js.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../out/relay-worker/worker.js");
await build({
  entryPoints: [join(here, "../../infra/sutra-relay/src/worker.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["cloudflare:*"],
  legalComments: "none",
  logLevel: "warning",
});
console.log(`relay worker → ${out}`);
