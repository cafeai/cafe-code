import { useEffect, useState } from "react";
import { readBoundedResponse } from "@cafecode/relay/discovery";
import { fetchAppResource } from "./active";
import { admitImageTransfer } from "../../attachments/imageTransfer";

/** Native image elements receive a bounded inert blob, never a virtual URL. */
export function useRelayImageSource(source: string | null): string | null {
  const relayed =
    source !== null &&
    new URL(source, window.location.origin).hostname.endsWith(".cafecode-relay.invalid");
  const [loaded, setLoaded] = useState<{ source: string; blob: string } | undefined>(undefined);
  useEffect(() => {
    if (!relayed || !source) return;
    const controller = new AbortController();
    let active = true,
      blob: string | undefined;
    void (async () => {
      const release = await admitImageTransfer(controller.signal);
      try {
        const response = await fetchAppResource(source, {
          signal: controller.signal,
          credentials: "omit",
          redirect: "error",
        });
        const mime = response.headers.get("content-type")?.split(";", 1)[0];
        // SVG/HTML is never promoted to a same-origin Blob document.
        if (
          !mime ||
          ![
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/x-icon",
            "image/vnd.microsoft.icon",
          ].includes(mime)
        ) {
          await response.body?.cancel();
          return;
        }
        const bytes = await readBoundedResponse(response, 262_144);
        if (!active || controller.signal.aborted) return;
        blob = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
        setLoaded({ source, blob });
      } finally {
        release();
      }
    })().catch(() => {});
    return () => {
      active = false;
      controller.abort();
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [source, relayed]);
  return relayed ? (loaded?.source === source ? loaded.blob : null) : source;
}
