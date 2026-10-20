// The fixture qualifies actual private connection files and their retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
// Native bridge paths remain structured inputs on the actual host.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { readBridgeConnection } from "../mcp/localBridge.ts";
import {
  makeVisualizationSessionRuntime,
  requireVisualizationSessionAuthority,
  type VisualizationSessionBinding,
} from "./sessionRuntime.ts";
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const identity = {
  threadId: ThreadId.make("visual-fixture"),
  providerInstanceId: ProviderInstanceId.make("codex_fixture"),
  provider: "codex" as const,
  runtimeMode: "full-access" as const,
};
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,runtime_mode,created_at,updated_at)
    VALUES(${identity.threadId},NULL,'Isolated Full-access policy','full-access','2026-10-13T00:00:00.000Z','2026-10-13T00:00:00.000Z')
    ON CONFLICT(thread_id) DO UPDATE SET runtime_mode='full-access'`;
  const root = yield* Effect.promise(() =>
    fs.mkdtemp(path.join(os.tmpdir(), "cafe-visual-session-fixture-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  );
  const bridgeSource = path.join(root, "bridge.mjs");
  yield* Effect.promise(() =>
    fs.writeFile(bridgeSource, "// Isolated synthetic bridge; never executed.\n"),
  );
  const options = { bridgeSource, mcpPort: 12345 };
  const runtime = yield* makeVisualizationSessionRuntime(options);
  yield* Effect.addFinalizer(() => Effect.promise(runtime.close));
  return { runtime, sql: yield* SqlClient.SqlClient, options };
});
const tokenFor = (binding: VisualizationSessionBinding) =>
  Effect.promise(() => readBridgeConnection(binding.launch.args[1]!, "cafe-visualizations"));

it.layer(TestSqliteClient.layerMemory())("private visualization generations", (it) => {
  it.effect(
    "admits discovery without mutation and fences exact owner generation and audience",
    () =>
      Effect.gen(function* () {
        const { runtime, sql } = yield* fixture;
        const binding = yield* Effect.promise(() => runtime.bind(identity));
        if (!binding) throw new Error("Expected isolated fixture binding.");
        const { token, url } = yield* tokenFor(binding);
        assert.equal(url, "http://127.0.0.1:12345/mcp/visualizations");
        assert.match(binding.name, /^cafe-visualizations-[A-Za-z0-9_-]{22}$/);
        assert.equal(encodeJson(binding.launch).includes(token), false);
        const authority = yield* Effect.promise(() => runtime.authorize(token));
        assert.equal(
          (yield* Effect.exit(
            sql.withTransaction(requireVisualizationSessionAuthority(sql, authority)),
          ))._tag,
          "Failure",
        );
        yield* Effect.promise(binding.activate);
        yield* sql.withTransaction(requireVisualizationSessionAuthority(sql, authority));
        for (const forged of [
          { ...authority, threadId: ThreadId.make("other") },
          { ...authority, providerInstanceId: ProviderInstanceId.make("claude_fixture") },
          { ...authority, tokenDigest: "0".repeat(64) },
          { ...authority, serverName: `cafe-visualizations-${"a".repeat(22)}` },
        ])
          assert.equal(
            (yield* Effect.exit(
              sql.withTransaction(requireVisualizationSessionAuthority(sql, forged)),
            ))._tag,
            "Failure",
          );
        assert.equal(
          encodeJson(yield* sql`SELECT * FROM visualization_session_capabilities`).includes(token),
          false,
        );
        yield* Effect.promise(binding.dispose);
        yield* Effect.promise(binding.dispose);
        assert.equal(
          (yield* Effect.exit(
            sql.withTransaction(requireVisualizationSessionAuthority(sql, authority)),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(token))))._tag,
          "Failure",
        );
      }),
  );
  it.effect("does not advertise unsupported provenance or unavailable runtime policy", () =>
    Effect.gen(function* () {
      const { runtime, options } = yield* fixture;
      assert.equal(
        yield* Effect.promise(() => runtime.bind({ ...identity, provider: "grok" })),
        undefined,
      );
      const unavailable = yield* makeVisualizationSessionRuntime({
        ...options,
        available: () => Promise.resolve(false),
      });
      yield* Effect.addFinalizer(() => Effect.promise(unavailable.close));
      assert.equal(yield* Effect.promise(() => unavailable.bind(identity)), undefined);
    }),
  );
  it.effect(
    "requires both trusted Full-access launch policy and current persisted thread policy",
    () =>
      Effect.gen(function* () {
        const { runtime, sql } = yield* fixture;
        assert.equal(
          yield* Effect.promise(() =>
            runtime.bind({ ...identity, runtimeMode: "approval-required" }),
          ),
          undefined,
        );
        yield* sql`UPDATE projection_threads SET runtime_mode='approval-required' WHERE thread_id=${identity.threadId}`;
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.bind(identity))))._tag,
          "Failure",
        );
        yield* sql`UPDATE projection_threads SET runtime_mode='full-access' WHERE thread_id=${identity.threadId}`;
        const binding = yield* Effect.promise(() => runtime.bind(identity));
        if (!binding) throw new Error("Expected Full-access fixture binding.");
        const { token } = yield* tokenFor(binding);
        yield* Effect.promise(binding.activate);
        yield* sql.withTransaction(requireVisualizationSessionAuthority(sql, binding.authority));
        yield* sql`UPDATE projection_threads SET runtime_mode='approval-required' WHERE thread_id=${identity.threadId}`;
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(token))))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            sql.withTransaction(requireVisualizationSessionAuthority(sql, binding.authority)),
          ))._tag,
          "Failure",
        );
        yield* sql`DELETE FROM projection_threads WHERE thread_id=${identity.threadId}`;
        assert.equal(
          (yield* Effect.exit(Effect.tryPromise(() => runtime.authorize(token))))._tag,
          "Failure",
        );
      }),
  );
  it.effect("rejects stale activation and old-owner close without revoking the replacement", () =>
    Effect.gen(function* () {
      const { runtime, options, sql } = yield* fixture;
      const first = yield* Effect.promise(() => runtime.bind(identity));
      if (!first) throw new Error("Expected fixture binding.");
      yield* Effect.promise(first.activate);
      const stale = yield* Effect.promise(() => runtime.bind(identity));
      const fresh = yield* Effect.promise(() => runtime.bind(identity));
      if (!stale || !fresh) throw new Error("Expected fixture binding.");
      yield* Effect.promise(fresh.activate);
      assert.equal((yield* Effect.exit(Effect.tryPromise(stale.activate)))._tag, "Failure");
      yield* Effect.promise(first.dispose);
      yield* sql.withTransaction(requireVisualizationSessionAuthority(sql, fresh.authority));
      const replacement = yield* makeVisualizationSessionRuntime(options);
      yield* Effect.addFinalizer(() => Effect.promise(replacement.close));
      const current = yield* Effect.promise(() => replacement.bind(identity));
      if (!current) throw new Error("Expected fixture binding.");
      yield* Effect.promise(current.activate);
      yield* Effect.promise(runtime.close);
      yield* sql.withTransaction(requireVisualizationSessionAuthority(sql, current.authority));
      assert.equal((yield* Effect.exit(Effect.tryPromise(fresh.activate)))._tag, "Failure");
    }),
  );
});
