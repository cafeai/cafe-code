import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { isElectron } from "../../env";
import { isWindowsPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ExpandedImageViewer } from "./ExpandedImageViewer";
import { useChatPane } from "../../chatPaneContext";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview: initialPreview,
  onClose,
}: ExpandedImageDialogProps) {
  const uiLocale = useUiLocale();

  const pane = useChatPane();
  const [preview, setPreview] = useState(initialPreview);

  // Sync when the parent hands us a new preview reference.
  useEffect(() => {
    setPreview(initialPreview);
  }, [initialPreview]);

  const navigateImage = useCallback((direction: -1 | 1) => {
    setPreview((existing) => {
      if (existing.images.length <= 1) return existing;
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) return existing;
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!pane.active || !pane.visible || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length, pane.active, pane.visible]);

  const item = preview.images[preview.index];
  if (!item || !pane.visible) return null;
  const reserveNativeTitlebar = isElectron && isWindowsPlatform(navigator.platform);

  // A chat pane may clip its content or establish a fixed-position containing
  // block. Keep this full-window viewer outside that layout while retaining
  // the pane's React ownership and keyboard guards. Native window controls sit
  // above all renderer content: Windows reserves its visible caption band, and
  // macOS starts the card below the fixed traffic-light band.
  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 animate-enter-fade [-webkit-app-region:no-drag] mac-traffic-lights:pt-(--app-mac-titlebar-height) ${reserveNativeTitlebar ? "wco:pt-[calc(env(titlebar-area-y,0px)+env(titlebar-area-height,40px)+1rem)]" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={uiText("Expanded image preview", undefined, undefined, uiLocale)}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={uiText("Close image preview", undefined, undefined, uiLocale)}
        onClick={onClose}
      />
      <div className="relative isolate z-10 flex h-full min-h-0 w-full min-w-0 max-w-[1600px] flex-col gap-2 rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl animate-enter-scale">
        {/* Each selected image owns its measurements and view, so navigation
            starts fitted without carrying another image's pan or zoom. */}
        <ExpandedImageViewer key={`${preview.index}:${item.src}`} item={item} onClose={onClose} />
        <div className="flex shrink-0 items-center gap-2">
          {preview.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={uiText("Previous image", undefined, undefined, uiLocale)}
              onClick={() => navigateImage(-1)}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <p className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
            {item.name}
            {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
          </p>
          {preview.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={uiText("Next image", undefined, undefined, uiLocale)}
              onClick={() => navigateImage(1)}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
        <span className="shrink-0 text-center text-xs text-muted-foreground">
          {uiText("Scroll to zoom. Drag to pan.", undefined, undefined, uiLocale)}
        </span>
      </div>
    </div>,
    document.body,
  );
});
