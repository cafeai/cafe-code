import { describe, expect, it, vi } from "vitest";
import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import {
  claimVisualizationNativeItem,
  ClaudeVisualizationCompletionObserver,
  redactVisualizationReceiptProofs,
  readVisualizationClaudeParent,
} from "./nativePrivacy.ts";
import { computeGeneratedVisualizationInputSha256 } from "./store.ts";
import type { VisualizationSessionBinding } from "./sessionRuntime.ts";
import type { GeneratedVisualizationNativeWitness } from "@cafecode/contracts/visualizationApi";

const server = "cafe-visualizations-AAAAAAAAAAAAAAAAAAAAAA";
const generation = VisualizationGenerationId.make("00000000-0000-4000-8000-000000000001");
const input = {
  version: 1,
  purpose: "generated-visualization",
  requestId: "00000000-0000-4000-8000-000000000002",
  source: "<div>PRIVATE SOURCE</div>",
  title: "Fixture",
  assets: [],
  appearance: "auto",
};
const witness = {
  provider: "codex" as const,
  threadId: ThreadId.make("chat"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  nativeThreadId: "native",
  nativeTurnId: "turn",
  nativeItemId: "item",
  actor: { type: "root" as const },
  messageId: MessageId.make("message"),
  turnId: TurnId.make("turn"),
  occurredAt: "2026-10-12T00:00:00.000Z",
};
const receipt = () => ({
  version: 1,
  purpose: "cafe-visualization-receipt",
  toolName: "publish_visualization",
  proof: "a".repeat(64),
  inputSha256: computeGeneratedVisualizationInputSha256(input),
  sessionGeneration: generation,
  serverName: server,
});
const binding = () =>
  ({
    name: server,
    authority: {
      threadId: witness.threadId,
      providerInstanceId: witness.providerInstanceId,
      sessionGeneration: generation,
      runtimeGeneration: generation,
      tokenDigest: "b".repeat(64),
      serverName: server,
    },
    launch: { command: "fixture", args: [], env: {} },
    activate: async () => {},
    dispose: async () => {},
    claimNativeCompletion: vi.fn(
      async (_witness: GeneratedVisualizationNativeWitness, _proof: string) => undefined,
    ),
  }) satisfies VisualizationSessionBinding;
describe("visualization tool activity and native attribution", () => {
  it("refuses malformed/accessor/inherited Claude parents without primary fallback", () => {
    for (const parent of ["", 5, {}, " child "])
      expect(readVisualizationClaudeParent({ parent_tool_use_id: parent })).toBeUndefined();
    const getter = vi.fn(() => null);
    const accessor = Object.defineProperty({}, "parent_tool_use_id", { get: getter });
    expect(readVisualizationClaudeParent(accessor)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(
      readVisualizationClaudeParent(Object.create({ parent_tool_use_id: null })),
    ).toBeUndefined();
    expect(
      readVisualizationClaudeParent({ parent_tool_use_id: null, agent_id: "child" }),
    ).toBeUndefined();
    expect(readVisualizationClaudeParent({ parent_tool_use_id: null })).toEqual({ type: "root" });
    expect(readVisualizationClaudeParent({ parent_tool_use_id: "child" })).toEqual({
      type: "child",
      id: "child",
    });
  });
  it.each([
    { server },
    { server: "external", mcpAppUi: { resourceUri: "ui://chart" } },
    { server: "external", mcpAppResourceUri: "ui://legacy-chart" },
    {
      server: "connected-app",
      appContext: { connectorId: "drive", appName: "Drive", actionName: "Search" },
    },
  ])("preserves tool identity, source, input, output and errors (%j)", (metadata) => {
    const item = {
      id: "item",
      type: "mcpToolCall",
      tool: "search",
      arguments: { query: "quarterly report", source: input.source },
      result: { content: [{ type: "text", text: "Actual tool result" }] },
      error: { message: "Actual tool error" },
      status: "failed",
      durationMs: 42,
      ...metadata,
    };
    const original = { thread: { turns: [{ items: [item] }] } };
    expect(redactVisualizationReceiptProofs(original)).toBe(original);
  });

  it("omits only the internal proof from structured and JSON-text publisher receipts", () => {
    const originalReceipt = receipt();
    const result = {
      structuredContent: { visualizationReceipt: originalReceipt },
      content: [{ type: "text", text: JSON.stringify(originalReceipt) }],
    };
    const original = {
      turns: [
        {
          items: [
            {
              id: "item",
              type: "mcpToolCall",
              server,
              tool: "publish_visualization",
              arguments: input,
              result,
              status: "completed",
            },
          ],
        },
      ],
    };
    const safe = redactVisualizationReceiptProofs(original);
    const item = safe.turns[0]!.items[0]!;
    expect(item.server).toBe(server);
    expect(item.tool).toBe("publish_visualization");
    expect(item.arguments).toBe(input);
    expect(item.result.structuredContent.visualizationReceipt).toEqual({
      version: 1,
      purpose: "cafe-visualization-receipt",
      toolName: "publish_visualization",
      inputSha256: computeGeneratedVisualizationInputSha256(input),
      sessionGeneration: generation,
      serverName: server,
    });
    expect(JSON.parse(item.result.content[0]!.text)).toEqual(
      item.result.structuredContent.visualizationReceipt,
    );
    expect(JSON.stringify(safe)).not.toContain(originalReceipt.proof);
    expect(originalReceipt.proof).toBe("a".repeat(64));
    expect(result.content[0]!.text).toContain(originalReceipt.proof);
  });

  it.each([null, "child", "", false, { source: "unclassified parent" }])(
    "preserves Claude visualization inputs, partial JSON and ordinary results for parent %j",
    (parent) => {
      const tool = {
        type: "tool_use",
        id: "same-id",
        name: `mcp__${server}__publish_visualization`,
        input,
      };
      const frames = [
        { type: "assistant", parent_tool_use_id: parent, message: { content: [tool] } },
        {
          type: "stream_event",
          parent_tool_use_id: parent,
          event: { type: "content_block_start", index: 1, content_block: tool },
        },
        {
          type: "stream_event",
          parent_tool_use_id: parent,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          },
        },
        {
          type: "user",
          parent_tool_use_id: parent,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "same-id",
                content: "Actual tool result",
                is_error: true,
              },
            ],
          },
        },
      ];
      for (const frame of frames) expect(redactVisualizationReceiptProofs(frame)).toBe(frame);
    },
  );

  it.each([null, "child"])(
    "omits Claude receipt proofs without hiding tool results (%j)",
    (parent) => {
      const originalReceipt = receipt();
      for (const content of [
        JSON.stringify(originalReceipt),
        [{ type: "text", text: JSON.stringify(originalReceipt) }],
      ]) {
        const original = {
          type: "user",
          parent_tool_use_id: parent,
          message: {
            content: [{ type: "tool_result", tool_use_id: "item", content, is_error: false }],
          },
        };
        const safe = redactVisualizationReceiptProofs(original);
        expect(safe.message.content[0]).toMatchObject({
          type: "tool_result",
          tool_use_id: "item",
          is_error: false,
        });
        const serialized = JSON.stringify(safe);
        expect(serialized).not.toContain(originalReceipt.proof);
        expect(serialized).toContain("cafe-visualization-receipt");
        expect(serialized).toContain("publish_visualization");
        expect(JSON.stringify(original)).toContain(originalReceipt.proof);
      }
    },
  );

  it("leaves ordinary proof fields and JSON formatting unchanged", () => {
    const original = {
      proof: "A user-visible proof",
      content: '{ "proof": "ordinary", "purpose": "other" }',
      nearMatches: [
        { ...receipt(), purpose: "ordinary" },
        { ...receipt(), toolName: "other" },
        { ...receipt(), version: 2 },
      ],
    };
    expect(redactVisualizationReceiptProofs(original)).toBe(original);
  });

  it("does not allocate or traverse an unbounded received array", () => {
    expect(redactVisualizationReceiptProofs(Array.from({ length: 50_001 }, () => "output"))).toBe(
      "[Tool payload exceeds inspection bounds]",
    );
  });

  it("bounds cycles and omits malformed proof values without copying their contents", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JSON.stringify(redactVisualizationReceiptProofs(cyclic))).toContain(
      "[Tool payload exceeds inspection bounds]",
    );
    const original = { ...receipt(), proof: { secret: "internal proof value" } };
    expect(JSON.stringify(redactVisualizationReceiptProofs(original))).not.toContain(
      "internal proof value",
    );
  });

  it("keeps received prototype keys inert when copying a receipt", () => {
    const original = JSON.parse(`{"__proto__":{"receipt":${JSON.stringify(receipt())}}}`);
    const safe = redactVisualizationReceiptProofs(original);
    expect(Object.getPrototypeOf(safe)).toBe(null);
    expect(Object.hasOwn(safe, "__proto__")).toBe(true);
    expect(JSON.stringify(safe)).not.toContain(receipt().proof);
    expect(JSON.stringify(original)).toContain(receipt().proof);
  });
  it("does not grant authority to receipts from wrong native tool/server/status/input/generation", async () => {
    const owner = binding();
    const item = {
      id: "item",
      type: "mcpToolCall",
      server,
      tool: "publish_visualization",
      arguments: input,
      result: { structuredContent: { visualizationReceipt: receipt() } },
      status: "completed",
    };
    for (const changed of [
      redactVisualizationReceiptProofs(item),
      { ...item, server: "foreign" },
      { ...item, status: "failed" },
      { ...item, id: "sibling" },
      { ...item, arguments: { ...input, source: "changed" } },
      {
        ...item,
        result: {
          structuredContent: {
            visualizationReceipt: { ...receipt(), sessionGeneration: "foreign" },
          },
        },
      },
    ])
      await claimVisualizationNativeItem(owner, changed, witness);
    expect(owner.claimNativeCompletion).not.toHaveBeenCalled();
    await claimVisualizationNativeItem(owner, item, witness);
    expect(owner.claimNativeCompletion).toHaveBeenCalledOnce();
    expect(owner.claimNativeCompletion.mock.calls[0]![0]).toMatchObject({
      nativeThreadId: "native",
      nativeItemId: "item",
      serverName: server,
      inputSha256: computeGeneratedVisualizationInputSha256(input),
    });
  });
  it("does not join Claude child/root results or receipt-selected tool identity", async () => {
    const owner = binding();
    const observer = new ClaudeVisualizationCompletionObserver();
    const claude = { ...witness, provider: "claudeAgent" as const };
    await observer.observe(
      owner,
      {
        type: "assistant",
        parent_tool_use_id: "child",
        message: {
          content: [
            { type: "tool_use", id: "item", name: `mcp__${server}__publish_visualization`, input },
          ],
        },
      },
      claude,
    );
    await observer.observe(
      owner,
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "item", content: JSON.stringify(receipt()) },
          ],
        },
      },
      claude,
    );
    expect(owner.claimNativeCompletion).not.toHaveBeenCalled();
    await observer.observe(
      owner,
      {
        type: "user",
        parent_tool_use_id: "child",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "item", content: JSON.stringify(receipt()) },
          ],
        },
      },
      claude,
    );
    expect(owner.claimNativeCompletion).toHaveBeenCalledOnce();
  });
  it("never revives a conflicting or consumed Claude native call", async () => {
    const owner = binding();
    const observer = new ClaudeVisualizationCompletionObserver();
    const claude = { ...witness, provider: "claudeAgent" as const };
    const use = (value: unknown) => ({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "item",
            name: `mcp__${server}__publish_visualization`,
            input: value,
          },
        ],
      },
    });
    const result = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "item", content: JSON.stringify(receipt()) }],
      },
    };
    await observer.observe(owner, use(input), claude);
    await observer.observe(owner, use({ ...input, source: "conflict" }), claude);
    await observer.observe(owner, use(input), claude);
    await observer.observe(owner, result, claude);
    expect(owner.claimNativeCompletion).not.toHaveBeenCalled();
    const fresh = new ClaudeVisualizationCompletionObserver();
    await fresh.observe(owner, use(input), claude);
    await fresh.observe(owner, result, claude);
    await fresh.observe(owner, use(input), claude);
    await fresh.observe(owner, result, claude);
    expect(owner.claimNativeCompletion).toHaveBeenCalledOnce();
  });
});
