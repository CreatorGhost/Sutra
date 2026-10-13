// .tar.bz2 extraction for sherpa-onnx model archives, run inside the speech utility process (pure-JS
// bzip2 blocks its thread for ~0.5 s at a time — fine there, never on the main process).
//
// The OS tar is tried first because it is ~20× faster: macOS ships bsdtar, Windows 10 1803+ ships
// %SystemRoot%\System32\tar.exe (also bsdtar, bzip2 built in), most Linux distros have GNU tar + bzip2.
// When it is missing or fails, a pure-JS path (unbzip2-stream → node-tar) does the same job, so no user
// ever has to install anything. Both refuse absolute paths and ".." entries.
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";

function systemTar(): string | null {
  if (process.platform === "win32") {
    const p = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
    return existsSync(p) ? p : null;
  }
  for (const p of ["/usr/bin/tar", "/bin/tar"]) if (existsSync(p)) return p;
  return null;
}

function runTar(bin: string, archive: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-xjf", archive, "-C", dest], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** The no-external-tools path (exported for tests). */
export async function jsExtract(archive: string, dest: string): Promise<void> {
  // Loaded on demand: only needed when the OS tar is missing or failed.
  const bunzip = require("unbzip2-stream") as () => NodeJS.ReadWriteStream;
  const tar = require("tar") as { x(o: { cwd: string; strict: boolean }): NodeJS.WritableStream };
  await pipeline(createReadStream(archive), bunzip(), tar.x({ cwd: dest, strict: true }));
}

/** Extract `archive` into `dest` (created if needed). */
export async function extractTarBz2(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const bin = systemTar();
  if (bin && (await runTar(bin, archive, dest))) return;
  // A failed system extraction may have left partial files behind; start clean.
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await jsExtract(archive, dest);
}

/** Every file under `root`, as paths relative to it (forward slashes). */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  await walk(root);
  return out;
}
