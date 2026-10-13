// Compile the macOS mic watcher (electron/native/micwatch.swift) during `npm run build:desktop`.
// No-op on other platforms or when Xcode command-line tools are missing — the app then falls back to
// compiling it on first launch, or to tab/window-title detection.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (process.platform !== "darwin") process.exit(0);
const src = "electron/native/micwatch.swift", out = "electron/native/micwatch";
try {
  execFileSync("xcrun", ["swiftc", "-O", src, "-o", out], { stdio: "inherit" });
  console.log(existsSync(out) ? `built ${out}` : "micwatch build produced no binary");
} catch (e) {
  console.warn("micwatch: skipped (Xcode command-line tools not available):", e.message);
}
