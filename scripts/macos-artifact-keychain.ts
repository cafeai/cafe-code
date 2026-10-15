import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

type SecurityCommand = (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string>;

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
  action: () => Promise<void>,
  security: SecurityCommand = executeSecurity,
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
  // Exclusive creation proves this home has no previous keychain preferences.
  const library = join(home, "Library");
  await mkdir(library, { mode: 0o700 });
  await mkdir(join(library, "Preferences"), { mode: 0o700 });
  const directory = join(library, "Keychains");
  await mkdir(directory, { mode: 0o700 });
  const keychain = join(directory, "runtime-smoke.keychain-db");
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
    for (const name of new Set(applicationNames)) {
      if (!name.trim() || name.length > 160 || /[\r\n\0]/u.test(name)) {
        throw new Error("Unexpected artifact application name.");
      }
      await run([
        "add-generic-password",
        "-A",
        "-a",
        name,
        "-s",
        `${name} Safe Storage`,
        "-w",
        randomBytes(32).toString("base64"),
        keychain,
      ]);
    }
    await action();
  } finally {
    await run(["delete-keychain", keychain]);
  }
}
