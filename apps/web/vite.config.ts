import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { readCafeCodeEnv } from "@cafecode/shared/compatEnv";
import { defineConfig } from "vite";
import { reactCompilerConfig } from "./reactCompilerConfig.ts";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const sourcemapEnv = readCafeCodeEnv(process.env, "CAFE_CODE_WEB_SOURCEMAP")?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);

export default defineConfig({
  plugins: [tanstackRouter(), react(), babel(reactCompilerConfig), tailwindcss()],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@noble/hashes/sha2.js",
      "effect/Array",
      "effect/Order",
      "unified",
      "remark-parse",
      // This parser-owned decoder is imported by math/link normalization.
      // Prebundle it so cold browser tests do not reload during assertions.
      "micromark-util-decode-string",
    ],
  },
  define: {
    // In dev mode, tell the renderer where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    ...(devProxyTarget
      ? {
          proxy: {
            "/.well-known": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/api": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/attachments": {
              target: devProxyTarget,
              changeOrigin: true,
            },
          },
        }
      : {}),
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    chunkSizeWarningLimit: 3500,
    rolldownOptions: {
      checks: {
        invalidAnnotation: false,
        pluginTimings: false,
      },
    },
  },
});
