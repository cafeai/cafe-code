import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import { DEFAULT_SERVER_SETTINGS } from "@cafecode/contracts";

import { ServerConfig } from "../config.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeMcpManagement, refreshMcpBridgeCredential } from "./McpManagement.ts";
import { readBridgeConnection } from "./localBridge.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const sessionsLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cafe-mcp-credential-test-" })),
);

it.layer(NodeServices.layer)("MCP credential lifecycle", (it) => {
  it.effect(
    "finishes an admitted install after its caller disconnects and serializes another install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sessions = yield* SessionCredentialService;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "cafe-mcp-management-test-" })
          .pipe(Effect.flatMap(fs.realPath));
        const source = path.join(root, "source.mjs");
        yield* fs.writeFileString(source, "// fixture bridge\n");
        const admitted = yield* Deferred.make<void>();
        const continueInstall = yield* Deferred.make<void>();
        let issueCount = 0;
        const config = Context.get(
          yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), { prefix: "cafe-mcp-management-config-" }),
          ),
          ServerConfig,
        );
        const settings = Context.get(
          yield* Layer.build(
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            }),
          ),
          ServerSettingsService,
        );
        const management = yield* makeMcpManagement({
          stateDir: path.join(root, "state"),
          home: path.join(root, "home"),
          env: {},
          executable: process.execPath,
          bridgeSource: source,
          platform: "linux",
        }).pipe(
          Effect.provideService(SessionCredentialService, {
            ...sessions,
            issue: (input) =>
              Effect.gen(function* () {
                issueCount++;
                yield* Deferred.succeed(admitted, undefined);
                yield* Deferred.await(continueInstall);
                return yield* sessions.issue(input);
              }),
          }),
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ServerConfig, { ...config, mode: "desktop", port: 1234 }),
        );
        const first = yield* management
          .updateClient({ client: "codex", operation: "install" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(first);
        const second = yield* management
          .updateClient({ client: "grok", operation: "install" })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(continueInstall, undefined);
        yield* Fiber.join(second);
        const status = yield* management.status({ canManage: true, canInstall: true });
        expect(status.clients.find((client) => client.id === "codex")?.status).toBe("installed");
        expect(status.clients.find((client) => client.id === "grok")?.status).toBe("installed");
        expect(status.bridgeReady).toBe(true);
        expect(issueCount).toBe(1);
      }).pipe(Effect.provide(sessionsLayer)),
  );
  it.effect("reuses a valid private session across port changes and rotates before expiry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessions = yield* SessionCredentialService;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-mcp-connection-test-" });
      const connectionPath = path.join(yield* fs.realPath(directory), "connection.json");
      yield* refreshMcpBridgeCredential({
        connectionPath,
        url: "http://127.0.0.1:1234/mcp",
        sessions,
      });
      const first = yield* Effect.promise(() => readBridgeConnection(connectionPath));
      expect((yield* sessions.verify(first.token)).role).toBe("owner");
      yield* refreshMcpBridgeCredential({
        connectionPath,
        url: "http://127.0.0.1:5678/mcp",
        sessions,
      });
      const moved = yield* Effect.promise(() => readBridgeConnection(connectionPath));
      expect(moved.token).toBe(first.token);
      expect(moved.url).toBe("http://127.0.0.1:5678/mcp");
      yield* TestClock.adjust(Duration.days(24));
      yield* refreshMcpBridgeCredential({ connectionPath, url: moved.url, sessions });
      const renewed = yield* Effect.promise(() => readBridgeConnection(connectionPath));
      expect(renewed.token).not.toBe(first.token);
      // Requests that read the old file before publication may still complete.
      expect((yield* sessions.verify(first.token)).role).toBe("owner");
      yield* TestClock.adjust(Duration.days(7));
      expect((yield* Effect.exit(sessions.verify(first.token)))._tag).toBe("Failure");
      expect((yield* sessions.verify(renewed.token)).role).toBe("owner");
      const verified = yield* sessions.verify(renewed.token);
      yield* sessions.revoke(verified.sessionId);
      const backgroundRefresh = yield* Effect.exit(
        refreshMcpBridgeCredential({ connectionPath, url: moved.url, sessions }),
      );
      expect(backgroundRefresh._tag).toBe("Failure");
      expect((yield* Effect.promise(() => readBridgeConnection(connectionPath))).token).toBe(
        renewed.token,
      );
      yield* refreshMcpBridgeCredential({
        connectionPath,
        url: moved.url,
        sessions,
        reissueInvalid: true,
      });
      const repaired = yield* Effect.promise(() => readBridgeConnection(connectionPath));
      expect((yield* sessions.verify(repaired.token)).role).toBe("owner");
      expect(repaired.token).not.toBe(renewed.token);
    }).pipe(Effect.provide(sessionsLayer)),
  );
});
