import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";
import { withCodexMetadataClient } from "./CodexProvider.js";

it("never logs rejected private metadata wire JSON through the real disposable decoder", async () => {
  const logs: unknown[] = [];
  let spawns = 0;
  const logger = Logger.make(({ message }) => {
    logs.push(message);
  });
  const spawner = ChildProcessSpawner.make(() => {
    spawns += 1;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(7001),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        // Valid JSON, invalid protocol. The decode failure used to annotate the
        // complete object even when incoming protocol logging was not enabled.
        stdout: Stream.make(
          new TextEncoder().encode(
            JSON.stringify({
              privateMetadata: "/private/skill-path-sentinel",
              secret: "account-sentinel",
            }) + "\n",
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  await Effect.runPromise(
    withCodexMetadataClient(
      {
        binaryPath: "synthetic-no-process",
        cwd: "synthetic-cwd",
        environment: {},
      },
      () => Effect.void,
    ).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.exit,
    ),
  );
  expect(spawns).toBe(1);
  expect(logs).toEqual([]);
});
