// macOS without a Developer ID: ad-hoc sign the packed app with its entitlements, so it gets a real
// identity (app.sutra.desktop), a bound Info.plist and the mic entitlement — otherwise macOS denies the
// microphone without ever asking. ponytail: remove once electron-builder signs with a Developer ID.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function adhocSign(ctx) {
  if (ctx.electronPlatformName !== "darwin") return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const ent = join(__dirname, "..", "build", "entitlements.adhoc.plist");
  execFileSync("codesign", ["--force", "--deep", "--options", "runtime", "--sign", "-", "--entitlements", ent, app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
