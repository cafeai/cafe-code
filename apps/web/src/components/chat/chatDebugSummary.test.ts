import { describe, expect, it } from "vitest";
import { MessageId, EventId, type OrchestrationThreadActivity } from "@cafecode/contracts";
import {
  countBy,
  summarizeDebugMessage,
  summarizeDebugActivity,
  readDebugRecord,
} from "./chatDebugSummary";

describe("chat diagnostic projections", () => {
  it("keeps bounded message previews with secrets redacted before truncation", () => {
    const secret = `sk-${"a".repeat(32)}`;
    const text = `${secret} ${"long text ".repeat(100)}`;
    const summary = summarizeDebugMessage({
      id: MessageId.make("message"),
      role: "user",
      text,
      createdAt: "2026-09-06T00:00:00.000Z",
      streaming: false,
    });
    expect(summary.textLength).toBe(text.length);
    expect(summary.textPreview.length).toBeLessThanOrEqual(120);
    expect(summary.textPreview).toContain("sk-[redacted]");
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("survives cyclic diagnostic payloads without expanding them", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("event"),
      kind: "runtime.warning",
      tone: "info",
      summary: "Operational warning",
      turnId: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      payload,
    };
    expect(summarizeDebugActivity(activity).payloadPreview).toBe("[unserializable]");
    expect(readDebugRecord([])).toBeNull();
    expect(readDebugRecord(null)).toBeNull();
  });

  it("counts untrusted prototype-like labels as ordinary keys", () => {
    const result = countBy(["__proto__", "constructor", "__proto__"], (label) => label);
    expect(result["__proto__"]).toBe(2);
    expect(result["constructor"]).toBe(1);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
});
