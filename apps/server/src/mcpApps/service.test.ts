import { randomUUID } from "node:crypto";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { ThreadId, type OrchestrationCommand } from "@cafecode/contracts";
import type { ProviderDaemonJsonRequestOptions } from "@cafecode/shared/providerDaemonHttp";
import {
  MCP_APP_JSON_MAX_BYTES,
  MCP_APP_JSON_MAX_TRANSPORT_BYTES,
} from "@cafecode/shared/mcpAppJson";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { MCP_APP_MAX_PENDING_CONSENTS, type McpAppPrepareInput } from "@cafecode/contracts/mcpApps";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { VisualizationArtifacts } from "../visualizations/service.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { makeMcpAppsService } from "./service.ts";

// Controlled browser-frame grants qualify exact broker decisions. They do not
// claim that Full-access same-origin pages are contained or trustworthy.
const peer = vi.hoisted(() => ({
  generation: "00000000-0000-4000-8000-000000000003",
  documentGeneration: "00000000-0000-4000-8000-000000000004",
  leaseId: "00000000-0000-4000-8000-000000000005",
  frameIds: undefined as Set<string> | undefined,
  snapshotHook: undefined as ((input: McpAppPrepareInput) => void | Promise<void>) | undefined,
  expiresAtMs: 0 as number | null,
  active: true,
  toolCalls: 0,
  contextCalls: 0,
  catalogueHook: undefined as (() => void | Promise<void>) | undefined,
  ownerOperations: [] as Array<{ method: string; consentExpiresAtMs?: number }>,
  visibility: ["app"],
  result: "{}",
  textSchema: false,
  httpBodies: [] as string[],
  httpResponseCaps: [] as number[],
}));
vi.mock("@cafecode/shared/providerDaemonHttp", () => ({
  requestProviderDaemonJson: async (
    _endpoint: unknown,
    path: string,
    options: ProviderDaemonJsonRequestOptions,
  ) => {
    if (path !== "/visualizations/apps/owner" || !options.body)
      throw new Error("Unexpected synthetic App route.");
    peer.httpBodies.push(options.body);
    peer.httpResponseCaps.push(options.maxResponseBytes ?? 0);
    const { dispatchMcpAppOwnerOperation } = await import("./owner.ts");
    const json = await dispatchMcpAppOwnerOperation(JSON.parse(options.body));
    return { statusCode: 200, body: JSON.stringify({ json }) };
  },
}));
vi.mock("./owner.ts", () => ({
  MCP_APP_OWNER_PATH: "/visualizations/apps/owner",
  dispatchMcpAppOwnerOperation: async (input: { method: string; consentExpiresAtMs?: number }) => {
    peer.ownerOperations.push(input);
    if (input.method === "catalog") {
      await peer.catalogueHook?.();
      return JSON.stringify({
        data: [
          {
            name: "fixture-server",
            tools: {
              act: {
                inputSchema: {
                  type: "object",
                  properties: {
                    count: { type: "integer", minimum: 1 },
                    ...(peer.textSchema ? { text: { type: "string", maxLength: 60_000 } } : {}),
                  },
                  required: ["count"],
                  additionalProperties: false,
                },
                _meta: { ui: { visibility: peer.visibility } },
              },
            },
            resources: [{ uri: "ui://owned" }],
          },
        ],
      });
    }
    if (input.method === "context") {
      peer.contextCalls += 1;
      return "{}";
    }
    if (input.method === "tool") peer.toolCalls += 1;
    return peer.result;
  },
}));

const base = {
  threadId: ThreadId.make("app-fixture"),
  artifactId: VisualizationArtifactId.make("00000000-0000-4000-8000-000000000001"),
  revisionId: VisualizationRevisionId.make("00000000-0000-4000-8000-000000000002"),
  leaseId: "00000000-0000-4000-8000-000000000005",
  ticket: "a".repeat(64),
};
const request = (
  method: string,
  params: unknown,
  id: number | null = 1,
  leaseId = base.leaseId,
): McpAppPrepareInput => ({
  ...base,
  leaseId,
  requestJson: JSON.stringify({ jsonrpc: "2.0", method, ...(id === null ? {} : { id }), params }),
});
const makeFixture = (useDaemon = false) =>
  Effect.gen(function* () {
    peer.generation = "00000000-0000-4000-8000-000000000003";
    peer.documentGeneration = "00000000-0000-4000-8000-000000000004";
    peer.leaseId = base.leaseId;
    peer.frameIds = undefined;
    peer.snapshotHook = undefined;
    peer.expiresAtMs = Date.now() + 60_000;
    peer.active = true;
    peer.toolCalls = 0;
    peer.contextCalls = 0;
    peer.catalogueHook = undefined;
    peer.ownerOperations = [];
    peer.visibility = ["app"];
    peer.result = "{}";
    peer.textSchema = false;
    peer.httpBodies = [];
    peer.httpResponseCaps = [];
    const dispatched: OrchestrationCommand[] = [];
    // Only these two owner-read methods are exercised. All other artifact APIs
    // remain absent, so an accidental unrelated operation fails the fixture.
    const artifacts = {
      readInlineFrame: (input: Pick<McpAppPrepareInput, "leaseId" | "ticket">) =>
        Effect.suspend(() => {
          if (
            (peer.frameIds ? !peer.frameIds.has(input.leaseId) : input.leaseId !== peer.leaseId) ||
            input.ticket !== base.ticket ||
            peer.generation !== "00000000-0000-4000-8000-000000000003" ||
            !peer.active ||
            peer.expiresAtMs === null ||
            peer.expiresAtMs <= Date.now()
          )
            return Effect.fail(new Error("Synthetic frame grant refused."));
          return Effect.succeed({
            documentGeneration: peer.frameIds ? input.leaseId : peer.documentGeneration,
            expiresAtMs: peer.expiresAtMs,
          });
        }),
      inlineFrameDeadline: (input: Pick<McpAppPrepareInput, "leaseId" | "ticket">) =>
        peer.active &&
        peer.expiresAtMs !== null &&
        (peer.frameIds ? peer.frameIds.has(input.leaseId) : input.leaseId === peer.leaseId) &&
        input.ticket === base.ticket
          ? peer.expiresAtMs
          : undefined,
      readMcpAppSnapshot: (input: McpAppPrepareInput) =>
        Effect.promise(async () => {
          await peer.snapshotHook?.(input);
          return {
            kind: "mcp-app",
            privateJson: JSON.stringify({
              input: {
                originalInputJson: '{"count":1}',
                originalResultJson: '{"content":[]}',
                serverName: "fixture-server",
                originCallId: "call",
              },
              witness: {
                provider: "codex",
                threadId: base.threadId,
                providerInstanceId: "codex_fixture",
                sessionGeneration: "00000000-0000-4000-8000-000000000006",
                nativeThreadId: "native",
              },
            }),
          };
        }).pipe(Effect.tap(() => Effect.yieldNow)),
    } as unknown as VisualizationArtifacts["Service"];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineService["Service"];
    const config = {
      stateDir: "fixture-not-read",
      providerDaemon: useDaemon
        ? {
            httpBaseUrl: "http://127.0.0.1:1",
            token: "synthetic-not-sent".repeat(4),
          }
        : undefined,
      providerSupervisor: undefined,
    } as ServerConfigShape;
    const service = yield* makeMcpAppsService.pipe(
      Effect.provideService(VisualizationArtifacts, artifacts),
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ServerConfig, config),
    );
    const initialize = (leaseId = base.leaseId) =>
      Effect.gen(function* () {
        const reply = yield* service.prepare(
          request(
            "ui/initialize",
            {
              protocolVersion: "2026-01-26",
              appInfo: { name: "fixture", version: "1" },
              appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
            },
            1,
            leaseId,
          ),
        );
        assert.equal(reply.kind, "reply");
        return yield* service.prepare(request("ui/notifications/initialized", {}, null, leaseId));
      });
    return { service, initialize, dispatched, sql: yield* SqlClient.SqlClient };
  });
const fixture = makeFixture();

it.layer(TestSqliteClient.layerMemory())("exact MCP App consent broker", (it) => {
  it.effect(
    "refuses revoked or replaced frames after snapshot I/O without retaining initialized protocol state",
    () =>
      Effect.gen(function* () {
        for (const change of ["revoke", "replace"] as const) {
          const { service, initialize } = yield* fixture;
          const originalGeneration = peer.documentGeneration;
          peer.snapshotHook = async () => {
            // Real asynchronous snapshot work outlives the initial grant read.
            await Promise.resolve();
            if (change === "revoke") peer.active = false;
            else peer.documentGeneration = randomUUID();
          };
          const denied = yield* Effect.exit(
            service.prepare(
              request("ui/initialize", {
                protocolVersion: "2026-01-26",
                appInfo: { name: "fixture", version: "1" },
                appCapabilities: {},
              }),
            ),
          );
          assert.equal(denied._tag, "Failure");
          assert.equal(peer.ownerOperations.length, 0);
          peer.active = true;
          peer.documentGeneration = originalGeneration;
          peer.snapshotHook = undefined;
          const premature = yield* service.prepare(
            request("ui/notifications/initialized", {}, null),
          );
          // A stale initializer must not survive and replay original private
          // input/results merely because the same fixture identity is restored.
          assert.deepStrictEqual(premature, { kind: "reply", json: "" });
          const fresh = yield* initialize();
          if (fresh.kind !== "reply") throw new Error("Expected exact fresh replay.");
          assert.equal(JSON.parse(fresh.json).method, "ui/notifications/tool-input");
          assert.equal(fresh.messages?.length, 1);
        }
      }),
  );
  it.effect(
    "rechecks the exact 128-session cap at concurrent snapshot completion before creating protocols",
    () =>
      Effect.gen(function* () {
        const { service, initialize } = yield* fixture;
        const frameIds = Array.from({ length: 129 }, () => randomUUID());
        // This isolated faulty artifact peer deliberately admits one excess frame
        // identifier. Production grant admission remains bounded to128; this
        // proves the Apps metadata pool independently retains its own exact cap.
        peer.frameIds = new Set(frameIds);
        for (const frameId of frameIds.slice(0, 127)) yield* initialize(frameId);
        let reads = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        peer.snapshotHook = () => {
          reads += 1;
          if (reads === 2) release();
          return gate;
        };
        const results = yield* Effect.all(
          frameIds.slice(127).map((frameId) =>
            Effect.exit(
              service.prepare(
                request(
                  "ui/initialize",
                  {
                    protocolVersion: "2026-01-26",
                    appInfo: { name: "fixture", version: "1" },
                    appCapabilities: {},
                  },
                  1,
                  frameId,
                ),
              ),
            ),
          ),
          { concurrency: 2 },
        );
        assert.equal(reads, 2);
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        peer.snapshotHook = undefined;
        const admittedIndex = results.findIndex((result) => result._tag === "Success");
        const refusedIndex = results.findIndex((result) => result._tag === "Failure");
        const admittedFrame = frameIds[127 + admittedIndex]!;
        const refusedFrame = frameIds[127 + refusedIndex]!;
        const replay = yield* service.prepare(
          request("ui/notifications/initialized", {}, null, admittedFrame),
        );
        if (replay.kind !== "reply") throw new Error("Expected retained exact protocol.");
        assert.equal(JSON.parse(replay.json).method, "ui/notifications/tool-input");
        assert.equal(
          (yield* Effect.exit(service.prepare(request("ping", {}, 2, refusedFrame))))._tag,
          "Failure",
        );
        assert.equal(peer.ownerOperations.length, 0);
      }),
  );
  it.effect(
    "serializes first-frame protocol preparation without retaining overlapping requests",
    () =>
      Effect.gen(function* () {
        const { service } = yield* fixture;
        const input = request("ui/initialize", {
          protocolVersion: "2026-01-26",
          appInfo: { name: "fixture", version: "1" },
          appCapabilities: {},
        });
        const results = yield* Effect.all(
          [Effect.exit(service.prepare(input)), Effect.exit(service.prepare(input))],
          { concurrency: 2 },
        );
        assert.equal(results.filter((value) => value._tag === "Success").length, 1);
        assert.equal(results.filter((value) => value._tag === "Failure").length, 1);
        const initialized = yield* service.prepare(
          request("ui/notifications/initialized", {}, null),
        );
        assert.equal(initialized.kind, "reply");
        if (initialized.kind === "reply") {
          assert.equal(JSON.parse(initialized.json).method, "ui/notifications/tool-input");
          assert.equal(initialized.messages?.length, 1);
        }
        assert.deepStrictEqual(
          yield* service.prepare(request("ui/notifications/initialized", {}, null)),
          { kind: "reply", json: "" },
        );
      }),
  );
  it.effect(
    "returns the immutable consent deadline and refuses spending it after catalogue I/O despite a renewed frame grant",
    () =>
      Effect.gen(function* () {
        let clock = Date.now();
        const observe = vi.spyOn(Date, "now").mockImplementation(() => clock);
        try {
          const { service, initialize } = yield* fixture;
          yield* initialize();
          peer.expiresAtMs = clock + 12_000;
          const consent = yield* service.prepare(
            request("tools/call", { name: "act", arguments: { count: 1 } }),
          );
          if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
          assert.equal(consent.expiresAtMs, clock + 12_000);
          peer.catalogueHook = () => {
            clock += 12_001;
            peer.expiresAtMs = clock + 60_000;
          };
          assert.equal(
            (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
            "Failure",
          );
          assert.equal(peer.toolCalls, 0);
          assert.equal(
            (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
            "Failure",
          );
        } finally {
          observe.mockRestore();
        }
      }),
  );
  it.effect(
    "forwards the original resource/tool consent deadline unchanged through local and private daemon dispatch",
    () =>
      Effect.gen(function* () {
        for (const useDaemon of [false, true]) {
          const { service, initialize } = yield* makeFixture(useDaemon);
          yield* initialize();
          peer.expiresAtMs = Date.now() + 12_000;
          for (const [method, params, ownerMethod] of [
            ["tools/call", { name: "act", arguments: { count: 1 } }, "tool"],
            ["resources/read", { uri: "ui://owned" }, "resource"],
          ] as const) {
            const consent = yield* service.prepare(request(method, params));
            if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
            // Healthy frame renewal must not grant additional spending time to
            // consent already shown to the user, including across a daemon hop.
            peer.expiresAtMs = Date.now() + 60_000;
            yield* service.resolve({ ...consent, decision: "approve" });
            const dispatched = peer.ownerOperations.filter((input) => input.method === ownerMethod);
            assert.equal(dispatched.length, 1);
            assert.equal(dispatched[0]!.consentExpiresAtMs, consent.expiresAtMs);
            if (useDaemon) {
              const wire = peer.httpBodies
                .map((body) => JSON.parse(body) as { method: string; consentExpiresAtMs?: number })
                .find((input) => input.method === ownerMethod);
              assert.equal(wire?.consentExpiresAtMs, consent.expiresAtMs);
            }
          }
          assert.ok(
            peer.ownerOperations
              .filter((input) => input.method === "catalog")
              .every((input) => !Object.hasOwn(input, "consentExpiresAtMs")),
          );
        }
      }),
  );
  it.effect(
    "bounds concurrent consent admission across distinct frames to eight after asynchronous catalogue reads",
    () =>
      Effect.gen(function* () {
        const { service, initialize } = yield* fixture;
        const frameIds = Array.from({ length: MCP_APP_MAX_PENDING_CONSENTS + 2 }, () =>
          randomUUID(),
        );
        peer.frameIds = new Set(frameIds);
        for (const frameId of frameIds) yield* initialize(frameId);
        let catalogueCount = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        peer.catalogueHook = () => {
          catalogueCount += 1;
          // Every preparation sees the original empty pending map, then crosses
          // real asynchronous catalogue I/O together. A pre-await size check
          // alone would incorrectly admit all ten distinct frame operations.
          if (catalogueCount === frameIds.length) release();
          return gate;
        };
        const results = yield* Effect.all(
          frameIds.map((frameId) =>
            service.prepare(
              request("tools/call", { name: "act", arguments: { count: 1 } }, 1, frameId),
            ),
          ),
          { concurrency: frameIds.length },
        );
        assert.equal(catalogueCount, frameIds.length);
        const admitted = results.filter((result) => result.kind === "consent");
        assert.equal(admitted.length, MCP_APP_MAX_PENDING_CONSENTS);
        const refused = results.filter((result) => result.kind === "reply");
        assert.equal(refused.length, 2);
        for (const result of refused) assert.match(result.json, /Operation unavailable/);
        assert.equal(
          new Set(admitted.map((result) => result.operationId)).size,
          MCP_APP_MAX_PENDING_CONSENTS,
        );
        for (const consent of admitted)
          assert.match((yield* service.details(consent)).json, /"count":1/);
        assert.equal(peer.toolCalls, 0);
        peer.catalogueHook = undefined;
        yield* service.resolve({ ...admitted[0]!, decision: "deny" });
        const replacement = yield* service.prepare(
          request(
            "tools/call",
            { name: "act", arguments: { count: 1 } },
            2,
            frameIds[frameIds.length - 1]!,
          ),
        );
        assert.equal(replacement.kind, "consent");
      }),
  );
  it.effect(
    "preserves bounded quote-heavy requests and results across the escaped private daemon envelope",
    () =>
      Effect.gen(function* () {
        const { service, initialize } = yield* makeFixture(true);
        yield* initialize();
        peer.textSchema = true;
        const text = '"'.repeat(50_000);
        peer.result = JSON.stringify({ content: [{ type: "text", text }] });
        const consent = yield* service.prepare(
          request("tools/call", {
            name: "act",
            arguments: { count: 1, text },
          }),
        );
        if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
        const reply = yield* service.resolve({ ...consent, decision: "approve" });
        assert.equal(JSON.parse(reply.json).result.content[0].text, text);
        assert.equal(peer.toolCalls, 1);
        assert.ok(
          peer.httpBodies.some(
            (body) => new TextEncoder().encode(body).byteLength > MCP_APP_JSON_MAX_BYTES,
          ),
        );
        assert.ok(
          peer.httpBodies.every(
            (body) => new TextEncoder().encode(body).byteLength <= MCP_APP_JSON_MAX_TRANSPORT_BYTES,
          ),
        );
        assert.ok(peer.httpResponseCaps.every((cap) => cap === MCP_APP_JSON_MAX_TRANSPORT_BYTES));
      }),
  );
  it.effect("orders original input/result once and refuses premature operations", () =>
    Effect.gen(function* () {
      const { service, initialize } = yield* fixture;
      assert.match(
        JSON.stringify(
          yield* service.prepare(request("tools/call", { name: "act", arguments: { count: 1 } })),
        ),
        /Operation unavailable/,
      );
      const original = yield* initialize();
      assert.equal(original.kind, "reply");
      if (original.kind !== "reply") return;
      assert.equal(JSON.parse(original.json).method, "ui/notifications/tool-input");
      assert.equal(JSON.parse(original.messages![0]!).method, "ui/notifications/tool-result");
      const duplicate = yield* service.prepare(request("ui/notifications/initialized", {}, null));
      assert.deepStrictEqual(duplicate, { kind: "reply", json: "" });
      assert.equal(peer.toolCalls, 0);
    }),
  );
  it.effect("refuses mismatched frame IDs and revoked grant generations", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture;
      peer.leaseId = "00000000-0000-4000-8000-000000000007";
      assert.equal((yield* Effect.exit(service.prepare(request("ping", {}))))._tag, "Failure");
      peer.leaseId = base.leaseId;
      peer.generation = "00000000-0000-4000-8000-000000000008";
      assert.equal((yield* Effect.exit(service.prepare(request("ping", {}))))._tag, "Failure");
    }),
  );
  it.effect("requires app visibility and exact schema before one-use consent", () =>
    Effect.gen(function* () {
      const { service, initialize } = yield* fixture;
      yield* initialize();
      for (const args of [{}, { count: 0 }, { count: 2, extra: true }])
        assert.match(
          JSON.stringify(
            yield* service.prepare(request("tools/call", { name: "act", arguments: args })),
          ),
          /Operation unavailable/,
        );
      peer.visibility = ["model"];
      assert.match(
        JSON.stringify(
          yield* service.prepare(request("tools/call", { name: "act", arguments: { count: 1 } })),
        ),
        /Operation unavailable/,
      );
      peer.visibility = ["app"];
      const consent = yield* service.prepare(
        request("tools/call", { name: "act", arguments: { count: 1 } }),
      );
      assert.equal(consent.kind, "consent");
      if (consent.kind !== "consent") return;
      const detail = yield* service.details(consent);
      assert.match(detail.json, /"count":1/);
      const reply = yield* service.resolve({ ...consent, decision: "approve" });
      assert.equal(JSON.parse(reply.json).id, 1);
      assert.equal(peer.toolCalls, 1);
      assert.equal(
        (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
        "Failure",
      );
      assert.equal(peer.toolCalls, 1);
    }),
  );
  it.effect("rechecks the document after approval catalogue I/O, before dispatch", () =>
    Effect.gen(function* () {
      const { service, initialize } = yield* fixture;
      yield* initialize();
      const consent = yield* service.prepare(
        request("tools/call", { name: "act", arguments: { count: 1 } }),
      );
      if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
      peer.catalogueHook = () => {
        peer.documentGeneration = "00000000-0000-4000-8000-000000000009";
      };
      assert.equal(
        (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
        "Failure",
      );
      assert.equal(peer.toolCalls, 0);
      assert.equal(
        (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
        "Failure",
      );
    }),
  );
  it.effect("denies without side effects; context replacement never starts inference", () =>
    Effect.gen(function* () {
      const { service, initialize, dispatched } = yield* fixture;
      yield* initialize();
      const consent = yield* service.prepare(
        request("tools/call", { name: "act", arguments: { count: 1 } }),
      );
      if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
      yield* service.resolve({ ...consent, decision: "deny" });
      assert.equal(peer.toolCalls, 0);
      yield* service.prepare(
        request("ui/update-model-context", {
          content: [{ type: "text", text: "Untrusted fixture context" }],
        }),
      );
      assert.equal(peer.contextCalls, 1);
      assert.deepStrictEqual(dispatched, []);
    }),
  );
  it.effect("never approves revoked visibility, foreign resources or expired documents", () =>
    Effect.gen(function* () {
      const { service, initialize } = yield* fixture;
      yield* initialize();
      assert.match(
        JSON.stringify(yield* service.prepare(request("resources/read", { uri: "ui://foreign" }))),
        /Operation unavailable/,
      );
      const consent = yield* service.prepare(
        request("tools/call", { name: "act", arguments: { count: 1 } }),
      );
      if (consent.kind !== "consent") throw new Error("Expected fixture consent.");
      peer.visibility = [];
      assert.equal(
        (yield* Effect.exit(service.resolve({ ...consent, decision: "approve" })))._tag,
        "Failure",
      );
      assert.equal(peer.toolCalls, 0);
      peer.expiresAtMs = Date.now() - 1;
      assert.equal((yield* Effect.exit(service.prepare(request("ping", {}))))._tag, "Failure");
      peer.expiresAtMs = null;
      assert.equal((yield* Effect.exit(service.prepare(request("ping", {}))))._tag, "Failure");
    }),
  );
  it.effect("binds an explicit user message to the observed current account and modes", () =>
    Effect.gen(function* () {
      const { service, initialize, dispatched, sql } = yield* fixture;
      yield* initialize();
      // A scoped SQLite projection fixture, not the user's database or providers.
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads(thread_id TEXT PRIMARY KEY,runtime_mode TEXT,interaction_mode TEXT,model_selection_json TEXT,deleted_at TEXT)`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`INSERT INTO projection_threads VALUES(${base.threadId},'full-access','default',${JSON.stringify({ instanceId: "foreign", model: "fixture" })},NULL)`;
      const message = request("ui/message", {
        role: "user",
        content: [{ type: "text", text: "Explicit approved fixture message" }],
      });
      const foreign = yield* service.prepare(message);
      if (foreign.kind !== "consent") throw new Error("Expected fixture consent.");
      assert.equal(
        (yield* Effect.exit(service.resolve({ ...foreign, decision: "approve" })))._tag,
        "Failure",
      );
      assert.equal(dispatched.length, 0);
      yield* sql`UPDATE projection_threads SET model_selection_json=${JSON.stringify({ instanceId: "codex_fixture", model: "fixture" })}`;
      const current = yield* service.prepare({
        ...message,
        requestJson: message.requestJson.replace('"id":1', '"id":2'),
      });
      if (current.kind !== "consent") throw new Error("Expected fixture consent.");
      yield* service.resolve({ ...current, decision: "approve" });
      assert.equal(dispatched.length, 1);
      assert.deepStrictEqual(dispatched[0]!.type, "thread.turn.start");
      assert.match(JSON.stringify(dispatched[0]), /codex_fixture/);
    }),
  );
});
