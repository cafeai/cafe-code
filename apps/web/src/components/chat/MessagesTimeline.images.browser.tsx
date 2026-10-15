import "../../index.css";

import { EnvironmentId, MessageId, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useCallback, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";
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
}: {
  listRef: TimelineProps["listRef"];
  revision: number;
}) {
  const [following, setFollowing] = useState(true);
  const stopFollowing = useCallback(() => setFollowing(false), []);
  return (
    <div className="h-full min-h-0" data-image-list-following={following}>
      <MessagesTimeline
        activeThreadId={ThreadId.make("image-chat")}
        activeThreadEnvironmentId={EnvironmentId.make("image-fixture")}
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
        markdownCwd="/repo"
        additionalWorkspaceRoots={[`/repo/related-${revision}`]}
        skills={[{ name: "research", displayName: `Research ${revision}` }]}
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

let holdTransfers = false;
beforeEach(() => {
  holdTransfers = false;
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
    if (holdTransfers) {
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) reject(new Error("cancelled"));
        else
          init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
      });
    }
    return Promise.resolve(
      params.source
        ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } })
        : new Response(JSON.stringify(manifest)),
    );
  });
});
afterEach(() => vi.restoreAllMocks());

async function paint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function reviewWithNativeWheel(scroller: HTMLElement) {
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
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY: -300,
  });
}

it.each(["tail", "review"] as const)(
  "keeps loaded images and the physical %s position through chat presentation updates",
  async (mode) => {
    const host = document.createElement("div");
    host.style.width = "min(760px, 100vw)";
    host.style.height = "360px";
    document.body.append(host);
    const listRef = createRef<LegendListRef>();
    const view = await render(<ImageTimeline listRef={listRef} revision={0} />, {
      container: host,
    });
    try {
      await vi.waitFor(() => {
        const scroller = listRef.current?.getScrollableNode();
        expect(scroller).toBeInstanceOf(HTMLElement);
        expect(scroller!.clientHeight).toBeGreaterThan(200);
        expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight + 1_000);
        expect(host.querySelector('img[alt="Image 11-2"]')).not.toBeNull();
        expect(scroller!.scrollHeight - scroller!.clientHeight - scroller!.scrollTop).toBeLessThan(
          20,
        );
      });
      const scroller = listRef.current!.getScrollableNode()!;
      if (mode === "review") {
        await reviewWithNativeWheel(scroller);
        await vi.waitFor(() =>
          expect(host.querySelector('[data-image-list-following="false"]')).not.toBeNull(),
        );
      }
      await vi.waitFor(() => {
        expect(host.querySelectorAll(".chat-markdown button img").length).toBeGreaterThanOrEqual(3);
        expect(host.querySelectorAll('.chat-markdown button[aria-label^="Enlarge"]')).toHaveLength(
          host.querySelectorAll(".chat-markdown > p").length,
        );
      });
      for (let frame = 0; frame < 8; frame++) await paint();
      const images = Array.from(host.querySelectorAll<HTMLImageElement>(".chat-markdown img"));
      await Promise.all(images.map((image) => image.decode()));
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
      holdTransfers = true;
      await view.rerender(<ImageTimeline listRef={listRef} revision={1} />);
      for (let frame = 0; frame < 12; frame++) {
        await paint();
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
      }
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
    } finally {
      await view.unmount();
      host.remove();
    }
  },
);
