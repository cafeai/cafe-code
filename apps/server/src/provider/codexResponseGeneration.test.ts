import { describe, expect, it } from "vitest";

import { CodexResponseGenerationTracker } from "./codexResponseGeneration.ts";

const itemStarted = (type: string) => ({ method: "item/started", params: { item: { type } } });
const itemCompleted = (type: string) => ({ method: "item/completed", params: { item: { type } } });
const tokenUsage = (outputTokens: number) => ({
  method: "thread/tokenUsage/updated",
  params: { tokenUsage: { last: { outputTokens } } },
});

describe("CodexResponseGenerationTracker", () => {
  it("times a reasoning and message response from first output to last output edge", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe({ method: "item/reasoning/summaryTextDelta" }, 1_400);
    tracker.observe(itemCompleted("reasoning"), 2_000);
    tracker.observe(itemStarted("agentMessage"), 2_100);
    tracker.observe({ method: "item/agentMessage/delta" }, 3_500);
    tracker.observe(itemCompleted("agentMessage"), 4_000);
    // Usage can arrive later than the response itself; it must not end the window.
    expect(tracker.observe(tokenUsage(300), 4_250)).toBe(3_000);
  });

  it("ends at the first tool start and excludes tool execution before usage", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe(itemCompleted("reasoning"), 2_000);
    // The call's arguments finish generating and the tool is spawned.
    tracker.observe(itemStarted("commandExecution"), 2_500);
    tracker.observe({ method: "item/commandExecution/outputDelta" }, 30_000);
    tracker.observe(itemCompleted("commandExecution"), 60_000);
    // A second, serially locked tool only starts after the first finishes.
    tracker.observe(itemStarted("fileChange"), 60_100);
    expect(tracker.observe(tokenUsage(120), 61_000)).toBe(1_500);
  });

  it("ignores tool starts after an approval was resolved", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe(itemCompleted("reasoning"), 2_000);
    tracker.observe({ method: "serverRequest/resolved" }, 45_000);
    tracker.observe(itemStarted("commandExecution"), 45_100);
    expect(tracker.observe(tokenUsage(80), 50_000)).toBe(1_000);
  });

  it("extends the window with streamed patch arguments", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe(itemCompleted("reasoning"), 2_000);
    tracker.observe({ method: "item/fileChange/patchUpdated" }, 9_000);
    expect(tracker.observe(tokenUsage(900), 9_500)).toBe(8_000);
  });

  it("does not sample responses without observed output or with hosted tools", () => {
    const tracker = new CodexResponseGenerationTracker();
    // A bare function call opens no window: its start is not observable.
    tracker.observe(itemStarted("commandExecution"), 1_000);
    expect(tracker.observe(tokenUsage(40), 2_000)).toBeUndefined();

    tracker.observe(itemStarted("reasoning"), 3_000);
    tracker.observe(itemStarted("webSearch"), 3_500);
    tracker.observe(itemStarted("agentMessage"), 9_000);
    expect(tracker.observe(tokenUsage(200), 10_000)).toBeUndefined();

    // The next response is measured normally again.
    tracker.observe(itemStarted("agentMessage"), 11_000);
    tracker.observe(itemCompleted("agentMessage"), 12_000);
    expect(tracker.observe(tokenUsage(100), 12_100)).toBe(1_000);
  });

  it("restarts the window after a retried stream or a turn boundary", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe({ method: "error", params: { willRetry: true } }, 5_000);
    tracker.observe(itemStarted("reasoning"), 20_000);
    tracker.observe(itemCompleted("reasoning"), 21_000);
    expect(tracker.observe(tokenUsage(100), 21_100)).toBe(1_000);

    tracker.observe(itemStarted("agentMessage"), 30_000);
    tracker.observe({ method: "turn/completed" }, 31_000);
    expect(tracker.observe(tokenUsage(100), 31_100)).toBeUndefined();
  });

  it("measures each response of a turn independently", () => {
    const tracker = new CodexResponseGenerationTracker();
    tracker.observe(itemStarted("reasoning"), 1_000);
    tracker.observe(itemStarted("commandExecution"), 2_000);
    expect(tracker.observe(tokenUsage(50), 9_000)).toBe(1_000);
    // The second response may use its own first tool start as an edge.
    tracker.observe(itemStarted("reasoning"), 10_000);
    tracker.observe(itemStarted("commandExecution"), 13_000);
    expect(tracker.observe(tokenUsage(150), 20_000)).toBe(3_000);
  });
});
