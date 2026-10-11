import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkSourceUpdateForTests } from "./DesktopSourceUpdates.ts";
import * as DesktopSourceUpdates from "./DesktopSourceUpdates.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import type { DesktopSourceUpdateState } from "@cafecode/contracts";
import { setUiLocale, uiText } from "@cafecode/shared/i18n";
import * as IpcChannels from "../ipc/channels.ts";

const textEncoder = new TextEncoder();

function makeProcess(
  stdoutText: string,
  exitCode: number,
  stderrText = "",
): ChildProcessSpawner.ChildProcessHandle {
  const stdout =
    stdoutText.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(stdoutText));
  const stderr =
    stderrText.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(stderrText));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function commandKey(command: ChildProcess.Command) {
  if (command._tag !== "StandardCommand") {
    return "<non-standard>";
  }
  return [command.command, ...command.args].join(" ");
}

function makeGitSpawner(input: {
  readonly responses: ReadonlyMap<string, { readonly stdout: string; readonly exitCode?: number }>;
  readonly commands: string[];
}) {
  return ChildProcessSpawner.make((command) => {
    const key = commandKey(command);
    input.commands.push(key);
    const response = input.responses.get(key);
    if (!response) {
      return Effect.succeed(makeProcess("", 1, `unexpected command: ${key}`));
    }
    return Effect.succeed(makeProcess(response.stdout, response.exitCode ?? 0));
  });
}

describe("DesktopSourceUpdates", () => {
  it.effect(
    "re-emits only cached presentation on a locale switch, retaining check and source identity",
    () =>
      Effect.gen(function* () {
        setUiLocale("en");
        const commands: string[] = [];
        const delivered: DesktopSourceUpdateState[] = [];
        const spawner = makeGitSpawner({
          commands,
          responses: new Map([
            ["git rev-parse --show-toplevel", { stdout: "/synthetic\n" }],
            ["git rev-parse --abbrev-ref HEAD", { stdout: "dev\n" }],
            ["git rev-parse HEAD", { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }],
            ["git status --porcelain=v1", { stdout: "" }],
            [
              "git fetch --quiet --no-tags origin refs/heads/dev:refs/remotes/origin/dev",
              { stdout: "" },
            ],
            ["git rev-parse origin/dev", { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }],
            [
              "git merge-base HEAD origin/dev",
              { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" },
            ],
          ]),
        });
        const environment = DesktopEnvironment.layer({
          dirname: "/synthetic/apps/desktop/dist-electron",
          homeDirectory: "/synthetic-home",
          platform: "linux",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/synthetic",
          isPackaged: false,
          resourcesPath: "/synthetic/resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
        const windows = Layer.succeed(ElectronWindow.ElectronWindow, {
          create: () => Effect.die("language cannot create a window"),
          main: Effect.succeed(Option.none()),
          currentMainOrFirst: Effect.succeed(Option.none()),
          focusedMainOrFirst: Effect.succeed(Option.none()),
          setMain: () => Effect.void,
          clearMain: () => Effect.void,
          reveal: () => Effect.die("language cannot reveal a window"),
          destroyAll: Effect.die("language cannot destroy windows"),
          syncAllAppearance: () => Effect.void,
          sendAll: (channel, ...args) =>
            Effect.sync(() => {
              assert.equal(channel, IpcChannels.SOURCE_UPDATE_STATE_CHANNEL);
              delivered.push(args[0] as DesktopSourceUpdateState);
            }),
        } satisfies ElectronWindow.ElectronWindowShape);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopSourceUpdates.DesktopSourceUpdates;
            const original = yield* updates.check("synthetic-owner");
            assert.equal(original.message, "This checkout is current with origin.");
            const commandCount = commands.length;
            for (const locale of ["ja", "ko"] as const) {
              setUiLocale(locale);
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              const current = yield* updates.getState;
              assert.equal(
                current.message,
                uiText("This checkout is current with origin.", undefined, undefined, locale),
              );
              assert.deepEqual({ ...current, message: null }, { ...original, message: null });
              assert.deepEqual(delivered.at(-1), current);
              assert.equal(Object.getOwnPropertyDescriptor(current, "message")?.get, undefined);
              assert.equal(commands.length, commandCount, "language must not read/fetch git again");
            }
            assert.equal(
              original.message,
              "This checkout is current with origin.",
              "delivered snapshots never retain a mutable getter",
            );
          }).pipe(
            Effect.provide(
              DesktopSourceUpdates.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    environment,
                    windows,
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  ),
                ),
              ),
            ),
          ),
        );
        const emissions = delivered.length;
        setUiLocale("en");
        yield* Effect.yieldNow;
        assert.equal(
          delivered.length,
          emissions,
          "retired native scope removes its display listener",
        );
      }).pipe(Effect.ensuring(Effect.sync(() => setUiLocale("en")))),
  );
  it.effect("ignores non-main/dev branches without fetching remote refs", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const spawner = makeGitSpawner({
        commands,
        responses: new Map([
          ["git rev-parse --show-toplevel", { stdout: "/repo\n" }],
          ["git rev-parse --abbrev-ref HEAD", { stdout: "feature/window\n" }],
          ["git rev-parse HEAD", { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }],
          ["git status --porcelain=v1", { stdout: " M file.ts\n" }],
        ]),
      });

      const state = yield* checkSourceUpdateForTests(spawner, "/repo");

      assert.equal(state.status, "ignored");
      assert.equal(state.branch, "feature/window");
      assert.equal(state.trackedBranch, null);
      assert.equal(state.runtimeHash, null);
      assert.equal(state.localHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.equal(state.dirty, true);
      assert.deepStrictEqual(
        commands.filter((command) => command.includes(" fetch ")),
        [],
      );
    }),
  );

  it.effect(
    "reports a newer remote hash for a tracked dev branch without reading dirty files",
    () =>
      Effect.gen(function* () {
        const commands: string[] = [];
        const localHash = "1111111111111111111111111111111111111111";
        const remoteHash = "2222222222222222222222222222222222222222";
        const runtimeHash = "0000000000000000000000000000000000000000";
        const spawner = makeGitSpawner({
          commands,
          responses: new Map([
            ["git rev-parse --show-toplevel", { stdout: "/repo\n" }],
            ["git rev-parse --abbrev-ref HEAD", { stdout: "dev\n" }],
            ["git rev-parse HEAD", { stdout: `${localHash}\n` }],
            ["git status --porcelain=v1", { stdout: "" }],
            [
              "git fetch --quiet --no-tags origin refs/heads/dev:refs/remotes/origin/dev",
              { stdout: "" },
            ],
            ["git rev-parse origin/dev", { stdout: `${remoteHash}\n` }],
            ["git merge-base HEAD origin/dev", { stdout: `${localHash}\n` }],
            ["git merge-base --is-ancestor HEAD origin/dev", { stdout: "" }],
          ]),
        });

        const state = yield* checkSourceUpdateForTests(spawner, "/repo", runtimeHash);

        assert.equal(state.status, "behind");
        assert.equal(state.trackedBranch, "dev");
        assert.equal(state.runtimeHash, runtimeHash);
        assert.equal(state.localHash, localHash);
        assert.equal(state.remoteHash, remoteHash);
        assert.equal(state.dirty, false);
        assert.ok(
          commands.includes(
            "git fetch --quiet --no-tags origin refs/heads/dev:refs/remotes/origin/dev",
          ),
        );
      }),
  );
});
