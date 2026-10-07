const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const os = require("node:os");

// Signing changes Mach-O bytes. Record the final signed helper hash, then seal
// only the outer app again so signing cannot change the helper a second time.
// Preserve the original app's identifier, entitlements and runtime flags.
module.exports = async function finalizeCuaSigning(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const root = path.join(app, "Contents", "Resources", "cua-driver");
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  const run = (args) => {
    const result = spawnSync("/usr/bin/codesign", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) throw new Error("Cua signing qualification failed.");
    return result.stderr.toString("utf8");
  };
  const executable = path.join(root, "cua-driver");
  for (const [file, limit] of [
    [manifestPath, 16 * 1024],
    [executable, 128 * 1024 * 1024],
  ]) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      throw new Error("Invalid staged Cua signing payload.");
  }
  run(["--verify", "--strict", executable]);
  run(["--verify", "--strict", app]);
  const appInfo = run(["--display", "--verbose=4", app]);
  const helperInfo = run(["--display", "--verbose=4", executable]);
  const adhoc = /Signature=adhoc/u.test(appInfo);
  let identity = adhoc ? "-" : /^Authority=(.+)$/mu.exec(appInfo)?.[1];
  const team = /^TeamIdentifier=(.+)$/mu.exec(appInfo)?.[1];
  if (
    !identity ||
    (!adhoc && (!team || team === "not set" || !helperInfo.includes(`TeamIdentifier=${team}\n`)))
  )
    throw new Error("The signed Cua helper must belong to the app's signing team.");
  let keychain;
  if (!adhoc) {
    // Match the exact leaf certificate rather than a potentially ambiguous
    // display name, and retain electron-builder's temporary signing keychain.
    const certificates = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-cua-cert-"));
    try {
      const prefix = path.join(certificates, "cert");
      run(["--display", "--extract-certificates", prefix, app]);
      identity = crypto
        .createHash("sha1")
        .update(fs.readFileSync(`${prefix}0`))
        .digest("hex");
    } finally {
      fs.rmSync(certificates, { recursive: true, force: true });
    }
    keychain = (await context.packager.codeSigningInfo?.value)?.keychainFile;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.sha256 = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run([
    "--force",
    "--sign",
    identity,
    "--preserve-metadata=identifier,requirements,entitlements,flags,runtime",
    ...(adhoc ? [] : ["--timestamp"]),
    ...(typeof keychain === "string" ? ["--keychain", keychain] : []),
    app,
  ]);
  run(["--verify", "--strict", app]);
};
