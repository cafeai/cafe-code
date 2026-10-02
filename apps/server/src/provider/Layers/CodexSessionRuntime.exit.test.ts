import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";

import { buildCodexAppServerArgs, makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

it.effect.each([
  { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.exe", windowsShell: false },
  { binaryPath: "C:\\Program Files\\Cafe & Codex\\CODEX.COM", windowsShell: false },
  { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.cmd", windowsShell: true },
  { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.bat", windowsShell: true },
  { binaryPath: "codex", windowsShell: true },
  { binaryPath: "/test-only/codex", windowsShell: true },
])(
  "uses the shared host launch policy in a real session for $binaryPath",
  ({ binaryPath, windowsShell }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<ChildProcess.Command> = [];
        // Stop before process creation. This tests the actual session startup
        // path without probing PATH, reading provider credentials or requiring
        // an executable corresponding to a foreign-platform command spelling.
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "Intentional session command-policy fixture stop",
            }),
          );
        });
        const environment = { CAFE_TEST_ONLY: "literal & | %fixture%", CODEX_HOME: "overridden" };
        const result = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-command-policy"),
          binaryPath,
          homePath: "isolated-codex-home",
          appServerCwd: "backend-owned-cwd",
          cwd: "distinct-project-cwd",
          environment,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 3,
          transportPolicy: { responsesWebsockets: "disabled" },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.exit,
        );
        assert.equal(Exit.isFailure(result), true);
        assert.equal(commands.length, 1);
        const command = commands[0];
        if (command?._tag !== "StandardCommand") {
          throw new Error("Expected one structured session command");
        }
        assert.equal(command.command, binaryPath);
        assert.deepEqual(
          command.args,
          buildCodexAppServerArgs({
            maxConcurrentSubagents: 3,
            transportPolicy: { responsesWebsockets: "disabled" },
          }),
        );
        assert.equal(command.options.shell, process.platform === "win32" && windowsShell);
        assert.equal(command.options.cwd, "backend-owned-cwd");
        assert.deepEqual(command.options.env, {
          ...environment,
          CODEX_HOME: "isolated-codex-home",
        });
        assert.equal(command.options.forceKillAfter, "2 seconds");
        // The compatibility correction must not silently change long-running
        // session ownership or copy disposable probe SIGKILL/detach policy.
        assert.equal(command.options.detached, undefined);
        assert.equal(command.options.killSignal, undefined);
      }),
    ),
);

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
