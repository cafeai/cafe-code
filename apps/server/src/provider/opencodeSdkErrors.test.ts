import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  OpenCodeRuntimeError,
  openCodeSdkFailureDetail,
  runOpenCodeSdk,
} from "./opencodeRuntime.ts";

describe("OpenCode SDK error boundary", () => {
  it("retains a useful HTTP classification without request credentials or response bodies", async () => {
    const failure = {
      response: { status: 401, headers: { authorization: "private-fixture-secret" } },
      request: {
        url: "https://private-fixture-secret.invalid",
        headers: { authorization: "private-fixture-secret" },
      },
      error: { message: "private-fixture-secret" },
    };
    const result = await Effect.runPromise(
      Effect.exit(runOpenCodeSdk("session.promptAsync", () => Promise.reject(failure))),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(OpenCodeRuntimeError.is(error)).toBe(true);
      if (OpenCodeRuntimeError.is(error)) expect(error.detail).toContain("rejected authentication");
      expect(JSON.stringify(result.cause)).not.toContain("private-fixture-secret");
      expect(error).not.toHaveProperty("cause");
    }
    expect(openCodeSdkFailureDetail({ response: { status: 429 } })).toContain("rate limited");
    expect(openCodeSdkFailureDetail({ response: { status: 503 } })).toContain("HTTP 503");
  });

  it("does not stringify opaque failures or invoke error-body coercion", () => {
    let coerced = false;
    const error = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("private-fixture-secret");
        },
        get() {
          coerced = true;
          throw new Error("private-fixture-secret");
        },
      },
    );
    expect(openCodeSdkFailureDetail(error)).toBe(
      "OpenCode request failed. Check the provider configuration and server availability.",
    );
    expect(coerced).toBe(false);
  });

  it("retires the exact request signal when its caller is cancelled", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          let signal: AbortSignal | undefined;
          const request = yield* runOpenCodeSdk("session.get", (ownedSignal) => {
            signal = ownedSignal;
            return new Promise((_resolve, reject) => {
              ownedSignal.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
              Effect.runSync(Deferred.succeed(entered, undefined));
            });
          }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(request);
          expect(signal?.aborted).toBe(true);
        }),
      ),
    );
  });
});
