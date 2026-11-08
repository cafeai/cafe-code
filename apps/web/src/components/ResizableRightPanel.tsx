import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { uiText } from "@cafecode/shared/i18n";

import { useUiLocale } from "~/i18n";
import {
  chatRightPanelWidthBounds,
  DEFAULT_CHAT_RIGHT_PANEL_WIDTH,
  MAX_CHAT_RIGHT_PANEL_WIDTH,
  MIN_CHAT_COLUMN_WIDTH,
  MIN_CHAT_RIGHT_PANEL_WIDTH,
  resolveChatRightPanelWidth,
} from "../rightPanelLayout";
import { useUiStateStore } from "../uiStateStore";

interface ResizeDrag {
  readonly handle: HTMLDivElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  pendingWidth: number;
  frame: number | null;
}

function releaseResizeDrag(drag: ResizeDrag): void {
  if (drag.frame !== null) cancelAnimationFrame(drag.frame);
  if (drag.handle.hasPointerCapture(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }
}

/** One resize owner for the shared Tasks/plan column; its children keep their identity. */
export const ResizableRightPanel = forwardRef<
  HTMLDivElement,
  { children: ReactNode; defaultWidth?: number | undefined }
>(function ResizableRightPanel({ children, defaultWidth = DEFAULT_CHAT_RIGHT_PANEL_WIDTH }, ref) {
  const uiLocale = useUiLocale();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<ResizeDrag | null>(null);
  const preferredWidth = useUiStateStore((state) => state.chatRightPanelWidth);
  const setPreferredWidth = useUiStateStore((state) => state.setChatRightPanelWidth);
  const [containerWidth, setContainerWidth] = useState(
    DEFAULT_CHAT_RIGHT_PANEL_WIDTH + MIN_CHAT_COLUMN_WIDTH,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const bounds = useMemo(() => chatRightPanelWidthBounds(containerWidth), [containerWidth]);
  const width = resolveChatRightPanelWidth(
    dragWidth ?? preferredWidth,
    containerWidth,
    defaultWidth,
  );
  const liveBounds = useRef(bounds);
  useLayoutEffect(() => {
    liveBounds.current = bounds;
  }, [bounds]);

  useImperativeHandle(ref, () => panel.current!, []);

  useLayoutEffect(() => {
    const container = panel.current?.parentElement;
    if (!container) return;
    const measure = () => setContainerWidth(container.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      const active = drag.current;
      drag.current = null;
      if (active) releaseResizeDrag(active);
    },
    [],
  );

  const finishResize = useCallback(
    (pointerId: number, commit: boolean) => {
      const active = drag.current;
      if (!active || active.pointerId !== pointerId) return;
      // Retire before releasing native capture, which can synchronously dispatch
      // lostpointercapture. Flush the final admitted move even before its RAF.
      drag.current = null;
      const currentBounds = liveBounds.current;
      if (commit && active.pendingWidth !== active.startWidth) {
        const finalWidth = Math.max(
          currentBounds.min,
          Math.min(currentBounds.max, active.pendingWidth),
        );
        setPreferredWidth(
          Math.max(MIN_CHAT_RIGHT_PANEL_WIDTH, Math.min(MAX_CHAT_RIGHT_PANEL_WIDTH, finalWidth)),
        );
      }
      releaseResizeDrag(active);
      setDragWidth(null);
    },
    [setPreferredWidth],
  );

  return (
    <div
      ref={panel}
      id={id}
      tabIndex={-1}
      data-chat-right-column="true"
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border-subtle bg-card animate-enter-from-end"
      style={{ width }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label={uiText("Resize Sidebar", undefined, undefined, uiLocale)}
        aria-controls={id}
        aria-orientation="vertical"
        aria-valuemin={Math.round(bounds.min)}
        aria-valuemax={Math.round(bounds.max)}
        aria-valuenow={Math.round(width)}
        className="no-drag absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none select-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px hover:before:bg-ring focus-visible:before:bg-ring"
        onPointerDown={(event) => {
          if (
            drag.current ||
            event.button !== 0 ||
            !event.isPrimary ||
            !Number.isFinite(event.clientX)
          ) {
            return;
          }
          const active: ResizeDrag = {
            handle: event.currentTarget,
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width,
            pendingWidth: width,
            frame: null,
          };
          event.preventDefault();
          event.stopPropagation();
          drag.current = active;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus({ preventScroll: true });
          setDragWidth(width);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId || !Number.isFinite(event.clientX)) {
            return;
          }
          const currentBounds = liveBounds.current;
          active.pendingWidth = Math.max(
            currentBounds.min,
            Math.min(currentBounds.max, active.startWidth + active.startX - event.clientX),
          );
          if (active.frame !== null) return;
          active.frame = requestAnimationFrame(() => {
            if (drag.current !== active) return;
            active.frame = null;
            setDragWidth(active.pendingWidth);
          });
        }}
        onPointerUp={(event) => finishResize(event.pointerId, true)}
        onPointerCancel={(event) => finishResize(event.pointerId, false)}
        onLostPointerCapture={(event) => finishResize(event.pointerId, false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            finishResize(drag.current.pointerId, false);
            return;
          }
          if (event.altKey || event.ctrlKey || event.metaKey || drag.current) return;
          const step = event.shiftKey ? 50 : 10;
          const nextWidth =
            event.key === "ArrowLeft"
              ? width + step
              : event.key === "ArrowRight"
                ? width - step
                : event.key === "Home"
                  ? bounds.min
                  : event.key === "End"
                    ? bounds.max
                    : null;
          if (nextWidth === null) return;
          event.preventDefault();
          event.stopPropagation();
          setPreferredWidth(Math.max(MIN_CHAT_RIGHT_PANEL_WIDTH, Math.min(bounds.max, nextWidth)));
        }}
      />
      {/* Keep the resize cursor over the whole viewport without changing global
          document styles that another pane or dialog could own. Native pointer
          capture still routes this gesture to its original separator. */}
      {dragWidth !== null
        ? createPortal(
            <div aria-hidden="true" className="fixed inset-0 z-50 cursor-col-resize select-none" />,
            document.body,
          )
        : null}
      {children}
    </div>
  );
});
