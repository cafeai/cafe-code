import {
  RELAY_VIEWER_FRAME_PATH,
  RELAY_VIEWER_WORKER_PATH,
  relayViewerLauncherOrigin,
} from "@cafecode/relay/viewerOrigins";
import { Lifetime } from "@cafecode/relay/lifetime";
import { deferred } from "@cafecode/relay/deferred";
import { requireRelay } from "@cafecode/relay/errors";
import type { BrowserRelay } from "./active";
import {
  isViewerMessage,
  makeEmbeddedViewerRelay,
  viewerRequest,
  VIEWER_ASSET,
  VIEWER_READY,
  VIEWER_START,
  VIEWER_STARTUP_MS,
} from "./viewerBridge";

type RelayViewerDocument = Window & {
  cafeRelayViewer?: { relay: BrowserRelay; started: () => void };
};

export function readEmbeddedViewer() {
  if (window.parent === window || !relayViewerLauncherOrigin(new URL(location.href)))
    return undefined;
  try {
    if (
      window.parent.location.origin !== location.origin ||
      window.parent.location.pathname !== RELAY_VIEWER_FRAME_PATH
    )
      return undefined;
    return (window.parent as RelayViewerDocument).cafeRelayViewer;
  } catch {
    return undefined;
  }
}

async function startFrame(port: MessagePort, data: Record<string, unknown>): Promise<void> {
  requireRelay(
    typeof data.environmentId === "string" &&
      typeof data.httpBaseUrl === "string" &&
      typeof data.wsBaseUrl === "string" &&
      "serviceWorker" in navigator,
  );
  const identity = {
    environmentId: data.environmentId,
    httpBaseUrl: data.httpBaseUrl,
    wsBaseUrl: data.wsBaseUrl,
  };
  const lifetime = new Lifetime();
  const deadline = lifetime.deadline(VIEWER_STARTUP_MS);
  deadline.signal.addEventListener("abort", () => port.postMessage("failed"), { once: true });
  const browserRelay = makeEmbeddedViewerRelay(identity, port);
  let admittedWorker: ServiceWorker | null = null;
  const assets = (event: MessageEvent<unknown>) => {
    const { data, ports } = event;
    if (
      event.source !== admittedWorker ||
      !isViewerMessage(data) ||
      data.kind !== VIEWER_ASSET ||
      typeof data.file !== "string" ||
      ports.length !== 1
    )
      return;
    const reply = ports[0]!;
    const transfer = lifetime.deadline(60_000);
    void viewerRequest(port, { kind: "asset", file: data.file }, transfer.signal)
      .then((value) =>
        reply.postMessage(value, value.body instanceof ArrayBuffer ? [value.body] : []),
      )
      .catch(() => reply.postMessage({ kind: "error" }))
      .finally(() => {
        transfer.cancel();
        reply.close();
      });
  };
  const worker = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration | undefined;
  worker.addEventListener("message", assets);
  window.addEventListener(
    "pagehide",
    () => {
      worker.removeEventListener("message", assets);
      lifetime.retire();
      void browserRelay.close();
      void registration?.unregister().catch(() => {});
      port.close();
    },
    { once: true },
  );
  const controller = deferred<ServiceWorker>();
  void controller.promise.catch(() => {});
  const abortControllerWait = () => controller.reject(deadline.signal.reason);
  deadline.signal.addEventListener("abort", abortControllerWait, { once: true });
  const checkController = () => {
    const current = worker.controller;
    if (current && new URL(current.scriptURL).pathname === RELAY_VIEWER_WORKER_PATH)
      controller.resolve(current);
  };
  worker.addEventListener("controllerchange", checkController);
  try {
    registration = await worker.register(RELAY_VIEWER_WORKER_PATH, {
      scope: "/",
      updateViaCache: "none",
    });
    checkController();
    admittedWorker = await controller.promise;
    deadline.signal.throwIfAborted();
  } finally {
    worker.removeEventListener("controllerchange", checkController);
    deadline.signal.removeEventListener("abort", abortControllerWait);
  }
  (window as RelayViewerDocument).cafeRelayViewer = Object.freeze({
    relay: Object.freeze(browserRelay),
    started: () => {
      deadline.cancel();
      port.postMessage("started");
    },
  });
  const app = document.createElement("iframe");
  app.title = "Cafe Code workspace";
  app.allow = "clipboard-write 'src'";
  app.src = "/";
  document.body.append(app);
}

export function acceptHostViewer(): void {
  const parent = relayViewerLauncherOrigin(new URL(location.href));
  if (!parent || window.parent === window) return;
  function receive(event: MessageEvent<unknown>) {
    if (
      event.source !== window.parent ||
      event.origin !== parent ||
      !isViewerMessage(event.data) ||
      event.data.kind !== VIEWER_START ||
      event.ports.length !== 1
    )
      return;
    window.removeEventListener("message", receive);
    const port = event.ports[0]!;
    void startFrame(port, event.data).catch(() => port.postMessage("failed"));
  }
  window.addEventListener("message", receive);
  window.parent.postMessage(VIEWER_READY, parent);
}
