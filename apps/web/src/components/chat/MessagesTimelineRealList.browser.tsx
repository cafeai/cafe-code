import "../../index.css";

import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledFollowupId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type ScheduledFollowupRecord,
} from "@cafecode/contracts";
import {
  GeneratedVisualizationReference,
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import * as Schema from "effect/Schema";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useCallback, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { MessagesTimeline } from "./MessagesTimeline";
import { refreshScheduledFollowups } from "./scheduledFollowupsResource";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type TimelineEntries = TimelineProps["timelineEntries"];

const CREATED_AT = "2026-09-20T12:00:00.000Z";
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const ignore = () => undefined;

function messages(scope: string, count = 40): TimelineEntries {
  return Array.from({ length: count }, (_, index) => ({
    id: `${scope}-entry-${index}`,
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(`${scope}-message-${index}`),
      role: "user" as const,
      text: `${scope} message ${index}\nA bounded synthetic message for the real virtualizer.`,
      createdAt: CREATED_AT,
      streaming: false,
    },
  }));
}

function growLastMessage(entries: TimelineEntries): TimelineEntries {
  return entries.map((entry, index) =>
    index === entries.length - 1 && entry.kind === "message"
      ? {
          ...entry,
          message: {
            ...entry.message,
            text: `${entry.message.text}\nAn additional measured line.\nThe final measured line.`,
          },
        }
      : entry,
  );
}

function compactVisualization(scope: string, index: number): TimelineEntries[number] {
  const identifier = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  return {
    id: `visualization:${scope}:${index}`,
    kind: "visualization",
    createdAt: CREATED_AT,
    visualization: {
      messageId: MessageId.make(`${scope}-artifact-message-${index}`),
      turnId: TurnId.make(`${scope}-artifact-turn`),
      originItemId: `${scope}-native-${index}`,
      occurredAt: CREATED_AT,
      actor: { type: "root" },
      reference: {
        version: 1,
        purpose: "generated-visualization",
        artifactId: VisualizationArtifactId.make(identifier),
        revisionId: VisualizationRevisionId.make(identifier),
        title: `${scope} chart ${index}`,
        width: 640,
        height: 120,
      },
    },
  };
}

/**
 * Exercise Cafe's real row rendering, ResizeObserver measurements and list ref.
 * Only the parent-owned follow decision is represented here: user review turns
 * it off, and a keyed thread change starts a fresh following view, as ChatView
 * does. No provider, backend transport or LegendList implementation is mocked.
 */
function TimelineFixture({
  entries,
  listRef,
  scope,
  scheduledFollowups,
}: {
  entries: TimelineEntries;
  listRef: TimelineProps["listRef"];
  scope: string;
  scheduledFollowups?: TimelineProps["scheduledFollowups"];
}) {
  const [following, setFollowing] = useState(true);
  const stopFollowing = useCallback(() => setFollowing(false), []);

  return (
    <div className="h-full min-h-0" data-real-list-following={following}>
      <MessagesTimeline
        activeThreadId={ThreadId.make(scope)}
        activeThreadEnvironmentId={EnvironmentId.make("real-list-fixture")}
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
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        {...(scheduledFollowups ? { scheduledFollowups } : {})}
        stickToEndRevision={0}
        timelineEntries={entries}
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.width = "min(760px, 100vw)";
  host.style.height = "360px";
  document.body.append(host);
  return host;
}

function readScroller(listRef: TimelineProps["listRef"]): HTMLElement {
  const scroller = listRef.current?.getScrollableNode();
  expect(scroller).toBeInstanceOf(HTMLElement);
  return scroller!;
}

function tailDistance(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

/** Native wheel input only: never change a reused worker's device/media policy. */
async function reviewWithNativeWheel(scroller: HTMLElement, deltaY = -500) {
  const bounds = scroller.getBoundingClientRect();
  let x = bounds.left + bounds.width / 2;
  let y = bounds.top + Math.min(bounds.height / 2, 100);
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY,
  });
}

function readMessage(host: HTMLElement, id: string): HTMLElement {
  const row = host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  expect(row).not.toBeNull();
  return row!;
}

async function expectTail(
  host: HTMLElement,
  listRef: TimelineProps["listRef"],
  lastMessageId: string,
  stage = "initial",
) {
  await vi.waitFor(() => {
    const scroller = readScroller(listRef);
    const row = readMessage(host, lastMessageId);
    const viewport = scroller.getBoundingClientRect();
    const message = row.getBoundingClientRect();
    const spacers = host.querySelectorAll<HTMLElement>("div.h-3.sm\\:h-4");
    expect(spacers).toHaveLength(2);
    const footerHeight = spacers[1]!.getBoundingClientRect().height;
    // Assert physical layout as well as identity. A mocked ref, a zero-height
    // viewport or an offscreen recycled row must not satisfy this smoke test.
    expect(scroller.clientHeight).toBeGreaterThan(200);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight + 500);
    // Cafe issues both scrollToEnd and last-row scrollToIndex. The latter can
    // align the last row rather than its trailing spacer. Admit only that
    // measured footer, never a viewport-sized threshold hiding missing rows.
    expect(Math.abs(tailDistance(scroller)), `${stage}: ${lastMessageId}`).toBeLessThanOrEqual(
      footerHeight + 4,
    );
    expect(message.bottom).toBeLessThanOrEqual(viewport.bottom + 2);
    expect(message.bottom).toBeGreaterThanOrEqual(viewport.bottom - footerHeight - 4);
  });
}

describe("MessagesTimeline with real LegendList", () => {
  it("preserves an exact overlap anchor when older review slides the 1,000-artifact window", async () => {
    const scope = "artifact-sliding-review";
    const host = createHost();
    const listRef = createRef<LegendListRef>();
    const userRows = messages(scope);
    const windowEntries = (first: number): TimelineEntries => [
      ...Array.from({ length: 1_000 }, (_, index) => compactVisualization(scope, first + index)),
      ...userRows,
    ];
    const view = await render(
      <TimelineFixture entries={windowEntries(50)} listRef={listRef} scope={scope} />,
      { container: host },
    );
    const started = performance.now();
    try {
      await expectTail(host, listRef, `${scope}-message-39`);
      const scroller = readScroller(listRef);
      // Traverse with ordinary finite wheel gestures, allowing the real list
      // to measure each newly mounted slice. A single huge synthetic jump can
      // land in an estimated, not yet measured window and is not a review anchor.
      for (let gesture = 0; gesture < 12; gesture += 1) {
        await reviewWithNativeWheel(scroller, -1_500);
        for (let frame = 0; frame < 4; frame += 1)
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      await vi.waitFor(() =>
        expect(host.querySelector('[data-real-list-following="false"]')).not.toBeNull(),
      );
      for (let frame = 0; frame < 4; frame += 1)
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      let anchor: HTMLElement | undefined;
      await vi.waitFor(() => {
        const viewport = scroller.getBoundingClientRect();
        anchor = Array.from(host.querySelectorAll<HTMLElement>("[data-visualization-card]")).find(
          (row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
          },
        );
        expect(
          anchor,
          JSON.stringify({
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            mountedCards: host.querySelectorAll("[data-visualization-card]").length,
            viewport: { top: viewport.top, bottom: viewport.bottom },
            cards: Array.from(host.querySelectorAll<HTMLElement>("[data-visualization-card]")).map(
              (row) => ({
                id: row.dataset.visualizationCard,
                top: row.getBoundingClientRect().top,
                bottom: row.getBoundingClientRect().bottom,
              }),
            ),
          }),
        ).toBeDefined();
      });
      const identifier = anchor!.dataset.visualizationCard!;
      const ordinal = Number(identifier.slice(-12));
      expect(ordinal).toBeGreaterThan(50);
      expect(ordinal).toBeLessThanOrEqual(1_000);
      const anchorTop = anchor!.getBoundingClientRect().top;
      await view.rerender(
        <TimelineFixture entries={windowEntries(0)} listRef={listRef} scope={scope} />,
      );
      await vi.waitFor(() => {
        const currentAnchor = host.querySelector<HTMLElement>(
          `[data-visualization-card="${identifier}"]`,
        );
        expect(currentAnchor).not.toBeNull();
        expect(currentAnchor!.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0);
        expect(host.querySelector('[data-real-list-following="false"]')).not.toBeNull();
      });
      const mountedCards = host.querySelectorAll("[data-visualization-card]").length;
      expect(mountedCards).toBeGreaterThan(0);
      expect(mountedCards).toBeLessThan(25);
      expect(host.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-sliding-list-qualification",
        JSON.stringify({
          compactReferences: 1_000,
          mountedCards,
          overlapOrdinal: ordinal,
          anchorDeltaPx: Number(
            (
              host
                .querySelector<HTMLElement>(`[data-visualization-card="${identifier}"]`)!
                .getBoundingClientRect().top - anchorTop
            ).toFixed(3),
          ),
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
      host.remove();
    }
  });
  it.each([true, false])(
    "keeps 1,000 compact artifacts virtualized with reserved geometry and tail following %s",
    async (following) => {
      const scope = following ? "artifact-follow" : "artifact-review";
      const host = createHost();
      const listRef = createRef<LegendListRef>();
      const userRows = messages(scope);
      let entries: TimelineEntries = Array.from({ length: 1_000 }, (_, index) => [
        compactVisualization(scope, index),
        ...(index >= 960 ? [userRows[index - 960]!] : []),
      ]).flat();
      const started = performance.now();
      const view = await render(
        <TimelineFixture entries={entries} listRef={listRef} scope={scope} />,
        { container: host },
      );
      try {
        await expectTail(host, listRef, `${scope}-message-39`);
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        const scroller = readScroller(listRef);
        scroller.scrollTop = scroller.scrollHeight;
        await vi.waitFor(() => expect(Math.abs(tailDistance(scroller))).toBeLessThanOrEqual(2));
        const mountedCards = host.querySelectorAll("[data-visualization-card]").length;
        expect(mountedCards).toBeGreaterThan(0);
        expect(mountedCards).toBeLessThan(25);
        expect(
          host.querySelector('[data-visualization-card="00000000-0000-4000-8000-000000000001"]'),
        ).toBeNull();
        const lastCard = host.querySelector<HTMLElement>(
          '[data-visualization-card="00000000-0000-4000-8000-000000001000"]',
        )!;
        const surface = lastCard.querySelector<HTMLElement>("[data-visualization-native-surface]")!;
        const reservedHeight = surface.getBoundingClientRect().height;
        const reservedWidth = surface.getBoundingClientRect().width;
        expect(reservedWidth).toBeGreaterThan(200);
        // The actual desktop-project viewport may be narrower than this host's
        // 760px maximum. Its intentional 80px minimum is still reserved geometry.
        expect(reservedHeight).toBeCloseTo(
          Math.max(80, Math.min(innerHeight * 0.7, 700, (reservedWidth * 120) / 640)),
          1,
        );
        // Late poster metadata has the same admitted dimensions. Its image
        // transport is unavailable in this isolated real-list fixture; the
        // reserved box must not collapse or cause a layout-driven tail jump.
        entries = entries.map((value) =>
          value.kind === "visualization" && value.id === `visualization:${scope}:999`
            ? {
                ...value,
                visualization: {
                  ...value.visualization,
                  reference: Schema.decodeUnknownSync(GeneratedVisualizationReference)({
                    ...value.visualization.reference,
                    poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 640, height: 120 },
                  }),
                },
              }
            : value,
        );
        await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope={scope} />);
        await vi.waitFor(() =>
          expect(surface.getBoundingClientRect().height).toBeCloseTo(reservedHeight, 1),
        );
        await expectTail(host, listRef, `${scope}-message-39`, "late poster metadata");
        if (!following) {
          await reviewWithNativeWheel(scroller);
          await vi.waitFor(() => {
            expect(host.querySelector('[data-real-list-following="false"]')).not.toBeNull();
            expect(tailDistance(scroller)).toBeGreaterThan(400);
          });
          // Let the real browser scroll event and recycled-row measurements
          // commit before choosing the review anchor; follow-mode state alone
          // is synchronous and does not attest the virtualizer's new viewport.
          for (let frame = 0; frame < 4; frame += 1) {
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
          }
        }
        const viewport = scroller.getBoundingClientRect();
        const anchor = Array.from(
          host.querySelectorAll<HTMLElement>("[data-message-id], [data-visualization-card]"),
        ).find((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
        });
        expect(anchor).toBeDefined();
        const anchorSelector = anchor!.dataset.messageId
          ? `[data-message-id="${anchor!.dataset.messageId}"]`
          : `[data-visualization-card="${anchor!.dataset.visualizationCard}"]`;
        const previousTop = scroller.scrollTop;
        const previousAnchorTop = anchor!.getBoundingClientRect().top;
        entries = [...entries, compactVisualization(scope, 1_000), messages(scope, 41)[40]!];
        await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope={scope} />);
        if (following) await expectTail(host, listRef, `${scope}-message-40`, "artifact append");
        else
          await vi.waitFor(() => {
            // Recycled rows may replace their DOM node while keeping the same
            // logical item. Bind review preservation to that exact item and
            // physical pixels, not the obsolete node or estimated scroll sum.
            const currentAnchor = host.querySelector<HTMLElement>(anchorSelector);
            expect(currentAnchor).not.toBeNull();
            expect(
              currentAnchor!.getBoundingClientRect().top,
              JSON.stringify({
                previousTop,
                currentTop: scroller.scrollTop,
                previousAnchorTop,
                currentAnchorTop: currentAnchor!.getBoundingClientRect().top,
              }),
            ).toBeCloseTo(previousAnchorTop, 0);
            expect(host.querySelector('[data-real-list-following="false"]')).not.toBeNull();
            expect(tailDistance(scroller)).toBeGreaterThan(400);
          });
        expect(host.querySelector("iframe")).toBeNull();
        expect(host.textContent).not.toContain("private-json-marker");
        console.info(
          "visualization-real-list-qualification",
          JSON.stringify({
            following,
            compactReferences: 1_000,
            mountedCards,
            reservedHeight,
            observedMs: Number((performance.now() - started).toFixed(2)),
          }),
        );
      } finally {
        await view.unmount();
        host.remove();
      }
    },
  );
  it.each([true, false])(
    "preserves the real scroll position when a proposal arrives with tail following %s",
    async (following) => {
      const scope = following ? "schedule-follow" : "schedule-review";
      const environmentId = EnvironmentId.make("real-list-fixture");
      const threadId = ThreadId.make(scope);
      const instanceId = ProviderInstanceId.make("real-list-schedule-account");
      const context = {
        environmentId,
        threadId,
        provider: null,
        modelSelection: { instanceId, model: "gpt-6-astra" },
        unavailable: false,
      };
      let records: readonly ScheduledFollowupRecord[] = [];
      const list = vi.fn(async () => ({ schedules: records, backendOnline: true }));
      __setEnvironmentApiOverrideForTests(environmentId, {
        scheduledFollowups: { list },
      } as unknown as EnvironmentApi);
      const host = createHost();
      const listRef = createRef<LegendListRef>();
      const view = await render(
        <TimelineFixture
          entries={messages(scope)}
          listRef={listRef}
          scope={scope}
          scheduledFollowups={context}
        />,
        { container: host },
      );
      try {
        await vi.waitFor(() => {
          expect(list).toHaveBeenCalledTimes(1);
          expect(host.querySelector("[data-scheduled-followup-notices]")).toBeNull();
        });
        await expectTail(host, listRef, `${scope}-message-39`);
        // Finish the initial alignment frames before exercising independent
        // footer growth, then place the real browser at the physical tail.
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        const scroller = readScroller(listRef);
        scroller.scrollTop = scroller.scrollHeight;
        await vi.waitFor(() => expect(Math.abs(tailDistance(scroller))).toBeLessThanOrEqual(2));
        if (!following) {
          scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
          scroller.scrollTop -= 500;
          await vi.waitFor(() => {
            expect(host.querySelector('[data-real-list-following="false"]')).not.toBeNull();
            expect(tailDistance(scroller)).toBeGreaterThan(400);
          });
        }
        const previousTop = scroller.scrollTop;
        const viewportBefore = scroller.getBoundingClientRect();
        const visibleMessage = Array.from(
          host.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).find((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= viewportBefore.top && bounds.bottom <= viewportBefore.bottom;
        });
        expect(visibleMessage).toBeDefined();
        const visibleMessageId = visibleMessage!.dataset.messageId!;
        const previousMessageTop = visibleMessage!.getBoundingClientRect().top;
        records = [
          {
            id: ScheduledFollowupId.make("11111111-1111-4111-8111-111111111111"),
            threadId,
            revision: 1,
            state: "pending_confirmation",
            name: "Synthetic proposal at the conversation tail",
            prompt: "Check synthetic results only.",
            recurrence: {
              kind: "interval",
              anchorAt: CREATED_AT,
              everyMinutes: 5,
              timeZone: "UTC",
            },
            modelSelection: null,
            notificationPolicy: "changes-and-errors",
            endAt: null,
            maxRuns: null,
            allowAutoFinish: false,
            authorizedInstanceId: instanceId,
            permissionCeiling: "approval-required",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            nextRunAt: null,
            runCount: 0,
            lastRun: null,
          },
        ];
        refreshScheduledFollowups(environmentId, threadId);
        await vi.waitFor(() => {
          expect(host.querySelector("[data-scheduled-followup-notices] article")).not.toBeNull();
        });
        // Let actual ResizeObserver/list measurement settle before asserting the
        // anchor: an immediate assertion could pass before the footer was sized.
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        if (following) {
          await vi.waitFor(() => {
            const viewport = scroller.getBoundingClientRect();
            const review = host.querySelector<HTMLButtonElement>(
              'button[aria-label="Review schedule: Synthetic proposal at the conversation tail"]',
            );
            expect(review).not.toBeNull();
            expect(review!.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
            expect(review!.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom + 2);
            expect(Math.abs(tailDistance(scroller))).toBeLessThanOrEqual(2);
          });
        } else {
          expect(Math.abs(scroller.scrollTop - previousTop)).toBeLessThanOrEqual(2);
          expect(
            Math.abs(
              readMessage(host, visibleMessageId).getBoundingClientRect().top - previousMessageTop,
            ),
          ).toBeLessThanOrEqual(2);
          expect(tailDistance(scroller)).toBeGreaterThan(400);
        }
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        await view.unmount();
        host.remove();
        __resetEnvironmentApiOverridesForTests();
      }
    },
  );

  it("opens at the newest message and follows appended rows and row growth", async () => {
    const host = createHost();
    const listRef = createRef<LegendListRef>();
    let entries = messages("follow");
    const view = await render(
      <TimelineFixture entries={entries} listRef={listRef} scope="follow" />,
      { container: host },
    );
    try {
      await expectTail(host, listRef, "follow-message-39");
      // Forty rows exceed both the viewport and the small default buffer: this
      // must be an actual virtualized window, not an eagerly rendered fixture.
      expect(host.querySelector('[data-message-id="follow-message-0"]')).toBeNull();

      // Following is conditional on the physical tail. The initial last-row
      // target can leave its footer below the viewport; explicitly reach that
      // tail before testing the distinct append/measurement-follow contract.
      // Let Cafe's three initial alignment frames finish before this movement.
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      const scroller = readScroller(listRef);
      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => {
        expect(Math.abs(tailDistance(scroller))).toBeLessThanOrEqual(2);
        expect(listRef.current?.getState().isAtEnd).toBe(true);
      });

      entries = messages("follow", 41);
      await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope="follow" />);
      await expectTail(host, listRef, "follow-message-40", "append");
      const previousHeight = readMessage(host, "follow-message-40").getBoundingClientRect().height;

      entries = growLastMessage(entries);
      await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope="follow" />);
      await vi.waitFor(() => {
        expect(
          readMessage(host, "follow-message-40").getBoundingClientRect().height,
        ).toBeGreaterThan(previousHeight + 20);
      });
      await expectTail(host, listRef, "follow-message-40", "row growth");
    } finally {
      await view.unmount();
      host.remove();
    }
  });

  it("reuses the parent ref across keyed thread changes without retaining old rows or scroll targets", async () => {
    const host = createHost();
    const listRef = createRef<LegendListRef>();
    const view = await render(
      <TimelineFixture key="first" entries={messages("first")} listRef={listRef} scope="first" />,
      { container: host },
    );
    try {
      await expectTail(host, listRef, "first-message-39");
      const previousScroller = readScroller(listRef);
      await view.rerender(
        <TimelineFixture
          key="second"
          entries={messages("second", 24)}
          listRef={listRef}
          scope="second"
        />,
      );
      await expectTail(host, listRef, "second-message-23");
      expect(readScroller(listRef)).not.toBe(previousScroller);
      expect(previousScroller.isConnected).toBe(false);
      expect(host.querySelector('[data-message-id^="first-message-"]')).toBeNull();
    } finally {
      await view.unmount();
      host.remove();
    }
  });
});
