import {
  attachProviderDaemonRuntimeEventCursor,
  readProviderDaemonRuntimeEventCursor,
  rewindProviderDaemonCursorForReplay,
} from "./ProviderDaemonRuntimeCursor.ts";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

function runtimeEvent(): ProviderRuntimeEvent {
  return {
    type: "runtime.warning",
    eventId: EventId.make("event-cursor-test"),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-cursor-test"),
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      message: "warning",
    },
  };
}

describe("ProviderDaemonRuntimeCursor", () => {
  it("attaches a non-enumerable provider daemon cursor to runtime events", () => {
    const withCursor = attachProviderDaemonRuntimeEventCursor(runtimeEvent(), 42);

    expect(readProviderDaemonRuntimeEventCursor(withCursor)).toBe(42);
    expect(JSON.stringify(withCursor)).not.toContain("cafecodeProviderDaemonCursor");
  });

  it("rewinds persisted cursors by a bounded replay overlap", () => {
    expect(rewindProviderDaemonCursorForReplay(2_500, 1_000)).toBe(1_500);
    expect(rewindProviderDaemonCursorForReplay(20, 1_000)).toBe(0);
    expect(rewindProviderDaemonCursorForReplay(Number.NaN, 1_000)).toBe(0);
  });
});
