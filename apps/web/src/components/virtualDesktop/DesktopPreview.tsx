import { useEffect, useRef, useState } from "react";
import { MonitorIcon } from "lucide-react";
import {
  DESKTOP_PREVIEW_PATH,
  DESKTOP_PREVIEW_MAX_BYTES,
  type EnvironmentId,
} from "@cafecode/contracts";
import { Skeleton } from "../ui/skeleton";
import { useDesktopImage } from "./useDesktopImage";

export function DesktopPreview({
  environmentId,
  id,
  name,
  enabled,
  revision = 0,
}: {
  environmentId: EnvironmentId;
  id: string;
  name: string;
  enabled: boolean;
  revision?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { src, error, onError } = useDesktopImage(
    environmentId,
    enabled && visible ? `${DESKTOP_PREVIEW_PATH}/${id}` : null,
    DESKTOP_PREVIEW_MAX_BYTES,
    undefined,
    revision,
  );
  return (
    <div
      ref={ref}
      className="relative flex aspect-[8/5] w-full items-center justify-center overflow-hidden bg-muted/50"
    >
      {src && enabled && visible ? (
        // A refresh swaps the source in place, so only the first frame fades in.
        <img
          src={src}
          alt={`Preview of ${name}`}
          draggable={false}
          onError={onError}
          className="size-full animate-enter-fade object-contain"
        />
      ) : enabled && !error ? (
        <Skeleton
          role="status"
          aria-label="Loading preview"
          className="absolute inset-0 rounded-none"
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
          <MonitorIcon className="size-6 text-disabled-foreground" />
          <span>{!enabled ? "Preview unavailable" : "Could not load preview"}</span>
        </div>
      )}
    </div>
  );
}
