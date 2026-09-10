import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CLAUDE_MAX_CONCURRENT_SUBAGENTS, type ClaudeSettings } from "@cafecode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  describe("Claude Agent-tool concurrency environment", () => {
    it.effect("omits the key unless configured and preserves inherited provider policy", () =>
      Effect.gen(function* () {
        const withoutOverride = yield* makeClaudeEnvironment({ homePath: "" }, {});
        expect(Object.hasOwn(withoutOverride, "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS")).toBe(false);

        // An unset Cafe override must not sanitize, replace, or invent a
        // default for an inherited value. The configured CLI owns its parsing.
        for (const inherited of ["12", "128", "invalid-inherited-value"]) {
          const baseEnv = Object.freeze({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: inherited });
          const env = yield* makeClaudeEnvironment({ homePath: "" }, baseEnv);
          expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(inherited);
          expect(baseEnv.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(inherited);
        }
      }),
    );

    for (const maxConcurrentSubagents of [1, 20, CLAUDE_MAX_CONCURRENT_SUBAGENTS]) {
      it.effect(
        `serializes explicit limit ${maxConcurrentSubagents} without mutating the parent`,
        () =>
          Effect.gen(function* () {
            const baseEnv = Object.freeze({
              CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "8",
              CAFE_TEST_UNRELATED: "preserved",
            });
            const env = yield* makeClaudeEnvironment(
              { homePath: "", maxConcurrentSubagents },
              baseEnv,
            );
            expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(String(maxConcurrentSubagents));
            expect(env.CAFE_TEST_UNRELATED).toBe("preserved");
            expect(baseEnv.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("8");

            // Sharing a home/base environment never leaks one instance's limit
            // into another. Existing session environments remain snapshots too.
            const sibling = yield* makeClaudeEnvironment({ homePath: "" }, baseEnv);
            expect(sibling.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("8");
            expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(String(maxConcurrentSubagents));
          }),
      );
    }

    for (const maxConcurrentSubagents of [
      0,
      -1,
      1.5,
      CLAUDE_MAX_CONCURRENT_SUBAGENTS + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "20",
      "1; ignored",
      null,
    ]) {
      it.effect(
        `rejects malformed explicit limit ${String(maxConcurrentSubagents)} at launch`,
        () =>
          Effect.gen(function* () {
            // Intentionally bypass TypeScript to exercise the final boundary for
            // corrupted/restored state; no invalid input may reach a provider.
            const result = yield* makeClaudeEnvironment(
              { homePath: "", maxConcurrentSubagents } as unknown as Pick<
                ClaudeSettings,
                "homePath" | "maxConcurrentSubagents"
              >,
              {},
            ).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              expect(Cause.pretty(result.cause)).toContain(
                `Claude maxConcurrentSubagents must be an integer between 1 and ${CLAUDE_MAX_CONCURRENT_SUBAGENTS}.`,
              );
            }
          }),
      );
    }
  });

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
