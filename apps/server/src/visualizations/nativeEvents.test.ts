import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@cafecode/contracts";
import { redactArchivedToolEvent } from "../provider/Layers/CodexAdapter.ts";
import { sanitizeCodexProtocolDiagnosticPayload } from "../provider/Layers/CodexSessionRuntime.ts";

describe("visualization tool activity and protocol diagnostics", () => {
  it("preserves actual MCP progress before normal event mapping and in decoded diagnostics", () => {
    const received = {
      method: "item/mcpToolCall/progress",
      payload: { itemId: "item", threadId: "native", turnId: "turn", message: "Found three files" },
      message: "Found three files",
      textDelta: "Found three files",
    } as ProviderEvent;
    expect(redactArchivedToolEvent(received)).toBe(received);
    const wire = { method: received.method, params: received.payload };
    expect(
      sanitizeCodexProtocolDiagnosticPayload({
        direction: "incoming",
        stage: "decoded",
        payload: wire,
      }),
    ).toBe(wire);
  });
  it("preserves connected-app tool details in nested history and decoded diagnostics", () => {
    const item = {
      type: "mcpToolCall",
      id: "search",
      server: "drive",
      tool: "search",
      appContext: { connectorId: "drive", appName: "Drive", actionName: "Search" },
      arguments: { query: "quarterly report" },
      result: { content: [{ type: "text", text: "Found the report" }] },
      error: { message: "Actual tool error" },
      status: "failed",
    };
    for (const payload of [{ item }, { thread: { turns: [{ items: [item] }] } }]) {
      const event = { method: "item/completed", payload } as ProviderEvent;
      expect(redactArchivedToolEvent(event)).toBe(event);
      const wire = { method: event.method, params: payload };
      expect(
        sanitizeCodexProtocolDiagnosticPayload({
          direction: "incoming",
          stage: "decoded",
          payload: wire,
        }),
      ).toBe(wire);
    }
  });
  it("retains decoded tool diagnostics while omitting only the internal receipt proof", () => {
    const receipt = {
      version: 1,
      purpose: "cafe-visualization-receipt",
      toolName: "publish_visualization",
      proof: "a".repeat(64),
    };
    const item = {
      type: "mcpToolCall",
      id: "chart",
      server: `cafe-visualizations-${"A".repeat(22)}`,
      tool: "publish_visualization",
      arguments: { source: "<div>Chart source</div>" },
      result: {
        structuredContent: { visualizationReceipt: receipt },
        content: [{ type: "text", text: JSON.stringify(receipt) }],
      },
    };
    for (const method of ["item/completed", "turn/completed"]) {
      const params = method === "item/completed" ? { item } : { turn: { items: [item] } };
      const activity = redactArchivedToolEvent({
        method,
        payload: params,
        message: "Chart published",
        textDelta: "Publication complete",
      } as ProviderEvent);
      expect(activity.message).toBe("Chart published");
      expect(activity.textDelta).toBe("Publication complete");
      expect(JSON.stringify(activity)).not.toContain(receipt.proof);
      const safe = sanitizeCodexProtocolDiagnosticPayload({
        direction: "incoming",
        stage: "decoded",
        payload: { method, params },
      });
      const serialized = JSON.stringify(safe);
      expect(serialized).not.toContain(receipt.proof);
      expect(serialized).toContain(item.server);
      expect(serialized).toContain(item.arguments.source);
      expect(serialized).toContain("publish_visualization");
    }
    expect(item.result.structuredContent.visualizationReceipt.proof).toBe(receipt.proof);
  });
  it("keeps separate outbound wire/turn and unclassified protocol diagnostic filtering", () => {
    const events = [
      { direction: "outgoing", stage: "raw", payload: '{"params":{"input":"PRIVATE CONTEXT"}}' },
      {
        direction: "outgoing",
        stage: "decoded",
        payload: { method: "turn/start", params: { input: "PRIVATE CONTEXT" } },
      },
      {
        direction: "incoming",
        stage: "decoded",
        payload: { id: 1, result: { contents: [{ text: "PRIVATE HTML" }] } },
      },
      {
        direction: "incoming",
        stage: "decode_failed",
        payload: { method: "PRIVATE REJECTED METHOD", cause: { actual: "PRIVATE HTML" } },
      },
    ];
    for (const event of events) {
      const safe = sanitizeCodexProtocolDiagnosticPayload(event);
      expect(JSON.stringify(safe)).not.toContain("PRIVATE");
    }
  });
});
