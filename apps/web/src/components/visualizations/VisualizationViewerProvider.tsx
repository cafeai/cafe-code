import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { createVisualizationPane, type VisualizationPane } from "./visualizationViewportEpochs";

export type { VisualizationPane } from "./visualizationViewportEpochs";
const MAX_FRAMES = 4;
const MAX_READS = 2;
const MAX_PENDING_READS = 8;
const MAX_ANCHORS = 128;
const MAX_PANES = 16;
interface Reservation {
  readonly key: string;
  readonly pane: VisualizationPane;
  wanted: boolean;
  granted: boolean;
  frameMounted: boolean;
  readonly sequence: number;
}
interface Pane {
  admitted: boolean;
  environmentId?: EnvironmentId;
  threadId?: ThreadId;
}
interface ReadRequest {
  readonly start: () => void;
  readonly reject: () => void;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}
interface ViewerContext {
  readonly defaultPane: VisualizationPane;
  subscribe: (listener: () => void) => () => void;
  granted: (key: string) => boolean;
  request: (key: string, pane: VisualizationPane, wanted: boolean) => () => void;
  read: <Value>(operation: () => Promise<Value>, signal: AbortSignal) => Promise<Value>;
  scope: (
    pane: VisualizationPane,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    admitted: boolean,
  ) => void;
  closePane: (pane: VisualizationPane) => void;
  frameMounted: (key: string, mounted: boolean) => void;
}
const ViewerContext = createContext<ViewerContext | null>(null);
const diagnosticReaders = new Set<
  () => {
    anchors: number;
    granted: number;
    frames: number;
    activeReads: number;
    waitingReads: number;
  }
>();

/** Fixed scalar counts only, never DOM, HTML, URLs, identities or action grants.
 * These describe this renderer's owned work, not total process/OS memory. */
export function readInlineVisualizationPoolDiagnostics() {
  let anchors = 0,
    granted = 0,
    frames = 0,
    activeReads = 0,
    waitingReads = 0,
    pools = 0;
  for (const read of diagnosticReaders) {
    if (++pools > 16) break;
    const value = read();
    anchors += value.anchors;
    granted += value.granted;
    frames += value.frames;
    activeReads += value.activeReads;
    waitingReads += value.waitingReads;
  }
  return Object.freeze({
    mode: "inline-browser" as const,
    fullAccessRequired: true as const,
    pools: Math.min(16, pools),
    anchors,
    grantedFrames: granted,
    runningFrames: frames,
    activeReads,
    waitingReads,
    maxFramesPerPool: MAX_FRAMES,
    maxReadsPerPool: MAX_READS,
    maxPendingReadsPerPool: MAX_PENDING_READS,
    diagnosticsConstrained: diagnosticReaders.size > 16,
  });
}

/** Ordinary same-origin browser frames are not an Electron execution host or a
 * security boundary. These finite reservations bound work only; backend Full
 * access authorization independently admits every exact source read. */
export function VisualizationViewerProvider({ children }: { children: ReactNode }) {
  const defaultPane = useRef(createVisualizationPane()).current;
  const reservations = useRef(new Map<string, Reservation>());
  const panes = useRef(new Map<VisualizationPane, Pane>([[defaultPane, { admitted: true }]]));
  const listeners = useRef(new Set<() => void>());
  const sequence = useRef(0);
  const runningReads = useRef(0);
  const pendingReads = useRef<ReadRequest[]>([]);
  const mounted = useRef(true);
  const publish = useCallback(() => {
    for (const listener of listeners.current) listener();
  }, []);
  const reconcile = useCallback(() => {
    let occupied = 0;
    // Stable visible frames never get preempted by another pane or callback.
    // Releasing one exact offscreen owner admits the oldest waiting anchor.
    for (const record of reservations.current.values()) {
      if (!record.wanted || !panes.current.get(record.pane)?.admitted) record.granted = false;
      if (record.granted) occupied += 1;
    }
    for (const record of [...reservations.current.values()].toSorted(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (occupied >= MAX_FRAMES) break;
      if (record.granted || !record.wanted || !panes.current.get(record.pane)?.admitted) continue;
      record.granted = true;
      occupied += 1;
    }
    publish();
  }, [publish]);
  const context = useMemo<ViewerContext>(
    () => ({
      defaultPane,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      granted: (key) => reservations.current.get(key)?.granted === true,
      request: (key, pane, wanted) => {
        const old = reservations.current.get(key);
        if (!old && reservations.current.size >= MAX_ANCHORS) return () => undefined;
        const record: Reservation = {
          key,
          pane,
          wanted,
          granted: old?.granted ?? false,
          frameMounted: old?.frameMounted ?? false,
          sequence: old?.sequence ?? ++sequence.current,
        };
        reservations.current.set(key, record);
        if (!panes.current.has(pane) && panes.current.size < MAX_PANES)
          panes.current.set(pane, { admitted: true });
        reconcile();
        return () => {
          // A late cleanup cannot delete a replacement with the same public key.
          if (reservations.current.get(key) !== record) return;
          reservations.current.delete(key);
          reconcile();
        };
      },
      read: <Value,>(operation: () => Promise<Value>, signal: AbortSignal) => {
        if (!mounted.current || signal.aborted)
          return Promise.reject(new Error("visualization-read-cancelled"));
        return new Promise<Value>((resolve, reject) => {
          const advance = () => {
            runningReads.current -= 1;
            while (mounted.current && pendingReads.current.length) {
              const next = pendingReads.current.shift()!;
              next.dispose();
              if (next.signal.aborted) next.reject();
              else {
                next.start();
                break;
              }
            }
          };
          const start = () => {
            runningReads.current += 1;
            // An aborted caller does not prove its RPC stopped. Retain the read
            // permit until actual settlement; Card refuses late bytes separately.
            void Promise.resolve().then(operation).then(resolve, reject).finally(advance);
          };
          if (runningReads.current < MAX_READS) {
            start();
            return;
          }
          if (pendingReads.current.length >= MAX_PENDING_READS) {
            reject(new Error("visualization-read-busy"));
            return;
          }
          const item: ReadRequest = {
            start,
            signal,
            reject: () => reject(new Error("visualization-read-cancelled")),
            dispose: () => signal.removeEventListener("abort", cancel),
          };
          const cancel = () => {
            const index = pendingReads.current.indexOf(item);
            if (index < 0) return;
            pendingReads.current.splice(index, 1);
            item.dispose();
            item.reject();
          };
          pendingReads.current.push(item);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      },
      scope: (pane, environmentId, threadId, admitted) => {
        if (!panes.current.has(pane) && panes.current.size >= MAX_PANES) return;
        const old = panes.current.get(pane);
        if (
          old?.environmentId &&
          (old.environmentId !== environmentId || old.threadId !== threadId)
        )
          for (const record of reservations.current.values())
            if (record.pane === pane) {
              record.wanted = false;
              record.granted = false;
            }
        panes.current.set(pane, { admitted, environmentId, threadId });
        reconcile();
      },
      closePane: (pane) => {
        for (const record of reservations.current.values())
          if (record.pane === pane) {
            record.wanted = false;
            record.granted = false;
          }
        panes.current.delete(pane);
        reconcile();
      },
      frameMounted: (key, present) => {
        const record = reservations.current.get(key);
        if (record) record.frameMounted = present;
      },
    }),
    [defaultPane, reconcile],
  );
  useEffect(() => {
    mounted.current = true;
    const read = () => ({
      anchors: reservations.current.size,
      granted: [...reservations.current.values()].filter((value) => value.granted).length,
      frames: [...reservations.current.values()].filter((value) => value.frameMounted).length,
      activeReads: runningReads.current,
      waitingReads: pendingReads.current.length,
    });
    diagnosticReaders.add(read);
    return () => {
      mounted.current = false;
      diagnosticReaders.delete(read);
      reservations.current.clear();
      for (const request of pendingReads.current.splice(0)) {
        request.dispose();
        request.reject();
      }
    };
  }, []);
  return <ViewerContext value={context}>{children}</ViewerContext>;
}
export function useVisualizationViewer() {
  return use(ViewerContext);
}

/** Pane ownership is local presentation, never permission to read source. */
export function useVisualizationScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  admitted: boolean,
  _priority = true,
) {
  const viewer = useVisualizationViewer();
  const pane = useRef(createVisualizationPane()).current;
  useLayoutEffect(() => {
    viewer?.scope(pane, environmentId, threadId, admitted);
  }, [viewer, pane, environmentId, threadId, admitted]);
  const close = viewer?.closePane;
  useEffect(() => () => close?.(pane), [close, pane]);
  return pane;
}
export function useVisualizationReservation(
  key: string,
  pane: VisualizationPane | undefined,
  wanted: boolean,
) {
  const viewer = useVisualizationViewer();
  const ownerPane = pane ?? viewer?.defaultPane;
  useLayoutEffect(() => {
    if (viewer && ownerPane) return viewer.request(key, ownerPane, wanted);
  }, [viewer, ownerPane, key, wanted]);
  const subscribe = useCallback(
    (listener: () => void) => viewer?.subscribe(listener) ?? (() => undefined),
    [viewer],
  );
  const read = useCallback(() => viewer?.granted(key) === true, [viewer, key]);
  return useSyncExternalStore(subscribe, read, read);
}
