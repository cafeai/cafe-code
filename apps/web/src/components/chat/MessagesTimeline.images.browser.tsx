import "../../index.css";

import { EnvironmentId, MessageId, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useCallback, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import { cdp } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";

const mocks = vi.hoisted(() => ({ fileRequest: vi.fn() }));
vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: mocks.fileRequest,
}));

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
const CREATED_AT = "2026-10-14T12:00:00.000Z";
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const ignore = () => undefined;
const entries: TimelineProps["timelineEntries"] = Array.from({ length: 12 }, (_, index) => ({
  id: `image-entry-${index}`,
  kind: "message" as const,
  createdAt: CREATED_AT,
  message: {
    id: MessageId.make(`image-message-${index}`),
    role: "assistant" as const,
    text: Array.from(
      { length: 3 },
      (_, image) => `![Image ${index}-${image}](/repo/picture-${image}.png)`,
    ).join("\n\n"),
    createdAt: CREATED_AT,
    streaming: false,
  },
}));

// Keep the real Markdown renderer, transfer admission, ResizeObserver and
// LegendList. Only authenticated image responses are synthetic; no provider
// or user profile participates in this layout qualification.
function ImageTimeline({
  listRef,
  revision,
  onDebugScrollEvent,
  provider = "codex",
}: {
  listRef: TimelineProps["listRef"];
  revision: number;
  onDebugScrollEvent: NonNullable<TimelineProps["onDebugScrollEvent"]>;
  provider?: string;
}) {
  const [following, setFollowing] = useState(true);
  const stopFollowing = useCallback(() => setFollowing(false), []);
  return (
    <div
      className="h-full min-h-0"
      data-image-list-following={following}
      data-image-list-revision={revision}
    >
      <MessagesTimeline
        activeThreadId={ThreadId.make("image-chat")}
        activeThreadEnvironmentId={EnvironmentId.make("image-fixture")}
        activeProvider={ProviderDriverKind.make(provider)}
        activeTurnId={null}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        autoFollowTail={following}
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking={false}
        listRef={listRef}
        markdownCwd="/repo"
        additionalWorkspaceRoots={[`/repo/related-${revision}`]}
        skills={[{ name: "research", displayName: `Research ${revision}` }]}
        onDebugScrollEvent={onDebugScrollEvent}
        onImageExpand={ignore}
        onIsAtEndChange={ignore}
        onRevertUserMessage={ignore}
        onUserScrollIntent={stopFollowing}
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        stickToEndRevision={0}
        timelineEntries={entries}
        timestampFormat="24-hour"
        workspaceRoot="/repo"
      />
    </div>
  );
}

interface HeldTransfer {
  readonly promise: Promise<Response>;
  readonly retire: () => void;
}
interface ImageFixtureState {
  holdTransfers: boolean;
  retired: boolean;
  readonly heldTransfers: Set<HeldTransfer>;
}
let imageFixture: ImageFixtureState | undefined;
let activeImageOwner: { readonly cleanup: () => Promise<void> } | undefined;
beforeEach(() => {
  // A timed-out prior hook is not authority to replace its still-owned DOM,
  // native input, or transfer mocks.
  if (activeImageOwner) throw new Error("The prior image timeline fixture is still retiring.");
  const ownedFixture: ImageFixtureState = {
    holdTransfers: false,
    retired: false,
    heldTransfers: new Set(),
  };
  imageFixture = ownedFixture;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#408060";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (character) =>
    character.charCodeAt(0),
  );
  const manifest = Array.from({ length: 3 }, (_, index) => ({
    source: `/repo/picture-${index}.png`,
    mimeType: "image/png",
    width: canvas.width,
    height: canvas.height,
    sizeBytes: bytes.length,
  }));
  mocks.fileRequest.mockReset();
  mocks.fileRequest.mockImplementation((_environment, _path, init: RequestInit, params) => {
    if (ownedFixture.retired) return Promise.reject(new Error("cancelled"));
    if (ownedFixture.holdTransfers) {
      let rejectTransfer!: (error: Error) => void;
      const promise = new Promise<Response>((_resolve, reject) => {
        rejectTransfer = reject;
      });
      let settled = false;
      const retire = () => {
        if (settled) return;
        settled = true;
        init.signal?.removeEventListener("abort", retire);
        rejectTransfer(new Error("cancelled"));
      };
      const held = { promise, retire };
      ownedFixture.heldTransfers.add(held);
      void promise.then(
        () => ownedFixture.heldTransfers.delete(held),
        () => ownedFixture.heldTransfers.delete(held),
      );
      if (init.signal?.aborted) retire();
      else init.signal?.addEventListener("abort", retire, { once: true });
      return promise;
    }
    return Promise.resolve(
      params.source
        ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } })
        : new Response(JSON.stringify(manifest)),
    );
  });
});
afterEach(async () => {
  // Vitest calls this shared hook before onTestFinished. Join the exact same
  // owner before releasing mocks or permitting the next fixture to start. An
  // unproved unmount retains ownership and never authorizes a mock reset.
  await activeImageOwner?.cleanup();
  vi.restoreAllMocks();
  imageFixture = undefined;
});

function createImageOwner(context: TestContext, fixture: ImageFixtureState) {
  if (activeImageOwner) throw new Error("An image timeline fixture is already owned.");
  const signal = context.signal;
  const pending = new Set<Promise<unknown>>();
  let retired = false;
  let host: HTMLDivElement | undefined;
  let rendering: ReturnType<typeof render> | undefined;
  let removeReviewListeners: (() => void) | undefined;
  let completion: Promise<void> | undefined;
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("The exact image timeline fixture was retired.");
  };
  const own = async <T,>(start: () => PromiseLike<T>): Promise<T> => {
    assertActive();
    const original = Promise.resolve(start());
    pending.add(original);
    try {
      const result = await original;
      assertActive();
      return result;
    } finally {
      pending.delete(original);
    }
  };
  const cleanup = () => {
    if (completion) return completion;
    retired = true;
    fixture.retired = true;
    signal.removeEventListener("abort", onAbort);
    completion = Promise.resolve().then(async () => {
      // No new operations can be admitted after retirement. Join the original
      // native actions and rendering before unmounting their exact target.
      while (pending.size) await Promise.allSettled([...pending]);
      removeReviewListeners?.();
      const view = await rendering?.catch(() => undefined);
      await view?.unmount();
      // Stalled transfer negatives remain held throughout the test. After the
      // exact unmount, retire any that did not receive their native abort and
      // join their original promises before this fixture can release mocks.
      const heldTransfers = [...fixture.heldTransfers];
      for (const held of heldTransfers) held.retire();
      await Promise.allSettled(heldTransfers.map((held) => held.promise));
      // A rejected unmount cannot release this owner's host or mock boundary.
      host?.remove();
      if (activeImageOwner?.cleanup === cleanup) activeImageOwner = undefined;
    });
    return completion;
  };
  const onAbort = () => {
    void cleanup().catch(() => undefined);
  };
  activeImageOwner = { cleanup };
  context.onTestFinished(cleanup);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    assertActive,
    isActive: () => !retired && !signal.aborted,
    own,
    cleanup,
    setHost(value: HTMLDivElement) {
      assertActive();
      host = value;
    },
    setRendering(value: ReturnType<typeof render>) {
      // Retain even a render that was admitted just before retirement; its
      // eventual screen still belongs to this owner and must be unmounted.
      rendering = value;
      assertActive();
    },
    setReviewCleanup(value: () => void) {
      assertActive();
      removeReviewListeners = value;
    },
  };
}

async function paint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function reviewWithNativeWheel(scroller: HTMLElement, assertActive: () => void) {
  const bounds = scroller.getBoundingClientRect();
  let x = bounds.left + bounds.width / 2;
  let y = bounds.top + bounds.height / 2;
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  // A timed-out mouse move cannot admit the separate wheel operation later.
  assertActive();
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: -300,
  });
}

it.for(["tail", "review"] as const)(
  "keeps loaded images and the physical %s position through chat presentation updates",
  async (mode, context) => {
    const fixture = imageFixture;
    if (!fixture) throw new Error("The image timeline fixture was not initialized.");
    const owner = createImageOwner(context, fixture);
    let initialImageListLoad = false;
    // Retain one exact-case callback across both renders; a retired caller
    // cannot mint a readiness observation for itself or a successor.
    const onDebugScrollEvent: NonNullable<TimelineProps["onDebugScrollEvent"]> = (event) => {
      if (owner.isActive() && event.reason === "initial-list-load") initialImageListLoad = true;
    };
    const host = document.createElement("div");
    owner.setHost(host);
    host.style.width = "min(760px, 100vw)";
    host.style.height = "360px";
    document.body.append(host);
    const listRef = createRef<LegendListRef>();
    const rendering = render(
      <ImageTimeline listRef={listRef} revision={0} onDebugScrollEvent={onDebugScrollEvent} />,
      {
        container: host,
      },
    );
    owner.setRendering(rendering);
    let bodyFailed = false;
    try {
      const view = await owner.own(() => rendering);
      await owner.own(() =>
        vi.waitFor(() => {
          owner.assertActive();
          const scroller = listRef.current?.getScrollableNode();
          expect(scroller).toBeInstanceOf(HTMLElement);
          expect(scroller!.clientHeight).toBeGreaterThan(200);
          expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight + 1_000);
          expect(host.querySelector('img[alt="Image 11-2"]')).not.toBeNull();
          expect(
            scroller!.scrollHeight - scroller!.clientHeight - scroller!.scrollTop,
          ).toBeLessThan(20);
        }),
      );
      await owner.own(() =>
        vi.waitFor(() => {
          owner.assertActive();
          expect(initialImageListLoad).toBe(true);
        }),
      );
      const scroller = listRef.current!.getScrollableNode()!;
      if (mode === "review") {
        const beforeWheel = scroller.scrollTop;
        let witnessedWheel = false;
        let completedScrollTop: number | undefined;
        const observeWheel = (event: WheelEvent) => {
          if (
            owner.isActive() &&
            event.isTrusted &&
            event.currentTarget === scroller &&
            event.deltaY === -300
          )
            witnessedWheel = true;
        };
        const observeScrollEnd = (event: Event) => {
          if (
            owner.isActive() &&
            witnessedWheel &&
            event.isTrusted &&
            event.target === scroller &&
            scroller.scrollTop < beforeWheel
          )
            completedScrollTop = scroller.scrollTop;
        };
        const removeListeners = () => {
          scroller.removeEventListener("wheel", observeWheel);
          scroller.removeEventListener("scrollend", observeScrollEnd);
        };
        // Install on the exact target before the original native gesture. The
        // intent flag alone precedes physical movement and cannot own a review
        // baseline; only the trusted completed scroll may do so.
        owner.setReviewCleanup(removeListeners);
        scroller.addEventListener("wheel", observeWheel);
        scroller.addEventListener("scrollend", observeScrollEnd);
        try {
          await owner.own(() => reviewWithNativeWheel(scroller, owner.assertActive));
          await owner.own(() =>
            vi.waitFor(() => {
              owner.assertActive();
              expect(host.querySelector('[data-image-list-following="false"]')).not.toBeNull();
              expect(witnessedWheel).toBe(true);
              expect(completedScrollTop).toBeDefined();
              expect(scroller.scrollTop).toBeLessThan(beforeWheel);
              expect(scroller.scrollTop).toBeCloseTo(completedScrollTop!, 0);
              expect(
                scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
              ).toBeGreaterThan(20);
            }),
          );
        } finally {
          removeListeners();
        }
      }
      await owner.own(() =>
        vi.waitFor(() => {
          owner.assertActive();
          expect(host.querySelectorAll(".chat-markdown button img").length).toBeGreaterThanOrEqual(
            3,
          );
          expect(
            host.querySelectorAll('.chat-markdown button[aria-label^="Enlarge"]'),
          ).toHaveLength(host.querySelectorAll(".chat-markdown > p").length);
        }),
      );

      const images = Array.from(host.querySelectorAll<HTMLImageElement>(".chat-markdown img"));
      // Own each original decode independently. Promise.all rejects on the
      // first failure, but the other native decodes can still be running and
      // must settle before this owner unmounts their elements.
      await Promise.all(images.map((image) => owner.own(() => image.decode())));
      const viewport = scroller.getBoundingClientRect();
      const anchor = images.find((image) => {
        const bounds = image.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      expect(anchor).toBeDefined();
      const anchorTop = anchor!.getBoundingClientRect().top;
      const anchorHeight = anchor!.getBoundingClientRect().height;
      const anchorRow = anchor!.closest<HTMLElement>("[data-message-id]")!;
      const rowTop = anchorRow.getBoundingClientRect().top;
      const rowHeight = anchorRow.getBoundingClientRect().height;
      expect(anchorHeight).toBeGreaterThan(180);
      expect(anchor!.getBoundingClientRect().width / anchorHeight).toBeCloseTo(640 / 400, 1);
      const sources = images.map((image) => image.src);
      const requestCount = mocks.fileRequest.mock.calls.length;
      const scrollTop = scroller.scrollTop;
      const revoked = vi.spyOn(URL, "revokeObjectURL");
      // Any accidental remount now stalls in the normal two-slot transfer
      // queue, exposing its placeholder collapse instead of hiding a flicker
      // behind instant local responses.
      fixture.holdTransfers = true;
      await owner.own(() =>
        view.rerender(
          <ImageTimeline
            listRef={listRef}
            revision={1}
            provider="grok"
            onDebugScrollEvent={onDebugScrollEvent}
          />,
        ),
      );
      await owner.own(() =>
        vi.waitFor(() => {
          owner.assertActive();
          expect(host.querySelector('[data-image-list-revision="1"]')).not.toBeNull();
          expect(
            anchorRow.getBoundingClientRect().height,
            JSON.stringify({
              mode,
              scrollDelta: scroller.scrollTop - scrollTop,
              rowTopDelta: anchorRow.getBoundingClientRect().top - rowTop,
              rowHeightDelta: anchorRow.getBoundingClientRect().height - rowHeight,
            }),
          ).toBeCloseTo(rowHeight, 0);
          expect(anchorRow.getBoundingClientRect().top).toBeCloseTo(rowTop, 0);
          expect(anchor!.isConnected).toBe(true);
          expect(anchor!.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0);
          expect(anchor!.getBoundingClientRect().height).toBeCloseTo(anchorHeight, 0);
          expect(
            host.querySelector(`[data-image-list-following="${mode === "tail"}"]`),
          ).not.toBeNull();
        }),
      );
      // LegendList may reorder its retained row containers without replacing
      // their images or moving the visible anchor. Bind the complete image set
      // by object identity rather than the virtualizer's physical DOM order.
      const retainedImages = Array.from(
        host.querySelectorAll<HTMLImageElement>(".chat-markdown img"),
      );
      expect(retainedImages).toHaveLength(images.length);
      const originalImages = new Set(images);
      for (const image of retainedImages) expect(originalImages.has(image)).toBe(true);
      expect(images.map((image) => image.src)).toEqual(sources);
      expect(mocks.fileRequest).toHaveBeenCalledTimes(requestCount);
      expect(revoked).not.toHaveBeenCalled();
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      try {
        await owner.cleanup();
      } catch (error) {
        // Keep the original body failure; the shared hook still joins and
        // reports this same rejected cleanup without resetting its mocks.
        if (!bodyFailed) throw error;
      }
    }
  },
);
