import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkSourceUpdateForTests } from "./DesktopSourceUpdates.ts";

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

        const state = yield* checkSourceUpdateForTests(spawner, "/repo");

        assert.equal(state.status, "behind");
        assert.equal(state.trackedBranch, "dev");
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
