import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChartNoAxesCombinedIcon,
  EllipsisIcon,
  PlayIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import type { EnvironmentId, RuntimeMode, ThreadId } from "@cafecode/contracts";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import {
  VisualizationDetailsResult,
  VisualizationExportHtmlResult,
  VisualizationInlineResult,
  VisualizationInlineFrameResult,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { copyPngToClipboard, savePngToDisk } from "../../lib/imageExport";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
} from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { downloadPortableVisualization } from "./visualizationDownload";
import { observeVisualizationOwner } from "./visualizationOwner";
import {
  useVisualizationReservation,
  useVisualizationViewer,
  type VisualizationPane,
} from "./VisualizationViewerProvider";
import { VisualizationPrivateText } from "./VisualizationPrivateText";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
import { visualizationClippingAncestors, visualizationGeometry } from "./visualizationGeometry";
import { visualizationPresentation } from "./visualizationPresentation";
import {
  createInlineVisualizationDocument,
  inlineVisualizationColors,
  measureInlineVisualization,
} from "./inlineVisualizationDocument";
import { captureInlineVisualization } from "./visualizationInlineCapture";
import { InlineMcpAppBridge } from "./InlineMcpAppBridge";

const decodeDetails = Schema.decodeUnknownSync(VisualizationDetailsResult);
const decodeHtml = Schema.decodeUnknownSync(VisualizationExportHtmlResult);
const decodeInline = Schema.decodeUnknownSync(VisualizationInlineResult);
const decodeTouch = Schema.decodeUnknownSync(VisualizationInlineFrameResult);

/**
 * A Full-access visualization executes in an ordinary same-origin iframe.
 * There is deliberately no Electron viewer or sandbox claim. Source is never
 * injected into Cafe's parent DOM, but this unsandboxed document CAN use its
 * parent's authority; authoritative backend permission is therefore mandatory.
 * Offscreen ownership releases the actual frame, not a saved preview bitmap.
 */
export const VisualizationCard = memo(function VisualizationCard({
  environmentId,
  threadId,
  entry,
  timestampFormat,
  pane,
  onScrollIntent,
  onLayoutIntent,
  generatedAdmissionReady = true,
  runtimeMode = null,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry: VisualizationTimelineEntry;
  timestampFormat: TimestampFormat;
  pane?: VisualizationPane;
  onScrollIntent?: (deltaY: number) => boolean | void;
  onLayoutIntent?: (anchor: HTMLElement, height: number) => (() => void) | undefined;
  generatedAdmissionReady?: boolean;
  /** Received exact-thread policy only. A composer draft/default is not authority. */
  runtimeMode?: RuntimeMode | null;
}) {
  const uiLocale = useUiLocale(),
    viewer = useVisualizationViewer(),
    reference = entry.reference;
  const anchorId = useId();
  const key = JSON.stringify([
    environmentId,
    threadId,
    visualizationEntryIdentity(entry),
    anchorId,
  ]);
  const anchor = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState({
    key,
    value: Math.max(80, Math.min(2000, reference.height)),
    constrained: false,
  });
  const [installed, setInstalled] = useState<{
    key: string;
    payload: VisualizationInlineResult;
    html: string;
  } | null>(null);
  const [loaded, setLoaded] = useState<Document | null>(null);
  const [appReady, setAppReady] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState<string | null>(null);
  const [details, setDetails] = useState<{ key: string; value: VisualizationDetailsResult } | null>(
    null,
  );
  const [detailFailure, setDetailFailure] = useState(false);
  const [htmlConsent, setHtmlConsent] = useState<string | null>(null);
  const [exportOutcome, setExportOutcome] = useState<
    "copied" | "saved" | "downloaded" | "failed" | null
  >(null);
  const committed = useRef({
    key,
    fullAccess: runtimeMode === "full-access",
    wanted: false,
    uiLocale,
  });
  const readEpoch = useRef(0),
    privateEpoch = useRef(0);
  const exportAbort = useRef<AbortController | null>(null);
  const downloadRelease = useRef<(() => void) | null>(null);
  const privateOwned = useRef<() => boolean>(() => false);
  const sourceOwned = useRef<() => boolean>(() => false);
  const scrollIntent = useRef(onScrollIntent),
    layoutIntent = useRef(onLayoutIntent);
  const currentPermission = runtimeMode === "full-access";
  const wanted =
    currentPermission && generatedAdmissionReady && visible && paused !== key && failed !== key;
  const granted = useVisualizationReservation(key, pane, wanted);
  const running = wanted && granted && installed?.key === key;
  // A reservation, source reply and iframe insertion are distinct readiness
  // stages. In particular, installing srcdoc does not mean its actual document
  // has loaded. Keep the indicator through that last browser-owned transition,
  // and include the finite FIFO wait without granting another frame or read.
  const pending =
    wanted &&
    viewer !== null &&
    (!granted || !running || !loaded || loaded !== frame?.contentDocument);
  const loading = useDelayedFlag(pending);
  const inlineHeight =
    height.key === key ? height.value : Math.max(80, Math.min(2000, reference.height));

  useLayoutEffect(() => {
    committed.current = {
      key,
      fullAccess: currentPermission,
      wanted: wanted && granted,
      uiLocale,
    };
    scrollIntent.current = onScrollIntent;
    layoutIntent.current = onLayoutIntent;
  }, [key, currentPermission, wanted, granted, uiLocale, onScrollIntent, onLayoutIntent]);
  const bindFrame = useCallback(
    (element: HTMLIFrameElement | null) => {
      frameRef.current = element;
      viewer?.frameMounted(key, element !== null);
      setFrame(element);
    },
    [viewer, key],
  );
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    let scheduled: number | null = null;
    const sample = () => {
      // Ordinary DOM modals can paint above an iframe without tearing down its
      // document. Inertness is not an offscreen transition: private inspectors
      // and an App's own consent must not reset the still-visible chart.
      const actuallyVisible =
        document.visibilityState === "visible" && visualizationGeometry(element, true) !== null;
      // Threshold-zero IO may report intersecting at a touching edge or for a
      // subpixel crop that our finite geometry correctly refuses. Its bucket
      // need not change when scrolling inward. Fresh clipped geometry, never
      // a cached IO flag, therefore owns admission and offscreen retirement.
      setVisible(actuallyVisible);
    };
    const schedule = () => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = null;
        sample();
      });
    };
    const scroll = (event: Event) => {
      // Capture observes only the parent document's owning scroll chain. An
      // unrelated scroller or a child iframe cannot trigger extra geometry
      // walks; rapid owning scroll/resize events share one pending RAF.
      const target = event.target;
      if (
        target === document ||
        target === window ||
        (target instanceof HTMLElement && target.contains(element))
      )
        schedule();
    };
    const intersection = new IntersectionObserver(
      (entries) => {
        // Geometry refusal can also mean unsupported bounds, not scroll-out.
        // Only a real nonintersecting IO observation under visible valid styles
        // clears terminal Stop/error intent for a later new viewport admission.
        if (
          entries.some((entry) => entry.target === element && !entry.isIntersecting) &&
          document.visibilityState === "visible" &&
          visualizationClippingAncestors(element) !== null
        ) {
          setPaused(null);
          setFailed(null);
        }
        sample();
      },
      { threshold: 0 },
    );
    intersection.observe(element);
    const visibility = new MutationObserver(sample);
    const resize = new ResizeObserver(schedule);
    let ancestor: HTMLElement | null = element;
    for (let count = 0; ancestor && count < 128; count += 1) {
      visibility.observe(ancestor, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden", "hidden", "class", "style"],
      });
      // The existing finite owner chain also supplies resize wakeups: a
      // clipping parent may grow without changing this anchor's own size.
      resize.observe(ancestor);
      ancestor = ancestor.parentElement;
    }
    sample();
    document.addEventListener("visibilitychange", sample);
    window.addEventListener("resize", sample);
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      intersection.disconnect();
      visibility.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", sample);
      window.removeEventListener("resize", sample);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [key]);

  useEffect(() => {
    const token = ++readEpoch.current;
    setInstalled(null);
    setLoaded(null);
    setAppReady(null);
    sourceOwned.current = () => false;
    if (!wanted || !granted || !viewer) return;
    const abort = new AbortController();
    let disposed = false,
      payload: VisualizationInlineResult | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owner = observeVisualizationOwner(environmentId, () => {
      abort.abort();
      exportAbort.current?.abort();
      sourceOwned.current = () => false;
      setInstalled(null);
      setLoaded(null);
      setFailed(key);
    });
    const current = () =>
      !disposed &&
      !abort.signal.aborted &&
      token === readEpoch.current &&
      committed.current.key === key &&
      committed.current.fullAccess &&
      committed.current.wanted &&
      owner.current();
    sourceOwned.current = current;
    const tuple = { threadId, artifactId: reference.artifactId, revisionId: reference.revisionId };
    const retire = (value: VisualizationInlineResult) => {
      void owner.api?.visualizations
        ?.retireInlineFrame?.({ ...tuple, frameId: value.frameId, ticket: value.ticket })
        .catch(() => undefined);
    };
    const touch = async () => {
      if (!current() || !payload) return;
      try {
        const value = decodeTouch(
          await owner.api!.visualizations!.touchInlineFrame!({
            ...tuple,
            frameId: payload.frameId,
            ticket: payload.ticket,
          }),
        );
        if (!current()) return;
        if (
          value.threadId !== threadId ||
          value.artifactId !== reference.artifactId ||
          value.revisionId !== reference.revisionId ||
          value.frameId !== payload.frameId ||
          value.expiresAtMs <= Date.now()
        )
          throw new Error("visualization-grant-invalid");
        timer = setTimeout(() => void touch(), 10_000);
      } catch {
        if (!current()) return;
        setFailed(key);
        setInstalled(null);
      }
    };
    void viewer
      .read(async () => {
        if (
          !current() ||
          !owner.api?.visualizations?.inline ||
          !owner.api.visualizations.touchInlineFrame ||
          !owner.api.visualizations.retireInlineFrame
        )
          throw new Error("visualization-unavailable");
        return decodeInline(await owner.api.visualizations.inline(tuple));
      }, abort.signal)
      .then((value) => {
        // Received purpose/fullAccess and exact tuple are checked before source
        // becomes iframe srcdoc. A late reply's backend action grant is retired,
        // never installed under a newer permission, owner or recycled anchor.
        if (
          value.threadId !== threadId ||
          value.artifactId !== reference.artifactId ||
          value.revisionId !== reference.revisionId ||
          value.purpose !== reference.purpose ||
          value.fullAccess !== true ||
          value.expiresAtMs <= Date.now()
        ) {
          retire(value);
          throw new Error("visualization-inline-invalid");
        }
        if (!current()) {
          retire(value);
          return;
        }
        payload = value;
        const html = createInlineVisualizationDocument(
          value.html,
          // Source may settle after an interface-language change. Read only
          // the latest committed presentation instead of the request's stale
          // closure; changing language never restarts the exact owned read.
          visualizationPresentation(committed.current.uiLocale),
          document.documentElement.classList.contains("dark"),
          value.frameId,
          reference.purpose === "generated-visualization",
        );
        if (!current()) {
          retire(value);
          payload = null;
          return;
        }
        setInstalled({ key, payload: value, html });
        timer = setTimeout(() => void touch(), 10_000);
      })
      .catch(() => {
        if (current()) {
          setFailed(key);
          setInstalled(null);
        }
      });
    return () => {
      disposed = true;
      abort.abort();
      sourceOwned.current = () => false;
      if (timer) clearTimeout(timer);
      if (payload) retire(payload);
      owner.dispose();
    };
    // Presentation and callback changes never replace an admitted document.
    // Their current values are applied through the exact loaded frame below.
  }, [
    environmentId,
    threadId,
    key,
    reference.artifactId,
    reference.revisionId,
    reference.purpose,
    wanted,
    granted,
    viewer,
    attempt,
  ]);

  const frameCurrent = useCallback(
    () =>
      Boolean(
        running &&
        sourceOwned.current() &&
        frameRef.current?.isConnected &&
        frameRef.current === frame,
      ),
    [running, frame],
  );
  useLayoutEffect(() => {
    if (!frame || !loaded || !running || frame.contentDocument !== loaded) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let layoutCancel: (() => void) | undefined;
    const measure = () => {
      timer = undefined;
      if (
        disposed ||
        !sourceOwned.current() ||
        frameRef.current !== frame ||
        frame.contentDocument !== loaded
      )
        return;
      const layout = measureInlineVisualization(loaded);
      if (!layout) return;
      const element = anchor.current;
      if (element && element.getBoundingClientRect().height !== layout.height) {
        layoutCancel?.();
        layoutCancel = layoutIntent.current?.(element, layout.height);
      }
      setHeight((old) =>
        old.key === key && old.value === layout.height && old.constrained === layout.constrained
          ? old
          : { key, value: layout.height, constrained: layout.constrained },
      );
    };
    const schedule = () => {
      if (!disposed && !timer) timer = setTimeout(measure, 250);
    };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);
    resize.observe(loaded.body);
    mutation.observe(loaded.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "open", "width", "height"],
    });
    const wheel = (event: WheelEvent) => {
      if (
        !event.isTrusted ||
        !sourceOwned.current() ||
        event.deltaMode !== 0 ||
        !Number.isFinite(event.deltaY) ||
        Math.abs(event.deltaY) > 10_000
      )
        return;
      // Prevent the browser's chain only when this exact owning timeline really
      // applied the delta. Otherwise ordinary browser scrolling remains native.
      if (scrollIntent.current?.(event.deltaY) === true) event.preventDefault();
    };
    loaded.addEventListener("wheel", wheel, { passive: false });
    void loaded.fonts.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      resize.disconnect();
      mutation.disconnect();
      loaded.removeEventListener("wheel", wheel);
      layoutCancel?.();
    };
  }, [frame, loaded, running, key]);
  useEffect(() => {
    if (!loaded || !running) return;
    const update = () => {
      if (!sourceOwned.current() || frameRef.current?.contentDocument !== loaded) return;
      const presentation = visualizationPresentation(uiLocale),
        root = loaded.documentElement;
      root.classList.toggle("dark", document.documentElement.classList.contains("dark"));
      root.style.colorScheme = document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
      root.lang = uiLocale;
      root.dataset.cafeReducedMotion = String(presentation.reducedMotion);
      root.style.setProperty("--cafe-interface-scale", String(presentation.scale));
      for (const [name, value] of inlineVisualizationColors(presentation))
        root.style.setProperty(name, value);
      loaded.defaultView?.dispatchEvent(new Event("cafe-presentation-changed"));
    };
    const theme = new MutationObserver(update);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", update);
    update();
    return () => {
      theme.disconnect();
      motion.removeEventListener("change", update);
    };
  }, [loaded, running, uiLocale]);
  useEffect(() => {
    const changed = () => setExpanded(document.fullscreenElement === anchor.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const changeDisplayMode = useCallback(async (mode: "inline" | "fullscreen") => {
    try {
      if (!sourceOwned.current() || !anchor.current) return false;
      if (mode === "fullscreen") await anchor.current.requestFullscreen();
      else if (document.fullscreenElement === anchor.current) await document.exitFullscreen();
      return mode === "fullscreen"
        ? document.fullscreenElement === anchor.current
        : document.fullscreenElement !== anchor.current;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const token = ++privateEpoch.current;
    privateOwned.current = () => false;
    setDetails(null);
    setDetailFailure(false);
    if (inspection !== key) return;
    let disposed = false;
    const owner = observeVisualizationOwner(environmentId, () => {
      privateOwned.current = () => false;
      setDetails(null);
      setDetailFailure(true);
    });
    const current = () =>
      !disposed &&
      token === privateEpoch.current &&
      committed.current.key === key &&
      owner.current();
    privateOwned.current = current;
    if (!owner.current() || !owner.api?.visualizations) setDetailFailure(true);
    else
      void owner.api.visualizations
        .details({ threadId, artifactId: reference.artifactId, revisionId: reference.revisionId })
        .then((raw) => {
          if (!current()) return;
          const value = decodeDetails(raw);
          if (
            value.threadId !== threadId ||
            value.artifactId !== reference.artifactId ||
            value.revisionId !== reference.revisionId ||
            value.source.artifactId !== reference.artifactId ||
            value.source.revisionId !== reference.revisionId ||
            value.source.purpose !== reference.purpose ||
            value.diagnostics.artifactId !== reference.artifactId ||
            value.diagnostics.revisionId !== reference.revisionId ||
            new TextEncoder().encode(JSON.stringify(value)).byteLength > 4 * 1024 * 1024
          )
            throw new Error("visualization-details-invalid");
          setDetails({ key, value });
        })
        .catch(() => {
          if (current()) setDetailFailure(true);
        });
    return () => {
      disposed = true;
      privateEpoch.current += 1;
      privateOwned.current = () => false;
      owner.dispose();
    };
  }, [
    environmentId,
    threadId,
    key,
    reference.artifactId,
    reference.revisionId,
    reference.purpose,
    inspection,
    detailAttempt,
  ]);
  useEffect(
    () => () => {
      exportAbort.current?.abort();
      downloadRelease.current?.();
    },
    [key],
  );
  useLayoutEffect(() => {
    if (!running) exportAbort.current?.abort();
  }, [running]);
  const copy = async (value: string) => {
    if (!privateOwned.current()) return;
    try {
      await copyTextToClipboard(value);
      if (privateOwned.current()) setExportOutcome("copied");
    } catch {
      if (privateOwned.current()) setExportOutcome("failed");
    }
  };
  const exportPng = (action: "copy" | "save") => {
    const target = frameRef.current;
    if (!target || !frameCurrent() || exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    const png = captureInlineVisualization(
      target,
      abort.signal,
      () => frameCurrent() && frameRef.current?.contentDocument === loaded,
    );
    void (
      action === "copy"
        ? copyPngToClipboard(png, abort.signal)
        : savePngToDisk(png, "visualization.png", abort.signal)
    )
      .then((result) => {
        if (!abort.signal.aborted && committed.current.key === key && result !== "cancelled")
          setExportOutcome(action === "copy" ? "copied" : "saved");
      })
      .catch(() => {
        if (!abort.signal.aborted && committed.current.key === key) setExportOutcome("failed");
      })
      .finally(() => {
        if (exportAbort.current === abort) exportAbort.current = null;
      });
  };
  const exportHtml = () => {
    if (
      htmlConsent !== key ||
      reference.purpose !== "generated-visualization" ||
      exportAbort.current
    )
      return;
    setHtmlConsent(null);
    const abort = new AbortController(),
      owner = observeVisualizationOwner(environmentId, () => {
        abort.abort();
        downloadRelease.current?.();
      });
    exportAbort.current = abort;
    const current = () => !abort.signal.aborted && committed.current.key === key && owner.current();
    if (!current() || !owner.api?.visualizations?.exportHtml) {
      owner.dispose();
      exportAbort.current = null;
      setExportOutcome("failed");
      return;
    }
    void owner.api.visualizations
      .exportHtml({ threadId, artifactId: reference.artifactId, revisionId: reference.revisionId })
      .then((raw) => {
        if (!current()) return;
        const result = decodeHtml(raw);
        if (
          result.threadId !== threadId ||
          result.artifactId !== reference.artifactId ||
          result.revisionId !== reference.revisionId
        )
          throw new Error("visualization-export-invalid");
        downloadRelease.current = downloadPortableVisualization(result.html);
        setExportOutcome("downloaded");
      })
      .catch(() => {
        if (current()) setExportOutcome("failed");
      })
      .finally(() => {
        owner.dispose();
        if (exportAbort.current === abort) exportAbort.current = null;
      });
  };
  return (
    <section
      className="group/visualization my-3 w-full min-w-0"
      data-visualization-card={reference.artifactId}
    >
      <div
        ref={anchor}
        data-visualization-inline-surface="inline"
        data-visualization-inline-frame="true"
        className="relative w-full min-w-0 overflow-hidden bg-transparent [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:overflow-auto [&:fullscreen]:bg-background"
        style={{ minHeight: 80, height: expanded ? undefined : inlineHeight }}
      >
        {running ? (
          <iframe
            ref={bindFrame}
            title={reference.title}
            srcDoc={
              reference.purpose === "mcp-app" && appReady !== installed.payload.frameId
                ? undefined
                : installed.html
            }
            className="block w-full border-0 bg-transparent"
            style={{ height: inlineHeight }}
            allow="fullscreen"
            referrerPolicy="no-referrer"
            onLoad={(event) => {
              const target = event.currentTarget,
                document = target.contentDocument;
              if (reference.purpose === "mcp-app" && appReady !== installed.payload.frameId) return;
              if (
                !sourceOwned.current() ||
                target !== frameRef.current ||
                !document ||
                document.documentElement.dataset.cafeInlineFrame !== installed.payload.frameId
              ) {
                setFailed(key);
                setInstalled(null);
                return;
              }
              setLoaded(document);
            }}
          />
        ) : (
          <div
            role={visible ? "status" : undefined}
            className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground"
          >
            {!currentPermission
              ? uiText("Visualizations require Full access.", undefined, undefined, uiLocale)
              : failed === key
                ? uiText("Visualization unavailable.", undefined, undefined, uiLocale)
                : paused === key
                  ? uiText(
                      "Viewer stopped. Run again to start a new document.",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : null}
          </div>
        )}
        {pending && loading ? (
          <div
            role="status"
            data-visualization-loading="true"
            className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 text-xs text-muted-foreground"
          >
            <SparklesIcon
              aria-hidden
              className="size-3.5 shrink-0 animate-pulse text-status-running motion-reduce:animate-none"
            />
            <span>{uiText("Loading visualization…", undefined, undefined, uiLocale)}</span>
          </div>
        ) : null}
        {expanded ? (
          <Button
            className="absolute right-2 top-2"
            size="sm"
            variant="outline"
            onClick={() => void changeDisplayMode("inline")}
          >
            {uiText("Back to chat", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
      </div>
      {running && frame && reference.purpose === "mcp-app" ? (
        <InlineMcpAppBridge
          environmentId={environmentId}
          threadId={threadId}
          reference={reference}
          payload={installed.payload}
          frame={frame}
          current={frameCurrent}
          onDisplayMode={changeDisplayMode}
          onClose={() => setPaused(key)}
          onReady={() => setAppReady(installed.payload.frameId)}
        />
      ) : null}
      <div className="flex h-6 min-w-0 justify-end" data-visualization-controls="quiet">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground transition-opacity duration-(--duration-fast) [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/visualization:opacity-100 [@media(hover:hover)]:group-focus-within/visualization:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100"
                      aria-label={uiText("Visualization actions", undefined, undefined, uiLocale)}
                      data-visualization-run="true"
                    />
                  }
                />
              }
            >
              <EllipsisIcon className="size-4" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              {uiText("Visualization actions", undefined, undefined, uiLocale)}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup
            align="end"
            className="max-w-[min(28rem,calc(100vw-2rem))] motion-reduce:transition-none motion-reduce:duration-0"
            data-visualization-menu="true"
          >
            <MenuGroup>
              <MenuGroupLabel className="space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  {entry.actor.type === "child" ? (
                    <SubagentAvatar
                      seed={entry.actor.id}
                      label={
                        entry.actor.label ?? uiText("Subagent", undefined, undefined, uiLocale)
                      }
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <ChartNoAxesCombinedIcon className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{reference.title}</span>
                </div>
                <div className="font-normal [overflow-wrap:anywhere]">
                  {entry.actor.type === "root"
                    ? uiText("Root", undefined, undefined, uiLocale)
                    : (entry.actor.label ??
                      uiText("Subagent", undefined, undefined, uiLocale))}{" "}
                  ·{" "}
                  <time dateTime={entry.occurredAt}>
                    {formatDiagnosticTimestamp(entry.occurredAt, timestampFormat, uiLocale)}
                  </time>
                </div>
                {height.constrained ? (
                  <div role="status" className="font-normal">
                    {uiText(
                      "Inline content limit reached. Expand to inspect.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </div>
                ) : null}
              </MenuGroupLabel>
              <MenuSeparator />
              {running ? (
                <>
                  <MenuItem onClick={() => setPaused(key)}>
                    <SquareIcon />
                    {uiText("Stop", undefined, undefined, uiLocale)}
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      void changeDisplayMode("fullscreen").then((accepted) => {
                        if (!accepted) setExportOutcome("failed");
                      })
                    }
                  >
                    {uiText("Expand", undefined, undefined, uiLocale)}
                  </MenuItem>
                </>
              ) : (
                <MenuItem
                  disabled={!currentPermission || !generatedAdmissionReady}
                  onClick={() => {
                    setPaused(null);
                    setFailed(null);
                    setAttempt((value) => value + 1);
                  }}
                >
                  <PlayIcon />
                  {uiText("Restart", undefined, undefined, uiLocale)}
                </MenuItem>
              )}
              <MenuItem disabled={!running || !loaded} onClick={() => exportPng("copy")}>
                {uiText("Copy current PNG", undefined, undefined, uiLocale)}
              </MenuItem>
              <MenuItem disabled={!running || !loaded} onClick={() => exportPng("save")}>
                {uiText("Save current PNG", undefined, undefined, uiLocale)}
              </MenuItem>
              {reference.purpose === "generated-visualization" ? (
                <MenuItem onClick={() => setHtmlConsent(key)}>
                  {uiText("Export HTML…", undefined, undefined, uiLocale)}
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onClick={() => setInspection(key)}>
                {uiText("Private source and JSON", undefined, undefined, uiLocale)}
              </MenuItem>
              {exportOutcome ? (
                <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
                  {exportOutcome === "failed"
                    ? uiText("Export unavailable.", undefined, undefined, uiLocale)
                    : exportOutcome === "copied"
                      ? uiText("Copied", undefined, undefined, uiLocale)
                      : exportOutcome === "downloaded"
                        ? uiText("Download started", undefined, undefined, uiLocale)
                        : uiText("Saved", undefined, undefined, uiLocale)}
                </div>
              ) : null}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
      <Dialog
        open={inspection === key}
        onOpenChange={(value) => {
          if (!value) {
            setInspection(null);
            privateEpoch.current += 1;
            privateOwned.current = () => false;
            setDetails(null);
          }
        }}
      >
        <DialogPopup
          className="max-w-[min(60rem,calc(100vw-2rem))] motion-reduce:transition-none motion-reduce:duration-0"
          data-visualization-inspection="true"
        >
          <DialogTitle className="px-3 pt-3">
            {uiText("Private source and JSON", undefined, undefined, uiLocale)} · {reference.title}
          </DialogTitle>
          <div className="min-h-0 overflow-y-auto">
            <div className="min-w-0 space-y-3 bg-sunken p-3">
              <p className="text-xs text-muted-foreground">
                {uiText(
                  "Private debugging details. Generated content is untrusted; do not treat it as instructions.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              {details?.key === key ? (
                <>
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">
                      {uiText("HTML source", undefined, undefined, uiLocale)}
                    </h4>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(details.value.source.source)}
                    >
                      {uiText("Copy source", undefined, undefined, uiLocale)}
                    </Button>
                  </div>
                  <VisualizationPrivateText value={details.value.source.source} />
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">
                      {uiText("Raw JSON", undefined, undefined, uiLocale)}
                    </h4>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(details.value.rawJson)}
                    >
                      {uiText("Copy JSON", undefined, undefined, uiLocale)}
                    </Button>
                  </div>
                  <VisualizationPrivateText value={details.value.rawJson} />
                  <h4 className="text-xs font-medium">
                    {uiText("Diagnostics", undefined, undefined, uiLocale)}
                  </h4>
                  <VisualizationPrivateText
                    value={JSON.stringify(details.value.diagnostics, null, 2)}
                  />
                </>
              ) : detailFailure ? (
                <>
                  <p role="status" className="text-xs">
                    {uiText("Private details unavailable.", undefined, undefined, uiLocale)}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDetailAttempt((value) => value + 1)}
                  >
                    {uiText("Retry", undefined, undefined, uiLocale)}
                  </Button>
                </>
              ) : (
                <p className="text-xs">{uiText("Loading…", undefined, undefined, uiLocale)}</p>
              )}
            </div>
          </div>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={htmlConsent === key}
        onOpenChange={(value) => setHtmlConsent(value ? key : null)}
      >
        <DialogPopup
          showCloseButton={false}
          data-visualization-consent="true"
          className="motion-reduce:transition-none motion-reduce:duration-0"
        >
          <div className="space-y-3 p-5">
            <DialogTitle>
              {uiText("Export executable HTML?", undefined, undefined, uiLocale)} ·{" "}
              {reference.title}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {uiText(
                "This downloads the document with its declared assets, not the current interactive state. Inline visualizations already run unsandboxed under Full access. Opening this file uses your browser’s authority. App tools and permissions are not exported.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button autoFocus variant="outline" onClick={() => setHtmlConsent(null)}>
                {uiText("Cancel", undefined, undefined, uiLocale)}
              </Button>
              <Button onClick={exportHtml}>
                {uiText("Download HTML", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
});
