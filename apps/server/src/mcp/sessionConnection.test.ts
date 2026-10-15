import { makeMcpManagement } from "./McpManagement.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeManagementMcpSession } from "./sessionConnection.ts";
import { readBridgeConnection } from "./localBridge.ts";
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "cafe-session-mcp-test-" });
const sessionsLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(configLayer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "cafe-session-mcp-fixture-" })
    .pipe(Effect.flatMap(fs.realPath));
  const bridgeSource = path.join(root, "bridge.mjs");
  yield* fs.writeFileString(bridgeSource, "// isolated bridge fixture\n");
  const credentials = yield* SessionCredentialService;
  const input = {
    threadId: ThreadId.make("fixture-chat"),
    providerInstanceId: ProviderInstanceId.make("codex_personal"),
    bridgeSource,
    port: 12345,
    credentials,
  };
  return { fs, path, root, input, credentials };
});
it.layer(NodeServices.layer)("launch-time management connection", (it) => {
  it.effect(
    "publishes private per-session credentials without putting tokens in argv and revokes only its own grants",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = (yield* makeManagementMcpSession(f.input))!;
        const second = (yield* makeManagementMcpSession({
          ...f.input,
          threadId: ThreadId.make("other-chat"),
        }))!;
        const a = yield* Effect.promise(() => readBridgeConnection(first.launch.args[1]!));
        const b = yield* Effect.promise(() => readBridgeConnection(second.launch.args[1]!));
        expect(first.name).not.toBe(second.name);
        expect(a.token).not.toBe(b.token);
        expect(JSON.stringify(first.launch)).not.toContain(a.token);
        expect(first.launch.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
        expect((yield* f.credentials.verify(a.token)).role).toBe("owner");
        yield* first.dispose;
        yield* first.dispose;
        expect((yield* Effect.exit(f.credentials.verify(a.token)))._tag).toBe("Failure");
        expect((yield* f.credentials.verify(b.token)).role).toBe("owner");
        expect(yield* f.fs.exists(first.launch.args[1]!)).toBe(false);
        yield* second.dispose;
        expect((yield* Effect.exit(f.credentials.verify(b.token)))._tag).toBe("Failure");
      }).pipe(Effect.provide(sessionsLayer), Effect.provide(configLayer)),
  );
  it.effect("renews a multi-day connection without overriding owner revocation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const binding = (yield* makeManagementMcpSession(f.input))!;
      const first = yield* Effect.promise(() => readBridgeConnection(binding.launch.args[1]!));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.days(24));
      const next = yield* Effect.promise(() =>
        vi.waitFor(async () => {
          const current = await readBridgeConnection(binding.launch.args[1]!);
          expect(current.token).not.toBe(first.token);
          return current;
        }),
      );
      expect(next.token).not.toBe(first.token);
      const verified = yield* f.credentials.verify(next.token);
      yield* f.credentials.revoke(verified.sessionId);
      yield* TestClock.adjust(Duration.days(1));
      expect(
        (yield* Effect.promise(() => readBridgeConnection(binding.launch.args[1]!))).token,
      ).toBe(next.token);
      expect((yield* Effect.exit(f.credentials.verify(next.token)))._tag).toBe("Failure");
      yield* binding.dispose;
      expect((yield* Effect.exit(f.credentials.verify(first.token)))._tag).toBe("Failure");
    }).pipe(Effect.provide(sessionsLayer), Effect.provide(configLayer)),
  );
  it.effect(
    "retires a failed launch credential and preserves replaced private files during cleanup",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          (yield* Effect.exit(
            makeManagementMcpSession({
              ...f.input,
              bridgeSource: f.path.join(f.root, "absent.mjs"),
            }),
          ))._tag,
        ).toBe("Failure");
        expect((yield* f.credentials.listActive()).length).toBe(0);
        const binding = (yield* makeManagementMcpSession(f.input))!;
        const original = yield* Effect.promise(() => readBridgeConnection(binding.launch.args[1]!));
        const saved = f.path.join(f.root, "saved-connection.json");
        yield* f.fs.rename(binding.launch.args[1]!, saved);
        yield* f.fs.writeFileString(binding.launch.args[1]!, "replacement");
        yield* binding.dispose;
        expect((yield* Effect.exit(f.credentials.verify(original.token)))._tag).toBe("Failure");
        expect(yield* f.fs.readFileString(binding.launch.args[1]!)).toBe("replacement");
        yield* f.fs.remove(f.path.dirname(binding.launch.args[1]!), { recursive: true });
      }).pipe(Effect.provide(sessionsLayer), Effect.provide(configLayer)),
  );
  it.effect("retires every old installer credential without touching ordinary owner sessions", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const oldA = yield* f.credentials.issue({
        subject: "cafe-mcp-local-bridge",
        role: "owner",
        method: "bearer-session-token",
      });
      const oldB = yield* f.credentials.issue({
        subject: "cafe-mcp-local-bridge",
        role: "owner",
        method: "bearer-session-token",
      });
      const owner = yield* f.credentials.issue({
        subject: "browser-owner",
        role: "owner",
        method: "bearer-session-token",
      });
      const config = yield* ServerConfig;
      yield* makeMcpManagement.pipe(
        Effect.provideService(ServerConfig, { ...config, mode: "desktop" }),
      );
      expect((yield* Effect.exit(f.credentials.verify(oldA.token)))._tag).toBe("Failure");
      expect((yield* Effect.exit(f.credentials.verify(oldB.token)))._tag).toBe("Failure");
      expect((yield* f.credentials.verify(owner.token)).role).toBe("owner");
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest()),
      Effect.provide(sessionsLayer),
      Effect.provide(configLayer),
    ),
  );
});
