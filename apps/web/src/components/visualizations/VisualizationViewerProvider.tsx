import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DesktopBridge, EnvironmentId, ThreadId } from "@cafecode/contracts";
import { VisualizationViewerTicketResult } from "@cafecode/contracts/visualizationApi";
import {
  McpAppPrepareResult,
  McpAppReply,
  type VisualizationReference,
} from "@cafecode/contracts/mcpApps";
import {
  VisualizationHostState,
  type VisualizationHostBounds,
  type VisualizationHostEvent,
} from "@cafecode/contracts/visualizationHost";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { useTheme } from "../../hooks/useTheme";
import { readLocalApi } from "../../localApi";
import { isWindowsPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { observeVisualizationOwner } from "./visualizationOwner";
import { visualizationPresentation } from "./visualizationPresentation";
import { VisualizationPrivateText } from "./VisualizationPrivateText";

export interface VisualizationBinding {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: VisualizationReference;
  readonly entryKey: string;
  readonly anchorId: string;
  readonly anchor: HTMLElement;
  readonly opener: HTMLElement;
}
export function visualizationBindingKey(
  binding: Pick<
    VisualizationBinding,
    "environmentId" | "threadId" | "reference" | "entryKey" | "anchorId"
  >,
) {
  return JSON.stringify([
    binding.environmentId,
    binding.threadId,
    binding.entryKey,
    binding.anchorId,
    binding.reference.artifactId,
    binding.reference.revisionId,
  ]);
}
type ViewerStatus = "starting" | "active" | "stopping" | "stopped" | "unavailable" | "quarantined";
interface ViewerSnapshot {
  key: string;
  status: ViewerStatus;
  expanded: boolean;
  expiresAtMs: number | null;
}
interface ActiveViewer {
  binding: Pick<
    VisualizationBinding,
    "environmentId" | "threadId" | "reference" | "entryKey" | "anchorId"
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
}
interface ViewerContext {
  snapshot: ViewerSnapshot | null;
  run: (binding: VisualizationBinding) => void;
  stop: () => void;
  expand: (key: string, expanded: boolean) => void;
  detach: (key: string) => void;
  retireScope: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  capture: (key: string, signal: AbortSignal) => Promise<Blob>;
}
const ViewerContext = createContext<ViewerContext | null>(null);
const decodeState = Schema.decodeUnknownSync(VisualizationHostState);
const decodeTicket = Schema.decodeUnknownSync(VisualizationViewerTicketResult);
const decodeApp = Schema.decodeUnknownSync(McpAppPrepareResult);
const decodeReply = Schema.decodeUnknownSync(McpAppReply);
const MAX_PENDING_MESSAGES = 8;

/** Only the two exact viewer-owned dialogs may retain this document's authority. */
function hasBlockingVisualizationOverlay() {
  return Boolean(
    document.querySelector(
      '[role="dialog"]:not([data-visualization-viewer]):not([data-visualization-consent]), [role="alertdialog"]',
    ),
  );
}

export function useVisualizationViewer() {
  return use(ViewerContext);
}

/** Finite trusted-shell geometry, never a guest-provided size or CSS selector. */
export function visualizationBounds(element: HTMLElement): VisualizationHostBounds | null {
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, Math.ceil(rect.x)),
    y = Math.max(0, Math.ceil(rect.y));
  const width = Math.min(1600, Math.floor(Math.min(rect.right, window.innerWidth) - x));
  const height = Math.min(2000, Math.floor(Math.min(rect.bottom, window.innerHeight) - y));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/**
 * This owner is above the recycled timeline. Cards contain only inert posters
 * and a geometry anchor; changing inline/fullscreen bounds never recreates the
 * native document. Native retirement is authoritative: a failed/uncertain stop
 * leaves this slot occupied and disables new admission instead of guessing.
 */
export function VisualizationViewerProvider({ children }: { children: ReactNode }) {
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
  const reserveNativeTitlebar =
    window.desktopBridge !== undefined && isWindowsPlatform(navigator.platform);

  const publish = useCallback((viewer: ActiveViewer, status: ViewerStatus) => {
    if (active.current !== viewer) return;
    setSnapshot((old) => ({
      key: visualizationBindingKey(viewer.binding),
      status,
      expanded: old?.key === visualizationBindingKey(viewer.binding) && old.expanded,
      expiresAtMs: old?.expiresAtMs ?? null,
    }));
  }, []);
  const retire = useCallback(
    async (viewer: ActiveViewer) => {
      if (active.current !== viewer) return;
      viewer.revoked = true;
      viewer.queuedMessages.length = 0;
      viewer.earlyMessages.length = 0;
      viewer.earlyStates.length = 0;
      viewer.ticket = null;
      viewer.consent = null;
      setConsent(null);
      setConsentPrivate(null);
      setConsentExpanded(false);
      publish(viewer, "stopping");
      if (!viewer.leaseId) {
        // If native open has begun, a lost acknowledgement cannot prove that no
        // renderer exists. Keep this owner occupied until its exact lease is known.
        if (viewer.openStarted) publish(viewer, "quarantined");
        return;
      }
      try {
        const result = decodeState(
          await viewer.bridge.retireVisualization?.({ leaseId: viewer.leaseId }),
        );
        if (active.current !== viewer || result.leaseId !== viewer.leaseId) return;
        if (result.state === "retired") {
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
    },
    [publish],
  );
  const stop = useCallback(() => {
    const viewer = active.current;
    if (viewer) void retire(viewer);
  }, [retire]);
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

  const run = useCallback(
    (binding: VisualizationBinding) => {
      if (
        active.current ||
        !binding.anchor.isConnected ||
        document.visibilityState !== "visible" ||
        hasBlockingVisualizationOverlay()
      )
        return;
      const bridge = window.desktopBridge;
      if (
        !bridge?.openVisualization ||
        !bridge.updateVisualization ||
        !bridge.retireVisualization ||
        !bridge.getVisualizationHostCapabilities ||
        !bridge.onVisualizationHostEvent
      ) {
        setSnapshot({
          key: visualizationBindingKey(binding),
          status: "unavailable",
          expanded: false,
          expiresAtMs: null,
        });
        return;
      }
      const bounds = visualizationBounds(binding.anchor);
      if (!bounds) return;
      let viewer: ActiveViewer;
      const owner = observeVisualizationOwner(binding.environmentId, () => {
        if (viewer) void retire(viewer);
      });
      viewer = {
        binding: {
          environmentId: binding.environmentId,
          threadId: binding.threadId,
          reference: binding.reference,
          entryKey: binding.entryKey,
          anchorId: binding.anchorId,
        },
        anchor: new WeakRef(binding.anchor),
        opener: new WeakRef(binding.opener),
        bridge,
        owner,
        leaseId: null,
        ticket: null,
        openStarted: false,
        revoked: false,
        consent: null,
        requestBusy: false,
        queuedMessages: [],
        earlyMessages: [],
        earlyStates: [],
      };
      active.current = viewer;
      setSnapshot({
        key: visualizationBindingKey(binding),
        status: "starting",
        expanded: false,
        expiresAtMs: null,
      });
      void (async () => {
        try {
          const capabilities = await bridge.getVisualizationHostCapabilities!();
          if (!stillCurrent(viewer) || !capabilities.available || !owner.api?.visualizations)
            throw new Error("unavailable");
          const result = decodeTicket(
            await owner.api.visualizations.viewerTicket({
              threadId: binding.threadId,
              artifactId: binding.reference.artifactId,
              revisionId: binding.reference.revisionId,
            }),
          );
          if (
            !stillCurrent(viewer) ||
            result.threadId !== binding.threadId ||
            result.artifactId !== binding.reference.artifactId ||
            result.revisionId !== binding.reference.revisionId ||
            !binding.anchor.isConnected
          )
            throw new Error("stale");
          viewer.ticket = result.ticket;
          viewer.openStarted = true;
          const opened = decodeState(
            await bridge.openVisualization!({
              ticket: result.ticket,
              bounds,
              appearance: appearance.current,
              displayMode: "inline",
              presentation: visualizationPresentation(locale.current),
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
          });
          // Guest initialization can race the open IPC response. Only after the
          // exact native lease is known may an early message reach the broker.
          const early = viewer.earlyMessages.splice(0);
          for (const message of early)
            if (message.leaseId === viewer.leaseId) messageHandler.current(viewer, message.json);
        } catch {
          if (active.current !== viewer) return;
          if (viewer.leaseId) await retire(viewer);
          else if (viewer.openStarted) {
            viewer.revoked = true;
            viewer.ticket = null;
            viewer.queuedMessages.length = 0;
            viewer.earlyMessages.length = 0;
            viewer.earlyStates.length = 0;
            publish(viewer, "quarantined");
          } else {
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
    [publish, retire, stillCurrent],
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
      setSnapshot((old) => (old?.key === key ? { ...old, expanded } : old));
    },
    [retire],
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

  useEffect(() => {
    const bridge = window.desktopBridge;
    const off = bridge?.onVisualizationHostEvent?.((event) => {
      const viewer = active.current;
      if (!viewer || viewer.bridge !== bridge) return;
      if (viewer.leaseId === null) {
        if (event.state === "retired" || event.state === "quarantined") {
          if (viewer.earlyStates.length >= MAX_PENDING_MESSAGES) {
            void retire(viewer);
            return;
          }
          viewer.earlyStates.push(event);
        }
        if (
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
      if (event.state === "message" && event.json && stillCurrent(viewer) && !viewer.consent)
        messageHandler.current(viewer, event.json);
      else if (event.state === "retired") {
        restoreFocus.current = {
          key: visualizationBindingKey(viewer.binding),
          anchor: viewer.anchor,
          opener: viewer.opener,
        };
        viewer.revoked = true;
        viewer.owner.dispose();
        active.current = null;
        viewer.consent = null;
        viewer.queuedMessages.length = 0;
        viewer.ticket = null;
        setConsent(null);
        setConsentPrivate(null);
        setConsentExpanded(false);
        setSnapshot((old) => (old ? { ...old, status: "stopped", expanded: false } : old));
      } else if (event.state === "quarantined") {
        viewer.revoked = true;
        viewer.consent = null;
        viewer.queuedMessages.length = 0;
        viewer.ticket = null;
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
      attributeFilter: ["role", "aria-modal", "inert"],
    });
    document.addEventListener("visibilitychange", hidden);
    return () => {
      off?.();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      stop();
    };
  }, [publish, stop, retire, stillCurrent]);

  useLayoutEffect(() => {
    const pending = restoreFocus.current;
    if (
      !pending ||
      active.current ||
      snapshot?.key !== pending.key ||
      snapshot.status !== "stopped"
    )
      return;
    restoreFocus.current = null;
    // The running toolbar replaces Run with Stop, so the old opener may have
    // been removed. Resolve only within the exact still-connected card after
    // React commits its replacement control; never steal focus from a new host.
    const opener = pending.opener.deref();
    const target = opener?.isConnected
      ? opener
      : pending.anchor
          .deref()
          ?.closest("[data-visualization-card]")
          ?.querySelector<HTMLElement>("[data-visualization-run]");
    if (target?.isConnected) target.focus({ preventScroll: true });
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
      const bounds = visualizationBounds(element);
      if (!bounds) {
        void retire(viewer);
        return;
      }
      if (busy) {
        trailing = true;
        return;
      }
      const presentation = visualizationPresentation(locale.current);
      const displayMode = snapshot.expanded ? "fullscreen" : "inline";
      const value = JSON.stringify([bounds, appearance.current, displayMode, presentation]);
      if (value === previous) return;
      previous = value;
      busy = true;
      void viewer.bridge.updateVisualization!({
        leaseId: viewer.leaseId!,
        bounds,
        visible: true,
        appearance: appearance.current,
        displayMode,
        presentation,
      })
        .then((raw) => {
          const result = decodeState(raw);
          if (
            active.current === viewer &&
            result.leaseId === viewer.leaseId &&
            result.state !== "active"
          )
            void retire(viewer);
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
    [retire, stillCurrent, forward],
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

  return (
    <ViewerContext value={{ snapshot, run, stop, expand, detach, retireScope, capture }}>
      {children}
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
          className={`fixed bottom-6 left-1/2 top-6 h-auto w-[calc(100vw-3rem)] max-w-[1600px] -translate-x-1/2 translate-y-0 scale-100 transition-none data-starting-style:translate-y-0 data-starting-style:scale-100 data-starting-style:opacity-100 [app-region:no-drag] ${reserveNativeTitlebar ? "wco:[--cafe-visualization-titlebar-inset:calc(env(titlebar-area-y,0px)+env(titlebar-area-height,40px))] wco:top-[calc(var(--cafe-visualization-titlebar-inset)+1.5rem)]" : ""}`}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle p-3">
            <DialogTitle className="truncate text-sm">
              {active.current?.binding.reference.title ??
                uiText("Visualization", undefined, undefined, uiLocale)}
            </DialogTitle>
            <div className="flex gap-2">
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
            className="min-h-0 flex-1 bg-background"
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
    </ViewerContext>
  );
}

/** Pane ownership is exact; the queue fallback owner never controls a viewer. */
export function useVisualizationScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  admitted: boolean,
) {
  const viewer = useVisualizationViewer();
  const retireScope = viewer?.retireScope;
  useEffect(() => {
    if (!admitted) retireScope?.(environmentId, threadId);
    return () => retireScope?.(environmentId, threadId);
  }, [environmentId, threadId, admitted, retireScope]);
}
