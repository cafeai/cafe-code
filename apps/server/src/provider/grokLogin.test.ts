import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Sink from "effect/Sink";
import type { ServerProviderDeviceLoginEvent } from "@cafecode/contracts";

import {
  GROK_LOGIN_ERRORS,
  grokLoginFailureMessage,
  makeGrokLogin,
  parseGrokDeviceLoginInstructions,
} from "./grokLogin.ts";

describe("parseGrokDeviceLoginInstructions", () => {
  it("extracts a validated xAI device-code URL and matching user code", () => {
    const sample = [
      "To sign in, open this URL in your browser:",
      "",
      "  https://accounts.x.ai/oauth2/device?user_code=AKRB-SC86",
      "",
      "Confirm this code in your browser:",
      "",
      "  AKRB-SC86",
      "",
      "Waiting for authorization...",
    ].join("\n");

    expect(parseGrokDeviceLoginInstructions(sample, { requireTerminator: true })).toEqual({
      type: "device-code",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=AKRB-SC86",
      userCode: "AKRB-SC86",
    });
  });

  it("rejects untrusted origins, control characters, and mismatched codes", () => {
    expect(
      parseGrokDeviceLoginInstructions(
        "https://evil.example/oauth2/device?user_code=ABCD-1234\nABCD-1234\n",
      ),
    ).toBeNull();
    expect(
      parseGrokDeviceLoginInstructions(
        "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\nWXYZ-9999\n",
      ),
    ).toBeNull();
    expect(parseGrokDeviceLoginInstructions("https://accounts.x.ai/oauth2/device\n")).toBeNull();
  });
});

describe("makeGrokLogin", () => {
  it.effect("streams device-code instructions and refreshes after approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let refreshed = 0;
        const allowExit = yield* Deferred.make<number>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(42_001),
              exitCode: Deferred.await(allowExit).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.make(
                "To sign in:\n  https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\n  ABCD-1234\n",
              ).pipe(Stream.encodeText),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );

        const login = yield* makeGrokLogin({
          binaryPath: "grok",
          homePath: "/tmp/grok-private",
          environment: {},
          spawner,
          hasSessions: Effect.succeed(false),
          refresh: Effect.sync(() => {
            refreshed += 1;
          }),
        });

        const events: Array<ServerProviderDeviceLoginEvent> = [];
        const fiber = yield* login.loginDeviceCode(Effect.succeed(false)).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "device-code") {
                yield* Deferred.succeed(allowExit, 0);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Fiber.join(fiber);
        expect(events).toEqual([
          {
            type: "device-code",
            verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
            userCode: "ABCD-1234",
          },
          { type: "authenticated" },
        ] satisfies ReadonlyArray<ServerProviderDeviceLoginEvent>);
        expect(refreshed).toBe(1);
      }),
    ),
  );

  it.effect("refuses login when the Grok account has active sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make(() => Effect.die("should not spawn"));
        const login = yield* makeGrokLogin({
          binaryPath: "grok",
          environment: {},
          spawner,
          hasSessions: Effect.succeed(true),
          refresh: Effect.void,
        });
        const error = yield* login
          .loginDeviceCode(Effect.succeed(false))
          .pipe(Stream.runCollect, Effect.flip);
        expect(grokLoginFailureMessage(error)).toBe(GROK_LOGIN_ERRORS.busy);
      }),
    ),
  );
});
