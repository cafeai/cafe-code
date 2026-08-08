import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@cafecode/contracts";
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
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const path = yield* Path.Path;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  const configuredConfigDir = baseEnv.CLAUDE_CONFIG_DIR?.trim();

  // Claude Code currently supports both HOME-derived config discovery and
  // CLAUDE_CONFIG_DIR. Cafe sets the latter explicitly so SDK launches match a
  // verified CLI command such as `CLAUDE_CONFIG_DIR=/Users/me/.claude claude`
  // instead of depending on subtle process-launch HOME behavior.
  return {
    ...baseEnv,
    HOME: resolvedHomePath,
    // Club Code owns provider compatibility and only advances this pin after
    // source review and cross-platform gates. Prevent Claude's background
    // updater from silently replacing that tested binary between launches;
    // manual `claude install <version>` remains available to the detached
    // conformity helper.
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CONFIG_DIR:
      configuredConfigDir && configuredConfigDir.length > 0
        ? path.resolve(configuredConfigDir)
        : path.join(resolvedHomePath, ".claude"),
  };
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
