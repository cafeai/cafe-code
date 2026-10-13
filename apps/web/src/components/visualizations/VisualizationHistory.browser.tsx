import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@cafecode/contracts";
import type { VisualizationTimelineEntry } from "@cafecode/contracts/visualizationApi";
import {
  GeneratedVisualizationReference,
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useLayoutEffect, useState } from "react";
import { uiText } from "@cafecode/shared/i18n";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useThreadVisualizations } from "./useThreadVisualizations";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
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
afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  vi.mocked(fileRequest).mockReset();
});

/** A bounded received-page fixture; no private source or native host is started. */
function historyValues(count: number): VisualizationTimelineEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...entry,
    messageId: MessageId.make(`archive-message-${index + 1}`),
    turnId: TurnId.make(`archive-turn-${index + 1}`),
    originItemId: `archive-origin-${index + 1}`,
    // Some oldest stored rows have newer display timestamps. Retention must
    // still follow exact page admission rather than trust this presentation.
    occurredAt: new Date(
      Date.UTC(2026, 9, 12, 0, 0, index < 20 ? count + index : index),
    ).toISOString(),
    reference: {
      ...entry.reference,
      revisionId: VisualizationRevisionId.make(
        `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
    },
  }));
}

function archivePage(values: readonly VisualizationTimelineEntry[], before = values.length + 1) {
  const last = Math.min(values.length, before - 1);
  const first = Math.max(1, last - 49);
  return {
    entries: values.slice(first - 1, last).toReversed(),
    ...(first > 1
      ? { nextCursor: `70000000-0000-4000-8000-${String(first).padStart(12, "0")}` }
      : {}),
  };
}

function HistoryReviewFixture({
  onObserve,
}: {
  onObserve: (result: ReturnType<typeof useThreadVisualizations>) => void;
}) {
  const [revision, setRevision] = useState(0);
  const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
  useLayoutEffect(() => {
    onObserve(result);
  });
  return (
    <>
      <button disabled={result.loading} onClick={result.loadOlder}>
        Load older archive
      </button>
      <button onClick={() => setRevision((value) => value + 1)}>New live event</button>
      {result.reviewingOlder ? (
        <button onClick={result.returnToLatest}>{uiText("Return to latest")}</button>
      ) : null}
      {result.failed ? <button onClick={result.refresh}>Retry archive</button> : null}
      <output
        data-review-mode={result.reviewingOlder}
        data-reference-count={result.entries.length}
      />
    </>
  );
}

describe("durable compact visualization history", () => {
  it("makes every stored page reachable through a capped older-review window and explicit return to latest", async () => {
    const api = installApi();
    const values = historyValues(1_300);
    let published = 1_250;
    api.list.mockImplementation(async (input) =>
      archivePage(
        values.slice(0, published),
        input.cursor ? Number(input.cursor.slice(-12)) : undefined,
      ),
    );
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    let peakReferences = 0;
    const started = performance.now();
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
          peakReferences = Math.max(peakReferences, result.entries.length);
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
      }
      expect(observed?.hasOlder).toBe(true);
      const retainedOverlap = observed!.entries.find(
        (value) => value.originItemId === "archive-origin-500",
      );
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const calls = api.list.mock.calls.length + 1;
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(calls));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
        expect(observed?.entries).toHaveLength(1_000);
        expect(observed?.reviewingOlder).toBe(true);
      }
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(0, 1_000).map(visualizationEntryIdentity)),
      );
      expect(observed?.entries.find((value) => value.originItemId === "archive-origin-500")).toBe(
        retainedOverlap,
      );
      expect(observed?.hasOlder).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "Return to latest", exact: true }))
        .toBeVisible();
      const reviewed = observed!.entries;
      published = 1_300;
      for (let event = 0; event < 3; event += 1)
        await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      expect(api.list).toHaveBeenCalledTimes(25);
      expect(observed?.entries).toBe(reviewed);
      await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(1_250).map(visualizationEntryIdentity)),
      );
      expect(observed?.reviewingOlder).toBe(false);
      expect(api.list).toHaveBeenCalledTimes(26);
      expect(peakReferences).toBe(1_000);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-sliding-history-qualification",
        JSON.stringify({
          storedReferences: published,
          peakReferences,
          explicitOlderPages: 24,
          listRequests: api.list.mock.calls.length,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
  });
  it("revokes a deferred older page before one return-to-latest replacement, without overlapping requests", async () => {
    const api = installApi();
    const values = historyValues(1_100);
    const pending = deferred<Awaited<ReturnType<typeof api.list>>>();
    let held: Awaited<ReturnType<typeof api.list>> | undefined;
    let holdOlder = false;
    let concurrent = 0;
    let peakRequests = 0;
    api.list.mockImplementation(async (input) => {
      concurrent += 1;
      peakRequests = Math.max(peakRequests, concurrent);
      try {
        const result = archivePage(
          values,
          input.cursor ? Number(input.cursor.slice(-12)) : undefined,
        );
        if (input.cursor && holdOlder) {
          holdOlder = false;
          held = result;
          return await pending.promise;
        }
        return result;
      } finally {
        concurrent -= 1;
      }
    });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const admittedSnapshots: string[][] = [];
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
          admittedSnapshots.push(result.entries.map((value) => value.originItemId));
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
      }
      holdOlder = true;
      await userEvent.click(page.getByRole("button", { name: "Load older archive", exact: true }));
      await vi.waitFor(() => expect(held).toBeDefined());
      expect(observed?.reviewingOlder).toBe(true);
      await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
      for (let event = 0; event < 3; event += 1)
        await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      expect(api.list).toHaveBeenCalledTimes(21);
      pending.resolve(held!);
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(22));
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      expect(observed?.reviewingOlder).toBe(false);
      expect(admittedSnapshots.some((snapshot) => snapshot.includes("archive-origin-51"))).toBe(
        false,
      );
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(-50).map(visualizationEntryIdentity)),
      );
      expect(peakRequests).toBe(1);
      expect(concurrent).toBe(0);
    } finally {
      pending.resolve(held ?? { entries: [] });
      await view.unmount();
    }
  });
  it.each(["empty", "failure"] as const)(
    "keeps return-to-latest available after an older-review %s",
    async (outcome) => {
      const api = installApi();
      const values = historyValues(1_100);
      api.list.mockImplementation(async (input) =>
        archivePage(values, input.cursor ? Number(input.cursor.slice(-12)) : undefined),
      );
      let observed: ReturnType<typeof useThreadVisualizations> | undefined;
      const view = await render(
        <HistoryReviewFixture
          onObserve={(result) => {
            observed = result;
          }}
        />,
      );
      try {
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
          await userEvent.click(
            page.getByRole("button", { name: "Load older archive", exact: true }),
          );
          await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
        }
        if (outcome === "empty") api.list.mockResolvedValueOnce({ entries: [] });
        else api.list.mockRejectedValueOnce(new Error("private-history-failure"));
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(21));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
        expect(observed?.entries).toHaveLength(1_000);
        expect(observed?.reviewingOlder).toBe(true);
        await expect
          .element(page.getByRole("button", { name: "Return to latest", exact: true }))
          .toBeVisible();
        if (outcome === "failure") {
          expect(document.body.textContent).not.toContain("private-history-failure");
          await userEvent.click(page.getByRole("button", { name: "Retry archive", exact: true }));
          await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(22));
          expect(api.list.mock.calls[21]?.[0]).toEqual(api.list.mock.calls[20]?.[0]);
          await vi.waitFor(() => expect(observed?.loading).toBe(false));
          expect(
            observed?.entries.some((value) => value.originItemId === "archive-origin-51"),
          ).toBe(true);
        }
        await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        expect(observed?.reviewingOlder).toBe(false);
        expect(api.list.mock.calls.at(-1)?.[0]).toEqual({ threadId });
      } finally {
        await view.unmount();
      }
    },
  );
  it("retains separate exact root and child invocations of the same immutable revision across refreshes", async () => {
    const api = installApi();
    const root: VisualizationTimelineEntry = {
      ...entry,
      actor: { type: "root" },
      originItemId: "root-call",
    };
    const child: VisualizationTimelineEntry = {
      ...entry,
      actor: { type: "child", id: "other-child" },
      originItemId: "child-call",
    };
    api.list.mockResolvedValue({ entries: [root, child] });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(2));
      const initial = observed!.entries;
      await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(observed?.loading).toBe(false));
      expect(observed?.entries).toHaveLength(2);
      expect(observed?.entries[0]).toBe(initial[0]);
      expect(observed?.entries[1]).toBe(initial[1]);
      expect(new Set(observed!.entries.map(visualizationEntryIdentity)).size).toBe(2);
      expect(observed?.entries.map((value) => value.actor.type)).toEqual(["root", "child"]);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
  it.each([50, 1_000])(
    "fills a 120-reference refresh gap without dropping the %i-reference retained window",
    async (initialCount) => {
      const api = installApi();
      const values = Array.from(
        { length: initialCount + 120 },
        (_, index): VisualizationTimelineEntry => ({
          ...entry,
          occurredAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
          reference: {
            ...entry.reference,
            revisionId: VisualizationRevisionId.make(
              `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            ),
            title: `Burst chart ${index + 1}`,
          },
        }),
      );
      let publishedCount = initialCount;
      const cursorFor = (index: number) =>
        `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      api.list.mockImplementation(async (input) => {
        // Cursor identity is an immutable row boundary, not an offset that
        // shifts when new rows arrive. This matches the actual list contract.
        const before = input.cursor ? Number(input.cursor.slice(-12)) : publishedCount + 1;
        const last = Math.min(publishedCount, before - 1);
        const first = Math.max(1, last - 49);
        return {
          entries: values.slice(first - 1, last).toReversed(),
          ...(first > 1 ? { nextCursor: cursorFor(first) } : {}),
        };
      });
      let observed: ReturnType<typeof useThreadVisualizations> | undefined;
      function History() {
        const [revision, setRevision] = useState(0);
        const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
        useLayoutEffect(() => {
          observed = result;
        });
        return (
          <>
            <button onClick={result.loadOlder}>Older burst references</button>
            <button onClick={() => setRevision((value) => value + 1)}>
              Refresh burst references
            </button>
          </>
        );
      }
      const view = await render(<History />);
      try {
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        for (let pageIndex = 1; pageIndex < initialCount / 50; pageIndex += 1) {
          await userEvent.click(
            page.getByRole("button", { name: "Older burst references", exact: true }),
          );
          await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
        }
        expect(observed?.hasOlder).toBe(false);
        publishedCount += 120;
        await userEvent.click(
          page.getByRole("button", { name: "Refresh burst references", exact: true }),
        );
        await vi.waitFor(() =>
          expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
            values.at(-1)!.reference.revisionId,
          ),
        );
        expect(observed?.hasOlder).toBe(true);
        // One refresh plus two explicit pages reconnect to the original known
        // head, including when retained memory is already at its 1,000-row cap.
        for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
          const expectedCalls = api.list.mock.calls.length + 1;
          await userEvent.click(
            page.getByRole("button", { name: "Older burst references", exact: true }),
          );
          await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(expectedCalls));
          await vi.waitFor(() => expect(observed?.loading).toBe(false));
        }
        expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
          values.slice(-1_000).map((value) => value.reference.revisionId),
        );
        expect(observed?.hasOlder).toBe(initialCount === 1_000);
        expect(api.list).toHaveBeenCalledTimes(initialCount / 50 + 3);
        if (initialCount === 1_000) {
          // Reconstructing the capped latest window evicted a known tail. Its
          // original end cursor must not strand those rows; the exact gap page
          // continuation remains explicitly browseable all the way to row one.
          for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
            const calls = api.list.mock.calls.length + 1;
            await userEvent.click(
              page.getByRole("button", { name: "Older burst references", exact: true }),
            );
            await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(calls));
            await vi.waitFor(() => expect(observed?.loading).toBe(false));
            expect(observed?.entries).toHaveLength(1_000);
          }
          expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
            values.slice(0, 1_000).map((value) => value.reference.revisionId),
          );
          expect(observed?.hasOlder).toBe(false);
          expect(observed?.reviewingOlder).toBe(true);
        }
        expect(api.details).not.toHaveBeenCalled();
        expect(api.viewerTicket).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );
  it("retains the original gap boundary when a later burst refresh follows an in-flight older page", async () => {
    const api = installApi();
    const values = Array.from({ length: 250 }, (_, index): VisualizationTimelineEntry => ({
      ...entry,
      occurredAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
      reference: {
        ...entry.reference,
        revisionId: VisualizationRevisionId.make(
          `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
      },
    }));
    let publishedCount = 50;
    let deferredOlder = false;
    const pending = deferred<Awaited<ReturnType<typeof api.list>>>();
    let pendingPage: Awaited<ReturnType<typeof api.list>> | undefined;
    api.list.mockImplementation((input) => {
      const before = input.cursor ? Number(input.cursor.slice(-12)) : publishedCount + 1;
      const last = Math.min(publishedCount, before - 1);
      const first = Math.max(1, last - 49);
      const result = {
        entries: values.slice(first - 1, last).toReversed(),
        ...(first > 1
          ? { nextCursor: `50000000-0000-4000-8000-${String(first).padStart(12, "0")}` }
          : {}),
      };
      if (input.cursor && deferredOlder) {
        deferredOlder = false;
        pendingPage = result;
        return pending.promise;
      }
      return Promise.resolve(result);
    });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    function History() {
      const [revision, setRevision] = useState(0);
      const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
      useLayoutEffect(() => {
        observed = result;
      });
      return (
        <>
          <button onClick={result.loadOlder}>Older overlapping references</button>
          <button onClick={() => setRevision((value) => value + 1)}>
            Refresh overlapping references
          </button>
        </>
      );
    }
    const view = await render(<History />);
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      publishedCount = 170;
      await userEvent.click(
        page.getByRole("button", { name: "Refresh overlapping references", exact: true }),
      );
      await vi.waitFor(() =>
        expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
          values[169]!.reference.revisionId,
        ),
      );
      deferredOlder = true;
      await userEvent.click(
        page.getByRole("button", { name: "Older overlapping references", exact: true }),
      );
      await vi.waitFor(() => expect(pendingPage).toBeDefined());
      const beforeRefreshCalls = api.list.mock.calls.length;
      publishedCount = 250;
      await userEvent.click(
        page.getByRole("button", { name: "Refresh overlapping references", exact: true }),
      );
      expect(api.list).toHaveBeenCalledTimes(beforeRefreshCalls);
      pending.resolve(pendingPage!);
      await vi.waitFor(() =>
        expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
          values[249]!.reference.revisionId,
        ),
      );
      expect(api.list).toHaveBeenCalledTimes(beforeRefreshCalls + 1);
      for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
        const expectedCalls = api.list.mock.calls.length + 1;
        await userEvent.click(
          page.getByRole("button", { name: "Older overlapping references", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(expectedCalls));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
      }
      expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
        values.map((value) => value.reference.revisionId),
      );
      expect(observed?.hasOlder).toBe(false);
      expect(api.list).toHaveBeenCalledTimes(8);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      if (pendingPage) pending.resolve(pendingPage);
      await view.unmount();
    }
  });
  it("retains at most 1,000 compact references through explicit bounded pagination", async () => {
    const api = installApi();
    const values = Array.from({ length: 1_000 }, (_, index): VisualizationTimelineEntry => ({
      ...entry,
      reference: {
        ...entry.reference,
        revisionId: VisualizationRevisionId.make(
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
        title: `Compact chart ${index + 1}`,
      },
    }));
    // Synthetic retention stress exceeds the store's per-chat publication quota;
    // it qualifies the reader bound, not permission to publish 1,000 artifacts.
    const cursorFor = (index: number) =>
      `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    api.list.mockImplementation(async (input) => {
      const offset = input.cursor ? Number(input.cursor.slice(-12)) : 0;
      return {
        entries: values.slice(offset, offset + 50),
        ...(offset + 50 < values.length ? { nextCursor: cursorFor(offset + 50) } : {}),
      };
    });
    let firstReference: VisualizationTimelineEntry | undefined;
    let latestFirstReference: VisualizationTimelineEntry | undefined;
    let observedCount = 0;
    function History() {
      const [revision, setRevision] = useState("one");
      const result = useThreadVisualizations(environmentId, threadId, true, revision);
      observedCount = result.entries.length;
      firstReference ??= result.entries[0];
      latestFirstReference = result.entries[0];
      return (
        <>
          <button onClick={result.loadOlder}>Older compact references</button>
          <button onClick={() => setRevision("two")}>Refresh compact references</button>
          <output data-compact-count={result.entries.length} data-has-older={result.hasOlder} />
        </>
      );
    }
    const started = performance.now();
    const view = await render(<History />);
    try {
      await vi.waitFor(() => expect(observedCount).toBe(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Older compact references", exact: true }),
        );
        await vi.waitFor(() => expect(observedCount).toBe((pageIndex + 1) * 50));
      }
      expect(api.list).toHaveBeenCalledTimes(20);
      expect(document.querySelector("output")?.getAttribute("data-has-older")).toBe("false");
      await userEvent.click(
        page.getByRole("button", { name: "Older compact references", exact: true }),
      );
      expect(api.list).toHaveBeenCalledTimes(20);
      await userEvent.click(
        page.getByRole("button", { name: "Refresh compact references", exact: true }),
      );
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(21));
      expect(observedCount).toBe(1_000);
      expect(latestFirstReference).toBe(firstReference);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-history-qualification",
        JSON.stringify({
          references: observedCount,
          pageSize: 50,
          listRequests: api.list.mock.calls.length,
          compactJsonBytes: new TextEncoder().encode(JSON.stringify(values)).byteLength,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
  });
  it("coalesces a burst while one list request is in flight and ignores late old-chat results", async () => {
    let complete!: (value: { entries: VisualizationTimelineEntry[] }) => void;
    const api = installApi();
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    function History() {
      const [revision, setRevision] = useState("one");
      const [thread, setThread] = useState(threadId);
      const result = useThreadVisualizations(environmentId, thread, true, revision);
      return (
        <>
          <button
            onClick={() => {
              setRevision("two");
            }}
          >
            New event
          </button>
          <button onClick={() => setThread(ThreadId.make("another-chat"))}>Switch chat</button>
          <output>{result.entries.map((value) => value.reference.title).join(",")}</output>
        </>
      );
    }
    await render(<History />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "New event", exact: true }));
    expect(api.list).toHaveBeenCalledTimes(1);
    api.list.mockResolvedValue({ entries: [] });
    await userEvent.click(page.getByRole("button", { name: "Switch chat", exact: true }));
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    complete({ entries: [entry] });
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector("output")!.textContent).toBe("");
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
