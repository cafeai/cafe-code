import { MessageId, ThreadId, TurnId } from "@cafecode/contracts";
import type {
  VisualizationListInput,
  VisualizationListResult,
  VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { describe, expect, it, vi } from "vitest";
import {
  createVisualizationHistoryController,
  type VisualizationHistoryState,
} from "./visualizationHistoryController";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";

const threadId = ThreadId.make("viewport-history-fixture");
function entry(
  index: number,
  occurredAt = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
): VisualizationTimelineEntry {
  return {
    messageId: MessageId.make(`message-${index}`),
    turnId: TurnId.make(`turn-${index}`),
    originItemId: `origin-${index}`,
    occurredAt,
    actor: { type: "root" },
    reference: {
      version: 1,
      purpose: "generated-visualization",
      artifactId: VisualizationArtifactId.make("80000000-0000-4000-8000-000000000000"),
      revisionId: VisualizationRevisionId.make(
        `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
      title: `Chart ${index}`,
      width: 640,
      height: 240,
    },
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness(list: (input: VisualizationListInput) => Promise<VisualizationListResult>) {
  let state: VisualizationHistoryState = { entries: [], loading: false, failed: false };
  const controller = createVisualizationHistoryController({
    threadId,
    current: () => true,
    list,
    publish: (value) => {
      state = value;
    },
  });
  return { controller, state: () => state };
}
const viewport = (value: VisualizationTimelineEntry, keys: readonly string[] = []) => ({
  oldestAt: value.occurredAt,
  newestAt: value.occurredAt,
  visibleEntryKeys: keys,
  atEnd: false,
});

describe("viewport-positioned visualization history", () => {
  it("seeks a far-old visible message directly without walking intervening cursors", async () => {
    const newest = entry(20_000),
      old = entry(20);
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.atOrBefore
        ? { entries: [old] }
        : { entries: [newest], nextCursor: "a0000000-0000-4000-8000-000000000000" },
    );
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(h.state().entries).toEqual([newest]));
      h.controller.observeViewport(viewport(old));
      await vi.waitFor(() => expect(h.state().entries).toEqual([old, newest]));
      expect(list.mock.calls.map(([input]) => input)).toEqual([
        { threadId },
        { threadId, atOrBefore: old.occurredAt },
      ]);
      h.controller.observeViewport(viewport(old));
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      h.controller.close();
    }
  });

  it("continues exact timestamp ties only after the admitted page's last chart is visible", async () => {
    const tied = Array.from({ length: 52 }, (_, index) =>
      entry(index + 1, "2026-10-01T00:00:00.000Z"),
    ).toReversed();
    const cursor = "a0000000-0000-4000-8000-000000000050";
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.cursor
        ? { entries: tied.slice(50) }
        : { entries: tied.slice(0, 50), nextCursor: cursor },
    );
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(h.state().entries).toHaveLength(50));
      h.controller.observeViewport(viewport(tied[0]!, [visualizationEntryIdentity(tied[0]!)]));
      expect(list).toHaveBeenCalledTimes(1);
      h.controller.observeViewport(viewport(tied[49]!, [visualizationEntryIdentity(tied[49]!)]));
      await vi.waitFor(() => expect(h.state().entries).toHaveLength(52));
      expect(list.mock.calls[1]?.[0]).toEqual({ threadId, cursor });
      h.controller.observeViewport(viewport(tied[49]!, [visualizationEntryIdentity(tied[49]!)]));
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      h.controller.close();
    }
  });

  it("coalesces visibility while a request is held and revokes late old-owner results", async () => {
    const pending = deferred<VisualizationListResult>();
    const newest = entry(20_000),
      first = entry(200),
      second = entry(20);
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.atOrBefore ? { entries: [second] } : pending.promise,
    );
    const h = harness(list);
    h.controller.invalidate();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    h.controller.observeViewport(viewport(first));
    h.controller.observeViewport(viewport(second));
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve({ entries: [newest], nextCursor: "a0000000-0000-4000-8000-000000000000" });
    await vi.waitFor(() => expect(h.state().entries).toEqual([second, newest]));
    expect(list.mock.calls[1]?.[0]).toEqual({ threadId, atOrBefore: second.occurredAt });
    h.controller.close();
    const closed = deferred<VisualizationListResult>();
    const retirementObserved = deferred<void>();
    const staleList = vi.fn(() => closed.promise);
    let owned = true;
    const publish = vi.fn();
    const stale = createVisualizationHistoryController({
      threadId,
      current: () => {
        if (!owned) retirementObserved.resolve();
        return owned;
      },
      list: staleList,
      publish,
    });
    try {
      stale.invalidate();
      await vi.waitFor(() => expect(staleList).toHaveBeenCalledTimes(1));
      stale.observeViewport(viewport(first));
      const admittedPublications = publish.mock.calls.length;
      owned = false;
      closed.resolve({ entries: [first] });
      // Exact response-consumer ownership check, not a microtask-count guess.
      await retirementObserved.promise;
      expect(publish).toHaveBeenCalledTimes(admittedPublications);
      expect(staleList).toHaveBeenCalledTimes(1);
    } finally {
      closed.resolve({ entries: [] });
      stale.close();
    }
  });

  it("keeps the current visible object through bounded-cache eviction and re-seeks evicted history", async () => {
    const anchor = entry(1);
    let batch = 0;
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.atOrBefore
        ? { entries: [anchor] }
        : {
            entries: Array.from({ length: 50 }, (_, index) =>
              entry(batch * 50 + index + 2),
            ).toReversed(),
            nextCursor: `a0000000-0000-4000-8000-${String(++batch).padStart(12, "0")}`,
          },
    );
    const h = harness(list);
    try {
      h.controller.observeViewport(viewport(anchor));
      await vi.waitFor(() => expect(h.state().entries).toEqual([anchor]));
      h.controller.observeViewport(viewport(anchor, [visualizationEntryIdentity(anchor)]));
      const admitted = h.state().entries[0];
      for (let page = 0; page < 22; page += 1) {
        h.controller.invalidate();
        await vi.waitFor(() => expect(h.state().loading).toBe(false));
        expect(h.state().entries.length).toBeLessThanOrEqual(1_000);
        expect(h.state().entries.find((value) => value.originItemId === anchor.originItemId)).toBe(
          admitted,
        );
      }
      const beforeSeek = list.mock.calls.length;
      h.controller.observeViewport(viewport(entry(5)));
      await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(beforeSeek));
      expect(list.mock.calls.at(-1)?.[0]).toEqual({ threadId, atOrBefore: entry(5).occurredAt });
    } finally {
      h.controller.close();
    }
  });

  it("retains admitted entries on failure, retries only the exact request, and rejects invalid hints", async () => {
    const newest = entry(2_000),
      old = entry(2);
    const list = vi.fn(async (input: VisualizationListInput): Promise<VisualizationListResult> => {
      if (!input.atOrBefore)
        return { entries: [newest], nextCursor: "a0000000-0000-4000-8000-000000000000" };
      if (list.mock.calls.length === 2) throw new Error("private transport details");
      return { entries: [old] };
    });
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(h.state().entries).toEqual([newest]));
      h.controller.observeViewport({ ...viewport(old), oldestAt: "2026-02-31T00:00:00.000Z" });
      h.controller.observeViewport({ ...viewport(old), newestAt: "+010000-01-01T00:00:00.000Z" });
      h.controller.observeViewport({ ...viewport(old), oldestAt: newest.occurredAt });
      h.controller.observeViewport({
        ...viewport(old),
        visibleEntryKeys: Array.from({ length: 129 }, () => "oversized"),
      });
      expect(list).toHaveBeenCalledTimes(1);
      h.controller.observeViewport(viewport(old));
      await vi.waitFor(() => expect(h.state().failed).toBe(true));
      expect(h.state().entries).toEqual([newest]);
      h.controller.observeViewport(viewport(old));
      expect(list).toHaveBeenCalledTimes(2);
      h.controller.retry();
      await vi.waitFor(() => expect(h.state().entries).toEqual([old, newest]));
      expect(list.mock.calls[2]?.[0]).toEqual(list.mock.calls[1]?.[0]);
      expect(h.state().failed).toBe(false);
    } finally {
      h.controller.close();
    }
  });

  it.each(["stalled", "cyclic"] as const)(
    "refuses %s cursor progress without a hot loop or losing the visible object",
    async (kind) => {
      const chart = entry(1),
        cursorA = "a0000000-0000-4000-8000-000000000001",
        cursorB = "a0000000-0000-4000-8000-000000000002";
      const list = vi.fn(async (input: VisualizationListInput) => ({
        entries: [chart],
        nextCursor: !input.cursor
          ? cursorA
          : kind === "stalled"
            ? input.cursor
            : input.cursor === cursorA
              ? cursorB
              : cursorA,
      }));
      const h = harness(list);
      try {
        h.controller.invalidate();
        await vi.waitFor(() => expect(h.state().entries).toHaveLength(1));
        const stable = h.state().entries[0];
        h.controller.observeViewport(viewport(chart, [visualizationEntryIdentity(chart)]));
        await vi.waitFor(() => expect(h.state().failed).toBe(true));
        expect(list).toHaveBeenCalledTimes(kind === "stalled" ? 2 : 3);
        expect(h.state().entries[0]).toBe(stable);
        h.controller.observeViewport(viewport(chart, [visualizationEntryIdentity(chart)]));
        expect(list).toHaveBeenCalledTimes(kind === "stalled" ? 2 : 3);
      } finally {
        h.controller.close();
      }
    },
  );

  it("accepts complete contract-sized fork anchors as visible cursor ownership", async () => {
    const chart = {
      ...entry(1),
      messageId: MessageId.make("m".repeat(2_048)),
      turnId: TurnId.make("t".repeat(2_048)),
      originItemId: "o".repeat(2_048),
      actor: { type: "child" as const, id: "c".repeat(200) },
    };
    const cursor = "a0000000-0000-4000-8000-000000000000";
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.cursor ? { entries: [] } : { entries: [chart], nextCursor: cursor },
    );
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(h.state().entries).toHaveLength(1));
      h.controller.observeViewport(viewport(chart, [visualizationEntryIdentity(chart)]));
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(list.mock.calls[1]?.[0]).toEqual({ threadId, cursor });
    } finally {
      h.controller.close();
    }
  });

  it("gives a far-old visible window its turn before a coalesced stream of newer invalidations", async () => {
    const first = deferred<VisualizationListResult>(),
      old = entry(1),
      latest = entry(20_000);
    const list = vi.fn(async (input: VisualizationListInput): Promise<VisualizationListResult> => {
      if (list.mock.calls.length === 1) return first.promise;
      if (input.atOrBefore) return { entries: [old] };
      return { entries: [latest], nextCursor: "a0000000-0000-4000-8000-000000000000" };
    });
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      h.controller.observeViewport(viewport(old));
      for (let index = 0; index < 100; index += 1) h.controller.invalidate();
      expect(list).toHaveBeenCalledTimes(1);
      first.resolve({ entries: [latest], nextCursor: "a0000000-0000-4000-8000-000000000000" });
      await vi.waitFor(() => {
        expect(h.state().loading).toBe(false);
        expect(list).toHaveBeenCalledTimes(3);
      });
      expect(list.mock.calls.map(([input]) => input)).toEqual([
        { threadId },
        { threadId, atOrBefore: old.occurredAt },
        { threadId },
      ]);
      expect(h.state().entries).toEqual([old, latest]);
    } finally {
      first.resolve({ entries: [] });
      h.controller.close();
    }
  });

  it("refreshes a visible gap directly after a large live burst instead of trusting stale absence coverage", async () => {
    const initial = entry(1_000),
      gap = entry(1_100),
      burst = entry(1_200);
    let published = false;
    const list = vi.fn(async (input: VisualizationListInput) =>
      input.atOrBefore
        ? { entries: [gap] }
        : {
            entries: [published ? burst : initial],
            nextCursor: "a0000000-0000-4000-8000-000000000000",
          },
    );
    const h = harness(list);
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(h.state().entries).toEqual([initial]));
      h.controller.observeViewport(viewport(gap));
      expect(list).toHaveBeenCalledTimes(1);
      published = true;
      h.controller.invalidate();
      await vi.waitFor(() => {
        expect(h.state().entries).toEqual([initial, gap, burst]);
        expect(h.state().loading).toBe(false);
      });
      expect(list.mock.calls.map(([input]) => input)).toEqual([
        { threadId },
        { threadId, atOrBefore: gap.occurredAt },
        { threadId },
      ]);
    } finally {
      h.controller.close();
    }
  });

  it("fairly admits both viewport edges even when each held request receives newer invalidations", async () => {
    const oldest = entry(1),
      newest = entry(200),
      latest = entry(20_000);
    const pending: ReturnType<typeof deferred<VisualizationListResult>>[] = [];
    const list = vi.fn((_input: VisualizationListInput) => {
      const request = deferred<VisualizationListResult>();
      pending.push(request);
      return request.promise;
    });
    const h = harness(list);
    const invalidate = () => {
      for (let index = 0; index < 20; index += 1) h.controller.invalidate();
    };
    try {
      h.controller.invalidate();
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      h.controller.observeViewport({
        oldestAt: oldest.occurredAt,
        newestAt: newest.occurredAt,
        visibleEntryKeys: [],
        atEnd: false,
      });
      invalidate();
      pending[0]!.resolve({
        entries: [latest],
        nextCursor: "a0000000-0000-4000-8000-000000000000",
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(list.mock.calls[1]?.[0]).toEqual({ threadId, atOrBefore: newest.occurredAt });
      invalidate();
      pending[1]!.resolve({
        entries: [newest],
        nextCursor: "a0000000-0000-4000-8000-000000000000",
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      expect(list.mock.calls[2]?.[0]).toEqual({ threadId });
      invalidate();
      pending[2]!.resolve({
        entries: [latest],
        nextCursor: "a0000000-0000-4000-8000-000000000000",
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));
      expect(list.mock.calls[3]?.[0]).toEqual({ threadId, atOrBefore: oldest.occurredAt });
    } finally {
      h.controller.close();
      for (const request of pending) request.resolve({ entries: [] });
    }
  });
});
