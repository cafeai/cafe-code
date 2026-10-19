import {
  CHAT_IMAGES_PATH,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type RuntimeMode,
} from "@cafecode/contracts";
import type {
  VisualizationDetailsResult,
  VisualizationInlineResult,
  VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import {
  GeneratedVisualizationReference,
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";
import type { LegendListRef } from "@legendapp/list/react";
import * as Schema from "effect/Schema";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page, userEvent } from "vitest/browser";
import { fileRequest } from "../../attachments/fileAttachments";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import "../../index.css";
import { deriveTimelineEntries } from "../../session-logic";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { VisualizationCard } from "./VisualizationCard";
import { visualizationClippingAncestors, visualizationGeometry } from "./visualizationGeometry";
import { readVisualizationPosterAccounting } from "./visualizationPoster";
import {
  VisualizationViewerProvider,
  readInlineVisualizationPoolDiagnostics,
  useVisualizationScope,
} from "./VisualizationViewerProvider";

vi.mock("../../attachments/fileAttachments", async (original) => ({
  ...(await original<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: vi.fn(),
}));
const copy = vi.fn(async (_value: string) => undefined),
  download = vi.fn((_value: string) => () => undefined);
vi.mock("../../lib/copyToClipboard", () => ({
  copyTextToClipboard: (value: string) => copy(value),
}));
vi.mock("./visualizationDownload", () => ({
  downloadPortableVisualization: (value: string) => download(value),
}));
const environmentId = EnvironmentId.make("inline-visualization-environment"),
  threadId = ThreadId.make("inline-visualization-chat");
const artifactId = VisualizationArtifactId.make("8bdd2475-78f0-4563-9829-f29b073c0689"),
  revisionId = VisualizationRevisionId.make("4e27bd63-c586-4f50-99b5-a722994d41dc");
const entry: VisualizationTimelineEntry = {
  messageId: MessageId.make("inline-chart-message"),
  turnId: TurnId.make("inline-chart-turn"),
  originItemId: "inline-chart-call",
  occurredAt: "2026-10-12T12:14:15.000Z",
  actor: { type: "child", id: "inline-chart-child", label: "Layout reviewer" },
  reference: Schema.decodeUnknownSync(GeneratedVisualizationReference)({
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    title: "Revenue explorer",
    width: 640,
    height: 240,
    poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 16, height: 16 },
  }),
};
const source = `<main style="height:360px;padding:16px"><h2>Live chart</h2><button id="counter">Change range</button><output id="count">0</output><div style="height:240px"><svg viewBox="0 0 640 240" width="100%" height="240"><rect width="640" height="240" fill="var(--chart-1)"/><text x="30" y="50" fill="var(--foreground)">Visible data</text></svg></div></main><script>document.querySelector('#counter').onclick=()=>{const output=document.querySelector('#count');output.value=String(Number(output.value)+1)};</script>`;
const privateDetails: VisualizationDetailsResult = {
  threadId,
  artifactId,
  revisionId,
  source: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    source: "<script>window.__privateExecuted=true</script><p>private-source-marker</p>",
    assets: [],
  },
  diagnostics: {
    version: 1,
    artifactId,
    revisionId,
    records: [{ classification: "capture-failed", message: "private-diagnostic-marker" }],
    truncated: false,
  },
  rawJson: '{"private-json-marker":"<img src=x onerror=alert(1)>"}',
};
const originalBridge = window.desktopBridge,
  originalLocale = getUiLocale();
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function installApi() {
  const inline = vi.fn<NonNullable<NonNullable<EnvironmentApi["visualizations"]>["inline"]>>(
    async (input) => ({
      ...input,
      purpose: "generated-visualization",
      fullAccess: true,
      html: source,
      frameId: crypto.randomUUID(),
      ticket: "a".repeat(64),
      expiresAtMs: Date.now() + 30_000,
    }),
  );
  const touchInlineFrame = vi.fn<
    NonNullable<NonNullable<EnvironmentApi["visualizations"]>["touchInlineFrame"]>
  >(async ({ ticket: _ticket, ...input }) => ({ ...input, expiresAtMs: Date.now() + 30_000 }));
  const retireInlineFrame = vi.fn<
    NonNullable<NonNullable<EnvironmentApi["visualizations"]>["retireInlineFrame"]>
  >(async ({ ticket: _ticket, ...input }) => ({ ...input, retired: true }));
  const details = vi.fn(async () => privateDetails),
    exportHtml = vi.fn(async () => ({
      threadId,
      artifactId,
      revisionId,
      html: "<p>portable-source-marker</p>",
    }));
  const viewerTicket = vi.fn();
  const api = {
    visualizations: {
      inline,
      touchInlineFrame,
      retireInlineFrame,
      details,
      exportHtml,
      viewerTicket,
      list: vi.fn(async () => ({ entries: [entry] })),
    },
  };
  __setEnvironmentApiOverrideForTests(environmentId, api as unknown as EnvironmentApi);
  return { ...api.visualizations, api };
}
function Fixture({
  value = entry,
  permission = "full-access",
  ready = true,
  width = 900,
  count = 1,
  scroll = false,
  actions,
}: {
  value?: VisualizationTimelineEntry;
  permission?: RuntimeMode | null;
  ready?: boolean;
  width?: number;
  count?: number;
  scroll?: boolean;
  actions?: {
    changePermission?: (value: RuntimeMode | null) => void;
    complete?: () => void;
    recycle?: () => void;
  };
}) {
  const [mode, setMode] = useState(permission),
    [admitted, setAdmitted] = useState(ready),
    [mounted, setMounted] = useState(true);
  if (actions) {
    actions.changePermission = setMode;
    actions.complete = () => setAdmitted(true);
    actions.recycle = () => setMounted((old) => !old);
  }
  return (
    <VisualizationViewerProvider>
      <div
        data-inline-fixture
        style={{
          width,
          maxWidth: "100%",
          height: scroll ? 500 : undefined,
          overflow: scroll ? "auto" : undefined,
        }}
      >
        {mounted
          ? Array.from({ length: count }, (_, index) => (
              <VisualizationCard
                key={index}
                environmentId={environmentId}
                threadId={threadId}
                entry={
                  index === 0
                    ? value
                    : {
                        ...value,
                        originItemId: `inline-chart-${index}`,
                        reference: { ...value.reference, title: `Chart ${index}`, height: 80 },
                      }
                }
                timestampFormat="24-hour"
                runtimeMode={mode}
                generatedAdmissionReady={admitted}
              />
            ))
          : null}
        {scroll ? <div style={{ height: 900 }} /> : null}
      </div>
    </VisualizationViewerProvider>
  );
}
/** The real anchor begins in IO's threshold-zero intersecting bucket, but its
 * fractional crop contains no admitted whole CSS pixel. Native scrolling or
 * resizing the clipping parent must wake fresh geometry within that bucket. */
function FractionalEdgeFixture() {
  const scroller = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const parent = scroller.current!,
      spacer = parent.querySelector<HTMLElement>("[data-edge-spacer]")!,
      anchor = parent.querySelector<HTMLElement>("[data-visualization-inline-surface]")!;
    spacer.style.height = `${spacer.getBoundingClientRect().height + parent.getBoundingClientRect().bottom - 0.25 - anchor.getBoundingClientRect().top}px`;
  }, []);
  return (
    <VisualizationViewerProvider>
      <div
        ref={scroller}
        data-fractional-edge
        style={{ width: 700, maxWidth: "100%", height: 200, overflow: "auto" }}
      >
        <div data-edge-spacer style={{ height: 180 }} />
        <VisualizationCard
          environmentId={environmentId}
          threadId={threadId}
          entry={entry}
          timestampFormat="24-hour"
          runtimeMode="full-access"
        />
        <div style={{ height: 600 }} />
      </div>
    </VisualizationViewerProvider>
  );
}
function RealTimeline({ completed }: { completed: () => void }) {
  const list = useRef<LegendListRef | null>(null);
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 900, maxWidth: "100%", height: 700 }}>
        <MessagesTimeline
          activeThreadId={threadId}
          activeThreadEnvironmentId={environmentId}
          activeProvider={ProviderDriverKind.make("codex")}
          visualizationRuntimeMode="full-access"
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          autoFollowTail
          completionDividerAfterEntryId={null}
          completionSummary={null}
          isRevertingCheckpoint={false}
          isWorking={false}
          listRef={list}
          markdownCwd={undefined}
          onImageExpand={() => undefined}
          onIsAtEndChange={() => undefined}
          onRevertUserMessage={() => undefined}
          onUserScrollIntent={() => undefined}
          onDebugScrollEvent={(event) => {
            if (event.reason === "initial-list-load") completed();
          }}
          revertTurnCountByUserMessageId={new Map()}
          stickToEndRevision={0}
          timelineEntries={deriveTimelineEntries([], [], [], [entry])}
          timestampFormat="24-hour"
          workspaceRoot={undefined}
        />
      </div>
    </VisualizationViewerProvider>
  );
}
/** Real browser clipping and transforms, not fabricated visibility media or
 * dimensions. Only the far edge of this admitted frame is visible initially. */
function ClippedFrameFixture({ axis }: { axis: "horizontal" | "vertical" }) {
  return (
    <VisualizationViewerProvider>
      <div data-clipped-frame-fixture style={{ width: 300, height: 500, overflow: "hidden" }}>
        <div
          style={{
            width: axis === "horizontal" ? 2400 : 300,
            transform:
              axis === "horizontal" ? "translateX(-1700px)" : "translateY(-2200px) scaleY(8)",
            transformOrigin: "top left",
          }}
        >
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={{ ...entry, reference: { ...entry.reference, height: 360 } }}
            timestampFormat="24-hour"
            runtimeMode="full-access"
          />
        </div>
      </div>
    </VisualizationViewerProvider>
  );
}
function frameElement() {
  return document.querySelector<HTMLIFrameElement>("[data-visualization-card] iframe");
}
async function loadedFrame() {
  // The counter precedes the output and authored handlers in the real parser.
  // Replacement documents must finish loading before their state is inspected.
  await vi.waitFor(() => {
    const child = frameElement()?.contentDocument;
    expect(child?.getElementById("counter")).toBeTruthy();
    expect(child?.readyState).toBe("complete");
  });
  return frameElement()!;
}
async function loadedSelectFrame() {
  const frame = await loadedFrame();
  // The first button is parsed before later selects/output and their authored
  // handlers. These input fixtures need the actual completed document, not a
  // lucky partial-parser snapshot of the shared chart marker.
  await vi.waitFor(() => expect(frame.contentDocument?.readyState).toBe("complete"));
  return frame;
}
async function openMenu() {
  await userEvent.click(
    page.getByRole("button", { name: uiText("Visualization actions"), exact: true }).first(),
  );
}
async function inspect() {
  await openMenu();
  await userEvent.click(
    page.getByRole("menuitem", { name: uiText("Private source and JSON"), exact: true }),
  );
}
interface PoolInlineImage {
  id: string;
  source: string;
  name: string;
  width: number;
  height: number;
}
/** Real shared list, actual frame geometry and real image decode; transport
 * replies contain only these fixture-owned synthetic PNGs. */
function MixedTimelineFixture({
  actions,
  provider,
  inlineImages,
  width = 700,
}: {
  actions: {
    grow?: () => void;
    readState?: () => ReturnType<LegendListRef["getState"]> | undefined;
  };
  provider: "codex" | "claudeAgent";
  inlineImages: readonly PoolInlineImage[];
  width?: number;
}) {
  const pane = useVisualizationScope(environmentId, threadId, true);
  const listRef = useRef<LegendListRef | null>(null);
  const [following, setFollowing] = useState(true),
    [growth, setGrowth] = useState(0);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  actions.grow = () => setGrowth((old) => old + 1);
  actions.readState = () => listRef.current?.getState();
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `mixed-message-${index}`,
    kind: "message" as const,
    createdAt: entry.occurredAt,
    message: {
      id: MessageId.make(`mixed-message-${index}`),
      role: "user" as const,
      createdAt: entry.occurredAt,
      text: `Earlier message ${index}\nMeasured browser history.`,
      streaming: false,
    },
  }));
  const last = {
    id: "mixed-streaming",
    kind: "message" as const,
    createdAt: entry.occurredAt,
    message: {
      id: MessageId.make("mixed-streaming"),
      role: "assistant" as const,
      createdAt: entry.occurredAt,
      text: `Current answer\n${"Measured content.\n".repeat(3 + growth)}`,
      streaming: true,
    },
  };
  return (
    <div
      data-pool-timeline
      data-following={following}
      style={{ width, maxWidth: "100%", height: 500 }}
    >
      <MessagesTimeline
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        activeProvider={ProviderDriverKind.make(provider)}
        visualizationRuntimeMode="full-access"
        activeTurnId={null}
        activeTurnInProgress
        activeTurnStartedAt={null}
        autoFollowTail={following}
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking
        listRef={listRef}
        markdownCwd={undefined}
        onImageExpand={setExpandedImage}
        onIsAtEndChange={() => undefined}
        onRevertUserMessage={() => undefined}
        onUserScrollIntent={() => setFollowing(false)}
        revertTurnCountByUserMessageId={new Map()}
        stickToEndRevision={0}
        timelineEntries={[
          ...messages,
          ...deriveTimelineEntries([], [], [], [entry]),
          ...inlineImages.map((image) => ({
            id: image.id,
            kind: "message" as const,
            createdAt: entry.occurredAt,
            message: {
              id: MessageId.make(image.id),
              role: "assistant" as const,
              createdAt: entry.occurredAt,
              text: `![${image.name}](<${image.source}>)`,
              streaming: false,
            },
          })),
          last,
        ]}
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        visualizationPane={pane}
      />
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}

/**
 * Hold only the authenticated response boundary. Both metadata-driven flow and
 * binary decoding use the production MarkdownImage path, with real scoped PNGs
 * and exact message/source routing; no browser fetch or provider is contacted.
 */
interface PoolImageTransfer {
  messageId: string;
  kind: "manifest" | "bytes";
  signal: AbortSignal;
  outcome: "pending" | "response" | "aborted";
}
async function installPoolInlineImagePeer(images: readonly PoolInlineImage[]) {
  const transfers: PoolImageTransfer[] = [];
  const peers = await Promise.all(
    images.map(async (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")!.fillRect(0, 0, image.width, image.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
          "image/png",
        ),
      );
      const png = new Uint8Array(await blob.arrayBuffer());
      const manifest = deferred<void>();
      const bytes = deferred<void>();
      return {
        image,
        manifest,
        bytes,
        // Readiness is shared, never a one-use Response body. Initial list
        // measurement can cancel a row and then admit its current replacement.
        // Every actual request must receive its own fresh bounded body.
        manifestResponse: () =>
          new Response(
            JSON.stringify([
              {
                source: image.source,
                mimeType: "image/png",
                width: image.width,
                height: image.height,
                sizeBytes: png.length,
              },
            ]),
          ),
        bytesResponse: () =>
          new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }),
        releaseManifest: () => manifest.resolve(undefined),
        releaseBytes: () => bytes.resolve(undefined),
      };
    }),
  );
  vi.mocked(fileRequest).mockImplementation(async (owner, path, init, query) => {
    expect(owner).toBe(environmentId);
    expect(path).toBe(CHAT_IMAGES_PATH);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const peer = peers.find((candidate) => candidate.image.id === query?.messageId);
    if (!peer) throw new Error("fixture-image-owner-mismatch");
    expect(query).toEqual({
      threadId,
      messageId: peer.image.id,
      ...(query?.source === undefined ? {} : { source: peer.image.source }),
    });
    // This finite fixture must fail on an unbounded refetch, not mask it in
    // a flexible count. The post-admission baselines below are stricter still.
    expect(transfers.length).toBeLessThan(8);
    const signal = init!.signal!;
    const kind = query?.source === undefined ? "manifest" : "bytes";
    const transfer: PoolImageTransfer = {
      messageId: peer.image.id,
      kind,
      signal,
      outcome: "pending",
    };
    transfers.push(transfer);
    if (signal.aborted) throw new Error("fixture-image-cancelled");
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        if (transfer.outcome !== "pending") return;
        transfer.outcome = "aborted";
        reject(new Error("fixture-image-cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void (kind === "manifest" ? peer.manifest.promise : peer.bytes.promise).then(
        () => {
          signal.removeEventListener("abort", abort);
          if (transfer.outcome !== "pending") return;
          transfer.outcome = "response";
          resolve(kind === "manifest" ? peer.manifestResponse() : peer.bytesResponse());
        },
        (error: Error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  });
  return { peers, transfers };
}
async function prepareVisualizationScrollerWheel(element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  let x = bounds.left + bounds.width / 2;
  let y = bounds.top + Math.min(bounds.height / 2, 100);
  let frame = window.frameElement;
  while (frame) {
    const owner = frame as HTMLElement;
    const rect = owner.getBoundingClientRect();
    x = rect.left + (x + owner.clientLeft) * (rect.width / owner.offsetWidth);
    y = rect.top + (y + owner.clientTop) * (rect.height / owner.offsetHeight);
    frame = owner.ownerDocument.defaultView?.frameElement ?? null;
  }
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return { x, y };
}
async function wheelVisualizationScroller({ x, y }: { x: number; y: number }, deltaY: number) {
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  setUiLocale(originalLocale);
  copy.mockClear();
  download.mockClear();
  vi.mocked(fileRequest).mockReset();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("font-size");
});

describe("Full-access live inline visualizations", () => {
  it.each(["codex", "claudeAgent"] as const)(
    "keeps %s image growth and full-width chart layout in one real list without losing tail or review ownership",
    async (provider) => {
      setUiLocale("en");
      const images: readonly PoolInlineImage[] = [
        {
          id: "pool-image-tail",
          source: "/repo/pool-follow-tail.png",
          name: "Tail image",
          width: 640,
          height: 128,
        },
        {
          id: "pool-image-review",
          source: "/repo/pool-review.png",
          name: "Review image",
          width: 640,
          height: 96,
        },
      ];
      const { peers, transfers } = await installPoolInlineImagePeer(images);
      const api = installApi(),
        actions: {
          grow?: () => void;
          readState?: () => ReturnType<LegendListRef["getState"]> | undefined;
        } = {};
      const read = api.inline.getMockImplementation()!;
      api.inline.mockImplementation(async (input) => ({
        ...(await read(input)),
        html: '<main style="height:180px;padding:8px"><button id="counter">Change range</button><output id="count">0</output><svg viewBox="0 0 640 100" width="100%" height="100"><rect width="640" height="100" fill="var(--chart-1)"/><text x="10" y="25" fill="var(--foreground)">Current chart data</text></svg></main>',
      }));
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      let view: Awaited<ReturnType<typeof render>> | undefined;
      try {
        // This case deliberately contrasts full-pane charts with capped prose.
        // Use the runner's supported viewport API, not CSS/media overrides, and
        // restore its exact incoming dimensions even if render/assertion fails.
        await page.viewport(1200, 900);
        view = await render(
          <VisualizationViewerProvider>
            <MixedTimelineFixture
              actions={actions}
              provider={provider}
              inlineImages={images}
              width={1100}
            />
          </VisualizationViewerProvider>,
        );
        await loadedFrame();
        expect(api.inline).toHaveBeenCalledOnce();
        // Two independent completed messages have exact separate manifests.
        // Keep both binary replies held so metadata, not image load timing,
        // is what reserves the first larger row in the real virtualized list.
        await vi.waitFor(() => {
          const current = transfers.filter((transfer) => transfer.outcome === "pending");
          expect(current.map((transfer) => transfer.messageId).sort()).toEqual(
            images.map((image) => image.id).sort(),
          );
          expect(
            current.every((transfer) => transfer.kind === "manifest" && !transfer.signal.aborted),
          ).toBe(true);
          expect(transfers.filter((transfer) => transfer.kind === "bytes")).toHaveLength(0);
          for (const transfer of transfers.filter((transfer) => transfer.outcome !== "pending")) {
            expect(transfer.outcome).toBe("aborted");
            expect(transfer.signal.aborted).toBe(true);
          }
        });
        const startupRequests = transfers.length;
        expect(fileRequest).toHaveBeenCalledTimes(startupRequests);
        const anchor = document.querySelector<HTMLElement>(
          '[data-pool-timeline] [data-visualization-inline-surface="inline"]',
        )!;
        const scroller = visualizationClippingAncestors(anchor)!.find(
          (element) =>
            /auto|scroll/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight,
        )!;
        const hosts = images.map((image) =>
          document.querySelector<HTMLElement>(
            `[data-chat-copy-message-id="${image.id}"] span[style]`,
          )!,
        );
        // Observe the held loading state itself; its CSS height/border are not a feature contract.
        await vi.waitFor(() => {
          for (const host of hosts) {
            expect(host).toHaveTextContent(uiText("Loading image…"));
            expect(host.style.aspectRatio).toBe("");
            expect(host.getBoundingClientRect().height).toBeGreaterThan(0);
          }
        });
        const initialImageHeights = hosts.map((host) => host.getBoundingClientRect().height);
        const expectSharedWidth = () => {
          const style = getComputedStyle(scroller);
          const available =
            scroller.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight);
          expect(Math.abs(anchor.getBoundingClientRect().width - available)).toBeLessThanOrEqual(1);
          expect(anchor.getBoundingClientRect().width).toBeGreaterThan(768);
          expect(scroller.scrollWidth).toBe(scroller.clientWidth);
          expect(anchor.scrollWidth).toBe(anchor.clientWidth);
          for (const host of hosts) {
            const proseWidth = host
              .closest<HTMLElement>('[data-timeline-row-kind="message"]')!
              .getBoundingClientRect().width;
            expect(proseWidth).toBeLessThanOrEqual(768);
            expect(host.getBoundingClientRect().width).toBeLessThanOrEqual(proseWidth);
            // Unknown metadata cannot establish a 640px natural-width cap.
            // Once the real manifest supplies aspect ratio, retain that exact
            // image cap in addition to the unchanged prose/overflow bounds.
            if (host.style.aspectRatio)
              expect(host.getBoundingClientRect().width).toBeLessThanOrEqual(640);
            expect(host.scrollWidth).toBe(host.clientWidth);
          }
        };
        expectSharedWidth();
        peers[0]!.releaseManifest();

        await vi.waitFor(() => {
          expect(hosts[0]!.getBoundingClientRect().height).toBeGreaterThan(initialImageHeights[0]!);
          expect(hosts[0]!.style.aspectRatio).toBe("640 / 128");
          expect(anchor.getBoundingClientRect().height).toBe(180);
          expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThan(
            1,
          );
          expect(fileRequest).toHaveBeenCalledTimes(startupRequests + 1);
        });
        expect(
          document.querySelector('[data-pool-timeline][data-following="true"]'),
        ).not.toBeNull();
        peers[0]!.releaseBytes();
        const firstImage = page.getByRole("img", { name: "Tail image", exact: true });
        await vi.waitFor(() =>
          expect((firstImage.element() as HTMLImageElement).naturalWidth).toBe(640),
        );
        const imageNode = firstImage.element();
        const imageSource = imageNode.getAttribute("src");
        expect(imageSource).toMatch(/^blob:/);
        // Establish review ownership only after the image is decoded and the real list is at tail.
        // Bootstrap and metadata can legitimately take a unit fully offscreen before this point.
        await vi.waitFor(() => {
          expect((imageNode as HTMLImageElement).complete).toBe(true);
          expect(actions.readState?.()?.isAtEnd).toBe(true);
          expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThan(
            1,
          );
        });
        const frame = await loadedFrame();
        const frameDocument = frame.contentDocument;
        const inlineReadsAtReview = api.inline.mock.calls.length;
        const retireCallsAtReview = api.retireInlineFrame.mock.calls.length;
        // Await native pointer preparation before sampling the physical
        // baseline, then dispatch the unchanged wheel without another wait.
        // Passive capture can observe an already-applied compositor scroll,
        // so its event proves trusted delta/owner admission, not pre-default
        // position. Child events do not bubble across the iframe boundary;
        // observe both legitimate surfaces without altering input handlers.
        expect(frameDocument).not.toBeNull();
        const timeline = scroller.closest<HTMLElement>("[data-pool-timeline]")!;
        const expectOriginalOwner = (phase: string) => {
          const geometry = visualizationGeometry(anchor, true);
          // Do not adopt a replacement after metadata/measurement or native
          // pointer preparation. These content-free witnesses localize an
          // ownership transition while preserving the original document proof.
          const witness = {
            phase,
            scrollerConnected: scroller.isConnected,
            currentFrame: frameElement() === frame,
            currentDocument: frame.contentDocument === frameDocument,
            clipWidth: geometry?.clipBounds.width ?? null,
            clipHeight: geometry?.clipBounds.height ?? null,
            inlineReads: api.inline.mock.calls.length,
            retireCalls: api.retireInlineFrame.mock.calls.length,
          };
          const diagnostic = JSON.stringify(witness);
          expect(witness.scrollerConnected, diagnostic).toBe(true);
          expect(witness.currentFrame, diagnostic).toBe(true);
          expect(witness.currentDocument, diagnostic).toBe(true);
          expect(geometry, diagnostic).not.toBeNull();
          expect(geometry!.clipBounds.width, diagnostic).toBeGreaterThan(0);
          expect(geometry!.clipBounds.height, diagnostic).toBeGreaterThan(0);
          expect(api.inline.mock.calls.length, diagnostic).toBe(inlineReadsAtReview);
          expect(api.retireInlineFrame.mock.calls.length, diagnostic).toBe(retireCallsAtReview);
        };
        let wheelCount = 0;
        let admission:
          | {
              trusted: boolean;
              deltaY: number;
              deltaMode: number;
              following: boolean;
              exactOwner: boolean;
              scrollerConnected: boolean;
              currentFrame: boolean;
              currentDocument: boolean;
              currentEventTarget: boolean;
            }
          | undefined;
        const observeWheel = (event: WheelEvent) => {
          wheelCount += 1;
          if (admission) return;
          const owner = {
            scrollerConnected: scroller.isConnected,
            currentFrame: frameElement() === frame,
            currentDocument: frame.contentDocument === frameDocument,
            currentEventTarget:
              event.currentTarget === scroller || event.currentTarget === frameDocument,
          };
          admission = {
            trusted: event.isTrusted,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            following: timeline.dataset.following === "true",
            ...owner,
            exactOwner: Object.values(owner).every((value) => value),
          };
        };
        scroller.addEventListener("wheel", observeWheel, { capture: true, passive: true });
        frameDocument!.addEventListener("wheel", observeWheel, { capture: true, passive: true });
        try {
          expectOriginalOwner("before native pointer preparation");
          const wheelPosition = await prepareVisualizationScrollerWheel(scroller);
          expectOriginalOwner("after native pointer preparation");
          const beforeWheel = scroller.scrollTop;
          expect(Number.isFinite(beforeWheel)).toBe(true);
          expect(timeline.dataset.following).toBe("true");
          await wheelVisualizationScroller(wheelPosition, -64);
          await vi.waitFor(() => {
            expect(wheelCount).toBe(1);
            expect(admission).toBeDefined();
            expect(admission!.trusted).toBe(true);
            expect(admission!.deltaY).toBe(-64);
            expect(admission!.deltaMode).toBe(0);
            expect(admission!.following).toBe(true);
            const diagnostic = JSON.stringify(admission);
            expect(admission!.scrollerConnected, diagnostic).toBe(true);
            expect(admission!.currentFrame, diagnostic).toBe(true);
            expect(admission!.currentDocument, diagnostic).toBe(true);
            expect(admission!.currentEventTarget, diagnostic).toBe(true);
            expect(admission!.exactOwner, diagnostic).toBe(true);
            expect(
              document.querySelector('[data-pool-timeline][data-following="false"]'),
            ).not.toBeNull();
            expect(scroller.scrollTop).toBeCloseTo(beforeWheel - 64, 0);
          });
        } finally {
          scroller.removeEventListener("wheel", observeWheel, true);
          frameDocument!.removeEventListener("wheel", observeWheel, true);
        }
        const reviewTop = scroller.scrollTop;
        const anchorTop = anchor.getBoundingClientRect().top;
        // New image metadata and an actual child natural-height change arrive after
        // real review intent. Neither may take over the user's scroll owner,
        // rebuild the already decoded first image, or replace the chart document.
        peers[1]!.releaseManifest();
        frame.contentDocument!.querySelector<HTMLElement>("main")!.style.height = "240px";
        actions.grow?.();
        await vi.waitFor(() => {
          expect(hosts[1]!.getBoundingClientRect().height).toBeGreaterThan(initialImageHeights[1]!);
          expect(hosts[1]!.style.aspectRatio).toBe("640 / 96");
          expect(anchor.getBoundingClientRect().height).toBe(240);
          expect(fileRequest).toHaveBeenCalledTimes(startupRequests + 2);
        });
        peers[1]!.releaseBytes();
        await vi.waitFor(() =>
          expect(
            (
              page
                .getByRole("img", { name: "Review image", exact: true })
                .element() as HTMLImageElement
            ).naturalWidth,
          ).toBe(640),
        );
        await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(240));
        expect(scroller.scrollTop).toBeCloseTo(reviewTop, 0);
        expect(anchor.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0);
        expect(firstImage.element()).toBe(imageNode);
        expect(firstImage.element().getAttribute("src")).toBe(imageSource);
        expectSharedWidth();
        expect(fileRequest).toHaveBeenCalledTimes(startupRequests + 2);
        expect(api.inline.mock.calls.length).toBe(inlineReadsAtReview);
        expect(api.retireInlineFrame.mock.calls.length).toBe(retireCallsAtReview);
        expect(frameElement()).toBe(frame);
        expect(frame.contentDocument).toBe(frameDocument);
        expect(api.details).not.toHaveBeenCalled();
      } finally {
        try {
          await view?.unmount();
        } finally {
          await page.viewport(originalViewport.width, originalViewport.height);
        }
      }
    },
  );
  it.each(["codex", "claudeAgent"] as const)(
    "preserves the exact %s ordinary frame through its real Markdown image dialog without reloading or refetching",
    async (provider) => {
      setUiLocale("en");
      const images: readonly PoolInlineImage[] = [
        {
          id: "pool-image-dialog",
          source: "/repo/pool-dialog.png",
          name: "Dialog image",
          width: 640,
          height: 128,
        },
      ];
      const {
        peers: [peer],
        transfers,
      } = await installPoolInlineImagePeer(images);
      peer!.releaseManifest();
      peer!.releaseBytes();
      const api = installApi(),
        actions: { grow?: () => void } = {};
      const read = api.inline.getMockImplementation()!;
      api.inline.mockImplementation(async (input) => ({
        ...(await read(input)),
        html: '<main style="height:180px;padding:8px"><button id="counter">Change range</button><output id="count">0</output><svg viewBox="0 0 640 100" width="100%" height="100"><rect width="640" height="100" fill="var(--chart-1)"/><text x="10" y="25" fill="var(--foreground)">Current chart data</text></svg></main>',
      }));
      const view = await render(
        <VisualizationViewerProvider>
          <MixedTimelineFixture actions={actions} provider={provider} inlineImages={images} />
        </VisualizationViewerProvider>,
      );
      try {
        const frame = await loadedFrame();
        const frameDocument = frame.contentDocument;
        expect(api.inline).toHaveBeenCalledOnce();
        const image = page.getByRole("img", { name: "Dialog image", exact: true });
        await vi.waitFor(() =>
          expect((image.element() as HTMLImageElement).naturalWidth).toBe(640),
        );
        const imageNode = image.element();
        const source = imageNode.getAttribute("src");
        expect(source).toMatch(/^blob:/);
        const currentBytes = transfers.filter(
          (transfer) => transfer.kind === "bytes" && !transfer.signal.aborted,
        );
        expect(currentBytes).toHaveLength(1);
        expect(currentBytes[0]!.messageId).toBe(images[0]!.id);
        expect(currentBytes[0]!.outcome).toBe("response");
        expect(transfers.filter((transfer) => transfer.outcome === "pending")).toHaveLength(0);
        for (const transfer of transfers.filter((transfer) => transfer.outcome === "aborted"))
          expect(transfer.signal.aborted).toBe(true);
        const decodedRequests = transfers.length;
        expect(fileRequest).toHaveBeenCalledTimes(decodedRequests);
        await userEvent.click(
          page.getByRole("button", { name: "Enlarge Dialog image", exact: true }),
        );
        const dialog = page.getByRole("dialog", { name: "Expanded image preview", exact: true });
        await expect.element(dialog).toBeVisible();
        expect(dialog.element().parentElement).toBe(document.body);
        expect(dialog.element().querySelector("img")!.getAttribute("src")).toBe(source);
        expect(frameElement()).toBe(frame);
        expect(frame.contentDocument).toBe(frameDocument);
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
        // Ordinary same-origin DOM stays under the image modal naturally.
        // Closing the modal preserves the same actual chart document, not a
        // destroyed native lease or a saved preview replacement.
        await userEvent.click(
          page.getByRole("button", { name: "Close image preview", exact: true }).last(),
        );
        await expect.element(dialog).not.toBeInTheDocument();
        frame.contentDocument!.querySelector<HTMLElement>("main")!.style.height = "300px";
        actions.grow?.();
        for (let frame = 0; frame < 6; frame += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(api.inline).toHaveBeenCalledOnce();
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
        expect(frameElement()).toBe(frame);
        expect(frame.contentDocument).toBe(frameDocument);
        expect(fileRequest).toHaveBeenCalledTimes(decodedRequests);
        expect(image.element()).toBe(imageNode);
        expect(image.element().getAttribute("src")).toBe(source);
        expect(api.details).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );

  it.each([null, "approval-required" as const])(
    "refuses missing/non-Full-access policy %s before any source read",
    async (permission) => {
      const api = installApi();
      await render(<Fixture permission={permission} />);
      await expect
        .element(page.getByText("Visualizations require Full access.", { exact: true }))
        .toBeVisible();
      expect(api.inline).not.toHaveBeenCalled();
      expect(frameElement()).toBeNull();
      expect(fileRequest).not.toHaveBeenCalled();
      expect(document.querySelector("[data-visualization-loading]")).toBeNull();
    },
  );
  it("runs automatically in an ordinary browser, has no saved poster, and accepts real chart input", async () => {
    const api = installApi();
    delete window.desktopBridge;
    await render(<Fixture />);
    const frame = await loadedFrame();
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(api.inline).toHaveBeenCalledOnce();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(fileRequest).not.toHaveBeenCalled();
    expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
    expect(document.querySelector("[data-visualization-card] img")).toBeNull();
    expect(frame.contentDocument?.defaultView?.parent).toBe(window);
    await userEvent.click(
      page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true }),
    );
    expect(frame.contentDocument?.getElementById("count")?.textContent).toBe("1");
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it.each([
    { dark: false, scale: 0.8 },
    { dark: true, scale: 1.3 },
  ])(
    "removes pointer-select decoration without changing native selection or focus ($dark/$scale)",
    async ({ dark, scale }) => {
      const api = installApi(),
        read = api.inline.getMockImplementation()!,
        previousDark = document.documentElement.classList.contains("dark"),
        previousScale = document.documentElement.style.getPropertyValue("font-size"),
        previousScalePriority = document.documentElement.style.getPropertyPriority("font-size");
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.setProperty("font-size", `${scale * 100}%`);
      api.inline.mockImplementationOnce(async (input) => ({
        ...(await read(input)),
        html: `<style>select{border:2px solid rgb(80,90,100)}select:focus{outline:4px solid var(--accent)!important;box-shadow:0 0 0 6px var(--accent)!important}</style><main style="height:240px;padding:16px"><button id="counter">Before controls</button><select id="metric" aria-label="Period"><option value="first">First period</option><option value="second">Second period</option></select><select id="visible-choices" size="2" aria-label="Visible choices"><option value="launch">Launch</option><option value="growth">Growth</option></select><output id="count">0</output><input aria-label="Editable name"><button>After controls</button></main><script>for(const select of document.querySelectorAll('select'))select.addEventListener('change',event=>{const output=document.getElementById('count');output.value=String(Number(output.value)+1);output.dataset.trusted=String(event.isTrusted)});</script>`,
      }));
      const view = await render(<Fixture width={430} />);
      try {
        const frame = await loadedSelectFrame(),
          child = frame.contentDocument!,
          dropdown = child.getElementById("metric") as HTMLSelectElement,
          choices = child.getElementById("visible-choices") as HTMLSelectElement,
          native = page.frameLocator(page.elementLocator(frame)),
          output = child.getElementById("count")!;
        expect(child.documentElement.classList.contains("dark")).toBe(dark);
        expect(
          Number(child.documentElement.style.getPropertyValue("--cafe-interface-scale")),
        ).toBeCloseTo(scale);
        expect(
          Number.parseFloat(child.defaultView!.getComputedStyle(child.documentElement).fontSize),
        ).toBeCloseTo(14 * scale);
        // These are visible native option rows, not Playwright selectOptions or
        // fabricated change events. A native OS popup's pointer completion is a
        // separate smoke boundary; the same exact select controller owns both.
        await userEvent.click(native.getByRole("option", { name: "Growth", exact: true }));
        await vi.waitFor(() => expect(choices.value).toBe("growth"));
        expect(output.textContent).toBe("1");
        expect(output.dataset.trusted).toBe("true");
        expect(child.activeElement).toBe(choices);
        expect(child.defaultView!.getComputedStyle(choices).outlineStyle).toBe("none");
        expect(child.defaultView!.getComputedStyle(choices).boxShadow).toBe("none");
        expect(child.defaultView!.getComputedStyle(choices).borderTop).toBe(
          "2px solid rgb(80, 90, 100)",
        );
        // Native pointer opening also suppresses the closed-dropdown residual
        // outline, without changing its value or stealing its retained focus.
        await userEvent.click(native.getByRole("combobox", { name: "Period", exact: true }));
        expect(child.activeElement).toBe(dropdown);
        expect(dropdown.value).toBe("first");
        expect(child.defaultView!.getComputedStyle(dropdown).outlineStyle).toBe("none");
        expect(child.defaultView!.getComputedStyle(dropdown).boxShadow).toBe("none");
        expect(output.textContent).toBe("1");
        await userEvent.keyboard("{Escape}");
        await userEvent.click(native.getByRole("textbox", { name: "Editable name", exact: true }));
        expect(child.defaultView!.getComputedStyle(dropdown).borderTop).toBe(
          "2px solid rgb(80, 90, 100)",
        );
        expect(dropdown.style.getPropertyValue("outline")).toBe("");
        expect(dropdown.style.getPropertyValue("box-shadow")).toBe("");
        expect(child.querySelector("input")!.style.getPropertyValue("outline")).toBe("");
        expect(frameElement()).toBe(frame);
        expect(frame.contentDocument).toBe(child);
        expect(api.inline).toHaveBeenCalledOnce();
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
      } finally {
        document.documentElement.classList.toggle("dark", previousDark);
        if (previousScale)
          document.documentElement.style.setProperty(
            "font-size",
            previousScale,
            previousScalePriority,
          );
        else document.documentElement.style.removeProperty("font-size");
        await view.unmount();
      }
    },
  );
  it("restores authored select focus for native keyboard navigation without blurring or replaying selection", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      html: `<main style="height:240px;padding:16px"><button id="counter">Before controls</button><select id="metric" aria-label="Period" style="outline:5px dashed rgb(20,30,40)!important;box-shadow:inset 0 0 0 2px rgb(40,50,60)"><option value="first">First period</option><option value="second">Second period</option></select><output id="count">0</output><button id="programmatic">Authored focus</button></main><script>document.getElementById('metric').addEventListener('change',event=>{const output=document.getElementById('count');output.value=String(Number(output.value)+1);output.dataset.trusted=String(event.isTrusted)});document.getElementById('programmatic').onclick=()=>document.getElementById('metric').focus();</script>`,
    }));
    await render(<Fixture />);
    const frame = await loadedSelectFrame(),
      child = frame.contentDocument!,
      select = child.getElementById("metric") as HTMLSelectElement,
      originalOutline = select.style.getPropertyValue("outline"),
      originalShadow = select.style.getPropertyValue("box-shadow"),
      native = page.frameLocator(page.elementLocator(frame)),
      output = child.getElementById("count")!;
    await userEvent.click(native.getByRole("button", { name: "Before controls", exact: true }));
    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() => expect(child.activeElement).toBe(select));
    expect(child.defaultView!.getComputedStyle(select).outlineStyle).toBe("dashed");
    // Real closed-select typeahead chooses the second period. This does not
    // claim that the browser provider can dispatch keys into an OS popup.
    await userEvent.keyboard("s");
    await vi.waitFor(() => expect(select.value).toBe("second"));
    expect(output.textContent).toBe("1");
    expect(output.dataset.trusted).toBe("true");
    expect(child.activeElement).toBe(select);
    expect(select.style.getPropertyValue("outline")).toBe(originalOutline);
    expect(select.style.getPropertyPriority("outline")).toBe("important");
    expect(select.style.getPropertyValue("box-shadow")).toBe(originalShadow);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await vi.waitFor(() => expect(child.activeElement).toBe(child.getElementById("counter")));
    expect(select.style.getPropertyValue("outline")).toBe(originalOutline);
    expect(select.style.getPropertyValue("box-shadow")).toBe(originalShadow);
    // Real authored focus reached from a different pointer target is not a
    // direct pointer-select choice and must keep its ordinary visible outline.
    await userEvent.click(native.getByRole("button", { name: "Authored focus", exact: true }));
    expect(child.activeElement).toBe(select);
    expect(child.defaultView!.getComputedStyle(select).outlineStyle).toBe("dashed");
    expect(output.textContent).toBe("1");
    expect(frame.contentDocument).toBe(child);
    expect(api.inline).toHaveBeenCalledOnce();
    expect(api.retireInlineFrame).not.toHaveBeenCalled();
  });
  it("restores visible keyboard focus on the same pointer-selected native control", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      html: `<main style="height:240px;padding:16px"><button id="counter">Before controls</button><select id="choices" size="2" aria-label="Visible choices" style="outline-style:dashed;outline-width:5px!important;outline-color:rgb(20,30,40);box-shadow:inset 0 0 0 2px rgb(40,50,60)"><option value="launch">Launch</option><option value="growth">Growth</option></select><output id="count">0</output></main><script>document.getElementById('choices').addEventListener('change',event=>{const output=document.getElementById('count');output.value=String(Number(output.value)+1);output.dataset.trusted=String(event.isTrusted)});</script>`,
    }));
    await render(<Fixture />);
    const frame = await loadedSelectFrame(),
      child = frame.contentDocument!,
      select = child.getElementById("choices") as HTMLSelectElement,
      originalShadow = select.style.getPropertyValue("box-shadow"),
      native = page.frameLocator(page.elementLocator(frame)),
      output = child.getElementById("count")!;
    await userEvent.click(native.getByRole("option", { name: "Growth", exact: true }));
    await vi.waitFor(() => expect(select.value).toBe("growth"));
    expect(output.textContent).toBe("1");
    expect(output.dataset.trusted).toBe("true");
    expect(child.activeElement).toBe(select);
    expect(child.defaultView!.getComputedStyle(select).outlineStyle).toBe("none");
    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => expect(select.value).toBe("launch"));
    expect(output.textContent).toBe("2");
    expect(output.dataset.trusted).toBe("true");
    expect(child.activeElement).toBe(select);
    expect(child.defaultView!.getComputedStyle(select).outlineStyle).toBe("dashed");
    expect(select.style.getPropertyValue("outline-width")).toBe("5px");
    expect(select.style.getPropertyPriority("outline-width")).toBe("important");
    expect(select.style.getPropertyValue("box-shadow")).toBe(originalShadow);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await vi.waitFor(() => expect(child.activeElement).toBe(child.getElementById("counter")));
    expect(output.textContent).toBe("2");
    expect(frame.contentDocument).toBe(child);
    expect(api.inline).toHaveBeenCalledOnce();
    expect(api.retireInlineFrame).not.toHaveBeenCalled();
  });
  it("does not overwrite newer authored select styles when pointer focus is released", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      html: `<main style="height:240px;padding:16px"><button id="counter">Before controls</button><select id="choices" size="2" aria-label="Visible choices" style="outline-width:7px!important;outline-color:rgb(30,40,50);outline-style:dashed;box-shadow:inset 0 0 0 1px rgb(10,20,30)"><option value="launch">Launch</option><option value="growth">Growth</option></select><output id="count">0</output><button>After controls</button></main><script>document.getElementById('choices').addEventListener('change',event=>{const select=event.currentTarget;select.style.setProperty('outline-style','dotted','important');select.style.setProperty('box-shadow','inset 0 0 0 3px rgb(70,80,90)');const output=document.getElementById('count');output.value=String(Number(output.value)+1);output.dataset.trusted=String(event.isTrusted)});</script>`,
    }));
    await render(<Fixture />);
    const frame = await loadedSelectFrame(),
      child = frame.contentDocument!,
      select = child.getElementById("choices") as HTMLSelectElement,
      native = page.frameLocator(page.elementLocator(frame)),
      originalWidth = select.style.getPropertyValue("outline-width"),
      originalColor = select.style.getPropertyValue("outline-color"),
      output = child.getElementById("count")!;
    await userEvent.click(native.getByRole("option", { name: "Growth", exact: true }));
    await vi.waitFor(() => expect(select.value).toBe("growth"));
    expect(output.textContent).toBe("1");
    expect(output.dataset.trusted).toBe("true");
    expect(select.style.getPropertyValue("outline-width")).toBe(originalWidth);
    expect(select.style.getPropertyPriority("outline-width")).toBe("important");
    expect(select.style.getPropertyValue("outline-color")).toBe(originalColor);
    const newerShadow = select.style.getPropertyValue("box-shadow");
    await userEvent.click(native.getByRole("button", { name: "After controls", exact: true }));
    expect(select.style.getPropertyValue("outline-style")).toBe("dotted");
    expect(select.style.getPropertyPriority("outline-style")).toBe("important");
    expect(select.style.getPropertyValue("box-shadow")).toBe(newerShadow);
    expect(select.style.getPropertyPriority("box-shadow")).toBe("");
    expect(output.textContent).toBe("1");
    expect(frame.contentDocument).toBe(child);
    expect(api.inline).toHaveBeenCalledOnce();
  });
  it("does not read source or a preview while exact initial layout admission is pending", async () => {
    const api = installApi(),
      actions: Parameters<typeof Fixture>[0]["actions"] = {};
    await render(<Fixture ready={false} actions={actions} />);
    expect(api.inline).not.toHaveBeenCalled();
    expect(frameElement()).toBeNull();
    expect(fileRequest).not.toHaveBeenCalled();
    expect(document.querySelector("[data-visualization-loading]")).toBeNull();
    actions.complete?.();
    await loadedFrame();
    expect(api.inline).toHaveBeenCalledOnce();
  });
  it("does not claim pending work without an actual viewer reservation provider", async () => {
    const api = installApi();
    await render(
      <VisualizationCard
        environmentId={environmentId}
        threadId={threadId}
        entry={entry}
        timestampFormat="24-hour"
        runtimeMode="full-access"
      />,
    );
    expect(api.inline).not.toHaveBeenCalled();
    expect(frameElement()).toBeNull();
    expect(document.querySelector("[data-visualization-loading]")).toBeNull();
    expect(fileRequest).not.toHaveBeenCalled();
  });
  it.each(["scroll", "resize"] as const)(
    "admits a genuine fractional edge crop after owning %s without an IO threshold transition",
    async (wake) => {
      const api = installApi();
      const view = await render(<FractionalEdgeFixture />);
      const scroller = document.querySelector<HTMLElement>("[data-fractional-edge]")!,
        anchor = scroller.querySelector<HTMLElement>("[data-visualization-inline-surface]")!;
      const samples: IntersectionObserverEntry[] = [];
      let resizeStyle: HTMLStyleElement | null = null;
      const observer = new IntersectionObserver((entries) => samples.push(...entries), {
        threshold: 0,
      });
      observer.observe(anchor);
      try {
        await vi.waitFor(() => expect(samples).toHaveLength(1));
        expect(samples[0]!.isIntersecting).toBe(true);
        expect(samples[0]!.intersectionRect.height).toBeCloseTo(0.25, 2);
        expect(visualizationGeometry(anchor, true)).toBeNull();
        expect(api.inline).not.toHaveBeenCalled();
        expect(frameElement()).toBeNull();
        expect(document.querySelector("[data-visualization-loading]")).toBeNull();
        if (wake === "scroll") {
          const point = await prepareVisualizationScrollerWheel(scroller);
          await wheelVisualizationScroller(point, 2);
          await vi.waitFor(() => expect(scroller.scrollTop).toBe(2));
        } else {
          // A real stylesheet layout change has no owner-chain attribute
          // mutation. Only actual resize/geometry delivery can wake this crop.
          resizeStyle = document.createElement("style");
          resizeStyle.textContent = "[data-fractional-edge]{height:202px!important}";
          document.head.append(resizeStyle);
        }
        const frame = await loadedFrame(),
          documentAtEntry = frame.contentDocument;
        expect(visualizationGeometry(anchor, true)!.clipBounds.height).toBeGreaterThanOrEqual(1);
        // Independent native IO evidence: positive finite geometry was admitted
        // without another threshold-zero notification, not via widened margins.
        expect(samples).toHaveLength(1);
        expect(api.inline).toHaveBeenCalledOnce();
        const point = await prepareVisualizationScrollerWheel(scroller);
        await wheelVisualizationScroller(point, 100);
        await vi.waitFor(() => expect(scroller.scrollTop).toBe(wake === "scroll" ? 102 : 100));
        expect(frameElement()).toBe(frame);
        expect(frame.contentDocument).toBe(documentAtEntry);
        await userEvent.click(
          page
            .frameLocator(page.elementLocator(frame))
            .getByRole("button", { name: "Change range", exact: true }),
        );
        expect(frame.contentDocument!.getElementById("count")!.textContent).toBe("1");
        expect(api.inline).toHaveBeenCalledOnce();
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
        expect(document.querySelector("[data-visualization-loading]")).toBeNull();
        await wheelVisualizationScroller(await prepareVisualizationScrollerWheel(scroller), 600);
        await vi.waitFor(() => expect(frameElement()).toBeNull());
        expect(document.querySelector("[data-visualization-loading]")).toBeNull();
        expect(api.retireInlineFrame).toHaveBeenCalledOnce();
        await wheelVisualizationScroller(await prepareVisualizationScrollerWheel(scroller), -600);
        const replacement = await loadedFrame();
        expect(replacement).not.toBe(frame);
        expect(replacement.contentDocument).not.toBe(documentAtEntry);
        expect(replacement.contentDocument!.getElementById("count")!.textContent).toBe("0");
        expect(api.inline).toHaveBeenCalledTimes(2);
        expect(fileRequest).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
        resizeStyle?.remove();
        await view.unmount();
      }
    },
  );
  it("keeps genuine source and parser readiness pending, then removes the sparkle for the interactive actual document", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!,
      request = deferred<VisualizationInlineResult>();
    api.inline.mockImplementationOnce(() => request.promise);
    await render(<Fixture />);
    await expect.element(page.getByText("Loading visualization…", { exact: true })).toBeVisible();
    const status = document.querySelector<HTMLElement>("[data-visualization-loading]")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(getComputedStyle(status).pointerEvents).toBe("none");
    expect(frameElement()).toBeNull();
    expect(api.inline).toHaveBeenCalledOnce();
    const observations: { installed: boolean; ready: boolean; pending: boolean }[] = [];
    const observer = new MutationObserver(() => {
      const frame = frameElement();
      observations.push({
        installed: !!frame,
        ready: !!frame?.contentDocument?.documentElement.dataset.cafeInlineFrame,
        pending: !!document.querySelector("[data-visualization-loading]"),
      });
    });
    observer.observe(document.querySelector("[data-visualization-inline-surface]")!, {
      childList: true,
    });
    try {
      const result = await read({ threadId, artifactId, revisionId });
      request.resolve({
        ...result,
        html: `<script>document.documentElement.dataset.firstScriptSawPending=String(!!parent.document.querySelector('[data-visualization-loading]'));</script>${source}`,
      });
      const frame = await loadedFrame();
      expect(
        observations.some((sample) => sample.installed && !sample.ready && sample.pending),
      ).toBe(true);
      // This is real authored parser execution before the browser's own load
      // event, not a synthetic load callback or a fabricated ready document.
      expect(frame.contentDocument!.documentElement.dataset.firstScriptSawPending).toBe("true");
      await vi.waitFor(() =>
        expect(document.querySelector("[data-visualization-loading]")).toBeNull(),
      );
      await userEvent.click(
        page
          .frameLocator(page.elementLocator(frame))
          .getByRole("button", { name: "Change range", exact: true }),
      );
      expect(frame.contentDocument!.getElementById("count")!.textContent).toBe("1");
      expect(api.inline).toHaveBeenCalledOnce();
      expect(api.retireInlineFrame).not.toHaveBeenCalled();
      expect(fileRequest).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });
  it("does not treat unsupported visible geometry as a scroll-out that clears Stop intent", async () => {
    const api = installApi();
    await render(<Fixture />);
    await loadedFrame();
    await openMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Stop", exact: true }));
    await vi.waitFor(() => expect(frameElement()).toBeNull());
    const anchor = document.querySelector<HTMLElement>("[data-visualization-inline-surface]")!;
    const observations: IntersectionObserverEntry[] = [];
    const observer = new IntersectionObserver((entries) => observations.push(...entries), {
      threshold: 0,
    });
    observer.observe(anchor);
    try {
      await vi.waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]!.isIntersecting).toBe(true);
      anchor.style.width = "32769px";
      expect(anchor.getBoundingClientRect().width).toBe(32769);
      expect(visualizationGeometry(anchor, true)).toBeNull();
      // Native owner-page frames deliver actual resize/IO observation without
      // inventing callbacks, retrying work or changing geometry limits.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(observations).toHaveLength(1);
      anchor.style.width = "100%";
      await vi.waitFor(() => expect(visualizationGeometry(anchor, true)).not.toBeNull());
      await expect
        .element(
          page.getByText("Viewer stopped. Run again to start a new document.", { exact: true }),
        )
        .toBeVisible();
      expect(frameElement()).toBeNull();
      expect(document.querySelector("[data-visualization-loading]")).toBeNull();
      expect(api.inline).toHaveBeenCalledOnce();
      expect(api.retireInlineFrame).toHaveBeenCalledOnce();
    } finally {
      observer.disconnect();
    }
  });
  it.each(["failure", "permission", "offscreen"] as const)(
    "removes pending presentation immediately on %s and never installs a stale source reply",
    async (outcome) => {
      const api = installApi(),
        read = api.inline.getMockImplementation()!,
        request = deferred<VisualizationInlineResult>(),
        actions: Parameters<typeof Fixture>[0]["actions"] = {};
      api.inline.mockImplementationOnce(() => request.promise);
      await render(<Fixture scroll actions={actions} />);
      await expect.element(page.getByText("Loading visualization…", { exact: true })).toBeVisible();
      expect(api.inline).toHaveBeenCalledOnce();
      if (outcome === "failure")
        request.reject(new Error("private-source-error-must-not-be-presented"));
      else if (outcome === "permission") actions.changePermission?.("approval-required");
      else {
        const scroller = document.querySelector<HTMLElement>("[data-inline-fixture]")!;
        const expectedScroll = Math.min(700, scroller.scrollHeight - scroller.clientHeight);
        await wheelVisualizationScroller(await prepareVisualizationScrollerWheel(scroller), 700);
        await vi.waitFor(() => expect(scroller.scrollTop).toBe(expectedScroll));
      }
      await vi.waitFor(() =>
        expect(document.querySelector("[data-visualization-loading]")).toBeNull(),
      );
      expect(frameElement()).toBeNull();
      expect(document.body.textContent).not.toContain("private-source-error-must-not-be-presented");
      if (outcome === "failure") {
        await expect
          .element(page.getByText("Visualization unavailable.", { exact: true }))
          .toBeVisible();
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
      } else {
        const late = await read({ threadId, artifactId, revisionId });
        request.resolve(late);
        await vi.waitFor(() =>
          expect(api.retireInlineFrame).toHaveBeenCalledExactlyOnceWith({
            threadId,
            artifactId,
            revisionId,
            frameId: late.frameId,
            ticket: late.ticket,
          }),
        );
        expect(frameElement()).toBeNull();
        expect(api.inline).toHaveBeenCalledOnce();
      }
      expect(fileRequest).not.toHaveBeenCalled();
    },
  );
  it("bounds actual concurrent source reads to two and live frames to four, then admits the oldest waiting unit", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    const pending: {
      request: ReturnType<typeof deferred<VisualizationInlineResult>>;
      value: Promise<VisualizationInlineResult>;
    }[] = [];
    let active = 0,
      maximum = 0;
    api.inline.mockImplementation((input) => {
      active++;
      maximum = Math.max(maximum, active);
      const request = deferred<VisualizationInlineResult>();
      const value = read(input).then((result) => ({
        ...result,
        html: '<main style="height:80px"><button id="counter">Change range</button><output id="count">0</output></main>',
      }));
      pending.push({ request, value });
      return request.promise.finally(() => {
        active--;
      });
    });
    const original = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1000, 900);
    const view = await render(<Fixture count={5} />);
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(document.querySelectorAll("[data-visualization-card] iframe")).toHaveLength(0);
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-visualization-loading]")).toHaveLength(5),
      );
      for (let index = 0; index < 4; index++) {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
        pending[index]!.request.resolve(await pending[index]!.value);
      }
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-visualization-card] iframe")).toHaveLength(4),
      );
      expect(api.inline).toHaveBeenCalledTimes(4);
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-visualization-loading]")).toHaveLength(1),
      );
      const waitingCard = document.querySelectorAll<HTMLElement>("[data-visualization-card]")[4]!;
      expect(waitingCard.querySelector("[data-visualization-loading]")).not.toBeNull();
      expect(waitingCard.querySelector("iframe")).toBeNull();
      expect(maximum).toBe(2);
      expect(readInlineVisualizationPoolDiagnostics()).toMatchObject({
        mode: "inline-browser",
        fullAccessRequired: true,
        runningFrames: 4,
        grantedFrames: 4,
        anchors: 5,
        activeReads: 0,
        waitingReads: 0,
      });
      await openMenu();
      await userEvent.click(page.getByRole("menuitem", { name: "Stop", exact: true }));
      await vi.waitFor(() => expect(pending).toHaveLength(5));
      pending[4]!.request.resolve(await pending[4]!.value);
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-visualization-card] iframe")).toHaveLength(4),
      );
      expect(api.inline).toHaveBeenCalledTimes(5);
      expect(api.retireInlineFrame).toHaveBeenCalledOnce();
      expect(fileRequest).not.toHaveBeenCalled();
    } finally {
      for (const value of pending) value.request.resolve(await value.value);
      await view.unmount();
      await page.viewport(original.width, original.height);
    }
  });
  it.each([false, true])(
    "waits for the actual virtualized list public completion: StrictMode=%s",
    async (strict) => {
      const api = installApi();
      let complete = false;
      const observations: boolean[] = [];
      const sourceRead = api.inline.getMockImplementation()!;
      api.inline.mockImplementation(async (input) => {
        observations.push(complete);
        return sourceRead(input);
      });
      const fixture = (
        <RealTimeline
          completed={() => {
            expect(api.inline).not.toHaveBeenCalled();
            complete = true;
          }}
        />
      );
      await render(strict ? <StrictMode>{fixture}</StrictMode> : fixture);
      await loadedFrame();
      expect(observations).toEqual([true]);
      expect(api.inline).toHaveBeenCalledOnce();
    },
  );
  it("uses available chat width and measured natural height without an inner scrollbar", async () => {
    installApi();
    const original = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1400, 900);
    const view = await render(<Fixture width={1000} />);
    try {
      const frame = await loadedFrame();
      await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBe(360));
      const parent = document.querySelector<HTMLElement>("[data-inline-fixture]")!;
      expect(frame.getBoundingClientRect().width).toBeCloseTo(
        parent.getBoundingClientRect().width,
        0,
      );
      expect(frame.contentDocument!.documentElement.scrollWidth).toBe(
        frame.contentDocument!.documentElement.clientWidth,
      );
      expect(frame.contentDocument!.documentElement.scrollHeight).toBe(
        frame.contentDocument!.documentElement.clientHeight,
      );
      expect(frame.getBoundingClientRect().width).toBeGreaterThan(entry.reference.width);
    } finally {
      await view.unmount();
      await page.viewport(original.width, original.height);
    }
  });
  it.each(["horizontal", "vertical"] as const)(
    "keeps a partially clipped %s far edge live and clickable without a horizontal inner scrollbar",
    async (axis) => {
      const api = installApi(),
        read = api.inline.getMockImplementation()!;
      api.inline.mockImplementationOnce(async (input) => ({
        ...(await read(input)),
        html: `<main style="height:360px;position:relative"><button id="counter" style="position:absolute;left:${axis === "horizontal" ? 1900 : 16}px;top:${axis === "horizontal" ? 16 : 280}px">Change range</button><output id="count">0</output><svg viewBox="0 0 640 240" width="100%" height="240"><rect width="640" height="240" fill="var(--chart-1)"/></svg></main><script>document.querySelector('#counter').onclick=()=>{const output=document.querySelector('#count');output.value=String(Number(output.value)+1)};</script>`,
      }));
      await render(<ClippedFrameFixture axis={axis} />);
      const frame = await loadedFrame(),
        frameDocument = frame.contentDocument!;
      await vi.waitFor(() => expect(frame.style.height).toBe("360px"));
      const bounds = frame.getBoundingClientRect();
      if (axis === "horizontal") {
        expect(bounds.width).toBe(2400);
        expect(bounds.left).toBeLessThan(-1600);
      } else {
        expect(bounds.height).toBe(2880);
        expect(bounds.top).toBeLessThan(-2000);
      }
      expect(bounds.right).toBeGreaterThan(0);
      expect(bounds.bottom).toBeGreaterThan(0);
      expect(frameDocument.documentElement.scrollWidth).toBe(
        frameDocument.documentElement.clientWidth,
      );
      expect(frameDocument.documentElement.scrollHeight).toBe(
        frameDocument.documentElement.clientHeight,
      );
      await userEvent.click(
        page
          .frameLocator(page.elementLocator(frame))
          .getByRole("button", { name: "Change range", exact: true }),
      );
      expect(frameDocument.getElementById("count")?.textContent).toBe("1");
      expect(frameElement()).toBe(frame);
      expect(frame.contentDocument).toBe(frameDocument);
      expect(api.inline).toHaveBeenCalledOnce();
      expect(api.retireInlineFrame).not.toHaveBeenCalled();
    },
  );
  it("retains the same interactive document through partial scrolling and unloads after whole offscreen", async () => {
    const api = installApi();
    await render(<Fixture scroll />);
    const frame = await loadedFrame(),
      original = frame.contentDocument;
    await userEvent.click(
      page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true }),
    );
    const scroller = document.querySelector<HTMLElement>("[data-inline-fixture]")!;
    scroller.scrollTop = 100;
    await vi.waitFor(() => expect(frameElement()).toBe(frame));
    expect(frame.contentDocument).toBe(original);
    expect(frame.contentDocument?.getElementById("count")?.textContent).toBe("1");
    expect(api.inline).toHaveBeenCalledOnce();
    scroller.scrollTop = 700;
    await vi.waitFor(() => expect(frameElement()).toBeNull());
    await vi.waitFor(() => expect(api.retireInlineFrame).toHaveBeenCalledOnce());
    expect(frame.isConnected).toBe(false);
    scroller.scrollTop = 0;
    const replacement = await loadedFrame();
    expect(replacement).not.toBe(frame);
    expect(api.inline).toHaveBeenCalledTimes(2);
  });
  it("preserves authored full-document root/head/body metadata while composing the finite host prelude", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    const original = `<!doctype html><html class="authored-layout" style="--owned-brand:rgb(9, 20, 30)"><head data-original-head="kept"><style>.authored-layout main{height:420px}html{width:4000px;min-height:100vh}</style></head><body class="authored-body"><main><button id="counter">Change range</button><output id="count">0</output></main><script>document.documentElement.dataset.authoredPrelude=String(document.documentElement.dataset.cafeVisible==='true');document.getElementById('counter').onclick=()=>document.getElementById('count').value='1';</script></body></html>`;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      html: original,
    }));
    await render(<Fixture />);
    const frame = await loadedFrame(),
      document = frame.contentDocument!;
    expect(document.documentElement.classList.contains("authored-layout")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--owned-brand")).toBe("rgb(9, 20, 30)");
    expect(document.head.dataset.originalHead).toBe("kept");
    expect(document.body.className).toBe("authored-body");
    expect(document.documentElement.dataset.authoredPrelude).toBe("true");
    await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBe(420));
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    await userEvent.click(
      page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true }),
    );
    expect(document.getElementById("count")?.textContent).toBe("1");
  });
  it("preserves standards mode and authored document attributes when the exact fixed font appendix precedes source", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    const authored = `<!doctype html><html class="fixed-font-root" data-authored-root="kept" style="--owned-font-color:teal"><head data-authored-head="kept"><script>document.documentElement.dataset.authoredCompatMode=document.compatMode;document.documentElement.dataset.authoredFontFaces=String(Array.from(document.fonts).filter(face=>face.family.includes("DM Sans Variable")).length);</script><style>.fixed-font-root main{height:320px}</style></head><body class="fixed-font-body" data-authored-body="kept"><main><button id="counter">Change range</button><output id="count">0</output></main></body></html>`;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      // This is the exact server-minted derivative order, not a reconstructed
      // lookalike style. The frame composer must relocate only this fixed font
      // prefix into the real head without changing immutable authored source.
      html: GENERATED_VISUALIZATION_FONT_APPENDIX + authored,
    }));
    await render(<Fixture />);
    const frame = await loadedFrame(),
      frameDocument = frame.contentDocument!;
    expect(frameDocument.compatMode).toBe("CSS1Compat");
    expect(frameDocument.documentElement.dataset.authoredCompatMode).toBe("CSS1Compat");
    expect(frameDocument.documentElement.dataset.authoredFontFaces).toBe("4");
    expect(frameDocument.documentElement.classList.contains("fixed-font-root")).toBe(true);
    expect(frameDocument.documentElement.dataset.authoredRoot).toBe("kept");
    expect(frameDocument.documentElement.style.getPropertyValue("--owned-font-color")).toBe("teal");
    expect(frameDocument.head.dataset.authoredHead).toBe("kept");
    expect(frameDocument.body.className).toBe("fixed-font-body");
    expect(frameDocument.body.dataset.authoredBody).toBe("kept");
    expect(frameDocument.head.querySelectorAll("[data-cafe-chat-typography]")).toHaveLength(1);
    expect(
      frameDocument.documentElement.querySelectorAll("[data-cafe-chat-typography]"),
    ).toHaveLength(1);
    await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBe(320));
    expect(api.inline).toHaveBeenCalledOnce();
    expect(api.retireInlineFrame).not.toHaveBeenCalled();
  });
  it("measures normal-flow descendant overflow beyond a fixed root wrapper without counting absolute decoration", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    api.inline.mockImplementationOnce(async (input) => ({
      ...(await read(input)),
      html: '<main style="height:160px"><section style="height:700px"><button id="counter">Change range</button><output id="count">0</output></section><div style="position:absolute;top:0;height:9000px;pointer-events:none">Decoration</div></main>',
    }));
    await render(<Fixture scroll />);
    const frame = await loadedFrame();
    await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBe(700));
    expect(frame.contentDocument!.documentElement.scrollHeight).toBe(9000);
    // The absolute background is deliberately excluded from flow. It cannot
    // inflate the conversation to9000px; the complete actual flow fits700px.
    expect(frame.contentDocument!.querySelector("section")!.getBoundingClientRect().height).toBe(
      700,
    );
  });
  it("keeps template raw-text decoys intact and initializes the actual full document before its authored script", async () => {
    const api = installApi(),
      read = api.inline.getMockImplementation()!;
    const decoy = "<template><script>const example='</template><html><head>';</script></template>";
    const html =
      decoy +
      '<html class="actual-owned-root" style="--owned-template:magenta"><head><title>Actual chart</title></head><body class="actual-owned-body"><main style="height:300px"><button id="counter">Change range</button><output id="count">0</output></main><script>document.documentElement.dataset.actualAuthoredVisible=String(document.documentElement.dataset.cafeVisible==="true");document.getElementById("counter").onclick=()=>document.getElementById("count").value="1";</script></body></html>';
    api.inline.mockImplementationOnce(async (input) => ({ ...(await read(input)), html }));
    await render(<Fixture />);
    const frame = await loadedFrame(),
      document = frame.contentDocument!;
    expect(document.documentElement.classList.contains("actual-owned-root")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--owned-template")).toBe("magenta");
    expect(document.body.className).toBe("actual-owned-body");
    expect(document.documentElement.dataset.actualAuthoredVisible).toBe("true");
    expect(document.querySelector("template")!.content.querySelector("script")!.textContent).toBe(
      "const example='</template><html><head>';",
    );
    await userEvent.click(
      page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true }),
    );
    expect(document.getElementById("count")?.textContent).toBe("1");
  });
  it.each(["ja", "ko"] as const)(
    "uses the latest committed %s locale before authored startup code when source settles after a language change",
    async (locale) => {
      setUiLocale("en");
      const api = installApi(),
        read = api.inline.getMockImplementation()!,
        pending = deferred<VisualizationInlineResult>();
      const payload = {
        ...(await read({ threadId, artifactId, revisionId })),
        html: `<script>document.documentElement.dataset.authoredStartupLocale=document.documentElement.lang;</script>${source}`,
      };
      api.inline.mockImplementationOnce(() => pending.promise);
      const view = await render(<Fixture />);
      try {
        await vi.waitFor(() => expect(api.inline).toHaveBeenCalledOnce());
        expect(frameElement()).toBeNull();
        setUiLocale(locale);
        // This actual localized control proves the renderer committed the new
        // language before the held source response becomes executable srcdoc.
        await vi.waitFor(() =>
          expect(
            document.querySelector("[data-visualization-run]")?.getAttribute("aria-label"),
          ).toBe(uiText("Visualization actions", undefined, undefined, locale)),
        );
        pending.resolve(payload);
        const frame = await loadedFrame(),
          frameDocument = frame.contentDocument!;
        expect(frameDocument.documentElement.dataset.authoredStartupLocale).toBe(locale);
        expect(frameDocument.documentElement.lang).toBe(locale);
        expect(api.inline).toHaveBeenCalledOnce();
        expect(api.inline).toHaveBeenCalledWith({ threadId, artifactId, revisionId });
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
        setUiLocale("en");
        await vi.waitFor(() => expect(frame.contentDocument?.documentElement.lang).toBe("en"));
        expect(frame.contentDocument).toBe(frameDocument);
        expect(frameDocument.documentElement.dataset.authoredStartupLocale).toBe(locale);
        expect(api.inline).toHaveBeenCalledOnce();
        expect(api.retireInlineFrame).not.toHaveBeenCalled();
      } finally {
        // Failed assertions must still settle this fixture's held read. The
        // exact owner's unmount guard rejects any resulting late document.
        await view.unmount();
        pending.resolve(payload);
      }
    },
  );
  it("changes theme, locale and interface size without replacing or replaying the document", async () => {
    const api = installApi();
    await render(<Fixture />);
    const frame = await loadedFrame(),
      original = frame.contentDocument;
    await userEvent.click(
      page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true }),
    );
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "130%";
    setUiLocale("ja");
    await vi.waitFor(() => expect(frame.contentDocument?.documentElement.lang).toBe("ja"));
    expect(frame.contentDocument?.documentElement.classList.contains("dark")).toBe(true);
    expect(frame.contentDocument).toBe(original);
    expect(frame.contentDocument?.getElementById("count")?.textContent).toBe("1");
    expect(api.inline).toHaveBeenCalledOnce();
  });
  it("destroys a running document on a received Full-access downgrade and retires its exact action grant", async () => {
    const api = installApi(),
      actions: Parameters<typeof Fixture>[0]["actions"] = {};
    await render(<Fixture actions={actions} />);
    const frame = await loadedFrame();
    const result = await api.inline.mock.results[0]!.value;
    actions.changePermission?.("approval-required");
    await vi.waitFor(() => expect(frameElement()).toBeNull());
    await vi.waitFor(() =>
      expect(api.retireInlineFrame).toHaveBeenCalledWith({
        threadId,
        artifactId,
        revisionId,
        frameId: result.frameId,
        ticket: result.ticket,
      }),
    );
    expect(frame.isConnected).toBe(false);
  });
  it("refuses a late source reply after permission revocation, retires it, and never displays a bitmap", async () => {
    const api = installApi(),
      pending = deferred<VisualizationInlineResult>(),
      actions: Parameters<typeof Fixture>[0]["actions"] = {};
    api.inline.mockImplementationOnce(() => pending.promise);
    await render(<Fixture actions={actions} />);
    await vi.waitFor(() => expect(api.inline).toHaveBeenCalledOnce());
    actions.changePermission?.("approval-required");
    const value: VisualizationInlineResult = {
      threadId,
      artifactId,
      revisionId,
      purpose: "generated-visualization",
      fullAccess: true,
      html: source,
      frameId: crypto.randomUUID(),
      ticket: "a".repeat(64),
      expiresAtMs: Date.now() + 30_000,
    };
    pending.resolve(value);
    await vi.waitFor(() => expect(api.retireInlineFrame).toHaveBeenCalledOnce());
    expect(frameElement()).toBeNull();
    expect(fileRequest).not.toHaveBeenCalled();
  });
  it.each(["thread", "revision", "purpose", "permission"] as const)(
    "rejects a mismatched backend %s source before executing it",
    async (mismatch) => {
      const api = installApi(),
        read = api.inline.getMockImplementation()!;
      api.inline.mockImplementationOnce(
        async (input) =>
          ({
            ...(await read(input)),
            ...(mismatch === "thread"
              ? { threadId: ThreadId.make("other-chat") }
              : mismatch === "revision"
                ? {
                    revisionId: VisualizationRevisionId.make(
                      "1c1dc11a-d3a8-429f-85e1-530ff85a44c1",
                    ),
                  }
                : mismatch === "purpose"
                  ? { purpose: "mcp-app" as const }
                  : { fullAccess: false }),
          }) as VisualizationInlineResult,
      );
      await render(<Fixture />);
      await expect
        .element(page.getByText("Visualization unavailable.", { exact: true }))
        .toBeVisible();
      expect(frameElement()).toBeNull();
      expect(document.querySelector("[data-visualization-card] img")).toBeNull();
    },
  );
  it("revokes a pending source on exact environment API replacement without admitting its late bytes", async () => {
    const api = installApi(),
      pending = deferred<VisualizationInlineResult>();
    api.inline.mockImplementationOnce(() => pending.promise);
    await render(<Fixture />);
    await vi.waitFor(() => expect(api.inline).toHaveBeenCalledOnce());
    installApi();
    pending.resolve({
      threadId,
      artifactId,
      revisionId,
      purpose: "generated-visualization",
      fullAccess: true,
      html: source,
      frameId: crypto.randomUUID(),
      ticket: "a".repeat(64),
      expiresAtMs: Date.now() + 30_000,
    });
    await vi.waitFor(() => expect(api.retireInlineFrame).toHaveBeenCalledOnce());
    expect(frameElement()).toBeNull();
  });
  it("keeps source and raw JSON private until explicit inspection, escapes them, and erases them on close", async () => {
    const api = installApi();
    await render(<Fixture />);
    const frame = await loadedFrame();
    expect(api.details).not.toHaveBeenCalled();
    await inspect();
    await expect.element(page.getByText("private-json-marker", { exact: false })).toBeVisible();
    expect(api.details).toHaveBeenCalledOnce();
    expect(
      (window as unknown as { __privateExecuted?: boolean }).__privateExecuted,
    ).toBeUndefined();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenLastCalledWith(privateDetails.rawJson);
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("private-json-marker"));
    expect(frameElement()).toBe(frame);
    expect(api.inline).toHaveBeenCalledOnce();
  });
  it("rejects wrong private revisions and never displays received exception bodies", async () => {
    const api = installApi();
    api.details.mockResolvedValueOnce({
      ...privateDetails,
      revisionId: VisualizationRevisionId.make("1c1dc11a-d3a8-429f-85e1-530ff85a44c1"),
    });
    await render(<Fixture />);
    await loadedFrame();
    await inspect();
    await expect
      .element(page.getByText("Private details unavailable.", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("private-source-marker");
    api.details.mockRejectedValueOnce(new Error("private-received-error-marker"));
    await userEvent.click(page.getByRole("button", { name: "Retry", exact: true }));
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toContain("private-received-error-marker");
  });
  it("does not publish a late private detail response after closing its inspector", async () => {
    const api = installApi(),
      pending = deferred<VisualizationDetailsResult>();
    api.details.mockImplementationOnce(() => pending.promise);
    await render(<Fixture />);
    await loadedFrame();
    await inspect();
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledOnce());
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    pending.resolve(privateDetails);
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it("preserves exact private JSON pages and full-copy content without overflowing the reader", async () => {
    const api = installApi(),
      rawJson = JSON.stringify({ text: `${"x".repeat(40_000)}private-final-page-marker` });
    api.details.mockResolvedValueOnce({ ...privateDetails, rawJson });
    await render(<Fixture />);
    await loadedFrame();
    await inspect();
    await expect.element(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("private-final-page-marker");
    await userEvent.click(page.getByRole("button", { name: "Next details page", exact: true }));
    await expect
      .element(page.getByText("private-final-page-marker", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenLastCalledWith(rawJson);
  });
  it.each(["en", "ja", "ko"] as const)(
    "keeps the quiet actions and private disclosure localized in %s",
    async (locale) => {
      installApi();
      setUiLocale(locale);
      await render(<Fixture />);
      await loadedFrame();
      await inspect();
      await expect
        .element(page.getByRole("button", { name: uiText("Copy JSON"), exact: true }))
        .toBeVisible();
    },
  );
  it("requires explicit executable HTML consent and rejects a foreign export revision", async () => {
    const api = installApi();
    await render(<Fixture />);
    await loadedFrame();
    await openMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Export HTML…", exact: true }));
    await expect
      .element(
        page.getByRole("dialog", {
          name: "Export executable HTML? · Revenue explorer",
          exact: true,
        }),
      )
      .toBeVisible();
    expect(api.exportHtml).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("<p>portable-source-marker</p>"));
    api.exportHtml.mockResolvedValueOnce({
      threadId,
      artifactId,
      revisionId: VisualizationRevisionId.make("1c1dc11a-d3a8-429f-85e1-530ff85a44c1"),
      html: "foreign-export-marker",
    });
    await openMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await vi.waitFor(() => expect(api.exportHtml).toHaveBeenCalledTimes(2));
    expect(download).toHaveBeenCalledOnce();
  });
});
