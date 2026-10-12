import { describe, expect, it, vi } from "vitest";
import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import {
  claimVisualizationNativeItem,
  ClaudeVisualizationCompletionObserver,
  redactVisualizationNativePayload,
  readVisualizationClaudeParent,
  VisualizationNativePrivacy,
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
describe("native visualization privacy and attribution", () => {
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
  it("admits indexes before serializing native stream correlation keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const privacy = new VisualizationNativePrivacy();
    expect(() =>
      privacy.redact({
        type: "content_block_start",
        index: cyclic,
        content_block: {
          type: "tool_use",
          id: "tool",
          name: `mcp__${server}__publish_visualization`,
          input,
        },
      }),
    ).not.toThrow();
    expect(
      JSON.stringify(
        privacy.redact({
          type: "content_block_delta",
          index: cyclic,
          delta: { partial_json: "PRIVATE SOURCE" },
        }),
      ),
    ).not.toContain("PRIVATE SOURCE");
  });
  it("removes source/result/proof/descriptor before ordinary snapshot projection", () => {
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
              result: { structuredContent: { visualizationReceipt: receipt() } },
              status: "completed",
            },
            {
              id: "app",
              type: "mcpToolCall",
              server: "external",
              mcpAppUi: { resourceUri: "ui://PRIVATE" },
              arguments: { secret: "PRIVATE" },
              result: { content: [{ text: "PRIVATE" }] },
            },
          ],
        },
      ],
    };
    const safe = redactVisualizationNativePayload(original);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE");
    expect(JSON.stringify(safe)).not.toContain("proof");
    expect(original.turns[0]!.items[0]!.arguments).toEqual(input);
  });
  it("redacts Claude partial input and exactly correlated tool result", () => {
    const privacy = new VisualizationNativePrivacy();
    expect(
      JSON.stringify(
        privacy.redact({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool",
            name: `mcp__${server}__publish_visualization`,
            input,
          },
        }),
      ),
    ).not.toContain("PRIVATE");
    expect(
      JSON.stringify(
        privacy.redact({
          type: "content_block_delta",
          index: 1,
          delta: { partial_json: "PRIVATE" },
        }),
      ),
    ).not.toContain("PRIVATE");
    expect(
      JSON.stringify(
        privacy.redact({ type: "tool_result", tool_use_id: "tool", content: "PRIVATE" }),
      ),
    ).not.toContain("PRIVATE");
    expect(
      privacy.redact({ type: "tool_result", tool_use_id: "ordinary", content: "ordinary" }),
    ).toEqual({ type: "tool_result", tool_use_id: "ordinary", content: "ordinary" });
  });
  it("binds Claude private stream indexes and result IDs to their exact parent", () => {
    const privacy = new VisualizationNativePrivacy();
    const start = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "same-id",
          name: `mcp__${server}__publish_visualization`,
          input,
        },
      },
    };
    privacy.redact(start);
    privacy.redact({
      type: "stream_event",
      parent_tool_use_id: "child",
      event: { type: "content_block_stop", index: 1 },
    });
    expect(
      JSON.stringify(
        privacy.redact({
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: "PRIVATE ROOT SOURCE" },
          },
        }),
      ),
    ).not.toContain("PRIVATE ROOT");
    const child = {
      type: "stream_event",
      parent_tool_use_id: "child",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "ordinary child" },
      },
    };
    expect(privacy.redact(child)).toEqual(child);
    expect(
      privacy.redact({
        parent_tool_use_id: "child",
        type: "tool_result",
        tool_use_id: "same-id",
        content: "ordinary child",
      }),
    ).toMatchObject({ content: "ordinary child" });
    expect(
      JSON.stringify(
        privacy.redact({
          parent_tool_use_id: null,
          type: "tool_result",
          tool_use_id: "same-id",
          content: "PRIVATE RESULT",
        }),
      ),
    ).not.toContain("PRIVATE RESULT");
  });
  it("does not allocate or traverse an unbounded received array", () => {
    expect(redactVisualizationNativePayload(Array.from({ length: 50_001 }, () => "private"))).toBe(
      "[Private visualization payload omitted]",
    );
    expect(
      new VisualizationNativePrivacy().redact(Array.from({ length: 50_001 }, () => "private")),
    ).toBe("[Private visualization payload omitted]");
  });
  it.each(["", false, { source: "PRIVATE PARENT" }])(
    "keeps malformed-parent results private without suppressing later ordinary output (%j)",
    (parent) => {
      const privacy = new VisualizationNativePrivacy();
      expect(
        JSON.stringify(
          privacy.redact({
            type: "user",
            parent_tool_use_id: parent,
            message: {
              content: [
                { type: "tool_result", tool_use_id: "ordinary", content: "PRIVATE RESULT" },
              ],
            },
          }),
        ),
      ).not.toContain("PRIVATE RESULT");
      const valid = {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_result", tool_use_id: "ordinary", content: "Owned output" }],
        },
      };
      expect(privacy.redact(valid)).toEqual(valid);

      // A genuinely private tool without a correlatable parent still requires
      // sticky fail-closed result masking; local invalidity is not a bypass.
      privacy.redact({
        parent_tool_use_id: parent,
        type: "tool_use",
        id: "private",
        name: `mcp__${server}__publish_visualization`,
        input,
      });
      expect(
        JSON.stringify(
          privacy.redact({
            type: "tool_result",
            tool_use_id: "private",
            content: "PRIVATE RESULT",
          }),
        ),
      ).not.toContain("PRIVATE RESULT");
    },
  );
  it("never copies malformed native identity/status/index objects through a redaction", () => {
    const privateObject = { source: "PRIVATE HTML" };
    expect(
      JSON.stringify(
        redactVisualizationNativePayload({
          type: "mcpToolCall",
          server,
          id: privateObject,
          status: privateObject,
          arguments: input,
        }),
      ),
    ).not.toContain("PRIVATE");
    const privacy = new VisualizationNativePrivacy();
    privacy.redact({
      type: "tool_use",
      name: `mcp__${server}__publish_visualization`,
      id: privateObject,
      input,
    });
    expect(
      JSON.stringify(
        privacy.redact({ type: "tool_result", tool_use_id: privateObject, content: "PRIVATE" }),
      ),
    ).not.toContain("PRIVATE");
    expect(
      JSON.stringify(
        privacy.redact({
          type: "content_block_delta",
          index: privateObject,
          delta: { partial_json: "PRIVATE" },
        }),
      ),
    ).not.toContain("PRIVATE");
    const proto = JSON.parse(
      '{"__proto__":{"payload":{"type":"mcpToolCall","server":"cafe-visualizations-AAAAAAAAAAAAAAAAAAAAAA","arguments":{"source":"PRIVATE"}}}}',
    );
    const safe = redactVisualizationNativePayload(proto);
    expect(Object.getPrototypeOf(safe)).toBe(null);
    expect(Object.hasOwn(safe, "__proto__")).toBe(true);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE");
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
