import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeAuthenticationEnvironment } from "./ClaudeAuthenticationEnvironment.ts";

const config = { binaryPath: "synthetic-claude", homePath: "", enabled: true };
const encoder = new TextEncoder();
const login = { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', code: 0 };
const noLogin = { stdout: '{"loggedIn":false,"authMethod":"none"}', code: 1 };

function fixtureSpawner(
  handler: (command: ChildProcess.StandardCommand) => { stdout: string; code: number },
) {
  const commands: ChildProcess.StandardCommand[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") throw new Error("Unexpected piped command");
      commands.push(command);
      const result = handler(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { commands, spawner };
}

it.layer(NodeServices.layer)("Claude default authentication environment", (it) => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    it.effect(`excludes the chat output override from login selection on ${platform}`, () =>
      Effect.gen(function* () {
        const accountConfig = { ...config, maxOutputTokens: 128_000 };
        const fixture = fixtureSpawner(() => login);
        for (const inherited of [undefined, "32000"]) {
          const parent = Object.freeze({
            ...(inherited === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: inherited }),
          });
          const resolve = yield* makeClaudeAuthenticationEnvironment(
            accountConfig,
            parent,
            platform,
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner));
          const selected = yield* resolve;
          expect(selected.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(inherited);
          expect(Object.hasOwn(selected, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe(
            inherited !== undefined,
          );
          expect(parent.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(inherited);
        }
        for (const command of fixture.commands) {
          expect(command.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).not.toBe("128000");
        }
      }),
    );
  }

  for (const [label, cafe, terminal, expected, expectedProbes] of [
    ["only Cafe logged in", login, noLogin, "cafe", 1],
    ["only terminal logged in", noLogin, login, "terminal", 2],
    ["both logged in to different accounts", login, login, "cafe", 1],
    ["neither logged in", noLogin, noLogin, "cafe", 2],
  ] as const) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = fixtureSpawner((command) =>
          command.options.env?.CLAUDE_CONFIG_DIR ? cafe : terminal,
        );
        const baseEnv = Object.freeze({ CAFE_TEST_UNRELATED: "preserved" });
        const resolve = yield* makeClaudeAuthenticationEnvironment(config, baseEnv, "darwin").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
        );
        expect(fixture.commands).toHaveLength(0);
        const environment = yield* resolve;
        expect(environment.CAFE_TEST_UNRELATED).toBe("preserved");
        if (expected === "cafe") {
          expect(environment.CLAUDE_CONFIG_DIR).toBe(path.join(environment.HOME!, ".claude"));
        } else {
          expect(Object.hasOwn(environment, "CLAUDE_CONFIG_DIR")).toBe(false);
        }
        expect(fixture.commands).toHaveLength(expectedProbes);
        for (const command of fixture.commands) {
          expect(command.command).toBe(config.binaryPath);
          expect(command.args).toEqual(["auth", "status"]);
          expect(command.options.shell).toBe(false);
          expect(command.options.stdin).toBe("ignore");
          expect(command.options.stderr).toBe("ignore");
          expect(command.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
          expect(command.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        }
        expect(baseEnv).toEqual({ CAFE_TEST_UNRELATED: "preserved" });
      }),
    );
  }

  describe("inconclusive results preserve the existing environment", () => {
    for (const [label, result] of [
      ["invalid JSON", { stdout: "private provider error", code: 1 }],
      ["missing Boolean", { stdout: "{}", code: 1 }],
      ["string Boolean", { stdout: '{"loggedIn":"false"}', code: 1 }],
      ["mismatched logged-in exit", { stdout: login.stdout, code: 1 }],
      ["mismatched logged-out exit", { stdout: noLogin.stdout, code: 0 }],
      ["unsupported command exit", { stdout: noLogin.stdout, code: 2 }],
      ["oversized output", { stdout: `${login.stdout}${" ".repeat(16_384)}`, code: 0 }],
      ["array instead of object", { stdout: `[${noLogin.stdout}]`, code: 1 }],
    ] as const) {
      for (const source of ["cafe", "terminal"] as const) {
        it.effect(`${source}: ${label}`, () =>
          Effect.gen(function* () {
            const fixture = fixtureSpawner((command) =>
              source === "cafe" || !command.options.env?.CLAUDE_CONFIG_DIR ? result : noLogin,
            );
            const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
            );
            const environment = yield* resolve;
            expect(environment.CLAUDE_CONFIG_DIR).toBeDefined();
            expect(fixture.commands).toHaveLength(source === "cafe" ? 1 : 2);
          }),
        );
      }
    }

    it.effect("preserves selection when the configured executable cannot start", () =>
      Effect.gen(function* () {
        let calls = 0;
        const spawner = ChildProcessSpawner.make(() => {
          calls++;
          return Effect.die(new Error("synthetic private launch failure"));
        });
        const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect((yield* resolve).CLAUDE_CONFIG_DIR).toBeDefined();
        expect(calls).toBe(1);
      }),
    );

    it.effect("bounds a stalled probe and retires its child before preserving selection", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const calls: string[] = [];
        let running = true;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            calls.push("spawn");
            yield* Deferred.succeed(started, undefined);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.never,
              isRunning: Effect.sync(() => running),
              kill: (options) =>
                Effect.sync(() => {
                  calls.push(options?.killSignal ?? "unknown");
                  running = false;
                }),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const fiber = yield* resolve.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("4000 millis");
        expect((yield* Fiber.join(fiber)).CLAUDE_CONFIG_DIR).toBeDefined();
        expect(calls).toEqual(["spawn", "SIGTERM"]);
        expect(running).toBe(false);
      }),
    );
  });

  it.effect("rechecks an unresolved login, coalesces callers, then pins the selected store", () =>
    Effect.gen(function* () {
      let terminalLoggedIn = false;
      const fixture = fixtureSpawner((command) =>
        !command.options.env?.CLAUDE_CONFIG_DIR && terminalLoggedIn ? login : noLogin,
      );
      const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
      );
      const initial = yield* Effect.all([resolve, resolve, resolve], { concurrency: "unbounded" });
      expect(initial.every((env) => env.CLAUDE_CONFIG_DIR !== undefined)).toBe(true);
      expect(fixture.commands).toHaveLength(2);
      terminalLoggedIn = true;
      expect((yield* resolve).CLAUDE_CONFIG_DIR).toBeDefined();
      expect(fixture.commands).toHaveLength(2);
      yield* TestClock.adjust("5001 millis");
      const selected = yield* resolve;
      expect(Object.hasOwn(selected, "CLAUDE_CONFIG_DIR")).toBe(false);
      expect(fixture.commands).toHaveLength(4);
      terminalLoggedIn = false;
      yield* TestClock.adjust("1 hour");
      expect(yield* resolve).toBe(selected);
      expect(fixture.commands).toHaveLength(4);
    }),
  );

  it.effect("pins Cafe's existing login even if local login material changes later", () =>
    Effect.gen(function* () {
      const fixture = fixtureSpawner(() => login);
      const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner),
      );
      const selected = yield* resolve;
      yield* TestClock.adjust("1 hour");
      expect(yield* resolve).toBe(selected);
      expect(fixture.commands).toHaveLength(1);
    }),
  );

  it.effect("does not convert interruption into permission to probe another store", () =>
    Effect.gen(function* () {
      let calls = 0;
      const spawner = ChildProcessSpawner.make(() => {
        calls++;
        return Effect.interrupt;
      });
      const resolve = yield* makeClaudeAuthenticationEnvironment(config, {}, "darwin").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const result = yield* resolve.pipe(Effect.exit);
      expect(Exit.hasInterrupts(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );

  for (const platform of ["darwin", "linux", "win32"] as const) {
    it.effect(`respects explicit selection and skips unnecessary probes on ${platform}`, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = fixtureSpawner(() => {
          throw new Error("Explicit authentication must never be probed for fallback");
        });
        const root = path.resolve("synthetic-account-home");
        for (const [settings, baseEnv] of [
          [{ ...config, homePath: root }, {}],
          [config, { CLAUDE_CONFIG_DIR: root }],
          [config, { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }],
          [config, { ANTHROPIC_API_KEY: "synthetic-secret" }],
          [config, { ANTHROPIC_AUTH_TOKEN: "synthetic-secret" }],
          [config, { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-secret" }],
          [config, { CLAUDE_CODE_USE_BEDROCK: "1" }],
          [config, { CLAUDE_CODE_USE_VERTEX: "1" }],
          [config, { CLAUDE_CODE_USE_FOUNDRY: "1" }],
          [config, { ANTHROPIC_PROFILE: "synthetic-profile" }],
          [config, { ANTHROPIC_FEDERATION_RULE_ID: "synthetic-rule" }],
          [config, { ANTHROPIC_ORGANIZATION_ID: "synthetic-organization" }],
          [{ ...config, enabled: false }, {}],
          ...(platform === "darwin" ? [] : [[config, {}]]),
        ] as Array<[typeof config, NodeJS.ProcessEnv]>) {
          const frozen = Object.freeze(baseEnv);
          const resolve = yield* makeClaudeAuthenticationEnvironment(
            settings,
            frozen,
            platform,
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner));
          const selected = yield* resolve;
          for (const [key, value] of Object.entries(baseEnv)) {
            expect(selected[key]).toBe(value);
          }
          if (settings.homePath) {
            expect(selected.HOME).toBe(root);
            expect(selected.CLAUDE_CONFIG_DIR).toBe(path.join(root, ".claude"));
          }
        }
        expect(fixture.commands).toHaveLength(0);
      }),
    );
  }
});
