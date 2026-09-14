import { useEffect, useRef, useState } from "react";
import { MonitorIcon } from "lucide-react";
import {
  DESKTOP_PREVIEW_PATH,
  DESKTOP_PREVIEW_MAX_BYTES,
  type EnvironmentId,
} from "@cafecode/contracts";
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
        <img
          src={src}
          alt={`Preview of ${name}`}
          draggable={false}
          onError={onError}
          className="size-full object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
          <MonitorIcon className="size-6 opacity-50" />
          <span>
            {!enabled
              ? "Preview unavailable"
              : error
                ? "Could not load preview"
                : "Loading preview…"}
          </span>
        </div>
      )}
    </div>
  );
}
