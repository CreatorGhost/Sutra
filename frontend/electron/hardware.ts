// What kind of computer this is — enough to recommend a speech model (see recommendModel in
// src/shared/speechModels.ts). Every probe is best-effort with a short timeout; a failed probe just
// leaves its field empty.
import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import type { HardwareInfo } from "../src/shared/speechModels";
import { findBinary } from "./proc";

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 3000, windowsHide: true }, (e, out) => resolve(e ? "" : String(out).trim()));
  });
}

let cached: Promise<HardwareInfo> | null = null;

export function detectHardware(): Promise<HardwareInfo> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<HardwareInfo> {
  const ramGB = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const info: HardwareInfo = {
    platform: process.platform, arch: process.arch, appleSilicon: false, rosetta: false,
    chip: cpus()[0]?.model?.trim() || null, ramGB, cores: cpus().length, gpu: null,
  };
  if (process.platform === "darwin") {
    // hw.optional.arm64 is 1 on Apple Silicon even for an x64 build running under Rosetta.
    const [arm, translated, brand] = await Promise.all([
      run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]),
      run("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]),
      run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    ]);
    info.appleSilicon = arm === "1" || process.arch === "arm64";
    info.rosetta = translated === "1";
    if (brand) info.chip = brand;
    return info;
  }
  const smi = await findBinary(["nvidia-smi"]);
  if (smi) {
    const line = (await run(smi, ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])).split(/\r?\n/)[0] ?? "";
    const [name, mem] = line.split(",").map((s) => s.trim());
    if (name) info.gpu = { vendor: "nvidia", name, vramGB: Number(mem) > 0 ? Math.round(Number(mem) / 1024) : null };
  }
  return info;
}
