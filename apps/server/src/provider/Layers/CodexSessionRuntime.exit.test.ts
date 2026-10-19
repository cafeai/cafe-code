import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";

import {
  buildCodexAppServerArgs,
  makeCodexSessionRuntime,
  makeCodexStderrClassifier,
} from "./CodexSessionRuntime.ts";
import {
  markProcessShutdownRequested,
  resetProcessShutdownObservationForTests,
} from "../../processShutdownObservation.ts";

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
        const schedulingMcp = {
          name: "cafe-scoped_scheduling",
          launch: {
            command: process.execPath,
            args: ["C:\\Cafe & Code\\bridge.mjs", "C:\\private\\connection.json"],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        };
        const result = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-command-policy"),
          binaryPath,
          homePath: "isolated-codex-home",
          appServerCwd: "backend-owned-cwd",
          cwd: "distinct-project-cwd",
          environment,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 3,
          schedulingMcp,
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
            schedulingMcp,
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

it.effect("retires a parent-scoped runtime without recording an unexpected exit", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const scope = yield* Scope.make("sequential");
    let released = false;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.acquireRelease(
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(7_002),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () =>
              Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
        () =>
          Effect.gen(function* () {
            released = true;
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
          }),
      ),
    );
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("thread-planned-exit"),
      binaryPath: "/test-only/codex",
      cwd: "/test-only/workspace",
      runtimeMode: "full-access",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Scope.Scope, scope),
    );
    yield* Scope.close(scope, Exit.void);
    assert.equal(released, true);
    const session = yield* runtime.getSession;
    assert.notEqual(session.status, "error");
    assert.equal(session.lastError, undefined);
    // Parent retirement fences subsequent idle admission even when explicit
    // runtime.close was not called by the owner before its scope ended.
    assert.equal(yield* runtime.closeIfIdle!, false);
  }),
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

      // The observer first waits a short wall-clock window for planned-
      // shutdown evidence; with none, the exit is still a visible error.
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

it.effect("treats an exit during a requested Cafe shutdown as a stop, not a provider error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      markProcessShutdownRequested();
      yield* Effect.addFinalizer(() => Effect.sync(resetProcessShutdownObservationForTests));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-shutdown-zero-exit"),
        binaryPath: "/test-only/codex",
        cwd: "/test-only/workspace",
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* runtime.events.pipe(Stream.take(1), Stream.runCollect));
      const session = yield* runtime.getSession;
      assert.notEqual(session.status, "error");
      assert.equal(session.lastError, undefined);
      assert.deepEqual(
        events.map((event) => ({ kind: event.kind, method: event.method })),
        [{ kind: "session", method: "session/closed" }],
      );
    }),
  ).pipe(Effect.provide(exitZeroSpawnerLayer)),
);

it("keeps tracing record headers and drops their multi-line continuations", () => {
  const classify = makeCodexStderrClassifier(() => 0);
  // A non-tracing line before any record is still reported.
  assert.deepEqual(classify("panic before logging"), { message: "panic before logging" });
  assert.deepEqual(classify("2026-10-18T23:39:02.291Z ERROR codex_core::exec: failed"), {
    message: "2026-10-18T23:39:02.291Z ERROR codex_core::exec: failed",
  });
  // Source lines quoted by a multi-line record are continuations, not warnings.
  for (const continuation of ["const entries = await manifest();", "}", "## Notes"])
    assert.equal(classify(continuation), null);
  assert.deepEqual(classify("thread 'main' panicked at src/lib.rs:1:1:"), {
    message: "thread 'main' panicked at src/lib.rs:1:1:",
  });
  assert.equal(classify("2026-10-18T23:39:02.291Z INFO codex_core::exec: noise"), null);
});

it("drops background-noise targets and rate-limits identical records", () => {
  let now = 0;
  const classify = makeCodexStderrClassifier(() => now);
  for (const noise of [
    "2026-10-18T23:39:02Z ERROR codex_core::tools::router: error=apply_patch verification failed",
    "2026-10-18T20:16:17Z ERROR codex_models_manager::manager: failed to refresh available models",
    "2026-10-15T01:07:21Z ERROR codex_core::util: Custom tool call output is missing for call id",
  ])
    assert.equal(classify(noise), null);
  const refresh = (time: string) =>
    `${time} ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized`;
  assert.notEqual(classify(refresh("2026-10-15T18:05:52Z")), null);
  now += 60_000;
  assert.equal(classify(refresh("2026-10-15T18:06:52Z")), null);
  now += 5 * 60_000;
  assert.notEqual(classify(refresh("2026-10-15T18:11:52Z")), null);
});
