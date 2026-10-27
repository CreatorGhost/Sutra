// macOS without a Developer ID: sign the packed app with its entitlements, so it gets a real identity
// (app.sutra.desktop), a bound Info.plist and the mic entitlement — otherwise macOS denies the microphone
// without ever asking. With a local code-signing certificate in the keychain ("Sutra Local Signing", or
// SUTRA_SIGN_IDENTITY) the identity is the same every build, so macOS keeps the mic and Screen Recording
// permissions across rebuilds; without one it falls back to ad-hoc ("-"), which loses them each build.
// ponytail: remove once electron-builder signs with a Developer ID.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

function identity() {
  const name = process.env.SUTRA_SIGN_IDENTITY || "Sutra Local Signing";
  try {
    const out = execFileSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(`"${name}"`));
    const hash = line && line.match(/\b([0-9A-F]{40})\b/)?.[1];
    if (hash) return hash;
  } catch { /* no keychain access: ad-hoc */ }
  console.warn(`  • no "${name}" certificate — ad-hoc signing (permissions reset on each build)`);
  return "-";
}

exports.default = async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const ent = join(__dirname, "..", "build", "entitlements.adhoc.plist");
  execFileSync("codesign", ["--force", "--deep", "--options", "runtime", "--sign", identity(), "--entitlements", ent, app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
