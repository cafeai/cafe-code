// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CommandId, ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeStandaloneWorkspaceStore } from "./standaloneWorkspace.ts";

// Interpose only an explicitly armed metadata observation. Every operation
// otherwise reaches the real host-native filesystem; there are no timers or
// probabilistic racing processes, and no fabricated inode/permission results.
const filesystemObservation = vi.hoisted(() => ({
  beforeLstat: undefined as ((directory: unknown) => Promise<void>) | undefined,
  deviceDelta: 0n,
  volumeUuid: "darwin-volume:11111111-2222-4333-8444-555555555555",
  beforeReadIdentity: undefined as (() => Promise<void>) | undefined,
  afterClose: undefined as (() => void) | undefined,
}));
// Unit fixtures keep native filesystem/descriptor operations, but do not launch
// df/diskutil. The separately selected native identity test qualifies that
// read-only OS boundary. A device offset deterministically models remounting.
vi.mock("./standaloneFilesystemIdentity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./standaloneFilesystemIdentity.ts")>()),
  readStandaloneDeviceIdentity: async (_directory: string, device: bigint) => {
    await filesystemObservation.beforeReadIdentity?.();
    return process.platform === "darwin" ? filesystemObservation.volumeUuid : String(device);
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const remount = <T extends { dev: number | bigint } | undefined>(stat: T): T =>
    stat === undefined || filesystemObservation.deviceDelta === 0n
      ? stat
      : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          dev:
            typeof stat.dev === "bigint"
              ? stat.dev + filesystemObservation.deviceDelta
              : stat.dev + Number(filesystemObservation.deviceDelta),
        });
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      await filesystemObservation.beforeLstat?.(args[0]);
      return remount(await actual.lstat(...args));
    }) as typeof actual.lstat,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat")
            return async (...options: Parameters<typeof handle.stat>) =>
              remount(await target.stat(...options));
          if (key === "close")
            return async () => {
              await target.close();
              filesystemObservation.afterClose?.();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof actual.open,
  };
});

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "standalone-workspace-test-",
}).pipe(Layer.provide(NodeServices.layer));
const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory, configLayer));
const createThread = (threadId: ThreadId, projectId: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES (${threadId}, ${projectId}, 'Test', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`;
  });

layer("standalone workspace ownership", (it) => {
  it.effect(
    "reads only already provisioned workspaces without ownership or permission mutations",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("read-only-skills-workspace");
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        assert.isNull(yield* store.readExisting(thread));
        assert.deepEqual(
          yield* sql`SELECT * FROM standalone_thread_workspaces WHERE thread_id = ${thread}`,
          [],
        );
        const cwd = yield* store.resolve(thread);
        const ownershipBefore =
          yield* sql`SELECT * FROM standalone_thread_workspaces WHERE thread_id = ${thread}`;
        const rootBefore = yield* sql`SELECT * FROM standalone_workspace_root_identity`;
        if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(cwd, 0o750));
        assert.equal(yield* store.readExisting(thread), cwd);
        assert.deepEqual(
          yield* sql`SELECT * FROM standalone_thread_workspaces WHERE thread_id = ${thread}`,
          ownershipBefore,
        );
        assert.deepEqual(yield* sql`SELECT * FROM standalone_workspace_root_identity`, rootBefore);
        if (process.platform !== "win32")
          assert.equal((yield* Effect.promise(() => fs.stat(cwd))).mode & 0o777, 0o750);
        yield* sql`UPDATE projection_threads SET archived_at = '2026-10-05T00:00:00Z' WHERE thread_id = ${thread}`;
        assert.isNull(yield* store.readExisting(thread));
        yield* store.remove(thread);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects an untrusted replacement directory during read-only discovery", () =>
    Effect.gen(function* () {
      const thread = ThreadId.make("read-only-replacement-workspace");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      const original = `${cwd}-original`;
      yield* Effect.promise(() => fs.rename(cwd, original));
      yield* Effect.promise(() => fs.mkdir(cwd));
      const outcome = yield* Effect.exit(store.readExisting(thread));
      assert.equal(outcome._tag, "Failure");
      yield* Effect.promise(() => fs.rmdir(cwd));
      yield* Effect.promise(() => fs.rename(original, cwd));
      yield* store.remove(thread);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not chmod or rewrite ownership after cancelled volume admission finishes late",
    (context) =>
      Effect.gen(function* () {
        if (process.platform === "win32")
          return context.skip("POSIX held-descriptor cancellation policy");
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("cancelled-volume-admission");
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(thread);
        const root = path.dirname(cwd);
        yield* Effect.promise(() => fs.chmod(root, 0o755));
        const original = yield* sql`SELECT * FROM standalone_workspace_root_identity`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          filesystemObservation.beforeReadIdentity = async () => {
            await Effect.runPromise(Deferred.succeed(entered, undefined));
            await Effect.runPromise(Deferred.await(release));
          };
          filesystemObservation.afterClose = () => {
            Effect.runSync(Deferred.succeed(closed, undefined));
          };
          const attempt = yield* store.resolve(thread).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(attempt);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(closed);
          assert.equal((yield* Effect.promise(() => fs.lstat(root))).mode & 0o777, 0o755);
          assert.deepEqual(yield* sql`SELECT * FROM standalone_workspace_root_identity`, original);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              filesystemObservation.beforeReadIdentity = undefined;
              filesystemObservation.afterClose = undefined;
              yield* Deferred.succeed(release, undefined);
            }),
          ),
        );
        yield* store.remove(thread);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not rewrite leaf ownership if legacy root migration loses its comparison",
    (context) =>
      Effect.gen(function* () {
        if (process.platform !== "darwin")
          return context.skip("macOS durable volume identity policy");
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("legacy-volume-race");
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(thread);
        const raw = String((yield* Effect.promise(() => fs.lstat(cwd, { bigint: true }))).dev);
        yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${raw}`;
        yield* sql`UPDATE standalone_thread_workspaces SET directory_device = ${raw} WHERE thread_id = ${thread}`;
        yield* Effect.gen(function* () {
          filesystemObservation.beforeReadIdentity = async () => {
            filesystemObservation.beforeReadIdentity = undefined;
            await Effect.runPromise(
              sql`UPDATE standalone_workspace_root_identity SET directory_device = '987654321'`,
            );
          };
          assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
          assert.deepEqual(
            yield* sql`SELECT directory_device FROM standalone_thread_workspaces WHERE thread_id = ${thread}`,
            [{ directory_device: raw }],
          );
          assert.deepEqual(
            yield* sql`SELECT directory_device FROM standalone_workspace_root_identity`,
            [{ directory_device: "987654321" }],
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              filesystemObservation.beforeReadIdentity = undefined;
              yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${raw}`;
            }).pipe(Effect.orDie),
          ),
        );
        yield* store.remove(thread);
      }),
  );

  it.effect("rejects a macOS volume identity on other hosts without rewriting it", (context) =>
    Effect.gen(function* () {
      if (process.platform === "darwin") return context.skip("non-macOS admission policy");
      const sql = yield* SqlClient.SqlClient;
      const thread = ThreadId.make("foreign-host-volume");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      const raw = String((yield* Effect.promise(() => fs.lstat(cwd, { bigint: true }))).dev);
      yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${filesystemObservation.volumeUuid}`;
      assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
      assert.deepEqual(
        yield* sql`SELECT directory_device FROM standalone_workspace_root_identity`,
        [{ directory_device: filesystemObservation.volumeUuid }],
      );
      yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${raw}`;
      yield* store.remove(thread);
    }),
  );

  it.effect("retains macOS volume ownership across mount-device renumbering", (context) =>
    Effect.gen(function* () {
      if (process.platform !== "darwin")
        return context.skip("macOS durable volume identity policy");
      const thread = ThreadId.make("remounted-volume");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      yield* Effect.gen(function* () {
        filesystemObservation.deviceDelta = 31n;
        const restarted = yield* makeStandaloneWorkspaceStore;
        assert.equal(yield* restarted.resolve(thread), cwd);
        yield* restarted.remove(thread);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            filesystemObservation.deviceDelta = 0n;
          }),
        ),
      );
    }),
  );

  it.effect(
    "rejects another macOS volume with the same inode without changing permissions",
    (context) =>
      Effect.gen(function* () {
        if (process.platform !== "darwin")
          return context.skip("macOS durable volume identity policy");
        const thread = ThreadId.make("foreign-volume");
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(thread);
        const root = path.dirname(cwd);
        yield* Effect.promise(() => fs.chmod(root, 0o755));
        const saved = filesystemObservation.volumeUuid;
        yield* Effect.gen(function* () {
          filesystemObservation.volumeUuid = "darwin-volume:99999999-2222-4333-8444-555555555555";
          assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
          assert.equal((yield* Effect.result(store.remove(thread)))._tag, "Failure");
          assert.equal((yield* Effect.promise(() => fs.lstat(root))).mode & 0o777, 0o755);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              filesystemObservation.volumeUuid = saved;
            }),
          ),
        );
        yield* store.remove(thread);
      }),
  );

  it.effect(
    "upgrades exact legacy macOS root and fork ownership together, never mismatched legacy mounts",
    (context) =>
      Effect.gen(function* () {
        if (process.platform !== "darwin")
          return context.skip("macOS durable volume identity policy");
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("legacy-volume");
        const fork = ThreadId.make("legacy-volume-fork");
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(thread);
        yield* store.shareFork(thread, fork, CommandId.make("legacy-fork"));
        yield* createThread(fork);
        const raw = String((yield* Effect.promise(() => fs.lstat(cwd, { bigint: true }))).dev);
        yield* sql`UPDATE standalone_workspace_root_identity SET directory_device = ${raw}`;
        yield* sql`UPDATE standalone_thread_workspaces SET directory_device = ${raw} WHERE thread_id IN (${thread}, ${fork})`;
        yield* Effect.gen(function* () {
          filesystemObservation.deviceDelta = 31n;
          assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
          assert.deepEqual(
            yield* sql`SELECT directory_device FROM standalone_workspace_root_identity`,
            [{ directory_device: raw }],
          );
          assert.deepEqual(
            yield* sql`SELECT directory_device FROM standalone_thread_workspaces WHERE thread_id IN (${thread}, ${fork})`,
            [{ directory_device: raw }, { directory_device: raw }],
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              filesystemObservation.deviceDelta = 0n;
            }),
          ),
        );
        assert.equal(yield* store.resolve(thread), cwd);
        assert.deepEqual(
          yield* sql`SELECT directory_device FROM standalone_thread_workspaces WHERE thread_id IN (${thread}, ${fork})`,
          [
            { directory_device: filesystemObservation.volumeUuid },
            { directory_device: filesystemObservation.volumeUuid },
          ],
        );
        filesystemObservation.deviceDelta = 31n;
        yield* Effect.gen(function* () {
          assert.equal(yield* store.resolve(fork), cwd);
          yield* store.remove(thread);
          yield* store.remove(fork);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              filesystemObservation.deviceDelta = 0n;
            }),
          ),
        );
      }),
  );

  it.effect("rejects a symlinked cwd while preserving its target and permissions", (context) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const thread = ThreadId.make("symlink-admission");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      const saved = `${cwd}-saved`;
      const target = path.join(config.baseDir, "symlink-target");
      yield* Effect.promise(() => fs.mkdir(target, { mode: 0o755 }));
      const originalMode = (yield* Effect.promise(() => fs.lstat(target))).mode;
      yield* Effect.promise(() => fs.rename(cwd, saved));
      const linked = yield* Effect.tryPromise({
        try: () => fs.symlink(target, cwd, "dir"),
        catch: (error) => error,
      }).pipe(Effect.result);
      if (linked._tag === "Failure") {
        // Only this privilege-dependent assertion path is skipped; ordinary
        // directory identity/cleanup coverage remains enabled on every host.
        yield* Effect.promise(() => fs.rename(saved, cwd));
        yield* store.remove(thread);
        if (
          process.platform === "win32" &&
          linked.failure instanceof Error &&
          "code" in linked.failure &&
          linked.failure.code === "EPERM"
        ) {
          context.skip("Windows does not permit this specific directory-symlink fixture.");
          return;
        }
        return yield* Effect.fail(linked.failure);
      }
      assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
      assert.equal((yield* Effect.result(store.remove(thread)))._tag, "Failure");
      assert.equal((yield* Effect.promise(() => fs.lstat(target))).mode, originalMode);
      assert.isTrue((yield* Effect.promise(() => fs.lstat(target))).isDirectory());
      yield* Effect.promise(() => fs.unlink(cwd));
      yield* Effect.promise(() => fs.rename(saved, cwd));
      yield* store.remove(thread);
    }),
  );

  it.effect("resumes the exact persisted cleanup quarantine after interruption", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const thread = ThreadId.make("interrupted-cleanup");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      const cleanupName = "delete-00000000-0000-4000-8000-000000000001";
      const quarantine = path.join(path.dirname(cwd), cleanupName);
      yield* sql`UPDATE standalone_thread_workspaces SET cleanup_name = ${cleanupName} WHERE thread_id = ${thread}`;
      yield* Effect.promise(() => fs.rename(cwd, quarantine));
      const restarted = yield* makeStandaloneWorkspaceStore;
      yield* restarted.remove(thread);
      assert.equal(
        yield* Effect.promise(() =>
          fs.lstat(quarantine).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM standalone_thread_workspaces WHERE thread_id = ${thread}`,
        [],
      );
    }),
  );

  it.effect("retires absent unbound reservations but never deletes an existing unbound inode", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const absent = ThreadId.make("unbound-absent");
      const present = ThreadId.make("unbound-present");
      const presentId = "00000000-0000-4000-8000-000000000002";
      yield* sql`INSERT INTO standalone_thread_workspaces (thread_id, workspace_id, created_at) VALUES (${absent}, '00000000-0000-4000-8000-000000000001', '2026-10-03T00:00:00.000Z'), (${present}, ${presentId}, '2026-10-03T00:00:00.000Z')`;
      const directory = path.join(config.baseDir, "standalone-workspaces", presentId);
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }));
      const store = yield* makeStandaloneWorkspaceStore;
      yield* store.remove(absent);
      assert.equal((yield* Effect.result(store.remove(present)))._tag, "Failure");
      assert.isTrue((yield* Effect.promise(() => fs.lstat(directory))).isDirectory());
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM standalone_thread_workspaces WHERE thread_id IN (${absent}, ${present})`,
        [{ thread_id: present }],
      );
      // Fixture cleanup removes only its deliberately created empty directory.
      yield* Effect.promise(() => fs.rmdir(directory));
      yield* store.remove(present);
    }),
  );

  it.effect("keeps server-minted private cwd stable across store reconstruction and archive", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const thread = ThreadId.make("../../secrets/untrusted-thread-name");
      const second = ThreadId.make("second-neutral-chat");
      yield* createThread(thread);
      yield* createThread(second);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      assert.equal(path.dirname(cwd), path.join(config.baseDir, "standalone-workspaces"));
      assert.notEqual(cwd, process.cwd());
      assert.notEqual(cwd, config.stateDir);
      assert.notEqual(cwd, yield* store.resolve(second));
      const stat = yield* Effect.promise(() => fs.lstat(cwd));
      assert.isTrue(stat.isDirectory());
      if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
      yield* sql`UPDATE projection_threads SET archived_at = '2026-10-03T00:00:01.000Z' WHERE thread_id = ${thread}`;
      const restarted = yield* makeStandaloneWorkspaceStore;
      assert.equal(yield* restarted.resolve(thread), cwd);
      yield* restarted.remove(thread);
      yield* restarted.remove(second);
    }),
  );

  it.effect("denies project, missing, retired and replaced-directory admissions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const linked = ThreadId.make("linked-admission");
      const standalone = ThreadId.make("replaced-directory");
      yield* createThread(linked, "project");
      yield* createThread(standalone);
      const store = yield* makeStandaloneWorkspaceStore;
      assert.equal((yield* Effect.result(store.resolve(linked)))._tag, "Failure");
      assert.equal((yield* Effect.result(store.resolve(ThreadId.make("missing"))))._tag, "Failure");
      const cwd = yield* store.resolve(standalone);
      const original = `${cwd}-saved`;
      yield* Effect.promise(() => fs.rename(cwd, original));
      yield* Effect.promise(() => fs.mkdir(cwd));
      assert.equal((yield* Effect.result(store.resolve(standalone)))._tag, "Failure");
      assert.equal((yield* Effect.result(store.remove(standalone)))._tag, "Failure");
      assert.isTrue((yield* Effect.promise(() => fs.lstat(cwd))).isDirectory());
      // Restore the admitted inode, not a replacement, and retry the same durable
      // deletion quarantine. Failed admission must not erase ownership evidence.
      yield* Effect.promise(() => fs.rmdir(cwd));
      yield* Effect.promise(() => fs.rename(original, cwd));
      yield* store.remove(standalone);
      const retired = ThreadId.make("retired-admission");
      yield* createThread(retired);
      yield* sql`INSERT INTO hard_deleted_threads VALUES (${retired}, '2026-10-03T00:00:00.000Z')`;
      assert.equal((yield* Effect.result(store.resolve(retired)))._tag, "Failure");
    }),
  );

  it.effect("retains an explicit native fork's cwd until its last owner is deleted", () =>
    Effect.gen(function* () {
      const source = ThreadId.make("fork-source");
      const target = ThreadId.make("fork-target");
      const duplicate = ThreadId.make("context-duplicate");
      yield* createThread(source);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(source);
      yield* store.shareFork(source, target, CommandId.make("fixture-native-fork"));
      yield* createThread(target);
      yield* createThread(duplicate);
      assert.equal(yield* store.resolve(target), cwd);
      assert.notEqual(yield* store.resolve(duplicate), cwd);
      yield* store.remove(source);
      assert.equal(yield* store.resolve(target), cwd);
      yield* store.remove(target);
      assert.equal(
        yield* Effect.promise(() =>
          fs.stat(cwd).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      yield* store.remove(duplicate);
    }),
  );

  it.effect("binds provisional fork ownership and compensation to its exact command", () =>
    Effect.gen(function* () {
      const source = ThreadId.make("competing-fork-source");
      const target = ThreadId.make("competing-fork-target");
      const first = CommandId.make("first-fork-owner");
      const competitor = CommandId.make("competing-fork-owner");
      yield* createThread(source);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(source);
      yield* store.shareFork(source, target, first);
      assert.equal(
        (yield* Effect.result(store.shareFork(source, target, competitor)))._tag,
        "Failure",
      );
      yield* store.discardFork(target, competitor);
      yield* createThread(target);
      assert.equal(yield* store.resolve(target), cwd);
      yield* store.discardFork(target, first);
      assert.equal(yield* store.resolve(target), cwd);
      yield* store.remove(source);
      yield* store.remove(target);
    }),
  );

  it.effect("rejects a replaced private root without modifying or deleting the replacement", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const thread = ThreadId.make("root-replacement");
      yield* createThread(thread);
      const store = yield* makeStandaloneWorkspaceStore;
      const cwd = yield* store.resolve(thread);
      const root = path.dirname(cwd);
      const saved = `${root}-saved`;
      yield* Effect.promise(() => fs.rename(root, saved));
      yield* Effect.promise(() => fs.mkdir(root, { mode: 0o755 }));
      const replacementMode = (yield* Effect.promise(() => fs.lstat(root))).mode;
      assert.equal((yield* Effect.result(store.resolve(thread)))._tag, "Failure");
      assert.equal((yield* Effect.result(store.remove(thread)))._tag, "Failure");
      assert.equal((yield* Effect.promise(() => fs.lstat(root))).mode, replacementMode);
      assert.isTrue((yield* Effect.promise(() => fs.lstat(saved))).isDirectory());
      assert.equal(root, path.join(config.baseDir, "standalone-workspaces"));
      yield* Effect.promise(() => fs.rmdir(root));
      yield* Effect.promise(() => fs.rename(saved, root));
      yield* store.remove(thread);
    }),
  );

  for (const operation of ["resolve", "remove"] as const) {
    it.effect(`rejects a root replaced during ${operation}'s final recheck before chmod`, () =>
      Effect.gen(function* () {
        const thread = ThreadId.make(`root-recheck-${operation}`);
        yield* createThread(thread);
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(thread);
        const root = path.dirname(cwd);
        const saved = `${root}-recheck-saved`;
        let leafObserved = false;
        let rootSaved = false;
        let replacementMode: number | undefined;
        yield* Effect.gen(function* () {
          filesystemObservation.beforeLstat = async (directory) => {
            if (directory === cwd) leafObserved = true;
            if (directory !== root || !leafObserved || rootSaved) return;
            // Initial root admission and leaf ownership have already settled.
            // Replace exactly at the final metadata recheck, after all held
            // descriptors close, reproducing the stale-root permission hazard.
            await fs.rename(root, saved);
            rootSaved = true;
            await fs.mkdir(root, { mode: 0o755 });
            replacementMode = (await fs.lstat(root)).mode;
          };
          const result = yield* Effect.result(store[operation](thread));
          assert.equal(result._tag, "Failure");
          assert.isTrue(rootSaved);
          assert.isDefined(replacementMode);
          assert.equal((yield* Effect.promise(() => fs.lstat(root))).mode, replacementMode);
          assert.isTrue((yield* Effect.promise(() => fs.lstat(saved))).isDirectory());
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              filesystemObservation.beforeLstat = undefined;
              if (rootSaved) {
                // Only the exact empty replacement created above is removed. The
                // admitted root/inode and any persisted cleanup quarantine survive.
                await fs.rmdir(root);
                await fs.rename(saved, root);
              }
            }),
          ),
        );
        yield* store.remove(thread);
      }),
    );
  }
});
