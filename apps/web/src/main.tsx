import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { syncDocumentMacTrafficLightsClass } from "./lib/macTrafficLights";
import { installMobileDebugLogging } from "./lib/mobileDebugLog";
import { initializeApplicationLanguage } from "./uiLocaleStartup";
import { installWebPushLocaleSynchronization } from "./lib/webPushNotifications";

// Mobile DOM debugging — no-op unless enabled; see lib/mobileDebugLog.ts.
installMobileDebugLogging();

// Register the service worker so the web app is installable as a PWA (Add to
// Home Screen) and can receive web push. Secure browser contexts only: skipped
// in Electron (native shell) and on insecure origins where service workers are
// unavailable. `updateViaCache: "none"` avoids mobile browsers holding on to an
// older worker script while users are validating PWA installability.
if (
  !isElectron &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  window.isSecureContext
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

const recordingOverlay =
  isElectron && new URLSearchParams(window.location.search).get("cafeDictationOverlay") === "1";
const languageReady = initializeApplicationLanguage(document, recordingOverlay);
if (!isElectron) {
  void languageReady.then(() => {
    const unsubscribe = installWebPushLocaleSynchronization();
    window.addEventListener("pagehide", unsubscribe, { once: true });
  });
}

if (recordingOverlay) {
  // The macOS recording panel deliberately has no project router, sidebar,
  // providers, or ordinary composer. Its restricted preload and desktop-main
  // window identity define the security boundary; this branch only removes
  // unrelated UI/lifecycle work from a lightweight auxiliary renderer.
  void languageReady
    .then(() => import("./globalDictation/entry"))
    .then(({ mountGlobalDictation }) =>
      mountGlobalDictation(document.getElementById("root") as HTMLElement),
    );
} else {
  // Import the application graph only for an ordinary app window. Route
  // modules initialize desktop services at module load time, before React
  // mounts; loading them in the restricted dictation renderer previously
  // called an unavailable theme bridge method and prevented its ready IPC.
  void languageReady
    .then(() => import("./router"))
    .then(({ getRouter }) => {
      // Hash history avoids path resolution issues in the Electron shell.
      const history = isElectron ? createHashHistory() : createBrowserHistory();
      const router = getRouter(history);

      if (isElectron) {
        syncDocumentWindowControlsOverlayClass();
        syncDocumentMacTrafficLightsClass();
      }

      document.title = APP_DISPLAY_NAME;
      ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
        <React.StrictMode>
          <RouterProvider router={router} />
        </React.StrictMode>,
      );
    });
}
