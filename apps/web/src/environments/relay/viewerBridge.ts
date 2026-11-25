import { RelayError, requireRelay } from "@cafecode/relay/errors";
import { relativeAppPath, RELAY_HTTP_BODY_BYTES } from "@cafecode/relay/http";
import { RELAY_RPC_MESSAGE_BYTES } from "@cafecode/relay/ndjson";
import { Lifetime } from "@cafecode/relay/lifetime";
import { deferred } from "@cafecode/relay/deferred";
import type { BrowserRelay } from "./active";

export const VIEWER_READY = "cafe-relay-viewer-ready-v1";
export const VIEWER_START = "cafe-relay-viewer-start-v1";
export const VIEWER_ASSET = "cafe-relay-viewer-asset-v1";
export const VIEWER_STARTUP_MS = 90_000;
const VIEWER_RPC_QUEUE = 64;

export type ViewerIdentity = Pick<BrowserRelay, "environmentId" | "httpBaseUrl" | "wsBaseUrl">;
export type ViewerAsset = { body: ArrayBuffer; contentType: string };
export type ViewerAssetSource = (
  file: string,
  signal: AbortSignal,
) => Promise<ViewerAsset | undefined>;

export function isViewerMessage(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function viewerRequest(
  port: MessagePort,
  message: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => {
      signal.removeEventListener("abort", abort);
      channel.port1.close();
    };
    const abort = () => {
      channel.port1.postMessage("cancel");
      close();
      reject(new RelayError("UNAVAILABLE"));
    };
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      close();
      if (isViewerMessage(data) && data.kind === "reply") resolve(data);
      else reject(new RelayError("UNAVAILABLE"));
    };
    channel.port1.onmessageerror = abort;
    signal.addEventListener("abort", abort, { once: true });
    try {
      port.postMessage(message, [channel.port2]);
    } catch {
      close();
      channel.port2.close();
      reject(new RelayError("UNAVAILABLE"));
    }
  });
}

async function responseBytes(response: Response): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      requireRelay(size <= RELAY_HTTP_BODY_BYTES, "BUSY");
      parts.push(result.value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output.buffer;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function handleHttp(
  relay: BrowserRelay,
  message: Record<string, unknown>,
  signal: AbortSignal,
) {
  const { method, path, headers, body } = message;
  requireRelay(
    typeof path === "string" &&
      typeof method === "string" &&
      /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method) &&
      Array.isArray(headers) &&
      headers.length <= 32 &&
      headers.every(
        (entry: unknown) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[0].length <= 128 &&
          entry[1].length <= 4096,
      ),
  );
  const url = relativeAppPath(path);
  requireRelay(
    url.pathname === "/.well-known/cafe-code/environment" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/attachments/"),
  );
  // Keep code delivery in its separately authenticated, byte-bound lane.
  requireRelay(!url.pathname.startsWith("/api/relay/viewer/"));
  requireRelay(
    body === undefined ||
      (typeof body === "string" && body.length <= 16_384) ||
      (body instanceof Blob && body.size <= RELAY_HTTP_BODY_BYTES),
  );
  const requestHeaders = new Headers(headers);
  requestHeaders.delete("authorization");
  const response = await relay.request(path, {
    method,
    headers: requestHeaders,
    body: body ?? null,
    signal,
  });
  return {
    body: await responseBytes(response),
    status: response.status,
    headers: [...response.headers],
  };
}

function bindSocket(relay: BrowserRelay, path: string, port: MessagePort, signal: AbortSignal) {
  const url = relativeAppPath(path);
  requireRelay(
    url.pathname === "/ws" && [...url.searchParams.keys()].every((key) => key === "wsToken"),
  );
  const socket = relay.socket(new URL(path, relay.wsBaseUrl).href);
  const done = deferred<void>();
  const close = () => {
    socket.close();
    done.resolve();
  };
  signal.addEventListener("abort", close, { once: true });
  socket.onopen = () => port.postMessage({ kind: "open" });
  socket.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data === "string" && data.length <= RELAY_RPC_MESSAGE_BYTES)
      port.postMessage({ kind: "message", data });
    else close();
  };
  socket.onerror = () => port.postMessage({ kind: "error" });
  socket.onclose = ({ code }) => {
    port.postMessage({ kind: "close", code });
    done.resolve();
  };
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (data === "close") return close();
    if (!isViewerMessage(data) || data.kind !== "send" || typeof data.data !== "string")
      return close();
    try {
      socket.send(data.data);
      port.postMessage({ kind: "sent", size: data.data.length });
    } catch {
      close();
    }
  };
  port.onmessageerror = close;
  if (signal.aborted) close();
  return done.promise.finally(() => signal.removeEventListener("abort", close));
}

/** The only capabilities on this port are the selected host's app connection
 * and verified build files. It cannot select, inspect or switch relay targets. */
export function serveViewerBridge(
  relay: BrowserRelay,
  assets: ViewerAssetSource,
  lifetime: Lifetime,
  type: unknown,
  port: MessagePort,
): Promise<void> {
  if (!lifetime.active || !isViewerMessage(type)) {
    port.close();
    return Promise.resolve();
  }
  const cancellation = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, cancellation.signal]);
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (data === "cancel") cancellation.abort();
  };
  return (async () => {
    try {
      if (type.kind === "socket" && typeof type.path === "string") {
        await bindSocket(relay, type.path, port, signal);
        return;
      }
      const value =
        type.kind === "asset" && typeof type.file === "string"
          ? await assets(type.file, signal)
          : type.kind === "http"
            ? await handleHttp(relay, type, signal)
            : undefined;
      if (signal.aborted) return;
      if (value) {
        port.postMessage({ kind: "reply", ...value }, value.body === null ? [] : [value.body]);
      } else port.postMessage({ kind: "reply", status: 404 });
    } catch {
      if (!signal.aborted) port.postMessage({ kind: "error" });
    } finally {
      port.close();
    }
  })();
}

class ViewerSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly extensions = "";
  readonly protocol = "cafe-relay.ndjson";
  binaryType: BinaryType = "arraybuffer";
  readyState: number = this.CONNECTING;
  bufferedAmount = 0;
  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  private readonly port: MessagePort;
  private readonly pending: number[] = [];

  constructor(
    readonly url: string,
    bridge: MessagePort,
  ) {
    super();
    const channel = new MessageChannel();
    this.port = channel.port1;
    const target = new URL(url);
    this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!isViewerMessage(data) || this.readyState === this.CLOSED) return;
      if (data.kind === "open") {
        this.readyState = this.OPEN;
        this.publish(new Event("open"), this.onopen);
      } else if (data.kind === "message" && typeof data.data === "string") {
        this.publish(new MessageEvent("message", { data: data.data }), this.onmessage);
      } else if (data.kind === "sent" && data.size === this.pending[0]) {
        this.bufferedAmount -= this.pending.shift()!;
      } else if (data.kind === "close") this.finish(data.code === 1000 ? 1000 : 1006);
      else this.fail();
    };
    this.port.onmessageerror = () => this.fail();
    try {
      bridge.postMessage({ kind: "socket", path: target.pathname + target.search }, [
        channel.port2,
      ]);
    } catch {
      channel.port2.close();
      queueMicrotask(() => this.fail());
    }
  }

  private publish<E extends Event>(
    event: E,
    handler: ((this: WebSocket, event: E) => unknown) | null,
  ) {
    this.dispatchEvent(event);
    handler?.call(this, event);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    requireRelay(
      this.readyState === this.OPEN &&
        typeof data === "string" &&
        this.pending.length < VIEWER_RPC_QUEUE &&
        this.bufferedAmount + data.length <= RELAY_RPC_MESSAGE_BYTES,
      "BUSY",
    );
    this.pending.push(data.length);
    this.bufferedAmount += data.length;
    this.port.postMessage({ kind: "send", data });
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.port.postMessage("close");
    this.finish(1000);
  }

  private fail() {
    this.publish(new Event("error"), this.onerror);
    this.finish(1006);
  }

  private finish(code: number) {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.bufferedAmount = 0;
    this.pending.length = 0;
    this.port.close();
    this.publish(new CloseEvent("close", { code, wasClean: code === 1000 }), this.onclose);
  }
}

export function makeEmbeddedViewerRelay(identity: ViewerIdentity, port: MessagePort): BrowserRelay {
  const lifetime = new Lifetime();
  return {
    ...identity,
    request: async (path, init) => {
      const signal = AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]);
      const reply = await viewerRequest(
        port,
        {
          kind: "http",
          path,
          method: init?.method ?? "GET",
          headers: [...new Headers(init?.headers)],
          body: init?.body ?? undefined,
        },
        signal,
      );
      requireRelay(typeof reply.status === "number" && Array.isArray(reply.headers));
      return new Response(reply.body instanceof ArrayBuffer ? reply.body : null, {
        status: reply.status,
        headers: reply.headers,
      });
    },
    socket: (url) => new ViewerSocket(url, port),
    close: () => lifetime.close(),
  };
}
