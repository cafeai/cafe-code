import { Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ExtraProps } from "react-markdown";

import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { isWindowsPlatform } from "../lib/utils";
import { ImageExportMenu } from "./ImageExportMenu";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle, DialogTrigger } from "./ui/dialog";
import "./MarkdownTableViewer.css";

type TableProps = ComponentProps<"table">;

interface ExpandedTableProps {
  children: ReactNode;
  tableProps: TableProps;
  exportContentKey: unknown;
  createPng: (signal: AbortSignal) => Promise<Blob>;
}

interface TableGeometry {
  viewportWidth: number;
  viewportHeight: number;
  tableWidth: number;
  tableHeight: number;
}

const INITIAL_GEOMETRY: TableGeometry = {
  viewportWidth: 1,
  viewportHeight: 1,
  tableWidth: 1,
  tableHeight: 1,
};
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 4;

function ExpandedTable({ children, tableProps, exportContentKey, createPng }: ExpandedTableProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [geometry, setGeometry] = useState<TableGeometry>(INITIAL_GEOMETRY);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    // The table is measured before scaling. A transform never changes its
    // layout size, so updating the canvas cannot feed back into this observer.
    // Restrict observations to the open dialog rather than every chat table.
    const measure = () => {
      const styles = getComputedStyle(viewport);
      const viewportWidth = Math.max(
        1,
        viewport.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
      );
      const viewportHeight = Math.max(
        1,
        viewport.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom),
      );
      // Some cell renderers (notably unbroken code and math) can paint beyond
      // the table's border box. Include that overflow in Fit and in the native
      // scroll canvas so the last character remains reachable.
      const tableWidth = Math.max(1, content.offsetWidth, content.scrollWidth);
      const tableHeight = Math.max(1, content.offsetHeight, content.scrollHeight);
      setGeometry((previous) =>
        previous.viewportWidth === viewportWidth &&
        previous.viewportHeight === viewportHeight &&
        previous.tableWidth === tableWidth &&
        previous.tableHeight === tableHeight
          ? previous
          : { viewportWidth, viewportHeight, tableWidth, tableHeight },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const fitScale = Math.min(
    1,
    geometry.viewportWidth / geometry.tableWidth,
    geometry.viewportHeight / geometry.tableHeight,
  );
  const scale = zoom === "fit" ? fitScale : zoom;

  const changeZoom = (next: number | "fit") => {
    setZoom(next);
    if (next === "fit" || next === 1) viewportRef.current?.scrollTo(0, 0);
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Tables contain selectable text and actionable links. Dragging may begin
    // only on empty viewport/canvas space, never from a cell or its contents.
    // Touch keeps the browser's ordinary two-dimensional scroll behavior.
    if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    if (event.target !== event.currentTarget && event.target !== canvasRef.current) return;
    const viewport = event.currentTarget;
    // A native scrollbar event can target the viewport itself. Leave its
    // gutter to the browser rather than turning a thumb drag into panning.
    // Convert screen coordinates to layout coordinates so dialog entrance
    // scaling does not change which part of the viewport admits a drag.
    const bounds = viewport.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const localX = ((event.clientX - bounds.left) * viewport.offsetWidth) / bounds.width;
    const localY = ((event.clientY - bounds.top) * viewport.offsetHeight) / bounds.height;
    if (
      localX < viewport.clientLeft ||
      localX >= viewport.clientLeft + viewport.clientWidth ||
      localY < viewport.clientTop ||
      localY >= viewport.clientTop + viewport.clientHeight
    )
      return;
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
      <div className="markdown-table-expanded-heading">
        <DialogTitle className="text-base">Expanded table</DialogTitle>
        <DialogDescription className="text-xs">
          Zoom to inspect. Scroll or drag empty space to pan.
        </DialogDescription>
      </div>
      <div
        className="markdown-table-expanded-toolbar"
        role="group"
        aria-label="Table zoom controls"
      >
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
        <output className="markdown-table-zoom-value" aria-label="Zoom level">
          {scale < 0.005 ? "<1%" : `${Math.round(scale * 100)}%`}
        </output>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={() => changeZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * 1.25)))}
        >
          <PlusIcon />
        </Button>
        <div className="markdown-table-expanded-export">
          <ImageExportMenu
            label="Table"
            contentKey={exportContentKey}
            createPng={createPng}
            suggestedName="table.png"
          />
        </div>
      </div>
      <div
        ref={viewportRef}
        className="markdown-table-expanded-viewport"
        data-dragging={dragging || undefined}
        role="region"
        aria-label="Expanded table; scroll to inspect"
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
          ref={canvasRef}
          className="markdown-table-expanded-canvas"
          data-markdown-table-zoom-canvas="true"
          style={{
            width: geometry.tableWidth * scale,
            height: geometry.tableHeight * scale,
          }}
        >
          <div
            ref={contentRef}
            className="chat-markdown markdown-table-expanded-content"
            style={{ transform: `scale(${scale})` }}
          >
            <table {...tableProps}>{children}</table>
          </div>
        </div>
      </div>
    </>
  );
}

/** A stable react-markdown component type keeps inline horizontal scroll
 * position across chat metadata updates, while its dialog keeps the original
 * semantic table and the same sanitized React children fully interactive. */
export function MarkdownTable({ node: _node, children, ...props }: TableProps & ExtraProps) {
  const [expanded, setExpanded] = useState(false);
  const { resolvedTheme } = useTheme();
  const sourceTableRef = useRef<HTMLTableElement>(null);
  // Both menus export the same unscaled source. Neither scrolling the inline
  // table nor fitting/zooming the expanded viewer changes the exported extent.
  const exportContentKey = useMemo(
    () => ({
      children,
      node: _node,
      className: props.className,
      style: props.style,
      resolvedTheme,
    }),
    [children, _node, props.className, props.style, resolvedTheme],
  );
  const createPng = async (signal: AbortSignal): Promise<Blob> => {
    // Fonts and the presentation snapshotter are needed only for explicit
    // export actions, so ordinary chat rendering does not load their module.
    const { createTablePng } = await import("../lib/tableImageExport");
    signal.throwIfAborted();
    const table = sourceTableRef.current;
    if (!table?.isConnected) throw new Error("This table could not be exported as an image.");
    return createTablePng(table, signal);
  };
  const reserveNativeTitlebar =
    isElectron && typeof navigator !== "undefined" && isWindowsPlatform(navigator.platform);

  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <div className="markdown-table-block">
        <div className="markdown-table-inline-toolbar">
          <ImageExportMenu
            label="Table"
            contentKey={exportContentKey}
            createPng={createPng}
            suggestedName="table.png"
          />
          <DialogTrigger
            aria-label="Expand table"
            render={<Button size="icon-xs" variant="ghost" />}
          >
            <Maximize2Icon />
          </DialogTrigger>
        </div>
        <div className="chat-markdown-table-scroll">
          <table {...props} ref={sourceTableRef}>
            {children}
          </table>
        </div>
      </div>
      <DialogPopup
        className={`markdown-table-expanded-dialog${reserveNativeTitlebar ? " markdown-table-native-titlebar" : ""}`}
        bottomStickOnMobile={false}
        data-cafe-window-no-drag="true"
      >
        <ExpandedTable tableProps={props} exportContentKey={exportContentKey} createPng={createPng}>
          {children}
        </ExpandedTable>
      </DialogPopup>
    </Dialog>
  );
}
