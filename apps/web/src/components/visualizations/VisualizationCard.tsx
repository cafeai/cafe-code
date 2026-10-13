import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChartNoAxesCombinedIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import {
  VisualizationDetailsResult,
  VisualizationExportHtmlResult,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { copyPngToClipboard, savePngToDisk } from "../../lib/imageExport";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { acquireVisualizationPoster } from "./visualizationPoster";
import {
  useAutomaticVisualization,
  useVisualizationAvailability,
  useVisualizationSnapshot,
  useVisualizationViewer,
  visualizationBindingKey,
  type VisualizationPane,
} from "./VisualizationViewerProvider";
import { VisualizationPrivateText } from "./VisualizationPrivateText";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
import { visualizationClippingAncestors, visualizationInlineHeight } from "./visualizationGeometry";

const decodeDetails = Schema.decodeUnknownSync(VisualizationDetailsResult);
const decodeHtml = Schema.decodeUnknownSync(VisualizationExportHtmlResult);

/**
 * The row owns an inert poster/anchor. Generated execution is admitted by the
 * bounded viewport pool; external Apps still require a deliberate Run gesture.
 * Source/private JSON is absent from props, collapsed DOM, tooltips and history
 * projections. Collapse, recycling or owner-generation loss erases reader bytes.
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
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry: VisualizationTimelineEntry;
  timestampFormat: TimestampFormat;
  pane?: VisualizationPane;
  onScrollIntent?: (deltaY: number) => boolean | void;
  onLayoutIntent?: (anchor: HTMLElement, height: number) => (() => void) | undefined;
  /** A real virtualized timeline admits generated execution only after its
   * public initial-load completion. Standalone cards have no such bootstrap. */
  generatedAdmissionReady?: boolean;
}) {
  const uiLocale = useUiLocale();
  const viewer = useVisualizationViewer();
  const automatic = useAutomaticVisualization();
  const manualAllowed = useVisualizationAvailability();
  const reference = entry.reference;
  const admissionReady = reference.purpose !== "generated-visualization" || generatedAdmissionReady;
  // One immutable revision may appear in several invocations or panes. Neither
  // another card's controls nor its recycling may acquire/revoke this anchor.
  const anchorId = useId();
  const entryKey = visualizationEntryIdentity(entry);
  const ownerPane = pane ?? viewer?.defaultPane;
  const key =
    ownerPane && viewer
      ? viewer.key(ownerPane, { environmentId, threadId, reference, entryKey })
      : visualizationBindingKey({ environmentId, threadId, reference, entryKey, anchorId });
  const anchor = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [inlineHeight, setInlineHeight] = useState(700);
  const [poster, setPoster] = useState<{ key: string; url: string; blob: Blob } | null>(null);
  const [posterFailure, setPosterFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState({ key, value: false });
  const open = expanded.key === key && expanded.value;
  const [details, setDetails] = useState<{ key: string; value: VisualizationDetailsResult } | null>(
    null,
  );
  const [detailFailure, setDetailFailure] = useState(false);
  const [feedback, setExportOutcome] = useState<
    "copied" | "saved" | "downloaded" | "failed" | null
  >(null);
  const [htmlConsent, setHtmlConsent] = useState<string | null>(null);
  const htmlConsentOwned = useRef<() => boolean>(() => false);
  const downloadRelease = useRef<(() => void) | null>(null);
  const committed = useRef(key);
  const generation = useRef(0);
  const privateOwned = useRef<() => boolean>(() => false);
  const posterOwned = useRef<() => boolean>(() => false);
  const exportAbort = useRef<AbortController | null>(null);
  const active = useVisualizationSnapshot(key);
  const live = active?.status === "active" && active.visible !== false;
  const running = active?.status === "active";
  const quiet =
    reference.purpose === "generated-visualization" &&
    automatic &&
    viewer?.visibleLifetime() === true;
  const [menu, setMenu] = useState({ key, value: false });
  const menuOpen = menu.key === key && menu.value;
  const menuGeneration = useRef(0);
  const menuPresented = useRef(false);
  const [menuExiting, setMenuExiting] = useState(false);
  const [inspectionExiting, setInspectionExiting] = useState(false);
  const [consentExiting, setConsentExiting] = useState(false);
  const menuClosure = useRef<{
    key: string;
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  const scrollIntent = useRef(onScrollIntent);
  const layoutIntent = useRef(onLayoutIntent);
  useLayoutEffect(() => {
    scrollIntent.current = onScrollIntent;
    layoutIntent.current = onLayoutIntent;
  }, [onScrollIntent, onLayoutIntent]);
  // Callback replacement is presentation, not anchor ownership. A streaming
  // timeline can publish a fresh callback on every render; unregistering this
  // same card for that change would retire its viewer and latch a terminal
  // epoch. Forward only the newest committed callback through a stable handle.
  const forwardScrollIntent = useCallback((deltaY: number) => {
    return scrollIntent.current?.(deltaY);
  }, []);
  const forwardLayoutIntent = useCallback((element: HTMLElement, height: number) => {
    return layoutIntent.current?.(element, height);
  }, []);
  useEffect(() => {
    if (
      quiet &&
      !menuOpen &&
      !menuExiting &&
      !open &&
      !inspectionExiting &&
      htmlConsent !== key &&
      !consentExiting
    )
      void viewer?.presentationOverlay(key, false);
  }, [
    quiet,
    menu,
    menuOpen,
    menuExiting,
    open,
    inspectionExiting,
    htmlConsent,
    consentExiting,
    key,
    viewer,
  ]);
  useEffect(
    () => () => {
      menuGeneration.current += 1;
      menuClosure.current?.resolve();
      menuClosure.current = null;
      menuPresented.current = false;
      // Source inspectors/menu portals must never leave hidden sibling pixels
      // stranded when a recycled row or exact owner disappears mid-open.
      void viewer?.presentationOverlay(key, false);
    },
    [key, viewer],
  );
  const changeMenu = (value: boolean) => {
    const generation = ++menuGeneration.current;
    if (!value) {
      setMenu({ key, value: false });
      if (!menuPresented.current) {
        // An interrupted hide request may never have mounted a popup, so no
        // exit-completion event will arrive. Release that exact pending overlay
        // directly; its late ACK cannot reopen the cancelled menu generation.
        menuClosure.current?.resolve();
        menuClosure.current = null;
        void viewer?.presentationOverlay(key, false);
      }
      return;
    }
    menuClosure.current?.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    menuClosure.current = { key, promise, resolve };
    void viewer?.presentationOverlay(key, true).then((accepted) => {
      if (generation !== menuGeneration.current || committed.current !== key) return;
      if (accepted) {
        menuPresented.current = true;
        setMenuExiting(true);
        setMenu({ key, value: true });
      } else {
        menuClosure.current?.resolve();
        menuClosure.current = null;
        setExportOutcome("failed");
      }
    });
  };
  const afterMenuClosed = () => {
    const closure = menuClosure.current?.key === key ? menuClosure.current : null;
    return (closure?.promise ?? Promise.resolve()).then(() => {
      // A quick reopen replaces the closure identity. A queued capture/expand
      // must not restore native pixels through the newer popup or pending hide.
      if (menuPresented.current || (menuClosure.current && menuClosure.current !== closure))
        throw new Error("menu-still-presented");
    });
  };
  const closeInspection = () => {
    setExpanded({ key, value: false });
    generation.current += 1;
    setDetails(null);
    setExportOutcome(null);
    privateOwned.current = () => false;
  };

  useLayoutEffect(() => {
    committed.current = key;
    setMenuExiting(false);
    setInspectionExiting(false);
    setConsentExiting(false);
    setDetails(null);
    setExportOutcome(null);
    setPoster(null);
    return () => {
      generation.current += 1;
      privateOwned.current = () => false;
      posterOwned.current = () => false;
      exportAbort.current?.abort();
      downloadRelease.current?.();
    };
  }, [key]);
  const register = viewer?.register;
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!admissionReady || !element || !register || !ownerPane) return;
    return register({
      environmentId,
      threadId,
      reference,
      entryKey,
      anchorId,
      anchor: element,
      opener: element,
      pane: ownerPane,
      poolKey: key,
      onScrollIntent: forwardScrollIntent,
      onLayoutIntent: forwardLayoutIntent,
    });
  }, [
    register,
    key,
    environmentId,
    threadId,
    reference.artifactId,
    reference.revisionId,
    reference.purpose,
    entryKey,
    anchorId,
    ownerPane,
    forwardScrollIntent,
    forwardLayoutIntent,
    admissionReady,
  ]);
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = visualizationInlineHeight(element);
      if (height !== null) setInlineHeight(height);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Mounted, recycled cards alone observe their bounded shell ancestry. The
    // passive poster and active host use exactly the same reserved dimensions.
    const resize = new ResizeObserver(schedule);
    for (const ancestor of visualizationClippingAncestors(element) ?? []) resize.observe(ancestor);
    const visibility = new MutationObserver(schedule);
    // Observe only the bounded exact ancestry, not history descendants. This
    // restores a deferred size observation after a modal removes inertness.
    let ancestor: HTMLElement | null = element;
    for (let count = 0; ancestor && count < 128; count += 1) {
      visibility.observe(ancestor, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden", "hidden", "class", "style"],
      });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [key]);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    let near = false,
      actualVisible = false;
    // A nearby observer delivery is not an actual visibility sample. In
    // particular, its initial false value on a recycled mount must not invent
    // an offscreen epoch for a previously stopped, still-visible invocation.
    const observe = (actualSample: boolean) => {
      // Passive bitmap visibility is independent of native admission. Waiting
      // for a timeline's public load must keep its inert saved poster available
      // without registering a native binding or preparing a private ticket.
      if (!admissionReady) return;
      viewer?.observe(
        key,
        anchorId,
        near,
        actualVisible,
        actualSample &&
          document.visibilityState === "visible" &&
          !document.querySelector('[role="dialog"], [role="alertdialog"]') &&
          visualizationClippingAncestors(element) !== null,
      );
    };
    const observer = new IntersectionObserver(
      (entries) => {
        actualVisible = entries[0]?.isIntersecting ?? false;
        setVisible(actualVisible);
        observe(true);
      },
      { rootMargin: "0px" },
    );
    observer.observe(element);
    const nearby = admissionReady
      ? new IntersectionObserver(
          (entries) => {
            near = entries[0]?.isIntersecting ?? false;
            observe(false);
          },
          { root: visualizationClippingAncestors(element)?.[0] ?? null, rootMargin: "300px" },
        )
      : null;
    nearby?.observe(element);
    return () => {
      observer.disconnect();
      nearby?.disconnect();
    };
  }, [key, viewer, anchorId, admissionReady]);
  useEffect(() => {
    if (!visible || !reference.poster) {
      setPoster(null);
      return;
    }
    let disposed = false;
    let acquired: Awaited<ReturnType<typeof acquireVisualizationPoster>> | null = null;
    const abort = new AbortController();
    const owner = observeVisualizationOwner(environmentId, () => {
      abort.abort();
      acquired?.release();
      acquired = null;
      posterOwned.current = () => false;
      setPoster(null);
      setPosterFailure(true);
    });
    const current = () =>
      !disposed && !abort.signal.aborted && committed.current === key && owner.current();
    posterOwned.current = current;
    setPosterFailure(false);
    void acquireVisualizationPoster(environmentId, threadId, reference, abort.signal)
      .then((result) => {
        if (!current()) {
          result.release();
          return;
        }
        acquired = result;
        setPoster({ key, url: result.url, blob: result.blob });
      })
      .catch(() => {
        if (current()) setPosterFailure(true);
      });
    return () => {
      disposed = true;
      abort.abort();
      owner.dispose();
      acquired?.release();
      posterOwned.current = () => false;
    };
  }, [environmentId, threadId, key, reference, visible, attempt]);

  useEffect(() => {
    setDetails(null);
    setDetailFailure(false);
    setExportOutcome(null);
    privateOwned.current = () => false;
    if (!open) return;
    let disposed = false;
    const token = ++generation.current;
    const owner = observeVisualizationOwner(environmentId, () => {
      privateOwned.current = () => false;
      setDetails(null);
      setDetailFailure(true);
      exportAbort.current?.abort();
    });
    const current = () =>
      !disposed && token === generation.current && committed.current === key && owner.current();
    privateOwned.current = current;
    if (!owner.current() || !owner.api?.visualizations) setDetailFailure(true);
    else
      void owner.api.visualizations
        .details({ threadId, artifactId: reference.artifactId, revisionId: reference.revisionId })
        .then((raw) => {
          if (!current()) return;
          const result = decodeDetails(raw);
          if (
            result.threadId !== threadId ||
            result.artifactId !== reference.artifactId ||
            result.revisionId !== reference.revisionId ||
            result.source.artifactId !== reference.artifactId ||
            result.source.revisionId !== reference.revisionId ||
            result.diagnostics.artifactId !== reference.artifactId ||
            result.diagnostics.revisionId !== reference.revisionId ||
            result.source.purpose !== reference.purpose
          )
            throw new Error("details-stale");
          // Bound the complete private reader allocation, not each field separately.
          if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024)
            throw new Error("details-too-large");
          setDetails({ key, value: result });
        })
        .catch(() => {
          if (current()) setDetailFailure(true);
        });
    return () => {
      disposed = true;
      generation.current += 1;
      owner.dispose();
      privateOwned.current = () => false;
      exportAbort.current?.abort();
    };
  }, [
    environmentId,
    threadId,
    key,
    reference.artifactId,
    reference.revisionId,
    reference.purpose,
    open,
    attempt,
  ]);

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
    if (exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    setExportOutcome(null);
    const png =
      running && viewer
        ? (quiet
            ? afterMenuClosed().then(() => viewer.presentationOverlay(key, false))
            : Promise.resolve(true)
          ).then((accepted) => {
            if (!accepted || committed.current !== key) throw new Error("capture-unavailable");
            return viewer.capture(key, abort.signal);
          })
        : poster?.key === key && posterOwned.current()
          ? Promise.resolve(poster.blob)
          : Promise.reject(new Error("poster-unavailable"));
    const operation =
      action === "copy"
        ? copyPngToClipboard(png, abort.signal)
        : savePngToDisk(png, "visualization.png", abort.signal);
    void operation
      .then((result) => {
        if (!abort.signal.aborted && committed.current === key && result !== "cancelled")
          setExportOutcome(action === "copy" ? "copied" : "saved");
      })
      .catch(() => {
        if (!abort.signal.aborted && committed.current === key) setExportOutcome("failed");
      })
      .finally(() => {
        if (exportAbort.current === abort) exportAbort.current = null;
      });
  };
  const exportHtml = () => {
    if (htmlConsent !== key || !htmlConsentOwned.current()) return;
    setHtmlConsent(null);
    if (reference.purpose !== "generated-visualization" || exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    const owner = observeVisualizationOwner(environmentId, () => {
      abort.abort();
      downloadRelease.current?.();
    });
    const current = () => !abort.signal.aborted && committed.current === key && owner.current();
    if (!owner.api?.visualizations?.exportHtml || !current()) {
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
          throw new Error("export-stale");
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
  useEffect(() => {
    htmlConsentOwned.current = () => false;
    if (htmlConsent !== key) return;
    const owner = observeVisualizationOwner(environmentId, () => setHtmlConsent(null));
    htmlConsentOwned.current = () => committed.current === key && owner.current();
    return () => {
      owner.dispose();
      htmlConsentOwned.current = () => false;
    };
  }, [htmlConsent, key, environmentId]);

  const stateLabel =
    active?.status === "quarantined"
      ? uiText("Viewer unavailable until retirement is verified.", undefined, undefined, uiLocale)
      : active?.status === "unavailable"
        ? uiText(
            "Interactive viewing requires the local desktop host.",
            undefined,
            undefined,
            uiLocale,
          )
        : active?.status === "starting"
          ? uiText("Starting viewer…", undefined, undefined, uiLocale)
          : active?.status === "stopping"
            ? uiText("Stopping viewer…", undefined, undefined, uiLocale)
            : active?.status === "stopped"
              ? uiText(
                  "Viewer stopped. Run again to start a new document.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : quiet && running
                ? uiText("Interactive while visible", undefined, undefined, uiLocale)
                : live
                  ? uiText(
                      "Interactive · maximum five-minute session",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : null;
  const canRun =
    // A real timeline may paint the poster before its public initial-load
    // callback admits this exact registration. Do not consume a trusted click
    // while Provider.run must still refuse an absent binding; enable the same
    // control only after the registration's layout effect can commit.
    admissionReady &&
    (!active || ["stopped", "unavailable", "waiting", "yielded"].includes(active.status)) &&
    manualAllowed;
  const privateReader = (
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
            <Button size="sm" variant="ghost" onClick={() => void copy(details.value.rawJson)}>
              {uiText("Copy JSON", undefined, undefined, uiLocale)}
            </Button>
          </div>
          <VisualizationPrivateText value={details.value.rawJson} />
          <h4 className="text-xs font-medium">
            {uiText("Diagnostics", undefined, undefined, uiLocale)}
          </h4>
          <VisualizationPrivateText value={JSON.stringify(details.value.diagnostics, null, 2)} />
        </>
      ) : detailFailure ? (
        <>
          <p role="status" className="text-xs">
            {uiText("Private details unavailable.", undefined, undefined, uiLocale)}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Retry", undefined, undefined, uiLocale)}
          </Button>
        </>
      ) : (
        <p className="text-xs">{uiText("Loading…", undefined, undefined, uiLocale)}</p>
      )}
    </div>
  );
  return (
    <section
      className="group/visualization my-3 min-w-0 w-full"
      data-visualization-card={reference.artifactId}
    >
      <div
        ref={anchor}
        data-visualization-native-surface="inline"
        tabIndex={live ? 0 : undefined}
        role="group"
        aria-label={uiText(
          "Interactive visualization: {title}. Press Enter to interact.",
          { title: reference.title },
          undefined,
          uiLocale,
        )}
        onKeyDown={(event) => {
          if (
            live &&
            event.isTrusted &&
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            viewer?.focus(key);
          }
        }}
        className="relative flex w-full items-center justify-center overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        style={{
          ...(active?.layout && reference.purpose === "generated-visualization"
            ? { height: active.layout.height }
            : { aspectRatio: `${reference.width} / ${reference.height}`, maxHeight: inlineHeight }),
          minHeight: 80,
        }}
      >
        {poster?.key === key ? (
          <img
            src={poster.url}
            alt={uiText(
              "Saved preview of {title}",
              { title: reference.title },
              undefined,
              uiLocale,
            )}
            className="size-full object-contain"
            draggable={false}
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            {posterFailure
              ? uiText("Saved preview unavailable.", undefined, undefined, uiLocale)
              : reference.poster
                ? uiText("Loading preview…", undefined, undefined, uiLocale)
                : uiText("No saved preview.", undefined, undefined, uiLocale)}
          </p>
        )}
      </div>
      {quiet ? (
        <>
          {/* A native top-frame surface paints above the DOM. The small sibling
            strip is deliberately outside its pixels, with a stable reserved
            height so hover/focus never moves chat history. Touch stays visible. */}
          <div className="flex h-6 min-w-0 justify-end" data-visualization-controls="quiet">
            <Menu
              key={key}
              open={menuOpen}
              onOpenChange={changeMenu}
              onOpenChangeComplete={(value) => {
                if (value || menuOpen) return;
                menuPresented.current = false;
                menuClosure.current?.resolve();
                menuClosure.current = null;
                setMenuExiting(false);
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && !menuOpen) changeMenu(false);
                      }}
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="text-muted-foreground transition-opacity duration-(--duration-fast) [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/visualization:opacity-100 [@media(hover:hover)]:group-focus-within/visualization:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100"
                          aria-label={uiText(
                            "Visualization actions",
                            undefined,
                            undefined,
                            uiLocale,
                          )}
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
                className="max-w-[min(28rem,calc(100vw-2rem))]"
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
                    {stateLabel ? (
                      <div role="status" className="font-normal">
                        {stateLabel}
                      </div>
                    ) : null}
                    {active?.layout?.constrained ? (
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
                      <MenuItem onClick={() => viewer?.stop(key)}>
                        <SquareIcon />
                        {uiText("Stop", undefined, undefined, uiLocale)}
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          void afterMenuClosed()
                            .then(() => viewer?.presentationOverlay(key, false))
                            .then((accepted) => {
                              if (accepted && committed.current === key) viewer?.expand(key, true);
                            })
                            .catch(() => {
                              if (committed.current === key) setExportOutcome("failed");
                            });
                        }}
                      >
                        {uiText("Expand", undefined, undefined, uiLocale)}
                      </MenuItem>
                    </>
                  ) : canRun ? (
                    <MenuItem
                      onClick={(event) => {
                        if (anchor.current)
                          viewer?.run({
                            environmentId,
                            threadId,
                            reference,
                            entryKey,
                            anchorId,
                            anchor: anchor.current,
                            opener: event.currentTarget,
                            ...(ownerPane ? { pane: ownerPane } : {}),
                            poolKey: key,
                            onScrollIntent: forwardScrollIntent,
                            onLayoutIntent: forwardLayoutIntent,
                          });
                      }}
                    >
                      <PlayIcon />
                      {uiText("Restart", undefined, undefined, uiLocale)}
                    </MenuItem>
                  ) : null}
                  {active?.status === "quarantined" ? (
                    <MenuItem onClick={() => viewer?.stop(key)}>
                      {uiText("Stop", undefined, undefined, uiLocale)}
                    </MenuItem>
                  ) : null}
                  <MenuItem
                    disabled={!running && poster?.key !== key}
                    onClick={() => exportPng("copy")}
                  >
                    {running
                      ? uiText("Copy current PNG", undefined, undefined, uiLocale)
                      : uiText("Copy saved preview", undefined, undefined, uiLocale)}
                  </MenuItem>
                  <MenuItem
                    disabled={!running && poster?.key !== key}
                    onClick={() => exportPng("save")}
                  >
                    {running
                      ? uiText("Save current PNG", undefined, undefined, uiLocale)
                      : uiText("Save saved preview", undefined, undefined, uiLocale)}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setConsentExiting(true);
                      setHtmlConsent(key);
                    }}
                  >
                    {uiText("Export HTML…", undefined, undefined, uiLocale)}
                  </MenuItem>
                  {posterFailure ? (
                    <MenuItem onClick={() => setAttempt((value) => value + 1)}>
                      {uiText("Retry preview", undefined, undefined, uiLocale)}
                    </MenuItem>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      setInspectionExiting(true);
                      setExpanded({ key, value: true });
                    }}
                  >
                    {uiText("Private source and JSON", undefined, undefined, uiLocale)}
                  </MenuItem>
                  {feedback ? (
                    <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
                      {feedback === "failed"
                        ? uiText("Export unavailable.", undefined, undefined, uiLocale)
                        : feedback === "copied"
                          ? uiText("Copied", undefined, undefined, uiLocale)
                          : feedback === "downloaded"
                            ? uiText("Download started", undefined, undefined, uiLocale)
                            : uiText("Saved", undefined, undefined, uiLocale)}
                    </div>
                  ) : null}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </div>
          <Dialog
            key={key}
            open={open}
            onOpenChange={(value) => {
              if (!value) closeInspection();
            }}
            onOpenChangeComplete={(value) => {
              if (!value && !open) setInspectionExiting(false);
            }}
          >
            <DialogPopup
              data-visualization-inspection="true"
              className="max-w-[min(60rem,calc(100vw-2rem))]"
            >
              <DialogTitle className="px-3 pt-3">
                {uiText("Private source and JSON", undefined, undefined, uiLocale)} ·{" "}
                {reference.title}
              </DialogTitle>
              <div className="min-h-0 overflow-y-auto">{open ? privateReader : null}</div>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <>
          {/* The content belongs in the conversation, not inside another app shell.
          Keep public attribution once in a quiet footer; private readers remain
          collapsed and none of this presentation rewrites immutable source. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground">
            {entry.actor.type === "child" ? (
              <SubagentAvatar
                seed={entry.actor.id}
                label={entry.actor.label ?? uiText("Subagent", undefined, undefined, uiLocale)}
                className="size-4 shrink-0"
              />
            ) : (
              <ChartNoAxesCombinedIcon className="size-3.5 shrink-0" aria-hidden />
            )}
            <h3 className="min-w-0 flex-1 truncate text-xs font-medium">{reference.title}</h3>
            <span className="min-w-0 max-w-full truncate">
              {entry.actor.type === "root"
                ? uiText("Root", undefined, undefined, uiLocale)
                : (entry.actor.label ?? uiText("Subagent", undefined, undefined, uiLocale))}
            </span>
            <time
              className="min-w-0 max-w-full [overflow-wrap:anywhere]"
              dateTime={entry.occurredAt}
            >
              {formatDiagnosticTimestamp(entry.occurredAt, timestampFormat, uiLocale)}
            </time>
            {reference.purpose === "mcp-app" ? (
              <span className="min-w-0 max-w-full truncate">
                {uiText("App · {server}", { server: reference.serverLabel }, undefined, uiLocale)}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 py-1 [&>button]:min-w-0 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:[overflow-wrap:anywhere]">
            {live ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => viewer?.stop(key)}>
                  <SquareIcon className="size-3" />
                  {uiText("Stop", undefined, undefined, uiLocale)}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => viewer?.expand(key, true)}>
                  {uiText("Expand", undefined, undefined, uiLocale)}
                </Button>
              </>
            ) : reference.purpose === "mcp-app" ||
              !automatic ||
              active?.status === "stopped" ||
              active?.status === "unavailable" ? (
              <Button
                data-visualization-run="true"
                size="sm"
                variant="ghost"
                disabled={!viewer || !canRun}
                onClick={(event) => {
                  if (anchor.current)
                    viewer?.run({
                      environmentId,
                      threadId,
                      reference,
                      entryKey,
                      anchorId,
                      anchor: anchor.current,
                      opener: event.currentTarget,
                      ...(ownerPane ? { pane: ownerPane } : {}),
                      poolKey: key,
                      onScrollIntent: forwardScrollIntent,
                      onLayoutIntent: forwardLayoutIntent,
                    });
                }}
              >
                <PlayIcon className="size-3" />
                {automatic && reference.purpose === "generated-visualization"
                  ? uiText("Restart", undefined, undefined, uiLocale)
                  : uiText("Run", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
            {active?.status === "quarantined" ? (
              <Button size="sm" variant="outline" onClick={() => viewer?.stop(key)}>
                {uiText("Stop", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={!live && poster?.key !== key}
              onClick={() => exportPng("copy")}
            >
              {live
                ? uiText("Copy current PNG", undefined, undefined, uiLocale)
                : uiText("Copy saved preview", undefined, undefined, uiLocale)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!live && poster?.key !== key}
              onClick={() => exportPng("save")}
            >
              {live
                ? uiText("Save current PNG", undefined, undefined, uiLocale)
                : uiText("Save saved preview", undefined, undefined, uiLocale)}
            </Button>
            {reference.purpose === "generated-visualization" ? (
              <Button size="sm" variant="ghost" onClick={() => setHtmlConsent(key)}>
                {uiText("Export HTML…", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
            {posterFailure ? (
              <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                {uiText("Retry preview", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
          </div>
          {stateLabel ? (
            <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
              {stateLabel}
              {live && active?.expiresAtMs
                ? ` · ${formatDiagnosticTimestamp(new Date(active.expiresAtMs).toISOString(), timestampFormat, uiLocale)}`
                : ""}
            </p>
          ) : null}
          {reference.purpose === "generated-visualization" && active?.layout?.constrained ? (
            <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
              {uiText(
                "Inline content limit reached. Expand to inspect.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : null}
          <Collapsible
            open={open}
            onOpenChange={(value) => {
              setExpanded({ key, value });
              if (!value) {
                generation.current += 1;
                setDetails(null);
                setExportOutcome(null);
                privateOwned.current = () => false;
              }
            }}
            className="border-t border-border-subtle"
          >
            <CollapsibleTrigger className="focus-ring group flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground">
              <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) motion-reduce:transition-none motion-reduce:duration-0 group-data-[panel-open]:rotate-90" />
              {uiText("Private source and JSON", undefined, undefined, uiLocale)}
            </CollapsibleTrigger>
            <CollapsiblePanel className="motion-reduce:transition-none motion-reduce:duration-0">
              {open ? privateReader : null}
            </CollapsiblePanel>
          </Collapsible>
          {feedback ? (
            <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
              {feedback === "failed"
                ? uiText("Export unavailable.", undefined, undefined, uiLocale)
                : feedback === "copied"
                  ? uiText("Copied", undefined, undefined, uiLocale)
                  : feedback === "downloaded"
                    ? uiText("Download started", undefined, undefined, uiLocale)
                    : uiText("Saved", undefined, undefined, uiLocale)}
            </p>
          ) : null}
        </>
      )}
      <Dialog
        key={key}
        open={htmlConsent === key}
        onOpenChangeComplete={(value) => {
          if (!value && htmlConsent !== key) setConsentExiting(false);
        }}
        onOpenChange={(value) => setHtmlConsent(value ? key : null)}
      >
        <DialogPopup
          showCloseButton={false}
          {...(quiet ? { "data-visualization-inspection": "true" } : {})}
        >
          <div className="space-y-3 p-5">
            <DialogTitle>
              {uiText("Export executable HTML?", undefined, undefined, uiLocale)} ·{" "}
              {reference.title}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {uiText(
                "This downloads the original document with its declared assets, not the current interactive state. Opening it outside Cafe runs untrusted JavaScript without Cafe’s isolation. Network access and behavior then depend on your browser. App tools and permissions are not exported.",
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
