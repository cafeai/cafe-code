// @effect-diagnostics nodeBuiltinImport:off
import type * as http from "node:http";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const VISUALIZATION_MCP_RESPONSE_MS = 10_000;
export const VISUALIZATION_MCP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 2048;
const MAX_IN_FLIGHT = 4;
let activeRequests = 0;
/** Content-free process-local observation for isolated lifecycle fixtures.
 * This is neither a route nor native/session authorization. */
export const visualizationMcpRequestCount = () => activeRequests;
const discardedResponseError = () => {};

/** Acquire only after the existing exact session capability admission. The
 * response is supplied by the native Effect HTTP interpreter, never model
 * input. Keep the allowance through actual finish/close, not SDK Response
 * creation or upstream stream exhaustion: Node can still be waiting for drain.
 * A fixed output deadline starts at handoff and never renews on emitted bytes.
 * Closing one lease only retires its own response; no provider is interrupted. */
export function acquireVisualizationMcpResponse(response: http.ServerResponse) {
  if (activeRequests >= MAX_IN_FLIGHT || response.destroyed || response.writableFinished)
    return undefined;
  activeRequests += 1;
  let released = false;
  let transferred = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (deadline !== undefined) clearTimeout(deadline);
    response.off("finish", release);
    response.off("close", release);
    response.off("error", retire);
    response.once("error", discardedResponseError);
    activeRequests -= 1;
  };
  const retire = () => {
    response.destroy();
    release();
  };
  response.once("finish", release);
  response.once("close", release);
  response.once("error", retire);
  return {
    beginOutput: () => {
      if (transferred || released) return;
      transferred = true;
      deadline = setTimeout(retire, VISUALIZATION_MCP_RESPONSE_MS);
      if (response.destroyed || response.writableFinished) release();
    },
    // Cancellation/failure before handoff must not leak a lane. After handoff
    // only the native completion events or fixed deadline may release it.
    releaseUnlessTransferred: () => {
      if (!transferred) release();
    },
  };
}

/** Bound actual outgoing bytes and chunks without accumulating another whole
 * JSON/PNG copy. One maximum admitted PNG fits with base64/JSON framing. Larger
 * aggregate SDK responses fail closed, rather than retaining arbitrary output.
 * The separate native response timer also bounds a stalled downstream writer;
 * an upstream stream timeout alone would miss Node's drain wait. Received
 * stream errors are replaced before the HTTP interpreter can inspect them. */
export function boundVisualizationMcpResponse<E, R>(stream: Stream.Stream<Uint8Array, E, R>) {
  let length = 0;
  let chunks = 0;
  return stream.pipe(
    Stream.mapEffect((chunk) =>
      ++chunks > MAX_RESPONSE_CHUNKS ||
      length + chunk.byteLength > VISUALIZATION_MCP_MAX_RESPONSE_BYTES
        ? Effect.fail(new Error("Visualization response could not be delivered."))
        : Effect.sync(() => {
            length += chunk.byteLength;
            return chunk;
          }),
    ),
    Stream.mapError(() => new Error("Visualization response could not be delivered.")),
  );
}
