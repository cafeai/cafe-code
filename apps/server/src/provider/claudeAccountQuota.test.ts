import * as ProviderJsonSchema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeClaudeAccountQuotaReader, readClaudeAccountQuota } from "./claudeAccountQuota.ts";

const decodeProviderJsonString = ProviderJsonSchema.decodeUnknownSync(
  ProviderJsonSchema.UnknownFromJsonString,
);
const encodeProviderJsonString = ProviderJsonSchema.encodeUnknownSync(
  ProviderJsonSchema.UnknownFromJsonString,
);

const native = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 57, resets_at: "2026-10-16T22:40:00.143878+00:00" },
    seven_day: { utilization: 18, resets_at: "2026-10-20T11:00:00.143906+00:00" },
  },
};
const environment = Object.freeze({
  HOME: "/selected-home",
  CLAUDE_CONFIG_DIR: "/selected-config",
});
const encoder = new TextEncoder();
function fixture(output?: (requestId: string) => Stream.Stream<Uint8Array>) {
  const commands: ChildProcess.StandardCommand[] = [];
  const requests: unknown[] = [];
  const kills: string[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || !Stream.isStream(command.options.stdin))
        throw new Error("Expected a control stream");
      commands.push(command);
      const request = decodeProviderJsonString(
        new TextDecoder().decode(Option.getOrThrow(yield* Stream.runHead(command.options.stdin))),
      ) as { request_id: string };
      requests.push(request);
      let running = true;
      const reply =
        encodeProviderJsonString({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: request.request_id,
            response: native,
          },
        }) + "\n";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.sync(() => running),
        kill: (options) =>
          Effect.sync(() => {
            kills.push(options?.killSignal ?? "unknown");
            running = false;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        // Split a reply across chunks to exercise native NDJSON framing.
        stdout:
          output?.(request.request_id) ??
          Stream.make(encoder.encode(reply.slice(0, 53)), encoder.encode(reply.slice(53))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands, requests, kills };
}

describe("Claude control-only account allowances", () => {
  it.effect(
    "sends only get_usage with transcript scanning disabled and retires its exact child",
    () =>
      Effect.gen(function* () {
        const peer = fixture();
        const report = yield* readClaudeAccountQuota("selected-claude", environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
        );
        expect(report?.meters?.map((meter) => meter.usedPercent)).toEqual([57, 18]);
        expect(peer.requests).toEqual([
          {
            type: "control_request",
            request_id: expect.any(String),
            request: { subtype: "get_usage", skip_behaviors: true },
          },
        ]);
        expect(peer.commands).toHaveLength(1);
        const command = peer.commands[0]!;
        expect(command.command).toBe("selected-claude");
        expect(command.args).toEqual([
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--tools=",
          "--setting-sources=",
          "--settings",
          '{"disableAllHooks":true}',
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
        ]);
        expect(command.options).toMatchObject({
          env: environment,
          cwd: environment.HOME,
          extendEnv: false,
          shell: false,
          stderr: "ignore",
        });
        expect(peer.kills).toEqual(["SIGTERM"]);
      }),
  );

  for (const [name, output] of [
    [
      "foreign reply",
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "foreign", response: native },
      }) + "\n",
    ],
    ["malformed reply", "not-json\n"],
    ["oversized output", " ".repeat(262_145)],
    ["too many frames", (JSON.stringify({ type: "system" }) + "\n").repeat(129)],
    ["early exit", ""],
  ] as const)
    it.effect(`returns unavailable and cleans up on ${name}`, () =>
      Effect.gen(function* () {
        const peer = fixture(() => Stream.make(encoder.encode(output)));
        expect(
          yield* readClaudeAccountQuota("selected-claude", environment).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
          ),
        ).toBeNull();
        expect(peer.kills).toEqual(["SIGTERM"]);
      }),
    );

  it.effect("does not expose a matching error response or launch failure", () =>
    Effect.gen(function* () {
      const peer = fixture((request_id) =>
        Stream.make(
          encoder.encode(
            JSON.stringify({
              type: "control_response",
              response: { subtype: "error", request_id, error: "private failure" },
            }) + "\n",
          ),
        ),
      );
      expect(
        yield* readClaudeAccountQuota("selected-claude", environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
        ),
      ).toBeNull();
      const failing = ChildProcessSpawner.make(() =>
        Effect.die(new Error("private launch failure")),
      );
      expect(
        yield* readClaudeAccountQuota("missing", environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failing),
        ),
      ).toBeNull();
      expect(peer.kills).toEqual(["SIGTERM"]);
    }),
  );

  for (const action of ["timeout", "cancel"] as const)
    it.effect(`retires a stalled child on ${action}`, () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const peer = fixture(() =>
          Stream.fromEffect(Deferred.succeed(reading, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          ),
        );
        const fiber = yield* readClaudeAccountQuota("selected-claude", environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner),
          Effect.forkChild,
        );
        yield* Deferred.await(reading);
        if (action === "timeout") {
          yield* TestClock.adjust(4_000);
          expect(yield* Fiber.join(fiber)).toBeNull();
        } else yield* Fiber.interrupt(fiber);
        expect(peer.kills).toEqual(["SIGTERM"]);
      }),
    );

  it.effect(
    "coalesces consumers, caches unavailable results for one minute and isolates instances",
    () =>
      Effect.gen(function* () {
        const peer = fixture(() => Stream.empty);
        const reader = yield* makeClaudeAccountQuotaReader(
          "selected-claude",
          Effect.succeed(environment),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
        expect(yield* Effect.all([reader, reader, reader], { concurrency: "unbounded" })).toEqual([
          null,
          null,
          null,
        ]);
        expect(peer.commands).toHaveLength(1);
        yield* TestClock.adjust(59_000);
        yield* reader;
        expect(peer.commands).toHaveLength(1);
        yield* TestClock.adjust(1_001);
        yield* reader;
        expect(peer.commands).toHaveLength(2);
        const other = yield* makeClaudeAccountQuotaReader(
          "other-claude",
          Effect.succeed({ HOME: "/other" }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
        yield* other;
        expect(peer.commands[2]?.command).toBe("other-claude");
        expect(peer.commands[2]?.options.env).toEqual({ HOME: "/other" });
        expect(peer.kills).toHaveLength(3);
      }),
  );

  it.effect(
    "coalesces concurrent visible consumers and reuses successful reads for one minute",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const peer = fixture((request_id) =>
          Stream.fromEffect(
            Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(
            Stream.flatMap(() =>
              Stream.make(
                encoder.encode(
                  JSON.stringify({
                    type: "control_response",
                    response: { subtype: "success", request_id, response: native },
                  }) + "\n",
                ),
              ),
            ),
          ),
        );
        const reader = yield* makeClaudeAccountQuotaReader(
          "selected-claude",
          Effect.succeed(environment),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
        const consumers = yield* Effect.all([reader, reader, reader], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        expect(peer.commands).toHaveLength(1);
        yield* Deferred.succeed(release, undefined);
        const reports = yield* Fiber.join(consumers);
        expect(reports[0]?.meters?.map((meter) => meter.usedPercent)).toEqual([57, 18]);
        expect(reports).toEqual([reports[0], reports[0], reports[0]]);
        yield* TestClock.adjust(59_000);
        expect(yield* reader).toEqual(reports[0]);
        expect(peer.commands).toHaveLength(1);
        yield* TestClock.adjust(1_001);
        yield* reader;
        expect(peer.commands).toHaveLength(2);
        expect(peer.kills).toEqual(["SIGTERM", "SIGTERM"]);
      }),
  );

  it.effect(
    "retires a cancelled read and prevents reopen/reconnect bursts from probing again",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        let attempts = 0;
        const peer = fixture(() =>
          ++attempts === 1
            ? Stream.fromEffect(Deferred.succeed(reading, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
              )
            : Stream.empty,
        );
        const reader = yield* makeClaudeAccountQuotaReader(
          "selected-claude",
          Effect.succeed(environment),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
        const fiber = yield* reader.pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(fiber);
        expect(peer.kills).toEqual(["SIGTERM"]);
        // Interrupted exits also retain the pinned Effect cache's TTL. Repeated
        // subscribers may observe unavailable, but cannot restart the probe.
        yield* Effect.all(
          Array.from({ length: 12 }, () => Effect.exit(reader)),
          {
            concurrency: "unbounded",
          },
        );
        yield* TestClock.adjust(59_000);
        yield* Effect.exit(reader);
        expect(peer.commands).toHaveLength(1);
        yield* TestClock.adjust(1_001);
        expect(yield* reader).toBeNull();
        expect(peer.commands).toHaveLength(2);
        expect(peer.kills).toEqual(["SIGTERM", "SIGTERM"]);
      }),
  );
});
