import { EventId, TurnId, type OrchestrationThreadActivity } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";

// An isolated synthetic translation makes the presentation/canonical split
// observable without tying these provenance assertions to a specific catalog.
vi.mock("@cafecode/shared/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cafecode/shared/i18n")>();
  return {
    ...actual,
    uiText: (...args: Parameters<typeof actual.uiText>) => `translated:${actual.uiText(...args)}`,
  };
});

import { cafeWorkLogDisplayLabel } from "./workLogPresentation";
import {
  deriveSubagentWorkEntries,
  deriveWorkLogEntries,
  workLogDisplayLabel,
  workLogDisplayToolTitle,
} from "./session-logic";
import {
  deriveSubagentActivities,
  subagentDisplayLabel,
  subagentDisplayDescription,
} from "./subagent-activity";

function activity(
  kind: string,
  summary: string,
  payload: Record<string, unknown> = {},
  sequence = 1,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`i18n-work-${sequence}`),
    turnId: TurnId.make("i18n-work-turn"),
    kind,
    summary,
    payload,
    sequence,
    tone: "tool",
    createdAt: `2026-10-11T00:00:0${sequence}.000Z`,
  };
}

describe("work-log presentation localization boundary", () => {
  it.each([
    ["provider.turn.steer.delivery-attempted", "Steer delivery attempted"],
    ["provider.turn.steer.accepted", "Steer accepted"],
  ])("renders fixed public %s without touching private summaries or payloads", (kind, label) => {
    let reads = 0;
    const privatePayload = Object.defineProperty({}, "detail", {
      get() {
        reads += 1;
        throw new Error("private payload must not be inspected");
      },
    });
    const receipt = activity(kind, "private prompt and correlation data", privatePayload);
    const [row] = deriveWorkLogEntries([receipt], undefined);
    expect(row).toMatchObject({ label, displayLabel: `translated:${label}`, tone: "info" });
    expect(row?.detail).toBeUndefined();
    expect(row?.toolTitle).toBeUndefined();
    expect(row?.command).toBeUndefined();
    expect(row?.changedFiles).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("private prompt");
    expect(reads).toBe(0);
    expect(receipt.summary).toBe("private prompt and correlation data");
  });

  it("names Codex's exact HTTPS fallback warning and keeps its received text as detail", () => {
    const message =
      "Falling back from WebSockets to HTTPS transport. stream disconnected before completion";
    expect(
      cafeWorkLogDisplayLabel(activity("runtime.warning", "Runtime warning", { message })),
    ).toBe("translated:Switched to HTTPS (WebSocket unavailable)");
    expect(
      cafeWorkLogDisplayLabel(
        activity("runtime.warning", "Runtime warning", { message: `Note: ${message}` }),
      ),
    ).toBe("translated:Runtime warning");
    const [row] = deriveWorkLogEntries(
      [activity("runtime.warning", "Runtime warning", { message })],
      undefined,
    );
    expect(row?.detail).toBe(message);
  });

  it("localizes only an exact Cafe envelope, never arbitrary summaries or provider ICU", () => {
    expect(cafeWorkLogDisplayLabel(activity("approval.resolved", "Approval resolved"))).toBe(
      "translated:Approval resolved",
    );
    expect(
      cafeWorkLogDisplayLabel(activity("provider.native", "Approval resolved")),
    ).toBeUndefined();
    expect(
      cafeWorkLogDisplayLabel(activity("runtime.warning", "{secret, plural, one {private}}")),
    ).toBeUndefined();
    const opaque = activity("task.progress", "Reasoning update", {
      summary: "{private} <b>provider's text</b>",
    });
    expect(workLogDisplayLabel(deriveWorkLogEntries([opaque], undefined)[0]!)).toBe(
      "{private} <b>provider's text</b>",
    );
  });

  it("preserves the active compaction phase separately from its translated summary", () => {
    const [row] = deriveWorkLogEntries(
      [
        activity("tool.started", "Context compaction started", {
          itemType: "context_compaction",
          itemId: "exact-item",
        }),
      ],
      undefined,
    );
    expect(row).toMatchObject({
      label: "Context compaction started",
      toolTitle: "Compacting context",
    });
    expect(workLogDisplayLabel(row!)).toBe("translated:Context compaction started");
    expect(workLogDisplayToolTitle(row!)).toBe("translated:Compacting context");
  });

  it("preserves canonical labels while rendering the translated folded compaction outcome", () => {
    const rows = deriveWorkLogEntries(
      [
        activity(
          "tool.started",
          "Context compaction started",
          { itemType: "context_compaction", itemId: "exact-item" },
          1,
        ),
        activity(
          "tool.completed",
          "Context compacted",
          { itemType: "context_compaction", itemId: "exact-item", status: "completed" },
          2,
        ),
      ],
      undefined,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Context compacted", toolTitle: "Context compacted" });
    expect(workLogDisplayLabel(rows[0]!)).toBe("translated:Context compacted");
    expect(workLogDisplayToolTitle(rows[0]!)).toBe("translated:Context compacted");
  });

  it("does not carry a translated generic start over an opaque native completion", () => {
    const rows = deriveWorkLogEntries(
      [
        activity(
          "tool.started",
          "Tool started",
          { itemType: "command_execution", itemId: "command", title: "" },
          1,
        ),
        activity(
          "tool.completed",
          "{provider} result",
          { itemType: "command_execution", itemId: "command", title: "{provider} result" },
          2,
        ),
      ],
      undefined,
    );
    const completion = rows.at(-1)!;
    expect(workLogDisplayLabel(completion)).toBe("{provider} result");
    expect(workLogDisplayToolTitle(completion)).toBe("{provider} result");
  });

  it("tracks the generic subagent fallback without translating an identical received name", () => {
    const fallback = activity("task.started", "Subagent started", {
      taskId: "child",
      subagent: { threadId: "child", status: "active" },
    });
    const [generic] = deriveSubagentActivities([fallback]);
    expect(generic?.label).toBe("Subagent");
    expect(subagentDisplayLabel(generic!)).toBe("translated:Subagent");
    expect(workLogDisplayLabel(deriveSubagentWorkEntries([fallback], undefined)[0]!)).toBe(
      "translated:Subagent",
    );
    const named = activity(
      "task.progress",
      "Subagent update",
      { taskId: "child", subagent: { threadId: "child", status: "active", label: "Subagent" } },
      2,
    );
    const [received] = deriveSubagentActivities([fallback, named]);
    expect(received?.label).toBe("Subagent");
    expect(received?.displayLabel).toBeUndefined();
    expect(subagentDisplayLabel(received!)).toBe("Subagent");
  });

  it("keeps native title parameters inert in Cafe-authored lifecycle wrappers", () => {
    const title = "{count, plural, one {hidden}} <script>opaque</script>";
    expect(cafeWorkLogDisplayLabel(activity("tool.started", `${title} started`, { title }))).toBe(
      `translated:${title} started`,
    );
    let calls = 0;
    const payload = Object.defineProperty({}, "title", {
      get: () => {
        calls += 1;
        return title;
      },
    });
    expect(
      cafeWorkLogDisplayLabel(activity("tool.started", "Unknown started", payload)),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("localizes Cafe's legacy progress fallback only after canonical status matching", () => {
    const stopped = activity("tool.completed", "Subagent task", {
      itemType: "collab_agent_tool_call",
      itemId: "legacy",
      detail: "Interrupted /root/child",
    });
    const [legacy] = deriveSubagentActivities([stopped]);
    expect(legacy).toMatchObject({ status: "stopped", description: "Interrupted" });
    expect(subagentDisplayDescription(legacy!)).toBe("translated:Interrupted");
    const received = activity("task.started", "Subagent started", {
      taskId: "native",
      detail: "Interrupted",
      subagent: { threadId: "native", status: "active", label: "Native" },
    });
    const [native] = deriveSubagentActivities([received]);
    expect(native).toMatchObject({ status: "active", description: "Interrupted" });
    expect(native?.displayDescription).toBeUndefined();
  });

  it("uses exact optional switch provenance and leaves old or inconsistent rows opaque", () => {
    const from = "Account {private} from to <b>A</b>";
    const to = "Account 'B' {model}";
    const model = "model/{name}";
    const summary = `Switched from ${from} to ${to} · ${model}`;
    const payload = {
      fromDisplayName: from,
      toDisplayName: to,
      toModel: model,
      fromProvider: "codex",
      toProvider: "claudeAgent",
    };
    const current = activity("provider.switched", summary, payload);
    expect(cafeWorkLogDisplayLabel(current)).toBe(`translated:${summary}`);
    expect(current.summary).toBe(summary);
    expect(current.payload).toEqual(payload);
    expect(
      cafeWorkLogDisplayLabel(activity("provider.switched", summary, { toModel: model })),
    ).toBeUndefined();
    expect(
      cafeWorkLogDisplayLabel(
        activity("provider.switched", summary, { ...payload, toDisplayName: "Different" }),
      ),
    ).toBeUndefined();
    expect(
      cafeWorkLogDisplayLabel(
        activity("provider.switched", `Switched ${to} provider`, {
          fromDisplayName: to,
          toDisplayName: to,
        }),
      ),
    ).toBe(`translated:Switched ${to} provider`);
    const uninspectable = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("fixture");
        },
      },
    );
    expect(
      cafeWorkLogDisplayLabel(activity("provider.switched", summary, uninspectable)),
    ).toBeUndefined();
  });
});
