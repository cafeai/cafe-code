import { uiText } from "@cafecode/shared/i18n";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useUiLocale } from "~/i18n";
import { Button } from "../ui/button";
import type { ExpandedImageItem } from "./ExpandedImagePreview";

const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function ExpandedImageViewer({
  item,
  onClose,
}: {
  item: ExpandedImageItem;
  onClose: () => void;
}) {
  const uiLocale = useUiLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const anchorRef = useRef<{ imageX: number; imageY: number; x: number; y: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      setViewportSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale = imageSize.width
    ? Math.min(1, viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
    : 1;
  // A very large image must always be able to return to its fitted size.
  const minZoom = Math.min(0.1, fitScale);
  const scale = zoom === "fit" ? fitScale : zoom;
  const ready = imageSize.width > 0 && viewportSize.width > 0 && viewportSize.height > 0;

  const changeZoom = useCallback(
    (next: number | "fit", point?: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      if (!viewport || !ready) return;
      const x = point?.x ?? viewport.clientWidth / 2;
      const y = point?.y ?? viewport.clientHeight / 2;
      // Native scrolling owns pan bounds. Account for the centered margins
      // before converting the cursor/viewport center to an image coordinate.
      anchorRef.current = {
        imageX:
          (viewport.scrollLeft +
            x -
            Math.max(0, (viewport.clientWidth - imageSize.width * scale) / 2)) /
          scale,
        imageY:
          (viewport.scrollTop +
            y -
            Math.max(0, (viewport.clientHeight - imageSize.height * scale) / 2)) /
          scale,
        x,
        y,
      };
      setZoom(next === "fit" ? next : Math.min(MAX_ZOOM, Math.max(minZoom, next)));
    },
    [imageSize, minZoom, ready, scale],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!viewport) return;
    if (zoom === "fit") {
      viewport.scrollTo(0, 0);
    } else if (anchor) {
      // Apply after the new image dimensions reach the DOM, so zooming toward
      // a detail keeps it under the pointer instead of jumping to the origin.
      viewport.scrollLeft =
        anchor.imageX * scale +
        Math.max(0, (viewport.clientWidth - imageSize.width * scale) / 2) -
        anchor.x;
      viewport.scrollTop =
        anchor.imageY * scale +
        Math.max(0, (viewport.clientHeight - imageSize.height * scale) / 2) -
        anchor.y;
    }
  }, [imageSize, scale, zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      // React's delegated wheel listener is passive. Own only this viewport's
      // listener so trackpad pinch cannot zoom the surrounding application.
      event.preventDefault();
      if (!event.deltaY) return;
      const bounds = viewport.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.01), {
        x: event.clientX - bounds.left - viewport.clientLeft,
        y: event.clientY - bounds.top - viewport.clientTop,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom, scale]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch keeps native two-dimensional scrolling and its momentum.
    if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    const viewport = event.currentTarget;
    viewport.focus({ preventScroll: true });
    if (
      viewport.scrollWidth <= viewport.clientWidth &&
      viewport.scrollHeight <= viewport.clientHeight
    )
      return;
    event.preventDefault();
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
      <div
        className="flex shrink-0 items-center gap-1"
        role="group"
        aria-label={uiText("Image zoom controls", undefined, undefined, uiLocale)}
      >
        <Button size="xs" variant="outline" disabled={!ready} onClick={() => changeZoom("fit")}>
          {uiText("Fit", undefined, undefined, uiLocale)}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-label={uiText("Original size", undefined, undefined, uiLocale)}
          disabled={!ready}
          onClick={() => changeZoom(1)}
        >
          100%
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={uiText("Zoom out", undefined, undefined, uiLocale)}
          disabled={!ready || scale <= minZoom}
          onClick={() => changeZoom(scale / ZOOM_STEP)}
        >
          <MinusIcon />
        </Button>
        <output
          className="min-w-12 text-center text-xs tabular-nums"
          aria-label={uiText("Zoom level", undefined, undefined, uiLocale)}
        >
          {Math.round(scale * 100)}%
        </output>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={uiText("Zoom in", undefined, undefined, uiLocale)}
          disabled={!ready || scale >= MAX_ZOOM}
          onClick={() => changeZoom(scale * ZOOM_STEP)}
        >
          <PlusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          onClick={onClose}
          aria-label={uiText("Close image preview", undefined, undefined, uiLocale)}
        >
          <XIcon />
        </Button>
      </div>
      <div
        ref={viewportRef}
        className={`min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        role="region"
        aria-label={uiText(
          "Expanded image; scroll to zoom or drag to pan",
          undefined,
          undefined,
          uiLocale,
        )}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (["+", "=", "-", "0", "1"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "0") changeZoom("fit");
            else if (event.key === "1") changeZoom(1);
            else changeZoom(scale * (event.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP));
          } else if (
            event.key.startsWith("Arrow") &&
            (event.currentTarget.scrollWidth > event.currentTarget.clientWidth ||
              event.currentTarget.scrollHeight > event.currentTarget.clientHeight)
          ) {
            // A focused, zoomed viewport uses the browser's arrow-key scrolling;
            // gallery keys remain available from the toolbar and surrounding UI.
            event.stopPropagation();
          }
        }}
        onDoubleClick={(event) => {
          const viewport = event.currentTarget;
          const bounds = viewport.getBoundingClientRect();
          changeZoom(zoom === "fit" ? 1 : "fit", {
            x: event.clientX - bounds.left - viewport.clientLeft,
            y: event.clientY - bounds.top - viewport.clientTop,
          });
        }}
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
          className="grid min-h-full min-w-full place-items-center"
          style={
            ready ? { width: imageSize.width * scale, height: imageSize.height * scale } : undefined
          }
        >
          <img
            ref={imageRef}
            src={item.src}
            alt={item.name}
            className="max-w-none select-none"
            draggable={false}
            style={
              ready
                ? { width: imageSize.width * scale, height: imageSize.height * scale }
                : { maxWidth: "100%", maxHeight: "100%", opacity: 0 }
            }
            onLoad={() => {
              const img = imageRef.current;
              if (img) setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        </div>
      </div>
    </>
  );
}
