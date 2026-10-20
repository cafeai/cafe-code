import { ipcRenderer } from "electron";
import { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "@cafecode/shared/mcpAppJson";
import { loadGeneratedVisualizationFontFaces } from "@cafecode/shared/visualizationFonts";
import type {
  VisualizationHostPresentation,
  VisualizationHostDisplayMode,
} from "@cafecode/contracts/visualizationHost";
import {
  VisualizationAppContextPresenter,
  type VisualizationAppContext,
} from "./visualizations/visualizationAppContext.ts";
import { observeVisualizationLayout } from "./visualizations/visualizationLayout.ts";
import {
  cancelsPendingGeneratedFontInstall,
  GENERATED_VISUALIZATION_FONTS_READY_CHANNEL,
  GeneratedVisualizationFontCommit,
  isGeneratedFontInstallNonce,
  installFontReadyGeneratedDocument,
} from "./visualizations/visualizationFontInstallation.ts";
import {
  applyVisualizationPaintVisibility,
  applyVisualizationPresentation,
} from "./visualizations/visualizationPresentation.ts";

/** Presentation is copied only from the trusted native private channel. */
function applyPresentation(
  appearance: "light" | "dark",
  value?: VisualizationHostPresentation,
  generated = false,
  contextChanged = false,
): void {
  applyVisualizationPresentation(document, window, appearance, value, generated, contextChanged);
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
  let sourceReady = false;
  let generatedFontPending = false;
  let generatedInstallCancelled = false;
  let pendingGeneratedCommit: GeneratedVisualizationFontCommit | undefined;
  let pendingGeneratedPresentation:
    | { appearance: "light" | "dark"; value: VisualizationHostPresentation | undefined }
    | undefined;
  let appRelay = false;
  let generatedWheel = false;
  let wheelSequence = 0;
  let appContext: VisualizationAppContextPresenter | undefined;
  let currentContext: VisualizationAppContext | undefined;
  let layoutContextEpoch = 0;
  let layoutInline = true;
  // Main records receipt time itself. A page CPU loop blocks this renderer's
  // isolated timer as well, while the separately owned main watchdog still runs.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const startHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // Native lifecycle timer: retain callback ownership, cancellation and ref/unref semantics.
    // @effect-diagnostics-next-line globalTimers:off
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

  /** Only a real native wheel at a generated document edge can request bounded
   * scrolling of its exact host timeline. DOM synthetic events, modified chart
   * gestures and unknown/deep scroll ancestry remain inside the guest. */
  const wheel = (event: WheelEvent): void => {
    if (
      !generatedWheel ||
      !event.isTrusted ||
      !event.cancelable ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !(event.target instanceof Element)
    )
      return;
    const multiplier =
      event.deltaMode === 0
        ? 1
        : event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? Math.min(2000, innerHeight)
            : 0;
    const deltaX = event.deltaX * multiplier,
      deltaY = event.deltaY * multiplier;
    if (
      !multiplier ||
      !Number.isFinite(deltaX) ||
      !Number.isFinite(deltaY) ||
      Math.abs(deltaX) > 2048 ||
      Math.abs(deltaY) > 2048 ||
      (!deltaX && !deltaY)
    )
      return;
    let target: Element | null = event.target;
    let depth = 0;
    while (target && depth++ < 16) {
      const style = getComputedStyle(target);
      const root = target === document.scrollingElement;
      const canY =
        (root || ["auto", "scroll", "overlay"].includes(style.overflowY)) &&
        (deltaY < 0
          ? target.scrollTop > 0
          : deltaY > 0 && target.scrollTop + target.clientHeight < target.scrollHeight - 1);
      const canX =
        (root || ["auto", "scroll", "overlay"].includes(style.overflowX)) &&
        (deltaX < 0
          ? target.scrollLeft > 0
          : deltaX > 0 && target.scrollLeft + target.clientWidth < target.scrollWidth - 1);
      if (canY || canX) return;
      target = target.parentElement;
    }
    if (target) return;
    const now = performance.now();
    if (now - epoch >= 1000) {
      epoch = now;
      messages = 0;
    }
    if (++messages > 30) return;
    event.preventDefault();
    ipcRenderer.send("cafe-visualization:wheel", { sequence: ++wheelSequence, deltaX, deltaY });
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
      visible?: unknown;
      layoutNonce?: unknown;
      layoutContextEpoch?: unknown;
      fontInstallNonce?: unknown;
    };
    if (cancelsPendingGeneratedFontInstall(raw, generatedFontPending && !sourceReady)) {
      // Main can quarantine an exact still-live child when native separation
      // evidence is uncertain. That is not permission to parse after a late
      // font result. This terminal private signal does not confuse ordinary
      // bootstrap/tiny-crop/menu visibility false with installation revocation.
      generatedInstallCancelled = true;
      pendingGeneratedCommit?.cancel();
      return;
    }
    if (value.kind === "commit-install") {
      pendingGeneratedCommit?.receive(raw);
      return;
    }
    if (
      value.kind === "install" &&
      !installed &&
      typeof value.html === "string" &&
      value.html.length <= 600 * 1024 &&
      (value.documentKind === "generated" || value.documentKind === "mcp-app")
    ) {
      const sourceHtml = value.html;
      installed = true;
      if (
        value.documentKind === "generated" &&
        !isGeneratedFontInstallNonce(value.fontInstallNonce)
      ) {
        ipcRenderer.send(installedChannel, false);
        return;
      }
      appRelay = value.documentKind === "mcp-app";
      generatedWheel = value.documentKind === "generated" && value.preview !== true;
      if (
        Number.isSafeInteger(value.layoutContextEpoch) &&
        (value.layoutContextEpoch as number) > 0
      ) {
        layoutContextEpoch = value.layoutContextEpoch as number;
        layoutInline = value.displayMode !== "fullscreen";
      }
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
      const replaceSource = (faces?: readonly FontFace[]): void => {
        // Apps call this synchronous path directly and never inspect or touch
        // document.fonts. Generated font loading remains in the inert document
        // until all four fixed binary faces have independently been admitted.
        // A document.open replacement owns a new timer lifecycle. Retire our
        // bootstrap pulse before it and re-arm only after parsing returns. A
        // blocked source never receives a pulse and main's fixed watchdog wins.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        window.removeEventListener("pagehide", cancelPendingGeneratedInstall);
        document.open();
        if (faces) {
          // The desktop's DOM-only type library omits the setlike DOM.Iterable
          // augmentation. Admit this one concrete browser method at runtime,
          // without adding arbitrary API types or changing the sandbox loader.
          // Source remains unparsed, so it cannot replace the font set here.
          const fontSet = document.fonts;
          const add = Reflect.get(fontSet, "add");
          if (typeof add !== "function")
            throw new Error("Generated visualization typography is unavailable.");
          for (const face of faces) Reflect.apply(add, fontSet, [face]);
        }
        // document.open clears Window DOM listeners. Reinstall before parsing
        // any private source, retaining the isolated IPC closure and heartbeat.
        window.addEventListener("message", relay, { capture: true });
        window.addEventListener("wheel", wheel, { capture: true, passive: false });
        document.write(sourceHtml);
        document.close();
        sourceReady = true;
        generatedFontPending = false;
        pendingGeneratedCommit = undefined;
        if (
          value.documentKind === "generated" &&
          value.preview !== true &&
          typeof value.layoutNonce === "string" &&
          /^[a-f0-9-]{36}$/.test(value.layoutNonce)
        )
          observeVisualizationLayout(
            value.layoutNonce,
            (layout) => ipcRenderer.send("cafe-visualization:layout", layout),
            () => ({ epoch: layoutContextEpoch, inline: layoutInline }),
          );
        startHeartbeat();
        const latest = pendingGeneratedPresentation;
        pendingGeneratedPresentation = undefined;
        if (latest || value.appearance === "light" || value.appearance === "dark")
          applyPresentation(
            latest?.appearance ?? (value.appearance as "light" | "dark"),
            latest ? latest.value : value.presentation,
            value.documentKind === "generated",
          );
        // Main's absolute startup budget and independent heartbeat watchdog
        // govern blocked source. Two genuine frame callbacks yield source DOM
        // mutations to rendering; they are not pixel or retirement evidence.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => ipcRenderer.send(installedChannel, true)),
        );
      };
      const cancelPendingGeneratedInstall = (event: PageTransitionEvent): void => {
        // Source is still inert here. Only a real lifecycle departure cancels
        // pending readiness; a synthetic page event grants no such authority.
        if (event.isTrusted) {
          generatedInstallCancelled = true;
          pendingGeneratedCommit?.cancel();
        }
      };
      if (value.documentKind === "generated") {
        generatedFontPending = true;
        const commit = new GeneratedVisualizationFontCommit(value.fontInstallNonce as string);
        pendingGeneratedCommit = commit;
        window.addEventListener("pagehide", cancelPendingGeneratedInstall);
        if (value.appearance === "light" || value.appearance === "dark")
          pendingGeneratedPresentation = {
            appearance: value.appearance,
            value: value.presentation,
          };
        // Do not stop/rearm the bootstrap pulse while awaiting fixed fonts and
        // do not add a second deadline. Native main's original absolute startup
        // fence remains authoritative even if this asynchronous result is late.
        void installFontReadyGeneratedDocument(
          () => loadGeneratedVisualizationFontFaces("generated", globalThis.FontFace),
          () => !generatedInstallCancelled,
          () =>
            commit.request((nonce) =>
              ipcRenderer.send(GENERATED_VISUALIZATION_FONTS_READY_CHANNEL, { nonce }),
            ),
          replaceSource,
          () => ipcRenderer.send(installedChannel, false),
        );
      } else {
        // Preserve external Apps' original synchronous parse/relay lifecycle.
        // Even awaiting an empty generated-font loader here would change it.
        try {
          replaceSource();
        } catch {
          ipcRenderer.send(installedChannel, false);
        }
      }
    } else if (installed && value.kind === "visibility" && typeof value.visible === "boolean") {
      document.documentElement.dataset.cafeVisible = String(value.visible);
      window.dispatchEvent(
        new CustomEvent("cafe-visibility-changed", { detail: { visible: value.visible } }),
      );
    } else if (installed && value.kind === "presentation-visibility") {
      // The existing generated-viewer bit excludes both external Apps and
      // offscreen previews. This private data-only channel exposes no bridge.
      applyVisualizationPaintVisibility(document, window, raw, generatedWheel);
    } else if (
      installed &&
      sourceReady &&
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
      const previousEpoch = layoutContextEpoch;
      const previousInline = layoutInline;
      if (generatedFontPending)
        pendingGeneratedPresentation = { appearance: value.appearance, value: value.presentation };
      if (
        Number.isSafeInteger(value.layoutContextEpoch) &&
        (value.layoutContextEpoch as number) >= layoutContextEpoch &&
        (value.layoutContextEpoch as number) <= 100000
      ) {
        layoutContextEpoch = value.layoutContextEpoch as number;
        if (value.displayMode) layoutInline = value.displayMode !== "fullscreen";
      }
      applyPresentation(
        value.appearance,
        value.presentation,
        !appRelay,
        previousEpoch !== layoutContextEpoch || previousInline !== layoutInline,
      );
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
