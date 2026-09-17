import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const warningPrefix = "warning: sandbox could not be applied:";
const privateDiagnostic = " /private/provider-secret-path: endpoint is a symlink";
const genericFailure = AcpErrors.AcpRequestError.internalError("Sandbox unavailable.");
const specificFailure = AcpErrors.AcpRequestError.internalError("Sandbox socket alias refused.");

// Keep these tests independent of Grok's classifier vocabulary: the shared
// runtime must preserve complete provider-owned diagnostic records, regardless
// of which provider maps them into safe errors. Raw fixture text never becomes
// the returned error, even when stdout closes before its final stderr arrives.
const classifyStartupStderr = (stderr: string) =>
  !stderr.includes(warningPrefix)
    ? undefined
    : stderr.includes("endpoint is a symlink")
      ? specificFailure
      : genericFailure;

const makeRuntime = (input: {
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly running?: boolean;
  readonly requestLogger?: AcpSessionRuntime.AcpSessionRuntimeOptions["requestLogger"];
}) =>
  Effect.gen(function* () {
    const requestObserved = yield* Deferred.make<void>();
    return yield* AcpSessionRuntime.make({
      spawn: { command: "mock-acp-agent", args: [] },
      cwd: process.cwd(),
      authMethodId: "cached-token",
      clientInfo: { name: "acp-startup-test", version: "0.0.0" },
      classifyStartupStderr,
      ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(7_002),
              exitCode: input.running
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              isRunning: Effect.succeed(input.running ?? false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin:
                input.stdin ?? Sink.forEach(() => Deferred.succeed(requestObserved, undefined)),
              // Close stdout while initialize is awaiting its response. This
              // models immediate provider exit without depending on OS pipe
              // callback ordering or accidentally closing before admission.
              stdout:
                input.stdout ??
                Stream.fromEffect(Deferred.await(requestObserved)).pipe(Stream.drain),
              stderr: input.stderr,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        ),
      ),
    );
  });

describe("AcpSessionRuntime startup stderr", () => {
  it.effect("preserves a split warning when stdout closes before stderr finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderr = Stream.make(warningPrefix).pipe(
          Stream.concat(
            Stream.fromEffect(Effect.sleep("10 millis").pipe(Effect.as(privateDiagnostic))),
          ),
          Stream.encodeText,
        );
        const runtime = yield* makeRuntime({ stderr });
        const startup = yield* runtime.start().pipe(Effect.flip, Effect.forkScoped);

        yield* TestClock.adjust("20 millis");
        const failure = yield* Fiber.join(startup);
        expect(failure).toBe(specificFailure);
        expect(JSON.stringify(failure)).not.toContain("provider-secret-path");
      }),
    ),
  );

  it.effect("classifies a completed warning without waiting for an open stderr pipe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderr = Stream.make(warningPrefix).pipe(
          Stream.concat(
            Stream.fromEffect(Effect.sleep("10 millis").pipe(Effect.as(`${privateDiagnostic}\n`))),
          ),
          Stream.concat(Stream.never),
          Stream.encodeText,
        );
        const runtime = yield* makeRuntime({ stderr });
        const startup = yield* runtime.start().pipe(Effect.flip, Effect.forkScoped);

        yield* TestClock.adjust("20 millis");
        expect(startup.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(startup)).toBe(specificFailure);
      }),
    ),
  );

  it.effect(
    "preserves the original process failure when stderr contains no recognized warning",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let originalFailure: unknown;
          const runtime = yield* makeRuntime({
            stderr: Stream.make("unclassified private provider diagnostic\n").pipe(
              Stream.encodeText,
            ),
            requestLogger: (event) =>
              Effect.sync(() => {
                if (event.cause) originalFailure = Cause.squash(event.cause);
              }),
          });
          const failure = yield* runtime.start().pipe(Effect.flip);

          expect(failure).toBe(originalFailure);
          expect(failure).toMatchObject({ _tag: "AcpTransportError", operation: "call-rpc" });
          expect(JSON.stringify(failure)).not.toContain("private provider diagnostic");
        }),
      ),
  );

  it.effect("bounds failure draining when the provider leaves stderr open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestFailed = yield* Deferred.make<void>();
        const runtime = yield* makeRuntime({
          stderr: Stream.never,
          requestLogger: (event) =>
            event.status === "failed"
              ? Deferred.succeed(requestFailed, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const startup = yield* runtime.start().pipe(Effect.flip, Effect.forkScoped);

        yield* Deferred.await(requestFailed);
        yield* TestClock.adjust("1 second");
        // Poll before joining: a missing bound must produce an assertion
        // failure, rather than hanging until the suite's wall-clock timeout.
        expect(startup.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(startup)).toMatchObject({
          _tag: "AcpTransportError",
          operation: "call-rpc",
        });
      }),
    ),
  );

  it.effect("fails closed on an oversized unterminated warning after an unrelated line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({
          stderr: Stream.make(
            `unrelated diagnostic\n${warningPrefix}${"x".repeat(12 * 1024)}`,
          ).pipe(Stream.concat(Stream.never), Stream.encodeText),
          stdout: Stream.never,
          running: true,
        });
        const startup = yield* runtime.start().pipe(Effect.flip, Effect.forkScoped);

        yield* TestClock.adjust("1 second");
        expect(startup.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(startup)).toBe(genericFailure);
      }),
    ),
  );

  for (const unterminatedWarning of [false, true]) {
    it.effect(
      unterminatedWarning
        ? "refuses an otherwise successful startup with an unterminated sandbox warning"
        : "does not wait for stderr completion on successful startup",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const replies = yield* Queue.unbounded<Uint8Array>();
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            const runtime = yield* makeRuntime({
              stderr: unterminatedWarning
                ? Stream.make(warningPrefix).pipe(Stream.concat(Stream.never), Stream.encodeText)
                : Stream.never,
              stdout: Stream.fromQueue(replies),
              running: true,
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  for (const line of decoder.decode(chunk).trim().split("\n")) {
                    const request = JSON.parse(line) as {
                      readonly id: number;
                      readonly method: string;
                    };
                    const result =
                      request.method === "initialize"
                        ? { protocolVersion: 1 }
                        : request.method === "session/new"
                          ? { sessionId: "mock-startup-session" }
                          : {};
                    yield* Queue.offer(
                      replies,
                      encoder.encode(
                        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
                      ),
                    );
                  }
                }),
              ),
            });

            // The test clock is deliberately never advanced. Adding a drain
            // deadline to success would stall this otherwise immediate handshake.
            if (unterminatedWarning) {
              expect(yield* runtime.start().pipe(Effect.flip)).toBe(genericFailure);
            } else {
              expect((yield* runtime.start()).sessionId).toBe("mock-startup-session");
            }
          }),
        ),
    );
  }
});
