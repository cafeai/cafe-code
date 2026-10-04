import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { readBridgeConnection } from "../mcp/localBridge.ts";
import {
  dispatchSchedulingSessionAuthorization,
  installSchedulingSessionRuntime,
  makeSchedulingSessionRuntime,
  readSchedulingSessionBroker,
  requireSchedulingSessionAuthority,
  type SchedulingSessionBinding,
} from "./sessionRuntime.ts";

const identity = {
  threadId: ThreadId.make("synthetic-scheduling-chat"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  provider: "codex" as const,
};
const readToken = (binding: SchedulingSessionBinding) =>
  Effect.promise(() => readBridgeConnection(binding.launch.args[1]!, "cafe-scheduling"));
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const root = yield* Effect.promise(async () =>
    fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-scheduling-fixture-"))),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  );
  const bridgeSource = path.join(root, "synthetic.mjs");
  yield* Effect.promise(() =>
    fs.writeFile(bridgeSource, "// Synthetic fixture; never executed.\n"),
  );
  const options = { bridgeSource, mcpPort: 12345, executable: process.execPath };
  const runtime = yield* makeSchedulingSessionRuntime(options);
  yield* Effect.addFinalizer(() => Effect.promise(runtime.close));
  return { runtime, options, sql: yield* SqlClient.SqlClient };
});

it.layer(TestSqliteClient.layerMemory())("private scheduling session capabilities", (it) => {
  it.effect(
    "admits a pending catalog but binds activated tools to exact chat/account/generation",
    () =>
      Effect.gen(function* () {
        const { runtime, sql } = yield* fixture;
        const binding = yield* Effect.promise(() => runtime.bind(identity));
        const { token, url } = yield* readToken(binding);
        assert.equal(url, "http://127.0.0.1:12345/mcp/scheduling");
        assert.equal(JSON.stringify(binding.launch).includes(token), false);
        assert.match(binding.name, /^cafe-[A-Za-z0-9_-]{22}$/);
        const authority = yield* Effect.promise(() => runtime.authorize(token));
        assert.deepEqual(
          { threadId: authority.threadId, providerInstanceId: authority.providerInstanceId },
          { threadId: identity.threadId, providerInstanceId: identity.providerInstanceId },
        );
        assert.equal(
          (yield* Effect.exit(
            sql.withTransaction(requireSchedulingSessionAuthority(sql, authority)),
          ))._tag,
          "Failure",
        );
        yield* Effect.promise(binding.activate);
        yield* sql.withTransaction(requireSchedulingSessionAuthority(sql, authority));
        for (const forged of [
          { ...authority, threadId: ThreadId.make("other-chat") },
          { ...authority, providerInstanceId: ProviderInstanceId.make("codex_work") },
          { ...authority, sessionGeneration: "00000000-0000-0000-0000-000000000000" },
          { ...authority, tokenDigest: "0".repeat(64) },
        ])
          assert.equal(
            (yield* Effect.exit(
              sql.withTransaction(requireSchedulingSessionAuthority(sql, forged)),
            ))._tag,
            "Failure",
          );
        const rows = yield* sql`SELECT * FROM scheduling_session_capabilities`;
        assert.equal(JSON.stringify(rows).includes(token), false);
        for (const invalid of ["", "a".repeat(64), token.toUpperCase(), `${token}extra`]) {
          assert.equal(
            (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(invalid))))._tag,
            "Failure",
          );
        }
        const removed = binding.launch.args[1]!;
        yield* Effect.promise(binding.dispose);
        yield* Effect.promise(binding.dispose);
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(token))))._tag,
          "Failure",
        );
        // Previously authenticated claims are invalid once retirement commits.
        assert.equal(
          (yield* Effect.exit(
            sql.withTransaction(requireSchedulingSessionAuthority(sql, authority)),
          ))._tag,
          "Failure",
        );
        assert.equal(
          yield* Effect.promise(() =>
            fs.access(removed).then(
              () => true,
              () => false,
            ),
          ),
          false,
        );
      }),
  );

  it.effect("keeps failed candidates harmless and rejects a stale staged activation", () =>
    Effect.gen(function* () {
      const { runtime, sql } = yield* fixture;
      const old = yield* Effect.promise(() => runtime.bind(identity));
      yield* Effect.promise(old.activate);
      const oldToken = (yield* readToken(old)).token;
      const oldAuthority = yield* Effect.promise(() => runtime.authorize(oldToken));
      const failed = yield* Effect.promise(() => runtime.bind(identity));
      yield* Effect.promise(failed.dispose);
      yield* sql.withTransaction(requireSchedulingSessionAuthority(sql, oldAuthority));
      const stale = yield* Effect.promise(() => runtime.bind(identity));
      const replacement = yield* Effect.promise(() =>
        runtime.bind({ ...identity, providerInstanceId: ProviderInstanceId.make("codex_work") }),
      );
      assert.notEqual(replacement.name, old.name);
      yield* Effect.promise(old.dispose);
      // The predecessor tombstone preserves the legitimate activation CAS.
      yield* Effect.promise(replacement.activate);
      yield* Effect.promise(replacement.activate);
      assert.equal((yield* Effect.exit(Effect.tryPromise(stale.activate)))._tag, "Failure");
      yield* Effect.promise(stale.dispose);
      yield* Effect.promise(old.dispose);
      const replacementToken = (yield* readToken(replacement)).token;
      const authority = yield* Effect.promise(() => runtime.authorize(replacementToken));
      assert.equal(authority.providerInstanceId, "codex_work");
      yield* sql.withTransaction(requireSchedulingSessionAuthority(sql, authority));
    }),
  );

  it.effect(
    "invalidates a crashed runtime and fences its late bind, activate, close and unregister",
    () =>
      Effect.gen(function* () {
        const { runtime: oldRuntime, options, sql } = yield* fixture;
        const old = yield* Effect.promise(() => oldRuntime.bind(identity));
        yield* Effect.promise(old.activate);
        const oldToken = (yield* readToken(old)).token;
        const releaseOld = installSchedulingSessionRuntime(oldRuntime);
        const replacementRuntime = yield* makeSchedulingSessionRuntime(options);
        yield* Effect.addFinalizer(() => Effect.promise(replacementRuntime.close));
        const releaseNew = installSchedulingSessionRuntime(replacementRuntime);
        yield* Effect.addFinalizer(() => Effect.sync(releaseNew));
        releaseOld();
        assert.equal(readSchedulingSessionBroker(), replacementRuntime);
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => oldRuntime.authorize(oldToken))))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => oldRuntime.bind(identity))))._tag,
          "Failure",
        );
        assert.equal((yield* Effect.exit(Effect.tryPromise(old.activate)))._tag, "Failure");
        const current = yield* Effect.promise(() => replacementRuntime.bind(identity));
        yield* Effect.promise(current.activate);
        const currentToken = (yield* readToken(current)).token;
        yield* Effect.promise(oldRuntime.close);
        const authority = yield* Effect.promise(() =>
          dispatchSchedulingSessionAuthorization(currentToken),
        );
        yield* sql.withTransaction(requireSchedulingSessionAuthority(sql, authority));
        assert.equal(
          (yield* Effect.exit(
            Effect.tryPromise(() => dispatchSchedulingSessionAuthorization(oldToken)),
          ))._tag,
          "Failure",
        );
      }),
  );

  it.effect("revokes tombstoned chats without enabling later staged candidates", () =>
    Effect.gen(function* () {
      const { runtime, sql } = yield* fixture;
      const active = yield* Effect.promise(() => runtime.bind(identity));
      yield* Effect.promise(active.activate);
      const pending = yield* Effect.promise(() => runtime.bind(identity));
      const token = (yield* readToken(active)).token;
      const authority = yield* Effect.promise(() => runtime.authorize(token));
      yield* sql`INSERT INTO hard_deleted_threads (thread_id,deleted_at) VALUES (${identity.threadId},'2026-10-04T00:00:00.000Z')`;
      assert.equal(
        (yield* Effect.exit(sql.withTransaction(requireSchedulingSessionAuthority(sql, authority))))
          ._tag,
        "Failure",
      );
      assert.equal((yield* Effect.exit(Effect.tryPromise(pending.activate)))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(Effect.tryPromise(() => runtime.bind(identity))))._tag,
        "Failure",
      );
    }),
  );

  it.effect("publishes private host-native files and refuses replacement-directory cleanup", () =>
    Effect.gen(function* () {
      const { runtime } = yield* fixture;
      const binding = yield* Effect.promise(() =>
        runtime.bind({ ...identity, threadId: ThreadId.make("private-files-chat") }),
      );
      yield* Effect.promise(binding.activate);
      const token = (yield* readToken(binding)).token;
      const root = path.dirname(binding.launch.args[1]!);
      const moved = `${root}-moved`;
      if (process.platform !== "win32") {
        for (const entry of binding.launch.args)
          assert.equal(yield* Effect.promise(async () => (await fs.stat(entry)).mode & 0o077), 0);
        assert.equal(yield* Effect.promise(async () => (await fs.stat(root)).mode & 0o077), 0);
      }
      // No provider is spawned and no open directory/file handle is retained,
      // so this deterministic replacement requires no symlink privileges.
      yield* Effect.promise(async () => {
        await fs.rename(root, moved);
        await fs.mkdir(root, { mode: 0o700 });
        await fs.writeFile(path.join(root, "connection.json"), "replacement-must-survive");
      });
      try {
        assert.equal((yield* Effect.exit(Effect.tryPromise(binding.dispose)))._tag, "Failure");
        assert.equal(
          yield* Effect.promise(() => fs.readFile(path.join(root, "connection.json"), "utf8")),
          "replacement-must-survive",
        );
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(token))))._tag,
          "Failure",
        );
      } finally {
        yield* Effect.promise(async () => {
          await fs.unlink(path.join(root, "connection.json"));
          await fs.rmdir(root);
          await fs.rename(moved, root);
        });
      }
      // Safe cleanup can be retried after namespace identity is restored.
      yield* Effect.promise(binding.dispose);
    }),
  );
});
