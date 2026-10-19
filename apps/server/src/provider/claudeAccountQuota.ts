import { randomUUID } from "node:crypto";
import type { ProviderSessionQuotaReport } from "@cafecode/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mapClaudeAccountQuotaReport } from "./claudeSessionQuota.ts";
import { terminateProbeChild } from "./providerSnapshot.ts";

const MAX_RESPONSE_BYTES = 262_144;
const MAX_RESPONSE_FRAMES = 128;

/** A control-only process, never an SDK query or a synthetic user turn.
 * Verified with CLI 2.1.301; SDK 0.3.295 declares get_usage/skip_behaviors.
 * No initialize/user frames are needed. Keep stdin open until the exact reply;
 * EOF would race CLI shutdown. Native authentication owns all credentials.
 * https://code.claude.com/docs/en/cli-reference */
const readClaudeAccountQuotaFromEnvironment = (
  binaryPath: string,
  resolveEnvironment: Effect.Effect<NodeJS.ProcessEnv>,
): Effect.Effect<
  ProviderSessionQuotaReport | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = yield* resolveEnvironment;
    const requestId = randomUUID();
    const input = new TextEncoder().encode(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "get_usage", skip_behaviors: true },
      })}\n`,
    );
    const child = yield* Effect.acquireRelease(
      spawner.spawn(
        ChildProcess.make(
          binaryPath,
          [
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
          ],
          {
            env: { ...environment },
            extendEnv: false,
            shell: false,
            // No project cwd, resume id, Cafe MCP or chat response-budget override.
            cwd: environment.HOME,
            stdin: Stream.concat(Stream.make(input), Stream.never),
            stderr: "ignore",
          },
        ),
      ),
      (child) => terminateProbeChild(child, "250 millis"),
    );
    let bytes = 0;
    let frames = 0;
    return yield* child.stdout.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes <= MAX_RESPONSE_BYTES
          ? Effect.succeed(chunk)
          : Effect.fail(new Error("Claude quota response exceeded its bound."));
      }),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.mapEffect((line) =>
        Effect.try({
          try: () => {
            if (++frames > MAX_RESPONSE_FRAMES) throw new Error("Too many Claude quota frames.");
            return JSON.parse(line) as unknown;
          },
          catch: () => new Error("Invalid Claude quota frame."),
        }),
      ),
      Stream.map((frame) => {
        if (
          !frame ||
          typeof frame !== "object" ||
          !("type" in frame) ||
          frame.type !== "control_response"
        )
          return null;
        const response = "response" in frame ? frame.response : undefined;
        if (
          !response ||
          typeof response !== "object" ||
          !("request_id" in response) ||
          response.request_id !== requestId
        )
          return null;
        return response;
      }),
      Stream.filter((response) => response !== null),
      Stream.runHead,
      Effect.map((reply) => {
        if (Option.isNone(reply)) return null;
        const response = reply.value;
        return "subtype" in response && response.subtype === "success" && "response" in response
          ? mapClaudeAccountQuotaReport(response.response, new Date().toISOString())
          : null;
      }),
    );
  }).pipe(
    Effect.timeout("4 seconds"),
    // The scope owns the child outside the timeout's racing fibers, so caller
    // cancellation also joins process retirement before releasing the reader.
    Effect.scoped,
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
    ),
  );

export const readClaudeAccountQuota = (binaryPath: string, environment: NodeJS.ProcessEnv) =>
  readClaudeAccountQuotaFromEnvironment(binaryPath, Effect.succeed(environment));

/** Per-instance, shared single-flight cache includes unavailable and interrupted
 * exits for the full TTL. Cancelling/reopening a view or reconnecting cannot
 * launch another probe before that interval, even when its child was retired.
 * This depends on the pinned Effect cache's exit caching, qualified in tests. */
export const makeClaudeAccountQuotaReader = Effect.fn("makeClaudeAccountQuotaReader")(function* (
  binaryPath: string,
  resolveEnvironment: Effect.Effect<NodeJS.ProcessEnv>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: "60 seconds",
    lookup: () =>
      readClaudeAccountQuotaFromEnvironment(binaryPath, resolveEnvironment).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });
  return Cache.get(cache, "usage");
});
