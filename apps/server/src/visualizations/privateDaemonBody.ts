// Native request/response events own body retirement and actual output drain.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import type * as http from "node:http";
import {
  MCP_APP_JSON_MAX_TRANSPORT_BYTES,
  readBoundedMcpAppTransportJson,
} from "@cafecode/shared/mcpAppJson";

export const PRIVATE_VISUALIZATION_DAEMON_BODY_MS = 10_000;
export const PRIVATE_VISUALIZATION_DAEMON_RESPONSE_MS = 10_000;
export const PRIVATE_VISUALIZATION_DAEMON_MAX_CHUNKS = 2048;
// This accounts only for the outer escaped owner transport. Canonical native
// App messages retain their independent 128 KiB admission at dispatch.
const MAX_BODY_BYTES = MCP_APP_JSON_MAX_TRANSPORT_BYTES;
const MAX_IN_FLIGHT = 4;
// Both new private lanes share this process-local allowance. Holding it through
// dispatch and bounded response completion prevents many small completed bodies
// from multiplying retained work or outgoing private response buffers.
// These bounds do not change the ordinary daemon RPC or scheduling policy.
let activeRequests = 0;
/** Content-free process-local observation only; not a route or authority grant. */
export const privateVisualizationDaemonRequestCount = () => activeRequests;
const invalidBody = () => new Error("Invalid private visualization request body.");
// Node may emit its received stream error after "aborted". Once admission has
// failed, discard that subsequent error rather than crashing or logging data.
const discardRetiredStreamError = () => {};

/** Count actual incoming bytes/chunks before assembly or parsing. The absolute
 * deadline never renews on activity. Only a fixed fresh error escapes: decoder,
 * stream and JSON exceptions may contain private received data. This is a
 * transport envelope, not proof of native session or provider authority. */
export function readPrivateVisualizationDaemonBody(
  request: http.IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BODY_BYTES)
    return Promise.reject(invalidBody());
  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(deadline);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onFailure);
      request.off("aborted", onFailure);
      request.off("close", onClose);
      request.once("error", discardRetiredStreamError);
      chunks.length = 0;
    };
    const onFailure = () => {
      if (settled) return;
      settled = true;
      request.pause();
      cleanup();
      reject(invalidBody());
    };
    const onData = (chunk: unknown) => {
      if (
        !Buffer.isBuffer(chunk) ||
        chunks.length >= PRIVATE_VISUALIZATION_DAEMON_MAX_CHUNKS ||
        receivedBytes + chunk.byteLength > maxBytes
      ) {
        onFailure();
        return;
      }
      chunks.push(chunk);
      receivedBytes += chunk.byteLength;
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, receivedBytes),
        );
        const parsed = readBoundedMcpAppTransportJson(text, maxBytes);
        if (!parsed.ok) {
          onFailure();
          return;
        }
        settled = true;
        cleanup();
        resolve(parsed.value);
      } catch {
        onFailure();
      }
    };
    const onClose = () => {
      if (!request.complete) onFailure();
    };
    // The native incoming stream retains an absolute real-time upload budget,
    // independently of an Effect caller's possibly virtual clock/lifetime.
    // @effect-diagnostics-next-line globalTimers:off
    const deadline = setTimeout(onFailure, PRIVATE_VISUALIZATION_DAEMON_BODY_MS);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onFailure);
    request.on("aborted", onFailure);
    request.on("close", onClose);
    if (request.destroyed || request.readableEnded) onFailure();
  });
}

/** Keep admitted outgoing bytes under the same finite allowance. A peer that
 * stops receiving cannot retain a lane forever. Retirement closes only this
 * response, and received socket errors are never inspected or logged. */
function awaitPrivateResponseCompletion(response: http.ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response.off("finish", complete);
      response.off("close", complete);
      response.off("error", retire);
      response.once("error", discardRetiredStreamError);
      resolve();
    };
    const retire = () => {
      response.destroy();
      complete();
    };
    // Only this native outgoing response is retired on the unchanged deadline;
    // the lease must survive upstream operation completion until finish/close.
    // @effect-diagnostics-next-line globalTimers:off
    const deadline = setTimeout(retire, PRIVATE_VISUALIZATION_DAEMON_RESPONSE_MS);
    response.once("finish", complete);
    response.once("close", complete);
    response.once("error", retire);
  });
}

/** Call only after the daemon's existing RPC capability admission. Saturation
 * refuses immediately without retaining a waiting body/operation closure.
 * The caller closes its exact HTTP connection after a content-free response;
 * no process/provider retirement or other daemon lane is affected. */
export async function runPrivateVisualizationDaemonRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  maxBytes: number,
  execute: (body: unknown) => Promise<void>,
  deny: (reason: "busy" | "invalid") => void,
): Promise<void> {
  if (activeRequests >= MAX_IN_FLIGHT) {
    // No body reader is attached on saturation, but closing this exact slow
    // connection may still emit the native aborted-stream error afterwards.
    request.once("error", discardRetiredStreamError);
    request.pause();
    deny("busy");
    return;
  }
  activeRequests += 1;
  try {
    await execute(await readPrivateVisualizationDaemonBody(request, maxBytes));
  } catch {
    request.pause();
    if (!response.headersSent && !response.destroyed) deny("invalid");
    else response.destroy();
  } finally {
    await awaitPrivateResponseCompletion(response);
    activeRequests -= 1;
  }
}
