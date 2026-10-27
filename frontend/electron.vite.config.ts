// electron-vite config for the Sutra desktop shell (ticket F1).
// Three builds from ONE source tree:
//   • main      → electron/main.ts (Electron main process)
//   • preload   → electron/preload.ts (contextIsolation bridge)
//   • renderer  → the EXISTING frontend (index.html / src/main.tsx / App) — shared verbatim with the
//                 PWA. React plugin only here; PWA service-worker generation stays on the vite build
//                 path (`build:pwa`) and isn't needed inside the packaged desktop app.
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // speechWorker = the on-device speech utility process (electron/speech/worker.ts), forked by main.
      lib: { entry: { main: resolve(__dirname, "electron/main.ts"), speechWorker: resolve(__dirname, "electron/speech/worker.ts") }, formats: ["cjs"] },
      rollupOptions: {
        output: { dir: resolve(__dirname, "out/main"), entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // CJS .js (not .mjs) — a sandboxed preload must be CommonJS.
      lib: { entry: resolve(__dirname, "electron/preload.ts"), formats: ["cjs"] },
      rollupOptions: {
        output: { dir: resolve(__dirname, "out/preload"), entryFileNames: "preload.cjs" },
      },
    },
  },
  renderer: {
    root: __dirname,
    plugins: [react()],
    build: {
      target: "es2020",
      chunkSizeWarningLimit: 1500,
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: { input: { main: resolve(__dirname, "index.html") } },
    },
    // Its own port, on one address, and fail loudly if it's taken: with a bare `port` Vite could share
    // 5173 with another project on the other address family (::1 vs 127.0.0.1) and the window might
    // load that app instead. (The web build keeps 5173 — vite.config.ts — which the backend's CORS allows.)
    server: { host: "127.0.0.1", port: 5199, strictPort: true },
  },
});
