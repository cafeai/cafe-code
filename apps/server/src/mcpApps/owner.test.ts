import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import * as Effect from "effect/Effect";
import type { CodexSessionRuntimeShape } from "../provider/Layers/CodexSessionRuntime.ts";
import type { VisualizationSessionBinding } from "../visualizations/sessionRuntime.ts";
import {
  dispatchMcpAppOwnerOperation,
  readMcpAppModelContext,
  readMcpAppOwnerDiagnostics,
  registerMcpAppOwner,
  type McpAppOwnerOperation,
} from "./owner.ts";

const observed = vi.hoisted(() => ({ published: [] as unknown[][], current: true }));
vi.mock("../visualizations/service.ts", async () => {
  const E = await import("effect/Effect");
  return {
    readVisualizationArtifactService: () => ({
      run: E.runPromise,
      service: {
        requireActiveSession: () =>
          E.sync(() => {
            if (!observed.current) throw new Error("Synthetic generation revoked.");
          }),
        publishMcpApp: (...args: unknown[]) =>
          E.sync(() => {
            observed.published.push(args);
          }),
      },
    }),
  };
});
const retire: Array<() => void> = [];
const context = (text: string) => ({
  json: JSON.stringify({ content: [{ type: "text", text }] }),
});
afterEach(() => {
  for (const close of retire.splice(0)) close();
  observed.published.length = 0;
});

function fixture() {
  observed.current = true;
  const generation = VisualizationGenerationId.make(randomUUID());
  const authority = {
    threadId: ThreadId.make(`app-${randomUUID()}`),
    providerInstanceId: ProviderInstanceId.make("codex_fixture"),
    sessionGeneration: generation,
    runtimeGeneration: generation,
    tokenDigest: "a".repeat(64),
    serverName: "cafe-visualizations-AAAAAAAAAAAAAAAAAAAAAA",
  };
  const binding: VisualizationSessionBinding = {
    authority,
    name: authority.serverName,
    launch: { command: "synthetic-not-executed", args: [], env: {} },
    activate: vi.fn(),
    dispose: vi.fn(),
    claimNativeCompletion: vi.fn(),
  };
  let catalogueHook: (() => void) | undefined;
  let resourceUri = "ui://owned";
  let source = "<div>PRIVATE APP SOURCE</div>";
  const catalog = vi.fn((nativeThreadId: string, serverName: string) =>
    Effect.sync(() => {
      catalogueHook?.();
      return {
        data: [
          {
            name: serverName,
            tools: {
              act: {
                inputSchema: { type: "object" },
                _meta: { ui: { resourceUri: "ui://owned", visibility: ["app"] } },
              },
            },
          },
        ],
        nativeThreadId,
      };
    }),
  );
  const resource = vi.fn(
    (nativeThreadId: string, serverName: string, originCallId: string, uri: string) =>
      Effect.sync(() => ({
        originCallId,
        contents: [
          { uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: source, _meta: {} },
        ],
        nativeThreadId,
        serverName,
        requestedUri: uri,
      })),
  );
  const tool = vi.fn(
    (_thread: string, _server: string, _name: string, _args: Record<string, unknown>) =>
      Effect.succeed<unknown>({ content: [] }),
  );
  // This peer implements only controlled MCP calls. It has no provider binary,
  // credentials, process scope, real profile or ability to run inference.
  const runtime = { mcpApps: { catalog, resource, tool } } as unknown as CodexSessionRuntimeShape;
  const owner = registerMcpAppOwner(binding, runtime, Effect.runPromise);
  if (!owner) throw new Error("Expected synthetic owner.");
  retire.push(owner.close);
  const witness = {
    provider: "codex" as const,
    threadId: authority.threadId,
    providerInstanceId: authority.providerInstanceId,
    nativeThreadId: "native-root",
    nativeTurnId: "native-turn",
    nativeItemId: "native-call",
    actor: { type: "root" as const },
    messageId: MessageId.make("fixture-message"),
    turnId: TurnId.make("fixture-turn"),
    occurredAt: "2026-10-12T00:00:00.000Z",
  };
  const item = {
    id: witness.nativeItemId,
    type: "mcpToolCall",
    status: "completed",
    server: "fixture-server",
    tool: "act",
    arguments: { count: 1 },
    result: { content: [] },
    error: null,
    mcpAppUi: { resourceUri: "ui://owned" },
  };
  const operation = (
    method: McpAppOwnerOperation["method"],
    params: unknown = {},
    nativeThreadId = witness.nativeThreadId,
  ): McpAppOwnerOperation => ({
    threadId: authority.threadId,
    providerInstanceId: authority.providerInstanceId,
    sessionGeneration: generation,
    nativeThreadId,
    serverName: item.server,
    originCallId: item.id,
    method,
    requestJson: JSON.stringify(params),
  });
  return {
    binding,
    runtime,
    owner,
    witness,
    item,
    operation,
    catalog,
    resource,
    tool,
    setHook: (hook: () => void) => {
      catalogueHook = hook;
    },
    setResourceUri: (uri: string) => {
      resourceUri = uri;
    },
    setSource: (value: string) => {
      source = value;
    },
  };
}

describe("actual adapter-owned MCP App transport", () => {
  it("refuses originals that cannot fit the exact replay envelope before native catalogue or capture work", async () => {
    const peer = fixture();
    let argumentsValue: unknown = 0;
    for (let index = 0; index < 16; index += 1) argumentsValue = { value: argumentsValue };
    await peer.owner.capture({ ...peer.item, arguments: argumentsValue }, peer.witness);
    expect(peer.catalog).not.toHaveBeenCalled();
    expect(peer.resource).not.toHaveBeenCalled();
    expect(observed.published).toHaveLength(0);
    expect(readMcpAppOwnerDiagnostics().localCaptures).toBe(0);
  });
  it("snapshots only bounded own native witness fields without invoking extra or identity accessors", async () => {
    const peer = fixture();
    const extra = vi.fn(() => "PRIVATE EXTRA".repeat(10000));
    const witness = { ...peer.witness };
    Object.defineProperty(witness, "extra", { enumerable: true, get: extra });
    await peer.owner.capture(peer.item, witness);
    expect(extra).not.toHaveBeenCalled();
    expect(observed.published).toHaveLength(1);
    expect(observed.published[0]![2]).not.toHaveProperty("extra");
    const identity = vi.fn(() => "native-root");
    const accessor = { ...peer.witness };
    Object.defineProperty(accessor, "nativeThreadId", { enumerable: true, get: identity });
    await peer.owner.capture(peer.item, accessor);
    await peer.owner.capture(peer.item, { ...peer.witness, nativeThreadId: "x".repeat(201) });
    expect(identity).not.toHaveBeenCalled();
    expect(peer.catalog).toHaveBeenCalledOnce();
    expect(observed.published).toHaveLength(1);
  });

  it("observes bounded captures without waiting on provider event ingestion or retaining mutable originals", async () => {
    const peer = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = peer.catalog.getMockImplementation()!;
    peer.catalog.mockImplementation((...args) =>
      Effect.promise(async () => {
        await gate;
        return Effect.runPromise(original(...args));
      }),
    );
    const input = { count: 1 };
    const item = { ...peer.item, arguments: input };
    expect(peer.owner.observe(item, peer.witness)).toBeUndefined();
    input.count = 99;
    try {
      await vi.waitFor(() => expect(peer.catalog).toHaveBeenCalledOnce());
      expect(observed.published).toHaveLength(0);
      expect(readMcpAppOwnerDiagnostics().localCaptures).toBe(1);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(readMcpAppOwnerDiagnostics().localCaptures).toBe(0));
    expect(observed.published[0]![1]).toMatchObject({ originalInputJson: '{"count":1}' });
  });
  it("bounds process-wide captures to eight and exact-owner work to two with no waiting queue", async () => {
    const peers = Array.from({ length: 5 }, () => fixture());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const peer of peers) {
      const original = peer.catalog.getMockImplementation()!;
      peer.catalog.mockImplementation((...args) =>
        Effect.promise(async () => {
          await gate;
          return Effect.runPromise(original(...args));
        }),
      );
    }
    const before = readMcpAppOwnerDiagnostics().refusedCaptures;
    try {
      for (const peer of peers) {
        peer.owner.observe(peer.item, peer.witness);
        peer.owner.observe(peer.item, peer.witness);
        peer.owner.observe(peer.item, peer.witness);
      }
      expect(readMcpAppOwnerDiagnostics().localCaptures).toBe(8);
      expect(readMcpAppOwnerDiagnostics().refusedCaptures - before).toBe(7);
      await vi.waitFor(() =>
        expect(peers.reduce((total, peer) => total + peer.catalog.mock.calls.length, 0)).toBe(8),
      );
      expect(peers[4]!.catalog).not.toHaveBeenCalled();
    } finally {
      for (const peer of peers) peer.owner.close();
      release();
    }
    await vi.waitFor(() => expect(readMcpAppOwnerDiagnostics().localCaptures).toBe(0));
    expect(observed.published).toHaveLength(0);
  });
  it("captures the exact originating native server/tool/resource and immutable witness", async () => {
    const peer = fixture();
    await peer.owner.capture(peer.item, peer.witness);
    expect(peer.catalog).toHaveBeenCalledWith("native-root", "fixture-server");
    expect(peer.resource).toHaveBeenCalledWith(
      "native-root",
      "fixture-server",
      "native-call",
      "ui://owned",
    );
    expect(observed.published).toHaveLength(1);
    expect(observed.published[0]![0]).toEqual(peer.binding.authority);
    expect(observed.published[0]![1]).toMatchObject({
      source: "<div>PRIVATE APP SOURCE</div>",
      serverName: "fixture-server",
      originCallId: "native-call",
      resourceUri: "ui://owned",
      originalInputJson: '{"count":1}',
    });
    expect(observed.published[0]![2]).toMatchObject({
      nativeItemId: "native-call",
      sessionGeneration: peer.binding.authority.sessionGeneration,
      serverName: "fixture-server",
      toolName: "act",
    });
  });
  it("never falls back from a hosted account or foreign producer witness", async () => {
    const peer = fixture();
    await peer.owner.capture(
      { ...peer.item, appContext: { connectorId: "hosted", linkId: "private-account" } },
      peer.witness,
    );
    await peer.owner.capture(peer.item, { ...peer.witness, threadId: ThreadId.make("foreign") });
    await peer.owner.capture(peer.item, {
      ...peer.witness,
      providerInstanceId: ProviderInstanceId.make("foreign"),
    });
    expect(peer.catalog).not.toHaveBeenCalled();
    expect(observed.published).toHaveLength(0);
  });
  it("refuses swapped resource identity and retirement during catalogue I/O", async () => {
    const peer = fixture();
    peer.setResourceUri("ui://foreign");
    await peer.owner.capture(peer.item, peer.witness);
    expect(observed.published).toHaveLength(0);
    peer.setHook(peer.owner.close);
    await peer.owner.capture(peer.item, peer.witness);
    expect(peer.resource).toHaveBeenCalledTimes(1);
    expect(observed.published).toHaveLength(0);
  });
  it("fences every dispatch to an exact owner generation and never restarts a provider", async () => {
    const peer = fixture();
    await expect(
      dispatchMcpAppOwnerOperation({
        ...peer.operation("catalog"),
        sessionGeneration: randomUUID(),
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      dispatchMcpAppOwnerOperation({ ...peer.operation("catalog"), providerInstanceId: "foreign" }),
    ).rejects.toThrow("unavailable");
    expect(peer.catalog).not.toHaveBeenCalled();
    await dispatchMcpAppOwnerOperation(
      peer.operation("tool", { name: "act", arguments: { count: 1 } }),
    );
    expect(peer.tool).toHaveBeenCalledWith("native-root", "fixture-server", "act", { count: 1 });
    peer.owner.close();
    await expect(dispatchMcpAppOwnerOperation(peer.operation("catalog"))).rejects.toThrow(
      "unavailable",
    );
  });
  it("keeps replace-only bounded child model context out of the root", async () => {
    const peer = fixture();
    await dispatchMcpAppOwnerOperation(
      peer.operation("context", context("child1"), "native-child"),
    );
    expect(
      await readMcpAppModelContext(
        peer.binding.authority.threadId,
        peer.binding.name,
        "native-root",
      ),
    ).toBeUndefined();
    await dispatchMcpAppOwnerOperation(
      peer.operation("context", context("child2"), "native-child"),
    );
    expect(
      await readMcpAppModelContext(
        peer.binding.authority.threadId,
        peer.binding.name,
        "native-child",
      ),
    ).toContain("child2");
    expect(peer.tool).not.toHaveBeenCalled();
    await expect(
      dispatchMcpAppOwnerOperation(peer.operation("context", context("x".repeat(16 * 1024)))),
    ).rejects.toThrow("unavailable");
    peer.owner.close();
    expect(
      await readMcpAppModelContext(
        peer.binding.authority.threadId,
        peer.binding.name,
        "native-child",
      ),
    ).toBeUndefined();
  });
  it("rejects an oversized native result rather than amplify it through the App RPC envelope", async () => {
    const peer = fixture();
    peer.tool.mockImplementation(() =>
      Effect.succeed({ content: [{ type: "text", text: "x".repeat(128 * 1024) }] }),
    );
    await expect(
      dispatchMcpAppOwnerOperation(peer.operation("tool", { name: "act", arguments: {} })),
    ).rejects.toThrow("unavailable");
    expect(peer.tool).toHaveBeenCalledOnce();
  });
  it("does not install a success-shaped owner without native Apps transport", () => {
    const peer = fixture();
    peer.owner.close();
    expect(
      registerMcpAppOwner(peer.binding, {} as CodexSessionRuntimeShape, Effect.runPromise),
    ).toBeUndefined();
  });
  it("refuses a revoked activated generation even while its runtime remains registered", async () => {
    const peer = fixture();
    await dispatchMcpAppOwnerOperation(peer.operation("context", { json: '{"content":[]}' }));
    observed.current = false;
    expect(
      await readMcpAppModelContext(
        peer.binding.authority.threadId,
        peer.binding.name,
        "native-root",
      ),
    ).toBeUndefined();
    await expect(
      dispatchMcpAppOwnerOperation(peer.operation("tool", { name: "act", arguments: {} })),
    ).rejects.toThrow("unavailable");
    expect(peer.tool).not.toHaveBeenCalled();
    await peer.owner.capture(peer.item, peer.witness);
    expect(peer.resource).not.toHaveBeenCalled();
    expect(observed.published).toHaveLength(0);
  });
});
