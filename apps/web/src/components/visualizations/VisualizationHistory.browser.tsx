import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@cafecode/contracts";
import type {
  VisualizationListResult,
  VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import {
  GeneratedVisualizationReference,
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useThreadVisualizations } from "./useThreadVisualizations";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
import type { VisualizationHistoryViewport } from "./visualizationHistoryController";
import {
  acquireVisualizationPoster,
  readVisualizationPosterAccounting,
} from "./visualizationPoster";
import { fileRequest } from "../../attachments/fileAttachments";

vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: vi.fn(),
}));
const environmentId = EnvironmentId.make("visualization-fixture-environment");
const threadId = ThreadId.make("visualization-fixture-chat");
const artifactId = VisualizationArtifactId.make("8bdd2475-78f0-4563-9829-f29b073c0689");
const revisionId = VisualizationRevisionId.make("4e27bd63-c586-4f50-99b5-a722994d41dc");
const entry: VisualizationTimelineEntry = {
  messageId: MessageId.make("visualization-fixture-message"),
  turnId: TurnId.make("visualization-fixture-turn"),
  originItemId: "fixture-origin",
  occurredAt: "2026-10-12T12:14:15.000Z",
  actor: { type: "child", id: "fixture-child", label: "Layout reviewer" },
  reference: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    title: "Revenue explorer",
    width: 640,
    height: 240,
  },
};
/** Preserve the complete durable/history and old stored-poster reader contract.
 * These are inert data readers, not an execution fallback for current charts. */
function installApi() {
  const list = vi.fn<NonNullable<EnvironmentApi["visualizations"]>["list"]>(async () => ({
    entries: [entry],
  }));
  const details = vi.fn();
  const viewerTicket = vi.fn<NonNullable<EnvironmentApi["visualizations"]>["viewerTicket"]>();
  __setEnvironmentApiOverrideForTests(environmentId, {
    visualizations: { list, details, viewerTicket },
  } as unknown as EnvironmentApi);
  return { list, details, viewerTicket };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (reason: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const historyCleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  try {
    for (const cleanup of historyCleanups) await cleanup();
  } finally {
    historyCleanups.clear();
    __resetEnvironmentApiOverridesForTests();
    vi.mocked(fileRequest).mockReset();
  }
});

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
const ignore = () => undefined;
const emptyReverts = new Map<MessageId, number>();
const time = (seconds: number) => new Date(Date.UTC(2026, 9, 12, 0, 0, seconds)).toISOString();
function historyValue(index: number, seconds: number): VisualizationTimelineEntry {
  return {
    ...entry,
    messageId: MessageId.make(`history-message-${index}`),
    originItemId: `history-call-${index}`,
    occurredAt: time(seconds),
    reference: {
      ...entry.reference,
      revisionId: VisualizationRevisionId.make(
        `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
      title: `Historical chart ${index}`,
    },
  };
}
function AutomaticHistoryFixture({
  listRef,
  onObserve,
  onInitialLoad,
  onHistoryViewport,
}: {
  listRef: TimelineProps["listRef"];
  onObserve: (result: ReturnType<typeof useThreadVisualizations>) => void;
  onInitialLoad: () => void;
  onHistoryViewport: (value: VisualizationHistoryViewport) => void;
}) {
  const result = useThreadVisualizations(environmentId, threadId, true, "initial");
  const [following, setFollowing] = useState(true);
  const stopFollowing = useCallback(() => setFollowing(false), []);
  const observeViewport = useCallback(
    (value: VisualizationHistoryViewport) => {
      onHistoryViewport(value);
      result.observeViewport(value);
    },
    [onHistoryViewport, result.observeViewport],
  );
  useLayoutEffect(() => onObserve(result), [onObserve, result]);
  const entries = useMemo<TimelineProps["timelineEntries"]>(
    () =>
      [
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `visible-message-${index}`,
          kind: "message" as const,
          createdAt: index === 1 ? time(index * 10).replace(".000Z", "Z") : time(index * 10),
          message: {
            id: MessageId.make(`visible-message-${index}`),
            // This is ordinary uncollapsed assistant content. A long user
            // message deliberately collapses in production and cannot prove
            // that its next chronological row is outside the viewport.
            role: index === 1 ? ("assistant" as const) : ("user" as const),
            text:
              index === 1
                ? `Historical long message\n\n${Array.from({ length: 24 }, (_, line) => `Retained historical paragraph ${line}.`).join("\n\n")}`
                : `Historical message ${index}\nThe actual conversation owns scrolling.`,
            createdAt: time(index * 10),
            streaming: false,
          },
        })),
        ...result.entries.map((value) => ({
          id: `visualization:${visualizationEntryIdentity(value)}`,
          kind: "visualization" as const,
          createdAt: value.occurredAt,
          visualization: value,
        })),
      ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [result.entries],
  );
  return (
    <div className="h-full min-h-0" data-history-following={following}>
      <MessagesTimeline
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        activeProvider={ProviderDriverKind.make("codex")}
        activeTurnId={null}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        autoFollowTail={following}
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking={false}
        listRef={listRef}
        markdownCwd={undefined}
        onImageExpand={ignore}
        onIsAtEndChange={ignore}
        onRevertUserMessage={ignore}
        onUserScrollIntent={stopFollowing}
        onVisualizationHistoryViewport={observeViewport}
        onDebugScrollEvent={(event) => {
          if (event.reason === "initial-list-load") onInitialLoad();
        }}
        revertTurnCountByUserMessageId={emptyReverts}
        stickToEndRevision={0}
        timelineEntries={entries}
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />
    </div>
  );
}
/** Trusted native wheel input; the existing provider-owned desktop context is unchanged. */
async function wheel(scroller: HTMLElement, deltaY: number) {
  const bounds = scroller.getBoundingClientRect();
  let x = bounds.left + bounds.width / 2,
    y = bounds.top + Math.min(bounds.height / 2, 100);
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement,
      rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}
function HookFixture({
  onObserve,
}: {
  onObserve: (result: ReturnType<typeof useThreadVisualizations>) => void;
}) {
  const [revision, setRevision] = useState(0),
    [thread, setThread] = useState(threadId);
  const result = useThreadVisualizations(environmentId, thread, true, String(revision));
  useLayoutEffect(() => {
    onObserve(result);
  });
  return (
    <>
      <button onClick={() => setRevision((value) => value + 1)}>New live event</button>
      <button onClick={() => setThread(ThreadId.make("replacement-history-chat"))}>
        Switch chat
      </button>
      {result.failed ? <button onClick={result.refresh}>Retry archive</button> : null}
      <output>{result.entries.map((value) => value.reference.title).join(",")}</output>
    </>
  );
}

describe("automatic compact visualization history", () => {
  it("loads an older chart at its chronological location after native scroll, including publication during a long message", async () => {
    const api = installApi();
    const old = historyValue(1, 15);
    const values = [
      old,
      ...Array.from({ length: 50 }, (_, index) => historyValue(index + 2, 100 + index * 6)),
    ];
    const heldSeek = deferred<VisualizationListResult>();
    let heldPage: VisualizationListResult | undefined;
    api.list.mockImplementation(async (input) => {
      const selected = values
        .filter((value) => !input.atOrBefore || value.occurredAt <= input.atOrBefore)
        .toReversed();
      const page = {
        entries: selected.slice(0, 50),
        ...(selected.length > 50 ? { nextCursor: "70000000-0000-4000-8000-000000000001" } : {}),
      };
      if (input.atOrBefore !== undefined && heldPage === undefined) {
        heldPage = page;
        return heldSeek.promise;
      }
      return page;
    });
    const host = document.createElement("div");
    host.style.width = "min(760px, 100vw)";
    host.style.height = "360px";
    const listRef = createRef<LegendListRef>();
    let observed: ReturnType<typeof useThreadVisualizations> | undefined,
      loaded = false,
      reviewing = false,
      receivedLongInterval = false;
    let rendering: ReturnType<typeof render> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        try {
          const view = await rendering;
          await view?.unmount();
        } finally {
          heldSeek.resolve(heldPage ?? { entries: [] });
          host.remove();
        }
      })());
    // Own the held response and native render before either append/await. A
    // hard test timeout must not leak a pending reader into the next fixture.
    historyCleanups.add(cleanup);
    document.body.append(host);
    rendering = render(
      <AutomaticHistoryFixture
        listRef={listRef}
        onObserve={(value) => {
          observed = value;
        }}
        onInitialLoad={() => {
          loaded = true;
        }}
        onHistoryViewport={(value) => {
          if (
            reviewing &&
            value.oldestAt <= time(10) &&
            value.newestAt === time(20) &&
            value.visibleEntryKeys.length === 0
          )
            receivedLongInterval = true;
        }}
      />,
      { container: host },
    );
    try {
      await rendering;
      await vi.waitFor(() => {
        expect(loaded).toBe(true);
        expect(observed?.entries).toHaveLength(50);
        expect(observed?.loading).toBe(false);
        const scroller = listRef.current?.getScrollableNode();
        expect(scroller).toBeInstanceOf(HTMLElement);
        expect(
          scroller!.scrollHeight - scroller!.clientHeight - scroller!.scrollTop,
        ).toBeLessThanOrEqual(2);
      });
      const scroller = listRef.current!.getScrollableNode()!;
      const beforeReviewCalls = api.list.mock.calls.length;
      reviewing = true;
      await wheel(scroller, -1_000_000);
      await vi.waitFor(() => {
        expect(heldPage).toBeDefined();
        expect(receivedLongInterval).toBe(true);
        const viewport = scroller.getBoundingClientRect();
        const long = host.querySelector<HTMLElement>('[data-timeline-row-id="visible-message-1"]');
        expect(long).not.toBeNull();
        const bounds = long!.getBoundingClientRect();
        expect(bounds.bottom > viewport.top && bounds.top < viewport.bottom).toBe(true);
        const next = host
          .querySelector<HTMLElement>('[data-timeline-row-id="visible-message-2"]')
          ?.getBoundingClientRect();
        expect(!next || next.bottom <= viewport.top || next.top >= viewport.bottom).toBe(true);
      });
      // Admit the exact owned response only after the real list reports the
      // long-message interval [10s,20s]. The 15s publication lies inside it;
      // a start-time-only policy cannot produce this observed upper boundary.
      // Transitional native measurements may have sought a wider valid edge.
      heldSeek.resolve(heldPage!);
      await vi.waitFor(() =>
        expect(observed?.entries.some((value) => value.originItemId === old.originItemId)).toBe(
          true,
        ),
      );
      const seekCalls = api.list.mock.calls.slice(beforeReviewCalls);
      expect(seekCalls.length).toBeGreaterThanOrEqual(1);
      expect(seekCalls.length).toBeLessThanOrEqual(2);
      expect(seekCalls.every(([input]) => input.atOrBefore !== undefined)).toBe(true);
      expect(api.list.mock.calls.every(([input]) => input.cursor === undefined)).toBe(true);
      const rows = listRef.current!.getState().data;
      const oldIndex = rows.findIndex(
        (row) => row.id === `visualization:${visualizationEntryIdentity(old)}`,
      );
      expect(oldIndex).toBeGreaterThan(rows.findIndex((row) => row.id === "visible-message-1"));
      expect(oldIndex).toBeLessThan(rows.findIndex((row) => row.id === "visible-message-2"));
      expect(
        host.querySelector("[data-history-following]")?.getAttribute("data-history-following"),
      ).toBe("false");
      const long = host.querySelector<HTMLElement>('[data-timeline-row-id="visible-message-1"]');
      expect(long).not.toBeNull();
      // Use native wheel input past the actual long row, not a fixed amount
      // which silently assumes typography or the collapsed user-message size.
      await wheel(
        scroller,
        long!.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top,
      );
      await vi.waitFor(() => {
        const row = [...host.querySelectorAll<HTMLElement>("[data-timeline-row-id]")].find(
          (node) =>
            node.dataset.timelineRowId === `visualization:${visualizationEntryIdentity(old)}`,
        );
        expect(row?.querySelector("[data-visualization-card]")).not.toBeNull();
        const bounds = row!.getBoundingClientRect(),
          viewport = scroller.getBoundingClientRect();
        expect(bounds.bottom > viewport.top && bounds.top < viewport.bottom).toBe(true);
      });
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      await cleanup();
      historyCleanups.delete(cleanup);
    }
  });

  it("retains root and child invocation identity and equal-time ordering across a live refresh", async () => {
    const api = installApi();
    const root = { ...entry, actor: { type: "root" as const }, originItemId: "root-call" };
    const child = {
      ...entry,
      actor: { type: "child" as const, id: "other-child" },
      originItemId: "child-call",
    };
    api.list.mockResolvedValue({ entries: [root, child] });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const view = await render(
      <HookFixture
        onObserve={(value) => {
          observed = value;
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(2));
      const initial = observed!.entries;
      api.list.mockResolvedValue({ entries: [child, root] });
      await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      await vi.waitFor(() => {
        expect(api.list).toHaveBeenCalledTimes(2);
        expect(observed?.loading).toBe(false);
      });
      expect(observed?.entries).toEqual(initial);
      expect(observed?.entries[0]).toBe(initial[0]);
      expect(observed?.entries[1]).toBe(initial[1]);
      expect(new Set(observed!.entries.map(visualizationEntryIdentity)).size).toBe(2);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("revokes late old-chat pages and their coalesced invalidation when the exact owner changes", async () => {
    const api = installApi(),
      pending = deferred<{ entries: VisualizationTimelineEntry[] }>();
    api.list.mockImplementationOnce(() => pending.promise);
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const view = await render(
      <HookFixture
        onObserve={(value) => {
          observed = value;
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
      await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      expect(api.list).toHaveBeenCalledTimes(1);
      api.list.mockResolvedValue({ entries: [] });
      await userEvent.click(page.getByRole("button", { name: "Switch chat", exact: true }));
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      pending.resolve({ entries: [entry] });
      await pending.promise;
      expect(observed?.entries).toEqual([]);
      expect(api.list).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve({ entries: [] });
      await view.unmount();
    }
  });

  it("keeps admitted references on failure and retries from the explicit refresh action", async () => {
    const api = installApi();
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const view = await render(
      <HookFixture
        onObserve={(value) => {
          observed = value;
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toEqual([entry]));
      api.list.mockRejectedValueOnce(new Error("private diagnostic"));
      await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      await expect
        .element(page.getByRole("button", { name: "Retry archive", exact: true }))
        .toBeVisible();
      expect(observed?.entries).toEqual([entry]);
      await userEvent.click(page.getByRole("button", { name: "Retry archive", exact: true }));
      await vi.waitFor(() => {
        expect(observed?.failed).toBe(false);
        expect(api.list).toHaveBeenCalledTimes(3);
      });
      expect(observed?.entries).toEqual([entry]);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
});

describe("bounded stored visualization poster readers", () => {
  it("limits poster transport to two active reads and eight cancellable waiting reads", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
        "image/png",
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    const reference = Schema.decodeUnknownSync(GeneratedVisualizationReference)({
      ...entry.reference,
      poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 16, height: 16 },
    });
    const finish: ((response: Response) => void)[] = [];
    vi.mocked(fileRequest).mockImplementation(
      () => new Promise<Response>((resolve) => finish.push(resolve)),
    );
    const controllers = Array.from({ length: 11 }, () => new AbortController());
    // Attach both outcomes immediately: saturating/cancelling received work
    // must not create an unhandled rejection or leave an unbounded promise tail.
    const outcomes = controllers.map((controller) =>
      acquireVisualizationPoster(environmentId, threadId, reference, controller.signal).then(
        (lease) => {
          lease.release();
          return "decoded";
        },
        () => "refused",
      ),
    );
    try {
      expect(readVisualizationPosterAccounting()).toMatchObject({
        activeTransfers: 2,
        queuedTransfers: 8,
      });
      expect(fileRequest).toHaveBeenCalledTimes(2);
      for (const controller of controllers.slice(2)) controller.abort();
      expect(readVisualizationPosterAccounting().queuedTransfers).toBe(0);
      for (const complete of finish)
        complete(new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }));
      const settled = await Promise.all(outcomes);
      expect(settled.filter((value) => value === "decoded")).toHaveLength(2);
      expect(settled.filter((value) => value === "refused")).toHaveLength(9);
      expect(fileRequest).toHaveBeenCalledTimes(2);
      expect(readVisualizationPosterAccounting()).toMatchObject({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 0,
        retainedBytes: 0,
      });
    } finally {
      for (const controller of controllers) controller.abort();
      for (const complete of finish)
        complete(new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }));
      await Promise.all(outcomes);
    }
  });
  it("accounts real bitmap bytes before decoding and revokes the last poster URL on release", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 2000;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
        "image/png",
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    const reference = Schema.decodeUnknownSync(GeneratedVisualizationReference)({
      ...entry.reference,
      poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 1600, height: 2000 },
    });
    const second = {
      ...reference,
      revisionId: VisualizationRevisionId.make("3902c28e-399e-4d3a-9539-3f7c117c9d76"),
    };
    vi.mocked(fileRequest).mockImplementation(
      async () => new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }),
    );
    const decode = vi.spyOn(window, "createImageBitmap");
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    let first: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    let shared: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    let next: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    const started = performance.now();
    try {
      expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
      first = await acquireVisualizationPoster(
        environmentId,
        threadId,
        reference,
        new AbortController().signal,
      );
      shared = await acquireVisualizationPoster(
        environmentId,
        threadId,
        reference,
        new AbortController().signal,
      );
      expect(shared.url).toBe(first.url);
      expect(readVisualizationPosterAccounting()).toEqual({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 1,
        retainedBytes: 1600 * 2000 * 4 + png.byteLength,
        maxRetainedBytes: 16 * 1024 * 1024,
      });
      await expect(
        acquireVisualizationPoster(environmentId, threadId, second, new AbortController().signal),
      ).rejects.toThrow("poster-busy");
      expect(decode).toHaveBeenCalledTimes(1);
      expect(createUrl).toHaveBeenCalledTimes(1);
      first.release();
      expect(revokeUrl).not.toHaveBeenCalled();
      shared.release();
      expect(revokeUrl).toHaveBeenCalledWith(first.url);
      expect(readVisualizationPosterAccounting().retainedItems).toBe(0);
      next = await acquireVisualizationPoster(
        environmentId,
        threadId,
        second,
        new AbortController().signal,
      );
      expect(decode).toHaveBeenCalledTimes(2);
      next.release();
      expect(revokeUrl).toHaveBeenCalledTimes(2);
      expect(readVisualizationPosterAccounting()).toEqual({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 0,
        retainedBytes: 0,
        maxRetainedBytes: 16 * 1024 * 1024,
      });
      console.info(
        "visualization-poster-qualification",
        JSON.stringify({
          pngBytes: png.byteLength,
          conservativePeakOwnedBytes: 1600 * 2000 * 4 + png.byteLength,
          bitmapDecodes: decode.mock.calls.length,
          createdUrls: createUrl.mock.calls.length,
          revokedUrls: revokeUrl.mock.calls.length,
          idleOwnedBytes: 0,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      first?.release();
      shared?.release();
      next?.release();
      decode.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
});
