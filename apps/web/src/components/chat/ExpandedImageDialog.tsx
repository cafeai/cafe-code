import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { useChatPane } from "../../chatPaneContext";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview: initialPreview,
  onClose,
}: ExpandedImageDialogProps) {
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

  // A chat pane may clip its content or establish a fixed-position containing
  // block. Keep this full-window viewer outside that layout while retaining
  // the pane's React ownership and keyboard guards.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 animate-enter-fade [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 flex max-h-full min-h-0 min-w-0 max-w-full flex-col items-center animate-enter-scale">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          // Above the image: its entrance fade gives it a stacking context.
          className="absolute right-2 top-2 z-10"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        {/* Keyed by position so switching images crossfades the new one in
            instead of swapping pixels in place. */}
        <img
          key={`${preview.index}:${item.src}`}
          src={item.src}
          alt={item.name}
          className="max-h-[min(86dvh,calc(100dvh_-_5rem))] max-w-full select-none rounded-lg border border-border bg-background object-contain shadow-2xl animate-enter-fade"
          draggable={false}
        />
        <p className="mt-2 max-w-full shrink-0 truncate text-center text-xs text-white/80">
          {item.name}
          {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>,
    document.body,
  );
});
