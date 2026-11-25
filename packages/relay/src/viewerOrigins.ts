// These URL rules are shared with the Cloudflare Worker, independently of the
// encrypted relay protocol and its native Node dependencies.
export const RELAY_VIEWER_FRAME_PATH = "/_relay/frame";
export const RELAY_VIEWER_WORKER_PATH = "/_relay/worker.js";

export function relayViewerFrameUrl(launcher: URL, label: string): URL {
  if (
    (launcher.protocol !== "https:" &&
      !(launcher.protocol === "http:" && launcher.hostname === "localhost")) ||
    !/^[0-9a-f]{32}$/.test(label)
  )
    throw new TypeError("Invalid relay viewer origin");
  const url = new URL(RELAY_VIEWER_FRAME_PATH, launcher.origin);
  url.hostname = label + "." + launcher.hostname;
  return url;
}

export function relayViewerLauncherOrigin(frame: URL): string | undefined {
  const separator = frame.hostname.indexOf(".");
  const parent = frame.hostname.slice(separator + 1);
  if (
    (frame.protocol !== "https:" && !(frame.protocol === "http:" && parent === "localhost")) ||
    !/^[0-9a-f]{32}$/.test(frame.hostname.slice(0, separator))
  )
    return undefined;
  const launcher = new URL(frame.origin);
  launcher.hostname = parent;
  return launcher.origin;
}
