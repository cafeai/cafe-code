// @effect-diagnostics nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataProfileRoot, type DataProfile } from "@cafecode/shared/dataProfile";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";

/** Fixed operator copy: native errors and filesystem paths never escape. */
export class BackendProfileGuardError extends Error {
  constructor() {
    super(
      "This data profile's backend is already running, or its backend ownership could not be verified. Existing processes and data were preserved. Close the existing owner before retrying; do not remove ownership files while it may still be running.",
    );
    this.name = "BackendProfileGuardError";
  }
}

export interface BackendProfileGuardInput {
  readonly dataProfile: DataProfile;
  readonly configuredBaseDir: string | undefined;
  readonly baseDir: string;
  readonly stateDir: string;
}

export interface BackendProfileGuard {
  /** Call only after every backend layer and its finalizers have drained. */
  readonly close: () => Promise<void>;
}

// This executable has one backend role. Refuse another acquisition before any
// filesystem operation, even for an alternate spelling: on POSIX closing any
// independent descriptor for a SQLite file drops that process's advisory locks.
// Different profiles coexist in different processes, never within one backend.
let processReservation = false;
const applicationId = 0x43414642;
const formatVersion = 1;
const maximumGuardBytes = 65_536n;
const tableSql =
  "CREATE TABLE cafecode_backend_guard (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL CHECK (version = 1), role TEXT NOT NULL CHECK (role = 'backend'), profile TEXT NOT NULL, profile_id TEXT NOT NULL)";
const unavailable = (): never => {
  throw new BackendProfileGuardError();
};
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";
const sameFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;
const owned = (metadata: BigIntStats) =>
  process.platform === "win32" || metadata.uid === BigInt(process.getuid!());
const privateMode = (metadata: BigIntStats) =>
  process.platform === "win32" || (metadata.mode & 0o077n) === 0n;
const regularPrivateFile = (metadata: BigIntStats) =>
  metadata.isFile() &&
  !metadata.isSymbolicLink() &&
  metadata.nlink === 1n &&
  owned(metadata) &&
  privateMode(metadata) &&
  metadata.size <= maximumGuardBytes;

const snapshotInput = (input: BackendProfileGuardInput) => {
  // Reconstruct only finite own scalar data. Do not run getters or retain a
  // caller-owned object across namespace/SQLite awaits as opening authority.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== 4) return unavailable();
  const value = (name: keyof BackendProfileGuardInput): unknown => {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) return unavailable();
    return descriptor.value;
  };
  const dataProfile = value("dataProfile");
  const configuredBaseDir = value("configuredBaseDir");
  const baseDir = value("baseDir");
  const stateDir = value("stateDir");
  if (
    (dataProfile !== "production" && dataProfile !== "debug") ||
    typeof configuredBaseDir !== "string" ||
    typeof baseDir !== "string" ||
    typeof stateDir !== "string" ||
    [configuredBaseDir, baseDir, stateDir].some(
      (entry) => entry.length === 0 || entry.length > 4_096,
    )
  )
    return unavailable();
  return Object.freeze({ dataProfile, configuredBaseDir, baseDir, stateDir });
};

/**
 * Acquire OS-released backend-role exclusion without touching the main SQLite
 * file. A desktop crash can leave its backend alive after the Electron lock is
 * released. That orphan retains this transaction; a replacement backend refuses
 * before building settings/provider/reactor/SQLite runtime layers. No PID probe,
 * signal, timer, credential rotation or stale-file deletion grants admission.
 *
 * This relies on the supported local filesystem's native SQLite locking. It is
 * not a distributed lock or a sandbox against a process run by the same OS user.
 * Existing namespace uncertainty is preserved rather than repaired in place.
 */
export async function acquireBackendProfileGuard(
  input: BackendProfileGuardInput,
): Promise<BackendProfileGuard> {
  if (processReservation) return unavailable();
  processReservation = true;
  let database: DatabaseSync | undefined;
  let file: fs.FileHandle | undefined;
  let directory: fs.FileHandle | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      // Never close the raw admission FD while SQLite may retain a POSIX lock.
      // If native close is uncertain, retain every descriptor and the process
      // reservation until actual process exit instead of granting a new writer.
      try {
        database?.close();
      } catch {
        return unavailable();
      }
      database = undefined;
      try {
        await file?.close();
        file = undefined;
        await directory?.close();
        directory = undefined;
      } catch {
        return unavailable();
      }
      processReservation = false;
    })());
  try {
    const selected = snapshotInput(input);
    if (
      !path.isAbsolute(selected.configuredBaseDir) ||
      !path.isAbsolute(selected.baseDir) ||
      !path.isAbsolute(selected.stateDir) ||
      path.resolve(selected.baseDir) !==
        resolveDataProfileRoot(
          path.resolve(selected.configuredBaseDir),
          selected.dataProfile,
          path,
        ) ||
      path.resolve(selected.stateDir) !== path.join(path.resolve(selected.baseDir), "userdata")
    )
      return unavailable();
    // Resolve OS-provided aliases (for example macOS's /var) once, then require
    // the managed effective root/state themselves to be ordinary owned dirs.
    const parent = await fs.realpath(selected.configuredBaseDir);
    const root = await fs.realpath(selected.baseDir);
    const state = await fs.realpath(selected.stateDir);
    if (
      root !== resolveDataProfileRoot(parent, selected.dataProfile, path) ||
      state !== path.join(root, "userdata")
    )
      return unavailable();
    for (const entry of [selected.baseDir, selected.stateDir]) {
      const metadata = await fs.lstat(entry, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata))
        return unavailable();
    }
    const guardDirectory = path.join(state, "backend-ownership");
    try {
      await fs.mkdir(guardDirectory, { mode: 0o700 });
    } catch (error) {
      if (!exists(error)) throw error;
    }
    const beforeDirectory = await fs.lstat(guardDirectory, { bigint: true });
    if (
      !beforeDirectory.isDirectory() ||
      beforeDirectory.isSymbolicLink() ||
      !owned(beforeDirectory) ||
      !privateMode(beforeDirectory)
    )
      return unavailable();
    if (process.platform !== "win32") {
      directory = await fs.open(
        guardDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!sameFile(beforeDirectory, await directory.stat({ bigint: true }))) return unavailable();
    }
    const guardPath = path.join(guardDirectory, "backend-role-v1.sqlite");
    let before: BigIntStats | undefined;
    try {
      before = await fs.lstat(guardPath, { bigint: true });
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (before !== undefined && !regularPrivateFile(before)) return unavailable();
    try {
      file = await fs.open(
        guardPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!exists(error) || before === undefined) throw error;
      file = await fs.open(guardPath, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    const opened = await file.stat({ bigint: true });
    if (!regularPrivateFile(opened) || (before !== undefined && !sameFile(before, opened)))
      return unavailable();
    // The steady-state ownership transaction is read-only after initialization
    // commits, so no sidecar is needed. A private/single-link journal alone is
    // not proof that its contents belong to this exact guard. Preserve even an
    // interrupted initialization journal rather than letting SQLite apply or
    // delete unverified recovery bytes before format admission.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        await fs.lstat(`${guardPath}${suffix}`, { bigint: true });
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      return unavailable();
    }
    if (opened.size !== 0n) {
      // Inspect only SQLite's fixed header through the retained admission FD.
      // A foreign WAL-mode file with no present sidecars could otherwise make
      // SQLite create/recover sidecars before the SQL-level format refusal.
      // The header is merely preflight: the exact schema/profile checks below
      // remain mandatory and never derive ownership from these public bytes.
      const header = Buffer.alloc(100);
      const read = await file.read(header, 0, header.length, 0);
      if (
        read.bytesRead !== header.length ||
        !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "ascii")) ||
        header[18] !== 1 ||
        header[19] !== 1 ||
        header.readUInt32BE(60) !== formatVersion ||
        header.readUInt32BE(68) !== applicationId
      )
        return unavailable();
    }
    database = new DatabaseSync(guardPath, { timeout: 0, allowExtension: false });
    const verifyNamespace = async () => {
      const named = await fs.lstat(guardPath, { bigint: true });
      const namedDirectory = await fs.lstat(guardDirectory, { bigint: true });
      if (
        !regularPrivateFile(named) ||
        !sameFile(opened, named) ||
        !namedDirectory.isDirectory() ||
        namedDirectory.isSymbolicLink() ||
        !sameFile(beforeDirectory, namedDirectory)
      )
        return unavailable();
    };
    await verifyNamespace();
    database.exec("BEGIN EXCLUSIVE");
    const fingerprint = dataProfileIdentity(selected.dataProfile, root);
    const inspect = () => {
      const objects = database!
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const app = database!.prepare("PRAGMA application_id").get()?.application_id;
      const version = database!.prepare("PRAGMA user_version").get()?.user_version;
      return { objects, app, version };
    };
    const format = inspect();
    // An empty file is a recoverable pre-initialization reservation, including
    // a crash before its first schema commit. Never initialize nonempty unknown
    // SQLite files or reinterpret another database as Cafe's ownership guard.
    if (
      opened.size === 0n &&
      format.objects.length === 0 &&
      format.app === 0 &&
      format.version === 0
    ) {
      database.exec(tableSql);
      database
        .prepare(
          "INSERT INTO cafecode_backend_guard (id, version, role, profile, profile_id) VALUES (1, 1, 'backend', ?, ?)",
        )
        .run(selected.dataProfile, fingerprint);
      database.exec(
        `PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${formatVersion}; COMMIT; BEGIN EXCLUSIVE;`,
      );
    }
    const admitted = inspect();
    if (
      admitted.app !== applicationId ||
      admitted.version !== formatVersion ||
      admitted.objects.length !== 1 ||
      admitted.objects[0]?.type !== "table" ||
      admitted.objects[0]?.name !== "cafecode_backend_guard" ||
      admitted.objects[0]?.sql !== tableSql ||
      database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
    )
      return unavailable();
    const rows = database
      .prepare("SELECT id, version, role, profile, profile_id FROM cafecode_backend_guard")
      .all();
    if (
      rows.length !== 1 ||
      rows[0]?.id !== 1 ||
      rows[0]?.version !== formatVersion ||
      rows[0]?.role !== "backend" ||
      rows[0]?.profile !== selected.dataProfile ||
      rows[0]?.profile_id !== fingerprint
    )
      return unavailable();
    await verifyNamespace();
    return { close };
  } catch {
    try {
      await close();
    } catch {
      /* Uncertain native close retains the process reservation. */
    }
    return unavailable();
  }
}
