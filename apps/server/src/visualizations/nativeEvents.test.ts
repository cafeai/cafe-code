import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@cafecode/contracts";
import { redactArchivedToolEvent } from "../provider/Layers/CodexAdapter.ts";
import { sanitizeCodexProtocolDiagnosticPayload } from "../provider/Layers/CodexSessionRuntime.ts";

describe("private visualization native diagnostic boundary", () => {
  it("withholds unattributable MCP progress text before normal event mapping", () => {
    const received = {
      method: "item/mcpToolCall/progress",
      payload: { itemId: "item", threadId: "native", turnId: "turn", message: "PRIVATE SOURCE" },
      message: "PRIVATE SOURCE",
      textDelta: "PRIVATE SOURCE",
    } as ProviderEvent;
    const safe = redactArchivedToolEvent(received);
    expect(safe.payload).toEqual({
      itemId: "item",
      threadId: "native",
      turnId: "turn",
      message: "MCP operation is running.",
    });
    expect(JSON.stringify(safe)).not.toContain("PRIVATE");
    expect(received.message).toBe("PRIVATE SOURCE");
  });
  it("withholds outbound wire/turn context and incoming methodless/private progress", () => {
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
        payload: { method: "item/mcpToolCall/progress", params: { message: "PRIVATE HTML" } },
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
