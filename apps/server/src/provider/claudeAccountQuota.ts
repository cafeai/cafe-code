import * as ProviderJsonSchema from "effect/Schema";
import * as Data from "effect/Data";
import * as ProviderDateTime from "effect/DateTime";
import { randomUUID } from "node:crypto";
import type {
  ProviderSessionQuotaReport,
  ProviderSessionQuotaResult,
  ServerProviderAuth,
} from "@cafecode/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mapClaudeAccountQuotaReport } from "./claudeSessionQuota.ts";
import type { ProviderAccountQuotaReading } from "./ProviderDriver.ts";
import { terminateProbeChild } from "./providerSnapshot.ts";

const encodeProviderJsonString = ProviderJsonSchema.encodeUnknownSync(
  ProviderJsonSchema.UnknownFromJsonString,
);
const decodeProviderJsonString = ProviderJsonSchema.decodeUnknownSync(
  ProviderJsonSchema.UnknownFromJsonString,
);

/** Fixed control-stream failures retain the old public Error name/message,
 * without putting raw provider bytes into the typed error channel. */
class ClaudeQuotaResponseError extends Data.TaggedError("ClaudeQuotaResponseError")<{
  readonly message: string;
}> {
  override name = "Error";
}

const MAX_RESPONSE_BYTES = 262_144;
const MAX_RESPONSE_FRAMES = 128;

/** Fixed, content-free diagnostics distinguish local selection from the control
 * exchange. Neither provider output nor native/authentication errors are safe
 * log fields; an unavailable report also does not establish an auth failure. */
const unavailable = (
  phase: "authentication-selection" | "native-start" | "native-response",
  reason: "deadline" | "failure" | "no-response" | "control-error" | "reported-unavailable",
) => Effect.logDebug("claude.quota.unavailable", { phase, reason }).pipe(Effect.as(null));

/** A control-only process, never an SDK query or a synthetic user turn.
 * Verified with CLI 2.1.301; SDK 0.3.295 declares get_usage/skip_behaviors.
 * No initialize/user frames are needed. Keep stdin open until the exact reply;
 * EOF would race CLI shutdown. Native authentication owns all credentials.
 * https://code.claude.com/docs/en/cli-reference */
const readClaudeAccountQuotaInEnvironment = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  ProviderSessionQuotaReport | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() => {
    // Each execution owns this diagnostic phase, including concurrent callers
    // belonging to different configured instances. It carries no native data.
    let phase: "native-start" | "native-response" = "native-start";
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const requestId = randomUUID();
      const input = new TextEncoder().encode(
        `${encodeProviderJsonString({
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
      phase = "native-response";
      let bytes = 0;
      let frames = 0;
      return yield* child.stdout.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes <= MAX_RESPONSE_BYTES
            ? Effect.succeed(chunk)
            : Effect.fail(
                new ClaudeQuotaResponseError({
                  message: "Claude quota response exceeded its bound.",
                }),
              );
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.try({
            try: () => {
              if (++frames > MAX_RESPONSE_FRAMES)
                throw new ClaudeQuotaResponseError({ message: "Too many Claude quota frames." });
              return decodeProviderJsonString(line);
            },
            catch: () => new ClaudeQuotaResponseError({ message: "Invalid Claude quota frame." }),
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
        Effect.flatMap((reply) => {
          if (Option.isNone(reply)) return unavailable(phase, "no-response");
          const response = reply.value;
          if (!("subtype" in response && response.subtype === "success" && "response" in response))
            return unavailable(phase, "control-error");
          const report = mapClaudeAccountQuotaReport(
            response.response,
            ProviderDateTime.formatIso(ProviderDateTime.nowUnsafe()),
          );
          return report ? Effect.succeed(report) : unavailable(phase, "reported-unavailable");
        }),
      );
    }).pipe(
      Effect.timeout("4 seconds"),
      // The scope owns the child outside the timeout's racing fibers, so caller
      // cancellation also joins process retirement before releasing the reader.
      Effect.scoped,
      Effect.catchTag("TimeoutError", () => unavailable(phase, "deadline")),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : unavailable(phase, "failure"),
      ),
    );
  });

const selectClaudeQuotaEnvironment = (resolveEnvironment: Effect.Effect<NodeJS.ProcessEnv>) =>
  // Cold macOS login selection may consult two local auth stores. Each already
  // has its own four-second native budget and joined termination. Give that
  // existing selection path a separate finite envelope; it must not consume
  // the independent four-second get_usage allowance before its child starts.
  // No timeout authorizes a different account, an initialize frame or a prompt.
  resolveEnvironment.pipe(
    Effect.timeout("9 seconds"),
    Effect.catchTag("TimeoutError", () => unavailable("authentication-selection", "deadline")),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : unavailable("authentication-selection", "failure"),
    ),
  );

export const readClaudeAccountQuota = readClaudeAccountQuotaInEnvironment;

const NO_ACCOUNT_QUOTA: ProviderSessionQuotaResult = { report: null };
type LoginObservation = Pick<ServerProviderAuth, "status" | "email" | "type">;

/** Per-instance, shared single-flight cache includes unavailable and interrupted
 * exits for the full TTL. Cancelling/reopening a view or reconnecting cannot
 * launch another probe before that interval, even when its child was retired.
 * This depends on the pinned Effect cache's exit caching, qualified in tests. */
export const makeClaudeAccountQuotaReader = Effect.fn("makeClaudeAccountQuotaReader")(function* (
  binaryPath: string,
  resolveEnvironment: Effect.Effect<NodeJS.ProcessEnv>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let generation = 0;
  let selectedEnvironment: NodeJS.ProcessEnv | undefined;
  let observedLogin: LoginObservation | undefined;
  let lastReport: ProviderSessionQuotaReport | null = null;

  const retireReading = () => {
    generation++;
    lastReport = null;
  };
  const bindReading = (report: ProviderSessionQuotaReport, stale: boolean) => {
    const readingGeneration = generation;
    return {
      report,
      ...(stale ? { stale: true as const } : {}),
      isCurrent: () => readingGeneration === generation,
    };
  };
  const readLastReport = (): ProviderAccountQuotaReading =>
    lastReport ? bindReading(lastReport, true) : NO_ACCOUNT_QUOTA;
  const adoptEnvironment = (environment: NodeJS.ProcessEnv) => {
    // The shared selector returns stable objects for its exact login sources.
    // Never inspect or compare credentials from the environment itself.
    if (selectedEnvironment && selectedEnvironment !== environment) retireReading();
    selectedEnvironment = environment;
  };
  const observeAuthentication = (auth: LoginObservation) =>
    Effect.sync(() => {
      if (auth.status === "unknown") return;
      if (
        !observedLogin ||
        observedLogin.status !== auth.status ||
        observedLogin.email !== auth.email ||
        observedLogin.type !== auth.type
      ) {
        retireReading();
        observedLogin = { status: auth.status, email: auth.email, type: auth.type };
      }
    });
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: "60 seconds",
    lookup: () =>
      Effect.gen(function* () {
        const selectingGeneration = generation;
        const environment = yield* selectClaudeQuotaEnvironment(resolveEnvironment);
        if (selectingGeneration !== generation)
          return { generation: selectingGeneration, reading: NO_ACCOUNT_QUOTA };

        // An inconclusive selection may still display a prior observation from
        // this instance. Only a successful selection authorizes native work.
        if (environment) adoptEnvironment(environment);
        const readingGeneration = generation;
        const fresh = environment
          ? yield* readClaudeAccountQuotaInEnvironment(binaryPath, environment)
          : null;
        // A sign-out or selected login change can occur while the native child
        // is running. Neither its result nor the saved level can cross that fence.
        if (readingGeneration !== generation)
          return { generation: readingGeneration, reading: NO_ACCOUNT_QUOTA };
        if (fresh) lastReport = fresh;
        return {
          generation: readingGeneration,
          reading: fresh ? bindReading(fresh, false) : readLastReport(),
        };
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });

  return {
    observeEnvironment: (environment: NodeJS.ProcessEnv) =>
      Effect.sync(() => adoptEnvironment(environment)),
    observeAuthentication,
    retireReading,
    // Preserve the original shared retry floor even after the cached entry
    // loses its presentation authority. Only the next admitted read can renew it.
    read: Effect.uninterruptibleMask((restore) =>
      restore(Cache.get(cache, "usage")).pipe(
        Effect.map((entry): ProviderAccountQuotaReading =>
          entry.generation === generation ? entry.reading : NO_ACCOUNT_QUOTA,
        ),
        // The restored lookup still joins native cleanup on caller cancel.
        // A later caller may receive that cached interrupt without itself
        // being cancelled. Give it the prior reading without retrying the probe.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.sync(readLastReport) : Effect.failCause(cause),
        ),
      ),
    ),
  };
});
