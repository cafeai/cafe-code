import * as Schema from "effect/Schema";
import { parseRelayUrl, RelayError, requireRelay } from "./errors.ts";
import { Lifetime } from "./lifetime.ts";
import { canonicalBytes, HttpMethod, readCanonical, SafeCounter } from "./protocol.ts";
import type { RelaySession, RelayStream } from "./session.ts";
import { RELAY_DATA_CHUNK_BYTES, RELAY_LIMITS } from "./limits.ts";

const Header = Schema.Tuple([
  Schema.String.check(Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(4096)),
]);
const HeaderList = Schema.Array(Header).check(Schema.isMaxLength(32));
export const HttpOpen = Schema.Struct({
  method: HttpMethod,
  path: Schema.String.check(Schema.isMaxLength(4096)),
  headers: HeaderList,
});
export type HttpOpen = typeof HttpOpen.Type;
export const HttpReply = Schema.Struct({ status: SafeCounter, headers: HeaderList });
const requestHeaders = new Set([
  "authorization",
  "content-type",
  "content-length",
  "accept",
  "range",
  "if-none-match",
  "if-modified-since",
  "x-cafe-attachment-name",
  "x-cafe-thread-id",
  "x-cafe-attachment-lifecycle",
]);
const responseHeaders = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "retry-after",
  "x-cafe-auth-reason",
  "x-cafe-attachment-lifecycle",
  "x-content-type-options",
  "content-security-policy",
]);
const origin = "https://relay.cafecode.invalid";
export const RELAY_HTTP_BODY_BYTES = 26_214_400;

export function relativeAppPath(value: string): URL {
  requireRelay(
    value.length <= 4096 &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("#") &&
      !/[\u0000-\u0020\u007f]/.test(value),
  );
  const url = parseRelayUrl(origin + value);
  requireRelay(url.origin === origin && url.pathname + url.search === value);
  requireRelay(!/%(?:2f|5c|2e)/i.test(url.pathname));
  return url;
}
export function filteredHeaders(
  headers: Headers,
  direction: "request" | "response",
): Array<[string, string]> {
  const allowed = direction === "request" ? requestHeaders : responseHeaders;
  const output: Array<[string, string]> = [];
  for (const [name, value] of headers) if (allowed.has(name)) output.push([name, value]);
  canonicalBytes(output);
  requireRelay(output.length <= 32);
  return output;
}
export function checkedHeaders(
  entries: readonly (readonly [string, string])[],
  direction: "request" | "response",
): Headers {
  const allowed = direction === "request" ? requestHeaders : responseHeaders,
    headers = new Headers();
  for (const [name, value] of entries) {
    requireRelay(
      allowed.has(name) &&
        name === name.toLowerCase() &&
        !headers.has(name) &&
        !/[\r\n\u0000]/.test(value),
    );
    headers.set(name, value);
  }
  const length = headers.get("content-length");
  if (length !== null)
    requireRelay(/^(?:0|[1-9]\d{0,8})$/.test(length) && Number(length) <= RELAY_HTTP_BODY_BYTES);
  return headers;
}

async function writeBody(
  stream: RelayStream,
  body: ReadableStream<Uint8Array> | null,
  expected: string | null,
  finish = true,
): Promise<void> {
  let length = 0;
  const reader = body?.getReader();
  try {
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        // Existing application routes may return one already-buffered file.
        // Its ordinary 25 MiB application body bound is separate from encrypted
        // transport retention. Send bounded views under stream/channel credit.
        requireRelay(next.value.byteLength <= RELAY_HTTP_BODY_BYTES, "BUSY");
        length += next.value.byteLength;
        requireRelay(length <= RELAY_HTTP_BODY_BYTES, "BUSY");
        for (let offset = 0; offset < next.value.byteLength; offset += RELAY_DATA_CHUNK_BYTES)
          await stream.write(next.value.subarray(offset, offset + RELAY_DATA_CHUNK_BYTES));
      }
    requireRelay(expected === null || length === Number(expected), "INCOMPLETE");
    if (finish) await stream.finish();
  } catch (error) {
    stream.retire();
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

function slicedBlob(blob: Blob): ReadableStream<Uint8Array> {
  let offset = 0,
    active = true;
  return new ReadableStream(
    {
      async pull(controller) {
        if (offset >= blob.size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + RELAY_DATA_CHUNK_BYTES, blob.size),
          bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        if (!active) return;
        offset = end;
        controller.enqueue(bytes);
      },
      cancel() {
        active = false;
      },
    },
    { highWaterMark: 0 },
  );
}

function readBody(
  stream: RelayStream,
  expected: string | null,
  completed: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let length = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const bytes = await stream.read();
          if (!bytes) {
            requireRelay(expected === null || length === Number(expected), "INCOMPLETE");
            completed();
            controller.close();
            return;
          }
          length += bytes.byteLength;
          requireRelay(length <= RELAY_HTTP_BODY_BYTES, "BUSY");
          controller.enqueue(bytes.slice());
        } catch {
          stream.retire();
          controller.error(new RelayError("INCOMPLETE"));
          completed();
        }
      },
      cancel() {
        stream.retire();
        completed();
      },
    },
    { highWaterMark: 0 },
  );
}

export async function fetchRelayed(
  session: RelaySession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  relativeAppPath(path);
  requireRelay(session.auth && session.active, "AUTH_REQUIRED");
  if (init.body instanceof Blob) requireRelay(init.body.size <= RELAY_HTTP_BODY_BYTES, "BUSY");
  if (typeof init.body === "string")
    requireRelay(init.body.length <= RELAY_LIMITS.dataBytes, "BUSY");
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + session.auth.bearerToken);
  const requestInit = {
    ...init,
    headers,
    credentials: "omit" as const,
    redirect: "error" as const,
    duplex: "half" as const,
  };
  const request = new Request(origin + path, requestInit);
  const outgoingHeaders = new Headers(request.headers);
  if (init.body instanceof Blob) outgoingHeaders.set("content-length", String(init.body.size));
  const metadata = readCanonical(
    HttpOpen,
    canonicalBytes({
      method: request.method,
      path,
      headers: filteredHeaders(outgoingHeaders, "request"),
    }),
  );
  const stream = await session.open("http", metadata, init.signal ?? undefined),
    lifetime = new Lifetime(() => stream.retire());
  const retire = () => {
    stream.retire();
    lifetime.retire();
  };
  const cancel = lifetime.later(RELAY_LIMITS.httpMs, retire);
  const abort = () => retire();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) retire();
  const completed = () => {
    cancel();
    lifetime.retire();
    init.signal?.removeEventListener("abort", abort);
  };
  const upload = writeBody(
    stream,
    init.body instanceof Blob ? slicedBlob(init.body) : request.body,
    outgoingHeaders.get("content-length"),
  );
  void upload.catch(retire);
  try {
    const reply = readCanonical(HttpReply, canonicalBytes(await stream.metadata));
    requireRelay(
      reply.status >= 200 && reply.status <= 599 && (reply.status < 300 || reply.status >= 400),
    );
    const responseHeaders = checkedHeaders(reply.headers, "response");
    if (request.method === "HEAD" || [204, 205, 304].includes(reply.status)) {
      requireRelay((await stream.read()) === undefined, "INCOMPLETE");
      await upload;
      completed();
      return new Response(null, { status: reply.status, headers: responseHeaders });
    }
    return new Response(readBody(stream, responseHeaders.get("content-length"), completed), {
      status: reply.status,
      headers: responseHeaders,
    });
  } catch (error) {
    retire();
    completed();
    throw error instanceof RelayError ? error : new RelayError("UNAVAILABLE");
  }
}

/** Dispatches only into the supplied app handler; never dials a local URL. */
export async function serveRelayedHttp(
  stream: RelayStream,
  value: unknown,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const metadata = readCanonical(HttpOpen, canonicalBytes(value)),
    url = relativeAppPath(metadata.path),
    headers = checkedHeaders(metadata.headers, "request");
  const lifetime = new Lifetime(() => stream.retire());
  const cancel = lifetime.later(RELAY_LIMITS.httpMs, () => stream.retire());
  const noBody = metadata.method === "GET" || metadata.method === "HEAD";
  try {
    if (noBody) requireRelay((await stream.read()) === undefined, "INCOMPLETE");
    const body = noBody ? null : readBody(stream, headers.get("content-length"), () => {});
    const init = {
      method: metadata.method,
      headers,
      signal: stream.signal,
      ...(body ? { body } : {}),
      duplex: "half" as const,
    };
    const response = await handler(new Request(url, init));
    const replyHeaders = filteredHeaders(response.headers, "response");
    checkedHeaders(replyHeaders, "response");
    await stream.accept({ status: response.status, headers: replyHeaders });
    await writeBody(
      stream,
      metadata.method === "HEAD" ? null : response.body,
      metadata.method === "HEAD" ? null : response.headers.get("content-length"),
      false,
    );
    if (!stream.remoteFinished && body && !body.locked) {
      const reader = body.getReader();
      try {
        while (!(await reader.read()).done) {
          /* Drain only this bounded authenticated request. */
        }
      } finally {
        reader.releaseLock();
      }
    }
    await stream.incomingComplete;
    await stream.finish();
  } finally {
    cancel();
    await lifetime.close();
  }
}
