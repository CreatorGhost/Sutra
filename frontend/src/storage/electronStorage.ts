// Renderer-side desktop StorageProvider — the proxy half of ticket F5 (approach #3).
// The real DB (better-sqlite3-multiple-ciphers + safeStorage key) runs in the Electron MAIN process
// (electron/storage.ts); the sandboxed renderer can't load native modules, so this provider forwards
// q/run/exec/persist over the preload-exposed `sutraDesktop.db` IPC bridge and returns the rows the
// main process sends back — same StorageProvider shape as the in-process desktop adapter and db.ts.
//
// Importing this module pulls in NO native code (it only calls the preload bridge), so it's safe in
// the shared renderer/PWA bundle — though it's only ever USED when the Electron bridge is present.
import type { RunResult, StorageProvider } from "./StorageProvider";

/** The preload bridge shape (electron/preload.ts). `db` is the typed invoke channel to the main
 *  process's `sutra:db` handler. */
interface DesktopBridge {
  isDesktop: true;
  db: (op: "q" | "run" | "exec" | "persist", sql: string, params: any[]) => Promise<any>;
}

function bridge(): DesktopBridge {
  const b = (globalThis as any).sutraDesktop as DesktopBridge | undefined;
  if (!b?.db) {
    throw new Error("Electron desktop bridge (sutraDesktop.db) is unavailable in this runtime.");
  }
  return b;
}

/** Build the renderer-side desktop StorageProvider that proxies to the main process over IPC. */
export function createElectronStorageProvider(): StorageProvider {
  return {
    kind: "desktop",
    async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      return (await bridge().db("q", sql, params)) as T[];
    },
    async run(sql: string, params: any[] = []): Promise<RunResult> {
      return (await bridge().db("run", sql, params)) as RunResult;
    },
    async exec(sql: string): Promise<void> {
      await bridge().db("exec", sql, []);
    },
    async persist(): Promise<void> {
      await bridge().db("persist", "", []);
    },
  };
}
