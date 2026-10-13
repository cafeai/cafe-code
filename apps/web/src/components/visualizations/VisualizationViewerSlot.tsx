import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopBridge, EnvironmentId, ThreadId } from "@cafecode/contracts";
import { VisualizationViewerTicketResult } from "@cafecode/contracts/visualizationApi";
import {
  McpAppPrepareResult,
  McpAppReply,
  type VisualizationReference,
} from "@cafecode/contracts/mcpApps";
import {
  VisualizationHostState,
  VisualizationHostYieldResult,
  VisualizationHostLayout,
  type VisualizationHostCapabilities,
  type VisualizationHostEvent,
} from "@cafecode/contracts/visualizationHost";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { useTheme } from "../../hooks/useTheme";
import { readLocalApi } from "../../localApi";
import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { observeVisualizationOwner } from "./visualizationOwner";
import { visualizationPresentation } from "./visualizationPresentation";
import { VisualizationPrivateText } from "./VisualizationPrivateText";
import { visualizationClippingAncestors, visualizationGeometry } from "./visualizationGeometry";

export interface VisualizationBinding {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: VisualizationReference;
  readonly entryKey: string;
  readonly anchorId: string;
  readonly anchor: HTMLElement;
  readonly opener: HTMLElement;
  /** Process-local pane/entry identity, never an RPC or native authority. */
  readonly pane?: object;
  readonly poolKey?: string;
  readonly onScrollIntent?: (deltaY: number) => boolean | void;
  readonly onLayoutIntent?: (anchor: HTMLElement, height: number) => (() => void) | undefined;
}
export function visualizationBindingKey(
  binding: Pick<
    VisualizationBinding,
    "environmentId" | "threadId" | "reference" | "entryKey" | "anchorId"
  >,
) {
  if ("poolKey" in binding && typeof binding.poolKey === "string") return binding.poolKey;
  return JSON.stringify([
    binding.environmentId,
    binding.threadId,
    binding.entryKey,
    binding.anchorId,
    binding.reference.artifactId,
    binding.reference.revisionId,
  ]);
}
export type ViewerStatus =
  | "waiting"
  | "preparing"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "yielded"
  | "unavailable"
  | "quarantined";
export interface ViewerSnapshot {
  key: string;
  status: ViewerStatus;
  expanded: boolean;
  expiresAtMs: number | null;
  visible?: boolean;
  /** Bounded presentation only; never a lease renewal or execution entitlement. */
  layout?: Pick<VisualizationHostLayout, "height" | "constrained">;
}
interface ActiveViewer {
  binding: Pick<
    VisualizationBinding,
    | "environmentId"
    | "threadId"
    | "reference"
    | "entryKey"
    | "anchorId"
    | "poolKey"
    | "pane"
    | "onScrollIntent"
    | "onLayoutIntent"
  >;
  // A recycled row may have private inspector descendants. Weak DOM handles
  // prevent a long-lived fullscreen owner from retaining that detached tree.
  anchor: WeakRef<HTMLElement>;
  opener: WeakRef<HTMLElement>;
  bridge: DesktopBridge;
  leaseId: string | null;
  ticket: string | null;
  openStarted: boolean;
  revoked: boolean;
  owner: ReturnType<typeof observeVisualizationOwner>;
  consent: { operationId: string; method: string; name?: string; deadline: number } | null;
  requestBusy: boolean;
  queuedMessages: string[];
  earlyMessages: { leaseId: string; json: string }[];
  earlyStates: VisualizationHostEvent[];
  earlyLayout: VisualizationHostEvent | null;
  layoutSequence: number;
  layoutCancel: (() => void) | null;
  yielding: boolean;
  automatic: boolean;
  retirement: Promise<void> | null;
  presentationHidden: boolean;
  presentationEpoch: number;
  visibleLifetime: boolean;
  // A user Stop returns focus to this exact card. Programmatic retirement for
  // another generated card's menu must not steal focus from that menu trigger.
  restoreFocusOnRetire: boolean;
}

/** Presentation cleanup cannot delay native revocation/retirement authority. */
function releaseLayoutPreservation(viewer: ActiveViewer) {
  const cancel = viewer.layoutCancel;
  viewer.layoutCancel = null;
  try {
    cancel?.();
  } catch {
    // No received details or toast; lifecycle must continue if UI cleanup fails.
  }
}
export interface VisualizationSlotController {
  snapshot: ViewerSnapshot | null;
  leaseId: string | null;
  run: (binding: VisualizationBinding, prepared?: VisualizationPreparedViewer) => void;
  stop: () => void;
  expand: (key: string, expanded: boolean) => void;
  detach: (key: string) => void;
  retireScope: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  capture: (key: string, signal: AbortSignal) => Promise<Blob>;
  yield: () => Promise<{ continuation: string; expiresAtMs: number | null } | null>;
  stopAndWait: (restoreFocus?: boolean) => Promise<boolean>;
  attach: (binding: VisualizationBinding) => void;
  focus: (key: string) => void;
  presentationHidden: (hidden: boolean) => Promise<boolean>;
}
export interface VisualizationPreparedViewer {
  ticket: typeof VisualizationViewerTicketResult.Type;
  owner: ReturnType<typeof observeVisualizationOwner>;
  automatic: boolean;
  continuation?: string;
  expiresAtMs?: number | null;
}
const decodeState = Schema.decodeUnknownSync(VisualizationHostState);
const decodeTicket = Schema.decodeUnknownSync(VisualizationViewerTicketResult);
const decodeApp = Schema.decodeUnknownSync(McpAppPrepareResult);
const decodeReply = Schema.decodeUnknownSync(McpAppReply);
const decodeYield = Schema.decodeUnknownSync(VisualizationHostYieldResult);
const decodeLayout = Schema.decodeUnknownSync(VisualizationHostLayout);
const MAX_PENDING_MESSAGES = 8;

/** Only the two exact viewer-owned dialogs may retain this document's authority. */
function hasBlockingVisualizationOverlay() {
  return Boolean(
    document.querySelector(
      '[role="dialog"]:not([data-visualization-viewer]):not([data-visualization-consent]):not([data-visualization-inspection]), [role="alertdialog"]',
    ),
  );
}

/**
 * This owner is above the recycled timeline. Cards contain only inert posters
 * and a geometry anchor; changing inline/fullscreen bounds never recreates the
 * native document. Native retirement is authoritative: a failed/uncertain stop
 * leaves this slot occupied and disables new admission instead of guessing.
 */
export function VisualizationViewerSlot({
  slotKey,
  onController,
  onSnapshot,
  beforeOverlay,
  afterOverlay,
  readCapabilities,
  knownSiblingLease,
}: {
  slotKey: string;
  onController: (key: string, controller: VisualizationSlotController | null) => void;
  onSnapshot: (key: string, snapshot: ViewerSnapshot | null) => void;
  beforeOverlay: (key: string, transition?: boolean) => Promise<boolean>;
  afterOverlay: (key: string) => void;
  readCapabilities: () => Promise<VisualizationHostCapabilities>;
  knownSiblingLease: (key: string, leaseId: string) => boolean;
}) {
  const uiLocale = useUiLocale();
  const { resolvedTheme } = useTheme();
  const appearance = useRef(resolvedTheme);
  const locale = useRef(uiLocale);
  locale.current = uiLocale;
  appearance.current = resolvedTheme;
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const active = useRef<ActiveViewer | null>(null);
  // Native capacity events may arrive synchronously before React commits a
  // starting/refused snapshot. This mounted controller has exactly one
  // admission attempt; only a deliberate new controller may try again.
  const runAttempted = useRef(false);
  // The dialog portal mounts after its owner's first layout pass. Observing a
  // ref only once can therefore leave the live native view at inline bounds.
  // The callback ref re-runs geometry ownership on the actual portal mount;
  // this is the one stable shell surface, never a recycled timeline row.
  const [expandedAnchor, setExpandedAnchor] = useState<HTMLDivElement | null>(null);
  const restoreFocus = useRef<{
    key: string;
    anchor: WeakRef<HTMLElement>;
    opener: WeakRef<HTMLElement>;
  } | null>(null);
  const [consent, setConsent] = useState<ActiveViewer["consent"]>(null);
  const [consentPrivate, setConsentPrivate] = useState<string | null>(null);
  const [consentExpanded, setConsentExpanded] = useState(false);
  const [consentRemaining, setConsentRemaining] = useState(0);
  const [feedback, setFeedback] = useState(false);
  const messageHandler = useRef<(viewer: ActiveViewer, json: string) => void>(() => undefined);
  const focusIntent = useRef(false);
  const reserveNativeTitlebar =
    window.desktopBridge !== undefined && isWindowsPlatform(navigator.platform);
  const reserveMacTitlebar =
    window.desktopBridge !== undefined && isMacPlatform(navigator.platform);

  const publish = useCallback((viewer: ActiveViewer, status: ViewerStatus) => {
    if (active.current !== viewer) return;
    setSnapshot((old) => ({
      key: visualizationBindingKey(viewer.binding),
      status,
      expanded: old?.key === visualizationBindingKey(viewer.binding) && old.expanded,
      expiresAtMs: old?.expiresAtMs ?? null,
      visible: old?.visible ?? false,
      ...(old?.layout ? { layout: old.layout } : {}),
    }));
  }, []);
  const retire = useCallback(
    (viewer: ActiveViewer): Promise<void> => {
      if (active.current !== viewer) return Promise.resolve();
      if (viewer.retirement) return viewer.retirement;
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      viewer.retirement = completion;
      void (async () => {
        viewer.revoked = true;
        releaseLayoutPreservation(viewer);
        viewer.queuedMessages.length = 0;
        viewer.earlyMessages.length = 0;
        viewer.earlyStates.length = 0;
        viewer.earlyLayout = null;
        const unused = !viewer.openStarted ? viewer.ticket : null;
        viewer.ticket = null;
        if (unused)
          void viewer.owner.api?.visualizations
            ?.discardViewerTicket?.({
              threadId: viewer.binding.threadId,
              artifactId: viewer.binding.reference.artifactId,
              revisionId: viewer.binding.reference.revisionId,
              ticket: unused,
            })
            .catch(() => undefined);
        viewer.consent = null;
        setConsent(null);
        setConsentPrivate(null);
        setConsentExpanded(false);
        publish(viewer, "stopping");
        if (!viewer.leaseId) {
          // If native open has begun, a lost acknowledgement cannot prove that no
          // renderer exists. Keep this owner occupied until its exact lease is known.
          if (viewer.openStarted) {
            viewer.retirement = null;
            publish(viewer, "quarantined");
          } else {
            viewer.owner.dispose();
            active.current = null;
            setSnapshot((old) =>
              old ? { ...old, status: "unavailable", expanded: false, visible: false } : old,
            );
          }
          return;
        }
        try {
          const result = decodeState(
            await viewer.bridge.retireVisualization?.({ leaseId: viewer.leaseId }),
          );
          if (active.current !== viewer || result.leaseId !== viewer.leaseId) return;
          if (result.state === "retired") {
            if (!viewer.automatic && viewer.restoreFocusOnRetire)
              restoreFocus.current = {
                key: visualizationBindingKey(viewer.binding),
                anchor: viewer.anchor,
                opener: viewer.opener,
              };
            viewer.owner.dispose();
            active.current = null;
            publish(viewer, "stopped");
            setSnapshot((old) =>
              old?.key === visualizationBindingKey(viewer.binding)
                ? { ...old, status: "stopped", expanded: false }
                : old,
            );
          } else publish(viewer, "quarantined");
        } catch {
          publish(viewer, "quarantined");
        }
      })().then(complete, () => {
        publish(viewer, "quarantined");
        complete();
      });
      return completion;
    },
    [publish],
  );
  const stop = useCallback(() => {
    const viewer = active.current;
    if (viewer) void retire(viewer);
  }, [retire]);
  const stopAndWait = useCallback(
    async (restoreFocus = true) => {
      const viewer = active.current;
      if (viewer) {
        // This flag belongs only to the captured owner. It does not carry over
        // to a later Run, nor authorize a different lease or native operation.
        if (!restoreFocus) viewer.restoreFocusOnRetire = false;
        await retire(viewer);
      }
      return active.current === null;
    },
    [retire],
  );
  const attach = useCallback((binding: VisualizationBinding) => {
    const viewer = active.current;
    if (
      !viewer ||
      viewer.revoked ||
      visualizationBindingKey(viewer.binding) !== visualizationBindingKey(binding)
    )
      return;
    viewer.anchor = new WeakRef(binding.anchor);
    releaseLayoutPreservation(viewer);
    viewer.opener = new WeakRef(binding.opener);
    const {
      onScrollIntent: _oldScrollIntent,
      onLayoutIntent: _oldLayoutIntent,
      ...identity
    } = viewer.binding;
    viewer.binding = {
      ...identity,
      anchorId: binding.anchorId,
      ...(binding.onScrollIntent ? { onScrollIntent: binding.onScrollIntent } : {}),
      ...(binding.onLayoutIntent ? { onLayoutIntent: binding.onLayoutIntent } : {}),
    };
  }, []);
  const stillCurrent = useCallback(
    (viewer: ActiveViewer) =>
      active.current === viewer &&
      !viewer.revoked &&
      viewer.owner.current() &&
      window.desktopBridge === viewer.bridge &&
      document.visibilityState === "visible" &&
      !hasBlockingVisualizationOverlay(),
    [],
  );
  const acceptLayout = useCallback(
    (viewer: ActiveViewer, event: VisualizationHostEvent) => {
      if (
        viewer.binding.reference.purpose !== "generated-visualization" ||
        event.state !== "layout" ||
        event.leaseId !== viewer.leaseId ||
        !stillCurrent(viewer)
      )
        return;
      try {
        const layout = decodeLayout(event.layout);
        if (layout.sequence <= viewer.layoutSequence) return;
        viewer.layoutSequence = layout.sequence;
        // The wider fullscreen document can have a different responsive flow.
        // Consume its sequence without replacing the hidden transcript's last
        // inline reservation; only a subsequent inline measurement may do so.
        // The same native document/lease remains admitted throughout expansion.
        if (snapshotRef.current?.expanded) return;
        const anchor = viewer.anchor.deref();
        if (anchor) {
          const cancel = viewer.binding.onLayoutIntent?.(anchor, layout.height);
          if (cancel) viewer.layoutCancel = cancel;
        }
        setSnapshot((old) =>
          old?.key === visualizationBindingKey(viewer.binding) && old.status === "active"
            ? { ...old, layout: { height: layout.height, constrained: layout.constrained } }
            : old,
        );
      } catch {
        // Source height is adversarial presentation data. Malformed input is
        // ignored, never interpreted as native retirement or parent authority.
      }
    },
    [stillCurrent],
  );

  const run = useCallback(
    (binding: VisualizationBinding, prepared?: VisualizationPreparedViewer) => {
      if (runAttempted.current || active.current) return;
      runAttempted.current = true;
      const refuse = () => {
        if (prepared) {
          void prepared.owner.api?.visualizations
            ?.discardViewerTicket?.({
              threadId: binding.threadId,
              artifactId: binding.reference.artifactId,
              revisionId: binding.reference.revisionId,
              ticket: prepared.ticket.ticket,
            })
            .catch(() => undefined);
          prepared.owner.dispose();
        }
        setSnapshot({
          key: visualizationBindingKey(binding),
          status: "unavailable",
          expanded: false,
          expiresAtMs: null,
        });
      };
      if (
        !binding.anchor.isConnected ||
        document.visibilityState !== "visible" ||
        hasBlockingVisualizationOverlay()
      ) {
        refuse();
        return;
      }
      const bridge = window.desktopBridge;
      if (
        !bridge?.openVisualization ||
        !bridge.updateVisualization ||
        !bridge.retireVisualization ||
        !bridge.getVisualizationHostCapabilities ||
        !bridge.onVisualizationHostEvent
      ) {
        refuse();
        return;
      }
      if (!visualizationGeometry(binding.anchor)) {
        refuse();
        return;
      }
      let viewer: ActiveViewer;
      const owner =
        prepared?.owner ??
        observeVisualizationOwner(binding.environmentId, () => {
          if (viewer) void retire(viewer);
        });
      viewer = {
        binding: {
          environmentId: binding.environmentId,
          threadId: binding.threadId,
          reference: binding.reference,
          entryKey: binding.entryKey,
          anchorId: binding.anchorId,
          ...(binding.poolKey ? { poolKey: binding.poolKey } : {}),
          ...(binding.pane ? { pane: binding.pane } : {}),
          ...(binding.onScrollIntent ? { onScrollIntent: binding.onScrollIntent } : {}),
          ...(binding.onLayoutIntent ? { onLayoutIntent: binding.onLayoutIntent } : {}),
        },
        anchor: new WeakRef(binding.anchor),
        opener: new WeakRef(binding.opener),
        bridge,
        owner,
        leaseId: null,
        ticket: prepared?.ticket.ticket ?? null,
        openStarted: false,
        revoked: false,
        consent: null,
        requestBusy: false,
        queuedMessages: [],
        earlyMessages: [],
        earlyStates: [],
        earlyLayout: null,
        layoutSequence: 0,
        layoutCancel: null,
        yielding: false,
        automatic: prepared?.automatic ?? false,
        retirement: null,
        presentationHidden: false,
        presentationEpoch: 0,
        visibleLifetime: false,
        restoreFocusOnRetire: true,
      };
      active.current = viewer;
      setSnapshot({
        key: visualizationBindingKey(binding),
        status: "starting",
        expanded: false,
        expiresAtMs: null,
      });
      void (async () => {
        let unusedTicket: string | null = null;
        try {
          const capabilities = await readCapabilities();
          viewer.visibleLifetime =
            binding.reference.purpose === "generated-visualization" &&
            "generatedLifecycle" in capabilities &&
            capabilities.generatedLifecycle === "visible";
          if (!stillCurrent(viewer) || !capabilities.available || !owner.api?.visualizations)
            throw new Error("unavailable");
          const result =
            prepared?.ticket ??
            decodeTicket(
              await owner.api.visualizations.viewerTicket({
                threadId: binding.threadId,
                artifactId: binding.reference.artifactId,
                revisionId: binding.reference.revisionId,
              }),
            );
          if (
            result.threadId === binding.threadId &&
            result.artifactId === binding.reference.artifactId &&
            result.revisionId === binding.reference.revisionId
          )
            unusedTicket = result.ticket;
          if (
            !stillCurrent(viewer) ||
            result.threadId !== binding.threadId ||
            result.artifactId !== binding.reference.artifactId ||
            result.revisionId !== binding.reference.revisionId ||
            !binding.anchor.isConnected
          )
            throw new Error("stale");
          // Startup may await capability/ticket admission while the chat moves.
          // Native open stays hidden, but its initial page viewport must still
          // come from the current exact anchor rather than a stale scroll crop.
          const geometry = visualizationGeometry(binding.anchor);
          if (!geometry) throw new Error("stale");
          viewer.ticket = result.ticket;
          viewer.openStarted = true;
          unusedTicket = null;
          const opened = decodeState(
            await bridge.openVisualization!({
              ticket: result.ticket,
              ...geometry,
              appearance: appearance.current,
              displayMode: "inline",
              presentation: visualizationPresentation(locale.current),
              ...(prepared?.continuation ? { continuation: prepared.continuation } : {}),
            }),
          );
          viewer.leaseId = opened.leaseId;
          // Native open is initially hidden. Only a still-current exact lease
          // reaches the geometry effect's first visible update; a modal or Stop
          // during any awaited startup phase must retire this ACK, not expose it.
          if (!stillCurrent(viewer)) {
            await retire(viewer);
            return;
          }
          const earlyStates = viewer.earlyStates
            .splice(0)
            .filter((event) => event.leaseId === opened.leaseId);
          if (earlyStates.some((event) => event.state === "retired")) {
            viewer.revoked = true;
            viewer.owner.dispose();
            active.current = null;
            setSnapshot({
              key: visualizationBindingKey(binding),
              status: "stopped",
              expanded: false,
              expiresAtMs: opened.expiresAtMs,
            });
            return;
          }
          if (earlyStates.some((event) => event.state === "quarantined")) {
            viewer.revoked = true;
            publish(viewer, "quarantined");
            return;
          }
          if (opened.state !== "active") {
            if (opened.state === "quarantined") publish(viewer, "quarantined");
            else {
              // A conclusively blocked open can precede native ticket
              // consumption (for example, an exact capacity race). Discard
              // only this unused tuple; a spent ticket returns false and
              // cannot revoke an active or uncertain native owner.
              void owner.api?.visualizations
                ?.discardViewerTicket?.({
                  threadId: binding.threadId,
                  artifactId: binding.reference.artifactId,
                  revisionId: binding.reference.revisionId,
                  ticket: result.ticket,
                })
                .catch(() => undefined);
              viewer.ticket = null;
              owner.dispose();
              active.current = null;
              setSnapshot({
                key: visualizationBindingKey(binding),
                status: "unavailable",
                expanded: false,
                expiresAtMs: null,
              });
            }
            return;
          }
          setSnapshot({
            key: visualizationBindingKey(binding),
            status: "active",
            expanded: false,
            expiresAtMs: opened.expiresAtMs,
            visible: false,
          });
          const earlyLayout = viewer.earlyLayout;
          viewer.earlyLayout = null;
          if (earlyLayout) acceptLayout(viewer, earlyLayout);
          // Guest initialization can race the open IPC response. Only after the
          // exact native lease is known may an early message reach the broker.
          const early = viewer.earlyMessages.splice(0);
          for (const message of early)
            if (message.leaseId === viewer.leaseId) messageHandler.current(viewer, message.json);
        } catch {
          // A cancelled manual/legacy ticket response still owns only this
          // exact unused tuple. Cleanup does not reactivate a retired owner or
          // revoke another revision/window's active ledger.
          if (unusedTicket) {
            if (viewer.ticket === unusedTicket) viewer.ticket = null;
            void owner.api?.visualizations
              ?.discardViewerTicket?.({
                threadId: binding.threadId,
                artifactId: binding.reference.artifactId,
                revisionId: binding.reference.revisionId,
                ticket: unusedTicket,
              })
              .catch(() => undefined);
          }
          if (active.current !== viewer) return;
          if (viewer.leaseId) await retire(viewer);
          else if (viewer.openStarted) {
            viewer.revoked = true;
            viewer.ticket = null;
            viewer.queuedMessages.length = 0;
            viewer.earlyMessages.length = 0;
            viewer.earlyStates.length = 0;
            viewer.earlyLayout = null;
            publish(viewer, "quarantined");
          } else {
            if (viewer.ticket)
              void owner.api?.visualizations
                ?.discardViewerTicket?.({
                  threadId: binding.threadId,
                  artifactId: binding.reference.artifactId,
                  revisionId: binding.reference.revisionId,
                  ticket: viewer.ticket,
                })
                .catch(() => undefined);
            owner.dispose();
            active.current = null;
            setSnapshot({
              key: visualizationBindingKey(binding),
              status: "unavailable",
              expanded: false,
              expiresAtMs: null,
            });
          }
        }
      })();
    },
    [publish, retire, stillCurrent, readCapabilities, acceptLayout],
  );

  const expand = useCallback(
    (key: string, expanded: boolean) => {
      const viewer = active.current;
      if (
        !viewer ||
        visualizationBindingKey(viewer.binding) !== key ||
        viewer.revoked ||
        viewer.consent
      )
        return;
      if (!expanded && !viewer.anchor.deref()?.isConnected) {
        void retire(viewer);
        return;
      }
      if (!expanded) {
        setSnapshot((old) => (old?.key === key ? { ...old, expanded: false } : old));
        afterOverlay(key);
      } else {
        releaseLayoutPreservation(viewer);
        void beforeOverlay(key).then((ready) => {
          if (ready && stillCurrent(viewer)) {
            focusIntent.current = true;
            setSnapshot((old) => (old?.key === key ? { ...old, expanded: true } : old));
          }
        });
      }
    },
    [retire, beforeOverlay, afterOverlay, stillCurrent],
  );
  const detach = useCallback(
    (key: string) => {
      const viewer = active.current;
      if (
        viewer &&
        visualizationBindingKey(viewer.binding) === key &&
        !snapshotRef.current?.expanded
      )
        void retire(viewer);
    },
    [retire],
  );
  const retireScope = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      const viewer = active.current;
      if (viewer?.binding.environmentId === environmentId && viewer.binding.threadId === threadId)
        void retire(viewer);
    },
    [retire],
  );
  const capture = useCallback(
    async (key: string, signal: AbortSignal) => {
      const viewer = active.current;
      if (
        !viewer?.leaseId ||
        visualizationBindingKey(viewer.binding) !== key ||
        !stillCurrent(viewer) ||
        viewer.consent
      )
        throw new Error("capture-unavailable");
      signal.throwIfAborted();
      const frame = await viewer.bridge.captureVisualization?.({ leaseId: viewer.leaseId });
      signal.throwIfAborted();
      if (!frame || !stillCurrent(viewer)) throw new Error("capture-unavailable");
      return new Blob([frame.png as Uint8Array<ArrayBuffer>], { type: "image/png" });
    },
    [stillCurrent],
  );
  const focus = useCallback(
    (key: string) => {
      const viewer = active.current;
      if (
        !viewer?.leaseId ||
        visualizationBindingKey(viewer.binding) !== key ||
        !stillCurrent(viewer) ||
        viewer.consent ||
        snapshotRef.current?.visible !== true
      )
        return;
      // Only an explicit trusted card keyboard-entry gesture calls this method.
      // Native main independently checks its exact visible owner and never
      // activates another OS window or grants sibling guests focus authority.
      void viewer.bridge.focusVisualization?.({ leaseId: viewer.leaseId }).catch(() => undefined);
    },
    [stillCurrent],
  );

  const presentationHidden = useCallback(
    async (hidden: boolean) => {
      const viewer = active.current;
      if (
        !viewer?.leaseId ||
        !viewer.visibleLifetime ||
        !stillCurrent(viewer) ||
        viewer.consent ||
        snapshotRef.current?.status !== "active"
      )
        return false;
      const element = snapshotRef.current.expanded ? expandedAnchor : viewer.anchor.deref();
      const geometry = element && visualizationGeometry(element, viewer.presentationHidden);
      if (!geometry) {
        void retire(viewer);
        return false;
      }
      viewer.presentationHidden = hidden;
      const epoch = ++viewer.presentationEpoch;
      try {
        const result = decodeState(
          await viewer.bridge.updateVisualization!({
            leaseId: viewer.leaseId,
            ...geometry,
            visible: true,
            presentationHidden: hidden,
            appearance: appearance.current,
            displayMode: snapshotRef.current.expanded ? "fullscreen" : "inline",
            presentation: visualizationPresentation(locale.current),
          }),
        );
        if (
          !stillCurrent(viewer) ||
          result.leaseId !== viewer.leaseId ||
          result.state !== "active"
        ) {
          void retire(viewer);
          return false;
        }
        if (viewer.presentationEpoch !== epoch) return false;
        setSnapshot((old) => (old ? { ...old, visible: !hidden } : old));
        return true;
      } catch {
        void retire(viewer);
        return false;
      }
    },
    [expandedAnchor, retire, stillCurrent],
  );

  const yieldViewer = useCallback(async () => {
    const viewer = active.current;
    if (
      !viewer?.leaseId ||
      viewer.binding.reference.purpose === "mcp-app" ||
      viewer.revoked ||
      !viewer.bridge.yieldVisualization
    )
      return null;
    viewer.yielding = true;
    viewer.revoked = true;
    releaseLayoutPreservation(viewer);
    publish(viewer, "stopping");
    try {
      const result = decodeYield(
        await viewer.bridge.yieldVisualization({ leaseId: viewer.leaseId }),
      );
      if (
        active.current !== viewer ||
        result.leaseId !== viewer.leaseId ||
        result.state !== "retired" ||
        !result.continuation
      ) {
        publish(viewer, "quarantined");
        return null;
      }
      viewer.owner.dispose();
      active.current = null;
      setSnapshot((old) =>
        old
          ? {
              ...old,
              status: "yielded",
              expanded: false,
              visible: false,
              expiresAtMs: result.expiresAtMs,
            }
          : old,
      );
      return { continuation: result.continuation, expiresAtMs: result.expiresAtMs };
    } catch {
      publish(viewer, "quarantined");
      return null;
    }
  }, [publish]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    const off = bridge?.onVisualizationHostEvent?.((event) => {
      const viewer = active.current;
      if (!viewer || viewer.bridge !== bridge) return;
      if (viewer.leaseId === null) {
        // Native main binds every pre-ACK event to the exact consumed ticket.
        // Unknown or sibling lease events cannot fill another starter's queue;
        // a lease UUID learned later is never guessed from global event order.
        if (
          knownSiblingLease(slotKey, event.leaseId) ||
          !viewer.ticket ||
          event.openingTicket !== viewer.ticket
        )
          return;
        if (event.state === "layout") {
          if (
            viewer.binding.reference.purpose !== "generated-visualization" ||
            !stillCurrent(viewer)
          )
            return;
          try {
            const layout = decodeLayout(event.layout);
            // One exact-ticket scalar is enough. Layout floods cannot exhaust
            // the existing early lifecycle/message queues or promote a sibling.
            if (layout.sequence > (viewer.earlyLayout?.layout?.sequence ?? 0))
              viewer.earlyLayout = { leaseId: event.leaseId, state: "layout", layout };
          } catch {
            // No source object or malformed scalar is retained.
          }
          return;
        }
        if (event.state === "retired" || event.state === "quarantined") {
          if (viewer.earlyStates.length >= MAX_PENDING_MESSAGES) {
            void retire(viewer);
            return;
          }
          viewer.earlyStates.push(event);
        }
        if (
          viewer.binding.reference.purpose === "mcp-app" &&
          event.state === "message" &&
          event.json &&
          event.json.length <= 128 * 1024 &&
          stillCurrent(viewer)
        ) {
          if (viewer.earlyMessages.length >= MAX_PENDING_MESSAGES) {
            void retire(viewer);
            return;
          }
          viewer.earlyMessages.push({ leaseId: event.leaseId, json: event.json });
        }
        return;
      }
      if (event.leaseId !== viewer.leaseId) return;
      if (event.state === "layout") {
        acceptLayout(viewer, event);
        return;
      }
      if (viewer.yielding && event.state === "retired") return;
      if (
        event.state === "wheel" &&
        event.wheel &&
        viewer.automatic &&
        stillCurrent(viewer) &&
        !snapshotRef.current?.expanded
      ) {
        const anchor = viewer.anchor.deref();
        const scroll =
          anchor &&
          visualizationClippingAncestors(anchor)?.find((element) => {
            const style = getComputedStyle(element);
            return (
              (/(auto|scroll)/.test(style.overflowY) &&
                element.scrollHeight > element.clientHeight) ||
              (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth)
            );
          });
        if (
          scroll &&
          [event.wheel.deltaX, event.wheel.deltaY].every(
            (value) => Number.isFinite(value) && Math.abs(value) <= 2048,
          )
        ) {
          const handled = viewer.binding.onScrollIntent?.(event.wheel.deltaY) === true;
          // A real owning list applies and synchronizes its vertical input
          // exactly once. Standalone cards retain the bounded DOM fallback;
          // horizontal edge input remains this same exact scroll owner's input.
          if (!handled || event.wheel.deltaX !== 0)
            scroll.scrollBy({
              left: event.wheel.deltaX,
              top: handled ? 0 : event.wheel.deltaY,
              behavior: "instant",
            });
        }
        return;
      }
      if (event.state === "message" && event.json && stillCurrent(viewer) && !viewer.consent)
        messageHandler.current(viewer, event.json);
      else if (event.state === "retired") {
        if (!viewer.automatic && viewer.restoreFocusOnRetire)
          restoreFocus.current = {
            key: visualizationBindingKey(viewer.binding),
            anchor: viewer.anchor,
            opener: viewer.opener,
          };
        viewer.revoked = true;
        releaseLayoutPreservation(viewer);
        viewer.owner.dispose();
        active.current = null;
        viewer.consent = null;
        viewer.queuedMessages.length = 0;
        viewer.ticket = null;
        viewer.earlyLayout = null;
        setConsent(null);
        setConsentPrivate(null);
        setConsentExpanded(false);
        setSnapshot((old) => (old ? { ...old, status: "stopped", expanded: false } : old));
      } else if (event.state === "quarantined") {
        viewer.revoked = true;
        releaseLayoutPreservation(viewer);
        viewer.consent = null;
        viewer.queuedMessages.length = 0;
        viewer.ticket = null;
        viewer.earlyLayout = null;
        setConsent(null);
        setConsentPrivate(null);
        setConsentExpanded(false);
        publish(viewer, "quarantined");
      }
    });
    const hidden = () => {
      if (document.visibilityState !== "visible") stop();
    };
    const overlays = new MutationObserver(() => {
      // This guard owns starting as well as active/suspended documents. Revoke
      // in the observer delivery, not a later animation frame: closing a modal
      // again cannot revive the operation while a capability/ticket/ACK waits.
      if (active.current && !active.current.revoked && hasBlockingVisualizationOverlay()) stop();
    });
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "inert", "aria-hidden", "hidden"],
    });
    document.addEventListener("visibilitychange", hidden);
    return () => {
      off?.();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      stop();
    };
  }, [publish, stop, retire, stillCurrent, knownSiblingLease, slotKey, acceptLayout]);

  useLayoutEffect(() => {
    const pending = restoreFocus.current;
    if (
      !pending ||
      active.current ||
      snapshot?.key !== pending.key ||
      snapshot.status !== "stopped"
    )
      return;
    // The running toolbar replaces Run with Stop, so the old opener may have
    // been removed. Resolve only within the exact still-connected card after
    // React commits its replacement control; never steal focus from a new host.
    // The keyed Card is notified in this layout pass and commits its Run
    // control before the microtask. The controller may already be removed;
    // retain only weak exact DOM handles, never a detached private card tree.
    queueMicrotask(() => {
      if (
        active.current ||
        snapshotRef.current?.key !== pending.key ||
        snapshotRef.current.status !== "stopped"
      )
        return;
      restoreFocus.current = null;
      const opener = pending.opener.deref();
      const target = opener?.isConnected
        ? opener
        : pending.anchor
            .deref()
            ?.closest("[data-visualization-card]")
            ?.querySelector<HTMLElement>("[data-visualization-run]");
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [snapshot]);

  // Geometry updates are coalesced and have one pending IPC plus one trailing
  // sample. An unrelated modal/approval must never sit underneath native pixels.
  useLayoutEffect(() => {
    const viewer = active.current;
    if (!viewer?.leaseId || snapshot?.status !== "active" || viewer.consent) return;
    const element = snapshot.expanded ? expandedAnchor : viewer.anchor.deref();
    if (!element) return;
    let disposed = false,
      frame = 0,
      busy = false,
      trailing = false;
    let previous = "";
    const update = () => {
      frame = 0;
      if (disposed || !stillCurrent(viewer) || !element.isConnected) {
        void retire(viewer);
        return;
      }
      const geometry = visualizationGeometry(element, viewer.presentationHidden);
      if (!geometry) {
        void retire(viewer);
        return;
      }
      if (busy) {
        trailing = true;
        return;
      }
      const presentation = visualizationPresentation(locale.current);
      const displayMode = snapshot.expanded ? "fullscreen" : "inline";
      const hidden = viewer.presentationHidden;
      const epoch = viewer.presentationEpoch;
      const value = JSON.stringify([
        geometry,
        appearance.current,
        displayMode,
        presentation,
        hidden,
      ]);
      if (value === previous) return;
      previous = value;
      busy = true;
      const focus = snapshot.expanded && focusIntent.current;
      focusIntent.current = false;
      void viewer.bridge.updateVisualization!({
        leaseId: viewer.leaseId!,
        ...geometry,
        visible: true,
        ...(viewer.visibleLifetime ? { presentationHidden: hidden } : {}),
        appearance: appearance.current,
        displayMode,
        presentation,
        ...(focus ? { focus: true } : {}),
      })
        .then((raw) => {
          const result = decodeState(raw);
          if (
            active.current === viewer &&
            result.leaseId === viewer.leaseId &&
            result.state !== "active"
          )
            void retire(viewer);
          else if (
            active.current === viewer &&
            result.leaseId === viewer.leaseId &&
            stillCurrent(viewer) &&
            viewer.presentationEpoch === epoch
          )
            setSnapshot((old) => (old ? { ...old, visible: !hidden } : old));
          else if (active.current === viewer && stillCurrent(viewer)) return;
          else if (active.current === viewer) void retire(viewer);
        })
        .catch(() => {
          void retire(viewer);
        })
        .finally(() => {
          busy = false;
          if (trailing && !disposed) {
            trailing = false;
            schedule();
          }
        });
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    for (const ancestor of visualizationClippingAncestors(element) ?? []) resize.observe(ancestor);
    const visibility = new MutationObserver(schedule);
    // Native pixels cannot inherit DOM visibility. Watch only this exact,
    // bounded shell ancestry, including style/class changes without reflow.
    let ancestor: HTMLElement | null = element;
    for (let count = 0; ancestor && count < 128; count += 1) {
      visibility.observe(ancestor, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden", "hidden", "class", "style"],
      });
      ancestor = ancestor.parentElement;
    }
    const intersect = new IntersectionObserver(
      (entries) => {
        if (!snapshot.expanded && entries[0]?.isIntersecting === false) void retire(viewer);
      },
      { threshold: 0 },
    );
    intersect.observe(element);
    const overlay = new MutationObserver(schedule);
    overlay.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "inert"],
    });
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      intersect.disconnect();
      overlay.disconnect();
      theme.disconnect();
      motion.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [
    snapshot?.status,
    snapshot?.expanded,
    expandedAnchor,
    resolvedTheme,
    uiLocale,
    retire,
    consent,
    stillCurrent,
  ]);

  const forward = useCallback(
    async (viewer: ActiveViewer, json: string, messages?: readonly string[]) => {
      for (const payload of [...(json ? [json] : []), ...(messages ?? [])]) {
        if (!stillCurrent(viewer) || !viewer.leaseId) return;
        if (
          !(await viewer.bridge.sendVisualizationMessage?.({
            leaseId: viewer.leaseId,
            json: payload,
          }))
        )
          throw new Error("message-unavailable");
      }
    },
    [stillCurrent],
  );
  messageHandler.current = (viewer, json) => {
    if (
      viewer.binding.reference.purpose !== "mcp-app" ||
      !viewer.owner.api?.mcpApps ||
      !viewer.ticket ||
      json.length > 128 * 1024
    )
      return;
    if (viewer.requestBusy) {
      if (viewer.queuedMessages.length >= MAX_PENDING_MESSAGES) {
        void retire(viewer);
        return;
      }
      viewer.queuedMessages.push(json);
      return;
    }
    viewer.requestBusy = true;
    void (async () => {
      try {
        const result = decodeApp(
          await viewer.owner.api!.mcpApps!.prepare({
            threadId: viewer.binding.threadId,
            artifactId: viewer.binding.reference.artifactId,
            revisionId: viewer.binding.reference.revisionId,
            leaseId: viewer.leaseId!,
            ticket: viewer.ticket!,
            requestJson: json,
          }),
        );
        if (!stillCurrent(viewer)) return;
        if (result.kind === "reply") {
          if (result.displayMode)
            expand(visualizationBindingKey(viewer.binding), result.displayMode === "fullscreen");
          await forward(viewer, result.json, result.messages);
        } else {
          // Consent is a special nonrenewable native suspension, not an ordinary
          // hidden background view. Main drops guest actions and keeps the exact
          // document/lease only long enough to resolve this one operation.
          if (!viewer.bridge.suspendVisualization || !viewer.leaseId)
            throw new Error("consent-unavailable");
          viewer.consent = {
            operationId: result.operationId,
            method: result.method,
            ...(result.name ? { name: result.name } : {}),
            deadline: Date.now() + 30_000,
          };
          const suspended = await viewer.bridge.suspendVisualization({
            leaseId: viewer.leaseId,
            consentId: result.operationId,
            suspended: true,
          });
          if (!stillCurrent(viewer) || suspended !== true) throw new Error("consent-unavailable");
          if (
            !(await beforeOverlay(visualizationBindingKey(viewer.binding), false)) ||
            !stillCurrent(viewer)
          )
            throw new Error("consent-unavailable");
          viewer.queuedMessages.length = 0;
          setConsentExpanded(false);
          setConsentPrivate(null);
          setConsent(viewer.consent);
          setFeedback(false);
        }
      } catch {
        if (active.current === viewer) void retire(viewer);
      } finally {
        viewer.requestBusy = false;
        const next = viewer.queuedMessages.shift();
        if (next && stillCurrent(viewer) && !viewer.consent) messageHandler.current(viewer, next);
      }
    })();
  };

  const resolveConsent = useCallback(
    async (decision: "approve" | "deny") => {
      const viewer = active.current,
        pending = viewer?.consent;
      if (viewer?.requestBusy) return;
      if (
        !viewer ||
        !pending ||
        !stillCurrent(viewer) ||
        Date.now() >= pending.deadline ||
        !viewer.owner.api?.mcpApps ||
        !viewer.leaseId
      ) {
        if (viewer) void retire(viewer);
        return;
      }
      viewer.requestBusy = true;
      setConsentPrivate(null);
      setConsentExpanded(false);
      try {
        const reply = decodeReply(
          await viewer.owner.api.mcpApps.resolve({ operationId: pending.operationId, decision }),
        );
        if (!stillCurrent(viewer) || viewer.consent !== pending || Date.now() >= pending.deadline)
          throw new Error("stale");
        const resumed = await viewer.bridge.suspendVisualization!({
          leaseId: viewer.leaseId,
          consentId: pending.operationId,
          suspended: false,
        });
        if (!stillCurrent(viewer) || resumed !== true) throw new Error("stale");
        viewer.consent = null;
        setConsent(null);
        afterOverlay(visualizationBindingKey(viewer.binding));
        await forward(viewer, reply.json);
        if (reply.openUrl && stillCurrent(viewer)) {
          const url = new URL(reply.openUrl);
          if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username ||
            url.password
          )
            throw new Error("link-unavailable");
          const local = readLocalApi();
          if (!local) throw new Error("link-unavailable");
          await local.shell.openExternal(reply.openUrl);
        }
      } catch {
        void retire(viewer);
      } finally {
        viewer.requestBusy = false;
      }
    },
    [retire, stillCurrent, forward, afterOverlay],
  );

  useEffect(() => {
    if (!consent) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((consent.deadline - Date.now()) / 1000));
      setConsentRemaining(remaining);
      if (!remaining) {
        const viewer = active.current;
        if (viewer?.consent === consent) void retire(viewer);
      }
    };
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [consent, retire]);
  useEffect(() => {
    setConsentPrivate(null);
    const viewer = active.current;
    if (!consentExpanded || !consent || !viewer || !viewer.owner.api?.mcpApps) return;
    let cancelled = false;
    void viewer.owner.api.mcpApps
      .details({ operationId: consent.operationId })
      .then((raw) => {
        if (!cancelled && stillCurrent(viewer) && viewer.consent === consent)
          setConsentPrivate(decodeReply(raw).json);
      })
      .catch(() => {
        if (!cancelled) setFeedback(true);
      });
    return () => {
      cancelled = true;
    };
  }, [consentExpanded, consent, stillCurrent]);

  useLayoutEffect(() => {
    onSnapshot(slotKey, snapshot);
  }, [slotKey, snapshot, onSnapshot]);
  useLayoutEffect(() => {
    onController(slotKey, {
      snapshot,
      leaseId: active.current?.leaseId ?? null,
      run,
      stop,
      stopAndWait,
      attach,
      focus,
      expand,
      detach,
      retireScope,
      capture,
      yield: yieldViewer,
      presentationHidden,
    });
    return () => onController(slotKey, null);
  }, [
    slotKey,
    onController,
    snapshot,
    run,
    stop,
    stopAndWait,
    attach,
    focus,
    expand,
    detach,
    retireScope,
    capture,
    yieldViewer,
    presentationHidden,
  ]);
  return (
    <>
      <Dialog
        open={snapshot?.expanded === true}
        onOpenChange={(open) => {
          if (!open && snapshot) expand(snapshot.key, false);
        }}
      >
        <DialogPopup
          data-visualization-viewer="true"
          showCloseButton={false}
          bottomStickOnMobile={false}
          className={`fixed left-1/2 top-[calc(var(--cafe-visualization-titlebar-inset)+0.75rem)] h-[calc(100dvh-var(--cafe-visualization-titlebar-inset)-1.5rem)] max-h-none w-[calc(100vw-1.5rem)] max-w-[1600px] -translate-x-1/2 translate-y-0 scale-100 overflow-hidden rounded-lg transition-none data-starting-style:translate-y-0 data-starting-style:scale-100 data-starting-style:opacity-100 [app-region:no-drag] ${reserveMacTitlebar ? "[--cafe-visualization-titlebar-inset:50px]" : "[--cafe-visualization-titlebar-inset:0px]"} ${reserveNativeTitlebar ? "wco:[--cafe-visualization-titlebar-inset:calc(env(titlebar-area-y,0px)+env(titlebar-area-height,40px))]" : ""}`}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm">
              {active.current?.binding.reference.title ??
                uiText("Visualization", undefined, undefined, uiLocale)}
            </DialogTitle>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => snapshot && expand(snapshot.key, false)}
              >
                {uiText("Back to chat", undefined, undefined, uiLocale)}
              </Button>
              <Button size="sm" variant="outline" onClick={stop}>
                {uiText("Stop", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </div>
          <div
            ref={setExpandedAnchor}
            className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
            data-visualization-native-surface="expanded"
          />
        </DialogPopup>
      </Dialog>
      <Dialog
        open={consent !== null}
        onOpenChange={(open) => {
          if (!open) void resolveConsent("deny");
        }}
      >
        <DialogPopup
          data-visualization-consent="true"
          showCloseButton={false}
          className="[app-region:no-drag]"
        >
          <div className="space-y-3 p-5">
            <DialogTitle>{uiText("App permission", undefined, undefined, uiLocale)}</DialogTitle>
            <p className="text-sm">
              {uiText("Allow this one App operation?", undefined, undefined, uiLocale)}
            </p>
            <p className="text-sm text-muted-foreground">
              {consent?.method}
              {consent?.name ? ` · ${consent.name}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {uiText(
                "Permission expires in {seconds}s",
                { seconds: consentRemaining },
                undefined,
                uiLocale,
              )}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConsentExpanded((old) => !old)}
              aria-expanded={consentExpanded}
            >
              {uiText("Private details", undefined, undefined, uiLocale)}
            </Button>
            {consentExpanded ? (
              <VisualizationPrivateText
                value={consentPrivate ?? uiText("Loading…", undefined, undefined, uiLocale)}
              />
            ) : null}
            {feedback ? (
              <p role="status" className="text-xs">
                {uiText("Private details unavailable.", undefined, undefined, uiLocale)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button autoFocus variant="outline" onClick={() => void resolveConsent("deny")}>
                {uiText("Deny", undefined, undefined, uiLocale)}
              </Button>
              <Button onClick={() => void resolveConsent("approve")}>
                {uiText("Allow once", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
