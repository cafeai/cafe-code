/** Small native-owner scalars only. No source, JSON, identity, URL or path field exists. */
export interface VisualizationSurfaceDiagnostics {
  readonly phase:
    | "uncreated"
    | "bootstrap"
    | "admitted"
    | "active"
    | "retiring"
    | "retired"
    | "quarantined";
  readonly rejection:
    | "none"
    | "native-policy"
    | "renderer-separation"
    | "child-frame"
    | "heartbeat-frame"
    | "heartbeat-sequence"
    | "owner-window"
    | "owner-navigation"
    | "renderer-exit"
    | "resource-request"
    | "page-navigation"
    | "heartbeat-missed";
  readonly exclusiveProcess: boolean;
  readonly frameCount: number;
  readonly rendererCount: number;
  readonly gone: boolean;
  readonly destroyed: boolean;
  readonly watchdogArmed: boolean;
  readonly heartbeatMissed: boolean;
  readonly assetBytes: number;
  readonly requestCount: number;
  readonly servedBytes: number;
  readonly captureOutcome:
    | "not-attempted"
    | "native-error"
    | "empty"
    | "oversize"
    | "encoding-error"
    | "ready";
  readonly captureWidth: number;
  readonly captureHeight: number;
  /** Fixed geometry scalars only; positions, page content and native objects stay private. */
  readonly geometryOutcome: "uncommitted" | "full" | "partial" | "refused";
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly clipWidth: number;
  readonly clipHeight: number;
  readonly ownerZoom: number;
  readonly nativeVisibility: "hidden" | "visible" | "unknown";
  readonly visibilityHintSent: "hidden" | "visible" | "not-sent";
  readonly visibilityCommitted: boolean;
  readonly layoutHeight: number;
  readonly layoutConstrained: boolean;
  readonly layoutSequence: number;
  readonly layoutPublications: number;
  readonly layoutRefusals: number;
  readonly layoutRefusal:
    | "none"
    | "owner"
    | "frame"
    | "invalid"
    | "rate"
    | "geometry"
    | "visibility";
}
export interface VisualizationHostDiagnostics {
  readonly available: boolean;
  readonly status: "ready" | "unavailable" | "quarantined";
  readonly activeCount: number;
  readonly pendingViewerCount: number;
  readonly pendingPreviewCount: number;
  readonly retainedInputBytes: number;
  readonly retirementCount: number;
  readonly lastRetirementReason:
    | "none"
    | "busy"
    | "invalid"
    | "expired"
    | "unavailable"
    | "timeout"
    | "resource-denied"
    | "capture-failed"
    | "retirement-uncertain"
    | "owner-revoked";
  readonly native: VisualizationSurfaceDiagnostics | null;
  readonly viewerCount: number;
  readonly previewCount: number;
  readonly nativeWorkCount: number;
  readonly continuationCount: number;
}

let reader: (() => VisualizationHostDiagnostics) | null = null;
/** Registration is scoped to the actual main-owned host, never a renderer/RPC publication. */
export function registerVisualizationDiagnostics(
  next: () => VisualizationHostDiagnostics,
): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}
/** Evaluated only on existing debug requests; no new sampler, history or timer. */
export function readVisualizationDiagnostics(): VisualizationHostDiagnostics | null {
  try {
    const value = reader?.();
    if (!value) return null;
    const native = value.native;
    // Explicit projection prevents a future producer's extra private fields
    // from silently appearing in either compact or full debug responses.
    return {
      available: value.available,
      status: value.status,
      activeCount: value.activeCount,
      pendingViewerCount: value.pendingViewerCount,
      pendingPreviewCount: value.pendingPreviewCount,
      retainedInputBytes: value.retainedInputBytes,
      retirementCount: value.retirementCount,
      lastRetirementReason: value.lastRetirementReason,
      native: native
        ? {
            phase: native.phase,
            rejection: native.rejection,
            exclusiveProcess: native.exclusiveProcess,
            frameCount: native.frameCount,
            rendererCount: native.rendererCount,
            gone: native.gone,
            destroyed: native.destroyed,
            watchdogArmed: native.watchdogArmed,
            heartbeatMissed: native.heartbeatMissed,
            assetBytes: native.assetBytes,
            requestCount: native.requestCount,
            servedBytes: native.servedBytes,
            captureOutcome: native.captureOutcome,
            captureWidth: native.captureWidth,
            captureHeight: native.captureHeight,
            geometryOutcome: native.geometryOutcome,
            viewportWidth: native.viewportWidth,
            viewportHeight: native.viewportHeight,
            clipWidth: native.clipWidth,
            clipHeight: native.clipHeight,
            ownerZoom: native.ownerZoom,
            nativeVisibility: native.nativeVisibility,
            visibilityHintSent: native.visibilityHintSent,
            visibilityCommitted: native.visibilityCommitted,
            layoutHeight: native.layoutHeight,
            layoutConstrained: native.layoutConstrained,
            layoutSequence: native.layoutSequence,
            layoutPublications: native.layoutPublications,
            layoutRefusals: native.layoutRefusals,
            layoutRefusal: native.layoutRefusal,
          }
        : null,
      viewerCount: value.viewerCount,
      previewCount: value.previewCount,
      nativeWorkCount: value.nativeWorkCount,
      continuationCount: value.continuationCount,
    };
  } catch {
    return null;
  }
}
