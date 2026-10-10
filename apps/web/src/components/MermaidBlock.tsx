import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CheckIcon, CopyIcon, Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";

import { copyTextToClipboard } from "../lib/copyToClipboard";
import { createMermaidPng } from "../lib/imageExport";
import { renderMermaid, type MermaidResult } from "../lib/mermaid/renderService";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { ImageExportMenu } from "./ImageExportMenu";
import "./MermaidBlock.css";

interface MermaidBlockProps {
  code: string;
  complete: boolean;
  theme: "dark" | "light";
}

type DiagramState = {
  code: string;
  theme: MermaidBlockProps["theme"];
} & ({ status: "ready"; result: MermaidResult } | { status: "error" });

interface DiagramImage {
  result: MermaidResult;
  url: string;
}

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 4;

function ExpandedDiagram({
  result,
  url,
  exportTheme,
  exportDisabled,
}: DiagramImage & {
  exportTheme: "dark" | "light";
  exportDisabled: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Observe only this open dialog. No history-wide measurements or animation
    // loop are needed, and rem-based padding follows Cafe's interface scale.
    const measure = () => {
      const styles = getComputedStyle(viewport);
      const width = Math.max(
        1,
        viewport.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
      );
      const height = Math.max(
        1,
        viewport.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom),
      );
      setViewportSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale = Math.min(
    1,
    (viewportSize.width || 1) / result.width,
    (viewportSize.height || 1) / result.height,
  );
  const scale = zoom === "fit" ? fitScale : zoom;

  const changeZoom = (next: number | "fit") => {
    setZoom(next);
    // Fit and reset have deterministic origins even after a long pan. Ordinary
    // zoom preserves the native scroll position so keyboard scrolling also works.
    if (next === "fit" || next === 1) viewportRef.current?.scrollTo(0, 0);
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch retains the browser's ordinary two-dimensional scroll behavior.
    if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    const viewport = event.currentTarget;
    if (
      viewport.scrollWidth <= viewport.clientWidth &&
      viewport.scrollHeight <= viewport.clientHeight
    )
      return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  return (
    <>
      <div className="mermaid-expanded-heading">
        <DialogTitle className="text-base">Expanded Mermaid diagram</DialogTitle>
        <DialogDescription className="text-xs">
          Zoom to inspect. Scroll or drag to pan.
        </DialogDescription>
      </div>
      <div className="mermaid-expanded-toolbar" role="group" aria-label="Diagram zoom controls">
        <Button size="xs" variant="outline" onClick={() => changeZoom("fit")}>
          Fit
        </Button>
        <Button size="xs" variant="ghost" onClick={() => changeZoom(1)}>
          Reset
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          disabled={scale <= MIN_ZOOM}
          onClick={() => changeZoom(Math.max(MIN_ZOOM, scale / 1.25))}
        >
          <MinusIcon />
        </Button>
        <output className="mermaid-zoom-value" aria-label="Zoom level">
          {Math.round(scale * 100)}%
        </output>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={() => changeZoom(Math.min(MAX_ZOOM, scale * 1.25))}
        >
          <PlusIcon />
        </Button>
        <div className="ml-auto">
          <ImageExportMenu
            label="Diagram"
            contentKey={result}
            disabled={exportDisabled}
            createPng={(signal) => createMermaidPng(result, exportTheme, signal)}
            suggestedName="diagram.png"
          />
        </div>
      </div>
      <div
        ref={viewportRef}
        className="mermaid-expanded-viewport"
        data-dragging={dragging || undefined}
        role="region"
        aria-label="Expanded diagram; scroll or drag to pan"
        tabIndex={0}
        onPointerDown={beginPan}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX;
          event.currentTarget.scrollTop = drag.top + drag.y - event.clientY;
        }}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onLostPointerCapture={endPan}
      >
        <div
          className="mermaid-expanded-canvas"
          style={{ width: result.width * scale, height: result.height * scale }}
        >
          <img
            src={url}
            alt={result.title || "Mermaid diagram"}
            draggable={false}
            style={{ width: result.width * scale, height: result.height * scale }}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Owns the blob URL for one sanitized render result. A layout effect creates
 * it before paint, so a cached diagram appears on the first frame, and revokes
 * it when the result changes or the block unmounts. The URL is only returned
 * for the result it was created from, so a render can never reference a
 * revoked URL. (The shared cache returns the same result object, so cache
 * hits and StrictMode re-renders do not churn URLs.)
 */
function useResultObjectUrl(result: MermaidResult | null): string | null {
  const [entry, setEntry] = useState<{ result: MermaidResult; url: string } | null>(null);
  useLayoutEffect(() => {
    if (result === null) {
      setEntry(null);
      return;
    }
    // Even sanitized SVG stays in an image document, never in chat's DOM.
    const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
    setEntry({ result, url });
    return () => URL.revokeObjectURL(url);
  }, [result]);
  return entry !== null && entry.result === result ? entry.url : null;
}

/** Synchronous cache read so virtualized re-mounts never flash source first. */
function readCachedDiagram(
  code: string,
  theme: MermaidBlockProps["theme"],
  complete: boolean,
): DiagramState | null {
  if (!complete) return null;
  const cached = renderMermaid.peek?.(code, theme);
  if (cached === undefined) return null;
  return cached === null
    ? { code, theme, status: "error" }
    : { code, theme, status: "ready", result: cached };
}

export const MermaidBlock = memo(function MermaidBlock({
  code,
  complete,
  theme,
}: MermaidBlockProps) {
  const [diagramState, setDiagramState] = useState<DiagramState | null>(() =>
    readCachedDiagram(code, theme, complete),
  );
  // A diagram already cached at mount (scrolling back, switching chats) is
  // shown immediately without an entrance fade; only newly rendered images
  // fade in.
  const [mountedResult] = useState(() =>
    diagramState?.status === "ready" ? diagramState.result : null,
  );
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{ code: string; failed: boolean } | null>(null);
  const copySequenceRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setExpanded(false);
    // A theme change re-renders the same source: keep its current image until
    // the new one is ready instead of flashing back to source. Any other change
    // (streamed replacement, incomplete fence) discards the previous result.
    setDiagramState((previous) =>
      complete && previous?.code === code && previous.status === "ready" ? previous : null,
    );
    if (!complete) return;
    let disposed = false;
    void renderMermaid(code, theme)
      .then((result) => {
        if (disposed) return;
        setDiagramState({ code, theme, status: "ready", result });
      })
      .catch(() => {
        // Renderer errors may contain source text or paths. Only a fixed,
        // content-free fallback is allowed onto this display surface.
        if (!disposed) setDiagramState({ code, theme, status: "error" });
      });
    return () => {
      disposed = true;
    };
  }, [code, complete, theme]);

  useEffect(() => {
    setCopyStatus(null);
    return () => {
      // A slow clipboard promise must not update another source or an unmounted
      // row. Invalidate it alongside its bounded feedback timer.
      copySequenceRef.current += 1;
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    };
  }, [code]);

  const copySource = useCallback(() => {
    const sequence = ++copySequenceRef.current;
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = null;
    void copyTextToClipboard(code).then(
      () => {
        if (sequence !== copySequenceRef.current) return;
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        setCopyStatus({ code, failed: false });
        copiedTimerRef.current = setTimeout(() => {
          setCopyStatus(null);
          copiedTimerRef.current = null;
        }, 1200);
      },
      () => {
        if (sequence !== copySequenceRef.current) return;
        setCopyStatus({ code, failed: true });
        setView("source");
      },
    );
  }, [code]);

  // Never display a previous source's result, even for the render before the
  // effect runs; the code check also covers a streamed source replacement. A
  // ready image of the same source may outlive a theme change until the new
  // theme's image replaces it. Failures are bound to their exact theme.
  const sameSource = complete && diagramState?.code === code ? diagramState : null;
  const ready = sameSource?.status === "ready" ? sameSource : null;
  const failed = sameSource?.status === "error" && sameSource.theme === theme;
  const imageUrl = useResultObjectUrl(ready?.result ?? null);
  const shownImage = ready && imageUrl ? { result: ready.result, url: imageUrl } : null;
  const showSource = view === "source" || !complete || failed;
  // While rendering, keep the source in place (no "Rendering…" line) so the
  // block changes size at most once, when the image replaces it.
  const pending = !showSource && shownImage === null;
  const showPendingSpinner = useDelayedFlag(pending);
  const copied = copyStatus?.code === code && !copyStatus.failed;
  const copyFailed = copyStatus?.code === code && copyStatus.failed;

  return (
    <Dialog open={expanded && shownImage !== null} onOpenChange={setExpanded}>
      <div className="mermaid-block" data-mermaid-block="" data-theme={theme}>
        <div className="mermaid-toolbar">
          <div className="mermaid-view-toggle" role="group" aria-label="Mermaid view">
            <Button
              size="xs"
              variant={showSource ? "ghost" : "secondary"}
              aria-pressed={!showSource}
              disabled={!complete || failed}
              onClick={() => setView("diagram")}
            >
              Diagram
            </Button>
            <Button
              size="xs"
              variant={showSource ? "secondary" : "ghost"}
              aria-pressed={showSource}
              onClick={() => setView("source")}
            >
              Source
            </Button>
            {showPendingSpinner ? (
              <Spinner
                aria-label="Rendering diagram"
                className="ml-1 size-3.5 text-subtle-foreground"
              />
            ) : null}
          </div>
          <div className="mermaid-actions">
            <Button size="xs" variant="ghost" onClick={copySource} aria-label="Copy Mermaid source">
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <ImageExportMenu
              label="Diagram"
              contentKey={ready?.result}
              disabled={!ready || ready.theme !== theme || !shownImage}
              createPng={(signal) => {
                // A retained old-theme preview may stay visible while its
                // replacement renders, but it must never export with a new
                // theme's background or the next source's content.
                if (!ready || ready.theme !== theme)
                  return Promise.reject(new Error("Image unavailable."));
                return createMermaidPng(ready.result, ready.theme, signal);
              }}
              suggestedName="diagram.png"
            />
            <DialogTrigger
              disabled={!shownImage}
              aria-label="Expand diagram"
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <Maximize2Icon />
            </DialogTrigger>
          </div>
        </div>
        {copyFailed && (
          <p className="mermaid-notice" role="status">
            Couldn&apos;t copy. Use Source to select the code.
          </p>
        )}
        {failed && (
          <p className="mermaid-notice" role="status">
            Couldn&apos;t render this diagram. Showing its source.
          </p>
        )}
        {showSource || pending ? (
          <pre
            className="mermaid-source"
            tabIndex={0}
            aria-label="Mermaid source"
            aria-busy={pending || undefined}
          >
            <code>{code}</code>
          </pre>
        ) : shownImage ? (
          <div
            className="mermaid-preview"
            role="region"
            aria-label="Mermaid diagram preview; scroll to inspect"
            tabIndex={0}
          >
            <img
              key={shownImage.url}
              src={shownImage.url}
              alt={shownImage.result.title || "Mermaid diagram"}
              width={shownImage.result.width}
              height={shownImage.result.height}
              draggable={false}
              className={shownImage.result === mountedResult ? undefined : "animate-enter-fade"}
              onError={() => setDiagramState({ code, theme, status: "error" })}
            />
          </div>
        ) : null}
      </div>
      {shownImage && (
        <DialogPopup className="mermaid-expanded-dialog" bottomStickOnMobile={false}>
          <ExpandedDiagram
            result={shownImage.result}
            url={shownImage.url}
            exportTheme={ready!.theme}
            exportDisabled={ready!.theme !== theme}
          />
        </DialogPopup>
      )}
    </Dialog>
  );
});
