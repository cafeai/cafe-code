import { ipcRenderer } from "electron";
import { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "@cafecode/shared/mcpAppJson";
import type {
  VisualizationHostPresentation,
  VisualizationHostDisplayMode,
} from "@cafecode/contracts/visualizationHost";
import {
  VisualizationAppContextPresenter,
  type VisualizationAppContext,
} from "./visualizations/visualizationAppContext.ts";

/** Presentation is copied only from the trusted native private channel. */
function applyPresentation(
  appearance: "light" | "dark",
  value?: VisualizationHostPresentation,
): void {
  document.documentElement.style.colorScheme = appearance;
  if (value) {
    document.documentElement.lang = value.locale;
    document.documentElement.dataset.cafeReducedMotion = String(value.reducedMotion);
    document.documentElement.style.setProperty("--cafe-interface-scale", String(value.scale));
    const names = {
      background: "--background",
      foreground: "--foreground",
      muted: "--muted-foreground",
      accent: "--accent",
      accentForeground: "--accent-foreground",
      chart1: "--chart-1",
      chart2: "--chart-2",
      chart3: "--chart-3",
      chart4: "--chart-4",
      chart5: "--chart-5",
      chart6: "--chart-6",
    } as const;
    for (const key of Object.keys(names) as (keyof typeof names)[])
      document.documentElement.style.setProperty(names[key], value.colors[key]);
  }
  window.dispatchEvent(
    new CustomEvent("cafe-presentation-changed", { detail: { appearance, presentation: value } }),
  );
}

// This sandboxed isolated world exposes no contextBridge, Node or native API to
// generated/App source. The exact inert top frame is admitted by native main
// before this private loader receives bytes. No child frame is required.
if (process.isMainFrame === true) {
  const pageChannel = "cafe-visualization:page-data";
  const contextChannel = "cafe-visualization:context";
  const installedChannel = "cafe-visualization:installed";
  const frameChannel = "cafe-visualization:frame";
  const maximum = 128 * 1024;
  let sequence = 0;
  let epoch = performance.now();
  let messages = 0;
  let heartbeat = 0;
  let installed = false;
  let appRelay = false;
  let appContext: VisualizationAppContextPresenter | undefined;
  let currentContext: VisualizationAppContext | undefined;
  // Main records receipt time itself. A page CPU loop blocks this renderer's
  // isolated timer as well, while the separately owned main watchdog still runs.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const startHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(
      () => ipcRenderer.send("cafe-visualization:heartbeat", ++heartbeat),
      250,
    );
  };
  startHeartbeat();

  const relay = (event: MessageEvent<unknown>): void => {
    if (!appRelay || event.source !== window || !event.isTrusted) return;
    // The SDK uses parent===self in this dedicated top frame. Consume its actual
    // self-posted outgoing RPC before later main-world SDK listeners see it;
    // otherwise it could mistake its own request for a host notification.
    event.stopImmediatePropagation();
    if (
      event.ports.length !== 0 ||
      event.data === null ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      return;
    const now = performance.now();
    if (now - epoch >= 1000) {
      epoch = now;
      messages = 0;
    }
    if (++messages > 30) return;
    try {
      const json = encodeBoundedMcpAppJson(event.data, maximum);
      if (json === undefined) return;
      appContext?.observeOutgoing(event.data);
      ipcRenderer.send(pageChannel, { sequence: ++sequence, json });
    } catch {
      /* Received data never becomes a native error or chat toast. */
    }
  };

  const deliver = (value: unknown): void => {
    const json = encodeBoundedMcpAppJson(value, maximum);
    if (json === undefined) return;
    window.dispatchEvent(
      new MessageEvent("message", { data: value, source: window.parent, origin: location.origin }),
    );
  };

  const nativeContext = (
    appearance: "light" | "dark",
    value: VisualizationHostPresentation | undefined,
    dimensions: { width: number; height: number },
    displayMode: VisualizationHostDisplayMode,
  ): VisualizationAppContext => ({
    theme: appearance,
    locale: value?.locale ?? currentContext?.locale ?? "en",
    reducedMotion: value?.reducedMotion ?? currentContext?.reducedMotion ?? false,
    scale: value?.scale ?? currentContext?.scale ?? 1,
    displayMode,
    containerDimensions: dimensions,
  });

  ipcRenderer.on(contextChannel, (_event, raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const value = raw as {
      kind?: unknown;
      html?: unknown;
      documentKind?: unknown;
      preview?: unknown;
      appearance?: unknown;
      json?: unknown;
      presentation?: VisualizationHostPresentation;
      containerDimensions?: { width: number; height: number };
      displayMode?: VisualizationHostDisplayMode;
      token?: unknown;
    };
    if (
      value.kind === "install" &&
      !installed &&
      typeof value.html === "string" &&
      value.html.length <= 600 * 1024 &&
      (value.documentKind === "generated" || value.documentKind === "mcp-app")
    ) {
      installed = true;
      appRelay = value.documentKind === "mcp-app";
      if (
        appRelay &&
        (value.appearance === "light" || value.appearance === "dark") &&
        value.containerDimensions
      ) {
        currentContext = nativeContext(
          value.appearance,
          value.presentation,
          value.containerDimensions,
          value.displayMode ?? "inline",
        );
        appContext = new VisualizationAppContextPresenter(currentContext, value.preview === true);
      }
      try {
        // A document.open replacement owns a new timer lifecycle. Retire our
        // bootstrap pulse before it and re-arm only after parsing returns. A
        // blocked source never receives a pulse and main's fixed watchdog wins.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        document.open();
        // document.open clears Window DOM listeners. Reinstall before parsing
        // any private source, retaining the isolated IPC closure and heartbeat.
        window.addEventListener("message", relay, { capture: true });
        document.write(value.html);
        document.close();
        startHeartbeat();
        if (value.appearance === "light" || value.appearance === "dark")
          applyPresentation(value.appearance, value.presentation);
        // Main's absolute startup budget and independent heartbeat watchdog
        // govern blocked source. Two genuine frame callbacks yield source DOM
        // mutations to rendering; they are not pixel or retirement evidence.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => ipcRenderer.send(installedChannel, true)),
        );
      } catch {
        ipcRenderer.send(installedChannel, false);
      }
    } else if (
      installed &&
      value.kind === "frame" &&
      typeof value.token === "string" &&
      /^[a-f0-9-]{36}$/.test(value.token)
    ) {
      const token = value.token;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => ipcRenderer.send(frameChannel, token)),
      );
    } else if (
      installed &&
      value.kind === "message" &&
      typeof value.json === "string" &&
      value.json.length <= maximum
    ) {
      try {
        // Synthetic replies reach the SDK's source===parent check but are never
        // re-forwarded by our isTrusted-only listener. No native API is exposed.
        const parsed = readBoundedMcpAppJson(value.json, maximum);
        if (parsed.ok) deliver(appContext?.receive(parsed.value) ?? parsed.value);
      } catch {
        /* Main independently admits bounded JSON. */
      }
    } else if (
      installed &&
      value.kind === "presentation" &&
      (value.appearance === "light" || value.appearance === "dark")
    ) {
      applyPresentation(value.appearance, value.presentation);
      if (appContext && value.containerDimensions) {
        currentContext = nativeContext(
          value.appearance,
          value.presentation,
          value.containerDimensions,
          value.displayMode ?? currentContext?.displayMode ?? "inline",
        );
        const notification = appContext.update(currentContext);
        if (notification) deliver(notification);
      }
    }
  });
}
