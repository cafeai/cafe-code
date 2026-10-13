import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { DesktopBridge, EnvironmentId, ThreadId } from "@cafecode/contracts";
import { VisualizationViewerTicketResult } from "@cafecode/contracts/visualizationApi";
import {
  VisualizationHostCapacity,
  VisualizationHostCapabilities,
  type VisualizationHostCapacity as Capacity,
  type VisualizationHostCapabilities as Capabilities,
} from "@cafecode/contracts/visualizationHost";
import * as Schema from "effect/Schema";
import { observeVisualizationOwner } from "./visualizationOwner";
import { visualizationGeometry } from "./visualizationGeometry";
import {
  createVisualizationPane,
  createVisualizationViewportEpochs,
  type VisualizationPane,
} from "./visualizationViewportEpochs";
import {
  VisualizationViewerSlot,
  visualizationBindingKey as legacyBindingKey,
  type VisualizationBinding,
  type VisualizationPreparedViewer,
  type VisualizationSlotController,
  type ViewerSnapshot,
} from "./VisualizationViewerSlot";

export type { VisualizationBinding } from "./VisualizationViewerSlot";
export { visualizationBindingKey } from "./VisualizationViewerSlot";
export type { VisualizationPane } from "./visualizationViewportEpochs";
const decodeTicket = Schema.decodeUnknownSync(VisualizationViewerTicketResult);
const decodeCapacity = Schema.decodeUnknownSync(VisualizationHostCapacity);
const decodeCapabilities = Schema.decodeUnknownSync(VisualizationHostCapabilities);
const MAX_REGISTERED = 128;
const MAX_PREPARING = 2;
const MAX_VIEWERS = 4;
const MAX_PANES = 16;
const paneIds = new WeakMap<object, number>();
let nextPaneId = 0;
function paneId(pane: object) {
  let id = paneIds.get(pane);
  if (id === undefined) {
    id = ++nextPaneId;
    paneIds.set(pane, id);
  }
  return id;
}
interface PaneRecord {
  admitted: boolean;
  priority: boolean;
  environmentId?: EnvironmentId;
  threadId?: ThreadId;
  epochs: ReturnType<typeof createVisualizationViewportEpochs>;
}
interface RecordEntry {
  key: string;
  pane: VisualizationPane;
  binding: VisualizationBinding | null;
  mount: object | null;
  near: boolean;
  visible: boolean;
  eligible: boolean;
  requested: boolean;
  /** Monotonic for this exact record; presentation/cache state is not authority. */
  authorityAttempted: boolean;
  sequence: number;
  serial: number;
  preparing: boolean;
  prepared: VisualizationPreparedViewer | null;
  continuation: { continuation: string; expiresAtMs: number | null } | null;
  snapshot: ViewerSnapshot | null;
}
interface ViewerContext {
  automatic: boolean;
  defaultPane: VisualizationPane;
  key: (
    pane: VisualizationPane,
    binding: Pick<VisualizationBinding, "environmentId" | "threadId" | "reference" | "entryKey">,
  ) => string;
  subscribe: (key: string, listener: () => void) => () => void;
  snapshot: (key: string) => ViewerSnapshot | null;
  register: (binding: VisualizationBinding) => () => void;
  observe: (
    key: string,
    anchorId: string,
    near: boolean,
    visible: boolean,
    actual: boolean,
  ) => void;
  run: (binding: VisualizationBinding) => void;
  stop: (key: string) => void;
  expand: (key: string, expanded: boolean) => void;
  focus: (key: string) => void;
  detach: (key: string) => void;
  scope: (
    pane: VisualizationPane,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    admitted: boolean,
    priority: boolean,
  ) => void;
  closePane: (pane: VisualizationPane) => void;
  availability: () => number;
  manualAllowed: () => boolean;
  capture: (key: string, signal: AbortSignal) => Promise<Blob>;
  /** Current generated-only policy, never inferred from an old pooled host. */
  visibleLifetime: () => boolean;
  presentationOverlay: (key: string, hidden: boolean) => Promise<boolean>;
}
const ViewerContext = createContext<ViewerContext | null>(null);
const AutomaticContext = createContext(false);
export function useVisualizationViewer() {
  return use(ViewerContext);
}
export function useAutomaticVisualization() {
  return use(AutomaticContext);
}
export function useVisualizationAvailability() {
  const viewer = useVisualizationViewer();
  const subscribe = useCallback(
    (listener: () => void) => viewer?.subscribe("$pool", listener) ?? (() => undefined),
    [viewer],
  );
  // The subscribed value participates directly in render decisions. An
  // ignored wake-up revision would let compiled React cache an imperative
  // manualAllowed() call against an otherwise stable context object.
  const read = useCallback(() => viewer?.manualAllowed() ?? false, [viewer]);
  return useSyncExternalStore(subscribe, read, read);
}
export function useVisualizationSnapshot(key: string) {
  const viewer = useVisualizationViewer();
  const subscribe = useCallback(
    (listener: () => void) => viewer?.subscribe(key, listener) ?? (() => undefined),
    [viewer, key],
  );
  const read = useCallback(() => viewer?.snapshot(key) ?? null, [viewer, key]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Window-owned scheduler above recycled rows. Native main alone owns the global
 * reservation count. Capacity observations are hints; exact lease ACKs and
 * retirement decide lifecycle. At most two private ticket requests and four
 * local controllers exist. No polling, source strings or history scan occurs.
 */
export function VisualizationViewerProvider({ children }: { children: ReactNode }) {
  const defaultPane = useRef(createVisualizationPane()).current;
  const records = useRef(new Map<string, RecordEntry>());
  const panes = useRef(
    new Map<VisualizationPane, PaneRecord>([
      [
        defaultPane,
        { admitted: true, priority: false, epochs: createVisualizationViewportEpochs() },
      ],
    ]),
  );
  const listeners = useRef(new Map<string, Set<() => void>>());
  const controllers = useRef(new Map<string, VisualizationSlotController>());
  const slots = useRef(new Set<string>());
  const [slotKeys, setSlotKeys] = useState<string[]>([]);
  const [automatic, setAutomatic] = useState(false);
  const automaticRef = useRef(false);
  const visibleLifetimeRef = useRef(false);
  const capacity = useRef<Capacity | null>(null);
  const capacitySequence = useRef(-1);
  const bridgeRef = useRef<DesktopBridge | undefined>(undefined);
  const preparationCount = useRef(0);
  const sequence = useRef(0);
  const overlay = useRef<string | null>(null);
  const overlayGeneration = useRef(0);
  const priorityAdmissions = useRef(0);
  const availability = useRef(0);
  const capabilitiesPromise = useRef<Promise<Capabilities> | null>(null);
  const readCapabilities = useCallback(
    () => capabilitiesPromise.current ?? Promise.reject(new Error("unavailable")),
    [],
  );
  const changedAvailability = useCallback(() => {
    availability.current += 1;
    for (const listener of listeners.current.get("$pool") ?? []) listener();
  }, []);
  const pendingPump = useRef(false);
  const mounted = useRef(true);
  const pump = useRef<() => void>(() => undefined);
  const notify = useCallback((record: RecordEntry, snapshot: ViewerSnapshot | null) => {
    const layout = snapshot?.layout ?? record.snapshot?.layout;
    record.snapshot = snapshot && layout ? { ...snapshot, layout } : snapshot;
    for (const listener of listeners.current.get(record.key) ?? []) listener();
  }, []);
  const schedule = useCallback(() => {
    if (pendingPump.current || !mounted.current) return;
    pendingPump.current = true;
    queueMicrotask(() => {
      pendingPump.current = false;
      if (mounted.current) pump.current();
    });
  }, []);
  const discard = useCallback((record: RecordEntry, prepared: VisualizationPreparedViewer) => {
    const binding = record.binding;
    if (binding)
      void prepared.owner.api?.visualizations
        ?.discardViewerTicket?.({
          threadId: binding.threadId,
          artifactId: binding.reference.artifactId,
          revisionId: binding.reference.revisionId,
          ticket: prepared.ticket.ticket,
        })
        .catch(() => undefined);
    prepared.owner.dispose();
  }, []);
  const cancel = useCallback(
    (record: RecordEntry, terminal: boolean) => {
      if (terminal) record.authorityAttempted = true;
      const attempted =
        record.prepared !== null ||
        record.preparing ||
        record.requested ||
        record.snapshot !== null;
      record.serial += 1;
      if (record.prepared) {
        discard(record, record.prepared);
        record.prepared = null;
      }
      record.continuation = null;
      record.requested = false;
      if (terminal) {
        panes.current.get(record.pane)?.epochs.terminal(record.key);
        record.eligible = false;
      }
      const controller = controllers.current.get(record.key);
      if (controller) controller.stop();
      else if (!slots.current.has(record.key) && (attempted || automaticRef.current))
        notify(record, {
          key: record.key,
          status: "stopped",
          expanded: false,
          expiresAtMs: record.snapshot?.expiresAtMs ?? null,
        });
    },
    [discard, notify],
  );
  const removeSlot = useCallback(
    (key: string) => {
      if (slots.current.delete(key)) {
        setSlotKeys([...slots.current]);
        changedAvailability();
      }
      controllers.current.delete(key);
    },
    [changedAvailability],
  );
  const restorePresentations = useCallback(async (generation: number) => {
    // Snapshot the at-most-four entries before awaiting. Each ACK publishes a
    // new Slot snapshot, whose controller effect deletes/reinserts its key; a
    // live Map iterator would revisit that key indefinitely and starve timers.
    if (controllers.current.size > MAX_VIEWERS) return false;
    const admittedControllers = [...controllers.current];
    for (const [key, admitted] of admittedControllers) {
      if (overlay.current !== null || overlayGeneration.current !== generation || !mounted.current)
        return false;
      const controller = controllers.current.get(key);
      if (
        controller?.leaseId === admitted.leaseId &&
        records.current.get(key)?.binding?.reference.purpose === "generated-visualization" &&
        controller.snapshot?.status === "active"
      )
        await controller.presentationHidden(false);
    }
    return true;
  }, []);
  const onSnapshot = useCallback(
    (key: string, snapshot: ViewerSnapshot | null) => {
      const record = records.current.get(key);
      if (!record || !snapshot) return;
      if (snapshot.layout)
        panes.current.get(record.pane)?.epochs.rememberLayout(key, snapshot.layout);
      notify(record, snapshot);
      schedule();
      if (["stopped", "unavailable", "quarantined"].includes(snapshot.status)) {
        panes.current.get(record.pane)?.epochs.terminal(key);
        record.eligible = false;
        record.requested = false;
        // Terminal source ownership is not proof that its host-owned menu or
        // private/HTML inspector has finished closing. Keep that exact overlay
        // fence until the Card releases it after portal exit or unmount; only
        // surviving active siblings may then restore their native pixels.
        if (snapshot.status !== "quarantined") removeSlot(key);
        if (!record.binding && !record.preparing && snapshot.status !== "quarantined")
          records.current.delete(key);
        schedule();
      }
    },
    [notify, removeSlot, schedule, restorePresentations],
  );
  const onController = useCallback(
    (key: string, controller: VisualizationSlotController | null) => {
      if (controller) controllers.current.set(key, controller);
      else controllers.current.delete(key);
      schedule();
    },
    [schedule],
  );
  const beforeOverlay = useCallback(
    async (key: string, transition = true) => {
      if (overlay.current && overlay.current !== key) return false;
      if (overlay.current === key) return false;
      overlay.current = key;
      const generation = ++overlayGeneration.current;
      let ready = false;
      try {
        const selected = controllers.current.get(key);
        if (!selected?.snapshot || selected.snapshot.status !== "active" || !selected.leaseId)
          return false;
        const lease = selected.leaseId;
        for (const other of [...slots.current].filter((value) => value !== key)) {
          const record = records.current.get(other),
            controller = controllers.current.get(other);
          if (!record || !controller) return false;
          if (record.binding?.reference.purpose === "mcp-app") {
            if (!(await controller.stopAndWait())) return false;
          } else {
            const continuation = await controller.yield();
            if (!continuation) return false;
            record.continuation = continuation;
            removeSlot(other);
          }
          if (
            overlay.current !== key ||
            overlayGeneration.current !== generation ||
            !mounted.current
          )
            return false;
        }
        // The selected view hides before its portal mounts; only exact geometry
        // commit may expose this same document again, within its original budget.
        if (
          transition &&
          automaticRef.current &&
          !(await bridgeRef.current?.beginVisualizationTransition?.({ leaseId: lease }))
        ) {
          selected.stop();
          return false;
        }
        ready =
          overlay.current === key &&
          overlayGeneration.current === generation &&
          mounted.current &&
          controllers.current.get(key)?.leaseId === lease &&
          controllers.current.get(key)?.snapshot?.status === "active";
        return ready;
      } catch {
        controllers.current.get(key)?.stop();
        return false;
      } finally {
        if (!ready && overlay.current === key && overlayGeneration.current === generation) {
          overlay.current = null;
          schedule();
        }
      }
    },
    [removeSlot, schedule],
  );
  const afterOverlay = useCallback(
    (key: string) => {
      if (overlay.current === key) {
        overlay.current = null;
        schedule();
      }
    },
    [schedule],
  );

  const prepare = useCallback(
    (record: RecordEntry) => {
      const binding = record.binding;
      if (!binding || record.preparing || preparationCount.current >= MAX_PREPARING) return;
      const serial = record.serial;
      // Latch before any private owner observation/ticket request. Cleanup may
      // never reinterpret a begun attempt as an untouched React registration.
      record.authorityAttempted = true;
      record.preparing = true;
      preparationCount.current += 1;
      let owner: ReturnType<typeof observeVisualizationOwner>;
      owner = observeVisualizationOwner(binding.environmentId, () => cancel(record, true));
      notify(record, {
        key: record.key,
        status: "preparing",
        expanded: false,
        expiresAtMs: record.continuation?.expiresAtMs ?? null,
      });
      void (async () => {
        let prepared: VisualizationPreparedViewer | null = null;
        try {
          if (!owner.current() || !owner.api?.visualizations?.discardViewerTicket)
            throw new Error("unavailable");
          const ticket = decodeTicket(
            await owner.api.visualizations.viewerTicket({
              threadId: binding.threadId,
              artifactId: binding.reference.artifactId,
              revisionId: binding.reference.revisionId,
            }),
          );
          prepared = {
            owner,
            ticket,
            automatic: binding.reference.purpose === "generated-visualization",
            ...(record.continuation ?? {}),
          };
          if (
            ticket.threadId !== binding.threadId ||
            ticket.artifactId !== binding.reference.artifactId ||
            ticket.revisionId !== binding.reference.revisionId ||
            !mounted.current ||
            serial !== record.serial ||
            record.binding !== binding ||
            !record.near ||
            !owner.current()
          )
            throw new Error("stale");
          record.prepared = prepared;
          notify(record, {
            key: record.key,
            status: "waiting",
            expanded: false,
            expiresAtMs: record.continuation?.expiresAtMs ?? null,
          });
        } catch {
          if (prepared) discard({ ...record, binding }, prepared);
          else owner.dispose();
          if (serial === record.serial) {
            panes.current.get(record.pane)?.epochs.terminal(record.key);
            record.eligible = false;
            notify(record, {
              key: record.key,
              status: "unavailable",
              expanded: false,
              expiresAtMs: null,
            });
          }
        } finally {
          record.preparing = false;
          preparationCount.current -= 1;
          if (!record.binding && !slots.current.has(record.key)) records.current.delete(record.key);
          schedule();
        }
      })();
    },
    [cancel, discard, notify, schedule],
  );

  pump.current = () => {
    if (
      !mounted.current ||
      overlay.current ||
      document.visibilityState !== "visible" ||
      document.querySelector('[role="dialog"], [role="alertdialog"]')
    )
      return;
    const cap = capacity.current;
    if (
      automaticRef.current &&
      (!cap?.available ||
        [...records.current.values()].some((record) => record.snapshot?.status === "quarantined"))
    )
      return;
    const candidates = [...records.current.values()].filter(
      (record) =>
        record.binding &&
        panes.current.get(record.pane)?.admitted &&
        record.eligible &&
        ((automaticRef.current && record.binding.reference.purpose === "generated-visualization") ||
          record.requested),
    );
    const order = (left: RecordEntry, right: RecordEntry) => {
      // Stable live slots never get preempted. Focus wins a bounded two-admit
      // burst, then oldest FIFO wins so an inactive visible pane cannot starve.
      if (priorityAdmissions.current < 2) {
        const priority =
          Number(panes.current.get(right.pane)?.priority ?? false) -
          Number(panes.current.get(left.pane)?.priority ?? false);
        if (priority) return priority;
      }
      return left.sequence - right.sequence;
    };
    while (candidates.length) {
      // Re-evaluate after each admission, not only once per pump: a four-slot
      // burst must actually include its FIFO turn rather than starving a pane.
      candidates.sort(order);
      const record = candidates.shift()!;
      const binding = record.binding!;
      if (slots.current.has(record.key)) {
        const controller = controllers.current.get(record.key);
        if (controller && !controller.snapshot) {
          const prepared = record.prepared ?? undefined;
          record.prepared = null;
          controller.run(binding, prepared);
        }
        continue;
      }
      if (!record.near) continue;
      if (
        record.continuation &&
        record.continuation.expiresAtMs !== null &&
        record.continuation.expiresAtMs <= Date.now()
      ) {
        cancel(record, true);
        continue;
      }
      if (record.prepared && record.prepared.ticket.expiresAtMs <= Date.now()) {
        cancel(record, true);
        continue;
      }
      if (
        automaticRef.current &&
        !record.prepared &&
        !record.preparing &&
        preparationCount.current < MAX_PREPARING &&
        (cap?.freePreparations ?? 0) > preparationCount.current
      )
        prepare(record);
      if (!record.visible || !visualizationGeometry(binding.anchor)) continue;
      const max = automaticRef.current ? MAX_VIEWERS : 1;
      if (slots.current.size >= max) continue;
      const pendingNative = [...slots.current].filter(
        (key) => !controllers.current.get(key)?.leaseId,
      ).length;
      if (
        automaticRef.current &&
        (!record.prepared ||
          !cap ||
          cap.freeViewers <= pendingNative ||
          (binding.reference.purpose === "mcp-app" &&
            (!cap.mcpAppAvailable ||
              [...slots.current].some(
                (key) => records.current.get(key)?.binding?.reference.purpose === "mcp-app",
              ))))
      )
        continue;
      record.authorityAttempted = true;
      slots.current.add(record.key);
      changedAvailability();
      priorityAdmissions.current =
        priorityAdmissions.current < 2 && panes.current.get(record.pane)?.priority
          ? priorityAdmissions.current + 1
          : 0;
      notify(record, {
        key: record.key,
        status: "starting",
        expanded: false,
        expiresAtMs: record.continuation?.expiresAtMs ?? null,
        visible: false,
      });
      setSlotKeys([...slots.current]);
    }
  };

  useEffect(() => {
    mounted.current = true;
    const bridge = window.desktopBridge;
    bridgeRef.current = bridge;
    let disposed = false;
    const accept = (raw: unknown) => {
      if (disposed || bridge !== window.desktopBridge) return;
      try {
        const value = decodeCapacity(raw);
        if (value.sequence <= capacitySequence.current) return;
        capacitySequence.current = value.sequence;
        capacity.current = value;
        changedAvailability();
        schedule();
      } catch {
        capacity.current = null;
      }
    };
    const off = bridge?.onVisualizationCapacityChanged?.(accept);
    capabilitiesPromise.current =
      bridge?.getVisualizationHostCapabilities?.().then(decodeCapabilities) ??
      Promise.reject(new Error("unavailable"));
    void capabilitiesPromise.current
      .then((caps) => {
        if (disposed || bridge !== window.desktopBridge) return;
        const supported =
          "poolVersion" in caps &&
          caps.available &&
          caps.autoGenerated &&
          Boolean(
            bridge?.getVisualizationHostCapacity &&
            bridge.onVisualizationCapacityChanged &&
            bridge.yieldVisualization &&
            bridge.beginVisualizationTransition,
          );
        automaticRef.current = supported;
        visibleLifetimeRef.current =
          supported && "generatedLifecycle" in caps && caps.generatedLifecycle === "visible";
        setAutomatic(supported);
        if (supported)
          for (const record of records.current.values()) {
            if (!record.eligible && !record.snapshot)
              notify(record, {
                key: record.key,
                status: "stopped",
                expanded: false,
                expiresAtMs: null,
              });
          }
        if (supported)
          void bridge!.getVisualizationHostCapacity!()
            .then(accept)
            .catch(() => {
              capacity.current = null;
            });
        schedule();
      })
      .catch(() => undefined);
    const hidden = () => {
      if (document.visibilityState !== "visible")
        for (const record of records.current.values()) cancel(record, true);
    };
    const overlays = new MutationObserver(() => {
      if (
        document.querySelector(
          '[role="dialog"]:not([data-visualization-viewer]):not([data-visualization-consent]):not([data-visualization-inspection]), [role="alertdialog"]',
        )
      )
        for (const record of records.current.values()) cancel(record, true);
      schedule();
    });
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "inert", "aria-hidden", "hidden"],
    });
    document.addEventListener("visibilitychange", hidden);
    return () => {
      disposed = true;
      mounted.current = false;
      off?.();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      for (const record of records.current.values()) cancel(record, true);
    };
  }, [cancel, schedule, changedAvailability, notify]);
  const knownSiblingLease = useCallback(
    (key: string, leaseId: string) =>
      [...controllers.current].some(
        ([other, controller]) => other !== key && controller.leaseId === leaseId,
      ),
    [],
  );

  const context = useMemo<ViewerContext>(
    () => ({
      get automatic() {
        return automaticRef.current;
      },
      visibleLifetime: () => visibleLifetimeRef.current,
      presentationOverlay: async (key, hidden) => {
        if (!visibleLifetimeRef.current) return false;
        if (hidden) {
          if (controllers.current.size > MAX_VIEWERS) return false;
          const selected = records.current.get(key);
          if (
            !selected?.binding ||
            selected.binding.reference.purpose !== "generated-visualization"
          )
            return false;
          if (overlay.current && overlay.current !== key) return false;
          overlay.current = key;
          const generation = ++overlayGeneration.current;
          // At most four exact controllers exist. Hide every generated native
          // surface before a portal can overlap its pixels, preserving each
          // document rather than using destructive expansion continuations.
          // Manual Apps retain their existing overlay retirement policy.
          // Use one finite admission snapshot here for the same delete/reinsert
          // reason as restorePresentations. Re-resolve only the exact same
          // native lease before each step; never adopt a replacement document.
          const admittedControllers = [...controllers.current];
          for (const [other, admitted] of admittedControllers) {
            const record = records.current.get(other);
            const controller = controllers.current.get(other);
            if (!record || !controller || controller.leaseId !== admitted.leaseId) continue;
            const starting =
              controller.snapshot?.status === "starting" || record.snapshot?.status === "starting";
            if (!starting && controller.snapshot?.status !== "active") continue;
            const accepted =
              !starting && record.binding?.reference.purpose === "generated-visualization"
                ? await controller.presentationHidden(true)
                : await controller.stopAndWait(false);
            if (
              !accepted ||
              overlay.current !== key ||
              overlayGeneration.current !== generation ||
              !mounted.current
            ) {
              if (overlay.current === key && overlayGeneration.current === generation) {
                overlay.current = null;
                ++overlayGeneration.current;
                await restorePresentations(overlayGeneration.current);
              }
              schedule();
              return false;
            }
          }
          return (
            overlay.current === key && overlayGeneration.current === generation && mounted.current
          );
        }
        if (overlay.current !== key) return true;
        overlay.current = null;
        ++overlayGeneration.current;
        // A close is presentation only. Each controller rechecks its current
        // connected anchor, exact owner and lease; terminal state is never
        // reopened and a genuinely offscreen document is retired instead.
        const restored = await restorePresentations(overlayGeneration.current);
        schedule();
        return restored;
      },
      defaultPane,
      availability: () => availability.current,
      manualAllowed: () =>
        automaticRef.current ? capacity.current?.available === true : slots.current.size === 0,
      key: (pane, binding) =>
        JSON.stringify([
          paneId(pane),
          binding.environmentId,
          binding.threadId,
          binding.entryKey,
          binding.reference.artifactId,
          binding.reference.revisionId,
        ]),
      subscribe: (key, listener) => {
        let set = listeners.current.get(key);
        if (!set) {
          set = new Set();
          listeners.current.set(key, set);
        }
        set.add(listener);
        return () => {
          set!.delete(listener);
          if (!set!.size) listeners.current.delete(key);
        };
      },
      snapshot: (key) => records.current.get(key)?.snapshot ?? null,
      register: (binding) => {
        const pane = binding.pane ?? defaultPane;
        const key = binding.poolKey ?? legacyBindingKey(binding);
        if (!panes.current.has(pane)) {
          if (panes.current.size >= MAX_PANES) return () => undefined;
          panes.current.set(pane, {
            admitted: true,
            priority: false,
            epochs: createVisualizationViewportEpochs(),
          });
        }
        let record = records.current.get(key);
        const created = record === undefined;
        if (!record) {
          if (records.current.size >= MAX_REGISTERED) return () => undefined;
          const epochs = panes.current.get(pane)!.epochs;
          const layout = epochs.layout(key);
          const terminal = epochs.has(key) && !epochs.allowed(key);
          record = {
            key,
            pane,
            binding: null,
            mount: null,
            near: false,
            visible: false,
            eligible: true,
            requested: false,
            authorityAttempted: terminal,
            sequence: ++sequence.current,
            serial: 0,
            preparing: false,
            prepared: null,
            continuation: null,
            snapshot:
              terminal || layout
                ? {
                    key,
                    status: terminal ? "stopped" : "waiting",
                    expanded: false,
                    expiresAtMs: null,
                    ...(layout ? { layout } : {}),
                  }
                : null,
          };
          records.current.set(key, record);
        }
        const mount = Object.freeze({});
        record.binding = binding;
        record.mount = mount;
        controllers.current.get(key)?.attach(binding);
        // A poster card may already be subscribed while list readiness defers
        // registration. Restoring a cached stopped/waiting snapshot after its
        // render therefore needs an exact keyed notification; terminal records
        // intentionally have no later native event to wake that subscriber.
        // Publish only after installing this binding/mount. This is cached
        // presentation, not a new visibility epoch or execution admission.
        if (created && record.snapshot !== null) notify(record, record.snapshot);
        return () => {
          if (record!.mount !== mount) return;
          if (record!.snapshot?.expanded) {
            record!.mount = null;
            record!.binding = null;
            return;
          }
          const presentationOnly =
            record!.snapshot === null ||
            (record!.snapshot.status === "waiting" &&
              record!.snapshot.expiresAtMs === null &&
              !record!.snapshot.visible &&
              !record!.snapshot.expanded);
          const untouchedRegistration =
            !record!.authorityAttempted &&
            !record!.requested &&
            !record!.preparing &&
            record!.prepared === null &&
            record!.continuation === null &&
            !slots.current.has(key) &&
            !controllers.current.has(key) &&
            presentationOnly;
          if (untouchedRegistration) {
            // StrictMode may replay a wholly unattempted registration. Revoke
            // its exact local serial/binding, but do not invent terminal native
            // authority that never existed. No epoch is cleared or restarted.
            record!.serial += 1;
          } else cancel(record!, true);
          record!.binding = null;
          record!.mount = null;
          record!.near = false;
          record!.visible = false;
          if (!slots.current.has(key) && !record!.preparing) records.current.delete(key);
        };
      },
      observe: (key, anchorId, near, visible, actual) => {
        const record = records.current.get(key);
        if (!record?.binding || record.binding.anchorId !== anchorId) return;
        record.near = near;
        record.visible = visible;
        const pane = panes.current.get(record.pane);
        if (actual)
          record.eligible = (pane?.epochs.observe(key, visible) ?? false) || record.requested;
        else if (pane?.epochs.has(key) && !pane.epochs.allowed(key)) record.eligible = false;
        if (!record.eligible && !record.snapshot && automaticRef.current)
          notify(record, { key, status: "stopped", expanded: false, expiresAtMs: null });
        if (!visible && actual && !record.snapshot?.expanded && slots.current.has(key))
          cancel(record, false);
        if (!near && record.prepared) {
          discard(record, record.prepared);
          record.prepared = null;
          record.serial += 1;
        }
        schedule();
      },
      run: (binding) => {
        const record = records.current.get(binding.poolKey ?? legacyBindingKey(binding));
        if (!record || !record.binding || slots.current.has(record.key)) return;
        if (
          record.binding.anchorId !== binding.anchorId ||
          record.binding.anchor !== binding.anchor
        )
          return;
        // Preserve the actual deliberate Run/Restart opener for exact focus
        // restoration; registration's inert anchor is not that gesture target.
        record.binding = binding;
        const epochs = panes.current.get(record.pane)?.epochs;
        if (!record.eligible) epochs?.restart(record.key);
        record.eligible = true;
        record.authorityAttempted = true;
        record.requested = true;
        record.near = true;
        record.visible = true;
        record.sequence = ++sequence.current;
        schedule();
      },
      stop: (key) => {
        const record = records.current.get(key);
        if (record) cancel(record, true);
      },
      expand: (key, expanded) => controllers.current.get(key)?.expand(key, expanded),
      focus: (key) => controllers.current.get(key)?.focus(key),
      detach: (key) => controllers.current.get(key)?.detach(key),
      scope: (pane, environmentId, threadId, admitted, priority) => {
        let value = panes.current.get(pane);
        if (!value) {
          if (panes.current.size >= MAX_PANES) return;
          value = { admitted, priority, epochs: createVisualizationViewportEpochs() };
          panes.current.set(pane, value);
        }
        if (
          value.environmentId !== undefined &&
          (value.environmentId !== environmentId || value.threadId !== threadId)
        ) {
          for (const record of records.current.values())
            if (record.pane === pane) cancel(record, true);
          value.epochs.clear();
        }
        Object.assign(value, { environmentId, threadId, admitted, priority });
        if (!admitted)
          for (const record of records.current.values())
            if (record.pane === pane) cancel(record, true);
        schedule();
      },
      closePane: (pane) => {
        for (const record of records.current.values())
          if (record.pane === pane) cancel(record, true);
        panes.current.delete(pane);
      },
      capture: (key, signal) =>
        controllers.current.get(key)?.capture(key, signal) ??
        Promise.reject(new Error("capture-unavailable")),
    }),
    [defaultPane, cancel, discard, notify, schedule, restorePresentations],
  );
  return (
    <ViewerContext value={context}>
      <AutomaticContext value={automatic}>{children}</AutomaticContext>
      {slotKeys.map((key) => (
        <VisualizationViewerSlot
          key={key}
          slotKey={key}
          onController={onController}
          onSnapshot={onSnapshot}
          beforeOverlay={beforeOverlay}
          afterOverlay={afterOverlay}
          readCapabilities={readCapabilities}
          knownSiblingLease={knownSiblingLease}
        />
      ))}
    </ViewerContext>
  );
}

/** A pane survives row recycling and is independent of the selected/focused pane. */
export function useVisualizationScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  admitted: boolean,
  priority = true,
) {
  const viewer = useVisualizationViewer();
  const pane = useRef(createVisualizationPane()).current;
  useLayoutEffect(() => {
    viewer?.scope(pane, environmentId, threadId, admitted, priority);
  }, [viewer, pane, environmentId, threadId, admitted, priority]);
  const close = viewer?.closePane;
  useEffect(() => () => close?.(pane), [close, pane]);
  return pane;
}
