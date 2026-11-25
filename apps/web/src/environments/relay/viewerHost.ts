import { relayViewerFrameUrl } from "@cafecode/relay/viewerOrigins";
import { Lifetime } from "@cafecode/relay/lifetime";
import { deferred } from "@cafecode/relay/deferred";
import { RelayError } from "@cafecode/relay/errors";
import { ActiveRelay, type BrowserRelay } from "./active";
import { openViewerAssets, pinViewerTransport } from "./viewerAssets";
import {
  isViewerMessage,
  serveViewerBridge,
  VIEWER_READY,
  VIEWER_START,
  VIEWER_STARTUP_MS,
} from "./viewerBridge";

export async function openHostViewer(relay: BrowserRelay): Promise<void> {
  const lifetime = new Lifetime();
  const start = lifetime.deadline(VIEWER_STARTUP_MS);
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  const opened = deferred<void>();
  void opened.promise.catch(() => {});
  const pending = new Set<Promise<void>>();
  const label = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const url = relayViewerFrameUrl(new URL(location.origin), label);
  let portTransferred = false;
  let dispose: Promise<void> | undefined;

  const close = () => {
    if (dispose) return dispose;
    const done = deferred<void>();
    dispose = done.promise;
    lifetime.retire();
    channel.port1.close();
    if (!portTransferred) channel.port2.close();
    window.removeEventListener("message", acceptFrame);
    window.removeEventListener("pagehide", onPageHide);
    frame.remove();
    opened.reject(new RelayError("UNAVAILABLE"));
    void Promise.allSettled([lifetime.close(), relay.close(), ...pending]).then(() =>
      done.resolve(),
    );
    return dispose;
  };
  const onPageHide = () => void close();
  const acceptFrame = (event: MessageEvent<unknown>) => {
    if (
      !lifetime.active ||
      event.origin !== url.origin ||
      event.source !== frame.contentWindow ||
      event.data !== VIEWER_READY
    )
      return;
    window.removeEventListener("message", acceptFrame);
    frame.contentWindow?.postMessage(
      {
        kind: VIEWER_START,
        environmentId: relay.environmentId,
        httpBaseUrl: relay.httpBaseUrl,
        wsBaseUrl: relay.wsBaseUrl,
      },
      url.origin,
      [channel.port2],
    );
    portTransferred = true;
  };
  start.signal.addEventListener("abort", onPageHide, { once: true });
  window.addEventListener("pagehide", onPageHide, { once: true });

  try {
    const pinned =
      relay instanceof ActiveRelay
        ? await pinViewerTransport(relay, lifetime, start.signal, () => {
            void close();
            location.replace("/relay/connect");
          })
        : undefined;
    const transport = pinned?.transport ?? relay;
    const readAsset = await openViewerAssets(transport, start.signal, pinned?.manifest);
    const assets = (file: string, signal: AbortSignal) =>
      readAsset(file, signal).catch((error: unknown) => {
        if (!signal.aborted) opened.reject(error);
        throw error;
      });
    start.signal.throwIfAborted();
    channel.port1.onmessage = ({ data, ports }: MessageEvent<unknown>) => {
      if (data === "started" && lifetime.active && !ports.length) {
        opened.resolve();
        return;
      }
      if (data === "failed" && !ports.length) {
        void close();
        return;
      }
      const port = ports[0];
      if (!lifetime.active || !port || ports.length !== 1 || pending.size >= 32) {
        for (const port of ports) {
          port.postMessage({ kind: "error" });
          port.close();
        }
        return;
      }
      const job = serveViewerBridge(transport, assets, lifetime, data, port);
      pending.add(job);
      void job.finally(() => pending.delete(job)).catch(() => {});
    };
    channel.port1.onmessageerror = onPageHide;
    window.addEventListener("message", acceptFrame);
    frame.title = "Cafe Code";
    frame.sandbox.add(
      "allow-scripts",
      "allow-same-origin",
      "allow-forms",
      "allow-downloads",
      "allow-popups",
    );
    frame.allow = "clipboard-write 'src'";
    frame.referrerPolicy = "no-referrer";
    frame.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;border:0;visibility:hidden";
    frame.src = url.href;
    document.body.append(frame);
    await opened.promise;
    start.signal.throwIfAborted();
    frame.style.visibility = "visible";
  } catch (error) {
    await close();
    throw error;
  } finally {
    start.signal.removeEventListener("abort", onPageHide);
    start.cancel();
  }
}
