import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Deliberately content-free: startup errors must not disclose native homes,
 * settings, credentials or arbitrary filesystem errors to diagnostic clients. */
export class DebugDataProfileError extends Error {
  constructor() {
    super(
      "Debug data profile is unavailable or unsafe. Check its permissions and free space. Production data was not selected.",
    );
    this.name = "DebugDataProfileError";
  }
}

const privateDirectories = [
  "",
  "userdata",
  "userdata/secrets",
  "userdata/logs",
  "userdata/logs/provider",
  "userdata/tls",
  "userdata/attachments",
  "userdata/provider-daemon-ipc",
  "userdata/chromium-session",
  "caches",
  "worktrees",
  "standalone-workspaces",
  "provider-homes",
  "restart-logs",
] as const;

const stateFiles = [
  "state.sqlite",
  "state.sqlite-wal",
  "state.sqlite-shm",
  "settings.json",
  "keybindings.json",
  "system-prompt.md",
  "client-settings.json",
  "desktop-settings.json",
  "saved-environments.json",
  "server-runtime.json",
  "environment-id",
  "provider-daemon.json",
  "provider-daemon-token.bin",
  "tls/server-cert.pem",
] as const;

/** Admit the fixed Debug namespace before any layer can open settings or SQLite.
 * No production file is opened or copied. Existing unsafe entries are preserved,
 * never repaired with chmod/unlink or substituted with the production profile.
 * This is startup admission, not a sandbox against another same-user process
 * mutating the namespace later; individual native storage owners retain their
 * own publication/descriptor checks throughout their operations. */
export async function prepareDebugDataProfile(
  configuredRoot: string,
  filesystem: Pick<typeof fs, "mkdir" | "lstat" | "open" | "opendir"> = fs,
): Promise<void> {
  try {
    const root = path.join(configuredRoot, ".debug");
    await filesystem.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    for (const relative of privateDirectories) {
      const entry = relative === "" ? root : path.join(root, ...relative.split("/"));
      try {
        await filesystem.mkdir(entry, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const before = await filesystem.lstat(entry, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new DebugDataProfileError();
      if (
        process.platform !== "win32" &&
        ((before.mode & 0o077n) !== 0n || before.uid !== BigInt(process.getuid!()))
      ) {
        throw new DebugDataProfileError();
      }
      // POSIX pins the exact no-follow directory during identity verification.
      // Windows uses its native directory/reparse observations and user ACLs;
      // opening directories as ordinary files is not a portable Windows API.
      if (process.platform !== "win32") {
        const held = await filesystem.open(
          entry,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const opened = await held.stat({ bigint: true });
          const after = await filesystem.lstat(entry, { bigint: true });
          if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            !after.isDirectory()
          ) {
            throw new DebugDataProfileError();
          }
        } finally {
          await held.close();
        }
      }
    }
    for (const name of stateFiles) {
      const entry = path.join(root, "userdata", ...name.split("/"));
      let metadata;
      try {
        metadata = await filesystem.lstat(entry, { bigint: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      // A hard-linked DB/settings file can alias production even though its
      // spelling is Debug-local. Refuse all multi-link profile state files.
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        (process.platform !== "win32" && metadata.uid !== BigInt(process.getuid!()))
      ) {
        throw new DebugDataProfileError();
      }
    }
    // Secret names include dynamically allocated provider entries, so checking
    // only known DB/settings names is insufficient. Inspect bounded directory
    // metadata, never secret bytes, before any secret-store consumer starts.
    // Unknown capacity/identity is a refusal, not a partial admission.
    const secretsPath = path.join(root, "userdata", "secrets");
    const secrets = await filesystem.opendir(secretsPath);
    let observed = 0;
    for await (const entry of secrets) {
      observed += 1;
      if (observed > 4096) throw new DebugDataProfileError();
      const metadata = await filesystem.lstat(path.join(secretsPath, entry.name), { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        (process.platform !== "win32" &&
          (metadata.uid !== BigInt(process.getuid!()) || (metadata.mode & 0o077n) !== 0n))
      ) {
        throw new DebugDataProfileError();
      }
    }
  } catch {
    throw new DebugDataProfileError();
  }
}
