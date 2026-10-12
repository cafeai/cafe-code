import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeBackendMigrationProgressDecoder } from "@cafecode/shared/backendStartupProgress";

import { stopOwnedProviderDaemonChild } from "./DesktopProviderDaemonManager.ts";

// Process-backed exit qualification is explicitly opt-in, never a user daemon
// or provider runtime. Windows retains its native FILETIME/same-handle fixture.
it.skipIf(process.platform === "win32" || process.env.CAFE_CODE_DAEMON_STARTUP_E2E !== "1")(
  "confirms the copied Node child's real exit after ignored graceful termination",
  async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({
            prefix: "cafe-owned-daemon-exit-",
          });
          const executable = path.join(temporary, "synthetic-node");
          yield* fs.copyFile(process.execPath, executable);
          yield* fs.chmod(executable, 0o700);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const script = `import { writeSync } from 'node:fs';
          process.on('SIGTERM', () => {});
          writeSync(4, 'cafe-migration:v1:start:92\\n');
          setInterval(() => {}, 1000);`;
          const child = yield* spawner.spawn(
            ChildProcess.make(executable, ["--input-type=module", "--eval", script], {
              cwd: temporary,
              extendEnv: false,
              env: {},
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              additionalFds: { fd4: { type: "output" } },
            }),
          );
          const ready = yield* Deferred.make<void>();
          const decoder = makeBackendMigrationProgressDecoder();
          yield* child.getOutputFd(4).pipe(
            Stream.runForEach((bytes) => {
              const decoded = decoder.push(bytes);
              return decoded.records.some(
                (record) => record.phase === "start" && record.migrationId === 92,
              )
                ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
            Effect.forkScoped,
          );
          yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
          const signals: string[] = [];
          const stopped = yield* stopOwnedProviderDaemonChild({
            ...child,
            kill: (options) =>
              Effect.sync(() => {
                signals.push(options?.killSignal ?? "SIGTERM");
              }).pipe(Effect.andThen(child.kill(options))),
          });
          return { stopped, running: yield* child.isRunning, signals };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result).toEqual({ stopped: true, running: false, signals: ["SIGTERM", "SIGKILL"] });
  },
  30_000,
);
