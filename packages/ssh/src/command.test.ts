import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  parseSshResolveOutput,
  resolveRemoteCafeCodeCliPackageSpec,
  resolveSshIdentityAgent,
  runSshCommand,
} from "./command.ts";

const makeNeverFinishingProcess = () => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh command", () => {
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("builds agent-only ssh args by default", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs({
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        }),
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ConnectionAttempts=1",
          "-o",
          "NumberOfPasswordPrompts=0",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
          "-o",
          "PreferredAuthentications=publickey",
          "-o",
          "PubkeyAuthentication=yes",
          "-p",
          "2222",
        ],
      );
    }),
  );

  it.effect("pins OpenSSH to a validated identity agent socket when provided", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { identityAgent: "/tmp/cafe-code-agent.sock" },
        ),
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ConnectionAttempts=1",
          "-o",
          "NumberOfPasswordPrompts=0",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
          "-o",
          "PreferredAuthentications=publickey",
          "-o",
          "PubkeyAuthentication=yes",
          "-o",
          "IdentityAgent=/tmp/cafe-code-agent.sock",
          "-p",
          "2222",
        ],
      );
    }),
  );

  it.effect("does not expose malformed SSH_AUTH_SOCK values as IdentityAgent options", () =>
    Effect.sync(() => {
      assert.isNull(resolveSshIdentityAgent({ SSH_AUTH_SOCK: "/tmp/bad\nsock" }));
      assert.isNull(resolveSshIdentityAgent({ SSH_AUTH_SOCK: "relative-agent.sock" }));
      assert.notInclude(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { identityAgent: "/tmp/bad\nsock" },
        ),
        "IdentityAgent=/tmp/bad\nsock",
      );
    }),
  );

  it.effect("resolves the remote Cafe Code package spec from the desktop release channel", () =>
    Effect.sync(() => {
      assert.equal(
        resolveRemoteCafeCodeCliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
        }),
        "@cafeai/cafe-code@0.0.17",
      );
      assert.equal(
        resolveRemoteCafeCodeCliPackageSpec({
          appVersion: "0.0.17-nightly.20260415.44",
          updateChannel: "nightly",
        }),
        "@cafeai/cafe-code@0.0.17-nightly.20260415.44",
      );
      assert.equal(
        resolveRemoteCafeCodeCliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "nightly",
          isDevelopment: true,
        }),
        "@cafeai/cafe-code@nightly",
      );
      assert.equal(
        resolveRemoteCafeCodeCliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "latest",
          isDevelopment: true,
        }),
        "@cafeai/cafe-code@nightly",
      );
    }),
  );

  it.effect("reads the last non-empty ssh output line", () =>
    Effect.sync(() => {
      assert.equal(
        getLastNonEmptyOutputLine(
          ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
        ),
        '{"credential":"pairing-token"}',
      );
    }),
  );

  it.effect("fails commands that never finish", () => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeNeverFinishingProcess()));
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          runSshCommand(
            {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 2222,
            },
            { timeoutMs: 1 },
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "SSH command timed out after 1ms.");
      }
    }).pipe(Effect.provide(processLayer));
  });
});
