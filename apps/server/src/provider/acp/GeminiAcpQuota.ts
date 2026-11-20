import type {
  ServerProviderAccountRateLimits,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
// Native command boundary: the CLI requires a host filesystem path.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { terminateProbeChild } from "../providerSnapshot.ts";
import { geminiCliEnvironment } from "./GeminiAcpRuntime.ts";

const QUALIFIED_USAGE_VERSION = "1.5.13";
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const RESET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const BUCKET_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

// The native command completes without creating a conversation or a model
// turn. A model reply, formatted prose or another slash command is unusable.
const decodeUsageReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("SUCCESS"),
      conversation_id: Schema.Literal(""),
      num_turns: Schema.Literal(0),
      usage: Schema.Struct({ total_tokens: Schema.Literal(0) }),
      command: Schema.Struct({
        name: Schema.Literal("usage"),
        data: Schema.Struct({ groups: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(32)) }),
      }),
    }),
  ),
);

interface QuotaBucket {
  readonly id: string;
  readonly window: ServerProviderAccountRateLimitWindow | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  // Only inspect objects parsed as JSON in this module. No native object,
  // inherited property or user-defined accessor is a quota observation.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readResetTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !RESET_TIME.test(value)) return undefined;
  const instant = Option.getOrUndefined(DateTime.make(value));
  if (!instant || DateTime.formatIso(instant).slice(0, 19) !== value.slice(0, 19)) return undefined;
  const seconds = Math.floor(DateTime.toEpochMillis(instant) / 1_000);
  return seconds >= 0 ? seconds : undefined;
}

function readWindow(
  bucket: Record<string, unknown>,
  windowDurationMins: number,
): ServerProviderAccountRateLimitWindow | undefined {
  if (bucket.disabled !== undefined && bucket.disabled !== false) return undefined;
  const fraction = bucket.remaining_fraction;
  const resetsAt = readResetTime(bucket.reset_time);
  const usedPercent =
    typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      ? 100 * (1 - fraction)
      : undefined;
  // A reset alone does not establish the balance. Do not infer a percentage
  // from absolute remaining units or assume a window was replenished.
  if (usedPercent === undefined && resetsAt === undefined) return undefined;
  return {
    windowDurationMins,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function readUsageOutput(
  text: string,
  checkedAt: string,
): ServerProviderAccountRateLimits | undefined {
  const report = Option.getOrUndefined(decodeUsageReport(text));
  if (!report) return undefined;

  const limits = new Map<string, ServerProviderAccountRateLimitSnapshot>();
  const seenBuckets = new Set<string>();
  for (const entry of report.command.data.groups) {
    const group = record(entry);
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) continue;
    const buckets = group?.buckets;
    if (!Array.isArray(buckets) || buckets.length > 16) continue;

    let short: QuotaBucket | undefined;
    let weekly: QuotaBucket | undefined;
    for (const value of buckets) {
      const bucket = record(value);
      if (!bucket || typeof bucket.id !== "string" || !BUCKET_ID.test(bucket.id)) continue;
      if (bucket.window !== "5h" && bucket.window !== "weekly") continue;
      // One native bucket may only belong to one group and each group may
      // only report one bucket of each supported cadence.
      if (seenBuckets.has(bucket.id)) return undefined;
      seenBuckets.add(bucket.id);
      if (bucket.window === "5h") {
        if (short) return undefined;
        short = { id: bucket.id, window: readWindow(bucket, 300) };
      } else {
        if (weekly) return undefined;
        weekly = { id: bucket.id, window: readWindow(bucket, 10_080) };
      }
    }
    const limitId = short?.id ?? weekly?.id;
    if (!limitId || (!short?.window && !weekly?.window)) continue;
    limits.set(limitId, {
      limitId,
      limitName: name,
      ...(short?.window ? { primary: short.window } : {}),
      ...(weekly?.window ? { secondary: weekly.window } : {}),
    });
  }

  const rateLimits = limits.values().next().value;
  return rateLimits
    ? { checkedAt, rateLimits, rateLimitsByLimitId: Object.fromEntries(limits) }
    : undefined;
}

export function readGeminiAccountRateLimits(input: {
  readonly binaryPath: string;
  readonly version: string | null;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fs: FileSystem.FileSystem;
}): Effect.Effect<ServerProviderAccountRateLimits | undefined> {
  // Keep automatic reads on the release we have qualified for headless
  // dispatch. Older or changed runtimes can keep using ACP without quotas.
  if (input.version !== QUALIFIED_USAGE_VERSION) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const cwd = yield* input.fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-quota-" });
    const child = yield* input.spawner.spawn(
      ChildProcess.make(
        input.binaryPath,
        [
          "--settings",
          '{"disableSlashCommands":false}',
          "--print",
          "/usage",
          "--output-format",
          "json",
          "--log-file",
          join(cwd, "usage.log"),
        ],
        { cwd, env: geminiCliEnvironment(input.environment), extendEnv: false, stdin: "ignore" },
      ),
    );
    const { stdout, exitCode } = yield* Effect.all(
      {
        stdout: collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_LIMIT_BYTES }),
        stderr: Stream.runDrain(child.stderr),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(terminateProbeChild(child, "250 millis")));
    if (Number(exitCode) !== 0 || stdout.truncated) return undefined;
    return readUsageOutput(stdout.text, DateTime.formatIso(yield* DateTime.now));
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption("8 seconds"),
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}
