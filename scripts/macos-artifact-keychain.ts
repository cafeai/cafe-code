import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

type SecurityCommand = (args: readonly string[]) => Promise<string>;

const executeSecurity: SecurityCommand = async (args) => {
  try {
    const result = await promisify(execFile)("/usr/bin/security", [...args], {
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

function readKeychainPaths(output: string): string[] {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 32) throw new Error("Unexpected keychain search list size.");
  return lines.map((line) => {
    const path: unknown = JSON.parse(line.trim());
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
      throw new Error("Unexpected keychain path.");
    }
    return path;
  });
}

/** Explicit CI fixture only. Existing keychain contents/passwords are never
 * read; original default/search preferences are restored on failure. */
export async function withIsolatedMacosArtifactKeychain(
  root: string,
  action: () => Promise<void>,
  security: SecurityCommand = executeSecurity,
  applicationNames: readonly string[] = [],
): Promise<void> {
  if (!isAbsolute(root)) throw new Error("Expected an absolute private keychain directory.");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Expected a real private keychain directory.");
  }
  const keychain = join(root, "runtime-smoke.keychain-db");
  try {
    await lstat(keychain);
    throw new Error("Private artifact keychain already exists.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const originalDefault = readKeychainPaths(await security(["default-keychain", "-d", "user"]));
  if (originalDefault.length !== 1) throw new Error("Expected one default keychain.");
  const originalSearch = readKeychainPaths(await security(["list-keychains", "-d", "user"]));
  const password = randomBytes(32).toString("hex");
  try {
    await security(["create-keychain", "-p", password, keychain]);
    await security(["set-keychain-settings", "-u", "-t", "600", keychain]);
    await security(["unlock-keychain", "-p", password, keychain]);
    // The smoke must not fall through to an identically named credential in
    // the runner's login keychain and trigger its interactive access prompt.
    await security(["list-keychains", "-d", "user", "-s", keychain]);
    await security(["default-keychain", "-d", "user", "-s", keychain]);
    // Unsigned CI builds cannot establish a stable trusted-app ACL. Seed only
    // synthetic keys in this owned disposable keychain so the real native
    // safeStorage round trip does not wait for a desktop permission dialog.
    for (const name of new Set(applicationNames)) {
      if (!name.trim() || name.length > 160 || /[\r\n\0]/u.test(name)) {
        throw new Error("Unexpected artifact application name.");
      }
      await security([
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
    const failures: unknown[] = [];
    for (const args of [
      ["default-keychain", "-d", "user", "-s", originalDefault[0]!],
      ["list-keychains", "-d", "user", "-s", ...originalSearch],
      ["delete-keychain", keychain],
    ]) {
      try {
        await security(args);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length !== 0) throw new Error("Isolated macOS keychain cleanup failed.");
  }
}
