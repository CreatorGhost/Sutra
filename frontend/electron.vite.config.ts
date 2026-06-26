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
      lib: { entry: resolve(__dirname, "electron/main.ts"), formats: ["cjs"] },
      rollupOptions: {
        output: { dir: resolve(__dirname, "out/main"), entryFileNames: "main.cjs" },
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
    server: { port: 5173 },
  },
});
