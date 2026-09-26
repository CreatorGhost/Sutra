// macOS: which apps are recording from the mic right now, via the tiny Swift helper
// (electron/native/micwatch.swift). Prebuilt into the packaged app when built on a Mac; otherwise
// compiled once on first launch if the Xcode command-line tools are present. Without it, meeting
// detection still works from browser tabs, window titles and Zoom's CptHost.
import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MicConsumer } from "../src/shared/meetingRules";
import { findBinary, runProcess } from "./proc";

let helper: string | null | undefined;
let building: Promise<string | null> | null = null;

function sourcePath(): string | null {
  const candidates = [join(process.resourcesPath ?? "", "native", "micwatch.swift"), join(__dirname, "../../electron/native/micwatch.swift")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function resolveHelper(): Promise<string | null> {
  const prebuilt = [join(process.resourcesPath ?? "", "native", "micwatch"), join(__dirname, "../../electron/native/micwatch")];
  const hit = prebuilt.find((p) => existsSync(p));
  if (hit) return hit;
  const compiled = join(app.getPath("userData"), "bin", `micwatch-${app.getVersion()}`);
  if (existsSync(compiled)) return compiled;
  const src = sourcePath();
  const xcrun = await findBinary(["xcrun"]);
  if (!src || !xcrun) return null;
  await mkdir(join(app.getPath("userData"), "bin"), { recursive: true });
  const r = await runProcess(xcrun, ["swiftc", "-O", src, "-o", compiled], { timeoutMs: 180000 }).catch(() => null);
  return r && r.code === 0 && existsSync(compiled) ? compiled : null;
}

/** Apps capturing the mic (macOS 14.2+), or null when the helper isn't available. */
export async function macMicConsumers(): Promise<MicConsumer[] | null> {
  if (process.platform !== "darwin") return null;
  if (helper === undefined) {
    building ??= resolveHelper().catch(() => null);
    helper = await building;
  }
  if (!helper) return null;
  const r = await runProcess(helper, [], { timeoutMs: 3000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout) as { path?: string; bundleId?: string }[];
    return rows.map((x) => ({ path: x.path, name: x.bundleId }));
  } catch {
    return null;
  }
}
