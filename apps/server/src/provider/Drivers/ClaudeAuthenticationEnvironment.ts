import type { ClaudeSettings } from "@cafecode/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { DEFAULT_TIMEOUT_MS, terminateProbeChild } from "../providerSnapshot.ts";
import { makeClaudeNonChatEnvironment, resolveClaudeHomePath } from "./ClaudeHome.ts";

const AUTH_STATUS_MAX_BYTES = 16_384;
const UNRESOLVED_SELECTION_TTL = Duration.seconds(5);
const PROBE_TERMINATION_GRACE = Duration.millis(250);
const EXPLICIT_AUTH_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
] as const;

type LocalLoginStatus = "authenticated" | "unauthenticated" | "inconclusive";
const decodeLocalLoginStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })),
);

const readLocalLoginStatus = Effect.fn("readClaudeLocalLoginStatus")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.gen(function* () {
    // The documented auth-status command reads local material without sending
    // a prompt or refreshing credentials. Never use inference as a login probe.
    // https://code.claude.com/docs/en/cli-reference#cli-commands
    const child = yield* spawner.spawn(
      ChildProcess.make(binaryPath, ["auth", "status"], {
        env: environment,
        shell: false,
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    return yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: AUTH_STATUS_MAX_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(terminateProbeChild(child, PROBE_TERMINATION_GRACE)));
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Option.none()),
    ),
  );
  if (Option.isNone(result)) return "inconclusive" as const;
  const [stdout, exitCode] = result.value;
  if (stdout.truncated) return "inconclusive" as const;
  // Account identifiers and arbitrary provider output stay inside this bounded
  // parse. Only the exact Boolean plus its documented exit code may authorize
  // selection; malformed output and process failures cannot switch accounts.
  const status = decodeLocalLoginStatus(stdout.text);
  if (Option.isNone(status)) return "inconclusive" as const;
  const loggedIn = status.value.loggedIn;
  if (loggedIn === true && Number(exitCode) === 0) return "authenticated" as const;
  if (loggedIn === false && Number(exitCode) === 1) return "unauthenticated" as const;
  return "inconclusive" as const;
});

/** Shared per-instance selection for health, new queries and metadata helpers. */
export const makeClaudeAuthenticationEnvironment = Effect.fn("makeClaudeAuthenticationEnvironment")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath" | "maxConcurrentSubagents" | "enabled">,
    baseEnv: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): Effect.fn.Return<
    Effect.Effect<NodeJS.ProcessEnv>,
    never,
    Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const path = yield* Path.Path;
    // The account response cap belongs only to user chat queries. Login and
    // status probes, and the helpers sharing this selected login, must retain
    // their existing provider policy rather than acquire a larger chat budget.
    // Select only the existing login/concurrency fields even when the driver
    // passes a complete ClaudeSettings object at runtime.
    const environment = yield* makeClaudeNonChatEnvironment(config, baseEnv, platform);
    const defaultConfigDirectory = path.join(yield* resolveClaudeHomePath(config), ".claude");
    const shouldSelectDefaultLogin =
      config.enabled &&
      platform === "darwin" &&
      config.homePath.trim().length === 0 &&
      !baseEnv.CLAUDE_CONFIG_DIR?.trim() &&
      baseEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined &&
      !EXPLICIT_AUTH_ENVIRONMENT_KEYS.some((key) => baseEnv[key]?.trim());
    if (!shouldSelectDefaultLogin) {
      // Preserve the previous default config layout when another explicit auth
      // source owns selection; the terminal fallback is only for default OAuth.
      if (platform === "darwin" && !environment.CLAUDE_CONFIG_DIR) {
        environment.CLAUDE_CONFIG_DIR = defaultConfigDirectory;
      }
      return Effect.succeed(environment);
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cafeEnvironment = {
      ...environment,
      CLAUDE_CONFIG_DIR: defaultConfigDirectory,
    };
    const pinned = yield* Ref.make<NodeJS.ProcessEnv | undefined>(undefined);
    const unresolved = yield* Cache.make({
      capacity: 1,
      timeToLive: UNRESOLVED_SELECTION_TTL,
      lookup: () =>
        Effect.gen(function* () {
          // Preserve existing Cafe accounts/configuration when both stores have
          // logins. An inconclusive first check never authorizes a fallback.
          const cafeStatus: LocalLoginStatus = yield* readLocalLoginStatus(
            config.binaryPath,
            cafeEnvironment,
          );
          let selected: NodeJS.ProcessEnv | undefined;
          let source: "cafe" | "terminal" = "cafe";
          if (cafeStatus === "authenticated") {
            selected = cafeEnvironment;
          } else if (cafeStatus === "unauthenticated") {
            const terminalStatus = yield* readLocalLoginStatus(config.binaryPath, environment);
            if (terminalStatus === "authenticated") {
              selected = environment;
              source = "terminal";
            }
          }
          if (selected) {
            // Pin the first conclusive login for the configured instance's
            // lifetime. Refreshes and later logins in the other store must not
            // change an active account. No-auth/inconclusive results are cached
            // briefly so a later login can recover without an instance reload.
            yield* Ref.set(pinned, selected);
            yield* Effect.logDebug("claude.auth-environment.selected", { source });
          }
          return selected ?? cafeEnvironment;
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    });
    return Effect.gen(function* () {
      const selected = yield* Ref.get(pinned);
      return selected ?? (yield* Cache.get(unresolved, "default"));
    });
  },
);
