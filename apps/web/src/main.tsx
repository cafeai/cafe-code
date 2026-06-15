import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { installMobileDebugLogging } from "./lib/mobileDebugLog";

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

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
