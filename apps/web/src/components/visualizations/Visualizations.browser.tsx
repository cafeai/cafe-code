import "../../index.css";
import {
  EnvironmentId,
  CHAT_IMAGES_PATH,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type DesktopBridge,
  type EnvironmentApi,
} from "@cafecode/contracts";
import type {
  VisualizationDetailsResult,
  VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
  GeneratedVisualizationReference,
} from "@cafecode/contracts/visualizations";
import * as Schema from "effect/Schema";
import type {
  VisualizationHostCapacity,
  VisualizationHostEvent,
  VisualizationHostOpenInput,
} from "@cafecode/contracts/visualizationHost";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { KnownEnvironment } from "@cafecode/client-runtime";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  createEnvironmentApi,
  readEnvironmentApi,
} from "../../environmentApi";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  resetEnvironmentServiceForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  getWsConnectionStatus,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  wsConnectionStatusAtom,
} from "../../rpc/wsConnectionState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { WsRpcClient } from "../../rpc/wsRpcClient";
import { deriveTimelineEntries } from "../../session-logic";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import type { TimelineScrollDebugEventInput } from "../chat/timelineScrollDebug";
import { observeVisualizationOwner } from "./visualizationOwner";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import { VisualizationCard } from "./VisualizationCard";
import { VisualizationViewerProvider, useVisualizationScope } from "./VisualizationViewerProvider";
import { useThreadVisualizations } from "./useThreadVisualizations";
import { visualizationPresentation } from "./visualizationPresentation";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
import { visualizationClippingAncestors, visualizationGeometry } from "./visualizationGeometry";
import { createVisualizationTimelineScrollOwner } from "./visualizationTimelineScroll";
import {
  acquireVisualizationPoster,
  readVisualizationPosterAccounting,
} from "./visualizationPoster";
import { fileRequest } from "../../attachments/fileAttachments";

const registeredFixture = vi.hoisted(() => ({
  client: null as WsRpcClient | null,
  known: null as KnownEnvironment | null,
  kind: "primary" as "primary" | "saved",
}));
// Exercise the production registry, connection object, API constructor and
// ownership observer. Only the RPC transport's endpoint peer is synthetic;
// constructing this fixture cannot open a socket or contact a provider.
vi.mock("../../rpc/wsTransport", () => ({ WsTransport: vi.fn() }));
vi.mock("../../rpc/wsRpcClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../rpc/wsRpcClient")>()),
  createWsRpcClient: () => {
    if (!registeredFixture.client) throw new Error("Fixture RPC peer is absent.");
    return registeredFixture.client;
  },
}));
vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  getPrimaryKnownEnvironment: () => registeredFixture.known,
}));
vi.mock("../../environments/runtime/connection", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../environments/runtime/connection")>();
  return {
    ...original,
    // Keep the real constructor and registry. A saved-kind synthetic admitted
    // peer uses only volatile fixture auth metadata, never a login or profile.
    createEnvironmentConnection: (
      input: Parameters<typeof original.createEnvironmentConnection>[0],
    ) => original.createEnvironmentConnection({ ...input, kind: registeredFixture.kind }),
  };
});

// Only the authenticated binary transport is controlled. Real bounded response
// reading, PNG dimension admission and Chromium bitmap decoding remain intact.
// No fixture reads a provider profile, credentials or an ambient environment.
vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: vi.fn(),
}));

const environmentId = EnvironmentId.make("visualization-fixture-environment");
const threadId = ThreadId.make("visualization-fixture-chat");
const artifactId = VisualizationArtifactId.make("8bdd2475-78f0-4563-9829-f29b073c0689");
const revisionId = VisualizationRevisionId.make("4e27bd63-c586-4f50-99b5-a722994d41dc");
const leaseId = "adf6e758-2797-46b2-9817-bc6f2fc60e27";
const operationId = "ea97fb5b-25fd-4e92-8bc7-86e928414202";
const decodeGeneratedReference = Schema.decodeUnknownSync(GeneratedVisualizationReference);
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
const privateDetails: VisualizationDetailsResult = {
  threadId,
  artifactId,
  revisionId,
  source: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    source:
      "<script>window.__visualizationPrivateExecuted = true</script><p>private-source-marker</p>",
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
const originalBridge = window.desktopBridge;
const originalLocale = getUiLocale();
const copy = vi.fn(async (_value: string) => undefined);
const download = vi.fn((_value: string) => () => undefined);
vi.mock("../../lib/copyToClipboard", () => ({
  copyTextToClipboard: (value: string) => copy(value),
}));
vi.mock("./visualizationDownload", () => ({
  downloadPortableVisualization: (value: string) => download(value),
}));
vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    resolvedTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  }),
}));

function installApi(details = vi.fn(async () => privateDetails), override = true) {
  const list = vi.fn<NonNullable<EnvironmentApi["visualizations"]>["list"]>(async () => ({
    entries: [entry],
  }));
  const viewerTicket = vi.fn<NonNullable<EnvironmentApi["visualizations"]>["viewerTicket"]>(
    async () => ({
      threadId,
      artifactId,
      revisionId,
      ticket: "f".repeat(64),
      expiresAtMs: Date.now() + 10_000,
    }),
  );
  const prepare = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["prepare"]>(async () => ({
    kind: "reply",
    json: "{}",
  }));
  const resolve = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["resolve"]>(async () => ({
    json: '{"jsonrpc":"2.0","id":1,"result":{}}',
  }));
  const appDetails = vi.fn(async () => ({ json: '{"private-arguments-marker":true}' }));
  const exportHtml = vi.fn(async () => ({
    threadId,
    artifactId,
    revisionId,
    html: "<p>private-portable-source</p>",
  }));
  const discardViewerTicket = vi.fn<
    NonNullable<NonNullable<EnvironmentApi["visualizations"]>["discardViewerTicket"]>
  >(async (input) => ({
    threadId: input.threadId,
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    discarded: true,
  }));
  // Only this fixture's typed artifact namespace is used. Other backend APIs
  // are deliberately absent; these tests never start a provider or live host.
  const artifactApi = {
    visualizations: { list, details, viewerTicket, exportHtml, discardViewerTicket },
    mcpApps: { prepare, resolve, details: appDetails },
  } satisfies Pick<EnvironmentApi, "visualizations" | "mcpApps">;
  if (override)
    __setEnvironmentApiOverrideForTests(environmentId, artifactApi as unknown as EnvironmentApi);
  return {
    list,
    details,
    viewerTicket,
    prepare,
    resolve,
    appDetails,
    exportHtml,
    discardViewerTicket,
    artifactApi,
  };
}

function installRegisteredConnection(
  api: ReturnType<typeof installApi>,
  kind: "primary" | "saved" = "primary",
) {
  // Unused namespaces are deliberately inert. Actual connection registration
  // still installs all three real subscriptions and owns their exact cleanup.
  const unsubscribe = vi.fn(() => undefined);
  const peer = {
    ...api.artifactApi,
    projects: {},
    filesystem: {},
    sourceControl: {},
    vcs: {},
    git: {},
    server: {
      subscribeLifecycle: vi.fn(() => unsubscribe),
      subscribeConfig: vi.fn(() => unsubscribe),
    },
    orchestration: { subscribeShell: vi.fn(() => unsubscribe) },
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
  };
  registeredFixture.client = peer as unknown as WsRpcClient;
  registeredFixture.kind = kind;
  if (kind === "saved") {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      authState: "authenticated",
      role: "owner",
      connectedAt: "2026-10-13T01:02:03.000Z",
    });
  }
  registeredFixture.known = {
    id: environmentId,
    environmentId,
    label: "Isolated visualization peer",
    source: "manual",
    target: {
      httpBaseUrl: "https://visualization.invalid",
      wsBaseUrl: "wss://visualization.invalid/ws",
    },
  };
  recordWsConnectionOpened();
  const connection = getPrimaryEnvironmentConnection();
  expect(readEnvironmentConnection(environmentId)).toBe(connection);
  expect(connection.client).toBe(registeredFixture.client);
  return { connection, peer, unsubscribe };
}

function RegisteredHistoryFixture() {
  const history = useThreadVisualizations(environmentId, threadId, true, "native-completion");
  const listRef = useRef<LegendListRef | null>(null);
  const rows = deriveTimelineEntries([], [], [], history.entries);
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 700, height: 600 }}>
        <MessagesTimeline
          activeThreadId={threadId}
          activeThreadEnvironmentId={environmentId}
          activeProvider={ProviderDriverKind.make("codex")}
          activeTurnId={null}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          autoFollowTail
          completionDividerAfterEntryId={null}
          completionSummary={null}
          isRevertingCheckpoint={false}
          isWorking={false}
          listRef={listRef}
          markdownCwd={undefined}
          onImageExpand={() => undefined}
          onIsAtEndChange={() => undefined}
          onRevertUserMessage={() => undefined}
          onUserScrollIntent={() => undefined}
          revertTurnCountByUserMessageId={new Map()}
          stickToEndRevision={0}
          timelineEntries={rows}
          timestampFormat="24-hour"
          workspaceRoot={undefined}
        />
      </div>
    </VisualizationViewerProvider>
  );
}
function installBridge() {
  const listeners = new Set<(event: VisualizationHostEvent) => void>();
  const expiresAtMs = Date.now() + 300_000;
  const state = () => ({ leaseId, state: "active" as const, expiresAtMs });
  const open = vi.fn<NonNullable<DesktopBridge["openVisualization"]>>(async () => state());
  const update = vi.fn<NonNullable<DesktopBridge["updateVisualization"]>>(async () => state());
  const retire = vi.fn<NonNullable<DesktopBridge["retireVisualization"]>>(async () => ({
    ...state(),
    state: "retired" as const,
  }));
  const suspend = vi.fn<NonNullable<DesktopBridge["suspendVisualization"]>>(async () => true);
  const send = vi.fn<NonNullable<DesktopBridge["sendVisualizationMessage"]>>(async () => true);
  const capabilities = vi.fn<NonNullable<DesktopBridge["getVisualizationHostCapabilities"]>>(
    async () => ({
      available: true,
      reason: "ready" as const,
      maxActive: 1 as const,
      activeLeaseMs: 300000 as const,
    }),
  );
  const bridge = {
    // Real timeline mounts hydrate presentation settings through the local
    // bridge; this isolated peer returns no persisted settings or user profile.
    getClientSettings: async () => null,
    getVisualizationHostCapabilities: capabilities,
    openVisualization: open,
    updateVisualization: update,
    retireVisualization: retire,
    captureVisualization: async () => null,
    suspendVisualization: suspend,
    sendVisualizationMessage: send,
    onVisualizationHostEvent: (listener: (event: VisualizationHostEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Pick<
    DesktopBridge,
    | "getClientSettings"
    | "getVisualizationHostCapabilities"
    | "openVisualization"
    | "updateVisualization"
    | "retireVisualization"
    | "captureVisualization"
    | "suspendVisualization"
    | "sendVisualizationMessage"
    | "onVisualizationHostEvent"
  >;
  window.desktopBridge = bridge as unknown as DesktopBridge;
  return {
    open,
    update,
    retire,
    suspend,
    send,
    capabilities,
    state,
    emit: (event: VisualizationHostEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}
function Fixture({
  value = entry,
  second = false,
}: {
  value?: VisualizationTimelineEntry;
  second?: boolean;
}) {
  const [mounted, setMounted] = useState(true);
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 700, height: 600 }}>
        <button onClick={() => setMounted(false)}>Recycle card</button>
        {mounted ? (
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={value}
            timestampFormat="24-hour"
          />
        ) : null}
        {second ? (
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={{
              ...value,
              reference: {
                ...value.reference,
                artifactId: VisualizationArtifactId.make("487ff16c-9561-447c-abf0-4f551d30a35c"),
              },
            }}
            timestampFormat="24-hour"
          />
        ) : null}
      </div>
    </VisualizationViewerProvider>
  );
}

/** Synthetic native peer only; real Chromium owns layout/intersection/focus. */
function installPoolBridge(
  api: ReturnType<typeof installApi>,
  visibleLifetime = false,
  externalArtifactIds: readonly string[] = [],
) {
  const base = installBridge();
  const live = new Map<string, { input: VisualizationHostOpenInput; expiresAtMs: number | null }>();
  const tickets = new Set<string>();
  const generatedTickets = new Set<string>();
  const capacityListeners = new Set<(value: VisualizationHostCapacity) => void>();
  let sequence = 0,
    ticketSequence = 0;
  const snapshot = (): VisualizationHostCapacity => ({
    poolVersion: 1,
    sequence,
    available: true,
    viewerCount: live.size,
    freeViewers: 4 - live.size,
    preparedCount: tickets.size,
    freePreparations: 4 - tickets.size,
    mcpAppAvailable: true,
    previewBusy: false,
  });
  const capacity = () => {
    sequence += 1;
    for (const listener of capacityListeners) listener(snapshot());
  };
  const capabilities = vi.fn(async () => ({
    available: true,
    reason: "ready" as const,
    poolVersion: 1 as const,
    autoGenerated: true as const,
    maxActive: 4 as const,
    maxMcpApps: 1 as const,
    maxPreviews: 1 as const,
    activeLeaseMs: 300000 as const,
    ...(visibleLifetime ? { generatedLifecycle: "visible" as const } : {}),
  }));
  api.viewerTicket.mockImplementation(async (input) => {
    const ticket = (++ticketSequence).toString(16).padStart(64, "0");
    tickets.add(ticket);
    if (!externalArtifactIds.includes(input.artifactId)) generatedTickets.add(ticket);
    capacity();
    return { ...input, ticket, expiresAtMs: Date.now() + 60_000 };
  });
  api.discardViewerTicket.mockImplementation(async (input) => {
    const discarded = tickets.delete(input.ticket);
    generatedTickets.delete(input.ticket);
    capacity();
    return {
      threadId: input.threadId,
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      discarded,
    };
  });
  const open = vi.fn<NonNullable<DesktopBridge["openVisualization"]>>(async (input) => {
    const id = crypto.randomUUID();
    const expiresAtMs = Date.now() + 300_000;
    if (live.size >= 4 || !tickets.delete(input.ticket))
      return { leaseId: id, state: "blocked", reason: "busy", expiresAtMs };
    live.set(id, { input, expiresAtMs });
    capacity();
    return { leaseId: id, state: "active", expiresAtMs };
  });
  const update = vi.fn<NonNullable<DesktopBridge["updateVisualization"]>>(async (input) => {
    const owned = live.get(input.leaseId);
    return {
      leaseId: input.leaseId,
      state: owned ? "active" : "retired",
      expiresAtMs: owned ? owned.expiresAtMs : Date.now(),
    };
  });
  const retire = vi.fn<NonNullable<DesktopBridge["retireVisualization"]>>(async (input) => {
    const owned = live.get(input.leaseId);
    const expiresAtMs = owned ? owned.expiresAtMs : Date.now();
    live.delete(input.leaseId);
    capacity();
    return { leaseId: input.leaseId, state: "retired", expiresAtMs };
  });
  const yielded = new Map<string, number | null>();
  const yieldViewer = vi.fn<NonNullable<DesktopBridge["yieldVisualization"]>>(async (input) => {
    const owned = live.get(input.leaseId);
    const continuation = crypto.randomUUID().replaceAll("-", "").repeat(2);
    if (!owned) return { leaseId: input.leaseId, state: "quarantined", expiresAtMs: Date.now() };
    live.delete(input.leaseId);
    yielded.set(continuation, owned.expiresAtMs);
    capacity();
    return {
      leaseId: input.leaseId,
      state: "retired",
      expiresAtMs: owned.expiresAtMs,
      continuation,
    };
  });
  open.mockImplementation(async (input) => {
    const id = crypto.randomUUID();
    const generated = generatedTickets.has(input.ticket);
    const expiresAtMs = input.continuation
      ? yielded.has(input.continuation)
        ? yielded.get(input.continuation)!
        : 0
      : visibleLifetime && generated
        ? null
        : Date.now() + 300_000;
    if (
      live.size >= 4 ||
      !tickets.delete(input.ticket) ||
      (expiresAtMs !== null && expiresAtMs <= Date.now())
    )
      return {
        leaseId: id,
        state: "blocked",
        reason: "busy",
        expiresAtMs: expiresAtMs === null ? null : Math.max(0, expiresAtMs),
      };
    if (input.continuation) yielded.delete(input.continuation);
    generatedTickets.delete(input.ticket);
    live.set(id, { input, expiresAtMs });
    capacity();
    return { leaseId: id, state: "active", expiresAtMs };
  });
  const transition = vi.fn<NonNullable<DesktopBridge["beginVisualizationTransition"]>>(
    async (input) => live.has(input.leaseId),
  );
  const focus = vi.fn<NonNullable<DesktopBridge["focusVisualization"]>>(async (input) =>
    live.has(input.leaseId),
  );
  window.desktopBridge = {
    ...window.desktopBridge,
    getVisualizationHostCapabilities: capabilities,
    getVisualizationHostCapacity: async () => snapshot(),
    onVisualizationCapacityChanged: (listener) => {
      capacityListeners.add(listener);
      return () => capacityListeners.delete(listener);
    },
    openVisualization: open,
    updateVisualization: update,
    retireVisualization: retire,
    yieldVisualization: yieldViewer,
    beginVisualizationTransition: transition,
    focusVisualization: focus,
  } as DesktopBridge;
  return {
    ...base,
    open,
    update,
    retire,
    capabilities,
    transition,
    yieldViewer,
    focus,
    live,
    tickets,
    capacity,
    emit: (event: VisualizationHostEvent) => {
      if (event.state === "retired") {
        live.delete(event.leaseId);
        capacity();
      }
      base.emit(event);
    },
  };
}

function poolEntry(index: number): VisualizationTimelineEntry {
  return {
    ...entry,
    messageId: MessageId.make(`pool-message-${index}`),
    originItemId: `pool-call-${index}`,
    reference: { ...entry.reference, title: `Chart ${index}`, height: 120 },
  };
}
function PoolPane({
  first,
  count,
  focused = false,
  sameValue = false,
}: {
  first: number;
  count: number;
  focused?: boolean;
  sameValue?: boolean;
}) {
  const pane = useVisualizationScope(environmentId, threadId, true, focused);
  const [shown, setShown] = useState(true);
  return (
    <div
      data-pool-pane={first}
      style={{
        width: "min(900px,100%)",
        height: count > 1 ? "min(850px,calc(100dvh - 24px))" : 300,
        overflow: "auto",
      }}
    >
      <button onClick={() => setShown((old) => !old)}>Recycle pool {first}</button>
      <textarea aria-label={`Composer ${first}`} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
        {shown
          ? Array.from({ length: count }, (_, index) => (
              <div key={first + index} style={{ minWidth: 0, height: 250, overflow: "auto" }}>
                <VisualizationCard
                  environmentId={environmentId}
                  threadId={threadId}
                  entry={poolEntry(sameValue ? index : first + index)}
                  timestampFormat="24-hour"
                  pane={pane}
                />
              </div>
            ))
          : null}
      </div>
    </div>
  );
}
function PoolFixture({ count = 6, split = false }: { count?: number; split?: boolean }) {
  const [firstOpen, setFirstOpen] = useState(true);
  return (
    <VisualizationViewerProvider>
      {split ? <button onClick={() => setFirstOpen(false)}>Close first pane</button> : null}
      <div style={{ display: "flex", gap: 8 }}>
        {firstOpen ? <PoolPane first={0} count={split ? 1 : count} focused={!split} /> : null}
        {split ? <PoolPane first={100} count={1} focused sameValue /> : null}
      </div>
    </VisualizationViewerProvider>
  );
}
function PoolModalFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open pool modal</button>
      <PoolFixture count={1} />
      {open ? (
        <div role="dialog" aria-modal="true">
          <button onClick={() => setOpen(false)}>Close pool modal</button>
        </div>
      ) : null}
    </>
  );
}
function NearbyPoolFixture() {
  const pane = useVisualizationScope(environmentId, threadId, true);
  return (
    <div data-nearby-pool style={{ width: 700, height: 350, overflow: "auto" }}>
      <div style={{ height: 550 }} />
      <VisualizationCard
        environmentId={environmentId}
        threadId={threadId}
        entry={poolEntry(0)}
        timestampFormat="24-hour"
        pane={pane}
      />
      <div style={{ height: 700 }} />
    </div>
  );
}
/** A generated unit owns no scroll container: the surrounding chat does. */
function InlineFlowFixture({ actions }: { actions: { rerender?: () => void; intents: number[] } }) {
  const pane = useVisualizationScope(environmentId, threadId, true);
  const [revision, setRevision] = useState(0);
  actions.rerender = () => setRevision((old) => old + 1);
  return (
    <div data-inline-flow style={{ width: "min(420px,100%)", height: 360, overflow: "auto" }}>
      <p>Conversation before the chart.</p>
      <VisualizationCard
        environmentId={environmentId}
        threadId={threadId}
        entry={poolEntry(0)}
        timestampFormat="24-hour"
        pane={pane}
        onScrollIntent={() => {
          actions.intents.push(revision);
        }}
      />
      <p data-inline-flow-after>Conversation after the whole chart.</p>
    </div>
  );
}
interface PoolInlineImage {
  id: string;
  source: string;
  name: string;
  width: number;
  height: number;
}

/** Real list/layout; only the native edge-wheel sender is a synthetic peer. */
function PoolTimelineFixture({
  actions,
  scopeThread = threadId,
  empty,
  invocation = 0,
  width = 700,
  provider = "codex",
  inlineImages = [],
}: {
  actions: { grow?: () => void; trace?: (event: TimelineScrollDebugEventInput) => void };
  scopeThread?: ThreadId;
  empty?: "loading" | "blank";
  invocation?: number;
  width?: number;
  provider?: "codex" | "claudeAgent";
  inlineImages?: readonly PoolInlineImage[];
}) {
  const pane = useVisualizationScope(environmentId, scopeThread, true);
  const listRef = useRef<LegendListRef | null>(null);
  const [following, setFollowing] = useState(true);
  const [growth, setGrowth] = useState(0);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  actions.grow = () => setGrowth((old) => old + 1);
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `pool-chat-${index}`,
    kind: "message" as const,
    createdAt: entry.occurredAt,
    message: {
      id: MessageId.make(`pool-chat-${index}`),
      role: "user" as const,
      createdAt: entry.occurredAt,
      text: `Earlier message ${index}\nMeasured browser history.`,
      streaming: false,
    },
  }));
  const last = {
    id: "pool-streaming",
    kind: "message" as const,
    createdAt: entry.occurredAt,
    message: {
      id: MessageId.make("pool-streaming"),
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
        activeThreadId={scopeThread}
        activeThreadEnvironmentId={environmentId}
        activeProvider={ProviderDriverKind.make(provider)}
        activeTurnId={null}
        activeTurnInProgress={!empty}
        activeTurnStartedAt={null}
        autoFollowTail={following}
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking={!empty}
        isThreadHistoryHydrating={empty === "loading"}
        listRef={listRef}
        markdownCwd={undefined}
        onImageExpand={inlineImages.length ? setExpandedImage : () => undefined}
        onIsAtEndChange={() => undefined}
        onRevertUserMessage={() => undefined}
        onUserScrollIntent={() => setFollowing(false)}
        {...(actions.trace ? { onDebugScrollEvent: actions.trace } : {})}
        revertTurnCountByUserMessageId={new Map()}
        stickToEndRevision={0}
        timelineEntries={
          empty
            ? []
            : [
                ...messages,
                ...deriveTimelineEntries([], [], [], [poolEntry(invocation)]),
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
              ]
        }
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
/** The timeline component and ref survive both real absent-list branches. */
function SameChatListLifetimeFixture({
  actions,
  absentState,
}: {
  actions: { trace: (event: TimelineScrollDebugEventInput) => void };
  absentState: "loading" | "blank";
}) {
  const [content, setContent] = useState<"first" | "absent" | "fresh" | "old">("first");
  return (
    <>
      <button onClick={() => setContent("absent")}>Remove same-chat list</button>
      <button onClick={() => setContent("fresh")}>Restore fresh same-chat invocation</button>
      <button onClick={() => setContent("old")}>Restore old same-chat invocation</button>
      <PoolTimelineFixture
        actions={actions}
        {...(content === "absent" ? { empty: absentState } : {})}
        invocation={content === "fresh" ? 1 : 0}
      />
    </>
  );
}
function ScopedPoolTimelineFixture({
  actions,
}: {
  actions: { trace: (event: TimelineScrollDebugEventInput) => void };
}) {
  const [second, setSecond] = useState(false);
  const scopeThread = second ? ThreadId.make("visualization-second-timeline-chat") : threadId;
  return (
    <>
      <button onClick={() => setSecond(true)}>Switch exact timeline scope</button>
      {/* ChatView owns this same explicit per-chat timeline remount. A public
       * completion from the old list cannot admit the newly mounted scope. */}
      <PoolTimelineFixture key={scopeThread} scopeThread={scopeThread} actions={actions} />
    </>
  );
}
function ClippedGeometryFixture({ height = 500 }: { height?: number }) {
  return (
    <VisualizationViewerProvider>
      <div
        style={{ marginLeft: 40, marginTop: 50, width: 460, overflowX: "clip" }}
        data-visualization-horizontal-clip
      >
        <div
          data-visualization-scroll-clip
          style={{
            height,
            overflowY: "auto",
            overflowX: "hidden",
            border: "4px solid",
            padding: 12,
          }}
        >
          <div style={{ height: 40 }} />
          <div style={{ width: 640 }}>
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={{ ...entry, reference: { ...entry.reference, height: 640 } }}
              timestampFormat="24-hour"
            />
          </div>
          <div style={{ height: 800 }} />
        </div>
      </div>
    </VisualizationViewerProvider>
  );
}

/** Ordinary native wheel input, without changing a worker's device/media state. */
async function wheelVisualizationScroller(element: HTMLElement, deltaY: number) {
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
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

/** Only real numeric fixture geometry; no transcript/source/private details. */
function readVisualizationListGeometry(anchor: HTMLElement, scroller: HTMLElement) {
  const bounds = anchor.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  return {
    scrollTop: scroller.scrollTop,
    chartRowTop: anchor.closest("[data-timeline-row-id]")?.getBoundingClientRect().top ?? null,
    anchorTop: bounds.top,
    anchorHeight: bounds.height,
    visibleOverlap: Math.max(
      0,
      Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top),
    ),
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
  };
}
function InvocationFixture({
  ownerMounted = true,
  duplicate = true,
  sameInvocation = false,
}: {
  ownerMounted?: boolean;
  duplicate?: boolean;
  sameInvocation?: boolean;
}) {
  // Separate panes intentionally repeat the same exact invocation. Their
  // process-local pane owners must remain distinct across fixture rerenders,
  // as the production ChatView scope hook does.
  const ownerPane = useRef(Object.freeze({})).current;
  const duplicatePane = useRef(Object.freeze({})).current;
  const root: VisualizationTimelineEntry = {
    ...entry,
    actor: { type: "root" },
    originItemId: "root-call",
  };
  const child: VisualizationTimelineEntry = {
    ...entry,
    actor: { type: "child", id: "second-child", label: "Second inspector" },
    originItemId: "child-call",
  };
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 700, height: 600 }}>
        <div data-invocation-owner>
          {ownerMounted ? (
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={root}
              pane={ownerPane}
              timestampFormat="24-hour"
            />
          ) : null}
        </div>
        <div data-invocation-duplicate>
          {duplicate ? (
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={sameInvocation ? root : child}
              pane={duplicatePane}
              timestampFormat="24-hour"
            />
          ) : null}
        </div>
      </div>
    </VisualizationViewerProvider>
  );
}
function ModalFixture({
  second = false,
  value = entry,
}: {
  second?: boolean;
  value?: VisualizationTimelineEntry;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open unrelated modal</button>
      <Fixture second={second} value={value} />
      {open ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-background">
          Other modal
          <button onClick={() => setOpen(false)}>Close unrelated modal</button>
        </div>
      ) : null}
    </>
  );
}

/** Fixture-owned finite responses; neither the page nor the bridge starts a real host. */
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await resetEnvironmentServiceForTests();
  resetWsConnectionStateForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  registeredFixture.client = null;
  registeredFixture.known = null;
  registeredFixture.kind = "primary";
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  __resetEnvironmentApiOverridesForTests();
  setUiLocale(originalLocale);
  copy.mockClear();
  download.mockClear();
  vi.mocked(fileRequest).mockReset();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--primary");
  document.documentElement.style.removeProperty("--accent");
  document.documentElement.style.removeProperty("font-size");
});

describe("automatic visualization viewport pool", () => {
  it.each([false, true])(
    "admits generated execution only after the exact real list public load completion: StrictMode=%s",
    async (strict) => {
      const api = installApi(),
        bridge = installPoolBridge(api);
      let loaded = false;
      const completions: { tickets: number; opens: number }[] = [];
      const admittedAfterLoad: boolean[] = [];
      const nativeTicket = api.viewerTicket.getMockImplementation()!;
      api.viewerTicket.mockImplementation(async (input) => {
        admittedAfterLoad.push(loaded);
        return nativeTicket(input);
      });
      const actions: {
        grow?: () => void;
        trace: (event: TimelineScrollDebugEventInput) => void;
      } = {
        trace: (event) => {
          if (event.reason !== "initial-list-load") return;
          completions.push({
            tickets: api.viewerTicket.mock.calls.length,
            opens: bridge.open.mock.calls.length,
          });
          loaded = true;
        },
      };
      const fixture = (
        <VisualizationViewerProvider>
          <PoolTimelineFixture actions={actions} />
        </VisualizationViewerProvider>
      );
      await render(strict ? <StrictMode>{fixture}</StrictMode> : fixture);
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
      // The real installed list emits this public callback only after its
      // initial layout/scroll completes. Both private preparation and native
      // open were zero at that actual completion, not a guessed timing wait.
      expect(completions).toEqual([{ tickets: 0, opens: 0 }]);
      expect(admittedAfterLoad).toEqual([true]);
      expect(api.viewerTicket).toHaveBeenCalledOnce();
      expect(bridge.open).toHaveBeenCalledOnce();
      const [id, owned] = [...bridge.live][0]!;
      actions.grow?.();
      document.documentElement.classList.add("dark");
      window.dispatchEvent(new Event("resize"));
      bridge.capacity();
      bridge.emit({
        leaseId: id,
        state: "layout",
        layout: { height: 180, constrained: false, sequence: 1 },
      });
      await vi.waitFor(() => expect([...bridge.live.keys()]).toEqual([id]));
      expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
      expect(bridge.retire).not.toHaveBeenCalled();
      expect(api.viewerTicket).toHaveBeenCalledOnce();
      expect(bridge.open).toHaveBeenCalledOnce();
      await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
      await vi.waitFor(() => expect(bridge.live.size).toBe(0));
      actions.grow?.();
      window.dispatchEvent(new Event("resize"));
      bridge.capacity();
      await expect
        .element(page.getByRole("button", { name: "Restart", exact: true }))
        .toBeVisible();
      expect(completions).toHaveLength(1);
      expect(api.viewerTicket).toHaveBeenCalledOnce();
      expect(bridge.open).toHaveBeenCalledOnce();
    },
  );
  it("requires the new exact per-chat list completion after a scope remount", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const completions: { scope: string | null; tickets: number; opens: number }[] = [];
    await render(
      <VisualizationViewerProvider>
        <ScopedPoolTimelineFixture
          actions={{
            trace: (event) => {
              if (event.reason === "initial-list-load")
                completions.push({
                  scope: event.activeThreadId,
                  tickets: api.viewerTicket.mock.calls.length,
                  opens: bridge.open.mock.calls.length,
                });
            },
          }}
        />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const first = [...bridge.live.keys()][0]!;
    expect(completions).toEqual([{ scope: threadId, tickets: 0, opens: 0 }]);
    await userEvent.click(
      page.getByRole("button", { name: "Switch exact timeline scope", exact: true }),
    );
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    expect([...bridge.live.keys()]).not.toContain(first);
    expect(completions).toEqual([
      { scope: threadId, tickets: 0, opens: 0 },
      { scope: "visualization-second-timeline-chat", tickets: 1, opens: 1 },
    ]);
    expect(api.viewerTicket.mock.calls.map(([input]) => input.threadId)).toEqual([
      threadId,
      "visualization-second-timeline-chat",
    ]);
    expect(bridge.retire).toHaveBeenCalledOnce();
  });
  it.each(["loading", "blank"] as const)(
    "requires fresh public completion after same-chat %s removes the actual list without resetting terminal epochs",
    async (absentState) => {
      const api = installApi(),
        bridge = installPoolBridge(api);
      const completions: { tickets: number; opens: number }[] = [];
      const admittedAfterCompletion: number[] = [];
      const rejectedLoads: Record<string, unknown>[] = [];
      const nativeTicket = api.viewerTicket.getMockImplementation()!;
      api.viewerTicket.mockImplementation(async (input) => {
        admittedAfterCompletion.push(completions.length);
        return nativeTicket(input);
      });
      await render(
        <VisualizationViewerProvider>
          <SameChatListLifetimeFixture
            absentState={absentState}
            actions={{
              trace: (event) => {
                if (event.reason === "initial-list-load-rejected" && rejectedLoads.length < 4)
                  rejectedLoads.push(event.details ?? {});
                if (event.reason === "initial-list-load")
                  completions.push({
                    tickets: api.viewerTicket.mock.calls.length,
                    opens: bridge.open.mock.calls.length,
                  });
              },
            }}
          />
        </VisualizationViewerProvider>,
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      const first = [...bridge.live.keys()][0]!;
      expect(completions).toEqual([{ tickets: 0, opens: 0 }]);
      await userEvent.click(
        page.getByRole("button", { name: "Remove same-chat list", exact: true }),
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(0));
      expect(document.querySelector("[data-visualization-card]")).toBeNull();
      if (absentState === "loading")
        expect(document.querySelector("[data-thread-history-loading]")).not.toBeNull();
      else
        await expect
          .element(page.getByText("Send a message to start the conversation.", { exact: true }))
          .toBeVisible();
      expect(api.viewerTicket).toHaveBeenCalledOnce();
      expect(bridge.open).toHaveBeenCalledOnce();
      await userEvent.click(
        page.getByRole("button", { name: "Restore fresh same-chat invocation", exact: true }),
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      expect([...bridge.live.keys()]).not.toContain(first);
      // The same-chat component/ref did not remount, but the real list did. Its
      // second completion precedes the second private request/native issuance.
      expect(completions).toEqual([
        { tickets: 0, opens: 0 },
        { tickets: 1, opens: 1 },
      ]);
      expect(admittedAfterCompletion).toEqual([1, 2]);
      expect(api.viewerTicket).toHaveBeenCalledTimes(2);
      expect(bridge.open).toHaveBeenCalledTimes(2);
      await userEvent.click(
        page.getByRole("button", { name: "Remove same-chat list", exact: true }),
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(0));
      await userEvent.click(
        page.getByRole("button", { name: "Restore old same-chat invocation", exact: true }),
      );
      try {
        await expect
          .element(page.getByRole("button", { name: "Restart", exact: true }))
          .toBeVisible();
      } catch (error) {
        console.info(
          "same-chat-restoration-diagnostic",
          JSON.stringify({
            absentState,
            completions,
            rejectedLoads,
            ticketCalls: api.viewerTicket.mock.calls.length,
            openCalls: bridge.open.mock.calls.length,
            liveOwners: bridge.live.size,
          }),
        );
        throw error;
      }
      await vi.waitFor(() => expect(completions).toHaveLength(3));
      expect(completions[2]).toEqual({ tickets: 2, opens: 2 });
      expect(admittedAfterCompletion).toEqual([1, 2]);
      expect(api.viewerTicket).toHaveBeenCalledTimes(2);
      expect(bridge.open).toHaveBeenCalledTimes(2);
      expect(bridge.retire).toHaveBeenCalledTimes(2);
      expect(bridge.live.size).toBe(0);
    },
  );
  it("loads an authenticated inert poster while generated registration awaits public readiness", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
        "image/png",
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    vi.mocked(fileRequest).mockImplementation(
      async () => new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }),
    );
    const value = poolEntry(0);
    const view = await render(
      <VisualizationViewerProvider>
        <div style={{ width: "min(700px,100%)", height: 400 }}>
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={{
              ...value,
              reference: decodeGeneratedReference({
                ...value.reference,
                poster: {
                  id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd",
                  width: 16,
                  height: 16,
                },
              }),
            }}
            timestampFormat="24-hour"
            generatedAdmissionReady={false}
          />
        </div>
      </VisualizationViewerProvider>,
    );
    try {
      const image = page.getByRole("img", { name: "Saved preview of Chart 0", exact: true });
      await expect.element(image).toBeVisible();
      await vi.waitFor(() => expect((image.element() as HTMLImageElement).naturalWidth).toBe(16));
      expect(fileRequest).toHaveBeenCalledOnce();
      expect(vi.mocked(fileRequest).mock.calls[0]).toEqual([
        environmentId,
        `/api/visualizations/poster/${artifactId}/${revisionId}`,
        { signal: expect.any(AbortSignal) },
        { threadId },
      ]);
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(bridge.open).not.toHaveBeenCalled();
      expect(bridge.update).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("private-source-marker");
      expect(readVisualizationPosterAccounting().retainedItems).toBe(1);
    } finally {
      await view.unmount();
    }
    expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it("keeps four visible exact leases and admits the oldest waiting unit on native capacity", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture />);
    await vi.waitFor(() =>
      expect(
        [
          ...document.querySelectorAll<HTMLElement>('[data-visualization-native-surface="inline"]'),
        ].filter((element) => {
          const geometry = visualizationGeometry(element);
          return geometry && geometry.clipBounds.width >= 32 && geometry.clipBounds.height >= 32;
        }).length,
      ).toBeGreaterThanOrEqual(5),
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(4));
    expect(bridge.open).toHaveBeenCalledTimes(4);
    expect(api.details).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }).first());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(5));
    expect(bridge.live.size).toBe(4);
    expect(page.getByRole("button", { name: "Restart", exact: true }).all()).toHaveLength(1);
    expect(bridge.update.mock.calls.every(([input]) => input.focus !== true)).toBe(true);
  });
  it("discards the exact unused ticket after a capacity-race refusal without automatic replay", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    bridge.open.mockImplementation(async () => ({
      leaseId: crypto.randomUUID(),
      state: "blocked",
      reason: "busy",
      expiresAtMs: Date.now() + 300_000,
    }));
    await render(<PoolFixture count={1} />);
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(api.discardViewerTicket).toHaveBeenCalledWith({
      threadId,
      artifactId,
      revisionId,
      ticket: bridge.open.mock.calls[0]![0].ticket,
    });
    bridge.capacity();
    window.dispatchEvent(new Event("resize"));
    document.documentElement.classList.add("dark");
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.live.size).toBe(0);
    await userEvent.click(page.getByRole("button", { name: "Restart", exact: true }));
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.discardViewerTicket).toHaveBeenCalledTimes(2));
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  });
  it("does not renew Stop on row remount, theme, resize or native capacity", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture count={1} />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(0));
    await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
    document.documentElement.classList.add("dark");
    window.dispatchEvent(new Event("resize"));
    bridge.capacity();
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    expect(bridge.open).toHaveBeenCalledOnce();
    await userEvent.click(page.getByRole("button", { name: "Restart", exact: true }));
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
  });
  it("keeps a begun private preparation terminal through registration replay and discards its exact late ticket", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const nativeTicket = api.viewerTicket.getMockImplementation()!;
    const gate = deferred<void>();
    let prepared: Awaited<ReturnType<typeof api.viewerTicket>> | null = null;
    api.viewerTicket.mockImplementationOnce(async (input) => {
      const result = await nativeTicket(input);
      prepared = result;
      await gate.promise;
      return result;
    });
    await render(<PoolFixture count={1} />);
    await vi.waitFor(() => expect(api.viewerTicket).toHaveBeenCalledOnce());
    await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
    gate.resolve();
    await vi.waitFor(() => expect(api.discardViewerTicket).toHaveBeenCalledOnce());
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    const ticket = prepared as Awaited<ReturnType<typeof api.viewerTicket>> | null;
    expect(api.discardViewerTicket).toHaveBeenCalledWith({
      threadId,
      artifactId,
      revisionId,
      ticket: ticket!.ticket,
    });
    bridge.capacity();
    document.documentElement.classList.add("dark");
    window.dispatchEvent(new Event("resize"));
    expect(api.viewerTicket).toHaveBeenCalledOnce();
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it("does not turn a nearby-first real observer delivery on remount into an offscreen epoch", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const NativeObserver = window.IntersectionObserver;
    let holdActual = false,
      nearDeliveries = 0;
    const pending: (() => void)[] = [];
    // Delay only actual native zero-margin samples; never fabricate bounds or
    // media. This reproduces the legitimate nearby-first delivery ordering.
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super((entries, observer) => {
          if (options?.rootMargin === "300px") nearDeliveries += 1;
          if (holdActual && options?.rootMargin === "0px")
            pending.push(() => callback(entries, observer));
          else callback(entries, observer);
        }, options);
      }
    };
    try {
      await render(<PoolFixture count={1} />);
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
      await vi.waitFor(() => expect(bridge.live.size).toBe(0));
      const before = nearDeliveries;
      holdActual = true;
      await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
      await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
      await vi.waitFor(() => {
        expect(nearDeliveries).toBeGreaterThan(before);
        expect(pending.length).toBeGreaterThan(0);
      });
      holdActual = false;
      for (const deliver of pending.splice(0)) deliver();
      await expect
        .element(page.getByRole("button", { name: "Restart", exact: true }))
        .toBeVisible();
      expect(bridge.open).toHaveBeenCalledOnce();
    } finally {
      window.IntersectionObserver = NativeObserver;
    }
  });
  it("prepares only nearby data and renews a stopped unit only after real offscreen and visible samples", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(
      <VisualizationViewerProvider>
        <NearbyPoolFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(api.viewerTicket).toHaveBeenCalledOnce());
    expect(bridge.open).not.toHaveBeenCalled();
    const scroller = document.querySelector<HTMLElement>("[data-nearby-pool]")!;
    scroller.scrollTop = 500;
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(0));
    scroller.scrollTop = 0;
    await vi.waitFor(() =>
      expect(
        document
          .querySelector('[data-visualization-native-surface="inline"]')!
          .getBoundingClientRect().top,
      ).toBeGreaterThan(scroller.getBoundingClientRect().bottom),
    );
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    scroller.scrollTop = 500;
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
  });
  it("latches a modal cancellation through deferred capability and later presentation events", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const supported = await bridge.capabilities();
    bridge.capabilities.mockClear();
    const pending = deferred<Awaited<ReturnType<typeof bridge.capabilities>>>();
    bridge.capabilities.mockImplementationOnce(() => pending.promise);
    await render(<PoolModalFixture />);
    await vi.waitFor(() => expect(bridge.capabilities).toHaveBeenCalledOnce());
    await userEvent.click(page.getByRole("button", { name: "Open pool modal", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Close pool modal", exact: true }));
    pending.resolve(supported);
    bridge.capacity();
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    window.dispatchEvent(new Event("resize"));
    bridge.capacity();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it("discards a deferred automatic ticket after modal authority loss without auto retry", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const pending = deferred<Awaited<ReturnType<typeof api.viewerTicket>>>();
    api.viewerTicket.mockImplementationOnce(() => pending.promise);
    await render(<PoolModalFixture />);
    await vi.waitFor(() => expect(api.viewerTicket).toHaveBeenCalledOnce());
    await userEvent.click(page.getByRole("button", { name: "Open pool modal", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Close pool modal", exact: true }));
    pending.resolve({
      threadId,
      artifactId,
      revisionId,
      ticket: "a".repeat(64),
      expiresAtMs: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(api.discardViewerTicket).toHaveBeenCalledOnce());
    bridge.capacity();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(api.viewerTicket).toHaveBeenCalledOnce();
  });
  it("retires a late automatic open ACK and never commits visible pixels after a modal", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const nativeOpen = bridge.open.getMockImplementation()!;
    const pending = deferred<Awaited<ReturnType<typeof bridge.open>>>();
    bridge.open.mockImplementationOnce(async (input) => {
      await nativeOpen(input);
      return pending.promise;
    });
    await render(<PoolModalFixture />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const [id, native] = [...bridge.live][0]!;
    await userEvent.click(page.getByRole("button", { name: "Open pool modal", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Close pool modal", exact: true }));
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: native.expiresAtMs });
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId: id }));
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
  });
  it("ignores unrelated pre-ACK event bursts instead of poisoning another starting lease", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const nativeOpen = bridge.open.getMockImplementation()!;
    const pending = deferred<Awaited<ReturnType<typeof bridge.open>>>();
    bridge.open.mockImplementationOnce(async (input) => {
      await nativeOpen(input);
      return pending.promise;
    });
    await render(<PoolFixture count={1} />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    for (let index = 0; index < 20; index += 1)
      bridge.emit({
        leaseId: crypto.randomUUID(),
        openingTicket: "b".repeat(64),
        state: "quarantined",
      });
    const [id, native] = [...bridge.live][0]!;
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: native.expiresAtMs });
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("keeps same-chat same-call inactive split panes independent on closure", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture split />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const original = new Set(bridge.live.keys());
    await userEvent.click(page.getByRole("button", { name: "Close first pane", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    expect(bridge.retire).toHaveBeenCalledOnce();
    expect(original.has([...bridge.live.keys()][0]!)).toBe(true);
    expect(bridge.open).toHaveBeenCalledTimes(2);
  });
  it("bounds deferred private preparation to two and discards exact cancelled replies", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const pending: ReturnType<typeof deferred<Awaited<ReturnType<typeof api.viewerTicket>>>>[] = [];
    api.viewerTicket.mockImplementation(() => {
      const request = deferred<Awaited<ReturnType<typeof api.viewerTicket>>>();
      pending.push(request);
      return request.promise;
    });
    await render(<PoolFixture />);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(bridge.open).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Recycle pool 0", exact: true }));
    for (let index = 0; index < pending.length; index += 1)
      pending[index]!.resolve({
        threadId,
        artifactId,
        revisionId,
        ticket: String(index + 1).repeat(64),
        expiresAtMs: Date.now() + 60_000,
      });
    await vi.waitFor(() => expect(api.discardViewerTicket).toHaveBeenCalledTimes(2));
    expect(new Set(api.discardViewerTicket.mock.calls.map(([input]) => input.ticket)).size).toBe(2);
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it("keeps a poster until the exact visible commit ACK and never requests auto focus", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const pending =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge["updateVisualization"]>>>>();
    bridge.update.mockImplementationOnce(() => pending.promise);
    await render(<PoolFixture count={1} />);
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalledOnce());
    expect(page.getByRole("button", { name: "Expand", exact: true }).all()).toHaveLength(0);
    const [id, native] = [...bridge.live][0]!;
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: native.expiresAtMs });
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    expect(bridge.update.mock.calls[0]![0].focus).toBeUndefined();
  });
  it("yields siblings before Expand and resumes only the original remaining deadline", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture count={2} />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const original = new Map([...bridge.live].map(([id, value]) => [id, value.expiresAtMs]));
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }).first());
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(bridge.yieldViewer).toHaveBeenCalledOnce();
    expect(bridge.transition).toHaveBeenCalledOnce();
    expect(bridge.live.size).toBe(1);
    const chosen = [...bridge.live.keys()][0]!;
    expect(original.has(chosen)).toBe(true);
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    expect(bridge.open).toHaveBeenCalledTimes(3);
    const resumed = bridge.open.mock.calls.at(-1)![0];
    expect(resumed.continuation).toMatch(/^[0-9a-f]{64}$/);
    expect(
      [...bridge.live.values()].every((value) =>
        [...original.values()].includes(value.expiresAtMs),
      ),
    ).toBe(true);
    const focusedUpdates = bridge.update.mock.calls.filter(([input]) => input.focus === true);
    expect(focusedUpdates).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }).first());
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const toolbar = page
      .getByRole("button", { name: "Back to chat", exact: true })
      .element() as HTMLElement;
    toolbar.focus();
    const before = bridge.update.mock.calls.length;
    window.dispatchEvent(new Event("resize"));
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => expect(bridge.update.mock.calls.length).toBeGreaterThan(before));
    expect(document.activeElement).toBe(toolbar);
    expect(bridge.update.mock.calls.filter(([input]) => input.focus === true)).toHaveLength(2);
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
  });
  it("preserves the expanded exact document when its same invocation row remounts", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture count={1} />);
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const original = [...bridge.live.keys()][0]!;
    const recycle = page
      .getByRole("button", { name: "Recycle pool 0", exact: true })
      .element() as HTMLButtonElement;
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    // Recycled list state is not a gesture to the hidden background document.
    recycle.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-visualization-card]")).toHaveLength(0),
    );
    recycle.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-visualization-card]")).toHaveLength(1),
    );
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    expect([...bridge.live.keys()]).toEqual([original]);
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("enters only the chosen chart on a real keyboard gesture and never on mount", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(<PoolFixture count={2} />);
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Expand", exact: true }).all()).toHaveLength(2),
    );
    expect(bridge.focus).not.toHaveBeenCalled();
    const shell = page
      .getByRole("group", {
        name: "Interactive visualization: Chart 0. Press Enter to interact.",
        exact: true,
      })
      .element() as HTMLElement;
    shell.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(bridge.focus).toHaveBeenCalledOnce());
    const bounds = visualizationGeometry(shell)!.bounds;
    const exact = [...bridge.live].filter(
      ([, value]) => JSON.stringify(value.input.bounds) === JSON.stringify(bounds),
    );
    expect(exact).toHaveLength(1);
    expect(bridge.focus.mock.calls[0]![0].leaseId).toBe(exact[0]![0]);
    expect(bridge.update.mock.calls.every(([input]) => input.focus !== true)).toBe(true);
  });
  it("keeps the exact automatic viewer alive when its timeline callback rerenders", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions: { grow?: () => void } = {};
    await render(
      <VisualizationViewerProvider>
        <PoolTimelineFixture actions={actions} />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const original = [...bridge.live.keys()][0]!;
    actions.grow?.();
    for (let frame = 0; frame < 6; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(bridge.retire).not.toHaveBeenCalled();
    expect([...bridge.live.keys()]).toEqual([original]);
    expect(bridge.open).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
  });
  it("flows exact generated natural height into the chat without renewing or re-registering its live viewer", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions: { rerender?: () => void; intents: number[] } = { intents: [] };
    await render(
      <VisualizationViewerProvider>
        <InlineFlowFixture actions={actions} />
      </VisualizationViewerProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Run", exact: true }).all()).toHaveLength(0);
    const [id, owned] = [...bridge.live][0]!;
    const shell = document.querySelector<HTMLElement>("[data-inline-flow]")!;
    const anchor = shell.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const initialHeight = anchor.getBoundingClientRect().height;
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 560, constrained: false, sequence: 1 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(560));
    expect(initialHeight).toBeLessThan(560);
    expect(shell.scrollHeight).toBeGreaterThan(shell.clientHeight);
    expect(anchor.scrollHeight).toBe(anchor.clientHeight);
    expect(
      shell.querySelector<HTMLElement>("[data-inline-flow-after]")!.getBoundingClientRect().top,
    ).toBeGreaterThan(anchor.getBoundingClientRect().bottom);
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([input]) =>
            input.leaseId === id && input.bounds.height === 560 && input.clipBounds!.height < 560,
        ),
      ).toBe(true),
    );
    actions.rerender?.();
    document.documentElement.classList.add("dark");
    window.dispatchEvent(new Event("resize"));
    shell.scrollTop = 20;
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: -12 } });
    expect(actions.intents).toEqual([1]);
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
    expect(anchor.getBoundingClientRect().height).toBe(560);
    expect(document.body.textContent).not.toContain("Inline content limit reached.");
  });
  it("refuses stale foreign and malformed natural layout while retaining exact bounded flow after Stop", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions = { intents: [] as number[] };
    await render(
      <VisualizationViewerProvider>
        <InlineFlowFixture actions={actions} />
      </VisualizationViewerProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const id = [...bridge.live.keys()][0]!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 360, constrained: false, sequence: 2 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(360));
    for (const event of [
      {
        leaseId: crypto.randomUUID(),
        state: "layout" as const,
        layout: { height: 620, constrained: false, sequence: 3 },
      },
      {
        leaseId: id,
        state: "layout" as const,
        layout: { height: 620, constrained: false, sequence: 1 },
      },
      {
        leaseId: id,
        state: "layout" as const,
        layout: { height: 620, constrained: false, sequence: 2 },
      },
      ...[NaN, Infinity, 79, 2001, 360.5].map((height) => ({
        leaseId: id,
        state: "layout" as const,
        layout: { height, constrained: false, sequence: 3 },
      })),
      {
        leaseId: id,
        state: "layout" as const,
        layout: { height: 620, constrained: false, sequence: 100001 },
      },
    ])
      bridge.emit(event);
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(anchor.getBoundingClientRect().height).toBe(360);
    expect(bridge.retire).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 620, constrained: false, sequence: 4 },
    });
    expect(anchor.getBoundingClientRect().height).toBe(360);
    expect(bridge.open).toHaveBeenCalledOnce();
  });
  it("coalesces early exact-ticket layouts independently of lifecycle queues until the exact open ACK", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const nativeOpen = bridge.open.getMockImplementation()!;
    const pending = deferred<Awaited<ReturnType<typeof bridge.open>>>();
    bridge.open.mockImplementationOnce(async (input) => {
      await nativeOpen(input);
      return pending.promise;
    });
    await render(<PoolFixture count={1} />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const [id, owned] = [...bridge.live][0]!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const originalHeight = anchor.getBoundingClientRect().height;
    bridge.emit({
      leaseId: id,
      openingTicket: "f".repeat(64),
      state: "layout",
      layout: { height: 600, constrained: false, sequence: 1000 },
    });
    for (let sequence = 1; sequence <= 100; sequence += 1)
      bridge.emit({
        leaseId: id,
        openingTicket: owned.input.ticket,
        state: "layout",
        layout: { height: 120 + sequence, constrained: false, sequence },
      });
    expect(anchor.getBoundingClientRect().height).toBe(originalHeight);
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: owned.expiresAtMs });
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(220));
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
  });
  it("keeps constrained inline height honest while expanded geometry retains the same exact document", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    await render(
      <VisualizationViewerProvider>
        <InlineFlowFixture actions={{ intents: [] }} />
      </VisualizationViewerProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const [id, owned] = [...bridge.live][0]!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 2000, constrained: true, sequence: 1 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(2000));
    await expect
      .element(page.getByText("Inline content limit reached. Expand to inspect.", { exact: true }))
      .toBeInTheDocument();
    // Align once with actual browser wheel input. Both the footer control and
    // a meaningful native anchor intersection must remain visible: scrolling
    // the footer of a tiny nested grid cell into view could legitimately make
    // the source wholly offscreen and retire it on returning from expansion.
    const shell = document.querySelector<HTMLElement>("[data-inline-flow]")!;
    const expand = page.getByRole("button", { name: "Expand", exact: true });
    const control = expand.element().getBoundingClientRect();
    const viewport = shell.getBoundingClientRect();
    await wheelVisualizationScroller(
      shell,
      control.top + control.height / 2 - (viewport.bottom - 80),
    );
    await vi.waitFor(() => {
      const aligned = expand.element().getBoundingClientRect();
      expect(aligned.top).toBeGreaterThanOrEqual(viewport.top);
      expect(aligned.bottom).toBeLessThanOrEqual(viewport.bottom);
      expect(visualizationGeometry(anchor)?.clipBounds?.height).toBeGreaterThanOrEqual(64);
    });
    await userEvent.click(expand);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([input]) => input.leaseId === id && input.displayMode === "fullscreen",
        ),
      ).toBe(true),
    );
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 480, constrained: false, sequence: 2 },
    });
    for (let frame = 0; frame < 3; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(anchor.getBoundingClientRect().height).toBe(2000);
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await expect.element(expand).toBeVisible();
    expect(anchor.getBoundingClientRect().height).toBe(2000);
    expect(visualizationGeometry(anchor)?.clipBounds?.height).toBeGreaterThanOrEqual(64);
    expect([...bridge.live.keys()]).toEqual([id]);
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 480, constrained: false, sequence: 3 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(480));
    expect(bridge.open).toHaveBeenCalledOnce();
    expect([...bridge.live.keys()]).toEqual([id]);
    expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("hands native upward chart wheel intent to only its real timeline before streaming layout", async () => {
    const trace: { reason: string; metrics: TimelineScrollDebugEventInput["metrics"] }[] = [];
    let loaded = false;
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions: { grow?: () => void; trace: (event: TimelineScrollDebugEventInput) => void } = {
        trace: (event) => {
          if (event.reason === "initial-list-load") loaded = true;
          if (trace.length < 64) trace.push({ reason: event.reason, metrics: event.metrics });
        },
      };
    await render(
      <VisualizationViewerProvider>
        <PoolTimelineFixture actions={actions} />
        <div data-unrelated-scroll style={{ height: 80, overflow: "auto" }}>
          <div style={{ height: 400 }} />
        </div>
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const anchor = document.querySelector<HTMLElement>(
      '[data-pool-timeline] [data-visualization-native-surface="inline"]',
    )!;
    const scroller = visualizationClippingAncestors(anchor)!.find(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight,
    )!;
    const other = document.querySelector<HTMLElement>("[data-unrelated-scroll]")!;
    other.scrollTop = 40;
    const initialTop = scroller.scrollTop;
    const geometryBefore = readVisualizationListGeometry(anchor, scroller);
    const id = [...bridge.live.keys()][0]!;
    const started = performance.now();
    const samples: { phase: string; elapsedMs: number; scrollTop: number; loaded: boolean }[] = [];
    const sample = (phase: string) => {
      if (samples.length < 32)
        samples.push({
          phase,
          elapsedMs: Math.round(performance.now() - started),
          scrollTop: scroller.scrollTop,
          loaded,
        });
    };
    const actualScroll = () => sample("actual-dom-scroll");
    scroller.addEventListener("scroll", actualScroll);
    try {
      sample("before-native-wheel");
      bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: -80 } });
      sample("after-native-wheel");
      actions.grow?.();
      sample("after-grow-request");
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-pool-timeline][data-following="false"]'),
        ).not.toBeNull(),
      );
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        sample(`frame-${frame + 1}`);
      }
      console.info(
        "visualization-native-wheel-list-diagnostic",
        JSON.stringify({
          initialTop,
          geometryBefore,
          geometryAfter: readVisualizationListGeometry(anchor, scroller),
          live: bridge.live.size,
          trace,
          samples,
        }),
      );
      expect(scroller.scrollTop).toBeCloseTo(initialTop - 80, 0);
      expect(other.scrollTop).toBe(40);
    } finally {
      scroller.removeEventListener("scroll", actualScroll);
    }
  });
  it("keeps natural-height growth in its real list while preserving follow-tail and subsequent review ownership", async () => {
    const trace: { reason: string; metrics: TimelineScrollDebugEventInput["metrics"] }[] = [];
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions: { grow?: () => void; trace: (event: TimelineScrollDebugEventInput) => void } = {
        trace: (event) => {
          if (trace.length < 64) trace.push({ reason: event.reason, metrics: event.metrics });
        },
      };
    await render(
      <VisualizationViewerProvider>
        <PoolTimelineFixture actions={actions} />
      </VisualizationViewerProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const [id, owned] = [...bridge.live][0]!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-pool-timeline] [data-visualization-native-surface="inline"]',
    )!;
    const scroller = visualizationClippingAncestors(anchor)!.find(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight,
    )!;
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 360, constrained: false, sequence: 1 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(360));
    await vi.waitFor(() =>
      expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThan(1),
    );
    const beforeWheel = scroller.scrollTop;
    bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: -80 } });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-pool-timeline][data-following="false"]')).not.toBeNull(),
    );
    await vi.waitFor(() => expect(scroller.scrollTop).toBeCloseTo(beforeWheel - 80, 0));
    const reviewTop = scroller.scrollTop;
    const anchorTop = anchor.getBoundingClientRect().top;
    const geometryBefore = readVisualizationListGeometry(anchor, scroller);
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 560, constrained: false, sequence: 2 },
    });
    actions.grow?.();
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(560));
    for (let frame = 0; frame < 6; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    console.info(
      "visualization-natural-flow-list-diagnostic",
      JSON.stringify({
        reviewTop,
        actualTop: scroller.scrollTop,
        anchorTop,
        actualAnchorTop: anchor.getBoundingClientRect().top,
        geometryBefore,
        geometryAfter: readVisualizationListGeometry(anchor, scroller),
        live: bridge.live.size,
        trace,
      }),
    );
    expect(scroller.scrollTop).toBeCloseTo(reviewTop, 0);
    expect(anchor.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0);
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
  });
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
        bridge = installPoolBridge(api, true),
        actions: { grow?: () => void } = {};
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      let view: Awaited<ReturnType<typeof render>> | undefined;
      try {
        // This case deliberately contrasts full-pane charts with capped prose.
        // Use the runner's supported viewport API, not CSS/media overrides, and
        // restore its exact incoming dimensions even if render/assertion fails.
        await page.viewport(1200, 900);
        view = await render(
          <VisualizationViewerProvider>
            <PoolTimelineFixture
              actions={actions}
              provider={provider}
              inlineImages={images}
              width={1100}
            />
          </VisualizationViewerProvider>,
        );
        await vi.waitFor(() => expect(bridge.live.size).toBe(1));
        // Two independent completed messages have exact separate manifests.
        // Keep both binary replies held so metadata, not image load timing,
        // is what reserves the first larger row in the real virtualized list.
        const [id, owned] = [...bridge.live][0]!;
        expect(owned.expiresAtMs).toBeNull();
        await vi.waitFor(() =>
          expect(bridge.update).toHaveBeenCalledWith(
            expect.objectContaining({ leaseId: id, visible: true }),
          ),
        );
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
          '[data-pool-timeline] [data-visualization-native-surface="inline"]',
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
        const initialImageHeights = hosts.map((host) => host.getBoundingClientRect().height);
        expect(initialImageHeights).toEqual([64, 64]);
        const expectSharedWidth = () => {
          const style = getComputedStyle(scroller);
          const available =
            scroller.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight);
          expect(
            Math.abs(anchor.getBoundingClientRect().width - Math.min(1600, available)),
          ).toBeLessThanOrEqual(1);
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
        bridge.emit({
          leaseId: id,
          state: "layout",
          layout: { height: 180, constrained: false, sequence: 1 },
        });
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
        const beforeWheel = scroller.scrollTop;
        bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: -64 } });
        await vi.waitFor(() => {
          expect(
            document.querySelector('[data-pool-timeline][data-following="false"]'),
          ).not.toBeNull();
          expect(scroller.scrollTop).toBeCloseTo(beforeWheel - 64, 0);
        });
        const reviewTop = scroller.scrollTop;
        const anchorTop = anchor.getBoundingClientRect().top;
        // New image metadata and a native intrinsic-height update arrive after
        // real review intent. Neither may take over the user's scroll owner,
        // rebuild the already decoded first image, or replace the chart lease.
        peers[1]!.releaseManifest();
        bridge.emit({
          leaseId: id,
          state: "layout",
          layout: { height: 240, constrained: false, sequence: 2 },
        });
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
        for (let frame = 0; frame < 6; frame += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(scroller.scrollTop).toBeCloseTo(reviewTop, 0);
        expect(anchor.getBoundingClientRect().top).toBeCloseTo(anchorTop, 0);
        expect(firstImage.element()).toBe(imageNode);
        expect(firstImage.element().getAttribute("src")).toBe(imageSource);
        expectSharedWidth();
        expect(fileRequest).toHaveBeenCalledTimes(startupRequests + 2);
        expect(bridge.open).toHaveBeenCalledOnce();
        expect(bridge.retire).not.toHaveBeenCalled();
        expect([...bridge.live.keys()]).toEqual([id]);
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
    "retires the exact %s chart when its real Markdown image opens the existing preview dialog without later revival",
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
        bridge = installPoolBridge(api, true),
        actions: { grow?: () => void } = {};
      const view = await render(
        <VisualizationViewerProvider>
          <PoolTimelineFixture actions={actions} provider={provider} inlineImages={images} />
        </VisualizationViewerProvider>,
      );
      try {
        await vi.waitFor(() => expect(bridge.live.size).toBe(1));
        const id = [...bridge.live.keys()][0]!;
        await vi.waitFor(() =>
          expect(bridge.update).toHaveBeenCalledWith(
            expect.objectContaining({ leaseId: id, visible: true }),
          ),
        );
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
        await vi.waitFor(() => {
          expect(bridge.retire).toHaveBeenCalledOnce();
          expect(bridge.retire).toHaveBeenCalledWith({ leaseId: id });
          expect(bridge.live.size).toBe(0);
        });
        const terminalUpdates = bridge.update.mock.calls.length;
        // Actual image preview is an unrelated modal, not a generated private
        // inspector. Closing it or receiving stale layout must not revive the
        // retired native generation while ordinary image ownership survives.
        await userEvent.click(
          page.getByRole("button", { name: "Close image preview", exact: true }).last(),
        );
        await expect.element(dialog).not.toBeInTheDocument();
        bridge.emit({
          leaseId: id,
          state: "layout",
          layout: { height: 300, constrained: false, sequence: 1 },
        });
        actions.grow?.();
        for (let frame = 0; frame < 6; frame += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(
          bridge.update.mock.calls.slice(terminalUpdates).filter(([input]) => input.visible),
        ).toEqual([]);
        expect(bridge.open).toHaveBeenCalledOnce();
        expect(bridge.retire).toHaveBeenCalledOnce();
        expect(bridge.retire).toHaveBeenCalledWith({ leaseId: id });
        expect(bridge.live.size).toBe(0);
        expect(fileRequest).toHaveBeenCalledTimes(decodedRequests);
        expect(image.element()).toBe(imageNode);
        expect(image.element().getAttribute("src")).toBe(source);
        expect(api.details).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );
  async function checkRapidNativeChartDeltas(strict: boolean) {
    const api = installApi(),
      bridge = installPoolBridge(api),
      actions: { grow?: () => void } = {};
    const fixture = (
      <VisualizationViewerProvider>
        <PoolTimelineFixture actions={actions} />
      </VisualizationViewerProvider>
    );
    await render(strict ? <StrictMode>{fixture}</StrictMode> : fixture);
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    const [id, owned] = [...bridge.live][0]!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-pool-timeline] [data-visualization-native-surface="inline"]',
    )!;
    const scroller = visualizationClippingAncestors(anchor)!.find(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight,
    )!;
    const initialTop = scroller.scrollTop;
    actions.grow?.();
    // Do not await between native relays: a public list command may still be
    // waiting on the simultaneous data measurement. Physical deltas must be
    // cumulative, not calculated repeatedly from an unchanged pending target.
    for (const deltaY of [-24, -32, -24])
      bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY } });
    for (let frame = 0; frame < 6; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBeCloseTo(initialTop - 80, 0);
    expect(document.querySelector('[data-pool-timeline][data-following="false"]')).not.toBeNull();
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
  }
  it("applies rapid native chart deltas once while replacing deferred targets in its real list under StrictMode", () =>
    checkRapidNativeChartDeltas(true));
  it("applies rapid native chart deltas once while replacing deferred targets in its real list", () =>
    checkRapidNativeChartDeltas(false));
  it.each(["native-down", "keyboard-down"] as const)(
    "preserves fresh downward input over a natural-height correction in its real list: %s",
    async (mode) => {
      const api = installApi(),
        bridge = installPoolBridge(api),
        actions: { grow?: () => void } = {};
      await render(
        <VisualizationViewerProvider>
          <PoolTimelineFixture actions={actions} />
        </VisualizationViewerProvider>,
      );
      await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
      const [id, owned] = [...bridge.live][0]!;
      const anchor = document.querySelector<HTMLElement>(
        '[data-pool-timeline] [data-visualization-native-surface="inline"]',
      )!;
      const scroll = visualizationClippingAncestors(anchor)!.find(
        (element) =>
          /auto|scroll/.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight,
      )!;
      bridge.emit({
        leaseId: id,
        state: "layout",
        layout: { height: 360, constrained: false, sequence: 1 },
      });
      await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(360));
      bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: -80 } });
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-pool-timeline][data-following="false"]'),
        ).not.toBeNull(),
      );
      bridge.emit({
        leaseId: id,
        state: "layout",
        layout: { height: 560, constrained: false, sequence: 2 },
      });
      actions.grow?.();
      await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(560));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const before = scroll.scrollTop;
      if (mode === "native-down")
        bridge.emit({ leaseId: id, state: "wheel", wheel: { deltaX: 0, deltaY: 40 } });
      else {
        scroll.tabIndex = 0;
        scroll.focus();
        await userEvent.keyboard("{ArrowDown}");
      }
      await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(before));
      const moved = scroll.scrollTop;
      for (let frame = 0; frame < 6; frame += 1)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (mode === "native-down") expect(scroll.scrollTop).toBeCloseTo(before + 40, 0);
      else expect(scroll.scrollTop).toBeGreaterThanOrEqual(moved);
      expect(document.querySelector('[data-pool-timeline][data-following="false"]')).not.toBeNull();
      expect(bridge.open).toHaveBeenCalledOnce();
      expect(bridge.retire).not.toHaveBeenCalled();
      expect(bridge.live.get(id)?.expiresAtMs).toBe(owned.expiresAtMs);
    },
  );
  it("keeps actual fresh wheel observation when a chart-only deferred list promise settles", async () => {
    // Real DOM/ResizeObserver and real browser wheel input; only the public
    // list's finite deferred-command completion is synthetic here. This pins
    // the cleanup race independently of the actual LegendList tests above.
    await render(
      <div data-deferred-chart-scroll style={{ width: 700, height: 300, overflow: "auto" }}>
        <div style={{ height: 60 }} />
        <div data-deferred-chart-anchor style={{ height: 360 }} />
        <div style={{ height: 600 }} />
      </div>,
    );
    const scroll = document.querySelector<HTMLElement>("[data-deferred-chart-scroll]")!;
    const anchor = document.querySelector<HTMLElement>("[data-deferred-chart-anchor]")!;
    const completions: ReturnType<typeof deferred<void>>[] = [];
    const offsets: number[] = [];
    const scrollToOffset = vi.fn(({ offset }: { offset: number; animated?: boolean }) => {
      offsets.push(offset);
      const completion = deferred<void>();
      completions.push(completion);
      return completion.promise;
    });
    const list = { getScrollableNode: () => scroll, scrollToOffset } satisfies Pick<
      LegendListRef,
      "getScrollableNode" | "scrollToOffset"
    >;
    const owner = createVisualizationTimelineScrollOwner({
      readList: () => list,
      following: () => false,
    });
    const observeScroll = () => owner.observeScroll();
    const interrupt = () => {
      owner.interrupt();
      // An older imperative command can finish in a microtask before the
      // browser dispatches the scroll produced by this fresh default action.
      completions[0]!.resolve();
    };
    scroll.addEventListener("scroll", observeScroll);
    scroll.addEventListener("wheel", interrupt, { passive: true });
    try {
      scroll.scrollTop = 100;
      const originalTop = anchor.getBoundingClientRect().top;
      const cancel = owner.preserve(anchor, 560);
      expect(cancel).toBeTypeOf("function");
      anchor.style.height = "560px";
      // Synthetic library size anchoring shifts a later row; the helper's
      // physical correction is real and must restore the exact chart top.
      scroll.scrollTop += 200;
      await vi.waitFor(() => expect(scrollToOffset).toHaveBeenCalledOnce());
      expect(scroll.scrollTop).toBe(100);
      expect(anchor.getBoundingClientRect().top).toBeCloseTo(originalTop, 0);
      await wheelVisualizationScroller(scroll, 40);
      await vi.waitFor(() => expect(scroll.scrollTop).toBe(140));
      await vi.waitFor(() => expect(scrollToOffset).toHaveBeenCalledTimes(2));
      expect(offsets).toEqual([100, 140]);
      completions[1]!.resolve();
      await Promise.resolve();
      owner.close();
      const callsAtClose = scrollToOffset.mock.calls.length;
      scroll.scrollTop = 160;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(scrollToOffset).toHaveBeenCalledTimes(callsAtClose);
    } finally {
      scroll.removeEventListener("scroll", observeScroll);
      scroll.removeEventListener("wheel", interrupt);
      owner.close();
      for (const completion of completions) completion.resolve();
    }
  });
  it.each(["cancelled-chart-wheel", "native-command-keyboard"] as const)(
    "supersedes the latest synthetic deferred list token after fresh actual input: %s",
    async (mode) => {
      // This model preserves the installed library's documented token behavior:
      // every new command resolves/replaces the previous queued command; flushing
      // applies only the latest target. Real DOM and device-owned input remain
      // actual browser behavior, separately from real-list qualification above.
      await render(
        <div
          data-token-chart-scroll
          tabIndex={0}
          style={{ width: 700, height: 300, overflow: "auto" }}
        >
          <div style={{ height: 60 }} />
          <div data-token-chart-anchor style={{ height: 360 }} />
          <div style={{ height: 600 }} />
        </div>,
      );
      const scroll = document.querySelector<HTMLElement>("[data-token-chart-scroll]")!;
      const anchor = document.querySelector<HTMLElement>("[data-token-chart-anchor]")!;
      type Queued = { offset: number; completion: ReturnType<typeof deferred<void>> };
      let queued: Queued | null = null;
      const scrollToOffset = vi.fn(({ offset }: { offset: number; animated?: boolean }) => {
        const previous = queued;
        const completion = deferred<void>();
        queued = { offset, completion };
        previous?.completion.resolve();
        return completion.promise;
      });
      const list = { getScrollableNode: () => scroll, scrollToOffset } satisfies Pick<
        LegendListRef,
        "getScrollableNode" | "scrollToOffset"
      >;
      const owner = createVisualizationTimelineScrollOwner({
        readList: () => list,
        following: () => false,
      });
      const observe = () => owner.observeScroll();
      const interrupt = () => owner.interrupt();
      scroll.addEventListener("scroll", observe);
      scroll.addEventListener("wheel", interrupt, { passive: true });
      scroll.addEventListener("keydown", interrupt);
      try {
        scroll.scrollTop = mode === "cancelled-chart-wheel" ? 100 : 300;
        if (mode === "cancelled-chart-wheel") {
          const cancel = owner.preserve(anchor, 560)!;
          anchor.style.height = "560px";
          scroll.scrollTop += 200;
          await vi.waitFor(() => expect(scrollToOffset).toHaveBeenCalledOnce());
          cancel();
          expect(scrollToOffset).toHaveBeenCalledTimes(2);
        } else expect(owner.scroll(-80)).toBe(true);
        const before = scroll.scrollTop;
        if (mode === "cancelled-chart-wheel") await wheelVisualizationScroller(scroll, 40);
        else {
          await userEvent.click(scroll);
          await userEvent.keyboard("{ArrowDown}");
        }
        await vi.waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(before));
        for (let frame = 0; frame < 3; frame += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const actualAfterInput = scroll.scrollTop;
        const latest = queued as Queued | null;
        expect(latest?.offset).toBe(actualAfterInput);
        expect(latest?.offset).toBeGreaterThan(before);
        scroll.scrollTop = latest!.offset;
        latest!.completion.resolve();
        queued = null;
        for (let frame = 0; frame < 3; frame += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(scroll.scrollTop).toBeGreaterThanOrEqual(actualAfterInput);
        owner.close();
        const calls = scrollToOffset.mock.calls.length;
        scroll.scrollTop += 20;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(scrollToOffset).toHaveBeenCalledTimes(calls);
      } finally {
        scroll.removeEventListener("scroll", observe);
        scroll.removeEventListener("wheel", interrupt);
        scroll.removeEventListener("keydown", interrupt);
        owner.close();
        (queued as Queued | null)?.completion.resolve();
      }
    },
  );
  it("releases a rejected Expand transition without freezing future capacity work", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    bridge.transition.mockResolvedValueOnce(false);
    await render(<PoolFixture count={2} />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }).first());
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(3));
    expect(page.getByRole("dialog").all()).toHaveLength(0);
    expect(bridge.live.size).toBe(1);
  });
  it("makes native expiry terminal and never automatically restarts external Apps", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api);
    const app = {
      ...entry,
      originItemId: "external-app-call",
      reference: { ...entry.reference, purpose: "mcp-app" as const, serverLabel: "Fixture server" },
    };
    await render(
      <VisualizationViewerProvider>
        <VisualizationCard
          environmentId={environmentId}
          threadId={threadId}
          entry={app}
          timestampFormat="24-hour"
          generatedAdmissionReady={false}
        />
        <PoolPane first={0} count={1} />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledOnce());
    expect(api.prepare).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    const expired = [...bridge.live.keys()][0]!;
    bridge.emit({ leaseId: expired, state: "retired", reason: "expired" });
    bridge.capacity();
    await expect.element(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    expect(bridge.open).toHaveBeenCalledOnce();
  });
});

/** The current policy has a quiet host strip and no guest-owned scroll region.
 * Native lifecycle is synthetic here; real Chromium supplies crop/intersection,
 * focus, actual wheel input and popup/inertness. Native masking is separate. */
function SeamlessVisibleFixture() {
  const pane = useVisualizationScope(environmentId, threadId, true);
  return (
    <div
      data-seamless-visible
      style={{ width: "min(1100px,100%)", height: 360, overflowY: "auto", overflowX: "hidden" }}
    >
      <p data-seamless-before>Conversation before the chart.</p>
      <VisualizationCard
        environmentId={environmentId}
        threadId={threadId}
        entry={entry}
        timestampFormat="24-hour"
        pane={pane}
      />
      <p data-seamless-after>Conversation after the whole chart.</p>
      <div style={{ height: 900 }} />
    </div>
  );
}

describe("visibility-owned seamless generated cards", () => {
  it.each([false, true])(
    "keeps the default clean and reveals an accessible menu without resizing or private reads: dark=%s",
    async (dark) => {
      document.documentElement.classList.toggle("dark", dark);
      const api = installApi(),
        bridge = installPoolBridge(api, true);
      await render(
        <VisualizationViewerProvider>
          <SeamlessVisibleFixture />
        </VisualizationViewerProvider>,
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      const id = [...bridge.live.keys()][0]!;
      await vi.waitFor(() =>
        expect(
          bridge.update.mock.calls.some(
            ([value]) => value.leaseId === id && value.presentationHidden === false,
          ),
        ).toBe(true),
      );
      const anchor = document.querySelector<HTMLElement>(
        '[data-visualization-native-surface="inline"]',
      )!;
      const card = anchor.closest<HTMLElement>("[data-visualization-card]")!;
      const height = card.getBoundingClientRect().height;
      const trigger = page.getByRole("button", { name: "Visualization actions", exact: true });
      // Native pointer position persists between cases in this owned browser
      // context. Move it to real in-view prose before testing idle hover CSS;
      // never replace hover media, force styles, or scroll the chart offscreen.
      await userEvent.hover(document.querySelector<HTMLElement>("[data-seamless-before]")!);
      await vi.waitFor(() => expect(card.matches(":hover")).toBe(false));
      expect(document.body.textContent).not.toContain("maximum five-minute session");
      expect(document.body.textContent).not.toContain("Private source and JSON");
      expect(page.getByRole("button", { name: "Stop", exact: true }).all()).toHaveLength(0);
      expect(api.details).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("private-json-marker");
      await vi.waitFor(() =>
        expect(getComputedStyle(trigger.element()).opacity).toBe(
          matchMedia("(hover: hover)").matches ? "0" : "1",
        ),
      );
      await userEvent.hover(trigger.element());
      await vi.waitFor(() => expect(getComputedStyle(trigger.element()).opacity).toBe("1"));
      await userEvent.click(trigger);
      await expect.element(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
      expect(
        bridge.update.mock.calls.some(
          ([value]) => value.leaseId === id && value.presentationHidden === true,
        ),
      ).toBe(true);
      expect(card.getBoundingClientRect().height).toBe(height);
      expect(document.body.textContent).toContain("Interactive while visible");
      const popup = page.getByRole("menu").element();
      const surface = getComputedStyle(popup).backgroundColor;
      expect(surface).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(popup).color).not.toBe(surface);
      expect(api.details).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(page.getByRole("menu").query()).toBeNull());
      await expect.element(trigger).toHaveFocus();
      await vi.waitFor(() =>
        expect(bridge.update.mock.calls.at(-1)?.[0].presentationHidden).toBe(false),
      );
      expect(card.getBoundingClientRect().height).toBe(height);
      expect(bridge.open).toHaveBeenCalledOnce();
      expect(bridge.retire).not.toHaveBeenCalled();
      expect(bridge.live.get(id)?.expiresAtMs).toBeNull();
    },
  );

  it("balances rapid menu hide/restore for both live siblings without restarting either document", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <PoolPane first={0} count={2} />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const ids = [...bridge.live.keys()];
    const trigger = page
      .getByRole("button", { name: "Visualization actions", exact: true })
      .first();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await userEvent.click(trigger);
      await expect.element(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
      for (const id of ids)
        expect(
          bridge.update.mock.calls.some(
            ([value]) => value.leaseId === id && value.presentationHidden === true,
          ),
        ).toBe(true);
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(page.getByRole("menu").query()).toBeNull());
      for (const id of ids)
        await vi.waitFor(() =>
          expect(
            bridge.update.mock.calls.filter(([value]) => value.leaseId === id).at(-1)?.[0]
              .presentationHidden,
          ).toBe(false),
        );
    }
    expect([...bridge.live.keys()]).toEqual(ids);
    expect(bridge.open).toHaveBeenCalledTimes(2);
    expect(bridge.retire).not.toHaveBeenCalled();
  });

  it("bounds presentation walks when every native ACK reinserts its published controller", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <PoolPane first={0} count={2} />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const ids = [...bridge.live.keys()];
    // Native open is not evidence that initial geometry has already completed.
    // Start this menu-phase counter only after both exact startup ACKs, so the
    // <=2 witness covers each direct overlay update and coalesced geometry
    // update, not a third unrelated initial false presentation sample.
    for (const id of ids) {
      await vi.waitFor(() =>
        expect(
          bridge.update.mock.calls.some(
            ([value]) => value.leaseId === id && value.presentationHidden === false,
          ),
        ).toBe(true),
      );
      const initial = bridge.update.mock.calls.findIndex(
        ([value]) => value.leaseId === id && value.presentationHidden === false,
      );
      const acknowledgement = await bridge.update.mock.results[initial]!.value;
      expect(acknowledgement).toMatchObject({ leaseId: id, state: "active" });
    }
    const updates = new Map<string, number>();
    const update = bridge.update.getMockImplementation()!;
    bridge.update.mockImplementation(async (input) => {
      if (input.presentationHidden !== undefined) {
        const key = `${input.leaseId}:${input.presentationHidden}`;
        const count = (updates.get(key) ?? 0) + 1;
        updates.set(key, count);
        // A repeated live-Map revisit fails the fixture instead of starving its
        // original deadline. The real Slot still publishes every successful
        // ACK and replaces/reinserts its controller through its layout effect.
        if (count > 4) throw new Error("presentation-walk-revisited-controller");
      }
      return update(input);
    });
    await userEvent.click(
      page.getByRole("button", { name: "Visualization actions", exact: true }).first(),
    );
    await expect.element(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(page.getByRole("menu").query()).toBeNull());
    for (const id of ids)
      await vi.waitFor(() =>
        expect(
          bridge.update.mock.calls.filter(([value]) => value.leaseId === id).at(-1)?.[0]
            .presentationHidden,
        ).toBe(false),
      );
    for (const count of updates.values()) expect(count).toBeLessThanOrEqual(2);
    expect([...bridge.live.keys()]).toEqual(ids);
    expect(bridge.open).toHaveBeenCalledTimes(2);
    expect(bridge.retire).not.toHaveBeenCalled();
  });

  it("refuses an unacknowledged hide before mounting a menu and never reads private source", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <SeamlessVisibleFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const update = bridge.update.getMockImplementation()!;
    bridge.update.mockImplementation(async (input) =>
      input.presentationHidden
        ? { leaseId: input.leaseId, state: "blocked", reason: "invalid", expiresAtMs: null }
        : update(input),
    );
    await userEvent.click(page.getByRole("button", { name: "Visualization actions", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(0));
    expect(page.getByRole("menu").query()).toBeNull();
    expect(api.details).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
  });

  it("cannot revive terminal ownership through a delayed menu-hide acknowledgement", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <SeamlessVisibleFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const id = [...bridge.live.keys()][0]!;
    const pending = deferred<{ leaseId: string; state: "active"; expiresAtMs: null }>();
    const update = bridge.update.getMockImplementation()!;
    let held = false;
    bridge.update.mockImplementation(async (input) => {
      if (input.presentationHidden && !held) {
        held = true;
        return pending.promise;
      }
      return update(input);
    });
    await userEvent.click(page.getByRole("button", { name: "Visualization actions", exact: true }));
    await vi.waitFor(() => expect(held).toBe(true));
    bridge.emit({ leaseId: id, state: "retired" });
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: null });
    for (let frame = 0; frame < 4; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(page.getByRole("menu").query()).toBeNull();
    expect(api.details).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.live.size).toBe(0);
  });

  it("cancels a not-yet-mounted menu and restores its exact hidden document before a late hide ACK", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <SeamlessVisibleFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const id = [...bridge.live.keys()][0]!;
    const pending = deferred<{ leaseId: string; state: "active"; expiresAtMs: null }>();
    const update = bridge.update.getMockImplementation()!;
    let held = false;
    bridge.update.mockImplementation(async (input) => {
      if (input.presentationHidden && !held) {
        held = true;
        return pending.promise;
      }
      return update(input);
    });
    const trigger = page.getByRole("button", { name: "Visualization actions", exact: true });
    await userEvent.click(trigger);
    await vi.waitFor(() => expect(held).toBe(true));
    trigger.element().focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.filter(([value]) => value.leaseId === id).at(-1)?.[0]
          .presentationHidden,
      ).toBe(false),
    );
    pending.resolve({ leaseId: id, state: "active", expiresAtMs: null });
    for (let frame = 0; frame < 4; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(page.getByRole("menu").query()).toBeNull();
    expect([...bridge.live.keys()]).toEqual([id]);
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(api.details).not.toHaveBeenCalled();
  });

  it("releases a pending menu fence on exact Card unmount without reviving its terminal source", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(<Fixture second />);
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const ids = [...bridge.live.keys()];
    // The first menu belongs to the first artifact, not whichever controller
    // a global hide walk happens to visit first after asynchronous native ACKs.
    // Bind both exact artifact replies through their unique preparation ticket
    // to the synthetic native lease instead of using Map insertion order.
    const grants = await Promise.all(api.viewerTicket.mock.results.map((result) => result.value));
    expect(grants).toHaveLength(2);
    const selectedGrants = grants.filter((grant) => grant.artifactId === artifactId);
    const siblingGrants = grants.filter(
      (grant) => grant.artifactId === "487ff16c-9561-447c-abf0-4f551d30a35c",
    );
    expect(selectedGrants).toHaveLength(1);
    expect(siblingGrants).toHaveLength(1);
    const selectedIds = ids.filter(
      (id) => bridge.live.get(id)!.input.ticket === selectedGrants[0]!.ticket,
    );
    const siblingIds = ids.filter(
      (id) => bridge.live.get(id)!.input.ticket === siblingGrants[0]!.ticket,
    );
    expect(selectedIds).toHaveLength(1);
    expect(siblingIds).toHaveLength(1);
    const selected = selectedIds[0]!;
    const sibling = siblingIds[0]!;
    expect(selected).not.toBe(sibling);
    const pending = deferred<{ leaseId: string; state: "active"; expiresAtMs: null }>();
    const update = bridge.update.getMockImplementation()!;
    let held: string | null = null;
    bridge.update.mockImplementation(async (input) => {
      if (input.presentationHidden && !held) {
        held = input.leaseId;
        return pending.promise;
      }
      return update(input);
    });
    await userEvent.click(
      page.getByRole("button", { name: "Visualization actions", exact: true }).first(),
    );
    await vi.waitFor(() => expect(held).not.toBeNull());
    await userEvent.click(page.getByRole("button", { name: "Recycle card", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    expect(bridge.live.has(selected)).toBe(false);
    expect(bridge.live.has(sibling)).toBe(true);
    expect(bridge.retire.mock.calls.some(([input]) => input.leaseId === selected)).toBe(true);
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.filter(([value]) => value.leaseId === sibling).at(-1)?.[0]
          .presentationHidden,
      ).toBe(false),
    );
    pending.resolve({ leaseId: held!, state: "active", expiresAtMs: null });
    for (let frame = 0; frame < 4; frame += 1)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(page.getByRole("menu").query()).toBeNull();
    expect([...bridge.live.keys()]).toEqual([sibling]);
    expect(bridge.live.has(selected)).toBe(false);
    expect(bridge.open).toHaveBeenCalledTimes(2);
    expect(api.details).not.toHaveBeenCalled();
  });

  it("keeps manual Apps finite and never automatically restores one after a generated menu overlay", async () => {
    const appArtifactId = VisualizationArtifactId.make("487ff16c-9561-447c-abf0-4f551d30a35c");
    const api = installApi(),
      bridge = installPoolBridge(api, true, [appArtifactId]);
    const app = {
      ...entry,
      originItemId: "manual-visible-policy-app",
      reference: {
        ...entry.reference,
        artifactId: appArtifactId,
        purpose: "mcp-app" as const,
        serverLabel: "Fixture server",
      },
    };
    await render(
      <VisualizationViewerProvider>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            width: "min(1000px,100%)",
          }}
        >
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={entry}
            timestampFormat="24-hour"
          />
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={app}
            timestampFormat="24-hour"
          />
        </div>
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const generated = [...bridge.live.keys()][0]!;
    expect(bridge.live.get(generated)?.expiresAtMs).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    const appLease = [...bridge.live.keys()].find((id) => id !== generated)!;
    expect(bridge.live.get(appLease)?.expiresAtMs).toBeGreaterThan(Date.now());
    await userEvent.click(page.getByRole("button", { name: "Visualization actions", exact: true }));
    await expect.element(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
    await vi.waitFor(() => expect([...bridge.live.keys()]).toEqual([generated]));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(page.getByRole("menu").query()).toBeNull());
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.filter(([value]) => value.leaseId === generated).at(-1)?.[0]
          .presentationHidden,
      ).toBe(false),
    );
    expect(bridge.open).toHaveBeenCalledTimes(2);
    expect([...bridge.live.keys()]).toEqual([generated]);
    const appRun = page.getByRole("button", { name: "Run", exact: true });
    await expect.element(appRun).toBeVisible();
    // The overlay stop is deliberately not an ordinary user Stop: it must not
    // steal menu focus. A fresh, explicit App Run still retains the original
    // exact-card focus restoration when the user subsequently stops it.
    await expect
      .element(page.getByRole("button", { name: "Visualization actions", exact: true }))
      .toHaveFocus();
    await userEvent.click(appRun);
    await vi.waitFor(() => expect(bridge.live.size).toBe(2));
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toHaveFocus();
    expect([...bridge.live.keys()]).toEqual([generated]);
    expect(bridge.open).toHaveBeenCalledTimes(3);
  });

  it("opens private JSON only on explicit inspection and restores the same document after closing", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <SeamlessVisibleFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const id = [...bridge.live.keys()][0]!;
    const trigger = page.getByRole("button", { name: "Visualization actions", exact: true });
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("menuitem", { name: "Private source and JSON", exact: true }))
      .toBeVisible();
    await userEvent.click(
      page.getByRole("menuitem", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("private-source-marker", { exact: false })).toBeVisible();
    expect(api.details).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("private-json-marker");
    expect(
      (window as unknown as { __visualizationPrivateExecuted?: boolean })
        .__visualizationPrivateExecuted,
    ).toBeUndefined();
    expect(bridge.update.mock.calls.at(-1)?.[0].presentationHidden).toBe(true);
    expect(bridge.retire).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("private-json-marker"));
    await vi.waitFor(() =>
      expect(bridge.update.mock.calls.at(-1)?.[0].presentationHidden).toBe(false),
    );
    expect([...bridge.live.keys()]).toEqual([id]);
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.retire).not.toHaveBeenCalled();
  });

  it.each(["Private source and JSON", "Export HTML…"] as const)(
    "keeps surviving sibling pixels hidden through a terminal source and the %s inspector exit",
    async (action) => {
      const api = installApi(),
        bridge = installPoolBridge(api, true);
      await render(
        <VisualizationViewerProvider>
          <PoolPane first={0} count={2} />
        </VisualizationViewerProvider>,
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(2));
      const [selected, sibling] = [...bridge.live.keys()];
      const update = bridge.update.getMockImplementation()!;
      const prematureRestores: string[] = [];
      bridge.update.mockImplementation(async (input) => {
        if (
          input.presentationHidden === false &&
          document.querySelector("[data-visualization-inspection], [data-visualization-menu]")
        )
          prematureRestores.push(input.leaseId);
        return update(input);
      });
      await userEvent.click(
        page.getByRole("button", { name: "Visualization actions", exact: true }).first(),
      );
      await userEvent.click(page.getByRole("menuitem", { name: action, exact: true }));
      if (action === "Private source and JSON")
        await expect
          .element(page.getByText("private-source-marker", { exact: false }))
          .toBeVisible();
      else
        await expect
          .element(
            page.getByRole("dialog", { name: "Export executable HTML? · Chart 0", exact: true }),
          )
          .toBeVisible();
      bridge.emit({ leaseId: selected!, state: "retired" });
      for (let frame = 0; frame < 4; frame += 1)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect([...bridge.live.keys()]).toEqual([sibling]);
      expect(
        bridge.update.mock.calls.filter(([value]) => value.leaseId === sibling).at(-1)?.[0]
          .presentationHidden,
      ).toBe(true);
      if (action === "Private source and JSON")
        expect(document.body.textContent).toContain("private-json-marker");
      else expect(api.details).not.toHaveBeenCalled();
      expect(prematureRestores).toEqual([]);
      await userEvent.click(
        page.getByRole("button", {
          name: action === "Private source and JSON" ? "Close" : "Cancel",
          exact: true,
        }),
      );
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("private-json-marker"),
      );
      await vi.waitFor(() =>
        expect(
          bridge.update.mock.calls.filter(([value]) => value.leaseId === sibling).at(-1)?.[0]
            .presentationHidden,
        ).toBe(false),
      );
      expect(document.querySelector("[data-visualization-inspection]")).toBeNull();
      expect(prematureRestores).toEqual([]);
      expect(bridge.open).toHaveBeenCalledTimes(2);
      expect([...bridge.live.keys()]).toEqual([sibling]);
    },
  );

  it.each(["Copy current PNG", "Expand"] as const)(
    "waits for the menu exit before restoring native presentation for %s",
    async (action) => {
      const api = installApi(),
        bridge = installPoolBridge(api, true);
      await render(
        <VisualizationViewerProvider>
          <SeamlessVisibleFixture />
        </VisualizationViewerProvider>,
      );
      await vi.waitFor(() => expect(bridge.live.size).toBe(1));
      const update = bridge.update.getMockImplementation()!;
      const prematureRestores: string[] = [];
      bridge.update.mockImplementation(async (input) => {
        if (
          input.presentationHidden === false &&
          document.querySelector("[data-visualization-menu]")
        )
          prematureRestores.push(input.leaseId);
        return update(input);
      });
      const capture = vi.fn<NonNullable<DesktopBridge["captureVisualization"]>>(async () => null);
      window.desktopBridge!.captureVisualization = capture;
      await userEvent.click(
        page.getByRole("button", { name: "Visualization actions", exact: true }),
      );
      await userEvent.click(page.getByRole("menuitem", { name: action, exact: true }));
      if (action === "Expand")
        await expect
          .element(page.getByRole("dialog", { name: entry.reference.title }))
          .toBeVisible();
      else await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      expect(document.querySelector("[data-visualization-menu]")).toBeNull();
      expect(prematureRestores).toEqual([]);
      expect(bridge.retire).not.toHaveBeenCalled();
      expect(bridge.open).toHaveBeenCalledOnce();
    },
  );

  it("retains one document through real partial-edge scrolling and retires only after whole offscreen", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <SeamlessVisibleFixture />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const id = [...bridge.live.keys()][0]!;
    const shell = document.querySelector<HTMLElement>("[data-seamless-visible]")!;
    const anchor = shell.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    bridge.emit({
      leaseId: id,
      state: "layout",
      layout: { height: 560, constrained: false, sequence: 1 },
    });
    await vi.waitFor(() => expect(anchor.getBoundingClientRect().height).toBe(560));
    expect(anchor.scrollHeight).toBe(anchor.clientHeight);
    expect(anchor.scrollWidth).toBe(anchor.clientWidth);
    expect(
      shell.querySelector<HTMLElement>("[data-seamless-after]")!.getBoundingClientRect().top,
    ).toBeGreaterThanOrEqual(anchor.getBoundingClientRect().bottom);
    const nearEdge =
      shell.scrollTop +
      anchor.getBoundingClientRect().bottom -
      shell.getBoundingClientRect().top -
      12;
    shell.scrollTop = nearEdge;
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([value]) =>
            value.leaseId === id &&
            value.bounds.height === 560 &&
            value.clipBounds!.height > 0 &&
            value.clipBounds!.height < 32,
        ),
      ).toBe(true),
    );
    expect(bridge.retire).not.toHaveBeenCalled();
    // Physical browser input returns from the positive edge crop. No device,
    // hover media, worker context or assertion is fabricated by the peer.
    await wheelVisualizationScroller(shell, -100);
    await vi.waitFor(() => expect(shell.scrollTop).toBeLessThan(nearEdge));
    expect(bridge.open).toHaveBeenCalledOnce();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect([...bridge.live.keys()]).toEqual([id]);
    shell.scrollTop = nearEdge + 60;
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledOnce());
    expect(bridge.live.size).toBe(0);
  });

  it("uses the full real chat column for generated charts while preserving prose reading width", async () => {
    const api = installApi(),
      bridge = installPoolBridge(api, true);
    await render(
      <VisualizationViewerProvider>
        <PoolTimelineFixture actions={{}} width={1100} />
      </VisualizationViewerProvider>,
    );
    await vi.waitFor(() => expect(bridge.live.size).toBe(1));
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const scroller = visualizationClippingAncestors(anchor)!.find(
      (element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight,
    )!;
    const style = getComputedStyle(scroller);
    const available =
      scroller.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    expect(
      Math.abs(anchor.getBoundingClientRect().width - Math.min(1600, available)),
    ).toBeLessThanOrEqual(1);
    expect(scroller.scrollWidth).toBe(scroller.clientWidth);
    expect(anchor.scrollWidth).toBe(anchor.clientWidth);
    for (const row of document.querySelectorAll<HTMLElement>('[data-timeline-row-kind="message"]'))
      expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(768);
  });
});

describe("registered visualization connection ownership", () => {
  it("loads registered-connection history into the real timeline without an API override", async () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const bridge = installBridge();
    const view = await render(<RegisteredHistoryFixture />);
    try {
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith({ threadId }));
      await expect.element(page.getByText(entry.reference.title)).toBeVisible();
      expect(readEnvironmentApi(environmentId)).toBe(readEnvironmentApi(environmentId));
      expect(document.querySelectorAll("[data-visualization-card]")).toHaveLength(1);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(bridge.open).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("private-json-marker");
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await expect.element(page.getByText("private-json-marker", { exact: false })).toBeVisible();
      expect(api.details).toHaveBeenCalledOnce();
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("private-json-marker"),
      );
      await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
      await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      expect(api.viewerTicket).toHaveBeenCalledOnce();
      expect(bridge.open).toHaveBeenCalledOnce();
      recordWsConnectionClosed();
      await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(document.querySelector("[data-visualization-card]")).toBeNull(),
      );
    } finally {
      await view.unmount();
    }
  });

  it("keeps constructor semantics but revokes a replaced exact registry connection with the same peer", async () => {
    const api = installApi(undefined, false);
    const { connection, peer } = installRegisteredConnection(api);
    const firstApi = readEnvironmentApi(environmentId);
    const revoked = vi.fn();
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      expect(firstApi).toBe(readEnvironmentApi(environmentId));
      expect(createEnvironmentApi(connection.client)).not.toBe(
        createEnvironmentApi(connection.client),
      );
      await resetEnvironmentServiceForTests();
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalled();
      const replacement = getPrimaryEnvironmentConnection();
      expect(replacement).not.toBe(connection);
      expect(replacement.client).toBe(connection.client);
      expect(readEnvironmentApi(environmentId)).not.toBe(firstApi);
      expect(readEnvironmentApi(environmentId)).toBe(readEnvironmentApi(environmentId));
      expect(owner.current()).toBe(false);
      expect(peer.dispose).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("drops a late private detail response after transport generation revocation", async () => {
    const pending = deferred<VisualizationDetailsResult>();
    const api = installApi(
      vi.fn(() => pending.promise),
      false,
    );
    installRegisteredConnection(api);
    const view = await render(<RegisteredHistoryFixture />);
    try {
      await expect.element(page.getByText(entry.reference.title)).toBeVisible();
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await vi.waitFor(() => expect(api.details).toHaveBeenCalledOnce());
      recordWsConnectionClosed();
      pending.resolve(privateDetails);
      recordWsConnectionOpened();
      await expect.element(page.getByText(entry.reference.title)).toBeVisible();
      expect(document.body.textContent).not.toContain("private-json-marker");
      expect(api.details).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });

  it("retires a late native open acknowledgement without a visible commit after connection loss", async () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const bridge = installBridge();
    const pending =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge["openVisualization"]>>>>();
    bridge.open.mockImplementation(() => pending.promise);
    const view = await render(<RegisteredHistoryFixture />);
    try {
      await expect.element(page.getByText(entry.reference.title)).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
      await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledOnce());
      recordWsConnectionClosed();
      pending.resolve(bridge.state());
      await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
      expect(bridge.update.mock.calls.some(([input]) => input.visible)).toBe(false);
      expect(bridge.open).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });

  it.each(["role", "auth"] as const)(
    "keeps pending private details revoked after saved %s loss and same-generation recovery",
    async (loss) => {
      const pending = deferred<VisualizationDetailsResult>();
      const api = installApi(
        vi.fn(() => pending.promise),
        false,
      );
      const { connection } = installRegisteredConnection(api, "saved");
      const admitted = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
      if (!admitted) throw new Error("Fixture saved owner metadata is absent.");
      const view = await render(<Fixture />);
      try {
        await userEvent.click(
          page.getByRole("button", { name: "Private source and JSON", exact: true }),
        );
        await vi.waitFor(() => expect(api.details).toHaveBeenCalledOnce());
        // Loss and recovery are deliberately synchronous and retain the exact
        // connection/API/timestamp. Pending bytes still require a NEW gesture.
        useSavedEnvironmentRuntimeStore
          .getState()
          .patch(
            environmentId,
            loss === "role" ? { role: "client" } : { authState: "requires-auth" },
          );
        useSavedEnvironmentRuntimeStore.getState().patch(environmentId, admitted);
        expect(readEnvironmentConnection(environmentId)).toBe(connection);
        expect(useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.connectedAt).toBe(
          admitted.connectedAt,
        );
        pending.resolve(privateDetails);
        await expect.element(page.getByText("Private details unavailable.")).toBeVisible();
        expect(document.body.textContent).not.toContain("private-json-marker");
        expect(document.body.textContent).not.toContain("private-source-marker");
        expect(api.details).toHaveBeenCalledOnce();
        // Collapse/reopen is an explicit new disclosure owner, not recovery of
        // the revoked pending operation. The now-authorized owner may fetch.
        await userEvent.click(
          page.getByRole("button", { name: "Private source and JSON", exact: true }),
        );
        await userEvent.click(
          page.getByRole("button", { name: "Private source and JSON", exact: true }),
        );
        await expect.element(page.getByText("private-json-marker", { exact: false })).toBeVisible();
        expect(api.details).toHaveBeenCalledTimes(2);
      } finally {
        await view.unmount();
      }
    },
  );

  it("latches saved authority loss before notifying once and never revives its owner", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api, "saved");
    const admitted = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
    if (!admitted) throw new Error("Fixture saved owner metadata is absent.");
    const revoked = vi.fn(() => expect(owner.current()).toBe(false));
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { role: "client" });
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, admitted);
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { authState: "unknown" });
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, admitted);
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("latches an invalid snapshot without a read-side notification or later resurrection", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const revoked = vi.fn();
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      // Test-only adapter replacement has no registry notification: current()
      // must observe loss without invoking external callbacks during render.
      __setEnvironmentApiOverrideForTests(
        environmentId,
        api.artifactApi as unknown as EnvironmentApi,
      );
      expect(owner.current()).toBe(false);
      expect(revoked).not.toHaveBeenCalled();
      __resetEnvironmentApiOverridesForTests();
      expect(owner.current()).toBe(false);
      const admitted = getWsConnectionStatus();
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("never revives a primary owner after same-clock close and open observations", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const admitted = getWsConnectionStatus();
    const revoked = vi.fn(() => expect(owner.current()).toBe(false));
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted, phase: "disconnected" });
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      expect(getWsConnectionStatus().connectedAt).toBe(admitted.connectedAt);
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });
});

describe("generated visualization presentation", () => {
  it.each([false, true])(
    "keeps received long labels and every action inside a real narrow chart shell for App %s",
    async (app) => {
      installApi();
      installBridge();
      const actorLabel = "Review".repeat(24),
        serverLabel = "Source".repeat(24);
      const value: VisualizationTimelineEntry = {
        ...entry,
        actor: { type: "child", id: "narrow-child", label: actorLabel },
        reference: app ? { ...entry.reference, purpose: "mcp-app", serverLabel } : entry.reference,
      };
      await render(
        <VisualizationViewerProvider>
          <div style={{ width: "min(180px,100%)" }}>
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={value}
              timestampFormat="24-hour"
            />
          </div>
        </VisualizationViewerProvider>,
      );
      await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
      await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      const card = document.querySelector<HTMLElement>("[data-visualization-card]")!;
      const bounds = card.getBoundingClientRect();
      expect(card.textContent).toContain(actorLabel);
      if (app) expect(card.textContent).toContain(serverLabel);
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      for (const button of card.querySelectorAll("button")) {
        const rect = button.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      }
      expect(document.body.textContent).not.toContain("private-json-marker");
    },
  );
  it("keeps source/JSON private until expanded, escapes it, and clears on collapse", async () => {
    const api = installApi();
    await render(<Fixture />);
    await expect.element(page.getByText("Revenue explorer")).toBeVisible();
    expect(api.details).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-json-marker");
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("private-source-marker", { exact: false })).toBeVisible();
    expect(document.querySelector("[data-visualization-card] script")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenCalledWith(privateDetails.rawJson);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    expect(document.body.textContent).not.toContain("private-json-marker");
    expect(document.body.textContent).not.toContain("private-source-marker");
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(2));
  });
  it("refuses wrong private revision and never prints received error bodies", async () => {
    const details = vi.fn(async () => ({
      ...privateDetails,
      revisionId: VisualizationRevisionId.make("572dddf7-83e1-4505-bf08-53b67e82bb7f"),
    }));
    installApi(details);
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("Private details unavailable.")).toBeVisible();
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it("does not publish a late details read after collapse", async () => {
    let complete!: (value: VisualizationDetailsResult) => void;
    const api = installApi(
      vi.fn(
        () =>
          new Promise<VisualizationDetailsResult>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    complete(privateDetails);
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it("revokes a late private read when the exact environment adapter is replaced", async () => {
    let complete!: (value: VisualizationDetailsResult) => void;
    const api = installApi(
      vi.fn(
        () =>
          new Promise<VisualizationDetailsResult>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
    installApi();
    complete(privateDetails);
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("private-json-marker");
    expect(document.body.textContent).not.toContain("private-source-marker");
  });
  it("bounds private text layout while preserving every page and exact full-copy JSON", async () => {
    const rawJson = JSON.stringify({ text: `${"x".repeat(40_000)}private-final-page-marker` });
    installApi(vi.fn(async () => ({ ...privateDetails, rawJson })));
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("private-final-page-marker");
    await userEvent.click(page.getByRole("button", { name: "Next details page", exact: true }));
    await expect
      .element(page.getByText("private-final-page-marker", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenLastCalledWith(rawJson);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    expect(document.body.textContent).not.toContain("private-final-page-marker");
  });
  it("uses canonical child identity and native system timestamp formatting", async () => {
    installApi();
    await render(<Fixture />);
    await expect
      .element(page.getByRole("img", { name: "Layout reviewer", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(formatDiagnosticTimestamp(entry.occurredAt, "24-hour")))
      .toBeVisible();
  });
  it.each(["en", "ja", "ko"] as const)(
    "renders private disclosure and actions in %s",
    async (locale) => {
      installApi();
      setUiLocale(locale);
      await render(<Fixture />);
      await expect
        .element(page.getByRole("button", { name: uiText("Private source and JSON"), exact: true }))
        .toBeVisible();
      await userEvent.click(
        page.getByRole("button", { name: uiText("Private source and JSON"), exact: true }),
      );
      await expect
        .element(page.getByRole("button", { name: uiText("Copy JSON"), exact: true }))
        .toBeVisible();
    },
  );
  it("refuses execution in a plain browser without creating an iframe", async () => {
    const api = installApi();
    delete window.desktopBridge;
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect
      .element(page.getByText("Interactive viewing requires the local desktop host."))
      .toBeVisible();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(document.querySelector("[data-visualization-card] iframe")).toBeNull();
  });
  it("admits one native lease and preserves it through expansion and row recycling", async () => {
    installApi();
    const bridge = installBridge();
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Back to chat", exact: true }))
      .toBeVisible();
    expect(bridge.open.mock.calls[0]?.[0].displayMode).toBe("inline");
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([value]) => value.leaseId === leaseId && value.displayMode === "fullscreen",
        ),
      ).toBe(true),
    );
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.retire).not.toHaveBeenCalled();
    // Programmatic parent unmount represents virtualizer recycling, not a fake
    // mouse/media event. Real controls still exercise the native browser layout.
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-visualization-card]").length).toBe(1),
    );
    expect(bridge.retire).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(1));
  });
  it.each([false, true])(
    "binds one inline anchor independently of reused content and duplicate panes %s",
    async (sameInvocation) => {
      installApi();
      const bridge = installBridge();
      const view = await render(<InvocationFixture sameInvocation={sameInvocation} />);
      try {
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
        await expect
          .element(page.getByRole("button", { name: "Expand", exact: true }))
          .toBeVisible();
        expect(page.getByRole("button", { name: "Stop", exact: true }).all()).toHaveLength(1);
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
        expect(document.querySelector("[data-invocation-duplicate]")?.textContent).not.toContain(
          "Interactive · maximum",
        );
        await view.rerender(
          <InvocationFixture duplicate={false} sameInvocation={sameInvocation} />,
        );
        expect(bridge.retire).not.toHaveBeenCalled();
        await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await view.rerender(<InvocationFixture sameInvocation={sameInvocation} />);
        await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
        await expect
          .element(page.getByRole("button", { name: "Back to chat", exact: true }))
          .toBeVisible();
        // Recycling the active inline row must not transfer its expanded lease
        // to the other invocation/pane, nor retire the independent expanded view.
        await view.rerender(
          <InvocationFixture ownerMounted={false} sameInvocation={sameInvocation} />,
        );
        expect(bridge.retire).not.toHaveBeenCalled();
        expect(bridge.open).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[data-invocation-duplicate]")?.textContent).not.toContain(
          "Interactive · maximum",
        );
        await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
        await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(1));
        expect(bridge.retire).toHaveBeenCalledWith({ leaseId });
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
      } finally {
        await view.unmount();
      }
    },
  );
  it("does not release an uncertain native retirement or admit a competitor", async () => {
    installApi();
    const bridge = installBridge();
    bridge.retire.mockRejectedValue(new Error("private-native-error"));
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-native-error");
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
  });
  it("retires the eventual exact lease after cancellation during native open", async () => {
    installApi();
    const bridge = installBridge();
    let opened!: (value: ReturnType<typeof bridge.state>) => void;
    bridge.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Recycle card", exact: true }));
    expect(bridge.retire).not.toHaveBeenCalled();
    opened(bridge.state());
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
  });
  it("revokes a deferred capability admission when a modal opens, even after the modal closes", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<Awaited<ReturnType<typeof bridge.capabilities>>>();
    bridge.capabilities.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(bridge.capabilities).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    pending.resolve({ available: true, reason: "ready", maxActive: 1, activeLeaseMs: 300000 });
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("revokes a deferred viewer ticket before native open when an unrelated modal appears", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<Awaited<ReturnType<typeof api.viewerTicket>>>();
    api.viewerTicket.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(api.viewerTicket).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    pending.resolve({
      threadId,
      artifactId,
      revisionId,
      ticket: "f".repeat(64),
      expiresAtMs: Date.now() + 10_000,
    });
    await expect
      .element(page.getByText("Interactive viewing requires the local desktop host."))
      .toBeVisible();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(api.discardViewerTicket).toHaveBeenCalledWith({
        threadId,
        artifactId,
        revisionId,
        ticket: "f".repeat(64),
      }),
    );
  });
  it("retires a deferred native ACK without a visibility commit after modal startup revocation", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<ReturnType<typeof bridge.state>>();
    bridge.open.mockImplementationOnce(() => pending.promise);
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<ModalFixture second value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    expect(bridge.update).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(bridge.retire).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    // A valid early App message still has no authority after the modal revokes
    // startup. Neither the exact ACK nor later removal of the modal revives it.
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
    });
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    pending.resolve(bridge.state());
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
    await expect
      .element(page.getByText("Viewer stopped. Run again to start a new document."))
      .toBeVisible();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(page.getByRole("button", { name: "Expand", exact: true }).query()).toBeNull();
  });
  it("retains quarantine after a modal revokes startup and its native ACK is lost", async () => {
    installApi();
    const bridge = installBridge();
    const pending = deferred<ReturnType<typeof bridge.state>>();
    bridge.open.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    pending.reject(new Error("private-modal-open-ack-error"));
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-modal-open-ack-error");
  });
  it("keeps an uncertain open acknowledgement quarantined rather than admitting a competitor", async () => {
    installApi();
    const bridge = installBridge();
    bridge.open.mockRejectedValueOnce(new Error("private-lost-acknowledgement"));
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-lost-acknowledgement");
  });
  it("does not revive a lease whose trusted retirement event arrived before its open acknowledgement", async () => {
    installApi();
    const bridge = installBridge();
    bridge.open.mockImplementationOnce(async () => {
      bridge.emit({ leaseId, openingTicket: "f".repeat(64), state: "retired" });
      return bridge.state();
    });
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect
      .element(page.getByText("Viewer stopped. Run again to start a new document."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Expand", exact: true }).query()).toBeNull();
    expect(bridge.send).not.toHaveBeenCalled();
  });
  it("does not lose App initialization that arrives before the exact open acknowledgement", async () => {
    const api = installApi();
    const bridge = installBridge();
    bridge.open.mockImplementationOnce(async () => {
      bridge.emit({
        leaseId: "5025adcf-e51b-4c66-a12f-6d2872ecba76",
        state: "message",
        json: '{"jsonrpc":"2.0","id":8,"method":"ping"}',
      });
      bridge.emit({
        leaseId,
        openingTicket: "f".repeat(64),
        state: "message",
        json: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
      });
      return bridge.state();
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1));
    expect(api.prepare).toHaveBeenCalledWith({
      threadId,
      artifactId,
      revisionId,
      leaseId,
      ticket: "f".repeat(64),
      requestJson: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
    });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledWith({ leaseId, json: "{}" }));
  });
  it("forwards initialized original messages once in order and honors same-lease display requests", async () => {
    const api = installApi();
    const bridge = installBridge();
    api.prepare.mockResolvedValueOnce({
      kind: "reply",
      json: "",
      messages: ['{"input":true}', '{"result":true}'],
    });
    api.prepare.mockResolvedValueOnce({
      kind: "reply",
      json: '{"mode":"fullscreen"}',
      displayMode: "fullscreen",
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","method":"ui/notifications/initialized"}',
    });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(2));
    expect(bridge.send.mock.calls.map(([value]) => value.json)).toEqual([
      '{"input":true}',
      '{"result":true}',
    ]);
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":2,"method":"ui/request-display-mode","params":{"mode":"fullscreen"}}',
    });
    await expect
      .element(page.getByRole("button", { name: "Back to chat", exact: true }))
      .toBeVisible();
    expect(bridge.open).toHaveBeenCalledTimes(1);
  });
  it("updates accent, interface scale and theme without restarting or extending the lease", async () => {
    installApi();
    const bridge = installBridge();
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    document.documentElement.style.setProperty("--accent", "#ffffff");
    document.documentElement.style.setProperty("--primary", "#123abc");
    document.documentElement.style.setProperty("font-size", "20px");
    document.documentElement.classList.add("dark");
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([value]) =>
            value.presentation?.colors.accent === "#123abc" && value.presentation.scale === 1.25,
        ),
      ).toBe(true),
    );
    expect(visualizationPresentation("en").colors.accent).toBe("#123abc");
    expect(bridge.open).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Run", exact: true }).element(),
    );
  });
  it("yields an active native surface to an unrelated modal instead of drawing above it", async () => {
    installApi();
    const bridge = installBridge();
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
  });
  it("crops partial native geometry to real scrolling and horizontal ancestors without reflowing the page", async () => {
    const api = installApi();
    const bridge = installBridge();
    const view = await render(<ClippedGeometryFixture />);
    const scroller = document.querySelector<HTMLElement>("[data-visualization-scroll-clip]")!;
    const horizontal = document.querySelector<HTMLElement>("[data-visualization-horizontal-clip]")!;
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const reservedHeight = anchor.getBoundingClientRect().height;
    expect(reservedHeight).toBeLessThanOrEqual(scroller.clientHeight * 0.65);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalled());
    const original = bridge.update.mock.calls.at(-1)![0];
    expect(original.bounds.width).toBe(640);
    expect(original.clipBounds!.width).toBeLessThan(original.bounds.width);
    expect(anchor.getBoundingClientRect().height).toBe(reservedHeight);
    const beforeScroll = scroller.scrollTop;
    await wheelVisualizationScroller(scroller, 180);
    await vi.waitFor(() => {
      expect(scroller.scrollTop).toBeGreaterThan(beforeScroll);
      const latest = bridge.update.mock.calls.at(-1)![0];
      expect(latest.bounds.y).toBeLessThan(original.bounds.y);
      expect(latest.bounds.width).toBe(original.bounds.width);
      expect(latest.bounds.height).toBe(original.bounds.height);
      expect(latest.clipBounds!.y).toBeGreaterThanOrEqual(
        Math.ceil(scroller.getBoundingClientRect().top + scroller.clientTop),
      );
      expect(latest.clipBounds!.x + latest.clipBounds!.width).toBeLessThanOrEqual(
        Math.floor(horizontal.getBoundingClientRect().right),
      );
      expect(latest.clipBounds!.height).toBeLessThan(latest.bounds.height);
    });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(api.details).not.toHaveBeenCalled();
    await wheelVisualizationScroller(scroller, 800);
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
    await view.unmount();
  });
  it("resizes the same reserved inline slot with its actual pane and refuses hidden or deep ancestry", async () => {
    installApi();
    const bridge = installBridge();
    const view = await render(<ClippedGeometryFixture />);
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const oldHeight = anchor.getBoundingClientRect().height;
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await view.rerender(<ClippedGeometryFixture height={400} />);
    await vi.waitFor(() => {
      const geometry = visualizationGeometry(anchor)!;
      expect(anchor.getBoundingClientRect().height).toBeLessThan(oldHeight);
      expect(bridge.update.mock.calls.at(-1)![0].bounds).toEqual(geometry.bounds);
      expect(bridge.update.mock.calls.at(-1)![0].clipBounds).toEqual(geometry.clipBounds);
    });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    const shell = document.createElement("div");
    shell.style.cssText = "position:fixed;left:10px;top:10px;width:100px;height:100px";
    document.body.append(shell);
    try {
      shell.inert = true;
      expect(visualizationGeometry(shell)).toBeNull();
      shell.inert = false;
      shell.style.visibility = "hidden";
      expect(visualizationGeometry(shell)).toBeNull();
      shell.style.visibility = "visible";
      let nested = shell;
      for (let index = 0; index < 130; index += 1) {
        const next = document.createElement("div");
        next.style.cssText = "width:100px;height:100px";
        nested.append(next);
        nested = next;
      }
      expect(visualizationGeometry(nested)).toBeNull();
    } finally {
      shell.remove();
      await view.unmount();
    }
  });
  it("keeps the original reserved slot during expanded modal resize and remeasures after returning", async () => {
    installApi();
    const bridge = installBridge();
    const view = await render(<ClippedGeometryFixture />);
    const anchor = document.querySelector<HTMLElement>(
      '[data-visualization-native-surface="inline"]',
    )!;
    const reservedHeight = anchor.getBoundingClientRect().height;
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Back to chat", exact: true }))
      .toBeVisible();
    expect(anchor.closest('[inert], [aria-hidden="true"]')).not.toBeNull();
    await view.rerender(<ClippedGeometryFixture height={400} />);
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() =>
      expect(bridge.update.mock.calls.at(-1)![0].displayMode).toBe("fullscreen"),
    );
    expect(anchor.getBoundingClientRect().height).toBe(reservedHeight);
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await vi.waitFor(() => {
      expect(anchor.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(anchor.getBoundingClientRect().height).toBeLessThan(reservedHeight);
      expect(bridge.update.mock.calls.at(-1)![0].displayMode).toBe("inline");
    });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.retire).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("retires native pixels on an ancestor visibility change without resize and cannot reveal them again", async () => {
    installApi();
    const bridge = installBridge();
    const view = await render(<ClippedGeometryFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalled());
    const parent = document.querySelector<HTMLElement>("[data-visualization-horizontal-clip]")!;
    const oldBounds = parent.getBoundingClientRect();
    parent.style.visibility = "hidden";
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
    expect(parent.getBoundingClientRect().toJSON()).toEqual(oldBounds.toJSON());
    const visibleUpdates = bridge.update.mock.calls.length;
    parent.style.visibility = "visible";
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.update).toHaveBeenCalledTimes(visibleUpdates);
    await view.unmount();
  });
  it.each([
    { platform: "Win32", scale: 80, inset: 40 },
    { platform: "Win32", scale: 130, inset: 40 },
    { platform: "MacIntel", scale: 80, inset: 50 },
    { platform: "MacIntel", scale: 100, inset: 50 },
    { platform: "MacIntel", scale: 130, inset: 50 },
    { platform: "Linux x86_64", scale: 100, inset: 0 },
  ])(
    "keeps expanded controls usable in a short $platform window at $scale%",
    async ({ platform, scale, inset }) => {
      const root = document.documentElement;
      const originalWco = root.classList.contains("wco");
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      root.classList.add("wco");
      root.style.fontSize = `${scale}%`;
      await page.viewport(640, 320);
      try {
        installApi();
        const bridge = installBridge();
        await render(<Fixture />);
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
        await expect
          .element(page.getByRole("button", { name: "Expand", exact: true }))
          .toBeVisible();
        await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
        const back = page.getByRole("button", { name: "Back to chat", exact: true });
        await expect.element(back).toBeVisible();
        const popup = document.querySelector<HTMLElement>("[data-visualization-viewer]")!;
        await vi.waitFor(() => {
          const bounds = popup.getBoundingClientRect();
          expect(bounds.top).toBeGreaterThanOrEqual(inset);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
          expect(back.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(inset);
          expect(back.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
            window.innerHeight,
          );
          const surface = popup.querySelector<HTMLElement>(
            '[data-visualization-native-surface="expanded"]',
          )!;
          const surfaceBounds = surface.getBoundingClientRect();
          expect(surfaceBounds.height).toBeGreaterThan(150);
          expect(surfaceBounds.bottom).toBeGreaterThan(window.innerHeight - 25);
          expect(surfaceBounds.top).toBeGreaterThanOrEqual(
            back.element().getBoundingClientRect().bottom,
          );
          const latest = bridge.update.mock.calls.at(-1)?.[0];
          expect(latest?.displayMode).toBe("fullscreen");
          expect(latest?.bounds.height).toBe(
            Math.floor(surfaceBounds.bottom) - Math.ceil(surfaceBounds.top),
          );
          expect(latest?.leaseId).toBe(leaseId);
        });
        expect(popup.className.includes("wco:[--cafe-visualization-titlebar-inset")).toBe(
          platform === "Win32",
        );
        expect(bridge.open).toHaveBeenCalledTimes(1);
        await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }).last());
      } finally {
        root.classList.toggle("wco", originalWco);
        root.style.removeProperty("font-size");
        platformSpy.mockRestore();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );
  it("routes App requests to exact one-operation consent and hides private arguments by default", async () => {
    const api = installApi();
    api.prepare.mockResolvedValue({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    const bridge = installBridge();
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId: "5025adcf-e51b-4c66-a12f-6d2872ecba76",
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    expect(api.prepare).not.toHaveBeenCalled();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect
      .element(page.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    expect(api.appDetails).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    expect(bridge.suspend).toHaveBeenCalledWith({
      leaseId,
      consentId: operationId,
      suspended: true,
    });
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Deny", exact: true }));
    await vi.waitFor(() =>
      expect(api.resolve).toHaveBeenCalledWith({ operationId, decision: "deny" }),
    );
    await vi.waitFor(() =>
      expect(bridge.suspend).toHaveBeenCalledWith({
        leaseId,
        consentId: operationId,
        suspended: false,
      }),
    );
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
  });
  it("refuses a late approved App reply after native retirement", async () => {
    const api = installApi();
    const bridge = installBridge();
    api.prepare.mockResolvedValue({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    let complete!: (value: { json: string }) => void;
    api.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect
      .element(page.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Allow once", exact: true }));
    bridge.emit({ leaseId, state: "retired" });
    complete({ json: '{"private-late-operation":true}' });
    await Promise.resolve();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(bridge.suspend).not.toHaveBeenCalledWith({
      leaseId,
      consentId: operationId,
      suspended: false,
    });
    expect(document.body.textContent).not.toContain("private-late-operation");
  });
  it("uses fresh exact consent identities for sequential operations and clears private details on quarantine", async () => {
    const api = installApi();
    const bridge = installBridge();
    const secondOperation = "ec3f962b-792c-45bb-a98b-a30a7c02bdb3";
    api.prepare.mockResolvedValueOnce({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    api.prepare.mockResolvedValueOnce({
      kind: "consent",
      operationId: secondOperation,
      method: "resources/read",
      name: "read",
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect.element(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Deny", exact: true }));
    await vi.waitFor(() =>
      expect(bridge.suspend).toHaveBeenCalledWith({
        leaseId,
        consentId: operationId,
        suspended: false,
      }),
    );
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":2,"method":"resources/read"}',
    });
    await expect.element(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    expect(bridge.suspend).toHaveBeenCalledWith({
      leaseId,
      consentId: secondOperation,
      suspended: true,
    });
    expect(api.appDetails).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    bridge.emit({ leaseId, state: "quarantined" });
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Allow once", exact: true }).query()).toBeNull(),
    );
  });
  it("requires executable export consent and never exports App tools or permissions", async () => {
    const api = installApi();
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await expect
      .element(
        page.getByRole("heading", {
          name: "Export executable HTML? · Revenue explorer",
          exact: true,
        }),
      )
      .toBeVisible();
    expect(api.exportHtml).not.toHaveBeenCalled();
    expect(api.details).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(api.exportHtml).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await expect.element(page.getByText("Download started", { exact: true })).toBeVisible();
    expect(download).toHaveBeenCalledWith("<p>private-portable-source</p>");
    expect(api.exportHtml).toHaveBeenCalledWith({ threadId, artifactId, revisionId });
    expect(document.querySelector("[data-visualization-card] iframe")).toBeNull();
  });
  it("does not hand off wrong-revision HTML or a late export from a replaced owner", async () => {
    const api = installApi();
    api.exportHtml.mockResolvedValueOnce({
      threadId,
      artifactId,
      revisionId: VisualizationRevisionId.make("572dddf7-83e1-4505-bf08-53b67e82bb7f"),
      html: "private-wrong-revision",
    });
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await expect.element(page.getByText("Export unavailable.", { exact: true })).toBeVisible();
    expect(download).not.toHaveBeenCalled();
    let complete!: (value: Awaited<ReturnType<typeof api.exportHtml>>) => void;
    api.exportHtml.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await vi.waitFor(() => expect(api.exportHtml).toHaveBeenCalledTimes(2));
    installApi();
    complete({ threadId, artifactId, revisionId, html: "private-late-export" });
    await Promise.resolve();
    expect(download).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-late-export");
  });
  it("does not offer portable HTML for an App", async () => {
    installApi();
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    expect(page.getByRole("button", { name: "Export HTML…", exact: true }).query()).toBeNull();
  });
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

describe("bounded visualization resource qualification", () => {
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
  it("completes fifty distinct Run/Stop cycles with one synthetic native owner and no idle private DOM", async () => {
    const api = installApi();
    const bridge = installBridge();
    const live = new Set<string>();
    let maxConcurrent = 0;
    let currentExpires = 0;
    api.viewerTicket.mockImplementation(async () => ({
      threadId,
      artifactId,
      revisionId,
      ticket: Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
      expiresAtMs: Date.now() + 10_000,
    }));
    bridge.open.mockImplementation(async () => {
      expect(live.size).toBe(0);
      const fresh = crypto.randomUUID();
      live.add(fresh);
      maxConcurrent = Math.max(maxConcurrent, live.size);
      currentExpires = Date.now() + 300_000;
      return { leaseId: fresh, state: "active", expiresAtMs: currentExpires };
    });
    bridge.update.mockImplementation(async (input) => {
      expect(live.has(input.leaseId)).toBe(true);
      return { leaseId: input.leaseId, state: "active", expiresAtMs: currentExpires };
    });
    bridge.retire.mockImplementation(async (input) => {
      expect(live.delete(input.leaseId)).toBe(true);
      return { leaseId: input.leaseId, state: "retired", expiresAtMs: currentExpires };
    });
    const started = performance.now();
    const view = await render(<Fixture />);
    try {
      for (let cycle = 0; cycle < 50; cycle += 1) {
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
        await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
      }
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await expect.element(page.getByText("private-json-marker", { exact: false })).toBeVisible();
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("private-json-marker"),
      );
      expect(live.size).toBe(0);
      expect(maxConcurrent).toBe(1);
      expect(bridge.open).toHaveBeenCalledTimes(50);
      expect(bridge.retire).toHaveBeenCalledTimes(50);
      expect(new Set(bridge.retire.mock.calls.map(([input]) => input.leaseId)).size).toBe(50);
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-cycle-qualification",
        JSON.stringify({
          cycles: 50,
          maxSyntheticOwners: maxConcurrent,
          idleSyntheticOwners: live.size,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
    expect(live.size).toBe(0);
    expect(document.querySelector("[data-visualization-card]")).toBeNull();
    expect(document.body.textContent).not.toContain("private-source-marker");
    expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
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
