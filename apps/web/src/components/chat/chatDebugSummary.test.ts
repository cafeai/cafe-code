import { describe, expect, it } from "vitest";
import {
  MessageId,
  EventId,
  ProviderDriverKind,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import {
  countBy,
  summarizeDebugMessage,
  summarizeDebugActivity,
  summarizeDebugSession,
  readDebugRecord,
} from "./chatDebugSummary";

describe("chat diagnostic projections", () => {
  it("reports runtime evidence without exposing its correlation key or worker content", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("subagent-event"),
      kind: "task.progress",
      tone: "info",
      summary: "PRIVATE_LABEL",
      turnId: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      payload: {
        taskId: "PRIVATE_TASK",
        subagent: {
          threadId: "PRIVATE_CHILD",
          runtimeId: "PRIVATE_RUNTIME",
          historyId: "PRIVATE_HISTORY",
          status: "active",
          label: "PRIVATE_LABEL",
          objective: "PRIVATE_OBJECTIVE",
        },
      },
    };
    const summary = summarizeDebugActivity(activity);
    expect(JSON.parse(summary.payloadPreview)).toEqual({
      status: "active",
      hasRuntimeEvidence: true,
      hasHistoryBinding: true,
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_");
    const session = {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      orchestrationStatus: "running" as const,
      createdAt: activity.createdAt,
      updatedAt: activity.createdAt,
      subagentRuntimeId: "PRIVATE_RUNTIME",
    };
    expect(summarizeDebugSession(session)?.hasSubagentRuntimeEvidence).toBe(true);
    expect(JSON.stringify(summarizeDebugSession(session))).not.toContain("PRIVATE_RUNTIME");
    expect(
      summarizeDebugSession({ ...session, subagentRuntimeId: undefined })
        ?.hasSubagentRuntimeEvidence,
    ).toBe(false);
    expect(
      summarizeDebugSession({ ...session, subagentRuntimeId: null })?.hasSubagentRuntimeEvidence,
    ).toBe(false);
    expect(summarizeDebugSession(null)).toBeNull();
  });

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

  it("reports only bounded counts for inline questions, not titles or suggestions", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("question-event"),
      kind: "provider.async-questions",
      tone: "info",
      summary: "PRIVATE_QUESTION",
      turnId: null,
      createdAt: "2026-09-10T00:00:00.000Z",
      payload: {
        PRIVATE_KEY: "PRIVATE_VALUE",
        itemId: "PRIVATE_ITEM",
        questions: Array.from({ length: 20 }, () => ({
          title: "PRIVATE_QUESTION",
          options: Array.from({ length: 40 }, () => "PRIVATE_SUGGESTION"),
        })),
      },
    };
    const summary = summarizeDebugActivity(activity);
    expect(JSON.parse(summary.payloadPreview)).toEqual({ questionCount: 16, optionCount: 512 });
    expect(summary.payloadKeys).toEqual(["optionCount", "questionCount"]);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_");
    expect(summarizeDebugActivity({ ...activity, payload: null }).payloadPreview).toBe(
      '{"questionCount":0,"optionCount":0}',
    );
  });
});
