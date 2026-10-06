import * as NodeOS from "node:os";

import { CLAUDE_MAX_CONCURRENT_SUBAGENTS, type ClaudeSettings } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath" | "maxConcurrentSubagents">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const path = yield* Path.Path;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  const configuredConfigDir = baseEnv.CLAUDE_CONFIG_DIR?.trim();
  const maxConcurrentSubagents = config.maxConcurrentSubagents;

  // Revalidate at the process boundary as well as in the persisted schema:
  // internal callers and restored settings must not serialize malformed values
  // into the provider environment. Only the fixed public key and decimal
  // integer are passed; no shell command, global environment or config file is
  // modified. Claude Code 2.1.266 reads positive plain digits and defaults to
  // 20 (official env-vars / concurrent-subagent-limit documentation).
  if (
    maxConcurrentSubagents !== undefined &&
    (!Number.isInteger(maxConcurrentSubagents) ||
      maxConcurrentSubagents < 1 ||
      maxConcurrentSubagents > CLAUDE_MAX_CONCURRENT_SUBAGENTS)
  ) {
    return yield* Effect.die(
      new Error(
        `Claude maxConcurrentSubagents must be an integer between 1 and ${CLAUDE_MAX_CONCURRENT_SUBAGENTS}.`,
      ),
    );
  }

  // On macOS, even CLAUDE_CONFIG_DIR=$HOME/.claude selects a different Keychain
  // entry from an ordinary terminal launch with the variable unset. Build the
  // terminal candidate for the default home; the owning driver's shared
  // ClaudeAuthenticationEnvironment resolver preserves Cafe's existing login
  // first and selects this candidate only after conclusive local status checks.
  // Explicit config directories and custom account homes retain their selection.
  // https://code.claude.com/docs/en/authentication#credential-management
  // https://github.com/anthropics/claude-code/issues/92252
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: resolvedHomePath,
    // Omission preserves user-owned inherited configuration. Explicit instance
    // settings win only for newly created environments; they cannot change a
    // running query or a sibling instance that shares the same base object.
    ...(maxConcurrentSubagents !== undefined
      ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(maxConcurrentSubagents) }
      : {}),
  };
  if (configuredConfigDir) {
    env.CLAUDE_CONFIG_DIR = path.resolve(configuredConfigDir);
  } else if (platform === "darwin" && config.homePath.trim().length === 0) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = path.join(resolvedHomePath, ".claude");
  }
  return env;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);
