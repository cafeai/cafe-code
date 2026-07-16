import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { makeWebSocketConnectionFlowControl } from "./ConnectionFlowControl.ts";

describe("WebSocketConnectionFlowControl", () => {
  it("releases encoded-byte permits at the next Ack/pull and on stream finalization", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = makeWebSocketConnectionFlowControl({
            maxConnectionBytes: 1_024,
            reservedControlBytes: 128,
            maxFrameBytes: 512,
          });
          const pull = yield* Stream.toPull(
            control.wrapBulkStream(Stream.make({ value: "a".repeat(128) })),
          );

          const first = yield* pull;
          expect(Array.from(first)).toHaveLength(1);
          expect(control.snapshot().activeBulkFrames).toBe(1);
          expect(control.snapshot().activeBulkBytes).toBeGreaterThan(128);
        }),
      ),
    );
  });

  it("fails only an oversized bulk subscription with a sanitized resnapshot error", async () => {
    const secret = "SECRET_PROVIDER_OUTPUT".repeat(20);
    const control = makeWebSocketConnectionFlowControl({
      maxConnectionBytes: 1_024,
      reservedControlBytes: 128,
      maxFrameBytes: 64,
    });
    const result = await Effect.runPromise(
      control.wrapBulkStream(Stream.make({ value: secret })).pipe(Stream.runCollect, Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("OrchestrationGetSnapshotError");
      expect(JSON.stringify(result.failure)).not.toContain(secret);
      expect(result.failure.message).toContain("bounded output window");
    }
    expect(control.snapshot()).toMatchObject({
      activeBulkFrames: 0,
      activeBulkBytes: 0,
      overloadCloseCount: 1,
    });
  });

  it("isolates a second saturated stream while an admitted stream retains its permit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = makeWebSocketConnectionFlowControl({
            maxConnectionBytes: 300,
            reservedControlBytes: 64,
            maxFrameBytes: 256,
          });
          const firstPull = yield* Stream.toPull(
            control.wrapBulkStream(Stream.make({ value: "a".repeat(140) })),
          );
          const secondPull = yield* Stream.toPull(
            control.wrapBulkStream(Stream.make({ value: "b".repeat(140) })),
          );

          yield* firstPull;
          const second = yield* Effect.result(secondPull);

          expect(second._tag).toBe("Failure");
          expect(control.snapshot().activeBulkFrames).toBe(1);
          expect(control.snapshot().overloadCloseCount).toBe(1);
        }),
      ),
    );
  });
});
