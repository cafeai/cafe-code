import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

// The derived-config-dir assertions below must not see an ambient
// CLAUDE_CONFIG_DIR (e.g. when this suite runs inside a Claude Code session),
// since makeClaudeEnvironment deliberately preserves an explicit one. Drop it so
// the "no override configured" path is exercised deterministically.
const baseEnvWithoutClaudeConfigDir = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
};

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());
        const env = yield* makeClaudeEnvironment({ homePath: "" }, baseEnvWithoutClaudeConfigDir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(env.HOME).toBe(resolved);
        expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(resolved, ".claude"));
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");
        const env = yield* makeClaudeEnvironment({ homePath }, baseEnvWithoutClaudeConfigDir());

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect(env.HOME).toBe(resolved);
        expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(resolved, ".claude"));
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("preserves an explicit Claude config directory from the provider environment", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const explicitConfigDir = path.resolve(NodeOS.homedir(), ".claude-zkpixels");
        const env = yield* makeClaudeEnvironment(
          { homePath: "" },
          {
            ...process.env,
            CLAUDE_CONFIG_DIR: explicitConfigDir,
          },
        );

        expect(env.HOME).toBe(path.resolve(NodeOS.homedir()));
        expect(env.CLAUDE_CONFIG_DIR).toBe(explicitConfigDir);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
