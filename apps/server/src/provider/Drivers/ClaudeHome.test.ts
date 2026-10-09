import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLAUDE_MAX_CONCURRENT_SUBAGENTS,
  CLAUDE_MAX_OUTPUT_TOKENS,
  type ClaudeSettings,
} from "@cafecode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeNonChatEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

// The default-config-dir assertions below must not see an ambient
// CLAUDE_CONFIG_DIR (e.g. when this suite runs inside a Claude Code session),
// since makeClaudeEnvironment deliberately preserves an explicit one. Drop it so
// the "no override configured" path is exercised deterministically.
const baseEnvWithoutClaudeConfigDir = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
};

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude response-cap environment", () => {
    it.effect("keeps non-chat operations on their inherited output policy", () =>
      Effect.gen(function* () {
        const config = {
          homePath: "",
          maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
          maxConcurrentSubagents: 3,
        };
        const unset = yield* makeClaudeNonChatEnvironment(config, {});
        expect(Object.hasOwn(unset, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe(false);
        expect(unset.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("3");
        const inherited = Object.freeze({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
        const env = yield* makeClaudeNonChatEnvironment(config, inherited);
        expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
        expect(inherited.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
      }),
    );

    it.effect("keeps omission and inherited provider parsing authoritative", () =>
      Effect.gen(function* () {
        const unset = yield* makeClaudeEnvironment({ homePath: "" }, {});
        expect(Object.hasOwn(unset, "CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBe(false);
        // An account reset removes only Cafe's override. An ambient value,
        // even outside Cafe's supported explicit range, still belongs to the
        // configured CLI and is not rewritten into an invented model default.
        for (const inherited of ["32000", "256000", "provider-owned-value"]) {
          const parent = Object.freeze({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: inherited });
          const env = yield* makeClaudeEnvironment({ homePath: "" }, parent);
          expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(inherited);
          expect(parent.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(inherited);
        }
      }),
    );

    it.effect("binds explicit caps to copied account environments and preserves reset", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const parent = Object.freeze({
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
          CAFE_TEST_UNRELATED: "preserved",
        });
        const firstHome = path.resolve("synthetic-claude-output-first");
        const secondHome = path.resolve("synthetic-claude-output-second");
        for (const maxOutputTokens of [1, 64_000, CLAUDE_MAX_OUTPUT_TOKENS]) {
          const first = yield* makeClaudeEnvironment(
            { homePath: firstHome, maxOutputTokens },
            parent,
          );
          const second = yield* makeClaudeEnvironment(
            { homePath: secondHome, maxOutputTokens: 42 },
            parent,
          );
          const reset = yield* makeClaudeEnvironment({ homePath: firstHome }, parent);
          expect(first.HOME).toBe(firstHome);
          expect(first.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(maxOutputTokens));
          expect(second.HOME).toBe(secondHome);
          expect(second.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("42");
          expect(reset.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
          expect(first.CAFE_TEST_UNRELATED).toBe("preserved");
          expect(parent.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
          expect(first).not.toBe(second);
          expect(first).not.toBe(reset);
          // Later sibling/reset construction cannot mutate a query's already
          // captured process environment or the global parent object.
          expect(first.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(maxOutputTokens));
        }
      }),
    );

    for (const maxOutputTokens of [
      0,
      -1,
      1.5,
      CLAUDE_MAX_OUTPUT_TOKENS + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "64000",
      "1; ignored",
      null,
    ]) {
      it.effect(
        `rejects malformed explicit response cap ${String(maxOutputTokens)} at launch`,
        () =>
          Effect.gen(function* () {
            const result = yield* makeClaudeEnvironment(
              { homePath: "", maxOutputTokens } as unknown as Pick<
                ClaudeSettings,
                "homePath" | "maxOutputTokens"
              >,
              {},
            ).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              expect(Cause.pretty(result.cause)).toContain(
                `Claude maxOutputTokens must be an integer between 1 and ${CLAUDE_MAX_OUTPUT_TOKENS}.`,
              );
            }
          }),
      );
    }
  });

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
        if (process.platform === "darwin") {
          expect(Object.hasOwn(env, "CLAUDE_CONFIG_DIR")).toBe(false);
        } else {
          expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(resolved, ".claude"));
        }
      }),
    );

    for (const platform of ["darwin", "linux", "win32"] as const) {
      it.effect(`preserves the default credential-store selection on ${platform}`, () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const resolved = path.resolve(NodeOS.homedir());
          for (const homePath of ["", " \t "]) {
            for (const configDir of [undefined, "", " \t "]) {
              const baseEnv = Object.freeze({
                HOME: resolved,
                ...(configDir !== undefined ? { CLAUDE_CONFIG_DIR: configDir } : {}),
                CAFE_TEST_UNRELATED: "preserved",
              });
              const env = yield* makeClaudeEnvironment({ homePath }, baseEnv, platform);
              expect(env.HOME).toBe(resolved);
              expect(env.CAFE_TEST_UNRELATED).toBe("preserved");
              if (platform === "darwin") {
                expect(Object.hasOwn(env, "CLAUDE_CONFIG_DIR")).toBe(false);
              } else {
                expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(resolved, ".claude"));
              }
              expect(baseEnv.CLAUDE_CONFIG_DIR).toBe(configDir);
              expect(Object.hasOwn(baseEnv, "CLAUDE_CONFIG_DIR")).toBe(configDir !== undefined);
            }
          }
        }),
      );

      it.effect(`retains explicit account-directory selection on ${platform}`, () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const homePath = path.resolve(NodeOS.homedir(), ".claude-work");
          const configDir = path.resolve(NodeOS.homedir(), ".claude-explicit");
          const baseEnv = Object.freeze({ HOME: path.resolve(NodeOS.homedir()) });
          const customHome = yield* makeClaudeEnvironment({ homePath }, baseEnv, platform);
          expect(customHome.HOME).toBe(homePath);
          expect(customHome.CLAUDE_CONFIG_DIR).toBe(path.join(homePath, ".claude"));

          // An explicit directory remains authoritative even when it spells the
          // default path: its scoped Keychain login may belong to another account.
          for (const explicitConfigDir of [configDir, path.join(baseEnv.HOME, ".claude")]) {
            const explicitBaseEnv = Object.freeze({
              ...baseEnv,
              CLAUDE_CONFIG_DIR: explicitConfigDir,
            });
            for (const accountHome of ["", homePath]) {
              const env = yield* makeClaudeEnvironment(
                { homePath: accountHome },
                explicitBaseEnv,
                platform,
              );
              expect(env.CLAUDE_CONFIG_DIR).toBe(explicitConfigDir);
              expect(explicitBaseEnv.CLAUDE_CONFIG_DIR).toBe(explicitConfigDir);
            }
          }
        }),
      );
    }

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
