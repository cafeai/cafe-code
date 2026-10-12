import {
  UI_DIRECTION,
  resolveUiLocale,
  uiMessageParts,
  uiText,
  type UiLocale,
} from "@cafecode/shared/i18n";
import Mime from "@effect/platform-node/Mime";
import {
  CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH,
  CAFE_CODE_HTTPS_CERTIFICATE_PATH,
} from "@cafecode/shared/environmentEndpoint";
import { MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES } from "@cafecode/contracts/settings";
import { decodeOtlpTraceRecords } from "@cafecode/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { ensureHttpsCertificateMaterial } from "./httpsCertificate.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import {
  WebPushNotifications,
  type WebPushNotificationsError,
  WebPushSubscriptionInput,
} from "./notifications/WebPushNotifications.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { BrandingImageError, BrandingImageStore } from "./branding/BrandingImageStore.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PRIVATE_HASHED_ASSET_CACHE_CONTROL = "private, max-age=31536000, immutable";
const HTML_CACHE_CONTROL = "no-store";
const PWA_CONTROL_FILE_CACHE_CONTROL = "no-cache";
const STATIC_FILE_CACHE_CONTROL = "public, max-age=3600";
const BRANDING_IMAGE_ROUTE_PREFIX = "/api/branding/sidebar-image/";

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

// Remote peer addresses that mean "this machine". IPv4-mapped IPv6 (::ffff:127.x)
// and the IPv4 loopback range are both treated as loopback so the desktop app and
// same-machine browser are never shown the HTTPS bootstrap page.
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", ""]);

export function isLoopbackRemoteAddress(address: string): boolean {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    LOOPBACK_REMOTE_ADDRESSES.has(normalized) ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

function acceptsContentEncoding(rawHeader: string | undefined, encoding: "br" | "gzip"): boolean {
  if (!rawHeader) return false;

  for (const rawToken of rawHeader.split(",")) {
    const [rawCoding, ...rawParameters] = rawToken.split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (!coding || (coding !== encoding && coding !== "*")) {
      continue;
    }

    const qParameter = rawParameters.find((parameter) =>
      parameter.trim().toLowerCase().startsWith("q="),
    );
    const quality = qParameter ? Number(qParameter.split("=")[1]?.trim()) : 1;
    if (!Number.isFinite(quality) || quality > 0) {
      return true;
    }
  }

  return false;
}

function cacheControlForStaticResponse(input: {
  readonly requestPath: string;
  readonly filePath: string;
  readonly isHtmlFallback: boolean;
}): string {
  if (input.isHtmlFallback || input.filePath.toLowerCase().endsWith(".html")) {
    return HTML_CACHE_CONTROL;
  }

  if (input.requestPath.startsWith("/assets/")) {
    return HASHED_ASSET_CACHE_CONTROL;
  }

  const requestPath = input.requestPath.toLowerCase();
  if (requestPath === "/sw.js" || requestPath.endsWith(".webmanifest")) {
    return PWA_CONTROL_FILE_CACHE_CONTROL;
  }

  return STATIC_FILE_CACHE_CONTROL;
}

function staticResponseHeaders(input: {
  readonly cacheControl: string;
  readonly contentEncoding?: "br" | "gzip";
}): Record<string, string> {
  return {
    "Cache-Control": input.cacheControl,
    Vary: "Accept-Encoding",
    ...(input.contentEncoding ? { "Content-Encoding": input.contentEncoding } : {}),
  };
}

const serveStaticFile = (input: {
  readonly filePath: string;
  readonly requestPath: string;
  readonly isHtmlFallback: boolean;
  readonly acceptEncoding: string | undefined;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contentType = Mime.getType(input.filePath) ?? "application/octet-stream";
    const cacheControl = cacheControlForStaticResponse({
      requestPath: input.requestPath,
      filePath: input.filePath,
      isHtmlFallback: input.isHtmlFallback,
    });
    const compressedCandidates: ReadonlyArray<{
      readonly encoding: "br" | "gzip";
      readonly filePath: string;
    }> = [
      { encoding: "br", filePath: `${input.filePath}.br` },
      { encoding: "gzip", filePath: `${input.filePath}.gz` },
    ];

    for (const candidate of compressedCandidates) {
      if (!acceptsContentEncoding(input.acceptEncoding, candidate.encoding)) {
        continue;
      }

      const exists = yield* fileSystem
        .exists(candidate.filePath)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!exists) {
        continue;
      }

      const data = yield* fileSystem
        .readFile(candidate.filePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!data) {
        break;
      }

      return HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType,
        headers: staticResponseHeaders({
          cacheControl,
          contentEncoding: candidate.encoding,
        }),
      });
    }

    const data = yield* fileSystem
      .readFile(input.filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: staticResponseHeaders({ cacheControl }),
    });
  });

// True when the request reached this HTTP server through the HTTPS sibling proxy,
// which stamps these headers (see httpsSiblingServer.ts). Such requests are already
// encrypted end-to-end for the client, so they must be served the real app.
function isViaHttpsProxy(headers: Record<string, string | undefined>): boolean {
  return headers["x-cafe-code-https-proxy"] === "1" || headers["x-forwarded-proto"] === "https";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Minimal, self-contained (no external assets) page shown to external clients that
// hit the plain-HTTP listener while HTTPS is enabled. It explains how to trust the
// self-signed certificate and links to the secure site, instead of serving the app
// over cleartext.
export function renderHttpsBootstrapPage(input: {
  readonly hostname: string;
  readonly httpsPort: number;
  readonly uiLocale?: UiLocale;
}): string {
  const locale = resolveUiLocale(input.uiLocale ?? "en");
  const secureOrigin = `https://${input.hostname}:${input.httpsPort}/`;
  const secureOriginAttr = escapeHtml(secureOrigin);
  const certPathAttr = escapeHtml(CAFE_CODE_HTTPS_CERTIFICATE_PATH);
  // Catalogs supply text and named slots, never executable HTML. Only these
  // code-owned tags survive escaping; URL attributes stay independently bound.
  type TrustedHtml = { readonly html: string };
  const renderParts = (parts: readonly (string | TrustedHtml)[]): string =>
    parts.map((part) => (typeof part === "string" ? escapeHtml(part) : part.html)).join("");
  const strong = (chunks: (string | TrustedHtml)[]): TrustedHtml => ({
    html: `<strong>${renderParts(chunks)}</strong>`,
  });
  const iosInstructions = renderParts(
    uiMessageParts<TrustedHtml>(
      "<strong>iOS:</strong> open the downloaded profile, then enable it in Settings → General → VPN & Device Management, and turn it on under Certificate Trust Settings.",
      { strong },
      undefined,
      locale,
    ),
  );
  const androidInstructions = renderParts(
    uiMessageParts<TrustedHtml>(
      "<strong>Android:</strong> Settings → Security → install a certificate → CA certificate.",
      { strong },
      undefined,
      locale,
    ),
  );
  const openInstructions = renderParts(
    uiMessageParts<TrustedHtml>(
      "Then open <code>{origin}</code>",
      {
        origin: secureOrigin,
        code: (chunks) => ({ html: `<code>${renderParts(chunks)}</code>` }),
      },
      undefined,
      locale,
    ),
  );
  return `<!doctype html>
<html lang="${locale}" dir="${UI_DIRECTION}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(uiText("Cafe Code — secure connection required", undefined, undefined, locale))}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #f6f7f9; color: #1b1d20; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #0f1113; color: #e9eaec; } }
  .card { width: 100%; max-width: 420px; background: Canvas; border: 1px solid rgba(128,128,128,.25);
    border-radius: 16px; padding: 24px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: GrayText; }
  .btn { display: block; width: 100%; box-sizing: border-box; text-align: center;
    text-decoration: none; padding: 11px 14px; border-radius: 10px; font-weight: 600; margin-top: 10px; }
  .primary { background: #2563eb; color: #fff; }
  .secondary { border: 1px solid rgba(128,128,128,.4); color: inherit; }
  ol { margin: 14px 0 0; padding-left: 18px; color: GrayText; font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(uiText("This server uses HTTPS", undefined, undefined, locale))}</h1>
    <p>${escapeHtml(uiText("For a secure connection, install Cafe Code''s certificate on this device, then open the secure site.", undefined, undefined, locale))}</p>
    <a class="btn primary" href="${certPathAttr}" download="cafe-code.crt">${escapeHtml(uiText("Download certificate", undefined, undefined, locale))}</a>
    <a class="btn secondary" href="${secureOriginAttr}">${escapeHtml(uiText("Continue to secure site →", undefined, undefined, locale))}</a>
    <ol>
      <li>${iosInstructions}</li>
      <li>${androidInstructions}</li>
      <li>${openInstructions}</li>
    </ol>
  </div>
</body>
</html>`;
}

/** This unauthenticated public page has no access to private client settings.
 * A finite presentation query wins; otherwise only the first language range
 * matters. Never reflect arbitrary headers/query text into the document. */
export function resolveHttpsBootstrapLocale(
  query: string | null,
  acceptLanguage: string | undefined,
): UiLocale {
  if (query === "en" || query === "ja" || query === "ko") return query;
  if (typeof acceptLanguage !== "string" || acceptLanguage.length > 2_048) return "en";
  const primary = acceptLanguage.split(",", 1)[0]?.split(";", 1)[0]?.trim();
  return resolveUiLocale("system", primary ? [primary] : []);
}

// Serves the public self-signed certificate (PEM) so devices can trust the HTTPS
// listener. Reachable over plain HTTP on purpose (bootstrap), and intentionally
// unauthenticated because the certificate is public material already presented in
// every TLS handshake. The private key is never exposed here.
export const httpsCertificateRouteLayer = HttpRouter.add(
  "GET",
  CAFE_CODE_HTTPS_CERTIFICATE_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!config.httpsEnabled) {
      return HttpServerResponse.text("HTTPS is not enabled on this backend.", { status: 404 });
    }

    const material = yield* ensureHttpsCertificateMaterial(config).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!material) {
      return HttpServerResponse.text("Certificate is not available.", { status: 503 });
    }

    return HttpServerResponse.text(material.cert, {
      status: 200,
      // application/x-x509-ca-cert triggers the certificate install flow on mobile.
      contentType: "application/x-x509-ca-cert",
      headers: {
        "Content-Disposition": 'attachment; filename="cafe-code.crt"',
        "Cache-Control": "no-store",
      },
    });
  }),
);

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const serverEnvironmentRouteHandler = Effect.gen(function* () {
  const descriptor = yield* Effect.service(ServerEnvironment).pipe(
    Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
  );
  return HttpServerResponse.jsonUnsafe(descriptor, {
    status: 200,
    headers: browserApiCorsHeaders,
  });
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH,
  serverEnvironmentRouteHandler,
);

const WebPushSubscribeRequest = Schema.Struct({
  subscription: WebPushSubscriptionInput,
  label: Schema.optional(Schema.String),
});

const WebPushUnsubscribeRequest = Schema.Struct({
  endpoint: Schema.String,
});
const WebPushLocaleRequest = Schema.Struct({ subscription: WebPushSubscriptionInput });

// Hoisted compiled decoders — building these per request rebuilds the codec every time.
const decodeWebPushSubscribeRequest = Schema.decodeUnknownEffect(WebPushSubscribeRequest);
const decodeWebPushUnsubscribeRequest = Schema.decodeUnknownEffect(WebPushUnsubscribeRequest);
const decodeWebPushLocaleRequest = Schema.decodeUnknownEffect(WebPushLocaleRequest);

const respondToWebPushError = (error: WebPushNotificationsError) =>
  Effect.logWarning("web push route failed", { detail: error.detail, cause: error.cause }).pipe(
    Effect.as(HttpServerResponse.text("Web push storage failed.", { status: 500 })),
  );

const respondToBrandingImageError = (error: BrandingImageError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("branding image route failed", {
        code: error.code,
        cause: error.cause,
      });
    }
    return HttpServerResponse.text(error.message, {
      status: error.status,
      headers: browserApiCorsHeaders,
    });
  });

function decodeBrandingImageId(rawId: string): string | null {
  try {
    return decodeURIComponent(rawId);
  } catch {
    return null;
  }
}

export const webPushPublicKeyRouteLayer = HttpRouter.add(
  "GET",
  "/api/notifications/web-push/public-key",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const webPush = yield* WebPushNotifications;
    const publicKey = yield* webPush.getPublicKey();
    return HttpServerResponse.jsonUnsafe({ publicKey }, { headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("WebPushNotificationsError", respondToWebPushError),
  ),
);

export const webPushSubscribeRouteLayer = HttpRouter.add(
  "POST",
  "/api/notifications/web-push/subscriptions",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const decoded = yield* decodeWebPushSubscribeRequest(body).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (decoded === null) {
      return HttpServerResponse.text("Invalid subscription payload.", { status: 400 });
    }
    const webPush = yield* WebPushNotifications;
    yield* webPush.saveSubscription({
      subscription: decoded.subscription,
      label: decoded.label,
    });
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("WebPushNotificationsError", respondToWebPushError),
  ),
);

export const webPushUnsubscribeRouteLayer = HttpRouter.add(
  "POST",
  "/api/notifications/web-push/unsubscribe",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const decoded = yield* decodeWebPushUnsubscribeRequest(body).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (decoded === null) {
      return HttpServerResponse.text("Invalid unsubscribe payload.", { status: 400 });
    }
    const webPush = yield* WebPushNotifications;
    yield* webPush.removeSubscription(decoded.endpoint);
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("WebPushNotificationsError", respondToWebPushError),
  ),
);

export const webPushLocaleRouteLayer = HttpRouter.add(
  "POST",
  "/api/notifications/web-push/subscriptions/locale",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const decoded = yield* decodeWebPushLocaleRequest(body).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!decoded || !decoded.subscription.uiLocale)
      return HttpServerResponse.text("Invalid subscription locale payload.", { status: 400 });
    const webPush = yield* WebPushNotifications;
    yield* webPush.updateSubscriptionLocale(decoded.subscription);
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("WebPushNotificationsError", respondToWebPushError),
  ),
);

// Receives DOM/state debug events from the web UI (see
// apps/web/src/lib/mobileDebugLog.ts) and echoes them to the server log so
// mobile composer behavior can be diagnosed without devtools on the device.
// The browser debug flag is not authoritative: the server only accepts these
// diagnostics when it was explicitly started with debug logging enabled.
export const clientDebugLogRouteLayer = HttpRouter.add(
  "POST",
  "/api/client-debug-log",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.logLevel !== "Debug") {
      return HttpServerResponse.empty({ status: 404, headers: browserApiCorsHeaders });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed("<unparseable body>")));
    yield* Effect.logInfo("[client-debug]", body);
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }),
);

export const brandingSidebarImageUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/branding/sidebar-image",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentLengthHeader = request.headers["content-length"];
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
        return HttpServerResponse.text("Sidebar image is too large.", {
          status: 413,
          headers: browserApiCorsHeaders,
        });
      }
    }

    const body = yield* request.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new BrandingImageError({
            code: "invalid-image",
            status: 400,
            message: "Sidebar image data is invalid.",
            cause,
          }),
      ),
    );
    const brandingImages = yield* BrandingImageStore;
    const sidebarBrandImage = yield* brandingImages.storeUploadedImage({
      bytes: new Uint8Array(body),
      declaredMimeType: request.headers["content-type"],
    });

    return HttpServerResponse.jsonUnsafe(
      { sidebarBrandImage },
      {
        status: 200,
        headers: browserApiCorsHeaders,
      },
    );
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("BrandingImageError", respondToBrandingImageError),
  ),
);

export const brandingSidebarImageServeRouteLayer = HttpRouter.add(
  "GET",
  `${BRANDING_IMAGE_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const rawId = decodeBrandingImageId(
      url.value.pathname.slice(BRANDING_IMAGE_ROUTE_PREFIX.length),
    );
    if (!rawId) {
      return HttpServerResponse.text("Sidebar image was not found.", {
        status: 404,
        headers: browserApiCorsHeaders,
      });
    }
    const brandingImages = yield* BrandingImageStore;
    const stored = yield* brandingImages.resolveStoredImage(rawId);
    const fileSystem = yield* FileSystem.FileSystem;
    const data = yield* fileSystem.readFile(stored.filePath).pipe(
      Effect.mapError(
        (cause) =>
          new BrandingImageError({
            code: "storage-failed",
            status: 500,
            message: "Sidebar image could not be loaded.",
            cause,
          }),
      ),
    );

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType: stored.mimeType,
      headers: {
        "Cache-Control": PRIVATE_HASHED_ASSET_CACHE_CONTROL,
        ...browserApiCorsHeaders,
      },
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("BrandingImageError", respondToBrandingImageError),
  ),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    // The legacy image route must never expose generic-file bytes, private
    // metadata commitments or provider derivatives. Generic files have their
    // own authenticated, always-download route with inert text previews.
    const fileSystem = yield* FileSystem.FileSystem;
    const isLegacyBinary =
      filePath.endsWith(".bin") &&
      !(yield* fileSystem.exists(filePath.slice(0, -4) + ".metadata.json"));
    if (
      /\.(?:metadata|provider)[.-]/u.test(filePath) ||
      (!/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|heic|heif|tiff|svg)$/iu.test(filePath) &&
        !isLegacyBinary)
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ...(isLegacyBinary
          ? { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment" }
          : {}),
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    // HTTPS bootstrap: when HTTPS is enabled, do not serve the app over plain
    // cleartext HTTP to other devices. External clients that did not arrive
    // through the HTTPS proxy get a page explaining how to trust the self-signed
    // certificate and a link to the secure site. We only intercept when we can
    // positively confirm the peer is non-loopback, so the desktop app and the
    // same-machine browser (loopback HTTP) are never affected. The certificate
    // download route is a more specific route and is matched before this one, so
    // it stays reachable over HTTP for bootstrapping.
    if (config.httpsEnabled && config.httpsPort !== undefined) {
      const remoteAddress = Option.getOrUndefined(request.remoteAddress);
      const isExternalPeer = remoteAddress !== undefined && !isLoopbackRemoteAddress(remoteAddress);
      if (isExternalPeer && !isViaHttpsProxy(request.headers)) {
        return HttpServerResponse.text(
          renderHttpsBootstrapPage({
            hostname: url.value.hostname,
            httpsPort: config.httpsPort,
            uiLocale: resolveHttpsBootstrapLocale(
              url.value.searchParams.get("uiLocale"),
              request.headers["accept-language"],
            ),
          }),
          {
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      // Asset URLs identify exact build bytes. An older renderer can request a
      // retired hash after a rebuild; returning the app HTML here disguises
      // that absence as a successful module response and fails MIME admission.
      // Keep the miss uncached so a transient publication gap cannot become a
      // durable cached failure. Application routes retain their HTML fallback.
      if (url.value.pathname === "/assets" || url.value.pathname.startsWith("/assets/")) {
        return HttpServerResponse.text("Not Found", {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        });
      }

      const indexPath = path.resolve(staticRoot, "index.html");
      const indexInfo = yield* fileSystem
        .stat(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexInfo || indexInfo.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return yield* serveStaticFile({
        filePath: indexPath,
        requestPath: url.value.pathname,
        isHtmlFallback: true,
        acceptEncoding: request.headers["accept-encoding"],
      });
    }

    return yield* serveStaticFile({
      filePath,
      requestPath: url.value.pathname,
      isHtmlFallback: false,
      acceptEncoding: request.headers["accept-encoding"],
    });
  }),
);
