// @effect-diagnostics nodeBuiltinImport:off
// Native descriptor operations are deliberate: chmod must never dereference
// a provider-replaced symlink. Cwd is a provider policy, not an OS sandbox.
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { CommandId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import {
  isStandaloneStableDevice,
  readStandaloneDeviceIdentity,
} from "./standaloneFilesystemIdentity.ts";

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Identity = { directoryDevice: string; directoryInode: string };
type ObservedIdentity = Identity & { nativeDevice: bigint };
type Ownership = {
  workspaceId: string;
  directoryDevice: string | null;
  directoryInode: string | null;
  cleanupName: string | null;
  forkOperationId: string | null;
};
const identityOf = (stat: { dev: bigint; ino: bigint }): Identity => ({
  directoryDevice: String(stat.dev),
  directoryInode: String(stat.ino),
});
const equalIdentity = (
  left: { directoryDevice: string | null; directoryInode: string | null },
  right: Identity,
) => left.directoryDevice === right.directoryDevice && left.directoryInode === right.directoryInode;
const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Mint neutral cwd ownership on the server and persist it independently of
 * provider bindings. ThreadIds are SQL keys, never filesystem path segments.
 * Each ordinary chat/duplicate is unique. Explicit native forks share one
 * inode with reference-counted ownership so source deletion preserves the fork.
 * Restart, archival and account changes cannot recover a former project cwd.
 */
export const makeStandaloneWorkspaceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const root = nodePath.join(config.baseDir, "standalone-workspaces");
  const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () => new Error("Standalone chat directory is unavailable."),
    });
  const pathFor = (workspaceId: string) => {
    if (!WORKSPACE_ID.test(workspaceId)) throw new Error("Invalid standalone workspace ownership.");
    return nodePath.join(root, workspaceId);
  };

  const inspectDirectory = async (
    directory: string,
    create: boolean,
    expected?: Identity,
    rootIdentity?: ObservedIdentity,
    signal?: AbortSignal,
    mutatePermissions = true,
  ): Promise<ObservedIdentity> => {
    signal?.throwIfAborted();
    if (create) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    const before = await fs.lstat(directory, { bigint: true });
    signal?.throwIfAborted();
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Unsafe directory");
    const expectedIsStable = expected && isStandaloneStableDevice(expected.directoryDevice);
    if (expectedIsStable && process.platform !== "darwin")
      throw new Error("Directory filesystem changed");
    if (expected && !expectedIsStable && !equalIdentity(expected, identityOf(before)))
      throw new Error("Directory identity changed");
    // Every minted child belongs to the admitted root's filesystem. Nested
    // replacement mounts cannot inherit its durable volume identity.
    if (rootIdentity && rootIdentity.nativeDevice !== before.dev)
      throw new Error("Directory filesystem changed");
    if (process.platform === "win32") {
      if (expectedIsStable) throw new Error("Directory filesystem changed");
      return { ...identityOf(before), nativeDevice: before.dev };
    }
    // Permissions and identity bind to one held inode rather than a mutable
    // path. Windows keeps the user-owned directory ACL and does not chmod.
    const handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const held = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (
        !held.isDirectory() ||
        held.uid !== BigInt(process.getuid!()) ||
        !equalIdentity(identityOf(held), identityOf(before))
      )
        throw new Error("Unsafe directory owner");
      const directoryDevice =
        rootIdentity?.directoryDevice ??
        (await readStandaloneDeviceIdentity(directory, held.dev, signal));
      const observed = {
        directoryDevice,
        directoryInode: String(held.ino),
        nativeDevice: held.dev,
      };
      if (expectedIsStable && !equalIdentity(expected, observed))
        throw new Error("Directory identity changed");
      // A native metadata helper may yield while the path is replaced. Check
      // raw identity again before changing permissions, not only afterwards.
      const admitted = await fs.lstat(directory, { bigint: true });
      if (admitted.isSymbolicLink() || !equalIdentity(identityOf(admitted), identityOf(held)))
        throw new Error("Directory identity changed");
      signal?.throwIfAborted();
      if (mutatePermissions) await handle.chmod(0o700);
      const after = await fs.lstat(directory, { bigint: true });
      if (after.isSymbolicLink() || !equalIdentity(identityOf(after), identityOf(held)))
        throw new Error("Directory identity changed");
      signal?.throwIfAborted();
      return observed;
    } finally {
      await handle.close();
    }
  };

  const admitRoot = Effect.fn("StandaloneWorkspace.admitRoot")(function* (create: boolean) {
    const rows =
      yield* sql<Identity>`SELECT directory_device AS "directoryDevice", directory_inode AS "directoryInode" FROM standalone_workspace_root_identity WHERE singleton = 1`;
    const observed = yield* io((signal) =>
      inspectDirectory(root, create && !rows[0], rows[0], undefined, signal),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = rows[0];
        if (previous && previous.directoryDevice !== observed.directoryDevice) {
          if (
            isStandaloneStableDevice(previous.directoryDevice) ||
            !isStandaloneStableDevice(observed.directoryDevice)
          )
            return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
          // Upgrade only after exact legacy dev+inode admission. Root and children
          // recorded on that same filesystem move atomically to its stable UUID.
          // A legacy device mismatch cannot prove the old volume and still fails
          // closed above; it requires an explicit, separately verified repair.
          const [current] =
            yield* sql<Identity>`SELECT directory_device AS "directoryDevice", directory_inode AS "directoryInode" FROM standalone_workspace_root_identity WHERE singleton = 1`;
          if (!current || (!equalIdentity(current, previous) && !equalIdentity(current, observed)))
            return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
          yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${observed.directoryDevice}
          WHERE singleton = 1 AND directory_device = ${previous.directoryDevice} AND directory_inode = ${previous.directoryInode}`;
          yield* sql`UPDATE standalone_thread_workspaces SET directory_device = ${observed.directoryDevice}
          WHERE directory_device = ${previous.directoryDevice}`;
        }
        yield* sql`INSERT INTO standalone_workspace_root_identity VALUES (1, ${observed.directoryDevice}, ${observed.directoryInode}) ON CONFLICT (singleton) DO NOTHING`;
      }),
    );
    const admitted =
      yield* sql<Identity>`SELECT directory_device AS "directoryDevice", directory_inode AS "directoryInode" FROM standalone_workspace_root_identity WHERE singleton = 1`;
    if (!admitted[0] || !equalIdentity(admitted[0], observed))
      return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
    return observed;
  });
  const ownership = (threadId: ThreadId) =>
    sql<Ownership>`SELECT workspace_id AS "workspaceId", directory_device AS "directoryDevice", directory_inode AS "directoryInode", cleanup_name AS "cleanupName", fork_operation_id AS "forkOperationId" FROM standalone_thread_workspaces WHERE thread_id = ${threadId}`;

  const resolve = Effect.fn("StandaloneWorkspace.resolve")(function* (threadId: ThreadId) {
    yield* sql`INSERT INTO standalone_thread_workspaces (thread_id, workspace_id, created_at)
      SELECT thread_id, ${randomUUID()}, ${new Date().toISOString()} FROM projection_threads
      WHERE thread_id = ${threadId} AND project_id IS NULL AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})
      ON CONFLICT (thread_id) DO NOTHING`;
    const admitted =
      yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId} AND project_id IS NULL AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})`;
    const [row] = yield* ownership(threadId);
    if (!row || admitted.length !== 1 || row.cleanupName !== null)
      return yield* Effect.fail(new Error("Standalone chat is unavailable."));
    const directory = yield* Effect.try({
      try: () => pathFor(row.workspaceId),
      catch: () => new Error("Standalone chat directory is unavailable."),
    });
    const rootIdentity = yield* admitRoot(row.directoryInode === null);
    // Root admission may atomically upgrade this row's legacy mount number.
    const [currentRow] = yield* ownership(threadId);
    if (
      !currentRow ||
      currentRow.workspaceId !== row.workspaceId ||
      currentRow.cleanupName !== null
    )
      return yield* Effect.fail(new Error("Standalone chat is unavailable."));
    const expected =
      currentRow.directoryDevice !== null && currentRow.directoryInode !== null
        ? { directoryDevice: currentRow.directoryDevice, directoryInode: currentRow.directoryInode }
        : undefined;
    const observed = yield* io((signal) =>
      inspectDirectory(
        directory,
        currentRow.directoryInode === null,
        expected,
        rootIdentity,
        signal,
      ),
    );
    if (currentRow.directoryInode !== null && !equalIdentity(currentRow, observed))
      return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
    yield* sql`UPDATE standalone_thread_workspaces SET directory_device = ${observed.directoryDevice}, directory_inode = ${observed.directoryInode} WHERE workspace_id = ${row.workspaceId} AND directory_inode IS NULL`;
    if (
      !equalIdentity(
        rootIdentity,
        yield* io((signal) => inspectDirectory(root, false, rootIdentity, undefined, signal)),
      )
    )
      return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
    return directory;
  });

  /** Metadata discovery may inspect an already provisioned neutral workspace,
   * but must never create ownership, migrate volume records or change modes.
   * A missing/legacy-unadmitted workspace becomes available after its ordinary
   * provider session resolves it, not as a side effect of opening a picker. */
  const readExisting = Effect.fn("StandaloneWorkspace.readExisting")(function* (
    threadId: ThreadId,
  ) {
    const admissible = () => sql`SELECT thread_id FROM projection_threads
      WHERE thread_id = ${threadId} AND project_id IS NULL AND deleted_at IS NULL
      AND archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})`;
    if ((yield* admissible()).length !== 1) return null;
    const [row] = yield* ownership(threadId);
    const [rootRow] =
      yield* sql<Identity>`SELECT directory_device AS "directoryDevice", directory_inode AS "directoryInode" FROM standalone_workspace_root_identity WHERE singleton = 1`;
    if (
      !row ||
      !rootRow ||
      row.cleanupName !== null ||
      row.directoryDevice === null ||
      row.directoryInode === null
    )
      return null;
    const directory = yield* Effect.try({
      try: () => pathFor(row.workspaceId),
      catch: () => new Error("Standalone chat directory is unavailable."),
    });
    const expected = { directoryDevice: row.directoryDevice, directoryInode: row.directoryInode };
    const rootIdentity = yield* io((signal) =>
      inspectDirectory(root, false, rootRow, undefined, signal, false),
    );
    if (!equalIdentity(rootRow, rootIdentity)) return null;
    const observed = yield* io((signal) =>
      inspectDirectory(directory, false, expected, rootIdentity, signal, false),
    );
    if (!equalIdentity(expected, observed)) return null;
    const [current] = yield* ownership(threadId);
    const [currentRoot] =
      yield* sql<Identity>`SELECT directory_device AS "directoryDevice", directory_inode AS "directoryInode" FROM standalone_workspace_root_identity WHERE singleton = 1`;
    if (
      !current ||
      current.workspaceId !== row.workspaceId ||
      current.cleanupName !== null ||
      !equalIdentity(current, observed) ||
      !currentRoot ||
      !equalIdentity(currentRoot, rootIdentity) ||
      (yield* admissible()).length !== 1
    )
      return null;
    yield* io((signal) => inspectDirectory(root, false, rootIdentity, undefined, signal, false));
    return directory;
  });

  const shareFork = Effect.fn("StandaloneWorkspace.shareFork")(function* (
    source: ThreadId,
    target: ThreadId,
    operationId: CommandId,
  ) {
    yield* resolve(source);
    yield* sql`INSERT INTO standalone_thread_workspaces (thread_id, workspace_id, created_at, directory_device, directory_inode, fork_operation_id)
      SELECT ${target}, workspace_id, ${new Date().toISOString()}, directory_device, directory_inode, ${operationId} FROM standalone_thread_workspaces WHERE thread_id = ${source} AND cleanup_name IS NULL
      AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id IN (${source}, ${target})) ON CONFLICT (thread_id) DO NOTHING`;
    const [sourceRow] = yield* ownership(source);
    const [targetRow] = yield* ownership(target);
    if (
      !sourceRow ||
      !targetRow ||
      sourceRow.workspaceId !== targetRow.workspaceId ||
      targetRow.forkOperationId !== operationId ||
      targetRow.cleanupName !== null
    )
      return yield* Effect.fail(new Error("Standalone fork ownership is unavailable."));
  });
  const releaseWorkspace = Effect.fn("StandaloneWorkspace.release")(function* (
    threadId: ThreadId,
    provisionalOperationId?: CommandId,
  ) {
    // Serialize reference release with fork admission. Two concurrent deletes
    // cannot both see the other owner and leave an unowned directory behind.
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [current] = yield* ownership(threadId);
        if (!current) return undefined;
        if (provisionalOperationId !== undefined) {
          // Check the exact preparing command and projection absence under the
          // same writer transaction as reference release/quarantine reservation.
          // A competing compensation cannot revoke another attempt or a fork
          // whose canonical commit has already made this ownership durable.
          if (current.forkOperationId !== provisionalOperationId) return undefined;
          const committed =
            yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId} LIMIT 1`;
          if (committed.length > 0) return undefined;
        }
        const others =
          yield* sql`SELECT thread_id FROM standalone_thread_workspaces WHERE workspace_id = ${current.workspaceId} AND thread_id <> ${threadId} LIMIT 1`;
        if (others.length > 0) {
          yield* sql`DELETE FROM standalone_thread_workspaces WHERE thread_id = ${threadId}`;
          return undefined;
        }
        const cleanupName = current.cleanupName ?? `delete-${randomUUID()}`;
        yield* sql`UPDATE standalone_thread_workspaces SET cleanup_name = ${cleanupName} WHERE thread_id = ${threadId} AND cleanup_name IS NULL`;
        return { ...current, cleanupName };
      }),
    );
    if (!row) return;
    const original = yield* Effect.try({
      try: () => pathFor(row.workspaceId),
      catch: () => new Error("Standalone chat directory is unavailable."),
    });
    if (row.directoryInode === null || row.directoryDevice === null) {
      // A crash may reserve an id before creating/binding its directory. Absence
      // permits retiring that unused reservation; an existing unbound inode is
      // inconclusive and must never authorize recursive filesystem deletion.
      const absent = yield* io(async () => {
        try {
          await fs.lstat(original);
          return false;
        } catch (error) {
          if (isMissing(error)) return true;
          throw error;
        }
      });
      if (!absent)
        return yield* Effect.fail(new Error("Standalone chat directory ownership is unavailable."));
      yield* sql`DELETE FROM standalone_thread_workspaces WHERE thread_id = ${threadId} AND workspace_id = ${row.workspaceId}`;
      return;
    }
    const rootIdentity = yield* admitRoot(false);
    const [currentRow] = yield* ownership(threadId);
    if (
      !currentRow ||
      currentRow.workspaceId !== row.workspaceId ||
      currentRow.cleanupName !== row.cleanupName
    )
      return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
    const cleanupName = row.cleanupName;
    if (!/^delete-[0-9a-f-]{36}$/.test(cleanupName))
      return yield* Effect.fail(new Error("Standalone chat directory ownership changed."));
    const quarantine = nodePath.join(root, cleanupName);
    // Persist before rename so a crash retries exactly this quarantine. Keep
    // the ownership row until cleanup settles, and never delete a replacement.
    const expected =
      currentRow.directoryDevice !== null && currentRow.directoryInode !== null
        ? { directoryDevice: currentRow.directoryDevice, directoryInode: currentRow.directoryInode }
        : undefined;
    yield* io(async (signal) => {
      if (
        !equalIdentity(
          rootIdentity,
          await inspectDirectory(root, false, rootIdentity, undefined, signal),
        )
      )
        throw new Error("Root identity changed");
      let held: Identity | undefined;
      try {
        held = await inspectDirectory(quarantine, false, expected, rootIdentity, signal);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!held) {
        try {
          const leaf = await inspectDirectory(original, false, expected, rootIdentity, signal);
          if (currentRow.directoryInode !== null && !equalIdentity(currentRow, leaf))
            throw new Error("Leaf identity changed");
          signal.throwIfAborted();
          await fs.rename(original, quarantine);
          held = await inspectDirectory(quarantine, false, leaf, rootIdentity, signal);
          if (!equalIdentity(leaf, held)) throw new Error("Quarantine identity changed");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if (held) {
        if (currentRow.directoryInode !== null && !equalIdentity(currentRow, held))
          throw new Error("Quarantine identity changed");
        if (
          !equalIdentity(
            rootIdentity,
            await inspectDirectory(root, false, rootIdentity, undefined, signal),
          )
        )
          throw new Error("Root identity changed");
        // Node rm unlinks child symlinks rather than following their targets.
        signal.throwIfAborted();
        await fs.rm(quarantine, { recursive: true });
      }
    });
    yield* sql`DELETE FROM standalone_thread_workspaces WHERE thread_id = ${threadId} AND workspace_id = ${row.workspaceId}`;
  });
  const remove = (threadId: ThreadId) => releaseWorkspace(threadId);
  // Call only after confirmed provider-fork retirement. The final provisional
  // reference uses the same durable identity/quarantine cleanup as hard delete,
  // including when its source was retired during native fork preparation.
  const discardFork = (target: ThreadId, operationId: CommandId) =>
    releaseWorkspace(target, operationId).pipe(Effect.asVoid);
  return { resolve, readExisting, remove, shareFork, discardFork };
});
