import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { PROVIDER_PIPELINE_POLICY, utf8ByteLength } from "./providerPipelinePolicy.ts";
import { compactProviderRuntimeEvent } from "./providerRuntimeEventCompaction.ts";

function commandEvent(output: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make("event-large-command"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-large-command"),
    createdAt: "2026-07-16T00:00:00.000Z",
    type: "item.completed",
    payload: {
      itemType: "command_execution",
      status: "completed",
      data: { command: "printf hello", aggregatedOutput: output },
    },
    raw: {
      source: "codex.app-server.notification",
      payload: { item: { result: { stdout: output } } },
    },
  };
}

describe("compactProviderRuntimeEvent", () => {
  it("keeps small events byte-for-byte unchanged", () => {
    const event = commandEvent("ok");
    const result = compactProviderRuntimeEvent(event);
    expect(result.event).toBe(event);
    expect(result.stats.compacted).toBe(false);
  });

  it("bounds multi-megabyte nested command output and preserves identity", () => {
    const event = commandEvent("🙂".repeat(1_100_000));
    const result = compactProviderRuntimeEvent(event);
    const encoded = JSON.stringify(result.event);

    expect(result.stats.compacted).toBe(true);
    expect(utf8ByteLength(encoded)).toBeLessThanOrEqual(
      PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
    );
    expect(result.event.eventId).toBe(event.eventId);
    expect(result.event.threadId).toBe(event.threadId);
    expect(result.event.type).toBe("item.completed");
    expect(result.event.compaction?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(encoded).not.toContain("🙂".repeat(10_000));
  });

  it("does not split a surrogate pair at preview boundaries", () => {
    const event = commandEvent(`${"x".repeat(300_000)}\ud83d\ude42`);
    const result = compactProviderRuntimeEvent(event);
    expect(JSON.stringify(result.event)).not.toContain("�");
  });
});
