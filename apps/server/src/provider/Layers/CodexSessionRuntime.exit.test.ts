import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";

import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const exitZeroSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(7_001),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

it.effect("publishes an unrequested zero exit as a visible error before session/exited", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-unexpected-zero-exit"),
        binaryPath: "/test-only/codex",
        cwd: "/test-only/workspace",
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* runtime.events.pipe(Stream.take(2), Stream.runCollect));
      const session = yield* runtime.getSession;

      assert.equal(session.status, "error");
      assert.equal(session.lastError, "Codex App Server exited unexpectedly.");
      assert.deepEqual(
        events.map((event) => ({
          kind: event.kind,
          method: event.method,
          message: event.message,
        })),
        [
          {
            kind: "error",
            method: "process/exitedUnexpectedly",
            message: "Codex App Server exited unexpectedly.",
          },
          {
            kind: "session",
            method: "session/exited",
            message: "Codex App Server exited unexpectedly.",
          },
        ],
      );

      // The public diagnostic is deliberately finite and content-free. A
      // process exit must not surface stdio, request data, or command paths.
      const visibleDiagnostic = JSON.stringify(events);
      assert.equal(visibleDiagnostic.includes("/test-only/codex"), false);
      assert.equal(visibleDiagnostic.includes("/test-only/workspace"), false);
      assert.equal(visibleDiagnostic.includes("stdout"), false);
      assert.equal(visibleDiagnostic.includes("stderr"), false);
    }),
  ).pipe(Effect.provide(exitZeroSpawnerLayer)),
);
