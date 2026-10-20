// Native bridge keeps exact socket/response identity, stream lifetime and resource limits.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import type { ServerResponse } from "node:http";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";

// Typed internal failure preserves existing Error name, fixed text and optional cause.
class GlideResponseBoundaryError extends Data.TaggedError("GlideResponseBoundaryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super({ message, ...options });
    this.name = "Error";
  }
}

/** Control replies retain a separate allowance so four occupied JS response
 * lanes cannot prevent reset, discovery or human Stop in the owner daemon. */
function budget(maxBytes: number) {
  let active = 0;
  return {
    acquire(response: ServerResponse) {
      if (active >= 4 || response.destroyed || response.writableFinished)
        throw new GlideResponseBoundaryError("Glide response capacity is full.");
      active++;
      let handedOff = false,
        released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        if (timer) clearTimeout(timer);
        response.off("finish", release);
        response.off("close", release);
        response.off("error", retire);
        response.once("error", () => {});
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
          if (handedOff || released) return;
          handedOff = true;
          // Native callback deadline keeps exact socket/process lifetime, cancellation and ref/unref behavior.
          // @effect-diagnostics-next-line globalTimers:off
          timer = setTimeout(retire, 10_000);
          if (response.destroyed || response.writableFinished) release();
        },
        releaseUnlessTransferred: () => {
          if (!handedOff) release();
        },
      };
    },
    bound<E, R>(stream: Stream.Stream<Uint8Array, E, R>) {
      let bytes = 0,
        chunks = 0;
      return stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return ++chunks > 2048 || bytes > maxBytes
            ? Effect.fail(new GlideResponseBoundaryError("Glide response exceeded its limit."))
            : Effect.succeed(chunk);
        }),
        Stream.mapError(
          () => new GlideResponseBoundaryError("Glide response could not be delivered."),
        ),
      );
    },
  };
}
export const glideExecutionResponses = budget(12 * 1024 * 1024);
export const glideControlResponses = budget(64 * 1024);
