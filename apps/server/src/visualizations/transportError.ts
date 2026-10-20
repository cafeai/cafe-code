import * as Data from "effect/Data";

/** Transport failures carry fixed local copy only. Native stream, parser and
 * SDK errors can contain private visualization bytes and must not be retained
 * as a cause or serialized into an HTTP/RPC diagnostic. */
export class VisualizationTransportError extends Data.TaggedError("VisualizationTransportError")<{
  readonly message: string;
}> {}
