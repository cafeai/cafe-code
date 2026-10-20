// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdir } from "node:fs/promises";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

type SecurityCommand = (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string>;
type CodeSignatureReader = (
  applicationPath: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

export function parseMacosArtifactKeychainPartition(output: string): string {
  const lines = output.split(/\r?\n/u);
  const hashes = lines.filter((line) => line.startsWith("CDHash="));
  const hash = hashes.length === 1 ? /^CDHash=([a-f0-9]{40})$/u.exec(hashes[0]!) : null;
  const teams = lines.filter((line) => line.startsWith("TeamIdentifier="));
  if (hash && teams.length === 1) {
    if (teams[0] === "TeamIdentifier=not set" && lines.includes("Signature=adhoc")) {
      return `cdhash:${hash[1]}`;
    }
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/u.exec(teams[0]!);
    if (team && lines.some((line) => line.startsWith("Authority=Developer ID Application:"))) {
      return `teamid:${team[1]}`;
    }
  }
  throw new Error("Expected unambiguous ad-hoc or Developer ID artifact identity.");
}

const readCodeSignature: CodeSignatureReader = async (applicationPath, environment) => {
  try {
    const result = await promisify(execFile)(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", applicationPath],
      { env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 },
    );
    return result.stderr;
  } catch {
    throw new Error("Could not identify the exact macOS artifact code signature.");
  }
};

const executeSecurity: SecurityCommand = async (args, environment) => {
  try {
    const result = await promisify(execFile)("/usr/bin/security", [...args], {
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16_384,
    });
    return result.stdout;
  } catch {
    // execFile errors contain argv, including the generated private password.
    throw new Error(`Isolated macOS keychain ${args[0]} failed.`);
  }
};

/** Keychain preferences and the app must share the exact same fresh HOME.
 * Apple's keychain library expands ~/Library/Preferences from HOME. Mutating
 * the runner's search list cannot configure an app launched in another home.
 * No existing user preferences or keychain contents participate in this scope. */
export async function withIsolatedMacosArtifactKeychain(
  root: string,
  environment: NodeJS.ProcessEnv,
  applicationNames: readonly string[],
  applicationPath: string,
  action: () => Promise<void>,
  security: SecurityCommand = executeSecurity,
  codeSignature: CodeSignatureReader = readCodeSignature,
): Promise<void> {
  const home = join(root, "home");
  if (!isAbsolute(root) || environment.HOME !== home || environment.CFFIXED_USER_HOME !== home) {
    throw new Error("Keychain setup requires the exact private artifact home.");
  }
  for (const path of [root, home]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Expected a real private directory.");
  }
  if (!isAbsolute(applicationPath) || applicationPath.includes("\0")) {
    throw new Error("Expected an absolute artifact executable path.");
  }
  const names = [...new Set(applicationNames)];
  for (const name of names) {
    if (!name.trim() || name.length > 160 || /[\r\n\0]/u.test(name)) {
      throw new Error("Unexpected artifact application name.");
    }
  }
  // Exclusive creation proves this home has no previous keychain preferences.
  const library = join(home, "Library");
  await mkdir(library, { mode: 0o700 });
  await mkdir(join(library, "Preferences"), { mode: 0o700 });
  const directory = join(library, "Keychains");
  await mkdir(directory, { mode: 0o700 });
  const keychain = join(directory, "runtime-smoke.keychain-db");
  // Never accept missing, ambiguous or malformed identity, including from an
  // injected command adapter. No keychain has been created at this point.
  const partition = parseMacosArtifactKeychainPartition(
    await codeSignature(applicationPath, environment),
  );
  const password = randomBytes(32).toString("hex");
  const run = (args: readonly string[]) => security(args, environment);
  try {
    await run(["create-keychain", "-p", password, keychain]);
    await run(["set-keychain-settings", "-u", "-t", "600", keychain]);
    await run(["unlock-keychain", "-p", password, keychain]);
    await run(["list-keychains", "-d", "user", "-s", keychain]);
    await run(["default-keychain", "-d", "user", "-s", keychain]);
    // Synthetic random keys avoid unsigned CI access prompts. Only this owned
    // disposable keychain grants access; real native encryption remains intact.
    for (const name of names) {
      await run([
        "add-generic-password",
        "-T",
        applicationPath,
        "-a",
        name,
        "-s",
        `${name} Safe Storage`,
        "-w",
        randomBytes(32).toString("base64"),
        keychain,
      ]);
      // -T configures the legacy application ACL, but security also stamps a
      // separate apple-tool: partition. Electron then blocks in native key
      // access despite the unlocked keychain. macOS identifies ad-hoc clients
      // by CDHash and Developer ID clients by team, with the exact executable's
      // application ACL retained alongside this disposable partition grant.
      await run([
        "set-generic-password-partition-list",
        "-S",
        `apple-tool:,${partition}`,
        "-a",
        name,
        "-s",
        `${name} Safe Storage`,
        "-k",
        password,
        keychain,
      ]);
    }
    await action();
  } finally {
    await run(["delete-keychain", keychain]);
  }
}
